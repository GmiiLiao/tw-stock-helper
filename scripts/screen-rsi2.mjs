// ─────────────────────────────────────────────────────────────────────────
// RSI 完整實戰體系檢定（2026-07-24 使用者補充方法論·八子命題）
// 買進：①低檔黃金交叉(RSI5上穿RSI10·低檔區) ②底背離(價破前低·RSI不破) ③站回50
// 續抱：④雙線>50多頭續航 ⑤高檔鈍化(RSI5≥80連3日)
// 賣出：⑥高檔死亡交叉 ⑦頂背離(價創高·RSI不創高) ⑧跌破50
// bt-core：可交易宇宙·兩半窗·regime·隔日雙口徑＋5日持有
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, report } from './lib/bt-core.mjs';

const days = await loadDays({ days: 720 });
const samples = buildSamples(days);

const hist = {};
for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
  if (!/^\d{4}$/.test(code)) continue;
  const c = days[i].close[code]?.[0]; if (c > 0) (hist[code] ||= []).push([i, c]);
}
const bykey = {};
for (const code in hist) {
  const a = hist[code];
  if (a.length < 30) continue;
  let up5 = 0, dn5 = 0, up10 = 0, dn10 = 0;
  const r5s = [], r10s = [], cs = [];
  for (let k = 1; k < a.length; k++) {
    const ch = a[k][1] - a[k - 1][1]; const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (k <= 5) { up5 += g / 5; dn5 += l / 5; } else { up5 = (up5 * 4 + g) / 5; dn5 = (dn5 * 4 + l) / 5; }
    if (k <= 10) { up10 += g / 10; dn10 += l / 10; } else { up10 = (up10 * 9 + g) / 10; dn10 = (dn10 * 9 + l) / 10; }
    const r5 = up5 + dn5 > 0 ? up5 / (up5 + dn5) * 100 : 50;
    const r10 = up10 + dn10 > 0 ? up10 / (up10 + dn10) * 100 : 50;
    r5s.push(r5); r10s.push(r10); cs.push(a[k][1]);
    if (k < 22) continue;
    const t = r5s.length - 1;
    const f = {};
    // ① 低檔黃金交叉（兩檔嚴格度）
    f.goldX30 = r5s[t - 1] <= r10s[t - 1] && r5s[t] > r10s[t] && r5s[t - 1] < 30;
    f.goldX40 = r5s[t - 1] <= r10s[t - 1] && r5s[t] > r10s[t] && r5s[t - 1] < 40;
    // ⑥ 高檔死亡交叉
    f.deathX70 = r5s[t - 1] >= r10s[t - 1] && r5s[t] < r10s[t] && r5s[t - 1] > 70;
    // ③⑧ RSI10 穿越 50
    f.up50 = r10s[t - 1] < 50 && r10s[t] >= 50;
    f.dn50 = r10s[t - 1] >= 50 && r10s[t] < 50;
    // ④ 雙線>50 且 5 在 10 上（持有狀態）
    f.dual50 = r5s[t] > 50 && r10s[t] > 50 && r5s[t] > r10s[t];
    // ⑤ 高檔鈍化：RSI5≥80 連 3 日
    f.blunt = r5s[t] >= 80 && r5s[t - 1] >= 80 && r5s[t - 2] >= 80;
    // ②⑦ 20 日窗背離（前低/前高在窗內·RSI 差 ≥3 才算背離）
    let loI = t - 1, hiI = t - 1;
    for (let j = t - 20; j < t; j++) { if (cs[j] < cs[loI]) loI = j; if (cs[j] > cs[hiI]) hiI = j; }
    f.botDiv = cs[t] < cs[loI] && r5s[t] > r5s[loI] + 3;
    f.topDiv = cs[t] > cs[hiI] && r5s[t] < r5s[hiI] - 3;
    bykey[a[k][0] + '_' + code] = f;
  }
}
for (const s of samples) { const f = bykey[s.di + '_' + s.code]; if (f) Object.assign(s, f); }
const uni = samples.filter(s => s.tradable && s.goldX40 != null);
console.log(`樣本 ${uni.length.toLocaleString()}`);

report(uni, { title: '買進訊號（隔日）', groups: [
  { label: '①金叉·低檔<30', cond: s => s.goldX30 },
  { label: '①金叉·低檔<40', cond: s => s.goldX40 },
  { label: '②底背離', cond: s => s.botDiv },
  { label: '③RSI10站回50', cond: s => s.up50 },
]});
report(uni, { title: '續抱狀態（隔日）', groups: [
  { label: '④雙線>50', cond: s => s.dual50 },
  { label: '⑤高檔鈍化80×3', cond: s => s.blunt },
]});
report(uni, { title: '賣出訊號（隔日）', groups: [
  { label: '⑥死叉·高檔>70', cond: s => s.deathX70 },
  { label: '⑦頂背離', cond: s => s.topDiv },
  { label: '⑧RSI10跌破50', cond: s => s.dn50 },
]});
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
console.log('\n── ×5日持有淨均%（兩半窗·淨勝）──');
for (const [l, cond] of [
  ['①金叉<30', s => s.goldX30], ['①金叉<40', s => s.goldX40], ['②底背離', s => s.botDiv], ['③站回50', s => s.up50],
  ['④雙線>50', s => s.dual50], ['⑤鈍化80×3', s => s.blunt],
  ['⑥死叉>70', s => s.deathX70], ['⑦頂背離', s => s.topDiv], ['⑧跌破50', s => s.dn50],
]) {
  const sel = uni.filter(s => s.net5 != null).filter(cond);
  if (sel.length < 400) { console.log(`  ${l.padEnd(10)} n=${sel.length} 樣本不足`); continue; }
  const h = [0, 1].map(hf => avg(sel.filter(x => x.half === hf).map(x => x.net5)));
  const win = sel.filter(x => x.net5 > 0).length / sel.length * 100;
  console.log(`  ${l.padEnd(10)} n=${sel.length.toLocaleString().padStart(7)}  5日 ${h[0]?.toFixed(2)}%/${h[1]?.toFixed(2)}%  淨勝${win.toFixed(1)}%`);
}
process.exit(0);
