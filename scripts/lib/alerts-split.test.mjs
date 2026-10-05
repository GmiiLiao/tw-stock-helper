// 使用者價位警示／daemon 警示拆檔 單元測試：node --test scripts/lib/alerts-split.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isUserPriceAlert, pickUserPriceAlerts, resolvePriceAlerts, applyPriceAlertOp, stripUserPriceAlerts, withPriceAlerts, ackAlertIn,
  USER_PRICE_ALERT_TYPES, PRICE_ALERTS_DOC, LEGACY_ALERTS_DOC,
} from './alerts-split.mjs';

const userA = { id: 'a-1', code: '2330', name: '台積電', type: 'PRICE_ABOVE', value: 1200, triggered: false, createdAt: 1 };
const userB = { id: 'a-2', code: '2317', name: '鴻海', type: 'CHANGE_BELOW', value: -5, triggered: true, createdAt: 2 };
const daemonStop = { code: '3008', name: '大立光', type: 'stop', price: 2000, threshold: 2100, pnlPct: -8, message: '觸停損', at: 10 };
const daemonRev = { id: 'rev:2026-10-05:up', key: 'rev:2026-10-05:up', type: 'reversalUp', requireAck: true, message: '反轉', at: 11 };

test('文件名稱常數：新舊文件分開', () => {
  assert.equal(PRICE_ALERTS_DOC, 'priceAlerts');
  assert.equal(LEGACY_ALERTS_DOC, 'alerts');
  assert.notEqual(PRICE_ALERTS_DOC, LEGACY_ALERTS_DOC);
  assert.deepEqual([...USER_PRICE_ALERT_TYPES], ['PRICE_ABOVE', 'PRICE_BELOW', 'CHANGE_ABOVE', 'CHANGE_BELOW']);
});

test('isUserPriceAlert：只認四種大寫 type，daemon 警示一律排除', () => {
  assert.equal(isUserPriceAlert(userA), true);
  assert.equal(isUserPriceAlert(userB), true);
  assert.equal(isUserPriceAlert(daemonStop), false);
  assert.equal(isUserPriceAlert(daemonRev), false);
  assert.equal(isUserPriceAlert({ type: 'custom' }), false);
  assert.equal(isUserPriceAlert(null), false);
  assert.equal(isUserPriceAlert([userA]), false);
  assert.equal(isUserPriceAlert('PRICE_ABOVE'), false);
});

test('pickUserPriceAlerts：混合陣列只挑使用者格式、原物件照搬、同 id 去重、無 id 照樣保留', () => {
  const noId = { code: '1101', type: 'PRICE_BELOW', value: '40' };   // 舊資料欄位不完整也不丟
  const out = pickUserPriceAlerts([daemonStop, userA, daemonRev, userB, { ...userA, value: 999 }, noId]);
  assert.deepEqual(out, [userA, userB, noId]);
  assert.equal(out[0], userA, '原物件照搬，不重組欄位');
  assert.deepEqual(pickUserPriceAlerts(undefined), []);
  assert.deepEqual(pickUserPriceAlerts({ alerts: [userA] }), []);
});

test('resolvePriceAlerts：priceAlerts 已存在＝它說了算，不遷移', () => {
  const r = resolvePriceAlerts({ priceDoc: { alerts: [userB, daemonStop] }, legacyDoc: { alerts: [userA] }, localAlerts: [userA] });
  assert.deepEqual(r, { list: [userB], migrate: false, source: 'priceAlerts' });
});

test('resolvePriceAlerts：priceAlerts 存在但陣列缺漏＝空清單（不回頭用舊文件，避免已刪的警示復活）', () => {
  const r = resolvePriceAlerts({ priceDoc: { updatedAt: 5 }, legacyDoc: { alerts: [userA] }, localAlerts: [] });
  assert.deepEqual(r, { list: [], migrate: false, source: 'priceAlerts' });
});

test('resolvePriceAlerts：一次性遷移——舊 alerts 文件存在＝取其中使用者格式項目', () => {
  const r = resolvePriceAlerts({ priceDoc: null, legacyDoc: { updatedAt: 9, alerts: [daemonStop, userA, daemonRev, userB] }, localAlerts: [] });
  assert.deepEqual(r, { list: [userA, userB], migrate: true, source: 'legacy' });
});

