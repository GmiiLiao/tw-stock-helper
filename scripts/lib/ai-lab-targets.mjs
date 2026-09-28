// ─────────────────────────────────────────────────────────────────────────────
// AI 實驗目標追蹤（2026-09-26 使用者）：看戰績與累積戰績，5／20／60 日是否能持續獲利；
//   目標：近 5 個交易日帳戶報酬 ≥ 35%、近 20 日 ≥ 70%、近 60 日 ≥ 120%（使用者訂定，非本站實證可達水準）。
// 口徑：series＝逐交易日帳戶總值 [{date, total}]（舊→新）；近 N 日報酬＝最新總值 ÷ N 個交易日前的總值 − 1。
//   歷史不足 N 日時，以起始資金為基準、標記 partial（「已累積 k/N 日」），不冒充完整窗口。
//   「持續獲利」＝所有完整 N 日滾動窗中報酬 > 0 的比例、目前連續獲利窗數。
// ─────────────────────────────────────────────────────────────────────────────

export const LAB_TARGETS = Object.freeze({ 5: 35, 20: 70, 60: 120 });
// 波段帳戶累積目標（2026-09-28 使用者：「能達到 50 萬成長 200% 以上為目標」）＝帳戶總值 ≥ 150 萬
export const SWING_CUM_TARGET = 200;

export function windowStats(series, initial, n, target = LAB_TARGETS[n]) {
  const s = [...series].sort((a, b) => a.date.localeCompare(b.date));
  if (!s.length) return { n, target, days: 0, partial: true, ret: null, met: false, windows: 0, positive: 0, hitRate: null, streak: 0, best: null, worst: null };
  const last = s[s.length - 1];
  const partial = s.length <= n;
  const base = partial ? initial : s[s.length - 1 - n].total;
  const ret = +((last.total / base - 1) * 100).toFixed(2);
  const rets = [];
  for (let i = n; i < s.length; i++) rets.push((s[i].total / s[i - n].total - 1) * 100);
  let streak = 0; for (let i = rets.length - 1; i >= 0 && rets[i] > 0; i--) streak++;
  return {
    n, target, days: Math.min(s.length, n), partial, from: partial ? null : s[s.length - 1 - n].date, to: last.date, ret,
    met: !partial && ret >= target,
    windows: rets.length, positive: rets.filter(r => r > 0).length, hitRate: rets.length ? Math.round(rets.filter(r => r > 0).length / rets.length * 100) : null,
    streak, best: rets.length ? +Math.max(...rets).toFixed(2) : null, worst: rets.length ? +Math.min(...rets).toFixed(2) : null,
    metWindows: rets.filter(r => r >= target).length,
  };
}

export function targetBoard(series, initial, { cumTarget = null } = {}) {
  const s = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const last = s[s.length - 1];
  const cumRetPct = last ? +((last.total / initial - 1) * 100).toFixed(2) : 0;
  return {
    total: last?.total ?? initial, cumRetPct, tradingDays: s.length,
    cumTarget, targetTotal: cumTarget != null ? Math.round(initial * (1 + cumTarget / 100)) : null,
    cumMet: cumTarget != null && cumRetPct >= cumTarget, cumProgress: cumTarget ? +(Math.max(0, cumRetPct) / cumTarget * 100).toFixed(1) : null,
    windows: Object.keys(LAB_TARGETS).map(Number).map(n => windowStats(s, initial, n)),
  };
}
