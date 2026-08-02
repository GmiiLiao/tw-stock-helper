// ─────────────────────────────────────────────────────────────────────────
// 「上漲 ∧ KD 金叉 ∧ 交會」要再加什麼條件才是真起漲點？—— 網格搜尋 2026-08-02
//
// 前一輪結論：這個組合**單獨無效**（真起漲率與基準相同），疊「漲停」後的漂亮數字
// 是單一區段撐起的（8 段有 6 段中位數為負、OOT 勝率 41.8%）。
// 本輪照 swingEntry（波段起漲）當初的做法做網格搜尋：在母體上逐一疊加條件，
// 找出能讓它真正成立的參數組合，再用第三獨立窗 OOT 驗證。
//
// 口徑（與既有 swingEntry 技能完全對齊，才能比較與併榜）：
//   母體＝上漲(chg>0) ∧ 當日金叉 ∧ 交會(|K−D|<2) ∧ **可交易(chg≤8.5%)**
//         —— 排除漲停：收盤買不到，前一輪已證實 edge 都在買不到的那格
//   進場＝今日收盤／出場＝第5日收盤／扣費稅 0.4425%
//   真起漲＝後5日最低 ≥ 今日最低（不破底）∧ 後5日最高 ≥ 今日收盤×1.05
//
// 判準（任一不過即淘汰）：
//   ①真起漲率顯著高於母體 ②5日淨報酬為正 ③**中位數也要為正**（防極端值灌水）
//   ④主窗兩半同向 ⑤第三獨立窗 OOT 同向
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
      out[`${i}_${code}`] = { k: s.k, d: s.d, gold: pk <= pd && s.k > s.d, conv: Math.abs(s.k - s.d) < 2 };
    }
  }
  return out;
}
/** 後 5 日高低（真起漲判定用）＋ 20 日振幅 */
function buildFwd(days) {
  const out = {}, hist = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = days[i].close[code];
      if (!r || r.length < 5) continue;
      const H = (hist[code] ||= []);
      H.push(r[0]); if (H.length > 20) H.shift();
      let lo = Infinity, hi = -Infinity, ok = true;
      for (let k = 1; k <= 5; k++) {
        const rr = days[i + k]?.close?.[code];
        if (!rr || rr.length < 5) { ok = false; break; }
        if (rr[4] < lo) lo = rr[4];
        if (rr[3] > hi) hi = rr[3];
      }
      const rng = H.length === 20 ? (Math.max(...H) - Math.min(...H)) / Math.min(...H) * 100 : null;
      out[`${i}_${code}`] = { fwdLo: ok ? lo : null, fwdHi: ok ? hi : null, rng20: rng };
    }
  }
  return out;
}
const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const kd = buildKD(days), fw = buildFwd(days);
  for (const s of samples) Object.assign(s, kd[`${s.di}_${s.code}`] || {}, fw[`${s.di}_${s.code}`] || {});
  const pool = samples.filter(s =>
    s.k != null && s.fwdLo != null && s.net5 != null &&
    s.tradable && s.chg > 0 && s.gold && s.conv);
  for (const s of pool) s.realStart = s.fwdLo >= s.l && s.fwdHi >= s.c * 1.05;
  const uni = samples.filter(s => s.tradable && s.fwdLo != null && s.net5 != null);
  for (const s of uni) s.realStart = s.fwdLo >= s.l && s.fwdHi >= s.c * 1.05;
  return { pool, uni };
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };

const pct = (a, f) => (a.length ? +((a.filter(f).length / a.length) * 100).toFixed(1) : null);
const med = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return +(b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2).toFixed(3); };

