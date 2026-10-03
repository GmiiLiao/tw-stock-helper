// 產品連動（產品分類樹／產品×國家／跨產業）：node --test scripts/lib/stock-wiki/stock-wiki-products.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTaxonomy, readFamilies, readAssignments, readCanon, writeCanonBatches, taxDir } from './taxonomy.mjs';
import { sanitizeGeo, ingestAllGeo } from './ai-geo.mjs';
import { applyGeo, sanitizeItem, readProfile } from './profiles.mjs';
import { productLinesOf } from './product-links.mjs';
import { buildModel } from './model.mjs';
import { wikiFactLines } from '../wiki-facts.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-prod-'));
const put = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d)); };

const families = new Map([
  ['PCB材料', { name: 'PCB材料', industries: ['電子零組件業'], desc: '' }],
  ['石化中間體', { name: '石化中間體', industries: ['化學工業', '塑膠工業'], desc: '' }],
  ['印刷電路板', { name: '印刷電路板', industries: ['電子零組件業'], desc: '' }],
]);
const assign = new Map([['銅箔基板(CCL)', 'PCB材料'], ['CCL', 'PCB材料'], ['高速銅箔基板', 'PCB材料'], ['乙二醇(EG)', '石化中間體'], ['印刷電路板(PCB)', '印刷電路板']]);
const canon = new Map([['CCL', '銅箔基板(CCL)'], ['高速銅箔基板', 'CCL'], ['乙二醇(EG)', '印刷電路板(PCB)']]);

test('makeTaxonomy：標準名可鏈式解析、跨族合併不接受、沒分類照原名', () => {
  const t = makeTaxonomy({ families, assign, canon });
  assert.deepEqual(t.termOf('高速銅箔基板'), { canon: '銅箔基板(CCL)', family: 'PCB材料', industries: ['電子零組件業'] });
  assert.equal(t.termOf('乙二醇(EG)').canon, '乙二醇(EG)');            // 指向別族 ⇒ 不合併
  assert.deepEqual(t.termOf('未知品'), { canon: '未知品', family: null, industries: [] });
  assert.equal(t.termOf('銅箔基板 （CCL）').canon, '銅箔基板(CCL)');    // 輸入先正規化
});

test('讀三段輸出：產業不合法丟掉、族不在詞彙表丟掉、自己指自己不算合併', () => {
  const dir = tmp();
  put(taxDir(dir, 'families.json'), [{ family: 'PCB材料', industries: ['電子零組件業', '不存在業'] }, { family: 'PCB材料', industries: [] }, { family: '' }]);
  put(taxDir(dir, 'assign-out/assign-000.json'), { CCL: 'PCB材料', 怪東西: '沒這族', 空的: null });
  put(taxDir(dir, 'canon-out/canon-000.json'), { CCL: '銅箔基板(CCL)', 銅箔基板: '銅箔基板' });
  const fams = readFamilies(dir, ['電子零組件業']);
  assert.deepEqual([...fams.keys()], ['PCB材料']);
  assert.deepEqual(fams.get('PCB材料').industries, ['電子零組件業']);
  assert.deepEqual([...readAssignments(dir, fams)], [['CCL', 'PCB材料']]);
  assert.deepEqual([...readCanon(dir)], [['CCL', '銅箔基板(CCL)']]);
});

test('writeCanonBatches：同族一定同批、單一名稱的族不出題', () => {
  const dir = tmp();
  put(taxDir(dir, 'assign-out/assign-000.json'), { a1: 'A', a2: 'A', b1: 'B', b2: 'B', b3: 'B', c1: 'C' });
  const files = writeCanonBatches(dir, { maxNames: 3 });
  const batches = files.map(f => JSON.parse(fs.readFileSync(path.join(taxDir(dir, 'canon'), f), 'utf8')));
  assert.deepEqual(batches, [{ A: ['a1', 'a2'] }, { B: ['b1', 'b2', 'b3'] }]);
});

const aiProfile = { src: 'ai-knowledge', products: [{ name: '銅箔基板(CCL)' }, { name: '乙二醇(EG)' }], plants: [{ name: '昆山廠', country: '中國' }] };

