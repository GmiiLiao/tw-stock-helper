#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 變數過篩批次1（統一回測平台 bt-core 准入）：
//   ①上影線比率 ②連漲天數 ③5日累計漲幅 ④60日位階 ⑤融資水位 ⑥融券水位 ⑦借券水位
// 判準（bt-core 內建）：兩半窗 delta 同號且皆≥0.05pp 才 ✅；✅者加驗 regime 同向。
// 過關者=model-core 候補（仍需第二輪獨立驗證才入權重）。非投資建議。
// 用法：node scripts/screen-variables.mjs [--days=480]
// ─────────────────────────────────────────────────────────────────────────

import { loadDays, buildSamples, report } from './lib/bt-core.mjs';

const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);

const days = await loadDays({ days: DAYS });
console.log(`交易日 ${days.length}（${days[0]?.date} → ${days[days.length - 1]?.date}）`);
const samples = buildSamples(days);
console.log(`樣本 ${samples.length.toLocaleString()}（全市場·量≥300張·61日暖身）`);

const passed = [];

passed.push(...report(samples, { title: '① 上影線比率（尾盤拉高被打回程度）', groups: [
  { label: '無上影(≤0.02)', cond: s => s.uShadow <= 0.02 },
  { label: '短上影 0.02~0.1', cond: s => s.uShadow > 0.02 && s.uShadow <= 0.1 },
  { label: '中上影 0.1~0.3', cond: s => s.uShadow > 0.1 && s.uShadow <= 0.3 },
  { label: '長上影 0.3~0.5', cond: s => s.uShadow > 0.3 && s.uShadow <= 0.5 },
  { label: '極長上影 >0.5', cond: s => s.uShadow > 0.5 },
] }));

passed.push(...report(samples, { title: '② 連漲天數（含當日）', groups: [
  { label: '0（今日未漲）', cond: s => s.upStreak === 0 },
  { label: '1', cond: s => s.upStreak === 1 },
  { label: '2', cond: s => s.upStreak === 2 },
  { label: '3', cond: s => s.upStreak === 3 },
  { label: '≥4', cond: s => s.upStreak >= 4 },
] }));

passed.push(...report(samples, { title: '③ 5日累計漲幅', groups: [
  { label: '<-5%', cond: s => s.ret5 != null && s.ret5 < -5 },
  { label: '-5~0%', cond: s => s.ret5 != null && s.ret5 >= -5 && s.ret5 < 0 },
  { label: '0~5%', cond: s => s.ret5 != null && s.ret5 >= 0 && s.ret5 < 5 },
  { label: '5~10%', cond: s => s.ret5 != null && s.ret5 >= 5 && s.ret5 < 10 },
  { label: '10~20%', cond: s => s.ret5 != null && s.ret5 >= 10 && s.ret5 < 20 },
  { label: '≥20%', cond: s => s.ret5 != null && s.ret5 >= 20 },
] }));

passed.push(...report(samples, { title: '④ 60日位階（現價/60日高）', groups: [
  { label: '<0.8 深回檔', cond: s => s.posture60 != null && s.posture60 < 0.8 },
  { label: '0.8~0.9', cond: s => s.posture60 != null && s.posture60 >= 0.8 && s.posture60 < 0.9 },
  { label: '0.9~0.97', cond: s => s.posture60 != null && s.posture60 >= 0.9 && s.posture60 < 0.97 },
  { label: '0.97~1 貼高', cond: s => s.posture60 != null && s.posture60 >= 0.97 && s.posture60 < 1 },
  { label: '≥1 創60日高', cond: s => s.posture60 != null && s.posture60 >= 1 },
] }));

passed.push(...report(samples, { title: '⑤ 融資水位（資餘/20日均量·回補天數概念）', groups: [
  { label: '<1', cond: s => s.mgLevel != null && s.mgLevel < 1 },
  { label: '1~3', cond: s => s.mgLevel != null && s.mgLevel >= 1 && s.mgLevel < 3 },
  { label: '3~6', cond: s => s.mgLevel != null && s.mgLevel >= 3 && s.mgLevel < 6 },
  { label: '6~12', cond: s => s.mgLevel != null && s.mgLevel >= 6 && s.mgLevel < 12 },
  { label: '≥12 重倉', cond: s => s.mgLevel != null && s.mgLevel >= 12 },
] }));

passed.push(...report(samples, { title: '⑥ 融券水位（券餘/20日均量）', groups: [
  { label: '≈0 (<0.05)', cond: s => s.shLevel != null && s.shLevel < 0.05 },
  { label: '0.05~0.3', cond: s => s.shLevel != null && s.shLevel >= 0.05 && s.shLevel < 0.3 },
  { label: '0.3~1', cond: s => s.shLevel != null && s.shLevel >= 0.3 && s.shLevel < 1 },
  { label: '≥1 高券壓', cond: s => s.shLevel != null && s.shLevel >= 1 },
] }));

passed.push(...report(samples, { title: '⑦ 借券水位（借券餘/20日均量·僅~185日覆蓋⚠期別偏差）', groups: [
  { label: '<1', cond: s => s.lnLevel != null && s.lnLevel < 1 },
  { label: '1~5', cond: s => s.lnLevel != null && s.lnLevel >= 1 && s.lnLevel < 5 },
  { label: '5~15', cond: s => s.lnLevel != null && s.lnLevel >= 5 && s.lnLevel < 15 },
  { label: '≥15', cond: s => s.lnLevel != null && s.lnLevel >= 15 },
] }));

console.log(`\n═══ 過關（兩窗同向·|Δ|≥0.05pp）：${passed.length ? passed.map(p => `${p.title.split('（')[0]}·${p.label}`).join('；') : '無'} ═══`);
console.log('※ 過關≠入權重：仍需檢查與既有因子的重疊（條件於現行濾網/評分下的增量），並以獨立窗二次驗證。非投資建議。');
process.exit(0);
