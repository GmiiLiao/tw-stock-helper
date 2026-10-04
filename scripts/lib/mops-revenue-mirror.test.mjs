// 零網路回補（scripts/backfill-revenue-from-mirror.mjs）的月計畫測試：純計算，不讀鏡像檔、不碰 Firestore。
// node --test scripts/lib/mops-revenue-mirror.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMonth, parseArgs } from '../backfill-revenue-from-mirror.mjs';

const r = (c, extra = {}) => ({ c, n: `公司${c}`, rev: 100, prev: 90, last: 80, mom: 11.11, yoy: 25, cum: 900, ...extra });
const ok = (rows, at = Date.parse('2026-10-04T12:43:40Z')) => ({ state: 'ok', rows, at });
const old = { month: '2026-08', n: 3, bySrc: { 上市: 2, 上櫃: 1 }, at: 1, rowsJson: JSON.stringify([r('1101', { yoy: 0, mom: 0 }), r('2867'), r('3000')]) };
// 頁序：上市 _0、上市 _1、上櫃 _0、上櫃 _1（T21_PAGES）
const pages = [ok([r('1101', { yoy: null, mom: null, rev: 999 }), r('2880')]), ok([r('4157')]), ok([r('3000')]), ok([r('6000')])];

test('只補缺：KY 一律補、本國缺漏要 --domestic-gaps；既有列不動（官方新值不覆蓋）；修捏造 0 只改 yoy/mom', () => {
  const a = planMonth('2026-08', old, pages, { domesticGaps: false, fixZero: false, now: 5 });
  assert.equal(a.action, 'write'); assert.equal(a.doc.n, 5);
  assert.deepEqual(a.report.add, { 上市: [], 上市KY: ['4157'], 上櫃: [], 上櫃KY: ['6000'] });
  assert.equal(a.report.observed, false, '沒有併入本國缺漏 ⇒ 不是完整觀測'); assert.deepEqual(a.doc.fetchLog, []);
  const b = planMonth('2026-08', old, pages, { domesticGaps: true, fixZero: true, now: 5 });
  assert.deepEqual(b.report.add['上市'], ['2880']); assert.deepEqual(b.report.fixYoy, ['1101']); assert.deepEqual(b.report.retained, ['2867']);
  const rows = JSON.parse(b.doc.rowsJson); const r1101 = rows.find(x => x.c === '1101');
  assert.equal(r1101.rev, 100, '既有值不動'); assert.equal(r1101.yoy, null); assert.equal(r1101.mom, null);
  assert.equal(b.doc.v, 2); assert.equal(b.doc.final, false, '只有一次觀測'); assert.equal(b.doc.fetchLog.length, 1);
  assert.deepEqual(b.doc.bySrc, { 上市: 2, 上市KY: 1, 上櫃: 1, 上櫃KY: 1, 留存: 1 }); assert.equal(b.doc.kyN, 2);
  // 重跑（文件已是寫入後的樣子）：同一次鏡像觀測不重複記、沒有變更 ⇒ 略過
  const again = planMonth('2026-08', { ...old, ...b.doc }, pages, { domesticGaps: true, fixZero: true, now: 6 });
  assert.equal(again.action, 'skip');
});

test('鏡像頁未定版整月略過；缺頁照補其他頁但 final:false；openapi 薄版拒寫；壞 JSON 拒寫', () => {
  const nf = [...pages]; nf[2] = { state: 'nonfinal', note: '鏡像未定版' };
  assert.equal(planMonth('2026-09', old, nf, { domesticGaps: true }).action, 'skip');
  const miss = [{ state: 'missing', note: 'bad·內容過短' }, { state: 'missing', note: 'bad·內容過短' }, pages[2], pages[3]];
  const m = planMonth('2026-03', old, miss, { domesticGaps: true });
  assert.equal(m.action, 'write'); assert.equal(m.doc.final, false); assert.equal(m.report.allPages, false); assert.match(m.doc.pages['上市'], /^鏡像 missing/);
  assert.equal(planMonth('2026-08', { n: 2, rowsJson: '[]' }, pages, { domesticGaps: true }).action, 'refuse');
  assert.equal(planMonth('2026-08', { ...old, rowsJson: '{bad' }, pages, { domesticGaps: true }).action, 'refuse');
  assert.equal(planMonth('2026-08', { ...old, n: 99 }, pages, { domesticGaps: true }).action, 'refuse', '合併後筆數 < 既有 n');
});

test('參數：預設 dry-run；月份格式要 YYYY-MM；未知參數丟錯', () => {
  assert.equal(parseArgs([]).write, false);
  assert.equal(parseArgs(['--write', '--domestic-gaps']).domesticGaps, true);
  assert.throws(() => parseArgs(['--from', '2023-8']));
  assert.throws(() => parseArgs(['--extend']));
});
