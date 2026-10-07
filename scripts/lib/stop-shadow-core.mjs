// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1·影子試算（S3）的純函式：停損簿 Firestore 編解碼、官方日 K 整理、除權息係數合併、第一階段對照值、
//   新舊兩套對照（命中與漏網）、公開計數、排程判定。I/O 在 stop-shadow-store.mjs，流程在 stop-shadow-runner.mjs。
// 規範：.claude/skills/tw-ai-stoploss/SKILL.md「生效範圍」影子期列、§11；實作計畫 warroom/stoploss/v1.1/impl-plan.md §1.5、§2.1。
// 影子期＝只記錄、不推播、不寫 alerts；公共的 stopSpecAudit 只放計數，不放個人持股代號。
// 規則：純函式——不 import firebase、不碰網路與檔案、不讀時鐘；回傳新物件、不改輸入。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { STOP_SPEC_VERSION, STOP_PARAMS, tickOf, isEtfCode, prevTradingYmd } from './ai-stoploss-base.mjs';
import { aggregatePositions, legacyPushStop, legacyDisciplineStop } from './ai-stoploss-core.mjs';
import { mergeFactorItems } from './exright-source.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

export const SHADOW_PHASE = 'shadow';
/** 16:45 起資料到齊班車讀的 chipArchive 份數（夠算 MA20、ATR14、10 日低；實作計畫 §2.1） */
export const BAR_WINDOW = 80;
/** 命中紀錄每日重算時往回取的事件日數（生效後 5 根期限＋之後 20 根結算） */
export const EVENT_LOOKBACK_DAYS = 30;
/** 持有期最高收盤一次性往前讀的上限（份；約 3 年，歸檔起點 2023-07-17） */
export const DEEP_MAX_DOCS = 800;
const M = (h, m) => h * 60 + m;
export const PREMARKET_FROM = M(8, 46);
export const MARKET_OPEN = M(9, 0);
export const MARKET_CLOSE = M(13, 30);

// ── 停損簿編解碼（Firestore 不收巢狀陣列：ex.events 的 [日期, 係數]、eventSeen 的 [key, 生效日, 最後有效日, 事件日期?]） ─────

/** undefined 的鍵刪除、陣列中的 undefined 轉 null（同 firestore-clean.dropUndefined；這裡自帶一份以免依賴非純模組） */
function clean(v) {
  if (Array.isArray(v)) return v.map(x => (x === undefined ? null : clean(x)));
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) out[k] = clean(v[k]);
    return out;
  }
  return v;
}

export function encodePosition(p) {
  if (!isObj(p)) return null;
  const ex = isObj(p.ex)
    ? { coverFrom: p.ex.coverFrom ?? null, coverTo: p.ex.coverTo ?? null, events: (Array.isArray(p.ex.events) ? p.ex.events : []).map(e => (Array.isArray(e) ? { d: e[0], f: e[1] } : e)) }
    : null;
  // eventSeen 第 4 格＝事件日期（2026-10-07 N4，有值才有）⇒ d
  const eventSeen = (Array.isArray(p.eventSeen) ? p.eventSeen : [])
    .map(s => (Array.isArray(s) ? { k: s[0], e: s[1], x: s[2], ...(typeof s[3] === 'string' && s[3] ? { d: s[3] } : {}) } : s));
  return clean({ ...p, ex, eventSeen });
}

export function decodePosition(raw) {
  if (!isObj(raw)) return null;
  const ex = isObj(raw.ex)
    ? {
      coverFrom: raw.ex.coverFrom ?? null, coverTo: raw.ex.coverTo ?? null,
      events: (Array.isArray(raw.ex.events) ? raw.ex.events : []).map(e => (isObj(e) ? [e.d, e.f] : e))
        .filter(e => Array.isArray(e) && typeof e[0] === 'string' && isPos(e[1])),
    }
    : null;
  const eventSeen = (Array.isArray(raw.eventSeen) ? raw.eventSeen : [])
    .map(s => (isObj(s) ? (typeof s.d === 'string' && s.d ? [s.k, s.e, s.x, s.d] : [s.k, s.e, s.x]) : s))
    .filter(s => Array.isArray(s) && (s.length === 3 || s.length === 4) && s.every(x => typeof x === 'string'));
  return { ...raw, ex, eventSeen };
}

export function encodeBook(book) {
  if (!isObj(book)) return null;
  const positions = {};
  for (const [k, v] of Object.entries(isObj(book.positions) ? book.positions : {})) { const p = encodePosition(v); if (p) positions[k] = p; }
  return clean({ ...book, positions });
}

