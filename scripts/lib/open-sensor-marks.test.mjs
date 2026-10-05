// 開盤感應器衍生值（scripts/lib/open-sensor-marks.mjs）：解析、回音驗證、HTTP 分類、檢查點與指數摘要。
//   本機 10/02 MI_5MINS（官方鏡像 openapi 原始檔）存在時拿來當真實樣本；不存在就略過那幾例（不複製原始檔進 repo）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as M from './open-sensor-marks.mjs';

const SB = fileURLToPath(new URL('../../second-brain', import.meta.url));
const MI5_1002 = `${SB}/official/openapi.twse.com.tw/twse_oa_exchangeReport_MI_5MINS/2026-10-02.json.gz`;
const OF_1002 = `${SB}/backup/orderFlowArchive/2026-10-02.json`;

const MI5_FIELDS = ['時間', '累積委託買進筆數', '累積委託買進數量', '累積委託賣出筆數', '累積委託賣出數量', '累積成交筆數', '累積成交數量', '累積成交金額'];
const mi5Row = (t, tx, lots, valM) => [t, '1', '1', '1', '1', tx, lots, valM];
const mi5Json = (over = {}) => ({
  stat: 'OK', date: '20261005', title: '115年10月05日每5秒委託成交統計', fields: MI5_FIELDS,   // 實際標題沒有空白（10/05 實測）
  data: [
    mi5Row('09:00:00', '', '', ''),
    mi5Row('09:00:05', '26,016', '76,394', '16,806'),
    mi5Row('09:01:55', '90,000', '280,000', '46,000'),
    mi5Row('09:02:00', '137,147', '422,600', '62,155'),
    mi5Row('09:02:05', '140,000', '430,000', '63,000'),
    mi5Row('10:00:00', '1,286,912', '4,854,888', '415,835'),
    mi5Row('13:30:00', '2,906,928', '10,892,014', '898,174'),
  ],
  ...over,
});

test('normTime／rocTitleIso：兩種時間格式與民國標題', () => {
  assert.equal(M.normTime('09:00:05'), '09:00:05');
  assert.equal(M.normTime('090005'), '09:00:05');
  assert.equal(M.normTime('9:00:05'), '09:00:05');
  assert.equal(M.normTime('合計'), null);
  assert.equal(M.rocTitleIso('115年10月02日 每5秒委託成交統計'), '2026-10-02');
  assert.equal(M.rocTitleIso('115年7月9日 每5秒指數盤後統計'), '2026-07-09');
  assert.equal(M.rocTitleIso('每5秒委託成交統計'), null);
});

test('echoCheck：title 民國日期＝請求日才算過；date 欄不符、title 無日期、別日都擋', () => {
  assert.deepEqual(M.echoCheck(mi5Json(), '2026-10-05'), { ok: true, status: 'ok', echo: '2026-10-05' });
  assert.equal(M.echoCheck(mi5Json({ date: '20261002' }), '2026-10-05').status, 'mismatch');
  const other = M.echoCheck(mi5Json({ date: undefined, title: '115年10月02日 每5秒委託成交統計' }), '2026-10-05');
  assert.equal(other.ok, false); assert.equal(other.status, 'mismatch'); assert.equal(other.echo, '2026-10-02');
  assert.equal(M.echoCheck(mi5Json({ title: '每5秒委託成交統計' }), '2026-10-05').status, 'mismatch');
  assert.equal(M.echoCheck({ stat: '很抱歉，沒有符合條件的資料!' }, '2026-10-05').status, 'empty');
  assert.equal(M.echoCheck({ stat: 'ERROR' }, '2026-10-05').status, 'bad');
  assert.equal(M.echoCheck(null, '2026-10-05').status, 'bad');
  // 多表格式（tables[0].title）也認
  const tj = { stat: 'OK', tables: [{ title: '115年10月05日 每5秒指數盤後統計', fields: ['時間'], data: [] }] };
  assert.equal(M.echoCheck(tj, '2026-10-05').ok, true);
});

test('httpVerdict：307／429／403／30x 與封鎖頁＝整批停；5xx＝單筆失敗；200＝ok', () => {
  for (const s of [307, 429, 403, 302, 401]) assert.equal(M.httpVerdict(s, '').kind, 'stop', `HTTP ${s}`);
  assert.equal(M.httpVerdict(503, '').kind, 'fail');
  assert.equal(M.httpVerdict(404, '').kind, 'fail');
  assert.equal(M.httpVerdict(200, '{"stat":"OK"}').kind, 'ok');
  assert.equal(M.httpVerdict(200, '<html>因為安全性考量，您的連線已被暫停</html>').kind, 'stop');
});

