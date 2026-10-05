// 分析師資料包（W1）單元測試：全部用記憶體／暫存目錄的小型假資料，不打任何網路（globalThis.fetch 被換成會丟錯的函式）。
//   node --test scripts/lib/analyst-desk/pack.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildPack, nextTradingDay, nominalCutoffMs } from './pack.mjs';
import { REF_ID_RE, FORBIDDEN_KEY_RE, rnd } from './pack-refs.mjs';
import { nyCloseMs, expectedUsDay, taipeiMs, tpeDate } from './pack-sources.mjs';

const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error('測試不得有網路請求'); }; });
after(() => { globalThis.fetch = realFetch; });

const D = '2026-10-02'; const P = '2026-10-01'; const P2 = '2026-09-30'; const N = '2026-10-05';
const NOW = taipeiMs('2026-10-06', 9, 0); // 重播時刻（遠晚於版次截止，驗證 cutoff 會夾住）
const DAYS = ['2026-09-28', '2026-09-29', P2, P, D];
// 另有 30 個更早的平日只放 manifest（讓「上市天數」有足夠的交易日可數；新上市判斷靠這份清單）
const EARLIER = Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.UTC(2026, 7, 14 + i)); return d.toISOString().slice(0, 10); }).filter(d => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
const gz = o => gzipSync(Buffer.from(JSON.stringify(o)));
const roc = iso => `${+iso.slice(0, 4) - 1911}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
const rocCompact = iso => `${+iso.slice(0, 4) - 1911}${iso.slice(5, 7)}${iso.slice(8, 10)}`;
const rocText = iso => `${+iso.slice(0, 4) - 1911}年${iso.slice(5, 7)}月${iso.slice(8, 10)}日`;
const comma = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// ── 假宇宙 ─────────────────────────────────────────────────────────────────────────
// [code, name, 市場, 產業, 收盤D, 報酬D, 成交值百萬D, flagsD, 收盤P, 報酬P, 成交值百萬P, flagsP, 外資股D, 投信股D, 外資股P, 投信股P]
const U = [
  ['2330', '台積電', '上市', '半導體業', 2500, -0.4, 39510, 0, 2510, 1.21, 40000, 0, -5914000, 254000, -3000000, 100000],
  ['3037', '欣興', '上市', '電子零組件業', 1305, 7.41, 23509, 0, 1215, 4.5, 20000, 0, 5000000, 800000, 2000000, 300000],
  ['2002', '中鋼', '上市', '鋼鐵工業', 20, 1.0, 5000, 0, 19.8, 0.5, 4000, 0, 3000000, 500000, 1000000, 100000],
  ['1101', '台泥', '上市', '水泥工業', 25, 2.0, 4000, 0, 24.5, 0.2, 3000, 0, 1000000, 200000, 500000, 100000],   // 處置
  ['2201', '裕隆', '上市', '汽車工業', 30, 3.0, 4000, 0, 29, 0.1, 3000, 0, 1000000, 200000, 500000, 100000],       // 注意
  ['6999', '新股', '上市', '其他', 50, 5.0, 4000, 0, 48, 1.0, 3000, 0, 1000000, 200000, 500000, 100000],           // 新上市
  ['3008', '低量', '上市', '光電業', 100, 6.0, 100, 0, 94, 1.0, 100, 0, 100000, 20000, 50000, 10000],             // 成交值不足
  ['2603', '鎖死', '上市', '航運業', 200, 9.9, 9000, 5, 182, 2, 8000, 0, 1000000, 200000, 500000, 100000],         // 鎖死漲停（flags 1|4）
  ['2409', '友達', '上市', '光電業', 15, 9.8, 9000, 1, 13.7, 2, 8000, 0, 1000000, 200000, 500000, 100000],        // 漲停
  ['2412', '中華電', '上市', '通信網路業', 146, 0.34, 3500, 0, 145.5, 0.2, 3000, 0, -2000000, -300000, -1000000, -100000], // 外資投信連賣
  ['6488', '環球晶', '上櫃', '半導體業', 1190, 9.68, 18622, 0, 1085, 4.83, 26580, 0, -862867, 105839, -2244046, 983090], // 外資連賣
  ['3363', '上詮', '上櫃', '通信網路業', 100, 4.68, 2530, 0, 95.5, 1.0, 2000, 0, 800000, 300000, 100000, 50000],
  ['4772', '台特化', '上櫃', '化學工業', 60, 6.43, 1681, 0, 56.4, 1.0, 1500, 0, 300000, 100000, 100000, 20000],
];
const IND = [['半導體業', 3.0, 2.2], ['電子零組件業', 2.0, 1.5], ['鋼鐵工業', 1.5, 0.9], ['通信網路業', 1.0, 0.5], ['化學工業', 0.5, 5.9]];

function heatPayload(day, isD) {
  const k = isD ? 1 : 0;
  const stocks = U.map(r => [r[0], isD ? r[5] : r[9], isD ? r[6] : r[10], isD ? r[7] : r[11], 'C', r[3]]);
  const contrib = [{ code: '3037', name: '欣興', close: 1305, wPrev: 1.26, wClose: 1.35, ret: 7.41, pts: 45.2, sens1pctPts: 6.6 }, { code: '6488', name: '環球晶', close: 1190, wPrev: 0.2, wClose: 0.2, ret: 9.68, pts: 3, sens1pctPts: 1 }];
  const drag = [{ code: '2330', name: '台積電', close: 2500, wPrev: 41.19, wClose: 40.92, ret: -0.4, pts: isD ? -79.4 : 238.3, sens1pctPts: 198.4 }, { code: '2412', name: '中華電', close: 146, wPrev: 0.7, wClose: 0.7, ret: 0.3, pts: -1.2, sens1pctPts: 3.5 }];
  return {
    schema: 1, dataDate: day, useRules: { usedForScoring: false },
    market: { n: 1950 - k, tse: 1082, otc: 868, ew: isD ? 0.57 : 0.16, capW: isD ? 0.42 : 0.87, sigma: 2.46, up: isD ? 936 : 755, dn: isD ? 837 : 969, flat: isD ? 177 : 221, luN: isD ? 55 : 50, ldN: isD ? 5 : 4, lockU: isD ? 3 : 5, lockD: 2, valTotalM: isD ? 1144137 : 1072082 },
    universe: { total: 1970 },
    industries: IND.map(([key, heat, ew]) => ({ key, tier: '官方', n: 10, ew: isD ? ew : ew - 0.3, exMkt: isD ? ew - 0.57 : ew - 0.46, upRatio: 0.8, luN: 2, heat: isD ? heat : heat - 0.2, shape: '普遍型' }))
      .concat([{ key: '水泥工業', tier: '官方', n: 7, ew: 0.1, exMkt: -0.4, upRatio: 0.5, luN: 0, heat: null, shape: '普遍型' }]),
    index: {
      prevIndex: 48353.49, officialPts: 122.25, residualBp: 0.27, grade: '綠', top: [drag[0], ...contrib.slice(0, 1)], contributors: contrib, draggers: drag, conc10: isD ? 36.4 : 51.4, w1: 41.19,
      splits: [{ n: 5, weight: 53.65, pts: isD ? -118.8 : 300, restPts: isD ? 242.3 : 113.4, shareOfChange: null }, { n: 10, weight: 59.94, pts: isD ? -51.6 : 200, restPts: 175.2, shareOfChange: null }],
    },
    breadth: { source: '官方', up: isD ? 483 : 422, dn: isD ? 506 : 551, flat: 91, upLimit: 24, dnLimit: 1, adr: isD ? 0.488 : 0.434, net: isD ? -23 : -129, indexRetPct: isD ? 0.253 : 0.855, tseEwPct: isD ? 0.464 : 0.1, gapPp: isD ? -0.21 : 0.77 },
    sharesDisagree: [], layers: { chains: [{ key: 'PCB', tier: '站內整理', n: 5, lowN: false, ew: 2.1, exMkt: 1.5 }], segments: [], groups: [{ key: '甲集團/群', tier: '站內推導', n: 4, lowN: true, ew: 3, exMkt: 2.4 }], families: [] },
    board: {}, watch: { continue: [{ key: '化學工業', trigger: { rule: 'heat 前5' }, evidence: { level: '實測', caveat: '約40%來自連板' } }], catchup: [], risk: isD ? [{ key: '4772' }] : [] },
    stocks, sharesCorrected: [],
  };
}

function miPayload(day, isD) {
  const title = s => `${rocText(day)} ${s}`;
  const idx = [['發行量加權股價指數', isD ? '48,475.74' : '48,353.49', isD ? 122.25 : 413.36, true], ['臺灣50指數', '45,032.27', 9.39, false], ['臺灣中型100指數', '37,298.43', 368.23, true], ['小型股300指數', '14,234.82', 121.2, true],
    ['電子工業類指數', '3,088.44', 6.73, true], ['半導體類指數', '1,639.74', 2.98, false], ['金融保險類指數', '3,510.91', 3.71, false]];
  return {
    tables: [
      { title: title('價格指數(臺灣證券交易所)'), data: idx.map(([n, c, p, up]) => [n, c, up ? "<p style ='color:red'>+</p>" : "<p style ='color:green'>-</p>", String(p), '0', '']) },
      { title: title('大盤統計資訊'), data: [['1.一般股票', comma(isD ? 868804940498 : 814793705037), '1', '1']] },
      { title: title('每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))'), data: U.filter(r => r[2] === '上市').map(r => [r[0], r[1], '1,000', '10', '1,000', '1', '1', '1', String(isD ? r[4] : r[8])]) },
    ],
  };
}
const tpexPayload = (day, isD) => ({ tables: [{ date: roc(day), data: U.filter(r => r[2] === '上櫃').map(r => { const row = new Array(19).fill('0'); row[0] = r[0]; row[1] = r[1]; row[2] = String(isD ? r[4] : r[8]); row[15] = '1000'; return row; }) }] });
const t86Payload = (day, off) => ({ date: day.replace(/-/g, ''), title: `${rocText(day)} 三大法人買賣超日報`, data: U.filter(r => r[2] === '上市').map(r => { const row = new Array(19).fill('0'); row[0] = r[0]; row[4] = comma(r[12 + off]); row[10] = comma(r[13 + off]); row[11] = '1,000'; return row; }) });
const tpexInstiPayload = (day, off) => ({ tables: [{ date: roc(day), data: U.filter(r => r[2] === '上櫃').map(r => { const row = new Array(24).fill('0'); row[0] = r[0]; row[4] = comma(r[12 + off]); row[13] = comma(r[13 + off]); row[22] = '500'; return row; }) }] });

function putMirror(root, host, id, day, payload, meta = {}) {
  const dir = join(root, 'official', host, id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${day}.json.gz`), gz({ meta: { echo: day, ...meta }, payload }));
  const mf = join(dir, '_manifest.json');
  const m = existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : { id, host, rows: {} };
  m.rows[day] = { status: 'ok', file: `${day}.json.gz`, echo: day };
  writeFileSync(mf, JSON.stringify(m));
}
function putManifestOnly(root, host, id, day) {
  const dir = join(root, 'official', host, id); mkdirSync(dir, { recursive: true });
  const mf = join(dir, '_manifest.json');
  const m = existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : { id, host, rows: {} };
  m.rows[day] = { status: 'ok', file: `${day}.json.gz`, echo: day };
  writeFileSync(mf, JSON.stringify(m));
}

