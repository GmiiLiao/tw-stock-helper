// ─────────────────────────────────────────────────────────────────────────
// 日韓早盤 → 台股當日 預測力檢定 —— 2026-08-03
//
// 使用者要求：台股開盤前，加入日韓已開盤的漲跌走向與產業風向評估預測警示。
//
// 時區事實（先確認再談預測）：日本與韓國都是 UTC+9，兩地 09:00 開盤 ＝ **台北 08:00**。
//   台股 08:30 試撮、09:00 正式開盤 ⇒ 我們在台股開盤前有 **30~60 分鐘**的
//   日韓實盤資訊。這是真的領先窗口，不是事後諸葛。
//
// 三個變數（都在台股開盤前可知）：
//   ① asiaGap   日韓開盤跳空 = 開盤價/前收 - 1        ← 主要反映美股隔夜，與費半重疊
//   ② asiaDrift 開盤後30分走勢 = 08:30價/開盤價 - 1   ← **這才是新資訊**（美股沒有的部分）
//   ③ asiaTotal 合計 = 08:30價/前收 - 1
//
// 被預測目標（只用可交易的）：
//   twDay = 台股 開盤→收盤 %（08:30 看到訊號，09:00 買、13:30 賣，可執行）
//   twGap = 台股開盤跳空 %（**不可交易**，你買不到昨收，僅作機制理解）
//
// 增量檢定（本專案鐵律）：費半隔夜已經在 globalMarkets 裡了。
//   若 asiaDrift 的預測力在控制費半之後消失，這張卡就只是把費半講第二遍。
//
// 資料：Yahoo 5分K（60日上限）＋ 日線。樣本必然偏小(~40交易日)，
//   **不足以套用本站 480日主窗＋OOT 的標準**——結論一律標示為初步。
// 非投資建議。
// ─────────────────────────────────────────────────────────────────────────
const Y = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const H = { headers: { 'User-Agent': 'Mozilla/5.0' } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function chart(sym, q) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(`${Y}${encodeURIComponent(sym)}?${q}`, H);
      if (r.ok) return (await r.json())?.chart?.result?.[0] || null;
    } catch { /* retry */ }
    await sleep(1500 * (a + 1));
  }
  return null;
}
/** UTC 日期字串 */
const utcDay = ts => new Date(ts * 1000).toISOString().slice(0, 10);
const utcHM = ts => { const d = new Date(ts * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

/** 5分K → 每日 {open(00:00UTC), p30(00:30UTC), prevClose} */
async function asiaDaily(sym) {
  const r = await chart(sym, 'interval=5m&range=60d');
  if (!r) return {};
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  const byDay = {};
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i], o = q.open?.[i];
    if (!(c > 0)) continue;
    const d = utcDay(ts[i]), hm = utcHM(ts[i]);
    const b = (byDay[d] ||= { open: null, p30: null, last: null, n: 0 });
    b.n++; b.last = c;
    if (hm >= 0 && hm < 5 && b.open == null) b.open = o > 0 ? o : c;   // 09:00 JST/KST ＝ 00:00 UTC
    if (hm >= 25 && hm <= 35 && b.p30 == null) b.p30 = c;              // 開盤後30分 ＝ 台北 08:30
  }
  // 前一交易日收盤（用日線比較準）
  const d1 = await chart(sym, 'interval=1d&range=3mo');
  const dts = d1?.timestamp || [], dcl = d1?.indicators?.quote?.[0]?.close || [];
  const closes = {};
  for (let i = 0; i < dts.length; i++) if (dcl[i] > 0) closes[utcDay(dts[i])] = dcl[i];
  const days = Object.keys(closes).sort();
  const out = {};
  for (const d of Object.keys(byDay).sort()) {
    const b = byDay[d];
    if (!(b.open > 0 && b.p30 > 0)) continue;
    const i = days.indexOf(d);
    const prev = i > 0 ? closes[days[i - 1]] : null;
    if (!(prev > 0)) continue;
    out[d] = {
      gap: +((b.open / prev - 1) * 100).toFixed(3),
      drift: +((b.p30 / b.open - 1) * 100).toFixed(3),
      total: +((b.p30 / prev - 1) * 100).toFixed(3),
    };
  }
  return out;
}

const N = await asiaDaily('^N225'); await sleep(800);
const K = await asiaDaily('^KS11'); await sleep(800);

// 台股日線（開盤/收盤/前收）
const tw = await chart('^TWII', 'interval=1d&range=3mo');
const tts = tw?.timestamp || [], tq = tw?.indicators?.quote?.[0] || {};
const TW = {};
{
  const rows = [];
  for (let i = 0; i < tts.length; i++) if (tq.close?.[i] > 0 && tq.open?.[i] > 0) rows.push({ d: utcDay(tts[i]), o: tq.open[i], c: tq.close[i] });
  for (let i = 1; i < rows.length; i++) TW[rows[i].d] = {
    gap: +((rows[i].o / rows[i - 1].c - 1) * 100).toFixed(3),
    day: +((rows[i].c / rows[i].o - 1) * 100).toFixed(3),
    full: +((rows[i].c / rows[i - 1].c - 1) * 100).toFixed(3),
  };
}
await sleep(800);
// 費半（隔夜美股·增量控制用）：對台股 D 日，取美股前一交易日收盤漲跌
const sx = await chart('^SOX', 'interval=1d&range=3mo');
const sts = sx?.timestamp || [], sq = sx?.indicators?.quote?.[0] || {};
const SOX = []; for (let i = 0; i < sts.length; i++) if (sq.close?.[i] > 0) SOX.push({ d: utcDay(sts[i]), c: sq.close[i] });
const soxChg = {}; for (let i = 1; i < SOX.length; i++) soxChg[SOX[i].d] = +((SOX[i].c / SOX[i - 1].c - 1) * 100).toFixed(3);
/** 台股 D 日對應的隔夜費半＝日期 < D 的最後一筆 */
const soxFor = d => { let v = null; for (const k of Object.keys(soxChg).sort()) { if (k < d) v = soxChg[k]; else break; } return v; };

