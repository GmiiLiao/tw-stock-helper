#!/usr/bin/env node
// ── 法人倒貨獲利了結 vs 漲停訊號 實證分析（120日 chipDaily × chipArchive）──
// 問題：①倒貨了結由哪些因素觸發？加碼多少、漲幅多少才倒？②漲停是否同因素？
//   ③過漲停後是否續加碼誘散戶接手再出脫？誠實：~90日一季樣本、多頭期，描述統計為主。
import admin from 'firebase-admin';
process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const cd = await db.collection('chipDaily').orderBy('date', 'asc').get();
const instDates = []; const inst = {}; // date[], inst[date]={code:[f,t,d]}
for (const d of cd.docs) { const x = d.data(); if (x.codesJson) { instDates.push(x.date); inst[x.date] = JSON.parse(x.codesJson); } }
const arch = await db.collection('chipArchive').orderBy('date', 'asc').get();
const px = {}; // date -> {code:[close,vol,...]}
for (const d of arch.docs) { const x = d.data(); if (x.closeJson) px[x.date] = JSON.parse(x.closeJson); }
// 對齊有價格的法人日
const dates = instDates.filter(d => px[d]);
console.log(`法人×價格對齊 ${dates.length} 日：${dates[0]} → ${dates[dates.length - 1]}`);
const close = (code, d) => px[d]?.[code]?.[0] || 0;
const vol = (code, d) => px[d]?.[code]?.[1] || 0;
const net = (code, d) => { const r = inst[d]?.[code]; return r ? (r[0] || 0) + (r[1] || 0) + (r[2] || 0) : 0; };
const tick = p => p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
const isLimit = (c, pc) => pc > 0 && c > 0 && c >= Math.floor(pc * 1.1 / tick(pc)) * tick(pc) - 1e-9;
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// 全市場代碼（有足夠價量）
const codes = new Set();
for (const d of dates) for (const c in (px[d] || {})) if (/^\d{4}$/.test(c) && !c.startsWith('00')) codes.add(c);

// ── A. 倒貨episode：累計籌碼創峰值後回落≥30% ──────────────────────────
const episodes = [];
for (const code of codes) {
  // 建累計序列
  const cum = []; let s = 0;
  for (const d of dates) { s += net(code, d); cum.push(s); }
  const avgV = med(dates.map(d => vol(code, d)).filter(v => v > 0)) || 0;
  if (avgV < 200) continue; // 流動性
  // 找峰值(全期最大累計)且其後回落≥30%
  let peakI = 0; for (let i = 1; i < cum.length; i++) if (cum[i] > cum[peakI]) peakI = i;
  const peak = cum[peakI];
  if (peak < 500) continue; // 需實際累積加碼
  // 加碼起點=峰值前的累計低點
  let startI = 0; for (let i = peakI; i >= 0; i--) if (cum[i] < cum[startI]) startI = i;
  const trough = cum[startI];
  const added = peak - trough; // 加碼量(張)
  // 峰值後最低累計(倒貨底)
  let endI = peakI; for (let i = peakI; i < cum.length; i++) if (cum[i] < cum[endI]) endI = i;
  const distributed = peak - cum[endI];
  const distPct = peak > 0 ? distributed / peak * 100 : 0;
  if (distPct < 30 || endI <= peakI) continue; // 需真的倒貨
  const pStart = close(code, dates[startI]), pPeak = close(code, dates[peakI]), pEnd = close(code, dates[endI]);
  if (!(pStart > 0) || !(pPeak > 0) || !(pEnd > 0)) continue;
  // 誰先轉賣：峰值後 3 日 外資/投信 淨額
  const f3 = [1, 2, 3].reduce((a, k) => a + (inst[dates[peakI + k]]?.[code]?.[0] || 0), 0);
  const t3 = [1, 2, 3].reduce((a, k) => a + (inst[dates[peakI + k]]?.[code]?.[1] || 0), 0);
  // 峰值時是否處 20 日高
  let hi20 = 0; for (let k = Math.max(0, peakI - 20); k < peakI; k++) hi20 = Math.max(hi20, close(code, dates[k]));
  episodes.push({
    code, added, addedPctVol: avgV > 0 ? +(added / avgV).toFixed(1) : 0,
    riseToPeak: +((pPeak - pStart) / pStart * 100).toFixed(1),
    peakToEnd: +((pEnd - pPeak) / pPeak * 100).toFixed(1), // 倒貨後股價(法人賣在高點=負→了結成功)
    distPct: +distPct.toFixed(0), foreignFirst: f3 < 0 && f3 < t3, fFirst3: Math.round(f3), tFirst3: Math.round(t3),
    atHigh: pPeak >= hi20 * 0.98, days: peakI - startI,
  });
}
console.log(`\n══ A. 倒貨獲利了結 episode（累計峰值後回落≥30%，${episodes.length} 檔）══`);
console.log(`  加碼量中位 ${med(episodes.map(e => e.added))} 張（= ${med(episodes.map(e => e.addedPctVol))} 倍日均量）`);
console.log(`  加碼期漲幅中位 ${med(episodes.map(e => e.riseToPeak))}%（起漲→籌碼峰值）`);
console.log(`  倒貨後股價中位 ${med(episodes.map(e => e.peakToEnd))}%（負=法人賣在相對高點=了結成功）`);
console.log(`  賣在20日高附近占比 ${(episodes.filter(e => e.atHigh).length / episodes.length * 100).toFixed(0)}%`);
console.log(`  外資「先」轉賣(領先投信)占比 ${(episodes.filter(e => e.foreignFirst).length / episodes.length * 100).toFixed(0)}%`);
console.log(`  加碼天數中位 ${med(episodes.map(e => e.days))} 交易日`);
// 分組：漲幅 vs 倒貨後報酬（了結時機）
for (const [lab, lo, hi] of [['漲幅<10%', -999, 10], ['10-30%', 10, 30], ['30-60%', 30, 60], ['≥60%', 60, 9999]]) {
  const g = episodes.filter(e => e.riseToPeak >= lo && e.riseToPeak < hi);
  if (g.length < 3) continue;
  console.log(`  [加碼期漲${lab}] n=${g.length} 倒貨後股價中位 ${med(g.map(e => e.peakToEnd))}% 加碼中位 ${med(g.map(e => e.added))}張`);
}