export function decodeBook(data) {
  if (!isObj(data)) return null;
  const positions = {};
  for (const [k, v] of Object.entries(isObj(data.positions) ? data.positions : {})) { const p = decodePosition(v); if (p) positions[k] = p; }
  return { ...data, positions };
}

/** 停損簿＋plan* 的 bookPatch（代號 → 整份或 null＝出清）→ 新的停損簿；影子期一律 phase 'shadow'（切換 live 是 S5，另經使用者核可） */
export function applyBookPatch(book, patch, meta = {}) {
  const positions = { ...(isObj(book?.positions) ? book.positions : {}) };
  for (const [code, p] of Object.entries(isObj(patch) ? patch : {})) { if (p) positions[code] = p; else delete positions[code]; }
  return {
    ...(isObj(book) ? book : {}), nextEpisodeId: Number.isInteger(book?.nextEpisodeId) ? book.nextEpisodeId : 1,
    dataDate: book?.dataDate ?? null, ...meta, specVersion: STOP_SPEC_VERSION, phase: SHADOW_PHASE, positions,
  };
}

/** 鍵排序後的 JSON（判斷「有沒有變」，以免每輪都寫） */
export function stableJson(v) {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** 兩份停損簿的部位內容是否相同（meta 欄位不比） */
export function samePositions(a, b) {
  return stableJson(a?.positions ?? {}) === stableJson(b?.positions ?? {}) && (a?.nextEpisodeId ?? 1) === (b?.nextEpisodeId ?? 1);
}

// ── 官方日 K（chipArchive closeJson：[收, 量張, 開, 高, 低]） ─────────────────────

/**
 * chipArchive 文件（任意順序）→ { code: DayBar 原始值[]（升冪） }。codes 有給時只留這些代號（省記憶體）。
 * 開盤 0（當日沒有開盤成交）記 null；高低 0 由 lineInputsOf 的整理以收盤補。
 */
export function barsFromCloseDocs(docs, codes = null) {
  const want = codes instanceof Set ? codes : Array.isArray(codes) ? new Set(codes) : null;
  const out = {};
  const sorted = (Array.isArray(docs) ? docs : []).filter(d => isObj(d) && YMD_RE.test(String(d.date)))
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const d of sorted) {
    let m;
    try { m = typeof d.closeJson === 'string' ? JSON.parse(d.closeJson) : d.closeJson; } catch { m = null; }
    if (!isObj(m)) continue;
    for (const code of want ? want : Object.keys(m)) {
      const r = m[code];
      if (!Array.isArray(r) || !isPos(r[0])) continue;
      (out[code] ??= []).push({ date: d.date, c: r[0], v: isNum(r[1]) ? r[1] : null, o: isPos(r[2]) ? r[2] : null, h: isPos(r[3]) ? r[3] : r[0], l: isPos(r[4]) ? r[4] : r[0] });
    }
  }
  return out;
}

/** 兩段日 K 合併（同日以後者為準），升冪 */
export function concatBars(a, b) {
  const by = new Map();
  for (const x of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) if (isObj(x) && YMD_RE.test(String(x.date))) by.set(x.date, x);
  return [...by.values()].sort((p, q) => p.date.localeCompare(q.date));
}

// ── 除權息係數（官方除權息歷史檔＋daemon 抓的近期區間＋priceEvents 減資／面額變更） ─────────

