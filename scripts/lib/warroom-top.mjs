// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2 指揮列（Z0）／大盤脈動（Z1）／一級警示帶（Z2）的純函式（唯一實作；前端與 build-top 共用）
//
// 資料來源只認 daemon 已寫好的 Firestore 文件（欄位以 scripts/ai-daemon.mjs 寫入端為準，缺就回 null，不補預設值）：
//   marketPulse/latest     computeMarketPulse（約 7690 行）：counts／level／twii／otc／updatedAt——家數口徑唯一來源（使用者裁定第 3 題）
//   marketPattern/latest   computeMarketPattern（約 12200 行）：live.{date,pattern,at}
//   system/ai-daemon       heartbeat（約 200 行）：active／lastHeartbeat（不外露 host、model）
//   system/daemonHealth    writeDaemonHealth（約 636 行，每小時）：hotLag.{at,p50,p90,freshPct}
//   taifexPositions/latest trackTaifex（約 3566 行）：date(YYYYMMDD)／foreignTxfNetOI／putCallRatio／updatedAt
//   users/{uid}/data/alerts daemon 個人警示（觸停損 type 'stop' 約 3250 行）；使用者自設價警示 2026-10-05 起改存 priceAlerts（critique H3 已修，見 alerts-split.mjs）
// （持股重大利空不在這裡：改由慢層 board.news 精簡表＋前端依使用者持股判定，見 warroom-news.mjs majorBearOf／stepMajorBear；
//   權重沿用 rankMediaVerdicts、先驗·未校準。pulse 路由不再讀 newsVerdict，省掉每 30 秒解析數百 KB。）
//
// 大盤危險（使用者裁定第 8 題＋critique 可用性 #4）：資料時間 09:10 後、跌停 ≥10 且 ≥ 漲停×1.5、連續 2 拍（2 份不同 updatedAt
//   的 marketPulse）才成立；成立後連續 2 拍不成立才解除；同日再發需距上次 30 分鐘。daemon 原本的 warns 不升級（它在 09:01
//   「跌停 1、漲停 0」就會成立）。
// 價格類一級警示暫停窗：08:30–09:00 盤前試撮、13:25–13:30 收盤集合競價（試撮指示價可能不成交，critique 可用性 #6）。
// 逼近停損：停損一律用 AI 停損規範 stop-v1（使用者 2026-10-05 指示；暫算同 A1：warroom-mine.provisionalStop＝成本線、
//   未含除權息調整，帶同一份本機事件表當棘輪的上一版），逼近＝距停損 ≤2%（沒有 ATR14）。
//   daemon 寫的觸停損（type 'stop'）是舊制推播（停損算法不同）⇒ 降為二級。
// 單元測試：node --test scripts/lib/warroom-top.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { taipeiMinuteOfDay, taipeiYmd } from './warroom-session.mjs';
import { aggregatePositions, stopDistance } from './ai-stoploss.mjs';
import { provisionalStop } from './warroom-mine.mjs';

const M = (h, m) => h * 60 + m;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const numOrNull = v => (isNum(v) ? v : null);
const posOrNull = v => (isNum(v) && v > 0 ? v : null);
const strOrNull = v => (typeof v === 'string' && v ? v : null);
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** 秒或毫秒、ISO、Firestore Timestamp → epoch ms（與 warroom-freshness 同口徑，這裡只收 build-top 會遇到的兩種） */
function epochMs(v) {
  if (isNum(v) && v > 0) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (isObj(v)) {
    if (typeof v.toMillis === 'function') { const t = v.toMillis(); return isNum(t) ? t : null; }
    const s = isNum(v.seconds) ? v.seconds : isNum(v._seconds) ? v._seconds : null;
    return s != null ? s * 1000 : null;
  }
  if (typeof v === 'string') { const t = Date.parse(v); return isNum(t) ? t : null; }
  return null;
}

// ── 規則常數 ────────────────────────────────────────────────────────────────

export const DANGER_RULE = Object.freeze({
  fromMinute: M(9, 10),        // 資料時間 09:10 起才判（開盤前 10 分鐘家數不穩）
  untilMinute: M(13, 25),      // 13:25 起收盤集合競價＝價格類暫停
  minLimitDown: 10,
  ratio: 1.5,
  beats: 2,                    // 連續 2 拍成立
  clearBeats: 2,               // 連續 2 拍不成立才解除
  refireMs: 30 * 60_000,       // 同日再發間隔
});

