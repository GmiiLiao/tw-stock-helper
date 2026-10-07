// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1 共用純函式·daemon 整合（S3 影子期起用；寫 stopBooks/{uid} 前的所有決定都在這裡，daemon 只做讀寫）：
//   legacyBranchActive／legacyCodeActive（舊分支互斥與回滾；前端 bookStopOf 共用後者）、planBookRefresh（08:46 盤前／盤中持股變動／非交易日）、planUserStopTick（alertLoop 每輪）、
//   planCloseSettle（16:45 起資料到齊班車：補判→事件結算→新組成線版本→延後的事件收緊）、planDisciplineDigest（每人每日一則紀律彙總）、
//   mergeAlertsKeepUnacked（alerts 文件 40 則上限時優先保留未收到的一級）。
// 規範 SKILL §3–§10A、§11、§14；實作計畫 warroom/stoploss/v1.1/impl-plan.md §2。
// 規則：純函式——不 import firebase、不碰網路與檔案、不讀時鐘（nowMs 由呼叫端傳入）；回傳新物件、不改輸入。
// ⚠ 本檔只產生「要寫什麼」；phase 'shadow' 時呼叫端只寫 stopBooks、不推播、不寫 alerts（SKILL 生效範圍）。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { STOP_SPEC_VERSION, isEtfCode, stopSourceLabel, stopFactText } from './ai-stoploss-base.mjs';
import {
  EMPTY_EX_TABLE, aggregatePositions, resolveStop, evaluateTouch, evaluateLateTouch, isSetToday, isTodayTrade,
  advanceEpisode, settleEpisode, carryEpisode, disciplineDay,
} from './ai-stoploss-core.mjs';
import { stepEventOverlay, activeOverlays } from './ai-stoploss-event.mjs';
import { disciplineDigest, stopTouchPushText } from './ai-stoploss-text.mjs';
import { taipeiMinuteOfDay } from './warroom-session.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
/** 鍵排序後的 JSON（停損簿從 Firestore 讀回時鍵順序可能不同；只拿來判斷「有沒有變」以免每輪都寫） */
function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}
const sameDoc = (doc, bp) => isObj(bp) && Object.keys(doc).every(k => stableJson(doc[k]) === stableJson(bp[k]));

/**
 * 組成線原料由 daemon 盤前讀本機官方鏡像供給（ETF／興櫃；使用者 2026-10-06 R8）而且該歸檔種類**還沒**通過驗證（SKILL §2A 閘門＋使用者核可）
 * ⇒ 回種類（'etf'｜'emerging'），否則 null。verifiedArchives：已驗證的種類（Set 或陣列；預設空＝都還沒驗證）。
 */
export function unverifiedArchiveOf(lineInputs, verifiedArchives = []) {
  const a = isObj(lineInputs) ? lineInputs.archive : null;
  if (a !== 'etf' && a !== 'emerging') return null;
  const v = verifiedArchives instanceof Set ? verifiedArchives : new Set(Array.isArray(verifiedArchives) ? verifiedArchives : []);
  return v.has(a) ? null : a;
}

/**
 * live 時不發 v1.1 警示的代號：組成線來自尚未驗證的官方鏡像歸檔（unverifiedArchiveOf）——舊分支照跑（legacyBranchActive 為真），
 * v1.1 照算、照寫停損簿（影子期閘門 ⑥「照 v1.1 算這類代號並分開統計」），但不產生任何推播或二級文件（避免同一檔兩套警示）。
 */
const mutedAtLive = (book, lineInputs, verifiedArchives) => isObj(book) && book.phase === 'live' && unverifiedArchiveOf(lineInputs, verifiedArchives) != null;

/**
 * 停損簿的一檔是否留在第一階段口徑（不論 phase）：noOfficialBars（ETF／興櫃官方日 K 歸檔驗證前，A3 裁定）、或組成線來自尚未驗證的
 * 官方鏡像歸檔（verifiedArchives 不含它的種類；R8）⇒ true。daemon（legacyBranchActive）與戰情前端（warroom-stopbook.bookStopOf）
 * 共用這一支，前端的 verifiedArchives 讀停損簿文件裡 daemon 寫的同一份（2026-10-06 審查：兩邊口徑不一會出現兩個停損數字）。
 */
export function legacyCodeActive(bp, { verifiedArchives = [] } = {}) {
  if (!isObj(bp)) return false;
  return bp.noOfficialBars === true || unverifiedArchiveOf(bp.lineInputs, verifiedArchives) != null;
}

/**
 * 舊分支（第一階段口徑：舊停損推播、舊紀律、舊 trailing、舊崩盤防禦）要不要照跑：
 * 停損簿不存在、phase 不是 'live'、specVersion 不是本版 ⇒ true（回滾：把 phase 改回 'shadow' 立即恢復）；
 * 有傳 code 且該檔 legacyCodeActive（noOfficialBars，或組成線來自尚未驗證的官方鏡像歸檔；R8）⇒ true。
 */
