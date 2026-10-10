// 上市／上櫃公司清單備援＋產業別對照 單元測試：node --test scripts/lib/company-list.test.mjs
// 不連網：直接載入 src/lib/company-list.ts（無 import、只有可剝除的型別註記，Node 25 內建型別剝除可直接載入）
// 與 trend-analysis 打包的官方鏡像快照 JSON。「openapi 失敗」＝即時清單為 null。
// 背景：2026-10-08 線上 openapi t187ap03_L 失敗＋舊備援用 process.cwd() 讀 src/（部署產物沒有）⇒ 全上市股「未分類」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lib = await import(new URL('../../src/lib/company-list.ts', import.meta.url).href);
const readText = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');
const L_RAW = JSON.parse(readText('../../src/lib/t187ap03_L_fallback.json'));
const O_RAW = JSON.parse(readText('../../src/lib/t187ap03_O_fallback.json'));
const O_TEXT = readText('../../src/lib/t187ap03_O_fallback.json');
const SERVER_SRC = readText('../../src/lib/company-list-server.ts');
const ROUTE_SRC = readText('../../src/app/api/twse/trend-analysis/route.ts');

const LISTED_FB = lib.normalizeListed(L_RAW);
const OTC_FB = lib.normalizeOtc(O_RAW);
/** TWSE 與 TPEx 的 openapi 都失敗：即時清單 null，只剩打包備援 */
const openapiDown = () => ({ listedLive: null, otcLive: null, listedFallback: LISTED_FB, otcFallback: OTC_FB });

/** 模擬 route：查公司 → 產業 → 名稱（名稱規則同 route：公司簡稱，查無用日行情證券名稱） */
function resolve(code, src, day = null) {
  const lookup = lib.findCompany(code, src);
  const industry = lib.resolveIndustry(lookup, code, day?._market);
  const name = lookup.company?.['公司簡稱'] || day?.Name || '';
  return { lookup, industry, name, note: lib.fallbackNote(lookup) };
}

test('openapi 失敗：2330 走上市備援，台積電／半導體，標備援資料日', () => {
  const r = resolve('2330', openapiDown());
  assert.equal(r.lookup.source, 'fallback');
  assert.equal(r.lookup.market, 'tse');
  assert.equal(r.name, '台積電');
  assert.equal(r.lookup.company['公司名稱'], '台灣積體電路製造股份有限公司');
  assert.equal(r.industry.code, '24');
  assert.equal(r.industry.name, '半導體');
  assert.match(r.lookup.company['董事長'], /\S/);
  assert.match(r.note, /^備援資料日 \d{4}-\d{2}-\d{2}$/);
});

test('openapi 失敗：9929 秋雨＝官方產業別 20「其他」（不是未分類）', () => {
  const r = resolve('9929', openapiDown());
  assert.equal(r.lookup.source, 'fallback');
  assert.equal(r.name, '秋雨');
  assert.equal(r.industry.code, '20');
  assert.equal(r.industry.name, '其他');
});

test('openapi 失敗：6488 上櫃走上櫃備援，環球晶／半導體', () => {
  const r = resolve('6488', openapiDown());
  assert.equal(r.lookup.source, 'fallback');
  assert.equal(r.lookup.market, 'otc');
  assert.equal(r.name, '環球晶');
  assert.equal(r.industry.code, '24');
  assert.equal(r.industry.name, '半導體');
  assert.match(r.note, /^備援資料日 \d{4}-\d{2}-\d{2}$/);
});

test('0050 ETF：公司清單沒有 ETF ⇒ 產業顯示「ETF」、名稱取日行情', () => {
  const r = resolve('0050', openapiDown(), { Name: '元大台灣50', _market: 'tse' });
  assert.equal(r.lookup.source, 'none');
  assert.equal(r.industry.name, 'ETF');
  assert.equal(r.name, '元大台灣50');
  assert.equal(r.note, '');
  for (const c of ['00878', '006208', '00632R']) assert.equal(lib.resolveIndustry(lib.findCompany(c, openapiDown()), c).name, 'ETF', c);
});

