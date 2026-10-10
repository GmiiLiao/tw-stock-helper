// FinMind 1 分 K 轉換與彙總：node --test scripts/intraday-yahoo/finmind-kbar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toBars, aggregate } from './finmind-kbar.mjs';

const row = (minute, o, h, l, c, v) => ({ date: '2026-10-07', minute, stock_id: '2330', open: o, high: h, low: l, close: c, volume: v });
const rows = [row('09:00:00', 100, 101, 99, 100.5, 10), row('09:01:00', 100.5, 102, 100, 101, 5), row('09:04:00', 101, 101, 100, 100, 3),
  row('09:05:00', 100, 100.5, 99.5, 100, 2), row('13:29:00', 104, 104, 103, 103.5, 4), row('13:30:00', 104, 104, 104, 104, 20), row('09:01:00', 100.5, 102.5, 100, 101.5, 6)];

test('toBars：分鐘排序、同分鐘取後到、量原值不換算', () => {
  const b = toBars(rows);
  assert.deepEqual(b.t, [540, 541, 544, 545, 809, 810]);
  assert.equal(b.h[1], 102.5, '09:01 取後到的那一列'); assert.equal(b.v[1], 6);
  assert.equal(b.c.at(-1), 104, '13:30 收盤集合競價根保留');
});
test('aggregate：5 分 K 13:30 自成一根；60 分 K 13:30 併入 13:00；總量不變', () => {
  const b = toBars(rows);
  const m5 = aggregate(b, 5);
  assert.deepEqual(m5.t, [540, 545, 805, 810]);
  assert.deepEqual([m5.o[0], m5.h[0], m5.l[0], m5.c[0], m5.v[0]], [100, 102.5, 99, 100, 19]);
  assert.equal(m5.c.at(-1), 104); assert.equal(m5.v.at(-1), 20);
  const m60 = aggregate(b, 60);
  assert.deepEqual(m60.t, [540, 780]);
  assert.equal(m60.c[1], 104, '13:00 那根收在 13:30 收盤價'); assert.equal(m60.v[1], 24);
  const sum = x => x.v.reduce((a, y) => a + y, 0);
  assert.equal(sum(m5), sum(b)); assert.equal(sum(m60), sum(b));
});