// ── B. 漲停的法人signature（是否同因素）──────────────────────────────
let luDays = 0, luForeignBuy = 0, luChipCum = [], luRise5 = [];
const base = { n: 0, fBuy: 0 };
for (let i = 21; i < dates.length - 1; i++) {
  const d = dates[i], pd = dates[i - 1];
  for (const c of codes) {
    const pc = close(c, pd), cc = close(c, d); if (!(pc > 0) || !(cc > 0)) continue;
    base.n++; if (net(c, pd) > 0) base.fBuy++;
    if (isLimit(cc, pc)) {
      luDays++;
      // 漲停前一日(進場時已知)法人淨 + 前5日累計
      if (net(c, pd) > 0) luForeignBuy++;
      let cum5 = 0; for (let k = 1; k <= 5; k++) cum5 += net(c, dates[i - k]); luChipCum.push(cum5);
      const p5 = close(c, dates[i - 5]); if (p5 > 0) luRise5.push((pc - p5) / p5 * 100);
    }
  }
}
console.log(`\n══ B. 漲停的法人signature（${luDays} 漲停日次）══`);
console.log(`  漲停前一日法人買超占比 ${(luForeignBuy / luDays * 100).toFixed(0)}%（全市場基準 ${(base.fBuy / base.n * 100).toFixed(0)}%）`);
console.log(`  漲停前5日法人累計淨中位 ${med(luChipCum)} 張、前5日漲幅中位 ${med(luRise5)?.toFixed(1)}%`);
console.log(`  → 若占比≈基準、累計≈0，代表漲停與法人加碼「不同因素」（漲停=短線動能）`);

