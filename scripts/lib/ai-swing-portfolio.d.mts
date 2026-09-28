// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
import type { SwingLabDoc, SimAccount, SwingLot } from './ai-swing-lab.mjs';
export function portfolioState(docs: SwingLabDoc[], days?: unknown[] | null, beforeDate?: string | null): { lots: SwingLot[]; account: SimAccount };
