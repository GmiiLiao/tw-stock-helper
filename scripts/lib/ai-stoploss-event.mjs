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
import { isRuleContinuation, isLegalOngoing, ruleEventDateOf, eventDateLater } from './news-rule-evidence.mjs';
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
 *   D 走過四角色挑戰；E 類別在 ctx.classes 內（有傳時）；F 不是延續（ruleCont：同一檔同類別有效期內重複觸發，2026-10-07「不當新事件」——
 *   延續只從「被當成新事件」的那次判別起算〔news-rule-evidence.mjs ruleTrailEligible：主類別、挑戰過、非承接、讀過內文、label 利空，
 *   與這裡 B–D 同口徑〕，所以首次判定那天這裡已收過；首次沒收成事件〔挑戰失敗、只是次要類別…〕的不起算，隔日照新事件收。
 *   之後的同一事件由 stepEventOverlay 的事件身分處理，這裡不再收）。有效期內事件日期較晚的新進展（N4，2026-10-07「依建議進行」：
 *   先搜索、兩天後羈押）不是延續，這裡照收，eventDate 帶新的事件日期，交給 stepEventOverlay 重新起算。
 * C16a 只收「新聞視窗內有新進展」的（使用者 2026-10-07 N1(b)）：舊案 ruleFacts.C16a==='old'（涉訟中）、工安事故調查 'acc' 都沒有
 *   ruleClass＝C16a，ruleClassOf 本來就不認；2026-10-07 前的舊資料沒有新進展欄位，照舊認（不改歷史）。
 * **不看** w、強度、信心（它們只寫進 research）。B–D 與戰情 majorBearOf 同一套（isCurrentEntry）。
 * 回傳依代號排序：{ code, cls, clsKey, label, sub, key:`${code}:${cls}`, eventDate, pass, at, targetDate, weight, weightSource, tier, research }
 *   eventDate：事件日期（ruleEventDateOf：延續軌跡優先、再看稽核軌跡；非 C16a 與舊資料為 null）。
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
    if (isRuleContinuation(v)) continue;
    if (!isCurrentEntry(entry, nctx) || entry.at == null) continue;
    if (isNum(ctx.minAtMs) && entry.at < ctx.minAtMs) continue;
    if (!ruleRead(v)) continue;
    const c = RULE_CLASS_BY_CODE[cls];
    const sub = ruleSubOf(v, cls);
    const tier = eventTierOf(cls, sub);
    out.push({
      code, cls, clsKey: c.key, label: c.label, sub, key: `${code}:${cls}`, eventDate: ruleEventDateOf(v, cls), pass: entry.p ?? null, at: entry.at,
      targetDate: nctx.targetDate, weight: tier.weight, weightSource: tier.weightSource, tier: tier.tier,
      research: { w: entry.w ?? null, strength: entry.s ?? null, confidence: entry.c ?? null, eventType: entry.ev ?? null },
    });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

// ── 疊加層狀態機（SKILL §10A.4） ────────────────────────────────────────────

const validOverlay = o => isObj(o) && typeof o.key === 'string' && typeof o.cls === 'string'
  && (o.state === 'deferred' || (o.state === 'active' && isPos(o.line) && YMD_RE.test(String(o.effectiveFrom)) && YMD_RE.test(String(o.expiresAfter))));
const isText = v => typeof v === 'string' && v.length > 0;
const validSeen = s => Array.isArray(s) && (s.length === 3 || s.length === 4) && typeof s[0] === 'string'
  && YMD_RE.test(String(s[1])) && YMD_RE.test(String(s[2])) && (s.length === 3 || s[3] == null || typeof s[3] === 'string');

/** 事件身分記憶一列 [key, 生效日, 最後有效日, 事件日期?]：事件日期有值才帶第 4 格（2026-10-07 N4；舊的三格照認） */
function putSeen(list, key, eff, exp, eventDate = null) {
  const row = isText(eventDate) ? [key, eff, exp, eventDate] : [key, eff, exp];
  return [...list.filter(s => s[0] !== key), Object.freeze(row)];
}

