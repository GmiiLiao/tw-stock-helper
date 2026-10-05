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
/** 疑似臨時休市（整天沒有歸檔、之後已有歸檔）超過這麼多個交易日仍未被休市日曆確認 ⇒ 寫缺口（登錄 P1：不可有無聲缺日） */
export const SUSPECT_GRACE_TD = 5;
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
 *   suspected＝整天沒有歸檔、之後的交易日已有歸檔（疑似臨時休市；與缺口分開，日曆補上後自動剔除）；
 *     之後已過 SUSPECT_GRACE_TD 個交易日仍未被日曆確認為休市 ⇒ 改列 missed（寫缺口，P1 不可有無聲缺日）。
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
      const after = sorted.filter(x => x.date > d.date && x.date <= nowTw.slice(0, 10)).length;   // d 之後已經過去的交易日（日曆認定）
      if (after > SUSPECT_GRACE_TD && nowTw >= deadline) {
        plan.missed.push({ date: d.date, nextTD, deadline,
          reason: `整天沒有歸檔，之後 ${after} 個交易日都已歸檔、休市日曆仍未把它列為休市（超過 ${SUSPECT_GRACE_TD} 個交易日）⇒ 缺口（不可無聲缺日）` });
        continue;
      }
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
 * frozenDays：凍結日清單；hasScore(day, stage)；isReady(day)＝該日收盤＋法人兩市官方到齊（survey 的 basisOf.ready）。
 * 回傳 [{ day, stage, due, actionable }]：actionable＝due < today，或 due＝today 且當天資料已到齊——
 *   只有 actionable 的才觸發面板刷新與除權息補抓（07:05 那一輪 due＝今天、還沒收盤，不可為它抓「今天」的除權息）。
 */
export function pendingScores({ frozenDays, hasScore, cal, today, isReady = () => false }) {
  const out = [];
  for (const day of [...frozenDays].sort()) {
    let t;
    try { t = nextTradingDay(day, cal); } catch { continue; }
    for (const [stage, k] of SCORE_STAGES) {
      if (hasScore(day, stage)) continue;
      let due;
      try { due = nthTradingDayAfter(t, k, cal); } catch { break; }
      if (due <= today) out.push({ day, stage, due, actionable: due < today || !!isReady(due) });
      break;
    }
  }
  return out;
}

/** 這一輪要不要刷新共用面板（fetch_cache＋panel）：有要凍結的日子，或有「可處理」的到期評分而面板還沒那天（panelLast 不明＝要）。 */
export function tracksNeedData({ produce, pending, panelLast }) {
  if (produce.length > 0) return true;
  return pending.some(p => p.actionable !== false && (!panelLast || p.due > panelLast));
}

/** 除權息補抓的上限日：要凍結的日子與「可處理」的到期評分日（不含尚未收盤／未到齊的日子）。 */
export function tracksUptoDays({ produce, pending }) {
  return [...produce.map(p => p.date), ...pending.filter(p => p.actionable !== false).map(p => p.due)];
}

/**
 * 分軌步驟的告警（協調器寫 out/tracks_fwd/_alerts/LATEST.json，並把 error 級記成步驟失敗——a35 的狀態檔與後台管線頁看得到）。
 * status＝a37_tracks_fwd.py 寫的 tracks_fwd_status.json；exit＝子程序結束碼。凍結停擺的幾種原因（釘選檔被改、接線前證明不成立）
 * 若只寫在 wait 檔，期限一過就變成永不補產的缺口而沒人知道（審查 HIGH）——所以在期限前每一輪都告警。
 */
export function tracksAlerts(status, exit) {
  const out = [];
  if (!status || typeof status !== 'object') return [{ level: 'error', code: 'NO_STATUS', msg: '分軌程式沒有留下狀態檔（tracks_fwd_status.json）' }];
  if (status.skipped) return out;
  if (status.pins_ok === false) {
    const files = (status.pins_mismatches || []).map(m => m.file).join('、') || '不明';
    out.push({ level: 'error', code: 'PINS', msg: `釘選檔 sha256 與前向登錄不符（C7）：${files}——凍結停擺；改動釘選模組要先寫前向偏差＋PIN-UPDATE 列（登錄 implementation_pins）` });
  }
  if (status.prewire_gate && status.prewire_gate.ok === false) {
    out.push({ level: 'error', code: 'PREWIRE', msg: `接線前證明不成立，凍結停擺：${status.prewire_gate.why || '理由不明'}` });
  }
  const newGaps = [...(status.gaps || []).filter(g => g.result === 'written'), ...(status.frozen || []).filter(f => f.result === 'gap' && f.write === 'written')];
  if (newGaps.length) out.push({ level: 'error', code: 'GAP', msg: `新寫入缺口 ${newGaps.map(g => g.day).join('、')}（永不補產）` });
  const c6 = (status.frozen || []).filter(f => (f.unmet || []).includes('C6'));
  if (c6.length) out.push({ level: 'error', code: 'C6', msg: `分區 assertion 失敗：${c6.map(f => f.day).join('、')}` });
  if (exit !== 0 || (status.errors || []).length) out.push({ level: 'error', code: 'EXIT', msg: `分軌程式 exit ${exit}：${(status.errors || []).map(e => `${e.step} ${e.error}`).join('｜').slice(0, 400)}` });
  // 凍結時鏡像缺 s 當天的處置列（FDEV-007：DK_s 要 s 當天）：該市場 DK_s 整個記未知、寫一次就固定——鏡像落後告警只看到前一交易日，看不到這種
  const sMiss = (status.disp_s_missing || []).filter(x => x && Array.isArray(x.markets) && x.markets.length);
  if (sMiss.length) out.push({ level: 'error', code: 'DISP_S_MISSING', msg: `凍結時處置鏡像缺 s 當天：${sMiss.map(x => `${x.day}（${x.markets.join('、')}）`).join('、')}——該市場 DK_s 已記未知（DKNA，封印不改）；查 22:40 官方鏡像那輪` });
  if (status.disp_att_live?.any_lagging) {
    const lag = Object.entries(status.disp_att_live.datasets || {}).filter(([, v]) => v.lagging).map(([k, v]) => `${k}（最後 ${v.last ?? '無'}）`).join('、');
    out.push({ level: 'warn', code: 'DISP_ATT_LAG', msg: `處置／注意鏡像落後（應至少到 ${status.disp_att_live.expect_at_least}）：${lag}——DK_s／t 日起處置記未知` });
  }
  return out;
}
