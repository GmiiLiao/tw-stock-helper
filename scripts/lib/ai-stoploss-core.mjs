// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1 共用純函式·核心：部位彙總、事件係數與逐筆還原成本、持股變動、resolveStop（四線取高＋兩段棘輪＋
// 事件收緊疊加＋自檢）、時段與觸及判定、收盤後補判、觸及事件與紀律天數。
// 對外一律經 scripts/lib/ai-stoploss.mjs（集線器）匯入；型別在 ai-stoploss.d.mts。規範 .claude/skills/tw-ai-stoploss/SKILL.md §3–§8。
// 規則：純函式——不 import firebase、不碰網路與檔案、不讀時鐘（時間一律由參數傳入），回傳新物件、不改輸入。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { warSegmentAt, taipeiYmd, taipeiMinuteOfDay } from './warroom-session.mjs';
import {
  STOP_SPEC_VERSION, STOP_PARAMS, isEtfCode, tickOf, ceilTick, floorTick, onTick, limitPrices, normYmd,
  countTradingDays, stopSourceLabel, stopFactText,
} from './ai-stoploss-base.mjs';
import { exCoverageOf, profitLines } from './ai-stoploss-lines.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const EPS = 1e-9;
const M = (h, m) => h * 60 + m;
/** daemon inCloseAuction（13:24–13:35）：這段的快照價可能是試撮指示價，不當真成交 */
const CLOSE_AUCTION_FROM = M(13, 24);
const CLOSE_AUCTION_TO = M(13, 35);
const JUDGING_SEGMENTS = Object.freeze(['open', 'mid', 'tail', 'closing']);

// ── 部位彙總 ────────────────────────────────────────────────────────────────

/**
 * 持股依代號彙總（衍生自舊 warroom-stop.aggregateHoldings：同一略過規則——買價或張數不是正數的列不計入；保留首次出現順序），
 * 另帶每筆 id（沒有 id 的列以「代號#序號」補，只供本機比對，不寫回）。
 */
export function aggregatePositions(lots) {
  const by = new Map();
  (Array.isArray(lots) ? lots : []).forEach((h, i) => {
    if (!h || typeof h.code !== 'string' || !h.code) return;
    const qty = Number(h.quantity);
    const buyPrice = Number(h.buyPrice);
    if (!isPos(qty) || !isPos(buyPrice)) return;
    let g = by.get(h.code);
    if (!g) { g = { code: h.code, name: '', qty: 0, cost: 0, lots: [] }; by.set(h.code, g); }
    if (!g.name && typeof h.name === 'string') g.name = h.name;
    g.qty += qty;
    g.cost += buyPrice * qty;
    const id = typeof h.id === 'string' && h.id ? h.id : `${h.code}#${i}`;
    g.lots.push({ id, buyPrice, qty, buyDate: normYmd(h.buyDate) || null });
  });
  return [...by.values()].map(g => {
    const dates = g.lots.map(l => l.buyDate).filter(Boolean).sort();
    return {
      code: g.code, name: g.name, qty: g.qty, avgCost: g.cost / g.qty,
      firstDate: dates[0] ?? null, lastBuyDate: dates[dates.length - 1] ?? null, lots: g.lots,
    };
  });
}

// ── 事件係數（官方除權息＋priceEvents，呼叫端先以 exright-source.mergeFactorItems 合併） ─────

/**
 * 該代號在涵蓋區間內的事件表（依日期排序、同日只取第一筆——mergeFactorItems 已讓官方除權息優先）。
 * cover.from 由呼叫端取 min(日 K 視窗第一根, 最早買進日)、cover.to ≥ 資料日（SKILL §3.1、§3.4 係數涵蓋）。
 */
