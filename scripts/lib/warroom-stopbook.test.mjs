// 盤中戰情 v2：daemon 停損簿 stopBooks/{uid} 前端讀取端 單元測試：node --test scripts/lib/warroom-stopbook.test.mjs
// 規範 .claude/skills/tw-ai-stoploss/SKILL.md「生效範圍」、§3.6；實作計畫 §3.1。非投資建議。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregatePositions, legacyBranchActive } from './ai-stoploss.mjs';
import {
  parseStopBookDoc, stopBookLive, sameLots, stopBookStale, bookStopOf, bookCalcWhyText, shadowStopOf,
} from './warroom-stopbook.mjs';

const PREV = '2026-10-02';
const POS = aggregatePositions([{ id: 'a', code: '2317', name: '鴻海', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }])[0];
const BP = {
  lots: [{ id: 'a', buyPrice: 100, qty: 1, buyDate: '2026-09-01' }], ex: { events: [], coverFrom: '2026-06-01', coverTo: PREV },
  adjCost: 100, stop: 95.5, baseStop: 95.5, floorStop: 92, bandHold: 95.5, basisText: 'ATR 帶·10/02 設定·只升不降', costLine: 92,
  stopSource: 'atrBand', sourceDate: PREV, floorSource: 'cost', floorSourceDate: '2026-09-01', bandSourceDate: PREV,
  lines: { costLine: 92, bandLine: 95.5, beLine: null, trailLine: null, eventLine: null }, stopVersion: 4, startedAt: 1, tradeDate: PREV,
  atr14: 2.1, suspect: false, events: [], eventKeys: [], noOfficialBars: false,
};
const doc = (over = {}) => ({ specVersion: 'stop-v1.1', phase: 'live', dataDate: PREV, updatedAt: 1, positions: { 2317: BP }, ...over });

test('讀回：phase 只收 shadow／live；positions 只留代號合法、值是物件的列；資料日不合格記 null', () => {
  assert.equal(parseStopBookDoc(null), null);
  assert.equal(parseStopBookDoc({ phase: 'draft', specVersion: 'stop-v1.1' }), null);
  assert.equal(parseStopBookDoc({ phase: 'live' }), null);
  const b = parseStopBookDoc(doc({ positions: { 2317: BP, bad: BP, 2330: 5 }, dataDate: '10/02' }));
  assert.deepEqual(Object.keys(b.positions), ['2317']);
  assert.equal(b.dataDate, null);
});

test('生效條件：phase live 且 specVersion stop-v1.1；影子期、版本不符、沒有停損簿都不生效', () => {
  assert.equal(stopBookLive(parseStopBookDoc(doc())), true);
  assert.equal(stopBookLive(parseStopBookDoc(doc({ phase: 'shadow' }))), false);
  assert.equal(stopBookLive(parseStopBookDoc(doc({ specVersion: 'stop-v1' }))), false);
  assert.equal(stopBookLive(null), false);
});

test('快照比對不計順序；資料日早於前一交易日＝過期', () => {
  const a = [{ id: 'x', buyPrice: 1, qty: 1, buyDate: null }, { id: 'y', buyPrice: 2, qty: 1, buyDate: '2026-01-01' }];
  assert.equal(sameLots(a, [a[1], a[0]]), true);
  assert.equal(sameLots(a, [a[0]]), false);
  assert.equal(sameLots(a, [{ ...a[0], qty: 2 }, a[1]]), false);
  const b = parseStopBookDoc(doc());
  assert.equal(stopBookStale(b, PREV), false);
  assert.equal(stopBookStale(b, '2026-10-05'), true);
  assert.equal(stopBookStale(parseStopBookDoc(doc({ dataDate: null })), PREV), true);
});

