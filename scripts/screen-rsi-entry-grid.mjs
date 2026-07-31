// ─────────────────────────────────────────────────────────────────────────
// 起漲點網格搜尋（2026-07-27 使用者提問）：RSI5/RSI10 區間 × 其他條件組合
// 目標＝找出「同時滿足才是起漲點」的組合。准入：兩半窗同向 ∧ 勝過基準 ∧ n≥300
// 指標：5日持有淨均/淨勝（扣費稅）、10日內曾漲≥5%、隔日淨開賣
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples } from './lib/bt-core.mjs';
const days = await loadDays({ days: 720 });
const samples = buildSamples(days);
const hist={};
for(let i=0;i<days.length;i++)for(const code in days[i].close){if(!/^\d{4}$/.test(code))continue;const c=days[i].close[code]?.[0];if(c>0)(hist[code]||=[]).push([i,c]);}
const rb={};
for(const code in hist){const a=hist[code];if(a.length<15)continue;let u5=0,d5=0,u10=0,d10=0;
 for(let k=1;k<a.length;k++){const ch=a[k][1]-a[k-1][1],g=Math.max(ch,0),l=Math.max(-ch,0);
  if(k<=5){u5+=g/5;d5+=l/5}else{u5=(u5*4+g)/5;d5=(d5*4+l)/5}
  if(k<=10){u10+=g/10;d10+=l/10}else{u10=(u10*9+g)/10;d10=(d10*9+l)/10}
  if(k>=10)rb[a[k][0]+'_'+code]={r5:u5+d5>0?u5/(u5+d5)*100:50,r10:u10+d10>0?u10/(u10+d10)*100:50};}}
for(const s of samples){const x=rb[s.di+'_'+s.code];if(x)Object.assign(s,x);
 if(s.r5!=null)s.spread=s.r5-s.r10;
 const it=days[s.di-1]?.inst?.[s.code]; s.instT1=it?(it[0]||0)+(it[1]||0):0;
 let mx10=-99; for(let k=1;k<=10;k++){const c=days[s.di+k]?.close?.[s.code]?.[0]; if(c>0){const r=(c-s.c)/s.c*100; if(r>mx10)mx10=r;}}
 s.mx10=mx10>-99?mx10:null;}
const uni=samples.filter(s=>s.tradable&&s.r5!=null&&s.net5!=null&&s.mx10!=null);
const avg=(a,f)=>a.length?+(a.reduce((t,x)=>t+f(x),0)/a.length).toFixed(2):0;
const pct=(a,f)=>a.length?+(a.filter(f).length/a.length*100).toFixed(1):0;
const B={n5:avg(uni,x=>x.net5),w5:pct(uni,x=>x.net5>0),m10:pct(uni,x=>x.mx10>=5),op:avg(uni,x=>x.netOpen)};
console.log(`宇宙 ${uni.length.toLocaleString()}·基準：5日淨均 ${B.n5}%／淨勝 ${B.w5}%／10日內漲≥5% ${B.m10}%\n`);
// RSI 區間候選
const ZONES = [
  ['使用者區 R5 50-75∧R10 50-70', s=>s.r5>=50&&s.r5<=75&&s.r10>=50&&s.r10<=70],
  ['中性 R5 40-60', s=>s.r5>=40&&s.r5<60],
  ['轉強 R5 55-75∧spread<0', s=>s.r5>=55&&s.r5<=75&&s.spread<0],
  ['低檔 R5<30', s=>s.r5<30],
  ['低檔 R5<20', s=>s.r5<20],
  ['強勢 R5 75-90∧spread<5', s=>s.r5>=75&&s.r5<90&&s.spread<5],
  ['無RSI限制(對照)', ()=>true],
];
// 疊加條件
const ADDS = [
  ['—(單獨)', ()=>true],
  ['×量比>1.5', s=>s.volX>1.5],
  ['×量比>2', s=>s.volX>2],
  ['×破20日高', s=>s.brk20],
  ['×強尾pos≥0.7', s=>s.pos>=0.7],
  ['×破高∧強尾', s=>s.brk20&&s.pos>=0.7],
  ['×法人t-1買超', s=>s.instT1>0],
  ['×法人5日/均量>0.05', s=>s.inst5Ratio>0.05],
  ['×空頭日', s=>s.bull===false],
  ['×多頭日', s=>s.bull===true],
  ['×距60日高<0.85', s=>s.posture60!=null&&s.posture60<0.85],
  ['×破高∧量比>1.5', s=>s.brk20&&s.volX>1.5],
  ['×破高∧強尾∧量比>1.5', s=>s.brk20&&s.pos>=0.7&&s.volX>1.5],
  ['×法人買∧量比>1.5', s=>s.instT1>0&&s.volX>1.5],
];
const pass=[];
for (const [zl,zc] of ZONES) {
  console.log(`── ${zl} ──`);
  const zone = uni.filter(zc);
  for (const [al,ac] of ADDS) {
    const sel = zone.filter(ac);
    if (sel.length < 300) { continue; }
    const n5=avg(sel,x=>x.net5), w5=pct(sel,x=>x.net5>0), m10=pct(sel,x=>x.mx10>=5), op=avg(sel,x=>x.netOpen);
    const h=[0,1].map(hf=>avg(sel.filter(x=>x.half===hf),x=>x.net5));
    const stable = Math.sign(h[0])===Math.sign(h[1]) && h[0]>B.n5 && h[1]>B.n5;
    const mark = stable && n5>0.3 ? ' ⭐⭐' : stable ? ' ⭐' : '';
    if (al==='—(單獨)' || stable || n5>0.3)
      console.log(`   ${al.padEnd(22)} n=${String(sel.length.toLocaleString()).padStart(7)}  5日淨均 ${String(n5).padStart(6)}%[${h[0]}/${h[1]}]  淨勝 ${String(w5).padStart(5)}%  10日漲≥5% ${String(m10).padStart(5)}%  開賣 ${String(op).padStart(6)}%${mark}`);
    if (stable && n5 > 0.3) pass.push({ zl, al, n: sel.length, n5, w5, m10, h });
  }
}
console.log(`\n══ 通過（兩窗同向∧皆勝基準∧5日淨均>0.3%）共 ${pass.length} 組 ══`);
pass.sort((a,b)=>b.n5-a.n5).slice(0,12).forEach(p=>console.log(`  ${p.zl} ${p.al}  n=${p.n.toLocaleString()}  5日 ${p.n5}%[${p.h[0]}/${p.h[1]}]  勝${p.w5}%  10日漲≥5% ${p.m10}%`));
process.exit(0);
