// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1 共用純函式·事件收緊（第 14 項裁定＋第二輪 A4「做skills判定與加權重」）：
//   規則類利空事件的述詞 ruleBearEvents、類別權重分級 eventTierOf、收緊線 eventLineOf、疊加層狀態機 stepEventOverlay、
//   命中與漏網兩份影子紀錄 eventShadowRows／missShadowRows。
// 類別與類別權重（新聞技能 §4.1 baseWeight，先驗·未回測）的唯一來源：scripts/lib/news-rule-classes.mjs。
// ⚠ 不看 AI 新聞識讀的結果權重 w（rankMediaVerdicts；研究期只顯示）：w 只寫進紀錄的 research 欄位，任何判斷都不讀它（SKILL §10B）。
// 判別的時效、讀內文、挑戰等條件沿用戰情同一套（scripts/lib/warroom-news.mjs），不另寫第二份。
// 對外一律經 scripts/lib/ai-stoploss.mjs（集線器）匯入。規則：純函式、不碰網路與檔案、不讀時鐘。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { newsBoardFromDoc, newsCtxOf, isCurrentEntry, isAiRead, isPossibleLegalBear, GATE_E } from './warroom-news.mjs';
import { RULE_CLASS_BY_CODE, ruleClassOf, ruleSubOf, classWeightOf } from './news-rule-classes.mjs';
import { STOP_PARAMS, floorTick, limitPrices, nextTradingYmd, addTradingDays } from './ai-stoploss-base.mjs';
import { atr14Of } from './ai-stoploss-lines.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const EPS = 1e-9;

// ── 類別權重分級（SKILL §10A.3） ────────────────────────────────────────────

/**
 * 類別（＋子類別）→ 收緊級別：依 STOP_PARAMS.eventTiers 由高到低比對類別權重。
 * 回 { tier:'strong'|'mild'|'none', atrMult, minPct, weight, weightSource, reason }；
 * reason：'notSignal'（新聞技能明定不當訊號，C23）｜'belowWeight'（權重 <0.3）｜'unknownClass'｜null。
 */
export function eventTierOf(cls, sub = null) {
  const c = RULE_CLASS_BY_CODE[cls];
  if (!c) return { tier: 'none', atrMult: null, minPct: null, weight: null, weightSource: null, reason: 'unknownClass' };
  const cw = classWeightOf(cls, sub);
  if (!c.tightenEligible) return { tier: 'none', atrMult: null, minPct: null, weight: cw.weight, weightSource: cw.source, reason: 'notSignal' };
  for (const t of STOP_PARAMS.eventTiers) {
    if (cw.weight >= t.minWeight - EPS) return { tier: t.tier, atrMult: t.atrMult, minPct: t.minPct, weight: cw.weight, weightSource: cw.source, reason: null };
  }
  return { tier: 'none', atrMult: null, minPct: null, weight: cw.weight, weightSource: cw.source, reason: 'belowWeight' };
}

/**
 * 事件收緊線＝floorTick(前收 − max(atrMult×ATR14, minPct%×前收))（SKILL §10A.3；向下取檔保住最小距離）。
 * opts：{ isEtf, atrMult（預設 1）, minPct（預設 3） }，也可只傳布林（isEtf）。ATR14 缺時只用百分比；前收缺回 null。
 */
export function eventLineOf(refClose, atr14, opts = {}) {
  const o = typeof opts === 'boolean' ? { isEtf: opts } : (opts ?? {});
  if (!isPos(refClose)) return null;
  const atrMult = isPos(o.atrMult) ? o.atrMult : 1;
  const minPct = isPos(o.minPct) ? o.minPct : 3;
  const dist = Math.max(isPos(atr14) ? atrMult * atr14 : 0, (refClose * minPct) / 100);
  return floorTick(refClose - dist, !!o.isEtf);
}

// ── 規則類利空事件（SKILL §10A.1 條件 B–E） ─────────────────────────────────

