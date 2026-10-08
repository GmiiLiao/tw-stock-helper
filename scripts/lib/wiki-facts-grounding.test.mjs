// wiki-facts 年報層讀取端核對（J4-4）：node --test scripts/lib/wiki-facts-grounding.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWikiStocks, wikiFactLines, wikiPromptBlock, groundWikiAnnual, wikiGroundingReport, defaultAnnualDir, normEntityNameMirror, stripAnnualLayer } from './wiki-facts.mjs';
import { normEntityName } from './stock-wiki/profiles.mjs';
import { GROUND_VER } from './annual-grounding.mjs';

const A = 'annual-report-2025'; const AI = 'ai-knowledge';
const FILL = '本公司持續投入製程改善與品質管理，維持穩定出貨。'.repeat(40);   // 讓節錄過 800 字門檻
const OK_STATE = { status: 'text', fy: 2025, fetchedAt: 100, extractedAt: 200, anchors: ['products', 'counterparties'], extract: 'ok' };

// 1303：可用年報（部分項目要剔）；1234：0 字年報（黑松被寫成供應商台積電）；1326／1717：推導邊的另一端；9929：只有 AI 層
const TEXT = {
  1303: `${FILL}(一)主要產品為銅箔基板及環氧樹脂加工品。主要原料為環氧樹脂。(四)最近二年度主要銷貨客戶資料 名稱 金額 占全年度銷貨淨額比率(%) 1 台光電 1,234,567 15.2 無 2 A公司 456,789 10.1 無。產業上、中、下游之關聯性:台灣在世界30大貨櫃船公司就佔了四間,分別為長榮海運、陽明海運。主要競爭對手為台燿、聯茂。`,
  1234: '',
  1326: `${FILL}主要產品為環氧樹脂、聚酯纖維。`,
  1717: `${FILL}主要產品為玻纖布與樹脂。`,
  2002: `${FILL}主要產品為鋼板。`,
};
const STATE = {
  1303: OK_STATE, 1326: OK_STATE, 1717: OK_STATE,
  1234: { status: 'text', fy: 2025, fetchedAt: 100, extractedAt: 200, chapterFound: true, anchors: [], chars: 0, extract: 'ok' },
  2002: { ...OK_STATE, fetchedAt: 300, extractedAt: 200 },   // R7：節錄比萃取新
};
const stocks = () => ({
  1303: {
    name: '南亞', mainBusiness: '各種塑膠加工品', chains: [], upstream: [], downstream: [],
    derivedUpstream: ['1326', '1717'], derivedDownstream: [], derivedUpstreamAi: ['6505'], derivedDownstreamAi: [],
    profile: {
      src: `${A}＋${AI}`, asOf: '2025年報', summary: '南亞年報摘要', layers: [A, AI],
      products: [{ name: '銅箔基板', src: A }, { name: '光罩', src: A }],
      materials: [{ name: '環氧樹脂', src: A }, { name: '玻纖布', src: A }],
      customers: [{ name: '台光電', code: '2383', src: A }, { name: 'A公司', src: A }, { name: '長榮海運', code: '2603', src: A }],
      suppliers: [], equipment: [{ name: '真空壓膜機', src: A }], plants: [],
      competitors: [{ name: '台燿', src: A }, { name: '聯茂<0xEF><0xA7>', src: A }], markets: [{ name: '臺灣', src: AI }],
    },
  },
  1234: {
    name: '黑松', derivedUpstream: [], derivedDownstream: ['1717'], derivedUpstreamAi: ['1310'], derivedDownstreamAi: [],
    profile: {
      src: `${A}＋${AI}`, asOf: '2025年報', summary: '本年度營運穩健，產品線多元。', layers: [A, AI],
      products: [{ name: '玻纖布', src: A }], materials: [{ name: '苯乙烯', src: A }],
      customers: [{ name: 'NVIDIA', src: A }], suppliers: [{ name: '台積電', code: '2330', src: A }],
      equipment: [], plants: [], competitors: [{ name: '台積電', code: '2330', src: A }], markets: [],
    },
    productGeo: [{ product: '玻纖布', madeIn: ['臺灣'], soldTo: [] }],
    crossIndustries: [{ industry: '電子零組件業', via: ['玻纖布'] }],
  },
  1326: { name: '台化', derivedDownstream: ['1303'], profile: { src: `${A}＋${AI}`, products: [{ name: '環氧樹脂', src: A }], materials: [{ name: '乙烯', src: AI }] } },
  1717: { name: '長興', derivedDownstream: ['1303'], derivedUpstream: ['1234'], profile: { src: `${A}＋${AI}`, products: [{ name: '玻纖布', src: A }], materials: [{ name: '玻纖布', src: A }] } },
  2002: { name: '中鋼', profile: { src: `${A}＋${AI}`, summary: '中鋼年報摘要', products: [{ name: '鋼板', src: A }], customers: [{ name: '中鋼構', src: AI }] } },
  2003: { name: '中鋼構', profile: { src: `${A}＋${AI}`, products: [{ name: '鋼構', src: A }] } },   // 沒有 state／text
  9929: { name: '秋雨', derivedDownstreamAi: ['1341'], profile: { src: AI, summary: '印刷本業外，跨足專業區開發', products: [{ name: '印刷', src: AI }] } },
  2330: { name: '台積電' }, 2383: { name: '台光電' }, 2603: { name: '長榮' },
});
const readAnnual = (code) => (STATE[code] ? { state: STATE[code], text: TEXT[code] ?? '' } : { reason: 'no-state' });
const names = (p, k) => (p?.[k] || []).map(x => x.name);

