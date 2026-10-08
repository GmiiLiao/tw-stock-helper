// 推論信心上限（程式強制）單元測試：node --test scripts/lib/news-inference-cap.test.mjs
//   2026-10-08 X2（jev-score-usage-spec 附錄 B；plan B2-4 h；新聞技能 §3.2、§3B.10 第 1 點）：
//   「連動」以「推論」開頭 ⇒ 信心最高「低」，AI 原值留在 aiOriginal.confidence。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInferenceChain, inferenceCapFields, INFERENCE_CONF_MAX } from './news-inference-cap.mjs';

test('推論判定：連動欄以「推論」開頭（全形／半形冒號、前導空白或引號都算）', () => {
  for (const s of ['推論：油價→塑化成本', '推論:記憶體報價→封測', '  推論：x', '「推論：x」', '推論 x']) assert.equal(isInferenceChain(s), true, s);
  for (const s of [null, undefined, '', '無', '油價上漲推論塑化承壓', '記憶體報價 → 封測']) assert.equal(isInferenceChain(s), false, String(s));
});

test('推論＋信心「中」⇒ 夾成「低」，aiOriginal 留原值、標 confCap', () => {
  const f = inferenceCapFields({ label: '利多', confidence: '中', chain: '推論：AI 需求→本檔' });
  assert.equal(INFERENCE_CONF_MAX, '低');
  assert.equal(f.confidence, '低');
  assert.equal(f.confCap, 'inference');
  assert.equal(f.inference, true);
  assert.deepEqual(f.aiOriginal, { confidence: '中' });
});

test('推論＋信心「高」⇒ 夾成「低」；既有規則類 aiOriginal（label、reason）合併保留，不覆寫', () => {
  const v = { label: '利空', confidence: '高', chain: '推論：x', aiOriginal: { label: '中性', reason: '公司聲明營運正常' } };
  const f = inferenceCapFields(v);
  assert.equal(f.confidence, '低');
  assert.deepEqual(f.aiOriginal, { label: '中性', reason: '公司聲明營運正常', confidence: '高' });
  assert.deepEqual(v.aiOriginal, { label: '中性', reason: '公司聲明營運正常' }, '不改動輸入（不可變）');
});

test('推論但已是「低」⇒ 只標 inference，不動信心、不寫 aiOriginal', () => {
  assert.deepEqual(inferenceCapFields({ confidence: '低', chain: '推論：x' }), { inference: true });
});

test('C16a 法律事件（規則定方向）⇒ 不套推論上限：信心維持規則調整後的值，只標 inference（審查 2026-10-08；硬規定「涉法律事件一律利空」優先）', () => {
  // applyRuleFacts 覆寫：AI 原判中性／信心低 ⇒ label 利空、信心低升中，aiOriginal 記 AI 原判（含原信心）
  const v = { label: '利空', confidence: '中', chain: '推論：檢調搜索→營運風險', ruleClass: 'C16a', aiOriginal: { label: '中性', reason: 'x', confidence: '低' } };
  assert.deepEqual(inferenceCapFields(v), { inference: true }, '不覆寫 confidence、不覆寫 aiOriginal');
  // AI 自己也判利空（規則只補欄位）：方向同樣由法律規則確立 ⇒ 不夾
  assert.deepEqual(inferenceCapFields({ label: '利空', confidence: '高', chain: '推論：x', ruleClass: 'C16a', aiOriginal: { label: '利空', reason: 'y' } }), { inference: true });
  // 其他規則類（只記欄位、方向仍是 AI 判的）照常夾值
  assert.equal(inferenceCapFields({ label: '利空', confidence: '中', chain: '推論：x', ruleClass: 'C17', aiOriginal: { label: '利空', reason: 'y' } }).confidence, '低');
});

test('aiOriginal 已記 AI 原信心（上游規則調整過）⇒ 不以調整後的值覆寫（AI 原值欄位不可寫錯）', () => {
  const f = inferenceCapFields({ label: '利空', confidence: '中', chain: '推論：x', aiOriginal: { label: '中性', reason: 'r', confidence: '低' } });
  assert.equal(f.confidence, '低');
  assert.deepEqual(f.aiOriginal, { label: '中性', reason: 'r', confidence: '低' });
});

test('非推論 ⇒ 空物件（寫入端照原值，行為不變）', () => {
  assert.deepEqual(inferenceCapFields({ confidence: '高', chain: '油價→塑化' }), {});
  assert.deepEqual(inferenceCapFields({ confidence: '中', chain: null }), {});
  assert.deepEqual(inferenceCapFields(null), {});
});

test('寫入端用法：展開在原欄位之後即覆寫信心（物件後鍵勝）', () => {
  const v = { label: '利多', confidence: '中', chain: '推論：x' };
  const row = { label: v.label, confidence: v.confidence, ...inferenceCapFields(v) };
  assert.equal(row.confidence, '低');
});
