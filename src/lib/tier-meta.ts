// ============================================================
// 勝率雷達 tier 實測統計 —— 全站顯示的單一真相來源
//
// 資料來源：scripts/audit-weights.mjs 2026-08-01 全量重測
// （480 交易日·42.3 萬可交易樣本·資料修復後的乾淨窗）。
// 口徑＝**明開盤賣出**（產品鐵律 exitModel：開盤溢價是隔日沖全部 edge）。
//   毛勝 win    ＝ 明開盤價 > 今收盤價 的機率
//   淨勝 netWin ＝ 扣除費稅（~0.585% 來回）後仍為正的機率
//   淨均 net    ＝ 扣費稅後平均報酬 %/筆
//
// 讀法（給操作者）：
//   ● 排序看 rank（🥇→🚫），不要看字母——字母是籌碼形態代號，不是優劣順序。
//   ● **只有 A 級淨期望為正**（淨勝 51%·+0.17%/筆·日均約 3 檔）。
//     B+/S ≈ 打平；其餘全部淨負——是「避開與排序」工具，不是進場保證。
//   ● 避開端的辨識力最可靠：danger 淨勝 38.6% 全場最低。
//
// ⚠鏡像警告：daemon 的 chipPhaseTier（scripts/ai-daemon.mjs）持有同一張表的
//   mjs 副本，兩邊必須同步改（wm-source-aggregation「mirror 漂移」風險）。
// ============================================================

export interface TierMeta {
  rank: number;          // 1=最優
  medal: string;         // 顯示用序位符號
  win: number;           // 明開賣 毛勝率 %
  netWin: number;        // 明開賣 淨勝率 %（扣費稅）
  net: number;           // 明開賣 淨均 %/筆
  perDay: number;        // 日均出現檔數（480日窗）
  hint: string;          // 一句話決策提示
}

export const TIER_META: Record<string, TierMeta> = {
  A:        { rank: 1, medal: '🥇', win: 61, netWin: 51, net: 0.17,  perDay: 3,   hint: '三方同買·唯一費稅後淨正——首選' },
  'B+':     { rank: 2, medal: '🥈', win: 60, netWin: 45, net: 0.02,  perDay: 68,  hint: '外資大買·約打平——次選' },
  S:        { rank: 3, medal: '🥉', win: 59, netWin: 44, net: -0.02, perDay: 18,  hint: '外資重倉+投信·約打平' },
  B:        { rank: 4, medal: '④', win: 58, netWin: 44, net: -0.05, perDay: 351, hint: '一般買超·無淨優勢——僅排序參考' },
  watch:    { rank: 5, medal: '⚠', win: 51, netWin: 43, net: -0.09, perDay: 3,   hint: '大漲未鎖·毛勝最低——慎入' },
  watchHot: { rank: 5, medal: '⚠', win: 51, netWin: 43, net: -0.09, perDay: 3,   hint: '大漲未鎖·毛勝最低——慎入' },
  neutral:  { rank: 6, medal: '－', win: 53, netWin: 42, net: -0.26, perDay: 2,   hint: '中性·無訊號' },
  danger:   { rank: 7, medal: '🚫', win: 54, netWin: 39, net: -0.21, perDay: 437, hint: '外資賣超·淨勝全場最低——避開' },
};

/** 顯示字串：「🥇A·開盤賣漲61%·淨勝51%」；未知 tier 回傳原字母。 */
export function tierDisplay(tier?: string | null): string {
  if (!tier) return '';
  const m = TIER_META[tier];
  return m ? `${m.medal}${tier}·開賣漲${m.win}%·淨勝${m.netWin}%` : tier;
}
