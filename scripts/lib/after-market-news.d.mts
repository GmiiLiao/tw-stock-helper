export interface MediaItem {
  code: string; label: '利多' | '利空'; strength: string | null; confidence: string | null; certainty: string | null;
  novelty: string | null; priced: string | null; eventType: string | null; reason: string | null; impactPath: string | null;
  keyQuote: string | null; challenge: string | null; revision: string | null; strengthBasis: string | null;
  quotes: string[]; quoteVerified: number | null; quoteFailed: number | null; unsupported: string[]; basis: string | null;
  articlesRead: number | null; pass: string | null; verdictAt: number | null; px: number | null; pxSrc: string | null;
  weight: number; order: number; share: number | null; titles?: string[];
}
export interface MediaRank { items: MediaItem[]; total: number; bullish: number; bearish: number; neutral: number; insufficient: number }
export interface OfficialItem {
  code: string; name: string; subject: string; at: number | null; count: number; announcements: { subject: string; at: number | null; body: string | null }[]; type: string; typeLabel: string; dir: '+' | '−' | null;
  weight: number; basis: '主旨'; order: number; share: number | null;
}
export interface OfficialRank { items: OfficialItem[]; total: number; ranked: number; rankedAnnouncements: number; routine: number; unclassified: number; updatedAt: number | null }
export function rankMediaVerdicts(verdicts: Record<string, unknown> | null | undefined, opts?: { limit?: number }): MediaRank;
export function classifyOfficial(subject: string): { id: string | null; label: string; weight: number | null; dir: '+' | '−' | null };
export function rankOfficial(items: { code: string; name: string; subject: string; at?: number; body?: string }[] | null | undefined, opts?: { limit?: number }): OfficialRank;
export const OFFICIAL_RULES: { id: string; label: string; w: number; dir: '+' | '−' | null; re: RegExp }[];
