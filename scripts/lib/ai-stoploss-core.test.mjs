// AI 停損規範 stop-v1.1·resolveStop（四線取高＋兩段棘輪＋事件收緊）、補判、觸及事件延續、紀律天數 單元測試：
//   node --test scripts/lib/ai-stoploss-core.test.mjs
// 編號對應實作計畫 warroom/stoploss/v1.1/impl-plan.md §5（C′、E、L4–L9、M3–M4）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveStop, carryEpisode, advanceEpisode, evaluateLateTouch, disciplineDay, countTradingDays, legacyDisciplineStop,
  EPISODE_CONTINUE_REASONS, STOP_SPEC_VERSION,
} from './ai-stoploss.mjs';

const T = (h, m, s = 0, day = 5) => Date.UTC(2026, 9, day, h - 8, m, s);
const TODAY = '2026-10-05';   // 週一
const HOLIDAYS = new Set(['2026-10-09']);
const isTD = ymd => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !HOLIDAYS.has(ymd); };

const lot = (id, buyPrice, qty, buyDate = '2026-09-01') => ({ id, buyPrice, qty, buyDate });
const pos = (lots, code = '2317') => {
  const qty = lots.reduce((s, l) => s + l.qty, 0);
  const dates = lots.map(l => l.buyDate).filter(Boolean).sort();
  return { code, name: '', qty, avgCost: lots.reduce((s, l) => s + l.buyPrice * l.qty, 0) / qty,
    firstDate: dates[0] ?? null, lastBuyDate: dates[dates.length - 1] ?? null, lots };
};
const exOf = (events, coverFrom = '2022-07-01', coverTo = TODAY) => ({ events, coverFrom, coverTo });
const NO_EX = exOf([]);
const L = ({ dataDate = '2026-10-02', band = null, bandYmd = dataDate, close = 110, atr14 = 2, holdHigh = null, from = '2026-09-01', barsFrom = '2026-06-01', exGapBars = 0 } = {}) => ({
  dataDate, close, atr14, barsFrom, exGapBars,
  atrBand: band == null ? null : { price: band, dataDate: bandYmd },
  holdHigh: holdHigh == null ? null : { price: holdHigh, dataDate, complete: true, from },
});
const resolve = (position, ex = NO_EX, prev = null, extra = {}) =>
  resolveStop({ position, ex, prev, nowMs: T(16, 50, 0, 2), tradeDate: '2026-10-02', ...extra });
/** 上一版（停損簿 prevStateOf 的形狀） */
const prevOf = (r, position) => ({
  stop: r.stop, baseStop: r.baseStop, floorStop: r.floorStop, bandHold: r.bandHold, stopSource: r.stopSource, sourceDate: r.sourceDate,
  floorSource: r.floorSource, floorSourceDate: r.floorSourceDate, bandSourceDate: r.bandSourceDate, basisText: r.basisText,
  stopVersion: r.stopVersion, lots: position.lots, exApplied: r.exApplied, selfAdjusted: r.selfAdjusted,
  startedAt: r.startedAt, tradeDate: r.tradeDate, holdHigh: r.holdHigh, eventKeys: r.eventKeys,
});
const overlay = (over = {}) => ({
  key: '2317:C16a', cls: 'C16a', label: '法律事件', tier: 'strong', weight: 0.9, line: 99, refClose: 104, refYmd: '2026-10-02', atr14: 2,
  effectiveFrom: TODAY, expiresAfter: '2026-10-12', startedAt: T(8, 46), source: 'premarket', state: 'active', ...over,
});
const P0 = pos([lot('a', 100, 1)]);

// ── C′：組成線與棘輪 ───────────────────────────────────────────────────────

test('C9′ 新部位：沒有組成線 ⇒ 只有成本線；ATR 帶資料日早於最早買進日 ⇒ 不計；有效帶值 ⇒ 成本線與帶取高', () => {
  const a = resolve(P0, NO_EX, null, { lines: null });
  assert.equal(a.stop, 92); assert.equal(a.stopSource, 'cost'); assert.equal(a.versionReason, 'init');
  const today = pos([lot('a', 100, 1, TODAY)]);
  const b = resolve(today, NO_EX, null, { lines: L({ band: 95 }) });
  assert.equal(b.stop, 92); assert.equal(b.lines.bandLine, null); assert.equal(b.stopSource, 'cost');
  const c = resolve(P0, NO_EX, null, { lines: L({ band: 95 }) });
  assert.equal(c.stop, 95); assert.equal(c.stopSource, 'atrBand'); assert.equal(c.sourceDate, '2026-10-02');
  assert.equal(c.basisText, 'ATR 帶·10/02 設定·只升不降');
  assert.equal(c.floorStop, 92); assert.equal(c.bandHold, 95); assert.equal(c.baseStop, 95);
  assert.equal(c.specVersion, STOP_SPEC_VERSION);
});

