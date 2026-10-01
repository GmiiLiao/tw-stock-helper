// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export interface MemberFlow { date: string; amount: number; at?: number }
export interface MemberSettings { flows: MemberFlow[]; daytradeLimit: number; growthTarget: number | null }
export const MEMBER_LIMITS: { minCapital: number; maxCapital: number; maxDaytradeLimit: number; minGoal: number; maxGoal: number; maxFlows: number };
export function netInvestedOf(flows: MemberFlow[] | null | undefined): number;
export function withdrawableOf(account: { settledCash?: number; cash?: number; payable?: number; reservedBuys?: number } | null, netInvested: number): number;
export function applyMemberSettings(
  body: { capital?: unknown; daytradeLimit?: unknown; growthTarget?: unknown },
  cur: Partial<MemberSettings> | null,
  opts: { today: string; now?: number; withdrawable?: number | null },
): { ok: true; next: MemberSettings; flow: MemberFlow | null } | { ok: false; error: string };
