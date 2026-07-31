// ─────────────────────────────────────────────────────────────────────────
// 犀利媽 RSI(5)/RSI(10) 極端值法回測（2026-07-24·使用者提供影片截圖更正：
// 方法=「平常RSI不理它，只看最高跟最低」——RSI5/10<10 超跌進場、高檔(≥95徘徊)賣出）
// 檢定：①RSI5 分桶 ②RSI5×RSI10 雙低 ③高檔賣訊 ④與乖離5日線(-5%)的重疊/增量
// bt-core：可交易宇宙·兩半窗·regime·隔日雙口徑+5日持有
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, report } from './lib/bt-core.mjs';

const days = await loadDays({ days: 720 });
const samples = buildSamples(days);

// Wilder RSI（台股看盤軟體慣用）＋乖離5
const hist = {};
for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
  if (!/^\d{4}$/.test(code)) continue;
  const c = days[i].close[code]?.[0]; if (c > 0) (hist[code] ||= []).push([i, c]);
}
const bykey = {};
for (const code in hist) {
  const a = hist[code];
  if (a.length < 15) continue;
  let up5 = 0, dn5 = 0, up10 = 0, dn10 = 0;
  for (let k = 1; k < a.length; k++) {
    const ch = a[k][1] - a[k - 1][1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (k <= 5) { up5 += g / 5; dn5 += l / 5; } else { up5 = (up5 * 4 + g) / 5; dn5 = (dn5 * 4 + l) / 5; }
    if (k <= 10) { up10 += g / 10; dn10 += l / 10; } else { up10 = (up10 * 9 + g) / 10; dn10 = (dn10 * 9 + l) / 10; }
    if (k >= 10) {
      const rsi5 = up5 + dn5 > 0 ? up5 / (up5 + dn5) * 100 : 50;
      const rsi10 = up10 + dn10 > 0 ? up10 / (up10 + dn10) * 100 : 50;
      const m5 = k >= 4 ? (a[k][1] + a[k-1][1] + a[k-2][1] + a[k-3][1] + a[k-4][1]) / 5 : null;
      bykey[a[k][0] + '_' + code] = { rsi5: +rsi5.toFixed(1), rsi10: +rsi10.toFixed(1), bias5: m5 ? (a[k][1] - m5) / m5 * 100 : null };
    }
  }
}
for (const s of samples) { const x = bykey[s.di + '_' + s.code]; if (x) Object.assign(s, x); }
const uni = samples.filter(s => s.tradable && s.rsi5 != null && s.bias5 != null);
console.log(`樣本 ${uni.length.toLocaleString()}`);

report(uni, { title: '① RSI5 分桶（隔日）', groups: [
  { label: 'RSI5<10 超跌', cond: s => s.rsi5 < 10 },
  { label: 'RSI5 10~20', cond: s => s.rsi5 >= 10 && s.rsi5 < 20 },
  { label: 'RSI5 40~60', cond: s => s.rsi5 >= 40 && s.rsi5 < 60 },
  { label: 'RSI5 80~90', cond: s => s.rsi5 >= 80 && s.rsi5 < 90 },
  { label: 'RSI5≥90 高檔', cond: s => s.rsi5 >= 90 },
  { label: 'RSI5≥95 極端', cond: s => s.rsi5 >= 95 },
]});
report(uni, { title: '② 影片定義：雙RSI<10 ＋ 高檔賣訊', groups: [
  { label: 'RSI5<10∧RSI10<10', cond: s => s.rsi5 < 10 && s.rsi10 < 10 },
  { label: 'RSI5<10∧RSI10<20', cond: s => s.rsi5 < 10 && s.rsi10 < 20 },
  { label: 'RSI5≥95∧RSI10≥90', cond: s => s.rsi5 >= 95 && s.rsi10 >= 90 },
]});
report(uni, { title: '③ RSI vs 乖離5：重疊與增量', groups: [
  { label: '雙RSI<10(全)', cond: s => s.rsi5 < 10 && s.rsi10 < 10 },
  { label: '雙RSI低∧乖離<-5', cond: s => s.rsi5 < 10 && s.rsi10 < 10 && s.bias5 < -5 },
  { label: '雙RSI低∧乖離≥-5', cond: s => s.rsi5 < 10 && s.rsi10 < 10 && s.bias5 >= -5 },
  { label: '乖離<-5∧RSI5≥10', cond: s => s.bias5 < -5 && s.rsi5 >= 10 },
]});
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
console.log('\n── ×5日持有淨均%（兩半窗）──');
for (const [l, cond] of [
  ['雙RSI<10', s => s.rsi5 < 10 && s.rsi10 < 10],
  ['RSI5<10(單)', s => s.rsi5 < 10],
  ['雙RSI低∧乖離<-5', s => s.rsi5 < 10 && s.rsi10 < 10 && s.bias5 < -5],
  ['乖離<-5(舊定版)', s => s.bias5 < -5],
  ['RSI5≥95', s => s.rsi5 >= 95],
]) {
  const sel = uni.filter(s => s.net5 != null).filter(cond);
  const h = [0, 1].map(hf => avg(sel.filter(x => x.half === hf).map(x => x.net5)));
  const win = sel.filter(x => x.net5 > 0).length / (sel.length || 1) * 100;
  console.log(`  ${l.padEnd(16)} n=${sel.length.toLocaleString().padStart(7)}  5日 ${h[0]?.toFixed(2)}%/${h[1]?.toFixed(2)}%  淨勝${win.toFixed(1)}%`);
}
process.exit(0);