test('C24 系統線的 basis 一律 system（不看來源）；line 一律 stop', () => {
  for (const r of [resolve(P0), resolve(P0, NO_EX, null, { lines: L({ band: 95 }) }), resolve(P0, NO_EX, null, { events: [overlay({ line: 99 })] })]) {
    assert.equal(r.basis, 'system'); assert.equal(r.line, 'stop');
  }
});

test('L4 ATR 帶併入棘輪：帶 105 → 98.5 ⇒ 生效停損維持 105（ATR 帶·設定日不變），今日帶值 98.5 照記', () => {
  const d1 = resolve(P0, NO_EX, null, { lines: L({ dataDate: '2026-10-01', band: 105, close: 110 }), tradeDate: '2026-10-01' });
  assert.equal(d1.stop, 105); assert.equal(d1.stopSource, 'atrBand'); assert.equal(d1.sourceDate, '2026-10-01');
  const d2 = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ dataDate: '2026-10-02', band: 98.5, close: 102 }) });
  assert.equal(d2.stop, 105); assert.equal(d2.stopSource, 'atrBand'); assert.equal(d2.sourceDate, '2026-10-01');
  assert.equal(d2.lines.bandLine, 98.5); assert.equal(d2.versionReason, null); assert.equal(d2.stopVersion, d1.stopVersion);
  assert.deepEqual(d2.rejected, []);
});

test('L5 bandRatchet=false：帶 105 → 98.5 ⇒ 停損降到 max(98.5, floorStop)、bandDown、不記 loosen', () => {
  const d1 = resolve(P0, NO_EX, null, { lines: L({ dataDate: '2026-10-01', band: 105, close: 110 }), tradeDate: '2026-10-01', bandRatchet: false });
  const d2 = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ dataDate: '2026-10-02', band: 98.5, close: 102 }), bandRatchet: false });
  assert.equal(d2.stop, 98.5); assert.equal(d2.versionReason, 'bandDown'); assert.equal(d2.stopVersion, d1.stopVersion + 1);
  assert.ok(!d2.rejected.some(r => r.code === 'loosen'));
  assert.equal(d2.basisText, 'ATR 帶·10/02 設定');
});

test('L6 帶值檢查：NaN、≤0、不在檔位、≥ 收盤、低於收盤 −15% 再減 1 檔、資料日不是最近定版日 ⇒ bandInvalid、bandHold 沿用上一版', () => {
  const d1 = resolve(P0, NO_EX, null, { lines: L({ dataDate: '2026-10-01', band: 105, close: 110 }), tradeDate: '2026-10-01' });
  const prev = prevOf(d1, P0);
  const bad = [
    L({ band: NaN }), L({ band: -1 }), L({ band: 98.53, close: 102 }), L({ band: 102, close: 102 }), L({ band: 80, close: 102 }),
  ];
  for (const lines of bad) {
    const r = resolve(P0, NO_EX, prev, { lines });
    assert.ok(r.rejected.some(x => x.code === 'bandInvalid'), JSON.stringify(lines.atrBand));
    assert.ok(r.bandRejected);
    assert.equal(r.bandHold, 105); assert.equal(r.stop, 105);
  }
  const stale = resolve(P0, NO_EX, prev, { lines: L({ band: 98.5, bandYmd: '2026-09-30', close: 102 }), latestCanonicalYmd: '2026-10-02' });
  assert.equal(stale.bandRejected, '帶值資料日不是最近定版日');
  // 前端暫算（close 為 null、不傳 latestCanonicalYmd）只驗數值與檔位：高於現價的帶值照收
  const front = resolve(P0, EMPTY(), null, { lines: { ...L({ band: 99 }), close: null, barsFrom: null }, bandRatchet: false });
  assert.equal(front.stop, 99); assert.equal(front.bandRejected, null);
});
function EMPTY() { return { events: [], coverFrom: null, coverTo: null }; }

