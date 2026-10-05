// ── T1 分軌前向影子（登錄 T1-TRACKS-FWD-2026-10-05）每日流程的決策邏輯（純函式，不碰 I/O）──────────────────
// 協調器 scripts/surge-lab/a35_shadow_daily.mjs 在 a35 名單＋發佈之後跑分軌步驟；這裡決定：哪一天要凍結 core、哪一天已錯過（寫缺口）、
// 哪些評分到期、這一輪要不要刷新面板。與 a35 的 planDays 同一套日曆規則（surge-shadow-daily.mjs），差別：
//   · 不需要站上 pred 定版（canonicalAt），也不需要資券／借券／當沖（四份代理清單不吃模型輸入）；
//   · 要官方漲停價鏡像：上市 TWT84U(D) 與上櫃 dailyQuotes(D 的前一交易日) 在鏡像 manifest 是 status＝ok、echo＝鍵、final≠false；
//   · 期限＝下一交易日 09:00（登錄 freeze.timing；python 端另有同一條時鐘閘）；
//   · 收盤要兩市官方到齊且沒有第三方（Yahoo）補洞（登錄 C1）；
//   · 起算日 startDay 來自 tracks/forward_config.json（總開關；磁碟即部署，預設停用）。
// 影子模式：不取代、不修改站上預測。非投資建議。
import { nextTradingDay, isTradingDay, addDaysIso } from './surge-shadow-daily.mjs';

export const TRACKS_DEADLINE_HHMM = '09:00';
export const TRACKS_OUT_DIR = 'tracks_fwd';
export const TRACKS_CORE_RE = /^tracks_fwd_(\d{4}-\d{2}-\d{2})\.json$/;
export const TRACKS_GAP_RE = /^tracks_fwd_gap_(\d{4}-\d{2}-\d{2})\.json$/;
export const TRACKS_SCORE_RE = /^tracks_fwd_score_(\d{4}-\d{2}-\d{2})_(y|c5|c10)\.json$/;
/** 評分期數與到期日：y＝t 之後第 1 個交易日（t＋1）、c5＝t＋4、c10＝t＋9（t＝決策日的下一交易日） */
export const SCORE_STAGES = [['y', 1], ['c5', 4], ['c10', 9]];
export const MIRROR_LIMIT_DATASETS = { twse: 'www.twse.com.tw/twse_twt84u', tpex: 'www.tpex.org.tw/tpex_dailyquotes' };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 總開關：enabled 必須是 true 且 startDay 是 YYYY-MM-DD 才算啟用；讀不到就停用（不猜）。 */
export function parseForwardConfig(obj) {
  if (!obj || typeof obj !== 'object') return { enabled: false, startDay: null, error: '讀不到 tracks/forward_config.json（視為停用）' };
  const startDay = DAY_RE.test(String(obj.startDay || '')) ? obj.startDay : null;
  const enabled = obj.enabled === true && !!startDay;
  return { enabled, startDay, error: obj.enabled === true && !startDay ? 'enabled＝true 但 startDay 不是 YYYY-MM-DD（視為停用）' : null };
}

/** iso 之前最近的交易日（往回最多 31 天；只用來找「前一面板日」，過去的日子不檢查日曆涵蓋年份） */
export function prevTradingDay(iso, cal) {
  let d = iso;
  for (let i = 0; i < 31; i++) {
    d = addDaysIso(d, -1);
    if (isTradingDay(d, cal)) return d;
  }
  throw new Error(`${iso} 之前 31 天內找不到交易日（日曆異常）`);
}

/** 鏡像 manifest 的一列是否可用（與 a37_tracks_sync.accept_row 同一條：ok、回聲＝鍵、未標 final＝false） */
export const mirrorRowOk = (row, key) => !!row && row.status === 'ok' && row.echo === key && row.final !== false;

/** 官方漲停價鏡像就緒：上市 TWT84U(D)、上櫃 dailyQuotes(前一交易日)。rows＝{ twse: manifest.rows, tpex: manifest.rows } */
export function mirrorLimitStatus(rows, day, prevDay) {
  const missing = [];
  if (!mirrorRowOk(rows?.twse?.[day], day)) missing.push(`上市 TWT84U(${day})`);
  if (!prevDay || !mirrorRowOk(rows?.tpex?.[prevDay], prevDay)) missing.push(`上櫃 dailyQuotes(${prevDay ?? '前一交易日'})`);
  return { ok: missing.length === 0, missing };
}

/**
 * 每個候選決策日的處置（升冪）：
 *   done＝已有 core 凍結檔或缺口記錄（只寫一次，不重產）；
 *   produce＝期限（下一交易日 09:00）前、收盤＋法人兩市官方到齊且無第三方補洞、官方漲停價鏡像就緒；
 *   missed＝已過期限仍沒有凍結檔 ⇒ 寫缺口（理由盡量具體）；
 *   waiting＝期限前條件未齊，或整天沒有歸檔、之後也還沒有歸檔（可能臨時休市）；
 *   suspected＝整天沒有歸檔、之後的交易日已有歸檔（疑似臨時休市；與缺口分開，日曆補上後自動剔除）。
 * days：[{ date, found(true|false|null＝不知道), ready, missing, nonOfficialOtcClose }]——start～今天的每個交易日。
 * mirrorOf(date) → { ok, missing }；blocks＝preflight 擋下的時刻（台北 'YYYY-MM-DDTHH:MM'）。
 */
