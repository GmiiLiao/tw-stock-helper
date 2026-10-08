// node --test scripts/lib/tpex-close-parse.test.mjs
// 真實夾具（tpex-close.fixture.mjs realFullFixture）：env TPEX_FIXTURE → ~/Downloads → 本機共用快取／收件匣 _done → 官方鏡像本機檔；
//   不依賴 session scratchpad。截斷檔由完整檔切出（或 env TPEX_TRUNC_FIXTURE）。OFFICIAL_ROOT＝官方鏡像根目錄（10-02 等價、季節低列數回歸）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import {
  parseTpexClose, validateTpexClose, statsOf, seedRowsOf, sharesOf, firestoreDocOf, toIso, rocOf, codes4Of, LIMITS, datedUrl,
  decodeTpexCloseDoc, isCloseLagging, splitRowsByDate, WEB_FIELDS, isThirdPartyRow, gradeTagOf, officialBarRows,
} from './tpex-close-parse.mjs';
import { synthOpenapi, realFullFixture, truncatedFixture } from './tpex-close.fixture.mjs';

const REAL = realFullFixture();
const TRUNC = truncatedFixture(REAL?.buf);
const MIRROR = process.env.OFFICIAL_ROOT || join(import.meta.dirname, '..', '..', 'second-brain', 'official');
const skipFull = REAL ? false : '本機沒有任何真實完整檔（~/Downloads、second-brain/tpex-close、官方鏡像）——略過';

const SMALL = { minRows: 5, minStocks4: 3, minCloseParse: 0.9, maxMissingVsPrev: 0.03 };

test('toIso／rocOf：民國、西元、斜線都認得', () => {
  assert.equal(toIso('1151008'), '2026-10-08');
  assert.equal(toIso('20261008'), '2026-10-08');
  assert.equal(toIso('2026/10/8'), '2026-10-08');
  assert.equal(toIso('115/10/07'), '2026-10-07');
  assert.equal(toIso('亂碼'), null);
  assert.equal(rocOf('2026-10-08'), '1151008');
  assert.equal(datedUrl('2026-10-08'), 'https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=2026%2F10%2F08&type=EW&id=&response=json');
});

test('openapi 陣列：解析、統計、驗證 ok；gzip 與 BOM 都認得', () => {
  const arr = synthOpenapi();
  for (const input of [arr, JSON.stringify(arr), gzipSync(Buffer.from(JSON.stringify(arr))), Buffer.from('﻿' + JSON.stringify(arr))]) {
    const p = parseTpexClose(input);
    assert.equal(p.format, 'openapi'); assert.equal(p.echo, '2026-10-08'); assert.equal(p.rows.length, arr.length);
    const v = validateTpexClose(p, { expect: '20261008', limits: SMALL });
    assert.equal(v.status, 'ok', v.reason);
  }
});

test('殘缺 JSON（截斷）＝invalid，不可部分使用', () => {
  const full = JSON.stringify(synthOpenapi());
  const p = parseTpexClose(full.slice(0, Math.floor(full.length * 0.6)));
  assert.equal(p.format, null); assert.match(p.error, /非完整 JSON/);
  assert.equal(validateTpexClose(p).status, 'invalid');
  assert.equal(parseTpexClose(gzipSync(Buffer.from(full)).subarray(0, 40)).format, null, '截斷的 gzip 也不能用');
  assert.match(parseTpexClose('').error, /空檔/);
});

test('錯誤資料日＝notYet（結構合格、可存在它自己的資料日下）；Date 不一致＝invalid', () => {
  const p = parseTpexClose(synthOpenapi({ roc: '1151007' }));
  const v = validateTpexClose(p, { expect: '2026-10-08', limits: SMALL });
  assert.equal(v.status, 'notYet'); assert.equal(v.dataDate, '2026-10-07'); assert.equal(v.structOk, true);
  const mixed = synthOpenapi(); mixed[1] = { ...mixed[1], Date: '1151007' };
  assert.equal(validateTpexClose(parseTpexClose(mixed), { limits: SMALL }).status, 'invalid');
});

