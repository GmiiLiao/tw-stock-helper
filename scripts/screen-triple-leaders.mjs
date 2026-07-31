// ─────────────────────────────────────────────────────────────────────────
// 三重確認 × 話題龍頭股 檢定（2026-07-27 使用者提問）
// 「話題龍頭」PIT安全定義：每日取「近5日漲停板數前3名族群」內的產業龍頭
//   （龍頭清單=build-leaders.mjs 依成交值選出的65檔·慢變數），日取前20檔。
// 三段檢定：A 240日×20檔(使用者指定·檢查樣本量) B 720日同定義(補樣本)
//          C 統計力最強版：全市場三重確認樣本內比較「龍頭/話題股 vs 其他」
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples, COST } from './lib/bt-core.mjs';
import { readFileSync } from 'node:fs';
const LEAD = JSON.parse(readFileSync(new URL('./data/industry-leaders.json', import.meta.url), 'utf8')).leaders;
const leadSet = new Set(LEAD.map(l => l.code));
const leadInd = Object.fromEntries(LEAD.map(l => [l.code, l.industry]));

const days = await loadDays({ days: 720 });
const samples = buildSamples(days);
// 產業對照（全市場·用於族群熱度）
const indMap = {};
for (const ep of ['t187ap03_L', 't187ap03_O']) {
  for (let t = 0; t < 3; t++) {
    try { const r = await fetch(`https://openapi.twse.com.tw/v1/opendata/${ep}`, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
      const txt = await r.text(); if (!txt.startsWith('[')) { await new Promise(s=>setTimeout(s,3000)); continue; }
      for (const x of JSON.parse(txt)) { const c=(x['公司代號']||'').trim(), i=(x['產業別']||'').trim(); if(/^\d{4}$/.test(c)&&i) indMap[c]=i; }
      break; } catch { await new Promise(s=>setTimeout(s,3000)); }
  }
}
console.log(`產業對照 ${Object.keys(indMap).length} 檔·龍頭 ${LEAD.length} 檔`);
// 漲停集合 → 每日熱門族群Top3（PIT：只用 ≤t）
const tick=p=>p<10?0.01:p<50?0.05:p<100?0.1:p<500?0.5:p<1000?1:5;
const isLU=(c,pc)=>{if(!(pc>0))return false;const raw=pc*1.1,t=tick(raw);return c>=Math.floor(raw/t+1e-9)*t-1e-6;};
const luSets=[null];
for(let i=1;i<days.length;i++){const s=new Set();for(const c in days[i].close){const p=days[i-1].close?.[c]?.[0];if(p&&isLU(days[i].close[c][0],p))s.add(c);}luSets.push(s);}
const hotByDi={};
for(let i=5;i<days.length;i++){const cnt={};
  for(let k=i-4;k<=i;k++)for(const c of (luSets[k]||[])){const ind=indMap[c];if(ind)cnt[ind]=(cnt[ind]||0)+1;}
  hotByDi[i]=new Set(Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,3).filter(([,n])=>n>=5).map(([k])=>k));}
// RSI + 法人
const hist={};
for(let i=0;i<days.length;i++)for(const code in days[i].close){if(!/^\d{4}$/.test(code))continue;const c=days[i].close[code]?.[0];if(c>0)(hist[code]||=[]).push([i,c]);}
const rb={};
for(const code in hist){const a=hist[code];if(a.length<15)continue;let u5=0,d5=0,u10=0,d10=0;
 for(let k=1;k<a.length;k++){const ch=a[k][1]-a[k-1][1],g=Math.max(ch,0),l=Math.max(-ch,0);
  if(k<=5){u5+=g/5;d5+=l/5}else{u5=(u5*4+g)/5;d5=(d5*4+l)/5}
  if(k<=10){u10+=g/10;d10+=l/10}else{u10=(u10*9+g)/10;d10=(d10*9+l)/10}
  if(k>=10)rb[a[k][0]+'_'+code]={r5:u5+d5>0?u5/(u5+d5)*100:50,r10:u10+d10>0?u10/(u10+d10)*100:50};}}
