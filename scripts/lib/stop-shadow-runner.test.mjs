// 停損 v1.1 影子試算流程（scripts/lib/stop-shadow-runner.mjs）：以記憶體版 store 跑「收盤結算 → 盤前刷新 → 盤中判定 → 收盤結算」整段。
// node --test scripts/lib/stop-shadow-runner.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { createStopShadow } from './stop-shadow-runner.mjs';
import { STOP_SPEC_VERSION } from './ai-stoploss-base.mjs';

const HOL = new Set(['2026-10-09', '2026-10-10']);
const isTD = ymd => { const d = new Date(`${ymd}T00:00:00Z`).getUTCDay(); return d !== 0 && d !== 6 && !HOL.has(ymd); };
const T = (ymd, h, m = 0) => Date.parse(`${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`);
const hasNestedArray = v => (Array.isArray(v) ? v.some(x => Array.isArray(x) || hasNestedArray(x)) : (v && typeof v === 'object' ? Object.values(v).some(hasNestedArray) : false));
const clone = v => JSON.parse(JSON.stringify(v));

/** 80 個交易日的官方日 K（到 2026-10-02），2330 在 100 附近 */
function archiveDays(lastYmd, n = 80) {
  const days = [];
  let d = new Date(`${lastYmd}T00:00:00Z`);
  while (days.length < n) {
    const ymd = d.toISOString().slice(0, 10);
    if (isTD(ymd)) days.unshift(ymd);
    d = new Date(d.getTime() - 86400000);
  }
  return days.map((date, i) => {
    const c = +(100 + 3 * Math.sin(i / 4) + i * 0.05).toFixed(1);
    // 2317／2454／2882（上市樣本）與 6274／8069／3260（上櫃樣本）讓 archiveDayStatus 判為兩市到齊
    const fill = Object.fromEntries(['2317', '2454', '2882', '6274', '8069', '3260'].map(k => [k, [50, 100, 50, 51, 49]]));
    return {
      date, closeJson: JSON.stringify({ ...fill, 2330: [c, 1000, +(c - 0.3).toFixed(1), +(c + 1).toFixed(1), +(c - 1).toFixed(1)] }),
      instJson: JSON.stringify({ 2330: [1, 1, 1], 6274: [1, 1, 1] }),
    };
  });
}

/** 記憶體版 store：介面同 stop-shadow-store.mjs；寫入時比照 Firestore 拒收巢狀陣列與 undefined */
function memStore({ archive, holdings, news = null }) {
  const db = { books: new Map(), days: new Map(), events: new Map(), audit: new Map(), calls: [] };
  const guard = (what, v) => {
    if (hasNestedArray(v)) throw new Error(`${what}: nested arrays are not supported`);
    if (JSON.stringify(v, (k, x) => (x === undefined ? '__undef__' : x)).includes('__undef__')) throw new Error(`${what}: undefined`);
  };
  const dayKey = (uid, ymd) => `${uid}|${ymd}`;
  const mergeDay = (uid, log) => {
    const k = dayKey(uid, log.ymd);
    const cur = db.days.get(k) ?? { date: log.ymd };
    for (const [kind, items] of Object.entries(log.arrays ?? {})) {
      const list = cur[kind] ?? [];
      for (const x of items) if (!list.some(y => JSON.stringify(y) === JSON.stringify(x))) list.push(clone(x));
      cur[kind] = list;
    }
    for (const [f, v] of Object.entries(log.fields ?? {})) cur[f] = clone(v);
    cur.updatedAt = log.at;
    guard('dayLog', cur);
    db.days.set(k, cur);
  };
  const store = {
    async getBook(uid) { db.calls.push('getBook'); return db.books.has(uid) ? clone(db.books.get(uid)) : null; },
    async saveBook(uid, enc, log) { db.calls.push('saveBook'); guard('book', enc); db.books.set(uid, clone(enc)); if (log) mergeDay(uid, log); },
    async appendDayLog(uid, log) { db.calls.push('appendDayLog'); mergeDay(uid, log); },
    async getDayLog(uid, ymd) { return db.days.has(dayKey(uid, ymd)) ? clone(db.days.get(dayKey(uid, ymd))) : null; },
    async getHoldings(uid) { return clone(holdings[uid] ?? []); },
    async getArchiveWindow(toYmd, n) { return archive.filter(d => d.date <= toYmd).sort((a, b) => b.date.localeCompare(a.date)).slice(0, n).map(({ date, closeJson }) => ({ date, closeJson })); },
    async scanArchiveRange(from, before, onPage) { const page = archive.filter(d => d.date >= from && d.date < before); if (page.length) onPage(page); return page.length; },
    async getArchiveDay(ymd) { const d = archive.find(x => x.date === ymd); return d ? { ...d, otcPending: false } : null; },
    async getNewsLatestUpdatedAt() { return news?.updatedAt ?? null; },
    async getNewsLatest() { return news; },
    async getNewsDay() { return news; },
    async getEventShadowRecent(before, n) { return [...db.events.values()].filter(d => d.date < before).sort((a, b) => b.date.localeCompare(a.date)).slice(0, n).map(d => ({ date: d.date, events: d.events })); },
    async setEventShadow(ymd, data) { guard('eventShadow', data); db.events.set(ymd, clone(data)); },
    async mergeAudit(ymd, data) { guard('audit', data); db.audit.set(ymd, { ...(db.audit.get(ymd) ?? {}), ...clone(data) }); },
    async incrementAudit(ymd, counts) { db.audit.set(ymd, { ...(db.audit.get(ymd) ?? {}), llmInc: clone(counts) }); },
    async getDividendCodesOn() { return []; },
  };
  return { store, db };
}

