// 盤中戰情 v2·D1 快看抽屜 純函式單元測試：node --test scripts/lib/warroom-drawer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pruneRegs, decideRegistration, addTicks, breakevenTicks, REG_WINDOW_MS, REG_MAX,
} from './warroom-drawer.mjs';

const NOW = Date.UTC(2026, 9, 5, 2, 30);   // 10:30 台北

test('登記配額：15 分鐘內最多 3 個不同代號，第 4 個不登記', () => {
  let list = [];
  for (const c of ['2317', '2330', '3017']) {
    const d = decideRegistration(list, c, NOW);
    assert.equal(d.allowed, true);
    list = d.next;
  }
  assert.equal(list.length, REG_MAX);
  const fourth = decideRegistration(list, '2454', NOW + 1000);
  assert.equal(fourth.allowed, false);
  assert.deepEqual(fourth.held.slice().sort(), ['2317', '2330', '3017']);
});

test('登記配額：同代號再開不多佔名額，並更新時間', () => {
  const list = [{ code: '2317', at: NOW - 60_000 }, { code: '2330', at: NOW - 30_000 }, { code: '3017', at: NOW - 10_000 }];
  const d = decideRegistration(list, '2317', NOW);
  assert.equal(d.allowed, true);
  assert.equal(d.next.length, 3);
  assert.equal(d.next.find(r => r.code === '2317').at, NOW);
});

test('登記配額：超過 15 分鐘的釋出名額；壞資料丟棄', () => {
  const list = [
    { code: '2317', at: NOW - REG_WINDOW_MS - 1 },
    { code: '2330', at: NOW - 60_000 },
    { code: 'abc', at: NOW },
    { code: '3017', at: 'x' },
    null,
    { code: '2330', at: NOW - 120_000 },   // 同代號只留較新的
  ];
  assert.deepEqual(pruneRegs(list, NOW), [{ code: '2330', at: NOW - 60_000 }]);
  const d = decideRegistration(list, '2454', NOW);
  assert.equal(d.allowed, true);
  assert.equal(decideRegistration([], 'bad', NOW).allowed, false);
  assert.deepEqual(pruneRegs('not-array', NOW), []);
});

const tick = p => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);

test('逐檔往上走：跨檔位級距逐檔換算', () => {
  assert.equal(addTicks(49.9, 3, tick), 50.1);   // 49.9→49.95→50.0→50.1
  assert.equal(addTicks(100, 2, tick), 101);
  assert.equal(addTicks(995, 2, tick), 997);    // 995→996→997
  assert.equal(addTicks(999, 2, tick), 1005);   // 999→1000→1005（≥1000 檔位 5）
});

test('回本檔數：手續費（折讓、最低 20 元）×2＋當沖稅 0.15%，以注入的費率函式計算', () => {
  // 全額 0.1425%、最低 20 元；當沖稅 0.15%（皆元以下捨去）
  const fee = p => Math.max(Math.floor(p * 1000 * 0.001425), 20);
  const tax = p => Math.max(1, Math.floor(p * 1000 * 0.0015));
  // 41.85（檔位 0.05）：成本約 59＋59＋62＝180 元 ⇒ 每檔 50 元 ⇒ 4 檔
  assert.equal(breakevenTicks(41.85, { fee, tax, tick }), 4);
  // 2.8 折：手續費 max(floor(41.85×1000×0.000399),20)=20 ⇒ 20＋20＋62＝102 ⇒ 3 檔
  const fee28 = p => Math.max(Math.floor(p * 1000 * 0.001425 * 0.28), 20);
  assert.equal(breakevenTicks(41.85, { fee: fee28, tax, tick }), 3);
  // 1,685（檔位 5）：全額 2401＋2408＋2535 ≈ 7344 ⇒ 每檔 5000 ⇒ 2 檔
  assert.equal(breakevenTicks(1685, { fee, tax, tick }), 2);
  assert.equal(breakevenTicks(0, { fee, tax, tick }), null);
  assert.equal(breakevenTicks(100, null), null);
  assert.equal(breakevenTicks(100, { fee: () => 1e9, tax, tick }, 5), null);
});