test('筆數／4 碼／收盤可解析／重複代號／與前一份相比缺太多 ⇒ invalid', () => {
  assert.match(validateTpexClose(parseTpexClose(synthOpenapi({ n4: 2 })), { limits: SMALL }).reason, /4 碼股 2/);
  assert.match(validateTpexClose(parseTpexClose(synthOpenapi({ n4: 1, warrants: 0 })), { limits: SMALL }).reason, /總列數/);
  assert.match(validateTpexClose(parseTpexClose(synthOpenapi({ n4: 5, closeBad: 2 })), { limits: SMALL }).reason, /收盤可解析/);
  const dup = synthOpenapi(); dup.push({ ...dup[0] });
  assert.match(validateTpexClose(parseTpexClose(dup), { limits: SMALL }).reason, /重複/);
  const prev = new Set(['1100', '1101', '1102', '1103', '1104', '9999']);
  assert.match(validateTpexClose(parseTpexClose(synthOpenapi()), { limits: SMALL, prevCodes4: prev }).reason, /缺 1\/6/);
});

test('收件匣（無期望日）：資料日要 ≤ 今天且是交易日', () => {
  const p = parseTpexClose(synthOpenapi({ roc: '1151010' }));   // 2026-10-10 週六
  assert.match(validateTpexClose(p, { today: '2026-10-12', limits: SMALL }).reason, /不是交易日/);
  assert.match(validateTpexClose(parseTpexClose(synthOpenapi({ roc: '1151009' })), { today: '2026-10-08', limits: SMALL }).reason, /晚於今天/);
  assert.equal(validateTpexClose(parseTpexClose(synthOpenapi()), { today: '2026-10-08', limits: SMALL }).status, 'ok');
});

test('帶日期 dailyQuotes：兩表合併、去千分位、回聲不符＝notYet、stat 非 ok＝invalid', () => {
  const fields = ['代號', '名稱', '收盤', '漲跌', '開盤', '最高', '最低', '均價', '成交股數', '成交金額(元)', '成交筆數', '最後買價', '最後買量(張數)', '最後賣價', '最後賣量(張數)', '發行股數', '次日 參考價', '次日 漲停價', '次日 跌停價'];
  const row = (c, close = '1,720.00') => [c, `名${c}`, close, '-35.00 ', '1740.00', '1835.00', '1710.00', '1759.70', '12,221,205', '21,505,630,580', '30,723', '1720.00', '82', '1725.00', '15', '299,493,093', '1720.00', '1890.00', '1550.00'];
  const j = { stat: 'ok', date: '20261007', tables: [
    { title: '上櫃股票行情', date: '115/10/07', fields, data: ['6274', '6275', '6276', '6277', '700001'].map(c => row(c)) },
    { title: '管理股票', fields, data: [row('6278')] },
  ] };
  const p = parseTpexClose(j);
  assert.equal(p.format, 'dated'); assert.equal(p.echo, '2026-10-07'); assert.equal(p.rows.length, 6);
  const r = p.rows.find(x => x.SecuritiesCompanyCode === '6278');
  assert.ok(r, '管理股票表也要收');
  assert.equal(r.Close, '1720.00'); assert.equal(r.TradingShares, '12221205'); assert.equal(r.Capitals, '299493093'); assert.equal(r.Change, '-35.00');
  assert.equal(r.NextLimitUp, '1890.00'); assert.equal(r.Date, '1151007');
  assert.equal(validateTpexClose(p, { expect: '20261007', limits: SMALL }).status, 'ok');
  assert.equal(validateTpexClose(p, { expect: '20261008', limits: SMALL }).status, 'notYet');
  assert.equal(validateTpexClose(parseTpexClose({ ...j, date: '20261008' }), { limits: SMALL }).status, 'invalid', '頂層 date 與表頭不一致');
  assert.equal(validateTpexClose(parseTpexClose({ stat: '查無資料' })).status, 'invalid');
});

