// 會員持股＋自選聯集（快線優先集來源）單元測試：node --test scripts/lib/watch-codes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeWatchCodes, WATCH_CODES_CAP } from './watch-codes.mjs';

const it = (code, name = '') => ({ code, name });
const range = (from, n) => Array.from({ length: n }, (_, i) => it(String(from + i)));

test('上限 40 檔', () => {
  assert.equal(WATCH_CODES_CAP, 40);
  const out = mergeWatchCodes([{ watchlist: range(1000, 60) }]);
  assert.equal(out.length, 40);
});

test('H4 重現：自選塞滿 40 格時，後面會員的持股仍在名單內（持股優先）', () => {
  const perUser = [
    { watchlist: range(1000, 45), holdings: [it('2330', '台積電')] },
    { watchlist: range(2000, 10), holdings: [it('3008', '大立光'), it('2317', '鴻海')] },
  ];
  const out = mergeWatchCodes(perUser);
  const codes = out.map(([c]) => c);
  assert.equal(out.length, 40);
  assert.deepEqual(codes.slice(0, 3), ['2330', '3008', '2317'], '所有會員的持股排在最前（依會員順序）');
  assert.ok(!codes.includes('2000'), '超出上限被擠掉的是自選');
});

test('同代號只占一格：持股與自選重複時位置跟著持股', () => {
  const out = mergeWatchCodes([
    { watchlist: [it('2454', '聯發科'), it('2330', '台積電')], holdings: [it('2330', '台積電')] },
  ]);
  assert.deepEqual(out, [['2330', '台積電'], ['2454', '聯發科']]);
});

test('名稱取第一個非空值（空名稱不覆蓋已有名稱）', () => {
  const out = mergeWatchCodes([
    { holdings: [it('2330', '')] },
    { holdings: [it('2330', '台積電')], watchlist: [it('2330', '')] },
  ]);
  assert.deepEqual(out, [['2330', '台積電']]);
});

test('總數未滿上限時內容與舊版相同（只差順序）：全部保留', () => {
  const perUser = [{ watchlist: [it('1101', '台泥'), it('2603', '長榮')], holdings: [it('2412', '中華電')] }];
  const out = mergeWatchCodes(perUser);
  assert.deepEqual(new Set(out.map(([c]) => c)), new Set(['1101', '2603', '2412']));
  assert.deepEqual(out[0], ['2412', '中華電']);
});

test('缺漏與髒資料：沒有 code 的項目略過；欄位不是陣列視為空；無會員回空陣列', () => {
  const out = mergeWatchCodes([
    { holdings: [null, {}, it(''), it('2881', '富邦金')], watchlist: 'oops' },
    null,
    { holdings: undefined, watchlist: [it('0050')] },
  ]);
  assert.deepEqual(out, [['2881', '富邦金'], ['0050', '']]);
  assert.deepEqual(mergeWatchCodes([]), []);
  assert.deepEqual(mergeWatchCodes(undefined), []);
});

test('cap 參數：可指定較小上限；負數視為 0', () => {
  const perUser = [{ holdings: range(3000, 5), watchlist: range(4000, 5) }];
  assert.deepEqual(mergeWatchCodes(perUser, 3).map(([c]) => c), ['3000', '3001', '3002']);
  assert.deepEqual(mergeWatchCodes(perUser, -1), []);
});
