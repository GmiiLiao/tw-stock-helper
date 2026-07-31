// ─────────────────────────────────────────────────────────────────────────
// 三重確認 out-of-time 驗證（2026-07-27）：能否入權重的關卡
// ①第三獨立窗（2022-07~2023-07 回填年·訊號設計時從未見過）
// ②逐年分段（四年·每段獨立）③regime 分割 ④隔日 vs 5日 口徑（決定該進哪個模型）
// ⑤流動性/價格分層（排除小型股假象）
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, COST } from './lib/bt-core.mjs';

const runWindow = async (label, opt) => {
  const days = await loadDays(opt);
  const samples = buildSamples(days);
  const hist={};
  for(let i=0;i<days.length;i++)for(const code in days[i].close){if(!/^\d{4}$/.test(code))continue;const c=days[i].close[code]?.[0];if(c>0)(hist[code]||=[]).push([i,c]);}
  const rb={};
  for(const code in hist){const a=hist[code];if(a.length<15)continue;let u5=0,d5=0,u10=0,d10=0;
   for(let k=1;k<a.length;k++){const ch=a[k][1]-a[k-1][1],g=Math.max(ch,0),l=Math.max(-ch,0);
    if(k<=5){u5+=g/5;d5+=l/5}else{u5=(u5*4+g)/5;d5=(d5*4+l)/5}
    if(k<=10){u10+=g/10;d10+=l/10}else{u10=(u10*9+g)/10;d10=(d10*9+l)/10}
    if(k>=10)rb[a[k][0]+'_'+code]={r5:u5+d5>0?u5/(u5+d5)*100:50};}}
  for(const s of samples){const x=rb[s.di+'_'+s.code];if(x)s.r5=x.r5;
   const it=days[s.di-1]?.inst?.[s.code]; s.instPrev=it?(it[0]||0)+(it[1]||0):null;
   s.triple = s.r5!=null && s.r5<20 && s.instPrev>0 && s.volX>1.5;}
  const uni=samples.filter(s=>s.tradable&&s.r5!=null&&s.net5!=null);
  const avg=(a,f)=>a.length?+(a.reduce((t,x)=>t+f(x),0)/a.length).toFixed(2):null;
  const win=(a,f)=>a.length?+(a.filter(x=>f(x)>0).length/a.length*100).toFixed(1):null;
  const tri=uni.filter(s=>s.triple);
  const h=[0,1].map(hf=>avg(tri.filter(x=>x.half===hf),x=>x.net5));
  console.log(`\n══ ${label}（${days[0]?.date}→${days[days.length-1]?.date}·${days.length}日）══`);
  console.log(`  宇宙 ${uni.length.toLocaleString()}·基準 5日 ${avg(uni,x=>x.net5)}%/勝${win(uni,x=>x.net5)}%`);
  console.log(`  三重確認 n=${tri.length.toLocaleString()}(${(tri.length/days.length).toFixed(1)}檔/日)  5日淨均 ${avg(tri,x=>x.net5)}%[${h[0]}/${h[1]}]  淨勝 ${win(tri,x=>x.net5)}%  隔日開賣 ${avg(tri,x=>x.netOpen)}%  隔日收賣 ${avg(tri,x=>x.netClose)}%`);
  return { uni, tri, avg, win, days };
};
// ① 第三獨立窗（回填年·2022-07~2023-07）
const w3 = await runWindow('①第三獨立窗（模型從未見過）', { days: 250, to: '2023-07-31' });
// ② 主窗
const main = await runWindow('②主窗（訊號發現窗·720日）', { days: 720 });
// ③ 逐年分段 + regime + 分層（用主窗+回填年合併的長窗）
const long = await runWindow('③長窗（4年·分段用）', { days: 940 });
const { uni, tri, avg, win } = long;
const nd = long.days.length;
console.log('\n【逐年分段】（每段約235日·各段獨立）');
const seg = Math.floor(nd / 4);
for (let q = 0; q < 4; q++) {
  const a = tri.filter(s => s.di >= q*seg && s.di < (q+1)*seg);
  const b = uni.filter(s => s.di >= q*seg && s.di < (q+1)*seg);
  const d0 = long.days[q*seg]?.date, d1 = long.days[Math.min((q+1)*seg, nd-1)]?.date;
  console.log(`  第${q+1}段 ${d0}~${d1}  n=${String(a.length).padStart(5)}  5日淨均 ${String(avg(a,x=>x.net5)).padStart(6)}%  淨勝 ${String(win(a,x=>x.net5)).padStart(5)}%  (基準 ${avg(b,x=>x.net5)}%)`);
}
console.log('\n【regime 分割】');
for (const [l,f] of [['多頭日',s=>s.bull===true],['空頭日',s=>s.bull===false]]) {
  const a=tri.filter(f), b=uni.filter(f);
  console.log(`  ${l}  n=${String(a.length).padStart(5)}  5日淨均 ${String(avg(a,x=>x.net5)).padStart(6)}%  淨勝 ${String(win(a,x=>x.net5)).padStart(5)}%  (基準 ${avg(b,x=>x.net5)}%)`);
}
console.log('\n【流動性/價格分層】（排除小型股假象）');
for (const [l,f] of [['量≥1000張',s=>s.v>=1000],['量≥3000張',s=>s.v>=3000],['價≥50元',s=>s.c>=50],['價<20元',s=>s.c<20]]) {
  const a=tri.filter(f);
  if(a.length<80){console.log(`  ${l.padEnd(10)} n=${a.length} 樣本不足`);continue;}
  const h=[0,1].map(hf=>avg(a.filter(x=>x.half===hf),x=>x.net5));
  console.log(`  ${l.padEnd(10)} n=${String(a.length).padStart(5)}  5日淨均 ${String(avg(a,x=>x.net5)).padStart(6)}%[${h[0]}/${h[1]}]  淨勝 ${String(win(a,x=>x.net5)).padStart(5)}%`);
}
console.log('\n【口徑歸屬】三重確認在各持有期的表現（決定進哪個模型）');
console.log(`  隔日開賣 ${avg(tri,x=>x.netOpen)}%  隔日收賣 ${avg(tri,x=>x.netClose)}%  5日 ${avg(tri,x=>x.net5)}%  ← 隔日≈0 者不可入隔日沖綜合評分`);
process.exit(0);