test('sanitizeGeo：名稱要對上既有項目、只收高／中、國家正規化', () => {
  const g = sanitizeGeo({
    products: [
      { name: '銅箔基板 （CCL）', madeIn: ['台灣', '中國大陸', '台灣'], soldTo: ['大陸'], conf: '中' },
      { name: '乙二醇(EG)', madeIn: ['美國'], conf: '低' },
      { name: '憑空產品', madeIn: ['日本'], conf: '高' },
    ],
    plants: [{ name: '昆山廠', products: ['銅箔基板(CCL)', '不在清單'], conf: '高' }, { name: '不存在廠', products: ['銅箔基板(CCL)'], conf: '高' }],
  }, aiProfile);
  assert.deepEqual(g, {
    products: [{ name: '銅箔基板(CCL)', madeIn: ['臺灣', '中國'], soldTo: ['中國'], conf: '中' }],
    plants: [{ name: '昆山廠', products: ['銅箔基板(CCL)'], conf: '高' }],
  });
  assert.equal(sanitizeGeo({}, aiProfile), null);
  assert.equal(sanitizeGeo({ products: [] }, null), null);
});

test('applyGeo 回新物件；readProfile 把 geo 掛到 AI 層、年報層有該面向時不用 AI', () => {
  const geo = { products: [{ name: '銅箔基板(CCL)', madeIn: ['臺灣'], soldTo: [], conf: '中' }], plants: [] };
  const out = applyGeo(aiProfile, geo);
  assert.deepEqual(out.products[0].madeIn, ['臺灣']);
  assert.equal(aiProfile.products[0].madeIn, undefined);   // 不改輸入
  const dir = tmp();
  put(path.join(dir, 'profiles/ai/1303.json'), aiProfile);
  put(path.join(dir, 'profiles/ai-geo/1303.json'), geo);
  assert.deepEqual(readProfile(dir, '1303').products[0].madeIn, ['臺灣']);
  put(path.join(dir, 'profiles/annual/1303.json'), { src: 'annual-report-2025', products: [{ name: '塑膠加工品' }] });
  assert.deepEqual(readProfile(dir, '1303').products.map(p => p.name), ['塑膠加工品']);
});

test('ingestAllGeo：驗證後入庫，全空的刪掉舊檔', () => {
  const dir = tmp();
  put(path.join(dir, 'profiles/ai/1303.json'), aiProfile);
  put(path.join(dir, 'profiles/ai-geo/2330.json'), { products: [{ name: 'x' }] });
  put(path.join(dir, 'profiles/ai/2330.json'), { products: [{ name: '晶圓代工' }] });
  put(path.join(dir, 'ai/geo-out/geo-000.json'), { 1303: { products: [{ name: '乙二醇(EG)', madeIn: ['美國'], conf: '高' }] }, 2330: {}, 9999: { products: [] } });
  const st = ingestAllGeo(dir, new Set(['1303', '2330']));
  assert.deepEqual(st, { batches: 1, written: 1, empty: 1 });
  assert.equal(fs.existsSync(path.join(dir, 'profiles/ai-geo/2330.json')), false);
});

test('sanitizeItem 保留清單欄位（生產地／銷售地／廠區產品）與內外銷', () => {
  const it = sanitizeItem({ name: '昆山廠', products: ['銅箔基板 （CCL）', '銅箔基板(CCL)', ''], madeIn: ['台灣'], domestic: '1,234', export: '5,678' });
  assert.deepEqual(it.products, ['銅箔基板(CCL)']);
  assert.deepEqual(it.madeIn, ['臺灣']);
  assert.equal(it.export, '5,678');
});

test('productLinesOf：生產地＝產品 madeIn ∪ 標明生產該產品的廠區所在國', () => {
  const t = makeTaxonomy({ families, assign, canon });
  const lines = productLinesOf({
    src: 'annual-report-2025',
    products: [{ name: 'CCL', madeIn: ['臺灣'], share: '40%' }, { name: '乙二醇(EG)' }],
    plants: [{ name: '昆山廠', country: '中國', products: ['銅箔基板(CCL)'] }, { name: '德州廠', location: '美國／德州', products: ['乙二醇(EG)'] }],
  }, t.termOf);
  assert.deepEqual(lines.map(l => [l.canon, l.family, l.madeIn, l.share]), [
    ['銅箔基板(CCL)', 'PCB材料', ['臺灣', '中國'], '40%'],
    ['乙二醇(EG)', '石化中間體', ['美國'], null],
  ]);
});

