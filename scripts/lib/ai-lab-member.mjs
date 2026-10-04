// ─────────────────────────────────────────────────────────────────────────────
// AI 實驗·會員設定（2026-10-01 使用者：開放高級會員、先開放波段）
//   會員可設 ①投入資金 ②獲利期間 ③獲利成長目標
//   （當晚使用者：取消「當沖額度」設定項，改為獲利期間下拉 5／10／20／60／120／240 日；lib 仍保留當沖額度驗證，API 不再提供）
//   · 投入資金：變更＝加碼（入金）／提領——寫成資金異動 flows[{date, amount, at}]，帳戶延續；報酬以時間加權計
//   · 提領不可超過可提領現金（已交割現金－應付－委託買單保留）；持股中的資金要等 AI 賣出才能提領
//   · 填 0＝提領全部可提領現金（含獲利，淨投入可為負；審查：舊版只能提到本金、獲利卡在帳戶）
//   · 獲利目標：每「獲利期間」個交易日帳戶成長 N%——滾動：自設定日的下一個交易日起算，到期自動進入下一期；
//     目標或期間變更＝重新起算。交給會員的 AI 交易員當作目標（風險控制優先），頁面追蹤進度
//   一律由伺服器驗證後寫入 aiSwingMembers/{uid}（會員不能直接寫 Firestore）。
// ─────────────────────────────────────────────────────────────────────────────

export const MEMBER_LIMITS = Object.freeze({ minCapital: 50_000, maxCapital: 100_000_000, maxDaytradeLimit: 100_000_000, minGoal: 1, maxGoal: 1000, maxFlows: 500 });
/** 獲利期間選項（交易日）；沒設或不合法＝預設 20 日 */
export const GOAL_DAYS = Object.freeze([5, 10, 20, 60, 120, 240]);
export const DEFAULT_GOAL_DAYS = 20;

/** 淨投入＝入金合計－提領合計 */
export const netInvestedOf = flows => (flows || []).reduce((a, f) => a + (Number(f?.amount) || 0), 0);

/** 可提領現金：已交割現金－應付款－委託買單保留（不含未交割的賣出款與委託賣單估計回收）；沒有快照＝淨投入 */
export function withdrawableOf(account, netInvested) {
  if (!account) return Math.max(0, netInvested);
  const settled = account.settledCash ?? account.cash ?? 0;
  return Math.max(0, Math.floor(settled - (account.payable ?? 0) - (account.reservedBuys ?? 0)));
}

/**
 * 快照之後的入金／提領（2026-10-01 審查 HIGH）：帳戶快照由 daemon 重算，設定變更後到下一次重算之間快照還沒算進去——
 * 顯示與提領上限都要補上，否則重算前可重複超領、首次入金會顯示總損益 −入金。
 * 快照的 flowsIncluded＝已計入幾筆（異動只會附加、不改寫）；沒有此欄的舊快照才退回以時間比對。
 */
export function pendingFlowOf(flows, snap) {
  if (!snap) return 0;
  const fs = Array.isArray(flows) ? flows : [];
  const rest = typeof snap.flowsIncluded === 'number' ? fs.slice(snap.flowsIncluded) : fs.filter(f => (f.at ?? 0) > (snap.at ?? 0));
  return rest.reduce((a, f) => a + (Number(f.amount) || 0), 0);
}

/** 目前可提領：有快照＝快照的可提領＋快照之後的異動；沒有快照（尚未開始）＝淨投入 */
export function withdrawableNow(snap, flows) {
  return snap ? Math.max(0, withdrawableOf(snap.account ?? null, 0) + pendingFlowOf(flows, snap)) : Math.max(0, netInvestedOf(flows));
}

const fmt = n => Math.round(n).toLocaleString('en-US');
const fail = error => ({ ok: false, error });

/**
 * 驗證並套用會員設定。body＝{ capital?, goalDays?, growthTarget?, daytradeLimit? }（數字；growthTarget 可為 null＝清除）；
 * cur＝現有設定；withdrawable＝目前可提領現金（見 withdrawableNow）。today＝台北日期（期間起算、資金異動日）。
 * 回傳 { ok: true, next, flow }（flow＝本次產生的資金異動，沒有則 null）｜{ ok: false, error }
 */