function setup({ news = null, archive = archiveDays('2026-10-02'), holdings = { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }, { id: 'e', code: '00878', name: '國泰永續高股息', buyPrice: 20, quantity: 2, buyDate: '2026-09-01' }] }, clock, extraDeps = {} } = {}) {
  const { store, db } = memStore({ archive, holdings, news });
  const marks = {};
  const done = [];
  const fetchCalls = [];
  const logs = [];
  let nowMs = clock ?? T('2026-10-05', 7, 0);
  const shadow = createStopShadow({
    store, log: m => logs.push(String(m)), getPremiumUsers: async () => Object.keys(holdings).map(id => ({ id })), isTradingDayIso: isTD,
    trainDone: () => false, fetchExright: async (from, to) => { fetchCalls.push([from, to]); return { items: [] }; },
    loadPriceFactors: async () => ({}), readExHistory: () => ({ from: '2022-07-01', to: '2026-09-30', items: [] }),
    fetchRiskSets: async () => ({ disp: new Set() }), readJobMarks: async () => ({ ...marks }),
    markJobDone: async (k, d) => { marks[k] = d; done.push([k, d]); }, now: () => nowMs, ...extraDeps,
  });
  return { shadow, db, archive, marks, done, fetchCalls, logs, setNow: ms => { nowMs = ms; } };
}

/** 本機官方鏡像（R8）的假讀取：ETF 00631L 的官方日 K（到 lastYmd，80 個交易日，在 40 附近）＋閘門結果；記錄呼叫 */
function mirrorStub({ lastYmd = '2026-10-02', n = 80, tailRun = n, fail = null } = {}) {
  const calls = [];
  const bars = archiveDays(lastYmd, n).map(({ date }, i) => {
    const c = +(40 + 1.2 * Math.sin(i / 4) + i * 0.02).toFixed(2);
    return { date, o: +(c - 0.1).toFixed(2), h: +(c + 0.4).toFixed(2), l: +(c - 0.4).toFixed(2), c, v: 5000 };
  });
  const load = async ({ kind, to, lastN }) => {
    calls.push({ kind, to, lastN });
    if (fail) throw new Error(fail);
    if (kind !== 'etf') return { barsByCode: {}, gates: { tailRun: 0, pendingTail: 0, minRun: 20, pass: false, lastDate: to } };
    return { barsByCode: { '00631L': bars.filter(b => b.date <= to) }, gates: { tailRun, pendingTail: 0, minRun: 20, pass: tailRun >= 20, lastDate: lastYmd } };
  };
  return { load, calls, bars };
}
const ETF_HOLD = { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }, { id: 'e', code: '00631L', name: '元大台灣50正2', buyPrice: 40, quantity: 2, buyDate: '2026-09-01' }] };

test('收盤結算（補跑前一交易日）→ 盤前刷新 → 盤中觸及：只寫停損簿與影子紀錄，若切換會送的一級記在 wouldPush；ETF 5 碼 noOfficialBars 不判定', async () => {
  const s = setup();
  assert.equal(await s.shadow.closeSettle('2026-10-02'), true);
  const b1 = s.db.books.get('u1');
  assert.equal(b1.phase, 'shadow'); assert.equal(b1.specVersion, STOP_SPEC_VERSION); assert.equal(b1.settledYmd, '2026-10-02');
  const p = b1.positions['2330'];
  assert.equal(p.lineInputs.dataDate, '2026-10-02');
  assert.ok(p.lines.bandLine > 0, 'ATR 帶由官方日 K 算出');
  assert.equal(p.linesStale, false);
  assert.equal(p.exGapBars, 0, '係數涵蓋到資料日');
  assert.equal(b1.positions['00878'].noOfficialBars, true);
  assert.deepEqual(s.fetchCalls, [['2026-10-01', '2026-10-02']], '除權息只抓歷史檔之後到資料日（全域一次）');
  assert.equal(hasNestedArray(b1), false);

  s.setNow(T('2026-10-05', 8, 47));
  assert.equal(await s.shadow.premarket('2026-10-05'), true);
  const b2 = s.db.books.get('u1');
  assert.equal(b2.premarketYmd, '2026-10-05');
  const stop = b2.positions['2330'].stop;
  assert.ok(stop >= 92, `停損 ${stop} ≥ 成本線 92`);

  s.setNow(T('2026-10-05', 10, 43));
  await s.shadow.beginRound();
  const prev = b2.positions['2330'].lineInputs.close;
  const quotes = {
    2330: { price: stop + 0.5, open: prev, high: prev + 0.5, low: stop - 0.5, volume: 2e6, live: true, liveAt: T('2026-10-05', 10, 42), revealAt: T('2026-10-05', 10, 42), realTrade: true, prev },
    '00878': { price: 15, open: 19, high: 19, low: 14.9, volume: 1e6, live: true, liveAt: T('2026-10-05', 10, 42), realTrade: true, prev: 20 },
  };
  await s.shadow.tick({ uid: 'u1', holdings: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }, { id: 'e', code: '00878', name: '國泰永續高股息', buyPrice: 20, quantity: 2, buyDate: '2026-09-01' }], quotes, analyses: { 2330: { stopLoss: 97.37 } } });
  const day = s.db.days.get('u1|2026-10-05');
  assert.equal(day.wouldPush.length, 1);
  assert.equal(day.wouldPush[0].type, 'stop'); assert.equal(day.wouldPush[0].code, '2330'); assert.equal(day.wouldPush[0].requireAck, true);
  const b3 = s.db.books.get('u1');
  assert.ok(b3.positions['2330'].episode, '觸及事件寫進停損簿');
  assert.deepEqual(b3.positions['2330'].legacy, { push: 97.37, discipline: 97.37, ratingBand: 97.37 }, '影子對照值來自持股分析，不另讀');
  assert.equal(b3.positions['00878'].episode ?? null, null, 'ETF 歸檔驗證前不判定');
  assert.ok(day.wouldDigest, '紀律彙總每人每日一次（前一交易日收盤已定版）');

  // 同一輪再跑一次：不重記同一則一級
  await s.shadow.tick({ uid: 'u1', holdings: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }], quotes, analyses: {} });
  assert.equal(s.db.days.get('u1|2026-10-05').wouldPush.length, 1);
  assert.ok(!s.db.calls.some(c => /alert|push/i.test(c) && !/DayLog|saveBook/.test(c)), '沒有任何推播或 alerts 寫入');
});