test('buildModel＋分類樹：同義寫法合併成同一實體、推導上下游跨寫法接上、跨產業成員', () => {
  const bk = {
    quotes: { 1303: { name: '南亞', market: 'tse', price: 50 }, 2313: { name: '華通', market: 'tse', price: 60 } },
    emerging: {}, peer: { industries: { 塑膠工業: [{ code: '1303' }], 電子零組件業: [{ code: '2313' }] }, summary: {} },
    themeChains: [], etfInfluence: null, finSummary: {}, mopsNews: [],
  };
  const profiles = {
    1303: { src: 'ai-knowledge', products: [{ name: '銅箔基板(CCL)', madeIn: ['臺灣'] }, { name: '乙二醇(EG)' }] },
    2313: { src: 'ai-knowledge', products: [{ name: '印刷電路板(PCB)' }], materials: [{ name: '高速銅箔基板' }] },
  };
  const m = buildModel({ bk, twse: {}, mopsOf: () => null, profileOf: c => profiles[c] || null, taxonomy: makeTaxonomy({ families, assign, canon }) });
  assert.ok(m.entities.materials.has('銅箔基板(CCL)'));
  assert.ok(!m.entities.materials.has('高速銅箔基板'));
  assert.deepEqual(m.stocks.get('2313').derivedUpstream.map(x => [x.code, x.via]), [['1303', '銅箔基板(CCL)']]);
  const nanya = m.stocks.get('1303');
  assert.equal(nanya.industry.name, '塑膠工業');
  assert.deepEqual(nanya.crossIndustries.map(x => x.industry).sort(), ['化學工業', '電子零組件業'].filter(i => m.industries.has(i)).sort());
  assert.deepEqual(m.industries.get('電子零組件業').crossMembers.map(x => x.code), ['1303']);
  assert.deepEqual([...m.families.get('PCB材料').producers.keys()], ['1303']);
  assert.deepEqual([...m.families.get('PCB材料').users.keys()], ['2313']);
  assert.deepEqual([...m.productGeo.made.get('臺灣').get('1303')], ['銅箔基板(CCL)']);
});

test('wiki-facts：跨產業與產品×國家只進參考區', () => {
  const wiki = { 1303: { name: '南亞', crossIndustries: [{ industry: '電子零組件業', via: ['銅箔基板(CCL)'] }], productGeo: [{ product: '乙二醇(EG)', madeIn: ['美國'], soldTo: [] }] } };
  const { facts, reference } = wikiFactLines('1303', wiki);
  assert.equal(facts.length, 0);
  assert.ok(reference.some(l => l.includes('依產品另涉產業') && l.includes('電子零組件業（銅箔基板(CCL)）')));
  assert.ok(reference.some(l => l.includes('乙二醇(EG)（產 美國）')));
});

// ── 2026-10-03 審查補測 ──
import { writeAssignBatches } from './taxonomy.mjs';
import { renderFamily } from './render-hubs.mjs';
import { makeLinks } from './links.mjs';
import { wikiPromptBlock } from '../wiki-facts.mjs';
import { entityKey } from './model.mjs';

const bkOf = (quotes, industries = {}) => ({ quotes, emerging: {}, peer: { industries, summary: {} }, themeChains: [], etfInfluence: null, finSummary: {}, mopsNews: [] });

test('年報兩端但靠 AI 合併才接上的邊 ⇒ ai 等級；原文同名才是 annual', () => {
  const bk = bkOf({ 1303: { name: '南亞', market: 'tse', price: 50 }, 2313: { name: '華通', market: 'tse', price: 60 }, 6213: { name: '聯茂', market: 'tse', price: 70 } });
  const annual = (o) => ({ src: 'annual-report-2025', ...o });
  const profiles = {
    1303: annual({ products: [{ name: '銅箔基板(CCL)' }] }),
    6213: annual({ products: [{ name: '高速銅箔基板' }] }),
    2313: annual({ materials: [{ name: '高速銅箔基板' }] }),
  };
  const m = buildModel({ bk, twse: {}, mopsOf: () => null, profileOf: c => profiles[c] || null, taxonomy: makeTaxonomy({ families, assign, canon }) });
  const up = Object.fromEntries(m.stocks.get('2313').derivedUpstream.map(x => [x.code, x.tier]));
  assert.deepEqual(up, { 1303: 'ai', 6213: 'annual' });
});

