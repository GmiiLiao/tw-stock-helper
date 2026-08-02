// ─────────────────────────────────────────────────────────────────────────
// KDMA 三策略完整檢定 —— 2026-08-02（第二版·比 screen-kdma.mjs 細緻）
//
// 上一版只測了「價 vs MA20 位置／多頭排列／乖離」，本版補測使用者這份
// 方法論中**四個尚未驗證的新元素**：
//   ① MA20 的**斜率**（原文：「20MA 趨勢向上」——上版只看位置，沒看方向）
//   ② 用 5MA/10MA **破解鈍化**（原文策略二：高檔鈍化只要沒跌破短均線就抱牢；
//      低檔鈍化要等站回短均線 + 金叉才進場）
//   ③ **均線糾結突破**（原文策略三：MA5/10/20 靠攏 → 帶量紅K突破 + K 在 50 附近上交叉）
//   ④ **量能確認**（原文提醒：金叉配放量，訊號真實性高很多）
//
// 判準（與 K>90 入權重時同一套，不因方法論寫得詳細就放寬）：
//   主窗 480 日 + 第三獨立窗 OOT 都要方向一致、兩半窗不得換號；
//   買進端須**絕對值為正**（扣費稅 0.4425% 後仍賺）才有意義；
//   通過後還要做 2×2 增量拆解，確認效果不是來自其中單一成分。
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
      const s = (st[code] ||= { k: 50, d: 50, hs: [], ls: [], hiN: 0, loN: 0 });
      s.hs.push(h); s.ls.push(l);
      if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
      if (s.hs.length < P) continue;
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((c - ln) / (hn - ln)) * 100;
      const pk = s.k, pd = s.d;
      s.k = (pk * 2) / 3 + rsv / 3; s.d = (pd * 2) / 3 + s.k / 3;
      s.hiN = s.k > 80 ? s.hiN + 1 : 0;
      s.loN = s.k < 20 ? s.loN + 1 : 0;
      out[`${i}_${code}`] = {
        k: s.k, d: s.d,
        gold: pk <= pd && s.k > s.d,     // 黃金交叉
        dead: pk >= pd && s.k < s.d,     // 死亡交叉
        hiN: s.hiN, loN: s.loN,          // 鈍化連續天數（含今日）
        prevHiN: s.k > 80 ? s.hiN - 1 : s.hiN,   // 今日之前的高檔鈍化天數
        prevLoN: s.k < 20 ? s.loN - 1 : s.loN,
      };
    }
  }
  return out;
}

/** MA5/10/20/60 ＋ MA20 斜率 ＋ 均線糾結度 */
function buildMA(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0];
      if (!(c > 0)) continue;
      const s = (st[code] ||= { cs: [], ma20: [] });
      s.cs.push(c);
      if (s.cs.length > 60) s.cs.shift();
      if (s.cs.length < 25) continue;
      const ma = n => { const a = s.cs.slice(-n); return a.reduce((x, y) => x + y, 0) / n; };
      const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20);
      s.ma20.push(ma20); if (s.ma20.length > 10) s.ma20.shift();
      const ma20Prev5 = s.ma20.length >= 6 ? s.ma20[s.ma20.length - 6] : null;
      const spread = Math.max(ma5, ma10, ma20) - Math.min(ma5, ma10, ma20);
      out[`${i}_${code}`] = {
        ma5, ma10, ma20,
        aboveMA5: c > ma5, aboveMA10: c > ma10, aboveMA20: c > ma20,
        ma20Up: ma20Prev5 != null ? ma20 > ma20Prev5 : null,       // 原文「20MA 趨勢向上」
        ma20Dn: ma20Prev5 != null ? ma20 < ma20Prev5 : null,
        knot: ma20 > 0 ? (spread / ma20) * 100 : null,             // 糾結度%（越小越糾結）
        aboveAllMA: c > Math.max(ma5, ma10, ma20),
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
    if (a) Object.assign(s, a);
    if (b) Object.assign(s, b);
    s.redK = s.c > s.o;                                    // 紅K（收 > 開）
  }
  return { all: samples.filter(s => s.tradable && s.k != null && s.ma20 != null && s.ma20Up != null && s.netOpen != null) };
};

const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };
const M = a => (a.length ? avg(a.map(s => s.netOpen)) : null);
const M5 = a => { const v = a.filter(s => s.net5 != null); return v.length ? avg(v.map(s => s.net5)) : null; };
const WR = a => (a.length ? +((a.filter(s => s.netOpen > 0).length / a.length) * 100).toFixed(1) : null);

function row(label, cond, minN = 200, five = false) {
  const cells = [];
  let ok = true;
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.all.filter(cond);
    if (sel.length < minN) { cells.push(`${wn} 樣本不足(${sel.length})`.padEnd(44)); ok = false; continue; }
    const f = five ? M5 : M;
    const h = [0, 1].map(hf => r3(f(sel.filter(s => s.half === hf))));
    const m = r3(f(sel));
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    if (!same) ok = false;
    cells.push(`${wn} ${String(m).padStart(7)}%[${h[0]}/${h[1]}]${same ? ' ' : '⚠'} 勝${String(WR(sel)).padStart(5)}% n=${String(sel.length).padStart(6)}`.padEnd(44));
  }
  console.log(`  ${label.padEnd(30)} ${cells.join(' ')}`);
  return ok;
}
const H = t => console.log(`\n${'═'.repeat(122)}\n══ ${t}\n${'═'.repeat(122)}`);

