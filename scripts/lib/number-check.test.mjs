import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unverifiedNumbers, markUnverified, stripNumberMark, NUMBER_MARK_LEAD } from './number-check.mjs';

test('derive 只驗 %/倍/億/萬；quote 另含 元/張/點', () => {
  const src = '外資買超 3.5億、今日 +2.1%';
  const ans = '外資買超3.5億，漲2.1%，目標價 120元，殖利率 6%';
  assert.deepEqual(unverifiedNumbers(ans, src, 'derive'), ['6%']);
  assert.deepEqual(unverifiedNumbers(ans, src, 'quote'), ['120元', '6%']);
});

test('全形％與千分位逗號視同', () => {
  assert.deepEqual(unverifiedNumbers('營收 1,200億、漲 3％', '營收 1200億 漲 3%', 'derive'), []);
});

test('沒有查不到的數字 → 只截斷、不加標示（與舊 .slice 行為相同）', () => {
  assert.equal(markUnverified('abcdef', [], 4), 'abcd');
  assert.equal(markUnverified('abc', undefined, 10), 'abc');
});

test('有查不到的數字 → 尾端標示，且長度上限內標示不被截掉', () => {
  const long = '字'.repeat(1000);
  const out = markUnverified(long, ['6%', '12億'], 900);
  assert.ok(out.length <= 900);
  assert.ok(out.endsWith(`${NUMBER_MARK_LEAD}6%、12億`));
});

test('最多列 5 個數字', () => {
  const out = markUnverified('x', ['1%', '2%', '3%', '4%', '5%', '6%'], 900);
  assert.ok(out.endsWith('1%、2%、3%、4%、5%'));
});

test('stripNumberMark 還原標示前內文；無標示原樣返回', () => {
  const body = '波段分析內文 3%';
  assert.equal(stripNumberMark(markUnverified(body, ['9%'], 900)), body);
  assert.equal(stripNumberMark(body), body);
  assert.equal(stripNumberMark(undefined), '');
});

test('標示過的文字餵回語料前先 strip，問AI 不會把查不到的數字當成可查證', () => {
  const marked = markUnverified('內文', ['88%'], 900);
  assert.deepEqual(unverifiedNumbers('漲幅 88%', stripNumberMark(marked), 'quote'), ['88%']);
});
