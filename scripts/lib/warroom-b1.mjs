// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2 · B1「盤中機會榜」伺服器端組裝的純函式（src/lib/warroom/build-b1.ts 呼叫；唯一實作）
//
// 做多：intradayRadar/latest（daemon computeIntradayRadar，每 60–90 秒）8 個策略合併去重。
//   命中＝出現在該策略的 groups（每策略前 10）；排序＝命中數多者優先、再依量比（與舊版戰情雷達同口徑）。
//   回傳前 40 檔：先保證每個策略至少前 5 名在內（策略下拉單選時不會整個消失），其餘依排序補滿。
// 做空：marketSnapshot/latest（已疊 5 秒快線 hot）→ 與 /api/twse/market-snapshot 同一轉換 → fade-patterns 轉空型態。
//   只列「可先賣當沖」（dayTradeEligible 狀態 1）、A／B 級；12:00 後成立者依 fade-patterns 降級（回放為負）不列。
//   ⚠ 為何不直接呼叫 fade-patterns.ts 的 classifyFade：它 import 的 statusOf 來自 'use client' 模組，
//     在伺服器端（app route 的 rsc 層）會被換成 client reference，一呼叫就丟錯。型態規則本身（FADE_PATTERNS）
//     由 build-b1.ts 從 fade-patterns 傳進來（同一份）；這裡只複寫外層流程與「不建議放空」三條規則，
//     並由 warroom-b1.test.mjs 逐字比對 fade-patterns.ts 與 market-snapshot route 的對應原文（漂移即紅）。
// 資料日用來源自報：雷達文件的 date、快照的 dataDate（daemon boardDataDate；build-b1.ts 讀出——sweepAt 只是寫入時刻，
// 盤外也每 5 分鐘重寫，不可當資料日）。不捏造：缺值一律 null。
// 單元測試：node --test scripts/lib/warroom-b1.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { RADAR_STRAT_ORDER, sortHits } from './warroom-b1-view.mjs';
import { limitPrices } from './daytrade-signals.mjs';
import { taipeiMinuteOfDay } from './warroom-session.mjs';

export const LONG_LIMIT = 40;
export const SHORT_LIMIT = 20;
export const PER_STRAT_MIN = 5;
/** 當沖名單少於此數＝殘缺（與前端 useDayTradeCodes 的 parse 同門檻） */
export const DT_MIN_CODES = 500;

const CODE4 = /^\d{4}$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, d) => (v == null ? null : +v.toFixed(d));
const clamp01 = v => (v == null ? null : Math.min(1, Math.max(0, v)));
const marketOf = m => (m === 'tse' || m === 'otc' ? m : null);

/** 漲跌停判定（daytrade-signals.limitPrices：依檔位向內取整）；只在 |漲跌| ≥ 9% 時才算，避免由漲跌% 反推昨收的捨入誤判 */
export function limitOf(price, prevClose) {
  if (!(price > 0) || !(prevClose > 0)) return null;
  const chg = (price / prevClose - 1) * 100;
  if (Math.abs(chg) < 9) return null;
  const { up, down } = limitPrices(prevClose);
  if (price >= up - 1e-6) return 'up';
  if (price <= down + 1e-6) return 'down';
  return null;
}

