// ─────────────────────────────────────────────────────────────────────────
// 隔日沖選股法（使用者提供三張方法論圖·2026-07-27）逐項檢定
// 新變數：①週轉率(當日成交股數÷發行股數) ②布林通道上軌 ③紅K(收>開)
// 已有變數對照：量比、收盤位置pos、炒作型
// 口徑＝隔日沖（今收買→明開賣為定版出場，同時看明收賣）·可交易宇宙·兩半窗·regime
// ⚠股數為當前值（慢變數·增資才變）用於歷史回測＝輕微前視，與產業別同性質，已註記
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, report } from './lib/bt-core.mjs';
import { createTpexClose } from './lib/tpex-close-quotes.mjs';
import { sharesOf } from './lib/tpex-close-parse.mjs';

// 發行股數（上市 t187ap03_L ＋ 上櫃 Capitals）
const shares = {};
for (let t = 0; t < 3; t++) {
  try {
    const r = await fetch('https://openapi.twse.com.tw/v1/opendata/t187ap03_L', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    const txt = await r.text(); if (!txt.startsWith('[')) { await new Promise(s => setTimeout(s, 3000)); continue; }
    for (const x of JSON.parse(txt)) {
      const c = (x['公司代號'] || '').trim();
      const n = parseFloat(String(x['已發行普通股數或TDR原股發行股數'] || '').replace(/,/g, ''));
      if (/^\d{4}$/.test(c) && n > 0) shares[c] = n;
    }
    break;
  } catch { await new Promise(s => setTimeout(s, 3000)); }
}
// 上櫃：Capitals＝股數。2026-10-08 改讀共用取得層最近一份已驗證檔（0 請求；舊版直打 openapi 4.7MB 沒有逾時，失敗時靜默——
//   上櫃 turn=null 被 `s.turn != null` 濾掉，檢定只剩上市樣本卻不告知）。讀不到就中止。
const nTse = Object.keys(shares).length;
const otcLatest = await createTpexClose({ network: 'never' }).getLatestTpexClose({ maxAgeDays: 30 });
let nOtc = 0;
for (const [c, n] of Object.entries(sharesOf(otcLatest?.rows))) if (!shares[c]) { shares[c] = n; nOtc++; }
if (nTse < 500 || nOtc < 500) {
  console.error(`✖ 發行股數不完整（上市 ${nTse}／上櫃 ${nOtc}）——中止，避免檢定結果只剩一個市場。上櫃讀共用快取／官方鏡像本機檔；沒有就先：node scripts/tpex-close-import.mjs <手動下載的上櫃收盤檔>`);
  process.exit(1);
}
console.log(`發行股數對照 ${Object.keys(shares).length} 檔（上市 ${nTse}／上櫃 ${nOtc}·取自 ${otcLatest.dataDate} ${otcLatest.source}）`);

const days = await loadDays({ days: 720 });
const samples = buildSamples(days);
// 布林通道（20MA±2σ）＋紅K＋週轉率
const hist = {};
for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
  if (!/^\d{4}$/.test(code)) continue;
  const c = days[i].close[code]?.[0]; if (c > 0) (hist[code] ||= []).push([i, c]);
}
const bb = {};
for (const code in hist) {
  const a = hist[code]; if (a.length < 25) continue;
  for (let k = 19; k < a.length; k++) {
    let s = 0; for (let j = 0; j < 20; j++) s += a[k - j][1];
    const m = s / 20;
    let v = 0; for (let j = 0; j < 20; j++) v += (a[k - j][1] - m) ** 2;
    const sd = Math.sqrt(v / 20);
    bb[a[k][0] + '_' + code] = { up: m + 2 * sd, mid: m, sd };
  }
}
for (const s of samples) {
  const b = bb[s.di + '_' + s.code];
  if (b) { s.bbUp = b.up; s.aboveBB = s.c > b.up; s.bbPos = b.sd > 0 ? (s.c - b.mid) / (2 * b.sd) : 0; }
  s.redK = s.c > s.o;                                    // 紅K（收>開）
  const sh = shares[s.code];
  s.turn = sh > 0 ? s.v * 1000 / sh * 100 : null;        // 週轉率%（成交張×1000÷發行股數）
}
const uni = samples.filter(s => s.tradable && s.bbUp != null && s.turn != null);
console.log(`可交易×資料齊備 ${uni.length.toLocaleString()}\n`);

report(uni, { title: '① 週轉率分桶（新變數）', groups: [
  { label: '週轉<0.5%', cond: s => s.turn < 0.5 },
  { label: '0.5~1%', cond: s => s.turn >= 0.5 && s.turn < 1 },
  { label: '1~3%', cond: s => s.turn >= 1 && s.turn < 3 },
  { label: '3~6%', cond: s => s.turn >= 3 && s.turn < 6 },
  { label: '6~10%', cond: s => s.turn >= 6 && s.turn < 10 },
  { label: '高週轉≥10%', cond: s => s.turn >= 10 },
]});
report(uni, { title: '② 布林通道上軌（新變數）', groups: [
  { label: '站上布林上軌', cond: s => s.aboveBB },
  { label: '未站上上軌', cond: s => !s.aboveBB },
  { label: '上軌×紅K', cond: s => s.aboveBB && s.redK },
  { label: '上軌×紅K×強尾', cond: s => s.aboveBB && s.redK && s.pos >= 0.7 },
]});
report(uni, { title: '③ 紅K + 相對高點（圖3核心）', groups: [
  { label: '紅K（收>開）', cond: s => s.redK },
  { label: '紅K×收位≥0.7', cond: s => s.redK && s.pos >= 0.7 },
  { label: '紅K×收位≥0.9', cond: s => s.redK && s.pos >= 0.9 },
  { label: '紅K×量比>1.5', cond: s => s.redK && s.volX > 1.5 },
]});
report(uni, { title: '④ SOP 完整組合（圖2四條件）', groups: [
  { label: '高週轉≥6%×量比>1.5×上軌×紅K強尾', cond: s => s.turn >= 6 && s.volX > 1.5 && s.aboveBB && s.redK && s.pos >= 0.7 },
  { label: '高週轉≥3%×量比>1.5×上軌×紅K強尾', cond: s => s.turn >= 3 && s.volX > 1.5 && s.aboveBB && s.redK && s.pos >= 0.7 },
  { label: '（去掉上軌）高週轉≥3%×量比>1.5×紅K強尾', cond: s => s.turn >= 3 && s.volX > 1.5 && s.redK && s.pos >= 0.7 },
  { label: '（去掉週轉）量比>1.5×上軌×紅K強尾', cond: s => s.volX > 1.5 && s.aboveBB && s.redK && s.pos >= 0.7 },
]});
report(uni, { title: '⑤ vs 現行定版濾網（破20日高×pos≥0.7×漲3~7%）', groups: [
  { label: '現行定版濾網', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 },
  { label: '定版×高週轉≥3%', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.turn >= 3 },
  { label: '定版×高週轉≥6%', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.turn >= 6 },
  { label: '定版×站上布林上軌', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.aboveBB },
  { label: '定版×紅K', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.redK },
]});
process.exit(0);