function writeWiki(dir, data, { withAnnual = true, generatedAt = '2026-10-08' } = {}) {
  fs.mkdirSync(path.join(dir, '_graph'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_graph', 'stocks.json'), JSON.stringify({ generatedAt, stocks: data }));
  if (withAnnual) {
    for (const sub of ['state', 'text']) fs.mkdirSync(path.join(dir, '.cache', 'annual', sub), { recursive: true });
    for (const [c, s] of Object.entries(STATE)) fs.writeFileSync(path.join(dir, '.cache', 'annual', 'state', `${c}.json`), JSON.stringify(s));
    for (const [c, t] of Object.entries(TEXT)) fs.writeFileSync(path.join(dir, '.cache', 'annual', 'text', `${c}.txt`), t);
  }
  return path.join(dir, '_graph', 'stocks.json');
}
const NOW = Date.parse('2026-10-08T12:00:00+08:00');

test('可用年報：原文找不到、代號名、亂碼、關係不成立的項目剔除；AI 層原樣', () => {
  const { stocks: g, report } = groundWikiAnnual(stocks(), { readAnnual });
  const p = g[1303].profile;
  assert.deepEqual(names(p, 'products'), ['銅箔基板']);                 // 光罩：原文沒有
  assert.deepEqual(names(p, 'materials'), ['環氧樹脂']);                // 玻纖布：原文沒有
  assert.deepEqual(names(p, 'customers'), ['台光電']);                  // A公司：代號名；長榮海運：產業列舉
  assert.deepEqual(names(p, 'equipment'), []);                          // 真空壓膜機：提示詞範例回聲
  assert.deepEqual(names(p, 'competitors'), ['台燿']);                  // 聯茂<0x..>：亂碼
  assert.deepEqual(names(p, 'markets'), ['臺灣']);                      // AI 項目不動
  assert.equal(p.summary, '南亞年報摘要');                               // 非 0 字年報的摘要待使用者決定，照舊
  assert.equal(p.src, `${A}＋${AI}`);
  const why = Object.fromEntries(report.perCode[1303].dropped.map(d => [d.name, d.reason]));
  assert.deepEqual(why, { 光罩: 'not-in-text', 玻纖布: 'not-in-text', A公司: 'placeholder', 長榮海運: 'role-non-transaction', 真空壓膜機: 'not-in-text', '聯茂<0xEF><0xA7>': 'garbled' });
});

test('0 字年報整份不用：年報項目與摘要都拿掉、不由 AI 層補位；由它推出的 AI 推導邊、產品×國家、跨產業一併拿掉（J4-4）', () => {
  const { stocks: g, report } = groundWikiAnnual(stocks(), { readAnnual });
  assert.equal(g[1234].profile, null);
  assert.equal(report.perCode[1234].unusable, 'text-empty');
  assert.equal(report.perCode[1234].summaryDropped, true);
  assert.deepEqual(g[1234].derivedUpstreamAi, []);                          // 黑松「推導上游 1310 台苯」只靠幻覺原料苯乙烯
  assert.deepEqual(g[1234].productGeo, []);                                 // 「玻纖布（產 臺灣）」只靠幻覺產品
  assert.deepEqual(g[1234].crossIndustries, []);
  assert.deepEqual(report.perCode[1234].refsDropped.map(d => `${d.field}:${d.reason}`).sort(),
    ['crossIndustries:no-products-left', 'derivedUpstreamAi:self-annual-unusable', 'productGeo:no-products-left']);
  assert.deepEqual(report.annualDerivedRefs.productGeo, { dropped: 1, byReason: { 'no-products-left': 1 } });
  const { facts, reference } = wikiFactLines('1234', g);
  const all = [...facts, ...reference].join('\n');
  for (const bad of ['台積電', 'NVIDIA', '苯乙烯', '〔年報', '營運穩健', '1310', '產品×國家', '另涉產業']) assert.ok(!all.includes(bad), `不得出現 ${bad}`);
  assert.equal(wikiPromptBlock('1234', g), '');
});

test('年報衍生的參考區欄位：只剔「可證明只靠被剔除年報項目」者；靠 AI 項目或剩下年報項目支撐的不動', () => {
  const T = { 1451: `${FILL}主要產品為尼龍布。`, 2022: `${FILL}主要產品為盤元、線材。`, 1710: `${FILL}主要產品為乙二醇。` };
  const read = (c) => (T[c] ? { state: OK_STATE, text: T[c] } : { reason: 'no-state' });
  const src = {
    // 可用年報，但原料全是提示詞範例回聲（原文找不到）⇒ 原料一項不剩
    1451: { name: '年興', derivedUpstreamAi: ['1310'], derivedDownstreamAi: ['1326'],
      profile: { src: `${A}＋${AI}`, products: [{ name: '尼龍布', src: A }], materials: [{ name: '苯乙烯', src: A }, { name: '銅箔', src: A }] } },
    1310: { name: '台苯', derivedDownstreamAi: ['1451', '1326'], profile: { src: AI, products: [{ name: '苯乙烯', src: AI }] } },
    1326: { name: '台化', derivedUpstreamAi: ['1310'], profile: { src: AI, materials: [{ name: '乙烯', src: AI }], products: [{ name: '聚酯', src: AI }] } },
    // 產品留著，但產地只來自原文找不到的廠區
    2022: { name: '聚亨', productGeo: [{ product: '盤元', madeIn: ['泰國'], soldTo: [] }],
      profile: { src: `${A}＋${AI}`, products: [{ name: '盤元', src: A }], plants: [{ name: '泰國聚亨廠', country: '泰國', products: ['盤元'], src: A }] } },
    // 廠區被剔，但 AI 項目自帶產地 ⇒ 產品×國家可能另有來源，不動
    1710: { name: '東聯', productGeo: [{ product: '環氧乙烷', madeIn: ['臺灣'], soldTo: [] }],
      profile: { src: `${A}＋${AI}`, products: [{ name: '乙二醇', src: A }, { name: '環氧乙烷', src: AI, madeIn: ['臺灣'] }], plants: [{ name: '聚醚胺廠', country: '臺灣', products: ['聚醚胺'], src: A }] } },
  };
  const { stocks: g, report } = groundWikiAnnual(src, { readAnnual: read });
  assert.deepEqual(g[1451].derivedUpstreamAi, []);
  assert.deepEqual(g[1451].derivedDownstreamAi, ['1326']);                  // 產品還在（尼龍布）⇒ 不動
  assert.deepEqual(g[1310].derivedDownstreamAi, ['1326']);                  // 對方（1451）原料一項不剩
  assert.equal(g[1326], src[1326]);                                         // 兩端都是 AI 項目：原物件
  assert.deepEqual(g[2022].productGeo, []);
  assert.equal(g[1710].productGeo, src[1710].productGeo);
  const why = (c) => report.perCode[c].refsDropped.map(d => `${d.field}:${d.code ?? ''}:${d.reason}`);
  assert.deepEqual(why(1451), ['derivedUpstreamAi:1310:self-items-dropped']);
  assert.deepEqual(why(1310), ['derivedDownstreamAi:1451:partner-items-dropped']);
  assert.deepEqual(why(2022), ['productGeo::geo-source-dropped']);
  assert.deepEqual(report.annualDerivedRefs.derivedAi, { listed: 5, dropped: 2, byReason: { 'self-items-dropped': 1, 'partner-items-dropped': 1 } });
  assert.ok(!('1710' in report.perCode && report.perCode[1710].refsDropped));
});

test('R7：節錄比萃取新、年度不同、或讀不到 state ⇒ 整份不用', () => {
  const { stocks: g, report } = groundWikiAnnual(stocks(), { readAnnual });
  assert.equal(report.perCode[2002].unusable, 'text-profile-version');
  assert.deepEqual(names(g[2002].profile, 'customers'), ['中鋼構']);     // AI 項目留著
  assert.equal(g[2002].profile.src, AI);                                  // 年報層沒了，標籤不再寫〔年報〕
  assert.ok(wikiFactLines('2002', g).reference[0].includes('〔AI整理·待驗〕'));
  assert.equal(report.perCode[2003].unusable, 'no-state');
  assert.equal(g[2003].profile, null);
  const fyOff = groundWikiAnnual({ 1326: { name: '台化', profile: { src: 'annual-report-2024＋ai-knowledge', products: [{ name: '環氧樹脂', src: 'annual-report-2024' }] } } }, { readAnnual });
  assert.equal(fyOff.report.perCode[1326].unusable, 'text-profile-version');
});

test('年報推導邊：兩端年報原名都要留得下（事實區）', () => {
  const { stocks: g, report } = groundWikiAnnual(stocks(), { readAnnual });
  assert.deepEqual(g[1303].derivedUpstream, ['1326']);                    // 1717 經玻纖布：1303 的玻纖布原文沒有
  assert.deepEqual(g[1717].derivedDownstream, []);
  assert.deepEqual(g[1326].derivedDownstream, ['1303']);
  assert.deepEqual(g[1234].derivedDownstream, []);                        // 1234 年報整份不用
  assert.deepEqual(g[1717].derivedUpstream, []);
  assert.deepEqual(g[1303].derivedUpstreamAi, ['6505']);                  // AI 推導邊不動
  const reasons = report.perCode[1717].derivedDropped.map(d => `${d.dir}:${d.code}:${d.reason}`).sort();
  assert.deepEqual(reasons, ['derivedDownstream:1303:via-item-dropped', 'derivedUpstream:1234:partner-annual-unusable']);
  const facts = wikiFactLines('1303', g).facts.join('\n');
  assert.ok(facts.includes('推導上游') && facts.includes('1326 台化') && !facts.includes('1717'));
});

test('只有 AI 層的個股原物件不動；理由計數加總一致', () => {
  const src = stocks();
  const { stocks: g, report } = groundWikiAnnual(src, { readAnnual });
  assert.equal(g[9929], src[9929]);
  assert.equal(report.groundVer, GROUND_VER);
  assert.equal(report.items.dropped, Object.values(report.items.byReason).reduce((a, b) => a + b, 0));
  assert.equal(report.items.annual, report.items.kept + report.items.dropped);
  assert.equal(report.derived.annual, report.derived.kept + report.derived.dropped);
  assert.equal(report.profiles.annual, report.profiles.usable + report.profiles.unusable);
  assert.ok(!('9929' in report.perCode));
});

test('同一股票的輸出可重現：重跑、從另一份同內容的檔案載入結果都一樣', () => {
  const a = groundWikiAnnual(stocks(), { readAnnual });
  const b = groundWikiAnnual(JSON.parse(JSON.stringify(stocks())), { readAnnual });
  for (const code of ['1303', '1234', '1326', '1717', '2002', '9929']) {
    assert.deepEqual(b.stocks[code], a.stocks[code], code);
    assert.equal(wikiPromptBlock(code, b.stocks), wikiPromptBlock(code, a.stocks), code);
  }
  assert.deepEqual(b.report, a.report);
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'wfg-')); const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wfg-'));
  const w1 = loadWikiStocks(writeWiki(d1, stocks()), { now: NOW }); const w2 = loadWikiStocks(writeWiki(d2, stocks()), { now: NOW });
  for (const code of ['1303', '1234', '1717']) assert.equal(wikiPromptBlock(code, w2), wikiPromptBlock(code, w1), code);
});

