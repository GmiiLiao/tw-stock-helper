// T1 分軌前向影子後台文件測試：node --test scripts/lib/surge-tracks-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTracksDayDoc, buildTracksIndexDoc, tracksDaySummary, gapSummary, assertNoReturns, assertTracksDocSizes, forwardReplaceProblems,
  dayDocId, isTracksDayId, LIST_ORDER, LIST_META, TRACKS_KIND_DAY, TRACKS_KIND_INDEX, MAX_DOC_BYTES, clean,
  rawDocId, rawDocWrites, rawAssemble, rawReplaceProblems, rawVerifyStatus, RAW_SHARD_BYTES, TRACKS_KIND_RAW,
  REGISTRATION_VERSION, WATCH_LABEL, HO_BURNED_NOTE,
} from './surge-tracks-report.mjs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const AMEND = JSON.parse(readFileSync(new URL('../surge-lab/tracks/registration_t1_tracks_forward_v1_1.json', import.meta.url), 'utf8'));
const V1 = JSON.parse(readFileSync(new URL('../surge-lab/tracks/registration_t1_tracks_forward.json', import.meta.url), 'utf8'));

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
    'S0_atr14@5': { K: 5, n_pool: 367, events: 2, picks: 5, hits: 1, E_rand: 0.0272, rand_draw_hits: 0, n_disp_t_unknown: 1,
      picks_outcome: [outcome(1, '2923', { y: 1 }), outcome(2, '3609', { m_disp_t_exec: null, flags: 'DKNA;DTNA' })], pool_y: [1, 0], pool_buyable: [1, 1] },
    'SFB_atr14@5': { K: 5, n_pool: 22, events: 0, picks: 5, hits: 0, E_rand: 0, rand_draw_hits: 0, picks_outcome: [outcome(1, '1591')] },
    'R0_combo@5': { K: 5, n_pool: 63, events: 3, picks: 5, hits: 1, E_rand: 0.238, rand_draw_hits: 1, picks_outcome: [outcome(1, '2305', { y: 1, m_locked_open: 1, m_buyable: 0 })] },
    'W_atr14@3': { K: 3, n_pool: 683, events: 4, picks: 3, hits: 0, E_rand: 0.0176, rand_draw_hits: 0, picks_outcome: [outcome(1, '6225')] },
  },
  events: [{ code: '2923', name: '鼎固-KY', market: 'TWSE', track: 'S', failing: [], list_id: 'S0_atr14@5', rank: 1, K: 5, n_pool: 367, picked: true,
    score: 0.0612345678, DK_s: 0, atr14: 0.07, flags: '', m_c1: 0.09, m_buyable: 1, m_disp_t_exec: 0 },
    { code: '3021', name: '鴻名', market: 'TWSE', track: 'R', failing: ['fCD'], list_id: 'R0_combo@5', rank: 24, K: 5, n_pool: 63, picked: false }],
  events_by_track: { S: 1, R: 1 },
  official_limit_coverage: { t: { TWSE: { n_close: 1080, n_official: 1080, n_tick_fallback: 0, coverage: 1 }, TPEx: { n_close: 870, n_official: 868, n_tick_fallback: 2, coverage: 0.9977 } }, t1: null },
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
  assert.deepEqual(d.lists.map(l => l.grey), [false, true, true, true, true]);          // v1.1（HO-BURNED）：四份代理清單全部灰底
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
    delta_pp: 19.456, delta_ci_pp: [19.456, 19.456], lift: 36.76, lift_ci: [36.76, 36.76], daily_mean_buyable: 0.5 } }, gate: { n_scored: 1, g60: null, g250: null, g500: null },
  process: { P1: { ok: false, n_trading_days: 3, silent_days: ['2026-10-05'], gap_ratio: 0.33 }, P2: { ok: true, local_seals: true }, P3: { ok: true, fail: [], data_correction: ['2026-10-02'] } } };
  const alerts = { time: '2026-10-08T15:50:00Z', alerts: [{ level: 'error', code: 'PREWIRE', msg: '接線前證明不成立' }, { level: 'warn', code: 'DISP_ATT_LAG', msg: '落後' }] };
  const ix = buildTracksIndexDoc({ days: [d1, g], summary, status: { finished: 'x', exit: 0, errors: [], prewire_gate: { ok: false, why: 'pending' }, pins_ok: true },
    alerts, rawArchive: { ok: false, n_local: 3, n_verified: 2, missing: ['tracks-raw-core-2026-10-06'], time: null }, generatedAt: '2026-10-08T23:55:00Z' });
  assert.equal(ix.process.P1.ok, false); assert.deepEqual(ix.process.P1.silentDays, ['2026-10-05']);
  assert.deepEqual(ix.process.P3.dataCorrection, ['2026-10-02']);
  assert.deepEqual(ix.alerts.map(x => x.code), ['PREWIRE', 'DISP_ATT_LAG']);
  assert.equal(ix.pipeline.prewireOk, false);
  assert.deepEqual(ix.rawArchive, { ok: false, nLocal: 3, nVerified: 2, time: null, missing: ['tracks-raw-core-2026-10-06'] });
  assert.equal(ix.gates.g500.reached, false);
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

