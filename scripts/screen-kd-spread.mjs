// ─────────────────────────────────────────────────────────────────────────
// KD 交叉線「交匯／開放」判讀檢定 —— 2026-08-02
//
// 使用者從四張看盤圖歸納：**漲停時 K 與 D 交匯（幾乎重疊），跌停時開放（大幅張開）**。
// 實例（2026-07-31）：華新1605 漲停 K-D=+0.96、聯發科2454 漲停 K-D=+0.42、
//                     凌華6166 跌停 K-D=-17.32、友訊2332 +1.62% K-D=-9.86。
//
// 本檢定要分清楚**兩件本質不同的事**（決定能不能進權重）：
//   Ⅰ 同期關係（今日 chg ↔ 今日 K-D）：KD 由價格算出，漲停必然推高 RSV → K 追向 D。
//      若只有這層，它是**事後描述**，拿來解盤可以，**不能當預測、不能進權重**。
//   Ⅱ 前瞻預測力（今日 K-D 狀態 ↔ **明日**開賣報酬）：這才是能進權重的東西。
//
// 另按使用者要求，核對「KD 線方向（K 是升是降）× 位階高低」的交叉表。
// 口徑：明開賣（netOpen·扣費稅），可交易宇宙（排除 chg>8.5%＝漲停買不到），
//       兩半窗一致 + 第三獨立窗 OOT。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const P = 9;
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
      if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
      if (s.hs.length < P) continue;
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((c - ln) / (hn - ln)) * 100;
      const pk = s.k, pd = s.d;
      s.k = (pk * 2) / 3 + rsv / 3;
      s.d = (pd * 2) / 3 + s.k / 3;
      out[`${i}_${code}`] = {
        k: s.k, d: s.d, rsv,
        spread: s.k - s.d,                    // 正＝K在D上、負＝K在D下
        absSpread: Math.abs(s.k - s.d),       // 「交匯度」：越小越交匯
        prevSpread: pk - pd,
        converging: Math.abs(s.k - s.d) < Math.abs(pk - pd),   // 收斂中
        kUp: s.k > pk,                        // KD 線方向
      };
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const kd = buildKD(days);
  for (const s of samples) Object.assign(s, kd[`${s.di}_${s.code}`] || {});
  return { days, all: samples.filter(s => s.k != null) };
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const M = a => (a.length ? avg(a.map(s => s.netOpen)) : null);
const WR = a => (a.length ? +((a.filter(s => s.netOpen > 0).length / a.length) * 100).toFixed(1) : null);
const H = t => console.log(`\n${'═'.repeat(112)}\n══ ${t}\n${'═'.repeat(112)}`);

// ── Ⅰ 同期關係：先確認使用者的觀察是不是全市場通則（含漲停跌停，不設可交易限制）──
H('Ⅰ 同期關係：今日漲跌幅 ↔ 今日 K−D 交匯度（驗證你的觀察）');
console.log('  漲跌幅區間           樣本      平均 K−D      平均|K−D|(交匯度)   |K−D|<2 佔比   K在D上佔比');
const BUCKETS = [
  ['跌停(≤-9.5%)', s => s.chg <= -9.5], ['大跌(-9.5~-5%)', s => s.chg > -9.5 && s.chg <= -5],
  ['小跌(-5~0%)', s => s.chg > -5 && s.chg < 0], ['小漲(0~5%)', s => s.chg >= 0 && s.chg < 5],
  ['大漲(5~9.5%)', s => s.chg >= 5 && s.chg < 9.5], ['漲停(≥9.5%)', s => s.chg >= 9.5],
];
for (const [bl, bf] of BUCKETS) {
  const a = W.主窗.all.filter(bf);
  if (!a.length) continue;
  const conv = a.filter(s => s.absSpread < 2).length / a.length * 100;
  const above = a.filter(s => s.spread > 0).length / a.length * 100;
  console.log(`  ${bl.padEnd(18)} ${String(a.length).padStart(7)}  ${String(r3(avg(a.map(s => s.spread)))).padStart(9)}  ${String(r3(avg(a.map(s => s.absSpread)))).padStart(14)}  ${String(conv.toFixed(1) + '%').padStart(12)}  ${String(above.toFixed(1) + '%').padStart(11)}`);
}

// ── Ⅱ 前瞻預測力（可交易宇宙）──
H('Ⅱ 前瞻預測力：今日 K−D 狀態 → 明日開賣報酬（可交易宇宙·扣費稅）');
function row(label, cond, minN = 300) {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const uni = w.all.filter(s => s.tradable && s.netOpen != null);
    const sel = uni.filter(cond);
    if (sel.length < minN) { cells.push(`${wn} 不足(${sel.length})`.padEnd(42)); continue; }
    const h = [0, 1].map(hf => r3(M(sel.filter(s => s.half === hf))));
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    cells.push(`${wn} ${String(r3(M(sel))).padStart(7)}%[${h[0]}/${h[1]}]${same ? ' ' : '⚠'} 勝${String(WR(sel)).padStart(5)}% n=${String(sel.length).padStart(6)}`.padEnd(42));
  }
  console.log(`  ${label.padEnd(24)} ${cells.join(' ')}`);
}
console.log('  基準：');
row('全體可交易', () => true);
console.log('  ── 交匯度分層（|K−D| 越小越交匯）──');
row('|K−D| < 1（極交匯）', s => s.absSpread < 1);
row('|K−D| 1~3', s => s.absSpread >= 1 && s.absSpread < 3);
row('|K−D| 3~8', s => s.absSpread >= 3 && s.absSpread < 8);
row('|K−D| ≥ 8（開放）', s => s.absSpread >= 8);
console.log('  ── 方向 × 交匯 ──');
row('交匯(<3) ∧ K向上', s => s.absSpread < 3 && s.kUp);
row('交匯(<3) ∧ K向下', s => s.absSpread < 3 && !s.kUp);
row('開放(≥8) ∧ K在D上', s => s.absSpread >= 8 && s.spread > 0);
row('開放(≥8) ∧ K在D下', s => s.absSpread >= 8 && s.spread < 0);
console.log('  ── 收斂/發散中 ──');
row('收斂中', s => s.converging);
row('發散中', s => !s.converging);

// ── Ⅲ 使用者要求：KD 方向 × 位階高低 交叉表 ──
H('Ⅲ KD 線方向 × 位階高低（明日開賣·可交易宇宙）');
console.log('  位階以 K 值分區；方向以今日 K 是否上升');
for (const [zl, zf] of [['低檔 K<20', s => s.k < 20], ['中低 20~50', s => s.k >= 20 && s.k < 50],
  ['中高 50~80', s => s.k >= 50 && s.k < 80], ['高檔 K≥80', s => s.k >= 80]]) {
  row(`${zl} ∧ K向上`, s => zf(s) && s.kUp, 200);
  row(`${zl} ∧ K向下`, s => zf(s) && !s.kUp, 200);
}
console.log(`\n${'═'.repeat(112)}`);
console.log('判讀：Ⅰ 若漲停組交匯度顯著低於跌停組 → 你的觀察成立（但那是同期，KD 由價格算出）。');
console.log('      Ⅱ 才是能不能進權重的關鍵：交匯/開放對「明日」有沒有預測力、兩窗是否一致。');
process.exit(0);
