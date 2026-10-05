// T1 分軌前向影子後台文件測試：node --test scripts/lib/surge-tracks-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTracksDayDoc, buildTracksIndexDoc, tracksDaySummary, gapSummary, assertNoReturns, assertTracksDocSizes, forwardReplaceProblems,
  dayDocId, isTracksDayId, LIST_ORDER, LIST_META, TRACKS_KIND_DAY, TRACKS_KIND_INDEX, MAX_DOC_BYTES, clean,
} from './surge-tracks-report.mjs';

const SEAL = 'f'.repeat(64);
const pick = (rank, code, over = {}) => ({
  rank, code, name: `股${code}`, name_src: 'names.json', market: 'TPEx', track: 'S', score: 0.0612345678, combo_n: null, close: 25.7, vol20: 176.25,
  qmax_lots: 1, qmax_rule: 'floor(1%×vol20)', DK_s: 0, disposal_status: '非處置（DK_s＝0）', flags_known: '', at_known5: 0, at_known20: 0,
  hist_len: 1018, nan20: 0, atr14: 0.0675, ...over,
});
const list = (id, track, n, picks) => ({ track, K: LIST_META[id].K, section: LIST_META[id].section, grey_watch_only: LIST_META[id].grey, n_pool: n,
  ranking: id.startsWith('R0') ? 'combo' : 'atr14', ranked_codes: picks.map(p => p.code), ranked_scores: picks.map(p => p.score), picks,
  rand: { seed: 1, draw: ['9999'], picks: Math.min(LIST_META[id].K, n) }, list_verdict: 'x', label: 'x' });
const core = (over = {}) => ({
  schema: 't1-tracks-forward-core/v1', kind: 't1-tracks-core', date_s: '2026-10-06', t: '2026-10-07', seal: SEAL, frozen_time: '2026-10-06T23:51:02+08:00',
  deadline: '2026-10-07T09:00:00+08:00', rehearsal: false, track_counts: { M: 760, Mp: 22, R: 63, S: 367, W: 683 }, closes_at_s: { TWSE: 1086, TPEx: 868 },
  disposal_attention: { strict_unknown: { TWSE: { disposal_missing_days: ['2026-10-05'], attention_missing_days: [] } } },
  lists: {
    'S0_atr14@5': list('S0_atr14@5', 'S', 367, [pick(1, '2923'), pick(2, '3609', { DK_s: null, flags_known: 'DKNA', at_known5: null })]),
    'SFB_atr14@5': list('SFB_atr14@5', 'Mp', 22, [pick(1, '1591', { track: 'Mp' })]),
    'R0_combo@5': list('R0_combo@5', 'R', 63, [pick(1, '2305', { track: 'R', DK_s: 1, flags_known: 'DK1', at_known5: 2 })]),
    'W_atr14@3': list('W_atr14@3', 'W', 683, [pick(1, '6225', { track: 'W', qmax_lots: null })]),
  },
  ...over,
});
const outcome = (rank, code, over = {}) => ({ rank, code, y: 0, m_buyable: 1, m_has_open_t: 1, m_locked_open: 0, m_c1: -0.045, m_disp_t_exec: 0, flags: 'C5_PENDING', ...over });
const yDoc = (over = {}) => ({
  kind: 't1-tracks-score', stage: 'y', status: 'ok', frozen_seal: SEAL, t: '2026-10-07', due: '2026-10-08',
  lists: {
    'S0_atr14@5': { K: 5, n_pool: 367, events: 2, picks: 5, hits: 1, E_rand: 0.0272, rand_draw_hits: 0, picks_outcome: [outcome(1, '2923', { y: 1 }), outcome(2, '3609')], pool_y: [1, 0], pool_buyable: [1, 1] },
    'SFB_atr14@5': { K: 5, n_pool: 22, events: 0, picks: 5, hits: 0, E_rand: 0, rand_draw_hits: 0, picks_outcome: [outcome(1, '1591')] },
    'R0_combo@5': { K: 5, n_pool: 63, events: 3, picks: 5, hits: 1, E_rand: 0.238, rand_draw_hits: 1, picks_outcome: [outcome(1, '2305', { y: 1, m_locked_open: 1, m_buyable: 0 })] },
    'W_atr14@3': { K: 3, n_pool: 683, events: 4, picks: 3, hits: 0, E_rand: 0.0176, rand_draw_hits: 0, picks_outcome: [outcome(1, '6225')] },
  },
  events: [{ code: '2923', name: '鼎固-KY', market: 'TWSE', track: 'S', failing: [], list_id: 'S0_atr14@5', rank: 1, K: 5, n_pool: 367, picked: true },
    { code: '3021', name: '鴻名', market: 'TWSE', track: 'R', failing: ['fCD'], list_id: 'R0_combo@5', rank: 24, K: 5, n_pool: 63, picked: false }],
  events_by_track: { S: 1, R: 1 },
  ...over,
});
const retDoc = stage => ({ kind: 't1-tracks-score', stage, status: 'ok', frozen_seal: SEAL,
  lists: { 'S0_atr14@5': { picks_outcome: [{ rank: 1, code: '2923', [`m_${stage}`]: 0.031, [`exit_${stage}_cat`]: 'OK' }], daily_mean_buyable: 0.031, pool_mean_buyable: 0.002 } } });

