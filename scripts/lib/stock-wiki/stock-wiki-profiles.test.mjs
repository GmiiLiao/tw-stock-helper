// 經營輪廓／年報管線單元測試：node --test scripts/lib/stock-wiki/stock-wiki-profiles.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeAiProfile, normEntityName, sanitizeItem, sanitizeProfile, mergeProfiles, ingestAiBatch, readProfile } from './profiles.mjs';
import { pickAnnualReport, pickPdfHref, looksLikeToc, findOperationsChapter, anchorWindows, inWindow, toAnnualProfile, nightBackfillDone, daemonLlmBusy } from './annual-report.mjs';
import { expectedFy, needsFetch, makeNameToCode, annualExtract } from './annual-runner.mjs';
import { buildModel } from './model.mjs';

const valid = new Set(['1326', '1312', '2330']);

test('sanitizeItem：去無效名稱、代號須在宇宙、信心度白名單', () => {
  assert.equal(sanitizeItem('不明'), null);
  assert.equal(sanitizeItem({ name: '' }), null);
  assert.deepEqual(sanitizeItem({ name: ' 台化 ', code: '1326', conf: '高', country: '臺灣' }, { validCodes: valid }), { name: '台化', code: '1326', conf: '高', country: '臺灣' });
  assert.equal(sanitizeItem({ name: '某公司', code: '9999' }, { validCodes: valid }).code, undefined);
  assert.equal(sanitizeItem({ name: 'x', conf: '極高' }).conf, undefined);
  assert.equal(sanitizeItem({ name: 'x'.repeat(80) }).name.length, 40);
});

test('normEntityName：中英交界空白、全形括號、地名別名統一', () => {
  assert.equal(normEntityName('AI 伺服器'), 'AI伺服器');
  assert.equal(normEntityName('EUV 曝光機'), 'EUV曝光機');
  assert.equal(normEntityName('先進封裝 （CoWoS）'), '先進封裝(CoWoS)');
  assert.equal(normEntityName('南科 Fab 12A'), '南科Fab 12A');
  assert.equal(normEntityName('中國大陸'), '中國');
  assert.equal(normEntityName('台灣'), '臺灣');
  assert.equal(normEntityName('Applied Materials'), 'Applied Materials');
  assert.equal(sanitizeItem({ name: 'x', country: '中國大陸' }).country, '中國');
});

test('sanitizeProfile：供應商／客戶／競爭者濾掉純地名，同名去重，全空回 null', () => {
  const p = sanitizeProfile({ suppliers: ['台化', '日本', '台化', { name: '中國大陸' }], materials: ['苯乙烯'], products: [] }, { defaultSrc: 'annual-report-2025' });
  assert.deepEqual(p.suppliers.map(x => x.name), ['台化']);
  assert.equal(p.materials[0].src, 'annual-report-2025');
  assert.equal(sanitizeProfile({ products: [], summary: '' }), null);
  assert.ok(sanitizeProfile({ summary: '只有摘要' }));
});

test('mergeProfiles：年報有的面向整個用年報，沒有的用 AI 補', () => {
  const annual = { src: 'annual-report-2025', products: [{ name: '合成樹脂' }], customers: [], summary: '年報' };
  const ai = { src: 'ai-knowledge', products: [{ name: '樹脂' }], customers: [{ name: 'Apple' }], summary: 'AI' };
  const m = mergeProfiles(annual, ai);
  assert.deepEqual(m.products.map(x => x.name), ['合成樹脂']);
  assert.deepEqual(m.customers.map(x => x.name), ['Apple']);
  assert.equal(m.summary, '年報');
  assert.equal(m.src, 'annual-report-2025＋ai-knowledge');
  assert.equal(mergeProfiles(null, ai), ai);
  assert.equal(mergeProfiles(null, null), null);
});

test('ingestAiBatch＋readProfile：寫單檔、回報缺漏，年報層優先讀取', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-prof-'));
  const st = ingestAiBatch(dir, { 2330: { products: ['晶圓代工'], conf: '高' }, 1326: { products: [] } }, ['2330', '1326', '1312'], valid, { asOf: '2026-10' });
  assert.deepEqual([st.written, st.empty, st.missing], [1, 1, ['1312']]);
  assert.equal(readProfile(dir, '2330').src, 'ai-knowledge');
  fs.mkdirSync(path.join(dir, 'profiles', 'annual'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'profiles', 'annual', '2330.json'), JSON.stringify({ src: 'annual-report-2025', products: [{ name: '晶圓' }] }));
  assert.deepEqual(readProfile(dir, '2330').products.map(x => x.name), ['晶圓']);
});