export function legacyBranchActive(book, code, { verifiedArchives = [] } = {}) {
  if (!isObj(book) || book.phase !== 'live' || book.specVersion !== STOP_SPEC_VERSION) return true;
  if (code == null) return false;
  return legacyCodeActive(book.positions?.[code], { verifiedArchives });
}

/** alerts 文件寫入：新的在前、同 id 只留一則；超過上限時優先保留尚未收到的一級（requireAck 且沒有 ack），其餘依新舊 */
export function mergeAlertsKeepUnacked(prev, incoming, max = 40) {
  const seen = new Set();
  const all = [];
  for (const a of [...(Array.isArray(incoming) ? incoming : []), ...(Array.isArray(prev) ? prev : [])]) {
    if (!isObj(a)) continue;
    const k = typeof a.id === 'string' && a.id ? a.id : null;
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    all.push(a);
  }
  if (all.length <= max) return all;
  const keep = new Set();
  all.forEach((a, i) => { if (a.requireAck === true && !a.ack && keep.size < max) keep.add(i); });
  for (let i = 0; i < all.length && keep.size < max; i++) keep.add(i);
  return all.filter((_, i) => keep.has(i));
}

/** 停損簿的一檔 → resolveStop 的 prev */
export function prevStateOf(bp) {
  if (!isObj(bp) || !isPos(bp.stop) || !Number.isInteger(bp.stopVersion)) return null;
  return {
    stop: bp.stop, baseStop: bp.baseStop ?? null, floorStop: bp.floorStop ?? null, bandHold: bp.bandHold ?? null,
    stopSource: bp.stopSource ?? null, sourceDate: bp.sourceDate ?? null, floorSource: bp.floorSource ?? null,
    floorSourceDate: bp.floorSourceDate ?? null, bandSourceDate: bp.bandSourceDate ?? null, basisText: bp.basisText ?? null,
    stopVersion: bp.stopVersion, lots: Array.isArray(bp.lots) ? bp.lots : [], exApplied: Array.isArray(bp.exApplied) ? bp.exApplied : [],
    selfAdjusted: isObj(bp.selfAdjusted) ? bp.selfAdjusted : {}, startedAt: bp.startedAt ?? 0, tradeDate: bp.tradeDate ?? '',
    holdHigh: bp.holdHigh ?? null, eventKeys: Array.isArray(bp.eventKeys) ? bp.eventKeys : [],
  };
}

/** 綁定來源的短標籤（觸及類句子用）；事件收緊要帶那一層的日期與類別名 */
function sourceLabelOf(res, overlays) {
  if (res.stopSource !== 'event') return stopSourceLabel(res.stopSource);
  const top = activeOverlays(overlays).reduce((m, o) => (m == null || o.line > m.line ? o : m), null);
  return stopSourceLabel('event', { effectiveFrom: top?.effectiveFrom, label: top?.label });
}

/** 停損簿一檔的完整內容（StopBookPosition） */
function positionDoc(position, res, x) {
  const li = x.lineInputs ?? null;
  return {
    qty: position.qty, avgCost: position.avgCost, firstDate: position.firstDate, lots: position.lots,
    ex: x.ex, exApplied: res.exApplied, selfAdjusted: res.selfAdjusted, adjCost: res.adjCost, adjDate: res.tradeDate,
    exPending: !!x.exPending, exUnconfirmed: !!x.exUnconfirmed, exUnknown: res.exUnknown,
    stop: res.stop, baseStop: res.baseStop, floorStop: res.floorStop, bandHold: res.bandHold,
    line: res.line, basis: res.basis, basisText: res.basisText, costLine: res.costLine,
    stopSource: res.stopSource, sourceDate: res.sourceDate, floorSource: res.floorSource,
    floorSourceDate: res.floorSourceDate, bandSourceDate: res.bandSourceDate,
    lines: res.lines, lineInputs: li, linesStale: res.linesStale,
    stopVersion: res.stopVersion, versionReason: res.versionReason, startedAt: res.startedAt, tradeDate: res.tradeDate,
    atr14: res.atr14, atrPct: isPos(res.atr14) && isPos(li?.close) ? +((res.atr14 / li.close) * 100).toFixed(2) : null,
    suspect: res.suspect, events: x.overlays, eventSeen: x.seen, eventKeys: res.eventKeys,
    holdHigh: res.holdHigh, noOfficialBars: res.noOfficialBars || li?.noOfficialBars === true, exGapBars: res.exGapBars,
    episode: x.episode ?? null, ticked: !!x.ticked, legacy: x.legacy ?? null,
  };
}