for(const s of samples){const x=rb[s.di+'_'+s.code];if(x)Object.assign(s,x);
 const it=days[s.di-1]?.inst?.[s.code]; s.instPrev=it?(it[0]||0)+(it[1]||0):null;
 s.isLead=leadSet.has(s.code);
 s.isTopicLead=s.isLead && (hotByDi[s.di]?.has(indMap[s.code]) || false);
 s.isTopic=hotByDi[s.di]?.has(indMap[s.code]) || false;
 s.triple = s.r5!=null && s.r5<20 && s.instPrev>0 && s.volX>1.5;}
const uni=samples.filter(s=>s.tradable&&s.r5!=null&&s.net5!=null);
const nDays=days.length;
const avg=(a,f)=>a.length?+(a.reduce((t,x)=>t+f(x),0)/a.length).toFixed(2):null;
const win=(a,f)=>a.length?+(a.filter(x=>f(x)>0).length/a.length*100).toFixed(1):null;
const show=(l,sel,minN=100)=>{
  if(sel.length<minN){console.log(`  ${l.padEnd(30)} n=${sel.length} ⚠樣本不足（<${minN}）`);return;}
  const h=[0,1].map(hf=>avg(sel.filter(x=>x.half===hf),x=>x.net5));
  const ok=h[0]!=null&&h[1]!=null&&h[0]>0&&h[1]>0;
  console.log(`  ${l.padEnd(30)} n=${String(sel.length.toLocaleString()).padStart(6)}  5日淨均 ${String(avg(sel,x=>x.net5)).padStart(6)}%[${h[0]}/${h[1]}]  淨勝 ${String(win(sel,x=>x.net5)).padStart(5)}%${ok?' ⭐':''}`);
};
// A：240日 × 話題龍頭（每日至多20檔）
const cut = days.length - 240;
const uni240 = uni.filter(s=>s.di>=cut).map(s=>({...s, half: s.di < cut+120 ? 0 : 1}));
console.log(`\n【A】使用者指定：240日 × 話題龍頭（每日Top3熱門族群內的龍頭）`);
const tl240 = uni240.filter(s=>s.isTopicLead);
console.log(`  話題龍頭池：${tl240.length.toLocaleString()} 檔日（日均 ${(tl240.length/240).toFixed(1)} 檔）`);
show('　池內三重確認', tl240.filter(s=>s.triple), 30);
show('　池內全部（對照）', tl240, 30);
show('　全市場三重確認(240日)', uni240.filter(s=>s.triple), 30);
show('　全市場基準(240日)', uni240, 30);
console.log(`\n【B】720日同定義（補樣本量）`);
const tlAll = uni.filter(s=>s.isTopicLead);
console.log(`  話題龍頭池：${tlAll.length.toLocaleString()} 檔日（日均 ${(tlAll.length/nDays).toFixed(1)} 檔）`);
show('　池內三重確認', tlAll.filter(s=>s.triple), 30);
show('　池內全部（對照）', tlAll);
console.log(`\n【C】統計力最強：全市場三重確認樣本內，龍頭/話題身分是否加分？`);
const tri = uni.filter(s=>s.triple);
show('三重確認（全體）', tri);
show('　∧產業龍頭', tri.filter(s=>s.isLead), 30);
show('　∧非龍頭', tri.filter(s=>!s.isLead));
show('　∧話題族群(不限龍頭)', tri.filter(s=>s.isTopic));
show('　∧非話題族群', tri.filter(s=>!s.isTopic));
show('　∧話題龍頭', tri.filter(s=>s.isTopicLead), 30);
console.log(`\n【D】對照：龍頭/話題身分單獨（不加三重確認）`);
show('產業龍頭（全體）', uni.filter(s=>s.isLead));
show('話題族群（全體）', uni.filter(s=>s.isTopic));
show('全市場基準', uni);
process.exit(0);
