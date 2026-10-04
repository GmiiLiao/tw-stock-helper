// 起漲研究後台（官方化重訓驗證／鏡像健康／管線狀態）文件測試：node --test scripts/lib/surge-lab-report.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastTradingDay, taipeiMinute, parseCsv, typedTable, rowsPayload, cvRowsDocId, assertDocSizes, ablationRows, robustFor,
  extractAnalysis, planCvTask, buildCvDoc, buildMirrorDoc, buildPipelineDoc, datasetUnit, parseRowsQuery, resolveRowsDoc, queryRows,
  CV_VERSIONS, MAX_DOC_BYTES, ALERTS_MAX, LU_MISS_RANK_MAX,
} from './surge-lab-report.mjs';

const PRE = CV_VERSIONS.find(v => v.id === 'pre_fix');
const CUR = CV_VERSIONS.find(v => v.id === 'current');
const SHA = 'f'.repeat(64);
const HEAD = 'date,code,name,market,score,rank,n_day,result,pct_atr14,"有值:外資持股(MI_QFIIS,僅上市)"';
const csv = (rows, head = HEAD) => [head, ...rows].join('\n') + '\n';
const hitRow = (d, code, rank, mkt = 'tse') => `${d},${code},股${code},${mkt},1.5,${rank},800,命中,0.9,1`;
const missRow = (d, code, rank, mkt = 'otc') => `${d},${code},股${code},${mkt},0.2,${rank},800,漏網,,0`;
const OUT_HEAD = 'date,event_day,code,name,market,reason';
const outside = csv(['2025-01-02,2025-01-03,8045,達運,tse,上市未滿125日', '2025-01-03,2025-01-06,6144,得利,,其他'], OUT_HEAD);
const model = (prec, hits, misses, extra = {}) => ({ auc: 0.81, prec, lift: 8, hits, picks: 40, nfeat: 117, seeds: 3, hitmiss: { K: 10, n_hit: hits, n_miss: misses, feature_pct_mean: { atr14: [0.9, 0.7] }, source_has_value_rate: { 法人: [1, 0.99] }, miss_rank_bins: { '(10, 30]': 1 }, by_market: { tse: [1, 1] }, _legend: '[命中, 漏網]' }, ...extra });
const cvJson = (bp = 0.05, op = 0.075) => JSON.stringify({
  base: model(bp, 2, 1), official: model(op, 3, 1, { vs_base: { dprec: [-0.01, 0.04], dauc: [0.001, 0.003] } }),
  '+micro': { auc: 0.8, prec: 0.03, lift: 8, hits: 1, picks: 40, nfeat: 120, seeds: 1, vs_base: { dprec: [0, 0.01], dauc: [-0.1, 0.1] } },
  _meta: { task: 't1L', K: 10, test_rows: 100, positives: 3, days: 4, base_rate: 0.01, protocol: 'p', groups: { micro: ['o_avglot'] } },
});
const files = (over = {}) => ({
  base: { hits: csv([hitRow('2025-01-02', '1111', 3), hitRow('2025-01-03', '2222', 1)]), misses: csv([missRow('2025-01-02', '3333', 15)]), outside },
  official: { hits: csv([hitRow('2025-01-02', '1111', 2), hitRow('2025-01-03', '2222', 1), hitRow('2025-01-06', '4444', 9, 'otc')]), misses: csv([missRow('2025-01-02', '3333', 12)]), outside },
  ...over,
});
const robustText = (b = 5, o = 7.5) => JSON.stringify({ t1L: { task: 't1L', overall: { base: b, official: o }, by_half: { '2025H1': { days: 2, base: 5, official: 7.5, diff_ci: [-1, 3] } }, base: { prec: b }, official: { prec: o }, universe: { o_c1_mean: 0.1 } } });
const ANALYSIS = ['# 標題', '> **沒有證明的事**：未重訓', '', '## 0. 重點摘要', '摘要列', '## 1. 換手', '換手細節', '## 6. 漏網原因假設', '| # | 假設 |', '|---|---|', '| H1 | 訊息 |', '## 9. 重現', '腳本'].join('\n');
const input = (def, over = {}) => ({ def, cvText: cvJson(), sha: 'ab'.repeat(32), mtime: '2026-10-04T11:06:23.000Z', robustText: robustText(), analysis: { file: 'official_cv_hitmiss_analysis_2026-10-04.md', text: ANALYSIS, sha: 'cd'.repeat(32) }, csv: files(), ...over });