const stopInfo = (code, name, sub, idTail, message, nowMs, extra = {}) => ({
  id: `stopInfo:${code}:${sub}:${idTail}`, type: 'stopInfo', sub, code, name: name ?? '', message, at: nowMs,
  price: 0, threshold: 0, pnlPct: 0, ...extra,
});

/** 事件收緊紀錄 → 只寫文件的二級 stopInfo（收緊本身不推播；SKILL §8.3、§10A.9） */
function eventInfoAlerts(code, name, records, res, overlays, before, dayYmd, nowMs, isEtf) {
  const out = [];
  for (const r of records) {
    const o = overlays.find(x => x.key === r.key) ?? before.find(x => x.key === r.key) ?? {};
    const label = stopSourceLabel('event', { form: 'row', effectiveFrom: o.effectiveFrom ?? dayYmd, expiresAfter: o.expiresAfter, label: o.label });
    const id = `${r.cls}:${o.effectiveFrom ?? dayYmd}`;
    if (r.outcome === 'applied') {
      out.push(stopInfo(code, name, 'eventTighten', id, stopFactText('eventTighten', {
        line: r.line, label, baseStop: res.baseStop, baseSource: stopSourceLabel(res.baseStop === res.floorStop ? res.floorSource : 'atrBand'), isEtf,
      }), nowMs, { threshold: r.line ?? 0 }));
    } else if (r.outcome === 'deferred') {
      out.push(stopInfo(code, name, 'eventDeferred', `${r.cls}:${dayYmd}`, stopFactText('eventDeferred', { price: o.deferredPx, line: r.line, isEtf }), nowMs));
    } else if (r.outcome === 'noBite') {
      out.push(stopInfo(code, name, 'eventNoBite', `${r.cls}:${dayYmd}`, stopFactText('eventNoBite', { stop: res.stop, source: stopSourceLabel(res.stopSource), line: r.line, isEtf }), nowMs));
    } else if (r.outcome === 'expired') {
      out.push(stopInfo(code, name, 'eventExpire', id, stopFactText('eventExpire', { effectiveFrom: o.effectiveFrom, stop: res.stop, source: stopSourceLabel(res.stopSource), isEtf }), nowMs));
    }
  }
  return out;
}

/** 新套用的除權息事件（還原成本與停損 ×f；SKILL §7） */
function newExEvents(ex, prevApplied, nowApplied) {
  const was = new Set(Array.isArray(prevApplied) ? prevApplied : []);
  const now = new Set(Array.isArray(nowApplied) ? nowApplied : []);
  return (Array.isArray(ex?.events) ? ex.events : []).filter(([d]) => now.has(d) && !was.has(d));
}

/**
 * 停損簿刷新（daemon 唯一寫 stopBooks 的地方之一；SKILL §3、§7、§10A.4）。
 * when：'premarket'（交易日 08:46–09:00：除權息調整、盤後／夜補／晨間趟事件生效、到期移除）｜'intraday'（盤中持股變動或盤中趟事件）｜
 *   'nontrading'（非交易日每小時：只處理持股變動，版本日＝最後交易日）。16:45 的組成線換版走 planCloseSettle。
 * lineInputs：沒傳的代號沿用停損簿裡的 lineInputs。newsEvents：ruleBearEvents 的輸出（全市場，這裡依代號過濾）。
 * refCloses／refYmds：事件收緊的前收與它的口徑日（預設＝lineInputs.close／dataDate）。lastPrices：成本可疑檢查與盤中 B3 檢查用的價。
 * 回 { bookPatch（代號 → 整份 StopBookPosition；出清的代號 → null）, docOnlyAlerts（二級 stopInfo）, eventRecords }
 */
