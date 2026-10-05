// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1·影子試算（S3）流程——daemon 以動態 import 載入（載入失敗只停用影子，現行停損推播不受影響）。
//
// 影子期＝線上照第一階段（checkAlerts／trackStopDiscipline／checkCrashDefense 的現行算法一行不改），daemon 另算 v1.1：
//   ① 盤前刷新（交易日 08:46 起；markJobDone 'stopShadowPre'）：planBookRefresh(premarket)——除權息、盤後／夜補／晨間趟的規則類利空事件收緊、到期移除。
//   ② 盤中（checkAlerts 每輪、每位會員；同一份快照報價）：planUserStopTick——觸及判定、觸及事件、盤中趟事件；紀律彙總每人每日一次。
//   ③ 收盤結算（資料到齊班車完成後；markJobDone 'stopShadowClose'）：planCloseSettle——收盤後補判、事件結算、官方日 K 組成線換版、
//      延後的事件收緊；對照（舊制實際送出 vs v1.1 若切換會送出）、全市場事件收緊命中與漏網、公開計數。
//   ④ 非交易日每小時：持股變動 → planBookRefresh(nontrading)（版本日＝最後交易日）。
// 只寫 stopBooks/{uid}（＋shadowDays 紀錄）、stopEventShadow、stopSpecAudit；**不推播、不寫 alerts、不讀寫 _hwm**。
// 上游請求：除權息區間（官方 TWT49U／exDailyQ，已登錄核准）每日約 1 次（2 個請求），與會員數無關；MIS 0；Ollama 0。
// ETF／興櫃官方日 K（使用者 2026-10-06 R8「ok 如建議」）：盤前刷新時由 daemon 讀本機官方鏡像（second-brain/official；
//   deps.loadOfficialBars＝official-bars.readOfficialBarsAsync）——只讀本機檔、0 次 Firestore 讀寫、0 上游請求，每個資料日每種讀一次
//   （全域，與會員數無關）。讀不到或閘門 ①②③ 沒過 ⇒ fail-closed（不用、不捏造）並記 log；組成線標 lineInputs.archive，
//   歸檔驗證並經使用者核可前（verifiedArchives 不含該種類）live 時舊分支照跑、v1.1 不發警示（ai-stoploss-plan unverifiedArchiveOf）。
//   鏡像當日資料 22:40 才有 ⇒ 這類持股的收盤結算（補判、事件結算、組成線換版、延後的事件收緊）不在 16:45 跑，改在下一交易日盤前
//   讀到鏡像（資料日＝前一交易日）時補跑（mirrorSettle）；興櫃轉上市櫃（chipArchive 當日有它）⇒ 收盤結算改走 chipArchive。
//   每次寫停損簿一併寫 verifiedArchives（前端 bookStopOf 與 daemon 同一份）。
// 規範 .claude/skills/tw-ai-stoploss/SKILL.md「生效範圍」、§11；實作計畫 warroom/stoploss/v1.1/impl-plan.md §2.1、§2.9。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import {
  STOP_SPEC_VERSION, STOP_PARAMS, EMPTY_EX_TABLE, aggregatePositions, exTableFor, hasOfficialBars, lineInputsOf, adjustBars, isEtfCode,
  planBookRefresh, planUserStopTick, planCloseSettle, planDisciplineDigest, ruleBearEvents, eventShadowRows, missShadowRows, prevTradingYmd,
  barArchiveOf,
} from './ai-stoploss.mjs';
import { gzipSync } from 'node:zlib';
import { newsBoardFromDoc } from './warroom-news.mjs';
import { archiveDayStatus, archiveCloseReady } from './canonical-gate.mjs';
import { taipeiYmd, taipeiMinuteOfDay } from './warroom-session.mjs';
import {
  SHADOW_PHASE, BAR_WINDOW, EVENT_LOOKBACK_DAYS, DEEP_MAX_DOCS,
  encodeBook, decodeBook, applyBookPatch, samePositions, stableJson, barsFromCloseDocs, concatBars, exFetchRange, exItemsMerge,
  legacyOf, compareShadowDay, bookAuditCounts, dayAuditCounts, closeTargetOf, premarketDue, taipeiMs, eventMinAtMs, noBarsStub, logKeyOf,
  officialBarsVerdict,
} from './stop-shadow-core.mjs';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isPos = v => typeof v === 'number' && Number.isFinite(v) && v > 0;
const arr = v => (Array.isArray(v) ? v : []);
const msg = e => String(e?.message ?? e ?? '').slice(0, 80);
const LOG_KINDS = ['wouldPush', 'wouldDocOnly', 'eventRecords', 'legacySent'];
const LEGACY_TYPES = new Set(['stop', 'trailing', 'discipline']);
const RETRY_MS = 10 * 60000;
/**
 * 收盤結算失敗（會員讀取／寫入錯誤、全域紀錄寫入失敗）後的重試：第 1～4 次失敗後各隔 10／30／60／60 分鐘，總共最多 CLOSE_MAX_ATTEMPTS 次
 * （2026-10-05 審查：原本任一位會員失敗就整段每 10 分鐘重跑到隔日 08:46，每次重讀 80 份歸檔、新聞日檔、事件影子歷史並重寫全域紀錄）。
 * 重試只跑失敗的會員、沿用記憶體裡同一資料日的歸檔視窗與往前讀的日 K；全域紀錄（事件影子、公開計數）成功一次就不再重寫。
 * 歸檔還不在（資料未到齊）不算失敗，照 RETRY_MS 等。到上限仍有人失敗 ⇒ 停止重試、標記完成，未結算人數記進 stopSpecAudit.shadowRetry。
 */
const CLOSE_BACKOFF_MS = Object.freeze([10, 30, 60, 60].map(m => m * 60000));
const CLOSE_MAX_ATTEMPTS = 5;
/** stopEventShadow/{date} 兩份壓縮紀錄的預算（Firestore 單文件 1,048,576 bytes，留給 events 與其他欄位） */
const EVENT_DOC_BUDGET = 800_000;
/** 本機官方鏡像供給的歸檔種類（R8）與 log 用的名稱 */
const ARCHIVE_TEXT = Object.freeze({ etf: 'ETF', emerging: '興櫃' });
const mirrorArchiveOf = li => (li && (li.archive === 'etf' || li.archive === 'emerging') ? li.archive : null);
/** 某資料日是這檔的除權息日、而停損簿還沒依係數調整 ⇒ 收盤補判不判定（同 exPending） */
const exPendingOn = (t, bp, ymd) => arr(t?.events).some(([d]) => d === ymd) && !arr(bp?.exApplied).includes(ymd);
/** 民國 YYYMMDD（dividendCalendar 的日期格式） */
const rocOf = ymd => `${Number(ymd.slice(0, 4)) - 1911}${ymd.slice(5, 7)}${ymd.slice(8, 10)}`;

/**
 * deps：{ store（stop-shadow-store 介面）, log, getPremiumUsers, isTradingDayIso(ymd), trainDone(ymd)（資料到齊班車今日完成）,
 *   fetchExright(from,to), loadPriceFactors(), readExHistory(), fetchRiskSets(), readJobMarks(), markJobDone(key, ymd), now(),
 *   loadOfficialBars({ kind, to, lastN })（選用；本機官方鏡像的 ETF／興櫃日 K，回 { barsByCode, gates }；沒給＝不供給，同 R8 之前）,
 *   verifiedArchives（選用；已驗證並經使用者核可的歸檔種類，預設空）}
 */
