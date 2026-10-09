// 月營收來源（同業比較／論點支柱／wiki 中位數）純函式測試：node --test scripts/lib/revenue-source.test.mjs
// openapi 列的欄位名照 t187ap05_L 原樣；歸檔列照 revenueArchive v2 的形狀（{c,n,rev,prev,last,mom,yoy,cum}）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from './revenue-source.mjs';

const api = (c, n, ind, { ym = '11508', rev = '1,000', prev = '900', last = '800', mom = '11.11', yoy = '25.00', cum = '8,000' } = {}) => ({
  出表日期: '1151004', 資料年月: ym, 公司代號: c, 公司名稱: n, 產業別: ind,
  '營業收入-當月營收': rev, '營業收入-上月營收': prev, '營業收入-去年當月營收': last,
  '營業收入-上月比較增減(%)': mom, '營業收入-去年同月增減(%)': yoy, '累計營業收入-當月累計營收': cum,
});
const arch = rows => ({ v: 2, rowsJson: JSON.stringify(rows) });
const meta = (id, n, missingN, v = 2) => ({ id, v, n, missingN });

test('民國資料年月 ↔ 西元月份', () => {
  assert.equal(R.rocToMonthId('11508'), '2026-08');
  assert.equal(R.rocToMonthId('10001'), '2011-01');
  assert.equal(R.rocToMonthId('11513'), null);
  assert.equal(R.rocToMonthId(''), null);
  assert.equal(R.monthIdToRoc('2026-08'), '11508');
  assert.equal(R.monthIdToRoc('bad'), '');
});

test('openapi 只收上市 _L：_P 是未上市公開發行公司', () => {
  assert.equal(R.OPENAPI_REVENUE_EP, 't187ap05_L');
});

test('parseOpenapiRevenue：增減 % 留白＝null（舊版 parseFloat→0 是捏造）、金額留白＝0、產業別正規化', () => {
  const { monthId, rows } = R.parseOpenapiRevenue([
    api('2330', '台積電', '半導體業'),
    api('3718', '中光電投控', '其他業', { last: '', mom: '', yoy: '' }),   // 去年同月為 0 ⇒ 官方留白
  ]);
  assert.equal(monthId, '2026-08');
  assert.deepEqual(rows[0], { c: '2330', n: '台積電', ind: '半導體業', rev: 1000, prev: 900, last: 800, mom: 11.11, yoy: 25, cum: 8000 });
  assert.equal(rows[1].yoy, null);
  assert.equal(rows[1].mom, null);
  assert.equal(rows[1].last, 0);
  assert.equal(rows[1].ind, '其他');
});

test('parseOpenapiRevenue：營收 ≤0、非 4 碼、重複代號、少數月份的列都不收', () => {
  const { monthId, rows } = R.parseOpenapiRevenue([
    api('1101', '台泥', '水泥工業'),
    api('1102', '亞泥', '水泥工業'),
    api('2881', '富邦金', '金融保險業', { rev: '-8,994,147' }),
    api('6785', '昱展新藥', '生技醫療業', { rev: '0' }),
    api('912000', '晨訊科-DR', '存託憑證'),
    api('1101', '台泥', '水泥工業', { rev: '5' }),
    api('1103', '嘉泥', '水泥工業', { ym: '11507' }),   // 混入上個月的列＝來源異常，不混算
  ]);
  assert.equal(monthId, '2026-08');
  assert.deepEqual(rows.map(r => r.c), ['1101', '1102']);
  assert.equal(rows[0].rev, 1000);
  assert.deepEqual(R.parseOpenapiRevenue(null), { monthId: null, rows: [] });
});

test('archiveRevenueRows：null 維持 null、非有限數變 null、物件形式 rowsJson 也讀', () => {
  const rows = R.archiveRevenueRows(arch([
    { c: '2330', n: '台積電', rev: 1000, prev: 900, last: 800, mom: 11.11, yoy: 25, cum: 8000 },
    { c: 4157, n: '太景*-KY', rev: 44, prev: 40, last: 0, mom: 10, yoy: null, cum: 300 },
    { c: '9999', n: 'x', rev: 5, mom: 'NaN', yoy: '' },
    { c: '6785', n: '昱展新藥', rev: 0 },
    { c: '912000', n: 'DR', rev: 5 },
  ]));
  assert.deepEqual(rows.map(r => r.c), ['2330', '4157', '9999']);
  assert.equal(rows[1].yoy, null);
  assert.equal(rows[2].mom, null);
  assert.equal(rows[2].yoy, null);
  assert.equal(rows[2].last, 0);
  assert.deepEqual(R.archiveRevenueRows({ rowsJson: JSON.stringify({ a: { c: '1101', n: '台泥', rev: 1, yoy: 0 } }) }).map(r => r.yoy), [0]);
  assert.deepEqual(R.archiveRevenueRows(null), []);
  assert.throws(() => R.archiveRevenueRows({ rowsJson: '{bad' }));
});