export function exTableFor(code, mergedItems, cover) {
  const from = cover?.from ?? null, to = cover?.to ?? null;
  const seen = new Set();
  const events = (Array.isArray(mergedItems) ? mergedItems : [])
    .filter(x => x && x.code === code && isPos(x.factor) && typeof x.date === 'string'
      && (!from || x.date >= from) && (!to || x.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter(x => (seen.has(x.date) ? false : (seen.add(x.date), true)))
    .map(x => Object.freeze([x.date, x.factor]));
  return { events, coverFrom: from, coverTo: to };
}

/** 沒有係數表時（前端拿不到停損簿 stopBooks）傳這張空表：不還原、不判 exUnknown，依據文字標「未含除權息調整」（SKILL §3.6） */
export const EMPTY_EX_TABLE = Object.freeze({ events: Object.freeze([]), coverFrom: null, coverTo: null });

const evList = ex => (Array.isArray(ex?.events) ? ex.events : []);
/** 事件日 > ymd 的係數連乘（ymd 缺 ⇒ 1） */
const factorAfter = (ex, ymd) => (typeof ymd === 'string' && ymd
  ? evList(ex).filter(([d]) => d > ymd).reduce((acc, [, f]) => acc * f, 1) : 1);

/**
 * 逐筆還原成本：每筆 buyPrice × Π f（事件日 > 該筆買進日；使用者已自行調整的事件略過），再依張數加權。
 * exUnknown：某筆買進日早於係數表涵蓋起點（或沒有買進日）。係數表 coverFrom 為 null ＝沒有係數表（前端退回）⇒ 不判 exUnknown。
 */
export function adjustedCost(pos, ex, selfAdjusted) {
  const coverFrom = ex?.coverFrom ?? null;
  const applied = new Set();
  let exUnknown = false, sum = 0, qty = 0;
  for (const l of pos?.lots ?? []) {
    if (!isPos(l.qty) || !isPos(l.buyPrice)) continue;
    let px = l.buyPrice;
    if (!l.buyDate) { if (coverFrom) exUnknown = true; }
    else {
      if (coverFrom && l.buyDate < coverFrom) exUnknown = true;
      const skip = new Set(selfAdjusted?.[l.id] ?? []);
      for (const [d, f] of evList(ex)) {
        if (d > l.buyDate && !skip.has(d)) { px *= f; applied.add(d); }
      }
    }
    sum += px * l.qty;
    qty += l.qty;
  }
  return { adjCost: qty > 0 ? sum / qty : NaN, exUnknown, applied: [...applied].sort() };
}

const near = (a, b, eps = EPS) => Math.abs(a - b) <= eps;

/** 同一 id 的買價／張數改動是否等於某個事件的自行調整（買價比 ≈ f ±1 檔、張數比 ≈ 1/f），回該事件日或 null */
function selfAdjustEvent(prevLot, curLot, ex, isEtf) {
  if (prevLot.buyDate !== curLot.buyDate || !prevLot.buyDate) return null;
  for (const [d, f] of evList(ex)) {
    if (d <= prevLot.buyDate) continue;
    const priceOk = Math.abs(curLot.buyPrice - prevLot.buyPrice * f) <= tickOf(curLot.buyPrice, isEtf) + EPS;
    const qtyOk = Math.abs((curLot.qty * f) / prevLot.qty - 1) <= 0.02;
    if (priceOk && qtyOk) return d;
  }
  return null;
}

/** SKILL §3.2 步驟 3：以每筆 id 比對上一版快照 */
export function classifyLotChange(prevLots, cur, ex, isEtf = false) {
  const changes = new Set(), editedIds = [], selfAdjusted = {};
  if (!Array.isArray(prevLots)) return { changes: ['init'], editedIds, selfAdjusted };
  const curList = Array.isArray(cur) ? cur : [];
  if (!curList.length) return { changes: ['exit'], editedIds, selfAdjusted };
  const prevById = new Map(prevLots.map(l => [l.id, l]));
  const curIds = new Set(curList.map(l => l.id));
  for (const l of prevLots) if (!curIds.has(l.id)) changes.add('sell');
  for (const l of curList) {
    const p = prevById.get(l.id);
    if (!p) { changes.add('buy'); continue; }
    const samePrice = near(p.buyPrice, l.buyPrice), sameDate = p.buyDate === l.buyDate;
    if (samePrice && sameDate) {
      if (l.qty > p.qty + EPS) changes.add('buy');
      else if (l.qty < p.qty - EPS) changes.add('sell');
      continue;
    }
    const d = selfAdjustEvent(p, l, ex, isEtf);
    if (d) { changes.add('selfAdjust'); selfAdjusted[l.id] = [d]; continue; }
    changes.add('edit');
    editedIds.push(l.id);
  }
  return { changes: [...changes], editedIds, selfAdjusted };
}

// ── 過渡期（第一階段）推播口徑：與 daemon checkAlerts（錨點 `a.stopLoss > 0 ? a.stopLoss : +(avg * 0.92).toFixed(2)`）同 ─────

export function legacyPushStop(avgCost, aiStopLoss) {
  if (!isPos(avgCost)) return null;
  if (isPos(aiStopLoss)) return { price: aiStopLoss, source: 'ai' };
  return { price: +(avgCost * 0.92).toFixed(2), source: 'cost' };
}

/** 第一階段停損紀律／崩盤防禦口徑：max(ATR 帶, 成本×0.92)（daemon 錨點 `+Math.max(a.stopLoss > 0 ? a.stopLoss : 0, avg * 0.92).toFixed(2)`） */
export function legacyDisciplineStop(avgCost, aiStopLoss) {
  if (!isPos(avgCost)) return null;
  return +Math.max(isPos(aiStopLoss) ? aiStopLoss : 0, avgCost * 0.92).toFixed(2);
}

// ── v1.1 決定停損（SKILL §3.2–§3.4） ───────────────────────────────────────

const validStop = (v, isEtf) => isPos(v) && onTick(v, isEtf);
const maxPos = (...vals) => vals.reduce((m, v) => (isPos(v) && (m == null || v > m) ? v : m), null);
const FLOOR_SOURCES = new Set(['cost', 'breakeven', 'trail']);
/** 自檢「只升不降」的例外（SKILL §3.4） */
const DROP_OK = new Set(['exAdjust', 'costCorrection', 'init', 'eventExpire', 'bandDown', 'userSet']);
/** 停損換版時觸及事件延續的版本原因（SKILL §8.2 版本延續表） */
export const EPISODE_CONTINUE_REASONS = Object.freeze(['exAdjust', 'lineRaise', 'eventTighten', 'eventExpire', 'bandDown']);

function mergeSelfAdjusted(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const [id, ds] of Object.entries(src ?? {})) out[id] = [...new Set([...(out[id] ?? []), ...(ds ?? [])])].sort();
  }
  return out;
}