test('收盤結算：同一資料日只結算一次（settleEpisode 不重複）；對照、事件影子、公開計數（不含代號）都寫出', async () => {
  const archive = archiveDays('2026-10-05');
  const s = setup({ archive, holdings: { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }] } });
  assert.equal(await s.shadow.closeSettle('2026-10-02'), true);
  s.setNow(T('2026-10-05', 9, 30));
  await s.shadow.noteLegacy('u1', [{ type: 'stop', code: '2330', price: 90, threshold: 92, pnlPct: -10, at: T('2026-10-05', 9, 30) }, { type: 'take', code: '2330' }]);
  s.setNow(T('2026-10-05', 16, 50));
  assert.equal(await s.shadow.closeSettle('2026-10-05'), true);
  const b = s.db.books.get('u1');
  assert.equal(b.settledYmd, '2026-10-05');
  assert.equal(b.positions['2330'].lineInputs.dataDate, '2026-10-05');
  const snapshot = JSON.stringify(b);
  assert.equal(await s.shadow.closeSettle('2026-10-05'), true);
  assert.equal(JSON.stringify(s.db.books.get('u1')), snapshot, '重跑不再結算（closesBelow 等不重複累加）');
  const day = s.db.days.get('u1|2026-10-05');
  assert.deepEqual(day.legacySent.map(x => x.type), ['stop'], '只記停損類（take 不記）');
  assert.ok(day.compare && Array.isArray(day.compare.stop.legacyOnly));
  const ev = s.db.events.get('2026-10-05');
  assert.equal(ev.encoding, 'gzip-json');
  const unz = b => JSON.parse(gunzipSync(Buffer.from(b.data ?? b)).toString());
  assert.ok(Array.isArray(unz(ev.hitsGz)) && Array.isArray(unz(ev.missesGz)), '命中與漏網兩份紀錄（壓縮）');
  const audit = s.db.audit.get('2026-10-05');
  assert.equal(audit.phase, 'shadow');
  assert.equal(audit.shadow.books.positions, 1);
  assert.ok(!JSON.stringify(audit).includes('2330'), '公開計數不放代號');
});

test('step：今天的收盤結算要等資料到齊班車（trainDone）；成功才 markJobDone；盤前刷新 08:46 起一次', async () => {
  const archive = archiveDays('2026-10-05');
  const s = setup({ archive, clock: T('2026-10-05', 16, 50) });
  await s.shadow.step();
  assert.deepEqual(s.done, [], '班車未完成：不結算、不標記');
  assert.ok(!s.db.books.has('u1'));
  const s2 = setup({ archive, clock: T('2026-10-06', 8, 0) });
  await s2.shadow.step();
  assert.deepEqual(s2.done, [['stopShadowClose', '2026-10-05']], '開盤前補跑前一交易日（看歸檔到齊，不看時鐘）');
  s2.setNow(T('2026-10-06', 8, 50));
  await s2.shadow.step();
  assert.deepEqual(s2.done.map(x => x[0]), ['stopShadowClose', 'stopShadowPre']);
  await s2.shadow.step();
  assert.equal(s2.done.length, 2, '同日不重跑');
});

test('LLM 量測只累計計數，flush 以資料日寫入；非交易日記為最後交易日', async () => {
  const s = setup({ clock: T('2026-10-10', 12, 0) });
  s.shadow.recordLlm('holding', { push: [{ code: 'textMismatch' }], shadow: [] });
  await s.shadow.flushLlm();
  const a = s.db.audit.get('2026-10-08');
  assert.deepEqual(a.llmInc, { llm: { holding: { checked: 1, push: { textMismatch: 1 }, shadowChecked: 1, shadow: {} } } });
});

test('盤中新買進：先建立部位（今日買進不套帶、只有成本線）；非交易日持股變動的版本日記為最後交易日', async () => {
  const holdings = { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }] };
  const s = setup({ holdings });
  await s.shadow.closeSettle('2026-10-02');
  s.setNow(T('2026-10-05', 10, 0));
  await s.shadow.beginRound();
  const lots = [...holdings.u1, { id: 'b', code: '2317', name: '鴻海', buyPrice: 50, quantity: 2, buyDate: '2026-10-05' }];
  await s.shadow.tick({ uid: 'u1', holdings: lots, quotes: { 2317: { price: 50, open: 50, high: 50.5, low: 49.8, live: true, liveAt: T('2026-10-05', 9, 59), realTrade: true, prev: 50 } }, analyses: {} });
  const p = s.db.books.get('u1').positions['2317'];
  assert.equal(p.stopSource, 'cost'); assert.equal(p.stop, 46);
  assert.equal(p.tradeDate, '2026-10-05');
  assert.ok(p.startedAt > T('2026-10-05', 9, 0), '盤中版本（setToday 口徑）');
  // 非交易日（10/10 國慶）：持股紀錄已沒有 2317 ⇒ 刷新時移除
  s.setNow(T('2026-10-10', 11, 0));
  await s.shadow.step();
  assert.ok(!s.db.books.get('u1').positions['2317'], '出清的代號在非交易日刷新時移除');
  const s2 = setup({ holdings: { u1: [holdings.u1[0], { id: 'c', code: '2454', name: '聯發科', buyPrice: 1000, quantity: 1, buyDate: '2026-10-08' }] }, clock: T('2026-10-10', 11, 0) });
  await s2.shadow.step();
  const p2 = s2.db.books.get('u1').positions['2454'];
  assert.equal(p2.tradeDate, '2026-10-08');
  assert.equal(s2.db.books.get('u1').positions['2330'].tradeDate, '2026-10-08');
});

