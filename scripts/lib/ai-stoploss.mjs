// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1 共用純函式（唯一實作；技能 .claude/skills/tw-ai-stoploss/SKILL.md §3.8，
// 簽章照實作計畫 warroom/stoploss/impl-plan.md §1.2）。前端經 ai-stoploss.d.mts 匯入；單元測試 ai-stoploss.test.mjs。
//
// 本檔目前實作的是「戰情 v2 需要的子集」（使用者 2026-10-05 指示：戰情 v2 改用本規範；v2 僅超管可用）：
//   檔位與漲跌停、部位彙總、事件係數表與逐筆還原成本、持股變動分類、resolveStop（成本線＋棘輪＋自檢）、
//   legacyPushStop（第一階段推播口徑，留作對照）、時段與觸及判定 evaluateTouch、stopDistance、
//   觸及事件 advanceEpisode／settleEpisode、事實句 stopFactText。
//   尚未實作（daemon 端與 LLM，等使用者裁定 SKILL §13 後的 S3／S5）：evaluateLateTouch、disciplineDay、countTradingDays、
//   trailLine、AI 選擇題、LLM 停損文字、planBookRefresh／planUserStopTick／planCloseSettle、mergeAlertsKeepUnacked、legacyBranchActive。
//
// 規則：純函式——不 import firebase、不碰網路與檔案、不讀時鐘（時間一律由參數傳入），回傳新物件、不改輸入。
// SKILL §13 的 16 項待裁定一律採規範預設：上限 8%、成本線向上取檔、逼近 ≤1×ATR14（沒有 ATR 時 ≤2%）、
//   只認今日成交更新的 low、試撮與收盤競價窗不判定、跳空照實記開盤價、每個觸及事件一次、收盤站回 ×1.02 才結束、
//   成本可疑 0.25／5 抑制一級、處置／注意不調整停損。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { warSegmentAt, taipeiYmd, taipeiMinuteOfDay } from './warroom-session.mjs';

export const STOP_SPEC_VERSION = 'stop-v1';

/** SKILL §3.7 參數表（改任何一個都要重跑回測並經使用者核可） */
export const STOP_PARAMS = Object.freeze({
  capPct: 8, clearMult: 1.02, nearAtr: 1, nearPctFallback: 2, aiMinAtr: 2, aiMinPct: 5,
  trailFromPct: 10, trailGivebackPct: 8, suspectLo: 0.25, suspectHi: 5, staleSec: 300,
  disciplineFromDay: 2, shadowMinDays: 20,
});

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const M = (h, m) => h * 60 + m;
/** daemon inCloseAuction（13:24–13:35）：這段的快照價可能是試撮指示價，不當真成交 */
const CLOSE_AUCTION_FROM = M(13, 24);
const CLOSE_AUCTION_TO = M(13, 35);
const JUDGING_SEGMENTS = Object.freeze(['open', 'mid', 'tail', 'closing']);

// ── 檔位與漲跌停（統一 daemon _isEtfCode／_tickOf／_onTick） ─────────────────

/** v1 釘住 daemon 現行 /^00\d{2,4}$/；英文字尾（00632R、00958B、00400A）判為非 ETF——待核實（SKILL §15-1） */
export function isEtfCode(code) {
  return /^00\d{2,4}$/.test(String(code ?? ''));
}

/** 該價位的檔位（個股：<10 0.01、<50 0.05、<100 0.1、<500 0.5、<1000 1、≥1000 5；ETF：<50 0.01、≥50 0.05） */
export function tickOf(price, isEtf = false) {
  const p = Number(price);
  if (isEtf) return p < 50 ? 0.01 : 0.05;
  return p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
}

const decOfTick = t => (t >= 1 ? 0 : t >= 0.1 ? 1 : 2);

