// 台股 wiki 單元測試：node --test scripts/lib/stock-wiki/stock-wiki.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cell, normCompanyName, safeFileName, rocToIso, parseShares, countyOf, extractNotes, withNotes, NOTES_MARKER, frontmatter, wikiLink } from './util.mjs';
import { corporateHoldings, deriveGroups, isCorporateName } from './groups.mjs';
import { learnCodeNames, resolveIndustry } from './industry.mjs';
import { issuerOf, etfTags, normalizeEtfRow } from './etf.mjs';
import { flattenMops, crawlMopsCompanies, readMopsCompany, loadTwseOpenData } from './sources.mjs';
import { chainNeighbors, nearestPeers } from './model.mjs';

test('normCompanyName 去後綴並統一台／臺', () => {
  assert.equal(normCompanyName('台灣塑膠工業股份有限公司'), '臺灣塑膠工業');
  assert.equal(normCompanyName('臺灣塑膠工業(股)公司'), '臺灣塑膠工業');
  assert.equal(normCompanyName(' 宇聲投資 有限公司'), '宇聲投資');
});

test('safeFileName 把 Obsidian 禁用字元換成全形', () => {
  assert.equal(safeFileName('沛爾生醫*-創'), '沛爾生醫＊-創');
  assert.equal(safeFileName('A/B:C|D?'), 'A／B：C｜D？');
  assert.equal(wikiLink('個股', '2330 台積電', '台積電'), '[[個股/2330 台積電|台積電]]');
});

test('rocToIso 吃民國斜線、民國 7 碼、西元 8 碼', () => {
  assert.equal(rocToIso('100/10/18'), '2011-10-18');
  assert.equal(rocToIso('0920625'), '2003-06-25');
  assert.equal(rocToIso('19550207'), '1955-02-07');
  assert.equal(rocToIso('—'), null);
});

test('parseShares 解析 MOPS 股數字串', () => {
  assert.equal(parseShares('478,113,725股（含私募0股）'), 478113725);
  assert.equal(parseShares('341238364'), 341238364);
  assert.equal(parseShares(''), null);
});

test('countyOf 找地址中第一個縣市（含科學園區開頭、舊縣名）', () => {
  assert.equal(countyOf('新竹科學園區新竹市工業東二路八號'), '新竹市');
  assert.equal(countyOf('台中市沙鹿區沙田路45號'), '臺中市');
  assert.equal(countyOf('桃園縣龜山鄉'), '桃園市');
  assert.equal(countyOf('Cayman Islands'), null);
});

test('個人筆記：重建時保留標記以下內容，沒有舊檔時為空', () => {
  const v1 = withNotes('# A\n內容一', '');
  assert.ok(v1.includes(NOTES_MARKER));
  const edited = `${v1}我的筆記：留意 2nm 產能\n`;
  const v2 = withNotes('# A\n內容二', extractNotes(edited));
  assert.ok(v2.includes('內容二'));
  assert.ok(v2.endsWith('我的筆記：留意 2nm 產能\n'));
  assert.equal(extractNotes(null), '');
  assert.equal(extractNotes('沒有標記的檔'), '');
});

test('cell：表格內 wiki 連結別名用 \\|，其他直線換全形', () => {
  assert.equal(cell('[[產業/塑膠工業|塑膠工業]] a|b'), '[[產業/塑膠工業\\|塑膠工業]] a｜b');
  assert.equal(cell(null), '—');
});

test('frontmatter 略過空值、陣列加引號', () => {
  const fm = frontmatter({ code: '2330', tags: ['個股', '上市'], empty: '', none: null, list: [] });
  assert.equal(fm, '---\ncode: "2330"\ntags: ["個股", "上市"]\n---');
});