/** 建一份假 second-brain。opts: { risk: true|false, twseNotice: true|false } */
function makeRoot({ risk = true, twseNotice = true, wiki = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'analyst-pack-'));
  const T = 'www.twse.com.tw'; const X = 'www.tpex.org.tw'; const O = 'openapi.twse.com.tw';
  for (const d of [...EARLIER, ...DAYS.slice(0, 2)]) putManifestOnly(root, T, 'twse_mi_index', d);
  for (const [d, isD] of [[P2, false], [P, false], [D, true]]) {
    putMirror(root, T, 'twse_mi_index', d, miPayload(d, isD));
    putMirror(root, X, 'tpex_dailyquotes', d, tpexPayload(d, isD));
  }
  putMirror(root, T, 'twse_t86', D, t86Payload(D, 0)); putMirror(root, T, 'twse_t86', P, t86Payload(P, 2));
  putMirror(root, X, 'tpex_insti_dailytrade', D, tpexInstiPayload(D, 0)); putMirror(root, X, 'tpex_insti_dailytrade', P, tpexInstiPayload(P, 2));
  putMirror(root, T, 'twse_bfi82u', D, { date: D.replace(/-/g, ''), data: [['外資及陸資(不含外資自營商)', '1', '1', '2,621,799,962'], ['投信', '1', '1', '5,768,811,349'], ['自營商(自行買賣)', '1', '1', '4,741,375,500'], ['自營商(避險)', '1', '1', '-2,714,959,070'], ['合計', '1', '1', '10,417,027,741']] });
  // heatmap
  const hdir = join(root, 'daily-heatmap'); mkdirSync(hdir, { recursive: true });
  const rows = {};
  for (const [d, isD] of [[P, false], [D, true]]) { writeFileSync(join(hdir, `${d}.json.gz`), gz(heatPayload(d, isD))); rows[d] = { status: 'final', file: `${d}.json.gz`, rebuilt: !isD }; }
  writeFileSync(join(hdir, '_manifest.json'), JSON.stringify({ rows })); writeFileSync(join(hdir, 'latest.json'), JSON.stringify({ dataDate: D }));
  // chipArchive
  const cdir = join(root, 'backup', 'chipArchive'); mkdirSync(cdir, { recursive: true });
  for (const [d, isD] of [[P, false], [D, true]]) {
    writeFileSync(join(cdir, `${d}.json`), JSON.stringify({
      date: d, complete: true, otcPending: false,
      closeJson: JSON.stringify({ 2330: [2500, 1000, 0, 0, 0], 2317: [100, 500, 0, 0, 0] }), instJson: '{}',
      marginJson: JSON.stringify({ 2330: [isD ? 1000 : 900, isD ? 50 : 40], 2317: [500, 10], '00878': [999, 999] }),
      sblJson: JSON.stringify({ 2330: [3000, 100] }), dayTradeJson: JSON.stringify({ 2330: 400, 2317: 100 }), dtOtcStat: { lots: 600000 },
    }));
  }
  // otc index
  const idir = join(root, 'backup', 'indexHistory'); mkdirSync(idir, { recursive: true });
  writeFileSync(join(idir, 'otc.json'), JSON.stringify({ rowsJson: JSON.stringify({ 20260930: [1, 1, 1, 417], 20261001: [1, 1, 1, 418.82], 20261002: [1, 1, 1, 426.93] }) }));
  // wiki
  if (wiki) {
    const wdir = join(root, 'wiki', '_graph'); mkdirSync(wdir, { recursive: true });
    const stocks = {};
    for (const r of U) stocks[r[0]] = { name: r[1], market: r[2], industry: r[3], chains: r[0] === '3037' ? [{ name: 'PCB', role: '族群', label: null }] : [], group: r[0] === '3037' ? '欣興關係企業群' : null, derivedUpstream: [], derivedDownstream: [], derivedUpstreamAi: r[0] === '3037' ? ['2383'] : [], derivedDownstreamAi: [] };
    writeFileSync(join(wdir, 'stocks.json'), JSON.stringify({ generatedAt: '2026-10-05', stocks }));
  }
  // 上市日期（6999 新上市；其餘很久以前）
  putMirror(root, O, 'twse_oa_opendata_t187ap03_L', D, U.filter(r => r[2] === '上市').map(r => ({ 公司代號: r[0], 上市日期: r[0] === '6999' ? '20260920' : '20000101' })));
  putMirror(root, X, 'tpex_oa_mopsfin_t187ap03_O', D, U.filter(r => r[2] === '上櫃').map(r => ({ SecuritiesCompanyCode: r[0], DateOfListing: '20100101' })));
  // 風險旗標
  if (risk) {
    putMirror(root, O, 'twse_oa_announcement_punish', D, [{ Code: '1101', DispositionPeriod: '115/10/01～115/10/07' }, { Code: '2002', Date: rocCompact(D), DispositionPeriod: '115/10/05～115/10/09' }]);
    putMirror(root, O, 'twse_oa_announcement_notice', D, twseNotice ? [{ Code: '2201', Date: rocCompact(D) }] : [{ Number: '0', Code: '', Date: '' }]);
    putMirror(root, T, 'twse_notetrans', D, { title: `${rocText(D)} 公布注意累計次數可能達處置標準之有價證券一覽表`, data: [] });
    putMirror(root, X, 'tpex_oa_tpex_disposal_information', D, []);
    putMirror(root, X, 'tpex_oa_tpex_trading_warning_information', D, [{ Date: rocCompact(D), SecuritiesCompanyCode: '4772' }]);
    putMirror(root, X, 'tpex_bulletin_warning', D, { tables: [{ date: Number(D.replace(/-/g, '')), data: [] }] });
  }
  return root;
}