test('resolvePriceAlerts：舊文件存在但沒有使用者項目＝仍要寫一份空的（遷移標記）', () => {
  const r = resolvePriceAlerts({ priceDoc: null, legacyDoc: { alerts: [daemonStop] }, localAlerts: [userA] });
  assert.deepEqual(r, { list: [], migrate: true, source: 'legacy' });
});

test('resolvePriceAlerts：舊文件也不存在＝取本機（firebase-sync 已套擁有者規則）', () => {
  const r = resolvePriceAlerts({ priceDoc: null, legacyDoc: null, localAlerts: [userA, daemonStop] });
  assert.deepEqual(r, { list: [userA], migrate: true, source: 'local' });
});

test('applyPriceAlertOp add：附加在尾端；重複 id 或非使用者格式不動', () => {
  const nu = { id: 'a-3', code: '2454', name: '聯發科', type: 'PRICE_BELOW', value: 1000, triggered: false, createdAt: 3 };
  assert.deepEqual(applyPriceAlertOp([userA], { kind: 'add', item: nu }), { list: [userA, nu], changed: true });
  assert.deepEqual(applyPriceAlertOp([userA], { kind: 'add', item: { ...userA } }), { list: [userA], changed: false });
  assert.deepEqual(applyPriceAlertOp([userA], { kind: 'add', item: daemonStop }), { list: [userA], changed: false });
});

test('applyPriceAlertOp remove：只移除該 id；不存在的 id 不算變更', () => {
  assert.deepEqual(applyPriceAlertOp([userA, userB], { kind: 'remove', id: 'a-1' }), { list: [userB], changed: true });
  assert.deepEqual(applyPriceAlertOp([userA, userB], { kind: 'remove', id: 'nope' }), { list: [userA, userB], changed: false });
});

test('applyPriceAlertOp trigger：只改該 id、已觸發不重寫、不改動原物件', () => {
  const r = applyPriceAlertOp([userA, userB], { kind: 'trigger', id: 'a-1' });
  assert.equal(r.changed, true);
  assert.deepEqual(r.list, [{ ...userA, triggered: true }, userB]);
  assert.equal(userA.triggered, false, '輸入物件不可被改動');
  assert.deepEqual(applyPriceAlertOp([userB], { kind: 'trigger', id: 'a-2' }), { list: [userB], changed: false });
  assert.deepEqual(applyPriceAlertOp([userA], { kind: 'trigger', id: '' }), { list: [userA], changed: false });
  assert.deepEqual(applyPriceAlertOp([userA], { kind: 'bogus', id: 'a-1' }), { list: [userA], changed: false });
});

test('H3 重現：觸價後只寫 priceAlerts——daemon 在登入後寫入的停損警示不再被抹掉', () => {
  // 登入時 store 讀到的舊陣列（遷移前）：使用者 A＋一則舊 daemon 警示
  const legacyAtLogin = [userA, daemonRev];
  // 之後 daemon 在舊文件前面接上新的停損警示
  const legacyNow = [daemonStop, ...legacyAtLogin];
  // 觸價：新做法只在 priceAlerts 上改單一 id
  const migrated = resolvePriceAlerts({ priceDoc: null, legacyDoc: { alerts: legacyNow }, localAlerts: legacyAtLogin });
  const after = applyPriceAlertOp(migrated.list, { kind: 'trigger', id: 'a-1' });
  assert.deepEqual(after.list, [{ ...userA, triggered: true }]);
  assert.ok(after.list.every(isUserPriceAlert), 'priceAlerts 只會有使用者格式');
  // 舊文件不被前端改寫 ⇒ daemon 停損警示仍在
  assert.deepEqual(legacyNow, [daemonStop, userA, daemonRev]);
});

