// ETF／興櫃官方日 K（stop-v1.1 A3）測試：node --test scripts/lib/official-bars.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as C from './official-mirror.mjs';
import * as B from './official-bars.mjs';
import { lineInputsOf } from './ai-stoploss.mjs';
import { DATED } from '../official-mirror/adapters-dated.mjs';

test('接線：讀的資料集都在鏡像排程裡（帶日期＝P1、2022-07-18 起、已驗證；快照＝每日）', () => {
  const snaps = JSON.parse(readFileSync(new URL('../official-mirror/snapshot-registry.json', import.meta.url), 'utf8')).entries;
  for (const s of [...B.BAR_SOURCES.etf, ...B.BAR_SOURCES.emerging].flatMap(m => m.alts)) {
    if (s.snapshot) {
      const e = snaps.find(x => x.id === s.id);
      assert.ok(e, `${s.id} 不在 snapshot-registry`); assert.equal(e.host, s.host); assert.equal(e.freq, 'daily', `${s.id} 要每日快照`);
      continue;
    }
    const ad = DATED.find(x => x.id === s.id);
    assert.ok(ad, `${s.id} 不在 adapters-dated`);
    assert.equal(ad.host, s.host); assert.equal(ad.unit, 'day'); assert.equal(ad.priority, 1);
    assert.ok(!ad.disabled && ad.verified !== false, `${s.id} 要已驗證`); assert.ok(ad.from <= '2022-07-18');
  }
  const cal = DATED.find(x => x.id === B.CALENDAR_SOURCE.id);
  assert.equal(cal?.must, true, '交易日曆來源要是必有表');
});

const MI_FIELDS = ['證券代號', '證券名稱', '成交股數', '成交筆數', '成交金額', '開盤價', '最高價', '最低價', '收盤價', '漲跌(+/-)', '漲跌價差', '最後揭示買價', '最後揭示買量', '最後揭示賣價', '最後揭示賣量', '本益比'];
const miRow = (code, o, h, l, c, sh) => [code, `名${code}`, sh, '1', '1', o, h, l, c, '', '0', '', '', '', '', ''];
const roc = d => `${+d.slice(0, 4) - 1911}年${d.slice(5, 7)}月${d.slice(8, 10)}日`;
const rocSlash = d => `${+d.slice(0, 4) - 1911}/${d.slice(5, 7)}/${d.slice(8, 10)}`;
const mi = (d, rows, { titleDay = d, top = d } = {}) => ({
  stat: 'OK', date: top.replace(/-/g, ''),
  tables: [{ title: `${roc(d)} 價格指數`, fields: ['指數'], data: [] }, { title: `${roc(titleDay)} 每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))`, fields: MI_FIELDS, data: rows }],
});
const DQ_FIELDS = ['代號', '名稱', '收盤', '漲跌', '開盤', '最高', '最低', '均價', '成交股數', '成交金額(元)', '成交筆數', '最後買價', '最後買量(張數)', '最後賣價', '最後賣量(張數)', '發行股數', '次日 參考價', '次日 漲停價', '次日 跌停價'];
const dqRow = (code, o, h, l, c, sh, next = c) => [code, `名${code}`, c, '0', o, h, l, c, sh, '1', '1', '', '', '', '', '1', next, '9999.95', '0.01'];
const dq = (d, rows, { tdate = d } = {}) => ({ stat: 'ok', date: d.replace(/-/g, ''), tables: [{ title: '上櫃股票行情', date: rocSlash(tdate), fields: DQ_FIELDS, data: rows }, { title: '管理股票', fields: DQ_FIELDS, data: [] }] });
const esb = (rocDay, rows) => rows.map(([code, h, l, c, v]) => ({ Date: rocDay, SecuritiesCompanyCode: code, CompanyName: `名${code}`, Highest: h, Lowest: l, LatestPrice: c, TransactionVolume: v }));

test('數字：千分位、正負號；--／---／X／空字串 ⇒ null', () => {
  assert.equal(B.num('68,967,747'), 68967747);
  assert.equal(B.num('-0.03 '), -0.03);
  for (const v of ['--', '---', 'X', '', null, '<p>-</p>']) assert.equal(B.num(v), null);
});