test('pickArchiveMonth：申報期內的新月份（僅部分公司）不蓋過上月完整月份', () => {
  const metas = [meta('2026-07', 1964, 0), meta('2026-08', 1972, 0), meta('2026-09', 910, 1060)];
  assert.deepEqual(R.pickArchiveMonth(metas, '2026-08'), { id: '2026-08', complete: true });
  // 9 月名冊補齊後換月
  assert.deepEqual(R.pickArchiveMonth([...metas.slice(0, 2), meta('2026-09', 1969, 3)], '2026-08'), { id: '2026-09', complete: true });
});

test('pickArchiveMonth：歸檔比 openapi 舊、或沒有 v2 文件 ⇒ null（呼叫端用 openapi）', () => {
  assert.equal(R.pickArchiveMonth([meta('2026-07', 1964, 0), meta('2026-08', 1972, 0)], '2026-09'), null);
  assert.equal(R.pickArchiveMonth([meta('2026-08', 1832, null, null)], '2026-08'), null);   // 舊版（無 v）不算
  assert.equal(R.pickArchiveMonth([], null), null);
  assert.equal(R.pickArchiveMonth(null, '2026-08'), null);
});

test('pickArchiveMonth：同月以歸檔為準（含上櫃與 KY）；openapi 資料月未知時取最新的完整月份', () => {
  assert.deepEqual(R.pickArchiveMonth([meta('2026-08', 1972, 0)], '2026-08'), { id: '2026-08', complete: true });
  assert.deepEqual(R.pickArchiveMonth([meta('2026-07', 1964, 0), meta('2026-08', 1972, 2), meta('2026-09', 800, 1100)], null), { id: '2026-08', complete: true });
});

test('pickArchiveMonth：沒有名冊完整的候選 ⇒ 最新兩個候選裡筆數較多者，complete=false', () => {
  // 晚申報的金融群還沒上表（缺 15 檔）＋新月份才 900 檔 ⇒ 取 8 月
  assert.deepEqual(R.pickArchiveMonth([meta('2026-08', 1957, 15), meta('2026-09', 900, 1072)], '2026-08'), { id: '2026-08', complete: false });
  // openapi 已到 9 月、歸檔 9 月還缺晚申報者 ⇒ 仍用歸檔 9 月（openapi 同樣缺、還沒有上櫃）
  assert.deepEqual(R.pickArchiveMonth([meta('2026-08', 1972, 0), meta('2026-09', 1955, 17)], '2026-09'), { id: '2026-09', complete: false });
  // 名冊比對未知（有頁失敗時寫 null）不算完整；同筆數取新
  assert.deepEqual(R.pickArchiveMonth([meta('2026-08', 1972, null), meta('2026-09', 1972, null)], null), { id: '2026-09', complete: false });
});

const WIKI = {
  2330: { name: '台積電', market: '上市', industry: '半導體業' },
  5483: { name: '中美晶', market: '上櫃', industry: '半導體業' },
  4157: { name: '太景*-KY', market: '上櫃', industry: '生技醫療業' },
  6015: { name: '宏遠證', market: '上櫃', industry: '金融業' },
  7859: { name: '翰可能源', market: '興櫃', industry: '綠能環保' },
  8299: { name: '群聯', market: '上櫃', industry: ' 半導體業 ' },
};

test('makeIndustryLookup：證交所上市產業別 > wiki（上市漏網＋上櫃）> 上一份同業表；興櫃不收', () => {
  const lookup = R.makeIndustryLookup({
    openapiRows: [{ c: '2330', ind: '半導體業' }, { c: '1101', ind: '水泥工業' }],
    wikiStocks: { ...WIKI, 1101: { market: '上市', industry: '其他' } },
    prevIndustries: {
      光電業: [{ code: '3008', mkt: '上市' }, { code: '5483', mkt: '上櫃' }],
      其他: [{ code: '1237' }],                          // 舊版（openapi＋_P）列沒有 mkt ⇒ 不當後備
    },
  });
  assert.deepEqual(lookup('2330'), { ind: '半導體業', mkt: '上市', src: 'twse' });
  assert.deepEqual(lookup('1101'), { ind: '水泥工業', mkt: '上市', src: 'twse' });
  assert.deepEqual(lookup('5483'), { ind: '半導體業', mkt: '上櫃', src: 'wiki' });
  assert.deepEqual(lookup('8299'), { ind: '半導體業', mkt: '上櫃', src: 'wiki' });
  assert.deepEqual(lookup('6015'), { ind: '金融業', mkt: '上櫃', src: 'wiki' });   // MOPS 官方名照收，不自行併類
  assert.deepEqual(lookup('3008'), { ind: '光電業', mkt: '上市', src: 'prev' });
  assert.equal(lookup('7859'), null);
  assert.equal(lookup('1237'), null);
  assert.equal(lookup(4157).mkt, '上櫃');
});

