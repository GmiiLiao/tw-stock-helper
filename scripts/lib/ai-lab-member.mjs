// ─────────────────────────────────────────────────────────────────────────────
// AI 實驗·會員設定（2026-10-01 使用者：開放高級會員、先開放波段；會員可設 1.投入資金 2.當沖額度 3.獲利成長目標）
//   · 投入資金：變更＝加碼（入金）／提領——寫成資金異動 flows[{date, amount, at}]，帳戶延續；報酬以時間加權計
//   · 提領不可超過可提領現金（已交割現金－應付－委託買單保留）；持股中的資金要等 AI 賣出才能提領
//   · 填 0＝提領全部可提領現金（含獲利，淨投入可為負；2026-10-01 審查：舊版只能提到本金、獲利卡在帳戶）
//   · 當沖額度：當沖功能開放後才使用（先保存設定）
//   · 獲利成長目標：帳戶成長 %；交給會員的 AI 交易員當作目標並在頁面追蹤進度
//   一律由伺服器驗證後寫入 aiSwingMembers/{uid}（會員不能直接寫 Firestore）。
// ─────────────────────────────────────────────────────────────────────────────

export const MEMBER_LIMITS = Object.freeze({ minCapital: 50_000, maxCapital: 100_000_000, maxDaytradeLimit: 100_000_000, minGoal: 1, maxGoal: 1000, maxFlows: 500 });

/** 淨投入＝入金合計－提領合計 */
export const netInvestedOf = flows => (flows || []).reduce((a, f) => a + (Number(f?.amount) || 0), 0);

/** 可提領現金：已交割現金－應付款－委託買單保留（不含未交割的賣出款與委託賣單估計回收）；沒有快照＝淨投入 */
export function withdrawableOf(account, netInvested) {
  if (!account) return Math.max(0, netInvested);
  const settled = account.settledCash ?? account.cash ?? 0;
  return Math.max(0, Math.floor(settled - (account.payable ?? 0) - (account.reservedBuys ?? 0)));
}

const fmt = n => Math.round(n).toLocaleString('en-US');
const fail = error => ({ ok: false, error });

/**
 * 驗證並套用會員設定。body＝{ capital?, daytradeLimit?, growthTarget? }（數字；growthTarget 可為 null＝清除）；
 * cur＝現有設定 { flows, daytradeLimit, growthTarget }；withdrawable＝目前可提領現金（見 withdrawableOf）。
 * 回傳 { ok: true, next, flow }（flow＝本次產生的資金異動，沒有則 null）｜{ ok: false, error }
 */
export function applyMemberSettings(body, cur, { today, now = Date.now(), withdrawable = null } = {}) {
  const c = cur || {};
  const flows = Array.isArray(c.flows) ? c.flows : [];
  const next = { flows, daytradeLimit: c.daytradeLimit ?? 0, growthTarget: c.growthTarget ?? null };
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
  if (body?.growthTarget !== undefined) {
    const v = body.growthTarget;
    if (v === null) next.growthTarget = null;
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < MEMBER_LIMITS.minGoal || v > MEMBER_LIMITS.maxGoal) return fail(`獲利成長目標需為 ${MEMBER_LIMITS.minGoal}～${MEMBER_LIMITS.maxGoal}%`);
    else next.growthTarget = Math.round(v * 10) / 10;
  }
  return { ok: true, next, flow };
}
