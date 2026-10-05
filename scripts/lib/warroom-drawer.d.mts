// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export const REG_WINDOW_MS: number;
export const REG_MAX: number;

export interface RegEntry { code: string; at: number }
export function pruneRegs(list: unknown, now: number): RegEntry[];
export function decideRegistration(list: unknown, code: string, now: number): { allowed: boolean; next: RegEntry[]; held: string[] };
export function addTicks(price: number, n: number, tick: (p: number) => number): number;
export function breakevenTicks(
  price: number,
  fns: { fee: (p: number) => number; tax: (p: number) => number; tick: (p: number) => number } | null | undefined,
  maxTicks?: number,
): number | null;
