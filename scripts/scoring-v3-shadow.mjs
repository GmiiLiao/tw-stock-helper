#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 技術評分 v3 影子模式（docs/SCORING-SPEC-v3.md §8；2026-09-30 使用者核可）
//   只跑 scripts/data/scoring-v3-weights.json 裡 passed=true 的分數；權重只讀檔、不在線上重估。
//   daemon 每個交易日 18:45 以獨立行程執行（法人 16:47 補跑已齊）；成功才寫 system/daemonJobMarks.scoringV3。
//   每日：宇宙（排除處置股）→ 因子（官方除權息＋priceEvents 還原）→ 總分百分位 → scoringV3/{資料日}、scoringV3/latest
//        ＋ 記分板 scoringV3/scoreboard：v3 Top20 vs 同日 v2 Top20（picksHistory.top20），同一標籤口徑的超額。
//   不動 v2、不動任何榜單；上游只有每日 2 次官方除權息區間查詢（與人數無關）＋自家處置名單 API。
//   失敗一律不寫（寧缺勿錯）：法人未齊、除權息來源失敗、處置名單殘缺 ⇒ exit 1。
//   2026-10-04（WM-SCAN G2-23／G2-26／G2-28）：
//     · 資料日必須＝預期的最新交易日（交易日 13:30 後＝今天，否則前一交易日；休市日曆 system/tradingCalendar）且兩市收盤＋法人到齊
//       （canonical-gate.archiveDayStatus）——舊版取「最近一個 ≥1500 檔的歸檔日」，上櫃未併入時會改寫昨天的影子記錄並回報成功。
//     · priceEvents/latest 不存在／沒有 items＝讀取失敗 ⇒ 不寫。
//     · 歸檔以交易日序列對齊：殘缺日保留一格（缺值），不整天濾掉讓 60 日窗位移。
//     · 同一資料日重跑：新版宇宙比既有記錄少 2% 以上 ⇒ 不覆蓋（neverThinner）；latest 只往前，不被較舊的資料日蓋掉。
//   用法：node scripts/scoring-v3-shadow.mjs [--dry]
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { V3_FACTORS, crossSection, compositePct, labelsFor, topN, shadowBoard } from './lib/scoring-v3.mjs';
import { applyPriceFactors, factorsFromItems } from './lib/price-factors.mjs';
import { fetchExright, mergeFactorItems } from './lib/exright-source.mjs';
import { dropUndefined } from './lib/firestore-clean.mjs';
import { alignArchiveDays, latestTradingDayAsOf, shadowDayCheck, twClock } from './lib/ai-lab-guard.mjs';
import { neverThinner } from './lib/canonical-gate.mjs';

const DRY = process.argv.includes('--dry');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_BASE = process.env.APP_BASE || 'https://tw-stock-helper.web.app';
const LOOKBACK = 100;          // 歸檔日數：60 日因子窗＋記分板回看
const INST_MIN = 1200;         // 當日法人檔數下限（15:15 只有上櫃約 800 檔 ⇒ 未齊）
const TOP = 20, BOARD_DAYS = 60;
const LABEL = { S: 'S', W: 'W5' };   // 各分數的記分板標籤（與驗證定權標籤同）
const r2 = x => (Number.isFinite(x) ? +x.toFixed(2) : null);
const fail = msg => { console.log(`✖ v3 影子：${msg}`); process.exit(1); };

function initDb() {
  if (!getApps().length) {
    const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    initializeApp(p ? { credential: cert(JSON.parse(readFileSync(p, 'utf8'))) } : {});
  }
  return getFirestore();
}

const W = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'scoring-v3-weights.json'), 'utf8'));
const live = Object.entries(W.scores || {}).filter(([, s]) => s.passed);
if (!live.length) { console.log('· v3 影子：沒有通過驗證的分數，不執行'); process.exit(0); }