function prevStateOk(prev, isEtf) {
  if (!isObj(prev)) return false;
  if (!validStop(prev.stop, isEtf) || !Number.isInteger(prev.stopVersion) || prev.stopVersion < 1 || !Array.isArray(prev.lots)) return false;
  for (const k of ['baseStop', 'floorStop', 'bandHold']) if (prev[k] != null && !validStop(prev[k], isEtf)) return false;
  return true;
}

/** 帶值檢查（SKILL §3.4「帶值」列）；通過回 null，否則回原因 */
function bandCheck(price, close, isEtf, bandYmd, latest) {
  if (!isPos(price)) return '帶值不是正數';
  if (!onTick(price, isEtf)) return '帶值不在檔位上';
  if (isPos(close)) {
    if (price >= close - EPS) return '帶值不低於收盤';
    if (price < close * STOP_PARAMS.bandClampLo - tickOf(price, isEtf) - EPS) return '帶值低於收盤 −15% 再減 1 檔';
  }
  if (typeof latest === 'string' && latest && bandYmd !== latest) return '帶值資料日不是最近定版日';
  return null;
}

/**
 * 當日組成線（SKILL §3.2 步驟 4）。lines 的價格口徑是 lines.dataDate 當天；之後才生效的除權息事件以係數表再乘一次（idempotent）。
 * carry：今天不採用由日 K 算出的值（資料延遲、帶值不通過、係數涵蓋不足）⇒ 棘輪值沿用上一版。
 */
function todayLinesOf({ lines, ex, position, adjCost, isEtf, latestCanonicalYmd }) {
  const out = {
    bandLine: null, beLine: null, trailLine: null, holdHigh: null, atr14: null, close: null, dataDate: null, bandYmd: null,
    linesStale: false, noOfficialBars: false, bandRejected: null, exGap: false, exGapBars: 0, carry: false,
  };
  if (!isObj(lines)) return out;
  if (lines.noOfficialBars === true) return { ...out, noOfficialBars: true };
  const dataDate = typeof lines.dataDate === 'string' && lines.dataDate ? lines.dataDate : null;
  out.dataDate = dataDate;
  // 前端暫算不傳 latestCanonicalYmd ⇒ 不判 linesStale（SKILL §3.6 最後一列）
  if (typeof latestCanonicalYmd === 'string' && latestCanonicalYmd && dataDate !== latestCanonicalYmd) {
    return { ...out, linesStale: true, carry: true };
  }
  // 係數涵蓋（SKILL §3.4）：只有用還原日 K 算的組成線才檢查（前端暫算 barsFrom 為 null）
  if (lines.barsFrom != null) {
    const cov = exCoverageOf(ex, lines.barsFrom, dataDate);
    const gapBars = Math.max(cov.exGapBars, Number.isInteger(lines.exGapBars) ? lines.exGapBars : 0);
    if (!cov.ok || gapBars > 0) return { ...out, exGap: true, exGapBars: Math.max(gapBars, 1), carry: true };
  }
  const fL = factorAfter(ex, dataDate);
  const scale = v => (isPos(v) ? v * fL : null);
  out.atr14 = scale(lines.atr14);
  out.close = scale(lines.close);
  const hh = lines.holdHigh;
  if (isObj(hh) && isPos(hh.price) && (hh.from == null || hh.from === position.firstDate)) out.holdHigh = { ...hh, price: hh.price * fL };
  const b = lines.atrBand;
  if (isObj(b) && position.firstDate && typeof b.dataDate === 'string' && b.dataDate >= position.firstDate) {
    const price = !isPos(b.price) || near(fL, 1) ? b.price : floorTick(b.price * fL, isEtf);
    const why = bandCheck(price, out.close, isEtf, b.dataDate, latestCanonicalYmd);
    if (why) { out.bandRejected = why; out.carry = true; } else { out.bandLine = price; out.bandYmd = b.dataDate; }
  }
  const pl = profitLines(adjCost, out.holdHigh?.price ?? null, out.atr14, isEtf);
  out.beLine = pl.beLine;
  out.trailLine = pl.trailLine;
  return out;
}

/** 期限內的事件收緊疊加層（SKILL §10A）：只取 state 'active'、線有效者；口徑日（refYmd）之後的除權息再乘係數並向上取檔 */
function effectiveOverlays(events, ex, isEtf) {
  const out = [];
  for (const o of Array.isArray(events) ? events : []) {
    if (!isObj(o) || o.state === 'deferred' || !isPos(o.line)) continue;
    const f = factorAfter(ex, o.refYmd);
    const line = near(f, 1) ? o.line : ceilTick(o.line * f, isEtf);
    if (validStop(line, isEtf)) out.push({ o, line });
  }
  return out;
}

