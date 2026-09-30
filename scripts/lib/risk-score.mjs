// ─────────────────────────────────────────────────────────────────────────────
// 處置／注意扣分與「未含風險扣分」的技術評分（2026-09-30 使用者「為何論點相反」全站稽核）
//   /api/rating 的 score／grade／signal 已含處置 −40／注意 −20 的可交易性調整（給推薦榜排序用）。
//   描述走勢強弱的地方（汰弱留強、論點支柱、LLM prompt、同業比較、自然語言選股）一律用
//   baseScore／baseSignal，風險另列——否則強勢上漲中的處置股會被當成弱勢
//   （實例：2305 全友 20 日 +128%、處置股，扣分前 57.36 → 扣分後 17.36 被標「弱勢」建議轉倉）。
//   扣分幅度與 src/lib/scoring-server.ts 同步。
// ─────────────────────────────────────────────────────────────────────────────

export const RISK_PENALTY = { disposition: 40, attention: 20 };

/** 完整分析物件（/api/rating?code= 的 stock）的風險類型 */
export const riskTypeOf = st => (st?.isDisposition ? 'disposition' : st?.isAttention ? 'attention' : null);

/** 未含風險扣分的技術評分；舊 API 沒有 baseScore 時由 score＋扣分回推（被扣到 0 的會低估，僅過渡用） */
export function baseScoreOf(r, riskType) {
  if (r?.baseScore != null) return r.baseScore;
  if (r?.score == null) return null;
  return +(r.score + (RISK_PENALTY[riskType] || 0)).toFixed(2);
}

/** sorted（升冪）中 ≤ v 的比例 ×100（四捨五入）；v 為 null 或陣列空 ⇒ null */
export function percentileOf(sorted, v) {
  if (v == null || !sorted.length) return null;
  return Math.round(sorted.filter(x => x <= v).length / sorted.length * 100);
}

/** 給 LLM 的技術評分文字：有風險時寫未含扣分的評分與技術訊號（不寫含扣分的等級，避免被讀成走勢弱） */
export function techScoreText(st, riskType = riskTypeOf(st)) {
  if (!riskType) return `AI 技術評分 ${st.score}(${st.grade}) 訊號 ${st.signal}`;
  return `AI 技術評分（未含風險扣分）${baseScoreOf(st, riskType)}、技術訊號 ${st.baseSignal ?? '—'}`;
}

/** 給 LLM 的風險說明：明講是交易風險、不是走勢 */
export function riskNoteText(riskType) {
  if (riskType === 'disposition') return '⚠️ 此股為處置股：分盤撮合、可能需預收款券（交易限制與流動性風險）。這是交易風險，不代表技術面轉弱。';
  if (riskType === 'attention') return '⚠️ 此股為注意股：交易所提示成交異常（波動風險）。這是交易風險，不代表技術面轉弱。';
  return '';
}

/**
 * 論點支持度（描述目前證據有多少站在論點這邊，不是報酬預測）：
 *   論點支柱成立權重 2、其他參考指標成立權重 1，換算 0~100。pillars／refs：[{ ok }]；兩者皆空 ⇒ null。
 */
export function thesisSupport(pillars = [], refs = []) {
  const den = 2 * pillars.length + refs.length;
  if (!den) return null;
  const num = 2 * pillars.filter(p => p.ok).length + refs.filter(p => p.ok).length;
  return Math.round(num / den * 100);
}