/** N4 盤中換新的延後標記（掛在仍生效的舊層上，renewPending）：形狀不對當沒有 */
const pendingOf = o => (isObj(o) && isObj(o.renewPending) && isText(o.renewPending.eventDate) ? o.renewPending : null);

/** 舊層去掉延後換新標記（收盤班車處理完、或沒有收盤價時） */
function withoutPending(o) {
  const { renewPending: _p, ...rest } = o;
  return rest;
}

/** 幾個已記的事件日期取最晚的（eventDateLater；讀不到的跳過）；都沒有回 null */
function latestEventDate(list) {
  let out = null;
  for (const d of list) if (isText(d) && (!out || eventDateLater(d, out))) out = d;
  return out;
}

/**
 * 同代號同類別的事件身分（SKILL §10A.4）：old＝現有的層、s＝身分記憶、ed＝這件的事件日期、
 * knownEd＝已記的事件日期（延後換新標記、層、身分記憶第 4 格取最晚——收盤班車沒算成時層與身分記憶可能不同步）。
 * renew（N4，2026-10-07「依建議進行」）：這件的事件日期晚於已記的（eventDateLater；任一邊讀不到就不算），而且舊事件還在期限內
 *   （層還在，或身分記憶的最後有效日未過）⇒ 新事件、重新起算。到期後的冷卻期（eventRearmDays）照舊算同一事件（D22 不變）。
 * same：不是新事件、記 'sameEvent'（同類別的層存在，或到期後冷卻期內）。
 */
function eventIdentity(ev, overlays, seenL, todayYmd, isTradingDay) {
  const ed = isText(ev.eventDate) ? ev.eventDate : null;
  const old = overlays.find(o => o.key === ev.key) ?? null;
  const s = seenL.find(x => x[0] === ev.key) ?? null;
  const knownEd = latestEventDate([pendingOf(old)?.eventDate, old?.eventDate, s?.[3]]);
  const renew = eventDateLater(ed, knownEd) && (!!old || (!!s && todayYmd <= s[2]));
  const rearmUntil = s ? addTradingDays(s[2], STOP_PARAMS.eventRearmDays, isTradingDay) : null;
  const same = !renew && (!!old || (!!s && (!rearmUntil || todayYmd <= rearmUntil)));
  return { ed, old, s, knownEd, renew, same };
}

/** 舊層／身分記憶沒有事件日期（N4 前建立）：補上這件的日期——比不了就算同一事件，之後更晚日期的新進展才算新事件（同 ruleTrail 的相容規則） */
function backfillEventDate(overlays, seenL, id, key) {
  if (!id.ed || id.knownEd) return { overlays, seenL };
  return {
    overlays: overlays.map(o => (o.key === key ? { ...o, eventDate: id.ed } : o)),
    seenL: id.s ? putSeen(seenL, key, id.s[1], id.s[2], id.ed) : seenL,
  };
}

/** 生效中的舊層（N4 換新時才看；延後層不算） */
const activeLayer = o => (o && o.state === 'active' && isPos(o.line) ? o : null);

/**
 * N4 重新起算的收緊線：舊層在新層生效日仍生效時不提前放寬——取新舊較高者。回 { line, held }（held＝沿用線的舊層，口徑欄位
 * 跟著它；沒有舊層 null）。盤中成交價已不高於新線（B3）的情況不在這裡：同首次事件延後到收盤重算（stepEventOverlay 的 renewPending）。
 */
function renewLine(fresh, act) {
  return act && act.line >= fresh - EPS ? { line: act.line, held: act } : { line: fresh, held: null };
}

/**
 * 收盤班車處理一個延後換新（2026-10-07 審查：盤中換新不能抬線時，比照首次事件延後，不只延長期限）：以今日官方收盤重算新線，
 * 舊層在次一交易日仍有效時取新舊較高者，次一交易日生效、期限從那天起算。沒有收盤價 ⇒ 'noRef'、舊層照舊；收緊線 ≤ 基礎停損 ⇒
 * 'noBite'、舊層照舊到期。回 { layer, seenRow, outcome, line }。
 */
