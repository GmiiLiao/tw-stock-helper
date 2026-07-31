// OHLC 完整性防護（借鏡 HKUDS/Vibe-Trading 的「loader boundary integrity guard」）
// 在資料載入邊界攔截物理上不可能的 K 棒，避免壞資料汙染圖表/回測/評分。
// 規則：價格皆為正、high≥max(o,c,l)、low≤min(o,c,h)；不可修者回 null 由呼叫端丟棄。

export interface OhlcBar { t?: number; o: number; h: number; l: number; c: number; v?: number }

/**
 * 清洗單根 K 棒。close 無效(≤0 或 NaN)→ null(丟棄)。
 * high/low 若與開收不一致(資料源偶發)→ 夾到 max/min 使其自洽，不整根丟。
 */
export function sanitizeOhlc<T extends OhlcBar>(bar: T): T | null {
  const c = Number(bar.c);
  if (!(c > 0) || !Number.isFinite(c)) return null; // 收盤是骨幹，無效即丟
  const o = Number(bar.o) > 0 ? Number(bar.o) : c;
  const lo0 = Number(bar.l) > 0 ? Number(bar.l) : c;
  const hi0 = Number(bar.h) > 0 ? Number(bar.h) : c;
  // 自洽夾制：high 必 ≥ 所有價、low 必 ≤ 所有價
  const h = Math.max(hi0, o, c, lo0);
  const l = Math.min(lo0, o, c, hi0);
  const v = Number.isFinite(Number(bar.v)) && Number(bar.v) >= 0 ? Number(bar.v) : 0;
  return { ...bar, o, h, l, c, v };
}

/** 清洗一序列並丟棄無法修復者。回傳 {bars, dropped}。 */
export function sanitizeOhlcSeries<T extends OhlcBar>(bars: T[]): { bars: T[]; dropped: number } {
  const out: T[] = [];
  let dropped = 0;
  for (const b of bars) { const s = sanitizeOhlc(b); if (s) out.push(s); else dropped++; }
  return { bars: out, dropped };
}
