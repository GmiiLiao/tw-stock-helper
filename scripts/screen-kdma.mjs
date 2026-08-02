// ─────────────────────────────────────────────────────────────────────────
// KD × MA（KDMA）組合檢定 —— 2026-08-02（承 screen-kd*.mjs）
//
// 使用者主張：KD 是擺盪指標（抓轉折/超買超賣）、MA 是趨勢指標（看方向/支撐壓力），
// 兩者互補性強。上一輪 KD 單獨檢定結論：買進端主窗有、**OOT 全垮**；
// 只有 K>90 避開端過關。
//
// 本輪要回答的**實質問題**（不是「組合起來好不好看」）：
//   Q1 MA 趨勢濾網能不能救回 KD 買進端？（OOT 是判準，主窗好看不算）
//   Q2 2×2 拆解：組合的效果是 KD 帶來的，還是 MA 自己就有？
//      —— 若「K<20 ∧ 價>MA20」≈「價>MA20 單獨」，則 KD 沒有增量，組合是假象。
//   Q3 MA 能不能強化已過關的 K>90 避開端？
//
// 口徑：明開賣（netOpen·扣費稅 0.4425%）為主，可交易宇宙，兩半窗一致 + OOT。
// MA 由 chipArchive 收盤序列計算（MA5/MA20/MA60），與站上 indicators 同義。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const PERIOD = 9;

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

/** MA5/20/60（收盤價簡單移動平均，與站上 calculateSMA 同義） */
function buildMA(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0];
      if (!(c > 0)) continue;
      const s = (st[code] ||= { cs: [] });
      s.cs.push(c);
      if (s.cs.length > 60) s.cs.shift();
      if (s.cs.length < 60) continue;
      const ma = n => { const a = s.cs.slice(-n); return a.reduce((x, y) => x + y, 0) / n; };
      const ma5 = ma(5), ma20 = ma(20), ma60 = ma(60);
      out[`${i}_${code}`] = {
        ma5, ma20, ma60,
        aboveMA20: c > ma20, aboveMA60: c > ma60,
        align: ma5 > ma20 && ma20 > ma60,          // 多頭排列
        bias20: (c / ma20 - 1) * 100,              // 乖離
      };
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const kd = buildKD(days), ma = buildMA(days);
  for (const s of samples) {
    const a = kd[`${s.di}_${s.code}`], b = ma[`${s.di}_${s.code}`];
    if (a) { s.k = a.k; s.d = a.d; s.goldCross = a.pk <= a.pd && a.k > a.d; }
    if (b) Object.assign(s, b);
  }
  return { days, all: samples.filter(s => s.tradable && s.k != null && s.ma20 != null && s.netOpen != null) };
};

const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const N = a => (a.length ? avg(a.map(s => s.netOpen)) : null);
const winp = a => (a.length ? +((a.filter(s => s.netOpen > 0).length / a.length) * 100).toFixed(1) : null);

/** 一組條件：主窗＋OOT 各自的絕對值、兩半窗、勝率、樣本 */
function line(label, cond, minN = 200) {
  const cells = [];
  let pass = true;
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.all.filter(cond);
    if (sel.length < minN) { cells.push(`${wn} 樣本不足(${sel.length})`); pass = false; continue; }
    const h = [0, 1].map(hf => r3(N(sel.filter(s => s.half === hf))));
    const m = N(sel);
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    if (!(m > 0 && same)) pass = false;
    cells.push(`${wn} ${String(r3(m)).padStart(7)}%[${h[0]}/${h[1]}]${same ? '' : '⚠換號'} 勝${String(winp(sel)).padStart(5)}% n=${String(sel.length).padStart(6)}`);
  }
  console.log(`  ${label.padEnd(26)} ${cells.join('   ')}  ${pass ? '✅' : '❌'}`);
  return pass;
}

console.log('基準（可交易宇宙·明開賣）：');
for (const [wn, w] of Object.entries(W)) {
  const h = [0, 1].map(hf => r3(N(w.all.filter(s => s.half === hf))));
  console.log(`  ${wn.padEnd(5)} ${r3(N(w.all))}%[${h[0]}/${h[1]}] 勝${winp(w.all)}% n=${w.all.length.toLocaleString()}`);
}

console.log(`\n${'═'.repeat(112)}\n══ Q1 MA 趨勢濾網能不能救回 KD 買進端？（判準＝主窗與 OOT 都要正且兩半同向）\n${'═'.repeat(112)}`);
line('K<20 ∧ 價>MA20', s => s.k < 20 && s.aboveMA20);
line('K<20 ∧ 價>MA60', s => s.k < 20 && s.aboveMA60);
line('K<20 ∧ 多頭排列', s => s.k < 20 && s.align);
line('K<10 ∧ 價>MA20', s => s.k < 10 && s.aboveMA20);
line('K<10 ∧ 多頭排列', s => s.k < 10 && s.align);
line('低檔金叉 ∧ 價>MA20', s => s.goldCross && s.k < 30 && s.aboveMA20);
line('低檔金叉 ∧ 多頭排列', s => s.goldCross && s.k < 30 && s.align);
line('K<30 ∧ 乖離MA20 ±3%內', s => s.k < 30 && Math.abs(s.bias20) <= 3);

console.log(`\n${'═'.repeat(112)}\n══ Q2 2×2 拆解：效果是 KD 帶來的，還是 MA 自己就有？\n${'═'.repeat(112)}`);
line('價>MA20 單獨', s => s.aboveMA20);
line('多頭排列 單獨', s => s.align);
line('K<20 單獨', s => s.k < 20);
line('K<20 ∧ 價>MA20', s => s.k < 20 && s.aboveMA20);
line('K≥20 ∧ 價>MA20', s => s.k >= 20 && s.aboveMA20);
line('K<20 ∧ 價≤MA20', s => s.k < 20 && !s.aboveMA20);
line('K≥20 ∧ 價≤MA20', s => s.k >= 20 && !s.aboveMA20);

console.log(`\n${'═'.repeat(112)}\n══ Q3 MA 能不能強化 K>90 避開端？（此處 ❌＝報酬為負＝正是我們要的避開）\n${'═'.repeat(112)}`);
line('K>90 單獨', s => s.k > 90, 150);
line('K>90 ∧ 價>MA20', s => s.k > 90 && s.aboveMA20, 150);
line('K>90 ∧ 價≤MA20', s => s.k > 90 && !s.aboveMA20, 100);
line('K>90 ∧ 多頭排列', s => s.k > 90 && s.align, 150);
line('K>90 ∧ 非多頭排列', s => s.k > 90 && !s.align, 100);

console.log(`\n${'═'.repeat(112)}\n══ 判讀\n${'═'.repeat(112)}`);
console.log('  Q1：只要 OOT 那格是負或換號，「MA 救回 KD 買進端」就不成立。');
console.log('  Q2：若「K<20 ∧ 價>MA20」與「K≥20 ∧ 價>MA20」差異不大 ＝ 效果來自 MA，KD 無增量。');
console.log('  Q3：K>90 各切法都要維持明顯負值，才談得上用 MA 細分避開強度。');
process.exit(0);
