// 投資論點口徑重測純函式測試：node --test scripts/lib/thesis-rebase.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from './thesis-rebase.mjs';

const R = (key, ok) => ({ key, label: `L-${key}`, ok });
const results = [R('score60', false), R('bullSignal', false), R('foreignBuy', true), R('revGrowth', true), R('rs70', false), R('yield4', false)];

test('draftPillars：成立者＝支柱、不成立前三＝風險（與建立論點同一規則）', () => {
  const d = T.draftPillars(results);
  assert.deepEqual(d.pillars.map(p => p.key), ['foreignBuy', 'revGrowth']);
  assert.ok(d.pillars.every(p => p.ok));
  assert.deepEqual(d.risks, ['L-score60：目前不成立', 'L-bullSignal：目前不成立', 'L-rs70：目前不成立']);
  assert.equal(d.aiText, '（AI 依據）L-foreignBuy、L-revGrowth。');
});

test('draftPillars：一根都不成立時取前三根（全 ✗）當支柱、文字為草稿提示', () => {
  const d = T.draftPillars(results.map(r => ({ ...r, ok: false })));
  assert.deepEqual(d.pillars.map(p => p.key), ['score60', 'bullSignal', 'foreignBuy']);
  assert.match(d.aiText, /草稿/);
});

test('draftThesisText：有持股備註時接在前面', () => {
  assert.equal(T.draftThesisText('長抱', 'X。'), '長抱｜X。');
  assert.equal(T.draftThesisText(null, 'X。'), 'X。');
});

test('isIntact：多數支柱成立；沒有支柱視為成立', () => {
  assert.equal(T.isIntact([]), true);
  assert.equal(T.isIntact([{ ok: true }, { ok: false }]), true);
  assert.equal(T.isIntact([{ ok: false }, { ok: false }, { ok: true }]), false);
});

test('needsRebase：有舊論點且口徑不同才重測；空文件與已切換者不重測', () => {
  assert.equal(T.needsRebase(null), false);
  assert.equal(T.needsRebase({ theses: {} }), false);
  assert.equal(T.needsRebase({ theses: { 2330: {} } }), true);
  assert.equal(T.needsRebase({ theses: { 2330: {} }, basis: T.THESIS_BASIS }), false);
  assert.equal(T.needsRebase({ theses: { 2330: {} }, basis: 'older' }), true);
});

test('rebaseReady：只認 MOPS 歸檔且名冊完整', () => {
  assert.equal(T.rebaseReady({ source: 'archive:2026-08', complete: true }), true);
  assert.equal(T.rebaseReady({ source: 'archive:2026-09', complete: false }), false);
  assert.equal(T.rebaseReady({ source: 'openapi:2026-08', complete: false }), false);
  assert.equal(T.rebaseReady({ source: 'none' }), false);
  assert.equal(T.rebaseReady(undefined), false);
});

test('rebuildThesis：草稿論點整則重生系統部分，目標價／停損／建立時間沿用', () => {
  const old = {
    name: '台積電', status: 'draft', conviction: 'medium', thesis: '（AI 依據）L-foreignBuy。',
    pillars: [R('foreignBuy', false)], risks: ['L-revGrowth：目前不成立'], intact: false,
    targetPrice: 1200, stopLoss: 900, createdAt: 111, updatedAt: 222, support: 10,
  };
  const n = T.rebuildThesis(old, results, { note: '備註', now: 999 });
  assert.notEqual(n, old);
  assert.equal(old.intact, false);                      // 不改舊物件
  assert.deepEqual(n.pillars.map(p => p.key), ['foreignBuy', 'revGrowth']);
  assert.equal(n.intact, true);
  assert.equal(n.thesis, '備註｜（AI 依據）L-foreignBuy、L-revGrowth。');
  assert.equal(n.status, 'draft');
  assert.equal(n.targetPrice, 1200); assert.equal(n.stopLoss, 900); assert.equal(n.createdAt, 111);
  assert.equal(n.updatedAt, 999);
});

test('rebuildThesis：使用者改過（edited）的論點文字與信心度保留，只換支柱與成立與否', () => {
  const old = { name: 'X', status: 'edited', conviction: 'high', thesis: '我自己的理由', pillars: [], risks: [], intact: true };
  const n = T.rebuildThesis(old, results.map(r => ({ ...r, ok: false })));
  assert.equal(n.thesis, '我自己的理由');
  assert.equal(n.conviction, 'high');
  assert.equal(n.status, 'edited');
  assert.equal(n.pillars.length, 3);
  assert.equal(n.intact, false);                        // 重測後直接算對，不等隔天才翻（不再產生逐檔「轉弱」）
});

test('rebaseSummaryMessage：一則彙總、列出轉弱者、附非投資建議', () => {
  const ok = T.rebaseSummaryMessage([{ code: '2330', name: '台積電', intact: true }]);
  assert.match(ok, /共 1 檔，目前沒有轉弱的論點/);
  assert.match(ok, /非投資建議/);
  const rows = Array.from({ length: 12 }, (_, i) => ({ code: String(1101 + i), name: `N${i}`, intact: false }));
  const m = T.rebaseSummaryMessage(rows, { maxList: 3 });
  assert.match(m, /目前轉弱 12 檔：1101 N0、1102 N1、1103 N2 等/);
});
