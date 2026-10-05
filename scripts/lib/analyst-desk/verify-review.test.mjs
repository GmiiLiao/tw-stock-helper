import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compound, evaluateHorizon, buildMisses, buildReview, aggregate, retMapOf, laterDays, REVIEW_SPEC } from './verify-review.mjs';
import { reviewOne } from '../../verify-daily-analyst.mjs';
import { writeIssue, archiveDir } from './archive.mjs';
import { scanKeys } from './publish-split.mjs';
import { makeIssue, makePack, DAY, TRADING_DAYS } from './w5-fixtures.mjs';

const near = (a, b, eps = 0.011) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
/** 熱力夾具：stocks 緊湊陣列 [code, ret, valM, flags, resonance, industry]；market.ew；board.gainers。 */
const hm = (ew, rets, gainers = []) => ({ market: { ew }, stocks: Object.entries(rets).map(([c, r]) => [c, r, 1, 0, 'C', 'x']), board: { gainers } });
const HM = {
  '2026-10-05': hm(1.0, { 2330: 2, 2317: -1, 9999: 10 }, [{ code: '9999', name: '池內未入名單', industry: '其他', ret: 10, valM: 50 }, { code: '8888', name: '被排除', industry: '其他', ret: 9.5, valM: 20 }, { code: '2330', name: '台積電', ret: 2, valM: 9 }, { code: '7777', name: '無記錄', industry: '其他', ret: 9, valM: 5 }]),
  '2026-10-06': hm(0.5, { 2330: 1, 2317: 3 }),
  '2026-10-07': hm(-0.5, { 2330: 0, 2317: 0 }),
  '2026-10-09': hm(0, { 2330: 0, 2317: 0 }),
  '2026-10-12': hm(0, { 2330: 0 }),                                           // 2317 無成交
};
const heatmapOf = d => HM[d] || null;
const stocks = makeIssue().cards.find(c => c.id === 'next').focus.stocks;

test('compound：日報酬連乘；任何一日缺值＝null（不補 0）', () => {
  near(compound([10, 10]), 21, 1e-9);
  near(compound([-5, 5]), -0.25, 1e-9);
  assert.equal(compound([1, null]), null);
  assert.equal(compound([]), 0);
});

test('retMapOf／laterDays', () => {
  assert.equal(retMapOf(HM['2026-10-05']).get('2330'), 2);
  assert.deepEqual(laterDays(TRADING_DAYS, DAY, 2), ['2026-10-05', '2026-10-06']);
});

test('evaluateHorizon：+1 日報酬＝次一交易日、基準＝同日等權；命中＝報酬高於基準', () => {
  const r = evaluateHorizon({ stocks, tradingDays: TRADING_DAYS, day: DAY, h: 1, heatmapOf });
  assert.equal(r.status, 'ready');
  assert.deepEqual(r.days, ['2026-10-05']);
  assert.equal(r.benchPct, 1);
  const tsmc = r.picks.find(p => p.code === '2330'), hon = r.picks.find(p => p.code === '2317');
  assert.deepEqual([tsmc.retPct, tsmc.exPp, tsmc.hit], [2, 1, true]);
  assert.deepEqual([hon.retPct, hon.exPp, hon.hit], [-1, -2, false]);
  assert.deepEqual(tsmc.sponsors, ['momentum']);
  assert.ok(tsmc.evidence.includes('st.2330.ret'));
});

test('evaluateHorizon：+5 日連乘；某檔有一日無成交＝報酬 null、不計命中、附註明', () => {
  const tds = ['2026-10-01', DAY, '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09', '2026-10-12'];
  const r = evaluateHorizon({ stocks, tradingDays: tds, day: DAY, h: 5, heatmapOf });
  assert.equal(r.status, 'ready');
  assert.equal(r.days.length, 5);
  near(r.benchPct, (1.01 * 1.005 * 0.995 - 1) * 100);
  const tsmc = r.picks.find(p => p.code === '2330');
  near(tsmc.retPct, (1.02 * 1.01 * 1 * 1 * 1 - 1) * 100);
  const hon = r.picks.find(p => p.code === '2317');
  assert.equal(hon.retPct, null); assert.equal(hon.hit, null); assert.match(hon.note, /2026-10-12/);
});

