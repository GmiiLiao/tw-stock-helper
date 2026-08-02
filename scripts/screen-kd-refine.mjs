// ─────────────────────────────────────────────────────────────────────────
// KD 過關命題深入驗證 —— 2026-08-02（承 screen-kd.mjs）
//
// screen-kd 主窗+OOT 雙過關三組：K<20 超賣、K<10 極度超賣、K>90 極度超買。
// 但三組**全部帶 OOT regime 反向警告**，且 report() 的 Δ 是「相對可交易宇宙
// 基準」，基準本身為負 —— Δ 為正不等於絕對報酬為正、不等於可以下單。
//
// 本輪四問（任何一問沒過就不進權重）：
//   Q1 絕對報酬：扣費稅後三口徑各是多少？正的嗎？
//   Q2 regime 依賴：edge 是不是只在空頭日成立？（波段起漲就是這型，需硬 gate）
//   Q3 冗餘度：KD 超賣 vs RSI5 超跌是不是同一件事？（RSI5<20 已在站上使用）
//   Q4 增量：在既有 RSI 條件之上，KD 還有沒有增量？
//      —— 專案鐵律：單獨看漂亮 ≠ 有增量（RSI 對漲停模型即因此判定不採）
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
      out[`${i}_${code}`] = { k: s.k, d: s.d };
    }
  }
  return out;
}

/** RSI5/RSI10（Wilder，與站上 rsiPair 同口徑）供冗餘檢定 */
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

const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);

/** 絕對報酬三口徑＋兩半窗＋樣本數 */
function absTable(label, sel, uni) {
  const row = (a, key) => {
    const v = a.filter(s => s[key] != null);
    const h = [0, 1].map(hf => r3(avg(v.filter(s => s.half === hf).map(s => s[key]))));
    return `${String(r3(avg(v.map(s => s[key])))).padStart(7)}%[${h[0]}/${h[1]}] 勝${String(pct(v, s => s[key] > 0)).padStart(5)}%`;
  };
  console.log(`  ${label.padEnd(22)} n=${String(sel.length).padStart(6)} (${(sel.length / uni.dayCount).toFixed(1)}檔/日)`);
  console.log(`      開賣 ${row(sel, 'netOpen')}   ｜基準 ${row(uni.all, 'netOpen')}`);
  console.log(`      收賣 ${row(sel, 'netClose')}   ｜基準 ${row(uni.all, 'netClose')}`);
  console.log(`      5日  ${row(sel, 'net5')}   ｜基準 ${row(uni.all, 'net5')}`);
}

const CONDS = [
  ['K<20 超賣', s => s.k < 20],
  ['K<10 極度超賣', s => s.k < 10],
  ['K>90 極度超買', s => s.k > 90],
];

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const kd = buildKD(days), rsi = buildRSI(days);
  for (const s of samples) {
    const a = kd[`${s.di}_${s.code}`], b = rsi[`${s.di}_${s.code}`];
    if (a) { s.k = a.k; s.d = a.d; }
    if (b) { s.rsi5 = b.rsi5; s.rsi10 = b.rsi10; }
  }
  const all = samples.filter(s => s.tradable && s.k != null && s.rsi5 != null);
  return { days, all, dayCount: days.length };
};

