// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2：daemon 停損簿 stopBooks/{uid}（AI 停損規範 stop-v1.1）前端讀取端的純函式（唯一實作；前端經 warroom-stopbook.d.mts
//   匯入，單元測試 warroom-stopbook.test.mjs）。規範 .claude/skills/tw-ai-stoploss/SKILL.md「生效範圍」、§3.6；實作計畫 §3.1–§3.3。
//
//   · 停損簿 phase 'live' 且 specVersion 'stop-v1.1' 才是生效的停損（stopBookLive＝!legacyBranchActive）。
//     'shadow'（影子期，S3–S4）只記錄、不推播——戰情照前端暫算，快看抽屜另列影子值供 I5 比對（shadowStopOf）。
//   · 生效時（bookStopOf）：
//       'book'     逐筆快照與目前持股一致、資料日沒過期（≥ 前一交易日）⇒ 直接用停損簿這一版（與推播同一口徑）
//       'bookCalc' 不一致、過期、停損簿沒有這檔或這檔資料不完整 ⇒ 同一支 resolveStop 帶停損簿的 prev／ex／lineInputs／
//                  期限內事件收緊暫算（棘輪一樣生效），標「暫算·待 daemon 確認」（SKILL §3.6）
//       'legacy'   該檔留在第一階段口徑（legacyCodeActive：noOfficialBars，或組成線來自尚未驗證的官方鏡像歸檔——5～6 碼與英文字尾
//                  ETF、興櫃在官方日 K 歸檔驗證前，第二輪 A3、R8；verifiedArchives 讀停損簿文件裡 daemon 寫的同一份，與 daemon
//                  legacyBranchActive 同口徑）⇒ legacyPushStop（有持股分析 ATR 帶就用，否則成本 −8%），標「沿用現行推播口徑」
// 停損簿由 daemon 以 Admin SDK 單一寫入、規則只開放本人與管理員讀；這裡的檢查是防資料形狀錯誤（缺就退回暫算，不捏造）。
// 規則：純函式——不 import firebase、不讀時鐘（時間一律由參數傳入），回傳新物件、不改輸入。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import {
  STOP_SPEC_VERSION, STOP_PARAMS, EMPTY_EX_TABLE, isEtfCode, onTick, resolveStop, activeOverlays, prevStateOf,
  legacyBranchActive, legacyCodeActive, legacyPushStop, stopSourceLabel, mmddText,
} from './ai-stoploss.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const posOr = v => (isPos(v) ? v : null);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^\d{4,6}[A-Z]?$/;
const SOURCES = new Set(['cost', 'atrBand', 'breakeven', 'trail', 'event']);
const srcOr = v => (SOURCES.has(v) ? v : null);
const ymdOr = v => (typeof v === 'string' && YMD_RE.test(v) ? v : null);
const ARCHIVES = new Set(['etf', 'emerging']);

/**
 * stopBooks/{uid} 讀回（不信任形狀）：phase 只收 'shadow'／'live'；positions 只留代號合法、值是物件的列；
 * verifiedArchives 只收 'etf'／'emerging'（daemon 寫的已驗證官方鏡像歸檔種類；缺＝空＝都還沒驗證，fail-closed）。
 * 不合格回 null（＝沒有停損簿，前端暫算）。
 */
export function parseStopBookDoc(raw) {
  if (!isObj(raw) || (raw.phase !== 'shadow' && raw.phase !== 'live') || typeof raw.specVersion !== 'string') return null;
  const positions = {};
  if (isObj(raw.positions)) {
    for (const [code, bp] of Object.entries(raw.positions)) if (CODE_RE.test(code) && isObj(bp)) positions[code] = bp;
  }
  const verifiedArchives = [...new Set(Array.isArray(raw.verifiedArchives) ? raw.verifiedArchives.filter(a => ARCHIVES.has(a)) : [])].sort();
  return {
    phase: raw.phase, specVersion: raw.specVersion, dataDate: ymdOr(raw.dataDate),
    updatedAt: isPos(raw.updatedAt) ? raw.updatedAt : null, positions, verifiedArchives,
  };
}

/** 停損簿是否生效（phase 'live' 且 specVersion 為本版）；沒有停損簿、影子期、版本不符都是 false */
export function stopBookLive(book) {
  return isObj(book) && !legacyBranchActive(book);
}