test('corporateHoldings 只取法人「本人」列，同公司同法人合併並取最大持股', () => {
  const rows = [
    { 公司代號: '1303', 職稱: '董事本人', 姓名: '台灣塑膠工業股份有限公司', 目前持股: '783356866' },
    { 公司代號: '1303', 職稱: '董事之法人代表人', 姓名: '柯有明', 目前持股: '0' },
    { 公司代號: '1303', 職稱: '董事本人', 姓名: '王文淵', 目前持股: '100' },
    { 公司代號: '1303', 職稱: '大股東本人', 姓名: '臺灣塑膠工業股份有限公司', 目前持股: '1' },
  ];
  const out = corporateHoldings(rows, [{ 公司代號: '1104', 大股東名稱: '宇聲投資股份有限公司' }]);
  assert.equal(out.length, 2);
  const fpc = out.find(x => x.code === '1303');
  assert.equal(fpc.rel, 'major_holder');
  assert.equal(fpc.shares, 783356866);
  assert.ok(isCorporateName('財團法人研華文教基金會'));
  assert.ok(!isCorporateName('王文淵'));
});

function company(code, name, fullName, mktCap, shares) { return [code, { code, name, fullName, mktCap, shares }]; }

test('deriveGroups：每家只連最大法人股東，次要股東不串群（防橋接）', () => {
  const companies = new Map([
    company('1301', '台塑', '台灣塑膠工業股份有限公司', 500, 1000),
    company('1303', '南亞', '南亞塑膠工業股份有限公司', 400, 1000),
    company('2412', '中華電', '中華電信股份有限公司', 900, 1000),
    company('9999', '某合資', '某合資股份有限公司', 10, 1000),
    company('8888', '另一家', '另一家股份有限公司', 20, 1000),
  ]);
  const holdings = [
    { code: '1303', holder: '台灣塑膠工業股份有限公司', rel: 'director', shares: 99 },        // 9.9% → 上層
    { code: '9999', holder: '南亞塑膠工業股份有限公司', rel: 'director', shares: 300 },        // 30% → 上層
    { code: '9999', holder: '中華電信股份有限公司', rel: 'director', shares: 60 },            // 6% 次要 → 不串
    { code: '8888', holder: '中華電信股份有限公司', rel: 'director', shares: 80 },            // 8% → 中華電群
    { code: '8888', holder: '行政院國家發展基金管理會', rel: 'major_holder', shares: 0 },     // 公股 → 不串
  ];
  const g = deriveGroups(holdings, companies);
  const groupOf = (c) => g.groupOf.get(c);
  assert.equal(groupOf('1301'), groupOf('1303'));
  assert.equal(groupOf('9999'), groupOf('1301'));
  assert.notEqual(groupOf('8888'), groupOf('1301'));
  assert.equal(groupOf('8888'), groupOf('2412'));
  assert.equal(g.groups.find(x => x.members.includes('1301')).name, '台塑關係企業群');
  assert.equal(g.holders.get('行政院國家發展基金管理會').kind, 'public');
  const parent9999 = g.links.find(l => l.to === '9999' && l.isParent);
  assert.equal(parent9999.from, '1303');
});

test('deriveGroups：持股 <5% 且非大股東不當上層；共同家族投資公司串成同群', () => {
  const companies = new Map([company('1111', 'A', 'A股份有限公司', 1, 1000), company('2222', 'B', 'B股份有限公司', 2, 1000), company('3333', 'C', 'C股份有限公司', 3, 1000)]);
  const g = deriveGroups([
    { code: '1111', holder: '家族投資股份有限公司', rel: 'director', shares: 100 },
    { code: '2222', holder: '家族投資股份有限公司', rel: 'major_holder', shares: 0 },
    { code: '3333', holder: '家族投資股份有限公司', rel: 'director', shares: 10 },   // 1% → 不串
  ], companies);
  assert.equal(g.groupOf.get('1111'), g.groupOf.get('2222'));
  assert.equal(g.groupOf.get('3333'), undefined);
});

test('產業別：MOPS 優先，學出代碼對照，最後才用站內同業表', () => {
  const names = learnCodeNames([['24', '半導體業'], ['24', '半導體業'], ['99', '新類別']]);
  assert.equal(names['24'], '半導體業');
  assert.equal(names['99'], '新類別');
  assert.deepEqual(resolveIndustry({ mopsName: '光電業', twseCode: '24' }, names), { name: '光電業', src: 'mops-t05st03' });
  assert.deepEqual(resolveIndustry({ twseCode: '24' }, names), { name: '半導體業', src: 'twse-t187ap03' });
  assert.deepEqual(resolveIndustry({ peerName: '其他業' }, names), { name: '其他', src: 'peerComps' });
  assert.equal(resolveIndustry({}, names), null);
});