test('盤前刷新套用規則類利空事件收緊（類別權重分級）：只記 eventRecords 與二級 stopInfo（只寫文件），不產生一級', async () => {
  const at = T('2026-10-05', 7, 10);
  const v = {
    label: '利空', strength: '中', confidence: '低', certainty: '已確認', novelty: '首次', priced: '否', eventType: '法律', basis: 'content',
    challenged: true, at, pass: 'morning', n: 3, reason: '【規則】涉檢調搜索，法律判定前視為利空（AI 原判中性：公司聲明營運正常）',
    keyQuote: '調查局今日搜索公司總部', quoteVerified: 1, quoteFailed: 0,
  };
  const news = { date: '2026-10-05', targetDate: '2026-10-05', updatedAt: T('2026-10-05', 7, 20), lastPass: 'morning', verdictJson: JSON.stringify({ 2330: v }) };
  const s = setup({ news, holdings: { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }] } });
  await s.shadow.closeSettle('2026-10-02');
  s.setNow(T('2026-10-05', 8, 47));
  assert.equal(await s.shadow.premarket('2026-10-05'), true);
  const p = s.db.books.get('u1').positions['2330'];
  const day = s.db.days.get('u1|2026-10-05');
  // 前收 106.3、ATR 2：C16a（類別權重 0.90 ⇒ 強）收緊線＝floorTick(106.3 − max(1×2, 3%×106.3)) = 103，高於基礎停損（ATR 帶 99.7）
  assert.ok(day.eventRecords.some(r => r.code === '2330' && r.cls === 'C16a' && r.outcome === 'applied' && r.line === 103 && r.tier === 'strong'), JSON.stringify(day.eventRecords));
  assert.equal(p.stopSource, 'event'); assert.equal(p.stop, 103); assert.equal(p.baseStop, 99.7);
  assert.ok(day.wouldDocOnly.some(a => a.type === 'stopInfo' && a.sub === 'eventTighten'));
  assert.ok(!(day.wouldPush ?? []).length, '收緊本身不推播');
});

test('端到端（2026-10-06 R1）：非法律規則類別 label 維持 AI 原判中性、只記規則欄位 ⇒ 盤前刷新照樣辨識為規則類利空並收緊', async () => {
  const at = T('2026-10-05', 7, 10);
  const v = {
    label: '中性', strength: '弱', confidence: '中', certainty: '已確認', novelty: '首次', priced: '否', eventType: '其他', basis: 'content',
    challenged: true, at, pass: 'morning', n: 3, reason: '公司說明產線已恢復', keyQuote: '廠區昨晚發生火災', quoteVerified: 1, quoteFailed: 0,
    ruleClass: 'C17', ruleOverride: 'accident', ruleFacts: { C17: 'yes' }, aiOriginal: { label: '中性', reason: '公司說明產線已恢復' },
  };
  const news = { date: '2026-10-05', targetDate: '2026-10-05', updatedAt: T('2026-10-05', 7, 20), lastPass: 'morning', verdictJson: JSON.stringify({ 2330: v }) };
  const s = setup({ news, holdings: { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }] } });
  await s.shadow.closeSettle('2026-10-02');
  s.setNow(T('2026-10-05', 8, 47));
  assert.equal(await s.shadow.premarket('2026-10-05'), true);
  const p = s.db.books.get('u1').positions['2330'];
  const day = s.db.days.get('u1|2026-10-05');
  // C17 工安停工類別權重 0.70 ⇒ 強級，與 C16a 同一條收緊線 103
  assert.ok(day.eventRecords.some(r => r.code === '2330' && r.cls === 'C17' && r.outcome === 'applied' && r.line === 103 && r.tier === 'strong'), JSON.stringify(day.eventRecords));
  assert.equal(p.stopSource, 'event'); assert.equal(p.stop, 103);
  assert.ok(!(day.wouldPush ?? []).length, '收緊本身不推播');
  // 同一筆判別但事實沒答「是」⇒ 不收緊
  const s2 = setup({ news: { ...news, verdictJson: JSON.stringify({ 2330: { ...v, ruleFacts: { C17: 'no' } } }) }, holdings: { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }] } });
  await s2.shadow.closeSettle('2026-10-02');
  s2.setNow(T('2026-10-05', 8, 47));
  await s2.shadow.premarket('2026-10-05');
  assert.notEqual(s2.db.books.get('u1').positions['2330'].stopSource, 'event');
});