export function planBookRefresh(input) {
  const {
    holdings, book = null, exTables = {}, lastPrices = {}, lineInputs = {}, newsEvents = [], refCloses = {}, refYmds = {},
    when, latestCanonicalYmd = null, nowMs, tradeDate, isTradingDay, exState = {}, names = {}, resetEpisodes = false, verifiedArchives = [],
  } = input ?? {};
  const positions = aggregatePositions(holdings);
  const bookPatch = {}, docOnlyAlerts = [], eventRecords = [];
  const muted = new Set();
  const held = new Set(positions.map(p => p.code));
  for (const code of Object.keys(book?.positions ?? {})) if (!held.has(code)) bookPatch[code] = null;
  for (const position of positions) {
    const code = position.code;
    const name = position.name || names[code] || '';
    const bp = book?.positions?.[code] ?? null;
    const isEtf = isEtfCode(code);
    const li = has(lineInputs, code) ? lineInputs[code] : (bp?.lineInputs ?? null);
    if (mutedAtLive(book, li, verifiedArchives)) muted.add(code);
    const ex = exTables[code] ?? bp?.ex ?? EMPTY_EX_TABLE;
    const prev = prevStateOf(bp);
    const common = { position, ex, prev, lines: li, latestCanonicalYmd, lastPrice: lastPrices[code] ?? null, nowMs, tradeDate, isEtf };
    const before = Array.isArray(bp?.events) ? bp.events : [];
    let overlays = before;
    let seen = Array.isArray(bp?.eventSeen) ? bp.eventSeen : [];
    let records = [];
    if (when === 'premarket' || when === 'intraday') {
      const r0 = resolveStop({ ...common, events: activeOverlays(overlays, tradeDate) });
      const step = stepEventOverlay(overlays, {
        events: (Array.isArray(newsEvents) ? newsEvents : []).filter(e => e?.code === code), seen, baseStop: r0.baseStop,
        firstDate: position.firstDate, refClose: has(refCloses, code) ? refCloses[code] : li?.close ?? null,
        refYmd: has(refYmds, code) ? refYmds[code] : li?.dataDate ?? null, atr14: li?.atr14 ?? null,
        lastTradePx: lastPrices[code] ?? null, todayYmd: tradeDate, nowMs, when, isTradingDay, isEtf,
      });
      overlays = step.overlays; seen = step.seen; records = step.records;
    }
    const res = resolveStop({ ...common, events: activeOverlays(overlays, tradeDate) });
    // resetEpisodes：S5 切換當天（phase 由 shadow 改 live 那一次）清掉影子期的事件，讓第一輪 live 判定以 seeded 彙總處理「已在停損下」的部位
    const episode = resetEpisodes ? null : carryEpisode(bp?.episode ?? null, res);
    const exS = exState[code] ?? {};
    bookPatch[code] = positionDoc(position, res, {
      ex, lineInputs: li, overlays, seen, episode, ticked: resetEpisodes ? false : bp?.ticked, legacy: bp?.legacy ?? null,
      exPending: exS.pending, exUnconfirmed: exS.unconfirmed,
    });
    for (const r of records) eventRecords.push({ code, ...r, when, dayYmd: tradeDate });
    docOnlyAlerts.push(...eventInfoAlerts(code, name, records, res, overlays, before, tradeDate, nowMs, isEtf));
    if (res.versionReason === 'exAdjust' && prev) {
      const evs = newExEvents(ex, prev.exApplied, res.exApplied);
      const f = evs.reduce((a, [, k]) => a * k, 1);
      const date = evs.length ? evs[evs.length - 1][0] : tradeDate;
      docOnlyAlerts.push(stopInfo(code, name, 'exAdjust', date, stopFactText('exAdjust', {
        date, factor: f, from: prev.stop, to: res.stop, costTo: res.adjCost, isEtf,
      }), nowMs, { threshold: res.stop ?? 0 }));
    }
    if (when === 'premarket' && exS.pending) docOnlyAlerts.push(stopInfo(code, name, 'exPending', tradeDate, stopFactText('exPending', {}), nowMs));
    if (when === 'premarket' && res.linesStale) {
      docOnlyAlerts.push(stopInfo(code, name, 'linesStale', tradeDate, stopFactText('linesStale', { dataDate: li?.dataDate }), nowMs));
    }
    if (res.exUnknown && !bp?.exUnknown) {
      docOnlyAlerts.push(stopInfo(code, name, 'exUnknown', tradeDate, stopFactText('exUnknown', { coverFrom: ex?.coverFrom }), nowMs));
    }
  }
  return { bookPatch, docOnlyAlerts: muted.size ? docOnlyAlerts.filter(a => !muted.has(a.code)) : docOnlyAlerts, eventRecords };
}

const M = (h, m) => h * 60 + m;
/** 事件收緊 B3 檢查與 setToday 用的真成交價：主迴圈快照 realTrade、非處置、非 13:24–13:35；沒有就 null */
function realTradePxOf(q, todayYmd, disposition) {
  if (!q || q.realTrade !== true || disposition || !isTodayTrade(q, todayYmd) || !isPos(q.price)) return null;
  const minute = taipeiMinuteOfDay(q.liveAt);
  return minute >= M(13, 24) && minute < M(13, 35) ? null : q.price;
}

const JUDGE_PX = Object.freeze({ touch: 'price', close: 'price', gap: 'open' });

/** 觸及當下的持有損益（%）：盤中觸及用現價、跳空用開盤價、收盤時用收盤價（＝現價）、補判用今日官方收盤 */
function touchPnlPct(touch, q, adjCost, officialClose = null) {
  if (!isPos(adjCost)) return null;
  const px = touch.kind === 'late' ? officialClose : touch.basis === 'trade' ? q?.price : q?.[JUDGE_PX[touch.kind] ?? 'price'];
  return isPos(px) ? ((px - adjCost) / adjCost) * 100 : null;
}

