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

// ── 銀行餘額自動逐日滾動（2026-08-14 使用者指正）────────────────────
// 使用者輸入的銀行餘額是「錨點」，之後每天的交割款進出系統都知道（交易紀錄
// ＋T+2），應自動滾動而不是擺到變舊。實案：8/12 輸入 837,959，8/13/8/14 兩天
// 交割 −496,264 後實際 342,751，畫面卻仍拿 837,959 算剩餘籌碼（虛胖 49 萬）。
// 慣例：錨點視為「已含錨點日當天早上的交割」⇒ 只滾 settleDate > 錨點日的部分；
// 現金流水（入金/出金/股利）同理以其記錄日期滾動。
// ⚠鏡像警告：scripts/ai-daemon.mjs checkAllocationDrift 有同邏輯抄本（mjs 不能
// import TS），改這裡務必同步改那裡。
export interface BankRoll { estBank: number; rolledNet: number; rolledCount: number; anchorDate: string }
export function rollBankToToday(
  bankBalance: number, bankAt: number,
  trades: Array<{ type: string; date?: string; totalAmount?: number }>,
  entries: Array<{ type: string; date?: string; amount?: number }> = [],
  todayIso: string = todayTaipeiIso(),
): BankRoll {
  const anchorDate = new Date(bankAt).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }); // YYYY-MM-DD
  let rolledNet = 0, rolledCount = 0;
  for (const t of trades) {
    if ((t.type !== 'buy' && t.type !== 'sell') || !t.date) continue;
    const sd = settleDate(t.date);
    if (sd > anchorDate && sd <= todayIso) {
      rolledNet += (t.type === 'sell' ? 1 : -1) * (t.totalAmount || 0);
      rolledCount++;
    }
  }
  for (const e of entries) {
    if (!e.date || e.date <= anchorDate || e.date > todayIso) continue;
    if (e.type === 'deposit' || e.type === 'dividend') { rolledNet += e.amount || 0; rolledCount++; }
    else if (e.type === 'withdraw') { rolledNet -= e.amount || 0; rolledCount++; }
  }
  return { estBank: bankBalance + rolledNet, rolledNet, rolledCount, anchorDate };
}

// 距交割剩餘交易日（0=今日交割、>0 未交割、<0 已過交割日）
export function tradingDaysUntilSettle(tradeDateIso: string, todayIso: string = todayTaipeiIso()): number {
  const target = settleDate(tradeDateIso);
  if (target <= todayIso) return target === todayIso ? 0 : -1;
  let n = 0; const d = parse(todayIso);
  while (iso(d) < target) { d.setDate(d.getDate() + 1); if (!isWeekend(d)) n++; }
  return n;
}