test('ETF：發行投信由名稱推導，長前綴優先；類型轉標籤', () => {
  assert.equal(issuerOf('元大台灣卓越50證券投資信託基金'), '元大投信');
  assert.equal(issuerOf('大華銀台灣精選基金'), '大華銀投信');
  assert.equal(issuerOf('期元大S&P原油反1'), '元大期貨');
  assert.equal(issuerOf('不明基金'), null);
  assert.deepEqual(etfTags('槓桿/反向指數股票型基金', '否'), ['槓桿反向', '國內成分']);
  assert.deepEqual(etfTags('國外成分證券指數股票型基金', '是'), ['國外成分']);
  const e = normalizeEtfRow({ 基金代號: '0050', 基金簡稱: '元大台灣50', 基金中文名稱: '元大台灣卓越50證券投資信託基金', 基金類型: '國內成分證券指數股票型基金', '標的指數/追蹤指數名稱': '臺灣50指數', 是否包含國外成分股: '否', 成立日期: '0920625', 上市日期: '0920630', '發行單位數/轉換數': '22166500000', 出表日期: '1151002' });
  assert.equal(e.index, '臺灣50指數');
  assert.equal(e.listDate, '2003-06-30');
  assert.equal(e.units, 22166500000);
});

test('flattenMops 去掉隱藏與空值', () => {
  assert.deepEqual(flattenMops({ a: { value: ' x ', isHidden: false }, b: { value: 'y', isHidden: true }, c: { value: '-', isHidden: false }, d: { value: false, isHidden: false } }), { a: 'x', d: false });
});

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'stock-wiki-')); }
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test('crawlMopsCompanies：成功寫快取、查無記 notFound、新鮮快取跳過', async () => {
  const dir = tmpDir();
  const fetchImpl = async (url, opt) => {
    const id = JSON.parse(opt.body).companyId;
    if (id === '0000') return okJson({ code: 500, message: '公司代號格式錯誤' });
    return okJson({ code: 200, result: { companyName: { value: `公司${id}`, isHidden: false } } });
  };
  const s1 = await crawlMopsCompanies(dir, ['1111', '0000'], { fetchImpl, sleepImpl: async () => {} });
  assert.deepEqual([s1.fetched, s1.notFound, s1.failed], [1, 1, 0]);
  assert.equal(readMopsCompany(dir, '1111').data.companyName, '公司1111');
  assert.equal(readMopsCompany(dir, '0000').notFound, true);
  const s2 = await crawlMopsCompanies(dir, ['1111', '0000'], { fetchImpl, sleepImpl: async () => {} });
  assert.equal(s2.cached, 2);
});

test('crawlMopsCompanies：HTTP 錯誤連續失敗會暫停，超過 3 次暫停就中止', async () => {
  const dir = tmpDir(); let pauses = 0;
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const sleepImpl = async (ms) => { if (ms > 10000) pauses++; };
  const codes = Array.from({ length: 20 }, (_, i) => String(1000 + i));
  const s = await crawlMopsCompanies(dir, codes, { fetchImpl, sleepImpl, pauseMs: 60000 });
  assert.equal(s.aborted, true);
  assert.equal(pauses, 3);
  assert.equal(s.failed, 12);
});

test('loadTwseOpenData：失敗時回舊快取（stale-if-error），沒有快取回空並帶錯誤', async () => {
  const dir = tmpDir();
  const r1 = await loadTwseOpenData(dir, 'x', { fetchImpl: async () => okJson([{ a: 1 }]), now: 1 });
  assert.equal(r1.from, 'net');
  const r2 = await loadTwseOpenData(dir, 'x', { refresh: true, fetchImpl: async () => { throw new Error('boom'); }, now: 2 });
  assert.equal(r2.from, 'stale'); assert.equal(r2.rows.length, 1);
  const r3 = await loadTwseOpenData(dir, 'y', { fetchImpl: async () => ({ ok: false, status: 302 }) });
  assert.equal(r3.from, 'none'); assert.equal(r3.rows.length, 0);
});