function level1Alert({ uid, code, name, res, touch, episode, quote, overlays, isEtf, nowMs, officialClose = null }) {
  const pnlPct = touchPnlPct(touch, quote, res.adjCost, officialClose);
  const sourceLabel = sourceLabelOf(res, overlays);
  const message = stopTouchPushText({
    code, name, touch, stop: res.stop, sourceLabel, price: touch.kind === 'late' ? null : quote?.price, pnlPct,
    at: touch.kind === 'late' ? null : quote?.revealAt ?? quote?.liveAt ?? null, isEtf,
  });
  return {
    alert: {
      id: `stop:${code}:v${res.stopVersion}:e${episode.id}`, requireAck: true, type: 'stop', sub: touch.kind, code, name,
      price: touch.kind === 'late' ? officialClose ?? 0 : quote?.price ?? 0, threshold: res.stop, pnlPct: isNum(pnlPct) ? +pnlPct.toFixed(2) : 0,
      stopVersion: res.stopVersion, episodeId: episode.id, touchBasis: touch.basis, skipPct: touch.skipPct,
      stopSource: res.stopSource, sourceDate: res.sourceDate, message, at: nowMs,
    },
    dedupKey: `${uid}:${code}:stop:v${res.stopVersion}:e${episode.id}`,
  };
}

/** 停損簿的一檔目前的停損狀態（不重算時直接用） */
function resFromBook(bp) {
  return {
    stop: bp.stop, baseStop: bp.baseStop, floorStop: bp.floorStop, bandHold: bp.bandHold, stopSource: bp.stopSource,
    sourceDate: bp.sourceDate, stopVersion: bp.stopVersion, versionReason: bp.versionReason, startedAt: bp.startedAt,
    tradeDate: bp.tradeDate, adjCost: bp.adjCost, exUnknown: !!bp.exUnknown, suspect: !!bp.suspect, atr14: bp.atr14 ?? null,
  };
}

/**
 * alertLoop 每一輪（盤中；SKILL §4、§8.1–§8.3、§10A.4 盤中趟）。持股與停損簿逐筆比對、套用盤中趟事件收緊、觸及判定、觸及事件推進。
 * 停損簿標 noOfficialBars 的代號（ETF／興櫃歸檔驗證前）不判定、不寫 episode——由舊分支照跑（SKILL §2、A3）。
 * 組成線來自尚未驗證的官方鏡像歸檔（lineInputs.archive；R8）：影子期照常判定（閘門 ⑥）；live 時照算、寫停損簿，但不發任何 v1.1 警示
 * （舊分支照跑；verifiedArchives 含該種類後才發）。
 * 回 { pushAlerts（一級 type:'stop'，帶 id、requireAck、touchBasis、stopSource、sourceDate、pnlPct）, docOnlyAlerts（二級 stopInfo）,
 *     bookPatch（有變動的代號）, dedupKeys, suppressOtherTypes（本輪觸及的代號 ⇒ 跳過 take／reentry）, nextEpisodeId, eventRecords }
 */