/** 盤型（marketPattern.live.pattern → 畫面文字） */
export const PATTERN_LABEL = Object.freeze({
  fadeDown: '開高走低', flatDown: '開平殺盤', downDown: '開低走低',
  reversalUp: '開低走高', upUp: '開高走高', range: '平盤震盪',
});

/** 盤勢燈（marketPulse.level.key → 燈色）：偏多紅、偏空綠、持平灰、危險紫（使用者裁定第 2 題） */
export const LEVEL_TONE = Object.freeze({ strong: 'up', good: 'up', flat: 'flat', weak: 'dn', bad: 'danger' });

// ── Firestore 文件 → payload（缺欄位一律 null，不補 0） ────────────────────

/** marketPulse/latest → 大盤脈動。文件不存在回 null。 */
export function normalizePulse(doc) {
  if (!isObj(doc)) return null;
  const c = isObj(doc.counts) ? doc.counts : null;
  const counts = c && isNum(c.limitUp) && isNum(c.limitDown) && isNum(c.up) && isNum(c.down) && isNum(c.counted)
    ? {
      limitUp: c.limitUp, limitDown: c.limitDown, up: c.up, down: c.down,
      flat: Math.max(0, c.counted - c.up - c.down), counted: c.counted, live: numOrNull(c.live),
    }
    : null;
  const lv = isObj(doc.level) ? doc.level : null;
  const tw = isObj(doc.twii) ? doc.twii : {};
  const otc = isObj(doc.otc) ? doc.otc : {};
  return {
    asOf: epochMs(doc.updatedAt),
    marketNow: typeof doc.marketNow === 'boolean' ? doc.marketNow : null,
    basis: doc.countsBasis === 'live' || doc.countsBasis === 'settled' ? doc.countsBasis : null,
    counts,
    level: lv && typeof lv.key === 'string'
      ? { key: lv.key, label: strOrNull(lv.label) ?? lv.key, luExp: posOrNull(lv.luExp), ldExp: posOrNull(lv.ldExp) }
      : null,
    twiiChg: numOrNull(tw.chg),
    value: posOrNull(tw.value),
    prevValue: posOrNull(tw.prevValue),
    valueVsPrevFullDay: posOrNull(tw.valueVsPrevFullDay),
    otcChg: numOrNull(otc.chg),
  };
}

/** marketPattern/latest.live → 今日盤型；不是今天的（盤前、非交易日殘留）回 null */
export function normalizePattern(doc, todayYmd) {
  const live = isObj(doc) && isObj(doc.live) ? doc.live : null;
  if (!live || typeof live.pattern !== 'string' || live.date !== todayYmd) return null;
  return { key: live.pattern, label: PATTERN_LABEL[live.pattern] ?? live.pattern, date: live.date, at: epochMs(live.at) };
}

/** system/ai-daemon → 心跳（只取時間與 active，不外露主機名、模型） */
export function normalizeHeartbeat(doc) {
  if (!isObj(doc)) return null;
  return { lastHeartbeat: epochMs(doc.lastHeartbeat), active: typeof doc.active === 'boolean' ? doc.active : null };
}

/** system/daemonHealth.hotLag → 快線揭示落後統計（每 5 分鐘一筆，但文件每小時才寫一次——呈現時要帶統計時間） */
export function normalizeHotLag(doc) {
  const h = isObj(doc) && isObj(doc.hotLag) ? doc.hotLag : null;
  if (!h) return null;
  return { at: epochMs(h.at), p50: numOrNull(h.p50), p90: numOrNull(h.p90), freshPct: numOrNull(h.freshPct) };
}

/** taifexPositions/latest → 外資台指淨未平倉（收盤後資料；date＝資料日 YYYYMMDD） */
export function normalizeTaifex(doc) {
  if (!isObj(doc)) return null;
  const date = typeof doc.date === 'string' && /^\d{8}$/.test(doc.date) ? doc.date : null;
  return {
    date,
    foreignTxfNetOI: numOrNull(doc.foreignTxfNetOI),
    putCallRatio: posOrNull(doc.putCallRatio),
    asOf: epochMs(doc.updatedAt),
  };
}

// ── 大盤危險（前端狀態機；連續 2 拍＝2 份不同 updatedAt 的 marketPulse） ────

