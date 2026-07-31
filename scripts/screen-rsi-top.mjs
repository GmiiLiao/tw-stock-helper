// ─────────────────────────────────────────────────────────────────────────
// RSI5>95∧RSI10>90「是否為真頂點」＋連續天數效應（2026-07-27 使用者提問）
// 真頂點定義：今日收盤 ≥ 未來 N 日所有收盤（N=5/10/20）
// 另測：最高點出現在第幾天分布、連續天數 streak 對頂點率/報酬的影響、
//      四種出場時機（訊號日賣 / 續抱N日 / 跌破RSI5<90才賣 / 死叉才賣）
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples } from './lib/bt-core.mjs';
const COST = 0.4425;
const days = await loadDays({ days: 720 });
const samples = buildSamples(days);
const hist = {};
for (let i=0;i<days.length;i++) for (const code in days[i].close) {
  if(!/^\d{4}$/.test(code))continue; const c=days[i].close[code]?.[0]; if(c>0)(hist[code]||=[]).push([i,c]); }
const rsiBy = {};   // di_code -> {r5,r10,streak}
for (const code in hist) { const a=hist[code]; if(a.length<15)continue;
  let u5=0,d5=0,u10=0,d10=0,streak=0;
  for(let k=1;k<a.length;k++){ const ch=a[k][1]-a[k-1][1],g=Math.max(ch,0),l=Math.max(-ch,0);
    if(k<=5){u5+=g/5;d5+=l/5}else{u5=(u5*4+g)/5;d5=(d5*4+l)/5}
    if(k<=10){u10+=g/10;d10+=l/10}else{u10=(u10*9+g)/10;d10=(d10*9+l)/10}
    const r5=u5+d5>0?u5/(u5+d5)*100:50, r10=u10+d10>0?u10/(u10+d10)*100:50;
    if(k>=10){ const on = r5>95&&r10>90; streak = on ? streak+1 : 0;
      rsiBy[a[k][0]+'_'+code]={r5,r10,streak}; } }
}
for (const s of samples) {
  const x = rsiBy[s.di+'_'+s.code]; if (x) Object.assign(s, x);
  // 未來 20 日收盤路徑
  const path=[]; for(let k=1;k<=20;k++){const c=days[s.di+k]?.close?.[s.code]?.[0]; path.push(c>0?(c-s.c)/s.c*100:null);}
  s.path = path;
  const val = k => path.slice(0,k).filter(v=>v!=null);
  s.mx5 = val(5).length?Math.max(...val(5)):null; s.mx10 = val(10).length?Math.max(...val(10)):null; s.mx20 = val(20).length?Math.max(...val(20)):null;
  s.mn5 = val(5).length?Math.min(...val(5)):null; s.mn10 = val(10).length?Math.min(...val(10)):null;
  s.argmax10 = val(10).length ? val(10).indexOf(Math.max(...val(10)))+1 : null;
}
const uni = samples.filter(s=>s.tradable&&s.r5!=null&&s.mx20!=null);
const sig = uni.filter(s=>s.r5>95&&s.r10>90);
const pct=(a,f)=>a.length?+(a.filter(f).length/a.length*100).toFixed(1):0;
const avg=(a,f)=>a.length?+(a.reduce((t,x)=>t+f(x),0)/a.length).toFixed(2):0;
console.log(`宇宙 ${uni.length.toLocaleString()}／訊號(RSI5>95∧RSI10>90) ${sig.length.toLocaleString()}\n`);
console.log('【1】真頂點率（今日收盤 ≥ 未來N日所有收盤）');
console.log(`  口徑          訊號     基準    倍數`);
for (const [l,f] of [['未來5日最高',s=>s.mx5<=0],['未來10日最高',s=>s.mx10<=0],['未來20日最高',s=>s.mx20<=0]]) {
  const a=pct(sig,f), b=pct(uni,f);
  console.log(`  ${l.padEnd(12)} ${String(a).padStart(5)}%  ${String(b).padStart(5)}%  ${(a/b).toFixed(2)}x`);
}
console.log('\n【2】未來10日最高點出現在第幾天（訊號日=第0天）');
const dist={};for(const s of sig){if(s.argmax10==null)continue; const k=s.mx10<=0?0:s.argmax10; dist[k]=(dist[k]||0)+1;}
const tot=Object.values(dist).reduce((a,b)=>a+b,0);
console.log('  第0天(即今日)  ' + `${(dist[0]/tot*100).toFixed(1)}%`);
for(let k=1;k<=10;k++) if(dist[k]) console.log(`  第${k}天${' '.repeat(k<10?9:8)}${(dist[k]/tot*100).toFixed(1)}%`);
console.log('\n【3】連續天數 streak 效應（第N天仍在訊號狀態）');
console.log('  streak   樣本   真頂點(5日)  隔日跌   5日淨均%  10日淨均%  5日內曾跌≥5%  5日內曾漲≥5%');
for (const [l,f] of [['第1天',s=>s.streak===1],['第2天',s=>s.streak===2],['第3天',s=>s.streak===3],['第4天',s=>s.streak===4],['第5天+',s=>s.streak>=5]]) {
  const sel=sig.filter(f); if(sel.length<50){console.log(`  ${l.padEnd(8)} n=${sel.length} 樣本不足`);continue;}
  const n10=sel.filter(s=>s.path[9]!=null);
  console.log(`  ${l.padEnd(8)} ${String(sel.length).padStart(5)}  ${String(pct(sel,s=>s.mx5<=0)).padStart(9)}%  ${String(pct(sel,s=>s.rNC<0)).padStart(5)}%  ${String(avg(sel,s=>s.net5)).padStart(8)}  ${String(avg(n10,s=>s.path[9]-COST)).padStart(8)}  ${String(pct(sel,s=>s.mn5<=-5)).padStart(11)}%  ${String(pct(sel,s=>s.mx5>=5)).padStart(11)}%`);
}
console.log('\n【4】出場時機比較（自訊號日起算·扣費稅淨報酬%·兩半窗）');
// 模擬：訊號日收盤持有→依規則賣出
const exitAt = (s, rule) => {
  if (rule==='d0') return 0;                      // 訊號日即賣（不持有）
  if (rule==='d1') return s.path[0];              // 抱1日
  if (rule==='d3') return s.path[2];
  if (rule==='d5') return s.path[4];
  if (rule==='d10') return s.path[9];
  if (rule==='break90'||rule==='death') {         // 跌破RSI5<90 / 死叉 才賣
    for(let k=1;k<=20;k++){
      const x = rsiBy[(s.di+k)+'_'+s.code]; if(!x) break;
      const hit = rule==='break90' ? x.r5<90 : (x.r5<x.r10);
      if(hit) return s.path[k-1];
    }
    return s.path[19];
  }
};
for (const [l,rule] of [['① 訊號日收盤即賣','d0'],['② 抱1日','d1'],['③ 抱3日','d3'],['④ 抱5日','d5'],['⑤ 抱10日','d10'],['⑥ 跌破RSI5<90才賣','break90'],['⑦ RSI死叉才賣','death']]) {
  const vals = sig.map(s=>({v:exitAt(s,rule),h:s.half})).filter(x=>x.v!=null);
  const net = x=>x.v-(rule==='d0'?0:COST);
  const h=[0,1].map(hf=>{const a=vals.filter(x=>x.h===hf); return a.length?+(a.reduce((t,x)=>t+net(x),0)/a.length).toFixed(2):null;});
  const all=+(vals.reduce((t,x)=>t+net(x),0)/vals.length).toFixed(2);
  const win=+(vals.filter(x=>net(x)>0).length/vals.length*100).toFixed(1);
  console.log(`  ${l.padEnd(18)} n=${String(vals.length).padStart(5)}  淨均 ${String(all).padStart(6)}%  淨勝 ${String(win).padStart(5)}%  兩窗[${h[0]}/${h[1]}]${h[0]!=null&&h[1]!=null&&Math.sign(h[0])===Math.sign(h[1])?'同向':'⚠換號'}`);
}
process.exit(0);