export function planUserStopTick(input) {
  const {
    uid, holdings, book = null, quotes = {}, nowMs, openMs, todayYmd, tradingDay = true, dispositionCodes,
    exState = {}, refPrices = {}, intradayEvents = [], dedupHas = () => false, isTradingDay, latestCanonicalYmd, names = {}, verifiedArchives = [],
  } = input ?? {};
  const disp = dispositionCodes instanceof Set ? dispositionCodes : new Set(Array.isArray(dispositionCodes) ? dispositionCodes : []);
  const positions = aggregatePositions(holdings);
  const pushAlerts = [], docOnlyAlerts = [], dedupKeys = [], eventRecords = [], seededCodes = [];
  const muted = new Set();
  const bookPatch = {};
  const suppressOtherTypes = new Set();
  let nextId = Number.isInteger(book?.nextEpisodeId) && book.nextEpisodeId > 0 ? book.nextEpisodeId : 1;
  for (const position of positions) {
    const code = position.code;
    const bp = book?.positions?.[code] ?? null;
    if (bp?.noOfficialBars === true) continue;
    const name = position.name || names[code] || '';
    const isEtf = isEtfCode(code);
    const q = quotes[code] ?? null;
    const ex = bp?.ex ?? EMPTY_EX_TABLE;
    const li = bp?.lineInputs ?? null;
    const mute = mutedAtLive(book, li, verifiedArchives);
    if (mute) muted.add(code);
    const disposition = disp.has(code);
    const before = Array.isArray(bp?.events) ? bp.events : [];
    let overlays = before;
    let seen = Array.isArray(bp?.eventSeen) ? bp.eventSeen : [];
    const common = {
      position, ex, prev: prevStateOf(bp), lines: li, latestCanonicalYmd, lastPrice: q?.price ?? null, nowMs, tradeDate: todayYmd, isEtf,
    };
    let res = resolveStop({ ...common, events: activeOverlays(overlays, todayYmd) });
    const evs = (Array.isArray(intradayEvents) ? intradayEvents : []).filter(e => e?.code === code);
    if (evs.length) {
      const step = stepEventOverlay(overlays, {
        events: evs, seen, baseStop: res.baseStop, firstDate: position.firstDate, refClose: li?.close ?? null, refYmd: li?.dataDate ?? null,
        atr14: li?.atr14 ?? null, lastTradePx: realTradePxOf(q, todayYmd, disposition) ?? li?.close ?? null,
        todayYmd, nowMs, when: 'intraday', isTradingDay, isEtf,
      });
      overlays = step.overlays; seen = step.seen;
      for (const r of step.records) eventRecords.push({ code, ...r, when: 'intraday', dayYmd: todayYmd });
      if (step.changed.length) res = resolveStop({ ...common, events: activeOverlays(overlays, todayYmd) });
      docOnlyAlerts.push(...eventInfoAlerts(code, name, step.records, res, overlays, before, todayYmd, nowMs, isEtf));
    }
    const exS = exState[code] ?? {};
    const setToday = isSetToday({ tradeDate: res.tradeDate, startedAt: res.startedAt }, todayYmd, openMs);
    const touch = evaluateTouch({
      stop: res.stop ?? 0, quote: q, nowMs, todayYmd, tradingDay, exPending: !!exS.pending, exUnconfirmed: !!exS.unconfirmed,
      exUnknown: res.exUnknown, suspect: res.suspect, isEtf, disposition, refPrice: refPrices[code] ?? null,
      setToday, startedAt: res.startedAt, atr14: res.atr14,
    });
    let episode = carryEpisode(bp?.episode ?? null, res);
    const seedNow = !bp?.ticked && !episode && isPos(li?.close) && isPos(res.stop) && li.close <= res.stop;
    const adv = advanceEpisode(episode, {
      touch, stopVersion: res.stopVersion, versionReason: res.versionReason, todayYmd, nowMs, nextId, seeded: seedNow, stopSource: res.stopSource,
    });
    if (adv.isNew) nextId += 1;
    episode = adv.episode;
    // 成本可疑：停損照算，但「本檔停損警示暫停」也涵蓋「已在停損下」彙總（2026-10-07 線上查核 4746；SKILL §3.4 成本可疑列）
    if (adv.isNew && episode?.seeded && !mute && !res.suspect) seededCodes.push(`${code} ${name}`.trim());
    if (touch.status === 'touched' && !mute) suppressOtherTypes.add(code);
    if (mute) {
      // 尚未驗證的官方鏡像歸檔（R8）：live 時舊分支照跑，這裡只更新停損簿、不發 v1.1 警示
    } else if (adv.sendLevel1) {
      const { alert, dedupKey } = level1Alert({ uid, code, name, res, touch, episode, quote: q, overlays, isEtf, nowMs });
      if (!dedupHas(dedupKey)) { pushAlerts.push(alert); dedupKeys.push(dedupKey); }
    } else if (adv.isNew && touch.status === 'touched' && touch.hold === 'exUnconfirmed') {
      docOnlyAlerts.push(stopInfo(code, name, 'exUnconfirmed', `e${episode.id}`, stopFactText('exUnconfirmed', { low: touch.triggerPx, stop: res.stop, isEtf }), nowMs));
    } else if (adv.isNew && touch.status === 'touched' && touch.hold === 'exUnknown') {
      docOnlyAlerts.push(stopInfo(code, name, 'touchHeld', `e${episode.id}`,
        `${stopFactText(touch.kind === 'gap' ? 'gap' : touch.kind === 'close' ? 'closeTouch' : 'touch', { low: touch.triggerPx, open: touch.triggerPx, stop: res.stop, skipPct: touch.skipPct, source: sourceLabelOf(res, overlays), isEtf })}·${stopFactText('exUnknown', { coverFrom: ex?.coverFrom })}`, nowMs));
    }
    if (res.suspect) {
      const ratio = isPos(q?.price) && isPos(res.adjCost) ? q.price / res.adjCost : null;
      docOnlyAlerts.push(stopInfo(code, name, 'suspect', todayYmd, stopFactText('suspect', { ratio }), nowMs));
    }
    const doc = positionDoc(position, res, {
      ex, lineInputs: li, overlays, seen, episode, ticked: true, legacy: bp?.legacy ?? null, exPending: exS.pending, exUnconfirmed: exS.unconfirmed,
    });
    if (!sameDoc(doc, bp)) bookPatch[code] = doc;
  }
  if (seededCodes.length) {
    docOnlyAlerts.push({ ...stopInfo('', '', 'seeded', todayYmd, stopFactText('seededDigest', { codes: seededCodes }), nowMs), id: `stopInfo:seeded:${todayYmd}` });
  }
  return {
    pushAlerts, docOnlyAlerts: muted.size ? docOnlyAlerts.filter(a => !muted.has(a.code)) : docOnlyAlerts,
    bookPatch, dedupKeys, suppressOtherTypes, nextEpisodeId: nextId, eventRecords,
  };
}