const db = initDb();
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(LOOKBACK).select('date', 'closeJson', 'instJson', 'otcPending', 'gapFixSource').get();
// 休市日曆（讀不到＝無法判定預期資料日與交易日序列 ⇒ 不寫）
let holidays;
try { const cal = (await db.collection('system').doc('tradingCalendar').get()).data(); if (!Array.isArray(cal?.holidays) || !cal.holidays.length) throw new Error('holidays 為空'); holidays = new Set(cal.holidays); }
catch (e) { fail(`休市日曆讀不到（${(e.message || '').slice(0, 60)}），無法判定預期資料日`); }
const isTd = iso => { const g = new Date(`${iso}T12:00:00Z`).getUTCDay(); return g !== 0 && g !== 6 && !holidays.has(iso); };
const aligned = alignArchiveDays(snap.docs.map(d => d.data()), { isTradingDayIso: isTd });   // 颱風假等非交易日的空殼丟掉、交易日的殘缺保留為缺值
const raw = aligned.days.map(d => { let inst = null; try { inst = d.raw.instJson ? JSON.parse(d.raw.instJson) : null; } catch { inst = null; } return { date: d.date, m: d.m, inst }; });
if (raw.length < 62) fail(`歸檔只有 ${raw.length} 日`);
const t = raw.length - 1, date = raw[t].date;
const expected = latestTradingDayAsOf(twClock(Date.now()), isTd, 13 * 60 + 30);
const dayOk = shadowDayCheck({ lastDate: date, expected, archiveDoc: aligned.days[t].raw });
if (!dayOk.ok) fail(dayOk.why);
const partialInWin = aligned.partialDates.filter(d => d >= raw[Math.max(0, t - 61)].date);
if (partialInWin.length) console.log(`⚠ v3 影子：60 日窗內有 ${partialInWin.length} 個殘缺交易日（保留為缺值、不位移；窗跨過它的個股本日不進宇宙）：${partialInWin.join('、')}`);
const instN = Object.keys(raw[t].inst || {}).length;
if (instN < INST_MIN) fail(`${date} 法人僅 ${instN} 檔（<${INST_MIN}，未齊）`);

// 還原係數：窗內官方除權息（失敗就不算——未還原的除息跳空會污染 r60/dd60/標籤）＋ priceEvents 減資／面額變更
let ex;
try { ex = await fetchExright(raw[0].date, date); } catch (e) { fail(`除權息來源失敗：${(e.message || '').slice(0, 80)}`); }
const peDoc = (await db.collection('priceEvents').doc('latest').get()).data();
if (!peDoc || !Array.isArray(peDoc.items)) fail(`價格結構事件讀取失敗（priceEvents/latest ${peDoc ? '沒有 items' : '不存在'}）`);
const pe = peDoc.items;
const days = applyPriceFactors(raw, factorsFromItems(mergeFactorItems(ex.items, pe)));

// 處置股排除（名單取不到或殘缺 ⇒ 不寫；空集合會讓處置股安靜混入）
let disp;
try {
  const rs = await fetch(`${APP_BASE}/api/twse/risk-stocks`, { signal: AbortSignal.timeout(8000) }).then(x => (x.ok ? x.json() : null));
  if (!rs || !Array.isArray(rs.disposition) || rs.dispositionComplete === false) fail('處置名單取不到或殘缺');
  disp = new Set(rs.disposition.filter(x => x.code && (!x.endDate || x.endDate >= date)).map(x => x.code));
} catch (e) { fail(`處置名單抓取失敗：${(e.message || '').slice(0, 60)}`); }
const dayT = { ...days[t], m: Object.fromEntries(Object.entries(days[t].m).filter(([c]) => !disp.has(c))) };
const cs = crossSection([...days.slice(0, t), dayT], t, raw);   // v3.1：門檻看未還原的實際價
if (cs.codes.length < 100) fail(`${date} 宇宙僅 ${cs.codes.length} 檔`);

const v2Top = ((await db.collection('picksHistory').doc(date).get()).data()?.top20 || []).map(p => p.code).filter(Boolean);
const scores = {};
for (const [k, s] of live) {
  const pct = compositePct(cs.factors, s.weights);
  scores[k] = {
    label: s.label, weights: s.weights,
    top: topN(cs.codes, pct, TOP).map(x => {
      const i = cs.codes.indexOf(x.code);
      return { code: x.code, pct: r2(x.pct), f: Object.fromEntries(V3_FACTORS.map(f => [f, r2(cs.factors[f][i])])) };
    }),
    pctJson: JSON.stringify(Object.fromEntries(cs.codes.map((c, i) => [c, r2(pct[i])]))),
  };
}
const doc = { date, version: W.version, weightsMeta: { dataHash: W.dataHash, dataDate: W.dataDate }, at: Date.now(),
  universe: cs.codes.length, dispExcluded: disp.size, instN, exright: ex.counts, v2Top20: v2Top, scores,
  note: '影子模式：只記錄、不影響任何榜單。pct＝當日可交易宇宙百分位（0–100）。非投資建議。' };