test('最後交易日由資料決定：週日發佈仍記 10-02；休市（empty）不算交易日；沒有資料回 null', () => {
  const r = lastTradingDay({ panelDates: ['2026-09-30', '2026-10-01', '2026-10-02'], miIndexRows: { '2026-10-01': { status: 'ok' }, '2026-10-02': { status: 'ok' }, '2026-10-03': { status: 'empty' }, 'junk': { status: 'ok' } } });
  assert.deepEqual(r, { date: '2026-10-02', panelLast: '2026-10-02', mirrorLast: '2026-10-02' });
  assert.equal(lastTradingDay({ panelDates: ['2026-10-01'], miIndexRows: { '2026-10-02': { status: 'ok' } } }).date, '2026-10-02');   // 鏡像比面板新
  assert.equal(lastTradingDay({ panelDates: ['2026-10-02'], miIndexRows: {} }).date, '2026-10-02');
  assert.equal(lastTradingDay({}).date, null);
  assert.equal(lastTradingDay({ panelDates: ['not-a-day'], miIndexRows: { '2026-10-05': { status: 'bad' } } }).date, null);
});

test('taipeiMinute：UTC → 台北分鐘；無效回 null', () => {
  assert.equal(taipeiMinute('2026-10-04T11:06:23.000Z'), '2026-10-04 19:06');
  assert.equal(taipeiMinute('2026-10-04T17:30:00Z'), '2026-10-05 01:30');
  assert.equal(taipeiMinute('x'), null);
});

test('parseCsv：引號欄含逗號、"" 跳脫、CRLF、BOM；欄數不齊丟錯', () => {
  const t = parseCsv('﻿a,"b,c",d\r\n1,"x ""y""",\r\n');
  assert.deepEqual(t, { cols: ['a', 'b,c', 'd'], rows: [['1', 'x "y"', '']] });
  assert.throws(() => parseCsv('a,b\n1\n'), /欄數/);
  assert.throws(() => parseCsv(''), /表頭/);
});

test('typedTable：文字欄保留、數值欄轉數字、空字串＝null、非數字丟錯；不改動輸入', () => {
  const src = parseCsv(csv([missRow('2025-01-02', '0050', 15)]));
  const before = JSON.stringify(src);
  const t = typedTable(src);
  assert.deepEqual(t.rows[0], ['2025-01-02', '0050', '股0050', 'otc', 0.2, 15, 800, '漏網', null, 0]);
  assert.equal(JSON.stringify(src), before);
  assert.throws(() => typedTable({ cols: ['rank'], rows: [['abc']] }), /不是數字/);
});

test('rowsPayload：lu1L 漏網只留名次 ≤100，其他原樣', () => {
  const t = parseCsv(csv([missRow('2025-01-02', '1111', 5), missRow('2025-01-02', '2222', LU_MISS_RANK_MAX), missRow('2025-01-02', '3333', LU_MISS_RANK_MAX + 1), missRow('2025-01-02', '4444', 999)]));
  const p = rowsPayload('lu1L', 'misses', t);
  assert.deepEqual(p.rows.map(r => r[1]), ['1111', '2222']);
  assert.equal(p.totalRows, 4); assert.equal(p.keptRows, 2); assert.match(p.filterNote, /≤100/);
  const q = rowsPayload('t1L', 'misses', t);
  assert.equal(q.keptRows, 4); assert.equal(q.filterNote, null);
  assert.equal(rowsPayload('lu1L', 'hits', t).keptRows, 4);
});

