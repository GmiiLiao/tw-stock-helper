// 零網路回補（scripts/backfill-revenue-from-mirror.mjs）的月計畫測試：純計算＋暫存目錄裡的假鏡像，不碰網路與 Firestore。
// node --test scripts/lib/mops-revenue-mirror.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as C from './official-mirror.mjs';
import { T21_CSV_HEADER } from './mops-revenue.mjs';
import { planMonth, parseArgs, loadMirrorCsv, csvRefRoster, withCsvPages } from '../backfill-revenue-from-mirror.mjs';

const r = (c, extra = {}) => ({ c, n: `公司${c}`, rev: 100, prev: 90, last: 80, mom: 11.11, yoy: 25, cum: 900, ...extra });
const GEN = Date.parse('2026-10-04T20:00:18+08:00');
const ok = (rows, at = Date.parse('2026-10-04T12:43:40Z'), gen = GEN) => ({ state: 'ok', rows, codes: rows.map(x => x.c), at, gen });
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
  assert.deepEqual(b.doc.retained, ['2867']); assert.equal(b.doc.missingVsPrev, null, '沒給上月文件＝無參照');
  assert.equal(b.doc.fetchLog[0].gen, GEN, '觀測時刻＝最早的出表日期'); assert.equal(b.doc.fetchLog[0].src, 'mirror');
  // 重跑（文件已是寫入後的樣子）：同一次鏡像觀測不重複記、沒有變更 ⇒ 略過
  const again = planMonth('2026-08', { ...old, ...b.doc }, pages, { domesticGaps: true, fixZero: true, now: 6 });
  assert.equal(again.action, 'skip');
});

