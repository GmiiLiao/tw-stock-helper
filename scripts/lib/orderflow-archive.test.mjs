// node --test scripts/lib/orderflow-archive.test.mjs
//   委託失衡歸檔的 digest（2026-10-07 原樣搬移）與 O8 openMarks（同一份 MI_5MINS 回應順便產出，不增加請求）。
//   本機有 10/02 官方鏡像（openapi 原始檔）與 orderFlowArchive 備份時，拿真實 3,241 列做回歸；沒有就略過那一例。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { digest, openMarksTotalsMatch, openMarksFromResponse, dayDocPayload } from './orderflow-archive.mjs';
import { BASIS, MI5_URL } from './open-sensor-marks.mjs';

const SB = fileURLToPath(new URL('../../second-brain', import.meta.url));
const MI5_1002 = `${SB}/official/openapi.twse.com.tw/twse_oa_exchangeReport_MI_5MINS/2026-10-02.json.gz`;
const OF_1002 = `${SB}/backup/orderFlowArchive/2026-10-02.json`;

// rwd 實際欄位順序（digest 依位置讀；parseMi5 依欄名讀）
const FIELDS = ['時間', '累積委託買進筆數', '累積委託買進數量', '累積委託賣出筆數', '累積委託賣出數量', '累積成交筆數', '累積成交數量', '累積成交金額'];
const row = (t, tx, lots, valM, book = ['1,000', '5,000', '900', '4,000']) => [t, ...book, tx, lots, valM];
const resp = (over = {}) => ({
  stat: 'OK', date: '20261005', title: '115年10月05日每5秒委託成交統計', fields: FIELDS,
  data: [
    row('09:00:00', '', '', ''),
    row('09:00:05', '26,016', '76,394', '16,806'),
    row('09:02:00', '137,147', '422,600', '62,155'),
    row('09:30:00', '700,000', '2,500,000', '230,000'),
    row('10:00:00', '1,286,912', '4,854,888', '415,835'),
    row('13:00:00', '2,700,000', '10,000,000', '820,000', ['2,000', '9,000', '1,500', '6,000']),
    row('13:25:00', '2,800,000', '10,400,000', '850,000', ['2,100', '9,500', '1,600', '6,500']),
    row('13:30:00', '2,906,928', '10,892,014', '1,150,804', ['1,800', '7,000', '1,400', '5,000']),
  ],
  ...over,
});

/** Firestore 不允許巢狀陣列（陣列裡放陣列）；物件裡的陣列可以 */
function hasNestedArray(v, inArray = false) {
  if (Array.isArray(v)) return inArray || v.some(x => hasNestedArray(x, true));
  if (v && typeof v === 'object') return Object.values(v).some(x => hasNestedArray(x, false));
  return false;
}

test('openMarksFromResponse：同一份回應 → openSensorMarks-v1，帶 src／echo，全日三值＝digest', () => {
  const j = resp();
  const dg = digest(j.data);
  const url = MI5_URL('20261005');
  const r = openMarksFromResponse(j, '2026-10-05', dg, { src: url });
  assert.equal(r.reason, null);
  const om = r.openMarks;
  assert.equal(om.basis, BASIS);
  assert.equal(om.src, url);
  assert.equal(om.echo, '2026-10-05');
  assert.equal(om.complete, true);
  assert.deepEqual(om.day, { t: '13:30:00', yi: 11508.04, lots: 10892014, tx: 2906928 });
  assert.equal(om.marks.m0902.yi, 621.55);
  assert.equal(om.auction.t, '09:00:05');
  assert.equal(hasNestedArray(om), false, 'openMarks 不可有巢狀陣列（Firestore 會拒寫）');
  assert.equal(typeof om.minJson, 'string');
});

test('openMarksTotalsMatch：百萬元→億元換算後三值全等才 true（浮點不誤判）', () => {
  const dg = { tradeValue: 1150804, tradeVol: 10892014, trans: 2906928 };
  assert.equal(openMarksTotalsMatch({ day: { yi: 11508.04, lots: 10892014, tx: 2906928 } }, dg), true);
  assert.equal(openMarksTotalsMatch({ day: { yi: 11508.05, lots: 10892014, tx: 2906928 } }, dg), false);
  assert.equal(openMarksTotalsMatch({ day: { yi: 11508.04, lots: 10892013, tx: 2906928 } }, dg), false);
  assert.equal(openMarksTotalsMatch({ day: { yi: 11508.04, lots: 10892014, tx: 2906929 } }, dg), false);
  assert.equal(openMarksTotalsMatch(null, dg), false);
  assert.equal(openMarksTotalsMatch({ day: { yi: 1, lots: 1, tx: 1 } }, null), false);
});

