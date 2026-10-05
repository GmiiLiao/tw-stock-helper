// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2·A1「我的部位」與持股停損的純函式（唯一實作；前端經 warroom-mine.d.mts 匯入，單元測試 warroom-mine.test.mjs）。
//
// 停損口徑（使用者 2026-10-05 指示「請 3 位股市分析師制訂 AI 停損規範 skills，再使用這個規範」；兩輪裁定定稿 stop-v1.1；
//   戰情 v2 僅超管可用）。一檔持股的停損一律由 warStopResOf 決定，A1、快看抽屜、Z2、逼近清單都帶同一份 ctx 與本機表，數字必然一致：
//   ① 停損簿 stopBooks/{uid} 生效（phase 'live' 且 specVersion 'stop-v1.1'）⇒ 讀停損簿（warroom-stopbook.bookStopOf：
//      快照一致＝停損簿這一版、不符或過期＝帶停損簿原料暫算「待 daemon 確認」、noOfficialBars＝沿用現行推播口徑）。
//   ② 其餘（停損簿不存在、影子期、讀不到）＝v1.1 前端暫算（規範 §3.6 最後一列；provisionalStop）：
//      max(成本線〔買進均價，未還原〕, ATR 帶〔持股分析 analyses[code].stopLoss，向下取檔、資料日＝前一交易日〕)；
//      frontLinesOf＋resolveStop（bandRatchet:false、空係數表、不傳 latestCanonicalYmd）。ATR 帶不棘輪；成本線沿用本機事件表
//      記住的上一版只升不降（攤平、FIFO 賣出不下移；第 6 項），同一筆被編輯（成本更正）才歸零；今天買進的部位不套 ATR 帶（A1）。
//      沒有持股分析帶值 ⇒ 只有成本線，標「暫算·未含 ATR 帶」；沒有 ATR14 ⇒ 逼近改用距停損 ≤2%；不自編數字。
// Z2 一級「觸停損」（第二輪 A7「ok」：網頁判定、標「單一裝置·暫算」，維持到停損簿切換正式）：只限使用者自己的持股、只認今日成交
//   更新的 low、每個觸及事件只發一次（本機 localStorage 記事件；前一交易日收盤 > 停損×1.02 才結束事件）。不同裝置可能不同。
//   今日盤中才生效的停損（今天買進，或本裝置 09:00 後偵測到持股變動／成本更正而換版）前端沒有真成交旗標 ⇒ 當日不判定（§4.1）；
//   ATR 帶換值（lineRaise／bandDown）是前一交易日收盤算的、開盤起就適用 ⇒ 照常以今日最低價判定。
//   停損簿生效後停用前端判定，改讀 daemon 的 type 'stop'（warroom-top.eventFromDaemonAlert stopLive）。
// 金額一律 ×1000（holdings.quantity 單位是張）。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import {
  EMPTY_EX_TABLE, isEtfCode, resolveStop, evaluateTouch, stopDistance, advanceEpisode, settleEpisode, stopFactText, stopPxText,
  normYmd, isSetToday, frontLinesOf, stopSourceLabel, mmddText,
} from './ai-stoploss.mjs';
import { taipeiYmd } from './warroom-session.mjs';
import { stopBookLive, bookStopOf, bookCalcWhyText } from './warroom-stopbook.mjs';

/** 1 張＝1000 股（HoldingItem.quantity 單位是張，可含小數＝零股） */
export const SHARES_PER_LOT = 1000;

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// ── 部位損益（自 warroom-stop.mjs 移來，口徑不變） ───────────────────────────

/** 未實現損益（毛額，不含費稅）：(現價−均價)÷均價、金額＝差價×張×1000（與投資組合頁「逐股水位」同口徑） */
export function grossPnl(avgCost, lots, price) {
  if (!isPos(avgCost) || !isPos(lots) || !isPos(price)) return null;
  return { amount: (price - avgCost) * lots * SHARES_PER_LOT, pct: ((price - avgCost) / avgCost) * 100 };
}

/** 昨收（盤前價格欄用）：今日有真成交（mis_realtime）時 prevClose 才是昨收；沒有今日成交時報價本身就是最後一個交易日的收盤 */
export function lastCloseOf(q) {
  if (!q) return null;
  if (q.source === 'mis_realtime') return isPos(q.prevClose) ? q.prevClose : null;
  return isPos(q.price) ? q.price : null;
}

/**
 * 單一代號的今日損益（毛額）：每筆的基準＝今日買進的用買價，其餘用昨收。
 * @param lots aggregatePositions 的 lots（qty＝張）
 * @returns {{ amount: number, base: number } | null} base＝Σ 基準價×股數（算 % 的分母）
 */
export function dayPnlOf(lots, quote, todayYmd) {
  if (!quote || !isPos(quote.price) || !isPos(quote.prevClose)) return null;
  let amount = 0, base = 0;
  for (const l of Array.isArray(lots) ? lots : []) {
    if (!isPos(l?.qty)) continue;
    const ref = l.buyDate && l.buyDate === todayYmd && isPos(l.buyPrice) ? l.buyPrice : quote.prevClose;
    const shares = l.qty * SHARES_PER_LOT;
    amount += (quote.price - ref) * shares;
    base += ref * shares;
  }
  return base > 0 ? { amount, base } : null;
}

