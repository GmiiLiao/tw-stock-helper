// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export interface MemberFlow { date: string; amount: number; at?: number }
export interface MemberSettings { flows: MemberFlow[]; daytradeLimit: number; growthTarget: number | null; goalDays: number | null; goalStartDate: string | null }
export interface MemberAccount { settledCash?: number; cash?: number; payable?: number; reservedBuys?: number }
export interface SnapMeta { at?: number | null; flowsIncluded?: number; account?: MemberAccount | null }
export interface GoalProgress {
  goal: number; days: number; startDate: string | null; period: number; day: number; daysLeft: number;
  periodStart: string | null; periodRetPct: number; cumRetPct: number | null; progress: number;
  lastPeriod: { n: number; retPct: number; achieved: boolean } | null;
}
export const MEMBER_LIMITS: { minCapital: number; maxCapital: number; maxDaytradeLimit: number; minGoal: number; maxGoal: number; maxFlows: number };
export const GOAL_DAYS: readonly number[];
export const DEFAULT_GOAL_DAYS: number;
export function netInvestedOf(flows: MemberFlow[] | null | undefined): number;
export function withdrawableOf(account: MemberAccount | null, netInvested: number): number;
export function pendingFlowOf(flows: MemberFlow[] | null | undefined, snap: SnapMeta | null): number;
export function withdrawableNow(snap: SnapMeta | null, flows: MemberFlow[] | null | undefined): number;
export function applyMemberSettings(
  body: { capital?: unknown; daytradeLimit?: unknown; growthTarget?: unknown; goalDays?: unknown },
  cur: Partial<MemberSettings> | null,
  opts: { today: string; now?: number; withdrawable?: number | null },
): { ok: true; next: MemberSettings; flow: MemberFlow | null } | { ok: false; error: string };
export function goalProgress(
  history: { date: string; growth?: number; cumRetPct?: number | null }[] | null | undefined,
  settings: { growthTarget?: number | null; goalDays?: number | null; goalStartDate?: string | null },
): GoalProgress | null;