/** 取到合法檔位：dir −1 向下、+1 向上（ceilTick）、0 四捨五入。容忍浮點誤差（52.35 不會被當成 52.3500001 再進一檔） */
export function roundTick(price, dir, isEtf = false) {
  if (!isPos(price)) return NaN;
  const t = tickOf(price, isEtf);
  const n = price / t;
  const k = dir > 0 ? Math.ceil(n - 1e-7) : dir < 0 ? Math.floor(n + 1e-7) : Math.round(n);
  return +(k * t).toFixed(decOfTick(t));
}

/** 是否在合法檔位上（容忍浮點誤差、不容忍半檔；同 daemon _onTick） */
export function onTick(price, isEtf = false) {
  if (!isPos(price)) return false;
  const t = tickOf(price, isEtf);
  return Math.abs(price / t - Math.round(price / t)) < 0.02;
}

/** 漲跌停價（參考價×1.1 向下取檔／×0.9 向上取檔）。參考價未知、≤0，或無漲跌幅限制的標的 ⇒ null（不寫跌停事實句） */
export function limitPrices(refPrice, isEtf = false, noLimit = false) {
  if (noLimit || !isPos(refPrice)) return null;
  return { up: roundTick(refPrice * 1.1, -1, isEtf), down: roundTick(refPrice * 0.9, 1, isEtf) };
}