test('上市 MI_INDEX：只收 5～6 碼與英文字尾 ETF（4 碼 ETF 歸 chipArchive、ETN／REIT／個股不收）；無成交不成一根', () => {
  const p = mi('2026-10-02', [
    miRow('0050', '112.85', '112.95', '112.30', '112.80', '68,967,747'),
    miRow('00631L', '39.58', '39.71', '39.29', '39.58', '99,743,650'),
    miRow('00632R', '9.43', '9.44', '9.38', '9.40', '51,289,487'),
    miRow('00400A', '15.61', '15.80', '15.61', '15.78', '25,080,047'),
    miRow('006208', '258.20', '258.70', '257.50', '258.30', '2,246,225'),
    miRow('00999', '--', '--', '--', '--', '0'),
    miRow('020000', '10', '10', '10', '10', '1000'),
    miRow('01001T', '10', '10', '10', '10', '1000'),
    miRow('2330', '1000', '1010', '990', '1005', '1000'),
  ]);
  const r = B.parseTwseMiIndex(p, { expect: '2026-10-02' });
  assert.equal(r.status, 'ok'); assert.equal(r.echo, '2026-10-02');
  assert.deepEqual(r.rows.map(x => x.code), ['00631L', '00632R', '00400A', '006208']);
  assert.deepEqual(r.rows[0], { code: '00631L', name: '名00631L', market: 'tse', o: 39.58, h: 39.71, l: 39.29, c: 39.58, shares: 99743650 });
});

test('上市 MI_INDEX 回聲：頂層 date 與表 title 不一致、或≠請求日 ⇒ mismatch；stat 非 OK ⇒ bad', () => {
  const rows = [miRow('00631L', '1', '1', '1', '1', '1000')];
  assert.equal(B.parseTwseMiIndex(mi('2026-10-02', rows, { titleDay: '2026-10-01' })).status, 'mismatch');
  assert.equal(B.parseTwseMiIndex(mi('2026-10-02', rows), { expect: '2026-10-01' }).status, 'mismatch');
  assert.equal(B.parseTwseMiIndex({ stat: '很抱歉，沒有符合條件的資料!' }).status, 'bad');
  assert.equal(B.parseTwseMiIndex({ stat: 'OK', date: '20261002', tables: [] }).status, 'bad');
});

