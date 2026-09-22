#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────
// 軋空候選 × MACD 狀態稽核（2026-09-22 使用者：「請確定 MACD 在 0 線以上且向上翻紅」＋「用錯誤條件來學習」）
//   · 母體＝站上軋空候選規則（漲≥5% × 券資比≥5% × 融券日增>0 × 20 日均量≥500 張 × 價>10），250 日、PIT 口徑同 v2
//   · MACD(12,26,9) 由 chipArchive 還原收盤逐檔計算；狀態：dif>0／柱>0／柱上升／翻紅（柱由負轉正）／使用者條件（dif>0 且柱>0 且上升）
//   · 結果：隔日開盤報酬（今收→明開）、當沖（明開→明收）、隔日收盤、軋空率（漲≥5% 且融券真減）、漲停率、鎖死率
//   · 尺：與 v2 同一把（日層級超額 vs 純動能基準、區塊自助 CI、固定切點 06-10 樣本外）
//   · 錯誤學習：把「失敗」（隔日開盤報酬 ≤0）與「成功」分開，看每個條件在兩組的出現率與成功率／提升度
// 唯讀：不寫任何 Firestore。用法：GOOGLE_APPLICATION_CREDENTIALS=… node scripts/squeeze-macd-audit.mjs
// ─────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { buildSamples, TRADE_MODES, OOS_FROM, evalGroup, dayBaseline } from './squeeze-train.mjs';

if (!getApps().length) initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
const db = getFirestore();
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const pct = (a, f) => (a.length ? +(a.filter(f).length / a.length * 100).toFixed(1) : null);
const r2 = v => (v == null ? '—' : +v.toFixed(2));

function ema(arr, n) { const k = 2 / (n + 1); const out = []; let e = null; for (const v of arr) { e = e == null ? v : v * k + e * (1 - k); out.push(e); } return out; }
// 回傳每個 t 的 { dif, dea, hist }（前 34 根為 null，不假裝有值）
function macdSeries(closes) {
  const e12 = ema(closes, 12), e26 = ema(closes, 26);
  const dif = closes.map((_, i) => e12[i] - e26[i]);
  const dea = ema(dif, 9);
  return closes.map((_, i) => (i < 34 ? null : { dif: dif[i], dea: dea[i], hist: dif[i] - dea[i] }));
}

const { samples, days } = await buildSamples(db, { days: 250 });
// 逐檔 MACD（只算出現在樣本裡的檔）
const codes = [...new Set(samples.map(s => s.code))];
const macdBy = {};
for (const code of codes) {
  const closes = days.map(d => d.close[code]?.[0]);
  if (closes.some(v => !(v > 0))) {   // 有缺日就逐段補：缺值用前一日（不影響狀態判斷的方向，僅少量）
    let last = null; for (let i = 0; i < closes.length; i++) { if (closes[i] > 0) last = closes[i]; else closes[i] = last; }
  }
  if (closes.some(v => !(v > 0))) continue;
  macdBy[code] = macdSeries(closes);
}
// 母體：站上軋空候選規則
const pool = samples.filter(s => s.f.chg >= 5 && s.f.ratio != null && s.f.ratio >= 5 && s.f.shrtChg != null && s.f.shrtChg > 0 && s.f.close > 10);
for (const s of pool) {
  const m = macdBy[s.code]?.[s.t], mp = macdBy[s.code]?.[s.t - 1];
  s.macd = m && mp ? { dif0: m.dif > 0, hist0: m.hist > 0, rising: m.hist > mp.hist, turn: m.hist > 0 && mp.hist <= 0, user: m.dif > 0 && m.hist > 0 && m.hist > mp.hist, dea0: m.dea > 0 } : null;
}
const withM = pool.filter(s => s.macd);
console.log(`\n母體：軋空候選規則 ${pool.length} 筆（MACD 可算 ${withM.length}）｜期間 ${days[0].date}～${days[days.length - 1].date}｜樣本外自 ${OOS_FROM}`);