test('R8 ETF 官方日 K 由盤前讀本機官方鏡像供給：全域一次（不隨會員數）、組成線標 archive、影子照判定；收盤結算不覆蓋、留給下一次盤前；公開計數分開統計', async () => {
  const m = mirrorStub();
  const holdings = { ...ETF_HOLD, u2: [{ id: 'f', code: '00631L', name: '元大台灣50正2', buyPrice: 39, quantity: 1, buyDate: '2026-09-02' }] };
  const s = setup({ holdings, extraDeps: { loadOfficialBars: m.load } });
  await s.shadow.closeSettle('2026-10-02');
  assert.equal(s.db.books.get('u1').positions['00631L'].noOfficialBars, true, '盤前刷新前：還沒有官方日 K（同 R8 之前）');
  assert.equal(m.calls.length, 0, '收盤結算不讀鏡像');
  s.setNow(T('2026-10-05', 8, 47));
  assert.equal(await s.shadow.premarket('2026-10-05'), true);
  assert.deepEqual(m.calls, [{ kind: 'etf', to: '2026-10-02', lastN: 80 }], '兩位會員、同一資料日只讀一次（截至前一交易日、80 根）');
  const p = s.db.books.get('u1').positions['00631L'];
  assert.equal(p.noOfficialBars, false);
  assert.equal(p.lineInputs.archive, 'etf');
  assert.equal(p.lineInputs.dataDate, '2026-10-02');
  assert.ok(p.lines.bandLine > 0, 'ATR 帶由本機官方鏡像日 K 算出');
  assert.equal(p.linesStale, false);
  assert.ok(s.db.books.get('u2').positions['00631L'].lineInputs.archive === 'etf');
  assert.ok(s.logs.some(x => x.includes('ETF官方日 K（本機官方鏡像）至 2026-10-02')));
  // 盤中：影子期照 v1.1 判定（閘門 ⑥），若切換會送的一級記在 wouldPush
  s.setNow(T('2026-10-05', 10, 43));
  await s.shadow.beginRound();
  const stop = p.stop;
  const quotes = { '00631L': { price: stop - 0.2, open: stop + 0.5, high: stop + 0.6, low: stop - 0.3, volume: 1e6, live: true, liveAt: T('2026-10-05', 10, 42), revealAt: T('2026-10-05', 10, 42), realTrade: true, prev: p.lineInputs.close } };
  await s.shadow.tick({ uid: 'u1', holdings: ETF_HOLD.u1, quotes, analyses: {} });
  assert.ok(s.db.days.get('u1|2026-10-05').wouldPush.some(a => a.code === '00631L' && a.type === 'stop'));
  // 收盤結算：鏡像 22:40 才有當日資料 ⇒ 組成線不被 chipArchive／noBarsStub 覆蓋（資料日仍是前一交易日、linesStale 沿用棘輪），下一次盤前再供給
  const archive = archiveDays('2026-10-05');
  const s2 = setup({ archive, holdings: ETF_HOLD, extraDeps: { loadOfficialBars: m.load } });
  await s2.shadow.closeSettle('2026-10-02');
  s2.setNow(T('2026-10-05', 8, 47));
  await s2.shadow.premarket('2026-10-05');
  const before = s2.db.books.get('u1').positions['00631L'];
  s2.setNow(T('2026-10-05', 16, 50));
  assert.equal(await s2.shadow.closeSettle('2026-10-05'), true);
  const after = s2.db.books.get('u1').positions['00631L'];
  assert.deepEqual(after.lineInputs, before.lineInputs);
  assert.equal(after.noOfficialBars, false);
  assert.equal(after.stop, before.stop, '棘輪值沿用（不放寬）');
  const audit = s2.db.audit.get('2026-10-05').shadow;
  assert.equal(audit.books.officialArchive.etf.positions, 1, '公開計數分開統計（閘門 ⑥）');
  assert.deepEqual(audit.officialBars.etf, { to: '2026-10-02', ok: true, reason: null, tailRun: 80 });
  assert.ok(!JSON.stringify(audit).includes('00631L'), '公開計數不放代號');
});

test('R8 fail-closed：鏡像讀不到、或閘門沒過（連續完整 <20 日）⇒ 不供給、記 log；已供給過的持股不被覆蓋成 noOfficialBars（linesStale 沿用棘輪）', async () => {
  for (const [m, why] of [[mirrorStub({ fail: '找不到 _manifest.json' }), '讀檔失敗'], [mirrorStub({ tailRun: 12 }), '最近連續完整 12 個交易日（需 ≥20）']]) {
    const s = setup({ holdings: ETF_HOLD, extraDeps: { loadOfficialBars: m.load } });
    await s.shadow.closeSettle('2026-10-02');
    s.setNow(T('2026-10-05', 8, 47));
    assert.equal(await s.shadow.premarket('2026-10-05'), true, '鏡像不可用不擋盤前刷新');
    const p = s.db.books.get('u1').positions['00631L'];
    assert.equal(p.noOfficialBars, true, why);
    assert.equal(p.lineInputs.archive, undefined);
    assert.ok(s.logs.some(x => x.includes('本機鏡像不可用') && x.includes(why)), why);
    assert.equal(s.db.books.get('u1').positions['2330'].noOfficialBars, false, '4 碼股票不受影響');
  }
  // 前一天已供給、今天鏡像缺資料日 ⇒ 不覆蓋：同一份組成線、資料日落後 ⇒ linesStale（同 chipArchive 資料延遲）
  const ok = mirrorStub();
  const s = setup({ archive: archiveDays('2026-10-05'), holdings: ETF_HOLD, extraDeps: { loadOfficialBars: async o => (o.to === '2026-10-02' ? ok.load(o) : { barsByCode: {}, gates: { tailRun: 0, pendingTail: 1, minRun: 20, pass: false, lastDate: o.to } }) } });
  await s.shadow.closeSettle('2026-10-02');
  s.setNow(T('2026-10-05', 8, 47));
  await s.shadow.premarket('2026-10-05');
  const p1 = s.db.books.get('u1').positions['00631L'];
  s.setNow(T('2026-10-05', 16, 50));
  await s.shadow.closeSettle('2026-10-05');
  s.setNow(T('2026-10-06', 8, 47));
  await s.shadow.premarket('2026-10-06');
  const p2 = s.db.books.get('u1').positions['00631L'];
  assert.deepEqual(p2.lineInputs, p1.lineInputs);
  assert.equal(p2.noOfficialBars, false);
  assert.equal(p2.linesStale, true);
  assert.ok(p2.stop >= p1.stop, '棘輪值沿用、不放寬');
  assert.ok(s.logs.some(x => x.includes('資料日 2026-10-05 鏡像尚未抓齊')));
});

