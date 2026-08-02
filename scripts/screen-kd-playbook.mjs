// ─────────────────────────────────────────────────────────────────────────
// KD 完整口訣檢定（第二批）—— 2026-08-02
//
// 前兩輪已測：金叉/死叉、K>80/K<20 靜態門檻、KD×MA（個股均線）。
// 本輪補測使用者教學中**尚未驗證的四個主張**，每一個都照原文操作化：
//
//   A 鈍化＝「**連續 3 天以上**」（前輪測的是單日靜態門檻，定義不同！）
//     · 高檔鈍化：連續3天 KD>80 →「強者恆強·不宜放空·順勢抱牢」
//     · 低檔鈍化：連續3天 KD<20 →「弱到極點·可能續破底·不要摸底」
//   B 背離（原文稱「大波段轉折的強烈訊號」）
//     · 底背離：價創波段新低，但 KD 低點一波比一波高
//     · 頂背離：價創波段新高，但 KD 高點一波比一波低
//   C 「KD 在區間震盪盤很準，在強烈趨勢盤容易失效」
//   D 「先用均線判斷大趨勢，在**多頭市場**中找拉回的黃金交叉，勝率顯著提升」
//     ⚠上輪用「個股站上 MA20」操作化 →交集僅 492 筆。本輪改用**大盤**多頭
//       （全市場等權指數站上其 MA20），才是原文「大趨勢」的本意。
//
// 口徑：明開賣（netOpen·扣費稅）為主，另列 5 日持有（鈍化/背離屬波段語意）。
// 判準：主窗 + 第三獨立窗 OOT 都要方向一致，兩半窗不得換號。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, avg, r3 } from './lib/bt-core.mjs';

const P = 9;

/** KD ＋ 連續天數（鈍化用）＋ 歷史 K 序列（背離用） */
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
      s.k = (pk * 2) / 3 + rsv / 3;
      s.d = (pd * 2) / 3 + s.k / 3;
      // 鈍化連續天數（含今日）：原文定義「KD 值連續3天以上維持在 80 以上 / 20 以下」
      s.hiN = (s.k > 80 && s.d > 80) ? s.hiN + 1 : 0;
      s.loN = (s.k < 20 && s.d < 20) ? s.loN + 1 : 0;
      out[`${i}_${code}`] = { k: s.k, d: s.d, pk, pd, hiN: s.hiN, loN: s.loN };
    }
  }
  return out;
}

/** 背離：以 20 日窗（排除最近 2 日）內的極值 bar 作對照 */
function buildDiv(days, kd) {
  const hist = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0];
      const x = kd[`${i}_${code}`];
      if (!(c > 0) || !x) continue;
      const H = (hist[code] ||= []);
      // 對照窗＝ t-20 ~ t-3（排除最近兩根，避免拿相鄰 bar 當「前一波」）
      const win = H.slice(-20, -2);
      if (win.length >= 10) {
        let lo = win[0], hi = win[0];
        for (const b of win) { if (b.c < lo.c) lo = b; if (b.c > hi.c) hi = b; }
        out[`${i}_${code}`] = {
          botDiv: c < lo.c && x.k > lo.k,   // 價更低但 K 更高＝底背離
          topDiv: c > hi.c && x.k < hi.k,   // 價更高但 K 更低＝頂背離
        };
      }
      H.push({ c, k: x.k });
      if (H.length > 30) H.shift();
    }
  }
  return out;
}

/** 大盤等權指數 + 其 MA20（用於 D 的「大趨勢」）；同時給每日震盪/趨勢分類 */
function buildMarket(days) {
  const idx = [];
  let lvl = 100;
  for (let i = 0; i < days.length; i++) {
    const P0 = days[i - 1];
    let sum = 0, n = 0;
    if (P0) for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0], pc = P0.close?.[code]?.[0];
      if (c > 0 && pc > 0) { sum += (c / pc - 1); n++; }
    }
    if (n > 300) lvl *= 1 + sum / n;
    idx.push(lvl);
  }
  const out = [];
  for (let i = 0; i < idx.length; i++) {
    const w = idx.slice(Math.max(0, i - 19), i + 1);
    const ma20 = w.reduce((a, b) => a + b, 0) / w.length;
    out.push({ lvl: idx[i], ma20, mktBull: i >= 20 ? idx[i] > ma20 : null });
  }
  return out;
}

/** 個股 20 日振幅 → 震盪盤 / 趨勢盤 */
function buildRange(days) {
  const hist = {}, out = {};
  for (let i = 0; i < days.length; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0];
      if (!(c > 0)) continue;
      const H = (hist[code] ||= []);
      H.push(c); if (H.length > 20) H.shift();
      if (H.length === 20) {
        const hi = Math.max(...H), lo = Math.min(...H);
        out[`${i}_${code}`] = lo > 0 ? (hi - lo) / lo * 100 : null;
      }
    }
  }
  return out;
}