test('L8 同值時的來源標示：事件收緊 > 追蹤線 > 保本線 > ATR 帶 > 成本線', () => {
  // 帶 92＝成本線 92 ⇒ ATR 帶
  assert.equal(resolve(P0, NO_EX, null, { lines: L({ band: 92, close: 100 }) }).stopSource, 'atrBand');
  // 保本 100＝帶 100 ⇒ 保本線（holdHigh 112 ≥ 110；ATR 14 時追蹤線 ＝ 112−42 低於保本，不影響）
  const be = resolve(P0, NO_EX, null, { lines: L({ band: 100, close: 105, holdHigh: 112, atr14: 14 }) });
  assert.equal(be.stop, 100); assert.equal(be.stopSource, 'breakeven');
  assert.equal(be.basisText, '保本線·持有期最高收盤曾達 +12.0%·未含費稅；淨額約 −0.38%');
  // 追蹤 100（130 − 3×10）＝保本 100＝帶 100 ⇒ 追蹤線
  const tr = resolve(P0, NO_EX, null, { lines: L({ band: 100, close: 120, holdHigh: 130, atr14: 10 }) });
  assert.equal(tr.stop, 100); assert.equal(tr.stopSource, 'trail');
  assert.equal(tr.basisText, '追蹤線·持有期最高收盤 130.0 −3 ATR');
  // 事件 100＝基礎 100 ⇒ 事件收緊
  const ev = resolve(P0, NO_EX, null, { lines: L({ band: 100, close: 120, holdHigh: 130, atr14: 10 }), events: [overlay({ line: 100 })] });
  assert.equal(ev.stopSource, 'event'); assert.equal(ev.sourceDate, TODAY);
  assert.equal(ev.basisText, '事件收緊·10/05 法律事件·至 10/12');
});

test('L9 係數涵蓋不足（coverFrom 晚於日 K 視窗起點）⇒ exGap、當日不採用日 K 算出的帶值與保本追蹤，棘輪沿用、成本線照算', () => {
  const r0 = resolve(P0);
  const ex = exOf([], '2026-07-01');
  const r = resolve(P0, ex, prevOf(r0, P0), { lines: L({ band: 95, holdHigh: 130, atr14: 5, barsFrom: '2026-06-01' }) });
  assert.ok(r.rejected.some(x => x.code === 'exGap'));
  assert.ok(r.exGapBars >= 1);
  assert.equal(r.stop, 92); assert.equal(r.lines.bandLine, null); assert.equal(r.lines.trailLine, null);
  assert.equal(r.versionReason, null);
  const gapBars = resolve(P0, NO_EX, prevOf(r0, P0), { lines: L({ band: 95, exGapBars: 3 }) });
  assert.equal(gapBars.exGapBars, 3); assert.equal(gapBars.stop, 92);
});

test('C23 組成線資料日 ≠ 最近定版日 ⇒ linesStale、沿用上一版、沒有 lineRaise；前端暫算不傳 latestCanonicalYmd ⇒ 不判 linesStale', () => {
  const d1 = resolve(P0, NO_EX, null, { lines: L({ dataDate: '2026-10-01', band: 100, close: 110 }), tradeDate: '2026-10-01' });
  const st = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ dataDate: '2026-10-01', band: 104, close: 110 }), latestCanonicalYmd: '2026-10-02' });
  assert.equal(st.linesStale, true); assert.equal(st.stop, 100); assert.equal(st.versionReason, null);
  const st2 = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ dataDate: '2026-10-01', band: 104, close: 110 }), bandRatchet: false, latestCanonicalYmd: '2026-10-02' });
  assert.equal(st2.bandHold, 100, 'bandRatchet=false 時資料延遲也沿用上一版帶值，不會掉成只有成本線');
  const fr = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ dataDate: '2026-10-01', band: 104, close: 110 }) });
  assert.equal(fr.linesStale, false); assert.equal(fr.stop, 104); assert.equal(fr.versionReason, 'lineRaise');
});