test('stripUserPriceAlerts：舊文件只移除使用者價位警示，daemon 警示與 ack 原封保留、順序不變', () => {
  const acked = { ...daemonRev, ack: 7, ackVia: 'telegram' };
  const legacy = { updatedAt: 9, alerts: [daemonStop, userA, acked, userB] };
  const out = stripUserPriceAlerts(legacy);
  assert.deepEqual(out, [daemonStop, acked]);
  assert.equal(out[1], acked, 'daemon 項目原物件照搬');
  assert.equal(legacy.alerts.length, 4, '輸入文件不可被改動');
});

test('stripUserPriceAlerts：沒有要移除的＝null（不寫入）；文件或陣列缺漏也回 null', () => {
  assert.equal(stripUserPriceAlerts({ alerts: [daemonStop, daemonRev] }), null);
  assert.equal(stripUserPriceAlerts({ alerts: [] }), null);
  assert.equal(stripUserPriceAlerts({ updatedAt: 1 }), null);
  assert.equal(stripUserPriceAlerts(null), null);
  assert.deepEqual(stripUserPriceAlerts({ alerts: [userA] }), [], '只剩使用者項目＝清成空陣列');
});

test('H3 端到端：遷移＋清理後，舊文件不再有過期的 triggered:false 副本，priceAlerts 是唯一真相', () => {
  const legacy = { alerts: [daemonStop, userA, daemonRev] };
  const r = resolvePriceAlerts({ priceDoc: null, legacyDoc: legacy, localAlerts: [] });
  const priceAfter = applyPriceAlertOp(r.list, { kind: 'trigger', id: 'a-1' }).list;
  const legacyAfter = stripUserPriceAlerts(legacy);
  assert.deepEqual(priceAfter, [{ ...userA, triggered: true }]);
  assert.deepEqual(legacyAfter, [daemonStop, daemonRev]);
  assert.ok(!pickUserPriceAlerts(legacyAfter).length, '下次登入 firebase-sync 從舊文件載入時不會再出現價位警示');
  // 遷移後舊文件又出現價位警示（舊版分頁回寫）：priceAlerts 說了算，舊的只清不回併
  const later = resolvePriceAlerts({ priceDoc: { alerts: priceAfter }, legacyDoc: { alerts: [userA, daemonStop] }, localAlerts: [] });
  assert.deepEqual(later.list, priceAfter);
  assert.equal(later.migrate, false);
  assert.deepEqual(stripUserPriceAlerts({ alerts: [userA, daemonStop] }), [daemonStop]);
});

test('withPriceAlerts：價位警示換成雲端清單，daemon 項目原樣保留在後（即時追蹤 🔔 行為不變）', () => {
  const stale = { ...userA, triggered: false };
  const store = [daemonStop, stale, daemonRev];               // firebase-sync 從舊文件載入的內容
  const cloud = [{ ...userA, triggered: true }, userB];
  const out = withPriceAlerts(store, cloud);
  assert.deepEqual(out, [{ ...userA, triggered: true }, userB, daemonStop, daemonRev]);
  assert.equal(out.filter(isUserPriceAlert).length, 2, '舊的價位警示副本不會殘留');
  assert.deepEqual(new Set(out.map((a) => a.code)), new Set(['2330', '2317', '3008', undefined]));
  assert.deepEqual(withPriceAlerts(undefined, [userA]), [userA]);
  assert.deepEqual(withPriceAlerts([daemonStop], undefined), [daemonStop]);
});

test('ackAlertIn：只改該 id；已確認的不覆寫；其他 daemon 警示原封不動', () => {
  const list = [daemonStop, daemonRev, { id: 'x', ack: 5, ackVia: 'telegram' }];
  const r = ackAlertIn(list, 'rev:2026-10-05:up', 100, 'web');
  assert.equal(r.changed, true);
  assert.deepEqual(r.list[1], { ...daemonRev, ack: 100, ackVia: 'web' });
  assert.equal(r.list[0], daemonStop);
  assert.equal(daemonRev.ack, undefined, '輸入物件不可被改動');
  assert.deepEqual(ackAlertIn(list, 'x', 200, 'web'), { list, changed: false });
  assert.deepEqual(ackAlertIn(list, 'missing', 200, 'web').changed, false);
  assert.deepEqual(ackAlertIn(undefined, 'x', 1, 'web'), { list: [], changed: false });
});
