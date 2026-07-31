#!/usr/bin/env node
// 當沖比率變數過篩（bt-core 准入·僅上市有資料·當日收盤即知=PIT安全）
// 假說：當沖佔比高＝籌碼當日對沖洗清→隔日留倉慣性改變？方向讓資料說話。
import { loadDays, buildSamples, report } from './lib/bt-core.mjs';
const DAYS = +(process.argv.find(a => a.startsWith('--days='))?.split('=')[1] || 480);
const days = await loadDays({ days: DAYS });
const samples = buildSamples(days);
const cov = samples.filter(s => s.dtRatio != null).length;
console.log(`樣本 ${samples.length.toLocaleString()}·有當沖資料 ${cov.toLocaleString()}（${(cov / samples.length * 100).toFixed(0)}%·僅上市）`);

const passed = [];
passed.push(...report(samples, { title: '當沖佔比（沖銷張/當日量）', groups: [
  { label: '<5% 冷門', cond: s => s.dtRatio != null && s.dtRatio < 5 },
  { label: '5~15%', cond: s => s.dtRatio != null && s.dtRatio >= 5 && s.dtRatio < 15 },
  { label: '15~30%', cond: s => s.dtRatio != null && s.dtRatio >= 15 && s.dtRatio < 30 },
  { label: '30~45%', cond: s => s.dtRatio != null && s.dtRatio >= 30 && s.dtRatio < 45 },
  { label: '≥45% 沖仔主場', cond: s => s.dtRatio != null && s.dtRatio >= 45 },
] }));
passed.push(...report(samples, { title: '當沖佔比×強勢股（chg≥3·隔日沖候選區）', groups: [
  { label: '強勢∧沖比<15', cond: s => s.chg >= 3 && s.dtRatio != null && s.dtRatio < 15 },
  { label: '強勢∧沖比15~30', cond: s => s.chg >= 3 && s.dtRatio != null && s.dtRatio >= 15 && s.dtRatio < 30 },
  { label: '強勢∧沖比30~45', cond: s => s.chg >= 3 && s.dtRatio != null && s.dtRatio >= 30 && s.dtRatio < 45 },
  { label: '強勢∧沖比≥45', cond: s => s.chg >= 3 && s.dtRatio != null && s.dtRatio >= 45 },
] }));
passed.push(...report(samples, { title: '當沖佔比×定版撿尾盤濾網疊加', groups: [
  { label: '濾網∧沖比<15', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.dtRatio != null && s.dtRatio < 15 },
  { label: '濾網∧沖比15~30', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.dtRatio != null && s.dtRatio >= 15 && s.dtRatio < 30 },
  { label: '濾網∧沖比30~45', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.dtRatio != null && s.dtRatio >= 30 && s.dtRatio < 45 },
  { label: '濾網∧沖比≥45', cond: s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7 && s.dtRatio != null && s.dtRatio >= 45 },
] }));
console.log(`\n═══ 過關：${passed.length ? passed.map(p => `${p.title.split('（')[0]}·${p.label}`).join('；') : '無'} ═══`);
console.log('※ 過關者需再做日配對/重疊檢查才可入權重。非投資建議。');
process.exit(0);