export function createStopShadow(deps) {
  const {
    store, log = () => {}, getPremiumUsers, isTradingDayIso, trainDone = () => false, fetchExright, loadPriceFactors,
    readExHistory, fetchRiskSets = async () => null, readJobMarks = async () => ({}), markJobDone = async () => {}, now = () => Date.now(),
    loadOfficialBars = null, verifiedArchives = [],
  } = deps;
  const isTD = ymd => { try { return isTradingDayIso(ymd) === true; } catch { return false; } };
  const shadowYmd = ms => { const t = taipeiYmd(ms); return isTD(t) ? t : (prevTradingYmd(t, isTD) ?? t); };
  /** 寫進停損簿文件的已驗證歸檔種類（前端 bookStopOf 讀同一份；2026-10-06 審查） */
  const verifiedList = Object.freeze([...new Set(verifiedArchives instanceof Set ? verifiedArchives : arr(verifiedArchives))]
    .filter(a => a === 'etf' || a === 'emerging').sort());

  const books = new Map();          // uid → 停損簿（null＝確認不存在）
  const locks = new Map();          // uid → 排隊中的寫入（盤中、盤前、收盤三條路徑互斥）
  const logged = new Map();         // `${uid}|${ymd}` → 已記的影子紀錄鍵
  const digestDone = new Set();     // `${uid}|${ymd}`
  const llm = new Map();            // 資料日 → LLM 量測計數（只放計數）
  let history; let ex = null; let exByCode = null; let exFailAt = 0;
  let news = { ymd: null, updatedAt: undefined, events: [] };
  let disp = { ymd: null, set: new Set(), at: 0 };
  let exPend = { ymd: null, codes: new Set() };
  let prevCloses = { ymd: null, map: null, at: 0 };
  let marks = null;
  let closeNextAt = 0, preNextAt = 0, nontradingAt = 0;
  const official = new Map();       // 歸檔種類 → { to, ok, reason, barsByCode, tailRun }（本機官方鏡像；每個資料日每種讀一次）
  /** 同一資料日的收盤結算狀態（重試沿用）：{ ymd, attempts, docs, deep, deepCodes, globalDone, pending:Set<uid>|null, settled } */
  let closeRun = null;
  const stats = { ticks: 0, writes: 0, errors: 0 };

  function withUser(uid, fn) {
    const prev = locks.get(uid) ?? Promise.resolve();
    const run = prev.then(() => fn());
    const tail = run.catch(() => {});
    locks.set(uid, tail);
    tail.then(() => { if (locks.get(uid) === tail) locks.delete(uid); });
    return run;
  }

  async function loadBook(uid) {
    if (books.has(uid)) return books.get(uid);
    const b = decodeBook(await store.getBook(uid));
    books.set(uid, b);
    return b;
  }

  // ── 影子紀錄（同一則只記一次；重啟後讀回當日紀錄再比對） ──
  async function loggedSet(uid, ymd) {
    const k = `${uid}|${ymd}`;
    if (logged.has(k)) return logged.get(k);
    const set = new Set();
    try {
      const d = await store.getDayLog(uid, ymd);
      for (const kind of LOG_KINDS) for (const x of Array.isArray(d?.[kind]) ? d[kind] : []) { const key = logKeyOf(kind, x); if (key) set.add(`${kind}|${key}`); }
    } catch { /* 讀不到就只用記憶體去重（重啟後可能重記一次，只影響紀錄筆數，不影響推播） */ }
    if (logged.size > 2000) for (const key of logged.keys()) if (!key.endsWith(`|${ymd}`)) logged.delete(key);
    logged.set(k, set);
    return set;
  }
  async function dayLogOf(uid, ymd, arrays, fields, at) {
    const set = await loggedSet(uid, ymd);
    const out = {}, local = new Set();
    let n = 0;
    for (const [kind, items] of Object.entries(arrays ?? {})) {
      const fresh = [];
      for (const x of Array.isArray(items) ? items : []) {
        const key = logKeyOf(kind, x);
        const kk = `${kind}|${key}`;
        if (!key || set.has(kk) || local.has(kk)) continue;
        local.add(kk);
        fresh.push(x);
      }
      if (fresh.length) { out[kind] = fresh; n += fresh.length; }
    }
    if (!n && !fields) return null;
    return { ymd, at, arrays: out, fields: fields ?? null, commit: () => { for (const kk of local) set.add(kk); } };
  }
  async function saveBook(uid, next0, dayLog) {
    const next = { ...next0, verifiedArchives: [...verifiedList] };
    await store.saveBook(uid, encodeBook(next), dayLog);
    books.set(uid, next);
    dayLog?.commit();
    stats.writes += 1;
  }
  async function appendLog(uid, dayLog) {
    if (!dayLog) return;
    await store.appendDayLog(uid, dayLog);
    dayLog.commit();
  }

  // ── 除權息係數：歷史檔＋歷史檔之後到資料日的官方區間（每資料日最多成功一次；失敗 10 分鐘內不重打） ──
  function exHistory() {
    if (history === undefined) {
      try { history = readExHistory(); } catch (e) { history = null; log(`  ⚠ 停損影子：讀不到除權息歷史檔（組成線會因係數涵蓋不足不採用）：${msg(e)}`); }
    }
    return history;
  }
  async function exUpTo(toYmd) {
    if (!toYmd || (ex && ex.cover.to >= toYmd)) return ex;
    const h = exHistory();
    if (!h) return ex;
    const range = exFetchRange(h, toYmd);
    let recent = null;
    if (range) {
      if (now() - exFailAt < RETRY_MS) return ex;
      try { recent = (await fetchExright(range.from, range.to))?.items ?? null; } catch (e) { exFailAt = now(); log(`  ⚠ 停損影子：除權息區間 ${range.from}~${range.to} 取不到（係數涵蓋停在 ${h.to}）：${msg(e)}`); }
    }
    let pf = null;
    try { pf = await loadPriceFactors(); } catch (e) { log(`  ⚠ 停損影子：價格結構事件讀取失敗（減資／面額變更本輪不還原）：${msg(e)}`); }
    const merged = exItemsMerge({ history: h, recent, recentRange: recent ? range : null, priceFactors: pf });
    if (merged && (!ex || merged.cover.to >= ex.cover.to)) {
      ex = merged;
      exByCode = new Map();
      for (const it of merged.items) { if (!exByCode.has(it.code)) exByCode.set(it.code, []); exByCode.get(it.code).push(it); }
    }
    return ex;
  }
  const exTableOf = code => (ex ? exTableFor(code, exByCode?.get(code) ?? [], ex.cover) : null);

  // ── 全域共用的小讀取（與會員數無關） ──
  async function refreshNews(todayYmd) {
    let u;
    try { u = await store.getNewsLatestUpdatedAt(); } catch { return news; }
    if (news.ymd === todayYmd && u != null && u === news.updatedAt) return news;
    try {
      const doc = await store.getNewsLatest();
      news = { ymd: todayYmd, updatedAt: u, events: doc ? ruleBearEvents(doc, { applicableYmd: todayYmd, minAtMs: eventMinAtMs(todayYmd, isTD) }) : [] };
    } catch (e) { log(`  ⚠ 停損影子：新聞判別讀取失敗（沿用上一份）：${msg(e)}`); }
    return news;
  }
  async function dispSet(todayYmd) {
    if (disp.ymd === todayYmd) return disp.set;
    if (now() - disp.at < RETRY_MS) return new Set();
    disp = { ...disp, at: now() };
    try { const rs = await fetchRiskSets(); if (rs?.disp instanceof Set) disp = { ymd: todayYmd, set: rs.disp, at: now() }; } catch { /* 下次再試 */ }
    return disp.ymd === todayYmd ? disp.set : new Set();
  }
  /** 除權息日（第一階段資料只有上市行事曆前 40 筆）：當日係數在收盤後才取 ⇒ 盤中一律 exPending（不判定），收盤補判同 */
  async function exPendingCodes(todayYmd) {
    if (exPend.ymd === todayYmd) return exPend.codes;
    try { exPend = { ymd: todayYmd, codes: new Set(await store.getDividendCodesOn(rocOf(todayYmd))) }; } catch { return new Set(); }
    return exPend.codes;
  }
  async function prevClosesOf(prevYmd) {
    if (prevCloses.ymd === prevYmd && prevCloses.map) return prevCloses.map;
    if (now() - prevCloses.at < 5 * 60000) return null;
    prevCloses = { ...prevCloses, at: now() };
    const doc = await store.getArchiveDay(prevYmd).catch(() => null);
    if (!doc || !archiveCloseReady(doc)) return null;   // 前一交易日官方收盤未定版 ⇒ 稍後再試
    let m = null;
    try { m = JSON.parse(doc.closeJson); } catch { return null; }
    const map = {};
    for (const [c, r] of Object.entries(isObj(m) ? m : {})) map[c] = Array.isArray(r) && r[0] > 0 ? r[0] : null;
    prevCloses = { ymd: prevYmd, map, at: now() };
    return map;
  }
  const namesOf = positions => Object.fromEntries(positions.filter(p => p.name).map(p => [p.code, p.name]));

  // ── ETF／興櫃官方日 K：盤前讀本機官方鏡像（R8；0 次 Firestore 讀寫、0 上游請求；每個資料日每種只讀一次，與會員數無關） ──
  async function officialBarsFor(kind, toYmd, { load = true } = {}) {
    if (typeof loadOfficialBars !== 'function' || !toYmd) return null;
    const cur = official.get(kind);
    if (cur?.to === toYmd) return cur;
    if (!load) return null;
    let next;
    try { next = { to: toYmd, ...officialBarsVerdict(await loadOfficialBars({ kind, to: toYmd, lastN: BAR_WINDOW }), toYmd) }; }
    catch (e) { next = { to: toYmd, ok: false, reason: `讀檔失敗：${msg(e)}`, barsByCode: {}, tailRun: 0 }; }
    official.set(kind, next);
    log(next.ok
      ? `  · 停損影子：${ARCHIVE_TEXT[kind]}官方日 K（本機官方鏡像）至 ${toYmd}：${Object.keys(next.barsByCode).length} 檔、最近連續完整 ${next.tailRun} 個交易日`
      : `  ⚠ 停損影子：${ARCHIVE_TEXT[kind]}官方日 K 本機鏡像不可用（${next.reason}）——這類持股不供給新資料（fail-closed）`);
    return next;
  }
  /**
   * 這檔的組成線原料要不要由本機官方鏡像供給（R8）：5～6 碼與英文字尾 ETF（barArchiveOf＝'etf'）；興櫃＝chipArchive 沒有它的日 K
   * （停損簿上一版 noOfficialBars，或上一版就是興櫃鏡像）**而且**官方興櫃表在視窗內有它——身分以官方表為準，不以代號猜（SKILL §2A）。
   * 回 null（不是這兩類 ⇒ 照原路徑）或 { kind, li, day }：li＝鏡像算出的組成線（標 archive）；鏡像不可用 ⇒ 停損簿已有上一份鏡像組成線就
   * 不覆蓋（li undefined：resolveStop 判 linesStale、沿用棘輪值，同 chipArchive 資料延遲 §3.6），從未供給過 ⇒ noBarsStub（第一階段口徑）。
   * day：這檔在資料日 toYmd 的官方日 K（planCloseSettle 的 official 形狀；興櫃 noLimit、沒有開盤價）與前一根收盤（漲跌停參考），
   *   給盤前補做資料日的收盤補判與事件結算（mirrorSettle）；資料日沒有這檔的日 K（當日無成交、暫停交易）⇒ null。
   * load false：只用已讀的快取（盤中、非交易日不讀檔）。
   */
  async function mirrorInputsOf(p, bp, exT, toYmd, { load = true } = {}) {
    const a = barArchiveOf(p.code);
    const kind = a === 'etf' ? 'etf'
      : a === 'chip' && (mirrorArchiveOf(bp?.lineInputs) === 'emerging' || bp?.noOfficialBars === true) ? 'emerging' : null;
    if (!kind) return null;
    const o = await officialBarsFor(kind, toYmd, { load });
    if (!o) return kind === 'etf' ? { kind, li: noBarsStub() } : null;
    const bars = o.barsByCode[p.code];
    if (kind === 'emerging' && !(Array.isArray(bars) && bars.length)) return null;
    if (!o.ok || !(Array.isArray(bars) && bars.length)) return { kind, li: mirrorArchiveOf(bp?.lineInputs) === kind ? undefined : noBarsStub(toYmd) };
    const li = lineInputsOf(bars, p.firstDate, bp?.holdHigh ?? null, exT ?? bp?.ex ?? EMPTY_EX_TABLE, {
      isEtf: isEtfCode(p.code), checkBreaks: kind === 'etf', isTradingDay: isTD, dataDate: toYmd,
    });
    if (li.noOfficialBars) return { kind, li, day: null };
    const last = bars[bars.length - 1];
    const day = last?.date === toYmd && isPos(last.c) && isPos(last.l) ? {
      official: { open: isPos(last.o) ? last.o : null, high: isPos(last.h) ? last.h : last.c, low: last.l, close: last.c, ...(kind === 'emerging' ? { noLimit: true } : {}) },
      refPrice: bars.length >= 2 && isPos(bars[bars.length - 2].c) ? bars[bars.length - 2].c : null,
    } : null;
    return { kind, li: { ...li, archive: kind }, day };
  }
  /** 鏡像代號（R8）在資料日 ymd 的官方收盤（只用盤前已讀的快取；chipArchive 沒有這類代號）——紀律彙總的前一交易日收盤用 */
  function mirrorClosesOf(positions, ymd) {
    const out = {};
    for (const o of official.values()) {
      if (o.to !== ymd || !o.ok) continue;
      for (const p of positions) {
        const bs = o.barsByCode[p.code];
        const b = Array.isArray(bs) ? bs[bs.length - 1] : null;
        if (b?.date === ymd && isPos(b.c)) out[p.code] = b.c;
      }
    }
    return out;
  }
  const officialAudit = () => Object.fromEntries([...official.entries()].map(([k, o]) => [k, { to: o.to, ok: o.ok, reason: o.reason, tailRun: o.tailRun }]));

  /**
   * 鏡像代號（R8）資料日 prevTd 的收盤結算：鏡像當日資料 22:40 才有 ⇒ 16:45 收盤結算排除這類持股，改在下一交易日盤前讀到鏡像時，
   * 以鏡像的 prevTd 官方日 K 對這些代號補跑 planCloseSettle（補判 evaluateLateTouch、settleEpisode、組成線換版、延後的事件收緊；
   * 版本日＝prevTd，同 chipArchive 收盤結算的口徑）。mirrorDay 只放 prevTd 當天已由同種鏡像組成線判定過的持股。
   * 影子紀錄記進 prevTd 的 shadowDays（若切換會送的一級 sub 'late'），並重算該日對照；stopSpecAudit/{prevTd} 的公開計數在收盤時已寫，
   * 不含這些補記（S4 以 shadowDays 重算）。每位會員每個交易日最多一次（盤前刷新以 premarketYmd 擋）；鏡像缺 prevTd ⇒ 該日不補（fail-closed）。
   * 回 null（沒有要補的）或 { book（套用後）, log（prevTd 的影子紀錄；沒有就 null） }
   */
  async function mirrorSettle(uid, { holdings, book, mirrorDay, exTables, lineInputs, prevTd, nowMs, names }) {
    const codes = Object.keys(mirrorDay);
    if (!codes.length || !isObj(book)) return null;
    const official = {}, refPrices = {}, exState = {};
    const positions = { ...book.positions };
    for (const code of codes) {
      const bp = book.positions[code];
      official[code] = mirrorDay[code].official;
      if (isPos(mirrorDay[code].refPrice)) refPrices[code] = mirrorDay[code].refPrice;
      if (exTables[code]) positions[code] = { ...bp, ex: exTables[code] };
      if (exPendingOn(exTables[code] ?? bp?.ex, bp, prevTd)) exState[code] = { pending: true };
    }
    const withEx = { ...book, positions };
    const r = planCloseSettle({
      uid, holdings, book: withEx, official, lineInputs, dateYmd: prevTd, openMs: taipeiMs(prevTd, 9), isTradingDay: isTD, exState, refPrices,
      dedupHas: () => false, nowMs, names, verifiedArchives, codes,
    });
    const next = applyBookPatch(withEx, r.bookPatch, { nextEpisodeId: r.nextEpisodeId });
    let fields = null;
    if (r.pushAlerts.length || r.missedLive.length) {
      // shadowDays 的欄位是整個覆寫 ⇒ 先讀回 prevTd 的紀錄，對照與漏判清單合併後再寫
      const d0 = await store.getDayLog(uid, prevTd).then(d => (isObj(d) ? d : {}), () => ({}));
      fields = { compare: compareShadowDay({ ...d0, wouldPush: [...arr(d0.wouldPush), ...r.pushAlerts] }) };
      if (r.missedLive.length) fields.missedLive = [...new Set([...arr(d0.missedLive), ...r.missedLive])];
    }
    const any = r.pushAlerts.length || r.docOnlyAlerts.length || r.eventRecords.length || fields;
    const log = any ? await dayLogOf(uid, prevTd, { wouldPush: r.pushAlerts, wouldDocOnly: r.docOnlyAlerts, eventRecords: r.eventRecords }, fields, nowMs) : null;
    return { book: next, log };
  }

  // ── ① 盤前刷新 ──
  async function premarketUser(uid, todayYmd, prevTd, events, pend, nowMs, late) {
    const book = await loadBook(uid);
    if (book?.premarketYmd === todayYmd) return false;
    const holdings = await store.getHoldings(uid);
    const positions = aggregatePositions(holdings);
    if (!positions.length && !book) return false;
    const exTables = {}, lineInputs = {}, exState = {}, mirrorDay = {};
    for (const p of positions) {
      const t = exTableOf(p.code); if (t) exTables[p.code] = t;
      const bp = book?.positions?.[p.code] ?? null;
      const m = await mirrorInputsOf(p, bp, t, prevTd);
      if (m) {
        if (m.li) lineInputs[p.code] = m.li;
        // 前一交易日已由同種鏡像組成線判定過 ⇒ 補做該日收盤結算（第一次供給的持股前一交易日沒有 v1.1 判定，不補判）
        if (m.day && isPos(bp?.stop) && mirrorArchiveOf(bp?.lineInputs) === m.kind) mirrorDay[p.code] = m.day;
      } else if (!hasOfficialBars(p.code)) lineInputs[p.code] = noBarsStub();
      if (pend.has(p.code)) exState[p.code] = { pending: true };
    }
    const names = namesOf(positions);
    const ms = await mirrorSettle(uid, { holdings, book, mirrorDay, exTables, lineInputs, prevTd, nowMs, names });
    const base = ms?.book ?? book;
    const r = planBookRefresh({
      holdings, book: base, exTables, lineInputs, newsEvents: events, when: 'premarket', latestCanonicalYmd: prevTd, nowMs, tradeDate: todayYmd,
      isTradingDay: isTD, exState, names, verifiedArchives,
    });
    const next = applyBookPatch(base, r.bookPatch, { premarketYmd: todayYmd, premarketLate: !!late, updatedAt: nowMs });
    // 前一交易日的補記先寫（停損簿寫入失敗 ⇒ 5 分鐘後由同一份停損簿重算，影子紀錄以鍵去重、不重記）
    if (ms?.log) await appendLog(uid, ms.log);
    await saveBook(uid, next, await dayLogOf(uid, todayYmd, { wouldDocOnly: r.docOnlyAlerts, eventRecords: r.eventRecords }, null, nowMs));
    return true;
  }
  async function premarket(todayYmd, { late = false } = {}) {
    const nowMs = now();
    const prevTd = prevTradingYmd(todayYmd, isTD);
    await exUpTo(prevTd);
    const nv = await refreshNews(todayYmd);
    const pend = await exPendingCodes(todayYmd);
    await dispSet(todayYmd);
    const users = await getPremiumUsers();
    let done = 0, failed = 0;
    for (const u of users) {
      try { if (await withUser(u.id, () => premarketUser(u.id, todayYmd, prevTd, nv.ymd === todayYmd ? nv.events : [], pend, nowMs, late))) done += 1; }
      catch (e) { failed += 1; stats.errors += 1; log(`  ✖ 停損影子·盤前 ${String(u.id).slice(0, 6)}：${msg(e)}`); }
    }
    log(`✓ 停損影子·盤前刷新 ${todayYmd}${late ? '（開盤後補跑）' : ''}：${done} 位會員${failed ? `、失敗 ${failed}` : ''}·規則類事件 ${nv.ymd === todayYmd ? nv.events.length : 0} 件（只記錄、不推播）`);
    return failed === 0;
  }

  // ── ② 盤中（checkAlerts 每輪；只用呼叫端已讀好的持股、快照報價、持股分析） ──
  async function tickUser(uid, holdings, quotes, analyses, nowMs, todayYmd) {
    const book = await loadBook(uid);
    const positions = aggregatePositions(holdings);
    if (!positions.length && !book) return null;
    const prevTd = prevTradingYmd(todayYmd, isTD);
    const names = namesOf(positions);
    const exState = {};
    if (exPend.ymd === todayYmd) for (const p of positions) if (exPend.codes.has(p.code)) exState[p.code] = { pending: true };
    const arrays = { wouldPush: [], wouldDocOnly: [], eventRecords: [] };
    let base = book;
    // 持股代號集合改變（盤中新買進／出清）：先以盤中刷新建立或移除（新部位今日買進 ⇒ 不套帶、只有成本線；版本 startedAt 在開盤後＝setToday 口徑）
    const bookCodes = new Set(Object.keys(book?.positions ?? {}));
    const held = new Set(positions.map(p => p.code));
    if (!book || bookCodes.size !== held.size || [...held].some(c => !bookCodes.has(c))) {
      const exTables = {}, lineInputs = {};
      for (const p of positions.filter(x => !bookCodes.has(x.code))) {
        const t = exTableOf(p.code); if (t) exTables[p.code] = t;
        // 盤中不讀檔：只用盤前已讀的本機鏡像快取（R8）；沒有快取同改動前
        const m = await mirrorInputsOf(p, null, t, prevTd, { load: false });
        if (m) { if (m.li) lineInputs[p.code] = m.li; }
        else if (!hasOfficialBars(p.code)) lineInputs[p.code] = noBarsStub();
      }
      const r = planBookRefresh({
        holdings, book, exTables, lineInputs, when: 'intraday', latestCanonicalYmd: prevTd, nowMs, tradeDate: todayYmd, isTradingDay: isTD, exState, names,
        verifiedArchives,
      });
      base = applyBookPatch(book, r.bookPatch, {});
      arrays.wouldDocOnly.push(...r.docOnlyAlerts);
      arrays.eventRecords.push(...r.eventRecords);
    }
    const refPrices = {};
    for (const p of positions) { const pv = quotes?.[p.code]?.prev; if (pv > 0) refPrices[p.code] = pv; }
    const t = planUserStopTick({
      uid, holdings, book: base, quotes: quotes ?? {}, nowMs, openMs: taipeiMs(todayYmd, 9), todayYmd, tradingDay: true,
      dispositionCodes: disp.ymd === todayYmd ? disp.set : new Set(), exState, refPrices,
      intradayEvents: news.ymd === todayYmd ? news.events.filter(e => e.pass === 'intraday') : [],
      dedupHas: () => false, isTradingDay: isTD, latestCanonicalYmd: prevTd, names, verifiedArchives,
    });
    let next = applyBookPatch(base, t.bookPatch, { nextEpisodeId: t.nextEpisodeId });
    // 影子對照值：舊推播停損、舊紀律停損、持股分析 ATR 帶（StopBookPosition.legacy；不新增其他欄位）
    const legacyPatch = {};
    for (const p of positions) {
      const bp = next.positions[p.code];
      if (!bp) continue;
      const leg = legacyOf(p.avgCost, analyses?.[p.code]?.stopLoss);
      if (stableJson(bp.legacy) !== stableJson(leg)) legacyPatch[p.code] = { ...bp, legacy: leg };
    }
    next = applyBookPatch(next, legacyPatch, {});
    arrays.wouldPush.push(...t.pushAlerts);
    arrays.wouldDocOnly.push(...t.docOnlyAlerts);
    arrays.eventRecords.push(...t.eventRecords.filter(r => r.outcome !== 'sameEvent'));
    // 紀律彙總（若切換：每人每交易日一則；前一交易日官方收盤定版後的第一輪）
    let fields = null;
    const dk = `${uid}|${todayYmd}`;
    if (!digestDone.has(dk) && prevTd) {
      const pc = await prevClosesOf(prevTd);
      if (pc) {
        // chipArchive 沒有的鏡像代號（ETF／興櫃；R8）補上盤前已讀的鏡像收盤（chipArchive 有的以 chipArchive 為準）
        const prevCloses = { ...mirrorClosesOf(positions, prevTd), ...pc };
        const d = planDisciplineDigest({ uid, book: next, holdings, prevCloses, todayYmd, isTradingDay: isTD, nowMs, names, verifiedArchives });
        fields = { wouldDigest: d.alert ?? { codes: [], at: nowMs } };
      }
    }
    const dl = await dayLogOf(uid, todayYmd, arrays, fields, nowMs);
    if (!samePositions(book, next)) await saveBook(uid, { ...next, updatedAt: nowMs }, dl);
    else await appendLog(uid, dl);
    if (fields) digestDone.add(dk);
    return { wouldPush: t.pushAlerts.length };
  }
  /** checkAlerts 每輪的第一件事（全域一次）：新聞判別只取 updatedAt、變了才讀整份；處置名單每日一次 */
  async function beginRound(nowMs = now()) {
    const todayYmd = taipeiYmd(nowMs);
    if (!isTD(todayYmd)) return;
    await refreshNews(todayYmd);
    await dispSet(todayYmd);
    await exPendingCodes(todayYmd);
  }
  // tick／noteLegacy 一律 async：任何同步錯誤都變成 rejection，由 daemon 的 .catch 吞掉——不可冒到 checkAlerts 的 try
  //   （那裡的 catch 會撤回現行推播的去重，造成重發）
  async function tick({ uid, holdings, quotes, analyses = {}, nowMs = now() }) {
    const todayYmd = taipeiYmd(nowMs);
    if (!isTD(todayYmd)) return null;
    stats.ticks += 1;
    return withUser(uid, () => tickUser(uid, Array.isArray(holdings) ? holdings : [], quotes, analyses, nowMs, todayYmd));
  }
  /** 舊制實際送出的停損類通知（checkAlerts 的 stop／trailing、trackStopDiscipline 的 discipline）——只記類型、代號、價位，供對照 */
  async function noteLegacy(uid, alerts, nowMs = now()) {
    const items = (Array.isArray(alerts) ? alerts : []).filter(a => isObj(a) && LEGACY_TYPES.has(a.type))
      .map(a => ({ type: a.type, code: a.code ?? null, price: a.price ?? null, threshold: a.threshold ?? null, pnlPct: a.pnlPct ?? null, days: a.days ?? null, at: a.at ?? nowMs }));
    if (!items.length) return false;
    const ymd = shadowYmd(nowMs);
    return withUser(uid, async () => { await appendLog(uid, await dayLogOf(uid, ymd, { legacySent: items }, null, nowMs)); return true; });
  }

  // ── ③ 收盤結算（資料到齊後；同一資料日每位會員只結算一次） ──
  async function deepBarsFor(holdingsBy, raw, windowFrom, have = null) {
    const need = new Map();
    for (const [uid, holdings] of holdingsBy) {
      const book = books.get(uid) ?? null;
      for (const p of aggregatePositions(holdings)) {
        if (!hasOfficialBars(p.code) || !p.firstDate || have?.has(p.code)) continue;   // 同一資料日的前一次嘗試已讀過
        const first = raw[p.code]?.[0]?.date;
        if (!first || p.firstDate >= first) continue;
        const hh = book?.positions?.[p.code]?.holdHigh;
        if (hh && hh.from === p.firstDate && hh.dataDate >= first) continue;   // 停損簿有同起點的上一版 ⇒ 每日增量即可
        const from = p.firstDate < STOP_PARAMS.archiveFrom ? STOP_PARAMS.archiveFrom : p.firstDate;
        if (!need.has(p.code) || from < need.get(p.code)) need.set(p.code, from);
      }
    }
    if (!need.size || !windowFrom) return {};
    const fromMin = [...need.values()].sort()[0];
    const out = {};
    const want = new Set(need.keys());
    const n = await store.scanArchiveRange(fromMin, windowFrom, page => {
      for (const [c, bs] of Object.entries(barsFromCloseDocs(page, want))) out[c] = concatBars(out[c], bs.filter(b => b.date >= need.get(c)));
    }, { max: DEEP_MAX_DOCS });
    log(`  · 停損影子：持有期最高收盤一次性往前讀 ${n} 份歸檔（${need.size} 檔，${fromMin} 起）`);
    return out;
  }
  async function settleUser(uid, holdings, dateYmd, raw, deep, nowMs, dayBy) {
    const book = await loadBook(uid);
    if (book?.settledYmd && book.settledYmd >= dateYmd) return false;   // settleEpisode 每個交易日只能一次
    const positions = aggregatePositions(holdings);
    if (!positions.length && !book) return false;
    const lineInputs = {}, official = {}, refPrices = {}, exTables = {}, exState = {};
    const settleCodes = [];
    let listedNow = 0;
    for (const p of positions) {
      const code = p.code;
      const bp = book?.positions?.[code] ?? null;
      const fresh = exTableOf(code);
      if (fresh) exTables[code] = fresh;   // 取不到新表就沿用停損簿裡的（不以空表覆蓋，否則還原成本會跳回未還原）
      const t = fresh ?? bp?.ex ?? EMPTY_EX_TABLE;
      const rb = raw[code] ?? [];
      const last = rb[rb.length - 1];
      // 本機官方鏡像供給的 ETF／興櫃（R8）：當日資料要等鏡像 22:40 才有 ⇒ 這類持股不在這裡結算（組成線、補判、事件結算、延後的事件收緊
      //   都留給下一交易日盤前的 mirrorSettle；不以 chipArchive／noBarsStub 覆蓋）。
      //   例外：興櫃轉上市／上櫃——chipArchive 當日已有這檔 ⇒ 改走 chipArchive（新組成線不標 archive，之後盤前也不再當興櫃；2026-10-06 審查）
      const arc = mirrorArchiveOf(bp?.lineInputs);
      if (arc && !(arc === 'emerging' && last?.date === dateYmd)) continue;
      if (arc) listedNow += 1;
      settleCodes.push(code);
      if (!hasOfficialBars(code)) { lineInputs[code] = noBarsStub(dateYmd); continue; }
      lineInputs[code] = lineInputsOf(concatBars(deep[code], raw[code]), p.firstDate, bp?.holdHigh ?? null, t, { isEtf: isEtfCode(code), isTradingDay: isTD, dataDate: dateYmd });
      if (last?.date === dateYmd) {
        official[code] = { open: last.o, high: last.h, low: last.l, close: last.c };
        if (rb.length >= 2) refPrices[code] = rb[rb.length - 2].c;
      }
      // 今日除權息、當天盤中停損還沒依係數調整 ⇒ 收盤補判不判定（同 exPending；調整由下面的換版處理）
      if (exPendingOn(t, bp, dateYmd)) exState[code] = { pending: true };
    }
    if (listedNow) log(`  · 停損影子·收盤 ${String(uid).slice(0, 6)}：興櫃轉上市櫃 ${listedNow} 檔（chipArchive ${dateYmd} 已有日 K）——組成線改走 chipArchive`);
    // 停損簿的係數表換成涵蓋到資料日的版本：組成線的係數涵蓋檢查要涵蓋到今日（plan 內 resolveStop 讀停損簿的 ex）。
    //   停損簿還沒有的持股（今天才買、盤中沒輪到）放一個只有係數表的占位：沒有 stop ⇒ 不補判、以 init 建第一版
    const posEx = {};
    for (const [c, bp] of Object.entries(book?.positions ?? {})) posEx[c] = exTables[c] ? { ...bp, ex: exTables[c] } : bp;
    for (const p of positions) if (!posEx[p.code] && exTables[p.code]) posEx[p.code] = { ex: exTables[p.code] };
    const withEx = book || Object.keys(posEx).length ? { ...(book ?? {}), positions: posEx } : null;
    const r = planCloseSettle({
      uid, holdings, book: withEx, official, lineInputs, dateYmd, openMs: taipeiMs(dateYmd, 9), isTradingDay: isTD, exState, refPrices,
      dedupHas: () => false, nowMs, names: namesOf(positions), verifiedArchives,
      codes: settleCodes.length === positions.length ? null : settleCodes,
    });
    const next = applyBookPatch(withEx, r.bookPatch, { nextEpisodeId: r.nextEpisodeId, dataDate: dateYmd, settledYmd: dateYmd, updatedAt: nowMs });
    await saveBook(uid, next, await dayLogOf(uid, dateYmd, { wouldPush: r.pushAlerts, wouldDocOnly: r.docOnlyAlerts, eventRecords: r.eventRecords },
      r.missedLive.length ? { missedLive: r.missedLive } : null, nowMs));
    // 對照（同一份紀錄：舊制實際送出 vs v1.1 若切換會送出；只寫本人的 shadowDays）
    const day = await store.getDayLog(uid, dateYmd);
    const compare = compareShadowDay(day);
    await store.appendDayLog(uid, { ymd: dateYmd, at: nowMs, arrays: {}, fields: { compare } });
    dayBy.set(uid, { ...(isObj(day) ? day : {}), compare });
    return true;
  }
  async function writeEventShadow(dateYmd, { eventsToday, recent, raw, newsDay, universe, nowMs }) {
    const adj = {};
    for (const [c, bs] of Object.entries(raw)) adj[c] = adjustBars(bs, exTableOf(c) ?? EMPTY_EX_TABLE);
    const seen = new Set();
    const all = [];
    for (const e of [...eventsToday, ...recent.flatMap(d => (Array.isArray(d.events) ? d.events : []))]) {
      const k = `${e?.key}|${e?.targetDate}`;
      if (!isObj(e) || seen.has(k)) continue;
      seen.add(k);
      all.push(e);
    }
    const hits = eventShadowRows({ events: all, barsByCode: adj, dateYmd });
    const prevTd = prevTradingYmd(dateYmd, isTD);
    const prevDoc = recent.find(d => d.date === prevTd);
    const eventCodes = new Set([...eventsToday.map(e => e.code), ...(Array.isArray(prevDoc?.events) ? prevDoc.events : []).map(e => e?.code)]);
    const misses = missShadowRows({ universe, barsByCode: adj, newsDoc: newsDay, dateYmd, applicableYmd: dateYmd, minAtMs: eventMinAtMs(dateYmd, isTD), eventCodes });
    const counts = { events: eventsToday.length, hitRows: hits.length, missRows: misses.length, missReasons: {} };
    for (const m of misses) counts.missReasons[m.reason] = (counts.missReasons[m.reason] ?? 0) + 1;
    // 大跌日的漏網列可能上千筆 ⇒ gzip(JSON) 存 Bytes（逼近 1MB 用壓縮；壓縮後仍超過預算就只存計數並記 log，不寫殘缺列）
    const hitsGz = gzipSync(Buffer.from(JSON.stringify(hits)));
    const missesGz = gzipSync(Buffer.from(JSON.stringify(misses)));
    const fits = hitsGz.length + missesGz.length <= EVENT_DOC_BUDGET;
    if (!fits) log(`  ⚠ 停損影子：${dateYmd} 事件影子紀錄壓縮後仍超過預算（${hitsGz.length + missesGz.length} bytes），本日只存計數`);
    await store.setEventShadow(dateYmd, {
      date: dateYmd, specVersion: STOP_SPEC_VERSION, phase: SHADOW_PHASE, events: eventsToday, newsDoc: newsDay ? 'ok' : 'missing',
      encoding: 'gzip-json', ...(fits ? { hitsGz, missesGz } : { rowsDropped: true }), counts, updatedAt: nowMs,
    });
    return counts;
  }
  async function closeSettle(dateYmd) {
    if (closeRun?.ymd !== dateYmd) closeRun = { ymd: dateYmd, attempts: 0, docs: null, deep: {}, deepCodes: new Set(), globalDone: false, pending: null, settled: 0 };
    const run = closeRun;
    const nowMs = now();
    if (!run.docs) {
      const docs = (await store.getArchiveWindow(dateYmd, BAR_WINDOW)).filter(d => d && d.closeJson && d.date);
      if (!docs.length || !docs.some(d => d.date === dateYmd)) { log(`  ⏳ 停損影子·收盤結算 ${dateYmd}：收盤歸檔不在，稍後重試`); return false; }
      run.docs = docs;   // 同一資料日的重試沿用（不重讀 80 份歸檔）
    }
    run.attempts += 1;
    const docs = run.docs;
    await exUpTo(dateYmd);
    const retryOnly = run.pending;   // 前一次失敗的會員（重試只跑這些人）；null＝全部
    const users = (await getPremiumUsers()).filter(u => !retryOnly || retryOnly.has(u.id));
    const holdingsBy = new Map();
    const failedUids = new Set();
    for (const u of users) {
      try { holdingsBy.set(u.id, await store.getHoldings(u.id)); await loadBook(u.id); }
      catch (e) { failedUids.add(u.id); log(`  ✖ 停損影子·收盤 ${String(u.id).slice(0, 6)} 讀取：${msg(e)}`); }
    }
    const held = new Set([...holdingsBy.values()].flatMap(h => aggregatePositions(h).map(p => p.code)));
    // 全域紀錄（事件收緊命中／漏網、公開計數）只在還沒成功寫過時才讀新聞判別與事件影子歷史
    let newsDay = null, recent = [], eventsToday = [], universe = [...held];
    if (!run.globalDone) {
      try { newsDay = await store.getNewsDay(dateYmd); } catch (e) { log(`  ⚠ 停損影子：newsVerdict/${dateYmd} 讀取失敗：${msg(e)}`); }
      try { recent = await store.getEventShadowRecent(dateYmd, EVENT_LOOKBACK_DAYS); } catch (e) { log(`  ⚠ 停損影子：事件影子歷史讀取失敗：${msg(e)}`); }
      const board = newsDay ? newsBoardFromDoc(newsDay) : null;
      eventsToday = newsDay ? ruleBearEvents(newsDay, { applicableYmd: dateYmd, minAtMs: eventMinAtMs(dateYmd, isTD) }) : [];
      universe = [...new Set([...held, ...Object.keys(board?.map ?? {})])];
    }
    const need = new Set([...universe, ...eventsToday.map(e => e.code), ...recent.flatMap(d => (Array.isArray(d.events) ? d.events : []).map(e => e?.code))].filter(Boolean));
    const raw = barsFromCloseDocs(docs, need);
    const windowFrom = docs.map(d => d.date).sort()[0];
    try {
      const more = await deepBarsFor(holdingsBy, raw, windowFrom, run.deepCodes);
      for (const [c, bs] of Object.entries(more)) { run.deep[c] = bs; run.deepCodes.add(c); }
    } catch (e) { log(`  ⚠ 停損影子：持有期最高收盤往前讀失敗（本次以視窗內計、標不完整）：${msg(e)}`); }
    const deep = run.deep;
    const dayBy = new Map();
    let done = 0;
    for (const [uid, holdings] of holdingsBy) {
      try { if (await withUser(uid, () => settleUser(uid, holdings, dateYmd, raw, deep, nowMs, dayBy))) done += 1; }
      catch (e) { failedUids.add(uid); stats.errors += 1; log(`  ✖ 停損影子·收盤 ${String(uid).slice(0, 6)}：${msg(e)}`); }
    }
    run.settled += done;
    if (!run.globalDone) {
      // 公開計數要涵蓋當日全部會員（先前已結算者讀回當日紀錄）
      for (const uid of holdingsBy.keys()) {
        if (dayBy.has(uid) || !books.get(uid)) continue;
        try { const d = await store.getDayLog(uid, dateYmd); if (d) dayBy.set(uid, d); } catch { /* 少一位只影響計數 */ }
      }
      const pcMap = {};
      for (const [c, bs] of Object.entries(raw)) { const b = bs[bs.length - 1]; if (b?.date === dateYmd) pcMap[c] = b.c; }
      prevCloses = { ymd: dateYmd, map: pcMap, at: nowMs };
      let ev = null, evOk = false, auditOk = false;
      try { ev = await writeEventShadow(dateYmd, { eventsToday, recent, raw, newsDay, universe, nowMs }); evOk = true; } catch (e) { log(`  ⚠ 停損影子：事件收緊命中／漏網紀錄寫入失敗：${msg(e)}`); }
      try {
        const bookList = [...holdingsBy.keys()].map(uid => books.get(uid)).filter(Boolean);
        await store.mergeAudit(dateYmd, {
          date: dateYmd, specVersion: STOP_SPEC_VERSION, phase: SHADOW_PHASE, updatedAt: nowMs,
          shadow: {
            books: bookAuditCounts(bookList, dateYmd), day: dayAuditCounts([...dayBy.values()]), eventShadow: ev,
            exCoverTo: ex?.cover?.to ?? null, dispositionKnown: disp.ymd === dateYmd, exPendingSource: 'twse-calendar-top40', settledUsers: done, failedUsers: failedUids.size,
            officialBars: officialAudit(),
          },
        });
        auditOk = true;
      } catch (e) { log(`  ⚠ 停損影子：公開計數寫入失敗：${msg(e)}`); }
      run.globalDone = evOk && auditOk;
    }
    run.pending = failedUids.size ? failedUids : null;
    const gaveUp = (!!run.pending || !run.globalDone) && run.attempts >= CLOSE_MAX_ATTEMPTS;
    if (run.attempts > 1 || gaveUp) {
      // 重試的結果另記（不覆寫第一次的當日計數；只放人數，不放 uid）
      try {
        await store.mergeAudit(dateYmd, { updatedAt: nowMs, shadowRetry: { attempts: run.attempts, settledUsers: run.settled, failedUsers: failedUids.size, gaveUp } });
      } catch (e) { log(`  ⚠ 停損影子：重試計數寫入失敗：${msg(e)}`); }
    }
    log(`${run.pending || !run.globalDone ? '⚠' : '✓'} 停損影子·收盤結算 ${dateYmd}（第 ${run.attempts} 次）：${done} 位會員${failedUids.size ? `、失敗 ${failedUids.size}` : ''}·係數涵蓋至 ${ex?.cover?.to ?? '—'}·事件 ${eventsToday.length} 件（只記錄、不推播）`);
    if (gaveUp) {
      log(`  ✖ 停損影子·收盤結算 ${dateYmd}：重試 ${run.attempts} 次後仍未完成（未結算 ${failedUids.size} 位${run.globalDone ? '' : '、全域紀錄未寫成'}）——停止重試（stopSpecAudit.shadowRetry 記人數）`);
      return true;
    }
    return run.globalDone && !run.pending;
  }
  /** 收盤結算下一次重試的間隔：同一資料日已嘗試過（結算本身失敗）⇒ 退避；歸檔還不在 ⇒ RETRY_MS */
  function closeRetryDelay(ymd) {
    if (closeRun?.ymd !== ymd || !closeRun.attempts) return RETRY_MS;
    return CLOSE_BACKOFF_MS[Math.min(closeRun.attempts, CLOSE_BACKOFF_MS.length) - 1];
  }

  // ── ④ 非交易日每小時：持股變動（版本日＝最後交易日） ──
  async function nontrading(lastTd, nowMs) {
    const users = await getPremiumUsers();
    let n = 0;
    for (const u of users) {
      try {
        n += await withUser(u.id, async () => {
          const book = await loadBook(u.id);
          const holdings = await store.getHoldings(u.id);
          const positions = aggregatePositions(holdings);
          if (!positions.length && !book) return 0;
          const bookCodes = new Set(Object.keys(book?.positions ?? {}));
          const exTables = {}, lineInputs = {};
          for (const p of positions.filter(x => !bookCodes.has(x.code))) {
            const t = exTableOf(p.code); if (t) exTables[p.code] = t;
            if (!hasOfficialBars(p.code)) lineInputs[p.code] = noBarsStub();   // 非交易日不讀鏡像：下一個交易日盤前刷新再供給（R8）
          }
          const r = planBookRefresh({ holdings, book, exTables, lineInputs, when: 'nontrading', latestCanonicalYmd: lastTd, nowMs, tradeDate: lastTd, isTradingDay: isTD, names: namesOf(positions), verifiedArchives });
          const next = applyBookPatch(book, r.bookPatch, {});
          if (samePositions(book, next)) return 0;
          await saveBook(u.id, { ...next, updatedAt: nowMs }, await dayLogOf(u.id, lastTd, { wouldDocOnly: r.docOnlyAlerts, eventRecords: r.eventRecords }, null, nowMs));
          return 1;
        });
      } catch (e) { stats.errors += 1; log(`  ✖ 停損影子·非交易日 ${String(u.id).slice(0, 6)}：${msg(e)}`); }
    }
    if (n) log(`✓ 停損影子·非交易日持股變動：${n} 位會員（版本日 ${lastTd}）`);
  }

  // ── LLM 停損文字量測（measure；只放計數） ──
  function recordLlm(source, { push = [], shadow = null } = {}, nowMs = now()) {
    const ymd = shadowYmd(nowMs);
    const c = llm.get(ymd) ?? {};
    const s = (c[source] ??= { checked: 0, push: {}, shadowChecked: 0, shadow: {} });
    s.checked += 1;
    for (const v of Array.isArray(push) ? push : []) if (v?.code) s.push[v.code] = (s.push[v.code] ?? 0) + 1;
    if (Array.isArray(shadow)) { s.shadowChecked += 1; for (const v of shadow) if (v?.code) s.shadow[v.code] = (s.shadow[v.code] ?? 0) + 1; }
    llm.set(ymd, c);
  }
  async function flushLlm() {
    for (const [ymd, counts] of [...llm.entries()]) {
      llm.delete(ymd);
      try { await store.incrementAudit(ymd, { llm: counts }, { date: ymd, specVersion: STOP_SPEC_VERSION, updatedAt: now() }); }
      catch (e) {
        log(`  ⚠ 停損影子：LLM 量測計數寫入失敗（下次再寫）：${msg(e)}`);
        const cur = llm.get(ymd) ?? {};
        for (const [src, s] of Object.entries(counts)) {
          const t = (cur[src] ??= { checked: 0, push: {}, shadowChecked: 0, shadow: {} });
          t.checked += s.checked; t.shadowChecked += s.shadowChecked;
          for (const k of ['push', 'shadow']) for (const [code, n] of Object.entries(s[k])) t[k][code] = (t[k][code] ?? 0) + n;
        }
        llm.set(ymd, cur);
      }
    }
  }

  // ── 排程（daemon 每分鐘呼叫一次；成功才 markJobDone、開機讀回） ──
  async function archiveReady(ymd) {
    const doc = await store.getArchiveDay(ymd).catch(() => null);
    return !!doc && archiveDayStatus(doc).ready;
  }
  async function step() {
    const nowMs = now();
    const todayYmd = taipeiYmd(nowMs), minutes = taipeiMinuteOfDay(nowMs), tradingDay = isTD(todayYmd);
    if (!marks) { try { marks = { ...((await readJobMarks()) || {}) }; } catch { marks = {}; } }
    const target = closeTargetOf({ todayYmd, minutes, tradingDay, isTradingDay: isTD });
    if (target && String(marks.stopShadowClose ?? '') < target && nowMs >= closeNextAt) {
      closeNextAt = nowMs + RETRY_MS;
      // 今天：等資料到齊班車完成（兩市收盤＋法人到齊、priceEvents 已重算）；補跑前一交易日：直接看歸檔是否到齊
      if ((target !== todayYmd || trainDone(target)) && await archiveReady(target)) {
        if (await closeSettle(target)) {
          marks.stopShadowClose = target;
          await markJobDone('stopShadowClose', target);
          closeNextAt = 0;
        } else closeNextAt = nowMs + closeRetryDelay(target);
      }
    }
    const due = premarketDue({ todayYmd, minutes, tradingDay, doneYmd: marks.stopShadowPre });
    if (due && nowMs >= preNextAt) {
      preNextAt = nowMs + 5 * 60000;
      if (await premarket(todayYmd, due)) { marks.stopShadowPre = todayYmd; await markJobDone('stopShadowPre', todayYmd); }
    }
    if (!tradingDay && nowMs - nontradingAt >= 60 * 60000) {
      nontradingAt = nowMs;
      const last = prevTradingYmd(todayYmd, isTD);
      if (last) await nontrading(last, nowMs);
    }
    await flushLlm();
  }

  return {
    step, beginRound, tick, noteLegacy, recordLlm, flushLlm, closeSettle, premarket,
    /** 記憶體中的 v1.1 影子停損（LLM 量測對照用；沒有就 null，不另讀） */
    peekStop: (uid, code) => books.get(uid)?.positions?.[code]?.stop ?? null,
    status: () => ({
      ...stats, books: books.size, exCoverTo: ex?.cover?.to ?? null, officialBars: officialAudit(),
      marks: marks ? { pre: marks.stopShadowPre ?? null, close: marks.stopShadowClose ?? null } : null,
    }),
  };
}
