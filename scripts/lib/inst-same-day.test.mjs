// 法人資料是否與榜單價格同一天（三重確認 PIT 口徑）單元測試：node --test scripts/lib/inst-same-day.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instIsSameDay } from './inst-same-day.mjs';

const T = '2026-10-01', Y = '2026-09-30';

test('盤中（快照模式·歸檔末日＝昨天）：最新法人＝昨天 T86 ＝ t-1，不是同日——2026-10-03 前誤判成「含今日T86」', () => {
  assert.equal(instIsSameDay({ instDate: Y, liveDay: true, today: T, lastArchiveDay: Y }), false);
});

test('收盤歸檔晚到（快照模式）但今日 T86 已公布：法人＝今天＝價格日 ⇒ 同日', () => {
  assert.equal(instIsSameDay({ instDate: T, liveDay: true, today: T, lastArchiveDay: Y }), true);
});

test('歸檔模式：收盤已歸檔、T86 未公布（15:10–16:30）⇒ 法人是 t-1；公布後 ⇒ 同日', () => {
  assert.equal(instIsSameDay({ instDate: Y, liveDay: false, today: T, lastArchiveDay: T }), false);
  assert.equal(instIsSameDay({ instDate: T, liveDay: false, today: T, lastArchiveDay: T }), true);
});

test('歸檔模式：開盤前／休市日，價格與法人都是最後交易日 ⇒ 同日（對應「明日買進」）', () => {
  assert.equal(instIsSameDay({ instDate: Y, liveDay: false, today: T, lastArchiveDay: Y }), true);
  assert.equal(instIsSameDay({ instDate: '2026-10-02', liveDay: false, today: '2026-10-03', lastArchiveDay: '2026-10-02' }), true);
});

test('沒有法人資料 ⇒ 不是同日', () => {
  assert.equal(instIsSameDay({ instDate: null, liveDay: false, today: T, lastArchiveDay: T }), false);
  assert.equal(instIsSameDay({ instDate: undefined, liveDay: true, today: T, lastArchiveDay: Y }), false);
});