function noCostResult(base, prev, nowMs, tradeDate) {
  return {
    ...base, stop: null, baseStop: null, floorStop: null, bandHold: null, basisText: '成本資料缺',
    stopSource: null, sourceDate: null, floorSource: null, floorSourceDate: null, bandSourceDate: null,
    adjCost: null, costLine: null, lines: { costLine: null, bandLine: null, beLine: null, trailLine: null, eventLine: null },
    linesStale: false, bandRejected: null, exGapBars: 0, holdHigh: null, atr14: null, noOfficialBars: false, eventKeys: [],
    stopVersion: prev?.stopVersion ?? 0, versionReason: null,
    startedAt: prev?.startedAt ?? nowMs, tradeDate: prev?.tradeDate ?? tradeDate,
  };
}

/** 決定 floorStop 的來源（同值依 追蹤 > 保本 > 成本） */
function floorSourceOf(costLine, beLine, trailLine, floor) {
  if (isPos(trailLine) && near(trailLine, floor)) return 'trail';
  if (isPos(beLine) && near(beLine, floor)) return 'breakeven';
  return 'cost';
}

/**
 * 決定停損（SKILL §3.2–§3.4）。純函式：回傳新物件，不改輸入。
 * 基礎停損＝max(floorStop〔成本線、保本線、追蹤線的棘輪〕, bandHold〔ATR 帶；bandRatchet=false 時取當日值〕)；
 * 生效停損＝max(基礎停損, 期限內的事件收緊線)。v1 的上一版（只有 stop）視同 floorStop＝stop。
 */