export function applyMemberSettings(body, cur, { today, now = Date.now(), withdrawable = null } = {}) {
  const c = cur || {};
  const flows = Array.isArray(c.flows) ? c.flows : [];
  const next = { flows, daytradeLimit: c.daytradeLimit ?? 0, growthTarget: c.growthTarget ?? null, goalDays: c.goalDays ?? null, goalStartDate: c.goalStartDate ?? null };
  let flow = null;
  if (body?.capital !== undefined) {
    const cap = body.capital;
    if (!Number.isInteger(cap) || cap < 0 || cap > MEMBER_LIMITS.maxCapital) return fail(`投入資金需為 0～${fmt(MEMBER_LIMITS.maxCapital)} 元的整數`);
    const net = netInvestedOf(flows);
    if (cap > 0 && cap < MEMBER_LIMITS.minCapital) return fail(net > 0 ? `投入資金需為 0 或至少 ${fmt(MEMBER_LIMITS.minCapital)} 元` : `首次投入至少 ${fmt(MEMBER_LIMITS.minCapital)} 元`);
    const avail = Math.max(0, Math.floor(withdrawable ?? net));
    let delta = cap - net;
    if (cap === 0 && net !== 0) {   // 全部提領：所有可提領現金（含獲利）；持股中的部分留在帳戶
      if (!(avail > 0)) return fail('目前沒有可提領的現金（資金都在持股或委託中，AI 賣出並交割後才能提領）');
      delta = -avail;
    } else if (delta < 0 && -delta > avail) {
      return fail(`可提領現金不足：目前可提領 ${fmt(avail)} 元（其餘資金在持股或委託中，AI 賣出並交割後才能提領）`);
    }
    if (delta !== 0) {
      if (flows.length >= MEMBER_LIMITS.maxFlows) return fail(`入金／提領筆數已達上限 ${MEMBER_LIMITS.maxFlows} 筆，請洽管理員`);
      flow = { date: today, amount: delta, at: now }; next.flows = [...flows, flow];
    }
  }
  if (body?.daytradeLimit !== undefined) {
    const v = body.daytradeLimit;
    if (!Number.isInteger(v) || v < 0 || v > MEMBER_LIMITS.maxDaytradeLimit) return fail(`當沖額度需為 0～${fmt(MEMBER_LIMITS.maxDaytradeLimit)} 元的整數`);
    next.daytradeLimit = v;
  }
  if (body?.goalDays !== undefined) {
    if (!GOAL_DAYS.includes(body.goalDays)) return fail(`獲利期間需為 ${GOAL_DAYS.join('／')} 日其中之一`);
    next.goalDays = body.goalDays;
  }
  if (body?.growthTarget !== undefined) {
    const v = body.growthTarget;
    if (v === null) next.growthTarget = null;
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < MEMBER_LIMITS.minGoal || v > MEMBER_LIMITS.maxGoal) return fail(`獲利成長目標需為 ${MEMBER_LIMITS.minGoal}～${MEMBER_LIMITS.maxGoal}%`);
    else next.growthTarget = Math.round(v * 10) / 10;
  }
  // 期間起算日：目標或期間變更＝重新起算（自下一個交易日起）；只加碼／提領不影響；清除目標＝不追蹤
  if (next.growthTarget == null) next.goalStartDate = null;
  else if (next.growthTarget !== (c.growthTarget ?? null) || next.goalDays !== (c.goalDays ?? null) || !c.goalStartDate) next.goalStartDate = today;
  return { ok: true, next, flow };
}

/**
 * 獲利目標進度（滾動期間）：期間自設定日的下一個交易日起算，每 N 個交易日一期，到期自動進入下一期。
 * 報酬一律時間加權（growth 連乘相除：入金／提領不算獲利）。history＝帳戶每日戰績（舊→新，只含官方收盤日）。
 * 回傳 null＝沒設目標。
 * 限制：戰績只保留最近 400 個交易日；起算日早於保留範圍時，期數與本期起點以保留範圍內的列計算。
 */