const nextDayYmd = ymd => new Date(Date.parse(`${ymd}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** 歷史檔之後要抓的區間；歷史檔已涵蓋到 toYmd 回 null */
export function exFetchRange(history, toYmd) {
  if (!isObj(history) || !YMD_RE.test(String(history.to)) || !YMD_RE.test(String(toYmd)) || toYmd <= history.to) return null;
  return { from: nextDayYmd(history.to), to: toYmd };
}

/**
 * 係數表原料：exright-history.json（{ from, to, items:[[日期, 代號, factor]] }）＋近期區間（同格式，涵蓋 recentRange）＋
 * priceEvents（loadPriceFactors 的 { code:[{date,factor}] }）→ { items（mergeFactorItems 格式）, cover:{ from, to } }。
 * 涵蓋區間必須連續：近期區間沒抓到時 to＝歷史檔的 to（resolveStop 會因係數涵蓋不足而不採用組成線，fail-closed）。
 */
export function exItemsMerge({ history, recent = null, recentRange = null, priceFactors = null }) {
  if (!isObj(history) || !Array.isArray(history.items) || !YMD_RE.test(String(history.from)) || !YMD_RE.test(String(history.to))) return null;
  const contiguous = isObj(recentRange) && Array.isArray(recent) && recentRange.from === nextDayYmd(history.to);
  const seen = new Set();
  const ex = [];
  for (const it of [...history.items, ...(contiguous ? recent : [])]) {
    if (!Array.isArray(it) || typeof it[0] !== 'string' || typeof it[1] !== 'string' || !isPos(it[2])) continue;
    const k = `${it[0]}:${it[1]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    ex.push([it[0], it[1], it[2]]);
  }
  const pe = [];
  for (const [code, evs] of Object.entries(isObj(priceFactors) ? priceFactors : {})) {
    for (const e of Array.isArray(evs) ? evs : []) if (isObj(e) && isPos(e.factor) && typeof e.date === 'string') pe.push({ date: e.date, code, factor: e.factor });
  }
  return { items: mergeFactorItems(ex, pe), cover: { from: history.from, to: contiguous ? recentRange.to : history.to } };
}

// ── 第一階段對照值（影子期對照：舊推播、舊紀律、持股分析 ATR 帶；StopBookPosition.legacy） ─────

export function legacyOf(avgCost, ratingBand) {
  const p = legacyPushStop(avgCost, ratingBand);
  return { push: p?.price ?? null, discipline: legacyDisciplineStop(avgCost, ratingBand), ratingBand: isPos(ratingBand) ? ratingBand : null };
}

/** 代號 → 均價（與 resolveStop 同一套彙總規則） */
export function avgCostsOf(holdings) {
  return Object.fromEntries(aggregatePositions(holdings).map(p => [p.code, p.avgCost]));
}

// ── 新舊兩套對照（命中與漏網；只寫進本人的 stopBooks/{uid}/shadowDays） ─────────────

const codesOf = (list, pred) => [...new Set((Array.isArray(list) ? list : []).filter(a => isObj(a) && pred(a)).map(a => a.code).filter(c => typeof c === 'string' && c))].sort();
const split = (legacy, v11) => ({
  both: legacy.filter(c => v11.includes(c)), legacyOnly: legacy.filter(c => !v11.includes(c)), v11Only: v11.filter(c => !legacy.includes(c)),
});

/**
 * 一位會員一天的對照：舊制實際送出（legacySent：stop／trailing／discipline）對 v1.1 若切換會送出（wouldPush 一級、wouldDigest 紀律彙總）。
 * stop：同一份報價下兩套各自觸發的代號（both＝命中、legacyOnly／v11Only＝漏網兩向）；trailingLegacy：舊制獲利回落線（v1.1 退役）；
 * v11ProfitLine：v1.1 由保本線／追蹤線觸發的一級（取代 trailing 的那部分）。
 */
export function compareShadowDay(day) {
  const d = isObj(day) ? day : {};
  const lStop = codesOf(d.legacySent, a => a.type === 'stop');
  const vStop = codesOf(d.wouldPush, a => a.type === 'stop');
  const lDisc = codesOf(d.legacySent, a => a.type === 'discipline');
  const vDisc = isObj(d.wouldDigest) && Array.isArray(d.wouldDigest.codes) ? [...new Set(d.wouldDigest.codes)].sort() : [];
  return {
    stop: split(lStop, vStop),
    discipline: split(lDisc, vDisc),
    trailingLegacy: codesOf(d.legacySent, a => a.type === 'trailing'),
    v11ProfitLine: codesOf(d.wouldPush, a => a.type === 'stop' && (a.stopSource === 'breakeven' || a.stopSource === 'trail')),
  };
}

// ── 公開計數（stopSpecAudit/{date}；不放代號） ───────────────────────────────

const inc = (o, k, n = 1) => { if (k != null) o[k] = (o[k] ?? 0) + n; };

/** ATR 帶官方版（lines.bandLine）對持股分析 Yahoo 版（legacy.ratingBand）：差 ≤1 檔算相同（SKILL §15-6 的量化） */
function bandCompare(bp) {
  const off = bp?.lines?.bandLine ?? null, rating = bp?.legacy?.ratingBand ?? null;
  if (!isPos(off) && !isPos(rating)) return 'none';
  if (!isPos(off)) return 'ratingOnly';
  if (!isPos(rating)) return 'officialOnly';
  const t = tickOf(off, isEtfCode(String(bp?.code ?? '')));
  if (Math.abs(off - rating) <= t + 1e-9) return 'same';
  return off > rating ? 'officialHigher' : 'officialLower';
}

/**
 * 一組停損簿 → 部位層計數（綁定來源、資料狀態、今日版本原因、事件收緊、觸及事件、ATR 帶兩版本、v1.1 停損對舊推播停損的高低）。
 * 組成線由本機官方鏡像供給的 ETF／興櫃（lineInputs.archive；2026-10-06 R8）**分開統計**在 officialArchive[種類]（SKILL §2A 閘門 ⑥），
 * 不混進上面的計數。
 */
export function bookAuditCounts(books, dateYmd) {
  const out = {
    users: 0, positions: 0, bySource: {}, noOfficialBars: 0, linesStale: 0, exGap: 0, exUnknown: 0, suspect: 0,
    versionToday: {}, eventLayers: { active: 0, deferred: 0 }, episodes: { open: 0, seeded: 0 }, band: {},
    stopVsLegacyPush: { higher: 0, lower: 0, same: 0 }, officialArchive: {},
  };
  for (const b of Array.isArray(books) ? books : []) {
    const ps = Object.entries(isObj(b?.positions) ? b.positions : {});
    if (!ps.length) continue;
    out.users += 1;
    for (const [code, p] of ps) {
      out.positions += 1;
      if (p.noOfficialBars) { out.noOfficialBars += 1; continue; }
      const arc = p.lineInputs?.archive;
      if (arc === 'etf' || arc === 'emerging') {
        const a = (out.officialArchive[arc] ??= { positions: 0, bySource: {}, linesStale: 0, exGap: 0, episodes: 0 });
        a.positions += 1;
        inc(a.bySource, p.stopSource ?? 'none');
        if (p.linesStale) a.linesStale += 1;
        if ((p.exGapBars ?? 0) > 0) a.exGap += 1;
        if (p.episode) a.episodes += 1;
        continue;
      }
      inc(out.bySource, p.stopSource ?? 'none');
      if (p.linesStale) out.linesStale += 1;
      if ((p.exGapBars ?? 0) > 0) out.exGap += 1;
      if (p.exUnknown) out.exUnknown += 1;
      if (p.suspect) out.suspect += 1;
      if (p.tradeDate === dateYmd && p.versionReason) inc(out.versionToday, p.versionReason);
      for (const o of Array.isArray(p.events) ? p.events : []) inc(out.eventLayers, o?.state === 'deferred' ? 'deferred' : 'active');
      if (p.episode) { out.episodes.open += 1; if (p.episode.seeded) out.episodes.seeded += 1; }
      inc(out.band, bandCompare({ ...p, code }));
      const leg = p.legacy?.push;
      if (isPos(leg) && isPos(p.stop)) {
        const t = tickOf(p.stop, isEtfCode(code));
        inc(out.stopVsLegacyPush, Math.abs(p.stop - leg) <= t + 1e-9 ? 'same' : p.stop > leg ? 'higher' : 'lower');
      }
    }
  }
  return out;
}

/** 一天的影子紀錄（多位會員）→ 計數：v1.1 若切換會送幾則（依 sub）、舊制實際送幾則（依 type）、對照、紀律、事件收緊結果 */
export function dayAuditCounts(days) {
  const out = {
    wouldPush: {}, wouldDocOnly: {}, legacySent: {}, wouldDigest: 0, eventOutcomes: {},
    compare: { stopBoth: 0, stopLegacyOnly: 0, stopV11Only: 0, discBoth: 0, discLegacyOnly: 0, discV11Only: 0, trailingLegacy: 0, v11ProfitLine: 0 },
    wouldPushInProfit: 0,
  };
  for (const d of Array.isArray(days) ? days : []) {
    if (!isObj(d)) continue;
    for (const a of Array.isArray(d.wouldPush) ? d.wouldPush : []) {
      inc(out.wouldPush, a?.sub ?? a?.type ?? 'unknown');
      if (isNum(a?.pnlPct) && a.pnlPct > 0) out.wouldPushInProfit += 1;
    }
    for (const a of Array.isArray(d.wouldDocOnly) ? d.wouldDocOnly : []) inc(out.wouldDocOnly, a?.sub ?? 'unknown');
    for (const a of Array.isArray(d.legacySent) ? d.legacySent : []) inc(out.legacySent, a?.type ?? 'unknown');
    for (const r of Array.isArray(d.eventRecords) ? d.eventRecords : []) inc(out.eventOutcomes, r?.outcome ?? 'unknown');
    if (isObj(d.wouldDigest) && Array.isArray(d.wouldDigest.codes) && d.wouldDigest.codes.length) out.wouldDigest += 1;
    const c = compareShadowDay(d);
    out.compare.stopBoth += c.stop.both.length; out.compare.stopLegacyOnly += c.stop.legacyOnly.length; out.compare.stopV11Only += c.stop.v11Only.length;
    out.compare.discBoth += c.discipline.both.length; out.compare.discLegacyOnly += c.discipline.legacyOnly.length; out.compare.discV11Only += c.discipline.v11Only.length;
    out.compare.trailingLegacy += c.trailingLegacy.length; out.compare.v11ProfitLine += c.v11ProfitLine.length;
  }
  return out;
}

// ── 排程判定（定版看資料不看時鐘：收盤結算只在資料到齊後，盤前刷新只在交易日） ─────────────

/**
 * 收盤結算的目標資料日：交易日 13:30 後＝今天；交易日 08:46 前、或非交易日＝前一個（最後一個）交易日（補跑：前一日資料晚到或重啟錯過）；
 * 交易日 08:46–13:30＝null（下一交易日已開始，不回頭改寫——事件結算與組成線換版要在下一次盤前刷新之前完成）。
 */
export function closeTargetOf({ todayYmd, minutes, tradingDay, isTradingDay }) {
  if (tradingDay && minutes >= MARKET_CLOSE) return todayYmd;
  if (tradingDay && minutes >= PREMARKET_FROM) return null;
  return prevTradingYmd(todayYmd, isTradingDay);
}

/** 盤前刷新是否該跑：交易日 08:46 起、今天還沒完成；09:00 後才跑的標 late（版本 startedAt 在開盤後 ⇒ setToday 口徑） */
export function premarketDue({ todayYmd, minutes, tradingDay, doneYmd }) {
  if (!tradingDay || minutes < PREMARKET_FROM || minutes >= MARKET_CLOSE || doneYmd === todayYmd) return null;
  return { late: minutes >= MARKET_OPEN };
}

/** 台北某日某時刻的 epoch ms */
export function taipeiMs(ymd, hh, mm = 0) {
  return Date.parse(`${ymd}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+08:00`);
}

/** 規則類利空事件的最早判讀時刻：適用日的前一交易日 13:30（SKILL §10A.1 條件 B） */
export function eventMinAtMs(applicableYmd, isTradingDay) {
  const p = prevTradingYmd(applicableYmd, isTradingDay);
  return p ? taipeiMs(p, 13, 30) : null;
}

/** 歸檔驗證前沒有可用官方日 K 的代號（ETF 5～6 碼、興櫃；A3）給 plan* 的組成線原料 */
export function noBarsStub(dataDate = null) {
  return { dataDate, close: null, atr14: null, barsFrom: null, atrBand: null, holdHigh: null, exGapBars: 0, noOfficialBars: true };
}

/**
 * 本機官方鏡像的 ETF／興櫃日 K 讀取結果（official-bars.readOfficialBarsAsync；使用者 2026-10-06 R8）→ 能不能拿來算組成線（fail-closed）：
 * 閘門 ①②③（archiveGates.pass：逐份回聲＝鍵、最近連續 ≥20 個交易日、市場組成）通過，而且最後一個交易日＝資料日 toYmd 且已抓齊
 * （pendingTail 0）才 ok。回 { ok, reason（不 ok 的原因；ok 時 null）, barsByCode（不 ok 也留著，只給興櫃身分比對用）, tailRun }。
 */
export function officialBarsVerdict(result, toYmd) {
  const g = isObj(result) ? result.gates : null;
  const barsByCode = isObj(result?.barsByCode) ? result.barsByCode : {};
  let reason = null;
  if (!isObj(g)) reason = '讀取結果沒有閘門資訊';
  else if ((g.pendingTail ?? 0) > 0) reason = `資料日 ${toYmd} 鏡像尚未抓齊`;
  else if (g.lastDate !== toYmd) reason = `鏡像最後交易日 ${g.lastDate ?? '—'}≠資料日 ${toYmd}`;
  else if (g.pass !== true) reason = `最近連續完整 ${isNum(g.tailRun) ? g.tailRun : 0} 個交易日（需 ≥${isNum(g.minRun) ? g.minRun : 20}）`;
  return { ok: reason == null, reason, barsByCode, tailRun: isNum(g?.tailRun) ? g.tailRun : 0 };
}

/** 影子紀錄項目的去重鍵（同一則只記一次；重啟後讀回當日紀錄再比對） */
export function logKeyOf(kind, x) {
  if (!isObj(x)) return null;
  if (kind === 'eventRecords') return `${x.code}:${x.key}:${x.outcome}:${x.when}:${x.dayYmd ?? ''}`;
  if (kind === 'legacySent') return `${x.type}:${x.code}`;
  return typeof x.id === 'string' && x.id ? x.id : `${x.type ?? ''}:${x.sub ?? ''}:${x.code ?? ''}`;
}

export const SHADOW_PARAMS = Object.freeze({ capPct: STOP_PARAMS.capPct, barWindow: BAR_WINDOW, eventLookbackDays: EVENT_LOOKBACK_DAYS });