const cutoffEvening = nominalCutoffMs(D, 'evening');
const atD = (h, m = 0) => taipeiMs(D, h, m);
function makeFs(over = {}) {
  const verdicts = {
    3037: { label: '利多', confidence: '高', strength: '強', certainty: '預期', novelty: '首次', priced: '否', eventType: '擴產', basis: 'content', gate: null, reason: '擴產投資', keyQuote: 'SECRET_BODY_TEXT', impactPath: 'SECRET_IMPACT_PATH', at: atD(10) },
    6488: { label: '利空', confidence: '中', strength: '中', certainty: '已確認', novelty: '重複', priced: '是', eventType: '其他', basis: 'content', gate: null, reason: '【規則】涉檢調搜索', at: atD(11) },
    2330: { label: '利多', confidence: '高', strength: '強', certainty: '傳聞', novelty: '首次', priced: '否', eventType: '其他', basis: 'content', gate: null, reason: '傳聞導入', at: atD(12) },
    3363: { label: '利多', confidence: '低', strength: '弱', certainty: '預期', novelty: '首次', priced: '否', eventType: '其他', basis: 'title', gate: 'D-拒答門檻', reason: '資訊不足', at: atD(13) },
  };
  const nextVerdicts = {
    3363: { label: '利多', confidence: '高', strength: '強', certainty: '預期', novelty: '首次', priced: '否', eventType: '訂單', basis: 'content', gate: null, reason: '夜間判別', at: taipeiMs(D, 23, 30) },
    4772: { label: '利多', confidence: '高', strength: '強', certainty: '預期', novelty: '首次', priced: '否', eventType: '訂單', basis: 'content', gate: null, reason: '偷看（cutoff 之後）', at: taipeiMs('2026-10-03', 1, 0) },
  };
  const longBody = '內文'.repeat(400);
  const mops = {
    [D]: { day: D, items: { a: { key: 'a', code: '3037', name: '欣興', subject: '公告本公司擴產投資案', at: atD(15, 50), body: longBody }, b: { key: 'b', code: '2201', name: '裕隆', subject: '公告本公司遭檢調搜索', at: atD(16, 5), body: '搜索內文' }, c: { key: 'c', code: '6488', name: '環球晶', subject: '公告取得重大訂單', at: atD(9, 30), body: null }, d: { key: 'd', code: '2412', name: '中華電', subject: '公告召開股東常會', at: atD(10, 0) } } },
    [P]: { day: P, items: { e: { key: 'e', code: '2330', name: '台積電', subject: '公告月營收', at: taipeiMs(P, 14, 0), body: '月營收內文' } } },
  };
  const docs = {
    'system/tradingCalendar': { holidays: ['2026-10-09', '2026-10-10'], official: [], adHoc: [], coverYear: '2026', updatedAt: cutoffEvening - 86400e3 },
    [`newsVerdict/${D}`]: { date: D, dataDate: D, universeSize: 104, judged: 40, verdictJson: JSON.stringify(verdicts) },
    [`newsVerdict/${N}`]: { date: N, dataDate: N, universeSize: 73, judged: 20, verdictJson: JSON.stringify(nextVerdicts) },
    [`mopsNews/${D}`]: { date: D, dataDate: D, n: 4, itemsJson: JSON.stringify(mops[D].items) },
    [`mopsNews/${P}`]: { date: P, dataDate: P, n: 1, itemsJson: JSON.stringify(mops[P].items) },
    'catalystCalendar/latest': { updatedAt: cutoffEvening - 3600e3, from: '2026-10-04', to: '2026-11-08', events: [
      { date: N, type: 'earnings-call', code: '3363', name: '上詮', title: '上詮 法說會（14:30）' }, { date: N, type: 'exdiv', code: '2412', name: '中華電', title: '中華電 除權息（現金 1）' },
      { date: N, type: 'earnings-call', code: '3363', name: '上詮', title: '上詮 法說會（14:30）' }, { date: '2026-10-28', type: 'macro', code: null, name: 'FOMC', title: 'FOMC 利率決議' }] },
    'dividendCalendar/latest': { updatedAt: cutoffEvening, upcoming: [] },
    // 美股 10-01 場次收盤（台北 10-02 04:xx）→ evening 版可用且為收盤定版
    'globalMarkets/latest': { updatedAt: cutoffEvening, markets: [
      { sym: '^SOX', name: '費半', price: 13000.5, changePct: 1.5, prevDate: '2026-09-30', quoteAt: taipeiMs(D, 5, 15) }, { sym: '^IXIC', name: '那斯達克', price: 27000.1, changePct: 1.1, prevDate: '2026-09-30', quoteAt: taipeiMs(D, 5, 15) },
      { sym: '^GSPC', name: '標普500', price: 7700.2, changePct: 0.7, prevDate: '2026-09-30', quoteAt: taipeiMs(D, 5, 15) }, { sym: 'TWD=X', name: '美元台幣', price: 31.8, changePct: -0.28, prevDate: '2026-09-30', quoteAt: taipeiMs(D, 5, 16) },
      { sym: '^DJI', name: '道瓊', price: 51000, changePct: 0.4, prevDate: '2026-09-30', quoteAt: taipeiMs(D, 5, 14) }] },
    'adrPremium/latest': { updatedAt: taipeiMs(D, 12, 0), fx: 31.8, items: [{ adr: 'TSM', code: '2330', name: '台積電', ratio: 5, adrUsd: 472.78, fx: 31.8, implied: 3006.5, twPrice: 2500, premium: 20.26 }] },
    'taifexPositions/latest': { updatedAt: cutoffEvening, date: '20261002', foreignTxfNetOI: -3862, putCallRatio: 80.84 },
    'newsDigest/2026-10-02': { date: D, cats: [{ key: 'world', label: '全球局勢', items: [{ title: '就業數據欠佳', link: 'https://x', src: 'cna', at: atD(20) }, { title: '三天前的舊聞', link: 'https://y', src: 'cna', at: atD(20) - 3 * 86400e3 }] }] },
    ...over,
  };
  const calls = [];
  const fsGet = async (c, d) => { calls.push(`${c}/${d}`); return docs[`${c}/${d}`] ?? null; };
  return { fsGet, calls, docs };
}