export function resolveStop(input) {
  const { position, ex, prev = null, lastPrice = null, nowMs, tradeDate } = input;
  const capPct = isPos(input.capPct) ? input.capPct : STOP_PARAMS.capPct;
  const isEtf = input.isEtf ?? isEtfCode(position?.code);
  const bandRatchet = typeof input.bandRatchet === 'boolean' ? input.bandRatchet : STOP_PARAMS.bandRatchet;
  const rejected = [];
  const base = {
    specVersion: STOP_SPEC_VERSION, line: 'stop', basis: 'system', lotChanges: [], exApplied: [], selfAdjusted: {},
    exUnknown: false, suspect: false, rejected,
  };
  if (!position || !isPos(position.avgCost) || !position.lots?.length) return noCostResult(base, prev, nowMs, tradeDate);
  const prevOk = prevStateOk(prev, isEtf);
  if (prev && !prevOk) rejected.push({ code: 'prevInvalid', detail: `上一版停損不合法：${String(prev?.stop)}` });
  const p = prevOk ? prev : null;

  const cls = classifyLotChange(p ? p.lots : null, position.lots, ex, isEtf);
  const edited = cls.changes.includes('edit');
  const lotChanged = cls.changes.some(c => c === 'buy' || c === 'sell' || c === 'selfAdjust');
  const selfAdjusted = mergeSelfAdjusted(p?.selfAdjusted, cls.selfAdjusted);
  const { adjCost, exUnknown, applied } = adjustedCost(position, ex, selfAdjusted);
  const costLine = ceilTick(adjCost * (1 - capPct / 100), isEtf);
  // 已計入的事件＝套進還原成本的，加上使用者已自行調整的（同一輪才被認出的自行調整，停損仍要依係數帶下來）
  const accounted = [...new Set([...applied, ...Object.values(selfAdjusted).flat()])].sort();
  const prevApplied = new Set(p?.exApplied ?? []);
  const fNew = evList(ex).filter(([d]) => accounted.includes(d) && !prevApplied.has(d)).reduce((acc, [, f]) => acc * f, 1);
  const hasNewEx = !near(fNew, 1);

  const L = todayLinesOf({ lines: input.lines, ex, position, adjCost, isEtf, latestCanonicalYmd: input.latestCanonicalYmd });
  if (L.exGap) rejected.push({ code: 'exGap', detail: `係數表涵蓋不到日 K 視窗（${L.exGapBars} 根）` });
  if (L.bandRejected) rejected.push({ code: 'bandInvalid', detail: L.bandRejected });
  const reset = !p || edited;

  // ① floorStop：成本線、保本線、追蹤線的棘輪
  const floorToday = maxPos(costLine, L.beLine, L.trailLine);
  const floorTodaySrc = floorSourceOf(costLine, L.beLine, L.trailLine, floorToday);
  const floorTodayDate = floorTodaySrc === 'cost' ? tradeDate : L.dataDate;
  const carriedFloor = p ? ceilTick((isPos(p.floorStop) ? p.floorStop : p.stop) * fNew, isEtf) : null;
  let floorStop, floorSource, floorSourceDate;
  if (reset || carriedFloor == null || (isPos(floorToday) && floorToday > carriedFloor + EPS)) {
    floorStop = floorToday; floorSource = floorTodaySrc; floorSourceDate = floorTodayDate;
  } else {
    floorStop = carriedFloor;
    floorSource = FLOOR_SOURCES.has(p.floorSource) ? p.floorSource : 'cost';
    floorSourceDate = p.floorSourceDate ?? p.tradeDate ?? null;
  }

  // ② bandHold：ATR 帶（bandRatchet＝true 併入只升不降；false 取當日值，資料延遲或不通過時沿用上一版）
  const carriedBand = p && isPos(p.bandHold) ? ceilTick(p.bandHold * fNew, isEtf) : null;
  let bandHold = null, bandSourceDate = null;
  if (reset) {
    bandHold = L.bandLine; bandSourceDate = L.bandLine != null ? L.bandYmd : null;
  } else if (bandRatchet) {
    if (L.bandLine != null && (carriedBand == null || L.bandLine > carriedBand + EPS)) { bandHold = L.bandLine; bandSourceDate = L.bandYmd; }
    else if (carriedBand != null) { bandHold = carriedBand; bandSourceDate = p.bandSourceDate ?? null; }
  } else if (L.bandLine != null) {
    bandHold = L.bandLine; bandSourceDate = L.bandYmd;
  } else if (L.carry && carriedBand != null) {
    bandHold = carriedBand; bandSourceDate = p.bandSourceDate ?? null;
  }

  // ③ 基礎停損與事件收緊
  const baseStopRaw = maxPos(floorStop, bandHold);
  const overlays = effectiveOverlays(input.events, ex, isEtf);
  const top = overlays.reduce((m, x) => (m == null || x.line > m.line ? x : m), null);
  let stop = baseStopRaw;
  let stopSource, sourceDate;
  if (top && (baseStopRaw == null || top.line >= baseStopRaw - EPS)) {
    stop = maxPos(baseStopRaw, top.line); stopSource = 'event'; sourceDate = top.o.effectiveFrom ?? null;
  } else if (bandHold != null && (floorStop == null || bandHold > floorStop + EPS || (near(bandHold, floorStop) && floorSource === 'cost'))) {
    stopSource = 'atrBand'; sourceDate = bandSourceDate;
  } else {
    stopSource = floorSource; sourceDate = floorSourceDate;
  }

  // ④ 版本原因與自檢（SKILL §3.4）
  const curKeys = overlays.map(x => x.o.key).filter(k => typeof k === 'string').sort();
  const prevKeys = Array.isArray(p?.eventKeys) ? p.eventKeys : [];
  const changed = !p || stop == null || !near(stop, p.stop);
  let reason = null;
  if (!p) reason = 'init';
  else if (edited) reason = 'costCorrection';
  else if (hasNewEx && changed) reason = 'exAdjust';
  else if (changed) {
    if (stop < p.stop - EPS) {
      if (prevKeys.some(k => !curKeys.includes(k))) reason = 'eventExpire';
      else if (!bandRatchet) reason = 'bandDown';
      else reason = 'lineRaise';   // 不該發生的下降：下面自檢記 loosen
    } else if (lotChanged) reason = 'ratchet';
    else if (stopSource === 'event' && curKeys.some(k => !prevKeys.includes(k))) reason = 'eventTighten';
    else reason = 'lineRaise';
  }
  const prevFloorCheck = p ? ceilTick(p.stop * fNew, isEtf) : null;
  if (!validStop(stop, isEtf)) rejected.push({ code: 'invalid', detail: `停損不合法：${String(stop)}` });
  else if (isPos(costLine) && stop < costLine - EPS) rejected.push({ code: 'tooWide', detail: `${stop} 寬於成本線 ${costLine}` });
  else if (p && changed && !DROP_OK.has(reason) && prevFloorCheck != null && stop < prevFloorCheck - EPS) {
    rejected.push({ code: 'loosen', detail: `${stop} 低於上一版 ${prevFloorCheck}` });
  }
  const failed = rejected.some(r => r.code === 'invalid' || r.code === 'tooWide' || r.code === 'loosen');

  const ratio = isPos(lastPrice) && isPos(adjCost) ? lastPrice / adjCost : null;
  const suspect = ratio != null && (ratio < STOP_PARAMS.suspectLo || ratio > STOP_PARAMS.suspectHi);
  const holdHigh = L.holdHigh ?? (p && isObj(p.holdHigh) && isPos(p.holdHigh.price) ? { ...p.holdHigh, price: p.holdHigh.price * fNew } : null);
  const shared = {
    adjCost, costLine,
    lines: { costLine, bandLine: L.bandLine, beLine: L.beLine, trailLine: L.trailLine, eventLine: top ? top.line : null },
    linesStale: L.linesStale, bandRejected: L.bandRejected, exGapBars: L.exGapBars, holdHigh, atr14: L.atr14,
    noOfficialBars: L.noOfficialBars, lotChanges: cls.changes, selfAdjusted, exUnknown, suspect,
  };

  if (failed && p) {
    // 自檢不通過：保留上一版（事件也不算已套用，下一輪重算）
    return {
      ...base, ...shared,
      stop: p.stop, baseStop: isPos(p.baseStop) ? p.baseStop : p.stop, floorStop: isPos(p.floorStop) ? p.floorStop : p.stop,
      bandHold: isPos(p.bandHold) ? p.bandHold : null,
      stopSource: p.stopSource ?? 'cost', sourceDate: p.sourceDate ?? p.tradeDate ?? null,
      floorSource: FLOOR_SOURCES.has(p.floorSource) ? p.floorSource : 'cost', floorSourceDate: p.floorSourceDate ?? p.tradeDate ?? null,
      bandSourceDate: p.bandSourceDate ?? null,
      basisText: typeof p.basisText === 'string' && p.basisText ? p.basisText : stopSourceLabel('cost', { form: 'row', adjCost, hasExTable: ex?.coverFrom != null, capPct }),
      eventKeys: prevKeys,
      stopVersion: p.stopVersion, versionReason: null, startedAt: p.startedAt, tradeDate: p.tradeDate,
      exApplied: [...(p.exApplied ?? [])],
    };
  }
  if (failed) {
    stop = validStop(costLine, isEtf) ? costLine : null;
    floorStop = stop; floorSource = 'cost'; floorSourceDate = tradeDate; bandHold = null; bandSourceDate = null;
    stopSource = stop != null ? 'cost' : null; sourceDate = stop != null ? tradeDate : null;
  }
  const baseStop = failed ? stop : baseStopRaw;
  const holdHighPct = holdHigh && isPos(adjCost) ? (holdHigh.price / adjCost - 1) * 100 : null;
  const basisText = stopSource === 'event'
    ? stopSourceLabel('event', { form: 'row', effectiveFrom: top.o.effectiveFrom, expiresAfter: top.o.expiresAfter, label: top.o.label })
    : stopSource === 'atrBand' ? stopSourceLabel('atrBand', { form: 'row', sourceDate: bandSourceDate, ratchet: bandRatchet })
      : stopSource === 'breakeven' ? stopSourceLabel('breakeven', { form: 'row', holdHighPct })
        : stopSource === 'trail'
          ? stopSourceLabel('trail', { form: 'row', holdHigh: holdHigh?.price, fresh: floorSourceDate === L.dataDate && near(L.trailLine ?? NaN, floorStop), sourceDate: floorSourceDate, isEtf })
          : stopSourceLabel('cost', { form: 'row', adjCost, hasExTable: ex?.coverFrom != null, capPct });
  const prevVer = Number.isInteger(prev?.stopVersion) && prev.stopVersion >= 0 ? prev.stopVersion : 0;
  const bump = !p || changed;
  return {
    ...base, ...shared,
    stop, baseStop, floorStop, bandHold, basisText,
    stopSource, sourceDate, floorSource, floorSourceDate, bandSourceDate,
    eventKeys: failed ? [] : curKeys,
    stopVersion: bump ? prevVer + 1 : p.stopVersion,
    versionReason: bump ? (failed ? 'init' : reason) : null,
    startedAt: bump ? nowMs : p.startedAt,
    tradeDate: bump ? tradeDate : p.tradeDate,
    exApplied: accounted,
  };
}

