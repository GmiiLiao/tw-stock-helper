// 定版記錄閘門 單元測試：node --test scripts/lib/canonical-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveDayStatus, archiveCloseReady, canonicalDecision, beforeNextOpen, neverThinner, TSE_SAMPLES, OTC_SAMPLES } from './canonical-gate.mjs';

// 1,960 檔左右的完整日：上市＋上櫃收盤、上市＋上櫃法人都在
const mkDay = ({ tse = true, otc = true, instTse = true, instOtc = true, otcPending = false, extra = 1900 } = {}) => {
  const close = {}, inst = {};
  for (let i = 0; i < extra; i++) close[String(1100 + i)] = [10, 1, 10, 10, 10];
  for (const c of TSE_SAMPLES) { if (tse) close[c] = [100, 1, 100, 100, 100]; else delete close[c]; if (instTse) inst[c] = [1, 0]; }
  for (const c of OTC_SAMPLES) { if (otc) close[c] = [50, 1, 50, 50, 50]; else delete close[c]; if (instOtc) inst[c] = [1, 0]; }
  return { date: '2026-10-02', closeJson: JSON.stringify(close), instJson: JSON.stringify(inst), otcPending };
};

test('archiveDayStatus：上市＋上櫃收盤與法人都到齊、otcPending=false 才算到齊', () => {
  assert.deepEqual(archiveDayStatus(mkDay()), { ready: true, missing: [], basis: '兩市官方' });
});

test('archiveDayStatus：上櫃樣本股全數下市／轉板時，以總檔數 ≥1700 判定上櫃已併入（閘門不永久關閉）', () => {
  assert.equal(archiveDayStatus(mkDay({ otc: false, extra: 1900 })).ready, true);
  assert.equal(archiveDayStatus(mkDay({ otc: false, extra: 1100 })).ready, false, '只有上市（約 1,230 檔）不可能過');
});

test('archiveCloseReady：到期評估只看兩市收盤，法人缺（T86 未出）不影響；上櫃未併入則不行', () => {
  assert.equal(archiveCloseReady(mkDay({ instTse: false, instOtc: false })), true);
  assert.equal(archiveCloseReady(mkDay({ otc: false, otcPending: true, extra: 1100 })), false);
  assert.equal(archiveCloseReady(null), false);
});

test('archiveDayStatus：上櫃由第三方補洞時註明非官方（basis）', () => {
  assert.equal(archiveDayStatus({ ...mkDay(), gapFixSource: 'tpex-dated(0)+yahoo-TWO(補 880·缺 23)' }).basis, '上市官方＋上櫃含第三方補洞');
});

test('archiveDayStatus：15:15 的實際狀態（上櫃收盤未出、上市法人 T86 未出）列出缺哪些', () => {
  const s = archiveDayStatus(mkDay({ otc: false, otcPending: true, instTse: false, extra: 1100 }));
  assert.equal(s.ready, false);
  assert.deepEqual(s.missing.sort(), ['上市法人', '上櫃收盤'].sort());
});

test('archiveDayStatus：otcPending 為 true 時即使樣本股在也不算到齊（寫入端回聲驗證未完成）', () => {
  assert.deepEqual(archiveDayStatus(mkDay({ otcPending: true })).missing, ['上櫃收盤']);
});

test('archiveDayStatus：空殼／缺欄位／JSON 壞掉不會丟例外，回報缺漏', () => {
  assert.deepEqual(archiveDayStatus(null).ready, false);
  assert.deepEqual(archiveDayStatus({ date: 'x' }).missing.includes('上市收盤'), true);
  assert.deepEqual(archiveDayStatus({ closeJson: '{bad', instJson: '{}' }).ready, false);
});

test('archiveDayStatus：樣本股個別停牌（缺一兩檔）仍算到齊——不因單一股票卡住整天', () => {
  const d = mkDay(); const close = JSON.parse(d.closeJson); delete close[OTC_SAMPLES[0]]; delete close[TSE_SAMPLES[0]];
  assert.equal(archiveDayStatus({ ...d, closeJson: JSON.stringify(close) }).ready, true);
});

test('canonicalDecision：未到齊不寫；已定版不覆蓋；--force 可重寫；舊格式（無 canonicalAt）到齊後可補成定版', () => {
  assert.equal(canonicalDecision({ existing: null, ready: false }), 'skip-not-ready');
  assert.equal(canonicalDecision({ existing: null, ready: true }), 'write');
  assert.equal(canonicalDecision({ existing: { canonicalAt: 1 }, ready: true }), 'skip-exists');
  assert.equal(canonicalDecision({ existing: { canonicalAt: 1 }, ready: true, force: true }), 'write');
  assert.equal(canonicalDecision({ existing: { at: 1 }, ready: true }), 'write', '修正前寫入的舊檔沒有 canonicalAt ⇒ 到齊後以完整版補定版');
  assert.equal(canonicalDecision({ existing: null, ready: false, force: true }), 'skip-not-ready', '--force 也不能用未到齊的資料定版');
  assert.equal(canonicalDecision({ existing: null, ready: true, open: false }), 'skip-after-open', '下一個交易日開盤後才寫＝偷看答案');
});

test('beforeNextOpen：事前存檔只能在下一個交易日 08:30 前寫（週五資料到週一 08:30；遇休市順延）', () => {
  const trading = d => !['2026-10-03', '2026-10-04', '2026-10-10', '2026-10-11', '2026-10-09'].includes(d);
  assert.equal(beforeNextOpen('2026-10-02', '2026-10-02T17:00', trading), true);
  assert.equal(beforeNextOpen('2026-10-02', '2026-10-04T23:59', trading), true, '週末仍在週一開盤前');
  assert.equal(beforeNextOpen('2026-10-02', '2026-10-05T08:29', trading), true);
  assert.equal(beforeNextOpen('2026-10-02', '2026-10-05T08:30', trading), false);
  assert.equal(beforeNextOpen('2026-10-02', '2026-10-05T10:00', trading), false, '盤中的刷新不可再碰前一日的事前存檔（2026-10-02 實案）');
  assert.equal(beforeNextOpen('2026-10-08', '2026-10-11T12:00', trading), true, '10/9 補假＋週末 ⇒ 下一個交易日 10/12');
});

test('neverThinner：日期存檔只接受「不比既有少」的新版（某來源失敗時不可把完整的舊檔蓋薄）', () => {
  assert.equal(neverThinner(null, 5), true);
  assert.equal(neverThinner(10, 10), true);
  assert.equal(neverThinner(10, 12), true);
  assert.equal(neverThinner(1900, 1100), false, '上櫃那半失敗 ⇒ 不覆蓋');
  assert.equal(neverThinner(1900, 1890), true, '容許 2% 內的自然變動（停牌、下市）');
});