let ROOT; let FS; let PACK; let PACK_LEN;
before(async () => {
  ROOT = makeRoot();
  FS = makeFs();
  PACK = await buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: FS.fsGet, now: NOW });
  PACK_LEN = Buffer.byteLength(JSON.stringify(PACK));
  if (process.env.PACK_DEBUG) console.error(JSON.stringify({ deg: PACK.degraded, ex: PACK.excluded.data.slice(0, 8), absent: PACK.meta.absentDetail }, null, 1));
});
after(() => { for (const r of [ROOT]) if (r) rmSync(r, { recursive: true, force: true }); });

const refsOf = (pack, re) => Object.entries(pack.refs).filter(([k]) => re.test(k));
const walkKeys = (o, f) => { if (Array.isArray(o)) o.forEach(x => walkKeys(x, f)); else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { f(k); walkKeys(v, f); } };

test('日期：prev 取鏡像交易日清單前一日、next 取 tradingCalendar 推得的下一交易日（略過休市日）', async () => {
  assert.deepEqual(PACK.dates, { prev: P, data: D, next: N });
  assert.equal(PACK.dataDate, D);
  assert.equal(PACK.calendar.nextTradingDay, N);
  assert.deepEqual(PACK.calendar.holidaysAhead, ['2026-10-09', '2026-10-10']);
  // 下一個平日是休市日 → 順延
  const cal = { data: { holidays: ['2026-10-05'], coverYear: 2026 } };
  assert.equal(nextTradingDay(D, cal).N, '2026-10-06');
  assert.equal(nextTradingDay('2026-10-08', { data: { holidays: ['2026-10-09', '2026-10-10'], coverYear: 2026 } }).N, '2026-10-12');
});

test('日曆取不到：退回下一個平日並標 degraded calendar:approx（不默默）', async () => {
  const pack = await buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: null, now: NOW });
  assert.equal(pack.dates.next, N);
  assert.ok(pack.degraded.includes('calendar:approx'));
  assert.ok(pack.absent.includes('tradingCalendar'));
  assert.deepEqual(pack.calendar.holidaysAhead, []);
});

test('ref id 文法、tier 合法、欄位齊全，且沒有任何 key 含禁用字樣或以 At／Date 結尾（dataDate 除外）', () => {
  const TIERS = ['官方', '官方衍生', '媒體', '站內整理', 'AI待驗', '傳聞', '先驗·未驗證'];
  for (const [id, r] of Object.entries(PACK.refs)) {
    assert.match(id, REF_ID_RE, id);
    assert.ok(!FORBIDDEN_KEY_RE.test(id), `id 含禁用字樣：${id}`);
    assert.ok(TIERS.includes(r.tier), `${id} tier=${r.tier}`);
    assert.match(r.asOf, /^\d{4}-\d{2}-\d{2}$/, id);
    assert.ok(['sg2', 'int', 'pts1', 'bn1', 'pct0', 'date', 'txt'].includes(r.fmt), `${id} fmt=${r.fmt}`);
    assert.deepEqual(Object.keys(r).filter(k => k !== 'label'), ['v', 'unit', 'fmt', 'asOf', 'tier', 'source']);
    assert.ok(typeof r.source === 'string' && r.source.length > 0);
  }
  const bad = [];
  walkKeys({ ...PACK, refs: undefined }, k => { if (FORBIDDEN_KEY_RE.test(k) || (/(At|Date)$/.test(k) && !['dataDate', 'generatedAt', 'canonicalAt', 'updatedAt'].includes(k))) bad.push(k); });
  // adverse／adverseByCard 的鍵是股票代號、pools 內是欄位名；refs 的鍵（id）另測
  assert.deepEqual(bad, []);
});