// ── 時段與觸及判定（SKILL §4） ─────────────────────────────────────────────

/** ＝ warroom-session.warSegmentAt（時段唯一真相來源） */
export function judgeSegment(nowMs, tradingDay) {
  return warSegmentAt(nowMs, tradingDay);
}

/** open／mid／tail／closing 以價格判定；pre／preclear（試撮）、auction（收盤競價）、after、nontrading 不判定 */
export function segmentJudges(seg) {
  return JUDGING_SEGMENTS.includes(seg);
}

/** 今日真成交：有 liveAt 且台北日期是今天、盤中 live 或收盤後沿用的今日最後即時價（settled 有值）、今日有量。種子價沒有 liveAt 一律不算 */
export function isTodayTrade(q, todayYmd) {
  if (!q || !isPos(q.liveAt) || taipeiYmd(q.liveAt) !== todayYmd) return false;
  if (q.live !== true && typeof q.settled !== 'boolean') return false;
  return isPos(q.volume);
}

/** 今日盤中才生效的停損版本：版本日是今天、生效時刻晚於今天 09:00 */
export function isSetToday(ver, todayYmd, openMs) {
  return !!ver && ver.tradeDate === todayYmd && isNum(ver.startedAt) && ver.startedAt > openMs;
}

/** 距停損：pct＝(現價−停損)÷現價×100（未四捨五入）；逼近＝現價在停損上方且 ≤1×ATR14，沒有 ATR 時 ≤2% */
export function stopDistance(stop, price, atr14) {
  if (!isPos(stop) || !isPos(price)) return null;
  const diff = price - stop;
  const pct = (diff / price) * 100;
  const atrMultiple = isPos(atr14) ? diff / atr14 : null;
  const isNear = diff > 0 && (atrMultiple != null ? atrMultiple <= STOP_PARAMS.nearAtr : pct <= STOP_PARAMS.nearPctFallback);
  return { pct, atrMultiple, near: isNear };
}

function staleSecOf(q, nowMs) {
  const at = isPos(q?.revealAt) ? q.revealAt : isPos(q?.liveAt) ? q.liveAt : null;
  return at != null && isNum(nowMs) ? Math.max(0, Math.round((nowMs - at) / 1000)) : null;
}