test('loadWikiStocks：預設讀 stocks.json 旁的 .cache/annual；每個新版只核對一次並留一行日誌', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfg-'));
  const f = writeWiki(dir, stocks());
  fs.writeFileSync(path.join(dir, '.cache', 'annual', 'state', '2003.json'), JSON.stringify(OK_STATE));   // 有 state 沒 text
  assert.equal(defaultAnnualDir(f), path.join(dir, '_graph', '..', '.cache', 'annual'));
  const logs = [];
  const w = loadWikiStocks(f, { now: NOW, onWarn: m => logs.push(m) });
  assert.deepEqual(names(w[1303].profile, 'customers'), ['台光電']);
  assert.equal(w[1234].profile, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^wiki 年報核對 ag-.*整份不用 3 份.*text-empty 1.*placeholder 1/);
  assert.equal(loadWikiStocks(f, { now: NOW, onWarn: m => logs.push(m) }), w);   // mtime 沒變：用快取、不重核、不重報
  assert.equal(logs.length, 1);
  const r = wikiGroundingReport();
  assert.equal(r.profiles.unusable, 3);
  assert.equal(r.perCode[2003].unusable, 'no-text');
  r.profiles.unusable = 99;                                                  // 回傳的是複本
  assert.equal(wikiGroundingReport().profiles.unusable, 3);
});