/**
 * 16:45 起的資料到齊班車（SKILL §4.2 補判、§8.2 事件結束、§3A 組成線、§10A.4 延後的事件收緊）。順序固定：
 *   ① 以「當天盤中適用的停損」跑收盤後補判 evaluateLateTouch（今日沒有觸及事件、不是 setToday 才補判；發一級 sub 'late'）與 settleEpisode；
 *   ② 以今日官方日 K 算出的 lineInputs 產生隔日起適用的版本（resolveStop；lineRaise／exAdjust…；版本日＝今日資料日）；
 *   ③ 延後的事件收緊以今日官方收盤重算，次一交易日生效。事件**到期不在這裡**處理（只在 planBookRefresh premarket）。
 * official：{ [code]: { open, high, low, close, noLimit? } }（今日定版官方日 K；noLimit＝沒有漲跌幅限制，興櫃）。
 * codes：只處理這些代號（其餘停損簿部位不動、不出現在 bookPatch）；null＝全部。daemon 收盤結算以此排除本機官方鏡像供給的 ETF／興櫃
 *   （當日鏡像 22:40 才有），改在下一交易日盤前以鏡像的前一交易日日 K 對這些代號補跑同一支（stop-shadow-runner mirrorSettle；R8）。
 * 回 { pushAlerts, docOnlyAlerts, bookPatch, dedupKeys, missedLive, nextEpisodeId, eventRecords }
 */
export function planCloseSettle(input) {
  const {
    uid, holdings, book = null, official = {}, lineInputs = {}, dateYmd, openMs, isTradingDay, exState = {}, refPrices = {},
    dedupHas = () => false, nowMs, names = {}, verifiedArchives = [], codes = null,
  } = input ?? {};
  const only = codes == null ? null : new Set(codes instanceof Set ? codes : Array.isArray(codes) ? codes : []);
  const positions = aggregatePositions(holdings);
  const pushAlerts = [], docOnlyAlerts = [], dedupKeys = [], missedLive = [], eventRecords = [];
  const muted = new Set();
  const bookPatch = {};
  let nextId = Number.isInteger(book?.nextEpisodeId) && book.nextEpisodeId > 0 ? book.nextEpisodeId : 1;
  for (const position of positions) {
    const code = position.code;
    if (only && !only.has(code)) continue;
    const bp = book?.positions?.[code] ?? null;
    const li = has(lineInputs, code) ? lineInputs[code] : (bp?.lineInputs ?? null);
    if (bp?.noOfficialBars === true && li?.noOfficialBars !== false) continue;
    const mute = mutedAtLive(book, li, verifiedArchives);
    if (mute) muted.add(code);
    const name = position.name || names[code] || '';
    const isEtf = isEtfCode(code);
    const o = official[code] ?? null;
    const ex = bp?.ex ?? EMPTY_EX_TABLE;
    const exS = exState[code] ?? {};
    let episode = bp?.episode ?? null;
    // ① 補判與事件結算（用當天適用的停損）
    if (bp && isPos(bp.stop) && o) {
      const hadEpisodeToday = !!episode && (episode.lastDate === dateYmd || episode.firstDate === dateYmd);
      const late = evaluateLateTouch({
        stop: bp.stop, officialOpen: o.open, officialLow: o.low, dateYmd, hadEpisodeToday,
        setToday: isSetToday({ tradeDate: bp.tradeDate, startedAt: bp.startedAt }, dateYmd, openMs),
        exPending: !!exS.pending, exUnconfirmed: !!exS.unconfirmed, exUnknown: !!bp.exUnknown, suspect: !!bp.suspect,
        isEtf, refPrice: refPrices[code] ?? null, noLimit: o.noLimit === true,
      });
      const adv = advanceEpisode(episode, { touch: late, stopVersion: bp.stopVersion, versionReason: null, todayYmd: dateYmd, nowMs, nextId, stopSource: bp.stopSource });
      if (adv.isNew) { nextId += 1; if (late.status === 'touched') missedLive.push(code); }
      episode = adv.episode;
      if (adv.sendLevel1 && !mute) {
        const { alert, dedupKey } = level1Alert({
          uid, code, name, res: resFromBook(bp), touch: late, episode, quote: null, overlays: bp.events ?? [], isEtf, nowMs, officialClose: o.close,
        });
        if (!dedupHas(dedupKey)) { pushAlerts.push(alert); dedupKeys.push(dedupKey); }
      }
      episode = settleEpisode(episode, { officialClose: o.close, stop: bp.stop, dateYmd }).episode;
    }
    // ② 隔日起適用的版本（疊加層不依日期過濾：到期只在盤前刷新移除，這裡照舊納入；延後層解除後次一交易日生效）
    const prev = prevStateOf(bp);
    const common = { position, ex, prev, lines: li, latestCanonicalYmd: dateYmd, lastPrice: o?.close ?? null, nowMs, tradeDate: dateYmd, isEtf };
    let overlays = Array.isArray(bp?.events) ? bp.events : [];
    let seen = Array.isArray(bp?.eventSeen) ? bp.eventSeen : [];
    let res = resolveStop({ ...common, events: activeOverlays(overlays) });
    // ③ 延後的事件收緊：今日官方收盤重算、次一交易日生效
    if (overlays.some(x => x?.state === 'deferred')) {
      const before = overlays;
      const step = stepEventOverlay(overlays, {
        seen, baseStop: res.baseStop, refClose: o?.close ?? null, atr14: li?.atr14 ?? null, todayYmd: dateYmd, nowMs, when: 'close', isTradingDay, isEtf,
      });
      overlays = step.overlays; seen = step.seen;
      for (const r of step.records) eventRecords.push({ code, ...r, when: 'close', dayYmd: dateYmd });
      if (step.changed.length) res = resolveStop({ ...common, events: activeOverlays(overlays) });
      docOnlyAlerts.push(...eventInfoAlerts(code, name, step.records, res, overlays, before, dateYmd, nowMs, isEtf));
    }
    episode = carryEpisode(episode, res);
    bookPatch[code] = positionDoc(position, res, {
      ex, lineInputs: li, overlays, seen, episode, ticked: bp?.ticked, legacy: bp?.legacy ?? null, exPending: exS.pending, exUnconfirmed: exS.unconfirmed,
    });
  }
  return {
    pushAlerts, docOnlyAlerts: muted.size ? docOnlyAlerts.filter(a => !muted.has(a.code)) : docOnlyAlerts,
    bookPatch, dedupKeys, missedLive, nextEpisodeId: nextId, eventRecords,
  };
}