/** 單拍條件：跌停 ≥10 且 ≥ 漲停×1.5 */
export function dangerMet(counts) {
  if (!counts || !isNum(counts.limitUp) || !isNum(counts.limitDown)) return false;
  return counts.limitDown >= DANGER_RULE.minLimitDown && counts.limitDown >= counts.limitUp * DANGER_RULE.ratio;
}

export function initialDangerState(ymd) {
  return { ymd, lastAsOf: 0, streak: 0, clearStreak: 0, active: false, seq: 0, lastFire: 0 };
}

/**
 * 推進一拍。beat＝{ asOf, counts }（asOf＝marketPulse.updatedAt）。
 * 回 { state, fired }：fired＝這一拍剛成立（要發一級事件）。同一份 asOf 重送不推進（重新整理、輪詢重複拿到同一份）。
 * 只在資料時間 09:10–13:25 判；其餘時段狀態凍結（收盤競價時不解除也不新發）。
 */
export function stepDanger(prev, beat) {
  const asOf = beat && isNum(beat.asOf) ? beat.asOf : null;
  if (asOf == null) return { state: prev, fired: false };
  const ymd = taipeiYmd(asOf);
  let s = prev && prev.ymd === ymd ? prev : initialDangerState(ymd);
  if (asOf <= s.lastAsOf) return { state: s, fired: false };
  const minute = taipeiMinuteOfDay(asOf);
  if (minute < DANGER_RULE.fromMinute || minute >= DANGER_RULE.untilMinute) {
    return { state: { ...s, lastAsOf: asOf }, fired: false };
  }
  const met = dangerMet(beat.counts);
  s = {
    ...s,
    lastAsOf: asOf,
    streak: met ? s.streak + 1 : 0,
    clearStreak: met ? 0 : s.clearStreak + 1,
  };
  if (!s.active && s.streak >= DANGER_RULE.beats && (!s.lastFire || asOf - s.lastFire >= DANGER_RULE.refireMs)) {
    return { state: { ...s, active: true, seq: s.seq + 1, lastFire: asOf }, fired: true };
  }
  if (s.active && s.clearStreak >= DANGER_RULE.clearBeats) return { state: { ...s, active: false }, fired: false };
  return { state: s, fired: false };
}

/** localStorage 讀回的危險狀態：形狀不對一律當沒有（不信任本機資料） */
export function parseDangerState(raw, ymd) {
  if (!isObj(raw) || raw.ymd !== ymd) return initialDangerState(ymd);
  const n = k => (isNum(raw[k]) && raw[k] >= 0 ? raw[k] : 0);
  return {
    ymd, lastAsOf: n('lastAsOf'), streak: n('streak'), clearStreak: n('clearStreak'),
    active: raw.active === true, seq: n('seq'), lastFire: n('lastFire'),
  };
}

// ── 持股與停損（AI 停損規範 stop-v1；暫算與 A1 同一支 warroom-mine.provisionalStop） ──────

/**
 * 逼近停損清單（價格在停損價或以下，或距停損 ≤2%——停損簿未上線、沒有 ATR14），依距離由近到遠。
 * prices：{ [code]: 距停損用的價 }（與 A1 同口徑：盤前＝昨收、收盤競價窗＝13:25 前最後成交）。沒有價的不列（不拿成本當現價）；
 * 成本可疑（現價÷成本 <0.25 或 >5）的不列（規範：該檔停損警示暫停）。
 * book：本機事件表（代號 → 這一版；棘輪的上一版，與 A1、Z2 同一份）；沒有就從成本線起算。
 */
export function nearStopList(holdings, prices, book = null) {
  const out = [];
  for (const p of aggregatePositions(holdings)) {
    const price = prices ? prices[p.code] : undefined;
    if (!(typeof price === 'number' && price > 0)) continue;
    const entry = isObj(book) && Object.prototype.hasOwnProperty.call(book, p.code) ? book[p.code] : null;
    const res = provisionalStop(p, price, 0, '', entry);
    if (res.stop == null || res.suspect) continue;
    const d = stopDistance(res.stop, price, null);
    if (!d || !(price <= res.stop || d.near)) continue;
    out.push({ code: p.code, name: p.name, distPct: +d.pct.toFixed(1) });
  }
  return out.sort((a, b) => a.distPct - b.distPct || a.code.localeCompare(b.code));
}

// ── daemon 個人警示 → 戰情事件 ───────────────────────────────────────────

