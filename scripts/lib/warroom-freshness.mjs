// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2「資料章」與每列價齡（純函式·唯一實作）
//
// 資料章顯示「資料本身的時間」（revealAt／asOf／at），不是抓取時間。六種狀態：
//   live ● 即時 hh:mm:ss · delayed ◐ 延遲 n 分 · stale ▲ 過期 n 分·重試中
//   closed ■ 收盤 hh:mm · prev ◆ 前交易日 mm/dd · preopen ○ 未開盤
// 門檻（BUILD-SPEC／critique H5 實測：快線揭示落後 P50≈24 秒、P90≈57 秒）：
//   quote 報價 120／300 秒 · index 指數 60／180 秒 · list 榜單 5／10 分 · sector 族群 8／15 分 · news 新聞判別 30／60 分
// 每列價齡：揭示 >120 秒空心點（aging）、>300 秒標「舊」（old）；沒有今日真成交標「無成交」（notrade，市場事實不是故障）。
// 「收盤」看資料時間 ≥13:30（揭示時間），不看牆上時鐘。
// 單元測試：node --test scripts/lib/warroom-freshness.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { taipeiMinuteOfDay, taipeiDayStart, WAR_NODES } from './warroom-session.mjs';

const TPE_OFFSET_MS = 8 * 3_600_000;
const pad2 = n => String(n).padStart(2, '0');

export const FRESH_THRESHOLDS = Object.freeze({
  quote: Object.freeze({ delayMs: 120_000, staleMs: 300_000 }),
  index: Object.freeze({ delayMs: 60_000, staleMs: 180_000 }),
  list: Object.freeze({ delayMs: 300_000, staleMs: 600_000 }),
  sector: Object.freeze({ delayMs: 480_000, staleMs: 900_000 }),
  news: Object.freeze({ delayMs: 1_800_000, staleMs: 3_600_000 }),
});

export const ROW_AGE = Object.freeze({ agingMs: 120_000, oldMs: 300_000 });

export const STAMP_GLYPH = Object.freeze({ live: '●', delayed: '◐', stale: '▲', closed: '■', prev: '◆', preopen: '○' });

/** 會持續輪詢的時段（資料章「重試中」只在這些時段出現） */
const POLLING = new Set(['pre', 'preclear', 'open', 'mid', 'tail', 'auction', 'closing']);
/** 盤中有成交才有意義的時段（每列價齡只在這些時段標示） */
const TRADING = new Set(['open', 'mid', 'tail', 'auction', 'closing']);

/** 台北 hh:mm:ss */
export function hhmmss(ms) {
  const d = new Date(ms + TPE_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
/** 台北 hh:mm */
export function hhmm(ms) {
  return hhmmss(ms).slice(0, 5);
}
/** 台北 mm/dd */
export function mmdd(ms) {
  const d = new Date(ms + TPE_OFFSET_MS);
  return `${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}`;
}

/** 秒或毫秒、ISO 字串、Firestore Timestamp（{seconds}/{_seconds}/toMillis）→ epoch ms；認不得回 null */
export function toEpochMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof v === 'object') {
    if (typeof v.toMillis === 'function') { const t = v.toMillis(); return Number.isFinite(t) ? t : null; }
    const s = typeof v.seconds === 'number' ? v.seconds : typeof v._seconds === 'number' ? v._seconds : null;
    return s != null ? s * 1000 : null;
  }
  return null;
}

/**
 * 資料章。
 * @param {{ kind: 'quote'|'index'|'list'|'sector'|'news', asOf: number|null, now: number, segment: string,
 *           openOnly?: boolean, liveLabel?: string }} input
 *   openOnly：只有開盤後才有意義的資料（家數、榜單、族群、報價）——盤前與清空窗一律「○ 未開盤」。
 *   liveLabel：即時狀態的字（預設「即時」；A1 用「揭示」）。
 */
export function stampOf({ kind, asOf, now, segment, openOnly = false, liveLabel = '即時' }) {
  const th = FRESH_THRESHOLDS[kind] ?? FRESH_THRESHOLDS.list;
  const polling = POLLING.has(segment);
  const mk = (state, text, ageMin = null) => ({ state, glyph: STAMP_GLYPH[state], text, ageMin });

  if (segment === 'preclear') return mk('preopen', '○ 未開盤');
  if (segment === 'pre' && openOnly) return mk('preopen', '○ 未開盤');
  if (asOf == null || !Number.isFinite(asOf) || asOf <= 0) {
    return mk('stale', polling ? '▲ 無資料·重試中' : '▲ 無資料');
  }
  if (taipeiDayStart(asOf) < taipeiDayStart(now)) return mk('prev', `◆ 前交易日 ${mmdd(asOf)}`);
  if (taipeiMinuteOfDay(asOf) >= WAR_NODES.closing) return mk('closed', `■ 收盤 ${hhmm(asOf)}`);
  if (segment === 'after' || segment === 'nontrading') return mk('closed', `■ 收盤前資料 ${hhmm(asOf)}`);

  const age = Math.max(0, now - asOf);
  const ageMin = Math.floor(age / 60_000);
  if (age > th.staleMs) return mk('stale', `▲ 過期 ${ageMin} 分${polling ? '·重試中' : ''}`, ageMin);
  if (age > th.delayMs) return mk('delayed', `◐ 延遲 ${ageMin} 分`, ageMin);
  return mk('live', `● ${liveLabel} ${hhmmss(asOf)}`, ageMin);
}

/**
 * 每列價齡（A1／抽屜用）。
 * @param {{ revealAt?: number|null, source?: string, volume?: number }} q
 * @returns {'fresh'|'aging'|'old'|'notrade'|'none'} none＝此時段不標（盤前、盤後、非交易日）
 */
export function rowAgeOf(q, now, segment) {
  if (!TRADING.has(segment)) return 'none';
  if (!q) return 'notrade';
  const live = q.source === 'mis_realtime';
  if (!live || q.revealAt == null || !(q.volume > 0)) return 'notrade';
  const age = now - q.revealAt;
  if (age > ROW_AGE.oldMs) return 'old';
  if (age > ROW_AGE.agingMs) return 'aging';
  return 'fresh';
}