test('C11′ 除權息 f＝0.962：floorStop、bandHold、事件收緊線都 ceilTick(×f)、組成線依資料日之後的係數再乘、exAdjust、事件延續', () => {
  const d1 = resolve(P0, NO_EX, null, { lines: L({ band: 105, close: 112 }), events: [overlay({ line: 110 })] });
  assert.equal(d1.stop, 110); assert.equal(d1.stopSource, 'event');
  const ex = exOf([['2026-10-05', 0.962]]);
  const r = resolve(P0, ex, prevOf(d1, P0), {
    lines: L({ band: 105, close: 112 }), events: [overlay({ line: 110 })], nowMs: T(8, 46), tradeDate: TODAY,
  });
  assert.equal(r.versionReason, 'exAdjust');
  assert.equal(r.floorStop, 88.6);          // ceilTick(92 × 0.962 = 88.504)
  assert.equal(r.bandHold, 101.5);          // ceilTick(105 × 0.962 = 101.01)，檔位 0.5
  assert.equal(r.lines.bandLine, 101);      // 今日帶值 floorTick(105 × 0.962)
  assert.equal(r.stop, 106);                // 事件收緊線 ceilTick(110 × 0.962 = 105.82)
  assert.equal(r.stopSource, 'event');
  assert.deepEqual(r.exApplied, ['2026-10-05']);
  assert.deepEqual(r.rejected, []);
  const ep = { id: 3, stopVersion: d1.stopVersion, kind: 'touch', firstDate: '2026-10-02', lastDate: '2026-10-02', closesBelow: 0, level1Sent: true };
  assert.equal(carryEpisode(ep, r).id, 3);
  assert.equal(carryEpisode(ep, r).stopVersion, r.stopVersion);
  // 同一事件再算一次：已套用，不再乘
  const again = resolve(P0, ex, prevOf(r, P0), { lines: L({ band: 105, close: 112 }), events: [overlay({ line: 110 })], tradeDate: TODAY });
  assert.equal(again.stop, 106); assert.equal(again.versionReason, null);
});

test('C16′ 成本更正（同一筆買價被改）⇒ floorStop、bandHold 歸零以當日組成線重算；事件收緊層保留', () => {
  const d1 = resolve(P0, NO_EX, null, { lines: L({ band: 105, close: 112 }) });
  const edited = pos([lot('a', 90, 1)]);
  const r = resolve(edited, NO_EX, prevOf(d1, P0), { lines: L({ band: 98.5, close: 102 }), events: [overlay({ line: 99 })] });
  assert.equal(r.versionReason, 'costCorrection');
  assert.equal(r.floorStop, 82.8); assert.equal(r.bandHold, 98.5); assert.equal(r.baseStop, 98.5);
  assert.equal(r.stop, 99); assert.equal(r.stopSource, 'event');
  assert.deepEqual(r.rejected, []);
});

test('C17′ 自檢例外：init／costCorrection／exAdjust／eventExpire／bandDown 的下降不記 loosen；其他下降 ⇒ loosen、保留上一版', () => {
  // eventExpire：上一版由事件收緊決定，疊加層到期後回到基礎停損
  const d1 = resolve(P0, NO_EX, null, { lines: L({ band: 95, close: 104 }), events: [overlay({ line: 99 })] });
  const ex1 = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ band: 95, close: 104 }), events: [], tradeDate: '2026-10-13' });
  assert.equal(ex1.stop, 95); assert.equal(ex1.versionReason, 'eventExpire'); assert.ok(!ex1.rejected.some(r => r.code === 'loosen'));
  // 不明原因的下降（上一版 110 沒有任何來源支撐）⇒ loosen、保留上一版
  const weird = { stop: 110, floorStop: 92, bandHold: 100, stopSource: 'atrBand', stopVersion: 4, lots: P0.lots, exApplied: [], selfAdjusted: {}, startedAt: 1, tradeDate: '2026-10-01', eventKeys: [] };
  const lo = resolve(P0, NO_EX, weird, { lines: L({ band: 100, close: 104 }) });
  assert.ok(lo.rejected.some(r => r.code === 'loosen'));
  assert.equal(lo.stop, 110); assert.equal(lo.stopVersion, 4); assert.equal(lo.versionReason, null);
  // lineRaise 只會上升
  const up = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ band: 101, close: 106 }), events: [overlay({ line: 99 })] });
  assert.equal(up.stop, 101); assert.equal(up.versionReason, 'lineRaise');
});

test('事件收緊疊加：stop＝max(基礎, 收緊線)、新疊加層 ⇒ eventTighten；收緊線 ≤ 基礎 ⇒ 不改；deferred 層不納入', () => {
  const d1 = resolve(P0, NO_EX, null, { lines: L({ band: 95, close: 104 }) });
  const t = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ band: 95, close: 104 }), events: [overlay({ line: 99 })], tradeDate: TODAY });
  assert.equal(t.stop, 99); assert.equal(t.versionReason, 'eventTighten'); assert.deepEqual(t.eventKeys, ['2317:C16a']);
  assert.equal(t.lines.eventLine, 99); assert.equal(t.baseStop, 95);
  const low = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ band: 95, close: 104 }), events: [overlay({ line: 94 })] });
  assert.equal(low.stop, 95); assert.equal(low.stopSource, 'atrBand');
  const def = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ band: 95, close: 104 }), events: [overlay({ line: null, state: 'deferred' })] });
  assert.equal(def.stop, 95);
  // 兩個類別同時生效：取最高的那一層
  const two = resolve(P0, NO_EX, null, { lines: L({ band: 95, close: 104 }), events: [overlay({ line: 99 }), overlay({ key: '2317:C17', cls: 'C17', label: '工安停工', line: 100 })] });
  assert.equal(two.stop, 100); assert.equal(two.basisText, '事件收緊·10/05 工安停工·至 10/12');
});

