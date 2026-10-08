// 個股評分的新聞利空壓制只壓 signal、不壓 baseSignal（X21；使用者 2026-10-08 裁定 U6「ok」——新聞技能 §3C.5 R1）：
//   node --test scripts/lib/analysis-enrich-news-cap.test.mjs
// baseSignal 是「未含風險的技術訊號」，描述走勢強弱（CLAUDE.md「評分有兩種口徑」）；新聞利空是風險提示，
//   只把可交易性的 signal 上限調為觀察（WATCH），不改寫技術面。追高、走勢轉空是價量事實，仍兩者都壓。
// 不連網：直接載入 src/lib/analysis-enrich.ts（Node 25 內建型別剝除；它的相對 import 沒寫副檔名，這裡用 registerHooks 補 .ts）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.endsWith('.ts')) {
      return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});

const ENRICH_URL = new URL('../../src/lib/analysis-enrich.ts', import.meta.url);
const { enrichScoredStock } = await import(ENRICH_URL.href);

const baseStock = (over = {}) => ({
  code: '9999', name: '測試', price: 100, changePercent: 1.2,
  score: 70, grade: 'B+', signal: 'BUY', baseScore: 70, baseSignal: 'BUY',
  reasons: [], risks: [], buyZones: [], sellTargets: [], stopLoss: 95,
  isDisposition: false, isAttention: false, ...over,
});

/** 一則 AI 讀內文的利空判別（剛產出、未衰減） */
const bearNews = (strength, confidence) => {
  const at = new Date().toISOString();
  return [{
    title: '測試公司重大訊息', time: at,
    verdict: '利空', verdictBasis: 'content', verdictConfidence: confidence, verdictStrength: strength,
    verdictAt: at, verdictReason: '測試理由',
  }];
};

test('X21：新聞強利空（adjustment ≤ −10）只把 signal 壓成 WATCH，baseSignal（技術面）維持 BUY', () => {
  const r = enrichScoredStock(baseStock(), null, null, bearNews('極強', '高'));
  assert.ok(r.newsSentiment.adjustment <= -10, `前提：強利空 adjustment=${r.newsSentiment.adjustment}`);
  assert.equal(r.stock.signal, 'WATCH', '可交易性訊號上限調為觀察（風險提示）');
  assert.equal(r.stock.baseSignal, 'BUY', '未含風險的技術訊號不因新聞改寫');
  assert.ok(r.stock.risks.some(x => x.startsWith('📰 新聞面偏空')), '利空另列在風險');
});

test('X21：STRONG_BUY 遇新聞強利空，signal→WATCH、baseSignal 維持 STRONG_BUY', () => {
  const r = enrichScoredStock(baseStock({ score: 85, grade: 'A', signal: 'STRONG_BUY', baseScore: 85, baseSignal: 'STRONG_BUY' }),
    null, null, bearNews('極強', '高'));
  assert.equal(r.stock.signal, 'WATCH');
  assert.equal(r.stock.baseSignal, 'STRONG_BUY');
});

test('X21：處置股（signal 已是 NEUTRAL）遇新聞強利空，baseSignal 照技術面顯示（個股頁「技術面：…」）', () => {
  const r = enrichScoredStock(baseStock({ score: 30, grade: 'C', signal: 'NEUTRAL', baseScore: 70, baseSignal: 'BUY', isDisposition: true }),
    null, null, bearNews('極強', '高'));
  assert.equal(r.stock.signal, 'NEUTRAL', '處置一律 NEUTRAL 不變');
  assert.equal(r.stock.baseSignal, 'BUY');
});

test('非回歸：新聞弱利空（−10 < adjustment < 0）兩個訊號都不壓', () => {
  const r = enrichScoredStock(baseStock(), null, null, bearNews('弱', '低'));
  assert.ok(r.newsSentiment.adjustment < 0 && r.newsSentiment.adjustment > -10, `前提：弱利空 adjustment=${r.newsSentiment.adjustment}`);
  assert.equal(r.stock.signal, 'BUY');
  assert.equal(r.stock.baseSignal, 'BUY');
});

test('非回歸：追高（乖離 > 5%）是價量事實，signal 與 baseSignal 仍一起壓成 WATCH', () => {
  const bars = Array.from({ length: 30 }, (_, i) => {
    const c = i === 29 ? 112 : 100;
    return { d: `2026-08-${String(i + 1).padStart(2, '0')}`, o: c, h: c, l: c, c, v: 1000 };
  });
  const r = enrichScoredStock(baseStock({ price: 112 }), bars, null, null);
  assert.ok(r.swingSignal?.chase, `前提：追高 biasPct=${r.swingSignal?.biasPct}`);
  assert.equal(r.stock.signal, 'WATCH');
  assert.equal(r.stock.baseSignal, 'WATCH');
});

test('原始碼契約：新聞利空分支只碰 signal（baseSignal 只在基本面重算與追高／走勢轉空處改寫）', () => {
  const src = readFileSync(ENRICH_URL, 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const i = src.indexOf('if (newsSentiment.adjustment <= -10) {');
  assert.ok(i > 0, '找得到強利空分支');
  const block = src.slice(i, src.indexOf('}', i));
  assert.match(block, /stock\.signal = capBuy\(stock\.signal\);/);
  assert.doesNotMatch(block, /baseSignal/, '新聞利空不可改寫 baseSignal');
  assert.equal((src.match(/stock\.baseSignal = capBuy\(stock\.baseSignal\);/g) || []).length, 2, '只剩追高與走勢轉空兩處');
});