// ── 部位彙總 ────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD'／'YYYY/MM/DD'／ISO → 'YYYY-MM-DD'；認不得回 '' */
export function normYmd(s) {
  const m = String(s ?? '').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

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

/** 該代號在涵蓋區間內的事件表（依日期排序、同日只取第一筆——mergeFactorItems 已讓官方除權息優先） */
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

/**
 * 逐筆還原成本：每筆 buyPrice × Π f（事件日 > 該筆買進日；使用者已自行調整的事件略過），再依張數加權。
 * exUnknown：某筆買進日早於係數表涵蓋起點（或沒有買進日）。係數表 coverFrom 為 null ＝沒有係數表（前端退回）⇒ 不判 exUnknown，
 *   由呼叫端標「未含除權息調整」（SKILL §3.6 前端列）。
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

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** 同一 id 的買價／張數改動是否等於某個事件的自行調整（買價比 ≈ f ±1 檔、張數比 ≈ 1/f），回該事件日或 null */
function selfAdjustEvent(prevLot, curLot, ex, isEtf) {
  if (prevLot.buyDate !== curLot.buyDate || !prevLot.buyDate) return null;
  for (const [d, f] of evList(ex)) {
    if (d <= prevLot.buyDate) continue;
    const priceOk = Math.abs(curLot.buyPrice - prevLot.buyPrice * f) <= tickOf(curLot.buyPrice, isEtf) + 1e-9;
    const qtyOk = Math.abs((curLot.qty * f) / prevLot.qty - 1) <= 0.02;
    if (priceOk && qtyOk) return d;
  }
  return null;
}

/** SKILL §3.2 步驟 4：以每筆 id 比對上一版快照 */
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
      if (l.qty > p.qty + 1e-9) changes.add('buy');
      else if (l.qty < p.qty - 1e-9) changes.add('sell');
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

// ── v1 決定停損（SKILL §3.2–§3.4） ─────────────────────────────────────────

const validStop = (v, isEtf) => isPos(v) && onTick(v, isEtf);

function mergeSelfAdjusted(a, b) {
  const out = {};
  for (const src of [a, b]) {
    for (const [id, ds] of Object.entries(src ?? {})) out[id] = [...new Set([...(out[id] ?? []), ...(ds ?? [])])].sort();
  }
  return out;
}

/** 依據文字：有係數表（coverFrom 有值）＝「還原成本」；沒有係數表（前端退回）＝「買進均價…未含除權息調整」 */
function costText(adjCost, hasExTable, capPct, isEtf) {
  return hasExTable
    ? `成本線·還原成本 ${pxText(adjCost, isEtf, true)} −${capPct}%`
    : `成本線·買進均價 ${pxText(adjCost, isEtf, true)} −${capPct}%·未含除權息調整`;
}

export function resolveStop(input) {
  const { position, ex, prev = null, lastPrice = null, nowMs, tradeDate } = input;
  const capPct = isPos(input.capPct) ? input.capPct : STOP_PARAMS.capPct;
  const isEtf = input.isEtf ?? isEtfCode(position?.code);
  const rejected = [];
  const base = {
    specVersion: STOP_SPEC_VERSION, line: 'stop', basis: 'cost', lotChanges: [], exApplied: [], selfAdjusted: {},
    exUnknown: false, suspect: false, rejected,
  };
  if (!position || !isPos(position.avgCost) || !position.lots?.length) {
    return {
      ...base, stop: null, basisText: '成本資料缺', adjCost: null, costLine: null,
      stopVersion: prev?.stopVersion ?? 0, versionReason: null,
      startedAt: prev?.startedAt ?? nowMs, tradeDate: prev?.tradeDate ?? tradeDate,
    };
  }
  const prevOk = !!prev && validStop(prev.stop, isEtf) && Number.isInteger(prev.stopVersion) && prev.stopVersion >= 1
    && Array.isArray(prev.lots);
  if (prev && !prevOk) rejected.push({ code: 'prevInvalid', detail: `上一版停損不合法：${String(prev.stop)}` });
  const p = prevOk ? prev : null;

  const cls = classifyLotChange(p ? p.lots : null, position.lots, ex, isEtf);
  const selfAdjusted = mergeSelfAdjusted(p?.selfAdjusted, cls.selfAdjusted);
  const { adjCost, exUnknown, applied } = adjustedCost(position, ex, selfAdjusted);
  const costLine = roundTick(adjCost * (1 - capPct / 100), 1, isEtf);
  // 已計入的事件＝套進還原成本的，加上使用者已自行調整的（同一輪才被認出的自行調整，停損仍要依係數帶下來）
  const accounted = [...new Set([...applied, ...Object.values(selfAdjusted).flat()])].sort();
  const prevApplied = new Set(p?.exApplied ?? []);
  const fNew = evList(ex).filter(([d]) => accounted.includes(d) && !prevApplied.has(d)).reduce((acc, [, f]) => acc * f, 1);
  const hasNewEx = !near(fNew, 1);

  let stop, reason;
  if (!p) { stop = costLine; reason = 'init'; }
  else if (cls.changes.includes('edit')) { stop = costLine; reason = 'costCorrection'; }
  else {
    const carried = hasNewEx ? roundTick(p.stop * fNew, 1, isEtf) : p.stop;
    stop = Math.max(costLine, carried);
    reason = hasNewEx ? 'exAdjust' : 'ratchet';
  }

  // 自檢（SKILL §3.4）：不通過就保留上一版
  const floor = p ? roundTick(p.stop * fNew, 1, isEtf) : null;
  if (!validStop(stop, isEtf)) rejected.push({ code: 'invalid', detail: `停損不合法：${String(stop)}` });
  else if (stop < costLine - 1e-9) rejected.push({ code: 'tooWide', detail: `${stop} 寬於成本線 ${costLine}` });
  else if (p && !['exAdjust', 'costCorrection', 'init', 'userSet'].includes(reason) && stop < floor - 1e-9) {
    rejected.push({ code: 'loosen', detail: `${stop} 低於上一版 ${floor}` });
  }
  const failed = rejected.some(r => r.code !== 'prevInvalid');
  if (failed) {
    if (p) stop = p.stop;
    else stop = validStop(costLine, isEtf) ? costLine : null;
  }

  const ratio = isPos(lastPrice) && isPos(adjCost) ? lastPrice / adjCost : null;
  const suspect = ratio != null && (ratio < STOP_PARAMS.suspectLo || ratio > STOP_PARAMS.suspectHi);
  const changed = !p || (stop != null && !near(stop, p.stop));
  const prevVer = Number.isInteger(prev?.stopVersion) && prev.stopVersion >= 0 ? prev.stopVersion : 0;
  return {
    ...base,
    stop,
    basisText: costText(adjCost, ex?.coverFrom != null, capPct, isEtf),
    adjCost, costLine,
    stopVersion: changed ? prevVer + 1 : p.stopVersion,
    versionReason: changed ? reason : null,
    startedAt: changed ? nowMs : p.startedAt,
    tradeDate: changed ? tradeDate : p.tradeDate,
    // 自檢不通過、保留上一版時，事件也不算已套用（下一輪重算）
    lotChanges: cls.changes, exApplied: failed && p ? [...p.exApplied] : accounted, selfAdjusted, exUnknown, suspect,
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
  if (!isPos(low) || !onTick(low, isEtf) || (limits && low < limits.down - 1e-9)) return notJudged('badLow');
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

// ── 觸及事件（SKILL §8.2） ─────────────────────────────────────────────────

/**
 * 推進觸及事件。事件由第一次觸及開始；同一事件只發一次一級（hold 'exUnconfirmed' 解除時補發一次，'exUnknown' 永不發）。
 * 停損換版（ratchet／userSet／costCorrection／init）⇒ 舊事件結束，之後再觸及是新事件；exAdjust ⇒ 延續原事件。
 * ev.seeded（擴充）：第一次判定時部位已在停損下（例如前一交易日收盤已低於停損）⇒ 開 seeded 事件、不發一級（SKILL §8.3 切換當日）。
 */
export function advanceEpisode(prev, ev) {
  const { touch, stopVersion, versionReason, todayYmd, nowMs, nextId } = ev;
  let cur = prev ?? null;
  if (cur && cur.stopVersion !== stopVersion) cur = versionReason === 'exAdjust' ? { ...cur, stopVersion } : null;
  const touched = touch?.status === 'touched';
  if (!cur) {
    if (!touched && !ev.seeded) return { episode: null, isNew: false, sendLevel1: false };
    const hold = touched ? touch.hold ?? null : null;
    const seeded = !!ev.seeded;
    const episode = {
      id: nextId, stopVersion, kind: touched ? touch.kind ?? 'touch' : 'touch', triggerAt: nowMs,
      triggerPx: touched ? touch.triggerPx ?? null : null, skipPct: touched ? touch.skipPct ?? null : null,
      firstDate: todayYmd, lastDate: todayYmd, closesBelow: 0, seeded, hold, level1Sent: touched && !seeded && hold == null,
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

// ── 事實句（SKILL §9、references/wording.md；只描述事實，不下指令） ─────────────

function pxText(p, isEtf = false, cost = false) {
  if (!isNum(p)) return '—';
  const d = isEtf || cost ? 2 : decOfTick(tickOf(p, isEtf));
  const [i, f] = p.toFixed(d).split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}

/** 停損相關價格的顯示：依檔位定小數位（ETF 一律 2 位），千分位逗號——與站上 fmtPrice 同 */
export function stopPxText(p, isEtf = false) {
  return pxText(p, isEtf);
}

const pctText = (n, digits = 1) => (isNum(n) ? `${n.toFixed(digits)}%` : '—');
const pad2 = n => String(n).padStart(2, '0');
function hhmmText(ms) {
  if (!isNum(ms)) return '—';
  const m = Math.floor(taipeiMinuteOfDay(ms));
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}
const mmddText = ymd => (typeof ymd === 'string' && ymd.length >= 10 ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}` : '—');

const FACT = Object.freeze({
  row: d => {
    const atr = isNum(d.atrMultiple) ? `（${d.atrMultiple.toFixed(1)} ATR）` : '';
    const dist = isNum(d.distPct) ? `｜距 ${pctText(d.distPct)}${atr}` : '';
    return `停損 ${pxText(d.stop, d.isEtf)}（${d.basisText ?? '成本線'}）${dist}`;
  },
  touch: d => `今日最低 ${pxText(d.low, d.isEtf)} 觸及停損 ${pxText(d.stop, d.isEtf)}${isNum(d.at) ? `（${hhmmText(d.at)} 揭示）` : ''}${isPos(d.price) ? `·現價 ${pxText(d.price, d.isEtf)}` : ''}`,
  gap: d => `開盤 ${pxText(d.open, d.isEtf)}，已低於停損 ${pxText(d.stop, d.isEtf)}（差 ${pctText(d.skipPct)}）`,
  closeTouch: d => `收盤時判定：今日最低 ${pxText(d.low, d.isEtf)} 低於停損 ${pxText(d.stop, d.isEtf)}`,
  lateTouch: d => `收盤後補判：今日最低 ${pxText(d.low, d.isEtf)} 低於停損 ${pxText(d.stop, d.isEtf)}（盤中未即時判到）`,
  digest: d => (Array.isArray(d.items) ? d.items : [])
    .map(x => `${x.code} 事件第 ${x.n} 個交易日（前一交易日收盤 ${pxText(x.close, x.isEtf)}／停損 ${pxText(x.stop, x.isEtf)}）`).join('、'),
  exAdjust: d => `停損已依 ${mmddText(d.date)} ${d.label ?? '除權息'}調整（係數 ${isNum(d.factor) ? d.factor.toFixed(3) : '—'}）：${pxText(d.from, d.isEtf)} → ${pxText(d.to, d.isEtf)}`,
  exPending: () => '除權息日·停損待調整（係數未公布，今日不判定）',
  exUnconfirmed: d => `今日最低 ${pxText(d.low, d.isEtf)} 已低於停損 ${pxText(d.stop, d.isEtf)}·除權息狀態未確認（官方今日結果未公布），確認後再發一級`,
  exUnknown: d => `除權息資料不足（買進日早於 ${d.coverFrom ?? '係數表起點'}）·停損警示最高二級`,
  suspect: d => `成本資料可疑（現價為成本的 ${isNum(d.ratio) ? (d.ratio < 1 ? d.ratio.toFixed(2) : d.ratio.toFixed(1)) : '—'} 倍）·本檔停損警示暫停`,
  trailBreak: d => `跌破獲利回落線 ${pxText(d.line, d.isEtf)}（持有期最高 ${pxText(d.hwm, d.isEtf)} −8%）·仍獲利 +${pctText(d.gainPct)}`,
  auction: () => '收盤競價中·不判定',
  preOpen: () => '開盤前·不判定',
  stale: d => `報價延遲 ${d.minutes ?? '—'} 分（最後揭示 ${hhmmText(d.at)}）`,
  limitDown: d => (d.locked ? '今日未曾高於跌停價' : `今日在跌停價 ${pxText(d.price, d.isEtf)} 有成交`),
  disposition: d => (d.measures
    ? `處置中（撮合方式：${d.measures}）：觸價以成交價判定，實際成交可能低於停損價`
    : '處置中：觸價以成交價判定，實際成交可能低於停損價'),
  seededDigest: d => `已在停損下（前一交易日收盤低於停損）：${(d.codes ?? []).join('、')}·本次不逐檔發一級`,
  provisional: d => `停損 ${pxText(d.stop, d.isEtf)}（暫算·${d.hasBook ? '待 daemon 確認' : '未含除權息調整'}）`,
  tradeBasis: () => '依成交價判定（今日新設停損）',
});

/** 事實句範本（kind 見 FACT；未知 kind 回空字串） */
export function stopFactText(kind, data) {
  const f = FACT[kind];
  return f ? f(data ?? {}) : '';
}

/** 測試與文件用：所有範本 kind */
export const STOP_FACT_KINDS = Object.freeze(Object.keys(FACT));