test('openMarks 與 digest 三值不一致時不寫 openMarks（回 null 附原因，不丟錯）', () => {
  const j = resp();
  const dg = { ...digest(j.data), tradeValue: 1150805 };
  const r = openMarksFromResponse(j, '2026-10-05', dg);
  assert.equal(r.openMarks, null);
  assert.match(r.reason, /不一致/);
});

test('欄位順序被調換：digest（依位置）與 parseMi5（依欄名）讀到不同欄 ⇒ 不寫 openMarks', () => {
  const swapped = [...FIELDS]; [swapped[6], swapped[7]] = [swapped[7], swapped[6]];   // 量、金額的欄名互換、資料不動
  const j = resp({ fields: swapped });
  const r = openMarksFromResponse(j, '2026-10-05', digest(j.data));
  assert.equal(r.openMarks, null);
  assert.match(r.reason, /不一致/);
});

test('回音不符（別日標題、頂層 date 不符、標題無日期）⇒ 不寫 openMarks', () => {
  for (const over of [{ title: '115年10月02日每5秒委託成交統計', date: undefined }, { date: '20261002' }, { title: '每5秒委託成交統計' }]) {
    const j = resp(over);
    const r = openMarksFromResponse(j, '2026-10-05', digest(j.data));
    assert.equal(r.openMarks, null, JSON.stringify(over));
    assert.match(r.reason, /回音不符/);
  }
});

test('未收盤（最後成交列 < 13:30:00）⇒ 不寫 openMarks（占比分母不是全日）', () => {
  const j = resp(); j.data = j.data.slice(0, 5);   // 停在 10:00:00
  const r = openMarksFromResponse(j, '2026-10-05', digest(j.data));
  assert.equal(r.openMarks, null);
  assert.match(r.reason, /未收盤/);
});

test('壞回應（沒有 fields、缺欄、沒有成交列）回 null 附原因，絕不丟錯', () => {
  const cases = [
    resp({ fields: undefined }),
    resp({ fields: FIELDS.slice(0, 6) }),
    resp({ data: [row('09:00:00', '', '', '')] }),
    null,
  ];
  for (const j of cases) {
    const dg = j?.data ? digest(j.data) : null;
    let r;
    assert.doesNotThrow(() => { r = openMarksFromResponse(j, '2026-10-05', dg); });
    assert.equal(r.openMarks, null);
    assert.ok(r.reason);
  }
});

test('dayDocPayload：沒有 digest 不寫（不建空殼）；openMarks 為 null 時不帶該鍵；clearSkipped 有給才帶', () => {
  assert.equal(dayDocPayload({ iso: '2026-10-05', dg: null, openMarks: { basis: BASIS }, fetchedAt: 1 }), null);
  const dg = digest(resp().data);
  const p0 = dayDocPayload({ iso: '2026-10-05', dg, openMarks: null, fetchedAt: 1 });
  assert.equal('openMarks' in p0, false);
  assert.equal('skipped' in p0, false);
  assert.equal(p0.date, '2026-10-05');
  assert.equal(p0.fetchedAt, 1);
  assert.equal(p0.curveJson, dg.curveJson);
  const DEL = Symbol('delete');
  const p1 = dayDocPayload({ iso: '2026-10-05', dg, openMarks: { basis: BASIS }, fetchedAt: 2, clearSkipped: DEL });
  assert.deepEqual(p1.openMarks, { basis: BASIS });
  assert.equal(p1.skipped, DEL);
  // 既有欄位（digest）一個都不少
  for (const k of Object.keys(dg)) assert.equal(p1[k], dg[k], k);
});

test('本機 10/02 真實 3,241 列：digest 與歸檔逐欄相同（搬移不改行為）、openMarks 與回補版相同', { skip: !(existsSync(MI5_1002) && existsSync(OF_1002)) && '本機沒有 10/02 鏡像或備份' }, () => {
  const j = JSON.parse(gunzipSync(readFileSync(MI5_1002)).toString('utf8'));
  const t = s => `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
  const rows = j.payload.map(r => [t(r.Time), r.AccBidOrders, r.AccBidVolume, r.AccAskOrders, r.AccAskVolume, r.AccTransaction, r.AccTradeVolume, r.AccTradeValue]);
  const of = JSON.parse(readFileSync(OF_1002, 'utf8'));
  const dg = digest(rows);
  for (const k of Object.keys(dg)) assert.deepEqual(dg[k], of[k], `digest.${k}`);
  const r = openMarksFromResponse({ stat: 'OK', date: '20261002', title: '115年10月02日每5秒委託成交統計', fields: FIELDS, data: rows }, '2026-10-02', dg);
  assert.equal(r.reason, null);
  if (of.openMarks) {
    const strip = o => { const c = { ...o }; for (const k of ['src', 'echo', 'backfilledAt']) delete c[k]; return c; };
    assert.deepEqual(strip(r.openMarks), strip(of.openMarks));
  }
});