/** 多檔今日損益加總：{ amount, pct, counted }；沒有任何可算的檔回 null */
export function sumDayPnl(parts) {
  let amount = 0, base = 0, counted = 0;
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || !(p.base > 0) || !Number.isFinite(p.amount)) continue;
    amount += p.amount; base += p.base; counted += 1;
  }
  return counted ? { amount, pct: (amount / base) * 100, counted } : null;
}

/**
 * 收盤集合競價（13:25–13:30）前最後一筆真成交：競價窗的價格是試撮指示價（可能永不成交），距停損／損益改用這筆。
 * 沒有變化時回傳原物件（React 可據此略過重繪）。
 */
export function mergeTradedBefore(prev, quotes, cutoffMs) {
  const base = prev && typeof prev === 'object' ? prev : {};
  let next = null;
  for (const [code, q] of Object.entries(quotes ?? {})) {
    if (!q || q.source !== 'mis_realtime' || !isPos(q.price)) continue;
    const at = q.revealAt;
    if (!isNum(at) || at >= cutoffMs) continue;
    const old = base[code];
    if (old && old.revealAt >= at) continue;
    if (!next) next = { ...base };
    next[code] = { price: q.price, revealAt: at };
  }
  return next ?? base;
}

/** 台北某日（'YYYY-MM-DD'）hh:mm 的 epoch ms */
export function taipeiAt(ymd, hh, mm) {
  const d = normYmd(ymd);
  if (!d) return NaN;
  return Date.parse(`${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);
}

// ── 停損（規範 v1·前端暫算） ───────────────────────────────────────────────

/** 戰情報價（WarQuote）→ 觸及判定用報價：只有今日即時（mis_realtime）才帶 liveAt；前端報價沒有真成交旗標 realTrade */
export function judgeQuoteOf(q) {
  if (!q) return null;
  const live = q.source === 'mis_realtime';
  const liveAt = live ? (isPos(q.fetchedAt) ? q.fetchedAt : isPos(q.revealAt) ? q.revealAt : null) : null;
  return {
    price: q.price, open: q.open, high: q.high, low: q.low, volume: q.volume,
    live, liveAt, revealAt: live && isPos(q.revealAt) ? q.revealAt : null,
  };
}

/**
 * 本機事件表的一檔 → resolveStop 的 prev（停損簿生效前的退回：以本機記住的這一版做棘輪與持股變動分類，SKILL §3.2、§3.6）。
 * floor＝這一版的成本線棘輪（floorStop）：ATR 帶不棘輪（bandRatchet:false），所以上一版的生效停損若是 ATR 帶，不能拿來當
 *   成本線的上一版，否則帶值會經由棘輪被鎖住。v1 舊表沒有 floor（v1 只有成本線）⇒ floorStop 視同 stop。bandHold 不存本機。
 * 沒有逐筆快照（舊表）時以空陣列當快照 ⇒ 每筆都視同加碼，棘輪照舊、不會誤判成本更正。
 */
export function stopPrevOf(entry) {
  if (!isObj(entry) || !isPos(entry.stop) || !Number.isInteger(entry.ver) || entry.ver < 1) return null;
  return {
    stop: entry.stop, floorStop: isPos(entry.floor) ? entry.floor : null, stopVersion: entry.ver,
    lots: Array.isArray(entry.lots) ? entry.lots : [], exApplied: [], selfAdjusted: {},
    startedAt: isNum(entry.startedAt) ? entry.startedAt : 0, tradeDate: typeof entry.tradeDate === 'string' ? entry.tradeDate : '',
  };
}

/**
 * 停損簿生效前的 v1.1 前端暫算（SKILL §3.6 最後一列；呼叫規則照抄規範，兩個工程師要算出同一個值）：
 *   resolveStop({ position, ex: EMPTY_EX_TABLE, prev: 本機表這一檔, lines: frontLinesOf({ ratingBand, prevTradingYmd, isEtf }),
 *                 bandRatchet: false, 不傳 latestCanonicalYmd, … })。
 * opts.ratingBand：持股分析 analyses[code].stopLoss（沒有＝只有成本線）；opts.prevYmd：今日之前最後一個交易日（帶值的資料日）。
 */
export function provisionalStop(position, lastPrice, nowMs = 0, todayYmd = '', entry = null, opts = {}) {
  const isEtf = isEtfCode(position?.code);
  const lines = frontLinesOf({ ratingBand: opts?.ratingBand ?? null, prevTradingYmd: opts?.prevYmd ?? null, isEtf });
  return resolveStop({
    position, ex: EMPTY_EX_TABLE, prev: stopPrevOf(entry), lines, bandRatchet: false, isEtf,
    lastPrice: isPos(lastPrice) ? lastPrice : null, nowMs, tradeDate: todayYmd,
  });
}

/** ctx 裡這一檔的持股分析 ATR 帶（沒有回 null） */
export function ratingBandOf(ctx, code) {
  const v = isObj(ctx?.bands) && Object.prototype.hasOwnProperty.call(ctx.bands, code) ? ctx.bands[code] : null;
  return isPos(v) ? v : null;
}

/**
 * 一檔持股的停損（A1、快看抽屜、Z2、逼近清單共用——同一份輸入必得同一個數字）。
 * ctx.book 生效 ⇒ 讀停損簿（bookStopOf）；否則 v1.1 前端暫算（provisionalStop，帶 ctx 的 ATR 帶與前一交易日）。
 * @returns {{ mode: 'front'|'book'|'bookCalc'|'legacy', res, bp, why }}
 */
export function warStopResOf(position, lastPrice, { nowMs = 0, todayYmd = '', entry = null, ctx = null } = {}) {
  const ratingBand = ratingBandOf(ctx, position?.code);
  const prevYmd = typeof ctx?.prevYmd === 'string' ? ctx.prevYmd : null;
  if (stopBookLive(ctx?.book)) return bookStopOf(position, { book: ctx.book, todayYmd, prevYmd, lastPrice, nowMs, ratingBand });
  const res = provisionalStop(position, lastPrice, nowMs, todayYmd, entry, { ratingBand, prevYmd });
  return { mode: 'front', res, bp: null, why: null };
}

const EX_NOTE = '未含除權息調整';
/** v1.1 前端暫算的口徑字樣（wording.md「前端暫算」列；與 stopFactText('provisional', { withBand: true }) 同字） */
export const FRONT_BAND_NOTE = '暫算·成本線與 ATR 帶取高·未含除權息調整；ATR 帶未棘輪';
const BAND_STATUS_TEXT = Object.freeze({
  loading: '持股分析讀取中', slow: '持股分析讀取逾時', error: '持股分析讀不到', none: '尚無持股分析', ok: '持股分析沒有這檔的 ATR 帶',
});

/**
 * 前端暫算沒有套到 ATR 帶的說明（有套到回 null）：
 *   沒有帶值 ⇒「未含 ATR 帶（持股分析讀取中／讀不到／沒有這檔…）」；有帶值但沒套 ⇒「未套 ATR 帶（今日買進…／買進日缺…）」。
 */
function frontBandGap(res, position, ctx, todayYmd) {
  if (res.lines?.bandLine != null) return null;
  if (ratingBandOf(ctx, position?.code) == null) return `未含 ATR 帶（${BAND_STATUS_TEXT[ctx?.bandStatus] ?? BAND_STATUS_TEXT.none}）`;
  if (res.bandRejected) return `未套 ATR 帶（帶值檢查未過：${res.bandRejected}）`;
  if (!position?.firstDate) return '未套 ATR 帶（買進日缺）';
  if (typeof ctx?.prevYmd !== 'string' || !ctx.prevYmd) return '未套 ATR 帶（前一交易日未知）';
  if (position.firstDate === todayYmd) return '未套 ATR 帶（今日買進，隔一個交易日起套用）';
  return '未套 ATR 帶（買進日晚於帶值資料日，隔一個交易日起套用）';
}

/**
 * 停損的口徑註記（畫面寫明是哪一種算法）：
 *   front    「暫算·成本線與 ATR 帶取高·未含除權息調整；ATR 帶未棘輪」或「暫算·未含 ATR 帶（原因）·未含除權息調整」
 *   book     「停損簿 stop-v1.1·與推播同一口徑·資料日 MM/DD」
 *   bookCalc 「暫算·待 daemon 確認（原因）」
 *   legacy   「ETF／興櫃官方日 K 歸檔驗證前·沿用現行推播口徑（ATR 帶，否則成本 −8%）」
 */
export function stopModeNote(sr, position, ctx, todayYmd = '') {
  if (!sr) return '';
  if (sr.mode === 'book') return `停損簿 stop-v1.1·與推播同一口徑·資料日 ${mmddText(ctx?.book?.dataDate)}`;
  if (sr.mode === 'bookCalc') {
    const why = bookCalcWhyText(sr.why, ctx?.book);
    return `暫算·待 daemon 確認${why ? `（${why}）` : ''}`;
  }
  if (sr.mode === 'legacy') return 'ETF／興櫃官方日 K 歸檔驗證前·沿用現行推播口徑（ATR 帶，否則成本 −8%）';
  const gap = frontBandGap(sr.res, position, ctx, todayYmd);
  return gap ? `暫算·${gap}·未含除權息調整` : FRONT_BAND_NOTE;
}

/** 生效停損是否已還原除權息（停損簿的係數表有涵蓋起點才算；前端暫算與沿用現行口徑一律否） */
export function stopExAdjusted(sr) {
  return (sr?.mode === 'book' || sr?.mode === 'bookCalc') && isObj(sr.bp?.ex) && typeof sr.bp.ex.coverFrom === 'string';
}

/** Z2 觸停損一級的判定口徑（A7）：停損簿生效前＝本裝置判定（單一裝置·暫算）；生效後＝讀 daemon */
export const STOP_JUDGE_NOTE_FRONT = '觸停損一級由本裝置判定（單一裝置·暫算）';
export const STOP_JUDGE_NOTE_LIVE = '觸停損一級讀 daemon 停損簿（與推播同一則）';

/** 英文字尾 ETF（00631L、00632R、00958B…）：規範 §15-1 待核實，isEtfCode（v1 釘住 daemon）判為非 ETF */
const SUFFIX_ETF_RE = /^00\d{2,4}[A-Z]$/;
export function isSuffixEtfCode(code) {
  return SUFFIX_ETF_RE.test(String(code ?? ''));
}

/** ATR 帶換值（帶值是前一交易日收盤算的、開盤起就適用）——不算「今日盤中才生效」（§3A.1、A1） */
const BAND_REASONS = new Set(['lineRaise', 'bandDown']);

/**
 * 今日盤中才生效的停損（SKILL §4.1 setToday）：今天有買進；或本機表記到這一版是今天 09:00 後換的（盤中加碼、FIFO 賣出、
 * 成本更正——前端沒有持股的修改時刻，以本裝置偵測到換版的時刻推定生效時刻）；或這一輪才算出換版而現在已過 09:00。
 * 開盤前換的版本（前一晚、週末改的持股）與 ATR 帶換值不算，當天一律用今日最低價判定。
 */
function setTodayOf(position, entry, res, nowMs, todayYmd) {
  if (position.lastBuyDate === todayYmd) return true;
  const openMs = taipeiAt(todayYmd, 9, 0);
  if (!Number.isFinite(openMs)) return false;
  if (stopPrevOf(entry) && res.versionReason != null) return !BAND_REASONS.has(res.versionReason) && isNum(nowMs) && nowMs > openMs;
  return isObj(entry) && isSetToday({ tradeDate: entry.tradeDate, startedAt: entry.startedAt }, todayYmd, openMs);
}

/** 停損簿模式的 setToday：今天有買進，或停損簿這一版是今天 09:00 後生效的（daemon 記的 startedAt／tradeDate） */
function bookSetTodayOf(position, sr, nowMs, todayYmd) {
  if (position.lastBuyDate === todayYmd) return true;
  const openMs = taipeiAt(todayYmd, 9, 0);
  if (!Number.isFinite(openMs) || sr.mode === 'legacy') return false;
  if (sr.mode === 'bookCalc' && sr.res.versionReason != null && !BAND_REASONS.has(sr.res.versionReason)) return isNum(nowMs) && nowMs > openMs;
  return isSetToday({ tradeDate: sr.res.tradeDate, startedAt: sr.res.startedAt }, todayYmd, openMs);
}

const pct1 = n => +n.toFixed(1);
const priceText = stopPxText;

function notJudgedText(touch, setToday) {
  switch (touch.notJudged) {
    case 'segment':
      if (touch.segment === 'pre' || touch.segment === 'preclear') return stopFactText('preOpen', {});
      if (touch.segment === 'auction') return stopFactText('auction', {});
      return '盤後不即時判定';
    case 'noTodayTrade':
      return setToday ? '今日新設停損：前端沒有真成交旗標，今日不判定觸及' : '今日尚無成交·不判定';
    case 'badLow': return '今日最低價缺值或不在檔位上·不判定';
    case 'exPending': return stopFactText('exPending', {});
    default: return '';
  }
}

/** 停損欄提示的類別註記（規範 §2：ETF 不在回測母體；英文字尾 ETF 檔位待核實 §15-1） */
function classNoteOf(isEtf, suffixEtf) {
  if (suffixEtf) return '·英文字尾 ETF：檔位待核實（今日最低價檢查暫用 ETF 檔位）·此類未經本站回測';
  if (isEtf) return '·ETF：此類未經本站回測';
  return '';
}

/** 觸及類句子（SKILL §9：寫出來源與持有損益；損益＝判定當下的價對成本，跳空用開盤價） */
function touchedText(touch, stop, quote, isEtf, source, adjCost) {
  const px = touch.kind === 'gap' ? touch.triggerPx : quote?.price;
  const pnlPct = isPos(px) && isPos(adjCost) ? ((px - adjCost) / adjCost) * 100 : null;
  if (touch.kind === 'gap') return stopFactText('gap', { open: touch.triggerPx, stop, skipPct: touch.skipPct, source, pnlPct, isEtf });
  if (touch.kind === 'close') return stopFactText('closeTouch', { low: touch.triggerPx, stop, source, pnlPct, isEtf });
  return stopFactText('touch', { low: touch.triggerPx, stop, price: quote?.price, source, at: quote?.revealAt ?? null, pnlPct, isEtf });
}

/** 距停損句的 ATR 倍數（有 ATR14 才寫） */
const atrTail = d => (d && isNum(d.atrMultiple) ? `（${d.atrMultiple.toFixed(1)} ATR）` : '');

/**
 * A1 一列的停損（規範 stop-v1.1；來源見 warStopResOf）。
 * calcPrice：損益／距停損用的價（盤前＝昨收、收盤競價窗＝13:25 前最後成交）；priceLabel：它的名稱（現價／收盤／昨收…）。
 * level：hit＝今日 low 觸及停損或價格在停損下；near＝逼近（≤1 ATR；沒有 ATR14 時 ≤2%）；成本可疑一律 ok（停損警示暫停）。
 * entry：本機事件表這一檔（前端暫算的棘輪上一版；沒有傳 null）；ctx：持股分析 ATR 帶、前一交易日、停損簿——A1、抽屜、Z2 都要帶同一份。
 */
export function warStopView({ position, quote, calcPrice, priceLabel = '現價', nowMs, todayYmd, tradingDay, disposition = false, entry = null, ctx = null }) {
  const isEtf = isEtfCode(position.code);
  const suffixEtf = isSuffixEtfCode(position.code);
  const sr = warStopResOf(position, calcPrice ?? quote?.price, { nowMs, todayYmd, entry, ctx });
  const { res, mode, bp } = sr;
  const stop = res.stop;
  const setToday = mode === 'front' ? setTodayOf(position, entry, res, nowMs, todayYmd) : bookSetTodayOf(position, sr, nowMs, todayYmd);
  const atr14 = isPos(res.atr14) ? res.atr14 : null;
  const bookEx = mode === 'book' || mode === 'bookCalc';
  const touch = evaluateTouch({
    // 英文字尾 ETF 的最低價檢查暫用 ETF 檔位：個股檔位表會把合法價（如 227.85）判成不在檔位上而永遠不判定（§15-1 待核實）
    stop: stop ?? 0, quote: judgeQuoteOf(quote), nowMs, todayYmd, tradingDay, isEtf: isEtf || suffixEtf, disposition,
    suspect: res.suspect, exUnknown: res.exUnknown, exPending: bookEx && bp?.exPending === true,
    exUnconfirmed: bookEx && bp?.exUnconfirmed === true, setToday, startedAt: null, refPrice: null, atr14,
  });
  const source = stop != null ? stopSourceLabel(res.stopSource) : '';
  const dist = stop != null ? stopDistance(stop, calcPrice, atr14) : null;
  const below = dist != null && calcPrice <= stop;
  let level = null, reason = null;
  if (stop != null && dist != null) {
    if (res.suspect) {
      level = 'ok';
      reason = stopFactText('suspect', { ratio: calcPrice / res.adjCost });
    } else if (touch.status === 'touched') {
      level = 'hit';
      reason = [touchedText(touch, stop, quote, isEtf, source, res.adjCost), ...touch.facts].join('·');
    } else if (below) {
      level = 'hit';
      const why = notJudgedText(touch, setToday);
      reason = `${priceLabel} ${priceText(calcPrice, isEtf)} 在停損 ${priceText(stop, isEtf)}（${source}）下${why ? `（${why}）` : ''}`;
    } else {
      level = dist.near ? 'near' : 'ok';
      if (dist.near) reason = `逼近停損（${source}）·距 ${pct1(dist.pct).toFixed(1)}%${atrTail(dist)}`;
    }
  }
  const modeNote = stopModeNote(sr, position, ctx, todayYmd);
  const row = stop != null
    ? stopFactText('row', { stop, basisText: res.basisText, bandToday: res.lines?.bandLine, isEtf })
    : res.basisText;
  // 依據已寫「未含除權息調整」（成本線未還原）時，提示裡的口徑註記不再重複這幾個字
  const titleNote = row.includes(EX_NOTE) ? modeNote.replace(`·${EX_NOTE}`, '') : modeNote;
  return {
    res, stop, isEtf, setToday, touch, level, reason, mode, why: sr.why, bp, source, modeNote,
    exAdjusted: stopExAdjusted(sr),
    atrMultiple: dist && isNum(dist.atrMultiple) ? +dist.atrMultiple.toFixed(1) : null,
    distPct: dist ? pct1(dist.pct) : null,
    title: stop != null ? `${row}·規範 stop-v1.1·${titleNote}${classNoteOf(isEtf, suffixEtf)}` : row,
  };
}

/** 今日判定狀態（快看抽屜「今日」列）：觸及／未觸及／不判定的原因 */
export function stopJudgeText(v) {
  if (!v || v.stop == null) return '';
  if (v.res.suspect) return '成本資料可疑·本檔停損警示暫停';
  if (v.touch.status === 'touched') {
    return v.touch.basis === 'trade' ? '今日已觸及停損（依今日新設停損之後的成交價）' : '今日已觸及停損（只認今日成交更新的最低價）';
  }
  if (v.touch.status === 'notJudged') return notJudgedText(v.touch, v.setToday) || '不判定';
  return '今日未觸及停損';
}

// ── Z2 一級「觸停損」：本機事件表（localStorage） ─────────────────────────────

const EP_KINDS = new Set(['touch', 'gap', 'close', 'late']);
/** 前端暫算的綁定來源只有成本線與 ATR 帶（保本、追蹤、事件收緊只在停損簿） */
const EP_SOURCES = new Set(['cost', 'atrBand']);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymdOr = (v, d) => (typeof v === 'string' && YMD_RE.test(v) ? v : d);

function parseEpisode(e) {
  if (!isObj(e) || !Number.isInteger(e.id) || !Number.isInteger(e.stopVersion) || !EP_KINDS.has(e.kind)) return null;
  if (!isPos(e.triggerAt) || !YMD_RE.test(String(e.firstDate)) || !YMD_RE.test(String(e.lastDate))) return null;
  return {
    id: e.id, stopVersion: e.stopVersion, kind: e.kind, triggerAt: e.triggerAt,
    triggerPx: isPos(e.triggerPx) ? e.triggerPx : null, skipPct: isNum(e.skipPct) ? e.skipPct : null,
    firstDate: e.firstDate, lastDate: e.lastDate, closesBelow: Number.isInteger(e.closesBelow) ? e.closesBelow : 0,
    seeded: e.seeded === true, hold: e.hold === 'exUnconfirmed' || e.hold === 'exUnknown' ? e.hold : null,
    level1Sent: e.level1Sent === true,
    // 事件開始時的綁定來源（v1.1 起才記；與 advanceEpisode 的欄位順序相同，整筆比 JSON 才不會每輪都判成有變動）
    ...(EP_SOURCES.has(e.stopSource) ? { stopSource: e.stopSource } : {}),
  };
}

/** 逐筆快照上限（本機表不信任；超過就當沒有快照） */
const LOTS_MAX = 200;

/** 逐筆快照讀回（resolveStop 的 prev.lots）：任一筆形狀不對就整份丟（null＝沒有快照） */
function parseLots(v) {
  if (!Array.isArray(v) || v.length > LOTS_MAX) return null;
  const out = [];
  for (const l of v) {
    if (!isObj(l) || typeof l.id !== 'string' || !l.id || l.id.length > 80 || !isPos(l.buyPrice) || !isPos(l.qty)) return null;
    if (l.buyDate != null && !YMD_RE.test(String(l.buyDate))) return null;
    out.push({ id: l.id, buyPrice: l.buyPrice, qty: l.qty, buyDate: l.buyDate ?? null });
  }
  return out;
}

/** 寫進本機表的逐筆快照（只留比對需要的欄位） */
const snapLots = lots => (Array.isArray(lots)
  ? lots.filter(l => isObj(l) && typeof l.id === 'string' && isPos(l.buyPrice) && isPos(l.qty))
    .map(l => ({ id: l.id, buyPrice: l.buyPrice, qty: l.qty, buyDate: l.buyDate ?? null }))
  : null);

/**
 * 本機事件表讀回：{ nextId, byCode: { [code]: { stop, ver, settledYmd, ep, lots, startedAt, tradeDate, floor, sess } } }；形狀不對一律丟（不信任本機資料）。
 * lots＝這一版的逐筆快照（棘輪與成本更正的比對基準）；startedAt／tradeDate＝本裝置偵測到這一版的時刻與版本日（第一次進表＝0／''；
 * ATR 帶換值記為當日開盤前）；floor＝這一版的成本線棘輪（v1 舊表沒有＝null，視同 stop）；
 * sess＝{ ymd, stop }：交易日 ymd 收盤（13:30）前本裝置最後看到的停損＝該日盤中適用的停損（隔日結算用；SKILL §8.2「當天適用的停損」）。
 */
export function parseStopEpisodes(raw) {
  const empty = { nextId: 1, byCode: {} };
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.byCode)) return empty;
  const byCode = {};
  for (const [code, x] of Object.entries(raw.byCode)) {
    if (!/^\d{4,6}[A-Z]?$/.test(code) || !isObj(x) || !isPos(x.stop) || !Number.isInteger(x.ver) || x.ver < 1) continue;
    byCode[code] = {
      stop: x.stop, ver: x.ver, settledYmd: ymdOr(x.settledYmd, ''), ep: x.ep == null ? null : parseEpisode(x.ep),
      lots: parseLots(x.lots), startedAt: isNum(x.startedAt) && x.startedAt >= 0 ? x.startedAt : 0, tradeDate: ymdOr(x.tradeDate, ''),
      floor: isPos(x.floor) ? x.floor : null,
      sess: isObj(x.sess) && YMD_RE.test(String(x.sess.ymd)) && isPos(x.sess.stop) ? { ymd: x.sess.ymd, stop: x.sess.stop } : null,
    };
  }
  const maxId = Math.max(0, ...Object.values(byCode).map(x => x.ep?.id ?? 0));
  const nextId = Number.isInteger(raw.nextId) && raw.nextId > maxId ? raw.nextId : maxId + 1;
  return { nextId, byCode };
}

/** 寫回 localStorage 的形狀 */
export function serializeStopEpisodes(state) {
  return { v: 1, nextId: state.nextId, byCode: state.byCode };
}

// 欄位順序固定（parse 與 step 都依同一順序建物件），所以可以整筆比 JSON
const sameEntry = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);

/** 本裝置補判的觸及（前一交易日收盤 ≤ 停損、本機沒有事件）：kind 'late'，觸發價＝前一交易日收盤 */
const lateTouchOf = prevClose => ({
  status: 'touched', kind: 'late', triggerPx: prevClose, skipPct: null, basis: null, segment: null, notJudged: null, hold: null,
  staleSec: null, facts: [],
});

/** 本機表記得住的換版原因（resolveStop 的 versionReason；其他一律當持股變動 'ratchet'＝舊事件結束） */
const ROW_REASONS = new Set(['costCorrection', 'ratchet', 'lineRaise', 'bandDown']);

/**
 * 一輪：先以前一交易日收盤結算事件（> 停損×1.02 ⇒ 結束），再以今日觸及推進事件。
 * rows：每檔持股 { code, stop, floor, source, touch, at, prevClose, prevYmd, lots, reason }——stop／touch 由 warStopView 帶本機表這一檔
 *   當 prev 算出（成本線只升不降；攤平、FIFO 賣出不下移）；floor＝這一版的成本線棘輪（res.floorStop）；source＝綁定來源
 *   （res.stopSource，記在新事件上給一級文字用）；prevClose 只在今日有真成交時給（MIS 昨收），否則 null；reason＝resolveStop 的換版原因。
 *   · 停損數字變了 ⇒ 換版。持股變動／成本更正（ratchet／costCorrection）⇒ 舊事件結束，記下本裝置偵測時刻（setToday 推定用）；
 *     ATR 帶換值（lineRaise／bandDown）⇒ 事件延續（SKILL §8.2），交易日記為開盤前生效（帶值開盤起就適用，當日照常判定）。
 *   · 這一檔第一次拿到前一交易日收盤（新進表、切換當天，或 v1 舊表第一次以 v1.1 判定）而收盤已 ≤ 停損 ⇒ seeded
 *     （事件早已開始，不發一級，只發二級彙總）。
 *   · 其他情況前一交易日收盤 ≤ 停損、本機卻沒有事件，且這一版在前一交易日收盤前就生效 ⇒ 本裝置漏判（當天沒開戰情、
 *     收盤競價後才觸及…）⇒ 開 'late' 事件、發一級並標「前一交易日收盤後補判·本裝置」；今日已觸及就照今日的觸及記。
 * 結算前一交易日一律用該日盤中適用的停損（本機表 sess；SKILL §8.2）——持股分析全天每 30 分鐘重算，收盤歸檔後 ATR 帶換成
 *   當日收盤版（資料日＝當日、隔一個交易日起才適用），若拿「最後一版」結算會把當日的觸及事件提前結束、隔天再發一次一級。
 *   本裝置當日盤中沒看到過這一檔（沒有 sess）才退回最後一版。
 * ctx.versionYmd：換版的版本日（非交易日＝最後交易日，呼叫端以休市日曆算；預設 todayYmd）。
 * rows 為空（持股未載入或已全數出清）時保留舊表，避免重新整理時誤把事件清掉而重發。
 * @returns {{ state, changed: boolean, sendLevel1: string[], seeded: string[], late: string[] }}
 */
export function stepStopEpisodes(state, rows, { todayYmd, nowMs, versionYmd }) {
  const list = Array.isArray(rows) ? rows.filter(r => r && typeof r.code === 'string' && isPos(r.stop)) : [];
  if (!list.length) return { state, changed: false, sendLevel1: [], seeded: [], late: [] };
  const verYmd = ymdOr(versionYmd, todayYmd);
  const openToday = taipeiAt(todayYmd, 9, 0);
  // 今天是交易日（呼叫端以休市日曆給 versionYmd）而且還沒收盤 ⇒ 這一輪的停損就是今日盤中適用的停損（記 sess）
  const closeToday = taipeiAt(todayYmd, 13, 30);
  const inSession = verYmd === todayYmd && Number.isFinite(closeToday) && nowMs <= closeToday;
  let nextId = state.nextId;
  const byCode = {}, sendLevel1 = [], seeded = [], late = [];
  for (const r of list) {
    const old = state.byCode[r.code] ?? null;
    let ep = old?.ep ?? null;
    // v1 舊表的一檔第一次以 v1.1 判定（舊表沒有 floor；ATR 帶首次納入）且沒有進行中的事件 ⇒ 視同切換當天：前一交易日收盤已在
    //   新停損下的部位以 seeded 彙總處理、不逐檔發一級（SKILL §8.3）；進行中的事件照常延續（lineRaise）。
    const migrating = !!old && old.floor == null && isPos(r.floor) && !old.ep;
    const settledYmd = migrating ? '' : old?.settledYmd ?? '';
    const hasPrev = isPos(r.prevClose) && typeof r.prevYmd === 'string' && YMD_RE.test(r.prevYmd);
    const newDay = hasPrev && r.prevYmd > settledYmd;
    const firstCheck = hasPrev && settledYmd === '';
    const settleStop = old?.sess && old.sess.ymd === r.prevYmd ? old.sess.stop : old?.stop;
    if (ep && newDay) ep = settleEpisode(ep, { officialClose: r.prevClose, stop: settleStop, dateYmd: r.prevYmd }).episode;
    let ver = old?.ver ?? 1, reason = null, startedAt = old?.startedAt ?? 0, tradeDate = old?.tradeDate ?? '';
    if (old && old.stop !== r.stop) {
      ver = old.ver + 1;
      reason = ROW_REASONS.has(r.reason) ? r.reason : 'ratchet';
      // ATR 帶換值：交易日當天偵測到的記為開盤前（不是本裝置偵測時刻）⇒ 當日不算新設停損；非交易日照偵測時刻（晚於最後交易日收盤）
      const bandOpen = BAND_REASONS.has(reason) && verYmd === todayYmd && Number.isFinite(openToday);
      startedAt = bandOpen ? Math.min(nowMs, openToday - 1) : nowMs;
      tradeDate = verYmd;
    }
    const belowPrev = hasPrev && r.prevClose <= r.stop;
    const seedNow = !ep && belowPrev && (!old || firstCheck);
    const lateNow = !ep && belowPrev && !!old && !firstCheck && newDay && reason == null
      && startedAt <= taipeiAt(r.prevYmd, 13, 30);
    const touch = lateNow && r.touch?.status !== 'touched' ? lateTouchOf(r.prevClose) : r.touch;
    const adv = advanceEpisode(ep, {
      touch, stopVersion: ver, versionReason: reason, todayYmd, nowMs: isPos(r.at) ? r.at : nowMs, nextId, seeded: seedNow,
      stopSource: EP_SOURCES.has(r.source) ? r.source : null,
    });
    if (adv.isNew) nextId += 1;
    if (adv.sendLevel1) sendLevel1.push(r.code);
    if (adv.isNew && adv.episode?.seeded) seeded.push(r.code);
    if (adv.isNew && adv.episode?.kind === 'late') late.push(r.code);
    byCode[r.code] = {
      stop: r.stop, ver, settledYmd: newDay ? r.prevYmd : settledYmd, ep: adv.episode,
      lots: snapLots(r.lots) ?? old?.lots ?? null, startedAt, tradeDate, floor: isPos(r.floor) ? r.floor : null,
      sess: inSession ? { ymd: todayYmd, stop: r.stop } : old?.sess ?? null,
    };
  }
  const keys = Object.keys(byCode);
  const changed = nextId !== state.nextId || keys.length !== Object.keys(state.byCode).length
    || keys.some(k => !sameEntry(state.byCode[k], byCode[k]));
  return { state: changed ? { nextId, byCode } : state, changed, sendLevel1, seeded, late };
}

const KIND_TEXT = Object.freeze({
  touch: '今日最低觸及', gap: '開盤即低於停損', close: '收盤時判定', late: '前一交易日收盤後補判·本裝置',
});
/** Z2 一級文字的口徑註記（第二輪 A7「ok」：網頁判定，標「單一裝置·暫算」，維持到停損簿切換正式） */
export const STOP_L1_BASIS = '單一裝置·暫算';

/** 事件 id：stop:<代號>:p<前端版本>:e<事件序號>（p＝前端暫算版本，與 daemon 的 v<stopVersion> 分開，不會相撞） */
export const stopEventId = (code, ver, epId) => `stop:${code}:p${ver}:e${epId}`;

/**
 * 今日已發一級的觸停損事件（重新整理後重掛；同 id 不重複）。文字只寫代號、事件與來源（成本線／ATR 帶），
 * 不寫個人停損價（隱私，events.ts；規範 wording.md「戰情 Z2」列）。names：代號 → 名稱；只列目前仍持有的代號。
 */
export function stopLevel1Events(state, names, todayYmd) {
  const out = [];
  for (const [code, x] of Object.entries(state.byCode)) {
    const ep = x.ep;
    if (!ep || !ep.level1Sent || !names.has(code) || taipeiYmd(ep.triggerAt) !== todayYmd) continue;
    const who = `${code} ${names.get(code) ?? ''}`.trim();
    const src = EP_SOURCES.has(ep.stopSource) ? `${stopSourceLabel(ep.stopSource)}·` : '';
    out.push({
      id: stopEventId(code, ep.stopVersion, ep.id), at: ep.triggerAt, kind: 'stopLoss', level: 1, code, mine: true,
      text: `${who} 觸停損（${src}${KIND_TEXT[ep.kind] ?? '今日最低觸及'}）·${STOP_L1_BASIS}`,
    });
  }
  return out;
}

/**
 * 成本資料可疑（現價÷買進均價 <0.25 或 >5，SKILL §3.4／§8.3）：每檔每日一則二級（id 含日期）；該檔停損警示暫停。
 * 文字不寫成本、比值與停損價（Z2／B2 不寫個人金額，events.ts）。names：代號 → 名稱；只列目前仍持有的代號。
 */
export function stopSuspectEvents(codes, names, todayYmd, nowMs) {
  const out = [];
  for (const code of [...new Set(Array.isArray(codes) ? codes : [])].sort()) {
    if (typeof code !== 'string' || !names.has(code)) continue;
    const who = `${code} ${names.get(code) ?? ''}`.trim();
    out.push({
      id: `stopSuspect:${todayYmd}:${code}`, at: nowMs, kind: 'mine', level: 2, code, mine: true,
      text: `${who} 成本資料可疑（現價與買進均價相差過大）·本檔停損警示暫停·${STOP_L1_BASIS}`,
    });
  }
  return out;
}

/** 今日 seeded（第一次判定時已在停損下）的持股：一則二級彙總，不逐檔發一級；沒有回 null */
export function stopSeededEvent(state, names, todayYmd) {
  const codes = Object.entries(state.byCode)
    .filter(([code, x]) => x.ep?.seeded && x.ep.firstDate === todayYmd && names.has(code))
    .map(([code]) => code).sort();
  if (!codes.length) return null;
  const who = codes.map(c => `${c} ${names.get(c) ?? ''}`.trim());
  return {
    id: `stopSeeded:${todayYmd}:${codes.join(',')}`, at: Math.min(...codes.map(c => state.byCode[c].ep.triggerAt)),
    kind: 'mine', level: 2, mine: true, text: `${stopFactText('seededDigest', { codes: who })}·${STOP_L1_BASIS}`,
  };
}