test('seedRowsOf／sharesOf：沿用 daemon 既有口徑（帶字母 ETF 不收）', () => {
  const rows = synthOpenapi();
  const seed = seedRowsOf(rows);
  assert.deepEqual(seed.map(s => s.code), ['1100', '1101', '1102', '1103', '1104', '006201']);
  assert.deepEqual(seed[0], { code: '1100', name: '股0', market: 'otc', close: 10, change: 0.1, vol: 1000, open: 9.9, high: 10.5, low: 9.8 });
  const sh = sharesOf(rows);
  assert.equal(sh['1100'], 1000000); assert.equal(sh['006201'], undefined, '只收 4 碼');
});

test('firestoreDocOf：網站口徑（含帶字母 ETF、排除權證）、欄位排成陣列', () => {
  const rows = synthOpenapi();
  const doc = firestoreDocOf({ dataDate: '2026-10-08', rows, source: 'inbox', sha256: 'abc', fetchedAt: '2026-10-08T11:00:00.000Z' }, 123);
  assert.equal(doc.rows, 7); assert.equal(doc.roc, '1151008'); assert.equal(doc.updatedAt, 123); assert.equal(doc.dataDate, '2026-10-08');
  const arr = JSON.parse(doc.rowsJson);
  assert.equal(arr.length, 7);
  assert.equal(arr[0][doc.fields.indexOf('SecuritiesCompanyCode')], '1100');
  assert.ok(arr.some(a => a[0] === '00679B'));
});

test('真實完整檔：驗證 ok（預設門檻）、網站文件往返 0 差異；10-08 檔另驗 12,221 列／4 碼 886', { skip: skipFull }, () => {
  const p = parseTpexClose(REAL.buf);
  assert.equal(p.format, 'openapi'); assert.ok(p.echo);
  const st = statsOf(p.rows);
  assert.equal(st.dup, 0); assert.ok(st.closeParse >= LIMITS.minCloseParse);
  assert.equal(validateTpexClose(p, { expect: p.echo }).status, 'ok');
  assert.equal(validateTpexClose(p, { today: p.echo }).status, 'ok');
  const doc = firestoreDocOf({ dataDate: p.echo, rows: p.rows }, 0);
  assert.ok(doc.rowsJson.length < 400_000, `rowsJson ${doc.rowsJson.length} bytes`);
  const back = decodeTpexCloseDoc(doc);
  assert.equal(back.dataDate, p.echo); assert.equal(back.rows.length, doc.rows);
  const byCode = new Map(p.rows.map(r => [String(r.SecuritiesCompanyCode).trim(), r]));
  let diff = 0;
  for (const r of back.rows) { const o = byCode.get(r.SecuritiesCompanyCode.trim()); for (const f of WEB_FIELDS) if (String(o?.[f] ?? '') !== r[f]) diff++; }
  assert.equal(diff, 0, '網站讀回的列與原檔逐欄相同');
  if (REAL.known1008) {
    assert.equal(p.echo, '2026-10-08');
    assert.deepEqual([st.rows, st.stocks4, st.etf00], [12221, 886, 118]);
    assert.equal(seedRowsOf(p.rows).length, 886 + 15, '既有口徑：00 開頭只收不帶字母的 15 檔');
    assert.equal(doc.rows, 1005);
    assert.equal(sharesOf(p.rows)['6274'], 299493093);
  }
});

test('截斷檔（由真實完整檔切到約 1.78MB）＝invalid', { skip: TRUNC ? false : '本機沒有真實完整檔可切——略過' }, () => {
  const v = validateTpexClose(parseTpexClose(TRUNC));
  assert.equal(v.status, 'invalid'); assert.match(v.reason, /非完整 JSON/);
});

