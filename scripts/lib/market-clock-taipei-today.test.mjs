// 台北日曆日 helper（src/lib/market-clock.ts taipeiToday／lastTradingYmd）
// 不連網：直接載入 market-clock.ts（無 import、只有可剝除的型別註記，Node 25 內建型別剝除可直接載入）。
// 用 TZ=UTC／Asia/Taipei／America/New_York 各跑一次可驗「不受主機時區影響」。
import { test } from 'node:test';
import assert from 'node:assert/strict';

const mc = await import(new URL('../../src/lib/market-clock.ts', import.meta.url).href);
const at = iso => new Date(iso);

test('台北 00:30（UTC 前一天 16:30）回台北日期，不是 UTC 日期', () => {
  assert.equal(mc.taipeiToday(at('2026-09-30T16:30:00Z')), '2026-10-01');
});

test('台北 07:59 仍是當天；08:00 起 UTC 與台北同日', () => {
  assert.equal(mc.taipeiToday(at('2026-10-08T23:59:00Z')), '2026-10-09');
  assert.equal(mc.taipeiToday(at('2026-10-09T00:00:00Z')), '2026-10-09');
});

test('台北 23:59 不會跨到隔天', () => {
  assert.equal(mc.taipeiToday(at('2026-10-09T15:59:00Z')), '2026-10-09');
  assert.equal(mc.taipeiToday(at('2026-10-09T16:00:00Z')), '2026-10-10');
});

test('與 Intl Asia/Taipei 逐時比對一致（2026 全年每 6 小時）', () => {
  const fmt = d => d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 6 * 3_600_000 + 17 * 60_000) {
    assert.equal(mc.taipeiToday(new Date(t)), fmt(new Date(t)), new Date(t).toISOString());
  }
});

test('lastTradingYmd：交易日回當天、週末回週五、台北週一 00:30（UTC 仍週日）回週一當天', () => {
  mc.setHolidays([]);
  assert.equal(mc.lastTradingYmd(at('2026-10-09T02:00:00Z')), '2026-10-09');   // 週五
  assert.equal(mc.lastTradingYmd(at('2026-10-10T02:00:00Z')), '2026-10-09');   // 週六
  assert.equal(mc.lastTradingYmd(at('2026-10-11T02:00:00Z')), '2026-10-09');   // 週日
  assert.equal(mc.lastTradingYmd(at('2026-10-11T16:30:00Z')), '2026-10-12');   // 台北週一 00:30
});

test('lastTradingYmd：休市日曆生效（連假跨週末）', () => {
  mc.setHolidays(['2026-10-09']);
  try {
    assert.equal(mc.lastTradingYmd(at('2026-10-11T02:00:00Z')), '2026-10-08');
  } finally {
    mc.setHolidays([]);
  }
});
