// ─────────────────────────────────────────────────────────────────────────
// RSI(5)×RSI(10) 雙參數完整檢定（2026-07-27 重測·補前次濾網測試單參數缺口）
// 新增前次未測的核心維度：價差 spread=RSI5-RSI10（短線相對長線的加速度）——
// 這是雙參數獨有、任一單參數無法表達的資訊。
// A 二維漲停率曲面  B spread 分桶（控制RSI5水位）  C 雙參數濾網 walk-forward
// D 增量重測（加入 spread 第三特徵）  E 冗餘度（RSI5/RSI10/spread 各自）
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples } from './lib/bt-core.mjs';

const days = await loadDays({ days: 720 });
const samples = buildSamples(days);
const tickOf = p => p<10?0.01:p<50?0.05:p<100?0.1:p<500?0.5:p<1000?1:5;
const isLU = (c,pc) => { if(!(pc>0))return false; const raw=pc*1.1,t=tickOf(raw); return c>=Math.floor(raw/t+1e-9)*t-1e-6; };
const luSets=[null];
for(let i=1;i<days.length;i++){const s=new Set();for(const c in days[i].close){const p=days[i-1].close?.[c]?.[0];if(p&&isLU(days[i].close[c][0],p))s.add(c);}luSets.push(s);}
const hist={};
for(let i=0;i<days.length;i++)for(const code in days[i].close){if(!/^\d{4}$/.test(code))continue;const c=days[i].close[code]?.[0];if(c>0)(hist[code]||=[]).push([i,c]);}
const bykey={};
for(const code in hist){const a=hist[code];if(a.length<25)continue;let u5=0,d5=0,u10=0,d10=0;
 for(let k=1;k<a.length;k++){const ch=a[k][1]-a[k-1][1],g=Math.max(ch,0),l=Math.max(-ch,0);
  if(k<=5){u5+=g/5;d5+=l/5}else{u5=(u5*4+g)/5;d5=(d5*4+l)/5}
  if(k<=10){u10+=g/10;d10+=l/10}else{u10=(u10*9+g)/10;d10=(d10*9+l)/10}
  if(k>=20)bykey[a[k][0]+'_'+code]={r5:u5+d5>0?u5/(u5+d5)*100:50,r10:u10+d10>0?u10/(u10+d10)*100:50,ret20:a[k-20]?(a[k][1]-a[k-20][1])/a[k-20][1]*100:null};}}
for(const s of samples){const x=bykey[s.di+'_'+s.code];if(x)Object.assign(s,x);
 if(s.r5!=null)s.spread=+(s.r5-s.r10).toFixed(1);
 let lu5=0;for(let k=s.di-4;k<=s.di;k++)if(luSets[k]?.has(s.code))lu5++;s.luCnt5=lu5;
 const it=days[s.di-1]?.inst?.[s.code];s.fShare=it&&s.v>0?(it[0]||0)/s.v*100:0;s.t0=it?(it[1]||0):0;
 s.nearHi=s.hi20>0?(s.c/s.hi20-1)*100:null;s.LU=s.rNC>=9.3;}
const uni=samples.filter(s=>s.tradable&&s.r5!=null&&s.ret20!=null&&s.nearHi!=null);
const rate=a=>a.length?a.filter(x=>x.LU).length/a.length*100:0;
const base=rate(uni);
console.log(`可交易宇宙 n=${uni.length.toLocaleString()}·基準漲停率 ${base.toFixed(2)}%`);