test('stocks.json 讀不到：行為與現在相同（回 null、onWarn）', () => {
  const warns = [];
  assert.equal(loadWikiStocks('/nonexistent/j4/_graph/stocks.json', { onWarn: m => warns.push(m) }), null);
  assert.match(warns[0], /讀取失敗/);
});

test('年報節錄目錄讀不到：年報層整份不用（不放未核對的年報內容），AI 層與官方事實照舊', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfg-'));
  const f = writeWiki(dir, stocks(), { withAnnual: false });
  const w = loadWikiStocks(f, { now: NOW });
  assert.equal(w[1303].profile.src, AI);                                    // 年報層（含摘要）整份拿掉
  assert.ok(!('summary' in w[1303].profile));
  assert.deepEqual(names(w[1303].profile, 'customers'), []);
  assert.deepEqual(w[1303].derivedUpstream, []);
  assert.deepEqual(w[9929], stocks()[9929]);
  assert.ok(wikiPromptBlock('1303', w).includes('主要經營業務（官方登記）'));
  assert.equal(wikiGroundingReport().profiles.unusableByReason['no-state'], 6);
});

test('核對失敗的保底：年報層、年報推導邊、只靠年報項目的參考區欄位整份不用，AI 層照舊', () => {
  const g = stripAnnualLayer(stocks());
  assert.equal(g[1234].profile, null);
  assert.deepEqual(names(g[1303].profile, 'markets'), ['臺灣']);
  assert.deepEqual(names(g[1303].profile, 'customers'), []);
  assert.deepEqual(g[1303].derivedUpstream, []);
  assert.deepEqual(g[1303].derivedUpstreamAi, []);                          // 1303 的原料全是年報項目
  assert.deepEqual(g[1234].derivedUpstreamAi, []);
  assert.deepEqual(g[1234].productGeo, []);
  assert.deepEqual(names(g[1326].profile, 'materials'), ['乙烯']);          // AI 項目留著
  assert.deepEqual(g[9929], stocks()[9929]);
});

test('推導邊名稱比對口徑與 wiki normEntityName 一致', () => {
  for (const s of ['銅箔基板(CCL)', '銅箔基板（CCL）', ' 聚酯 纖維 ', '台灣', '中國大陸', 'PET ( film )', 'Epoxy Resin', '大陸']) {
    assert.equal(normEntityNameMirror(s), normEntityName(s), s);
  }
});