/** 規則類別的「AI 讀過內文」：同戰情 isAiRead；E 引用強制未過時，規則類別比照法律規則放行（AI 只認定事實、方向由規則定） */
function ruleRead(v) {
  if (isAiRead(v)) return true;
  return isObj(v) && v.gate === GATE_E && isAiRead({ ...v, gate: null });
}

function parseVerdicts(doc) {
  if (!isObj(doc) || typeof doc.verdictJson !== 'string') return null;
  try {
    const raw = JSON.parse(doc.verdictJson);
    return isObj(raw) ? raw : null;
  } catch { return null; }
}

/**
 * newsVerdict/latest → 合格的規則類利空事件（每檔最多一件）。條件：
 *   B 判別屬於今日適用交易日、非承接、判讀時間 ≥ minAtMs（上一交易日 13:30）；C 規則類利空（ruleClassOf：ruleClass＋該類事實題答「是」，
 *   舊資料 C16a 認 ruleOverride／「【規則】」前綴；**不看 label**——非法律類別 daemon 不覆寫 label，2026-10-06 R1）且 AI 讀過內文；
 *   D 走過四角色挑戰；E 類別在 ctx.classes 內（有傳時）。
 * **不看** w、強度、信心（它們只寫進 research）。B–D 與戰情 majorBearOf 同一套（isCurrentEntry）。
 * 回傳依代號排序：{ code, cls, clsKey, label, sub, key:`${code}:${cls}`, pass, at, targetDate, weight, weightSource, tier, research }
 */
