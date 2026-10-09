#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 標靶公式影子模式（2026-09-30 使用者核可：5 日持有·依多空市況兩組係數；研究 docs/SWING-FORMULA-RESEARCH-*-stage2.md）
//   只讀 scripts/data/swing-formula-weights.json（passed=true 才執行），不在線上重估；計算核心與研究同一份（lib/swing-formula.mjs）。
//   daemon 每個交易日 22:40 起以獨立行程執行（資券 21:45 班車之後）；法人／資券／當沖任一未齊即不寫、稍後重試。
//   每日：宇宙（排除處置股）→ 24 特徵當日排名 → 依市況（前 20 日宇宙等權報酬 >0＝多頭）選係數 → 前 20 名
//        → swingFormula/{資料日}、swingFormula/latest；
//   記分板 swingFormula/scoreboard：過去影子日 5 日到期後，前 20 名 vs 當日宇宙（未扣成本超額、勝率），並列同日 v2 Top20、v3 S Top20。
//   上游：每日 2 次官方除權息區間查詢＋自家處置名單 API（與人數無關）。任何來源失敗一律不寫（寧缺勿錯）。
//   用法：node scripts/swing-formula-shadow.mjs [--dry] [--date YYYY-MM-DD]（--date：以該日為資料日，補跑／測試用）
//     ⚠ --date 時處置名單與產業分群取「目前」的（沒有逐日歸檔）＝非時點正確，只供測試；正式紀錄只由每晚無 --date 的執行寫入。
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATS, LIMIT, mean, centeredRank, buildArrays, adjust, revenueIndex, makeFeatureFn, daySection, scoreWith } from './lib/swing-formula.mjs';
import { fetchExright, mergeFactorItems } from './lib/exright-source.mjs';
import { shadowBoard } from './lib/scoring-v3.mjs';
import { dropUndefined } from './lib/firestore-clean.mjs';

const DRY = process.argv.includes('--dry');
const AS_OF = (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : '') || '';
if (AS_OF && !/^\d{4}-\d{2}-\d{2}$/.test(AS_OF)) { console.log('✖ --date 格式須為 YYYY-MM-DD'); process.exit(1); }
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_BASE = process.env.APP_BASE || 'https://tw-stock-helper.web.app';
const LOAD_DAYS = 140;                               // 60 日特徵窗＋記分板回看
const TOP = 20, H = 5, BOARD_DAYS = 60;
const MIN = { inst: 1200, margin: 1000, dayTrade: 300, industry: 1000 };   // 當日資料齊全門檻（上櫃法人 15:15 先到、資券 21:30 後才有）
const r2 = x => (Number.isFinite(x) ? +x.toFixed(2) : null);
const fail = msg => { console.log(`✖ 標靶公式影子：${msg}`); process.exit(1); };

function initDb() {
  if (!getApps().length) { const p = process.env.GOOGLE_APPLICATION_CREDENTIALS; initializeApp(p ? { credential: cert(JSON.parse(readFileSync(p, 'utf8'))) } : {}); }
  return getFirestore();
}

const W = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'swing-formula-weights.json'), 'utf8'));
if (!W.passed) { console.log('· 標靶公式影子：權重未通過驗證，不執行'); process.exit(0); }
if (W.features?.join(',') !== FEATS.map(f => f[0]).join(',')) fail('權重檔特徵順序與計算核心不一致');

const db = initDb();
let q = db.collection('chipArchive').orderBy('date', 'desc');
if (AS_OF) q = q.where('date', '<=', AS_OF);
const rows = (await q.limit(LOAD_DAYS).select('date', 'closeJson', 'instJson', 'marginJson', 'dayTradeJson').get()).docs.map(d => d.data()).filter(a => a?.closeJson).reverse();
const D = buildArrays(rows);
if (D.N < 70) fail(`歸檔只有 ${D.N} 日`);
const t = D.N - 1, date = D.dates[t];
// 2026-10-09（同類缺口 B 類）：正式執行（無 --date）時，最新歸檔必須是今天（台北）。
//   舊版取 chipArchive 最新一天、不檢查日期：當日歸檔不存在時會用前一日資料「成功」跑完，daemon 隨即把今天標成完成。
//   例外：台北 09:00 前（下一交易日開盤前）手動補跑前一交易日（--run swingFormula）仍允許——歸檔日在 4 個日曆日內（涵蓋週末）。
if (!AS_OF) {
  const nowTw = new Date(Date.now() + 8 * 3600e3);
  const todayTw = nowTw.toISOString().slice(0, 10);
  const preOpen = nowTw.getUTCHours() < 9 && date < todayTw && (Date.parse(todayTw) - Date.parse(date)) <= 4 * 86400e3;
  if (date !== todayTw && !preOpen) fail(`最新收盤歸檔是 ${date}，不是今天 ${todayTw}（當日歸檔未到）`);
}
const lastRow = rows.find(r => r.date === date) || {};
const cnt = j => { try { return Object.keys(JSON.parse(j || '{}')).length; } catch { return 0; } };
const have = { inst: cnt(lastRow.instJson), margin: cnt(lastRow.marginJson), dayTrade: cnt(lastRow.dayTradeJson) };
for (const k of ['inst', 'margin', 'dayTrade']) if (have[k] < MIN[k]) fail(`${date} ${k} 僅 ${have[k]} 檔（<${MIN[k]}，未齊）`);