// ── 記分板：過去影子日（標籤已可得）的 v3 Top20 vs v2 Top20 超額（基準＝當日 v3 宇宙等權平均）──
const idx = new Map(days.map((d, i) => [d.date, i]));
const hist = (await db.collection('scoringV3').orderBy('date', 'desc').limit(BOARD_DAYS + 6).get()).docs   // +latest 本身也帶 date
  .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.id) && d.id < date).map(d => d.data())
  .filter(h => h.version === W.version);   // 記分板只比同一版權重（換版＝重新累積）
const board = {};
for (const [k] of live) {
  const L = LABEL[k]; const rows = [];
  for (const h of hist) {
    const i = idx.get(h.date); const sc = h.scores?.[k]; if (i == null || !sc?.pctJson) continue;
    const uni = Object.keys(JSON.parse(sc.pctJson));
    const lab = c => labelsFor(days, i, c)[L];
    const base = uni.map(lab).filter(Number.isFinite); if (base.length < 100) continue;   // 標籤尚未可得
    const mu = base.reduce((a, b) => a + b, 0) / base.length;
    const ex3 = sc.top.map(x => lab(x.code)).filter(Number.isFinite), ex2 = (h.v2Top20 || []).map(lab).filter(Number.isFinite);
    const m = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length - mu : null);
    rows.push({ date: h.date, v3: r2(m(ex3)), v2: r2(m(ex2)), n3: ex3.length, n2: ex2.length });
  }
  const recent = rows.slice(0, BOARD_DAYS);   // 統計窗與存檔窗一致（最近 60 個影子日）
  const st = shadowBoard(recent);
  board[k] = { label: L, ...Object.fromEntries(Object.entries(st).map(([a, v]) => [a, typeof v === 'number' ? r2(v) : v])), rows: recent };
}
const boardDoc = { updatedAt: Date.now(), dataDate: date, version: W.version, board,
  rule: '累積 ≥20 個交易日且（v3−v2 差值 95% CI 下界 > 0，或兩者皆負時 v3 損失較小）⇒ 提請使用者切換（§8）；切換前 v2 不動。',
  note: '超額＝Top20 平均 − 當日 v3 宇宙等權平均；S＝隔日跳空（開[t+1]÷收[t]）。未扣成本（成本依持有方式另計，不以扣成本方式比對）。非投資建議。' };

for (const [k, s] of Object.entries(scores)) console.log(`📐 v3 ${k} ${date}：宇宙 ${cs.codes.length}（排除處置 ${disp.size}）、Top ${s.top.slice(0, 5).map(x => x.code).join(' ')}…｜記分板 ${board[k].n} 日 v3 ${board[k].v3 ?? '—'} vs v2 ${board[k].v2 ?? '—'}${board[k].switchReady ? '｜⚑ 達提請切換條件' : ''}`);
if (DRY) process.exit(0);
// 同一資料日重跑：不以較薄的結果覆蓋（某來源這次失敗而宇宙變小）；latest 只往前
const prevDay = (await db.collection('scoringV3').doc(date).get()).data();
if (prevDay && !neverThinner(prevDay.universe ?? null, cs.codes.length)) fail(`${date} 既有記錄宇宙 ${prevDay.universe} 檔 > 本次 ${cs.codes.length} 檔（少 2% 以上），不覆蓋`);
await db.collection('scoringV3').doc(date).set(dropUndefined(doc));
const prevLatest = (await db.collection('scoringV3').doc('latest').get()).data();
if (!(prevLatest?.date > date)) await db.collection('scoringV3').doc('latest').set(dropUndefined(doc));
await db.collection('scoringV3').doc('scoreboard').set(dropUndefined(boardDoc));
console.log(`✓ v3 影子 ${date}：${Object.keys(scores).join('、')} 已寫入（除權息 ${ex.items.length} 件、法人 ${instN} 檔）`);
process.exit(0);
