// 台北時段／限速窗 單元測試：node --test scripts/finmind/timewin.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taipeiParts, hourlyCapAt, windowState, msUntilOpen, weeklyCapacity, etaHours, CAP_PEAK, CAP_NORMAL } from './timewin.mjs';

// 台北時間 → epoch ms（台灣無夏令時間）
const tpe = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
const noHoliday = { isHoliday: () => false, busyWindows: [] };

test('taipeiParts：UTC+8 換算日期、星期、分鐘', () => {
  const p = taipeiParts(tpe(2026, 10, 8, 0, 30));   // 週四 00:30
  assert.equal(p.date, '2026-10-08'); assert.equal(p.dow, 4); assert.equal(p.minutes, 30);
});

test('hourlyCapAt：平日 08:30–13:45 每小時 ≤1,500，其餘 ≤5,000；邊界含頭不含尾', () => {
  assert.equal(hourlyCapAt(tpe(2026, 10, 8, 8, 29), noHoliday), CAP_NORMAL);
  assert.equal(hourlyCapAt(tpe(2026, 10, 8, 8, 30), noHoliday), CAP_PEAK);
  assert.equal(hourlyCapAt(tpe(2026, 10, 8, 13, 44), noHoliday), CAP_PEAK);
  assert.equal(hourlyCapAt(tpe(2026, 10, 8, 13, 45), noHoliday), CAP_NORMAL);
  assert.equal(CAP_PEAK, 1500); assert.equal(CAP_NORMAL, 5000);
});

test('hourlyCapAt：週末與休市日的 10:00 不降速；daemon 重任務窗降速', () => {
  assert.equal(hourlyCapAt(tpe(2026, 10, 10, 10, 0), noHoliday), CAP_NORMAL);   // 週六
  assert.equal(hourlyCapAt(tpe(2026, 10, 9, 10, 0), { isHoliday: d => d === '2026-10-09', busyWindows: [] }), CAP_NORMAL);
  assert.equal(hourlyCapAt(tpe(2026, 10, 10, 21, 50), { isHoliday: () => false, busyWindows: [[21 * 60 + 40, 22 * 60 + 35, 'x']] }), CAP_PEAK);
});

test('windowState main：只有週日 00:00–03:00 維護時段暫停', () => {
  assert.equal(windowState(tpe(2026, 10, 8, 10, 0), 'main', noHoliday).open, true);
  assert.equal(windowState(tpe(2026, 10, 11, 1, 0), 'main', noHoliday).open, false);   // 週日 01:00
  assert.equal(windowState(tpe(2026, 10, 11, 3, 0), 'main', noHoliday).open, true);
});

test('windowState idle：平日 08:00–15:30 暫停；平日 15:30 後、08:00 前、週末、休市日可跑', () => {
  assert.equal(windowState(tpe(2026, 10, 8, 7, 59), 'idle', noHoliday).open, true);
  assert.equal(windowState(tpe(2026, 10, 8, 8, 0), 'idle', noHoliday).open, false);
  assert.equal(windowState(tpe(2026, 10, 8, 15, 29), 'idle', noHoliday).open, false);
  assert.equal(windowState(tpe(2026, 10, 8, 15, 30), 'idle', noHoliday).open, true);
  assert.equal(windowState(tpe(2026, 10, 10, 11, 0), 'idle', noHoliday).open, true);
  assert.equal(windowState(tpe(2026, 10, 9, 11, 0), 'idle', { isHoliday: d => d === '2026-10-09', busyWindows: [] }).open, true);
  assert.throws(() => windowState(0, 'bogus'), /window/);
});

test('msUntilOpen：idle 窗在平日 10:00 要等到 15:30；已開則 0', () => {
  assert.equal(msUntilOpen(tpe(2026, 10, 8, 10, 0), 'idle', noHoliday), 5.5 * 3600e3);
  assert.equal(msUntilOpen(tpe(2026, 10, 8, 16, 0), 'idle', noHoliday), 0);
  assert.equal(msUntilOpen(tpe(2026, 10, 11, 2, 0), 'main', noHoliday), 3600e3);
});

test('weeklyCapacity／etaHours：main 窗一週容量介於純 1,500 與純 5,000 之間；請求數換算時數', () => {
  const cap = weeklyCapacity('main', noHoliday);
  assert.ok(cap > 1500 * 168 && cap < 5000 * 168, String(cap));
  // 平日 5.25 小時 1,500、其餘 5,000、週日 3 小時維護
  const expect = 5 * (5.25 * 1500 + 18.75 * 5000) + 2 * 24 * 5000 - 3 * 5000;
  assert.equal(Math.round(cap), Math.round(expect));
  assert.equal(etaHours(cap, 'main', noHoliday), 168);
  assert.ok(weeklyCapacity('idle', noHoliday) < cap);
});

test('windowState heavy（重資料集）：降速時段（平日 08:30–13:45、daemon 重任務窗）整段暫停；週末、休市日、其餘時段照跑', () => {
  const heavy = { ...noHoliday, heavy: true };
  assert.equal(windowState(tpe(2026, 10, 8, 8, 29), 'main', heavy).open, true);
  const st = windowState(tpe(2026, 10, 8, 8, 30), 'main', heavy);
  assert.equal(st.open, false); assert.match(st.reason, /重資料集/);
  assert.equal(windowState(tpe(2026, 10, 8, 13, 44), 'main', heavy).open, false);
  assert.equal(windowState(tpe(2026, 10, 8, 13, 45), 'main', heavy).open, true);
  assert.equal(windowState(tpe(2026, 10, 10, 10, 0), 'main', heavy).open, true);   // 週六
  assert.equal(windowState(tpe(2026, 10, 9, 10, 0), 'main', { ...heavy, isHoliday: d => d === '2026-10-09' }).open, true);
  assert.equal(windowState(tpe(2026, 10, 10, 21, 50), 'main', { ...heavy, busyWindows: [[21 * 60 + 40, 22 * 60 + 35, 'x']] }).open, false);
  assert.equal(windowState(tpe(2026, 10, 8, 10, 0), 'main', noHoliday).open, true, '非重資料集盤中照跑（只降速）');
  assert.equal(msUntilOpen(tpe(2026, 10, 8, 10, 0), 'main', heavy), 3.75 * 3600e3);
});