function touchFacts({ q, low, isEtf, limits, disposition, staleSec }) {
  const facts = [];
  if (limits && near(low, limits.down)) {
    const locked = near(q.open, limits.down) && near(q.high, limits.down);
    facts.push(stopFactText('limitDown', { price: limits.down, locked, isEtf }));
  }
  if (disposition) facts.push(stopFactText('disposition', {}));
  if (staleSec != null && staleSec > STOP_PARAMS.staleSec) {
    facts.push(stopFactText('stale', { minutes: Math.round(staleSec / 60), at: q.revealAt ?? q.liveAt }));
  }
  return facts;
}

/**
 * 盤中觸及判定（SKILL §4.1–§4.6）。只認今日成交更新的 low（試撮 pz、五檔中價、昨收種子價一律不用）；
 * setToday（今日盤中才生效的停損）只認 liveAt > startedAt 的真成交價（realTrade、非處置、非 13:24–13:35），不符就當日不判定。
 * skipPct：開盤已跳過停損的幅度，百分比（(停損−開盤)÷停損×100）。
 */
export function evaluateTouch(input) {
  const { stop, quote: q, nowMs, todayYmd, tradingDay, isEtf = false, disposition = false } = input;
  const segment = judgeSegment(nowMs, tradingDay);
  const staleSec = staleSecOf(q, nowMs);
  const out = (status, extra = {}) => ({
    status, kind: null, triggerPx: null, skipPct: null, basis: null, segment, notJudged: null, hold: null,
    staleSec, facts: [], ...extra,
  });
  const notJudged = reason => out('notJudged', { notJudged: reason });
  const distStatus = px => {
    const d = stopDistance(stop, px, input.atr14);
    return out(d?.near ? 'near' : 'ok');
  };
  if (!isPos(stop)) return notJudged('noStop');
  if (!segmentJudges(segment)) return notJudged('segment');
  if (input.exPending) return notJudged('exPending');
  if (input.suspect) return notJudged('suspectCost');
  if (!isTodayTrade(q, todayYmd)) return notJudged('noTodayTrade');
  const hold = input.exUnconfirmed ? 'exUnconfirmed' : input.exUnknown ? 'exUnknown' : null;
  const touchedKind = segment === 'closing' ? 'close' : 'touch';

  if (input.setToday) {
    const minute = taipeiMinuteOfDay(q.liveAt);
    const inAuction = minute >= CLOSE_AUCTION_FROM && minute < CLOSE_AUCTION_TO;
    if (disposition || inAuction || q.realTrade !== true || !(q.liveAt > (input.startedAt ?? Infinity))) return notJudged('noTodayTrade');
    if (!onTick(q.price, isEtf)) return notJudged('noTodayTrade');
    if (q.price > stop) return distStatus(q.price);
    const facts = [stopFactText('tradeBasis', {}), ...touchFacts({ q, low: q.price, isEtf, limits: null, disposition, staleSec })];
    return out('touched', { kind: touchedKind, triggerPx: q.price, basis: 'trade', hold, facts });
  }

  const low = q.low;
  const limits = limitPrices(input.refPrice ?? null, isEtf, !!input.noLimit);
  if (!isPos(low) || !onTick(low, isEtf) || (limits && low < limits.down - EPS)) return notJudged('badLow');
  if (low > stop) return distStatus(q.price);
  const gap = isPos(q.open) && onTick(q.open, isEtf) && q.open <= stop;
  const facts = touchFacts({ q, low, isEtf, limits, disposition, staleSec });
  return out('touched', {
    kind: gap ? 'gap' : touchedKind,
    triggerPx: gap ? q.open : low,
    skipPct: gap ? +(((stop - q.open) / stop) * 100).toFixed(2) : null,
    basis: 'low', hold, facts,
  });
}

/**
 * 收盤後補判（SKILL §4.2 after 列；第 5 項裁定：發一級）：16:45 起的資料到齊班車，以「當天盤中適用的停損」比對官方日低。
 * 該檔今天已有觸及事件、或停損是今日盤中才生效的版本（setToday）⇒ 不補判。開盤就低於停損時觸發價記開盤價。
 */
export function evaluateLateTouch(input) {
  const { stop, officialOpen, officialLow, isEtf = false } = input;
  const out = (status, extra = {}) => ({
    status, kind: null, triggerPx: null, skipPct: null, basis: null, segment: 'after', notJudged: null, hold: null,
    staleSec: null, facts: [], ...extra,
  });
  const notJudged = reason => out('notJudged', { notJudged: reason });
  if (!isPos(stop)) return notJudged('noStop');
  if (input.hadEpisodeToday) return out('ok');
  if (input.setToday) return notJudged('setTodayLate');
  if (input.exPending) return notJudged('exPending');
  if (input.suspect) return notJudged('suspectCost');
  const limits = limitPrices(input.refPrice ?? null, isEtf, !!input.noLimit);
  if (!isPos(officialLow) || !onTick(officialLow, isEtf) || (limits && officialLow < limits.down - EPS)) return notJudged('badLow');
  if (officialLow > stop) return out('ok');
  const hold = input.exUnconfirmed ? 'exUnconfirmed' : input.exUnknown ? 'exUnknown' : null;
  const gap = isPos(officialOpen) && onTick(officialOpen, isEtf) && officialOpen <= stop;
  const facts = [];
  if (limits && near(officialLow, limits.down)) {
    const locked = gap && near(officialOpen, limits.down);
    facts.push(stopFactText('limitDown', { price: limits.down, locked, isEtf }));
  }
  return out('touched', {
    kind: 'late', triggerPx: gap ? officialOpen : officialLow,
    skipPct: gap ? +(((stop - officialOpen) / stop) * 100).toFixed(2) : null,
    basis: 'officialLow', hold, facts,
  });
}