/** 價格類一級警示暫停窗（試撮指示價）：08:30–09:00、13:25–13:30 */
export function isIndicativeMinute(minute) {
  return (minute >= M(8, 30) && minute < M(9, 0)) || (minute >= M(13, 25) && minute < M(13, 30));
}

/** daemon 警示類型 → 畫面文字（只寫事件，不寫個人停損價、成本、損益——隱私） */
export const DAEMON_ALERT_LABEL = Object.freeze({
  stop: '觸及停損', take: '觸及停利目標', trailing: '移動停利觸發', reentry: '停利後回檔',
  discipline: '停損觸發後未處理', exit: '爆量下殺', defense: '大盤急跌防禦檢查', anomaly: '盤中異常波動',
  daytrade: '當沖提醒', custom: '自訂提醒', catalyst: '事件日提醒', thesis: '持有理由檢查', buyzone: '進入買點區',
  exdiv: '除權息提醒', etfprem: 'ETF 溢折價', dca: '定期定額提醒', adr: 'ADR 提醒', forecast: '預測提醒',
  earlybird: '早盤機會（昨日策略榜）', opensell: '開盤賣出提醒', chipclear: '籌碼出清', chipsell: '籌碼賣壓', chipweak: '籌碼轉弱',
  finwarn: '財務警訊', rebound: '反彈出脫提醒', washout: '洗盤監測', rsiHot85: 'RSI5 高檔', rsiDual85: 'RSI5／RSI10 雙高',
  reversalUp: '反轉向上訊號', reversalDown: '出貨訊號',
});

/** daemon 停損類推播（推播停損與停損紀律）仍是舊算法——戰情停損改用規範 stop-v1，這兩類一律二級並標明，避免同頁兩種停損口徑 */
export const LEGACY_STOP_TYPES = Object.freeze(['stop', 'discipline']);
export const LEGACY_STOP_NOTE = '舊制推播（停損算法不同）';

/**
 * daemon 寫在 users/{uid}/data/alerts 的一筆 → 戰情事件輸入；不是 daemon 格式（使用者自設價警示定義）或不是今天的回 null。
 * 全部二級「我的」紀錄（B2）。一級「觸停損」改由前端依規範 stop-v1 判定（warroom-mine.stepStopEpisodes）；
 * daemon 的 type 'stop'／'discipline' 標「舊制推播（停損算法不同）」，落在試撮窗的另註明。
 */
export function eventFromDaemonAlert(a, todayYmd) {
  if (!isObj(a) || typeof a.type !== 'string' || typeof a.message !== 'string') return null;
  const at = epochMs(a.at);
  if (at == null || taipeiYmd(at) !== todayYmd) return null;
  const code = typeof a.code === 'string' && /^\d{4,6}$/.test(a.code) ? a.code : undefined;
  const who = code ? `${code} ${typeof a.name === 'string' ? a.name : ''}`.trim() : (typeof a.name === 'string' ? a.name : '');
  const label = DAEMON_ALERT_LABEL[a.type] ?? '個人警示';
  if (LEGACY_STOP_TYPES.includes(a.type)) {
    const paused = a.type === 'stop' && isIndicativeMinute(taipeiMinuteOfDay(at));
    return {
      id: `daemon:${a.type}:${code ?? ''}:${at}`, at, kind: 'mine', level: 2, code, mine: true,
      text: `${who} ${label}·${LEGACY_STOP_NOTE}${paused ? '·試撮時段（指示價可能不成交）' : ''}`.trim(),
    };
  }
  return { id: `daemon:${a.type}:${code ?? ''}:${at}`, at, kind: 'mine', level: 2, code, mine: true, text: `${who} ${label}`.trim() };
}

/** 一級事件的嚴重度排序鍵（小＝先）：大盤危險 → 觸停損 → 跌停排隊 → 開板 → 重大利空 → 其他 */
export const LEVEL1_ORDER = Object.freeze(['marketDanger', 'stopLoss', 'limitDownQueue', 'limitOpen', 'majorNegative']);
export function severityRank(kind) {
  const i = LEVEL1_ORDER.indexOf(kind);
  return i < 0 ? LEVEL1_ORDER.length : i;
}

/** 一級事件排序：嚴重度、再新到舊（不是單純依時間） */
export function sortLevel1(list) {
  return [...list].sort((a, b) => severityRank(a.kind) - severityRank(b.kind) || b.at - a.at);
}