test('年報清單：取最新會計年度的 F04；step=9 頁取 PDF 連結', () => {
  const html = `<a href='javascript:readfile2("F","1717","2024_1717_20250620F04.pdf");'>x</a>
    <a href='javascript:readfile2("F","1717","2025_1717_20260626F04.pdf");'>x</a>
    <a href='javascript:readfile2("F","1717","2025_1717_20260626FE4.pdf");'>英文版</a>`;
  assert.deepEqual(pickAnnualReport(html), { filename: '2025_1717_20260626F04.pdf', fy: 2025 });
  assert.equal(pickAnnualReport('沒有年報'), null);
  assert.equal(pickPdfHref("電子檔案：<a href='/pdf/2025_2330_20260604F04_20261003_133446.pdf'>x</a>"), '/pdf/2025_2330_20260604F04_20261003_133446.pdf');
});

test('營運概況定位：跳過目錄頁，取到正文章節並截到財務概況前', () => {
  const toc = '肆、營運概況------------------------- 85\n一、業務內容----------------------- 85\n二、市場及產銷概況------------------ 95\n伍、財務概況------------------ 120\n';
  const body = '\n肆、營運概況\n一、業務內容\n(一)業務範圍\n主要產品 合成樹脂 48%\n(三)主要原料之供應狀況\n苯乙烯 台化\n\n伍、財務概況\n資產負債表';
  assert.ok(looksLikeToc(toc));
  assert.ok(!looksLikeToc(body));
  const ch = findOperationsChapter(`封面\n${toc}${'致股東報告書\n'.repeat(50)}${body}`);
  assert.ok(ch.trimStart().startsWith('肆、營運概況\n一、業務內容'));
  assert.ok(!ch.includes('資產負債表'));
  assert.equal(findOperationsChapter('沒有制式章節的年報'), null);
});

test('anchorWindows：每個錨點各取一段，前面的長段落不會吃掉後面的錨點', () => {
  const t = `主要產品 A${'產業概況'.repeat(3000)}主要原料 苯乙烯\n主要競爭對手 Allnex`;
  const w = anchorWindows(t, { budget: 6000 });
  assert.ok(w.anchors.includes('materials'));
  assert.ok(w.text.includes('苯乙烯'));
  assert.ok(w.text.includes('Allnex'));
  assert.ok(w.text.length <= 6000);
});

test('inWindow：台北時間、可跨午夜', () => {
  const at = (hh, mm) => Date.UTC(2026, 9, 3, hh - 8, mm);   // 台北 hh:mm
  assert.equal(inWindow(at(3, 0), '02:00-06:30'), true);
  assert.equal(inWindow(at(6, 30), '02:00-06:30'), false);
  assert.equal(inWindow(at(14, 0), '02:00-06:30'), false);
  assert.equal(inWindow(at(23, 30), '23:00-02:00'), true);
  assert.equal(inWindow(at(1, 0), '23:00-02:00'), true);
  assert.throws(() => inWindow(at(12, 0), '02:00–06:30'));   // en dash：舊版回 true＝整天跑 LLM
});

test('toAnnualProfile：依名稱補台股代號、標年報來源，全空回 null', () => {
  const nameToCode = (n) => ({ 台化: '1326', 國喬: '1312' }[n] || null);
  const p = toAnnualProfile({ suppliers: [{ name: '台化' }, { name: 'Idemitsu', country: '日本' }, { name: '日本' }], materials: ['苯乙烯'] }, { fy: 2025, validCodes: valid, nameToCode, asOf: '2025年報' });
  assert.equal(p.src, 'annual-report-2025');
  assert.deepEqual(p.suppliers.map(x => [x.name, x.code]), [['台化', '1326'], ['Idemitsu', undefined]]);
  assert.equal(toAnnualProfile({ summary: '只有摘要' }, { fy: 2025, validCodes: valid }), null);
});

test('expectedFy／needsFetch：7 月起以去年年報為準；noreport 30 天後再試', () => {
  const jun = Date.UTC(2026, 5, 15); const oct = Date.UTC(2026, 9, 3);
  assert.equal(expectedFy(jun), 2024);
  assert.equal(expectedFy(oct), 2025);
  assert.equal(needsFetch(null, oct), true);
  assert.equal(needsFetch({ status: 'text', fy: 2025 }, oct), false);
  assert.equal(needsFetch({ status: 'text', fy: 2024, fetchedAt: oct - 1000 }, oct), false);   // 晚交年報：30 天內不重抓
  assert.equal(needsFetch({ status: 'text', fy: 2024, fetchedAt: oct - 31 * 86400000 }, oct), true);
  assert.equal(needsFetch({ status: 'nochapter', fetchedAt: oct - 1000 }, oct), false);
  assert.equal(needsFetch({ status: 'noreport', fetchedAt: oct - 86400000 }, oct), false);
  assert.equal(needsFetch({ status: 'noreport', fetchedAt: oct - 31 * 86400000 }, oct), true);
});

test('makeNameToCode：簡稱、全名、去 -KY／* 都對得到', () => {
  const model = { stocks: new Map([['1326', { code: '1326', name: '台化', fullName: '台灣化學纖維股份有限公司' }], ['3661', { code: '3661', name: '世芯-KY', fullName: '世芯電子股份有限公司' }]]) };
  const f = makeNameToCode(model);
  assert.equal(f('台化'), '1326');
  assert.equal(f('臺灣化學纖維股份有限公司'), '1326');
  assert.equal(f('世芯'), '3661');
  assert.equal(f('不存在'), null);
});