// ── 觸及事件（SKILL §8.2） ─────────────────────────────────────────────────

/**
 * 推進觸及事件。事件由第一次觸及開始；同一事件只發一次一級（hold 'exUnconfirmed' 解除時補發一次，'exUnknown' 永不發）。
 * 停損換版：versionReason 在 EPISODE_CONTINUE_REASONS（exAdjust、lineRaise、eventTighten、eventExpire、bandDown）⇒ 事件延續；
 *   其他（ratchet＝持股變動、costCorrection、init、userSet）⇒ 舊事件結束，之後再觸及是新事件。
 * ev.seeded：第一次判定時部位已在停損下（切換當天、前一交易日收盤已低於停損）⇒ 開 seeded 事件、不發一級（SKILL §8.3）。
 * ev.stopSource：新事件記下當時的綁定來源（推播與畫面寫明是哪一條線）。
 */
export function advanceEpisode(prev, ev) {
  const { touch, stopVersion, versionReason, todayYmd, nowMs, nextId } = ev;
  let cur = prev ?? null;
  if (cur && cur.stopVersion !== stopVersion) cur = EPISODE_CONTINUE_REASONS.includes(versionReason) ? { ...cur, stopVersion } : null;
  const touched = touch?.status === 'touched';
  if (!cur) {
    if (!touched && !ev.seeded) return { episode: null, isNew: false, sendLevel1: false };
    const hold = touched ? touch.hold ?? null : null;
    const seeded = !!ev.seeded;
    const episode = {
      id: nextId, stopVersion, kind: touched ? touch.kind ?? 'touch' : 'touch', triggerAt: nowMs,
      triggerPx: touched ? touch.triggerPx ?? null : null, skipPct: touched ? touch.skipPct ?? null : null,
      firstDate: todayYmd, lastDate: todayYmd, closesBelow: 0, seeded, hold, level1Sent: touched && !seeded && hold == null,
      // 有傳才記（戰情本機事件表不帶來源，形狀維持 v1，避免每輪都判成「有變動」）
      ...(typeof ev.stopSource === 'string' && ev.stopSource ? { stopSource: ev.stopSource } : {}),
    };
    return { episode, isNew: true, sendLevel1: episode.level1Sent };
  }
  if (!touched) return { episode: cur, isNew: false, sendLevel1: false };
  const release = !cur.level1Sent && !cur.seeded && cur.hold === 'exUnconfirmed' && (touch.hold ?? null) == null;
  const episode = { ...cur, lastDate: todayYmd > cur.lastDate ? todayYmd : cur.lastDate, ...(release ? { hold: null, level1Sent: true } : {}) };
  return { episode, isNew: false, sendLevel1: release };
}

/** 某交易日官方收盤 > 停損×1.02 ⇒ 事件結束；≤ 停損 ⇒ closesBelow+1。早於事件起始日的收盤不計。每個交易日只呼叫一次 */
export function settleEpisode(ep, ev) {
  if (!ep) return { episode: null, ended: false };
  const { officialClose, stop, dateYmd } = ev;
  if (!isPos(officialClose) || !isPos(stop) || (dateYmd && dateYmd < ep.firstDate)) return { episode: ep, ended: false };
  if (officialClose > stop * STOP_PARAMS.clearMult) return { episode: null, ended: true };
  return { episode: officialClose <= stop ? { ...ep, closesBelow: ep.closesBelow + 1 } : ep, ended: false };
}

/**
 * 停損紀律的天數（SKILL §8.4）：事件起始交易日算第 1 天，數到今天的交易日數 N；N ≥ 2（DISCIPLINE_FROM_DAY）
 * 而且前一交易日官方收盤 ≤ 停損 ⇒ 回 N；否則 null。seeded 事件照算（切換當天已在停損下的部位）。
 */
export function disciplineDay(ep, todayYmd, prevClose, stop, isTradingDay) {
  if (!ep || typeof ep.firstDate !== 'string' || !isPos(prevClose) || !isPos(stop)) return null;
  const n = countTradingDays(ep.firstDate, todayYmd, isTradingDay);
  if (n < STOP_PARAMS.disciplineFromDay || prevClose > stop) return null;
  return n;
}

/** 版本換了之後，停損簿裡的事件要不要延續（plan* 在換版當下就處理，避免兩次換版之間只看得到最後一個原因） */
export function carryEpisode(ep, res) {
  if (!ep || !res || res.stopVersion === ep.stopVersion) return ep ?? null;
  return EPISODE_CONTINUE_REASONS.includes(res.versionReason) ? { ...ep, stopVersion: res.stopVersion } : null;
}
