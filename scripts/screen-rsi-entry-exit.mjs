// ─────────────────────────────────────────────────────────────────────────
// 使用者指定條件檢定（2026-07-27）：
//  起漲點候選 A：RSI5∈[50,75] ∧ RSI10∈[50,70]   B：RSI5−RSI10≥10   A∪B
//  出貨點候選 ：RSI5>95 ∧ RSI10>90
// 「起漲/出貨」無單一定義 → 多口徑並列（隔日/5日/10日·含扣費稅）
// 主窗 180 日（使用者指定），附 720 日穩定性對照。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples } from './lib/bt-core.mjs';

const WINDOWS = [[180, '180日(指定)'], [720, '720日(對照)']];
for (const [DAYS, WLABEL] of WINDOWS) {
  const days = await loadDays({ days: DAYS });
  const samples = buildSamples(days);
  // RSI + 未來 5/10 日極值（起漲/出貨口徑）
  const hist = {};
  for (let i = 0; i < days.length; i++) for (const code in days[i].close) {
    if (!/^\d{4}$/.test(code)) continue;
    const c = days[i].close[code]?.[0]; if (c > 0) (hist[code] ||= []).push([i, c]);
  }
  const bykey = {};
  for (const code in hist) { const a = hist[code]; if (a.length < 15) continue;
    let u5=0,d5=0,u10=0,d10=0;
    for (let k=1;k<a.length;k++){ const ch=a[k][1]-a[k-1][1],g=Math.max(ch,0),l=Math.max(-ch,0);
      if(k<=5){u5+=g/5;d5+=l/5}else{u5=(u5*4+g)/5;d5=(d5*4+l)/5}
      if(k<=10){u10+=g/10;d10+=l/10}else{u10=(u10*9+g)/10;d10=(d10*9+l)/10}
      if(k>=10) bykey[a[k][0]+'_'+code]={r5:u5+d5>0?u5/(u5+d5)*100:50,r10:u10+d10>0?u10/(u10+d10)*100:50};
    }
  }
  for (const s of samples) {
    const x = bykey[s.di+'_'+s.code]; if (x) Object.assign(s, x);
    // 未來 5/10 日收盤極值（相對今收 %）
    let mx5=-99,mn5=99,mx10=-99;
    for (let k=1;k<=10;k++){ const c=days[s.di+k]?.close?.[s.code]?.[0]; if(!(c>0))continue;
      const r=(c-s.c)/s.c*100;
      if(k<=5){ if(r>mx5)mx5=r; if(r<mn5)mn5=r; }
      if(r>mx10)mx10=r; }
    if(mx5>-99){ s.fwdMax5=mx5; s.fwdMin5=mn5; s.fwdMax10=mx10; }
  }
  const uni = samples.filter(s => s.tradable && s.r5 != null && s.fwdMax5 != null && s.net5 != null);
  const pct = (a, f) => a.length ? +(a.filter(f).length / a.length * 100).toFixed(1) : 0;
  const avg = (a, f) => a.length ? +(a.reduce((t,x)=>t+f(x),0)/a.length).toFixed(2) : 0;
  const base = uni;
  console.log(`\n══════ ${WLABEL}：可交易樣本 ${uni.length.toLocaleString()} ══════`);

  const ENTRY = [
    ['A RSI5 50~75∧RSI10 50~70', s => s.r5>=50&&s.r5<=75&&s.r10>=50&&s.r10<=70],
    ['B RSI5−RSI10≥10', s => s.r5-s.r10>=10],
    ['A∪B（使用者條件）', s => (s.r5>=50&&s.r5<=75&&s.r10>=50&&s.r10<=70)||(s.r5-s.r10>=10)],
    ['A∩B', s => s.r5>=50&&s.r5<=75&&s.r10>=50&&s.r10<=70&&s.r5-s.r10>=10],
    ['【基準】全宇宙', () => true],
  ];
  console.log('\n〔起漲點檢定〕各口徑「機率」：');
  console.log('  條件                        樣本數   隔日漲   5日內曾漲≥5%  ≥10%   5日淨勝(扣費稅)  5日淨均%  兩窗一致');
  for (const [label, cond] of ENTRY) {
    const sel = base.filter(cond); if (sel.length < 200) { console.log(`  ${label.padEnd(26)} n=${sel.length} 樣本不足`); continue; }
    const h = [0,1].map(hf => pct(sel.filter(x=>x.half===hf), x=>x.net5>0));
    const bAll = pct(base, x=>x.net5>0);
    const ok = h[0]>bAll && h[1]>bAll ? '⭐' : '';
    console.log(`  ${label.padEnd(26)} ${String(sel.length.toLocaleString()).padStart(7)}  ${String(pct(sel,x=>x.rNC>0)).padStart(5)}%  ${String(pct(sel,x=>x.fwdMax5>=5)).padStart(8)}%  ${String(pct(sel,x=>x.fwdMax5>=10)).padStart(5)}%  ${String(pct(sel,x=>x.net5>0)).padStart(8)}%  ${String(avg(sel,x=>x.net5)).padStart(8)}  ${ok}`);
  }
  const EXIT = [
    ['RSI5>95 ∧ RSI10>90（使用者條件）', s => s.r5>95&&s.r10>90],
    ['RSI5≥90 ∧ RSI10≥90', s => s.r5>=90&&s.r10>=90],
    ['RSI5≥95（單）', s => s.r5>=95],
    ['【基準】全宇宙', () => true],
  ];
  console.log('\n〔出貨點檢定〕各口徑「機率」：');
  console.log('  條件                        樣本數   隔日跌   5日後仍跌  今日即5日高點  5日內曾跌≥5%  5日淨均%  10日內再漲≥5%');
  for (const [label, cond] of EXIT) {
    const sel = base.filter(cond); if (sel.length < 100) { console.log(`  ${label.padEnd(26)} n=${sel.length} 樣本不足`); continue; }
    console.log(`  ${label.padEnd(26)} ${String(sel.length.toLocaleString()).padStart(7)}  ${String(pct(sel,x=>x.rNC<0)).padStart(5)}%  ${String(pct(sel,x=>x.net5<0)).padStart(7)}%  ${String(pct(sel,x=>x.fwdMax5<=0)).padStart(11)}%  ${String(pct(sel,x=>x.fwdMin5<=-5)).padStart(10)}%  ${String(avg(sel,x=>x.net5)).padStart(8)}  ${String(pct(sel,x=>x.fwdMax10>=5)).padStart(12)}%`);
  }
}
process.exit(0);