test('日文件：清單固定順序 M0→S0→S_FB→R0→W、M0 未接線、各區不混排', () => {
  const d = buildTracksDayDoc({ core: core() });
  assert.equal(d.kind, TRACKS_KIND_DAY);
  assert.notEqual(d.kind, 'frozen-forward');                       // a35 發佈的查詢鍵，誤用會讓 a35 整批中止
  assert.deepEqual(d.lists.map(l => l.id), LIST_ORDER);
  assert.equal(d.lists[0].status, 'not-wired');
  assert.deepEqual(d.lists[0].picks, []);
  assert.deepEqual(d.lists.map(l => l.grey), [false, false, false, true, true]);
  for (const b of d.lists.slice(1)) assert.ok(b.picks.every(p => p.track === { 'S0_atr14@5': 'S', 'SFB_atr14@5': 'Mp', 'R0_combo@5': 'R', 'W_atr14@3': 'W' }[b.id]));
  assert.equal(d.matured.y, null);
  assert.equal(d.events, null);
});

test('日文件：處置徽章分開列（DK1／未知），注意狀態未知不補 0', () => {
  const d = buildTracksDayDoc({ core: core() });
  const s0 = d.lists.find(l => l.id === 'S0_atr14@5');
  assert.equal(s0.picks[0].disposalBadge, null);
  assert.equal(s0.picks[1].disposalBadge, '處置狀態未知（來源缺漏）');
  assert.equal(s0.picks[1].dk, null);
  assert.equal(s0.picks[1].attentionBadge, '注意狀態未知（來源缺漏）');
  const r0 = d.lists.find(l => l.id === 'R0_combo@5');
  assert.equal(r0.picks[0].disposalBadge, '處置中（DK_s＝1）·交易規則另案登錄');
  assert.equal(r0.picks[0].attentionBadge, '近 5 日注意 2 次');
  assert.ok(s0.warnings.includes('量薄，單筆 ≤1% 均量'));
});

test('到期後：T1 命中、基準率、Δ 對 RAND 只用精確度；報酬（c1／c5／c10）一律不進文件', () => {
  const d = buildTracksDayDoc({ core: core(), y: yDoc(), c5: retDoc('c5'), c10: retDoc('c10') });
  const s0 = d.lists.find(l => l.id === 'S0_atr14@5');
  assert.equal(s0.picks[0].outcome.t1, true);
  assert.equal(s0.outcome.hits, 1);
  assert.equal(s0.outcome.baseRatePct, Math.round((2 / 367) * 100 * 1000) / 1000);
  assert.equal(s0.outcome.deltaPp, Math.round(((1 - 0.0272) / 5) * 100 * 1000) / 1000);
  assert.deepEqual(d.matured, { y: 'ok', h5: 'ok', h10: 'ok' });
  const txt = JSON.stringify(d);
  for (const k of ['m_c1', 'm_c5', 'm_c10', 'daily_mean', 'pool_mean', '"c5"', '"c10"', 'excess']) assert.ok(!txt.includes(k), `不得出現 ${k}`);
  const r0 = d.lists.find(l => l.id === 'R0_combo@5');
  assert.equal(r0.picks[0].outcome.lockedOpen, true);
  assert.equal(d.events.length, 2);
  assert.deepEqual(d.events[1].failing, ['冷卻期（前10日內連板）']);
  assert.equal(d.events[0].picked, true);
});

test('評分檔封印對不上凍結檔 ⇒ 視為未評分', () => {
  const d = buildTracksDayDoc({ core: core(), y: yDoc({ frozen_seal: 'e'.repeat(64) }) });
  assert.equal(d.matured.y, null);
  assert.ok(d.lists.every(l => l.outcome === null));
});

