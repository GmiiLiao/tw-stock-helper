#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 出場時點模型（隔日沖的「賣點」研究——本輪稽核最大穩定效應：明開賣vs明收賣差0.3~0.5pp）
// 規則族（今收買·扣0.4425%）：
//   A 一律明開賣    B 一律明收賣
//   C1 開高(≥昨收)抱到收盤，開低立刻開盤賣（常見「開低停損」紀律）
//   C2 開高≥+1%才抱到收盤，其餘開盤賣
//   C3 開高≥+2%才抱到收盤，其餘開盤賣
//   C4 反向：開高開盤賣(獲利入袋)，開低抱到收盤(凹)——對照組
//   STOP 開盤賣但若開低>2%視為-2%停損上限（跳空風險示意）
// 池：①定版撿尾盤濾網 ②綜合行動區代理(漲1~7%×量≥昨量) 兩池×兩半窗。
// 上界參考：明日最高價均值（不可實現，僅示意留倉空間）。非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, COST } from './lib/bt-core.mjs';

const days = await loadDays({ days: 700 });
const samples = buildSamples(days).filter(s => s.tradable);
console.log(`交易日 ${days.length}·可交易樣本 ${samples.length.toLocaleString()}`);

const RULES = {
  'A 一律開盤賣': s => s.rNO,
  'B 一律收盤賣': s => s.rNC,
  'C1 開≥昨收抱收盤·開低開盤賣': s => (s.rNO >= 0 ? s.rNC : s.rNO),
  'C2 開≥+1%抱收盤·其餘開盤賣': s => (s.rNO >= 1 ? s.rNC : s.rNO),
  'C3 開≥+2%抱收盤·其餘開盤賣': s => (s.rNO >= 2 ? s.rNC : s.rNO),
  'C4 對照:開高開盤賣·開低凹到收盤': s => (s.rNO >= 0 ? s.rNO : s.rNC),
};
const avg = a => a.length ? +(a.reduce((t, v) => t + v, 0) / a.length).toFixed(3) : null;

const POOLS = {
  '定版撿尾盤濾網(破20日高×強尾×3~7)': s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7,
  '上漲活躍池(漲1~7×量增)': s => s.chg >= 1 && s.chg <= 7 && s.volX >= 1,
};
for (const [pname, pcond] of Object.entries(POOLS)) {
  const pool = samples.filter(pcond);
  console.log(`\n══ ${pname}（n=${pool.length.toLocaleString()}）══`);
  console.log(`  上界參考：明日最高均 +${avg(pool.map(s => s.rNH))}%·明日最低均 ${avg(pool.map(s => s.rNL))}%（路徑不可知，僅示意）`);
  for (const [rname, fn] of Object.entries(RULES)) {
    const h = [0, 1].map(half => {
      const sub = pool.filter(s => s.half === half);
      const rets = sub.map(s => fn(s) - COST);
      return { net: avg(rets), win: +(rets.filter(v => v > 0).length / rets.length * 100).toFixed(1) };
    });
    console.log(`  ${rname.padEnd(24)} 前半[淨均${h[0].net}%·淨勝${h[0].win}%]  後半[淨均${h[1].net}%·淨勝${h[1].win}%]`);
  }
  // 開盤缺口分佈（C 規則的分岔點分佈）
  const gapUp = pool.filter(s => s.rNO >= 0).length;
  console.log(`  （開高比例 ${(gapUp / pool.length * 100).toFixed(1)}%）`);
}
console.log('\n※ 兩半窗同向最優者才可寫入說明書出場紀律。非投資建議。');
process.exit(0);