test('文件 id 與大小上限：無效組合丟錯；任何一份 ≥ 上限整批中止', () => {
  assert.equal(cvRowsDocId('t1L', 'pre_fix', 'all', 'outside'), 'lab-cvrows-t1L-pre_fix-all-outside');
  assert.throws(() => cvRowsDocId('t9', 'pre_fix', 'base', 'hits'));
  assert.deepEqual(assertDocSizes([['a', 10], ['b', 20]]), ['b', 20]);
  assert.throws(() => assertDocSizes([['a', 10], ['big', MAX_DOC_BYTES]]), /big/);
  assert.throws(() => assertDocSizes([['nan', NaN]]), /nan/);
});

test('消融列：seeds=1 標參考；不含 base／official／_meta', () => {
  const rows = ablationRows(JSON.parse(cvJson()));
  assert.deepEqual(rows.map(r => r.key), ['+micro']);
  assert.equal(rows[0].referenceOnly, true);
  assert.deepEqual(rows[0].vs_base, { dprec: [0, 0.01], dauc: [-0.1, 0.1] });
});

test('穩健度只在 overall 與本版 CV 精確度相符時採用', () => {
  const cv = JSON.parse(cvJson());
  assert.ok(robustFor(JSON.parse(robustText()), 't1L', cv).robust);
  const bad = robustFor(JSON.parse(robustText(2.82, 3.06)), 't1L', cv);
  assert.equal(bad.robust, null); assert.match(bad.note, /不一致/);
  assert.match(robustFor({}, 't1L', cv).note, /沒有/);
});

test('extractAnalysis：前言＋指定節；過長在行邊界截斷並註明', () => {
  const a = extractAnalysis(ANALYSIS);
  assert.match(a.markdown, /沒有證明的事/); assert.match(a.markdown, /重點摘要/); assert.match(a.markdown, /H1/);
  assert.doesNotMatch(a.markdown, /換手細節/); assert.doesNotMatch(a.markdown, /腳本/);
  assert.equal(a.truncated, false);
  const long = extractAnalysis(['## 0. 摘要', ...Array.from({ length: 50 }, (_, i) => `第${i}行文字`)].join('\n'), ['0'], 60);
  assert.equal(long.truncated, true);
  assert.match(long.markdown, /已截斷/);
  assert.ok(long.markdown.split('\n').slice(0, -2).every(l => l === '## 0. 摘要' || /^第\d+行文字$/.test(l)));   // 沒有切半行
});

test('planCvTask：目前版與修正前逐位相同 ⇒ sameAs、不重複發佈逐列', () => {
  const { entry, payloads } = planCvTask('t1L', [input(PRE), input(CUR)]);
  assert.deepEqual(entry.versions.map(v => [v.id, v.sameAs]), [['pre_fix', null], ['current', 'pre_fix']]);
  assert.ok(payloads.every(p => p.version === 'pre_fix'));
  // 母體外兩模型相同 ⇒ 一份 model=all
  assert.deepEqual(payloads.map(p => p.id).sort(), ['lab-cvrows-t1L-pre_fix-all-outside', 'lab-cvrows-t1L-pre_fix-base-hits', 'lab-cvrows-t1L-pre_fix-base-misses', 'lab-cvrows-t1L-pre_fix-official-hits', 'lab-cvrows-t1L-pre_fix-official-misses']);
  const v = entry.versions[0];
  assert.match(v.versionLabel, /^修正前｜2026-10-04 快照｜abababab$/);
  assert.equal(v.robustNote, null); assert.ok(v.robust); assert.ok(v.analysis.markdown.includes('H1'));
  assert.equal(v.ablation[0].referenceOnly, true);
  assert.deepEqual(v.official.vs_base.dprec, [-0.01, 0.04]);
});

test('planCvTask：修正後不同 ⇒ 兩版各自發佈；舊分析文件與舊穩健度不掛到修正後', () => {
  const cur = input(CUR, { cvText: cvJson(0.06, 0.08), sha: '12'.repeat(32), robustText: robustText() });   // 穩健度仍是修正前的數字
  const { entry, payloads } = planCvTask('t1L', [input(PRE), cur]);
  const c = entry.versions.find(v => v.id === 'current');
  assert.equal(c.sameAs, null);
  assert.match(c.versionLabel, /^修正後｜2026-10-04 19:06｜12121212$/);
  assert.equal(c.analysis, null);                       // 分析文件與修正前相同 ⇒ 屬於修正前
  assert.equal(c.robust, null); assert.match(c.robustNote, /不一致/);
  assert.ok(payloads.some(p => p.id === 'lab-cvrows-t1L-current-base-hits'));
  const noRobust = planCvTask('t1L', [input(CUR, { cvText: cvJson(0.06, 0.08), robustText: null })]).entry.versions[0];
  assert.match(noRobust.robustNote, /沒有 official_cv_robust/);
});

