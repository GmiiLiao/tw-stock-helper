// ─────────────────────────────────────────────────────────────────────────
// KD「相對值」檢定 —— 2026-08-02
//
// 使用者指出：前面五輪全部用**固定門檻**（K>80、K<20、金叉…），但固定數值
// 對每檔股票的意義不同——有的股票 K 很少超過 60，有的常態待在 90 以上。
// 本輪改測**相對值**，並用**十分位單調性**判定（比門檻穩健得多：
// 門檻可能是切在雜訊上，單調趨勢則要求整條曲線一致）。
//
// 六個相對度量：
//   ① kSelfPct60  今日 K 在該股**自身過去 60 日**的百分位（消除個股體質差異）
//   ② kMktPct     今日 K 在**全市場當日**的橫斷面百分位（消除大盤整體位階）
//   ③ kSlope5     過去 5 日 K 值的**線性回歸斜率**（線性趨勢強度，非水位）
//   ④ spdSelfPct  今日 K−D 在自身過去 60 日的百分位（相對開合度）
//   ⑤ kDevMA20    K 減去自身 K 的 20 日均值（相對偏離，非絕對水位）
//   ⑥ kdRatio     K/D 比值（純相對，無單位）
//
// 判準：**十分位單調**（相鄰分位方向一致、頭尾差距明顯）＋主窗與 OOT 同向。
//       單調關係才可能是真結構；只有頭尾兩格有差＝多半是極端值。
// 口徑：明開賣 netOpen（隔日沖）與 net5（波段）並列，可交易宇宙，扣費稅。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const P = 9;
/** KD ＋ 自身歷史序列（供百分位／斜率／偏離） */
function buildRel(days) {
  const st = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const r = days[i].close[code];
      if (!r || r.length < 5) continue;
      const [c, , , h, l] = r;
      if (!(c > 0 && h > 0 && l > 0 && h >= l)) continue;
      const s = (st[code] ||= { k: 50, d: 50, hs: [], ls: [], kh: [], sh: [] });
      s.hs.push(h); s.ls.push(l);
      if (s.hs.length > P) { s.hs.shift(); s.ls.shift(); }
      if (s.hs.length < P) continue;
      const hn = Math.max(...s.hs), ln = Math.min(...s.ls);
      const rsv = hn === ln ? 50 : ((c - ln) / (hn - ln)) * 100;
      s.k = (s.k * 2) / 3 + rsv / 3;
      s.d = (s.d * 2) / 3 + s.k / 3;
      const spd = s.k - s.d;
      // 先用「過去」的歷史算百分位（不含今日→無前視）
      const kh = s.kh, sh = s.sh;
      let rec = null;
      if (kh.length >= 60) {
        const last60 = kh.slice(-60), lastS = sh.slice(-60);
        const pctOf = (arr, v) => arr.filter(x => x < v).length / arr.length * 100;
        const k20 = kh.slice(-20);
        const mean20 = k20.reduce((a, b) => a + b, 0) / 20;
        // 線性回歸斜率（含今日的最近 5 點）
        const p5 = [...kh.slice(-4), s.k];
        const n = 5, sx = 10, sxx = 30;   // x = 0..4
        let sy = 0, sxy = 0;
        for (let t = 0; t < n; t++) { sy += p5[t]; sxy += t * p5[t]; }
        const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        rec = {
          k: s.k, d: s.d,
          kSelfPct60: pctOf(last60, s.k),
          spdSelfPct: pctOf(lastS, spd),
          kSlope5: slope,
          kDevMA20: s.k - mean20,
          kdRatio: s.d > 0.5 ? s.k / s.d : null,
        };
      }
      kh.push(s.k); sh.push(spd);
      if (kh.length > 80) { kh.shift(); sh.shift(); }
      if (rec) out[`${i}_${code}`] = rec;
    }
  }
  // 全市場當日橫斷面百分位
  const byDay = {};
  for (const key in out) { const di = +key.split('_')[0]; (byDay[di] ||= []).push(key); }
  for (const di in byDay) {
    const keys = byDay[di];
    const ks = keys.map(k => out[k].k).sort((a, b) => a - b);
    for (const key of keys) {
      const v = out[key].k;
      let lo = 0, hi = ks.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (ks[m] < v) lo = m + 1; else hi = m; }
      out[key].kMktPct = (lo / ks.length) * 100;
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const rel = buildRel(days);
  for (const s of samples) Object.assign(s, rel[`${s.di}_${s.code}`] || {});
  return samples.filter(s => s.tradable && s.kSelfPct60 != null && s.netOpen != null && s.net5 != null);
};
const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };

const MEASURES = [
  ['① K 自身60日百分位', s => s.kSelfPct60],
  ['② K 全市場橫斷面百分位', s => s.kMktPct],
  ['③ K 近5日線性斜率', s => s.kSlope5],
  ['④ K−D 自身60日百分位', s => s.spdSelfPct],
  ['⑤ K 減自身20日均', s => s.kDevMA20],
  ['⑥ K/D 比值', s => s.kdRatio],
];

function deciles(w, f) {
  const vals = w.map(f).filter(v => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const cut = [];
  for (let q = 1; q < 10; q++) cut.push(vals[Math.floor(vals.length * q / 10)]);
  const buckets = Array.from({ length: 10 }, () => []);
  for (const s of w) {
    const v = f(s);
    if (v == null || !Number.isFinite(v)) continue;
    let b = 0; while (b < 9 && v >= cut[b]) b++;
    buckets[b].push(s);
  }
  return buckets;
}
/** 單調性：相鄰十分位差值中，同號者佔比 */
function mono(arr) {
  const d = []; for (let i = 1; i < arr.length; i++) d.push(arr[i] - arr[i - 1]);
  const pos = d.filter(x => x > 0).length, neg = d.filter(x => x < 0).length;
  return Math.max(pos, neg) / d.length;
}

console.log('十分位分析｜明開賣 netOpen（隔日沖）與 net5（波段5日）並列·可交易宇宙·扣費稅');
console.log('判準：整條曲線單調（相鄰同向≥7/9）且主窗與 OOT 方向一致\n');
for (const [name, f] of MEASURES) {
  console.log(`${'═'.repeat(126)}\n══ ${name}\n${'═'.repeat(126)}`);
  for (const key of ['netOpen', 'net5']) {
    const label = key === 'netOpen' ? '明開賣' : '5日  ';
    for (const [wn, w] of Object.entries(W)) {
      const bs = deciles(w, f);
      const means = bs.map(b => (b.length ? avg(b.map(s => s[key])) : null));
      const ok = means.every(m => m != null);
      const line = means.map(m => (m == null ? '  --  ' : String(r3(m)).padStart(6))).join(' ');
      const m1 = ok ? mono(means) : 0;
      const head = means[0], tail = means[9];
      console.log(`  ${label} ${wn.padEnd(4)} ${line}   單調 ${(m1 * 9).toFixed(0)}/9  頭尾差 ${ok ? r3(tail - head) : '--'}`);
    }
  }
  console.log('');
}
console.log('（每列由左到右＝該度量的第 1 到第 10 分位；數值＝該分位的平均淨報酬%）');
process.exit(0);