test('evaluateHorizon：交易日不足或缺熱力定版檔 → pending（原因寫明）', () => {
  const few = evaluateHorizon({ stocks, tradingDays: ['2026-10-05', '2026-10-06'], day: '2026-10-02', h: 5, heatmapOf });
  assert.equal(few.status, 'pending'); assert.match(few.reason, /不足 5 個交易日/);
  const miss = evaluateHorizon({ stocks, tradingDays: TRADING_DAYS, day: DAY, h: 5, heatmapOf: d => (d === '2026-10-07' ? null : heatmapOf(d)) });
  assert.equal(miss.status, 'pending'); assert.match(miss.reason, /2026-10-07/);
});

test('buildMisses：D+1 gainers 前 N 檔未入名單者，附池內／排除原因／相關消息', () => {
  const pack = makePack();
  pack.excluded.next.push({ code: '8888', reason: '成交值不足' });
  pack.refs['nv.7777.label'] = { v: '利多' };
  const m = buildMisses({ firstDayHeatmap: HM['2026-10-05'], stocks, pack, topN: 10 });
  assert.deepEqual(m.map(x => x.code), ['9999', '8888', '7777']);               // 2330 已入名單，不算漏網
  assert.equal(m[0].inPool, true); assert.deepEqual(m[0].poolFrom, ['board.gainers']);
  assert.equal(m[1].excludedReason, '成交值不足');
  assert.deepEqual(m[2].relatedNews, ['nv.7777.label']);
  assert.equal(buildMisses({ firstDayHeatmap: HM['2026-10-05'], stocks, pack, topN: 1 }).length, 1);
});

test('buildReview：只評 watch；無名單 skip；已 ready 的期不重算；usedForScoring=false；鍵名乾淨', () => {
  const issue = makeIssue(); const pack = makePack();
  const r = buildReview({ issue, pack, tradingDays: TRADING_DAYS.slice(0, 5), heatmapOf, now: 1 });
  assert.equal(r.skip, false);
  assert.equal(r.review.usedForScoring, false);
  assert.equal(r.review.nominated, 2);
  assert.equal(r.review.horizons[1].status, 'ready');
  assert.equal(r.review.horizons[1].misses.length, 3);
  assert.equal(r.review.horizons[5].status, 'pending');
  assert.equal(r.complete, false);
  assert.deepEqual(r.review.reviewSpec.horizons, [1, 5]);
  assert.deepEqual(scanKeys(r.review), []);
  // +5 補上：已 ready 的 +1 原樣保留
  const kept = JSON.parse(JSON.stringify(r.review));
  kept.horizons[1].picks[0].retPct = 999;                                        // 竄改既有結果，應被保留而非重算
  const again = buildReview({ issue, pack, tradingDays: ['2026-10-01', DAY, '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-09', '2026-10-12'], heatmapOf, existing: kept, now: 2 });
  assert.equal(again.review.horizons[1].picks[0].retPct, 999);
  assert.equal(again.review.horizons[5].status, 'ready');
  assert.equal(again.complete, true);
  const noWatch = makeIssue(); noWatch.cards.find(c => c.id === 'next').focus.stocks = [];
  assert.equal(buildReview({ issue: noWatch, pack, tradingDays: TRADING_DAYS, heatmapOf }).skip, true);
  const recapOnly = makeIssue(); recapOnly.cards.find(c => c.id === 'next').focus.kind = 'recap';
  assert.equal(buildReview({ issue: recapOnly, pack, tradingDays: TRADING_DAYS, heatmapOf }).skip, true);      // recap 不評
});