test('planCvTask：逐列筆數與摘要不符（重訓進行中）⇒ 該模型逐列不發佈並警示；母體外不同 ⇒ 各存一份', () => {
  const f = files();
  const bad = { ...f, official: { ...f.official, hits: csv([hitRow('2025-01-02', '1111', 2)]), outside: csv(['2025-01-02,2025-01-03,9999,X,tse,股價<10'], OUT_HEAD) } };
  const { entry, payloads } = planCvTask('t1L', [input(PRE, { csv: bad })]);
  const v = entry.versions[0];
  assert.match(v.rows.official.skipped, /命中 CSV 1 列/);
  assert.ok(v.warnings.some(w => w.startsWith('official 逐列未發佈')));
  assert.ok(!payloads.some(p => p.model === 'official' && p.kind !== 'outside'));
  assert.deepEqual(payloads.filter(p => p.kind === 'outside').map(p => p.model).sort(), ['base', 'official']);
});

test('planCvTask：缺檔（CSV／分析文件／母體外）⇒ 標「檔案不存在」或 null，不捏造', () => {
  const f = files();
  const { entry, payloads } = planCvTask('lu1L', [input(PRE, { analysis: null, csv: { base: { hits: f.base.hits, misses: null, outside: null }, official: { hits: null, misses: null, outside: null } } })]);
  const v = entry.versions[0];
  assert.equal(v.analysis, null);
  assert.deepEqual(v.rows.base.misses, { skipped: '檔案不存在' });
  assert.deepEqual(v.rows.official.hits, { skipped: '檔案不存在' });
  assert.deepEqual(v.rows.outside, {});
  assert.deepEqual(payloads.map(p => p.id), ['lab-cvrows-lu1L-pre_fix-base-hits']);
});

test('planCvTask：沒有任何版本 ⇒ 空版本＋說明；未知任務丟錯', () => {
  assert.match(planCvTask('t2L', [input(PRE, { cvText: null }), input(CUR, { cvText: null })]).entry.note, /沒有/);
  assert.throws(() => planCvTask('zz', []), /未知任務/);
});

test('buildCvDoc：dataDate 格式、逐列 id 重複／sha 無效都丟錯', () => {
  const r = { id: 'lab-cvrows-t1L-pre_fix-base-hits', sha256: SHA };
  assert.equal(buildCvDoc({ dataDate: '2026-10-02', generatedAt: 'g', tasks: [], rowsDocs: [r] }).schema, 'surgeShadow.cv.v1');
  assert.throws(() => buildCvDoc({ dataDate: '2026-10-04T00', generatedAt: 'g', tasks: [], rowsDocs: [] }), /dataDate/);
  assert.throws(() => buildCvDoc({ dataDate: '2026-10-02', generatedAt: 'g', tasks: [], rowsDocs: [r, r] }), /重複/);
  assert.throws(() => buildCvDoc({ dataDate: '2026-10-02', generatedAt: 'g', tasks: [], rowsDocs: [{ ...r, sha256: 'x' }] }), /無效/);
});