test('契約頂層欄位與鍵序固定', () => {
  assert.deepEqual(Object.keys(PACK).slice(0, 12), ['schema', 'kind', 'dataDate', 'dates', 'edition', 'refs', 'pools', 'excluded', 'adverse', 'adverseByCard', 'absent', 'degraded']);
  assert.equal(PACK.schema, 1); assert.equal(PACK.kind, 'analystPack'); assert.equal(PACK.edition, 'evening');
  assert.deepEqual(Object.keys(PACK.pools), ['prev', 'data', 'next']);
  assert.deepEqual(Object.keys(PACK.meta).slice(0, 3), ['refCount', 'bytes', 'cutoff']);
  const ids = Object.keys(PACK.refs);
  assert.deepEqual(ids, [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'refs 依 id 碼位序排列');
  assert.equal(PACK.meta.refCount, ids.length);
});

test('確定性：同輸入同輸出（位元組相同）；meta.bytes 等於自身序列化長度', async () => {
  const again = await buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: makeFs().fsGet, now: NOW });
  assert.equal(JSON.stringify(again), JSON.stringify(PACK));
  assert.equal(PACK.meta.bytes, PACK_LEN);
  // now 晚於版次截止時，cutoff 被夾在版次截止
  assert.equal(PACK.meta.cutoff, '2026-10-02T23:59:59+08:00');
});

test('數值：市場／指數／廣度／籌碼逐項對照假資料原始值，pv 為 D−1、df 為預算差（df＝v−pv）', () => {
  const v = id => PACK.refs[id]?.v;
  assert.equal(v('m.ew'), 0.57); assert.equal(v('pv.m.ew'), 0.16); assert.equal(v('df.m.ew'), 0.41);
  assert.equal(v('ix.twii.close'), 48475.74); assert.equal(v('ix.twii.pts'), 122.25); assert.equal(v('pv.ix.twii.pts'), 413.36);
  assert.equal(v('ix.twii.pct'), rnd((122.25 / (48475.74 - 122.25)) * 100, 2));
  assert.equal(v('ix.otc.close'), 426.93); assert.equal(v('ix.otc.pts'), 8.11); assert.equal(v('pv.ix.otc.pts'), 1.82);
  assert.equal(v('br.up'), 483); assert.equal(v('br.adr'), 49); assert.equal(v('pv.br.adr'), 43);
  assert.equal(v('ix.2330.pts'), -79.4); assert.equal(v('pv.ix.2330.pts'), 238.3); assert.equal(v('df.ix.2330.pts'), -317.7);
  assert.equal(v('ix.top5Pts'), -118.8); assert.equal(v('m.valTotalBn'), 11441.4); assert.equal(v('m.tseValBn'), 8688);
  // 法人估算：Σ(股數×收盤)/1e8（T86 上市）；fixture 只有 13 檔，手算
  const tseF = U.filter(r => r[2] === '上市').reduce((s, r) => s + r[12] * r[4], 0) / 1e8;
  assert.equal(v('ch.tse.foreignBn'), rnd(tseF, 1));
  const tseFP = U.filter(r => r[2] === '上市').reduce((s, r) => s + r[14] * r[8], 0) / 1e8;
  assert.equal(v('pv.ch.tse.foreignBn'), rnd(tseFP, 1));
  assert.equal(v('df.ch.tse.foreignBn'), rnd(rnd(tseF, 1) - rnd(tseFP, 1), 1));
  assert.equal(v('ch.tse.official.foreignBn'), 26.2); assert.ok(!('pv.ch.tse.official.foreignBn' in PACK.refs), '前一日官方 BFI82U 缺 → 不產生 pv／df，也不拿估算頂替');
  // 融資融券（只算 4 碼）、當沖比（同檔法）
  assert.equal(v('ch.margin.lots'), 1500); assert.equal(v('pv.ch.margin.lots'), 1400); assert.equal(v('df.ch.margin.lots'), 100);
  assert.equal(v('ch.dt.tseRatio'), rnd(((400 + 100) / (1000 + 500)) * 100, 2));
  for (const [id, r] of Object.entries(PACK.refs)) if (id.startsWith('df.')) {
    const b = id.slice(3);
    assert.ok(b in PACK.refs && `pv.${b}` in PACK.refs, `${id} 缺基底`);
    assert.ok(Math.abs(r.v - (PACK.refs[b].v - PACK.refs[`pv.${b}`].v)) < 0.0051, `${id} 應等於 v−pv`);
    assert.equal(r.asOf, D);
  }
});

test('產業：熱度名次由程式預算、n<8 無名次；watch／layers 一律「先驗·未驗證」', () => {
  const r = PACK.refs;
  assert.equal(r['ind.半導體業.heatNo'].v, 1); assert.equal(r['ind.化學工業.heatNo'].v, 5);
  assert.ok(!('ind.水泥工業.heatNo' in r) || r['ind.水泥工業.heatNo'] === undefined);
  assert.equal(r['pv.ind.半導體業.heatNo'].v, 1);
  assert.equal(r['ind.化學工業.watch'].tier, '先驗·未驗證');
  assert.match(r['ind.化學工業.lead'].v, /4772台特化\+6\.43%/);
  for (const [id, x] of refsOf(PACK, /^ly\./)) assert.equal(x.tier, '先驗·未驗證', id);
  assert.ok(Object.keys(r).some(k => /^ly\.grp\.甲集團_群\./.test(k)), '站內層級 key 的非法字元被轉成 _');
});

test('M／O 子樹分離、無任何合計欄位；O 的計數只算 O', () => {
  assert.ok(refsOf(PACK, /^nv\./).length > 0 && refsOf(PACK, /^mo\./).length > 0);
  for (const [id, r] of refsOf(PACK, /^nv\./)) assert.equal(r.tier, '媒體', id);
  for (const [id, r] of refsOf(PACK, /^mo\./)) assert.equal(r.tier, '官方', id);
  assert.ok(!Object.keys(PACK.refs).some(k => /^(nv|mo)\.(all|sum|both|combined)/.test(k)));
  // O 當範圍總則數＝4（只算官方公告），不是 4＋M 的檔數
  assert.equal(PACK.refs['mo.meta.total'].v, 4);
  assert.equal(PACK.refs['mo.meta.routine'].v, 1); // 股東常會＝例行
  assert.ok(PACK.refs['mo.meta.total'].label.includes('不與媒體加總'));
  assert.ok(!Object.keys(PACK.refs).some(k => /^nv\.meta\.(total|sum)/.test(k)));
});

test('媒體判別 nv：只放判別結果，不含新聞內文（keyQuote／impactPath）；規則覆寫、gate、傳聞可機械辨識', () => {
  const json = JSON.stringify(PACK);
  assert.ok(!json.includes('SECRET_BODY_TEXT') && !json.includes('SECRET_IMPACT_PATH'));
  const r = PACK.refs;
  assert.equal(r['nv.3037.label'].v, '利多'); assert.equal(r['nv.3037.override'].v, false);
  assert.equal(r['nv.6488.override'].v, true);
  assert.equal(r['nv.2330.certainty'].v, '傳聞');
  assert.equal(r['nv.3363.gate'].v, 'D-拒答門檻'); assert.equal(r['nv.3363.basis'].v, 'title');
  assert.ok(!Object.keys(r).some(k => /\.(keyQuote|impactPath|quotes|body)$/.test(k) && k.startsWith('nv.')));
  assert.ok(r['nv.3037.reason'].v.length <= 200);
});

