// 新聞識讀「網站路」獨立修正的原始碼契約（X8 網站端／X10／X11／X15）：node --test scripts/lib/news-website-fixes.test.mjs
// 依據：jev-score-usage-spec.md 附錄 B（2026-10-08 使用者「其它錯誤依建議修正」）。
// X5（有效期改依事件類型）已撤回：使用者 2026-10-08「j3 要等jev的結果並使用它」——維持 HEAD 現狀直到 Jev；
//   X5 的斷言已移除，末尾「撤回釘住」只確認沒有殘留半套。X11 依使用者「x11 先修」保留（官方欄方向改未判讀）。
// 只讀檔案文字、不連網；註解先剝除再比對（仿 hardcoded-removal.test.mjs 的 code()）。任何一條紅燈＝修正被改回去了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
/** 去掉整行註解（//、*、/*、{/* 開頭）與行尾 // 註解 */
const code = src => src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
  .map(l => l.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

const RATING = 'src/app/api/rating/route.ts';
const PREMARKET = 'src/components/Dashboard/PremarketHub.tsx';
const AI_EVAL = 'src/components/WatchlistTracker/StockAIEval.tsx';
const AFTER_NEWS = 'src/app/api/twse/after-market-news/route.ts';

test('X15：評分路由讀 newsVerdict/latest 走 60 秒 memoize（每請求不再整份重讀 100～570 KB）', () => {
  const src = code(read(RATING));
  assert.match(src, /memoize\(\s*'newsVerdictLatest',\s*60_000\s*,/);
  const reads = src.match(/collection\('newsVerdict'\)\.doc\('latest'\)/g) || [];
  assert.equal(reads.length, 1, '只能有一處讀 newsVerdict/latest（在 memoize 的 fetcher 內）');
  const memoBody = src.slice(src.indexOf("memoize('newsVerdictLatest'"));
  const getIdx = src.indexOf('export async function GET');
  assert.ok(src.indexOf("memoize('newsVerdictLatest'") < getIdx, 'memoize 要宣告在模組層，不可在 GET 內每請求建立');
  assert.match(memoBody.slice(0, 600), /collection\('newsVerdict'\)\.doc\('latest'\)/);
  // 壓制只在網站抓到新聞清單時才跑（反證 I7：純換源前維持）
  assert.match(src, /if \(news && news\.length\)/);
});

test('X8：PremarketHub 持股族群橫幅只顯示今天的 forecastHits（檢查 date，過期文件不顯示）', () => {
  const src = code(read(PREMARKET));
  assert.match(src, /todayTaipeiIso/);
  assert.match(src, /forecastHits/);
  assert.doesNotMatch(src, /setHits\(\s*snap\.exists\(\)\s*\?\s*\(snap\.data\(\)\.hits/, '不可再直接採用快照的 hits（不看 date）');
  assert.match(src, /\.date\s*===\s*todayTaipeiIso\(\)/, '顯示前要比對文件 date 是今天');
});

test('X10：StockAIEval 不再寫「影響評分」，改「未計入評分（參考值 ±N）」', () => {
  const src = code(read(AI_EVAL));
  assert.doesNotMatch(src, /影響評分/);
  assert.doesNotMatch(src, /20% 權重/, '09-18 起新聞不計分，不可再寫 20% 權重');
  assert.match(src, /未計入評分（參考值/);
});

test('X11：盤後報告官方欄方向在網站路由層一律改「未判讀」，不改共用 classifyOfficial', () => {
  const src = code(read(AFTER_NEWS));
  assert.match(src, /dir:\s*null/, '官方列方向要清成 null（元件顯示「需讀內文」）');
  assert.match(src, /dirStatus:\s*'未判讀'/);
  assert.doesNotMatch(src, /方向僅規則類/, '欄註不可再宣稱官方欄有規則方向');
  assert.match(src, /未判讀/);
  // 共用模組（分析師 pack 也在用）原封不動：仍有規則方向
  const lib = read('scripts/lib/after-market-news.mjs');
  assert.match(lib, /id: 'C16a'[^\n]*dir: '−'/);
});

test('X5 已撤回、維持現狀直到 Jev：評分路由沿用 HEAD 的掛判別（不帶事件類型）', () => {
  const rating = code(read(RATING));
  assert.doesNotMatch(rating, /attachLatestVerdict|verdictEventType/, 'X5 的事件類型有效期已撤回');
  assert.match(rating, /verdictBasis:\s*'content' as const/, '路由照 HEAD 只在最新一則掛內文判別');
  const sentiment = code(read('src/lib/news-sentiment.ts'));
  assert.doesNotMatch(sentiment, /validDaysForEventType|validityVersion/, 'X5 的事件類型有效期已撤回');
});
