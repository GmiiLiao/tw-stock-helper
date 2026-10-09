// chipArchive 視窗對齊 單元測試：node --test scripts/lib/archive-window.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toIsoDate, archiveBefore, leadingOnOrAfter, tailBaselines, olderThanCurrent } from './archive-window.mjs';

// 新→舊，與 readArchive 相同；收盤列 [收, 量張]
const doc = (date, close) => ({ date, closeJson: JSON.stringify(close) });
const ARCH = [
  doc('2026-10-02', { 2330: [110, 900] }),   // 15:10 後的「今日」
  doc('2026-10-01', { 2330: [100, 500] }),
  doc('2026-09-30', { 2330: [102, 400] }),
  doc('2026-09-29', { 2330: [101, 300] }),
  doc('2026-09-26', { 2330: [99, 200] }),
  doc('2026-09-25', { 2330: [98, 100] }),
  doc('2026-09-24', { 2330: [97, 50] }),
];

test('toIsoDate：CSV 自報 YYYYMMDD 與 ISO 都轉成 YYYY-MM-DD；其餘回 null', () => {
  assert.equal(toIsoDate('20261002'), '2026-10-02');
  assert.equal(toIsoDate('2026-10-02'), '2026-10-02');
  assert.equal(toIsoDate(''), null);
  assert.equal(toIsoDate(undefined), null);
  assert.equal(toIsoDate('1151002'), null, '民國日期要先經 rocToYmd');
});

test('archiveBefore：收盤模式（歸檔已含資料日）丟掉資料日當天，順序不變、不改原陣列', () => {
  const out = archiveBefore(ARCH, '2026-10-02');
  assert.deepEqual(out.map(a => a.date), ['2026-10-01', '2026-09-30', '2026-09-29', '2026-09-26', '2026-09-25', '2026-09-24']);
  assert.equal(ARCH.length, 7, '原陣列不變');
});

test('archiveBefore：盤中（歸檔尚無資料日）原樣保留', () => {
  const out = archiveBefore(ARCH.slice(1), '2026-10-02');
  assert.equal(out.length, 6);
  assert.equal(out[0].date, '2026-10-01');
});

test('archiveBefore：資料日缺就回空（呼叫端應棄權，不可退回未對齊的視窗）', () => {
  assert.deepEqual(archiveBefore(ARCH, null), []);
  assert.deepEqual(archiveBefore(ARCH, ''), []);
});

test('leadingOnOrAfter：歸檔含報價當日→1、盤中→0、報價日更舊（開機時快照落後）→跳過所有較新的歸檔', () => {
  assert.equal(leadingOnOrAfter(ARCH, '2026-10-02'), 1);
  assert.equal(leadingOnOrAfter(ARCH.slice(1), '2026-10-02'), 0);
  assert.equal(leadingOnOrAfter(ARCH, '2026-09-30'), 3);
  assert.equal(leadingOnOrAfter([], '2026-10-02'), 0);
});

test('tailBaselines：對齊後 昨收＝資料日前一交易日、近20日高與5日均量都不含資料日（根因回歸測試）', () => {
  const maps = archiveBefore(ARCH, '2026-10-02').map(a => JSON.parse(a.closeJson));
  const b = tailBaselines(maps);
  assert.equal(b.prevClose['2330'], 100, '昨收是 10-01，不是今日 110');
  assert.equal(b.hi20['2330'], 102, '20 日高不含今日 110');
  assert.equal(b.avgVol['2330'], (500 + 400 + 300 + 200 + 100) / 5, '5 日均量＝t-1..t-5，第 6 天（50 張）不計');
});

test('tailBaselines：未對齊（舊行為）會把今日收盤當昨收——漲幅恆 0、突破恆不成立', () => {
  const b = tailBaselines(ARCH.map(a => JSON.parse(a.closeJson)));
  assert.equal(b.prevClose['2330'], 110);
  assert.equal(b.hi20['2330'], 110);
});

test('tailBaselines：缺日的股票只用有資料的天數平均量；量 0 不計', () => {
  const maps = [{ 1101: [10, 0] }, {}, { 1101: [12, 30] }, { 1101: [11, 10] }];
  const b = tailBaselines(maps);
  assert.equal(b.prevClose['1101'], 10);
  assert.equal(b.hi20['1101'], 12);
  assert.equal(b.avgVol['1101'], 20);
});

test('olderThanCurrent：新榜資料日早於現存榜才擋（例：14:00 開機時 CSV 尚未換日）', () => {
  assert.equal(olderThanCurrent({ source: 'live', date: '2026-10-02' }, '2026-10-01'), true, '舊版無 dataDate 的盤中榜：date 即資料日');
  assert.equal(olderThanCurrent({ source: 'live', date: '2026-10-02' }, '2026-10-02'), false, '15:10 收盤版取代同日盤中版');
  assert.equal(olderThanCurrent({ source: 'close', dataDate: '2026-10-02', date: '2026-10-03' }, '2026-10-02'), false, '週末重算同一資料日');
  assert.equal(olderThanCurrent({ source: 'close', dataDate: '2026-10-02' }, '2026-10-05'), false);
  assert.equal(olderThanCurrent({ source: 'close', date: '2026-10-03' }, '2026-10-02'), false, '舊版收盤榜的 date 是日曆日，不能當資料日比');
  assert.equal(olderThanCurrent(null, '2026-10-02'), false);
  assert.equal(olderThanCurrent(undefined, '2026-10-02'), false);
});
