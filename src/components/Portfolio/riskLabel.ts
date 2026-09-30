// 處置／注意＝交易風險，不是走勢強弱（2026-09-30 使用者「為何論點相反」）。
// 徽章一律用全站共用的 <RiskBadge>（即時名單、含起訖日）；這裡只放「排序用評分為何比較低」的說明文字。
// 扣分幅度與 src/lib/scoring-server.ts 同步；汰弱留強與論點追蹤共用。

export type Risk = 'disposition' | 'attention' | null;

export const RISK_NOTE: Record<'disposition' | 'attention', string> = {
  disposition: '處置股是交易風險（分盤撮合、可能預收款券），不代表走勢弱；排序用評分另扣 40 分',
  attention: '注意股是交易風險（交易所成交異常警示），不代表走勢弱；排序用評分另扣 20 分',
};

/** 全市場百分位（0~100，越大越前）→「市場前 N%」；最前面的一檔顯示前 1%，不顯示前 0% */
export const topPctText = (percentile: number): string => `市場前 ${Math.max(1, 100 - percentile)}%`;