const main = async () => {
  const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };

  // ── Q1 絕對報酬 ──
  for (const [wn, w] of Object.entries(W)) {
    console.log(`\n${'═'.repeat(74)}\n══ Q1 絕對報酬（扣費稅 0.4425%）· ${wn}（${w.days[0].date}→${w.days[w.days.length - 1].date}）\n${'═'.repeat(74)}`);
    for (const [label, cond] of CONDS) absTable(label, w.all.filter(cond), w);
  }

  // ── Q2 regime 依賴 ──
  console.log(`\n${'═'.repeat(74)}\n══ Q2 regime 依賴（開賣口徑·絕對值）\n${'═'.repeat(74)}`);
  for (const [label, cond] of CONDS) {
    console.log(`\n  ${label}`);
    for (const [wn, w] of Object.entries(W)) {
      const line = [];
      for (const [rl, rf] of [['多頭日', s => s.bull === true], ['空頭日', s => s.bull === false]]) {
        const sel = w.all.filter(s => cond(s) && rf(s) && s.netOpen != null);
        const base = w.all.filter(s => rf(s) && s.netOpen != null);
        const h = [0, 1].map(hf => r3(avg(sel.filter(s => s.half === hf).map(s => s.netOpen))));
        line.push(`${rl} ${String(r3(avg(sel.map(s => s.netOpen)))).padStart(7)}%[${h[0]}/${h[1]}](基準${r3(avg(base.map(s => s.netOpen)))}·n=${sel.length})`);
      }
      console.log(`    ${wn.padEnd(4)} ${line.join('  ')}`);
    }
  }

  // ── Q3 冗餘度：KD 超賣 vs RSI5 超跌 ──
  console.log(`\n${'═'.repeat(74)}\n══ Q3 冗餘度：KD 與 RSI5 是不是同一件事\n${'═'.repeat(74)}`);
  for (const [wn, w] of Object.entries(W)) {
    const n = w.all.length;
    const kLow = w.all.filter(s => s.k < 20), rLow = w.all.filter(s => s.rsi5 < 20);
    const both = w.all.filter(s => s.k < 20 && s.rsi5 < 20);
    // Pearson（連續值）
    const mk = avg(w.all.map(s => s.k)), mr = avg(w.all.map(s => s.rsi5));
    let cov = 0, vk = 0, vr = 0;
    for (const s of w.all) { const a = s.k - mk, b = s.rsi5 - mr; cov += a * b; vk += a * a; vr += b * b; }
    const pear = cov / Math.sqrt(vk * vr);
    console.log(`  ${wn}：K 與 RSI5 相關係數 ${pear.toFixed(3)}`);
    console.log(`      K<20 ${kLow.length.toLocaleString()} 檔次｜RSI5<20 ${rLow.length.toLocaleString()}｜同時成立 ${both.length.toLocaleString()}`);
    console.log(`      K<20 之中有 ${(both.length / kLow.length * 100).toFixed(1)}% 同時 RSI5<20；RSI5<20 之中有 ${(both.length / rLow.length * 100).toFixed(1)}% 同時 K<20（母體 ${n.toLocaleString()}）`);
  }

  // ── Q4 增量：在 RSI5<20 之上，KD 還有沒有增量（反之亦然）──
  console.log(`\n${'═'.repeat(74)}\n══ Q4 增量檢定（開賣口徑·絕對值·兩半窗）\n${'═'.repeat(74)}`);
  const CELLS = [
    ['RSI5<20 單獨', s => s.rsi5 < 20],
    ['K<20 單獨', s => s.k < 20],
    ['RSI5<20 ∧ K<20', s => s.rsi5 < 20 && s.k < 20],
    ['RSI5<20 ∧ K≥20', s => s.rsi5 < 20 && s.k >= 20],
    ['RSI5≥20 ∧ K<20', s => s.rsi5 >= 20 && s.k < 20],
  ];
  for (const [wn, w] of Object.entries(W)) {
    console.log(`\n  ${wn}`);
    for (const [label, cond] of CELLS) {
      const sel = w.all.filter(s => cond(s) && s.netOpen != null);
      if (sel.length < 200) { console.log(`    ${label.padEnd(18)} 樣本不足 n=${sel.length}`); continue; }
      const h = [0, 1].map(hf => r3(avg(sel.filter(s => s.half === hf).map(s => s.netOpen))));
      const ok = Math.sign(h[0]) === Math.sign(h[1]);
      console.log(`    ${label.padEnd(18)} ${String(r3(avg(sel.map(s => s.netOpen)))).padStart(7)}%[${h[0]}/${h[1]}]${ok ? '同向' : '⚠換號'} 勝${pct(sel, s => s.netOpen > 0)}%·n=${sel.length.toLocaleString()}`);
    }
  }
  process.exit(0);
};
main();