test('興櫃（日行情 _market=esb、公司清單查無）⇒ 產業顯示「興櫃」', () => {
  const code = '7999';
  assert.equal(lib.findCompany(code, openapiDown()).company, null, '前提：7999 不在上市櫃備援');
  assert.equal(resolve(code, openapiDown(), { Name: '某興櫃', _market: 'esb' }).industry.name, '興櫃');
  // 拿不到市場別時不猜興櫃，據實標「產業別未提供」
  const unknown = resolve(code, openapiDown()).industry;
  assert.equal(unknown.name, '產業別未提供');
  assert.notEqual(unknown.name, '未分類');
});

test('即時清單可用時優先，且不標備援', () => {
  const live = lib.normalizeListed([{ '出表日期': '1151007', '公司代號': '2330', '公司簡稱': '台積電LIVE', '產業別': '24' }], 1);
  const r = resolve('2330', { ...openapiDown(), listedLive: live });
  assert.equal(r.lookup.source, 'live');
  assert.equal(r.name, '台積電LIVE');
  assert.equal(r.note, '');
  assert.equal(r.lookup.asOf, '2026-10-07');
  // 即時清單有效但查無此檔 ⇒ 仍查備援並標示
  assert.equal(resolve('9929', { ...openapiDown(), listedLive: live }).lookup.source, 'fallback');
});

test('上游回 HTML／物件／null／殘缺清單一律拋錯（呼叫端改走備援）', () => {
  for (const bad of ['<html>blocked</html>', { message: 'error' }, null, undefined, 42]) {
    assert.throws(() => lib.normalizeListed(bad), /不是陣列/);
    assert.throws(() => lib.normalizeOtc(bad), /不是陣列/);
  }
  assert.throws(() => lib.normalizeListed(L_RAW.slice(0, 50)), /殘缺/);
  assert.throws(() => lib.normalizeOtc(O_RAW.slice(0, 50)), /殘缺/);
  assert.throws(() => lib.normalizeListed(L_RAW.map(r => ({ ...r, '公司代號': '' }))), /殘缺/);
});

test('上櫃欄位正規化：去全形空白、「－」視為空、信箱欄的網址清掉', () => {
  const [c] = lib.normalizeOtc([{
    Date: '1151004', SecuritiesCompanyCode: '9999', CompanyAbbreviation: '測試', SecuritiesIndustryCode: '35',
    WebAddress: 'https://x.example.com　', Symbol: 'TST　', Fax: '－', EmailAddress: 'http://www.example.com',
  }], 1);
  assert.equal(c['網址'], 'https://x.example.com');
  assert.equal(c['英文簡稱'], 'TST');
  assert.equal(c['傳真機號碼'], '');
  assert.equal(c['電子郵件信箱'], '');
  assert.equal(c['出表日期'], '1151004');
  assert.equal(lib.cleanEmail(' ir@example.com '), 'ir@example.com');
});

test('信箱欄：多個信箱逐個保留、全形＠轉半形、非信箱值清空', () => {
  // 實測 2427、5434（分號串兩個）、1805、6831（全形＠）
  assert.equal(lib.cleanEmail('wenchu@mds.com.tw; elsa@mds.com.tw'), 'wenchu@mds.com.tw,elsa@mds.com.tw');
  assert.equal(lib.cleanEmail('della.huang@topco-global.com ; rita.hsieh@topco-global.com'), 'della.huang@topco-global.com,rita.hsieh@topco-global.com');
  assert.equal(lib.cleanEmail('IR＠microloops.com'), 'IR@microloops.com');
  for (const bad of ['hunya.com.tw', '無', '0', 'N', 'http://www.cmi.com.tw', '－', '']) assert.equal(lib.cleanEmail(bad), '', bad);
});

test('兩份備援快照的每個產業代碼都有官方名稱（不落「未分類」或「產業代碼 XX」）', () => {
  for (const [list, market] of [[LISTED_FB, 'tse'], [OTC_FB, 'otc']]) {
    const codes = new Set(list.map(c => c['產業別']));
    for (const ic of codes) {
      const ind = lib.resolveIndustry({ company: { '產業別': ic }, market, source: 'fallback', asOf: null }, 'x');
      assert.ok(lib.INDUSTRY_MAP[ic], `${market} 產業代碼 ${ic} 未收錄`);
      assert.doesNotMatch(ind.name, /未分類|產業代碼|未提供/, `${market} ${ic}`);
    }
  }
  // 綠能環保 35 上市櫃都有（gap-plan 驗證項：上櫃 35 顯示綠能環保）
  const otc35 = OTC_FB.find(c => c['產業別'] === '35');
  assert.equal(resolve(otc35['公司代號'], openapiDown()).industry.name, '綠能環保');
});