function settleRenewal(o, p, c) {
  const t = eventTierOf(o.cls, p.sub ?? null);
  const fresh = eventLineOf(c.refClose, c.atr14, { isEtf: c.isEtf, atrMult: t.atrMult, minPct: t.minPct });
  const eff = nextTradingYmd(c.todayYmd, c.isTradingDay);
  const exp = eff ? addTradingDays(eff, c.holdDays - 1, c.isTradingDay) : null;
  const base = { key: o.key, cls: o.cls, tier: t.tier, weight: t.weight, renew: true };
  if (!fresh || !eff || !exp) return { layer: withoutPending(o), seenRow: null, base, outcome: 'noRef', line: null };
  const { line, held } = renewLine(fresh, o.expiresAfter >= eff ? o : null);
  const seenRow = [o.key, eff, exp, p.eventDate];
  if (isPos(c.baseStop) && line <= c.baseStop + EPS) return { layer: withoutPending(o), seenRow, base, outcome: 'noBite', line };
  const ref = held
    ? { refClose: held.refClose ?? null, refYmd: held.refYmd ?? null, atr14: held.atr14 ?? null }
    : { refClose: c.refClose, refYmd: c.todayYmd, atr14: isPos(c.atr14) ? c.atr14 : null };
  const layer = {
    key: o.key, code: p.code ?? o.code ?? null, cls: o.cls, sub: p.sub ?? null, label: p.label ?? o.label ?? null,
    tier: t.tier, weight: t.weight, startedAt: c.nowMs, eventDate: p.eventDate, renewOf: p.renewOf ?? null,
    line, ...ref, effectiveFrom: eff, expiresAfter: exp, state: 'active', source: 'deferred',
  };
  return { layer, seenRow, base, outcome: 'applied', line };
}

/** 舊層到期時延後換新還沒被收盤班車處理（daemon 沒跑到）：轉成一般延後層，下一次收盤班車照首次事件的延後層處理 */
function deferredFromPending(o, p) {
  return {
    key: o.key, code: p.code ?? o.code ?? null, cls: o.cls, sub: p.sub ?? null, label: p.label ?? o.label ?? null,
    tier: p.tier ?? o.tier, weight: p.weight ?? o.weight ?? null, startedAt: isNum(p.startedAt) ? p.startedAt : o.startedAt,
    eventDate: p.eventDate, renewOf: p.renewOf ?? null,
    line: null, refClose: null, refYmd: null, atr14: null, effectiveFrom: null, expiresAfter: null, state: 'deferred', source: 'intraday',
    deferredPx: isPos(p.deferredPx) ? p.deferredPx : null, deferredLine: isPos(p.deferredLine) ? p.deferredLine : null,
  };
}