/**
 * 停損紀律彙總（第 7 項裁定：保留每日推播與「請面對決策」；SKILL §8.4）：每個交易日 09:00 後第一輪、前一交易日官方收盤已定版時跑一次。
 * 停損簿標 suspect（成本可疑）的代號不列入——同日二級已寫「本檔停損警示暫停」，停損本身是用可疑成本算的。
 * 事件第 2 個交易日起、前一交易日官方收盤 ≤ 停損的代號組成**一則** type:'discipline'（照現行推播，不加 requireAck）。去重鍵 `${uid}:digest`。
 * prevCloses：前一交易日官方收盤。停損簿標 noOfficialBars 的代號、live 時組成線來自尚未驗證官方鏡像歸檔的代號（R8）留在舊紀律分支，不列入。
 */
export function planDisciplineDigest(input) {
  const { uid, book = null, holdings, prevCloses = {}, todayYmd, isTradingDay, dedupHas = () => false, nowMs = 0, names = {}, verifiedArchives = [] } = input ?? {};
  const dedupKey = `${uid}:digest`;
  if (dedupHas(dedupKey)) return { alert: null, dedupKey: null };
  const items = [];
  for (const p of aggregatePositions(holdings)) {
    const bp = book?.positions?.[p.code];
    if (!isObj(bp) || bp.noOfficialBars === true || !bp.episode || mutedAtLive(book, bp.lineInputs, verifiedArchives)) continue;
    if (bp.suspect === true) continue;   // 成本可疑：本檔停損警示暫停（含紀律彙總；停損是用可疑成本算的）
    const n = disciplineDay(bp.episode, todayYmd, prevCloses[p.code], bp.stop, isTradingDay);
    if (n == null) continue;
    items.push({
      code: p.code, name: p.name || names[p.code] || '', n, prevClose: prevCloses[p.code], stop: bp.stop, stopSource: bp.stopSource,
      triggerPx: bp.episode.triggerPx, qty: p.qty, isEtf: isEtfCode(p.code),
    });
  }
  const message = disciplineDigest(items);
  if (!message) return { alert: null, dedupKey: null };
  return {
    alert: {
      id: `discipline:${todayYmd}`, type: 'discipline', code: items[0].code, codes: items.map(x => x.code),
      name: items.length > 1 ? `${items[0].name} 等 ${items.length} 檔` : items[0].name,
      price: items[0].prevClose, threshold: items[0].stop, pnlPct: 0, days: items[0].n, message, at: nowMs,
    },
    dedupKey,
  };
}