test('makeIndustryLookup：wiki 讀不到時，上櫃靠上一份新格式同業表的歸屬撐住', () => {
  const lookup = R.makeIndustryLookup({ openapiRows: [], wikiStocks: null, prevIndustries: { 半導體業: [{ code: '5483', mkt: '上櫃' }] } });
  assert.deepEqual(lookup('5483'), { ind: '半導體業', mkt: '上櫃', src: 'prev' });
});

test('buildPeerComps：上櫃與 KY 進表、留白 YoY 是 null 且不進中位數、查不到產業別不歸「其他」', () => {
  const rows = R.archiveRevenueRows(arch([
    { c: '2330', n: '台積電', rev: 1000, yoy: 30 },
    { c: '5483', n: '中美晶', rev: 500, yoy: -10 },
    { c: '8299', n: '群聯', rev: 700, yoy: null },
    { c: '4157', n: '太景*-KY', rev: 44, yoy: 47.08 },
    { c: '9999', n: '新上櫃', rev: 1, yoy: 5 },
  ]));
  const lookup = R.makeIndustryLookup({ openapiRows: [{ c: '2330', ind: '半導體業' }], wikiStocks: WIKI });
  const { industries, summary, coverage } = R.buildPeerComps({
    rows, lookup,
    bw: { 2330: { pe: 25, pb: 6, yld: 1.5 }, 5483: { pe: 0, pb: 1.2, yld: 0 } },
    rating: { 2330: { baseScore: 80, score: 80, signal: 'BUY', risk: null }, 5483: { score: 40 }, 8299: { baseScore: 60, score: 20, risk: 'attention' } },
    rs: { 2330: 90 }, quotes: { 2330: { price: 1000, changePercent: 1.2 } },
  });
  assert.deepEqual(Object.keys(industries).sort(), ['半導體業', '生技醫療業']);
  assert.deepEqual(industries.半導體業.map(s => s.code), ['2330', '8299', '5483']);   // 依未含風險扣分的評分排序
  const [tsmc, phison, sas] = industries.半導體業;
  assert.equal(tsmc.mkt, '上市');
  assert.equal(sas.mkt, '上櫃');
  assert.equal(phison.revYoY, null);
  assert.equal(phison.score, 60);
  assert.equal(sas.pe, null);                 // 0 不是本益比
  assert.equal(tsmc.price, 1000);
  assert.equal(sas.price, null);
  assert.equal(industries.生技醫療業[0].revYoY, 47.1);
  assert.deepEqual(summary.半導體業, { count: 3, medPe: 25, medPb: 6, medYield: 1.5, medRevYoY: 30 });
  assert.deepEqual(coverage, { rows: 5, listed: 1, otc: 3, noRevenue: 0, noIndustry: 1, noIndustryCodes: ['9999'] });
});

test('buildPeerComps：交易中但當月沒有營收列（營收 ≤0 的新藥公司）照樣進表、revYoY＝null；ETF 與無產業別者不進', () => {
  const rows = R.archiveRevenueRows(arch([{ c: '2330', n: '台積電', rev: 1000, yoy: 30 }]));
  const lookup = R.makeIndustryLookup({
    openapiRows: [{ c: '2330', ind: '半導體業' }, { c: '6919', ind: '生技醫療業' }],
    wikiStocks: { 6785: { market: '上櫃', industry: '生技醫療業' } },
  });
  const quotes = { 2330: { name: '台積電', price: 1000 }, 6919: { name: '康霈*', price: 50 }, 6785: { name: '昱展新藥' }, '0050': { name: '元大台灣50' }, 1234: { name: '無產業別' } };
  const { industries, summary, coverage } = R.buildPeerComps({ rows, lookup, quotes, bw: { 6919: { pb: 3 } } });
  assert.deepEqual(industries.生技醫療業.map(s => [s.code, s.name, s.mkt, s.revYoY, s.pb]), [['6785', '昱展新藥', '上櫃', null, null], ['6919', '康霈*', '上市', null, 3]]);
  assert.equal(summary.生技醫療業.medRevYoY, null);
  assert.equal(summary.生技醫療業.medPb, 3);
  assert.deepEqual(coverage, { rows: 1, listed: 2, otc: 1, noRevenue: 2, noIndustry: 0, noIndustryCodes: [] });
});

test('isPeerCoverageComplete／peerCompsWriteDecision：殘缺的新表不蓋掉完整的舊表', () => {
  const full = { listed: 1080, otc: 880 };
  const listedOnly = { listed: 1082, otc: 0 };
  assert.equal(R.isPeerCoverageComplete(full), true);
  assert.equal(R.isPeerCoverageComplete(listedOnly), false);
  assert.equal(R.isPeerCoverageComplete(undefined), false);
  assert.deepEqual(R.peerCompsWriteDecision(full, undefined), { write: true, complete: true });
  assert.equal(R.peerCompsWriteDecision(listedOnly, full).write, false);
  assert.equal(R.peerCompsWriteDecision(listedOnly, undefined).write, true);   // 舊版文件沒有 coverage＝本來就只有上市
  assert.equal(R.peerCompsWriteDecision(listedOnly, { listed: 1082, otc: 0 }).write, true);
});
