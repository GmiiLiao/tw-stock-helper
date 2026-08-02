// ─────────────────────────────────────────────────────────────────────────
// KD 作為「第二道確認」的增量檢定 —— 2026-08-02
//
// 使用者重新定位：KD 是**波段操作**的工具，用途是**雙重驗證**，不是單獨訊號。
// 這與前四輪的問法本質不同：
//   前四輪問「KD 能不能單獨產生 edge」→ 全部否定
//   本輪問「在已驗證訊號之上，KD 能不能再提升」→ 這是增量問題
//
// 基準訊號＝站上已上線的**波段起漲 ⭐三重確認**（model-core swingEntry）：
//   RSI5<20 ∧ 法人 t-1..t-5 買超>5%均量 ∧ 量比>1.5 ∧ **空頭日**（硬 gate）
//   已知實績：真起漲 18.6%／淨勝 55.8%／5日 +1.10%
//
// 檢定兩個方向（對應使用者說的「判斷是不是起漲或是會下跌」）：
//   Ⅰ 起漲側：基準 ＋ KD 條件 → 真起漲率與 5 日報酬能否提升
//   Ⅱ 下跌側：全市場 ＋ KD 條件 → 能否更準確地標出「5日內跌≥5%」
//
// 口徑：進場今日收盤／出場第5日收盤／扣費稅；真起漲＝後5日不破今日低 ∧ 最高≥收盤×1.05
// 判準：真起漲率提升 ∧ 5日均為正 ∧ 中位數為正 ∧ 兩半同向 ∧ OOT 同向
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
        k: s.k, d: s.d, kUp: s.k > pk, dUp: s.d > pd,
        gold: pk <= pd && s.k > s.d, dead: pk >= pd && s.k < s.d,
        spread: s.k - s.d, converging: Math.abs(s.k - s.d) < Math.abs(pk - pd),
      };
    }
  }
  return out;
}
function buildRSI(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0];
      if (!(c > 0)) continue;
      const s = (st[code] ||= { p: null, u5: 0, d5: 0, u10: 0, d10: 0, n: 0 });
      if (s.p != null) {
        const ch = c - s.p, g = Math.max(ch, 0), l = Math.max(-ch, 0);
        s.n++;
        if (s.n <= 5) { s.u5 += g / 5; s.d5 += l / 5; } else { s.u5 = (s.u5 * 4 + g) / 5; s.d5 = (s.d5 * 4 + l) / 5; }
        if (s.n <= 10) { s.u10 += g / 10; s.d10 += l / 10; } else { s.u10 = (s.u10 * 9 + g) / 10; s.d10 = (s.d10 * 9 + l) / 10; }
        if (s.n >= 10) out[`${i}_${code}`] = {
          rsi5: s.u5 + s.d5 > 0 ? (s.u5 / (s.u5 + s.d5)) * 100 : 50,
          rsi10: s.u10 + s.d10 > 0 ? (s.u10 / (s.u10 + s.d10)) * 100 : 50,
        };
      }
      s.p = c;
    }
  }
  return out;
}
function buildFwd(days) {
  const out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let k = 1; k <= 5; k++) {
        const rr = days[i + k]?.close?.[code];
        if (!rr || rr.length < 5) { ok = false; break; }
        if (rr[4] < lo) lo = rr[4];
        if (rr[3] > hi) hi = rr[3];
      }
      if (ok) out[`${i}_${code}`] = { fwdLo: lo, fwdHi: hi };
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const kd = buildKD(days), rsi = buildRSI(days), fw = buildFwd(days);
  for (const s of samples) Object.assign(s, kd[`${s.di}_${s.code}`] || {}, rsi[`${s.di}_${s.code}`] || {}, fw[`${s.di}_${s.code}`] || {});
  const uni = samples.filter(s => s.tradable && s.k != null && s.rsi5 != null && s.fwdLo != null && s.net5 != null);
  for (const s of uni) {
    s.realStart = s.fwdLo >= s.l && s.fwdHi >= s.c * 1.05;
    s.willFall = s.fwdLo <= s.c * 0.95;                 // 5日內自收盤跌≥5%
  }
  return uni;
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };

// 波段起漲 ⭐三重確認（含空頭日硬 gate）
const BASE = s => s.rsi5 < 20 && s.inst5Ratio != null && s.inst5Ratio > 0.05 && s.volX > 1.5 && s.bull === false;

const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };

function line(label, cond, minN = 80, mode = 'up') {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.filter(cond);
    if (sel.length < minN) { cells.push(`${wn} 不足(${sel.length})`.padEnd(56)); continue; }
    const rets = sel.map(x => x.net5);
    const h = [0, 1].map(hf => r3(avg(sel.filter(x => x.half === hf).map(x => x.net5))));
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    const key = mode === 'up' ? pct(sel, x => x.realStart) : pct(sel, x => x.willFall);
    const kl = mode === 'up' ? '真起漲' : '5日跌≥5%';
    cells.push(`${wn} ${kl}${String(key).padStart(5)}% 均${String(r3(avg(rets))).padStart(7)}% 中位${String(med(rets)).padStart(7)}%[${h[0]}/${h[1]}]${same ? ' ' : '⚠'} n=${String(sel.length).padStart(5)}`.padEnd(56));
  }
  console.log(`  ${label.padEnd(26)} ${cells.join(' ')}`);
}
const H = t => console.log(`\n${'═'.repeat(150)}\n══ ${t}\n${'═'.repeat(150)}`);

console.log('進場今日收盤·出場第5日收盤·扣費稅｜真起漲＝後5日不破今日低 ∧ 最高≥收盤×1.05\n');
for (const [wn, w] of Object.entries(W)) {
  console.log(`  ${wn} 全市場基準：真起漲 ${pct(w, x => x.realStart)}%·5日均 ${r3(avg(w.map(x => x.net5)))}%·中位 ${med(w.map(x => x.net5))}%·5日跌≥5% ${pct(w, x => x.willFall)}%（n=${w.length.toLocaleString()}）`);
}

H('Ⅰ 起漲側：波段起漲⭐三重確認（已上線）＋ KD 第二道確認');
line('【基準】⭐三重確認', BASE);
line('  ＋ K<20', s => BASE(s) && s.k < 20);
line('  ＋ K<30', s => BASE(s) && s.k < 30);
line('  ＋ K 向上', s => BASE(s) && s.kUp);
line('  ＋ 金叉', s => BASE(s) && s.gold);
line('  ＋ K在D上(K−D>0)', s => BASE(s) && s.spread > 0);
line('  ＋ K在D下(K−D<0)', s => BASE(s) && s.spread < 0);
line('  ＋ 兩線收斂中', s => BASE(s) && s.converging);
line('  ＋ D<20', s => BASE(s) && s.d < 20);
line('  ＋ K<20 ∧ K向上', s => BASE(s) && s.k < 20 && s.kUp);

H('Ⅱ 下跌側：KD 能不能更準確標出「5 日內跌≥5%」');
line('【基準】全市場', () => true, 300, 'down');
line('K>80', s => s.k > 80, 300, 'down');
line('K>90', s => s.k > 90, 200, 'down');
line('死亡交叉', s => s.dead, 300, 'down');
line('高檔死叉(K>70)', s => s.dead && s.k > 70, 200, 'down');
line('K向下 ∧ D向下', s => !s.kUp && !s.dUp, 300, 'down');
line('K>80 ∧ K向下', s => s.k > 80 && !s.kUp, 200, 'down');
line('K−D ≤ −8（開放）', s => s.spread <= -8, 300, 'down');

console.log(`\n${'═'.repeat(150)}`);
console.log('判準（起漲側）：真起漲率須高於基準組 ∧ 5日均為正 ∧ 中位數為正 ∧ 兩半同向 ∧ OOT 同向。');
console.log('判準（下跌側）：5日跌≥5% 的比率須顯著高於全市場基準，且兩窗一致。');
process.exit(0);