// ── C. 過漲停後是否續加碼誘散戶再出脫 ────────────────────────────────
let afterN = 0, keepBuy = 0, turnSell = 0, sellAndDrop = 0;
const postRet = [];
for (let i = 21; i < dates.length - 6; i++) {
  const d = dates[i], pd = dates[i - 1];
  for (const c of codes) {
    const pc = close(c, pd), cc = close(c, d); if (!(pc > 0) || !(cc > 0)) continue;
    if (!isLimit(cc, pc)) continue;
    // 漲停後 5 日：法人淨、股價
    let f5 = 0; for (let k = 1; k <= 5; k++) f5 += net(c, dates[i + k]);
    const p0 = cc, p5 = close(c, dates[i + 5]); if (!(p5 > 0)) continue;
    afterN++;
    if (f5 > 0) keepBuy++; else turnSell++;
    if (f5 < 0) postRet.push((p5 - p0) / p0 * 100);
    if (f5 < 0 && p5 < p0) sellAndDrop++;
  }
}
console.log(`\n══ C. 過漲停後法人行為（${afterN} 例）══`);
console.log(`  漲停後5日法人「續買」占比 ${(keepBuy / afterN * 100).toFixed(0)}% · 「轉賣」占比 ${(turnSell / afterN * 100).toFixed(0)}%`);
console.log(`  轉賣者其後5日股價中位 ${med(postRet)?.toFixed(1)}%（負=法人漲停後倒貨、散戶接手下跌）`);
console.log(`  「轉賣且下跌」占轉賣 ${(sellAndDrop / Math.max(turnSell, 1) * 100).toFixed(0)}%`);
// ── D. 融資接棒訊號：外資賣超×融資增減 → 後5日報酬 ─────────────────────
const marginByDate = {}; // date -> {code: 資餘張}
for (const d of arch.docs) { const x = d.data(); if (x.marginJson) { const m = JSON.parse(x.marginJson); const o = {}; for (const c in m) o[c] = m[c][0] || 0; marginByDate[x.date] = o; } }
const mDates = dates.filter(d => marginByDate[d]);
console.log(`\n══ D. 融資接棒（融資資料 ${mDates.length} 日）══`);
const groups = { sellUp: [], sellDown: [], buyUp: [], sellUpWin: 0, sellDownWin: 0 };
const fwd = 5;
for (let i = 1; i < mDates.length; i++) {
  const d = mDates[i], pd = mDates[i - 1];
  const di = dates.indexOf(d);
  if (di < 0 || di + fwd >= dates.length) continue;
  for (const c of codes) {
    const m0 = marginByDate[d][c], m1 = marginByDate[pd][c];
    if (!(m0 > 0) || !(m1 > 0)) continue;
    const f = inst[d]?.[c]?.[0] || 0;
    const p0 = close(c, d), p5 = close(c, dates[di + fwd]);
    if (!(p0 > 0) || !(p5 > 0) || vol(c, d) < 200) continue;
    const ret = (p5 - p0) / p0 * 100;
    const marginUp = m0 > m1 * 1.02; // 融資增 >2%
    const marginDown = m0 < m1 * 0.98;
    if (f < -100 && marginUp) { groups.sellUp.push(ret); if (ret > 0) groups.sellUpWin++; }
    else if (f < -100 && marginDown) { groups.sellDown.push(ret); if (ret > 0) groups.sellDownWin++; }
    else if (f > 100 && marginUp) groups.buyUp.push(ret);
  }
}
console.log(`  外資賣超+融資增(散戶接棒): 後5日中位 ${med(groups.sellUp)?.toFixed(2)}%、勝率 ${(groups.sellUpWin / Math.max(groups.sellUp.length, 1) * 100).toFixed(0)}% (n=${groups.sellUp.length})`);
console.log(`  外資賣超+融資減(同步撤退): 後5日中位 ${med(groups.sellDown)?.toFixed(2)}%、勝率 ${(groups.sellDownWin / Math.max(groups.sellDown.length, 1) * 100).toFixed(0)}% (n=${groups.sellDown.length})`);
console.log(`  外資買超+融資增(對照組):   後5日中位 ${med(groups.buyUp)?.toFixed(2)}% (n=${groups.buyUp.length})`);

// ── E. 外資先轉賣（領先投信）→ 後5日報酬（驗證領先訊號可操作性）──────
const lead = { fFirst: [], both: [], tOnly: [] };
for (let i = 1; i < dates.length - 5; i++) {
  const d = dates[i];
  for (const c of codes) {
    const r = inst[d]?.[c]; if (!r) continue;
    const f = r[0] || 0, t = r[1] || 0;
    const p0 = close(c, d), p5 = close(c, dates[i + 5]);
    if (!(p0 > 0) || !(p5 > 0) || vol(c, d) < 200) continue;
    // 條件：近5日法人有實質累計(≥500張)＝有貨可倒
    let cum5 = 0; for (let k = 1; k <= 5 && i - k >= 0; k++) cum5 += net(c, dates[i - k]);
    if (cum5 < 500) continue;
    const ret = (p5 - p0) / p0 * 100;
    if (f < -100 && t >= 0) lead.fFirst.push(ret);       // 外資先跑、投信還沒
    else if (f < -100 && t < 0) lead.both.push(ret);     // 雙賣
    else if (f >= 0 && t < -100) lead.tOnly.push(ret);   // 只投信賣
  }
}
console.log(`\n══ E. 有貨在手(5日累計≥500張)時的轉賣型態 → 後5日報酬 ══`);
console.log(`  外資先轉賣(投信未跟): 中位 ${med(lead.fFirst)?.toFixed(2)}% (n=${lead.fFirst.length})`);
console.log(`  外資投信雙賣:         中位 ${med(lead.both)?.toFixed(2)}% (n=${lead.both.length})`);
console.log(`  僅投信賣(外資沒賣):   中位 ${med(lead.tOnly)?.toFixed(2)}% (n=${lead.tOnly.length})`);

console.log('\n（~一季樣本、多頭期，描述統計；確定性計算，非投資建議）');
process.exit(0);
