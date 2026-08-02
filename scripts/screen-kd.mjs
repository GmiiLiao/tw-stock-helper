// ─────────────────────────────────────────────────────────────────────────
// KD（隨機指標）命題檢定 —— 2026-08-02
//
// 命題來源：使用者提出的教科書定義「判斷超買、超賣，以及尋找波段轉折點」。
// 口徑與站上 src/lib/twse-api.ts `calculateKD` 完全一致：
//   RSV = (C − Ln) / (Hn − Ln) × 100，n = 9
//   K = ⅔·前K + ⅓·RSV，D = ⅔·前D + ⅓·K，初始 K=D=50
//   —— 用 chipArchive 的真實盤中高低（列格式 [c,v,o,h,l]），非收盤價近似。
//
// 關卡（沿用 RSI／波段起漲同一套，過不了就是不採）：
//   ①兩半窗方向一致且幅度≥0.05 ②可交易宇宙（排除 chg>8.5%）③扣費稅
//   ④多空 regime 同向 ⑤第三獨立窗 OOT ⑥收賣／開賣／5日三口徑分開看
//
// 口徑鐵律：隔日開賣(netOpen) 是隔日沖的全部 edge；收賣、5日各屬不同語意，
//   不可混用（波段起漲就是因此獨立成榜、不併入隔日沖評分）。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, report, avg, r3 } from './lib/bt-core.mjs';

const PERIOD = 9;

/** 逐日重放算 K/D，回傳 map[`${di}_${code}`] = {k,d,pk,pd} */
function buildKD(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = days[i].close[code];
      if (!r || r.length < 5) continue;
      const [c, , , h, l] = r;
      if (!(c > 0 && h > 0 && l > 0 && h >= l)) continue;
      const s = (st[code] ||= { k: 50, d: 50, hs: [], ls: [] });
      s.hs.push(h); s.ls.push(l);
      if (s.hs.length > PERIOD) { s.hs.shift(); s.ls.shift(); }
      if (s.hs.length < PERIOD) continue;
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((c - ln) / (hn - ln)) * 100;
      const pk = s.k, pd = s.d;
      s.k = (pk * 2) / 3 + rsv / 3;
      s.d = (pd * 2) / 3 + s.k / 3;
      out[`${i}_${code}`] = { k: s.k, d: s.d, pk, pd };
    }
  }
  return out;
}

function attach(samples, kd) {
  let n = 0;
  for (const s of samples) {
    const x = kd[`${s.di}_${s.code}`];
    if (!x) continue;
    n++;
    s.k = x.k; s.d = x.d; s.pk = x.pk; s.pd = x.pd;
    s.goldCross = x.pk <= x.pd && x.k > x.d;
    s.deadCross = x.pk >= x.pd && x.k < x.d;
  }
  return n;
}

// 教科書講法 → 可執行條件
const GROUPS = [
  { label: 'K<20超賣', cond: s => s.k < 20 },
  { label: 'K<10極度超賣', cond: s => s.k < 10 },
  { label: 'K>80超買', cond: s => s.k > 80 },
  { label: 'K>90極度超買', cond: s => s.k > 90 },
  { label: '低檔金叉K<30', cond: s => s.goldCross && s.k < 30 },
  { label: '黃金交叉(全)', cond: s => s.goldCross },
  { label: '高檔死叉K>70', cond: s => s.deadCross && s.k > 70 },
  { label: '死亡交叉(全)', cond: s => s.deadCross },
  { label: '低檔鈍化KD<20', cond: s => s.k < 20 && s.d < 20 },
  { label: '高檔鈍化KD>80', cond: s => s.k > 80 && s.d > 80 },
  { label: 'K上穿20', cond: s => s.pk < 20 && s.k >= 20 },
  { label: 'K下破80', cond: s => s.pk > 80 && s.k <= 80 },
];

/** 5日持有另表（report() 只涵蓋收賣/開賣） */
function report5(uni, groups, minN = 200) {
  const b = { 0: uni.filter(s => s.half === 0 && s.net5 != null), 1: uni.filter(s => s.half === 1 && s.net5 != null) };
  const ba = { 0: avg(b[0].map(s => s.net5)), 1: avg(b[1].map(s => s.net5)) };
  console.log(`\n  【持有5日】基準 前半${r3(ba[0])}%/後半${r3(ba[1])}%（fwd 視窗重疊·顯著性打折）`);
  for (const g of groups) {
    const s0 = b[0].filter(g.cond), s1 = b[1].filter(g.cond);
    if (s0.length < minN || s1.length < minN) { console.log(`    ${g.label.padEnd(15)} 樣本不足(${s0.length}/${s1.length})`); continue; }
    const d = [avg(s0.map(s => s.net5)) - ba[0], avg(s1.map(s => s.net5)) - ba[1]];
    const ok = Math.sign(d[0]) === Math.sign(d[1]) && Math.min(Math.abs(d[0]), Math.abs(d[1])) >= 0.05;
    const win = ((s0.filter(s => s.net5 > 0).length + s1.filter(s => s.net5 > 0).length) / (s0.length + s1.length) * 100).toFixed(1);
    console.log(`    ${g.label.padEnd(15)} Δ[${r3(d[0])}/${r3(d[1])}] 淨勝${win}%·n=${(s0.length + s1.length).toLocaleString()} ${ok ? '✅' : '❌'}`);
  }
}

const run = async (label, opt, minN) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const withKD = attach(samples, buildKD(days));
  const uni = samples.filter(s => s.k != null);
  console.log(`\n${'═'.repeat(76)}\n══ ${label}`);
  console.log(`   ${days[0]?.date} → ${days[days.length - 1]?.date}·${days.length}日·樣本 ${samples.length.toLocaleString()}（含KD ${withKD.toLocaleString()}）`);
  console.log('═'.repeat(76));
  const stable = report(uni, { title: 'KD 命題', groups: GROUPS, minN });
  report5(uni.filter(s => s.tradable), GROUPS, minN);
  return { uni, stable };
};

const main = async () => {
  const A = await run('① 主窗 480 交易日', { days: 480 }, 300);
  const B = await run('② 第三獨立窗 OOT（模型從未見過）', { days: 250, to: '2023-07-31' }, 150);

  console.log(`\n${'═'.repeat(76)}\n══ 彙總：主窗過關 vs OOT 過關\n${'═'.repeat(76)}`);
  const bl = new Set(B.stable.map(x => x.label));
  if (!A.stable.length) console.log('  主窗零過關 —— 所有 KD 命題在兩半窗一致性上就被淘汰。');
  for (const s of A.stable) {
    console.log(`  ${s.label.padEnd(15)} 主窗✅（收賣Δ[${r3(s.dC[0])}/${r3(s.dC[1])}]·開賣Δ[${r3(s.dO[0])}/${r3(s.dO[1])}]）→ OOT ${bl.has(s.label) ? '✅ 通過' : '❌ 未過'}`);
  }
  const both = A.stable.filter(s => bl.has(s.label));
  console.log(`\n  主窗+OOT 雙過關：${both.length ? both.map(s => s.label).join('、') : '（無）'}`);
  process.exit(0);
};
main();