test('R8 興櫃：身分以官方興櫃表為準（chipArchive 沒有它、官方興櫃表有它）——不以代號猜；閘門沒過（累積不足 20 日）fail-closed', async () => {
  const { bars } = mirrorStub();
  const calls = [];
  const loader = pass => async ({ kind, to }) => {
    calls.push(kind);
    return kind === 'emerging'
      ? { barsByCode: { 7777: bars.filter(b => b.date <= to) }, gates: { tailRun: pass ? 80 : 3, pendingTail: 0, minRun: 20, pass, lastDate: to } }
      : { barsByCode: {}, gates: { tailRun: 80, pendingTail: 0, minRun: 20, pass: true, lastDate: to } };
  };
  const holdings = { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }, { id: 'g', code: '7777', name: '興櫃股', buyPrice: 40, quantity: 1, buyDate: '2026-09-01' }] };
  const s = setup({ holdings, extraDeps: { loadOfficialBars: loader(true) } });
  await s.shadow.closeSettle('2026-10-02');
  assert.equal(s.db.books.get('u1').positions['7777'].noOfficialBars, true, 'chipArchive 沒有它的日 K');
  s.setNow(T('2026-10-05', 8, 47));
  await s.shadow.premarket('2026-10-05');
  assert.deepEqual(calls, ['emerging'], '沒有 ETF 持股就不讀 ETF 鏡像');
  const p = s.db.books.get('u1').positions['7777'];
  assert.deepEqual([p.noOfficialBars, p.lineInputs.archive], [false, 'emerging']);
  assert.equal(s.db.books.get('u1').positions['2330'].lineInputs.archive, undefined, '4 碼上市櫃股票照走 chipArchive');
  // 閘門沒過（興櫃從 10/02 起才累積，R6）⇒ 不供給
  const s2 = setup({ holdings, extraDeps: { loadOfficialBars: loader(false) } });
  await s2.shadow.closeSettle('2026-10-02');
  s2.setNow(T('2026-10-05', 8, 47));
  await s2.shadow.premarket('2026-10-05');
  assert.equal(s2.db.books.get('u1').positions['7777'].noOfficialBars, true);
  assert.ok(s2.logs.some(x => x.includes('興櫃官方日 K 本機鏡像不可用（最近連續完整 3 個交易日（需 ≥20））')));
  // 官方興櫃表沒有它 ⇒ 不是興櫃：照原路徑（不改停損簿這一檔）
  const s3 = setup({ holdings: { u1: [holdings.u1[0], { ...holdings.u1[1], code: '8888' }] }, extraDeps: { loadOfficialBars: loader(true) } });
  await s3.shadow.closeSettle('2026-10-02');
  const b0 = s3.db.books.get('u1').positions['8888'];
  s3.setNow(T('2026-10-05', 8, 47));
  await s3.shadow.premarket('2026-10-05');
  assert.deepEqual(s3.db.books.get('u1').positions['8888'].lineInputs, b0.lineInputs);
});

/** ETF 00631L 的本機鏡像假讀取：mirrorStub 的日 K（到 10/02）＋測試中途加的日 K（extra）；閘門的最後交易日＝讀到的最後一根 */
function mirrorWithExtra() {
  const { bars } = mirrorStub();
  const extra = [];
  const calls = [];
  const load = async ({ kind, to, lastN }) => {
    calls.push({ kind, to });
    if (kind !== 'etf') return { barsByCode: {}, gates: { tailRun: 0, pendingTail: 0, minRun: 20, pass: false, lastDate: to } };
    const bs = [...bars, ...extra].filter(b => b.date <= to).slice(-lastN);
    return { barsByCode: { '00631L': bs }, gates: { tailRun: 80, pendingTail: 0, minRun: 20, pass: true, lastDate: bs[bs.length - 1].date } };
  };
  return { load, calls, extra };
}
const r2 = v => Math.round(v * 100) / 100;

test('R8 鏡像代號的收盤結算移到下一交易日盤前（2026-10-06 審查）：16:45 不動這類持股；隔日盤前以鏡像的前一交易日日K結算觸及事件', async () => {
  const m = mirrorWithExtra();
  const s = setup({ archive: archiveDays('2026-10-05'), holdings: ETF_HOLD, extraDeps: { loadOfficialBars: m.load } });
  await s.shadow.closeSettle('2026-10-02');
  s.setNow(T('2026-10-05', 8, 47));
  await s.shadow.premarket('2026-10-05');
  const p = s.db.books.get('u1').positions['00631L'];
  const stop = p.stop, prev = p.lineInputs.close;
  s.setNow(T('2026-10-05', 10, 43));
  await s.shadow.beginRound();
  const quotes = { '00631L': { price: r2(stop - 0.2), open: r2(stop + 0.5), high: r2(stop + 0.6), low: r2(stop - 0.3), volume: 1e6, live: true, liveAt: T('2026-10-05', 10, 42), revealAt: T('2026-10-05', 10, 42), realTrade: true, prev } };
  await s.shadow.tick({ uid: 'u1', holdings: ETF_HOLD.u1, quotes, analyses: {} });
  assert.equal(s.db.books.get('u1').positions['00631L'].episode.firstDate, '2026-10-05');
  s.setNow(T('2026-10-05', 16, 50));
  await s.shadow.closeSettle('2026-10-05');
  const atClose = s.db.books.get('u1').positions['00631L'];
  assert.ok(atClose.episode, '收盤結算不動鏡像代號（鏡像 22:40 才有當日資料）');
  assert.equal(atClose.lineInputs.dataDate, '2026-10-02');
  assert.equal(atClose.linesStale, false, '不再以前一份組成線在收盤時判 linesStale');
  assert.equal(s.db.books.get('u1').positions['2330'].lineInputs.dataDate, '2026-10-05', '4 碼股票照常收盤結算');
  // 鏡像 10/05 收盤遠高於停損×1.02 ⇒ 隔日盤前結算 ⇒ 事件結束（原本永遠不結算）
  m.extra.push({ date: '2026-10-05', o: r2(stop + 0.5), h: r2(stop * 1.1 + 0.2), l: r2(stop - 0.3), c: r2(stop * 1.1), v: 5000 });
  s.setNow(T('2026-10-06', 8, 47));
  assert.equal(await s.shadow.premarket('2026-10-06'), true);
  const p2 = s.db.books.get('u1').positions['00631L'];
  assert.equal(p2.episode, null, '觸及事件以鏡像收盤結算');
  assert.equal(p2.lineInputs.dataDate, '2026-10-05');
  assert.equal(p2.lineInputs.archive, 'etf');
  assert.ok(m.calls.some(c => c.kind === 'etf' && c.to === '2026-10-05'));
  assert.deepEqual(s.db.books.get('u1').verifiedArchives, [], '停損簿文件帶 verifiedArchives（前端 bookStopOf 同一份）');
});