// ── A 二維曲面 ──
console.log('\n【A】RSI5×RSI10 二維漲停率曲面（%·括號n·—=樣本<200）');
const B5=[[0,20],[20,40],[40,60],[60,75],[75,85],[85,95],[95,101]];
const B10=[[0,20],[20,40],[40,60],[60,75],[75,85],[85,101]];
console.log('  RSI5\\RSI10  ' + B10.map(([a,b])=>`${a}-${b>100?'100':b}`.padStart(11)).join(''));
for(const [a5,b5] of B5){
  const cells=B10.map(([a10,b10])=>{
    const sel=uni.filter(s=>s.r5>=a5&&s.r5<b5&&s.r10>=a10&&s.r10<b10);
    return sel.length<200?'—'.padStart(11):`${rate(sel).toFixed(2)}(${(sel.length/1000).toFixed(0)}k)`.padStart(11);
  });
  console.log(`  ${(a5+'-'+(b5>100?'100':b5)).padEnd(12)}` + cells.join(''));
}
// ── B spread 分桶（控制 RSI5 水位）──
console.log('\n【B】spread=RSI5−RSI10 分桶（加速度·前次完全未測）');
const SP=[['≤-15',s=>s.spread<=-15],['-15~-5',s=>s.spread>-15&&s.spread<=-5],['-5~+5',s=>s.spread>-5&&s.spread<5],['+5~+15',s=>s.spread>=5&&s.spread<15],['+15~+25',s=>s.spread>=15&&s.spread<25],['≥+25',s=>s.spread>=25]];
const line=(l,sel)=>{ if(sel.length<200){console.log(`    ${l.padEnd(10)} n=${sel.length} 不足`);return;}
  const h=[0,1].map(hf=>rate(sel.filter(x=>x.half===hf)));
  const ok=h[0]>base&&h[1]>base;
  console.log(`    ${l.padEnd(10)} n=${String(sel.length.toLocaleString()).padStart(7)}  ${rate(sel).toFixed(2)}%  ${(rate(sel)/base).toFixed(2)}x  [${h[0].toFixed(2)}/${h[1].toFixed(2)}]${ok?' ⭐兩窗勝':''}`);};
console.log('  全體：');
for(const [l,c] of SP) line(l, uni.filter(c));
for(const [lvl,cond] of [['RSI5 60~85 內',s=>s.r5>=60&&s.r5<85],['RSI5 ≥85 內',s=>s.r5>=85]]){
  console.log(`  控制水位—${lvl}：`);
  for(const [l,c] of SP) line(l, uni.filter(cond).filter(c));
}
// ── C/D walk-forward ──
const mid=Math.floor(days.length/2);
const train=uni.filter(s=>s.di<mid), test=uni.filter(s=>s.di>=mid);
const L={chg0:[[v=>v<0,0.68],[v=>v<3,0.59],[v=>v<7,1.66],[()=>true,2.62]],ret5:[[v=>v<-3,0.77],[v=>v<3,0.46],[v=>v<10,1.16],[()=>true,3.29]],ret20:[[v=>v<0,0.47],[v=>v<10,0.64],[v=>v<25,1.54],[()=>true,3.13]],volX:[[v=>v<1,0.75],[v=>v<2,1.05],[v=>v<4,2.03],[()=>true,2.68]],nearHi:[[v=>v<-10,1.01],[v=>v<-2,0.63],[v=>v<0,0.73],[()=>true,2.48]],luCnt5:[[v=>v===0,0.63],[v=>v===1,2.81],[()=>true,4.76]],fShare:[[v=>v<0,0.90],[v=>v<5,1.35],[v=>v<15,1.32],[()=>true,0.86]],t0:[[v=>v<=0,0.91],[()=>true,1.76]]};
const lf=(t,v)=>{for(const[p,x]of t)if(p(v))return x;return 1;};
const sc=s=>Math.log2(lf(L.chg0,s.chg))+Math.log2(lf(L.ret5,s.ret5))+Math.log2(lf(L.ret20,s.ret20))+Math.log2(lf(L.volX,s.volX))+Math.log2(lf(L.nearHi,s.nearHi))+Math.log2(lf(L.luCnt5,s.luCnt5))+Math.log2(lf(L.fShare,s.fShare))+Math.log2(lf(L.t0,s.t0));
const byDay={};for(const s of test)(byDay[s.di]||=[]).push(s);
const tRate=rate(test);
const topN=(N,filt,scorer)=>{let hit=0,tot=0;for(const di in byDay){const arr=byDay[di];if(arr.length<100)continue;
 const pool=filt?arr.filter(filt):arr; if(pool.length<N)continue;
 const top=[...pool].sort((a,b)=>(scorer||sc)(b)-(scorer||sc)(a)).slice(0,N);
 hit+=top.filter(s=>s.LU).length;tot+=top.length;}return {pct:tot?+(hit/tot*100).toFixed(2):0,hit,tot};};