test('parseMi5：依欄名取成交筆數／數量／金額；欄位缺就丟錯（不猜位置）', () => {
  const rows = M.parseMi5(mi5Json());
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[1], { t: '09:00:05', tx: 26016, lots: 76394, valM: 16806 });
  assert.deepEqual(rows[0], { t: '09:00:00', tx: null, lots: null, valM: null });
  assert.throws(() => M.parseMi5(mi5Json({ fields: MI5_FIELDS.slice(0, 7) })), /累積成交金額/);
  assert.throws(() => M.parseMi5({ stat: 'OK' }), /沒有表格/);
});

test('deriveOpenMarks：競價列、檢查點取 ≤T 最後一列、占全日比例、億元換算、每分鐘序列', () => {
  const om = M.deriveOpenMarks(M.parseMi5(mi5Json()));
  assert.equal(om.auction.t, '09:00:05');
  assert.equal(om.auction.yi, 168.06);                       // 16,806 百萬元 = 168.06 億
  assert.equal(om.marks.m0902.t, '09:02:00');                // 09:02:05 不可進 09:02 檢查點
  assert.equal(om.marks.m0902.yi, 621.55);
  assert.equal(om.marks.m0902.pctYi, +(62155 / 898174).toFixed(5));
  assert.equal(om.marks.m0901.t, '09:00:05');                // 09:01:00 以前最後一筆有成交的列
  assert.equal(om.marks.m0905.t, '09:02:05');
  assert.deepEqual(om.day, { t: '13:30:00', yi: 8981.74, lots: 10892014, tx: 2906928 });
  assert.equal(om.complete, true);
  assert.equal(om.nonMonotone, 0);
  const min = JSON.parse(om.minJson);
  assert.equal(min.length, 61);
  assert.deepEqual(min[0], ['09:00', null, null, null]);     // 09:00:00 尚無成交，不補 0
  assert.deepEqual(min[2], ['09:02', 621.55, 422600, 137147]);
  assert.deepEqual(min[60], ['10:00', 4158.35, 4854888, 1286912]);
  // Firestore 不收巢狀陣列：除了 JSON 字串以外不可出現陣列
  const hasArray = o => Object.values(o).some(v => Array.isArray(v) || (v && typeof v === 'object' && hasArray(v)));
  assert.equal(hasArray(om), false);
});

test('deriveOpenMarks：累積值下降要計數；沒有成交列丟錯', () => {
  const j = mi5Json();
  j.data.splice(5, 0, mi5Row('09:30:00', '100', '100', '100'));
  assert.equal(M.deriveOpenMarks(M.parseMi5(j)).nonMonotone, 1);
  assert.throws(() => M.deriveOpenMarks([{ t: '09:00:00', tx: null, lots: null, valM: null }]), /沒有成交列/);
});

test('本機 10/02 MI_5MINS（openapi 鏡像檔）：全日值與 orderFlowArchive 一致、09:02 占比 6.92%、競價 1.87%', { skip: !existsSync(MI5_1002) && '本機沒有 10/02 鏡像檔' }, () => {
  const j = JSON.parse(gunzipSync(readFileSync(MI5_1002)).toString('utf8'));
  const om = M.deriveOpenMarks(M.parseMi5OpenApi(j.payload));
  assert.equal(om.n, 3241);
  assert.equal(om.auction.t, '09:00:05');
  assert.equal(om.marks.m0902.pctYi.toFixed(4), '0.0692');
  assert.equal(om.auction.pctYi.toFixed(4), '0.0187');
  if (existsSync(OF_1002)) {
    const of = JSON.parse(readFileSync(OF_1002, 'utf8'));
    assert.equal(om.day.yi, of.tradeValue / 100);
    assert.equal(om.day.lots, of.tradeVol);
    assert.equal(om.day.tx, of.trans);
  }
});

// 實際格式（10/05 實測）：09:00:00 列＝昨收、09:00:05 列＝官方開盤；標題「115年10月05日 每5秒指數統計」
const IDX_FIELDS = ['時間', '發行量加權股價指數', '未含金融保險股指數', '未含電子股指數', '未含金融電子股指數', '水泥類指數', '電子類指數', '半導體類指數', '金融保險類指數'];
const ir = (t, v) => [t, v, '1', '2', '3', '4', '5', '6', '7'];
const idxJson = () => ({
  stat: 'OK', date: '20261005', title: '115年10月05日 每5秒指數統計', fields: IDX_FIELDS,
  data: [
    ir('09:00:00', '48,475.74'), ir('09:00:05', '48,574.95'), ir('09:01:55', '49,500.00'), ir('09:02:00', '49,600.00'),
    ir('09:02:05', '49,700.00'), ir('09:30:00', '49,800.00'), ir('10:00:00', '49,650.00'), ir('11:00:00', '49,900.00'), ir('13:30:00', '49,735.12'),
  ],
});