test('t 日起處置未知：卡片標未知（不當成未處置）；事件列不帶任何 m_ 報酬；漲停價檔位推算件數揭露', () => {
  const d = buildTracksDayDoc({ core: core({ official_limit_coverage: { min: 0.95, rows: { TWSE: { n_close: 1086, n_official: 1086, n_tick_fallback: 0, coverage: 1 } } } }), y: yDoc() });
  const s0 = d.lists.find(l => l.id === 'S0_atr14@5');
  assert.equal(s0.picks[1].outcome.dispTUnknown, true);
  assert.equal(s0.picks[1].outcome.dispT, false);
  assert.equal(s0.picks[0].outcome.dispTUnknown, false);
  assert.equal(s0.outcome.nDispTUnknown, 1);
  assert.equal(d.events[0].score, 0.061235);
  assert.ok(!JSON.stringify(d.events).includes('m_c1') && !JSON.stringify(d.events).includes('0.09'));
  assert.equal(d.limitCoverage.s.TWSE.nTickFallback, 0);
  assert.equal(d.limitCoverage.t.TPEx.nTickFallback, 2);
  assert.equal(d.limitCoverage.t1, null);
});

test('逐位副本：檔名→id、gzip 分片→組回逐位相同、已發佈不可改寫或消失、驗證帳', () => {
  assert.equal(rawDocId('tracks_fwd_2026-10-06.json'), 'tracks-raw-core-2026-10-06');
  assert.equal(rawDocId('tracks_fwd_score_2026-10-06_c10.json'), 'tracks-raw-score-2026-10-06-c10');
  assert.equal(rawDocId('tracks_fwd_gap_2026-10-07.json'), 'tracks-raw-gap-2026-10-07');
  assert.equal(rawDocId('tracks_fwd_parity_2026-10-06.json'), 'tracks-raw-parity-2026-10-06');
  assert.equal(rawDocId('prewire/tracks_fwd_prewire_20261007T221500.json'), 'tracks-raw-prewire-20261007T221500');
  assert.equal(rawDocId('prewire/tracks_fwd_dispatt_overlap_pass.json'), 'tracks-raw-overlap-pass');
  for (const f of ['tracks_fwd_summary.json', 'tracks_fwd_status.json', 'plan.json', '../x.json', 'tracks_fwd_dispatt_overlap.json']) assert.equal(rawDocId(f), null, f);
  const bytes = Buffer.from(JSON.stringify({ a: '中'.repeat(10), seal: 'x' }));
  const sha = createHash('sha256').update(bytes).digest('hex');
  const small = rawDocWrites({ id: 'tracks-raw-core-2026-10-06', file: 'tracks_fwd_2026-10-06.json', seal: 'x', sha256: sha, bytes: bytes.length, gz: gzipSync(bytes) });
  assert.equal(small.length, 1); assert.equal(small[0][1].kind, TRACKS_KIND_RAW); assert.equal(small[0][1].nShards, 1);
  assert.equal(createHash('sha256').update(gunzipSync(rawAssemble(small[0][1]))).digest('hex'), sha);
  const big = Buffer.from(Array.from({ length: RAW_SHARD_BYTES * 2 + 10 }, (_, i) => (i * 7919) % 251));   // 不可壓縮 ⇒ 3 片
  const w = rawDocWrites({ id: 'tracks-raw-score-2026-10-06-y', file: 'tracks_fwd_score_2026-10-06_y.json', seal: null, sha256: 'z', bytes: big.length, gz: big });
  assert.deepEqual(w.map(([id]) => id), ['tracks-raw-score-2026-10-06-y', 'tracks-raw-score-2026-10-06-y~1', 'tracks-raw-score-2026-10-06-y~2']);
  assert.ok(Buffer.from(rawAssemble(w[0][1], [w[2][1], w[1][1]])).equals(big));
  assert.throws(() => rawAssemble(w[0][1], [w[1][1]]), /分片不齊/);
  assert.throws(() => rawDocWrites({ id: 'tracks-fwd-2026-10-06', file: 'x', seal: null, sha256: 'z', bytes: 1, gz: Buffer.from('x') }), /不合規/);
  assert.deepEqual(rawReplaceProblems([{ id: 'a', sha256: '1' }, { id: 'b', sha256: '2' }], [{ id: 'a', sha256: '9' }]), { clash: ['a'], missing: ['b'] });
  assert.deepEqual(rawVerifyStatus([{ id: 'a', sha256: '1' }, { id: 'b', sha256: '2' }], { a: { sha256: '1' }, b: { sha256: 'old' } }, 't'),
    { ok: false, n_local: 2, n_verified: 1, missing: ['b'], time: 't' });
});