test('chainNeighbors／nearestPeers：依角色分上下游、同產業取市值最近', () => {
  const st = (code, mktCap, chains = []) => [code, { code, mktCap, industry: { name: '半導體業' }, chains }];
  const model = {
    stocks: new Map([st('A', 100, [{ key: 'k', role: '中游', label: '組裝' }]), st('B', 90), st('C', 10), st('D', 1000)]),
    industries: new Map([['半導體業', { members: ['D', 'A', 'B', 'C'] }]]),
    chains: [{ key: 'k', name: '鏈', segs: [{ role: '上游', label: '晶片', codes: ['B'] }, { role: '中游', label: '組裝', codes: ['A'] }, { role: '下游', label: '散熱', codes: ['C'] }] }],
  };
  const [n] = chainNeighbors(model, 'A');
  assert.deepEqual(n.upstream.map(x => x.code), ['B']);
  assert.deepEqual(n.downstream.map(x => x.code), ['C']);
  // B 距離最近；C、D 同距（log 差 1）時維持產業成員順序（D 在前）
  assert.deepEqual(nearestPeers(model, 'A', 2), ['B', 'D']);
});

test('crawlMopsCompanies：既有好資料遇到「查無」不覆蓋；系統忙碌類業務碼算故障', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'mops-t05st03'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mops-t05st03', '2330.json'), JSON.stringify({ fetchedAt: 1, data: { companyName: '台積電' } }));
  const busy = async () => okJson({ code: 500, message: '系統忙碌中' });
  const s1 = await crawlMopsCompanies(dir, ['2330'], { fetchImpl: busy, sleepImpl: async () => {}, now: () => 40 * 86400000 });
  assert.equal(s1.failed, 1);
  assert.equal(readMopsCompany(dir, '2330').data.companyName, '台積電');
  const gone = async () => okJson({ code: 500, message: '查無公司資料' });
  await crawlMopsCompanies(dir, ['2330'], { fetchImpl: gone, sleepImpl: async () => {}, now: () => 40 * 86400000 });
  const after = readMopsCompany(dir, '2330');
  assert.equal(after.data.companyName, '台積電');
  assert.ok(after.lastMiss.includes('查無'));
});

test('deriveGroups：法人只用全名比對（簡稱同名不同公司不配）；持股 >100% 視為未知', () => {
  const companies = new Map([company('2425', '承啟', '承啟科技股份有限公司', 10, 1000), company('2505', '國揚', '國揚實業股份有限公司', 5, 1000), company('2321', '東訊', '東訊股份有限公司', 1, 100)]);
  const g = deriveGroups([
    { code: '2505', holder: '承啟股份有限公司', rel: 'director', shares: 61 },
    { code: '2321', holder: '國揚實業股份有限公司', rel: 'director', shares: 116 },
  ], companies);
  const l1 = g.links.find(l => l.to === '2505');
  assert.equal(l1.from, null);           // 不是 2425
  assert.equal(l1.kind, 'private');
  const l2 = g.links.find(l => l.to === '2321');
  assert.equal(l2.from, '2505');
  assert.equal(l2.stake, null);
});

test('nearestPeers：市值未知不列，候選也排除市值未知者', () => {
  const st = (code, mktCap) => [code, { code, mktCap, industry: { name: 'X' }, chains: [] }];
  const model = { stocks: new Map([st('A', null), st('B', 100), st('C', null), st('D', 90)]), industries: new Map([['X', { members: ['A', 'B', 'C', 'D'] }]]), chains: [] };
  assert.deepEqual(nearestPeers(model, 'A'), []);
  assert.deepEqual(nearestPeers(model, 'B'), ['D']);
});

test('completenessProblems：備份缺檔、少一個市場、檔數驟減都擋下重建', async () => {
  const { completenessProblems } = await import('./build.mjs');
  const model = { stocks: new Map(Array.from({ length: 100 }, (_, i) => [String(1000 + i), {}])) };
  const ok = { missing: [], quotes: { 1: { market: 'tse' }, 2: { market: 'otc' } } };
  assert.deepEqual(completenessProblems(ok, model, { stocks: 100 }), []);
  assert.ok(completenessProblems({ ...ok, missing: ['backup/singletons.json'] }, model, null)[0].includes('備份缺'));
  assert.ok(completenessProblems({ missing: [], quotes: { 1: { market: 'tse' } } }, model, null).some(p => p.includes('上櫃')));
  assert.ok(completenessProblems(ok, model, { stocks: 200 }).some(p => p.includes('少超過 5%')));
});