test('完整性不看總列數的季節起落：權證少的完整檔（9,800 列、4 碼 850）＝ok；4 碼／00 開頭太少仍 invalid', () => {
  const thinWarrants = synthOpenapi({ n4: 850, etfExtra: 70, warrants: 8878 });
  assert.equal(thinWarrants.length, 9800);
  assert.equal(validateTpexClose(parseTpexClose(thinWarrants), { expect: '2026-10-08' }).status, 'ok');
  assert.match(validateTpexClose(parseTpexClose(synthOpenapi({ n4: 790, etfExtra: 70, warrants: 9000 }))).reason, /4 碼股 790/);
  assert.match(validateTpexClose(parseTpexClose(synthOpenapi({ n4: 850, etfExtra: 10, warrants: 9000 }))).reason, /00 開頭 12/);
  assert.match(validateTpexClose(parseTpexClose(synthOpenapi({ n4: 850, etfExtra: 70, warrants: 100 }))).reason, /總列數 1022/);
});

test('季節低列數回歸：官方鏡像 2026-06/07 低於 10,000 列的真實日子用預設門檻驗證 ok', t => {
  const dir = join(MIRROR, 'www.tpex.org.tw', 'tpex_dailyquotes');
  const days = ['2026-07-03', '2026-06-29', '2026-07-06'].filter(d => existsSync(join(dir, `${d}.json.gz`)));
  if (!days.length) { t.skip('本機沒有鏡像 2026-06/07 檔——略過'); return; }
  for (const d of days) {
    const p = parseTpexClose(JSON.parse(gunzipSync(readFileSync(join(dir, `${d}.json.gz`))).toString()).payload);
    const st = statsOf(p.rows);
    assert.ok(st.rows < 10000, `${d} 應是低列數日（${st.rows}）`);
    const v = validateTpexClose(p, { expect: d });
    assert.equal(v.status, 'ok', `${d}：${v.reason}`);
  }
});

test('decodeTpexCloseDoc：firestoreDocOf 往返（網站口徑列、Date＝roc）；格式不符回 null', () => {
  const rows = synthOpenapi();
  const doc = firestoreDocOf({ dataDate: '2026-10-08', rows, source: 'inbox', sha256: 'abc' }, 1);
  const back = decodeTpexCloseDoc(doc);
  assert.equal(back.dataDate, '2026-10-08'); assert.equal(back.roc, '1151008'); assert.equal(back.source, 'inbox');
  assert.deepEqual(back.rows.map(r => r.SecuritiesCompanyCode), ['1100', '1101', '1102', '1103', '1104', '006201', '00679B']);
  assert.equal(back.rows[0].Date, '1151008'); assert.equal(back.rows[0].Close, '10.00'); assert.equal(back.rows[0].Change, '+0.10 ');
  assert.equal(decodeTpexCloseDoc(null), null);
  assert.equal(decodeTpexCloseDoc({ ...doc, dataDate: '20261008' }), null, '資料日格式不符');
  assert.equal(decodeTpexCloseDoc({ ...doc, fields: ['Close'] }), null, '缺必要欄');
  assert.equal(decodeTpexCloseDoc({ ...doc, rowsJson: '[[' }), null, '壞 JSON');
});

test('firestoreDocOf／decodeTpexCloseDoc：第三方後備（grade 3P）帶 grade／volumeBasis／missingFields 往返；官方文件不多欄、讀回 grade=official', () => {
  const rows = synthOpenapi();
  const off = firestoreDocOf({ dataDate: '2026-10-08', rows, source: 'dated', sha256: 'a' }, 1);
  for (const k of ['grade', 'volumeBasis', 'missingFields']) assert.equal(k in off, false, `官方文件不帶 ${k}（形狀與既有相同）`);
  const offBack = decodeTpexCloseDoc(off);
  assert.equal(offBack.grade, 'official'); assert.equal(offBack.volumeBasis, null);
  const tp = firestoreDocOf({ dataDate: '2026-10-08', rows, source: 'finmind', sha256: 'b', grade: '3P', volumeBasis: 'tpex-dailyQuotes', missingFields: ['Capitals', 'Average'] }, 1);
  assert.equal(tp.grade, '3P'); assert.equal(tp.volumeBasis, 'tpex-dailyQuotes'); assert.deepEqual(tp.missingFields, ['Capitals', 'Average']);
  const back = decodeTpexCloseDoc(tp);
  assert.equal(back.grade, '3P'); assert.equal(back.volumeBasis, 'tpex-dailyQuotes'); assert.equal(back.rows.length, off.rows);
  assert.equal(decodeTpexCloseDoc({ ...tp, grade: 'xyz' }).grade, 'xyz', '不認得的等級照原樣回（讀者以「≠official」排除，不當官方）');
});

