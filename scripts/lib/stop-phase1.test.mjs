// 第一階段 LLM 停損提示詞片段與量測（scripts/lib/stop-phase1.mjs）：node --test scripts/lib/stop-phase1.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PHASE1_STOP_RULE, STOP_REF_FORMAT, phase1HoldingStop, phase1HoldingStopLine, standardBuyPoint, phase1HypotheticalStop,
  phase1HypotheticalStopLine, splitStopRef, measureLlmStop, llmViolationCounts,
} from './stop-phase1.mjs';
import { scanForbidden } from './ai-stoploss-text.mjs';

test('持股分析停損＝停損推播同口徑（AI 停損 >0 優先，否則均價×0.92）；數字照推播原樣', () => {
  assert.deepEqual(phase1HoldingStop(220, 205.37), { price: 205.37, source: 'ai' });
  assert.deepEqual(phase1HoldingStop(220, null), { price: 202.4, source: 'cost' });
  assert.equal(phase1HoldingStop(0, 100), null);
  assert.equal(phase1HoldingStopLine({ price: 205.37, source: 'ai' }), '停損（與停損推播同口徑·AI 停損）：205.37');
  assert.equal(phase1HoldingStopLine({ price: 202.4, source: 'cost' }), '停損（與停損推播同口徑·成本 −8%）：202.4');
  assert.equal(phase1HoldingStopLine(null), '停損：成本資料缺，不提供停損數字');
});

test('規則句：只能照抄、不得把買點或目標價稱為停損；不含「ATR 帶當日值」（第一階段停損本身就是帶）、不宣稱系統依新聞調整', () => {
  assert.ok(PHASE1_STOP_RULE.includes('停損數字只能原樣引用上面的「停損」'));
  assert.ok(!PHASE1_STOP_RULE.includes('ATR 帶當日值'));
  assert.ok(!PHASE1_STOP_RULE.includes('系統已依規則處理'));
  assert.equal(STOP_REF_FORMAT, 'STOP_REF: <照抄上面的停損數字>');
});

test('個股波段（未持有）：標準買點 B；帶 >0 且 <B 用帶，否則 B×0.92；沒有 B 不給數字', () => {
  assert.equal(standardBuyPoint([{ type: 'aggressive', price: 110 }, { type: 'standard', price: 100 }]), 100);
  assert.equal(standardBuyPoint([{ label: '保守', price: 90 }]), null);
  assert.deepEqual(phase1HypotheticalStop(100, 95.5), { price: 95.5, source: 'ai' });
  assert.deepEqual(phase1HypotheticalStop(100, 101), { price: 92, source: 'cost' }, '帶 ≥ B 不能當 B 進場的停損');
  assert.deepEqual(phase1HypotheticalStop(100, null), { price: 92, source: 'cost' });
  assert.equal(phase1HypotheticalStop(null, 95), null);
  assert.equal(phase1HypotheticalStopLine(100, { price: 95.5, source: 'ai' }), '停損：若以標準買點 100 進場，停損＝95.5（與停損推播同口徑·AI 停損）');
  assert.equal(phase1HypotheticalStopLine(null, null), '停損：未持有且沒有標準買點，不提供停損數字');
});

test('系統產生的停損行與規則句不含禁用詞', () => {
  for (const s of [phase1HoldingStopLine({ price: 50, source: 'ai' }), phase1HypotheticalStopLine(100, { price: 92, source: 'cost' }), PHASE1_STOP_RULE.replace('停損規則', '')]) {
    assert.deepEqual(scanForbidden(s).filter(w => w !== '不要'), [], s);
  }
});

test('splitStopRef：先取 STOP_REF 再整行剝除（正文不會殘留給使用者）', () => {
  const out = 'ACTION: 續抱\nTRIGGER: 跌破 52.35 停損\n分析: 量縮整理。\nSTOP_REF: 52.35';
  const r = splitStopRef(out);
  assert.equal(r.stopRef, 52.35);
  assert.ok(!r.text.includes('STOP_REF'));
  assert.ok(r.text.endsWith('量縮整理。'));
  assert.deepEqual(splitStopRef('沒有參照'), { stopRef: null, text: '沒有參照' });
  assert.equal(splitStopRef('分析: x\nSTOP_REF: <1,025.5>').stopRef, 1025.5, '角括號原樣回傳也認得');
  assert.equal(splitStopRef('分析: x\nSTOP_REF: <1,025.5>').text, '分析: x');
});

test('measureLlmStop：measure 只記錄（推播口徑與 v1.1 影子兩個比對值）；計數不含代號與句子', () => {
  const fields = { TRIGGER: '跌破 49.8 即停損出場', 分析: '支撐 50' };
  const m = measureLlmStop(fields, { stop: 52.35, shadowStop: 49.8, refPrice: 55, band: 49.8, lastPrice: 55, stopRef: 52.35 });
  assert.ok(m.push.some(v => v.code === 'textMismatch' && v.found === 49.8));
  assert.ok(m.push.some(v => v.code === 'bandAsStop'));
  assert.deepEqual(m.shadow.filter(v => v.code === 'textMismatch'), [], '對影子停損 49.8 一致');
  assert.ok(m.shadow.some(v => v.code === 'refMismatch'), 'STOP_REF 52.35 ≠ 影子 49.8');
  assert.equal(measureLlmStop(fields, { stop: 52.35 }).shadow, null, '沒有影子停損就不比');
  const c = llmViolationCounts(m.push);
  assert.equal(c.textMismatch, 1);
  assert.ok(Object.keys(c).every(k => !/\d/.test(k)));
  assert.deepEqual(fields, { TRIGGER: '跌破 49.8 即停損出場', 分析: '支撐 50' }, '欄位不改');
});

test('measureLlmStop expectRef:false（S3 提示詞不變、不要求 STOP_REF）：不記 T1，T2–T5 照記', () => {
  const fields = { TRIGGER: '跌破 49.8 即停損出場' };
  const on = measureLlmStop(fields, { stop: 52.35, shadowStop: 49.8, refPrice: 55, band: 49.8, lastPrice: 55 });
  assert.ok(on.push.some(v => v.code === 'refMissing'), '預設 expectRef:true ⇒ 沒有 STOP_REF 記 refMissing');
  const off = measureLlmStop(fields, { stop: 52.35, shadowStop: 49.8, refPrice: 55, band: 49.8, lastPrice: 55, expectRef: false });
  assert.deepEqual(off.push.filter(v => v.rule === 'T1'), []);
  assert.deepEqual(off.shadow.filter(v => v.rule === 'T1'), []);
  assert.ok(off.push.some(v => v.code === 'textMismatch' && v.found === 49.8));
  assert.ok(off.push.some(v => v.code === 'bandAsStop'));
});