/**
 * 推進一檔持股的事件收緊疊加層（可同時有多個類別，各自一層；生效停損取其中最高的線）。純函式。
 * when：
 *   'premarket'（08:46 停損簿刷新）＝先移除到期層（expiresAfter < 今日 ⇒ 'expire'），再套用盤後／夜補／晨間趟的新事件（生效日＝今日，非 setToday）；
 *   'intraday'（盤中趟判別寫入後的下一輪）＝新事件生效日＝今日（setToday）；今日真成交價（或最後交易日官方收盤）≤ 收緊線 ⇒ 'deferred'；
 *   'close'（16:45 資料到齊班車）＝只處理延後層與延後換新（renewPending）：以今日官方收盤重算，次一交易日生效、期限從那天起算。
 *   到期不在這裡處理。
 * 事件身分＝(代號, 類別, 首次生效交易日)：同類別的層存在 ⇒ 'sameEvent'（不改線、不延長）；到期後 eventRearmDays 個交易日內 ⇒ 'sameEvent'。
 *   例外（N4，2026-10-07）：舊事件期限內來了事件日期較晚的新進展（先搜索、兩天後羈押）⇒ 新事件，同類別的層換成新的一層：
 *   生效日＝今日、期限從今日重算、eventDate 記新日期、renewOf 記舊日期；線依新事件的前收重算，但舊層仍生效時取新舊較高者（renewLine）。
 *   盤中成交價已不高於新線（B3）⇒ 比照首次事件延後（2026-10-07 審查）：舊層照常生效、掛 renewPending，收盤班車以收盤價重算、
 *   取新舊較高者、次一交易日生效、期限從那天起算（settleRenewal）。紀錄帶 renew:true。
 * 條件 A：firstDate < 生效日才套用（＝ 'boughtSameDay'、> 'boughtAfter'、缺 'noFirstDate'）。收緊線 ≤ 基礎停損 ⇒ 'noBite'（記入身分，不重試）。
 * 輸入 events 只放這一檔的事件（ruleBearEvents 的輸出依代號過濾）；tier 'none' 的事件記 'belowWeight'／'notSignal'，不收緊。
 * 回 { overlays, seen, changed:('tighten'|'expire'|'deferred')[], records:[{ key, cls, outcome, line, tier, weight, renew? }] }
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
  const rec = (o, outcome, line = null) => records.push({
    key: o.key, cls: o.cls, outcome, line, tier: o.tier ?? null, weight: o.weight ?? null, ...(o.renew === true ? { renew: true } : {}),
  });

  if (when === 'premarket') {
    const keep = [];
    for (const o of overlays) {
      if (o.state === 'active' && o.expiresAfter < todayYmd) {
        rec(o, 'expired', o.line); changed.add('expire');
        const p = pendingOf(o);
        if (p) keep.push(deferredFromPending(o, p));
      } else keep.push(o);
    }
    overlays = keep;
  }

  if (when === 'close') {
    const next = [];
    for (const o of overlays) {
      const p = o.state === 'active' ? pendingOf(o) : null;
      if (p) {
        const r = settleRenewal(o, p, { refClose, atr14, isEtf, todayYmd, isTradingDay, baseStop, nowMs, holdDays });
        if (r.seenRow) seenL = putSeen(seenL, ...r.seenRow);
        next.push(r.layer);
        rec(r.base, r.outcome, r.line);
        if (r.outcome === 'applied') changed.add('tighten');
        continue;
      }
      if (o.state !== 'deferred') { next.push(o); continue; }
      const t = eventTierOf(o.cls, o.sub ?? null);
      const line = eventLineOf(refClose, atr14, { isEtf, atrMult: t.atrMult, minPct: t.minPct });
      const eff = nextTradingYmd(todayYmd, isTradingDay);
      const exp = eff ? addTradingDays(eff, holdDays - 1, isTradingDay) : null;
      if (!line || !eff || !exp) { rec(o, 'noRef'); continue; }
      seenL = putSeen(seenL, o.key, eff, exp, o.eventDate ?? null);
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
    const id = eventIdentity(ev, overlays, seenL, todayYmd, isTradingDay);
    const base = { key: ev.key, cls: ev.cls, tier: t.tier, weight: t.weight, renew: id.renew };
    if (t.tier === 'none') { rec(base, t.reason === 'notSignal' ? 'notSignal' : 'belowWeight'); continue; }
    if (id.same) { ({ overlays, seenL } = backfillEventDate(overlays, seenL, id, ev.key)); rec(base, 'sameEvent'); continue; }
    // 新事件（含 N4 重新起算）：同類別的舊層由新的一層取代（不是 N4 時本來就沒有同類別的層）
    const others = overlays.filter(o => o.key !== ev.key);
    const eff = todayYmd;
    const exp = addTradingDays(eff, holdDays - 1, isTradingDay);
    if (!YMD_RE.test(String(firstDate))) { rec(base, 'noFirstDate'); continue; }
    if (firstDate >= eff) {
      if (exp) { overlays = others; seenL = putSeen(seenL, ev.key, eff, exp, id.ed); }
      rec(base, firstDate === eff ? 'boughtSameDay' : 'boughtAfter');
      continue;
    }
    const fresh = eventLineOf(refClose, atr14, { isEtf, atrMult: t.atrMult, minPct: t.minPct });
    if (!fresh || !exp) { rec(base, 'noRef'); continue; }
    const act = id.renew ? activeLayer(id.old) : null;
    const { line, held } = renewLine(fresh, act);
    if (isPos(baseStop) && line <= baseStop + EPS) { overlays = others; seenL = putSeen(seenL, ev.key, eff, exp, id.ed); rec(base, 'noBite', line); continue; }
    const layer = {
      key: ev.key, code: ev.code ?? null, cls: ev.cls, sub: ev.sub ?? null, label: ev.label ?? RULE_CLASS_BY_CODE[ev.cls]?.label ?? null,
      tier: t.tier, weight: t.weight, startedAt: nowMs, ...(id.ed ? { eventDate: id.ed } : {}), ...(id.renew ? { renewOf: id.knownEd } : {}),
    };
    // 盤中成交價已不高於新事件自己的收緊線（B3）⇒ 今天不抬，比照首次事件延後到收盤重算
    const blocked = when === 'intraday' && (!isPos(lastTradePx) || lastTradePx <= fresh + EPS);
    if (blocked && act) {
      // N4 換新：舊層照常生效（不提前放寬），延後換新掛在舊層上；收盤班車 settleRenewal 以收盤價重算、取新舊較高者、次一交易日生效
      const { key: _k, cls: _c, ...info } = layer;
      const pending = { ...info, renewOf: id.knownEd, deferredPx: isPos(lastTradePx) ? lastTradePx : null, deferredLine: fresh };
      overlays = overlays.map(o => (o === act ? { ...o, renewPending: pending } : o));
      seenL = putSeen(seenL, ev.key, eff, exp, id.ed);
      rec(base, 'deferred', fresh);
      changed.add('deferred');
      continue;
    }
    if (blocked) {
      overlays = [...others, { ...layer, line: null, refClose: null, refYmd: null, atr14: null, effectiveFrom: null, expiresAfter: null, state: 'deferred', source: 'intraday', deferredPx: isPos(lastTradePx) ? lastTradePx : null, deferredLine: line }];
      seenL = putSeen(seenL, ev.key, eff, exp, id.ed);
      rec(base, 'deferred', line);
      changed.add('deferred');
      continue;
    }
    const ref = held
      ? { refClose: held.refClose ?? null, refYmd: held.refYmd ?? null, atr14: held.atr14 ?? null }
      : { refClose, refYmd: YMD_RE.test(String(refYmd)) ? refYmd : null, atr14: isPos(atr14) ? atr14 : null };
    overlays = [...others, {
      ...layer, line, ...ref, effectiveFrom: eff, expiresAfter: exp, state: 'active', source: when === 'intraday' ? 'intraday' : 'premarket',
    }];
    seenL = putSeen(seenL, ev.key, eff, exp, id.ed);
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
    //   （與 ruleBearEvents 同口徑：規則欄位答「是」的判別不論 label 都往下判）。C16a 舊案（涉訟中，2026-10-07 N1(b)）另記
    //   'legalOngoing'，供日後量「舊案不改判」漏掉幾件大跌。
    else if (v.label !== '利空' && !ruleClassOf(v)) reason = isLegalOngoing(v) ? 'legalOngoing' : 'notBear';
    else if (!ruleRead(v)) reason = 'notRead';
    else if (entry?.cr) reason = 'carried';
    else if (entry?.ch !== true) reason = 'notChallenged';
    else if (isNum(minAtMs) && isNum(entry?.at) && entry.at < minAtMs) reason = 'beforeMin';
    else {
      const cls = ruleClassOf(v);
      if (!cls) reason = isLegalOngoing(v) ? 'legalOngoing' : isPossibleLegalBear(v) ? 'aiBearLegalNoRule' : 'bearNotRule';
      else if (isRuleContinuation(v)) reason = 'continuation';   // 延續：首次判定那天已是事件（ruleBearEvents 不再收）
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