const rows = [];
for (const d of Object.keys(TW).sort()) {
  const n = N[d], k = K[d];
  if (!n || !k) continue;
  rows.push({ d, ...TW[d], nGap: n.gap, nDrift: n.drift, nTot: n.total, kGap: k.gap, kDrift: k.drift, kTot: k.total,
    avgDrift: +((n.drift + k.drift) / 2).toFixed(3), avgTot: +((n.total + k.total) / 2).toFixed(3), sox: soxFor(d) });
}
console.log(`樣本：${rows.length} 個交易日（${rows[0]?.d} → ${rows[rows.length - 1]?.d}）｜Yahoo 5分K 上限 60 天，樣本必然偏小`);
console.log(`台股基準：開盤→收盤 均 ${(rows.reduce((a, b) => a + b.day, 0) / rows.length).toFixed(3)}%·上漲日 ${(rows.filter(x => x.day > 0).length / rows.length * 100).toFixed(1)}%\n`);

const corr = (a, b) => {
  const n = a.length; if (n < 5) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; sa += da * da; sb += db * db; }
  return sa > 0 && sb > 0 ? +(sab / Math.sqrt(sa * sb)).toFixed(3) : null;
};
const F = [['日經 開盤跳空', x => x.nGap], ['日經 開盤後30分', x => x.nDrift], ['日經 合計', x => x.nTot],
  ['KOSPI 開盤跳空', x => x.kGap], ['KOSPI 開盤後30分', x => x.kDrift], ['KOSPI 合計', x => x.kTot],
  ['日韓平均 開盤後30分', x => x.avgDrift], ['日韓平均 合計', x => x.avgTot], ['費半隔夜(對照)', x => x.sox]];
console.log('══ ① 相關係數（台股 開盤→收盤 才是可交易目標；開盤跳空不可交易僅供理解）\n');
console.log(`  ${'變數'.padEnd(22)} ${'vs 台股開盤跳空'.padStart(16)} ${'vs 台股開盤→收盤'.padStart(18)} ${'vs 台股全日'.padStart(14)}`);
for (const [nm, f] of F) {
  const v = rows.filter(x => f(x) != null);
  if (v.length < 10) { console.log(`  ${nm.padEnd(22)} 樣本不足 ${v.length}`); continue; }
  console.log(`  ${nm.padEnd(22)} ${String(corr(v.map(f), v.map(x => x.gap))).padStart(16)} ${String(corr(v.map(f), v.map(x => x.day))).padStart(18)} ${String(corr(v.map(f), v.map(x => x.full))).padStart(14)}`);
}

console.log('\n══ ② 分組：日韓開盤後30分走勢 → 台股開盤→收盤（可交易口徑）\n');
for (const [nm, f] of [['日韓平均30分走勢', x => x.avgDrift], ['日韓平均合計', x => x.avgTot], ['費半隔夜(對照)', x => x.sox]]) {
  const v = rows.filter(x => f(x) != null).sort((a, b) => f(a) - f(b));
  const t = Math.floor(v.length / 3);
  const g = [v.slice(0, t), v.slice(t, v.length - t), v.slice(v.length - t)];
  const lab = ['最弱1/3', '中間1/3', '最強1/3'];
  console.log(`  ${nm}：`);
  g.forEach((x, i) => {
    if (!x.length) return;
    const m = x.reduce((a, b) => a + b.day, 0) / x.length;
    console.log(`    ${lab[i]}（${f(x[0]).toFixed(2)}~${f(x[x.length - 1]).toFixed(2)}%）→ 台股開→收 均 ${m.toFixed(3)}%·上漲 ${(x.filter(y => y.day > 0).length / x.length * 100).toFixed(0)}%·n=${x.length}`);
  });
}

console.log('\n══ ③ 增量檢定：控制費半隔夜之後，日韓30分走勢還有沒有資訊？\n');
const withSox = rows.filter(x => x.sox != null);
const sSorted = [...withSox].sort((a, b) => a.sox - b.sox);
const h = Math.floor(sSorted.length / 2);
for (const [lab, grp] of [['費半隔夜弱的一半', sSorted.slice(0, h)], ['費半隔夜強的一半', sSorted.slice(h)]]) {
  const s2 = [...grp].sort((a, b) => a.avgDrift - b.avgDrift);
  const q = Math.floor(s2.length / 2);
  const lo = s2.slice(0, q), hi = s2.slice(s2.length - q);
  if (!lo.length || !hi.length) { console.log(`  ${lab}：樣本不足`); continue; }
  const ml = lo.reduce((a, b) => a + b.day, 0) / lo.length, mh = hi.reduce((a, b) => a + b.day, 0) / hi.length;
  console.log(`  ${lab}（n=${grp.length}）：日韓30分弱→台股 ${ml.toFixed(3)}%／日韓30分強→台股 ${mh.toFixed(3)}%  差 ${(mh - ml).toFixed(3)}pp ${mh > ml ? '(同向✓)' : '(反向✗)'}`);
}
console.log('\n⚠樣本僅約 40 個交易日（Yahoo 5分K 60天上限），遠低於本站 480日主窗＋OOT 的標準。');
console.log('  結論一律視為**初步**，正式結論需靠逐日歸檔累積後重測。非投資建議。');
process.exit(0);