test('官方公告 mo：主旨分類僅供參考、規則方向、收盤後判定、內文摘要 ≤300 字', () => {
  const r = PACK.refs;
  assert.equal(r['mo.3037.C03.subject'].v, '公告本公司擴產投資案');
  assert.equal(r['mo.3037.C03.dir'].v, '需讀內文');
  assert.equal(r['mo.3037.C03.afterClose'].v, true);
  assert.equal(r['mo.6488.C01.afterClose'].v, false);
  assert.equal(r['mo.2201.C16a.dir'].v, '−');
  assert.ok(r['mo.3037.C03.cls'].label.includes('僅供參考'));
  assert.ok(r['mo.3037.C03.body'].v.length <= 300);
  assert.equal(r['mo.3037.C03.hhmm'].v, '15:50');
});

test('時點隔離：prev 範圍 refs 的 asOf ≤ D−1；evening 版任何 ref 不得 ≥ 下一交易日；cutoff 之後的資料不進包', () => {
  for (const [id, r] of Object.entries(PACK.refs)) {
    assert.ok(r.asOf < N, `${id} asOf=${r.asOf} 不得是 N 日資料`);
    if (id.startsWith('pv.') || /^st\.\d+\.prev/.test(id) || /^nv\.\d+\.prev\./.test(id) || /^mo\.\d+\.\w+\.prev\./.test(id)) assert.ok(r.asOf <= P, `${id} asOf=${r.asOf} 應 ≤ ${P}`);
  }
  assert.ok(!('nv.4772.next.label' in PACK.refs), 'cutoff（D 23:59）之後的 verdict 不得進包');
  assert.ok('nv.3363.next.label' in PACK.refs, 'cutoff 之前（D 23:30）的夜間判別可進 next 範圍');
  assert.equal(PACK.refs['nv.3363.next.label'].asOf, D);
  // 重播時 now 早於版次截止 → 以 now 為準
  return buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: FS.fsGet, now: taipeiMs(D, 12, 0) }).then(p => {
    assert.ok(!('nv.3363.next.label' in p.refs)); assert.ok(!('mo.3037.C03.subject' in p.refs) || p.refs['mo.3037.C03.afterClose'].v);
    assert.equal(p.meta.cutoff, '2026-10-02T12:00:00+08:00');
    assert.ok(!('mo.2201.C16a.subject' in p.refs), '12:00 時 16:05 的公告尚未發生');
  });
});

test('全球時點旗標：美東時區換算（不寫死 04:00/05:00）、盤中值不採用、overnightStale', async () => {
  assert.equal(new Date(nyCloseMs('2026-10-02')).toISOString(), '2026-10-02T20:00:00.000Z'); // EDT → 台北 10-03 04:00
  assert.equal(new Date(nyCloseMs('2026-11-02')).toISOString(), '2026-11-02T21:00:00.000Z'); // EST → 台北 11-03 05:00
  assert.equal(expectedUsDay(taipeiMs(D, 23, 59)), '2026-10-01');
  assert.equal(expectedUsDay(taipeiMs('2026-10-03', 7, 30)), '2026-10-02');
  const r = PACK.refs;
  assert.equal(r['gl.sox.close'].v, 13000.5); assert.equal(r['gl.sox.close'].asOf, '2026-10-01'); // 台北 10-02 05:15＝美東 10-01 場次
  assert.equal(r['gl.meta.usDay'].v, '2026-10-01'); assert.equal(r['gl.meta.usFinal'].v, true); assert.equal(r['gl.meta.overnightStale'].v, false);
  assert.equal(r['gl.dji.close'].v, 51000);
  assert.equal(r['fx.usdtwd.price'].v, 31.8);
  assert.equal(r['gl.sox.close'].tier, '站內整理'); assert.match(r['gl.sox.close'].source, /非官方/);
  // 21:45 的覆寫（美股開盤後 15 分、盤中值）→ 不得當收盤，標「非定版」且隔夜資料視為未更新
  const intraday = makeFs({ 'globalMarkets/latest': { updatedAt: taipeiMs(D, 21, 45), markets: [{ sym: '^SOX', name: '費半', price: 1, changePct: 1, prevDate: P, quoteAt: taipeiMs(D, 21, 45) }] } });
  const p1 = await buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: intraday.fsGet, now: NOW });
  assert.ok(!('gl.sox.close' in p1.refs)); assert.ok(p1.degraded.some(d => d.startsWith('global:quote-not-final:^SOX')));
  assert.equal(p1.refs['gl.meta.usFinal'].v, false); assert.equal(p1.refs['gl.meta.overnightStale'].v, true);
  // 版次之後才寫入的報價（evening 看到 morning 才有的美股收盤）→ 不採用並標舊
  const late = makeFs({ 'globalMarkets/latest': { updatedAt: NOW, markets: [{ sym: '^SOX', name: '費半', price: 1, changePct: 1, prevDate: D, quoteAt: taipeiMs('2026-10-03', 5, 15) }] } });
  const p2 = await buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: late.fsGet, now: NOW });
  assert.ok(!('gl.sox.close' in p2.refs)); assert.ok(p2.degraded.some(d => d.startsWith('global:quote-after-cutoff')));
  assert.ok(p2.degraded.includes('global:overnight-not-updated')); assert.ok(p2.absent.includes('globalMarkets'));
  assert.equal(p2.refs['gl.meta.overnightStale'].v, true);
});

test('ADR 無報價時間：只用 updatedAt 日期並標非 PIT；晚於 cutoff 不採用', async () => {
  assert.equal(PACK.refs['adr.tsm.premium'].v, 20.26);
  assert.ok(PACK.degraded.includes('adr:non-pit'));
  const p = await buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: makeFs({ 'adrPremium/latest': { updatedAt: NOW, fx: 1, items: [{ adr: 'TSM', premium: 1 }] } }).fsGet, now: NOW });
  assert.ok(!('adr.tsm.premium' in p.refs)); assert.ok(p.absent.includes('adrPremium'));
});

test('行事曆：只放 catalystCalendar 內真有的日期、去重、不補日期；站內 foreignTxfNetOI 不暴露', () => {
  const r = PACK.refs;
  assert.ok(`cal.${N}.earnings-call.3363` in r); assert.equal(Object.keys(r).filter(k => k.startsWith(`cal.${N}.earnings-call.3363`)).length, 1);
  assert.ok(`cal.${N}.exdiv.2412` in r);
  assert.ok(Object.keys(r).every(k => !k.startsWith('cal.') || k.startsWith('cal.meta.') || /^cal\.\d{4}-\d{2}-\d{2}\./.test(k)));
  assert.ok(!Object.keys(r).some(k => k.startsWith('cal.2026-10-28.')), 'FOMC 在 N+4 日窗之外 → 不放（但 cal.meta.to 標明涵蓋範圍）');
  assert.ok(!Object.keys(r).some(k => /foreignTxfNetOI/i.test(k)));
  assert.ok(PACK.degraded.includes('taifex:pcOi-from-site-taifexPositions')); assert.equal(r['ch.fut.pcOi'].v, 80.84);
});

