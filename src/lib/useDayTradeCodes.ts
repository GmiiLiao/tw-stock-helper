'use client';

// ── 全站共用：當沖資格名單（一次抓取、模組級快取，供任何顯示個股的地方標注）──
//
// 狀態語意（與 daemon computeDayTradeEligible 及 chipArchive.dtOtcEligibleJson 一致）：
//   1 = 可現股當沖（先買後賣、先賣後買皆可）
//   2 = 暫停「現股賣出後現款買進」⇒ **只能先買後賣**
//   0 = 不在交易所名單內 ⇒ 不可現股當沖（處置股屬此類）
//
// ⚠ **`loaded` 這個旗標是安全關鍵，不可省略**：名單還沒回來時，
//   「查不到」和「不可當沖」在資料上長得一模一樣。若少了這道判斷，
//   API 慢一點或掛掉就會讓**全站每一檔股票**都顯示紅底「不可當沖」——
//   那是會讓使用者錯過交易的假警報，比沒有標示更糟。
//   ⇒ 未載入時一律回 null，呼叫端不得渲染任何標示。
import { useEffect, useState } from 'react';

export type DayTradeStatus = 0 | 1 | 2;

export type DayTradeInfo = {
  loaded: boolean;
  date: string;
  /** code → 1|2；不在表內即為 0（不可當沖），但**只有 loaded 時才成立** */
  codes: Map<string, DayTradeStatus>;
};

const empty = (): DayTradeInfo => ({ loaded: false, date: '', codes: new Map() });

// ── 快取與重試（WM-SCAN G3-02·2026-09-28）──────────────────────────
// 舊版把「第一次的結果」（含失敗/殘缺的空表）記成模組級 promise 整個頁面生命週期，
// 且成功後跨日永不刷新。現在：
//   • 只快取**成功且 ≥500 檔**的名單（_cache）；失敗/殘缺不快取，下次使用時再試，
//     但以指數退避（30 秒起、最長 10 分鐘）防止每次掛載都打。
//   • 快取名單的 date 早於今天（台北）⇒ 視為過期、下次使用時重抓；重抓期間與失敗時
//     仍沿用舊名單（loaded 不會因此掉回 false）。名單日期若一直沒前進（週末/假日/daemon
//     尚未寫入），每 10 分鐘最多重試一次。
//   • 重抓成功會廣播給所有掛載中的 hook，避免同頁新舊名單並存。
const FAIL_BACKOFF_BASE_MS = 30_000;
const FAIL_BACKOFF_MAX_MS = 10 * 60_000;
const STALE_RETRY_MS = 10 * 60_000;

let _cache: DayTradeInfo | null = null;
let _promise: Promise<DayTradeInfo> | null = null;   // 只代表「進行中」的請求，完成即清空
let _failCount = 0;
let _nextTryAt = 0;
const _listeners = new Set<(v: DayTradeInfo) => void>();

const taipeiYmd = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
/** 名單日期（YYYY-MM-DD 或 YYYYMMDD）早於今天（台北）⇒ 過期；缺日期也當過期 */
const isStale = (info: DayTradeInfo) => info.date.replace(/\D/g, '').slice(0, 8) < taipeiYmd();

function parse(d: { codesJson?: string; date?: unknown } | null): DayTradeInfo | null {
  const codes = new Map<string, DayTradeStatus>();
  let raw: Record<string, number> = {};
  try { raw = JSON.parse(d?.codesJson || '{}'); } catch { raw = {}; }
  for (const c in raw) codes.set(c, raw[c] === 2 ? 2 : 1);
  // 名單太小代表抓到殘缺的一份——寧可不標，也不要標錯（同 daemon 的兩市場閘門）
  if (codes.size < 500) return null;
  return { loaded: true, date: String(d?.date || ''), codes };
}

export function fetchDayTradeCodes(): Promise<DayTradeInfo> {
  if (_promise) return _promise;
  if (_cache && !isStale(_cache)) return Promise.resolve(_cache);
  if (Date.now() < _nextTryAt) return Promise.resolve(_cache || empty());
  _promise = fetch('/api/twse/daytrade-eligible', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(parse)
    .catch(() => null)
    .then(info => {
      _promise = null;
      if (info) {
        _cache = info;
        _failCount = 0;
        _nextTryAt = isStale(info) ? Date.now() + STALE_RETRY_MS : 0;
        for (const fn of _listeners) fn(info);
        return info;
      }
      _failCount++;
      _nextTryAt = Date.now() + Math.min(FAIL_BACKOFF_MAX_MS, FAIL_BACKOFF_BASE_MS * 2 ** (_failCount - 1));
      return _cache || empty();   // 失敗：有舊名單就沿用，沒有就維持未載入（呼叫端不標示）
    });
  return _promise;
}

export function useDayTradeCodes(): DayTradeInfo {
  const [v, setV] = useState<DayTradeInfo>(_cache || empty());
  useEffect(() => {
    let live = true;
    const on = (x: DayTradeInfo) => { if (live) setV(x); };
    _listeners.add(on);
    if (_cache) setV(_cache);
    if (!_cache || isStale(_cache)) fetchDayTradeCodes().then(on);
    return () => { live = false; _listeners.delete(on); };
  }, []);
  return v;
}

/** 單檔查詢。未載入回 null——呼叫端必須據此不渲染，不可當成「不可當沖」。 */
export function useDayTradeStatus(code: string): DayTradeStatus | null {
  const { loaded, codes } = useDayTradeCodes();
  if (!loaded || !code) return null;
  return codes.get(code) ?? 0;
}

/** 列表用：拿整份表自己查，避免每一列都呼叫一次 hook（違反 Rules of Hooks）。 */
export function statusOf(info: DayTradeInfo, code: string): DayTradeStatus | null {
  if (!info.loaded || !code) return null;
  return info.codes.get(code) ?? 0;
}

// ── 顯示用常數：全站只有這一份，改配色改這裡 ──────────────────────
// ⚠ 「可當沖」刻意**不用綠色**：台股慣例綠=跌，用綠色標可當沖會與價格顏色打架。
//   改用中性藍，且透明度壓到最低——它佔 83%，不該搶版面。
export const DT_STYLE: Record<DayTradeStatus, { label: string; short: string; bg: string; fg: string; border: string; title: string }> = {
  1: {
    label: '✓ 可當沖', short: '✓',
    bg: 'rgba(56,189,248,0.10)', fg: '#38bdf8', border: 'rgba(56,189,248,0.30)',
    title: '在交易所「當日沖銷交易標的」名單內，可現股當沖（先買後賣、先賣後買皆可）。仍須本人已簽署風險預告書並具當沖資格。',
  },
  2: {
    label: '⚠ 僅先買後賣', short: '⚠',
    bg: 'rgba(245,158,11,0.16)', fg: '#f59e0b', border: 'rgba(245,158,11,0.38)',
    title: '交易所標註「暫停現股賣出後現款買進」——只能先買後賣，不可先賣後買（不可放空當沖）。',
  },
  0: {
    label: '🚫 不可當沖', short: '🚫',
    bg: 'rgba(239,68,68,0.16)', fg: '#ef4444', border: 'rgba(239,68,68,0.38)',
    title: '不在交易所「當日沖銷交易標的」名單內，不可現股當沖。處置股即屬此類。當沖下單會被券商拒絕或構成違規。',
  },
};