const COND = [
  ['全部候選', () => true],
  ['DIF>0（0 線上）', s => s.macd.dif0],
  ['DIF≤0（0 線下）', s => !s.macd.dif0],
  ['柱>0', s => s.macd.hist0],
  ['柱>0 且上升', s => s.macd.hist0 && s.macd.rising],
  ['翻紅（柱負轉正）', s => s.macd.turn],
  ['使用者條件：DIF>0 且柱>0 且上升', s => s.macd.user],
  ['DIF>0 且翻紅', s => s.macd.dif0 && s.macd.turn],
  ['反例：DIF≤0 或柱下降', s => !s.macd.dif0 || !s.macd.rising],
];
// ── 表 1：各狀態的原始結果 ──
console.log('\n表 1｜各 MACD 狀態的原始結果（全期）');
console.log('狀態 | n | 隔日開盤均 | 開盤勝率 | 當沖均 | 隔日收盤均 | 軋空率 | 漲停率 | 今收鎖死率(買不到)');
for (const [name, fn] of COND) {
  const g = withM.filter(fn); const ok = g.filter(x => x.y.openRet != null);
  console.log(`${name} | ${g.length} | ${r2(mean(ok.map(x => x.y.openRet)))}% | ${pct(ok, x => x.y.openRet > 0)}% | ${r2(mean(g.filter(x => x.y.dtRet != null).map(x => x.y.dtRet)))}% | ${r2(mean(g.filter(x => x.y.closeRet != null).map(x => x.y.closeRet)))}% | ${pct(g, x => x.y.squeeze === 1)}% | ${pct(g, x => x.y.limitUp === 1)}% | ${pct(g, x => x.y.entryLocked === 1)}%`);
}
// ── 表 2：v2 尺（可買、日層級超額 vs 純動能、樣本外）──
for (const key of ['nextday', 'daytrade']) {
  const mode = TRADE_MODES[key];
  const all = samples.filter(x => mode.entryOk(x.y) && mode.ret(x.y) != null && x.f.chg >= 5);
  const tr = all.filter(x => x.date < OOS_FROM), oo = all.filter(x => x.date >= OOS_FROM);
  const bTr = dayBaseline(tr, mode), bOo = dayBaseline(oo, mode);
  console.log(`\n表 2｜v2 尺 [${key}] ${mode.label}：日層級超額 vs 純動能（漲≥5%），可買口徑，扣費稅淨報酬`);
  console.log('條件 | 訓練 n/日 | 訓練超額 CI | 樣本外 n/日 | 樣本外超額 CI | 樣本外淨報酬 CI | 判定');
  for (const [name, fn] of COND) {
    const sel = x => x.macd && fn(x) && x.f.ratio != null && x.f.ratio >= 5 && x.f.shrtChg > 0;
    const setM = x => { if (!x.macd) { const m = macdBy[x.code]?.[x.t], mp = macdBy[x.code]?.[x.t - 1]; x.macd = m && mp ? { dif0: m.dif > 0, hist0: m.hist > 0, rising: m.hist > mp.hist, turn: m.hist > 0 && mp.hist <= 0, user: m.dif > 0 && m.hist > 0 && m.hist > mp.hist } : null; } return x; };
    const gTr = tr.map(setM).filter(sel), gOo = oo.map(setM).filter(sel);
    const a = evalGroup(gTr, mode, bTr, null), b = evalGroup(gOo, mode, bOo, null);
    const f = r => (r.excess == null ? `n=${r.n} ${r.why}` : `${r.excess}pp [${r.ci}]`);
    console.log(`${name} | ${a.n}/${a.days} | ${f(a)} | ${b.n}/${b.days} | ${f(b)} | ${b.net ? `${b.net.mean}% [${b.net.ci}]` : '—'} | ${b.pass ? '✅' : '✗ ' + b.why}`);
  }
}
// ── 表 3：錯誤學習——失敗組 vs 成功組的條件出現率與提升度 ──
console.log('\n表 3｜錯誤學習：以「隔日開盤報酬 ≤0」為失敗（可買口徑），各條件在失敗組／成功組的出現率，與該條件下的成功率');
const buyable = withM.filter(x => x.y.entryLocked === 0 && x.y.openRet != null);
const fail = buyable.filter(x => x.y.openRet <= 0), succ = buyable.filter(x => x.y.openRet > 0);
console.log(`可買候選 ${buyable.length}：成功 ${succ.length}（${pct(buyable, x => x.y.openRet > 0)}%）、失敗 ${fail.length}`);
const LEARN = [
  ...COND.slice(1),
  ['漲停收盤（鎖死）', s => s.y.entryLocked === 1],
  ['漲 5～7%', s => s.f.chg < 7], ['漲 7～9%', s => s.f.chg >= 7 && s.f.chg < 9], ['漲 ≥9%', s => s.f.chg >= 9],
  ['券資比 5～10%', s => s.f.ratio < 10], ['券資比 10～20%', s => s.f.ratio >= 10 && s.f.ratio < 20], ['券資比 ≥20%', s => s.f.ratio >= 20],
  ['量比 ≥3x', s => s.f.volX != null && s.f.volX >= 3], ['量比 <1.5x', s => s.f.volX != null && s.f.volX < 1.5],
  ['收位 ≥0.9', s => s.f.pos != null && s.f.pos >= 0.9], ['收位 <0.6', s => s.f.pos != null && s.f.pos < 0.6],
  ['5 日漲幅 ≥15%（已漲多）', s => s.f.ret5 != null && s.f.ret5 >= 15],
  ['破 20 日高', s => s.f.brk20 === 1],
  ['空頭日', s => s.rg === 'bear'], ['多頭日', s => s.rg === 'bull'],
];
console.log('條件 | 失敗組出現率 | 成功組出現率 | 該條件下成功率 | 該條件下隔日開盤均 | n');
for (const [name, fn] of LEARN) {
  const g = buyable.filter(fn); if (!g.length) continue;
  console.log(`${name} | ${pct(fail, fn)}% | ${pct(succ, fn)}% | ${pct(g, x => x.y.openRet > 0)}% | ${r2(mean(g.map(x => x.y.openRet)))}% | ${g.length}`);
}
// ── 表 4：失敗型態——跳空開高走低、直接開低 ──
console.log('\n表 4｜失敗型態（可買候選）');
const gapUpFade = buyable.filter(x => x.y.openRet > 0 && x.y.dtRet != null && x.y.dtRet < 0);
const openDown = buyable.filter(x => x.y.openRet <= 0);
console.log(`開高走低（開盤>今收、收盤<開盤）：${gapUpFade.length}（${pct(buyable, x => x.y.openRet > 0 && x.y.dtRet != null && x.y.dtRet < 0)}%）｜直接開低：${openDown.length}（${pct(buyable, x => x.y.openRet <= 0)}%）`);
for (const [name, fn] of COND.slice(1)) {
  const g = buyable.filter(fn);
  console.log(`  ${name}：開高走低 ${pct(g, x => x.y.openRet > 0 && x.y.dtRet != null && x.y.dtRet < 0)}%、直接開低 ${pct(g, x => x.y.openRet <= 0)}%（n=${g.length}）`);
}
// ── 表 5：把失敗組過度出現的條件排除後，成功率能拉到多少（回答「用錯誤條件過濾，下次成功機率多大」）──
console.log('\n表 5｜排除「失敗組過度出現」條件後的成功率（可買口徑，全期 / 樣本外）');
const EXCL = [
  ['不排除', () => true],
  ['排除 5 日漲幅≥15%', s => !(s.f.ret5 != null && s.f.ret5 >= 15)],
  ['排除 量比≥3x', s => !(s.f.volX != null && s.f.volX >= 3)],
  ['排除 漲 7～9%', s => !(s.f.chg >= 7 && s.f.chg < 9)],
  ['排除 多頭日', s => s.rg !== 'bull'],
  ['排除 已漲多 ∪ 量比≥3x', s => !(s.f.ret5 != null && s.f.ret5 >= 15) && !(s.f.volX != null && s.f.volX >= 3)],
  ['排除 已漲多 ∪ 量比≥3x ∪ 漲7～9%', s => !(s.f.ret5 != null && s.f.ret5 >= 15) && !(s.f.volX != null && s.f.volX >= 3) && !(s.f.chg >= 7 && s.f.chg < 9)],
  ['上列 ＋ 使用者 MACD 條件', s => !(s.f.ret5 != null && s.f.ret5 >= 15) && !(s.f.volX != null && s.f.volX >= 3) && !(s.f.chg >= 7 && s.f.chg < 9) && s.macd.user],
];
console.log('過濾 | n | 成功率 | 隔日開盤均 | 樣本外 n | 樣本外成功率 | 樣本外開盤均');
for (const [name, fn] of EXCL) {
  const g = buyable.filter(fn); const o = g.filter(x => x.date >= OOS_FROM);
  console.log(`${name} | ${g.length} | ${pct(g, x => x.y.openRet > 0)}% | ${r2(mean(g.map(x => x.y.openRet)))}% | ${o.length} | ${pct(o, x => x.y.openRet > 0)}% | ${r2(mean(o.map(x => x.y.openRet)))}%`);
}
process.exit(0);
