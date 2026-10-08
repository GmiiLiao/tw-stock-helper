// 新聞判別對答案：盤中前視列的切分（09:00 前／後）單元測試：node --test scripts/lib/news-verdict-preopen.test.mjs
//   2026-10-08 X16（jev-score-usage-spec 附錄 B、S1 卡；反證 S8）：舊對答案「昨收→今開」把 pass=intraday 的列也算進去
//   （27 日 876／5,229 列＝16.8%），判讀產生時已開盤＝前視。舊板照舊並加註比例；新板只收適用日 09:00 前產出的判讀，兩板分開。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preOpenCutMs, verdictTiming, lookaheadSummary, REVIEW_BOARD_VERSIONS } from './news-verdict-preopen.mjs';

const tpe = (ymd, hh, mm = 0) => Date.parse(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);

test('切點＝適用日台北 09:00', () => {
  assert.equal(preOpenCutMs('2026-10-08'), tpe('2026-10-08', 9));
  assert.equal(preOpenCutMs('bad'), null);
});

test('09:00 前（含前一晚盤後、夜補、晨間、承接自前一日）＝pre；09:00 起＝post；pass=intraday 一律 post', () => {
  const day = '2026-10-08';
  assert.equal(verdictTiming({ pass: 'evening', at: tpe('2026-10-07', 23, 30) }, day), 'pre');
  assert.equal(verdictTiming({ pass: 'night', at: tpe(day, 3) }, day), 'pre');
  assert.equal(verdictTiming({ pass: 'morning', at: tpe(day, 8, 59) }, day), 'pre');
  assert.equal(verdictTiming({ pass: 'evening', carriedFrom: '2026-10-07', at: tpe('2026-10-06', 23) }, day), 'pre');
  assert.equal(verdictTiming({ pass: 'morning', at: tpe(day, 9) }, day), 'post');
  assert.equal(verdictTiming({ pass: 'intraday', at: tpe(day, 8) }, day), 'post', '盤中趟按構造就是開盤後');
  assert.equal(verdictTiming({ pass: 'intraday' }, day), 'post');
});

test('承接列（carriedFrom）保留前一日的 pass=intraday：是前一交易日盤中產生、早於適用日開盤 ⇒ 依 at 判 pre（審查 2026-10-08）', () => {
  const day = '2026-10-08';
  // 前一日（10-07）盤中趟 11:00 判讀，被 10-08 文件承接（ai-daemon computeNewsVerdictBatch：{ ...yv[c], carriedFrom: yIso }）
  assert.equal(verdictTiming({ pass: 'intraday', carriedFrom: '2026-10-07', at: tpe('2026-10-07', 11) }, day), 'pre');
  // 承接列的 at 若落在適用日 09:00 之後（不應發生，但照實判）⇒ post；沒有 at ⇒ unknown（不猜）
  assert.equal(verdictTiming({ pass: 'intraday', carriedFrom: '2026-10-07', at: tpe(day, 9, 30) }, day), 'post');
  assert.equal(verdictTiming({ pass: 'intraday', carriedFrom: '2026-10-07' }, day), 'unknown');
  // 未承接的盤中列仍一律 post（盤中趟寫的是當日文件，按構造在開盤後）
  assert.equal(verdictTiming({ pass: 'intraday', at: tpe('2026-10-07', 11) }, day), 'post');
});

test('沒有判讀時間（非盤中趟）＝unknown：新板不收（不猜）', () => {
  assert.equal(verdictTiming({ pass: 'evening' }, '2026-10-08'), 'unknown');
  assert.equal(verdictTiming({ pass: 'evening', at: 'x' }, '2026-10-08'), 'unknown');
  assert.equal(verdictTiming(null, '2026-10-08'), 'unknown');
});

test('加註統計：列數、前視列與比例（1 位小數）', () => {
  const s = lookaheadSummary(['pre', 'pre', 'post', 'unknown', 'pre', 'post']);
  assert.deepEqual(s, { rows: 6, preOpen: 3, postOpen: 2, unknownTime: 1, pct: 33.3 });
  assert.deepEqual(lookaheadSummary([]), { rows: 0, preOpen: 0, postOpen: 0, unknownTime: 0, pct: null });
});

test('兩板版本章分開', () => {
  assert.notEqual(REVIEW_BOARD_VERSIONS.all, REVIEW_BOARD_VERSIONS.preOpen);
  assert.match(REVIEW_BOARD_VERSIONS.preOpen, /0900/);
});