// 月營收（M 月自 M+1 月 11 日起可用）、產業分群（自家 peerComps）
const rev = (await db.collection('revenueArchive').get()).docs.map(d => ({ month: d.id, rowsJson: d.data().rowsJson }));
const ind = {};
try {
  const pc = (await db.collection('peerComps').doc('latest').get()).data();
  const g = pc?.industriesJson ? JSON.parse(pc.industriesJson) : {};
  for (const k in g) for (const it of g[k] || []) if (/^\d{4}$/.test(it?.code || '') && !ind[it.code]) ind[it.code] = k;
} catch (e) { fail(`產業分群讀取失敗：${(e.message || '').slice(0, 60)}`); }
if (Object.keys(ind).length < MIN.industry) fail(`產業分群只有 ${Object.keys(ind).length} 檔`);

// 還原：窗內官方除權息（失敗就不算——未還原的除息跳空會污染報酬特徵）＋ priceEvents 減資／面額變更
let ex;
try { ex = await fetchExright(D.dates[0], date); } catch (e) { fail(`除權息來源失敗：${(e.message || '').slice(0, 80)}`); }
const pe = (await db.collection('priceEvents').doc('latest').get()).data()?.items;
// G2-26：事件表不存在／無 items＝讀取失敗（不可當「沒有減資事件」以未還原價寫影子記錄）
if (!Array.isArray(pe)) fail('priceEvents/latest 不存在或沒有 items');
const adj = adjust(D, mergeFactorItems(ex.items, pe));

// 處置股排除（名單取不到或殘缺 ⇒ 不寫）
let disp;
try {
  const rs = await fetch(`${APP_BASE}/api/twse/risk-stocks`, { signal: AbortSignal.timeout(8000) }).then(x => (x.ok ? x.json() : null));
  if (!rs || !Array.isArray(rs.disposition) || rs.dispositionComplete === false) fail('處置名單取不到或殘缺');
  disp = new Set(rs.disposition.filter(x => x.code && (!x.endDate || x.endDate >= date)).map(x => x.code));
} catch (e) { fail(`處置名單抓取失敗：${(e.message || '').slice(0, 60)}`); }

// ── 今日分數 ──
const fn = makeFeatureFn(D, adj);
const sec = daySection(D, adj, fn, t, revenueIndex(rev)(date), ind, disp);
if (!sec) fail(`${date} 宇宙不足`);
const coef = sec.bull ? W.coef.bull : W.coef.bear;
const score = scoreWith(sec.X, coef), pctOf = centeredRank(score).map(r => (r + 0.5) * 100);
const order = Array.from(score.keys()).sort((a, b) => score[b] - score[a]);
// 前 3 大貢獻：寫出特徵在當日宇宙「偏高／偏低」與對分數「加分／減分」（例：20 日波動偏低（加分）），避免把貢獻正負誤讀成特徵高低
const why = i => FEATS.map(([k, label], j) => ({ k, label, x: sec.X[j][i], c: coef[j] * sec.X[j][i] })).filter(x => x.c).sort((a, b) => Math.abs(b.c) - Math.abs(a.c)).slice(0, 3)
  .map(x => `${x.label}${x.x > 0 ? '偏高' : '偏低'}（${x.c > 0 ? '加分' : '減分'}）`);