test('M3 追蹤線：ATR 變大使當日追蹤線下降 ⇒ 停損不動（floorStop 棘輪）', () => {
  const d1 = resolve(P0, NO_EX, null, { lines: L({ close: 120, holdHigh: 125, atr14: 5 }) });
  assert.equal(d1.stop, 110); assert.equal(d1.stopSource, 'trail');
  const d2 = resolve(P0, NO_EX, prevOf(d1, P0), { lines: L({ close: 118, holdHigh: 125, atr14: 7 }) });
  assert.equal(d2.lines.trailLine, 104); assert.equal(d2.stop, 110); assert.equal(d2.stopSource, 'trail'); assert.equal(d2.versionReason, null);
});

test('M4 攤平、部分賣出、加碼、成本更正與保本／追蹤', () => {
  const d1 = resolve(P0, NO_EX, null, { lines: L({ close: 120, holdHigh: 125, atr14: 5 }) });
  // 攤平：還原成本降到 90，門檻較容易達到；已上移的停損不下移
  const avgDown = pos([lot('a', 100, 1), lot('b', 80, 1, '2026-09-20')]);
  const a = resolve(avgDown, NO_EX, prevOf(d1, P0), { lines: L({ close: 120, holdHigh: 125, atr14: 5 }) });
  assert.equal(a.stop, 110); assert.equal(a.versionReason, null);
  // FIFO 賣掉最早一筆：持有期起點改變 ⇒ 舊的最高收盤（from 不符）不用；停損不下移
  const sold = pos([lot('b', 80, 1, '2026-09-20')]);
  const s = resolve(sold, NO_EX, prevOf(a, avgDown), { lines: L({ close: 120, holdHigh: 125, atr14: 5 }) });
  assert.equal(s.lines.trailLine, null); assert.equal(s.stop, 110);
  // 加碼使成本上升：門檻用新成本；已啟動的線依新成本重算，棘輪保留
  const add = pos([lot('a', 100, 1), lot('c', 130, 1, '2026-10-01')]);
  const ad = resolve(add, NO_EX, prevOf(d1, P0), { lines: L({ close: 135, holdHigh: 140, atr14: 5 }) });
  assert.equal(ad.lines.beLine, 115); assert.equal(ad.lines.trailLine, 125);
  assert.equal(ad.stop, 125); assert.equal(ad.versionReason, 'ratchet');
  // 成本更正：歸零，依更正後成本重新判斷
  const corr = pos([lot('a', 120, 1)]);
  const c = resolve(corr, NO_EX, prevOf(d1, P0), { lines: L({ close: 120, holdHigh: 125, atr14: 5 }) });
  assert.equal(c.versionReason, 'costCorrection'); assert.equal(c.lines.beLine, null); assert.equal(c.stop, 110.5);   // ceilTick(120×0.92＝110.4)
});

test('上一版是 v1 形狀（只有 stop）⇒ floorStop 視同 stop，與 v1 結果相同', () => {
  const v1prev = { stop: 95, stopVersion: 2, lots: P0.lots, exApplied: [], selfAdjusted: {}, startedAt: 1, tradeDate: '2026-09-30' };
  const r = resolve(P0, NO_EX, v1prev);
  assert.equal(r.stop, 95); assert.equal(r.floorStop, 95); assert.equal(r.versionReason, null); assert.equal(r.stopVersion, 2);
});

// ── E：事件延續、補判、紀律 ─────────────────────────────────────────────────

const touched = { status: 'touched', kind: 'touch', triggerPx: 91.5, skipPct: null, basis: 'low', hold: null, facts: [] };

