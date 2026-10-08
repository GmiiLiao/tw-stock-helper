// 原始碼釘住（2026-10-08 使用者「其它錯誤依建議修正」——jev-score-usage-spec 附錄 B 的 daemon 端獨立修正）：
//   node --test scripts/lib/news-misc-daemon-pin.test.mjs
//   daemon 是 disk 即部署（要重啟才生效），這組測試確保下列修正落在 ai-daemon.mjs、而且之後不被改回：
//   X1／X7 當沖 s6 已反映比對與新聞快取 5 分（s6Version）；X2 推論信心上限（三個 newsVerdict 寫入端）；
//   X4 newsDaily 停算標題極性；X6 軋空判讀帶 wiki；X9 LIMITUP_SKILL 消息面說明；
//   X12 軋空註解與程式一致；X14 shortTraining 加 scoreExNews／newsPts／nvEngine；X16 對答案盤中前視加註與新舊板分開；
//   X17 提示詞規則 2、7（promptVersion）；X18 ingestMops 位元組判斷。
//   X3（話題選股）與 X8 的 daemon 端（晨報風向停推）已撤回：使用者 2026-10-08「j3 要等jev的結果並使用它」——維持 HEAD 現狀直到 Jev，
//   這兩項的斷言已移除；下方「撤回釘住」只確認撤回後沒有殘留半套（不得清空會員 forecastHits）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const daemon = readFileSync(join(HERE, '..', 'ai-daemon.mjs'), 'utf8');
const code = s => s.replace(/\/\/.*$/gm, '');   // 只看程式碼（註解可以提到這些字）
const fn = (start, next) => {
  const i = daemon.indexOf(start); const j = daemon.indexOf(next, i + start.length);
  assert.ok(i > 0 && j > i, `找得到 ${start}…${next}`);
  return daemon.slice(i, j);
};
const judge = fn('async function judgeOneStock(', 'async function newsJudgeContext(');
const WRITERS = [['async function computeNightBackfill(', 'async function computeNewsVerdictReview('],
  ['async function computeIntradayNewsVerdict(', 'function newsVerdictTargetIso('], ['async function computeNewsVerdictBatch(', 'async function computeLimitUpNewsVerdict(']];
const WRITER_ANCHORS = ["pass: 'night', at: Date.now(),", "pass: 'intraday', at: Date.now(),", 'basis: v.basis, n: v.n, pass, at: Date.now(),'];
const rowOf = anchor => { const c = code(daemon); const i = c.indexOf(anchor); assert.ok(i > 0, anchor); return c.slice(c.lastIndexOf('= {', i), c.indexOf('};', i)); };

test('X1／X7：s6 版本章與新聞快取 TTL 由 daytrade-score.mjs 定義；工作台情境快取 5 分、不再 30 分；引擎參數帶 s6Version', () => {
  const c = code(daemon);
  assert.match(c, /import \{[^}]*\bS6_VERSION\b[^}]*\bDESK_NEWS_TTL_MS\b[^}]*\} from '\.\/lib\/daytrade-score\.mjs';/);
  const desk = code(fn('async function buildDeskContext(', 'let _rotIdx'));
  assert.ok(desk.includes('Date.now() - _deskNews.at > DESK_NEWS_TTL_MS'));
  assert.ok(!/_deskNews\.at > 30 \* 60000/.test(desk), '舊的 30 分快取已拿掉');
  assert.ok(c.includes('const DESK_ENGINE_PARAMS = Object.freeze({ ...DESK_PARAMS, s6Version: S6_VERSION });'));
  assert.ok(c.includes('createDaytradeEngine({ evidence: DESK_EVIDENCE, params: DESK_ENGINE_PARAMS,'));
});

test('X7：三個寫入端寫完 newsVerdict/latest 後讓工作台新聞快取失效（行程內、零上游）', () => {
  for (const [a, b] of WRITERS) {
    const body = code(fn(a, b));
    const w = body.indexOf("db.collection('newsVerdict').doc('latest').set(");
    assert.ok(w > 0, a);
    assert.ok(body.indexOf('invalidateDeskNews();', w) > w, `${a} 寫 latest 之後要 invalidateDeskNews()`);
  }
  assert.ok(code(daemon).includes('function invalidateDeskNews() { _deskNews.at = 0; }'));
});

