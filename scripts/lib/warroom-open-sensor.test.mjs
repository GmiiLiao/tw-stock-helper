// 開盤感應器（影子）讀取端正規化＋畫面文字 單元測試：node --test scripts/lib/warroom-open-sensor.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeOpenSensor, normalizeCheck, currentCheck, normalizeOpenSensorPayload, summarizeOsUniverse,
  normalizeOsThreshold, normalizeOsOutsideStats, shouldPollOpenSensorAt, msUntilOpenSensorWindow, resolveBoardYmd, OS_BADGE,
} from './warroom-open-sensor.mjs';
import {
  osStateText, osCandidatesText, openSensorView, osFactsLine, osVolLine, osVolRealLine, osOpenLine, osPatternLine,
  osTrailLine, osUndeterminedLine, osOutsideMonthRows, osWan, osPct,
} from './warroom-open-sensor-view.mjs';

// 2026-10-08（週四）台北 hh:mm:ss → epoch ms
const T = (h, m, s = 0, day = 8) => Date.UTC(2026, 9, day, h - 8, m, s);

/** 10/05 型：⑥量大權值漲（數字取規格 §9.2 範例的量級；樣本內·代理） */
function check0902(over = {}) {
  return {
    status: 'ok', reasons: [], late: false, slid: false, T: '09:02:00', revealAt: T(9, 2, 0), revealP10: T(9, 1, 31), revealP90: T(9, 1, 58),
    writtenAt: T(9, 2, 41),
    state: { key: 'wUpHeavy', label: '⑥ 量大權值漲', num: 6, named: true, cell: { vol: 'big', dom: 'w', dir: 'up' }, outsideReason: null, sub: null, lamp: 'red', candidates: [] },
    w: { pct: 2.6, tsmcPct: 2.6, restPct: 2.5, restUp: 25, restDown: 3, restFlat: 1, restFresh: 29, dir: 'up', fresh: 30, capCovPct: 100 },
    g: { median: 0.4, upRatio: 0.67, up: 300, down: 148, flat: 64, fresh: 512, n: 603, dir: 'up' },
    s: 2.2, dom: { rule: 'R5', ratio: 0.15 },
    vol: {
      q: { lots: 676_000, revealAt: T(9, 2, 0) }, qAucLots: 128_258,
      px: { bar: 152.3, win: 30, n: 1320, volLots: 360_000, hasTsmc: true, w30n: 30 },
      rho: { v: 0.53, src: 'prior', n: 0 },
      vHatYi: 1012.4, c: 0.0726, cN: 20, estYi: 13945, estE2Yi: 12800, H: 8500, segThYi: 617.1,
      label: 'big', est: true, reason: null, gapDay: true, vSum: { yi: 590.2, n: 1320 },
    },
    value: { wYi: 610, gYi: 400, wSharePct: 60.4, wShareBasePct: 55.1 },
    idx: { tse: { e: 23950.5, pct: 2.18, revealAt: T(9, 2, 0) }, otc: { e: 260.1, pct: 1.1, revealAt: T(9, 2, 0) }, officialOpen: 23480, officialOpenPct: 0.2, oStarPct: 1.78, distortPp: 1.58, distorted: true },
    ticksJson: '[[1,2,3]]',
    ...over,
  };
}