test('上櫃 dailyQuotes：收英文字尾債券 ETF；回聲看頂層 date 與 tables[0].date（民國）', () => {
  const p = dq('2026-10-02', [dqRow('00679B', '24.60', '24.63', '24.57', '24.61', '24,896,170'), dqRow('006201', '46.80', '47.86', '46.80', '47.86', '198,026'), dqRow('00937B', '---', '---', '---', '---', '0'), dqRow('8069', '146', '146', '142.5', '143.5', '5,802,334')]);
  const r = B.parseTpexDailyQuotes(p, { expect: '2026-10-02' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rows.map(x => [x.code, x.market, x.c]), [['00679B', 'otc', 24.61], ['006201', 'otc', 47.86]]);
  assert.equal(B.parseTpexDailyQuotes(dq('2026-10-02', [], { tdate: '2026-10-01' })).status, 'mismatch');
  assert.equal(B.parseTpexDailyQuotes(p, { expect: '2026-10-05' }).status, 'mismatch');
});

test('興櫃 openapi：全表 Date 一致才收；當日無成交不成一根；沒有開盤價；4 碼代號也收', () => {
  const p = esb('1151002', [['1260', '31.2', '30.3', '31.2', '50050'], ['1269', '58.5', '56', '58.5', '0']]);
  const r = B.parseEsbOpenapi(p, { expect: '2026-10-02' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rows, [{ code: '1260', name: '名1260', market: 'emerging', o: null, h: 31.2, l: 30.3, c: 31.2, shares: 50050 }]);
  assert.equal(B.parseEsbOpenapi([...p, { ...p[0], Date: '1151001' }]).status, 'mismatch');
  assert.equal(B.parseEsbOpenapi(p, { expect: '2026-10-03' }).status, 'mismatch');
  assert.equal(B.parseEsbOpenapi({}).status, 'bad');
});

test('closeJson 與 chipArchive 同格式：[收, 量張(四捨五入), 開(無＝0), 高, 低]', () => {
  assert.deepEqual(B.closeJsonOf([{ code: '00631L', c: 39.58, shares: 99743650, o: 39.58, h: 39.71, l: 39.29 }, { code: '1260', c: 31.2, shares: 50050, o: null, h: 31.2, l: 30.3 }]),
    { '00631L': [39.58, 99744, 39.58, 39.71, 39.29], 1260: [31.2, 50, 0, 31.2, 30.3] });
});

// ── 鏡像讀取（暫存目錄造一份迷你鏡像） ─────────────────────────────────────
function seed(root, host, id, key, payload, extra = {}) {
  const man = C.loadManifest(root, host, id);
  const file = C.writeEntry(root, host, id, key, { kind: 'json', payload, meta: { echo: key } });
  man.rows[key] = { status: 'ok', file, echo: key, sha256: `h-${key}`, final: true, ...extra };
  C.saveManifest(root, man);
}
const DAYS = Array.from({ length: 22 }, (_, i) => new Date(Date.parse('2026-09-01T00:00:00Z') + i * 864e5).toISOString().slice(0, 10));

test('逐交易日讀鏡像：市場組成（缺上櫃的日子 ok=false、不半套）、回聲不符列進 problems、閘門算最近連續天數', () => {
  const root = mkdtempSync(join(tmpdir(), 'ob-'));
  try {
    DAYS.forEach((d, i) => {
      const px = (10 + i * 0.1).toFixed(2);
      seed(root, 'www.twse.com.tw', 'twse_mi_index', d, mi(d, [miRow('00631L', px, px, px, px, '1,500')]));
      if (d === '2026-09-03') return;   // 上櫃缺這天
      seed(root, 'www.tpex.org.tw', 'tpex_dailyquotes', d, d === '2026-09-04' ? dq('2026-09-07', [dqRow('00679B', px, px, px, px, '2,000')]) : dq(d, [dqRow('00679B', px, px, px, px, '2,000')]));
    });
    const { days, problems } = B.readOfficialDays({ root, kind: 'etf' });
    assert.equal(days.length, 22);
    assert.deepEqual(days.filter(d => !d.ok).map(d => [d.date, d.missing, d.pending]), [['2026-09-03', ['otc'], true], ['2026-09-04', ['otc'], false]]);
    assert.deepEqual(problems.map(p => [p.date, p.status]), [['2026-09-03', 'missing'], ['2026-09-04', 'mismatch']]);
    assert.deepEqual(days[0].counts, { tse: 1, otc: 1 });
    const g = B.archiveGates(days);
    assert.equal(g.tailRun, 18); assert.equal(g.pendingTail, 0); assert.equal(g.pass, false); assert.equal(g.lastDate, '2026-09-22');
    assert.equal(B.archiveGates(days, { minRun: 18 }).pass, true);
    const bars = B.barsByCodeOf(days);
    assert.equal(bars['00631L'].length, 20, '缺市場的日子整天不收');
    assert.deepEqual(bars['00631L'][0], { date: '2026-09-01', o: 10, h: 10, l: 10, c: 10, v: 2 });
    const docs = B.archiveDocsOf(days, 'etf');
    assert.equal(docs.length, 20);
    assert.deepEqual(JSON.parse(docs[0].closeJson), { '00631L': [10, 2, 10, 10, 10], '00679B': [10, 2, 10, 10, 10] });
    assert.deepEqual(docs[0].sources.map(s => s.id), ['twse_mi_index', 'tpex_dailyquotes']);
    const last5 = B.readOfficialBars({ root, kind: 'etf', lastN: 5, codes: ['00679B'] });
    assert.deepEqual(Object.keys(last5.barsByCode), ['00679B']);
    assert.equal(last5.barsByCode['00679B'].length, 5);
    assert.equal('rows' in last5.days[0], false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('官方日 K 直接餵 ai-stoploss lineInputsOf：20 根有 ATR 帶（契約）', () => {
  const root = mkdtempSync(join(tmpdir(), 'ob-'));
  try {
    DAYS.slice(0, 20).forEach((d, i) => {
      const c = 20 + i * 0.2;
      seed(root, 'www.twse.com.tw', 'twse_mi_index', d, mi(d, [miRow('00631L', String(c), (c + 0.3).toFixed(2), (c - 0.3).toFixed(2), String(c), '5,000')]));
      seed(root, 'www.tpex.org.tw', 'tpex_dailyquotes', d, dq(d, [dqRow('00679B', '30', '30', '30', '30', '1,000')]));
    });
    const { barsByCode } = B.readOfficialBars({ root, kind: 'etf', lastN: 80 });
    const li = lineInputsOf(barsByCode['00631L'], '2026-09-10', null, { events: [], coverFrom: '2026-09-01', coverTo: '2026-09-30' }, { isEtf: true });
    assert.equal(li.noOfficialBars, false); assert.equal(li.dataDate, '2026-09-20');
    assert.ok(li.atrBand?.price > 0); assert.ok(li.atr14 > 0); assert.equal(li.holdHigh?.price, 23.8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('快照資料集：同回聲日取最後一版（.r2），unchanged 指向 same 檔；興櫃以 MI_INDEX 交易日為曆', () => {
  const root = mkdtempSync(join(tmpdir(), 'ob-'));
  try {
    for (const d of ['2026-10-01', '2026-10-02']) seed(root, 'www.twse.com.tw', 'twse_mi_index', d, mi(d, [miRow('00631L', '1', '1', '1', '1', '1000')]));
    const id = 'tpex_oa_tpex_esb_latest_statistics';
    seed(root, 'www.tpex.org.tw', id, '2026-10-02', esb('1151002', [['1260', '31', '30', '30.5', '1000']]));
    seed(root, 'www.tpex.org.tw', id, '2026-10-02.r2', esb('1151002', [['1260', '31.2', '30.3', '31.2', '50050']]));
    const { days } = B.readOfficialDays({ root, kind: 'emerging' });
    assert.deepEqual(days.map(d => [d.date, d.ok]), [['2026-10-01', false], ['2026-10-02', true]]);
    assert.equal(days[1].rows[0].c, 31.2); assert.equal(days[1].sources[0].key, '2026-10-02.r2');
    const man = C.loadManifest(root, 'www.tpex.org.tw', id);
    man.rows['2026-10-01'] = { status: 'unchanged', same: man.rows['2026-10-02'].file, final: true };
    C.saveManifest(root, man);
    const again = B.readOfficialDays({ root, kind: 'emerging' }).days;
    assert.equal(again[0].ok, false, 'unchanged 指到 10-02 的檔：回聲≠10-01 ⇒ 不收（不把別天的內容記成這天）');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('官方參考價係數：TWT84U 依 groups 定位、只收前一交易日有成交（沒成交時基準跟淨值走）；dailyQuotes 次日參考價記到下一交易日', () => {
  const t84 = {
    stat: 'OK', date: '20261002', title: '115年10月02日 股價升降幅度',
    fields: ['證券代號', '證券名稱', '漲停價', '開盤競價基準', '跌停價', '開盤競價基準', '收盤價', '買進揭示價', '賣出揭示價', '最近成交日', '可否零股交易'],
    groups: [{ start: 0, span: 2, title: '' }, { start: 2, span: 3, title: '本日' }, { start: 5, span: 4, title: '前日' }, { start: 9, span: 2, title: '' }],
    data: [
      ['00878', 'x', '38', '34.50', '31', '34.89', '34.89', '', '', '115.10.01', '可'],
      ['00631L', 'x', '47', '39.62', '31', '39.62', '39.62', '', '', '115.10.01', '可'],
      ['00625K', 'x', '9,999.95', '8.43', '0.01', '8.40', '0.00', '', '', '115.09.27', '可'],
      ['2330', 'x', '1', '900', '1', '1000', '1000', '', '', '115.10.01', '可'],
    ],
  };
  assert.deepEqual(B.twt84uFactors(t84, { expect: '2026-10-02', prevDay: '2026-10-01' }), [['2026-10-02', '00878', 0.988822]]);
  assert.deepEqual(B.twt84uFactors(t84, { expect: '2026-10-01' }), []);
  const q = dq('2026-10-02', [dqRow('00679B', '24.6', '24.6', '24.6', '24.61', '1,000', '24.11'), dqRow('006201', '1', '1', '1', '47.86', '0', '40')]);
  assert.deepEqual(B.dailyQuotesNextFactors(q, { expect: '2026-10-02', nextDay: '2026-10-05' }), [['2026-10-05', '00679B', 0.979683]]);
  assert.deepEqual(B.dailyQuotesNextFactors(q, { expect: '2026-10-02', nextDay: null }), [], '沒有下一交易日 ⇒ 不記（不猜日期）');
  const ref = [['2026-10-02', '00878', 0.988822], ['2026-10-05', '00679B', 0.979683], ['2026-10-05', '00632R', 4]];
  assert.deepEqual(B.uncoveredFactors(ref, [['2026-10-02', '00878', 0.9888], ['2026-10-05', '00679B', 0.95]]), [['2026-10-05', '00679B', 0.979683], ['2026-10-05', '00632R', 4]]);
  // 係數表把除息記在颱風假（2024-10-31 休市），官方在下一交易日 11-01 生效：給前一交易日時視為同一件
  const typhoon = [['2024-11-01', '00939', 0.995166]]; const table = [['2024-10-31', '00939', 0.995166]];
  assert.equal(B.uncoveredFactors(typhoon, table).length, 1);
  assert.equal(B.uncoveredFactors(typhoon, table, { prevDayOf: () => '2024-10-30' }).length, 0);
  assert.equal(B.uncoveredFactors(typhoon, [['2024-10-30', '00939', 0.995166]], { prevDayOf: () => '2024-10-30' }).length, 1, '前一交易日（含）以前的不算');
});

test('結構斷點：停止買賣後收盤比 <0.7 或 >1.43 才算（分割／反分割候選）；連續交易日的大漲跌不算', () => {
  const cal = ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-27', '2026-03-30', '2026-03-31', '2026-04-01'];
  const bars = {
    '00631L': [{ date: '2026-03-23', c: 469.35 }, { date: '2026-03-24', c: 443.15 }, { date: '2026-03-31', c: 19.26 }, { date: '2026-04-01', c: 19.3 }],
    '00738U': [{ date: '2026-03-30', c: 91.5 }, { date: '2026-03-31', c: 63 }],
    '00632R': [{ date: '2026-03-24', c: 3.28 }, { date: '2026-03-27', c: 3.3 }],
  };
  assert.deepEqual(B.structuralBreaks(bars, cal), [{ code: '00631L', prevDate: '2026-03-24', date: '2026-03-31', gapDays: 4, ratio: 0.0435 }]);
});

test('興櫃 www emerging/latest（PRIMARY）：回聲取 tables[0].date 的民國日期；收盤＝成交；沒有成交不成一根', () => {
  const p = { stat: 'ok', tables: [{ title: '興櫃股票當日行情表', date: '115年10月05日 16:33:03', fields: ['代號', '名稱', '前日均價', '報買價', '報買量', '報賣價', '報賣量', '日最高', '日最低', '日均價', '成交', '投資人成交買賣別', '暫停交易開始時間(時:分:秒)', '成交量'],
    data: [['1260', '富味鄉', '30.51', 30.55, '3,000', 32, '3,000', '32.35', '30.45', '30.99', '32.00', '買進', '', '85,525'], ['1269', '乾杯', '58.6', 55.9, '1', 58.5, '1', '0.00', '0.00', '0.00', '58.50', '', '', '0']] }] };
  const r = B.parseEsbWwwLatest(p, { expect: '2026-10-05' });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.rows, [{ code: '1260', name: '富味鄉', market: 'emerging', o: null, h: 32.35, l: 30.45, c: 32, shares: 85525 }]);
  assert.equal(B.parseEsbWwwLatest(p, { expect: '2026-10-02' }).status, 'mismatch');
  assert.equal(B.parseEsbWwwLatest({ stat: 'ok', tables: [{ date: '115年10月05日', fields: ['代號'], data: [] }] }).status, 'bad');
});

test('PRIMARY 有就用 PRIMARY；PRIMARY 缺才用 FALLBACK 並記 problems；最後一天只是還沒抓到（pending）不算斷', () => {
  const root = mkdtempSync(join(tmpdir(), 'ob-'));
  try {
    const days3 = ['2026-10-01', '2026-10-02', '2026-10-05'];
    for (const d of days3) seed(root, 'www.twse.com.tw', 'twse_mi_index', d, mi(d, [miRow('00631L', '1', '1', '1', '1', '1000')]));
    const www = d => ({ stat: 'ok', tables: [{ date: `${roc(d)} 16:33:03`, fields: ['代號', '名稱', '日最高', '日最低', '成交', '成交量'], data: [['1260', 'x', '33', '31', '32', '1,000']] }] });
    seed(root, 'www.tpex.org.tw', 'tpex_emerging_latest', '2026-10-02', www('2026-10-02'));
    seed(root, 'www.tpex.org.tw', 'tpex_oa_tpex_esb_latest_statistics', '2026-10-02', esb('1151002', [['1260', '31.2', '30.3', '31.2', '50050']]));
    seed(root, 'www.tpex.org.tw', 'tpex_oa_tpex_esb_latest_statistics', '2026-10-01', esb('1151001', [['1260', '31', '30', '30.5', '1000']]));
    const { days, problems } = B.readOfficialDays({ root, kind: 'emerging' });
    assert.deepEqual(days.map(d => [d.date, d.ok, d.pending, d.sources[0]?.id ?? null]), [
      ['2026-10-01', true, false, 'tpex_oa_tpex_esb_latest_statistics'], ['2026-10-02', true, false, 'tpex_emerging_latest'], ['2026-10-05', false, true, null]]);
    assert.equal(days[1].rows[0].c, 32, 'PRIMARY 優先');
    assert.deepEqual(problems.map(p => [p.date, p.id, p.status]), [
      ['2026-10-01', 'tpex_emerging_latest', 'fallback:missing'], ['2026-10-05', 'tpex_emerging_latest', 'missing'], ['2026-10-05', 'tpex_oa_tpex_esb_latest_statistics', 'missing']]);
    const g = B.archiveGates(days, { minRun: 2 });
    assert.deepEqual([g.tailRun, g.pendingTail, g.pass], [2, 1, true]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('R8 daemon 盤前讀本機鏡像（readOfficialBarsAsync）：分段讀、段間讓出事件迴圈；結果與一次讀完相同；to 之後的日子不讀；閘門一併回傳', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ob-'));
  try {
    DAYS.forEach((d, i) => {
      const px = (10 + i * 0.1).toFixed(2);
      seed(root, 'www.twse.com.tw', 'twse_mi_index', d, mi(d, [miRow('00631L', px, px, px, px, '1,500')]));
      seed(root, 'www.tpex.org.tw', 'tpex_dailyquotes', d, dq(d, [dqRow('00679B', px, px, px, px, '2,000')]));
    });
    let pauses = 0;
    const to = DAYS[20];
    const r = await B.readOfficialBarsAsync({ root, kind: 'etf', to, lastN: 15, chunkDays: 4, pause: async () => { pauses += 1; } });
    const sync = B.readOfficialBars({ root, kind: 'etf', to, lastN: 15 });
    assert.deepEqual(r.barsByCode, sync.barsByCode);
    assert.deepEqual(r.days, sync.days);
    assert.equal(pauses, 3, '15 天、每段 4 天 ⇒ 4 段、段間讓出 3 次');
    assert.equal(r.barsByCode['00631L'].at(-1).date, to, 'to 之後的日子不讀');
    assert.deepEqual([r.gates.tailRun, r.gates.lastDate, r.gates.pass], [15, to, false], '連續 15 日 <20 ⇒ 閘門未過（呼叫端 fail-closed）');
    const full = await B.readOfficialBarsAsync({ root, kind: 'etf', to: DAYS[21], lastN: 80 });
    assert.deepEqual([full.gates.tailRun, full.gates.pass], [22, true]);
    await assert.rejects(B.readOfficialBarsAsync({ root, kind: 'nope' }), /未知的歸檔種類/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