test('R8 鏡像代號的收盤後補判（2026-10-06 審查）：盤中沒判到、鏡像日低 ≤ 停損 ⇒ 隔日盤前補判（sub late）記進前一交易日 shadowDays、重算對照；紀律彙總補鏡像前收', async () => {
  const m = mirrorWithExtra();
  const s = setup({ archive: archiveDays('2026-10-05'), holdings: ETF_HOLD, extraDeps: { loadOfficialBars: m.load, verifiedArchives: ['etf', 'bogus'] } });
  await s.shadow.closeSettle('2026-10-02');
  s.setNow(T('2026-10-05', 8, 47));
  await s.shadow.premarket('2026-10-05');
  const stop = s.db.books.get('u1').positions['00631L'].stop;
  s.setNow(T('2026-10-05', 16, 50));
  await s.shadow.closeSettle('2026-10-05');
  assert.ok(!(s.db.days.get('u1|2026-10-05')?.wouldPush ?? []).some(a => a.code === '00631L'), '收盤時沒有這檔的補判');
  m.extra.push({ date: '2026-10-05', o: r2(stop + 0.3), h: r2(stop + 0.5), l: r2(stop - 0.2), c: r2(stop - 0.1), v: 5000 });
  s.setNow(T('2026-10-06', 8, 47));
  await s.shadow.premarket('2026-10-06');
  const day5 = s.db.days.get('u1|2026-10-05');
  const late = day5.wouldPush.filter(a => a.code === '00631L');
  assert.deepEqual(late.map(a => [a.type, a.sub, a.price]), [['stop', 'late', r2(stop - 0.1)]], '補判記在資料日（前一交易日）的紀錄');
  assert.deepEqual(day5.compare.stop.v11Only, ['00631L'], '前一交易日的對照重算');
  assert.ok(day5.missedLive.includes('00631L'));
  const ep = s.db.books.get('u1').positions['00631L'].episode;
  assert.deepEqual([ep.firstDate, ep.closesBelow], ['2026-10-05', 1]);
  assert.deepEqual(s.db.books.get('u1').verifiedArchives, ['etf'], '只收 etf／emerging');
  // 同一交易日再跑盤前：不重複補判（premarketYmd 擋）
  await s.shadow.premarket('2026-10-06');
  assert.equal(s.db.days.get('u1|2026-10-05').wouldPush.filter(a => a.code === '00631L').length, 1);
  // 10/06 盤中第一輪：紀律彙總的前一交易日收盤對 ETF 用鏡像收盤（chipArchive 沒有這類代號）
  s.setNow(T('2026-10-06', 9, 30));
  await s.shadow.beginRound();
  await s.shadow.tick({ uid: 'u1', holdings: ETF_HOLD.u1, quotes: {}, analyses: {} });
  assert.deepEqual(s.db.days.get('u1|2026-10-06').wouldDigest.codes, ['00631L']);
});

test('R8 興櫃轉上市櫃（2026-10-06 審查）：chipArchive 當日有這檔 ⇒ 收盤結算改走 chipArchive、組成線不再標 archive；之後盤前不再當興櫃', async () => {
  const { bars } = mirrorStub();
  const calls = [];
  const load = async ({ kind, to }) => {
    calls.push({ kind, to });
    return kind === 'emerging'
      ? { barsByCode: { 7777: bars.filter(b => b.date <= to) }, gates: { tailRun: 80, pendingTail: 0, minRun: 20, pass: true, lastDate: to } }
      : { barsByCode: {}, gates: { tailRun: 80, pendingTail: 0, minRun: 20, pass: true, lastDate: to } };
  };
  // 10/05 起 7777 進 chipArchive（轉上櫃）；興櫃表最後一列停在 10/02
  const archive = archiveDays('2026-10-05').map(d => (d.date === '2026-10-05' ? { ...d, closeJson: JSON.stringify({ ...JSON.parse(d.closeJson), 7777: [42, 800, 41, 43, 40.5] }) } : d));
  const holdings = { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }, { id: 'g', code: '7777', name: '轉板股', buyPrice: 40, quantity: 1, buyDate: '2026-09-01' }] };
  const s = setup({ archive, holdings, extraDeps: { loadOfficialBars: load } });
  await s.shadow.closeSettle('2026-10-02');
  s.setNow(T('2026-10-05', 8, 47));
  await s.shadow.premarket('2026-10-05');
  assert.equal(s.db.books.get('u1').positions['7777'].lineInputs.archive, 'emerging');
  s.setNow(T('2026-10-05', 16, 50));
  await s.shadow.closeSettle('2026-10-05');
  const p = s.db.books.get('u1').positions['7777'];
  assert.equal(p.lineInputs.archive, undefined, '改走 chipArchive（原本會一直沿用興櫃舊日 K）');
  assert.deepEqual([p.lineInputs.dataDate, p.lineInputs.close, p.noOfficialBars], ['2026-10-05', 42, false]);
  assert.ok(s.logs.some(x => x.includes('興櫃轉上市櫃 1 檔')));
  s.setNow(T('2026-10-06', 8, 47));
  await s.shadow.premarket('2026-10-06');
  assert.ok(!calls.some(c => c.to === '2026-10-05'), '之後盤前不再當興櫃、不讀興櫃鏡像');
  const p2 = s.db.books.get('u1').positions['7777'];
  assert.deepEqual([p2.lineInputs.archive, p2.lineInputs.dataDate, p2.linesStale], [undefined, '2026-10-05', false]);
});