function rawDoc() {
  return {
    date: '2026-10-08', basis: 'openSensor-v2.1', mode: 'shadow', dateSrc: 't00', writtenAt: { _seconds: Math.floor(T(9, 2, 41) / 1000), _nanoseconds: 0 },
    params: { H: 8500, hSeg: [8250, 9250], hBasis: 'H-SEG60-v1', struct: 'struct-v2.1', vol: 'volRatio-v1', cBase: { n: 18, from: '2026-09-09', to: '2026-10-07', missing: ['2026-10-06', '2026-10-07'] }, rho0: 0.53 },
    universe: { sharesAsOf: '2026-10-02', sharesSrc: 'mirror', prevYmd: '2026-10-07', w30CapPct: 71.2, tsmcCapPct: 38.5, tsmcInW30Pct: 54.1, liquidN: 603, liquidMinLots: 300 },
    c0902: check0902(),
    rechecks: {
      r0910: check0902({ T: '09:10:00', revealAt: T(9, 10) }),
      r0920: { status: 'nodata', reasons: ['restart'] },
    },
    checks: {
      e: { tse: { v: 23950.5, pct: 2.18, revealAt: T(9, 2, 0) }, otc: { v: 260.1, pct: 1.1, revealAt: T(9, 2) }, gen: 0.58, officialOpen: 23480, officialOpenPct: 0.2, oStarPct: 1.78, distortPp: 1.58, distorted: true, basis: 'effOpen0902-v2.1' },
      c0920: { T: '09:20:00', writtenAt: T(9, 20, 40), lines: { tse: { status: 'ok', key: 'upHold', label: '大幅開高·持穩', gp: 2.3 }, otc: { status: 'ok', key: 'upHold', gp: 0.9 }, gen: { status: 'ok', key: 'fadeDown', gp: 0.58 } }, qualifier: '權值撐盤', basis: 'pattern3-v2.1' },
    },
    eCorr: { unopened: { n: 3, capPct: 0.8, w30: ['2454'] }, unknown: { n: 12, capPct: 0.1 }, eFinal: false, tse: [{ T: '09:10:00', pct: 2.31, addPp: 0.13, nOpened: 3 }], gen: [], otc: { status: 'ok' } },
    cur: { key: 'wUpHeavy', label: '⑥ 量大權值漲', T: '09:02:00', revealAt: T(9, 2), final: false, eTsePct: 2.31, eGenPct: 0.6 },
    trail: [{ T: '09:02:00', kind: 'state', key: 'wUpHeavy', label: '⑥ 量大權值漲', revealAt: T(9, 2) }, { T: '09:10:00', kind: 'eCorr', key: null, label: null }],
    outside: { cells: [], firstAt: null },
  };
}

test('openSensor 文件：照欄位轉出、時間轉 epoch ms、ticksJson 不帶；缺欄位回 null 不補 0', () => {
  const d = normalizeOpenSensor(rawDoc());
  assert.equal(d.date, '2026-10-08');
  assert.equal(d.writtenAt, Math.floor(T(9, 2, 41) / 1000) * 1000);   // Firestore Timestamp 形狀
  assert.equal(d.c0902.state.key, 'wUpHeavy');
  assert.equal(d.c0902.vol.q.lots, 676_000);
  assert.equal(d.c0902.vol.px.win, 30);
  assert.equal('ticksJson' in d.c0902, false);
  assert.equal(d.rechecks.r0920.status, 'nodata');
  assert.equal(d.rechecks.r0930, null);
  assert.deepEqual(d.params.cBase.missing, ['2026-10-06', '2026-10-07']);
  assert.equal(d.checks.c0930, null);
  assert.equal(d.post, null);
  // 缺欄位：不補預設值
  const bare = normalizeOpenSensor({ date: '2026-10-08' });
  assert.equal(bare.c0902, null);
  assert.equal(bare.cur, null);
  assert.deepEqual(bare.trail, []);
  assert.equal(bare.params, null);
  // 沒有合法 date、不是物件 ⇒ null
  assert.equal(normalizeOpenSensor({ date: '20261008' }), null);
  assert.equal(normalizeOpenSensor(null), null);
  // 狀態不認得的快照 ⇒ null；窗只收 30／60／120
  assert.equal(normalizeCheck({ status: 'weird' }), null);
  assert.equal(normalizeCheck(check0902({ vol: { px: { win: 45 } } })).vol.px.win, null);
});

