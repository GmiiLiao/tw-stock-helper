// 處置／注意扣分與未含風險扣分的技術評分 單元測試：node --test scripts/lib/risk-score.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RISK_PENALTY, riskTypeOf, baseScoreOf, percentileOf, techScoreText, riskNoteText, thesisSupport } from './risk-score.mjs';

test('baseScoreOf：有 baseScore 直接用；舊 API 由 score＋扣分回推（避免浮點尾差）', () => {
  assert.equal(baseScoreOf({ score: 17.36, baseScore: 57.36 }, 'disposition'), 57.36);
  assert.equal(baseScoreOf({ score: 17.36 }, 'disposition'), 57.36, '2305 全友實例：17.36＋40');
  assert.equal(baseScoreOf({ score: 18.38 }, 'disposition'), 58.38, '不出現 58.38000000000001');
  assert.equal(baseScoreOf({ score: 50 }, 'attention'), 70);
  assert.equal(baseScoreOf({ score: 50 }, null), 50, '無風險＝原分');
  assert.equal(baseScoreOf({}, 'disposition'), null);
  assert.equal(baseScoreOf(undefined, null), null);
  assert.deepEqual(RISK_PENALTY, { disposition: 40, attention: 20 }, '與 scoring-server.ts 同步');
});

test('riskTypeOf：處置優先於注意', () => {
  assert.equal(riskTypeOf({ isDisposition: true, isAttention: true }), 'disposition');
  assert.equal(riskTypeOf({ isAttention: true }), 'attention');
  assert.equal(riskTypeOf({}), null);
  assert.equal(riskTypeOf(null), null);
});

test('percentileOf：≤v 的比例；空或 null ⇒ null', () => {
  const s = [10, 20, 30, 40];
  assert.equal(percentileOf(s, 30), 75);
  assert.equal(percentileOf(s, 40), 100);
  assert.equal(percentileOf(s, 5), 0);
  assert.equal(percentileOf([], 30), null);
  assert.equal(percentileOf(s, null), null);
});

test('techScoreText：處置股寫未含扣分的評分與技術訊號，不寫含扣分的 17(C)／NEUTRAL', () => {
  const st = { score: 17.36, grade: 'C', signal: 'NEUTRAL', baseScore: 57.36, baseSignal: 'WATCH', isDisposition: true };
  const t = techScoreText(st);
  assert.match(t, /未含風險扣分）57\.36/);
  assert.match(t, /技術訊號 WATCH/);
  assert.doesNotMatch(t, /17\.36|\(C\)|NEUTRAL/);
  assert.equal(techScoreText({ score: 70, grade: 'B+', signal: 'BUY' }), 'AI 技術評分 70(B+) 訊號 BUY', '無風險維持原寫法');
  assert.match(techScoreText({ score: 30, grade: 'C', signal: 'WATCH' }, 'attention'), /未含風險扣分）50、技術訊號 —/, '呼叫端給的風險優先；舊 API 無 baseSignal 顯示 —');
});

test('riskNoteText：明講是交易風險、不是走勢', () => {
  assert.match(riskNoteText('disposition'), /處置股.*交易風險，不代表技術面轉弱/);
  assert.match(riskNoteText('attention'), /注意股.*交易風險，不代表技術面轉弱/);
  assert.equal(riskNoteText(null), '');
});

test('thesisSupport：支柱權重 2、參考權重 1，換算 0~100', () => {
  const ok = { ok: true }, no = { ok: false };
  assert.equal(thesisSupport([ok, ok], [no, no, no, no]), 50, '(2×2+0)/(2×2+4)');
  assert.equal(thesisSupport([ok, no], [ok, ok, no, no]), 50, '(2+2)/(4+4)');
  assert.equal(thesisSupport([ok, ok, ok], [ok, ok, ok]), 100);
  assert.equal(thesisSupport([no], [no, no]), 0);
  assert.equal(thesisSupport([ok], [no, no, no, no, no]), 29, '2/7 四捨五入');
  assert.equal(thesisSupport([], []), null);
  assert.equal(thesisSupport(), null);
});