test('bookStopOf：一致＝停損簿這一版（成本可疑以目前價重算）；停損不在檔位上＝資料不完整走暫算', () => {
  const b = parseStopBookDoc(doc());
  const ok = bookStopOf(POS, { book: b, todayYmd: '2026-10-05', prevYmd: PREV, lastPrice: 97 });
  assert.equal(ok.mode, 'book');
  assert.equal(ok.res.stop, 95.5);
  assert.equal(ok.res.stopSource, 'atrBand');
  assert.equal(ok.res.atr14, 2.1);
  assert.equal(ok.res.suspect, false);
  assert.equal(bookStopOf(POS, { book: b, prevYmd: PREV, lastPrice: 20 }).res.suspect, true);
  const bad = bookStopOf(POS, { book: parseStopBookDoc(doc({ positions: { 2317: { ...BP, stop: 95.55 } } })), prevYmd: PREV, lastPrice: 97 });
  assert.equal(bad.mode, 'bookCalc');
  assert.equal(bad.why, 'invalid');
  assert.equal(bookCalcWhyText('invalid', null), '停損簿這一檔資料不完整');
});

test('bookStopOf（2026-10-06 審查）：組成線來自尚未驗證的官方鏡像歸檔 ⇒ legacy（與 daemon legacyBranchActive 同口徑）；停損簿文件 verifiedArchives 含該種類才讀停損簿', () => {
  const etf = aggregatePositions([{ id: 'e', code: '00631L', name: '元大台灣50正2', buyPrice: 40, quantity: 1, buyDate: '2026-09-01' }])[0];
  const ebp = {
    ...BP, lots: [{ id: 'e', buyPrice: 40, qty: 1, buyDate: '2026-09-01' }], adjCost: 40, stop: 38.5, baseStop: 38.5, floorStop: 36.8,
    bandHold: 38.5, costLine: 36.8, lines: { costLine: 36.8, bandLine: 38.5, beLine: null, trailLine: null, eventLine: null },
    lineInputs: { dataDate: PREV, close: 41.5, atr14: 0.8, barsFrom: '2026-06-01', atrBand: { price: 38.5, dataDate: PREV }, holdHigh: null, exGapBars: 0, noOfficialBars: false, archive: 'etf' },
  };
  const b = parseStopBookDoc(doc({ positions: { '00631L': ebp } }));
  assert.deepEqual(b.verifiedArchives, [], '缺＝空＝都還沒驗證（fail-closed）');
  const r = bookStopOf(etf, { book: b, prevYmd: PREV, lastPrice: 41, ratingBand: 38 });
  assert.equal(r.mode, 'legacy');
  assert.equal(r.res.basisText, 'ATR 帶（持股分析）·沿用現行推播口徑');
  assert.equal(legacyBranchActive(b, '00631L'), true, 'daemon 同一份停損簿也走舊分支');
  const v = parseStopBookDoc(doc({ positions: { '00631L': ebp }, verifiedArchives: ['etf', 'bogus', 'etf'] }));
  assert.deepEqual(v.verifiedArchives, ['etf'], '只收 etf／emerging、去重');
  const rv = bookStopOf(etf, { book: v, prevYmd: PREV, lastPrice: 41, ratingBand: 38 });
  assert.equal(rv.mode, 'book', '驗證並核可後才讀停損簿（上一段的 legacy 不是空轉）');
  assert.equal(rv.res.stop, 38.5);
  assert.equal(legacyBranchActive(v, '00631L', { verifiedArchives: v.verifiedArchives }), false);
});

test('影子值只在 phase shadow 時給抽屜對照；生效後不給', () => {
  const sh = shadowStopOf(parseStopBookDoc(doc({ phase: 'shadow' })), '2317');
  assert.deepEqual(sh, { stop: 95.5, stopSource: 'atrBand', basisText: 'ATR 帶·10/02 設定·只升不降', dataDate: PREV, noOfficialBars: false });
  assert.equal(shadowStopOf(parseStopBookDoc(doc()), '2317'), null);
  assert.equal(shadowStopOf(parseStopBookDoc(doc({ phase: 'shadow' })), '2330'), null);
});