test('正規化可重跑：伺服器正規化過的結果再過一次不變（前端當形狀檢查）', () => {
  const once = normalizeOpenSensor(rawDoc());
  const twice = normalizeOpenSensor(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

test('目前檢查點＝最後一個不是 nodata 的快照', () => {
  const d = normalizeOpenSensor(rawDoc());
  const cur = currentCheck(d);
  assert.equal(cur.key, 'r0910');
  assert.equal(currentCheck(normalizeOpenSensor({ date: '2026-10-08' })), null);
});

test('狀態文字：七種用使用者原名、①–⑥ 標量為估計、⑦ 中性燈；不在狀態內三種原因', () => {
  assert.deepEqual(
    (({ title, lamp, short }) => ({ title, lamp, short }))(osStateText({ key: 'wUpHeavy' })),
    { title: '⑥ 量大權值漲（量為估計）', lamp: 'red', short: '⑥量大權值漲' },
  );
  assert.equal(osStateText({ key: 'allDownLight' }).lamp, 'green');
  assert.equal(osStateText({ key: 'noDirection' }).title, '⑦ 無方向');
  assert.equal(osStateText({ key: 'noDirection' }).lamp, 'neutral');
  assert.equal(osStateText({ key: 'outside', outsideReason: 'wUnstated' }).title, '不在狀態內（權值未表態）');
  assert.equal(osStateText({ key: 'outside', outsideReason: 'wUnconfirmed', sub: 'tsmcSolo' }).title, '不在狀態內（權值未確認·台積電獨撐）');
  assert.equal(osStateText({ key: 'outside', outsideReason: 'cell', cell: { vol: 'big', dom: 'all', dir: 'down' } }).title, '不在狀態內（量大·全面·跌）');
  // 軌跡、cur 只有 key：outside:{reason|cell}
  assert.equal(osStateText({ key: 'outside:big|all|down' }).short, '不在狀態內（量大·全面·跌）');
  assert.equal(osStateText({ key: 'outside:wUnconfirmed:tsmcWeak' }).short, '不在狀態內（權值未確認·台積電獨弱）');
  assert.equal(osStateText({ key: 'outside:wUnstated' }).lamp, 'gray');
  assert.equal(osStateText({ key: 'volPending' }).title, '量能未定');
  assert.equal(osStateText({ key: 'undetermined' }).title, '未判定');
});

test('量未定的候選依對照表（§3.6）', () => {
  assert.equal(osCandidatesText({ vol: 'pending', dom: 'w', dir: 'up' }), '若量大＝⑥量大權值漲；若量縮＝③量縮權值漲');
  assert.equal(osCandidatesText({ vol: 'pending', dom: 'all', dir: 'up' }), '若量大＝①全面量大上漲；若量縮＝不在狀態內');
  assert.equal(osCandidatesText({ vol: 'pending', dom: 'all', dir: 'down' }), '若量大＝不在狀態內；若量縮＝②全面量縮下跌');
  assert.equal(osCandidatesText(null), null);
});

test('單位：值寫億元並標（估）、量寫萬張（張÷10,000），兩者分列', () => {
  const c = normalizeCheck(check0902());
  assert.equal(osWan(676_000), '67.6');
  assert.equal(osWan(14_331_403), '1,433.1');
  const vol = osVolLine(c);
  assert.match(vol, /^量大（估）｜上市成交金額（估）09:02 累計約 1,012 億｜全日（估）13,945 億 ≥ 門檻 8,500 億（同時段 617 億）｜大跳空日$/);
  assert.equal(osVolRealLine(c), '上市成交量（實）09:02 累計 67.6 萬張｜開盤競價 12.8 萬張');
  assert.doesNotMatch(osVolRealLine(c), /億/);
  assert.equal(osFactsLine(c), '權值30 +2.60%（台積電 +2.60%·其餘29檔 25漲3跌）｜上市一般股中位 +0.40%·上漲 67%（已成交 512/603）');
  // 量縮：<
  const small = normalizeCheck(check0902({ vol: { ...check0902().vol, label: 'small', estYi: 8100, gapDay: false } }));
  assert.match(osVolLine(small), /^量縮（估）｜.*全日（估）8,100 億 < 門檻 8,500 億/);
  // 量未定寫原因
  const pend = normalizeCheck(check0902({ vol: { label: 'pending', reason: 'cBase', H: 8500 } }));
  assert.equal(osVolLine(pend), '量能未定（時間累計基準不足 5 日）｜門檻 8,500 億');
});

test('有效開盤、修正時間、官方開盤失真；盤型 09:20 三條線', () => {
  const d = normalizeOpenSensor(rawDoc());
  assert.equal(osOpenLine(d), '有效開盤 加權 +2.18%（09:02）→ 修正 +2.31%（09:10，09:02 後開出 3 檔）｜官方開盤 +0.20%（失真；個股開盤合成 +1.78%）');
  assert.equal(osPatternLine(d), '盤型 09:20｜加權 大幅開高·持穩｜櫃買 開高持穩｜一般股中位 開高走低｜權值撐盤');
  // 沒有修正、沒有失真
  const plain = normalizeOpenSensor({ ...rawDoc(), eCorr: null, checks: { e: { tse: { pct: -0.4 }, officialOpenPct: -0.35, distorted: false } } });
  assert.equal(osOpenLine(plain), '有效開盤 加權 −0.40%（09:02）｜官方開盤 −0.35%');
  assert.equal(osPatternLine(plain), null);
});

test('軌跡：09:10 起才出現；狀態有變才列、無資料的檢查點另列、10:00 定格', () => {
  const only0902 = normalizeOpenSensor({ ...rawDoc(), rechecks: {} });
  assert.equal(osTrailLine(only0902), null);
  const d = normalizeOpenSensor(rawDoc());
  assert.equal(osTrailLine(d), '09:02 ⑥量大權值漲｜無資料 09:20');
  const changed = normalizeOpenSensor({
    ...rawDoc(),
    rechecks: { r0910: check0902({ T: '09:10:00' }), r0940: check0902({ T: '09:40:00' }), r1000: check0902({ T: '10:00:00' }) },
    trail: [
      { T: '09:02:00', kind: 'state', key: 'wUpHeavy' },
      { T: '09:40:00', kind: 'state', key: 'wUpLight' },
    ],
    cur: { key: 'wUpLight', T: '09:40:00', final: true, frozenAt: T(10, 0, 41) },
  });
  assert.equal(osTrailLine(changed), '09:02 ⑥量大權值漲 → 09:40 ③量縮權值漲 → 10:00 定格');
  const timeout = normalizeOpenSensor({ ...rawDoc(), cur: { key: 'wUpHeavy', final: true, finalBy: 'timeout' } });
  assert.match(osTrailLine(timeout), /10:05 逾時定格/);
});

test('未判定：只寫原因與涵蓋數字（daemon 原因字串已含涵蓋數字，去掉 G# 代碼）；沒有原因才自己列涵蓋', () => {
  const c = normalizeCheck({
    status: 'undetermined', T: '09:02:00', reasons: ['G1:權值已成交 26/30·市值覆蓋 93.1%·台積電有（門檻 27/30·95%·需台積電）', 'G2:上市一般股已成交 301/603（門檻 362）'],
    w: { fresh: 26 }, g: { fresh: 301, n: 603 },
  });
  assert.equal(osUndeterminedLine(c), '09:02 資料不足，未判定｜權值已成交 26/30·市值覆蓋 93.1%·台積電有（門檻 27/30·95%·需台積電）；上市一般股已成交 301/603（門檻 362）');
  const bare = normalizeCheck({ status: 'undetermined', T: '09:02:00', reasons: [], w: { fresh: 26 }, g: { fresh: 301, n: 603, revealMed: T(9, 1, 12) } });
  assert.equal(osUndeterminedLine(bare), '09:02 資料不足，未判定｜權值已成交 26/30；上市一般股已成交 301/603（門檻 362）；揭示中位 09:01:12');
  assert.equal(osUndeterminedLine(normalizeCheck({ status: 'undetermined', T: '09:02:00', reasons: ['G10'] })), '09:02 資料不足，未判定｜發行股數缺或過舊');
});

test('量未定原因：daemon 以逗號串多個代碼', () => {
  const pend = normalizeCheck(check0902({ vol: { label: 'pending', reason: 'cBase,q', H: 8500 } }));
  assert.equal(osVolLine(pend), '量能未定（時間累計基準不足 5 日、上市累積成交量缺拍）｜門檻 8,500 億');
});

function payload(over = {}) {
  return { at: T(9, 3), date: '2026-10-08', today: '2026-10-08', tradingToday: true, doc: null, universe: null, threshold: null, outsideStats: null, failed: [], ...over };
}

test('區塊模型：讀取中／09:02 起首判／過 09:05 仍無文件／前交易日', () => {
  assert.equal(openSensorView(null, T(9, 0)).phase, 'loading');
  const wait = openSensorView(normalizeOpenSensorPayload(payload({ threshold: { H: 8500, m60: 8762, asOf: '2026-10-07' } })), T(8, 50));
  assert.equal(wait.phase, 'wait');
  assert.equal(wait.title, '09:02 起首判');
  assert.equal(wait.note, '門檻 H 8,500 億（近 60 日上市成交金額中位 8,762 億·至 10/07）');
  assert.equal(wait.badge, OS_BADGE);
  const late = openSensorView(normalizeOpenSensorPayload(payload()), T(9, 6));
  assert.equal(late.phase, 'missing');
  assert.equal(late.title, '今日尚無紀錄');
  // 週六看週五的文件：標前交易日
  const sat = normalizeOpenSensorPayload(payload({ date: '2026-10-09', today: '2026-10-10', tradingToday: false, doc: { ...rawDoc(), date: '2026-10-09' } }));
  const v = openSensorView(sat, T(11, 0, 0, 10));
  assert.equal(v.phase, 'ok');
  assert.equal(v.prevLabel, '◆ 前交易日 10/09');
});

test('區塊模型：有文件時第一行狀態、事實、量、開盤、盤型；不在狀態內第二行加「事實：」；量未定寫候選', () => {
  const v = openSensorView(normalizeOpenSensorPayload(payload({ doc: rawDoc() })), T(9, 21));
  assert.equal(v.phase, 'ok');
  assert.equal(v.title, '⑥ 量大權值漲（量為估計）');
  assert.equal(v.lamp, 'red');
  assert.equal(v.dataT, '09:10:00');
  assert.equal(v.checkKey, 'r0910');
  assert.match(v.facts, /^權值30 /);
  assert.match(v.volReal, /萬張/);
  assert.match(v.open, /^有效開盤/);
  assert.match(v.pattern, /^盤型 09:20/);

  const out = rawDoc();
  out.c0902 = check0902({ state: { key: 'outside', outsideReason: 'cell', cell: { vol: 'big', dom: 'all', dir: 'down' } }, w: { pct: -1.2, tsmcPct: -1.3, restUp: 3, restDown: 24 }, g: { median: -1.1, up: 26, down: 74, fresh: 500, n: 603 } });
  out.rechecks = {};
  const vo = openSensorView(normalizeOpenSensorPayload(payload({ doc: out })), T(9, 4));
  assert.equal(vo.title, '不在狀態內（量大·全面·跌）');
  assert.equal(vo.lamp, 'gray');
  assert.equal(vo.facts, '事實：量大（估）·全面·跌｜權值30 −1.20%（台積電 −1.30%·其餘29檔 3漲24跌）｜上市一般股中位 −1.10%·上漲 26%（已成交 500/603）');

  const pend = rawDoc();
  pend.c0902 = check0902({ state: { key: 'volPending', cell: { vol: 'pending', dom: 'w', dir: 'up' } }, vol: { label: 'pending', reason: 'pxSample', H: 8500, q: { lots: 600_000 } } });
  pend.rechecks = {};
  const vp = openSensorView(normalizeOpenSensorPayload(payload({ doc: pend })), T(9, 4));
  assert.equal(vp.title, '量能未定');
  assert.equal(vp.note, '若量大＝⑥量大權值漲；若量縮＝③量縮權值漲');

  const und = rawDoc();
  und.c0902 = { status: 'undetermined', T: '09:02:00', reasons: ['G1'], w: { fresh: 22 } };
  und.rechecks = {};
  const vu = openSensorView(normalizeOpenSensorPayload(payload({ doc: und })), T(9, 5, 30));
  assert.equal(vu.title, '未判定');
  assert.equal(vu.facts, null);
  assert.equal(vu.note, '09:02 資料不足，未判定｜權值 30 夠新不足');
});

test('路由回應：形狀不對回 null；文件日期與看板日期不同視為沒有文件；名單摘要不帶 codesJson', () => {
  assert.equal(normalizeOpenSensorPayload({ date: '2026-10-08' }), null);
  assert.equal(normalizeOpenSensorPayload(payload({ today: 'x' })), null);
  const p = normalizeOpenSensorPayload(payload({ doc: { ...rawDoc(), date: '2026-10-07' } }));
  assert.equal(p.doc, null);
  const u = summarizeOsUniverse({
    date: '2026-10-08', basis: 'openSensorUniverse-v1', createdAt: T(9, 2, 42), sharesAsOf: '2026-10-02', sharesSrc: 'mirror', prevYmd: '2026-10-07',
    w30: [{ code: '2330', capYi: 380000, wPct: 38.5 }, { code: 'bad' }], tsmcCapPct: 38.5, w30CapPct: 71.2,
    liquid: { n: 603, minLots: 300, codesJson: '[["1101",3000]]' }, excluded: { etf: ['0050'], tdr: 3 },
  });
  assert.equal('codesJson' in u, false);
  assert.deepEqual(u.w30, [{ code: '2330', capYi: 380000, wPct: 38.5 }]);
  assert.equal(u.liquidN, 603);
  assert.deepEqual(u.excluded, { etf: 1, tdr: 3, fullDelivery: null, split: null });
});

test('路由回應整份可重跑：伺服器組好的回應經 JSON 往返再正規化不變（名單摘要、計次陣列不丟欄位）', () => {
  const server = {
    ...payload({ doc: normalizeOpenSensor(rawDoc()) }),
    universe: summarizeOsUniverse({ date: '2026-10-08', liquid: { n: 603, minLots: 300 }, excluded: { etf: ['0050', '0056'] }, w30: [{ code: '2330', wPct: 38.5 }] }),
    threshold: normalizeOsThreshold({ H: 8500, seg: [8250, 9250], m60: 8762, asOf: '2026-10-07' }),
    outsideStats: normalizeOsOutsideStats({ cells: { wUnstated: { n: 2, dates: ['2026-10-02', '2026-10-07'] } }, pending: { n: 0, dates: [] } }),
  };
  const client = normalizeOpenSensorPayload(JSON.parse(JSON.stringify(server)));
  assert.deepEqual(client, normalizeOpenSensorPayload(server));
  assert.equal(client.universe.liquidN, 603);
  assert.equal(client.universe.excluded.etf, 2);
  assert.deepEqual(client.outsideStats.cells, [{ key: 'wUnstated', n: 2, dates: ['2026-10-02', '2026-10-07'] }]);
  assert.equal(client.doc.c0902.state.key, 'wUpHeavy');
});

test('門檻與不在狀態內統計：本月次數只算本月日期；最近 10 筆全在本月標「至少」', () => {
  const th = normalizeOsThreshold({ basis: 'H-SEG60-v1', H: 8500, seg: [8250, 9250], m60: 8762, n: 60, streak: { seg: null, n: 0, dates: [] }, asOf: '2026-10-07', history: [{}] });
  assert.equal(th.H, 8500);
  assert.deepEqual(th.seg, [8250, 9250]);
  assert.equal('history' in th, false);
  const st = normalizeOsOutsideStats({
    basis: 'openSensor-v2.1',
    // daemon 的格鍵是 Firestore 欄位安全版（| → _、: → -）
    cells: {
      wUnstated: { n: 12, dates: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13'] },
      big_all_down: { n: 2, dates: ['2026-09-29', '2026-10-06'] },
      'wUnconfirmed-tsmcSolo': { n: 1, dates: ['2026-10-02'] },
    },
    pending: { n: 1, dates: ['2026-10-06'] },
  });
  const rows = osOutsideMonthRows(st, T(12, 0, 0, 14));
  assert.equal(rows[0].title, '不在狀態內（權值未表態）');
  assert.equal(rows[0].month, 10);
  assert.equal(rows[0].capped, true);
  assert.equal(rows[1].title, '不在狀態內（量大·全面·跌）');
  assert.equal(rows[1].month, 1);
  assert.equal(rows[1].capped, false);
  assert.equal(rows[2].title, '不在狀態內（權值未確認·台積電獨撐）');
});

test('影子層輪詢窗：交易日 08:55–10:15；其餘只在掛載時抓一次', () => {
  assert.equal(shouldPollOpenSensorAt(T(8, 54, 59), true), false);
  assert.equal(shouldPollOpenSensorAt(T(8, 55), true), true);
  assert.equal(shouldPollOpenSensorAt(T(10, 6), true), true);       // 10:06 拿定格
  assert.equal(shouldPollOpenSensorAt(T(10, 15), true), false);
  assert.equal(shouldPollOpenSensorAt(T(9, 30), false), false);     // 非交易日
  assert.equal(shouldPollOpenSensorAt(T(9, 30), true, true), false); // 背景分頁
  assert.equal(msUntilOpenSensorWindow(T(8, 50), true), 5 * 60_000);
  assert.equal(msUntilOpenSensorWindow(T(9, 0), true), null);
  assert.equal(msUntilOpenSensorWindow(T(8, 0), false), null);
});

test('看板日期：交易日用今天；週末回到週五；假日再往前', () => {
  const trading = ymd => !['2026-10-10', '2026-10-11', '2026-10-09'].includes(ymd);
  assert.equal(resolveBoardYmd('2026-10-08', trading), '2026-10-08');
  assert.equal(resolveBoardYmd('2026-10-11', trading), '2026-10-08');
  assert.equal(resolveBoardYmd('bad', trading), null);
  assert.equal(osPct(-0.46), '−0.46%');
});
