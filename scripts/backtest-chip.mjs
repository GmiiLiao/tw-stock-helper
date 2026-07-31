// 籌碼策略回測：讀 chipArchive/{date}（法人/融資券/收盤），測隔日沖勝率。
// 用法：GOOGLE_APPLICATION_CREDENTIALS=<key> node scripts/backtest-chip.mjs
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
initializeApp({ credential: applicationDefault(), projectId: 'tw-stock-helper' });
const db = getFirestore();

const snap = await db.collection('chipArchive').orderBy('date').get();
const days = snap.docs.map(d => d.data()).filter(d => d.complete && d.instJson && d.closeJson)
  .map(d => ({ date: d.date, inst: JSON.parse(d.instJson), close: JSON.parse(d.closeJson), margin: d.marginJson ? JSON.parse(d.marginJson) : {} }));
console.log(`資料天數 ${days.length}（${days[0]?.date} → ${days[days.length - 1]?.date}）`);
if (days.length < 20) { console.log('資料不足'); process.exit(1); }

// 月末最後 3 個交易日集合（投信作帳窗口）
const monthEnd = new Set();
for (let i = 0; i < days.length; i++) {
  const m = days[i].date.slice(0, 7);
  const nm = days[i + 1]?.date.slice(0, 7);
  if (!nm || nm !== m) { monthEnd.add(days[i].date); if (days[i - 1]) monthEnd.add(days[i - 1].date); if (days[i - 2]) monthEnd.add(days[i - 2].date); }
}

const V = {}; const add = (k, r) => { (V[k] ??= []).push(r); };
const fStreak = {}, tStreak = {};
for (let i = 0; i < days.length - 1; i++) {
  const d = days[i], nx = days[i + 1];
  for (const code in d.inst) {
    const [f, t] = d.inst[code];
    fStreak[code] = f > 0 ? (fStreak[code] || 0) + 1 : 0;
    tStreak[code] = t > 0 ? (tStreak[code] || 0) + 1 : 0;
    const c0 = d.close[code]?.[0], c1 = nx.close[code]?.[0];
    if (!(c0 > 0) || !(c1 > 0)) continue;
    const prev = days[i - 1]?.close[code]?.[0];
    const chg = prev > 0 ? (c0 - prev) / prev * 100 : 0;
    const ret = (c1 - c0) / c0 * 100;
    const [mb, sb] = d.margin[code] || [0, 0];
    const tPrev = days[i - 1]?.inst[code]?.[1] ?? 0;

    if (tStreak[code] >= 3 && t >= 100) add('S1 投信連買3日(≥100張)', ret);
    if (tStreak[code] >= 3 && t >= 100 && chg > 1) add('S2 投信連買3日+當日漲1%', ret);
    if (fStreak[code] >= 5 && f >= 2000) add('S3 外資連買5日(≥2000張)', ret);
    if (f >= 1000 && t >= 100) add('S4 外資投信同日買', ret);
    if (mb > 1000 && sb / mb >= 0.3 && chg >= 2) add('S5 券資比30%+漲2%(軋空)', ret);
    if (t >= 500 && tPrev <= 0) add('S6 投信首買(≥500張)', ret);
    if (tStreak[code] >= 2 && t >= 100 && monthEnd.has(d.date)) add('S7 投信連買+月末作帳窗', ret);
  }
}
const rows = Object.entries(V).map(([k, r]) => {
  const w = r.filter(x => x > 0).length;
  const avg = r.reduce((s, x) => s + x, 0) / r.length;
  const ws = r.filter(x => x > 0).reduce((s, x) => s + x, 0);
  const ls = Math.abs(r.filter(x => x <= 0).reduce((s, x) => s + x, 0));
  return { k, n: r.length, win: Math.round(w / r.length * 100), avg: +avg.toFixed(2), pf: ls > 0 ? +(ws / ls).toFixed(2) : 99 };
}).sort((a, b) => b.win - a.win);
for (const r of rows) console.log(`${r.k}: ${r.n}筆 勝率 ${r.win}% 平均 ${r.avg >= 0 ? '+' : ''}${r.avg}% PF ${r.pf}`);
process.exit(0);
