// ─────────────────────────────────────────────────────────────────────────
// 漲停前夜訊號 5 日前瞻實驗（2026-07-20 起·使用者指令）
// 方法固定不可中途調整：A級=近66日漲停≥3次(熱池) ∧ 當日漲3~8.5%(可買) ∧ 破20日高。
// 每日收盤後執行(冪等)：①對答案(昨日picks vs 今日開/收盤) ②今日同法選股存檔
// ③滿5個記錄日且全部評估完→總結 vs 回測期望(明日漲停22.8%/上漲46.8%/開賣淨均+1.16%)。
// 資料：chipArchive via bt-core。存檔：prelimitExp/{date} + prelimitExp/summary。非投資建議。
// ─────────────────────────────────────────────────────────────────────────
import admin from 'firebase-admin';
import { loadDays, COST } from './lib/bt-core.mjs';

const EXP_DAYS = 5;
const days = await loadDays({ days: 66 });
const db = admin.firestore();
const L = days.length - 1;
const today = days[L].date;
const idxOf = Object.fromEntries(days.map((d, i) => [d.date, i]));
const col = db.collection('prelimitExp');
const out = [];

// ── ① 對答案：所有 pending 且次交易日資料已到的記錄 ──
const pendSnap = await col.where('evaluated', '==', false).get();
for (const doc of pendSnap.docs) {
  const x = doc.data();
  const k = idxOf[x.date];
  if (k == null || k >= L) continue;               // 次交易日未到
  const nx = days[k + 1].close;
  const outcomes = (x.picks || []).map(p => {
    const r = nx[p.code];
    if (!r || !(r[0] > 0) || !(r[2] > 0) || !(p.price > 0)) return null;
    const nextChg = +((r[0] - p.price) / p.price * 100).toFixed(2);
    return {
      code: p.code, name: p.name || p.code, nextChg,
      limit: nextChg >= 9.3, up: nextChg > 0,
      openNet: +((r[2] - p.price) / p.price * 100 - COST).toFixed(2),
      closeNet: +(nextChg - COST).toFixed(2),
    };
  }).filter(Boolean);
  await doc.ref.set({ evaluated: true, evalDate: days[k + 1].date, outcomes }, { merge: true });
  const lu = outcomes.filter(o => o.limit), up = outcomes.filter(o => o.up);
  out.push(`【對答案】${x.date} 第${x.dayNo}日 ${outcomes.length}檔 → 漲停${lu.length}檔 上漲${up.length}檔`);
  for (const o of outcomes) out.push(`  ${o.code} ${o.name}: 隔日${o.nextChg >= 0 ? '+' : ''}${o.nextChg}%${o.limit ? ' 🎯漲停' : o.up ? ' 紅' : ' 綠'}·開盤賣淨${o.openNet >= 0 ? '+' : ''}${o.openNet}%·收盤賣淨${o.closeNet >= 0 ? '+' : ''}${o.closeNet}%`);
}