export function ruleBearEvents(doc, ctx = {}) {
  const board = newsBoardFromDoc(doc);
  const raw = parseVerdicts(doc);
  if (!board || !raw) return [];
  const nctx = newsCtxOf(board.meta, ctx.applicableYmd);
  const allow = Array.isArray(ctx.classes) ? new Set(ctx.classes) : null;
  const out = [];
  for (const [code, entry] of Object.entries(board.map)) {
    const v = raw[code];
    const cls = ruleClassOf(v);
    if (!cls || (allow && !allow.has(cls))) continue;
    if (!isCurrentEntry(entry, nctx) || entry.at == null) continue;
    if (isNum(ctx.minAtMs) && entry.at < ctx.minAtMs) continue;
    if (!ruleRead(v)) continue;
    const c = RULE_CLASS_BY_CODE[cls];
    const sub = ruleSubOf(v, cls);
    const tier = eventTierOf(cls, sub);
    out.push({
      code, cls, clsKey: c.key, label: c.label, sub, key: `${code}:${cls}`, pass: entry.p ?? null, at: entry.at,
      targetDate: nctx.targetDate, weight: tier.weight, weightSource: tier.weightSource, tier: tier.tier,
      research: { w: entry.w ?? null, strength: entry.s ?? null, confidence: entry.c ?? null, eventType: entry.ev ?? null },
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

// ── 疊加層狀態機（SKILL §10A.4） ────────────────────────────────────────────

const validOverlay = o => isObj(o) && typeof o.key === 'string' && typeof o.cls === 'string'
  && (o.state === 'deferred' || (o.state === 'active' && isPos(o.line) && YMD_RE.test(String(o.effectiveFrom)) && YMD_RE.test(String(o.expiresAfter))));
const validSeen = s => Array.isArray(s) && s.length === 3 && typeof s[0] === 'string' && YMD_RE.test(String(s[1])) && YMD_RE.test(String(s[2]));

function putSeen(list, key, eff, exp) {
  return [...list.filter(s => s[0] !== key), Object.freeze([key, eff, exp])];
}

/**
 * 推進一檔持股的事件收緊疊加層（可同時有多個類別，各自一層；生效停損取其中最高的線）。純函式。
 * when：
 *   'premarket'（08:46 停損簿刷新）＝先移除到期層（expiresAfter < 今日 ⇒ 'expire'），再套用盤後／夜補／晨間趟的新事件（生效日＝今日，非 setToday）；
 *   'intraday'（盤中趟判別寫入後的下一輪）＝新事件生效日＝今日（setToday）；今日真成交價（或最後交易日官方收盤）≤ 收緊線 ⇒ 'deferred'；
 *   'close'（16:45 資料到齊班車）＝只處理延後層：以今日官方收盤重算，次一交易日生效、期限從那天起算。到期不在這裡處理。
 * 事件身分＝(代號, 類別, 首次生效交易日)：同類別的層存在 ⇒ 'sameEvent'（不改線、不延長）；到期後 eventRearmDays 個交易日內 ⇒ 'sameEvent'。
 * 條件 A：firstDate < 生效日才套用（＝ 'boughtSameDay'、> 'boughtAfter'、缺 'noFirstDate'）。收緊線 ≤ 基礎停損 ⇒ 'noBite'（記入身分，不重試）。
 * 輸入 events 只放這一檔的事件（ruleBearEvents 的輸出依代號過濾）；tier 'none' 的事件記 'belowWeight'／'notSignal'，不收緊。
 * 回 { overlays, seen, changed:('tighten'|'expire'|'deferred')[], records:[{ key, cls, outcome, line, tier, weight }] }
 */
export function stepEventOverlay(prevOverlays, input) {
  const {
    events = [], seen = [], baseStop = null, firstDate = null, refClose = null, refYmd = null, atr14 = null,
    lastTradePx = null, todayYmd, nowMs, when, isTradingDay, isEtf = false,
  } = input ?? {};
  let overlays = (Array.isArray(prevOverlays) ? prevOverlays : []).filter(validOverlay);
  let seenL = (Array.isArray(seen) ? seen : []).filter(validSeen);
  const records = [];
  const changed = new Set();
  const holdDays = STOP_PARAMS.eventHoldDays;
  const rec = (o, outcome, line = null) => records.push({ key: o.key, cls: o.cls, outcome, line, tier: o.tier ?? null, weight: o.weight ?? null });

  if (when === 'premarket') {
    const keep = [];
    for (const o of overlays) {
      if (o.state === 'active' && o.expiresAfter < todayYmd) { rec(o, 'expired', o.line); changed.add('expire'); }
      else keep.push(o);
    }
    overlays = keep;
  }

  if (when === 'close') {
    const next = [];
    for (const o of overlays) {
      if (o.state !== 'deferred') { next.push(o); continue; }
      const t = eventTierOf(o.cls, o.sub ?? null);
      const line = eventLineOf(refClose, atr14, { isEtf, atrMult: t.atrMult, minPct: t.minPct });
      const eff = nextTradingYmd(todayYmd, isTradingDay);
      const exp = eff ? addTradingDays(eff, holdDays - 1, isTradingDay) : null;
      if (!line || !eff || !exp) { rec(o, 'noRef'); continue; }
      seenL = putSeen(seenL, o.key, eff, exp);
      if (isPos(baseStop) && line <= baseStop + EPS) { rec(o, 'noBite', line); continue; }
      next.push({ ...o, line, refClose, refYmd: todayYmd, atr14: isPos(atr14) ? atr14 : null, effectiveFrom: eff, expiresAfter: exp, state: 'active', source: 'deferred', startedAt: nowMs });
      rec(o, 'applied', line);
      changed.add('tighten');
    }
    return { overlays: next, seen: pruneSeen(seenL, todayYmd, isTradingDay), changed: [...changed], records };
  }

  const byKey = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    if (!isObj(ev) || typeof ev.key !== 'string') continue;
    const old = byKey.get(ev.key);
    if (!old || (isNum(ev.at) && isNum(old.at) && ev.at < old.at)) byKey.set(ev.key, ev);
  }
  for (const ev of byKey.values()) {
    const t = eventTierOf(ev.cls, ev.sub ?? null);
    const base = { key: ev.key, cls: ev.cls, tier: t.tier, weight: t.weight };
    if (t.tier === 'none') { rec(base, t.reason === 'notSignal' ? 'notSignal' : 'belowWeight'); continue; }
    if (overlays.some(o => o.key === ev.key)) { rec(base, 'sameEvent'); continue; }
    const s = seenL.find(x => x[0] === ev.key);
    const rearmUntil = s ? addTradingDays(s[2], STOP_PARAMS.eventRearmDays, isTradingDay) : null;
    if (s && (!rearmUntil || todayYmd <= rearmUntil)) { rec(base, 'sameEvent'); continue; }
    const eff = todayYmd;
    const exp = addTradingDays(eff, holdDays - 1, isTradingDay);
    if (!YMD_RE.test(String(firstDate))) { rec(base, 'noFirstDate'); continue; }
    if (firstDate >= eff) { seenL = exp ? putSeen(seenL, ev.key, eff, exp) : seenL; rec(base, firstDate === eff ? 'boughtSameDay' : 'boughtAfter'); continue; }
    const line = eventLineOf(refClose, atr14, { isEtf, atrMult: t.atrMult, minPct: t.minPct });
    if (!line || !exp) { rec(base, 'noRef'); continue; }
    if (isPos(baseStop) && line <= baseStop + EPS) { seenL = putSeen(seenL, ev.key, eff, exp); rec(base, 'noBite', line); continue; }
    const layer = {
      key: ev.key, code: ev.code ?? null, cls: ev.cls, sub: ev.sub ?? null, label: ev.label ?? RULE_CLASS_BY_CODE[ev.cls]?.label ?? null,
      tier: t.tier, weight: t.weight, startedAt: nowMs,
    };
    if (when === 'intraday' && (!isPos(lastTradePx) || lastTradePx <= line + EPS)) {
      overlays = [...overlays, { ...layer, line: null, refClose: null, refYmd: null, atr14: null, effectiveFrom: null, expiresAfter: null, state: 'deferred', source: 'intraday', deferredPx: isPos(lastTradePx) ? lastTradePx : null, deferredLine: line }];
      seenL = putSeen(seenL, ev.key, eff, exp);
      rec(base, 'deferred', line);
      changed.add('deferred');
      continue;
    }
    overlays = [...overlays, {
      ...layer, line, refClose, refYmd: YMD_RE.test(String(refYmd)) ? refYmd : null, atr14: isPos(atr14) ? atr14 : null,
      effectiveFrom: eff, expiresAfter: exp, state: 'active', source: when === 'intraday' ? 'intraday' : 'premarket',
    }];
    seenL = putSeen(seenL, ev.key, eff, exp);
    rec(base, 'applied', line);
    changed.add('tighten');
  }
  return { overlays, seen: pruneSeen(seenL, todayYmd, isTradingDay), changed: [...changed], records };
}

/** 事件身分記憶：到期日再過 eventRearmDays 個交易日之後就不必記（約 10 個交易日） */
function pruneSeen(list, todayYmd, isTradingDay) {
  return list.filter(s => {
    const until = addTradingDays(s[2], STOP_PARAMS.eventRearmDays, isTradingDay);
    return !until || todayYmd <= until;
  });
}

/** 期限內、可進停損的疊加層（resolveStop 的 events）：state 'active' 且 effectiveFrom ≤ 適用日 ≤ expiresAfter */
export function activeOverlays(overlays, applyYmd) {
  return (Array.isArray(overlays) ? overlays : []).filter(o => validOverlay(o) && o.state === 'active'
    && (!applyYmd || (o.effectiveFrom <= applyYmd && applyYmd <= o.expiresAfter)));
}

// ── 影子紀錄：命中與漏網（SKILL §10A.7；使用者規則「回測要出命中與漏網兩份記錄」） ─────────

const COMPARE_ATR = Object.freeze([0.5, 1, 2, 3]);
const pct = (a, b) => (isPos(a) && isPos(b) ? +(((a / b) - 1) * 100).toFixed(2) : null);

/** 一條線在 [生效日起 5 根] 內的觸及與後續分類（洗出／命中／賣在相對低點；未觸及記之後 20 根最大跌幅） */
function lineOutcome(line, after, refClose) {
  if (!isPos(line)) return { line: null, touched: false, outcome: 'noLine' };
  const window = after.slice(0, STOP_PARAMS.eventHoldDays);
  const i = window.findIndex(b => isPos(b.l) && b.l <= line + EPS);
  if (i < 0) {
    const lows = after.slice(0, 20).map(b => b.l).filter(isPos);
    const maxDd = lows.length && isPos(refClose) ? pct(Math.min(...lows), refClose) : null;
    return { line, touched: false, outcome: after.length >= 20 ? 'untouched' : 'pending', maxDrawdownPct: maxDd };
  }
  const tb = window[i];
  const gap = isPos(tb.o) && tb.o <= line + EPS;
  const exitRef = gap ? tb.o : line;
  const post = after.slice(i + 1, i + 11);
  const washout = post.some(b => isPos(refClose) && b.c >= refClose - EPS);
  let outcome;
  if (washout) outcome = 'washout';
  else if (post.length < 10) outcome = 'pending';
  else outcome = post[9].c <= exitRef + EPS ? 'hit' : 'lowSell';
  return { line, touched: true, touchYmd: tb.date, touchType: gap ? 'gap' : 'touch', triggerPx: exitRef, outcome };
}

/**
 * 命中紀錄（全市場合成）：每件合格事件（含 tier 'none'，只記錄）以「生效日前最後一根官方收盤」為前收建一個合成部位，
 * 算類別級別的收緊線與 0.5／1／2／3×ATR 對照線，追蹤生效日起的觸及與第 1／5／10／20 根收盤。可每日整段重算（idempotent）。
 * barsByCode：官方還原日 K（升冪）；資料不足的欄位記 null、分類記 'pending'。w 只寫進 research，不影響分類。
 */
export function eventShadowRows({ events, barsByCode, dateYmd } = {}) {
  const rows = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!isObj(ev) || typeof ev.code !== 'string') continue;
    const bars = Array.isArray(barsByCode?.[ev.code]) ? barsByCode[ev.code] : [];
    const eff = ev.targetDate;
    const before = bars.filter(b => b.date < eff);
    const after = bars.filter(b => b.date >= eff);
    const ref = before[before.length - 1] ?? null;
    const t = eventTierOf(ev.cls, ev.sub ?? null);
    const refClose = ref?.c ?? null;
    const atr = before.length ? atr14Of(before) : null;
    const tierLine = t.tier === 'none' ? null : eventLineOf(refClose, atr, { atrMult: t.atrMult, minPct: t.minPct });
    const main = lineOutcome(tierLine, after, refClose);
    const at = n => (after[n - 1] ? { close: after[n - 1].c, vsLinePct: pct(after[n - 1].c, tierLine), vsRefPct: pct(after[n - 1].c, refClose) } : null);
    rows.push({
      date: dateYmd ?? null, code: ev.code, cls: ev.cls, label: ev.label ?? null, sub: ev.sub ?? null, tier: t.tier, weight: t.weight,
      pass: ev.pass ?? null, at: ev.at ?? null, effectiveFrom: eff ?? null, refYmd: ref?.date ?? null, refClose, atr14: atr,
      ...main, after: { d1: at(1), d5: at(5), d10: at(10), d20: at(20) },
      compare: Object.fromEntries(COMPARE_ATR.map(k => [
        `atr${String(k).replace('.', '_')}`,
        lineOutcome(isPos(refClose) && isPos(atr) ? floorTick(refClose - k * atr) : null, after, refClose),
      ])),
      research: isObj(ev.research) ? { ...ev.research } : null,
    });
  }
  return rows;
}

/**
 * 漏網紀錄（每日）：範圍＝會員持股 ∪ 當日判別宇宙。條件：官方收盤 ≤ 前收 − 2×ATR14，或收在跌停；而且 eventCodes（當日與前一交易日
 * 已有合格事件的代號）不含它。每列寫出判別各條件哪一條沒過（只記錄；AI 的 eventType、w、強度、信心一併記下，不參與判斷）。
 * 「AI 原判已是利空、沒有規則標記的法律事件」：判別沒存 negHits 時只能用字樣代理（isPossibleLegalBear），記 'aiBearLegalNoRule'。
 */
export function missShadowRows({ universe, barsByCode, newsDoc, dateYmd, applicableYmd, minAtMs = null, mopsCodes, eventCodes } = {}) {
  const board = newsBoardFromDoc(newsDoc);
  const raw = parseVerdicts(newsDoc);
  const nctx = board ? newsCtxOf(board.meta, applicableYmd) : null;
  const skip = eventCodes instanceof Set ? eventCodes : new Set(Array.isArray(eventCodes) ? eventCodes : []);
  const mops = mopsCodes instanceof Set ? mopsCodes : new Set(Array.isArray(mopsCodes) ? mopsCodes : []);
  const rows = [];
  for (const code of [...new Set(Array.isArray(universe) ? universe : [])].sort()) {
    if (skip.has(code)) continue;
    const bars = Array.isArray(barsByCode?.[code]) ? barsByCode[code] : [];
    const i = bars.findIndex(b => b.date === dateYmd);
    if (i < 1) continue;
    const today = bars[i], prev = bars[i - 1];
    const atr = atr14Of(bars.slice(0, i));
    const lim = limitPrices(prev.c, false, false);
    const atLimitDown = !!lim && today.c <= lim.down + EPS;
    const bigDrop = isPos(atr) && today.c <= prev.c - 2 * atr + EPS;
    if (!atLimitDown && !bigDrop) continue;
    const v = raw ? raw[code] : null;
    const entry = board ? board.map[code] : null;
    let reason;
    if (!board || !raw) reason = 'noDoc';
    else if (nctx?.fresh !== 'today') reason = 'docMismatch';
    else if (!isObj(v)) reason = 'noVerdict';
    // 不是利空、也不是規則類利空（ruleClassOf 不看 label：非法律類別 daemon 不覆寫 label，2026-10-06 R1）＝§10A.1-C 沒過
    //   （與 ruleBearEvents 同口徑：規則欄位答「是」的判別不論 label 都往下判）
    else if (v.label !== '利空' && !ruleClassOf(v)) reason = 'notBear';
    else if (!ruleRead(v)) reason = 'notRead';
    else if (entry?.cr) reason = 'carried';
    else if (entry?.ch !== true) reason = 'notChallenged';
    else if (isNum(minAtMs) && isNum(entry?.at) && entry.at < minAtMs) reason = 'beforeMin';
    else {
      const cls = ruleClassOf(v);
      if (!cls) reason = isPossibleLegalBear(v) ? 'aiBearLegalNoRule' : 'bearNotRule';
      else reason = eventTierOf(cls, ruleSubOf(v, cls)).tier === 'none' ? 'belowWeight' : 'qualified';
    }
    rows.push({
      date: dateYmd, code, close: today.c, prevClose: prev.c, dropPct: pct(today.c, prev.c), atr14: atr, atLimitDown, bigDrop,
      reason, label: isObj(v) ? v.label ?? null : null, ruleClass: isObj(v) ? ruleClassOf(v) : null,
      research: isObj(v) ? { eventType: v.eventType ?? null, w: entry?.w ?? null, strength: v.strength ?? null, confidence: v.confidence ?? null } : null,
      mops: mops.has(code),
    });
  }
  return rows;
}