console.log('基準（可交易宇宙·明開賣·扣費稅）：');
for (const [wn, w] of Object.entries(W)) {
  const h = [0, 1].map(hf => r3(M(w.all.filter(s => s.half === hf))));
  console.log(`  ${wn.padEnd(5)} ${r3(M(w.all))}%[${h[0]}/${h[1]}] 勝${WR(w.all)}% n=${w.all.length.toLocaleString()}`);
}

H('策略一：MA 定多空（含斜率）＋ KD 找進場點');
console.log('  ── 買入端（原文：站上20MA ∧ 20MA向上 ∧ KD低檔或金叉）→ 須絕對值為正才可交易 ──');
row('價>MA20 ∧ MA20向上', s => s.aboveMA20 && s.ma20Up);
row('  ＋K<30', s => s.aboveMA20 && s.ma20Up && s.k < 30);
row('  ＋K<20', s => s.aboveMA20 && s.ma20Up && s.k < 20);
row('  ＋金叉', s => s.aboveMA20 && s.ma20Up && s.gold);
row('  ＋金叉且K<30', s => s.aboveMA20 && s.ma20Up && s.gold && s.k < 30);
console.log('  ── 賣出/避開端（原文：跌破20MA ∧ 20MA向下 ∧ KD高檔或死叉）→ 須明顯負值 ──');
row('價<MA20 ∧ MA20向下', s => !s.aboveMA20 && s.ma20Dn);
row('  ＋K>80', s => !s.aboveMA20 && s.ma20Dn && s.k > 80, 100);
row('  ＋死叉', s => !s.aboveMA20 && s.ma20Dn && s.dead);

H('策略二：用 5MA/10MA 破解 KD 鈍化');
console.log('  ── 高檔鈍化「沒跌破短均線就抱牢」→ 若成立，抱牢組應優於跌破組且不為負 ──');
row('K>80 ∧ 價≥MA5（抱牢）', s => s.k > 80 && s.aboveMA5);
row('K>80 ∧ 價<MA5（該走）', s => s.k > 80 && !s.aboveMA5, 100);
row('K>80 ∧ 價≥MA10（抱牢）', s => s.k > 80 && s.aboveMA10);
row('K>80連3天 ∧ 價≥MA5', s => s.hiN >= 3 && s.aboveMA5);
console.log('  【持有5日】（鈍化抱牢是波段語意，補看 5 日）');
row('K>80 ∧ 價≥MA5【5日】', s => s.k > 80 && s.aboveMA5, 200, true);
row('K>80 ∧ 價<MA5【5日】', s => s.k > 80 && !s.aboveMA5, 100, true);
console.log('  ── 低檔鈍化「等站回短均線＋金叉才進」→ 若成立，應為正 ──');
row('曾鈍化 ∧ 站回MA5 ∧ 金叉', s => s.prevLoN >= 3 && s.aboveMA5 && s.gold, 100);
row('曾鈍化 ∧ 站回MA5', s => s.prevLoN >= 3 && s.aboveMA5, 100);
row('曾鈍化 ∧ 站回MA10 ∧ 金叉', s => s.prevLoN >= 3 && s.aboveMA10 && s.gold, 100);
row('曾鈍化 ∧ 站回MA5【5日】', s => s.prevLoN >= 3 && s.aboveMA5, 100, true);

H('策略三：均線糾結 ＋ 帶量紅K突破 ＋ KD 在 50 附近上交叉');
row('糾結<2% 單獨', s => s.knot != null && s.knot < 2);
row('糾結<3% 單獨', s => s.knot != null && s.knot < 3);
row('糾結<3% ∧ 突破全部均線', s => s.knot < 3 && s.aboveAllMA);
row('  ＋紅K', s => s.knot < 3 && s.aboveAllMA && s.redK);
row('  ＋紅K＋量比>1.5', s => s.knot < 3 && s.aboveAllMA && s.redK && s.volX > 1.5, 100);
row('  ＋紅K＋量>1.5＋K40~60上叉', s => s.knot < 3 && s.aboveAllMA && s.redK && s.volX > 1.5 && s.k >= 40 && s.k <= 60 && s.k > s.d, 60);
row('完整策略三【5日】', s => s.knot < 3 && s.aboveAllMA && s.redK && s.volX > 1.5 && s.k >= 40 && s.k <= 60 && s.k > s.d, 60, true);

H('④ 量能確認：金叉配放量，訊號真實性是否提高？');
row('金叉 單獨', s => s.gold);
row('金叉 ∧ 量比>1.5', s => s.gold && s.volX > 1.5);
row('金叉 ∧ 量比>2', s => s.gold && s.volX > 2);
row('金叉 ∧ 量比≤1', s => s.gold && s.volX <= 1);

console.log(`\n${'═'.repeat(122)}\n判準：買進端須主窗與 OOT 皆「絕對值為正、兩半同向」；避開端須皆為明顯負值。\n        任一窗換號(⚠)或樣本不足即不成立。通過者再做 2×2 增量拆解。\n${'═'.repeat(122)}`);
process.exit(0);