/** 毫秒或秒的時戳 → ms；認不得回 null */
function toMs(v) {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

// ── 做多：雷達合併 ────────────────────────────────────────────────────────────

/** 雷達單筆 → 精簡列（不含 hits）；代號不是 4 碼或價格無效回 null */
export function toLongRow(it) {
  if (!it || typeof it !== 'object') return null;
  const code = String(it.code ?? '');
  if (!CODE4.test(code)) return null;
  const price = num(it.price);
  if (!(price > 0)) return null;
  const chg = num(it.chg);
  const prev = chg != null && chg > -100 ? price / (1 + chg / 100) : null;
  return {
    code,
    name: typeof it.name === 'string' ? it.name.trim() : '',
    market: marketOf(it.market),
    price,
    chg,
    volX: num(it.volX),
    pos: clamp01(num(it.pos)),
    gap: num(it.gap),
    firstSeen: toMs(it.firstSeen),
    limit: prev != null ? limitOf(price, prev) : null,
  };
}

function cmpLong(a, b) {
  return b.hits.length - a.hits.length
    || (b.volX ?? -Infinity) - (a.volX ?? -Infinity)
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}

/**
 * intradayRadar/latest → { dataDate, rows（≤limit）, total（合併去重後總檔數） }
 * @param {object|null} doc
 */
export function mergeRadar(doc, { limit = LONG_LIMIT, perStrat = PER_STRAT_MIN } = {}) {
  const groups = doc && typeof doc.groups === 'object' && doc.groups ? doc.groups : {};
  const byCode = new Map();
  const groupCodes = new Map();
  for (const k of RADAR_STRAT_ORDER) {
    const list = Array.isArray(groups[k]) ? groups[k] : [];
    const codes = [];
    for (const it of list) {
      const row = toLongRow(it);
      if (!row) continue;
      const cur = byCode.get(row.code);
      if (!cur) byCode.set(row.code, { ...row, hits: [k] });
      else if (!cur.hits.includes(k)) byCode.set(row.code, { ...cur, hits: [...cur.hits, k] });
      if (!codes.includes(row.code)) codes.push(row.code);
    }
    groupCodes.set(k, codes);
  }
  const all = [...byCode.values()].sort(cmpLong).map(r => ({ ...r, hits: sortHits(r.hits) }));
  const keep = new Set();
  for (const k of RADAR_STRAT_ORDER) for (const c of groupCodes.get(k).slice(0, perStrat)) keep.add(c);
  for (const r of all) {
    if (keep.size >= limit) break;
    keep.add(r.code);
  }
  const rows = all.filter(r => keep.has(r.code)).slice(0, limit);
  const dataDate = typeof doc?.date === 'string' && YMD.test(doc.date) ? doc.date : null;
  return { dataDate, rows, total: all.length };
}

// ── 做空：快照 → 轉空型態 ────────────────────────────────────────────────────

/** dayTradeEligible/latest → Map(code → 1|2)；殘缺（<500 檔）或解析失敗回 null（呼叫端不列做空：寧缺勿錯） */
export function parseDtCodes(doc) {
  let raw;
  try { raw = JSON.parse(doc?.codesJson || '{}'); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const out = new Map();
  for (const c in raw) out.set(c, raw[c] === 2 ? 2 : 1);
  return out.size >= DT_MIN_CODES ? out : null;
}

/** volAvg20/latest → { code: 20 日均量(張) }；缺或壞回 {}（量比顯示「—」，與 market-snapshot route 同） */
export function parseAvg20(doc) {
  try {
    const o = JSON.parse(doc?.avgJson || '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** fade-patterns sessionClock 的可測版本：時間取請求的 now（不是 new Date()）；非盤中 hm=999、frac=1（時間規則不套用） */
export function fadeClockAt(nowMs, marketOpen) {
  if (!marketOpen) return { hm: 999, frac: 1 };
  const hm = Math.floor(taipeiMinuteOfDay(nowMs));
  return { hm, frac: Math.min(1, Math.max(0.05, (hm - 540) / 270)) };
}

/** 快照 → FadeSnap[]（與 /api/twse/market-snapshot 的轉換逐行同口徑：4 碼、價>0、掃描期間只收真即時、量比四捨五入 1 位） */
export function snapToFadeSnaps(snap, avg20 = {}) {
  const q = snap && typeof snap.quotes === 'object' && snap.quotes ? snap.quotes : {};
  const marketOpen = !!snap?.marketOpen;
  const sweeping = snap?.sweeping ?? marketOpen;
  const out = [];
  for (const code in q) {
    if (!CODE4.test(code)) continue;
    const x = q[code];
    if (!x || !(Number(x.price) > 0)) continue;
    if (sweeping && !x.live) continue;
    const a = avg20[code] || 0;
    const volX = a > 0 ? +(((x.volume ?? 0) / 1000) / a).toFixed(1) : null;
    out.push({
      code, name: (x.name || '').trim(), price: x.price, change: x.change ?? 0,
      changePercent: x.changePercent ?? 0, volume: x.volume ?? 0, volX,
      market: x.market || 'tse', open: x.open ?? 0, high: x.high ?? 0, low: x.low ?? 0,
      vwap: x.vwap ?? null,
    });
  }
  return out;
}

/** fade-patterns.ts 的 TIER_RANK（逐字比對見測試） */
export const TIER_RANK = Object.freeze({ A: 0, B: 1, C: 2, X: 3 });

/** fade-patterns.ts 的 AVOID（不建議放空）三條——該檔未匯出，這裡同口徑複寫（逐字比對見測試） */
export const FADE_AVOID = Object.freeze([
  { key: 'flipped', test: m => m.hiUp >= 3 && m.chg < 0 },
  { key: 'openFall', test: m => m.openUp >= 2 && m.openFall >= 2 },
  { key: 'lowPace', test: m => m.hiUp >= 5 && m.give >= 4 && m.pace < 2 && m.hiUp < 9.4 },
]);

/** fade-patterns classifyFade 的同口徑指標 */
export function fadeMetrics(s, { hm, frac }) {
  const prev = s.price - s.change;
  const vwap = s.vwap && s.vwap > 0 ? s.vwap : null;
  const volX = s.volX ?? 0;
  return {
    hiUp: (s.high / prev - 1) * 100, give: (s.high - s.price) / prev * 100, chg: s.changePercent,
    openUp: s.open > 0 ? (s.open / prev - 1) * 100 : 0, openFall: s.open > 0 ? (s.open - s.price) / s.open * 100 : 0,
    volX, pace: volX / frac, aboveVwap: vwap ? s.price > vwap : null, hm,
  };
}

function toShortRow({ s, m, main, also, tier }) {
  const prev = s.price - s.change;
  const range = s.high - s.low;
  return {
    code: s.code,
    name: s.name,
    market: marketOf(s.market),
    price: s.price,
    chg: round(num(s.changePercent), 2),
    /** 量比＝今日量比÷已過時段比例（線性估計；fade-patterns 的 pace）；沒有 20 日均量時 null */
    volX: s.volX == null ? null : round(m.pace, 1),
    pos: s.high > 0 && s.low > 0 && range > 0 ? round(clamp01((s.price - s.low) / range), 2) : null,
    gap: s.open > 0 ? round(m.openUp, 2) : null,
    tier,
    pattern: main.key,
    also: also.map(p => p.key),
    give: round(m.give, 2),
    hiUp: round(m.hiUp, 2),
    aboveVwap: m.aboveVwap,
    limit: limitOf(s.price, prev),
  };
}

/**
 * 轉空 A／B 級（fade-patterns classifyFade 同口徑；只收可先賣當沖＝狀態 1）。
 * @param {object[]} snaps FadeSnap[]
 * @param {{ hm: number, frac: number, marketOpen: boolean, dtStatus: (code: string) => 0|1|2, patterns: object[], limit?: number }} ctx
 *   patterns＝fade-patterns 的 FADE_PATTERNS（由 build-b1.ts 傳入，唯一實作）
 * @returns {{ rows: object[], total: number, demoted: number, noonDemote: boolean }}
 */
export function classifyShortRows(snaps, { hm, frac, marketOpen, dtStatus, patterns, limit = SHORT_LIMIT }) {
  const noonDemote = !!marketOpen && hm >= 720;
  const picked = [];
  let demoted = 0;
  for (const s of snaps || []) {
    if (!CODE4.test(s.code) || s.code.startsWith('00')) continue;
    const prev = s.price - s.change;
    if (!(prev > 10) || !(s.high > 0) || !(s.price > 0)) continue;
    if ((s.volume || 0) / 1000 < 500) continue;   // 與回測同一流動性門檻
    const m = fadeMetrics(s, { hm, frac });
    if (m.hiUp < 3) continue;
    if (dtStatus(s.code) !== 1) continue;           // 只列可先賣當沖
    const bad = FADE_AVOID.find(a => a.test(m));
    const hits = patterns.filter(p => p.test(m));
    if (bad && !(hits[0] && hits[0].tier === 'A' && hits[0].key.startsWith('lu'))) continue;
    if (!hits.length) continue;
    const main = hits[0];
    const tier = noonDemote ? 'X' : main.tier;
    if (TIER_RANK[tier] > TIER_RANK.B) {
      if (noonDemote && TIER_RANK[main.tier] <= TIER_RANK.B) demoted += 1;
      continue;
    }
    picked.push({ s, m, main, also: hits.slice(1), tier });
  }
  picked.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.m.give - a.m.give);
  return { rows: picked.slice(0, limit).map(toShortRow), total: picked.length, demoted, noonDemote };
}