test('E10 版本延續表：exAdjust／lineRaise／eventTighten／eventExpire／bandDown ⇒ 事件延續不重發；ratchet／costCorrection ⇒ 結束、再觸及開新事件', () => {
  assert.deepEqual([...EPISODE_CONTINUE_REASONS], ['exAdjust', 'lineRaise', 'eventTighten', 'eventExpire', 'bandDown']);
  const ep = advanceEpisode(null, { touch: touched, stopVersion: 1, versionReason: null, todayYmd: TODAY, nowMs: T(10, 0), nextId: 5, stopSource: 'atrBand' }).episode;
  assert.equal(ep.stopSource, 'atrBand');
  for (const reason of EPISODE_CONTINUE_REASONS) {
    const r = advanceEpisode(ep, { touch: touched, stopVersion: 2, versionReason: reason, todayYmd: TODAY, nowMs: T(11, 0), nextId: 6 });
    assert.equal(r.isNew, false, reason); assert.equal(r.sendLevel1, false, reason); assert.equal(r.episode.id, 5, reason);
    assert.equal(carryEpisode(ep, { stopVersion: 2, versionReason: reason }).id, 5);
  }
  for (const reason of ['ratchet', 'costCorrection', 'init']) {
    const r = advanceEpisode(ep, { touch: touched, stopVersion: 2, versionReason: reason, todayYmd: TODAY, nowMs: T(11, 0), nextId: 6 });
    assert.equal(r.isNew, true, reason); assert.equal(r.episode.id, 6, reason); assert.equal(r.sendLevel1, true, reason);
    assert.equal(carryEpisode(ep, { stopVersion: 2, versionReason: reason }), null);
  }
  assert.equal(carryEpisode(ep, { stopVersion: 1, versionReason: null }), ep);
});

test('收盤後補判：官方日低 ≤ 停損、今天沒有事件、不是 setToday ⇒ late／officialLow；開盤就低於 ⇒ 觸發價記開盤價', () => {
  const base = { stop: 92, officialOpen: 95, officialLow: 91.5, dateYmd: TODAY, hadEpisodeToday: false, setToday: false };
  const r = evaluateLateTouch(base);
  assert.equal(r.status, 'touched'); assert.equal(r.kind, 'late'); assert.equal(r.basis, 'officialLow'); assert.equal(r.triggerPx, 91.5);
  const g = evaluateLateTouch({ ...base, officialOpen: 90 });
  assert.equal(g.triggerPx, 90); assert.equal(g.skipPct, 2.17);
  assert.equal(evaluateLateTouch({ ...base, hadEpisodeToday: true }).status, 'ok');
  assert.equal(evaluateLateTouch({ ...base, setToday: true }).notJudged, 'setTodayLate');
  assert.equal(evaluateLateTouch({ ...base, officialLow: 92.5 }).status, 'ok');
  assert.equal(evaluateLateTouch({ ...base, officialLow: 91.53 }).notJudged, 'badLow');
  assert.equal(evaluateLateTouch({ ...base, exPending: true }).notJudged, 'exPending');
  assert.equal(evaluateLateTouch({ ...base, exUnconfirmed: true }).hold, 'exUnconfirmed');
  const ld = evaluateLateTouch({ ...base, officialOpen: 90, officialLow: 90, refPrice: 100 });
  assert.ok(ld.facts.includes('今日未曾高於跌停價'));
});

test('E6 紀律天數：事件起始交易日算第 1 天、交易日計數（跨休市日）、第 2 個交易日起且前一交易日收盤 ≤ 停損才算', () => {
  const ep = { id: 1, stopVersion: 1, kind: 'touch', firstDate: '2026-10-08', lastDate: '2026-10-08', closesBelow: 0, level1Sent: true };
  assert.equal(countTradingDays('2026-10-08', '2026-10-12', isTD), 2);   // 10-09 休市、10-10／11 週末
  assert.equal(disciplineDay(ep, '2026-10-12', 91, 92, isTD), 2);
  assert.equal(disciplineDay(ep, '2026-10-08', 91, 92, isTD), null);   // 第 1 天只發一級
  assert.equal(disciplineDay(ep, '2026-10-12', 92.5, 92, isTD), null); // 前一交易日收盤在停損上
  assert.equal(disciplineDay(ep, '2026-10-13', 91, 92, isTD), 3);
  assert.equal(countTradingDays('2026-10-12', '2026-10-08', isTD), 0);
});

test('第一階段口徑：停損紀律／崩盤防禦＝max(帶, 成本×0.92) 取 0.01', () => {
  assert.equal(legacyDisciplineStop(100, 95), 95);
  assert.equal(legacyDisciplineStop(100, 80), 92);
  assert.equal(legacyDisciplineStop(100, null), 92);
  assert.equal(legacyDisciplineStop(0, 95), null);
});