test('buildModel：原料＝他人產品 ⇒ 推導上下游；台股交易對手連到個股並記反向提及', () => {
  const bk = {
    quotes: { 1326: { name: '台化', market: 'tse', price: 50 }, 1717: { name: '長興', market: 'tse', price: 40 } },
    emerging: {}, peer: { industries: {}, summary: {} }, themeChains: [], etfInfluence: null, finSummary: {}, mopsNews: [],
  };
  const profiles = {
    1326: { src: 'ai-knowledge', products: [{ name: '苯乙烯' }], customers: [] },
    1717: { src: 'annual-report-2025', materials: [{ name: '苯乙烯' }], suppliers: [{ name: '台化', code: '1326', conf: '高' }] },
  };
  const m = buildModel({ bk, twse: {}, mopsOf: () => null, profileOf: c => profiles[c] || null });
  // 一端是 AI 輪廓 ⇒ tier 'ai'（只能當參考，不進判讀事實區）
  assert.deepEqual(m.stocks.get('1717').derivedUpstream.map(x => [x.code, x.via, x.tier]), [['1326', '苯乙烯', 'ai']]);
  assert.deepEqual(m.stocks.get('1326').derivedDownstream.map(x => [x.code, x.via, x.tier]), [['1717', '苯乙烯', 'ai']]);
  assert.equal(m.stocks.get('1326').referencedBy[0].kind, 'suppliers');
  assert.equal(m.entities.suppliers.has('台化'), false);   // 台股公司不另開實體頁
  assert.ok(m.entities.materials.has('苯乙烯'));
});

test('normalizeAiProfile：忽略 AI 給的代號、改由名稱解析，來源強制 ai-knowledge', () => {
  const nameToCode = (n) => ({ 大毅: '2478' }[n] || null);
  const p = normalizeAiProfile({ src: 'annual-report-2025', competitors: [{ name: '大毅', code: '6167' }, { name: '旺詮', code: '6173' }], products: [{ name: 'x', src: 'annual-report-2025' }] }, nameToCode);
  assert.equal(p.src, 'ai-knowledge');
  assert.deepEqual(p.competitors.map(x => [x.name, x.code]), [['大毅', '2478'], ['旺詮', undefined]]);
  assert.equal(p.products[0].src, undefined);
});

function signalDir(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-'));
  for (const [n, o] of Object.entries(files)) fs.writeFileSync(path.join(d, n), JSON.stringify(o));
  return d;
}

test('daemon 訊號：夜間補判完成要同一台北日且 01:15 後；忙碌訊號過期視為不忙', () => {
  const now = Date.UTC(2026, 9, 3, 19, 0);   // 台北 10/04 03:00
  assert.equal(nightBackfillDone(signalDir({ 'night-backfill.json': { at: Date.UTC(2026, 9, 3, 17, 40) } }), now), true);    // 台北 01:40
  assert.equal(nightBackfillDone(signalDir({ 'night-backfill.json': { at: Date.UTC(2026, 9, 3, 6, 0) } }), now), false);     // 台北前一天
  assert.equal(nightBackfillDone(signalDir({}), now), false);
  assert.equal(daemonLlmBusy(signalDir({ 'llm.json': { busy: true, at: now - 60000 } }), now), true);
  assert.equal(daemonLlmBusy(signalDir({ 'llm.json': { busy: false, queue: 2, at: now - 60000 } }), now), true);
  assert.equal(daemonLlmBusy(signalDir({ 'llm.json': { busy: true, at: now - 10 * 60000 } }), now), false);
});

test('annualExtract：daemon 忙碌時等待，直到離開時段就停、不送出', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-'));
  fs.mkdirSync(path.join(dir, 'annual', 'state'), { recursive: true }); fs.mkdirSync(path.join(dir, 'annual', 'text'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'annual', 'state', '1717.json'), JSON.stringify({ status: 'text', fy: 2025, fetchedAt: 1 }));
  fs.writeFileSync(path.join(dir, 'annual', 'text', '1717.txt'), '主要原料 苯乙烯');
  let t = Date.UTC(2026, 9, 3, 22, 25);   // 台北 06:25
  const sig = signalDir({ 'llm.json': { busy: true, at: t } });
  let calls = 0;
  const st = await annualExtract(dir, { stocks: new Map([['1717', { code: '1717', name: '長興' }]]) }, ['1717'], {
    signalDir: sig, now: () => t, sleepImpl: async (ms) => { t += ms; fs.writeFileSync(path.join(sig, 'llm.json'), JSON.stringify({ busy: true, at: t })); },
    extract: async () => { calls++; return {}; }, busyWaitMs: 60000,
  });
  assert.equal(calls, 0);
  assert.equal(st.stoppedByWindow, true);
  assert.ok(st.waitedBusy >= 5);
});
