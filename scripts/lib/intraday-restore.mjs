// ─────────────────────────────────────────────────────────────────────────────
// 重啟接回今日分時序列（marketIntraday/latest → daemon 記憶體 _intraday）——2026-10-03
//   _intraday 是純記憶體；重啟後第一次 writeIntraday 會用重啟後的稀疏序列整份覆蓋 Firestore，
//   即時走勢失去重啟前的全部資料（10-02 15:51/15:53/16:07 三次重啟後文件只剩 31 檔／682 點），早盤回補每輪只救一檔。
//   mergeRestoredIntraday：純合併（只收今日、逐檔逐點聯集、永不變少）；createIntradayRestorer：重試／放棄的閘門（讀文件由 daemon 注入）。
// ─────────────────────────────────────────────────────────────────────────────

/** 每檔最多保留的點數（recordIntraday 同一上限：全日 270 分＋早盤回補＋收盤後掃描，留餘裕） */
export const INTRADAY_MAX_PTS = 400;

const DAY_SEC = 86_400;
/** 台北日 YYYY-MM-DD 的 epoch 秒區間 [start, end)（台灣無日光節約，固定 +08:00） */
const taipeiDayBounds = isoDay => { const start = Date.parse(`${isoDay}T00:00:00+08:00`) / 1000; return [start, start + DAY_SEC]; };
const isValidPt = (p, lo, hi) => Array.isArray(p) && Number.isFinite(p[0]) && p[0] >= lo && p[0] < hi && Number.isFinite(p[1]) && p[1] > 0;
const validPrev = v => (Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * 把 readIntradayDoc 讀回的今日序列併進記憶體狀態。不改動傳入物件、回傳新狀態物件；
 * 未被文件動到的檔沿用原物件（呼叫端整份替換 _intraday，不會兩份並存）。
 * - 文件不是今天 → 不還原（other-day）；沒有文件 → none；今天但序列解不出（分片代不一致等）→ no-series，交由呼叫端重試
 * - 記憶體若是別天的（尚未被 recordIntraday 換日）比照換日重置
 * - 同一檔逐點聯集：同一秒以記憶體（現行程序）為準；依時間排序；超過上限保留最新的點（與 recordIntraday 同規則）
 * - 文件的點只收「今日、價 > 0」的合法點；記憶體的點一律保留 ⇒ 永不變少
 * @param {{ date: string, series: Record<string, { prev?: number, pts: number[][] }> }} current
 * @param {{ date: string, series: object | null } | null} restored
 * @param {string} today 台北日期 YYYY-MM-DD
 * @returns {{ state: typeof current, codes: number, points: number, skipped?: 'none' | 'other-day' | 'no-series' }}
 */
export function mergeRestoredIntraday(current, restored, today, cap = INTRADAY_MAX_PTS) {
  if (!restored) return { state: current, codes: 0, points: 0, skipped: 'none' };
  if (restored.date !== today) return { state: current, codes: 0, points: 0, skipped: 'other-day' };
  const src = restored.series;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return { state: current, codes: 0, points: 0, skipped: 'no-series' };

  const base = current?.date === today ? current.series : {};
  const out = new Map(Object.entries(base));   // Map 建表：文件裡的 __proto__ 之類鍵不會動到原型
  const [lo, hi] = taipeiDayBounds(today);
  let codes = 0, points = 0;
  for (const [code, r] of Object.entries(src)) {
    const pts = Array.isArray(r?.pts) ? r.pts.filter(p => isValidPt(p, lo, hi)) : [];
    if (!pts.length) continue;
    const cur = out.get(code);
    const byTs = new Map(pts.map(p => [p[0], [p[0], p[1], Number.isFinite(p[2]) ? p[2] : 0]]));
    const before = cur?.pts?.length || 0;
    for (const p of cur?.pts || []) byTs.set(p[0], p);   // 同秒以記憶體為準
    const merged = [...byTs.values()].sort((a, b) => a[0] - b[0]);
    const kept = merged.length > cap ? merged.slice(merged.length - cap) : merged;
    const prev = validPrev(cur?.prev) ?? validPrev(r.prev);
    out.set(code, prev === undefined ? { pts: kept } : { prev, pts: kept });
    if (kept.length > before) { codes++; points += kept.length - before; }
  }
  return { state: { date: today, series: Object.fromEntries(out) }, codes, points };
}

const SKIP_TEXT = { none: '沒有文件', 'other-day': '文件不是今天的' };

/**
 * 開機還原控制器（每個程序一個）：第一次呼叫讀文件併回記憶體；讀取／解碼丟例外或今日序列解不出（no-series）時
 * 回 false（呼叫端本輪不回補、不寫入），下一次再試；連續 maxTries 次失敗才放棄、回 true（照常寫入）。
 * 一旦回 true 之後都直接回 true、不再讀文件。記憶體狀態在讀完文件之後才取（讀取期間的變動不會被蓋掉）。
 * @param {{ readDoc: () => Promise<object|null>, getState: () => object, setState: (s: object) => void,
 *           log?: (msg: string) => void, maxTries?: number }} deps
 * @returns {(today: string) => Promise<boolean>} settled：true＝可以回補與寫入
 */
export function createIntradayRestorer({ readDoc, getState, setState, log = () => {}, maxTries = 3 }) {
  let settled = false, tries = 0;
  return async function restore(today) {
    if (settled) return true;
    try {
      const doc = await readDoc();
      const r = mergeRestoredIntraday(getState(), doc, today);
      if (r.skipped === 'no-series') throw new Error('今日文件序列解不出（分片代不一致或缺欄位）');
      setState(r.state);
      settled = true;
      log(r.codes ? `✓ 還原今日分時序列 ${r.codes} 檔／${r.points} 點（重啟不再以殘缺版覆蓋）` : `· 分時序列無今日資料可還原（${SKIP_TEXT[r.skipped] || '今日文件沒有點'}）`);
    } catch (e) {
      tries++;
      settled = tries >= maxTries;
      log(`${settled ? '⚠ 放棄還原今日分時序列，照常寫入' : '✖ 還原今日分時序列失敗，本輪不回補、不寫入'}（第 ${tries} 次）：${String(e?.message || e).slice(0, 120)}`);
    }
    return settled;
  };
}
