// AI 停損規範 stop-v1.1·事件收緊（第 14 項＋第二輪 A4：規則判定＋類別權重）單元測試：node --test scripts/lib/ai-stoploss-event.test.mjs
// 編號對應實作計畫 warroom/stoploss/v1.1/impl-plan.md §5 N 組。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ruleBearEvents, eventTierOf, eventLineOf, stepEventOverlay, activeOverlays, eventShadowRows, missShadowRows,
  resolveStop, STOP_PARAMS,
} from './ai-stoploss.mjs';
import { newsBoardFromDoc, newsCtxOf, majorBearOf, GATE_D, GATE_E, RULE_LEGAL_PREFIX } from './warroom-news.mjs';

const YMD = '2026-10-05';   // 週一
const T = (h, m = 0, ymd = YMD) => Date.parse(`${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
const PREV_CLOSE = Date.parse('2026-10-02T13:30:00+08:00');
const HOLIDAYS = new Set(['2026-10-09', '2026-10-15']);   // 10-15 當注入的颱風假
const isTD = ymd => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !HOLIDAYS.has(ymd); };

const V = (over = {}) => ({
  label: '利空', strength: '中', confidence: '低', certainty: '已確認', novelty: '首次', priced: '否',
  eventType: '法律', basis: 'content', challenged: true, at: T(7, 10), pass: 'morning', n: 3,
  reason: `${RULE_LEGAL_PREFIX}涉檢調搜索，法律判定前視為利空（AI 原判中性：公司聲明營運正常）`,
  keyQuote: '調查局今日搜索公司總部', quoteVerified: 1, quoteFailed: 0, ...over,
});
const docOf = (verdicts, extra = {}) => ({ date: YMD, targetDate: YMD, updatedAt: T(7, 20), lastPass: 'morning', verdictJson: JSON.stringify(verdicts), ...extra });
const CTX = { applicableYmd: YMD, minAtMs: PREV_CLOSE };

// ── N1–N3：述詞 ─────────────────────────────────────────────────────────────

test('N1 規則類＋挑戰過＋當日 ⇒ 成立；承接、前一日、早於上一交易日 13:30、沒挑戰、D 閘門、AI 未回應、非利空、只有 eventType 法律、w 高但非規則 ⇒ 不成立', () => {
  const ok = ruleBearEvents(docOf({ 3037: V() }), CTX);
  assert.equal(ok.length, 1);
  assert.deepEqual({ code: ok[0].code, cls: ok[0].cls, key: ok[0].key, tier: ok[0].tier, weight: ok[0].weight, pass: ok[0].pass },
    { code: '3037', cls: 'C16a', key: '3037:C16a', tier: 'strong', weight: 0.9, pass: 'morning' });
  const none = [
    docOf({ 3037: V({ carriedFrom: '2026-10-02' }) }),
    docOf({ 3037: V() }, { targetDate: '2026-10-02' }),
    docOf({ 3037: V({ at: T(13, 0, '2026-10-02') }) }),
    docOf({ 3037: V({ challenged: false }) }),
    docOf({ 3037: V({ gate: GATE_D }) }),
    docOf({ 3037: V({ label: '中性', reason: 'AI 判別未回應，保守視為中性' }) }),
    docOf({ 3037: V({ label: '利多' }) }),
    docOf({ 3037: V({ reason: '公司遭搜索，AI 自己判利空', eventType: '法律' }) }),
    docOf({ 3037: V({ reason: '大客戶砍單', eventType: '訂單', strength: '強', confidence: '高' }) }),
    { foo: 1 }, null,
  ];
  for (const d of none) assert.deepEqual(ruleBearEvents(d, CTX), [], JSON.stringify(d)?.slice(0, 120));
  // E 引用強制未過：規則類比照法律放行（AI 只認定事實）
  assert.equal(ruleBearEvents(docOf({ 3037: V({ gate: GATE_E }) }), CTX).length, 1);
  assert.equal(ruleBearEvents(docOf({ 2317: V({ ruleClass: 'C17', reason: '【規則·工安停工】廠區火災', gate: GATE_E }) }), CTX).length, 1);
  // classes 過濾（關閉收緊的回退路徑）
  assert.deepEqual(ruleBearEvents(docOf({ 3037: V() }), { ...CTX, classes: [] }), []);
});

test('N2 權重不變式：只改 w 的成分（強度、信心、確定性、新穎、反映）⇒ 事件、收緊線、期限、紀錄分類完全相同', () => {
  const run = over => {
    const evs = ruleBearEvents(docOf({ 3037: V(over) }), CTX);
    const step = stepEventOverlay([], { events: evs, baseStop: 90, firstDate: '2026-09-01', refClose: 104, refYmd: '2026-10-02', atr14: 2, todayYmd: YMD, nowMs: T(8, 46), when: 'premarket', isTradingDay: isTD });
    return { evs: evs.map(({ research: _research, ...e }) => e), overlays: step.overlays, records: step.records };
  };
  const base = run({});
  for (const over of [{ strength: '強', confidence: '高' }, { strength: '弱', confidence: '低', certainty: '傳聞' }, { novelty: '重複', priced: '已反映' }]) {
    assert.deepEqual(run(over), base, JSON.stringify(over));
  }
  const evs = ruleBearEvents(docOf({ 3037: V({ strength: '強', confidence: '高' }) }), CTX);
  assert.ok(evs[0].research && 'w' in evs[0].research, 'w 只寫進 research');
});

test('N3 金樣本：C16a 與戰情 majorBearOf(...).basis===rule-legal 一致（同一個述詞）', () => {
  const verdicts = {
    3037: V(), 2317: V({ challenged: false }), 2330: V({ carriedFrom: '2026-10-02' }), 2454: V({ at: T(12, 0, '2026-10-02') }),
    2603: V({ reason: '公司遭搜索', ruleOverride: 'legal-event' }), 1301: V({ reason: '一般利空', eventType: '訂單' }),
  };
  const doc = docOf(verdicts);
  const board = newsBoardFromDoc(doc);
  const ctx = newsCtxOf(board.meta, YMD);
  const golden = Object.keys(verdicts).filter(c => majorBearOf(board.map[c], { scope: 'holding', ctx, minAtMs: PREV_CLOSE })?.basis === 'rule-legal').sort();
  assert.deepEqual(ruleBearEvents(doc, CTX).filter(e => e.cls === 'C16a').map(e => e.code), golden);
  assert.deepEqual(golden, ['2603', '3037']);
});

// ── N4：類別權重分級與收緊線 ─────────────────────────────────────────────

test('類別權重分級（A4）：≥0.7 強（1 ATR／3%）、0.3～0.7 溫和（2 ATR／5%）、<0.3 不收緊；C23 不當訊號；C15a 贈與信託 0.05', () => {
  const t = c => eventTierOf(c).tier;
  assert.deepEqual(['C16a', 'C22', 'C13b', 'C17'].map(t), ['strong', 'strong', 'strong', 'strong']);
  assert.deepEqual(['C16b', 'C15a'].map(t), ['mild', 'mild']);
  assert.deepEqual(['C11a', 'C15c', 'C20b'].map(t), ['none', 'none', 'none']);
  assert.equal(eventTierOf('C20b').reason, 'belowWeight');
  assert.deepEqual({ tier: eventTierOf('C23').tier, reason: eventTierOf('C23').reason, weight: eventTierOf('C23').weight }, { tier: 'none', reason: 'notSignal', weight: 0.9 });
  assert.equal(eventTierOf('C15a', 'giftOrTrust').tier, 'none');
  assert.equal(eventTierOf('C99').reason, 'unknownClass');
  assert.deepEqual(STOP_PARAMS.eventTiers.map(x => [x.tier, x.minWeight, x.atrMult, x.minPct]), [['strong', 0.7, 1, 3], ['mild', 0.3, 2, 5]]);
  const strong = eventTierOf('C16a');
  assert.equal(strong.atrMult, 1); assert.equal(strong.minPct, 3);
  assert.match(strong.weightSource, /先驗·未回測/);
});

test('N4 收緊線：ATR 下限與百分比下限各一例、向下取檔、ETF 檔位、前收缺 ⇒ null；溫和級距離較寬', () => {
  assert.equal(eventLineOf(104, 4), 100);            // 104 − max(4, 3.12)
  assert.equal(eventLineOf(104, 2), 100.5);          // 104 − 3.12 ＝ 100.88 → 向下取檔（≥100 檔位 0.5）
  assert.equal(eventLineOf(52.37, null), 50.7);      // 52.37 − 1.5711 ＝ 50.7989 → 個股 50–100 元檔位 0.1
  assert.equal(eventLineOf(52.37, null, true), 50.75); // ETF ≥50 元檔位 0.05
  assert.equal(eventLineOf(null, 2), null);
  const mild = eventTierOf('C16b');
  assert.equal(eventLineOf(104, 2, { atrMult: mild.atrMult, minPct: mild.minPct }), 98.8);   // 104 − max(4, 5.2)＝98.8
});

// ── N5–N9：疊加層狀態機 ──────────────────────────────────────────────────

const EV = (over = {}) => ({ code: '3037', cls: 'C16a', label: '法律事件', sub: null, key: '3037:C16a', at: T(7, 10), targetDate: YMD, tier: 'strong', weight: 0.9, ...over });
const step = (prev, over = {}) => stepEventOverlay(prev, {
  events: [EV()], seen: [], baseStop: 92, firstDate: '2026-09-01', refClose: 104, refYmd: '2026-10-02', atr14: 2,
  todayYmd: YMD, nowMs: T(8, 46), when: 'premarket', isTradingDay: isTD, ...over,
});

test('N5 結果分類：applied／noBite／boughtSameDay（盤前、盤中）／boughtAfter／noFirstDate／noRef／sameEvent；更早就有批次 ⇒ applied', () => {
  const a = step([]);
  assert.deepEqual(a.records.map(r => r.outcome), ['applied']);
  assert.equal(a.overlays[0].line, 100.5); assert.equal(a.overlays[0].effectiveFrom, YMD);
  assert.equal(a.overlays[0].expiresAfter, '2026-10-12');   // 10-05 起 5 個交易日（10-09 休市）
  assert.deepEqual(a.changed, ['tighten']);
  assert.deepEqual(step([], { baseStop: 101 }).records.map(r => r.outcome), ['noBite']);
  assert.deepEqual(step([], { firstDate: YMD }).records.map(r => r.outcome), ['boughtSameDay']);
  assert.deepEqual(step([], { firstDate: YMD, when: 'intraday', lastTradePx: 103, nowMs: T(10, 30) }).records.map(r => r.outcome), ['boughtSameDay']);
  assert.deepEqual(step([], { firstDate: '2026-10-06' }).records.map(r => r.outcome), ['boughtAfter']);
  assert.deepEqual(step([], { firstDate: null }).records.map(r => r.outcome), ['noFirstDate']);
  assert.deepEqual(step([], { refClose: null }).records.map(r => r.outcome), ['noRef']);
  assert.deepEqual(step(a.overlays, { seen: a.seen }).records.map(r => r.outcome), ['sameEvent']);
  // 不收緊的類別只記錄
  assert.deepEqual(step([], { events: [EV({ cls: 'C20b', key: '3037:C20b' })] }).records.map(r => r.outcome), ['belowWeight']);
  assert.deepEqual(step([], { events: [EV({ cls: 'C23', key: '3037:C23' })] }).records.map(r => r.outcome), ['notSignal']);
  // 溫和級（C16b 裁罰訴訟）：前收 −max(2 ATR, 5%)
  const mild = step([], { events: [EV({ cls: 'C16b', key: '3037:C16b' })] });
  assert.equal(mild.overlays[0].line, 98.8); assert.equal(mild.overlays[0].tier, 'mild');
});

test('N6 盤前生效 ⇒ 版本不是 setToday；盤中生效 ⇒ 版本是 setToday；盤中成交價 ≤ 收緊線 ⇒ deferred，收盤以今日收盤重算、次一交易日生效', () => {
  const pos = { code: '3037', name: '', qty: 1, avgCost: 100, firstDate: '2026-09-01', lastBuyDate: '2026-09-01', lots: [{ id: 'a', buyPrice: 100, qty: 1, buyDate: '2026-09-01' }] };
  const pre = step([]);
  const r = resolveStop({ position: pos, ex: { events: [], coverFrom: '2022-07-01', coverTo: YMD }, events: activeOverlays(pre.overlays, YMD), nowMs: T(8, 46), tradeDate: YMD });
  assert.equal(r.stop, 100.5); assert.ok(r.startedAt < T(9, 0));
  const intra = step([], { when: 'intraday', lastTradePx: 103, nowMs: T(10, 30) });
  assert.deepEqual(intra.records.map(x => x.outcome), ['applied']);
  assert.equal(intra.overlays[0].source, 'intraday');
  const def = step([], { when: 'intraday', lastTradePx: 100.5, nowMs: T(10, 30) });
  assert.deepEqual(def.records.map(x => x.outcome), ['deferred']);
  assert.equal(def.overlays[0].state, 'deferred'); assert.equal(def.overlays[0].line, null);
  assert.equal(activeOverlays(def.overlays, YMD).length, 0);
  const close = stepEventOverlay(def.overlays, { seen: def.seen, baseStop: 92, refClose: 99, atr14: 2, todayYmd: YMD, nowMs: T(16, 50), when: 'close', isTradingDay: isTD });
  assert.deepEqual(close.records.map(x => x.outcome), ['applied']);
  const o = close.overlays[0];
  assert.deepEqual([o.state, o.line, o.refYmd, o.effectiveFrom, o.expiresAfter], ['active', 96, YMD, '2026-10-06', '2026-10-13']);
  assert.equal(activeOverlays(close.overlays, YMD).length, 0);
  assert.equal(activeOverlays(close.overlays, '2026-10-06').length, 1);
});

test('N7 期限：第 5 個交易日仍有效、第 6 個交易日 08:46 到期（跨週末、休市日與注入的颱風假）；到期 eventExpire 不記 loosen', () => {
  const a = stepEventOverlay([], { events: [EV()], seen: [], baseStop: 92, firstDate: '2026-09-01', refClose: 104, refYmd: '2026-10-08', atr14: 2, todayYmd: '2026-10-12', nowMs: T(8, 46, '2026-10-12'), when: 'premarket', isTradingDay: isTD });
  assert.equal(a.overlays[0].expiresAfter, '2026-10-19');   // 10-12、13、14、16、19（10-15 颱風假）
  const day5 = step(a.overlays, { events: [], seen: a.seen, todayYmd: '2026-10-19' });
  assert.equal(day5.overlays.length, 1); assert.deepEqual(day5.changed, []);
  const day6 = step(a.overlays, { events: [], seen: a.seen, todayYmd: '2026-10-20' });
  assert.equal(day6.overlays.length, 0); assert.deepEqual(day6.changed, ['expire']);
  assert.deepEqual(day6.records.map(r => r.outcome), ['expired']);
  // close 不處理到期
  const c = stepEventOverlay(a.overlays, { seen: a.seen, todayYmd: '2026-10-20', nowMs: 1, when: 'close', isTradingDay: isTD });
  assert.equal(c.overlays.length, 1);
});

test('N8 事件身分＝(代號, 類別, 首次生效日)：疊加層存在 ⇒ sameEvent；到期後第 1～5 個交易日 ⇒ sameEvent；第 6 個交易日起 ⇒ 新事件；引文與理由不影響', () => {
  const a = step([]);
  const textChanged = step(a.overlays, { seen: a.seen, events: [EV({ at: T(23, 0, '2026-10-05') })] });
  assert.deepEqual(textChanged.records.map(r => r.outcome), ['sameEvent']);
  assert.equal(textChanged.overlays[0].line, a.overlays[0].line); assert.equal(textChanged.overlays[0].expiresAfter, a.overlays[0].expiresAfter);
  const after = step(a.overlays, { events: [], seen: a.seen, todayYmd: '2026-10-13' });   // 到期日 10-12 ⇒ 10-13 到期移除
  assert.equal(after.overlays.length, 0);
  for (const d of ['2026-10-13', '2026-10-14', '2026-10-16', '2026-10-19', '2026-10-20']) {
    assert.deepEqual(step([], { seen: after.seen, todayYmd: d }).records.map(r => r.outcome), ['sameEvent'], d);
  }
  const fresh = step([], { seen: after.seen, todayYmd: '2026-10-21' });
  assert.deepEqual(fresh.records.map(r => r.outcome), ['applied']);
  assert.equal(fresh.overlays[0].effectiveFrom, '2026-10-21');
  // ruleBearEvents 的 key 與引文、理由文字無關
  const k1 = ruleBearEvents(docOf({ 3037: V({ keyQuote: '甲', reason: `${RULE_LEGAL_PREFIX}一` }) }), CTX)[0].key;
  const k2 = ruleBearEvents(docOf({ 3037: V({ keyQuote: '乙', reason: `${RULE_LEGAL_PREFIX}二`, quotes: ['丙'] }) }), CTX)[0].key;
  assert.equal(k1, k2);
});

test('N9 期限內除權息 ⇒ 收緊線 ceilTick(×f)、期限不變；部位的 firstDate 早於生效日、當天加碼照套', () => {
  const a = step([], { firstDate: '2026-09-01' });
  const pos = { code: '3037', name: '', qty: 2, avgCost: 100, firstDate: '2026-09-01', lastBuyDate: YMD, lots: [{ id: 'a', buyPrice: 100, qty: 1, buyDate: '2026-09-01' }, { id: 'b', buyPrice: 100, qty: 1, buyDate: YMD }] };
  const ex = { events: [['2026-10-07', 0.95]], coverFrom: '2022-07-01', coverTo: '2026-10-07' };
  const r = resolveStop({ position: pos, ex, events: activeOverlays(a.overlays, '2026-10-07'), nowMs: T(8, 46, '2026-10-07'), tradeDate: '2026-10-07' });
  assert.equal(r.lines.eventLine, 95.5);   // ceilTick(100.5 × 0.95 ＝ 95.475)
  assert.equal(a.overlays[0].expiresAfter, '2026-10-12');
});

// ── N10：影子紀錄 ────────────────────────────────────────────────────────────

function barsFrom(start, rows) {
  const out = [];
  let t = Date.parse(`${start}T00:00:00Z`);
  for (const [o, h, l, c] of rows) {
    let d;
    do { d = new Date(t).toISOString().slice(0, 10); t += 86_400_000; } while (!isTD(d));
    out.push({ date: d, o, h, l, c });
  }
  return out;
}

test('N10 命中紀錄（全市場合成）：欄位齊全、0.5／1／2／3 ATR 對照線、三類互斥；w 只寫進 research', () => {
  const pre = Array.from({ length: 20 }, () => [104, 105, 103, 104]);
  const post = [[103, 103.5, 99, 100], [100, 101, 98, 99], ...Array.from({ length: 22 }, () => [99, 99.5, 97, 98])];
  const bars = barsFrom('2026-09-07', [...pre, ...post]);
  const eff = bars[20].date;
  const rows = eventShadowRows({ events: [EV({ targetDate: eff, research: { w: 0.18 } })], barsByCode: { 3037: bars }, dateYmd: bars[bars.length - 1].date });
  assert.equal(rows.length, 1);
  const r = rows[0];
  for (const k of ['date', 'code', 'cls', 'tier', 'weight', 'refYmd', 'refClose', 'atr14', 'line', 'touched', 'outcome', 'after', 'compare', 'research']) assert.ok(k in r, k);
  assert.equal(r.refClose, 104); assert.equal(r.refYmd, bars[19].date);
  assert.equal(r.touched, true); assert.equal(r.touchYmd, eff); assert.equal(r.touchType, 'touch');
  assert.equal(r.outcome, 'hit');   // 10 根內沒有收盤回到前收、第 10 根收盤 ≤ 收緊線
  assert.deepEqual(Object.keys(r.compare), ['atr0_5', 'atr1', 'atr2', 'atr3']);
  for (const c of Object.values(r.compare)) assert.ok(['washout', 'hit', 'lowSell', 'untouched', 'pending', 'noLine'].includes(c.outcome));
  assert.equal(r.research.w, 0.18);
  const w2 = eventShadowRows({ events: [EV({ targetDate: eff, research: { w: 0.99 } })], barsByCode: { 3037: bars }, dateYmd: r.date })[0];
  assert.deepEqual({ ...w2, research: null }, { ...r, research: null });
  // 洗出：觸及後 10 根內有收盤回到前收
  const wash = barsFrom('2026-09-07', [...pre, [103, 103.5, 99, 100], [100, 105, 100, 104.5], ...Array.from({ length: 20 }, () => [104, 105, 103, 104])]);
  assert.equal(eventShadowRows({ events: [EV({ targetDate: wash[20].date })], barsByCode: { 3037: wash }, dateYmd: 'x' })[0].outcome, 'washout');
});

test('N10 漏網紀錄：收盤 ≤ 前收 −2 ATR 或收在跌停、當日沒有合格事件 ⇒ 一列，寫出哪一條沒過（AI 已判利空的法律字樣記 aiBearLegalNoRule）', () => {
  const pre = Array.from({ length: 20 }, () => [100, 101, 99, 100]);
  const mk = lastClose => barsFrom('2026-09-07', [...pre, [100, 100, lastClose, lastClose]]);
  const day = mk(90)[20].date;
  const doc = { date: day, targetDate: day, updatedAt: 1, verdictJson: JSON.stringify({
    1101: V({ reason: '公司遭搜索，負責人被約談', eventType: '法律' }),
    1102: V({ label: '中性', reason: '影響有限' }),
    1103: V({ ruleClass: 'C20b', reason: '【規則·信評調降】中華信評調降展望' }),
    1104: V({ reason: '一般利空', eventType: '訂單', keyQuote: '訂單減少' }),
  }) };
  const rows = missShadowRows({
    universe: ['1101', '1102', '1103', '1104', '1105', '1106', '1107'], newsDoc: doc, dateYmd: day, applicableYmd: day,
    barsByCode: { 1101: mk(90), 1102: mk(90), 1103: mk(90), 1104: mk(90), 1105: mk(90), 1106: mk(99.5), 1107: mk(90) },
    mopsCodes: new Set(['1101']), eventCodes: ['1107'],
  });
  const by = Object.fromEntries(rows.map(r => [r.code, r]));
  assert.deepEqual(Object.keys(by).sort(), ['1101', '1102', '1103', '1104', '1105']);
  assert.equal(by['1101'].reason, 'aiBearLegalNoRule'); assert.equal(by['1101'].mops, true);
  assert.equal(by['1102'].reason, 'notBear');
  assert.equal(by['1103'].reason, 'belowWeight');
  assert.equal(by['1104'].reason, 'bearNotRule');
  assert.equal(by['1105'].reason, 'noVerdict');
  assert.equal(by['1101'].atLimitDown, true);
  for (const r of rows) assert.ok('research' in r && 'dropPct' in r && 'atr14' in r);
});

test('N10b 漏網原因與 ruleBearEvents 同一口徑（2026-10-05 審查）：規則類利空沒挑戰 ⇒ notChallenged；label 不是利空的 ruleClass（覆寫前的過渡資料）⇒ 兩邊都不算', () => {
  const pre = Array.from({ length: 20 }, () => [100, 101, 99, 100]);
  const bars = barsFrom('2026-09-07', [...pre, [100, 100, 90, 90]]);
  const day = bars[20].date;
  const verdicts = {
    2317: V({ ruleClass: 'C17', reason: '【規則·工安停工】本公司工安／停工事件，依規則視為利空（AI 原判中性：…）', challenged: false }),
    2330: V({ label: '中性', ruleClass: 'C17', reason: '公司說明產線已恢復', challenged: false }),
    2454: V({ label: '中性', ruleClass: 'C17', reason: '公司說明產線已恢復' }),
  };
  const doc = { date: day, targetDate: day, updatedAt: 1, verdictJson: JSON.stringify(verdicts) };
  const rows = missShadowRows({
    universe: ['2317', '2330', '2454'], newsDoc: doc, dateYmd: day, applicableYmd: day,
    barsByCode: { 2317: bars, 2330: bars, 2454: bars }, eventCodes: [],
  });
  const by = Object.fromEntries(rows.map(r => [r.code, r]));
  assert.equal(by['2317'].reason, 'notChallenged');
  assert.equal(by['2317'].ruleClass, 'C17');
  assert.equal(by['2330'].reason, 'notBear');
  assert.equal(by['2454'].reason, 'notBear');
  // 同一份判別表：ruleBearEvents 也不收 2330／2454（§10A.1-C label＝利空），2317 因沒挑戰不收——兩份紀錄口徑一致
  assert.deepEqual(ruleBearEvents(doc, { applicableYmd: day, minAtMs: null }).map(e => e.code), []);
  const okDoc = { ...doc, verdictJson: JSON.stringify({ ...verdicts, 2317: { ...verdicts['2317'], challenged: true } }) };
  assert.deepEqual(ruleBearEvents(okDoc, { applicableYmd: day, minAtMs: null }).map(e => e.code), ['2317']);
});