function line(label, cond, minN = 150) {
  const cells = []; let pass = true;
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.pool.filter(cond);
    if (sel.length < minN) { cells.push(`${wn} 不足(${sel.length})`.padEnd(56)); pass = false; continue; }
    const rs = pct(sel, x => x.realStart);
    const rets = sel.map(x => x.net5);
    const m = r3(avg(rets)), md = med(rets);
    const h = [0, 1].map(hf => r3(avg(sel.filter(x => x.half === hf).map(x => x.net5))));
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    if (!(m > 0 && md > 0 && same)) pass = false;
    cells.push(`${wn} 真起漲${String(rs).padStart(5)}% 均${String(m).padStart(7)}% 中位${String(md).padStart(7)}%[${h[0]}/${h[1]}]${same ? ' ' : '⚠'} n=${String(sel.length).padStart(5)}`.padEnd(56));
  }
  console.log(`  ${label.padEnd(24)} ${cells.join(' ')}  ${pass ? '✅' : ''}`);
  return pass;
}
const H = t => console.log(`\n${'═'.repeat(148)}\n══ ${t}\n${'═'.repeat(148)}`);

console.log('進場＝今日收盤·出場＝第5日收盤·扣費稅｜真起漲＝後5日不破今日低 ∧ 期間最高≥收盤×1.05');
console.log('母體＝上漲 ∧ KD金叉 ∧ 交會(|K−D|<2) ∧ 可交易(chg≤8.5%，排除買不到的漲停)\n');
for (const [wn, w] of Object.entries(W)) {
  const u = w.uni, p = w.pool;
  console.log(`  ${wn}：全市場基準 真起漲 ${pct(u, x => x.realStart)}%·5日均 ${r3(avg(u.map(x => x.net5)))}%·中位 ${med(u.map(x => x.net5))}%（n=${u.length.toLocaleString()}）`);
  console.log(`        母體       真起漲 ${pct(p, x => x.realStart)}%·5日均 ${r3(avg(p.map(x => x.net5)))}%·中位 ${med(p.map(x => x.net5))}%（n=${p.length.toLocaleString()}）`);
}

H('網格搜尋：母體 ＋ 單一條件');
const GRID = [
  ['＋法人5日買超>5%均量', s => s.inst5Ratio > 0.05],
  ['＋法人5日買超>10%', s => s.inst5Ratio > 0.10],
  ['＋外資連買≥3日', s => s.fStreak >= 3],
  ['＋量比>1.5', s => s.volX > 1.5],
  ['＋量比>2', s => s.volX > 2],
  ['＋量≥1000張', s => s.v >= 1000],
  ['＋量≥3000張', s => s.v >= 3000],
  ['＋K<20', s => s.k < 20],
  ['＋K 20~50', s => s.k >= 20 && s.k < 50],
  ['＋K≥50', s => s.k >= 50],
  ['＋突破20日高', s => s.brk20],
  ['＋距60日高<0.85', s => s.posture60 != null && s.posture60 < 0.85],
  ['＋距60日高≥0.9', s => s.posture60 != null && s.posture60 >= 0.9],
  ['＋空頭日', s => s.bull === false],
  ['＋多頭日', s => s.bull === true],
  ['＋趨勢盤(振幅≥30%)', s => s.rng20 != null && s.rng20 >= 30],
  ['＋震盪盤(振幅<15%)', s => s.rng20 != null && s.rng20 < 15],
  ['＋收位≥0.7', s => s.pos >= 0.7],
  ['＋跳空開高', s => s.gap],
  ['＋融券水位>0.3', s => s.shLevel != null && s.shLevel > 0.3],
  ['＋連漲第2根', s => s.upStreak === 2],
];
const winners = [];
for (const [l, c] of GRID) if (line(l, c)) winners.push([l, c]);

H('組合：單條件過關者兩兩疊加');
if (winners.length < 2) console.log('  單條件過關者不足 2 個，無法組合。');
for (let i = 0; i < winners.length; i++) {
  for (let j = i + 1; j < winners.length; j++) {
    line(`${winners[i][0]}${winners[j][0]}`, s => winners[i][1](s) && winners[j][1](s), 100);
  }
}
console.log(`\n${'═'.repeat(148)}`);
console.log(`單條件過關 ${winners.length} 組：${winners.map(w => w[0]).join('、') || '（無）'}`);
console.log('判準：真起漲率高於母體 ∧ 5日均為正 ∧ **中位數為正** ∧ 主窗兩半同向 ∧ OOT 同樣成立。');
process.exit(0);