// ── ② 今日記錄（實驗未滿 EXP_DAYS 個記錄日且今日尚未記錄）──
const allSnap = await col.get();
const recs = allSnap.docs.filter(d => d.id !== 'summary').map(d => d.data()).sort((a, b) => a.date.localeCompare(b.date));
const hasToday = recs.some(r => r.date === today);
if (!hasToday && recs.length < EXP_DAYS) {
  // 熱池：近66日漲停次數（≥9.3%）
  const limitCnt = {};
  for (let i = 1; i <= L; i++) {
    for (const code in days[i].close) {
      if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
      const c = days[i].close[code]?.[0], pc = days[i - 1].close?.[code]?.[0];
      if (c > 0 && pc > 0 && (c - pc) / pc * 100 >= 9.3) limitCnt[code] = (limitCnt[code] || 0) + 1;
    }
  }
  const D = days[L], P = days[L - 1];
  const picks = [];
  for (const code in D.close) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    if ((limitCnt[code] || 0) < 3) continue;                     // 熱池
    const r = D.close[code]; if (!r || r.length < 5) continue;
    const [c, v, , h, l] = r;
    const pc = P.close?.[code]?.[0], pv = P.close?.[code]?.[1];
    if (!(c > 0 && pc > 0 && h > l && v >= 50)) continue;
    const chg = (c - pc) / pc * 100;
    if (chg > 8.5 || chg < 3) continue;                          // 可買∧大漲
    let hi20 = 0;
    for (let k = 1; k <= 20; k++) { const x = days[L - k]?.close?.[code]; if (x?.[0] > hi20) hi20 = x[0]; }
    if (!(hi20 > 0 && c > hi20)) continue;                       // 破20日高
    picks.push({
      code, price: c, chg: +chg.toFixed(2), lim: limitCnt[code],
      pos: +((c - l) / (h - l)).toFixed(2), volX: pv > 0 ? +(v / pv).toFixed(2) : null,
    });
  }
  // 補股名
  try {
    const snap = (await db.collection('marketSnapshot').doc('latest').get()).data();
    const q = snap?.quotesJson ? JSON.parse(snap.quotesJson) : {};
    for (const p of picks) p.name = q[p.code]?.name || p.code;
  } catch { for (const p of picks) p.name = p.code; }
  const dayNo = recs.length + 1;
  await col.doc(today).set({ date: today, dayNo, picks, n: picks.length, evaluated: false, method: '熱池66日≥3板×漲3~8.5%×破20日高', at: Date.now() });
  out.push(`\n【明日預測】${today} 第${dayNo}/${EXP_DAYS}日 → ${picks.length ? picks.length + '檔' : '空手日(無符合訊號=方法本身的答案)'}`);
  for (const p of picks.sort((a, b) => b.lim - a.lim)) out.push(`  ${p.code} ${p.name}: 今+${p.chg}%·66日${p.lim}板·尾盤pos${p.pos}${p.pos >= 0.7 ? '✅' : ''}·量比${p.volX ?? '-'}·收${p.price}`);
}

// ── ③ 彙總（每次都更新；滿5個評估日出總結）──
const allSnap2 = await col.get();
const evaled = allSnap2.docs.filter(d => d.id !== 'summary').map(d => d.data()).filter(r => r.evaluated).sort((a, b) => a.date.localeCompare(b.date));
const flat = evaled.flatMap(r => r.outcomes || []);
const agg = {
  evaluatedDays: evaled.length, picks: flat.length,
  limitHits: flat.filter(o => o.limit).length,
  upHits: flat.filter(o => o.up).length,
  openNetAvg: flat.length ? +(flat.reduce((t, o) => t + o.openNet, 0) / flat.length).toFixed(2) : null,
  closeNetAvg: flat.length ? +(flat.reduce((t, o) => t + o.closeNet, 0) / flat.length).toFixed(2) : null,
  openWinPct: flat.length ? +(flat.filter(o => o.openNet > 0).length / flat.length * 100).toFixed(0) : null,
  benchmark: '回測期望(池內可買日·大漲×破高)：明日漲停22.8%·上漲46.8%·開賣淨均+1.16%',
  updatedAt: Date.now(),
};
const recorded = allSnap2.docs.filter(d => d.id !== 'summary').length;
const done = recorded >= EXP_DAYS && evaled.length >= EXP_DAYS;
if (done && flat.length) {
  agg.finalReport = `5日實驗總結：共${agg.picks}次預測→漲停${agg.limitHits}次(${(agg.limitHits / agg.picks * 100).toFixed(0)}% vs 回測22.8%)·上漲${agg.upHits}次(${(agg.upHits / agg.picks * 100).toFixed(0)}% vs 46.8%)·開盤賣淨均${agg.openNetAvg >= 0 ? '+' : ''}${agg.openNetAvg}%(vs +1.16%)·收盤賣淨均${agg.closeNetAvg >= 0 ? '+' : ''}${agg.closeNetAvg}%。樣本極小(5日)，結論僅供方向參考，以回測與後續累積為準。`;
  out.push(`\n══ ${agg.finalReport}`);
}
await col.doc('summary').set(agg, { merge: true });
out.push(`\n進度：已記錄${recorded}/${EXP_DAYS}日·已評估${evaled.length}日·累計${agg.picks}次預測(漲停${agg.limitHits}·上漲${agg.upHits})${done ? '·實驗完成✅' : ''}`);
console.log(out.join('\n') || `今日(${today})無事可做`);
process.exit(0);