const load = async (opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const kd = buildKD(days), div = buildDiv(days, kd), mkt = buildMarket(days), rng = buildRange(days);
  for (const s of samples) {
    const a = kd[`${s.di}_${s.code}`];
    if (a) { s.k = a.k; s.d = a.d; s.hiN = a.hiN; s.loN = a.loN; s.goldCross = a.pk <= a.pd && a.k > a.d; }
    const b = div[`${s.di}_${s.code}`]; if (b) { s.botDiv = b.botDiv; s.topDiv = b.topDiv; }
    s.mktBull = mkt[s.di]?.mktBull ?? null;
    s.rng20 = rng[`${s.di}_${s.code}`] ?? null;
  }
  return { all: samples.filter(s => s.tradable && s.k != null && s.netOpen != null) };
};

const W = { 主窗: await load({ days: 480 }), OOT: await load({ days: 250, to: '2023-07-31' }) };

function row(label, cond, key = 'netOpen', minN = 200) {
  const cells = [];
  for (const [wn, w] of Object.entries(W)) {
    const sel = w.all.filter(s => cond(s) && s[key] != null);
    const base = w.all.filter(s => s[key] != null);
    if (sel.length < minN) { cells.push(`${wn} 樣本不足(${sel.length})`.padEnd(42)); continue; }
    const h = [0, 1].map(hf => r3(avg(sel.filter(s => s.half === hf).map(s => s[key]))));
    const m = r3(avg(sel.map(s => s[key])));
    const bm = r3(avg(base.map(s => s[key])));
    const same = Math.sign(h[0]) === Math.sign(h[1]);
    const wr = ((sel.filter(s => s[key] > 0).length / sel.length) * 100).toFixed(1);
    cells.push(`${wn} ${String(m).padStart(7)}%[${h[0]}/${h[1]}]${same ? '  ' : '⚠'} 勝${String(wr).padStart(5)}% n=${String(sel.length).padStart(6)}(基準${bm})`.padEnd(42));
  }
  console.log(`  ${label.padEnd(30)} ${cells.join(' ')}`);
}

const H = t => console.log(`\n${'═'.repeat(120)}\n══ ${t}\n${'═'.repeat(120)}`);

H('A 鈍化＝「連續 3 天以上」（原文定義·前輪測的是單日靜態門檻）');
console.log('  ── 高檔鈍化：主張「強者恆強·不宜放空·順勢抱牢」→ 若主張成立，報酬應不差於基準 ──');
for (const n of [1, 2, 3, 5]) row(`KD>80 連續${n}天`, s => s.hiN >= n, 'netOpen');
console.log('  【持有5日】');
for (const n of [1, 3, 5]) row(`KD>80 連續${n}天`, s => s.hiN >= n, 'net5');
console.log('\n  ── 低檔鈍化：主張「弱到極點·可能續破底·不要摸底」→ 若成立，報酬應顯著為負 ──');
for (const n of [1, 2, 3, 5]) row(`KD<20 連續${n}天`, s => s.loN >= n, 'netOpen');
console.log('  【持有5日】');
for (const n of [1, 3, 5]) row(`KD<20 連續${n}天`, s => s.loN >= n, 'net5');

H('B 背離（原文稱「大波段轉折的強烈訊號」）');
row('底背離（價新低·K更高）', s => s.botDiv, 'netOpen');
row('底背離【5日】', s => s.botDiv, 'net5');
row('頂背離（價新高·K更低）', s => s.topDiv, 'netOpen');
row('頂背離【5日】', s => s.topDiv, 'net5');

H('C 「KD 在區間震盪盤準·在強烈趨勢盤失效」');
console.log('  ── 若主張成立：震盪盤(20日振幅小)的 K<20 應優於趨勢盤 ──');
row('K<20 ∧ 震盪盤(振幅<15%)', s => s.k < 20 && s.rng20 != null && s.rng20 < 15, 'netOpen');
row('K<20 ∧ 中性(15~30%)', s => s.k < 20 && s.rng20 >= 15 && s.rng20 < 30, 'netOpen');
row('K<20 ∧ 趨勢盤(振幅≥30%)', s => s.k < 20 && s.rng20 >= 30, 'netOpen');
row('金叉 ∧ 震盪盤(<15%)', s => s.goldCross && s.rng20 != null && s.rng20 < 15, 'netOpen');
row('金叉 ∧ 趨勢盤(≥30%)', s => s.goldCross && s.rng20 >= 30, 'netOpen');

H('D 「大盤多頭 × 拉回低點的黃金交叉」（改用大盤等權指數 vs 其 MA20）');
row('大盤多頭 單獨', s => s.mktBull === true, 'netOpen');
row('金叉 ∧ 大盤多頭', s => s.goldCross && s.mktBull === true, 'netOpen');
row('低檔金叉K<30 ∧ 大盤多頭', s => s.goldCross && s.k < 30 && s.mktBull === true, 'netOpen');
row('低檔金叉K<30 ∧ 大盤空頭', s => s.goldCross && s.k < 30 && s.mktBull === false, 'netOpen');
row('低檔金叉∧大盤多頭【5日】', s => s.goldCross && s.k < 30 && s.mktBull === true, 'net5');

console.log(`\n${'═'.repeat(120)}\n判準：主窗與 OOT 都要同方向、兩半窗不得換號(⚠)，且達到主張宣稱的方向才算成立。\n${'═'.repeat(120)}`);
process.exit(0);
