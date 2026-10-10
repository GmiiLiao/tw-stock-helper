// 主要經營業務發佈：node --test scripts/publish-company-business.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBusinessMap, cleanBusiness } from './publish-company-business.mjs';

test('cleanBusiness：去頭尾空白、空白換行併成一格，不改寫內容', () => {
  assert.equal(cleanBusiness('  製造\n  銷售　LED '), '製造 銷售 LED', '全形空白也併成一格');
  assert.equal(cleanBusiness(null), '');
});
test('buildBusinessMap：只收有主要業務且檔名與代號相符者；壞檔與空值略過', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mops-'));
  writeFileSync(join(dir, '6226.json'), JSON.stringify({ fetchedAt: 1791004583891, data: { stockId: '6226', mainBusiness: '製造、加工及銷售各種發光二極體' } }));
  writeFileSync(join(dir, '2330.json'), JSON.stringify({ fetchedAt: 1791004583000, data: { stockId: '2330', mainBusiness: '' } }));
  writeFileSync(join(dir, '1101.json'), JSON.stringify({ data: { stockId: '9999', mainBusiness: '代號不符' } }));
  writeFileSync(join(dir, '1102.json'), '{壞檔');
  writeFileSync(join(dir, 'notes.txt'), 'x');
  const r = buildBusinessMap(dir);
  assert.deepEqual(r.map, { 6226: '製造、加工及銷售各種發光二極體' });
  assert.equal(r.n, 1); assert.equal(r.bad, 2); assert.equal(r.newest, 1791004583891);
});
test('parseIndustryPage：檔數、四項中位數、相關產業鏈；缺值給 null', async () => {
  const { parseIndustryPage } = await import('./publish-company-business.mjs');
  const md = '---\ntype: "industry"\nname: "光電業"\ncount: 134\n---\n\n# 光電業\n\n產業中位數〔站內同業表〕：本益比 29.5、股價淨值比 1.9、殖利率 2.1%、月營收年增 -13.3%\n\n相關產業鏈：[[產業鏈/面板|面板]]、[[產業鏈/蘋果鏈|蘋果鏈]]\n';
  assert.deepEqual(parseIndustryPage(md), { count: 134, pe: 29.5, pb: 1.9, yield: 2.1, revYoY: -13.3, chains: ['面板', '蘋果鏈'] });
  assert.deepEqual(parseIndustryPage('---\ncount: 3\n---\n'), { count: 3, pe: null, pb: null, yield: null, revYoY: null, chains: [] });
});