export function goalProgress(history, { growthTarget, goalDays, goalStartDate } = {}) {
  if (!(growthTarget > 0)) return null;
  const N = GOAL_DAYS.includes(goalDays) ? goalDays : DEFAULT_GOAL_DAYS;
  const rows = Array.isArray(history) ? history : [];
  const g = r => (r == null ? null : r.growth ?? (r.cumRetPct != null ? 1 + r.cumRetPct / 100 : null));
  const since = goalStartDate || '';
  const base0 = g(rows.filter(r => r.date <= since).at(-1)) ?? 1;
  const R = rows.filter(r => r.date > since);
  const elapsed = R.length, cur = Math.floor(elapsed / N), day = elapsed - cur * N;
  const baseOf = k => (k === 0 ? base0 : g(R[k * N - 1]) ?? base0);
  const pct = (a, b) => +((a / b - 1) * 100).toFixed(2);
  const periodRetPct = day ? pct(g(R.at(-1)) ?? base0, baseOf(cur)) : 0;
  const lastRet = cur >= 1 ? pct(g(R[cur * N - 1]) ?? base0, baseOf(cur - 1)) : null;
  return {
    goal: growthTarget, days: N, startDate: since || null, period: cur + 1, day, daysLeft: N - day,
    periodStart: R[cur * N]?.date ?? null,   // null＝本期自下一個交易日起算
    periodRetPct, cumRetPct: rows.length ? rows.at(-1).cumRetPct ?? null : null,
    progress: Math.max(0, Math.round(periodRetPct / growthTarget * 1000) / 10),
    lastPeriod: lastRet == null ? null : { n: cur, retPct: lastRet, achieved: lastRet >= growthTarget },
  };
}

// ── 會員資格（2026-10-04 使用者裁定；WM-SCAN G4-24／G4-21）───────────────────────
/** 與開通 API（src/app/api/admin/ai-lab-access/route.ts）同一份付費等級——不含註冊 14 天體驗期 */
export const AI_LAB_PAID_LEVELS = Object.freeze(['premium', 'admin', 'superadmin']);

/**
 * daemon 端會員 AI 帳戶的資格（與開通 API 一致：只收付費等級）。
 *   grants＝aiLabAccess 中 swing＝true 的 [{ uid }]；userOf(uid)＝users/{uid} 的資料（不存在＝null）。
 *   active：執行結算／成交／快照／決策；suspended：已開通但目前不是付費等級（體驗期到期或降級）或帳號不存在 ⇒
 *   停止一切執行（資料保留不刪），寫「已停用」狀態供 API／前端隱藏。
 * @returns {{ active: string[], suspended: { uid: string, reason: string, level: string|null }[] }}
 */
export function classifyLabMembers(grants, userOf) {
  const active = [], suspended = [];
  for (const g of grants || []) {
    const uid = g?.uid; if (!uid) continue;
    const u = userOf(uid);
    if (!u) { suspended.push({ uid, reason: '帳號不存在', level: null }); continue; }
    const level = String(u.level ?? 'registered');
    if (AI_LAB_PAID_LEVELS.includes(level)) active.push(uid);
    else suspended.push({ uid, reason: `非付費等級（${level}；體驗期已結束或已降級）`, level });
  }
  return { active, suspended };
}

/**
 * 經驗庫訓練可使用哪些會員的樣本（2026-10-04 使用者：「保留會員身分到會員自主取消或帳號刪除」）：
 *   仍開通（aiLabAccess.swing＝true）且帳號存在 ⇒ 納入（體驗期到期＝停用但未取消，樣本保留）；
 *   取消開通（swing≠true／無開通紀錄）或帳號已刪除 ⇒ 每次訓練時剔除（樣本是每次由會員決策檔重算，剔除即移除）。
 *   access(uid)＝aiLabAccess/{uid} 資料或 null；userExists(uid)＝boolean。
 * @returns {{ include: string[], exclude: { uid: string, reason: string }[] }}
 */
export function learnMemberEligibility(uids, access, userExists) {
  const include = [], exclude = [];
  for (const uid of uids || []) {
    if (access(uid)?.swing !== true) exclude.push({ uid, reason: '已取消開通' });
    else if (!userExists(uid)) exclude.push({ uid, reason: '帳號已刪除' });
    else include.push(uid);
  }
  return { include, exclude };
}