test('isCloseLagging：落後一個交易日照常採用；中間夾著交易日＝落後（週末、休市日不算）', () => {
  assert.equal(isCloseLagging('2026-10-07', '2026-10-08'), false, 'D-1 對 D');
  assert.equal(isCloseLagging('2026-10-08', '2026-10-08'), false);
  assert.equal(isCloseLagging('2026-10-09', '2026-10-08'), false, '比參考日新不算落後');
  assert.equal(isCloseLagging('2026-10-06', '2026-10-08'), true, 'D-2 對 D');
  assert.equal(isCloseLagging('2026-10-09', '2026-10-12'), false, '週五對週一');
  assert.equal(isCloseLagging('2026-10-08', '2026-10-12'), true, '週四對週一（夾著週五）');
  const hol = new Set(['2026-10-09']);
  assert.equal(isCloseLagging('2026-10-08', '2026-10-12', iso => !hol.has(iso) && ![0, 6].includes(new Date(`${iso}T12:00:00Z`).getUTCDay())), false, '週五休市');
  assert.equal(isCloseLagging(null, '2026-10-12'), false);
  assert.equal(isCloseLagging('2026-01-02', '2026-10-12'), true);
});

test('splitRowsByDate：依每列 Date 分出當日與他日；沒有 Date 的列算參考日', () => {
  const rows = [{ Code: 'a', Date: '1151008' }, { Code: 'b', Date: '1151007' }, { Code: 'c', Date: '' }, { Code: 'd' }, { Code: 'e', Date: '20261008' }];
  const { same, off } = splitRowsByDate(rows, '2026-10-08');
  assert.deepEqual(same.map(r => r.Code), ['a', 'c', 'd', 'e']);
  assert.deepEqual(off.map(r => r.Code), ['b']);
});

test('等價：鏡像 10-02 openapi 檔與帶日期檔轉換後 16 欄 0 差異', t => {
  const a = join(MIRROR, 'www.tpex.org.tw', 'tpex_oa_tpex_mainboard_daily_close_quotes', '2026-10-02.json.gz');
  const b = join(MIRROR, 'www.tpex.org.tw', 'tpex_dailyquotes', '2026-10-02.json.gz');
  if (!existsSync(a) || !existsSync(b)) { t.skip('本機沒有鏡像 10-02 檔——略過'); return; }
  const pa = parseTpexClose(JSON.parse(gunzipSync(readFileSync(a)).toString()).payload);
  const pb = parseTpexClose(JSON.parse(gunzipSync(readFileSync(b)).toString()).payload);
  assert.equal(pa.echo, '2026-10-02'); assert.equal(pb.echo, '2026-10-02');
  assert.equal(pa.rows.length, pb.rows.length);
  const norm = v => String(v ?? '').replace(/[,\s]/g, '');
  const byB = new Map(pb.rows.map(r => [r.SecuritiesCompanyCode, r]));
  let diff = 0;
  for (const r of pa.rows) {
    const o = byB.get(String(r.SecuritiesCompanyCode).trim());
    assert.ok(o, `帶日期檔缺 ${r.SecuritiesCompanyCode}`);
    for (const f of ['CompanyName', 'Close', 'Change', 'Open', 'High', 'Low', 'Average', 'TradingShares', 'TransactionAmount', 'TransactionNumber', 'LatestBidPrice', 'LatesAskPrice', 'Capitals', 'NextReferencePrice', 'NextLimitUp', 'NextLimitDown']) if (norm(r[f]) !== norm(o[f])) diff++;
  }
  assert.equal(diff, 0);
  assert.deepEqual(codes4Of(pa.rows), codes4Of(pb.rows));
  assert.deepEqual(seedRowsOf(pa.rows), seedRowsOf(pb.rows), '宇宙種子兩來源完全相同');
});