const lotKey = l => `${l?.id}|${l?.buyPrice}|${l?.qty}|${l?.buyDate ?? ''}`;
/** 逐筆快照一致（id、買價、張數、買進日；順序不計） */
export function sameLots(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const ka = a.map(lotKey).sort();
  const kb = b.map(lotKey).sort();
  return ka.every((k, i) => k === kb[i]);
}

/** 停損簿資料日落後：沒有資料日，或早於前一交易日（＝落後今天超過 1 個交易日，SKILL §3.6） */
export function stopBookStale(book, prevYmd) {
  if (!isObj(book) || !book.dataDate) return true;
  return typeof prevYmd === 'string' && YMD_RE.test(prevYmd) && book.dataDate < prevYmd;
}

const exOf = bp => (isObj(bp?.ex) && Array.isArray(bp.ex.events) ? bp.ex : EMPTY_EX_TABLE);

function suspectOf(lastPrice, adjCost, fallback) {
  if (!isPos(lastPrice) || !isPos(adjCost)) return fallback === true;
  const r = lastPrice / adjCost;
  return r < STOP_PARAMS.suspectLo || r > STOP_PARAMS.suspectHi;
}

const LINE_KEYS = ['costLine', 'bandLine', 'beLine', 'trailLine', 'eventLine'];
const linesOf = v => Object.fromEntries(LINE_KEYS.map(k => [k, posOr(isObj(v) ? v[k] : null)]));

/** 停損簿一檔 → StopResolution（停損簿是權威值；只有成本可疑以目前價重算） */
function resFromBook(bp, lastPrice) {
  const src = srcOr(bp.stopSource);
  return {
    specVersion: STOP_SPEC_VERSION, stop: bp.stop, baseStop: posOr(bp.baseStop) ?? bp.stop, floorStop: posOr(bp.floorStop) ?? bp.stop,
    bandHold: posOr(bp.bandHold), line: 'stop', basis: 'system',
    basisText: typeof bp.basisText === 'string' && bp.basisText ? bp.basisText : stopSourceLabel(src ?? 'cost'),
    stopSource: src, sourceDate: ymdOr(bp.sourceDate), floorSource: srcOr(bp.floorSource), floorSourceDate: ymdOr(bp.floorSourceDate),
    bandSourceDate: ymdOr(bp.bandSourceDate), adjCost: posOr(bp.adjCost), costLine: posOr(bp.costLine), lines: linesOf(bp.lines),
    linesStale: bp.linesStale === true, bandRejected: null, exGapBars: Number.isInteger(bp.exGapBars) ? bp.exGapBars : 0,
    holdHigh: isObj(bp.holdHigh) && isPos(bp.holdHigh.price) ? bp.holdHigh : null, atr14: posOr(bp.atr14),
    noOfficialBars: bp.noOfficialBars === true, eventKeys: Array.isArray(bp.eventKeys) ? bp.eventKeys : [],
    stopVersion: Number.isInteger(bp.stopVersion) ? bp.stopVersion : 0, versionReason: null,
    startedAt: isNum(bp.startedAt) ? bp.startedAt : 0, tradeDate: ymdOr(bp.tradeDate) ?? '',
    lotChanges: [], exApplied: Array.isArray(bp.exApplied) ? bp.exApplied : [], selfAdjusted: isObj(bp.selfAdjusted) ? bp.selfAdjusted : {},
    exUnknown: bp.exUnknown === true, suspect: suspectOf(lastPrice, bp.adjCost, bp.suspect), rejected: [],
  };
}