test('鏡像健康：日資料落後最後交易日標 stale；月／季不判；驗證失敗與警示（缺檔 null＋說明、超量截斷）', () => {
  const manifest = { updated: '2026-10-04T13:09:15Z', alerts: null, datasets: {
    'www.twse.com.tw/twse_mi_index': { first: '2022-07-18', last: '2026-10-02', counts: { ok: 1023 } },
    'www.tpex.org.tw/tpex_dailyquotes': { first: '2022-07-18', last: '2026-10-01', counts: { ok: 1022 } },
    'www.taifex.com.tw/taifex_large_trader': { first: '2026-10-02', last: '2026-10-02', counts: { empty: 1 } },
    'www.tpex.org.tw/tpex_oa_warrant': { first: '2026-10-02', last: '2026-10-02', counts: { empty: 1 } },   // 驗證 ok＝空表合法，不算異常
    'mopsov.twse.com.tw/mops_t21sc03': { first: '2022-06.otc', last: '2026-09.sii', counts: { ok: 103, bad: 1 } },
    'mopsov.twse.com.tw/mops_t163sb04': { first: '2021Q1.otc', last: '2026Q2.sii', counts: { ok: 44 } },
  } };
  const verify = { a: { ok: true, status: 'ok' }, b: { ok: false, status: 'empty', note: '空表', rows: 0, echo: '2026-10-02', at: 't' }, tpex_oa_warrant: { ok: true, status: 'empty' } };
  const doc = buildMirrorDoc({ manifest, verify, alerts: null, lock: null, budget: { day: '2026-10-04', requests: 214 }, lastTradingDay: '2026-10-02', dataDate: '2026-10-02', generatedAt: 'g' });
  assert.equal(doc.datasets[0].key, 'www.tpex.org.tw/tpex_dailyquotes');   // stale 排最前
  assert.deepEqual(doc.datasets.filter(d => d.stale).map(d => d.id), ['tpex_dailyquotes']);
  assert.equal(doc.datasets.find(d => d.id === 'mops_t21sc03').stale, null);
  assert.equal(doc.datasets.find(d => d.id === 'mops_t163sb04').unit, 'quarter');
  assert.deepEqual(doc.summary, { datasets: 6, daily: 4, stale: 1, withBad: 2, verifyTotal: 3, verifyOk: 2, alertsMissing: null });
  assert.equal(doc.datasets.find(d => d.id === 'tpex_oa_warrant').verified, true);
  assert.equal(doc.datasets.find(d => d.id === 'taifex_large_trader').verified, null);
  assert.deepEqual(doc.verifyFailures.map(f => f.id), ['b']);
  assert.equal(doc.alerts, null); assert.match(doc.alertsNote, /LATEST/);
  assert.equal(doc.lock, null); assert.equal(doc.budget.requests, 214);
  const many = Array.from({ length: ALERTS_MAX + 3 }, (_, i) => ({ id: 'x', key: `k${i}`, status: '未抓' }));
  const d2 = buildMirrorDoc({ manifest, verify, alerts: { rule: 'r', at: 't', missing: many }, lock: { cmd: 'backfill', pid: 1, at: 't', alive: false }, lastTradingDay: '2026-10-02', dataDate: '2026-10-02', generatedAt: 'g' });
  assert.equal(d2.alerts.missing.length, ALERTS_MAX); assert.equal(d2.alerts.missingTotal, ALERTS_MAX + 3); assert.equal(d2.alerts.truncated, true);
  assert.equal(d2.summary.alertsMissing, ALERTS_MAX + 3); assert.equal(d2.lock.alive, false);
  const none = buildMirrorDoc({ manifest: null, verify: null, alerts: null, lock: null, lastTradingDay: null, dataDate: '2026-10-02', generatedAt: 'g' });
  assert.equal(none.present, false); assert.equal(none.datasets.length, 0);
  assert.equal(datasetUnit('2026-09'), 'month'); assert.equal(datasetUnit('abc'), 'other');
});

test('管線狀態：沒有檔案 ⇒ null＋說明（不捏造）；不是物件丟錯；有檔原樣帶上', () => {
  const none = buildPipelineDoc({ status: null, dataDate: '2026-10-02', generatedAt: 'g' });
  assert.equal(none.present, false); assert.equal(none.status, null); assert.match(none.note, /a35_shadow_daily_status/);
  const s = { ok: true, step: 'publish', day: '2026-10-02' };
  assert.deepEqual(buildPipelineDoc({ status: s, mtime: 'm', dataDate: '2026-10-02', generatedAt: 'g' }).status, s);
  assert.throws(() => buildPipelineDoc({ status: [1], dataDate: '2026-10-02', generatedAt: 'g' }), /物件/);
  assert.throws(() => buildPipelineDoc({ status: null, dataDate: '2026-10-04 週日', generatedAt: 'g' }), /dataDate/);
});

