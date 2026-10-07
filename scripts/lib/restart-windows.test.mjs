// node --test scripts/lib/restart-windows.test.mjs
//   can-restart-daemon 的保護窗判定（2026-10-07 依使用者裁定 O7 新增開盤感應器窗 08:30–10:05）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WINDOWS, NEAR_GAP_MIN, restartVerdict, earliestRestart, hhmm } from './restart-windows.mjs';

const at = s => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const verdict = (s, isTradingDay = true) => restartVerdict({ mins: at(s), isTradingDay });
const names = v => v.active.map(w => w.name);
const SENSOR = WINDOWS.find(w => w.name.startsWith('開盤感應器'));

test('O7：交易日 08:30–10:05 有開盤感應器窗（代價說明不可空白）', () => {
  assert.ok(SENSOR, '找不到開盤感應器窗');
  assert.equal(SENSOR.from, at('08:30'));
  assert.equal(SENSOR.to, at('10:05'));
  assert.match(SENSOR.cost, /late 或 nodata/);
  for (const w of WINDOWS) assert.ok(w.name && w.cost, `窗 ${hhmm(w.from)} 缺名稱或代價`);
});

test('O7：交易日 10:04 回 BLOCK、10:05 放行（無其他窗時）', () => {
  const v1004 = verdict('10:04');
  assert.equal(v1004.ok, false);
  assert.equal(v1004.reason, 'active');
  assert.deepEqual(names(v1004), [SENSOR.name]);
  const v1005 = verdict('10:05');
  assert.equal(v1005.ok, true);
  assert.equal(v1005.reason, 'clear');
  assert.equal(v1005.upcoming[0].name, '尾盤五檔累積窗');
});

test('開盤感應器窗起點 08:30 與 09:20–10:04 之間（舊窗都已結束）都擋', () => {
  assert.ok(names(verdict('08:30')).includes(SENSOR.name));
  assert.equal(verdict('08:29').ok, false);                 // 08:00–09:05 等舊窗本來就擋
  assert.deepEqual(names(verdict('09:10')), [SENSOR.name, '搶漲停排隊警示']);
  for (const s of ['09:20', '09:35', '09:59', '10:00']) {
    const v = verdict(s);
    assert.equal(v.ok, false, s);
    assert.deepEqual(names(v), [SENSOR.name], s);
  }
});

test('13:20–13:40 尾盤五檔窗照舊；13:17 因 3 分鐘內開窗也擋', () => {
  assert.equal(verdict('13:20').ok, false);
  assert.equal(verdict('13:39').ok, false);
  assert.equal(verdict('13:40').ok, true);
  const near = verdict('13:17');
  assert.equal(near.ok, false);
  assert.equal(near.reason, 'near');
  assert.equal(near.near.name, '尾盤五檔累積窗');
  assert.equal(verdict('13:16').ok, true);
  assert.equal(NEAR_GAP_MIN, 3);
});

test('既有保護窗的時段不變（只新增一條）', () => {
  const others = WINDOWS.filter(w => w !== SENSOR).map(w => `${hhmm(w.from)}-${hhmm(w.to)}`);
  assert.deepEqual(others, ['07:00-09:00', '07:20-07:50', '08:00-09:05', '08:30-09:10', '09:00-09:20',
    '13:20-13:40', '15:05-15:25', '16:25-16:55', '21:40-22:35']);
});

test('非交易日一律放行', () => {
  for (const s of ['08:45', '09:30', '13:25', '21:50']) {
    const v = verdict(s, false);
    assert.equal(v.ok, true, s);
    assert.equal(v.reason, 'nonTrading');
  }
});

test('earliestRestart：窗與窗首尾相接時報到真正可重啟的時刻', () => {
  const e = s => hhmm(earliestRestart({ mins: at(s), isTradingDay: true }));
  assert.equal(e('07:10'), '10:05');   // 07:00–09:00 → 08:30–10:05 相接；舊版會報 09:00
  assert.equal(e('09:15'), '10:05');
  assert.equal(e('10:30'), '10:30');   // 已可重啟
  assert.equal(e('13:18'), '13:40');
  assert.equal(e('15:10'), '15:25');
  assert.equal(earliestRestart({ mins: at('09:15'), isTradingDay: false }), at('09:15'));
});

test('mins 不合法就丟錯（不猜）', () => {
  assert.throws(() => restartVerdict({ mins: -1, isTradingDay: true }), /mins/);
  assert.throws(() => restartVerdict({ mins: 1440, isTradingDay: true }), /mins/);
  assert.throws(() => restartVerdict({ mins: 9.5, isTradingDay: true }), /mins/);
});