test('parseIndex：依欄名挑加權與類股；沒有加權就丟錯', () => {
  const p = M.parseIndex(idxJson());
  assert.deepEqual(p.keys, ['taiex', 'exFin', 'exElec', 'exFinElec', 'elec', 'semi', 'fin']);
  assert.equal(p.rows.length, 9);
  assert.equal(p.rows[1].v.taiex, 48574.95);
  assert.throws(() => M.parseIndex({ ...idxJson(), fields: ['時間', '水泥類指數'] }), /發行量加權股價指數/);
});

test('deriveIndexMarks：09:00:00＝昨收列、09:00:05＝官方開盤、E＝首個 ≥09:02:00、高低不含昨收列', () => {
  const im = M.deriveIndexMarks(M.parseIndex(idxJson()));
  assert.equal(im.basis, M.INDEX_BASIS);
  assert.deepEqual(im.ref0900, { t: '09:00:00', v: 48475.74 });
  assert.deepEqual(im.open, { t: '09:00:05', v: 48574.95 });
  assert.deepEqual(im.e, { t: '09:02:00', v: 49600 });
  assert.deepEqual(im.taiex.m0900, { t: '09:00:00', v: 48475.74 });
  assert.deepEqual(im.taiex.m090005, { t: '09:00:05', v: 48574.95 });
  assert.deepEqual(im.taiex.m0902, { t: '09:02:00', v: 49600 });
  assert.deepEqual(im.hl0901, { hi: 49800, hiT: '09:30:00', lo: 49500, loT: '09:01:55' });
  assert.deepEqual(im.hlDay, { hi: 49900, hiT: '11:00:00', lo: 48574.95, loT: '09:00:05' });
  assert.deepEqual(im.close, { t: '13:30:00', v: 49735.12 });
  assert.equal(im.others.semi.m0902, 6);
  assert.equal(im.others.semi.m090005, 6);
  assert.equal(im.others.semi.close, 6);
  assert.equal(JSON.parse(im.minJson).length, 61);
});

test('enrichIndex：昨收算出官方開盤／E 漲跌%、失真 pp、昨收回音與收盤交叉驗證；不改輸入', () => {
  const im = M.deriveIndexMarks(M.parseIndex(idxJson()));
  const en = M.enrichIndex(im, { prevClose: 48475.74, prevSrc: 'mi_index:2026-10-02', closeOfficial: 49735.12 });
  assert.equal(en.officialOpen.pct, +((48574.95 / 48475.74 - 1) * 100).toFixed(3));
  assert.equal(en.ePct, +((49600 / 48475.74 - 1) * 100).toFixed(3));
  assert.equal(en.distortPp, +(en.ePct - en.officialOpen.pct).toFixed(3));
  assert.equal(en.closeMatch, true);
  assert.equal(en.refMatch, true);
  assert.equal(M.enrichIndex(im, { prevClose: 48400 }).refMatch, false);
  assert.equal(en.openIsDayLow, true);
  assert.equal(en.openIsDayHigh, false);
  assert.equal(im.prevClose, undefined);
  const none = M.enrichIndex(im, {});
  assert.equal(none.ePct, null); assert.equal(none.distortPp, null); assert.equal(none.closeMatch, null); assert.equal(none.refMatch, null);
});

test('taiexFromMiIndex：收盤與帶號漲跌點（HTML 正負號）', () => {
  const tbl = sign => ({ tables: [{ title: '價格指數(臺灣證券交易所)', fields: [], data: [
    ['寶島股價指數', '53,820.56', "<p style ='color:red'>+</p>", '197.60', '0.37', ''],
    ['發行量加權股價指數', '48,475.74', sign, '122.25', '0.25', ''],
  ] }] });
  assert.deepEqual(M.taiexFromMiIndex(tbl("<p style ='color:red'>+</p>")), { close: 48475.74, chg: 122.25 });
  assert.deepEqual(M.taiexFromMiIndex(tbl("<p style ='color:green'>-</p>")), { close: 48475.74, chg: -122.25 });
  assert.equal(M.taiexFromMiIndex({ tables: [] }), null);
});

test('tradingDaysBack／prevTradingDay：扣週末與休市日', () => {
  const holidays = new Set(['2026-09-25', '2026-09-28']);
  const d = M.tradingDaysBack({ end: '2026-10-05', n: 5, holidays });
  assert.deepEqual(d, ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']);
  assert.equal(M.tradingDaysBack({ end: '2026-10-05', n: 6, holidays })[0], '2026-09-24');
  assert.equal(M.prevTradingDay('2026-09-29', holidays), '2026-09-24');
  assert.equal(M.prevTradingDay('2026-10-05', holidays), '2026-10-02');
  assert.equal(M.isTradingIso('2026-10-03', holidays), false);
});