test('aggregate：樣本 <20 個交易日只列逐日、不輸出命中率；≥20 才有', () => {
  const mk = day => ({ dataDate: day, edition: 'morning', horizons: { 1: { status: 'ready', benchPct: 0.5, picks: [{ hit: true, retPct: 1 }, { hit: false, retPct: -1 }, { hit: null, retPct: null }] } } });
  const few = aggregate([mk('2026-10-02'), mk('2026-10-05')], 1);
  assert.equal(few.sampleDays, 2); assert.equal(few.hitRate, undefined);
  assert.match(few.note, /只列逐日/);
  assert.equal(few.perDay[0].n, 2);                                              // hit:null 不計入
  const days = Array.from({ length: 20 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
  const many = aggregate(days.map(mk), 1);
  assert.equal(many.sampleDays, 20); assert.equal(many.hitRate, 50); assert.match(many.note, /事後挑選/);
  assert.equal(aggregate([mk('2026-10-02')], 5).perDay.length, 0);              // 沒有 ready 的期
});

test('reviewOne：端到端只寫 _review/{D}.{edition}.json；第二次 unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'analyst-verify-'));
  writeIssue({ root, issue: makeIssue(), pack: makePack(), transcript: [], edition: 'evening', dataDate: DAY, now: Date.parse('2026-10-02T23:40:00+08:00') });
  const key = `${DAY}.evening`;
  const r = reviewOne({ root, key, tradingDays: TRADING_DAYS.slice(0, 6), heatmapOf, now: 5 });
  assert.equal(r.status, 'partial');
  const f = join(archiveDir(root), '_review', `${key}.json`);
  assert.ok(existsSync(f));
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).horizons[1].status, 'ready');
  assert.equal(reviewOne({ root, key, tradingDays: TRADING_DAYS.slice(0, 6), heatmapOf, now: 6 }).status, 'unchanged');
  const only = readdirSync(archiveDir(root)).filter(n => n.startsWith('_review'));
  assert.deepEqual(only, ['_review']);
  const none = reviewOne({ root, key: '2026-10-05.evening', tradingDays: TRADING_DAYS, heatmapOf });
  assert.equal(none.status, 'no-issue');
});

// ── 掃描：任何 daemon／計分模組不得 import 對答案程式（仿熱力 usedForScoring 測試）──────────────
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(SCRIPTS, '..', 'src');
const SKIP = /^(node_modules|\.surge-cache|out|\.cache|data|fixtures)$/;
function walk(dir, out = []) {
  let names = []; try { names = readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const p = join(dir, n); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (!SKIP.test(n)) walk(p, out); } else if (/\.(mjs|ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

test('掃描：沒有任何檔 import verify-daily-analyst／verify-review（除了它們自己與本測試）', () => {
  const allowed = new Set(['scripts/verify-daily-analyst.mjs', 'scripts/lib/analyst-desk/verify-review.mjs', 'scripts/lib/analyst-desk/verify-review.test.mjs']);
  const offenders = [];
  for (const f of [...walk(SCRIPTS), ...walk(SRC)]) {
    const rel = relative(join(SCRIPTS, '..'), f);
    if (allowed.has(rel)) continue;
    if (/(verify-daily-analyst|analyst-desk\/verify-review|\.\/verify-review)(\.mjs)?['"]/.test(readFileSync(f, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
  const daemon = readFileSync(join(SCRIPTS, 'ai-daemon.mjs'), 'utf8');
  assert.equal(/verify-daily-analyst|verify-review|daily-analyst|_review/.test(daemon.replace(/\/\/.*$/gm, '')), false, 'ai-daemon 不得讀對答案或分析師團隊檔');
});

test('掃描：對答案程式不碰 Firestore、不寫 picksHistory／picksScoreboard', () => {
  for (const f of ['verify-daily-analyst.mjs', 'lib/analyst-desk/verify-review.mjs']) {
    const s = readFileSync(join(SCRIPTS, f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.equal(/firebase-admin|firebase\/firestore|getAdminDb|\.collection\(/.test(s), false, f);
    assert.equal(/picksHistory|picksScoreboard/.test(s), false, f);
  }
  assert.equal(REVIEW_SPEC.minSampleDays, 20);
});
