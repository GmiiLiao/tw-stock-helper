// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { SwingLabDoc, SimAccount, SwingLot } from './ai-swing-lab.mjs';
/** 資金異動（會員帳戶）：入金為正、提領為負；date＝生效日（YYYY-MM-DD） */
export interface CashFlow { date: string; amount: number; at?: number }
export interface AccountOpts { initial?: number; flows?: CashFlow[] }
export function portfolioState(docs: SwingLabDoc[], days?: unknown[] | null, beforeDate?: string | null, opts?: AccountOpts): { lots: SwingLot[]; account: SimAccount };