test('收盤結算失敗的重試（2026-10-05 審查）：只重試失敗的會員、沿用同一資料日的歸檔視窗、全域紀錄只寫一次；退避且有次數上限', async () => {
  const holdings = {
    u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }],
    u2: [{ id: 'b', code: '2330', name: '台積電', buyPrice: 98, quantity: 1, buyDate: '2026-09-01' }],
  };
  let windowReads = 0, eventWrites = 0, getHoldingsU2 = 0, failU2 = 2;
  // 包一層記憶體 store：u2 前兩次讀持股失敗；記錄歸檔視窗讀取與事件影子寫入次數
  const mem = memStore({ archive: archiveDays('2026-10-02'), holdings });
  const wrapped = {
    ...mem.store,
    async getArchiveWindow(...a) { windowReads += 1; return mem.store.getArchiveWindow(...a); },
    async setEventShadow(...a) { eventWrites += 1; return mem.store.setEventShadow(...a); },
    async getHoldings(uid) { if (uid === 'u2') { getHoldingsU2 += 1; if (failU2-- > 0) throw new Error('暫時讀不到'); } return mem.store.getHoldings(uid); },
  };
  const marks = {};
  let nowMs = T('2026-10-05', 7, 0);
  const shadow = createStopShadow({
    store: wrapped, log: () => {}, getPremiumUsers: async () => [{ id: 'u1' }, { id: 'u2' }], isTradingDayIso: isTD,
    trainDone: () => false, fetchExright: async () => ({ items: [] }), loadPriceFactors: async () => ({}),
    readExHistory: () => ({ from: '2022-07-01', to: '2026-09-30', items: [] }), fetchRiskSets: async () => ({ disp: new Set() }),
    readJobMarks: async () => ({ ...marks }), markJobDone: async (k, d) => { marks[k] = d; }, now: () => nowMs,
  });
  // 第 1 次：u1 結算、u2 失敗 ⇒ 不標完成；全域紀錄寫一次
  assert.equal(await shadow.closeSettle('2026-10-02'), false);
  assert.equal(mem.db.books.get('u1').settledYmd, '2026-10-02');
  assert.ok(!mem.db.books.has('u2'));
  assert.equal(eventWrites, 1);
  assert.equal(mem.db.audit.get('2026-10-02').shadow.failedUsers, 1);
  // step 的退避：第 1 次失敗後 10 分鐘內不重跑
  await shadow.step();   // 07:00 之後第一次 step：closeNextAt 為 0 ⇒ 第 2 次嘗試（u2 仍失敗）
  assert.equal(marks.stopShadowClose, undefined);
  assert.equal(getHoldingsU2, 2);
  nowMs += 9 * 60000;
  await shadow.step();
  assert.equal(getHoldingsU2, 2, '第 2 次失敗後退避 30 分鐘：9 分鐘後不重跑');
  nowMs += 25 * 60000;
  await shadow.step();
  assert.equal(getHoldingsU2, 3);
  assert.equal(marks.stopShadowClose, '2026-10-02', '只重試 u2，成功後標完成');
  assert.equal(mem.db.books.get('u2').settledYmd, '2026-10-02');
  assert.equal(windowReads, 1, '同一資料日的歸檔視窗只讀一次');
  assert.equal(eventWrites, 1, '全域紀錄不重寫');
  assert.deepEqual(mem.db.audit.get('2026-10-02').shadowRetry, { attempts: 3, settledUsers: 2, failedUsers: 0, gaveUp: false });
});

test('收盤結算一直失敗：到次數上限就停止重試並記下未結算人數（不無限重跑）', async () => {
  const holdings = { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }] };
  const mem = memStore({ archive: archiveDays('2026-10-02'), holdings });
  let reads = 0;
  const wrapped = { ...mem.store, async getHoldings() { reads += 1; throw new Error('一直讀不到'); } };
  const shadow = createStopShadow({
    store: wrapped, log: () => {}, getPremiumUsers: async () => [{ id: 'u1' }], isTradingDayIso: isTD,
    fetchExright: async () => ({ items: [] }), loadPriceFactors: async () => ({}), readExHistory: () => ({ from: '2022-07-01', to: '2026-09-30', items: [] }),
    now: () => T('2026-10-05', 7, 0),
  });
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await shadow.closeSettle('2026-10-02'));
  assert.deepEqual(results.slice(0, 5), [false, false, false, false, true], '第 5 次到上限 ⇒ 回 true（標完成、不再重試）');
  assert.equal(mem.db.audit.get('2026-10-02').shadowRetry.gaveUp, true);
  assert.equal(mem.db.audit.get('2026-10-02').shadowRetry.failedUsers, 1);
  assert.ok(reads >= 5);
});
