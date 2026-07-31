// ============================================================
// 台股交割：T+2 交易日（款券於成交後第 2 個「交易日」交割）。
// 買進：成交日 T 記帳，交割銀行於 T+2 早上自動扣款 → 款項在 T+2 前仍留在銀行。
// 賣出：成交日 T 記帳，賣出價金於 T+2 入帳 → 款項在 T+2 前尚未進銀行。
// 近似：跳過週六日；國定假日未內建（會使實際交割日順延），以「假日順延」提示。
// ============================================================

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

export function isWeekend(d: Date): boolean { const g = d.getDay(); return g === 0 || g === 6; }

// 加 n 個交易日（跳過週末）
export function addTradingDays(dateIso: string, n: number): string {
  const d = parse(dateIso);
  let added = 0;
  while (added < n) { d.setDate(d.getDate() + 1); if (!isWeekend(d)) added++; }
  return iso(d);
}

// 成交日 → 交割日（T+2 交易日）
export function settleDate(tradeDateIso: string): string {
  return addTradingDays(tradeDateIso, 2);
}

// 今日（台北）ISO
export function todayTaipeiIso(): string {
  return iso(new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })));
}

// 是否已交割（交割日 <= 今日）
export function isSettled(tradeDateIso: string, todayIso: string = todayTaipeiIso()): boolean {
  return settleDate(tradeDateIso) <= todayIso;
}

// 距交割剩餘交易日（0=今日交割、>0 未交割、<0 已過交割日）
export function tradingDaysUntilSettle(tradeDateIso: string, todayIso: string = todayTaipeiIso()): number {
  const target = settleDate(tradeDateIso);
  if (target <= todayIso) return target === todayIso ? 0 : -1;
  let n = 0; const d = parse(todayIso);
  while (iso(d) < target) { d.setDate(d.getDate() + 1); if (!isWeekend(d)) n++; }
  return n;
}