export function tracksPlan({ days, cal, nowTw, start, hasCore, hasGap, mirrorOf, blocks = [] }) {
  const plan = { produce: [], missed: [], waiting: [], done: [], suspected: [], errors: [] };
  if (!start || !DAY_RE.test(start)) return plan;
  const sorted = [...days].filter(d => DAY_RE.test(d?.date || '')).sort((a, b) => a.date.localeCompare(b.date));
  const laterArchive = date => sorted.some(x => x.date > date && x.found === true);
  for (const d of sorted) {
    if (d.date < start) continue;
    if (hasCore(d.date) || hasGap(d.date)) { plan.done.push(d.date); continue; }
    let nextTD;
    try { nextTD = nextTradingDay(d.date, cal); } catch (e) { plan.errors.push({ date: d.date, error: String(e.message || e) }); continue; }
    const deadline = `${nextTD}T${TRACKS_DEADLINE_HHMM}`;
    if (d.found === false && laterArchive(d.date)) {
      plan.suspected.push({ date: d.date, reason: '整天沒有歸檔、之後的交易日已有歸檔：疑似臨時休市或整日未歸檔，待休市日曆確認' });
      continue;
    }
    const closeOk = d.found === true && d.ready === true && d.nonOfficialOtcClose !== true;
    const m = mirrorOf(d.date) || { ok: false, missing: ['鏡像狀態讀不到'] };
    if (nowTw >= deadline) {
      if (d.found === false) { plan.waiting.push({ date: d.date, nextTD, deadline, why: '整天沒有歸檔（可能是臨時休市）：待之後交易日歸檔或休市日曆確認' }); continue; }
      const blocked = blocks.filter(b => b > `${d.date}T13:30` && b < deadline);
      const reason = d.found !== true ? '期限前未凍結（歸檔狀態不明：協調器未執行或超出回看範圍）'
        : !d.ready ? `收盤歸檔未到齊（${(d.missing || []).join('、') || '未知'}）`
        : d.nonOfficialOtcClose === true ? '收盤含第三方（Yahoo）補洞，不符登錄 C1'
        : !m.ok ? `官方漲停價鏡像未到（${m.missing.join('、')}）`
        : blocked.length ? `期限前未凍結：研究程序占用共用快取（preflight 擋下 ${blocked.length} 輪，最後 ${blocked.at(-1)}）`
        : '期限前未凍結（協調器未執行或失敗；未齊條件見 wait 記錄）';
      plan.missed.push({ date: d.date, nextTD, deadline, reason });
      continue;
    }
    if (closeOk && m.ok) plan.produce.push({ date: d.date, nextTD, deadline });
    else plan.waiting.push({ date: d.date, nextTD, deadline,
      why: d.found !== true ? '收盤歸檔不存在或狀態不明' : !d.ready ? `收盤歸檔未到齊：${(d.missing || []).join('、')}`
        : d.nonOfficialOtcClose === true ? '收盤含第三方補洞（不凍結；期限前官方補齊才凍結）' : `官方漲停價鏡像未到：${m.missing.join('、')}` });
  }
  return plan;
}

/** n 個交易日之後（依日曆；未涵蓋年份丟錯） */
export function nthTradingDayAfter(iso, n, cal) {
  let d = iso;
  for (let i = 0; i < n; i++) d = nextTradingDay(d, cal);
  return d;
}

/**
 * 待評分：每個凍結日依序 y → c5 → c10，取第一個還沒有評分檔的期數；到期日 ≤ today 才算「到期待評」。
 * frozenDays：凍結日清單；hasScore(day, stage)；回傳 [{ day, stage, due }]。
 */
export function pendingScores({ frozenDays, hasScore, cal, today }) {
  const out = [];
  for (const day of [...frozenDays].sort()) {
    let t;
    try { t = nextTradingDay(day, cal); } catch { continue; }
    for (const [stage, k] of SCORE_STAGES) {
      if (hasScore(day, stage)) continue;
      let due;
      try { due = nthTradingDayAfter(t, k, cal); } catch { break; }
      if (due <= today) out.push({ day, stage, due });
      break;
    }
  }
  return out;
}

/** 這一輪要不要刷新共用面板（fetch_cache＋panel）：有要凍結的日子，或有到期評分的日子還不在上一輪的面板裡（panelLast 不明＝要）。 */
export function tracksNeedData({ produce, pending, panelLast }) {
  if (produce.length > 0) return true;
  return pending.some(p => !panelLast || p.due > panelLast);
}