test('上市／上櫃代碼差異：17 上市「金融保險」、上櫃「金融業」；未收錄代碼據實顯示', () => {
  const at = (ic, market) => lib.resolveIndustry({ company: { '產業別': ic }, market, source: 'live', asOf: null }, 'x');
  assert.equal(at('17', 'tse').name, '金融保險');
  assert.equal(at('17', 'otc').name, '金融業');
  assert.equal(at('16', 'tse').name, '觀光餐旅');
  for (const [ic, name] of [['32', '文化創意業'], ['33', '農業科技'], ['36', '數位雲端'], ['37', '運動休閒'], ['38', '居家生活'], ['91', '存託憑證']]) {
    assert.equal(at(ic, 'otc').name, name, ic);
  }
  assert.equal(at('77', 'tse').name, '產業代碼 77');
  assert.equal(lib.INDUSTRY_MAP['17'].name, '金融保險', '上櫃改名不可污染共用表');
});

test('民國日期轉換', () => {
  assert.equal(lib.rocDateToIso('1151003'), '2026-10-03');
  assert.equal(lib.rocDateToIso('991231'), '2010-12-31');
  assert.equal(lib.rocDateToIso(''), null);
  assert.equal(lib.rocDateToIso('1151399'), null);
  assert.equal(lib.rocDateToIso(undefined), null);
});

test('備援快照完整且有資料日', () => {
  assert.ok(LISTED_FB.length >= lib.MIN_LISTED_ROWS, `上市 ${LISTED_FB.length}`);
  assert.ok(OTC_FB.length >= lib.MIN_OTC_ROWS, `上櫃 ${OTC_FB.length}`);
  for (const list of [LISTED_FB, OTC_FB]) {
    assert.ok(list.every(c => lib.rocDateToIso(c['出表日期'])), '每列都要有可解析的出表日期');
    assert.ok(list.every(c => c['產業別']), '每列都要有產業別');
  }
});

test('上櫃備援檔不含 http(s) 網址（check-source-registry 只豁免上市快照）', () => {
  assert.doesNotMatch(O_TEXT, /https?:\/\//i);
});

test('備援檔靜態 import 進 bundle，不在執行期讀 src/（部署產物沒有 src/）', () => {
  assert.match(SERVER_SRC, /^import \w+ from '\.\/t187ap03_L_fallback\.json';$/m);
  assert.match(SERVER_SRC, /^import \w+ from '\.\/t187ap03_O_fallback\.json';$/m);
  const code = src => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');   // 去掉註解行（註解裡會提到舊做法）
  for (const [name, src] of [['company-list-server.ts', SERVER_SRC], ['trend-analysis/route.ts', ROUTE_SRC]]) {
    assert.doesNotMatch(code(src), /process\.cwd\(\)|readFile|from 'fs'|from 'node:fs'/, name);
  }
  // 上游都要經 memoize（合流＋負快取），不可在 GET 裡直接 fetch
  assert.match(SERVER_SRC, /memoize<CompanyInfo\[\]>\('t187ap03_L'/);
  assert.match(SERVER_SRC, /memoize<CompanyInfo\[\]>\('t187ap03_O'/);
  // L24（2026-10-10）：公告改讀 Firestore mopsNews（上市櫃重大訊息）並經 memoize；route 不再直打證交所公告頁
  assert.match(ROUTE_SRC, /memoize<MopsItem\[\]>\('mops-recent'/);
  assert.doesNotMatch(code(ROUTE_SRC), /twse\.com\.tw\/rwd\/zh\/announcement/);
  const getBody = ROUTE_SRC.slice(ROUTE_SRC.indexOf('export async function GET'), ROUTE_SRC.indexOf('// ─── Types'));
  assert.doesNotMatch(getBody, /fetch\(/);
});