test('候選池 pool-v1：每池 ≤30、無重複、from 標籤；排除附原因（處置／注意／新上市／成交值不足／鎖死漲停／漲停）', () => {
  assert.ok(PACK.pools.data.length > 0 && PACK.pools.data.length <= 30);
  const codes = PACK.pools.data.map(x => x.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const x of PACK.pools.data) { assert.ok(x.name && x.market && x.industry && x.from.length > 0, x.code); assert.ok(['上市', '上櫃'].includes(x.market)); }
  const ex = Object.fromEntries(PACK.excluded.data.map(e => [e.code, e.reason]));
  assert.equal(ex['1101'], '處置'); assert.equal(ex['2201'], '注意');
  assert.equal(ex['2002'], '處置', '公告日≤D 且尚未生效（起日在 N）的處置也要排除'); assert.equal(ex['6999'], '新上市');
  assert.equal(ex['3008'], '成交值不足'); assert.equal(ex['2603'], '鎖死漲停'); assert.equal(ex['2409'], '漲停');
  for (const c of ['1101', '2201', '6999', '3008', '2603', '2409']) assert.ok(!codes.includes(c), `${c} 不得入池`);
  for (const e of PACK.excluded.data) assert.ok(['處置', '注意', '新上市', '全額交割', '鎖死漲停', '漲停', '跌停', '除權息日', '無漲跌幅', '成交值不足', '旗標不可驗證'].includes(e.reason), e.reason);
  // K1：熱度前 5 產業各 1（半導體業→2330 通過排除，報酬最高者 6488 環球晶 +9.68 優先）
  const k1 = PACK.pools.data.filter(x => x.from.includes('heat.industry')).map(x => x.industry);
  assert.ok(k1.includes('半導體業'));
  assert.ok(PACK.pools.data.find(x => x.code === '3037').from.includes('idx.contributor'));
  assert.ok(PACK.pools.data.find(x => x.code === '2330').from.includes('idx.dragger'));
  assert.ok(PACK.pools.data.find(x => x.code === '3037').from.includes('inst.fgnTrust'));
  // prev 池使用 D−1 資料：本測試無 D−1 風險快照 → strict 一律「旗標不可驗證」寧缺勿濫
  assert.equal(PACK.pools.prev.length, 0); assert.ok(PACK.excluded.prev.length > 0 && PACK.excluded.prev.every(e => e.reason === '旗標不可驗證'));
  assert.ok(PACK.degraded.includes('risk:unverifiable:prev:上市'));
});

test('名單內每檔都有自己的 st.* 事實、官方產業別與市場別；個股事實的資料日對得上', () => {
  for (const x of PACK.pools.data) {
    for (const f of ['ret', 'valM', 'close', 'flags', 'industry', 'market']) assert.ok(`st.${x.code}.${f}` in PACK.refs, `${x.code} 缺 ${f}`);
    assert.equal(PACK.refs[`st.${x.code}.ret`].asOf, D);
    assert.equal(PACK.refs[`st.${x.code}.valM`].unit, '百萬');
  }
  assert.equal(PACK.refs['st.3037.ret'].v, 7.41); assert.equal(PACK.refs['st.3037.prevRet'].v, 4.5); assert.equal(PACK.refs['st.3037.prevRet'].asOf, P);
  assert.equal(PACK.refs['st.3037.fgnBn'].v, rnd((5000000 * 1305) / 1e8, 1));
  assert.equal(PACK.refs['st.3037.flags'].v, '無'); assert.equal(PACK.refs['st.3037.lockU'].v, false);
  assert.equal(PACK.refs['wk.3037.industry'].tier, '官方'); assert.equal(PACK.refs['wk.3037.chains'].tier, '站內整理');
  assert.equal(PACK.refs['wk.3037.group'].tier, '站內整理'); assert.equal(PACK.refs['wk.3037.aiUp'].tier, 'AI待驗');
  assert.ok(PACK.degraded.some(d => d.startsWith('wiki:non-pit')) && PACK.refs['wk.3037.industry'].asOf <= D);
});

test('adverse：M 利空、O 規則方向「−」、priced:是、傳聞、外資投信連賣、除權息日；缺資料不補', () => {
  const a = PACK.adverse;
  assert.ok(a['6488'].includes('nv.6488.label'), 'M 利空');
  assert.ok(a['6488'].includes('nv.6488.priced'), 'priced:是');
  assert.ok(a['6488'].includes('st.6488.fgnBn') && a['6488'].includes('st.6488.prevFgnBn'), '外資連賣（D 與 D−1 皆為負）');
  assert.ok(!a['6488'].some(id => id.includes('trustBn')), '投信 D 為買超，不算連賣');
  assert.ok(a['2330'].includes('nv.2330.certainty'), '傳聞');
  assert.ok(a['2412']?.includes('st.2412.fgnBn') && a['2412'].includes('st.2412.trustBn'), '外資＋投信連賣');
  assert.ok(a['2412'].includes(`cal.${N}.exdiv.2412`), 'next 卡的除權息日');
  assert.deepEqual(a['3037'], []); // 乾淨：沒有反證就是空陣列（仍列出，表示已計算）
  for (const code of Object.keys(a)) { assert.deepEqual(a[code], [...a[code]].sort((x, y) => (x < y ? -1 : 1))); for (const id of a[code]) assert.ok(id in PACK.refs, `${id} 必須在 refs`); }
  // 每個入池代號都有 adverse 鍵
  for (const c of ['prev', 'data', 'next']) for (const x of PACK.pools[c]) assert.ok(x.code in a, x.code);
  // 逐卡版：prev 卡不得含 asOf > D−1 的 ref
  for (const [code, ids] of Object.entries(PACK.adverseByCard.prev)) for (const id of ids) assert.ok(PACK.refs[id].asOf <= P, `${code} ${id}`);
  // 對 O 規則方向「−」：2201 有公告但被排除（注意）→ 不在池內，adverse 不含；改以 lenient 驗 O 規則（見下一則）
});