test('標準名解析：環取字典序最小、長鏈跟到底且冪等', () => {
  const asg = new Map([['a', 'F'], ['b', 'F'], ['c', 'F'], ['d', 'F'], ['e', 'F']]);
  const cyc = makeTaxonomy({ assign: asg, canon: new Map([['a', 'b'], ['b', 'a']]) });
  assert.equal(cyc.termOf('a').canon, 'a'); assert.equal(cyc.termOf('b').canon, 'a');
  const chain = makeTaxonomy({ assign: asg, canon: new Map([['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']]) });
  assert.equal(chain.termOf('a').canon, 'e'); assert.equal(chain.termOf('d').canon, 'e');
});

test('taxonomy assign --skip-done：新批次編號接在既有輸出之後，不覆蓋舊結果', () => {
  const dir = tmp();
  put(taxDir(dir, 'families.json'), [{ family: 'PCB材料', industries: [] }]);
  put(taxDir(dir, 'assign-out/assign-000.json'), { 舊名: 'PCB材料' });
  put(taxDir(dir, 'assign-out/assign-001.json'), { 被刪族的名: '已刪的族' });
  const model = { stocks: new Map([['1', { code: '1', name: 'x', industry: null, profile: { products: [{ name: '舊名' }, { name: '新名' }, { name: '被刪族的名' }] } }]]) };
  const files = writeAssignBatches(dir, model, { skipDone: true });
  assert.deepEqual(files, ['assign-002.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(taxDir(dir, 'assign'), files[0]), 'utf8')).map(t => t.name).sort(), ['新名', '被刪族的名'].sort());
});

test('產品族頁：原料表連到 原料/、生產者表連到 產品/', () => {
  const bk = bkOf({ 1303: { name: '南亞', market: 'tse', price: 50 }, 2313: { name: '華通', market: 'tse', price: 60 } });
  const profiles = { 1303: { src: 'ai-knowledge', products: [{ name: '銅箔基板(CCL)' }] }, 2313: { src: 'ai-knowledge', materials: [{ name: 'CCL' }] } };
  const m = buildModel({ bk, twse: {}, mopsOf: () => null, profileOf: c => profiles[c] || null, taxonomy: makeTaxonomy({ families, assign, canon }) });
  const page = renderFamily(m, m.families.get('PCB材料'), makeLinks(m), '2026-10-03');
  const [prod, users] = page.split('## 以此為原料者');
  assert.ok(prod.includes('[[產品/銅箔基板(CCL)'));
  assert.ok(users.includes('[[原料/銅箔基板(CCL)') && !users.includes('[[產品/'));
});

test('生產據點國家鍵：location 推出的國家也走地名別名（台灣→臺灣）', () => {
  assert.equal(entityKey('plants', { name: '竹科廠', location: '台灣／新竹' }), '臺灣');
  assert.deepEqual(productLinesOf({ products: [{ name: 'X' }], plants: [{ name: 'p', location: '台灣／新竹', products: ['X'] }] })[0].madeIn, ['臺灣']);
});

test('wiki-facts：產品連動欄位形狀壞掉不丟錯、官方事實照出', () => {
  const wiki = { 1: { name: 'x', mainBusiness: '官方業務', crossIndustries: [{ industry: '電子零組件業' }, null], productGeo: 'bad' } };
  assert.doesNotThrow(() => wikiPromptBlock('1', wiki));
  const { facts, reference } = wikiFactLines('1', wiki);
  assert.ok(facts[0].includes('官方業務'));
  assert.ok(reference.some(l => l.includes('電子零組件業（）')));
  assert.equal(wikiFactLines('1', { 1: { name: 'x', crossIndustries: 'bad', productGeo: [{ product: 'P', madeIn: 'x' }] } }).reference.length, 0);
});
