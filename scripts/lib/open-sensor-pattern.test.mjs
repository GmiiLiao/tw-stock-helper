// 開盤感應器 v2.1 09:20／09:30 盤型三線（design-v2.1 §6；門檻照 design-v2 §5.2〔先驗〕）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLine, qualifierOf, patternAt } from './open-sensor-pattern.mjs';
import { createCapture, feedIndex } from './open-sensor-capture.mjs';
import { tpeMs } from './open-sensor-params.mjs';

test('classifyLine：開高持穩（大幅）／開高走低·翻黑／開平殺盤／開低走高·翻紅／平盤震盪', () => {
  let c = classifyLine({ Y: 48475.74, E: 49530.99, P: 49550 });
  assert.equal(c.key, 'upHold'); assert.equal(c.big, true); assert.equal(c.label, '大幅開高持穩');
  c = classifyLine({ Y: 100, E: 101, P: 99.8 });
  assert.equal(c.key, 'fadeDown'); assert.equal(c.cross, '翻黑'); assert.equal(c.label, '大幅開高走低·翻黑'); assert.equal(c.reversal, true);
  c = classifyLine({ Y: 100, E: 100.5, P: 101 });
  assert.equal(c.key, 'upUp');
  c = classifyLine({ Y: 100, E: 100.1, P: 99 });
  assert.equal(c.key, 'flatDown'); assert.equal(c.label, '開平殺盤');
  c = classifyLine({ Y: 100, E: 99.5, P: 100.2 });
  assert.equal(c.key, 'reversalUp'); assert.equal(c.cross, '翻紅');
  assert.equal(classifyLine({ Y: 100, E: 100.1, P: 100.3 }).key, 'range');
  assert.equal(classifyLine({ Y: 100, E: null, P: 100 }).key, 'nodata');
});

test('classifyLine 一般股線（百分點口徑）：E′_gen +0.58 → 現 +0.18 ⇒ 開高走低', () => {
  const c = classifyLine({ E: 0.58, P: 0.18, mode: 'gen' });
  assert.equal(c.key, 'fadeDown'); assert.equal(c.d, -0.4); assert.equal(c.label, '開高走低');
});

test('qualifierOf：±1.0 百分點', () => {
  assert.equal(qualifierOf(2.2, 0.4), '權值撐盤');
  assert.equal(qualifierOf(-1.5, -0.2), '權值拖累、個股抗跌');
  assert.equal(qualifierOf(0.5, 0.2), null);
});

test('patternAt：三線、現值＝揭示 ≥ T 的第一拍、用 E′（含修正）並記未修正 E；拿不到就 nodata', () => {
  const D = '2026-10-08';
  const cap = createCapture(D);
  const t = (hms, z) => ({ price: z, prev: 100, mVal: 1, open: 100.2, revealAt: tpeMs(D, hms), realTrade: true });
  feedIndex(cap, 't', t('09:02:00', 102));
  feedIndex(cap, 't', t('09:19:55', 101.6));
  feedIndex(cap, 't', t('09:20:05', 101.5));
  const e = { tse: { v: 102, pct: 2, revealAt: tpeMs(D, '09:02:00') }, otc: null, gen: 0.6 };
  const eCorr = { tse: { pct: 2.3, addPp: 0.3, nOpened: 3 }, gen: { pp: 0.7 }, otc: null };
  const p = patternAt({ T: tpeMs(D, '09:20:00'), ringT: cap.ringT, ringO: cap.ringO, e, eCorr, gNow: 0.2, writtenAt: 1 });
  assert.equal(p.basis, 'pattern3-v2.1'); assert.equal(p.T, '09:20:00');
  assert.equal(p.lines.tse.status, 'ok'); assert.equal(p.lines.tse.p, 101.5);
  assert.equal(p.lines.tse.eUsed, 102.3); assert.equal(p.lines.tse.eRaw, 102); assert.equal(p.lines.tse.eCorrected, true);
  assert.equal(p.lines.tse.key, 'upHold');
  assert.equal(p.lines.otc.status, 'nodata');
  assert.equal(p.lines.gen.eUsed, 0.7); assert.equal(p.lines.gen.key, 'fadeDown');
  assert.equal(p.qualifier, '權值撐盤');   // 加權 +1.5% − 一般股 +0.2 = +1.3pp
});