test('風險旗標政策：strict 在上市注意股名單缺時整個上市市場不入池（旗標不可驗證）；lenient 放行並在 adverse 揭露', async () => {
  const root2 = makeRoot({ twseNotice: false });
  try {
    const strict = await buildPack({ date: D, edition: 'evening', root: root2, fsGet: FS.fsGet, now: NOW, riskPolicy: 'strict' });
    assert.ok(strict.pools.data.length > 0 && strict.pools.data.every(x => x.market === '上櫃'));
    assert.ok(strict.excluded.data.some(e => e.reason === '旗標不可驗證' && e.code === '3037'));
    assert.ok(strict.degraded.includes('risk:unverifiable:data:上市'));
    assert.ok(strict.meta.absentDetail.some(x => x.startsWith('twse_oa_announcement_notice') && x.includes('empty-shell')));
    const lenient = await buildPack({ date: D, edition: 'evening', root: root2, fsGet: FS.fsGet, now: NOW, riskPolicy: 'lenient' });
    assert.ok(lenient.pools.data.some(x => x.market === '上市'));
    assert.ok(lenient.degraded.some(d => d.startsWith('risk:partial:data:上市')));
    const c = lenient.pools.data.find(x => x.market === '上市').code;
    assert.ok(lenient.adverseByCard.data[c].includes(`st.${c}.risk`), '逐卡版：data 卡揭露注意股名單缺');
    const only = lenient.pools.data.find(x => x.market === '上市' && !lenient.pools.prev.some(y => y.code === x.code));
    if (only) assert.ok(lenient.adverse[only.code].includes(`st.${only.code}.risk`));
    const inPrev = lenient.pools.prev.find(x => x.market === '上市');
    if (inPrev) { assert.ok(lenient.adverseByCard.prev[inPrev.code].includes(`st.${inPrev.code}.prevRisk`)); assert.equal(lenient.refs[`st.${inPrev.code}.prevRisk`].asOf, P); }
    // 在 lenient 下 2201 沒有注意名單可排除 → 入池，且其 O 規則方向「−」（檢調搜索）進 adverse
    assert.ok(lenient.pools.data.some(x => x.code === '2201'));
    assert.ok(lenient.adverseByCard.data['2201'].includes('mo.2201.C16a.dir'));
    assert.ok(lenient.adverseByCard.next['2201'].includes('mo.2201.C16a.next.dir'), 'next 範圍：收盤後公告');
    assert.ok(!lenient.adverseByCard.prev['2201']?.some(id => id.startsWith('mo.2201.C16a')), 'prev 卡不得含 D 日公告（時點隔離）');
    if (lenient.pools.prev.some(x => x.code === '2201')) assert.ok(!lenient.adverse['2201'].includes('mo.2201.C16a.dir'), '同時在 prev 池時，全域 adverse 只留各卡都可引用者');
  } finally { rmSync(root2, { recursive: true, force: true }); }
  // 完全沒有風險旗標快照 → 無處置／注意名單 → 一律不入池
  const root3 = makeRoot({ risk: false });
  try {
    const p = await buildPack({ date: D, edition: 'evening', root: root3, fsGet: FS.fsGet, now: NOW });
    for (const c of ['prev', 'data', 'next']) assert.equal(p.pools[c].length, 0);
    assert.ok(p.absent.includes('riskFlags'));
    assert.ok(p.excluded.data.length > 0 && p.excluded.data.every(e => e.reason === '旗標不可驗證'));
  } finally { rmSync(root3, { recursive: true, force: true }); }
});

test('absent／degraded：沒有 Firestore 時所有 Firestore 來源列入 absent（寫「來源未提供」，不推測），且不產生對應 refs', async () => {
  const p = await buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: null, now: NOW });
  for (const n of ['newsVerdict', 'mopsNews', 'globalMarkets', 'adrPremium', 'catalystCalendar', 'newsDigest', 'tradingCalendar', 'asiaPremarket', 'sectorSpot']) assert.ok(p.absent.includes(n), n);
  assert.deepEqual(refsOf(p, /^(nv|mo|adr)\./).filter(([k]) => !k.startsWith('mo.meta.') && !k.startsWith('nv.meta.')), []);
  assert.ok(p.degraded.includes('news:coverage-low') && p.degraded.includes('global:overnight-not-updated'));
  assert.ok(p.meta.absentDetail.includes('newsVerdict:2026-10-02(no-firestore)'));
  // fsGet 丟錯 → 來源 absent（不整包失敗、不吞成空值）
  const boom = async () => { throw new Error('連線逾時'); };
  const p2 = await buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: boom, now: NOW });
  assert.ok(p2.absent.includes('newsVerdict')); assert.ok(p2.meta.absentDetail.some(x => x.includes('fsGet-error:連線逾時')));
});

test('前一日缺資料：只產生當日 refs、不產生 pv／df，且 absent／degraded 揭露（不補 0）', async () => {
  const root = makeRoot();
  try {
    rmSync(join(root, 'official', 'www.twse.com.tw', 'twse_t86', `${P}.json.gz`));
    const p = await buildPack({ date: D, edition: 'evening', root, fsGet: FS.fsGet, now: NOW });
    assert.ok(!('pv.ch.tse.foreignBn' in p.refs) && !('df.ch.tse.foreignBn' in p.refs));
    assert.ok('ch.tse.foreignBn' in p.refs);
    assert.ok(p.meta.absentDetail.some(x => x.startsWith(`twse_t86:${P}`)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('資料日不在交易日清單／熱力不可用：丟錯（硬閘門），不產生半成品', async () => {
  await assert.rejects(() => buildPack({ date: '2026-10-03', edition: 'evening', root: ROOT, fsGet: null, now: NOW }), /不在官方鏡像交易日清單/);
  const root = makeRoot();
  try {
    rmSync(join(root, 'daily-heatmap', `${D}.json.gz`));
    await assert.rejects(() => buildPack({ date: D, edition: 'evening', root, fsGet: null, now: NOW }), /熱力 .* 不可用/);
    await assert.rejects(() => buildPack({ date: D, edition: 'noon', root, fsGet: null, now: NOW }), /edition/);
  } finally { rmSync(root, { recursive: true, force: true }); }
  // date 省略＝latest.json
  const p = await buildPack({ edition: 'morning', root: ROOT, fsGet: null, now: NOW });
  assert.equal(p.dataDate, D); assert.equal(p.meta.cutoff, '2026-10-03T07:30:00+08:00');
});

test('只讀：fsGet 只被呼叫 get 形式 (collection, docId)，且未發出任何網路請求', async () => {
  const fs = makeFs();
  await buildPack({ date: D, edition: 'evening', root: ROOT, fsGet: fs.fsGet, now: NOW });
  assert.ok(fs.calls.length > 5 && fs.calls.every(c => /^[A-Za-z]+\/[^/]+$|^system\/tradingCalendar$/.test(c)));
  assert.equal(globalThis.fetch.toString().includes('測試不得有網路請求'), true);
  const src = readFileSync(new URL('./pack.mjs', import.meta.url), 'utf8') + readFileSync(new URL('./pack-sources.mjs', import.meta.url), 'utf8');
  assert.ok(!/from ['"]firebase-admin/.test(src) && !/\bfetch\(|node:https?|node:net/.test(src), '模組內不得 import firebase-admin／呼叫網路');
});

test('時間工具：台北日期與版次截止', () => {
  assert.equal(tpeDate(taipeiMs(D, 23, 59)), D); assert.equal(tpeDate(taipeiMs(D, 0, 0)), D);
  assert.equal(nominalCutoffMs(D, 'morning'), taipeiMs('2026-10-03', 7, 30));
});
