// ─────────────────────────────────────────────────────────────────────────
// 全站付費會員「持股＋自選」聯集（daemon resolveWatchCodes 用；2026-10-05·盤中戰情 v2 規畫 critique H4）
//
// 這份聯集是 5 秒快線優先集（buildPriorityCodes）、自建分時序列（getTrackedCodes）、持股池異動警示、
// 新聞 wiki 的共同來源，取前 WATCH_CODES_CAP 檔。
// 舊版逐一會員「先自選、後持股」插入同一個 Map 再取前 40 ⇒ 自選一多，最先被擠出快線的是持股
//   （持股才是盤中最需要即時價的：觸停損推播、戰情「我的部位」都靠它）。
// 現在：先放所有會員的持股，再放自選；其餘不變（同代號只占一格、上限仍 40、會員順序不變）。
// 名稱：同代號取第一個非空名稱（舊版後寫覆蓋，空名稱可能蓋掉有名稱的）。
// ─────────────────────────────────────────────────────────────────────────

export const WATCH_CODES_CAP = 40;

/**
 * @param {Array<{ holdings?: unknown, watchlist?: unknown }>} perUser 依會員順序，各自的 holdings／watchlist 陣列（項目 {code, name}）
 * @param {number} [cap]
 * @returns {Array<[string, string]>} [代號, 名稱]，持股在前
 */
export function mergeWatchCodes(perUser, cap = WATCH_CODES_CAP) {
  const users = Array.isArray(perUser) ? perUser : [];
  const wanted = new Map();
  const add = (it) => {
    const code = it?.code;
    if (!code) return;
    const name = it.name || '';
    if (!wanted.has(code) || (!wanted.get(code) && name)) wanted.set(code, name);
  };
  const listOf = (v) => (Array.isArray(v) ? v : []);
  for (const u of users) for (const h of listOf(u?.holdings)) add(h);
  for (const u of users) for (const w of listOf(u?.watchlist)) add(w);
  return [...wanted.entries()].slice(0, Math.max(0, cap));
}
