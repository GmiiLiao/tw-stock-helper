// 開盤感應器 v2.1 盤前名單（design-v2.1 §3.2、§3.3、§8.2、§11.3）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rocToIso, sharesFromTsePayload, sharesFromOtcPayload, fullDeliveryFromPayload, splitFromPunishPayload, buildUniverse, universeDoc, universeSummary, isCommonCode } from './open-sensor-universe.mjs';

test('rocToIso：民國 7 碼、斜線、西元 8 碼', () => {
  assert.equal(rocToIso('1151003'), '2026-10-03');
  assert.equal(rocToIso('115/10/01'), '2026-10-01');
  assert.equal(rocToIso('20261002'), '2026-10-02');
  assert.equal(rocToIso('—'), null);
});

test('發行股數解析：上市 t187ap03_L、上櫃 mopsfin t187ap03_O（出表日期＝來源自報）', () => {
  const tse = sharesFromTsePayload([{ 出表日期: '1151003', 公司代號: '2330', 已發行普通股數或TDR原股發行股數: '25,932,000,000' }, { 出表日期: '1151003', 公司代號: '9105', 已發行普通股數或TDR原股發行股數: '1000' }, { 公司代號: '2881A', 已發行普通股數或TDR原股發行股數: '5' }]);
  assert.equal(tse.feedIso, '2026-10-03'); assert.equal(tse.map['2330'], 25_932_000_000); assert.equal(tse.map['2881A'], undefined);
  const otc = sharesFromOtcPayload([{ Date: '1151004', SecuritiesCompanyCode: '6488', IssueShares: '588000000' }]);
  assert.deepEqual(otc, { map: { 6488: 588_000_000 }, feedIso: '2026-10-04' });
});

test('排除名單：TWT85U 全額交割（** 為分盤）、處置公告只收期間涵蓋當日且為撮合管制者', () => {
  const fd = fullDeliveryFromPayload([{ Code: '1213', PeriodicCallAuctionTrading: '  ' }, { Code: '2314', PeriodicCallAuctionTrading: '**' }]);
  assert.deepEqual([...fd.full], ['1213', '2314']); assert.deepEqual([...fd.periodic], ['2314']);
  const punish = { fields: ['編號', '公布日期', '證券代號', '證券名稱', '累計', '處置條件', '處置起迄時間', '處置措施', '處置內容', '備註'], data: [
    [1, '115/10/01', '2030', '彰源', 1, '連續三次', '115/10/02～115/10/08', '第一次處置', '以人工管制之撮合終端機執行撮合作業（約每二分鐘撮合一次）', ''],
    [2, '115/09/20', '1101', '台泥', 1, '連續三次', '115/09/21～115/09/27', '第一次處置', '約每五分鐘撮合一次', ''],
    [3, '115/10/01', '086845', '權證', 1, '連續三次', '115/10/01～115/10/07', '第一次處置', '撮合', ''],
  ] };
  assert.deepEqual([...splitFromPunishPayload(punish, '2026-10-08')], ['2030']);
  assert.deepEqual([...splitFromPunishPayload(punish, '2026-10-09')], []);
});

function fixture() {
  const closeMap = {}, sharesTse = {}, sharesOtc = {}, marketOf = {};
  // 上市普通股 120 檔：2330 最大，其餘市值遞減；昨量奇偶交錯（≥300／<300）
  for (let i = 0; i < 120; i++) {
    const c = i === 0 ? '2330' : String(1100 + i);
    closeMap[c] = [100, i % 2 ? 250 : 5000, 100, 101, 99];
    sharesTse[c] = (i === 0 ? 1e10 : 1e9 - i * 1e6);
    marketOf[c] = 'tse';
  }
  closeMap['0050'] = [100, 70000]; marketOf['0050'] = 'tse';
  closeMap['9105'] = [8.5, 20000]; sharesTse['9105'] = 1e8; marketOf['9105'] = 'tse';
  closeMap['6488'] = [500, 3000]; sharesOtc['6488'] = 5.88e8; marketOf['6488'] = 'otc';
  return { closeMap, sharesTse, sharesOtc, marketOf };
}

test('buildUniverse：W30＝上市普通股市值前 30；流動宇宙＝非 W30、昨量 ≥300 張、排除全額交割與分盤；上櫃另列', () => {
  const f = fixture();
  const u = buildUniverse({ date: '2026-10-08', prevYmd: '2026-10-07', ...f, excl: { full: new Set(['1198']), split: new Set(['1196']), periodic: new Set() }, sharesAsOf: '2026-10-03', sharesSrc: 'mirror' });
  assert.equal(u.w30.length, 30); assert.equal(u.w30[0], '2330');
  assert.ok(!u.w30.includes('9105') && !u.w30.includes('0050'), 'TDR、ETF 不進 W30');
  assert.ok(u.liquid.every(c => !u.w30Set.has(c) && u.tse[c].lots >= 300 && isCommonCode(c)));
  assert.ok(!u.liquid.includes('1198') && !u.liquid.includes('1196'));
  assert.equal(u.excluded.fullDelivery, 1); assert.equal(u.excluded.split, 1); assert.equal(u.excluded.etf, 1); assert.equal(u.excluded.tdr, 1);
  assert.ok(u.sample.has('0050') && u.sample.has('9105') && u.sample.has('2330') && !u.sample.has('6488'), '價格樣本：上市 4 碼＋00xx');
  assert.ok(u.otc['6488'] && !u.tse['6488'], '上櫃不進一般股');
  assert.ok(Math.abs(Object.values(u.tse).reduce((s, x) => s + x.w, 0) - 100) < 1e-9);
  const sum = universeSummary(u);
  assert.equal(sum.liquidN, u.liquid.length); assert.equal(sum.liquidMinLots, 300); assert.equal(sum.otcN, 1);
  const doc = universeDoc(u, 123);
  assert.equal(doc.basis, 'openSensorUniverse-v1'); assert.equal(doc.createdAt, 123); assert.equal(doc.w30.length, 30);
  assert.equal(typeof doc.liquid.codesJson, 'string');
  assert.ok(Math.abs(doc.w30.reduce((s, x) => s + x.wPct, 0) - 100) < 0.01);
});

test('buildUniverse：上市普通股不足 100 檔視為名單不完整（丟錯，呼叫端記未判定）', () => {
  assert.throws(() => buildUniverse({ date: 'd', prevYmd: 'p', closeMap: { 2330: [1, 1] }, sharesTse: { 2330: 1 } }), /不完整/);
  assert.throws(() => buildUniverse({ date: 'd', prevYmd: 'p', closeMap: null, sharesTse: {} }), /輸入缺/);
});