test('label_unavailable 只記狀態、不給命中數', () => {
  const d = buildTracksDayDoc({ core: core(), y: { kind: 't1-tracks-score', stage: 'y', status: 'label_unavailable', frozen_seal: SEAL } });
  assert.equal(d.matured.y, 'label_unavailable');
  assert.equal(d.events, null);
  assert.ok(d.lists.every(l => l.outcome === null));
});

test('演練凍結檔與格式不對的檔不得發佈', () => {
  assert.throws(() => buildTracksDayDoc({ core: core({ rehearsal: true }) }), /演練/);
  assert.throws(() => buildTracksDayDoc({ core: { kind: 'frozen-forward' } }), /格式/);
});

test('assertNoReturns：任何層級出現報酬鍵就丟錯', () => {
  assert.throws(() => assertNoReturns({ a: [{ b: { m_c5: 0.1 } }] }), /m_c5/);
  assert.throws(() => assertNoReturns({ daily_mean_buyable: 1 }), /daily_mean/);
  assert.throws(() => assertNoReturns({ c10: 1 }), /c10/);
  assert.doesNotThrow(() => assertNoReturns({ costRef: [], referenceNote: '', randDrawHits: 1, h5: 'ok' }));
});

test('索引：新→舊、凍結與缺口並列、累計只帶精確度類；G60／G250 進度', () => {
  const d1 = tracksDaySummary(buildTracksDayDoc({ core: core(), y: yDoc() }));
  const g = gapSummary({ date_s: '2026-10-07', t: '2026-10-08', reason: '已過目標日 09:00', seal: 'a'.repeat(64), unmet_conditions: { C2: {} } });
  const summary = { s0: '2026-10-06', n_scored: 1, stats: { 'S0_atr14@5': { days: 1, window_days: 1, picks: 5, hits: 1, E_rand: 0.0272, precision_pct: 20, rand_precision_pct: 0.544,
    delta_pp: 19.456, delta_ci_pp: [19.456, 19.456], lift: 36.76, lift_ci: [36.76, 36.76], daily_mean_buyable: 0.5 } }, gate: { 'S0_atr14@5': { g60_crash: null, g250: null } },
  process: { P2_seals: true } };
  const ix = buildTracksIndexDoc({ days: [d1, g], summary, status: { finished: 'x', exit: 0, errors: [] }, generatedAt: '2026-10-08T23:55:00Z' });
  assert.equal(ix.kind, TRACKS_KIND_INDEX);
  assert.deepEqual(ix.days.map(r => [r.day, r.status]), [['2026-10-07', 'gap'], ['2026-10-06', 'frozen']]);
  assert.equal(ix.nCore, 1); assert.equal(ix.nGaps, 1);
  assert.equal(ix.cumulative['S0_atr14@5'].deltaPp, 19.456);
  assert.ok(!('daily_mean_buyable' in ix.cumulative['S0_atr14@5']));
  assert.equal(ix.gates.g60.reached, false);
  assert.equal(ix.cumulative['W_atr14@3'], null);
  assert.equal(ix.days[0].gapReason, '已過目標日 09:00');
  assert.deepEqual(ix.days[0].unmet, ['C2']);
});

test('文件大小上限與前向不可改寫', () => {
  assert.throws(() => assertTracksDocSizes([['tracks-index', { reportJson: 'x'.repeat(MAX_DOC_BYTES + 1) }]]), /過大/);
  assert.deepEqual(assertTracksDocSizes([['a', { reportJson: '中' }]]), [['a', 3]]);
  const p = forwardReplaceProblems([{ id: 'tracks-fwd-2026-10-06', seal: 'a' }, { id: 'tracks-fwd-2026-10-07', seal: 'b' }], [{ id: 'tracks-fwd-2026-10-06', seal: 'c' }]);
  assert.deepEqual(p, { clash: ['tracks-fwd-2026-10-06'], missing: ['tracks-fwd-2026-10-07'] });
});

test('文件 id 與 clean：沒有 undefined／NaN', () => {
  assert.equal(dayDocId('2026-10-06'), 'tracks-fwd-2026-10-06');
  assert.ok(isTracksDayId('tracks-fwd-2026-10-06'));
  assert.ok(!isTracksDayId('fwd-2026-10-06'));
  assert.deepEqual(clean({ a: undefined, b: NaN, c: [Infinity, 1] }), { a: null, b: null, c: [null, 1] });
  const walk = (v, p) => { assert.notEqual(v, undefined, p); if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`); };
  walk(buildTracksDayDoc({ core: core(), y: yDoc() }), '$');
});