test('鏡像頁未定版整月略過；缺頁整月略過（不寫 v2）；openapi 薄版拒寫；壞 JSON 拒寫', () => {
  const nf = [...pages]; nf[2] = { state: 'nonfinal', note: '鏡像未定版' };
  assert.equal(planMonth('2026-09', old, nf, { domesticGaps: true }).action, 'skip');
  const miss = [{ state: 'missing', note: 'bad·內容過短' }, { state: 'missing', note: 'bad·內容過短' }, pages[2], pages[3]];
  const m = planMonth('2026-03', old, miss, { domesticGaps: true });
  assert.equal(m.action, 'skip', '缺頁整月略過、不寫 v2（否則稽核組成閘門天天 THIN）'); assert.equal(m.doc, undefined);
  assert.equal(m.report.allPages, false); assert.match(m.report.pages['上市'], /^missing/);
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

test('名冊比對：上月文件（扣掉它的留存）有、本月 4 頁都沒有的代號寫進 missingVsPrev；觀測只有一次不定版', () => {
  const prev = { v: 2, bySrc: {}, retained: ['5371'], rowsJson: JSON.stringify(['1101', '2880', '3000', '5371', '9999'].map(c => r(c))) };
  const p = planMonth('2026-08', old, pages, { domesticGaps: true, prev });
  assert.deepEqual(p.doc.missingVsPrev, { n: 1, codes: ['9999'] }); assert.equal(p.doc.final, false);
  const gens = [...pages]; gens[1] = ok(pages[1].rows, undefined, GEN - 3 * 864e5);
  assert.equal(planMonth('2026-08', old, gens, { domesticGaps: true }).doc.fetchLog[0].gen, GEN - 3 * 864e5, '4 頁中最早的出表日期');
});

// ── 官方 CSV 補頁（2026-10-04：2026-03 上市 _0／_1 靜態頁 MOPS 端 0 bytes）──
const H = 'mopsov.twse.com.tw';
let BIG5 = null;
/** 測試用 big5 編碼器：用 TextDecoder('big5') 反查（鏡像頁是 big5 原始位元組）。 */
function big5(str) {
  if (!BIG5) {
    BIG5 = new Map(); const dec = new TextDecoder('big5');
    for (let a = 0x81; a <= 0xfe; a++) for (const [lo, hi] of [[0x40, 0x7e], [0xa1, 0xfe]]) for (let b = lo; b <= hi; b++) {
      const ch = dec.decode(Uint8Array.of(a, b)); if (ch.length === 1 && ch !== '�' && !BIG5.has(ch)) BIG5.set(ch, [a, b]);
    }
  }
  return Buffer.from([...str].flatMap(ch => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : BIG5.get(ch))));
}
const mk = { sii: '上市', otc: '上櫃' };
const htmlPage = (mkt, m, kind, codes) => `<b>${mk[mkt]}公司115年${m}月份營業收入統計表</b><div class=tt>出表日期：115/10/04<!--20:00:18--></div><table>`
  + codes.map(c => `<tr><td>${c}</td><td>公司${c}</td>${'<td>1,000</td>'.repeat(6)}</tr>`).join('') + `<tr><th>全部${kind === '0' ? '國內' : '國外'}${mk[mkt]}公司合計</th></tr></table>`;
const csvLine = (ym, c, n, rev = '1000') => ['115/10/05', ym, c, n, '電子', rev, '900', '800', '11.119', '-25.009', '9000', '8000', '12.5', '-'].map(v => `"${v}"`).join(',');
const csvFile = (ym, list) => `﻿${T21_CSV_HEADER.join(',')}\r\n${list.map(([c, n, rev]) => csvLine(ym, c, n, rev)).join('\r\n')}\r\n`;
const SII_DOM = ['1101', '1102', '2330', '2880', '6785']; const SII_FGN = ['1256', '9105'];
const MAR = [['1101', '台泥'], ['1102', '亞泥'], ['2330', '台積電'], ['2880', '華南金'], ['1256', '鮮活果汁-KY'], ['9105', '泰金寶-DR'], ['6785', '昱展新藥', '0']];

function fakeMirror() {
  const root = mkdtempSync(join(tmpdir(), 'revcsv-'));
  const mans = { 0: { id: 'mops_t21sc03', host: H, rows: {} }, 1: { id: 'mops_t21sc03_ky', host: H, rows: {} }, csv: { id: 'mops_t21sc03_csv', host: H, rows: {} } };
  const html = (key, mkt, m, kind, codes, final = true) => {
    const id = kind === '0' ? 'mops_t21sc03' : 'mops_t21sc03_ky';
    const file = C.writeEntry(root, H, id, key, { kind: 'text', ext: 'html', buffer: big5(htmlPage(mkt, m, kind, codes)) });
    mans[kind].rows[key] = { status: 'ok', file, at: '2026-10-04T12:43:00.000Z', final };
  };
  const csv = (key, ym, list, final = true) => {
    const file = C.writeEntry(root, H, 'mops_t21sc03_csv', key, { kind: 'text', ext: 'csv', buffer: Buffer.from(csvFile(ym, list)) });
    mans.csv.rows[key] = { status: 'ok', file, sha256: 'f7f3', at: '2026-10-04T17:10:00.000Z', final };
  };
  return { root, mans, html, csv, done: () => rmSync(root, { recursive: true, force: true }) };
}

test('CSV 補頁：參照上月同市場兩頁核對市場與分類；本國／外國兩半當 _0／_1 用；沒有上月改用下月；沒有參照、錯月、錯市場都不可用', () => {
  const f = fakeMirror();
  try {
    f.html('2026-02.sii', 'sii', 2, '0', SII_DOM); f.html('2026-02.sii', 'sii', 2, '1', SII_FGN);
    f.html('2026-02.otc', 'otc', 2, '0', ['3105', '5347']); f.html('2026-02.otc', 'otc', 2, '1', ['2924']);
    f.csv('2026-03.sii', '115/3', MAR);
    const ref = csvRefRoster(f.root, f.mans, '2026-03', 'sii');
    assert.deepEqual(ref, { month: '2026-02', dom: SII_DOM, fgn: SII_FGN });
    const c = loadMirrorCsv(f.root, f.mans.csv, '2026-03', 'sii', ref);
    assert.equal(c.state, 'ok'); assert.equal(c.refMonth, '2026-02'); assert.equal(c.gen, Date.parse('2026-10-05T00:00:00+08:00'));
    assert.deepEqual(c.dom.rows.map(r => r.c), ['1101', '1102', '2330', '2880']); assert.deepEqual(c.dom.codes, ['1101', '1102', '2330', '2880', '6785']);
    assert.deepEqual(c.fgn.rows.map(r => [r.c, r.mom, r.yoy]), [['1256', 11.11, -25], ['9105', 11.11, -25]], '% 向零截斷');
    // 沒有上月 ⇒ 下月
    f.mans[0].rows['2026-02.sii'] = { status: 'bad', note: '內容過短' };
    f.html('2026-04.sii', 'sii', 4, '0', SII_DOM); f.html('2026-04.sii', 'sii', 4, '1', SII_FGN);
    assert.equal(csvRefRoster(f.root, f.mans, '2026-03', 'sii').month, '2026-04');
    assert.equal(csvRefRoster(f.root, f.mans, '2026-06', 'sii'), null);
    assert.match(loadMirrorCsv(f.root, f.mans.csv, '2026-03', 'sii', null).note, /沒有同市場參照頁/);
    // 錯市場：拿上櫃參照核對 ⇒ 重疊 0%
    const otcRef = csvRefRoster(f.root, f.mans, '2026-03', 'otc');
    const wrong = loadMirrorCsv(f.root, f.mans.csv, '2026-03', 'sii', otcRef);
    assert.equal(wrong.state, 'echo'); assert.match(wrong.note, /市場回音不符.*（參照 2026-02）/);
    // 錯月：鍵是 2026-03 但檔內資料年月 115/2
    f.csv('2026-03.sii', '115/2', MAR);
    assert.match(loadMirrorCsv(f.root, f.mans.csv, '2026-03', 'sii', ref).note, /回音不符：資料年月 115\/2 ≠ 115\/3/);
    // 未定版：照樣解析（給預覽），狀態 nonfinal
    f.csv('2026-03.sii', '115/3', MAR, false);
    const nf = loadMirrorCsv(f.root, f.mans.csv, '2026-03', 'sii', ref);
    assert.equal(nf.state, 'nonfinal'); assert.equal(nf.fgn.rows.length, 2);
    assert.equal(loadMirrorCsv(f.root, f.mans.csv, '2026-05', 'sii', ref).state, 'missing');
  } finally { f.done(); }
});

test('withCsvPages＋planMonth：上市兩頁缺 ⇒ CSV 兩半補上、寫 v2 並記補頁出處；CSV 未定版 dry-run 只預覽、--write 略過；HTML 未定版不補', () => {
  const kyOld = { month: '2026-03', n: 3, at: 1, bySrc: { 上市: 2, 上櫃: 1 }, rowsJson: JSON.stringify([r('1101'), r('2330'), r('3105')]) };
  const miss = { state: 'missing', note: 'bad·內容過短' };
  const otc = [ok([r('3105'), r('5347')]), ok([r('2924')])];
  const csv = (state = 'ok') => ({ state, note: state === 'ok' ? null : '鏡像 CSV 未定版', file: '2026-03.sii.csv.gz', sha256: 'f7f3', gen: GEN,
    dom: { rows: [r('1101'), r('2330'), r('2880')], codes: ['1101', '2330', '2880'], at: GEN, gen: GEN }, fgn: { rows: [r('1256')], codes: ['1256'], at: GEN, gen: GEN } });
  const pages = withCsvPages([miss, miss, ...otc], { sii: csv() });
  assert.deepEqual(pages.map(p => p.src ?? 'html'), ['csv', 'csv', 'html', 'html']);
  const w = planMonth('2026-03', kyOld, pages, { domesticGaps: true, now: 5 });
  assert.equal(w.action, 'write'); assert.deepEqual(w.report.add, { 上市: ['2880'], 上市KY: ['1256'], 上櫃: ['5347'], 上櫃KY: ['2924'] });
  assert.deepEqual(w.doc.bySrc, { 上市: 3, 上市KY: 1, 上櫃: 2, 上櫃KY: 1, 留存: 0 });
  assert.deepEqual(w.doc.supplement, { dataset: 'mops_t21sc03_csv', pages: ['上市', '上市KY'], files: ['2026-03.sii.csv.gz'], sha256: ['f7f3'] });
  assert.deepEqual(w.doc.pages, { 上市: 3, 上市KY: 1, 上櫃: 2, 上櫃KY: 1 });
  assert.equal(planMonth('2026-03', kyOld, withCsvPages([miss, miss, ...otc], {}), { domesticGaps: true }).action, 'skip', '沒有 CSV 照舊整月略過');
  // 之後 HTML 頁到位重寫：supplement 寫 null（update 是欄位合併，不寫會殘留舊的 CSV 出處）
  const html = planMonth('2026-03', { ...kyOld, ...w.doc }, [ok([r('1101'), r('2330'), r('2880'), r('1102')], undefined, GEN + 864e5), ok([r('1256')]), ...otc], { domesticGaps: true, now: 6 });
  assert.equal(html.action, 'write'); assert.equal(html.doc.supplement, null); assert.deepEqual(html.report.csvPages, []);
  // CSV 未定版：預覽（算出差異、不寫）；寫入模式整月略過
  const nfPages = withCsvPages([miss, miss, ...otc], { sii: csv('nonfinal') });
  const pv = planMonth('2026-03', kyOld, nfPages, { domesticGaps: true, preview: true });
  assert.equal(pv.action, 'skip'); assert.equal(pv.preview, true); assert.equal(pv.doc, undefined); assert.deepEqual(pv.report.add['上市KY'], ['1256']);
  const wr = planMonth('2026-03', kyOld, nfPages, { domesticGaps: true, preview: false });
  assert.equal(wr.action, 'skip'); assert.equal(wr.preview, undefined); assert.equal(wr.report.add, undefined);
  // CSV 不可用（回音不符）：保留缺頁、註記原因
  const bad = withCsvPages([miss, miss, ...otc], { sii: { state: 'echo', note: '市場回音不符' } });
  assert.equal(bad[0].state, 'missing'); assert.match(bad[0].note, /CSV echo（市場回音不符）/);
  // HTML 頁只是未定版（申報期內）：不拿 CSV 頂替，也不預覽
  const hnf = withCsvPages([{ state: 'nonfinal', note: '鏡像未定版' }, ok([r('1256')]), ...otc], { sii: csv() });
  assert.equal(hnf[0].src, undefined); assert.equal(planMonth('2026-09', kyOld, hnf, { domesticGaps: true, preview: true }).preview, undefined);
});