test('X2：三個 newsVerdict 寫入端都在規則欄位之後套推論信心上限（inferenceCapFields，留 aiOriginal.confidence）', () => {
  assert.ok(code(daemon).includes("import { inferenceCapFields } from './lib/news-inference-cap.mjs';"));
  for (const anchor of WRITER_ANCHORS) {
    const row = rowOf(anchor);
    const r = row.indexOf('...ruleFieldsOf(v),'); const cap = row.indexOf('...inferenceCapFields(v),');
    assert.ok(r > 0 && cap > r, `${anchor}：inferenceCapFields 要在 ruleFieldsOf 之後（合併規則類 aiOriginal、覆寫 confidence）`);
  }
  assert.equal((code(daemon).match(/\.\.\.inferenceCapFields\(v\),/g) || []).length, 3);
});

test('X17：提示詞規則 2 補設備材料商例外、規則 7 推論信心最高「低」（與規則 9 一致）；判別帶 promptVersion，三個寫入端都存', () => {
  assert.ok(judge.includes('本檔若是供應擴產所需設備或材料的廠商'), '規則 2 例外');
  assert.ok(judge.includes('推論性的連動信心最高只能給「低」'), '規則 7');
  assert.ok(!judge.includes('推論性的連動信心最高給「中」'), '舊規則 7 已改');
  assert.ok(judge.includes('且信心最高只能給「低」。'), '規則 9 不變');
  assert.match(code(daemon), /const NV_PROMPT_VERSION = 'nv-prompt-v2-[0-9-]+';/);
  assert.ok(code(judge).includes('promptVersion: NV_PROMPT_VERSION,'));
  for (const anchor of WRITER_ANCHORS) assert.ok(rowOf(anchor).includes('promptVersion: v.promptVersion || null,'), anchor);
});

test('X4：newsDaily 停算標題極性（LU_POS／LU_NEG 移除），mentionsJson 每檔只留 [則數]', () => {
  const c = code(daemon);
  assert.ok(!/\bLU_POS\b|\bLU_NEG\b/.test(c));
  const body = code(fn('async function computeNewsDaily(', '\n}\n'));
  assert.ok(body.includes('const m = (mentions[code] ||= [0]); m[0]++;'));
  assert.ok(!/m\[1\]\s*\+=/.test(body) && !/\bpol\b/.test(body), '不再累加極性');
  assert.ok(body.includes("mentionsFormat: 'count-v2'"));
});

test('X4（審查 2026-10-08）：回補腳本 backfill-news.mjs 也停算標題極性，寫同一格式（[則數]＋mentionsFormat）', () => {
  const src = code(readFileSync(join(HERE, '..', 'backfill-news.mjs'), 'utf8'));
  assert.ok(!/\bconst (POS|NEG)\s*=/.test(src), '標題極性詞典已移除');
  assert.ok(!/m\[1\]\s*\+=/.test(src) && !/\bpol\b/.test(src), '不再累加極性');
  assert.ok(src.includes("const MENTIONS_FORMAT = 'count-v2';"));
  assert.ok(src.includes('mentionsFormat: MENTIONS_FORMAT'));
  assert.ok(src.includes('const m = (d.mentions[code] ||= [0]);'));
});

test('X6：軋空判讀路徑帶 wiki 區塊（共用 loadWikiStocks）', () => {
  const body = code(fn('async function computeSqueezeNewsVerdict(', 'async function updateGlobalHistory('));
  assert.ok(body.includes('const wiki = loadWikiStocks(WIKI_STOCKS_FILE, { onWarn: m => log(`⚠ ${m}`) });'));
  assert.ok(body.includes('await judgeOneStock(it, { calMap, gLine, indMap, wiki });'));
});

