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

function setup({ news = null, archive = archiveDays('2026-10-02'), holdings = { u1: [{ id: 'a', code: '2330', name: '台積電', buyPrice: 100, quantity: 1, buyDate: '2026-09-01' }, { id: 'e', code: '00878', name: '國泰永續高股息', buyPrice: 20, quantity: 2, buyDate: '2026-09-01' }] }, clock } = {}) {
  const { store, db } = memStore({ archive, holdings, news });
  const marks = {};
  const done = [];
  const fetchCalls = [];
  let nowMs = clock ?? T('2026-10-05', 7, 0);
  const shadow = createStopShadow({
    store, log: () => {}, getPremiumUsers: async () => Object.keys(holdings).map(id => ({ id })), isTradingDayIso: isTD,
    trainDone: () => false, fetchExright: async (from, to) => { fetchCalls.push([from, to]); return { items: [] }; },
    loadPriceFactors: async () => ({}), readExHistory: () => ({ from: '2022-07-01', to: '2026-09-30', items: [] }),
    fetchRiskSets: async () => ({ disp: new Set() }), readJobMarks: async () => ({ ...marks }),
    markJobDone: async (k, d) => { marks[k] = d; done.push([k, d]); }, now: () => nowMs,
  });
  return { shadow, db, archive, marks, done, fetchCalls, setNow: ms => { nowMs = ms; } };
}

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
