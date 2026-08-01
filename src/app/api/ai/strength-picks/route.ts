import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 波段追強（強勢整理）·讀 strengthPicks/latest（daemon computeStrengthPicks）。
// 規則：RSI5 75~90 ∧ RSI10>RSI5 ∧ 法人5日買超/20日均量>0.05。
// 實證：主窗 5日+0.73%[0.71/0.76]·10日內漲≥5% 53.2%；OOT +0.96% 通過；
// 多空 regime 皆成立。⚠隔日開賣 -0.07% ＝絕不可隔日沖，5日持有語意。
// 日均 1.6 檔——空榜是常態。非投資建議。
export const GET = (request: Request) => latestDoc('strengthPicks', 'intraday', { request });