console.log(`\n【C】雙參數濾網重測（驗證窗基準 ${tRate.toFixed(2)}%·Top-N 由現行模型分數排序）`);
for(const [l,f] of [
 ['無濾網(對照)',null],
 ['雙RSI≥70(都強)',s=>s.r5>=70&&s.r10>=70],
 ['RSI5≥70∧RSI10<70(剛啟動)',s=>s.r5>=70&&s.r10<70],
 ['RSI5≥85∧RSI10<75(急拉)',s=>s.r5>=85&&s.r10<75],
 ['spread>0(短線轉強)',s=>s.spread>0],
 ['spread≥+10(加速)',s=>s.spread>=10],
 ['spread≥+20(強加速)',s=>s.spread>=20],
 ['排除 spread<0(減速)',s=>s.spread>=0],
 ['雙RSI 40~75(溫和區)',s=>s.r5>=40&&s.r5<75&&s.r10>=40&&s.r10<75],
]){ const t10=topN(10,f),t30=topN(30,f);
 console.log(`  ${l.padEnd(26)} Top10 ${String(t10.pct).padStart(5)}%(${t10.hit}/${t10.tot})  Top30 ${String(t30.pct).padStart(5)}%`);}
// D 增量：加入 spread 第三特徵（訓練窗學 lift）
const SPB=[['≤-10',s=>s.spread<=-10],['-10~0',s=>s.spread<0],['0~10',s=>s.spread<10],['10~20',s=>s.spread<20],['≥20',()=>true]];
const R5B=[['<20',s=>s.r5<20],['20~50',s=>s.r5<50],['50~70',s=>s.r5<70],['70~85',s=>s.r5<85],['85~95',s=>s.r5<95],['≥95',()=>true]];
const R10B=[['<30',s=>s.r10<30],['30~60',s=>s.r10<60],['60~80',s=>s.r10<80],['80~90',s=>s.r10<90],['≥90',()=>true]];
const lifts=b=>{const bs=rate(train)/100;return b.map(([lab,p],i)=>{const sel=train.filter(s=>b.findIndex(([,q])=>q(s))===i);return [lab,+(sel.length>=200?(rate(sel)/100)/bs:1).toFixed(2)];});};
const LS=lifts(SPB), L5=lifts(R5B), L10=lifts(R10B);
console.log(`\n【D】增量重測（訓練窗 spread lift：${LS.map(x=>x[0]+':'+x[1]+'x').join(' ')}）`);
const idx=(b,s)=>b.findIndex(([,p])=>p(s));
const rsiSc=(s,d)=>d*(Math.log2(L5[idx(R5B,s)][1])+Math.log2(L10[idx(R10B,s)][1]));
const spSc=(s,d)=>d*Math.log2(LS[idx(SPB,s)][1]);
for(const [l,scorer] of [
 ['現行因子(對照)',sc],
 ['＋spread(0.3)',s=>sc(s)+spSc(s,0.3)],
 ['＋spread(0.6)',s=>sc(s)+spSc(s,0.6)],
 ['＋RSI雙桶＋spread(各0.3)',s=>sc(s)+rsiSc(s,0.3)+spSc(s,0.3)],
 ['＋RSI雙桶＋spread(各0.6)',s=>sc(s)+rsiSc(s,0.6)+spSc(s,0.6)],
]){ const t10=topN(10,null,scorer),t30=topN(30,null,scorer);
 console.log(`  ${l.padEnd(24)} Top10 ${String(t10.pct).padStart(5)}%(${t10.hit})  Top30 ${String(t30.pct).padStart(5)}%`);}
// E 冗餘度
console.log('\n【E】冗餘度（同日內排名 Spearman vs 現行模型分數）');
for(const [l,key] of [['RSI5',s=>s.r5],['RSI10',s=>s.r10],['spread',s=>s.spread]]){
 let sum=0,cnt=0;
 for(const di in byDay){const arr=byDay[di];if(arr.length<200)continue;
  const a=[...arr].sort((x,y)=>sc(x)-sc(y)); const b=[...arr].sort((x,y)=>key(x)-key(y));
  const rk=new Map(b.map((s,i)=>[s,i])); let d2=0; const n=a.length;
  a.forEach((s,i)=>{const j=rk.get(s);d2+=(i-j)*(i-j);});
  sum+=1-6*d2/(n*(n*n-1)); cnt++;}
 console.log(`  ${l.padEnd(8)} ${(sum/cnt).toFixed(3)}`);}
process.exit(0);