test('登錄修訂 v1.1：S0／S_FB 的判定、標籤、灰底、標題與登錄 JSON 逐字一致；R0／W 不變', () => {
  assert.equal(REGISTRATION_VERSION, AMEND.version);
  assert.equal(WATCH_LABEL, AMEND.presentation.watch_label);
  assert.equal(WATCH_LABEL, '只觀察（保留驗證期作廢·待前向 G250）');
  assert.equal(HO_BURNED_NOTE, AMEND.presentation.header_one_line);
  for (const [id, o] of Object.entries(AMEND.lists_override)) {
    const m = LIST_META[id];
    assert.equal(m.verdict, o.entry_verdict, id);
    assert.equal(m.label, o.label, id);
    assert.equal(`${m.verdict}：${m.label}`, o.list_verdict, id);
    assert.equal(m.grey, o.grey_watch_only, id);
    assert.equal(m.title, o.title, id);
    assert.equal(m.watchLabel, WATCH_LABEL, id);
    assert.equal(m.section, { 'S0_atr14@5': 'S0', 'SFB_atr14@5': 'S_FB' }[id], id);    // section 代碼不變（不混排結構不變）
  }
  assert.deepEqual(Object.keys(AMEND.lists_override).sort(), ['S0_atr14@5', 'SFB_atr14@5']);
  assert.equal(LIST_META['R0_combo@5'].verdict, 'R-WATCH-ONLY'); assert.equal(LIST_META['R0_combo@5'].watchLabel, null);
  assert.equal(LIST_META['W_atr14@3'].verdict, 'W-WATCH-ONLY'); assert.equal(LIST_META['M0@10'].grey, false);
  for (const id of ['R0_combo@5', 'W_atr14@3', 'M0@10']) {                           // 沒覆寫的清單＝v1 原文（凍結檔的 list_verdict 由 v1 常數產生）
    assert.equal(`${LIST_META[id].verdict}：${LIST_META[id].label}`, V1.lists[id].list_verdict, id);
    assert.equal(LIST_META[id].grey, V1.lists[id].grey_watch_only, id);
  }
});

test('套過登錄修訂的凍結檔：清單判定必須等於後台標籤，否則整份不發佈；文件帶版本與 HO-BURNED 說明', () => {
  const amended = () => {
    const c = core({ registration_amendment: { registration_id: 'T1-TRACKS-FWD-2026-10-05', version: '1.1' } });
    for (const id of Object.keys(c.lists)) c.lists[id] = { ...c.lists[id], list_verdict: `${LIST_META[id].verdict}：${LIST_META[id].label}`, grey_watch_only: LIST_META[id].grey };
    return c;
  };
  const d = buildTracksDayDoc({ core: amended() });
  assert.equal(d.registrationVersion, '1.1');
  const s0 = d.lists.find(l => l.id === 'S0_atr14@5');
  assert.equal(s0.grey, true); assert.equal(s0.watchLabel, WATCH_LABEL); assert.ok(s0.listVerdict.startsWith(`S-WATCH-ONLY：${WATCH_LABEL}`));
  const bad = amended();
  bad.lists['S0_atr14@5'] = { ...bad.lists['S0_atr14@5'], list_verdict: 'S-KEEP-AS-SHADOW：觀察／研究榜' };
  assert.throws(() => buildTracksDayDoc({ core: bad }), /清單判定與後台標籤不一致/);
  assert.equal(buildTracksDayDoc({ core: core() }).registrationVersion, '1');                       // 沒有修訂指標的凍結檔照實標 v1
  const ix = buildTracksIndexDoc({ days: [], generatedAt: 'x' });
  assert.equal(ix.registrationVersion, '1.1'); assert.equal(ix.hoBurnedNote, HO_BURNED_NOTE);
  assert.equal(ix.listMeta['SFB_atr14@5'].watchLabel, WATCH_LABEL); assert.equal(ix.listMeta['SFB_atr14@5'].grey, true);
});
