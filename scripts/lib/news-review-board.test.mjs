// 新聞判別對答案的盤中前視加註（X16 網站端；審查 2026-10-08）：node --test scripts/lib/news-review-board.test.mjs
//   daemon 已在 newsVerdictReview/summary 寫 lookahead（舊板含盤中前視比例）與 preOpen（只收 09:00 前判讀的新板），
//   但網站唯一讀者戰情室軋空面板（SqueezePanel）照舊顯示舊板 newsLift，旁邊沒有任何前視註記。
//   規格 jev-score-usage-spec 附錄 B X16：「舊板加註『含盤中前視 x% 列』…加註下一次網站部署」。
// 不連網：直接載入 src/lib/news-review-board.ts（無 import、只有可剝除的型別註記，Node 25 內建型別剝除可載入）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const M = await import(new URL('../../src/lib/news-review-board.ts', import.meta.url).href);
const { lookaheadBadge, lookaheadDetail, preOpenBoardOf } = M;

const ST = (n, mean = 0.5, win = 55) => ({ n, mean, win });
const LA = { rows: 5229, preOpen: 4300, postOpen: 876, unknownTime: 53, pct: 16.8, note: '本板含盤中前視 16.8% 列（876／5229：…）；只收 09:00 前判讀的新板見 preOpen（另 53 列無判讀時間，新板不收）' };

test('有 lookahead ⇒ 照實寫比例（數字來自 daemon，不寫死）', () => {
  assert.equal(lookaheadBadge({ lookahead: LA }), '含盤中前視 16.8% 列');
  assert.equal(lookaheadBadge({ lookahead: { ...LA, pct: 3.2 } }), '含盤中前視 3.2% 列');
  assert.equal(lookaheadDetail({ lookahead: LA }), LA.note);
});

test('舊文件（daemon 尚未重算、沒有 lookahead）⇒ 仍加註但不捏造比例', () => {
  const b = lookaheadBadge({});
  assert.match(b, /含盤中前視/);
  assert.doesNotMatch(b, /\d/, '沒有資料就不寫數字');
  assert.match(lookaheadDetail({}), /盤中趟/);
  assert.equal(lookaheadBadge(null), b);
});

test('lookahead 有值但沒有可對答案的列（pct null、rows 0）⇒ 不加註', () => {
  assert.equal(lookaheadBadge({ lookahead: { rows: 0, preOpen: 0, postOpen: 0, unknownTime: 0, pct: null, note: '無可對答案的列' } }), '');
});

test('新板 preOpen：有統計才回傳；缺欄位或形狀不對回 null（舊文件不顯示新板）', () => {
  const pre = { boardVersion: 'nvr-v2-preopen-0900', days: 20, bull: ST(300), neutral: ST(900), bear: ST(80), newsLift: 0.12, conclusive: true };
  assert.deepEqual(preOpenBoardOf({ preOpen: pre }), pre);
  assert.equal(preOpenBoardOf({}), null);
  assert.equal(preOpenBoardOf({ preOpen: { days: 3 } }), null);
  assert.equal(preOpenBoardOf(null), null);
});

test('SqueezePanel 顯示加註與新板（契約：讀 lookahead／preOpen，經共用函式）', () => {
  const src = readFileSync(new URL('../../src/components/WarRoom/SqueezePanel.tsx', import.meta.url), 'utf8');
  assert.match(src, /from '@\/lib\/news-review-board'/);
  assert.match(src, /lookaheadBadge\(review\)/);
  assert.match(src, /lookaheadDetail\(review\)/);
  assert.match(src, /preOpenBoardOf\(review\)/);
});