const top = order.slice(0, TOP).map(i => ({ code: D.codes[sec.cis[i]], pct: r2(pctOf[i]), why: why(i) }));
const topOf = async (coll, pick) => { try { return pick((await db.collection(coll).doc(date).get()).data()) || []; } catch { return []; } };
const v2Top20 = await topOf('picksHistory', d => (d?.top20 || []).map(p => p.code).filter(Boolean));
const v3Top20 = await topOf('scoringV3', d => (d?.scores?.S?.top || []).map(p => p.code).filter(Boolean));
const doc = { date, version: W.version, h: H, regime: sec.bull ? '多頭' : '空頭', universe: sec.cis.length, dispExcluded: disp.size, have,
  exright: ex.counts, top, v2Top20, v3Top20, at: Date.now(),
  pctJson: JSON.stringify(Object.fromEntries(sec.cis.map((ci, i) => [D.codes[ci], r2(pctOf[i])]))),
  note: '影子模式：只記錄、不影響任何榜單。5 日持有口徑（D+1 開盤買、第 5 日收盤賣）；分數依市況選多頭／空頭係數。未扣成本。非投資建議。' };

// ── 記分板：過去影子日（5 日已到期）前 20 名 vs 當日宇宙；並列 v2／v3 Top20（同一標籤口徑、同一宇宙基準）──
const { N } = D, { cA, oA } = adj, idxOf = new Map(D.dates.map((d, i) => [d, i]));
const ret = (ci, i) => { const b = ci * N, o1 = oA[b + i + 1], ch = cA[b + i + H]; return o1 > 0 && ch > 0 && o1 / cA[b + i] - 1 < LIMIT ? (ch / o1 - 1) * 100 : NaN; };
const hist = (await db.collection('swingFormula').orderBy('date', 'desc').limit(BOARD_DAYS + 6).get()).docs
  .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d.id) && d.id < date).map(d => d.data()).filter(h => h.version === W.version);
const rowsB = [];
for (const h of hist) {
  const i = idxOf.get(h.date); if (i == null || i + H >= N || !h.pctJson) continue;
  const uni = Object.keys(JSON.parse(h.pctJson)).map(c => D.codeIdx.get(c)).filter(ci => ci != null);
  const base = uni.map(ci => ret(ci, i)).filter(Number.isFinite); if (base.length < 100) continue;
  const mu = mean(base), ex5 = codes => codes.map(c => D.codeIdx.get(c)).filter(ci => ci != null).map(ci => ret(ci, i) - mu).filter(Number.isFinite);
  const tp = ex5((h.top || []).map(x => x.code)), v2 = ex5(h.v2Top20 || []), v3 = ex5(h.v3Top20 || []);
  rowsB.push({ date: h.date, regime: h.regime, top: r2(mean(tp)), topHit: r2(tp.filter(x => x > 0).length / (tp.length || NaN) * 100),
    uniHit: r2(base.filter(x => x > mu).length / base.length * 100), v2: r2(mean(v2)), v3: r2(mean(v3)), n: tp.length });
}
const recent = rowsB.slice(0, BOARD_DAYS);
const vs = key => { const b = shadowBoard(recent.map(r => ({ date: r.date, v3: r.top, v2: r[key] }))); return { n: b.n, formula: r2(b.v3), other: r2(b.v2), diff: r2(b.diff), lo: r2(b.lo), hi: r2(b.hi), ready: b.switchReady }; };
const boardDoc = { updatedAt: Date.now(), dataDate: date, version: W.version, h: H, n: recent.length,
  top: r2(mean(recent.map(r => r.top))), topHit: r2(mean(recent.map(r => r.topHit))), uniHit: r2(mean(recent.map(r => r.uniHit))),
  vsV2: vs('v2'), vsV3: vs('v3'), rows: recent,
  rule: '累積 ≥20 個交易日且（與 v2 的差值 95% CI 下界 > 0，或兩者皆負時公式損失較小）⇒ 提請使用者決定；5 日重疊樣本的 CI 偏窄，僅供參考。',
  note: '超額＝前 20 名平均 − 當日宇宙等權平均（未扣成本；成本依持有方式另計）。非投資建議。' };

console.log(`🎯 標靶公式 ${date}（${doc.regime}係數）：宇宙 ${doc.universe}（排除處置 ${disp.size}）、前 5 ${top.slice(0, 5).map(x => x.code).join(' ')}｜記分板 ${boardDoc.n} 日 前20 ${boardDoc.top ?? '—'}%（勝率 ${boardDoc.topHit ?? '—'}% vs 宇宙 ${boardDoc.uniHit ?? '—'}%）`);
if (DRY) process.exit(0);
await db.collection('swingFormula').doc(date).set(dropUndefined(doc));
await db.collection('swingFormula').doc('latest').set(dropUndefined(doc));
await db.collection('swingFormula').doc('scoreboard').set(dropUndefined(boardDoc));
console.log(`✓ 標靶公式影子 ${date} 已寫入（${doc.regime}、法人 ${have.inst}／資券 ${have.margin}／當沖 ${have.dayTrade} 檔）`);
process.exit(0);
