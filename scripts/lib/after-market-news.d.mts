export interface MediaItem {
  code: string; label: '利多' | '利空'; strength: string | null; confidence: string | null; certainty: string | null;
  novelty: string | null; priced: string | null; eventType: string | null; reason: string | null; impactPath: string | null;
  keyQuote: string | null; weight: number; order: number; share: number | null;
}
export interface MediaRank { items: MediaItem[]; total: number; bullish: number; bearish: number; neutral: number; insufficient: number }
export interface OfficialItem {
  code: string; name: string; subject: string; at: number | null; type: string; typeLabel: string; dir: '+' | '−' | null;
  weight: number; basis: '主旨'; order: number; share: number | null;
}
export interface OfficialRank { items: OfficialItem[]; total: number; ranked: number; routine: number; unclassified: number }
export function rankMediaVerdicts(verdicts: Record<string, unknown> | null | undefined, opts?: { limit?: number }): MediaRank;
export function classifyOfficial(subject: string): { id: string | null; label: string; weight: number | null; dir: '+' | '−' | null };
export function rankOfficial(items: { code: string; name: string; subject: string; at?: number }[] | null | undefined, opts?: { limit?: number }): OfficialRank;
export const OFFICIAL_RULES: { id: string; label: string; w: number; dir: '+' | '−' | null; re: RegExp }[];
