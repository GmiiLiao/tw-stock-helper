// 本機資料讀取（交易日、休市日、各日股票／ETF／券商清單、官方鏡像）單元測試：node --test scripts/finmind/localdata.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createLocalData, rocToIso } from './localdata.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fm-local-'));
  const backup = join(root, 'backup'); const official = join(root, 'official'); const finmind = join(root, 'finmind');
  mkdirSync(join(backup, 'chipArchive'), { recursive: true });
  const chip = (date, close, extra = {}) => writeFileSync(join(backup, 'chipArchive', `${date}.json`), JSON.stringify({ date, closeJson: JSON.stringify(close), ...extra }));
  chip('2023-01-03', { 2330: [450, 20000, 446, 453, 443], 6129: [20, 0, 20, 20, 20], 2603: [150, 30000, 149, 151, 148] });
  chip('2023-01-04', { 2330: [449, 15000, 450, 451, 445] });
  chip('2023-01-05', {});   // 空殼（沒有收盤）不算交易日
  writeFileSync(join(backup, 'chipArchive', 'notes.txt'), 'x');
  const mirror = (host, id, date, payload) => {
    const dir = join(official, host, id); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${date}.json.gz`), gzipSync(JSON.stringify({ meta: { echo: date }, payload })));
  };
  mirror('openapi.twse.com.tw', 'twse_oa_holidaySchedule_holidaySchedule', '2026-10-02', [
    { Name: '國慶日', Date: '1151009', Description: '' },
    { Name: '國曆新年開始交易日', Date: '1150102', Description: '' },
    { Name: '市場無交易，僅辦理結算交割作業', Date: '1150212', Description: '' },
  ]);
  mirror('www.twse.com.tw', 'twse_mi_index', '2023-01-03', { tables: [{ title: '每日收盤行情(全部)', fields: ['證券代號', '證券名稱', '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價'],
    data: [['0050', '元大台灣50', '1,000,000', '1', '1', '110.00', '111.00', '109.00', '110.50'], ['2330', '台積電', '20,000,123', '1', '1', '446.00', '453.00', '443.00', '450.00'], ['00632R', '反1', '0', '0', '0', '--', '--', '--', '--']] }] });
  mirror('www.tpex.org.tw', 'tpex_dailyquotes', '2023-01-03', { tables: [{ title: '上櫃股票行情', fields: ['代號', '名稱', '收盤', '漲跌', '開盤', '最高', '最低', '均價', '成交股數', '成交金額(元)', '成交筆數', '最後買價', '最後買量(張數)', '最後賣價', '最後賣量(張數)', '發行股數', '次日 參考價', '次日 漲停價', '次日 跌停價'],
    data: [['006201', '元大富櫃50', '15.00', '+0.1', '14.9', '15.1', '14.8', '15', '200,000', '1', '1', '1', '1', '1', '1', '10,000,000', '15.00', '16.50', '13.50'], ['6129', '普誠', '20.00', '0', '20', '20', '20', '20', '0', '0', '0', '1', '1', '1', '1', '50,000,000', '20.00', '22.00', '18.00']] }] });
  mkdirSync(join(finmind, 'TaiwanSecuritiesTraderInfo'), { recursive: true });
  const brokers = [{ securities_trader_id: '1020', date: '1990-01-01' }, { securities_trader_id: '9A00', date: '2023-01-04' }];
  writeFileSync(join(finmind, 'TaiwanSecuritiesTraderInfo', 'snapshot_2026-10-08.jsonl.gz'), gzipSync(brokers.map(b => JSON.stringify(b)).join('\n') + '\n'));
  return { backup, official, finmind };
}

test('rocToIso：民國 7 碼轉西元', () => {
  assert.equal(rocToIso('1151009'), '2026-10-09');
  assert.equal(rocToIso('bad'), null);
});

test('tradingDays：取 chipArchive 有收盤的日子（空殼與非日期檔不算）', () => {
  const ld = createLocalData(fixture());
  assert.deepEqual(ld.tradingDays(), ['2023-01-03', '2023-01-04']);
});

test('holidays：讀休市表，「開始交易／最後交易」是交易日標記不是休市；「僅辦理結算交割」是休市', () => {
  const ld = createLocalData(fixture());
  const h = ld.holidays();
  assert.ok(h.has('2026-10-09')); assert.ok(h.has('2026-02-12')); assert.ok(!h.has('2026-01-02'));
});

test('stocksFor：當日 4 碼股票、成交量>0、依量由大到小；沒有收盤資料回 null', () => {
  const ld = createLocalData(fixture());
  assert.deepEqual(ld.stocksFor('2023-01-03'), ['2603', '2330']);
  assert.equal(ld.stocksFor('2023-02-01'), null);
});

test('etfsFor：官方鏡像上市＋上櫃收盤行情的 00 開頭代號、有成交才算', () => {
  const ld = createLocalData(fixture());
  assert.deepEqual(ld.etfsFor('2023-01-03'), ['0050', '006201']);
  assert.equal(ld.etfsFor('2023-02-01'), null);
});

test('officialQuotes：上市（MI_INDEX）＋上櫃（dailyQuotes）的股數與價格，含發行股數', () => {
  const ld = createLocalData(fixture());
  const q = ld.officialQuotes('2023-01-03');
  assert.equal(q.get('2330').shares, 20000123); assert.equal(q.get('2330').close, 450); assert.equal(q.get('2330').market, 'tse');
  assert.equal(q.get('6129').issued, 50000000); assert.equal(q.get('6129').market, 'otc');
  assert.equal(q.get('6129').nextUp, 22);
  assert.equal(q.get('00632R').close, null, '「--」不可轉成 0');
});

test('brokersFor：證券商清單快照全部券商，不可用 date 欄過濾（2026-10-08 試抓實測：date 不是設立日）', () => {
  // 實測：聯邦 8580～8588 在清單上 date=2026-05-04，但 2023-03-15、2024-12-23 都有分點成交；凱基-天母理財 921F date=2025-02-10、2023-03-15 有成交
  // ⇒ 依 date 過濾會讓券商路線安靜地漏掉這些券商（漏量 <5%，整日比對的容許範圍內看不出來）
  const ld = createLocalData(fixture());
  assert.deepEqual(ld.brokersFor('2023-01-03'), ['1020', '9A00']);
  assert.deepEqual(ld.brokersFor('2023-01-04'), ['1020', '9A00']);
});

test('closeFor：chipArchive 收盤 [收,量(張),開,高,低]', () => {
  const ld = createLocalData(fixture());
  assert.deepEqual(ld.closeFor('2023-01-03').get('2330'), { close: 450, lots: 20000, open: 446, high: 453, low: 443 });
});

test('stocksFor／etfsFor：chipArchive 與官方鏡像沒有的日子（2022-07-18 以前·空閒佇列）退回已下載的 FinMind 還原股價（量>0、依量排序）', () => {
  const f = fixture();
  const dir = join(f.finmind, 'TaiwanStockPriceAdj', '2019'); mkdirSync(dir, { recursive: true });
  const rows = [{ date: '2019-06-03', stock_id: '2330', Trading_Volume: 30000000 }, { date: '2019-06-03', stock_id: '2603', Trading_Volume: 50000000 },
    { date: '2019-06-03', stock_id: '1101', Trading_Volume: 0 }, { date: '2019-06-03', stock_id: '0050', Trading_Volume: 9000000 }, { date: '2019-06-03', stock_id: '00632R', Trading_Volume: 12000000 },
    { date: '2019-06-03', stock_id: '1101B', Trading_Volume: 1000 }];
  writeFileSync(join(dir, '2019-06-03.jsonl.gz'), gzipSync(rows.map(r => JSON.stringify(r)).join('\n') + '\n'));
  const ld = createLocalData(f);
  assert.deepEqual(ld.stocksFor('2019-06-03'), ['2603', '2330', '0050']);
  assert.deepEqual(ld.etfsFor('2019-06-03'), ['00632R', '0050']);
  assert.equal(ld.stocksFor('2019-06-04'), null, '兩邊都沒有 ⇒ null（計畫標「該日沒有代號清單」）');
  assert.deepEqual(ld.stocksFor('2023-01-03'), ['2603', '2330'], '有 chipArchive 的日子照舊用官方收盤');
});
