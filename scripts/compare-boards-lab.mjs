#!/usr/bin/env node
// ───────────────────────────────────────────────────────────
// 📏 榜單成果線性比對（2026-09-07 使用者：「跳空漲停的模型跟你挑選的推薦股差很多，請用線性成果比對」）
//
// 同一條時間軸、同一口徑，逐日並排三個榜：
//   🎯 gapLimitUp/{D}      影片形態（平底→連陽→漲停跳空，事件日 D）
//   🚀 limitUpRecommend/{D} 漲停預測（D 收盤後選、預測 D+1 漲停）
//   🩳 squeezeRecommend/{D} 軋空候選（D 收盤後選）
//   ＋ 基準：D 當日全部漲停股、全宇宙
// 口徑：進場一律 D+1 開盤（開盤即漲停＝買不到，另計）；隔日沖＝D+1 開→D+1 收；5 日＝D+1 開→D+5 收；10 日同理。
// 淨值扣成本 0.4425%（5/10 日）、隔日沖 0.4425%（同一套，簡化）。榜與榜的重疊也列出。
// 用法：node scripts/compare-boards-lab.mjs [--from 2026-07-29]
// ───────────────────────────────────────────────────────────
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
const db = getFirestore();
const COST = 0.4425;
const FROM = (process.argv.find(a => a.startsWith('--from=')) || '').slice(7) || '2026-07-29';

const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(80).get();
const days = snap.docs.map(d => d.data()).filter(a => a.closeJson).map(a => ({ date: a.date, close: JSON.parse(a.closeJson) })).reverse();
const idx = Object.fromEntries(days.map((d, i) => [d.date, i]));
const pct = (a, b) => b > 0 ? (a - b) / b * 100 : null;

const dates = days.map(d => d.date).filter(d => d >= FROM && idx[d] < days.length - 1);   // 至少有 D+1
const BOARDS = [
  { key: 'gap', col: 'gapLimitUp', label: '🎯影片形態', pick: x => (x?.items || []).map(i => i.code) },
  { key: 'lu', col: 'limitUpRecommend', label: '🚀漲停預測', pick: x => (x?.items || []).map(i => i.code) },
  { key: 'sq', col: 'squeezeRecommend', label: '🩳軋空候選', pick: x => (x?.items || []).map(i => i.code) },
];
function outcomes(D, codes) {
  const t = idx[D]; const rows = [];
  for (const code of codes) {
    const c0 = days[t].close[code]?.[0]; const n1 = days[t + 1]?.close[code]; if (!(c0 > 0) || !n1 || !(n1[2] > 0)) continue;
    const o1 = n1[2];
    if (pct(o1, c0) >= 9.5) { rows.push({ code, unbuyable: true }); continue; }
    const at = k => days[t + k]?.close[code]?.[0] || null;
    rows.push({ code, unbuyable: false, d1: pct(n1[0], o1) - COST, d5: at(5) ? pct(at(5), o1) - COST : null, d10: at(10) ? pct(at(10), o1) - COST : null });
  }
  return rows;
}
const agg = rows => { const b = rows.filter(r => !r.unbuyable); const m = k => { const a = b.filter(r => r[k] != null); return a.length ? a.reduce((s, r) => s + r[k], 0) / a.length : null; }; const w = k => { const a = b.filter(r => r[k] != null); return a.length ? a.filter(r => r[k] > 0).length / a.length * 100 : null; }; return { n: rows.length, unb: rows.filter(r => r.unbuyable).length, d1: m('d1'), d5: m('d5'), d10: m('d10'), w1: w('d1'), w5: w('d5'), w10: w('d10'), n5: b.filter(r => r.d5 != null).length }; };
const f = (x, w = 6) => x == null ? '   —  '.slice(0, w) : (x >= 0 ? '+' : '') + x.toFixed(1).padStart(w - 1) + '%';

const perDate = []; const pool = { gap: [], lu: [], sq: [], allLU: [], uni: [] }; const overlap = { 'gap∩lu': 0, 'gap∩sq': 0, 'lu∩sq': 0 };
for (const D of dates) {
  // 對齊：gapLimitUp 以事件日 D 存檔；limitUpRecommend／squeezeRecommend 以 targetDate（=D 的下一交易日）存檔
  const T = days[idx[D] + 1]?.date;
  const docs = await Promise.all(BOARDS.map(b => db.collection(b.col).doc(b.key === 'gap' ? D : T).get().then(s => s.data()).catch(() => null)));
  const picks = {}; BOARDS.forEach((b, i) => { picks[b.key] = b.pick(docs[i]); });
  const t = idx[D]; const prev = days[t - 1]?.close || {};
  const allLU = Object.keys(days[t].close).filter(c => { const p = days[t].close[c], q = prev[c]; return p?.[0] > 0 && q?.[0] > 0 && pct(p[0], q[0]) >= 9.5; });
  const uni = Object.keys(days[t].close).filter(c => days[t].close[c]?.[0] > 0 && days[t].close[c]?.[1] * days[t].close[c]?.[0] * 1000 > 50_000_000);
  const row = { D, gap: outcomes(D, picks.gap), lu: outcomes(D, picks.lu), sq: outcomes(D, picks.sq), allLU: outcomes(D, allLU), uni: outcomes(D, uni), luTotal: allLU.length, gapDoc: !!docs[0] };
  for (const k of Object.keys(pool)) pool[k].push(...row[k]);
  const S = k => new Set(picks[k]); overlap['gap∩lu'] += [...S('gap')].filter(c => S('lu').has(c)).length; overlap['gap∩sq'] += [...S('gap')].filter(c => S('sq').has(c)).length; overlap['lu∩sq'] += [...S('lu')].filter(c => S('sq').has(c)).length;
  perDate.push(row);
}
console.log(`區間 ${dates[0]} → ${dates[dates.length - 1]}（${dates.length} 個事件日；報酬以 D+1 開盤進場，淨值）`);
console.log('日期       | 🎯影片形態 n 隔日沖  5日   | 🚀漲停預測 n 隔日沖  5日   | 🩳軋空候選 n 隔日沖  5日   | 當日全部漲停 n 隔日沖 5日');
for (const r of perDate) {
  const c = k => { const a = agg(r[k]); return `${String(a.n).padStart(2)}${a.unb ? `(${a.unb}買不到)` : '        '.slice(0, 0)} ${f(a.d1)} ${f(a.d5)}`; };
  console.log(`${r.D} | ${c('gap').padEnd(28)}| ${c('lu').padEnd(28)}| ${c('sq').padEnd(28)}| ${c('allLU')}${r.gapDoc ? '' : '  (影片形態未回補)'}`);
}
console.log('\n▶ 合計（同一時間軸）');
for (const [k, label] of [['gap', '🎯影片形態'], ['lu', '🚀漲停預測'], ['sq', '🩳軋空候選'], ['allLU', '當日全部漲停（基準）'], ['uni', '全宇宙（基準）']]) {
  const a = agg(pool[k]);
  console.log(`  ${label.padEnd(12, '　')} n=${String(a.n).padStart(5)} 買不到=${String(a.unb).padStart(4)}  隔日沖 ${f(a.d1)}(勝${a.w1?.toFixed(0) ?? '—'}%)  5日 ${f(a.d5)}(勝${a.w5?.toFixed(0) ?? '—'}%·n${a.n5})  10日 ${f(a.d10)}(勝${a.w10?.toFixed(0) ?? '—'}%)`);
}
console.log(`\n▶ 榜單重疊（同日同檔）：${Object.entries(overlap).map(([k, v]) => `${k}=${v}`).join('  ')}`);
process.exit(0);