test('parseRowsQuery：預設值、白名單、整數與日期驗證', () => {
  const ok = parseRowsQuery(new URLSearchParams('task=t1L&version=pre_fix&model=base&kind=misses'));
  assert.deepEqual(ok, { ok: true, query: { task: 't1L', version: 'pre_fix', model: 'base', kind: 'misses', market: 'all', sort: 'date', rankMin: null, rankMax: null, page: 1, from: null, to: null, q: '' } });
  for (const bad of ['task=t9&version=pre_fix&model=base&kind=hits', 'task=t1L&version=pre_fix&model=all&kind=hits', 'task=t1L&version=pre_fix&model=base&kind=hits&market=xx',
    'task=t1L&version=pre_fix&model=base&kind=hits&rankMin=-1', 'task=t1L&version=pre_fix&model=base&kind=hits&page=0', 'task=t1L&version=pre_fix&model=base&kind=hits&from=2025/01/01',
    `task=t1L&version=pre_fix&model=base&kind=hits&q=${'x'.repeat(21)}`]) assert.equal(parseRowsQuery(new URLSearchParams(bad)).ok, false, bad);
});

test('resolveRowsDoc：母體外 model=all 也能對到；找不到回 null', () => {
  const cv = { rowsDocs: [{ id: 'lab-cvrows-t1L-pre_fix-all-outside', task: 't1L', version: 'pre_fix', model: 'all', kind: 'outside' }, { id: 'lab-cvrows-t1L-pre_fix-base-hits', task: 't1L', version: 'pre_fix', model: 'base', kind: 'hits' }] };
  assert.equal(resolveRowsDoc(cv, { task: 't1L', version: 'pre_fix', model: 'official', kind: 'outside' }).id, 'lab-cvrows-t1L-pre_fix-all-outside');
  assert.equal(resolveRowsDoc(cv, { task: 't1L', version: 'pre_fix', model: 'base', kind: 'hits' }).id, 'lab-cvrows-t1L-pre_fix-base-hits');
  assert.equal(resolveRowsDoc(cv, { task: 't1L', version: 'current', model: 'base', kind: 'hits' }), null);
});

test('queryRows：市場／名次／日期／代號名稱篩選、排序、分頁；不改動輸入；母體外名次條件不適用', () => {
  const table = typedTable(parseCsv(csv([missRow('2025-01-02', '1111', 50, 'tse'), missRow('2025-01-03', '2222', 12, 'otc'), missRow('2025-01-03', '3333', 11, 'tse'), missRow('2025-02-01', '4444', 300, 'otc')])));
  const before = JSON.stringify(table);
  const base = { market: 'all', sort: 'date', rankMin: null, rankMax: null, page: 1, from: null, to: null, q: '' };
  assert.deepEqual(queryRows(table, base).rows.map(r => r[1]), ['4444', '3333', '2222', '1111']);   // 日期新→舊、同日名次小→大
  assert.deepEqual(queryRows(table, { ...base, sort: 'rank' }).rows.map(r => r[1]), ['3333', '2222', '1111', '4444']);
  assert.deepEqual(queryRows(table, { ...base, market: 'otc', rankMax: 100 }).rows.map(r => r[1]), ['2222']);
  assert.deepEqual(queryRows(table, { ...base, from: '2025-01-03', to: '2025-01-31' }).rows.map(r => r[1]), ['3333', '2222']);
  assert.deepEqual(queryRows(table, { ...base, q: '股11' }).rows.map(r => r[1]), ['1111']);
  const p2 = queryRows(table, { ...base, page: 9 }, 3);
  assert.deepEqual([p2.page, p2.pages, p2.total, p2.rows.length], [2, 2, 4, 1]);   // 超出頁數夾回最後一頁
  assert.equal(JSON.stringify(table), before);
  const out = typedTable(parseCsv(outside));
  const r = queryRows(out, { ...base, rankMax: 10 });
  assert.equal(r.rankIgnored, true); assert.equal(r.total, 2);
});
