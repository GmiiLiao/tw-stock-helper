// ── 技術評分的顯示口徑（2026-09-30 使用者「為何論點相反」全站稽核）──
// /api/rating 的 score／grade／signal 已含處置 −40／注意 −20 的「可交易性調整」，那是給推薦榜排序用的。
// 描述「技術面強弱」的地方一律顯示 baseScore（未含風險扣分），風險用 RiskBadge／處置注意徽章另列——
// 不然強勢上漲中的處置股會被畫成弱勢（實例：2305 全友 20 日 +128%，扣分後 17 分被標「弱勢」）。
// 舊快取或舊 API 沒有 baseScore 時退回 score。

export interface RiskScored {
  score: number;
  baseScore?: number | null;
  isDisposition?: boolean;
  isAttention?: boolean;
}

/** 未含風險扣分的技術評分 */
export function techScoreOf(r: RiskScored): number {
  return r.baseScore ?? r.score;
}

/** 這檔的 score 有沒有因處置／注意被扣分 */
export function isRiskScored(r: RiskScored): boolean {
  return !!(r.isDisposition || r.isAttention);
}

export const TECH_SCORE_TIP = '技術評分未含處置／注意扣分——那是交易風險，不代表走勢弱；推薦榜排序時另扣 40／20 分';