/** 第一階段口徑（legacyCodeActive 的代號；A3、R8 歸檔驗證前）：legacyPushStop＝有持股分析 ATR 帶就用，否則成本 −8% */
function legacyRes(position, ratingBand, lastPrice) {
  const avg = position?.avgCost;
  const lp = legacyPushStop(avg, ratingBand);
  const src = lp ? (lp.source === 'ai' ? 'atrBand' : 'cost') : null;
  const stop = lp ? lp.price : null;
  return {
    specVersion: STOP_SPEC_VERSION, stop, baseStop: stop, floorStop: src === 'cost' ? stop : null, bandHold: src === 'atrBand' ? stop : null,
    line: 'stop', basis: 'system',
    basisText: !lp ? '成本資料缺' : src === 'atrBand' ? 'ATR 帶（持股分析）·沿用現行推播口徑' : '成本 −8%·沿用現行推播口徑',
    stopSource: src, sourceDate: null, floorSource: src === 'cost' ? 'cost' : null, floorSourceDate: null, bandSourceDate: null,
    adjCost: posOr(avg), costLine: lp && src === 'cost' ? stop : null,
    lines: { costLine: src === 'cost' ? stop : null, bandLine: src === 'atrBand' ? stop : null, beLine: null, trailLine: null, eventLine: null },
    linesStale: false, bandRejected: null, exGapBars: 0, holdHigh: null, atr14: null, noOfficialBars: true, eventKeys: [],
    stopVersion: 0, versionReason: null, startedAt: 0, tradeDate: '', lotChanges: [], exApplied: [], selfAdjusted: {},
    exUnknown: false, suspect: suspectOf(lastPrice, avg, false), rejected: [],
  };
}

/**
 * 停損簿生效時一檔持股的停損（呼叫端先確認 stopBookLive）。
 * @returns {{ mode: 'book'|'bookCalc'|'legacy', res, bp, why: null|'missing'|'stale'|'lots'|'invalid' }}
 */
export function bookStopOf(position, opts = {}) {
  const { book, todayYmd = '', prevYmd = null, lastPrice = null, nowMs = 0, ratingBand = null } = opts;
  const code = position?.code;
  const bp = isObj(book?.positions) && isObj(book.positions[code]) ? book.positions[code] : null;
  const isEtf = isEtfCode(code);
  // 與 daemon legacyBranchActive 同一支判斷（R8 鏡像歸檔驗證前的代號也留在第一階段口徑；2026-10-06 審查）
  if (bp && legacyCodeActive(bp, { verifiedArchives: book?.verifiedArchives })) return { mode: 'legacy', res: legacyRes(position, ratingBand, lastPrice), bp, why: null };
  const stale = stopBookStale(book, prevYmd);
  const match = !!bp && sameLots(bp.lots, position?.lots);
  const valid = !!bp && isPos(bp.stop) && onTick(bp.stop, isEtf) && Number.isInteger(bp.stopVersion);
  if (bp && match && !stale && valid) return { mode: 'book', res: resFromBook(bp, lastPrice), bp, why: null };
  const why = !bp ? 'missing' : stale ? 'stale' : !match ? 'lots' : 'invalid';
  const res = resolveStop({
    position, ex: exOf(bp), prev: valid ? prevStateOf(bp) : null, lines: isObj(bp?.lineInputs) ? bp.lineInputs : null,
    events: activeOverlays(Array.isArray(bp?.events) ? bp.events : [], todayYmd || null),
    latestCanonicalYmd: book?.dataDate ?? null, isEtf, lastPrice: isPos(lastPrice) ? lastPrice : null, nowMs, tradeDate: todayYmd,
  });
  return { mode: 'bookCalc', res, bp, why };
}

/** 'bookCalc' 的原因註記（「暫算·待 daemon 確認」之後的括號） */
export function bookCalcWhyText(why, book) {
  switch (why) {
    case 'missing': return '停損簿尚無此檔';
    case 'stale': return `停損簿資料日 ${mmddText(book?.dataDate)}`;
    case 'lots': return '持股與停損簿逐筆快照不符';
    case 'invalid': return '停損簿這一檔資料不完整';
    default: return '';
  }
}

/**
 * 影子期（phase 'shadow'）停損簿這一檔的 daemon 試算值——只供快看抽屜對照（SKILL §11 I5），不參與任何判定；
 * 停損簿生效或沒有這檔回 null。
 */
export function shadowStopOf(book, code) {
  if (!isObj(book) || book.phase !== 'shadow' || !isObj(book.positions)) return null;
  const bp = book.positions[code];
  if (!isObj(bp) || !isPos(bp.stop)) return null;
  return {
    stop: bp.stop, stopSource: srcOr(bp.stopSource),
    basisText: typeof bp.basisText === 'string' && bp.basisText ? bp.basisText : stopSourceLabel(srcOr(bp.stopSource) ?? 'cost'),
    dataDate: book.dataDate ?? null, noOfficialBars: bp.noOfficialBars === true,
  };
}