test('X9：LIMITUP_SKILL 消息面不再宣稱 newsDaily 標題極性有訊號、已納入模型', () => {
  const s = fn('const LIMITUP_SKILL = `', '`;\n');
  assert.ok(!s.includes('正面極性1.64x'));
  assert.ok(!s.includes('以0.3阻尼保守納入'));
  assert.ok(/消息面\(newsDaily[^\n]*已移除[^\n]*不納入/.test(s));
});

test('X12：軋空 newsScore 註解與程式一致（灰 0，不是 −0.5）；程式本身不變', () => {
  const body = fn('async function computeSqueezeNewsVerdict(', 'async function updateGlobalHistory(');
  assert.ok(!body.includes('灰 −0.5'));
  assert.ok(body.includes('灰 0'));
  assert.ok(code(body).includes("const newsScore = +(((reasonType.tone === 'green' ? 1 : 0) + (verdict.bullish ? (chainLink?.score ?? 0) : 0))).toFixed(2);"));
});

test('X14：做空訓練快照每列帶 scoreExNews、newsPts、nvEngine（訓練只用不含新聞的分數）', () => {
  const body = code(fn('async function computeShortCandidates(', 'async function recordShortTraining('));
  const push = body.slice(body.indexOf('trainRows.push({'), body.indexOf('});', body.indexOf('trainRows.push({')));
  for (const k of ['scoreExNews: score - newsPts', 'newsPts,', "nvEngine: hasNv ? NV_ENGINE_OLLAMA : null"]) assert.ok(push.includes(k), k);
  assert.ok(body.includes('newsPts = pts;'));
});

test('X16：對答案舊板照算並加註盤中前視比例；新板只收適用日 09:00 前產出的判讀，另存 preOpen（兩板版本章分開）', () => {
  const body = code(fn('async function computeNewsVerdictReview(', 'async function computeIntradayNewsVerdict('));
  assert.ok(body.includes("import('./lib/news-verdict-preopen.mjs')") || code(daemon).includes("from './lib/news-verdict-preopen.mjs';"));
  assert.ok(body.includes('verdictTiming(v[code], day)'));
  assert.ok(body.includes('lookahead: {'));
  assert.ok(body.includes('preOpen: {'));
  assert.ok(body.includes('boardVersion: REVIEW_BOARD_VERSIONS.all'));
  assert.ok(body.includes('boardVersion: REVIEW_BOARD_VERSIONS.preOpen'));
});

test('X2／X17（審查 2026-10-08）：分組對答案 breakdown 另依 promptVersion 與 confCap 分組（40 日滾動窗新舊口徑分得開；既有組不變）', () => {
  const body = code(fn('async function computeNewsVerdictReview(', 'async function computeIntradayNewsVerdict('));
  assert.ok(body.includes("for (const f of ['confidence', 'strength', 'priced', 'basis', 'pass', 'eventType', 'certainty', 'novelty', 'pxSrc', 'promptVersion', 'confCap'])"));
});

test('X18：ingestMops 以位元組估整份文件（fitMopsDayDoc），不再用字元數比 900KB', () => {
  const body = code(fn('async function ingestMops(', '// ── 產業現貨'));
  assert.ok(!/json\.length > 900_000/.test(body));
  assert.ok(body.includes('fitMopsDayDoc({'));
  assert.ok(body.includes("docPath: `mopsNews/${day}`") && body.includes('keep: prev'), '整份文件（含 merge 留著的舊欄位）一起估');
  // 審查 2026-10-08：bodyTrimmed 不是永久旗標——只有本版裁切章才跳過重抓（skipBodyRefetch）
  assert.ok(body.includes('!x.body && !skipBodyRefetch(x) && x.api === '), '同一版下放不下而清掉的內文不再每輪重抓');
  assert.ok(!body.includes('!x.bodyTrimmed'), '不可再以布林旗標永久擋重抓');
  assert.ok(code(daemon).includes("import { fitMopsDayDoc, skipBodyRefetch } from './lib/mops-doc-fit.mjs';"));
});

test('X3／X8（daemon 端）已撤回、維持現狀直到 Jev：不殘留半套（話題選股沿用舊讀法、晨報風向照常產生，不清空會員 forecastHits）', () => {
  const c = code(daemon);
  assert.ok(!c.includes('topic-picks-news.mjs'), '話題選股的新聞則數模組已撤回');
  const topic = code(fn('async function computeTopicPicks(', 'async function publishMorningNote('));
  assert.ok(topic.includes("db.collection('sectorForecast').doc('latest').get()"), '話題選股仍讀 sectorForecast（HEAD 現狀）');
  const fc = code(fn('async function forecastSectors(', '// ── 52)'));
  assert.ok(!fc.includes('stopped: true'), '晨報風向不得寫成停用文件');
  assert.ok(!fc.includes('hits: [], stopped'), '不得把會員 forecastHits 覆寫成空的停用文件');
  assert.ok(fc.includes("db.collection('sectorForecast').doc('latest').set({ date, generatedAt: Date.now(), model, bullish, bearish,"), '晨報風向照常寫 sectorForecast');
});
