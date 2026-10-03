// wiki → 新聞判讀事實錨點：node --test scripts/lib/wiki-facts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWikiStocks, wikiFactLines, wikiPromptBlock } from './wiki-facts.mjs';

const wiki = {
  1303: {
    name: '南亞', mainBusiness: '各種塑膠加工品、塑膠原料、電子材料', chains: [{ name: '塑化', role: '下游', label: '塑化中下游' }],
    upstream: ['6505'], downstream: [], derivedUpstream: ['1326'], derivedDownstreamAi: ['6505'], group: '南亞關係企業群',
    profile: { src: 'ai-knowledge', summary: '台塑集團多角化廠', products: [{ name: '銅箔基板(CCL)' }], customers: [] },
  },
  6505: { name: '台塑化' }, 1326: { name: '台化' },
  1717: { name: '長興', profile: { src: 'annual-report-2025＋ai-knowledge', materials: [{ name: '苯乙烯' }] } },
};

test('facts 只放官方／站內推導；AI 輪廓進 reference 並標待驗', () => {
  const { facts, reference } = wikiFactLines('1303', wiki);
  assert.ok(facts.some(l => l.includes('主要經營業務（官方登記）')));
  assert.ok(facts.some(l => l.includes('塑化／下游·塑化中下游')));
  assert.ok(facts.some(l => l.includes('6505 台塑化')));
  assert.ok(facts.some(l => l.includes('推導上游') && l.includes('1326 台化')));
  assert.ok(facts.some(l => l.includes('南亞關係企業群')));
  assert.ok(!facts.some(l => l.includes('銅箔基板')));
  assert.ok(!facts.some(l => l.includes('推導下游')));                       // AI 推導邊不進事實區
  assert.ok(reference.some(l => l.includes('推導下游（AI 輪廓名稱比對·待驗）')));
  assert.ok(reference.some(l => l.includes('AI整理·待驗')));
});

test('年報層標「年報＋AI待驗」；查無代號回空', () => {
  assert.ok(wikiFactLines('1717', wiki).reference[0].includes('〔年報＋AI待驗〕'));
  assert.deepEqual(wikiFactLines('9999', wiki), { facts: [], reference: [] });
  assert.equal(wikiPromptBlock('9999', wiki), '');
  assert.ok(wikiPromptBlock('1303', wiki).includes('【參考·未完全驗證'));
});

test('loadWikiStocks：讀不到回 null、依 mtime 快取', () => {
  assert.equal(loadWikiStocks('/nonexistent/stocks.json'), null);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-')), 'stocks.json');
  fs.writeFileSync(f, JSON.stringify({ stocks: { 2330: { name: '台積電' } } }));
  assert.equal(loadWikiStocks(f)[2330].name, '台積電');
  assert.equal(loadWikiStocks(f), loadWikiStocks(f));
});
