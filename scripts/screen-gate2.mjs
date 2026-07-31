#!/usr/bin/env node
// 三關法第二關「自己強 vs 跟風漲」的日線代理檢定（隔日沖語意·bt-core 准入）
// RS = 個股漲幅 − 市場等權均漲幅（當日收盤即知·PIT 安全）
import { loadDays, buildSamples, report } from './lib/bt-core.mjs';
const days = await loadDays({ days: 700 });
const samples = buildSamples(days);
// 每日市場等權均漲幅
const mkt = {};
{ const acc = {}; for (const s of samples) (acc[s.di] ||= []).push(s.chg);
  for (const di in acc) mkt[di] = acc[di].reduce((t, v) => t + v, 0) / acc[di].length; }
for (const s of samples) { s.mkt = mkt[s.di]; s.rs = s.chg - mkt[s.di]; }
console.log(`樣本 ${samples.length.toLocaleString()}`);

report(samples, { title: '第二關代理：今日強勢股(chg≥3)的相對強度分型', groups: [
  { label: '自己強:chg≥3∧大盤跌', cond: s => s.chg >= 3 && s.mkt <= -0.3 },
  { label: '自己強:chg≥3∧大盤平', cond: s => s.chg >= 3 && s.mkt > -0.3 && s.mkt < 0.3 },
  { label: '跟風:chg≥3∧大盤大漲', cond: s => s.chg >= 3 && s.mkt >= 1 },
  { label: 'RS≥5(超額強)', cond: s => s.chg >= 3 && s.rs >= 5 },
  { label: 'RS<1(純跟風)', cond: s => s.chg >= 3 && s.rs < 1 },
] });
report(samples, { title: '第二關×現行定版濾網（破20日高×強尾×3~7）疊加', groups: [
  { label: '定版濾網全體', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 },
  { label: '∧ 大盤跌(自己強)', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.mkt <= -0.3 },
  { label: '∧ 大盤平', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.mkt > -0.3 && s.mkt < 0.3 },
  { label: '∧ 大盤大漲(跟風?)', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.mkt >= 1 },
] });
process.exit(0);