test('第三方後備等級：gradeTagOf 只帶非官方（官方列形狀不變）；isThirdPartyRow 認列上 _grade', () => {
  assert.deepEqual(gradeTagOf({ _grade: '3P' }), { _grade: '3P' });
  assert.deepEqual(gradeTagOf({ _grade: 'official' }), {});
  assert.deepEqual(gradeTagOf({}), {}); assert.deepEqual(gradeTagOf(null), {}); assert.deepEqual(gradeTagOf(undefined), {});
  assert.equal(isThirdPartyRow({ _grade: '3P' }), true);
  assert.equal(isThirdPartyRow({ _grade: 'official' }), false); assert.equal(isThirdPartyRow({}), false); assert.equal(isThirdPartyRow({ _grade: '' }), false);
});

test('officialBarRows（daily-close 歷史 K 棒只收官方）：列自帶 3P 排除；防線——tpexClose 文件同資料日是 3P 時上櫃列也排除；上市列不受影響', () => {
  const rows = [
    { Code: '2330', _market: 'tse', Date: '1151008' },
    { Code: '6488', _market: 'otc', Date: '1151008', _grade: '3P' },
    { Code: '3105', _market: 'otc', Date: '1151008' },
  ];
  const a = officialBarRows(rows, { iso: '2026-10-08', otcDoc: null });
  assert.deepEqual(a.keep.map(r => r.Code), ['2330', '3105']); assert.deepEqual(a.thirdParty.map(r => r.Code), ['6488']);
  // 列上的標記在中途被丟掉（回歸）時，文件等級仍擋得住
  const lost = rows.map(({ _grade, ...r }) => r);
  const b = officialBarRows(lost, { iso: '2026-10-08', otcDoc: { grade: '3P', dataDate: '2026-10-08' } });
  assert.deepEqual(b.keep.map(r => r.Code), ['2330']); assert.deepEqual(b.thirdParty.map(r => r.Code), ['6488', '3105']);
  // 文件是官方、或 3P 但是別天 ⇒ 不靠文件排除
  assert.deepEqual(officialBarRows(lost, { iso: '2026-10-08', otcDoc: { grade: 'official', dataDate: '2026-10-08' } }).thirdParty, []);
  assert.deepEqual(officialBarRows(lost, { iso: '2026-10-08', otcDoc: { grade: '3P', dataDate: '2026-10-07' } }).thirdParty, []);
});

test('網站接線：getStockDayAllDataInternal 兩個出口（快照、closeOnly fallback）都帶 _grade；daily-close 用 officialBarRows 排除 3P 寫 K 棒', () => {
  const src = readFileSync(new URL('../../src/lib/twse-api-server.ts', import.meta.url), 'utf8');
  const fb = src.slice(src.indexOf('const fallback: StockDayData[] = raw.map('), src.indexOf('return await mergeEmerging(fallback);'));
  assert.ok(fb.length > 0, '找不到 fallback 出口（改名了？請同步本測試）');
  assert.match(fb, /\.\.\.gradeTagOf\(item\)/, 'closeOnly fallback 出口要帶 _grade');
  const snap = src.slice(src.indexOf('if (!closeOnly && isSnapshotFresh(snap))'), src.indexOf('if (data.length > 0) return await mergeEmerging(data);'));
  assert.ok(snap.length > 0, '找不到快照出口');
  assert.match(snap, /\.\.\.gradeTagOf\(rq\)/, '快照出口（開高低取自上櫃 3P 列）要帶 _grade');
  const dc = readFileSync(new URL('../../src/app/api/cron/daily-close/route.ts', import.meta.url), 'utf8');
  assert.match(dc, /officialBarRows\(regular,/);
  assert.match(dc, /readTpexClose\(\)/, 'daily-close 以文件等級當第二道防線');
  assert.doesNotMatch(dc, /下一次跑（或 topup-stock-history）再補/, '註解：daily-close 只寫當次 K 棒，D 日上櫃 K 棒要靠 topup-stock-history');
});
