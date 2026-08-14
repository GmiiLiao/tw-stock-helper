import { latestDoc } from '@/lib/api-cache';

// 大盤/櫃買盤中逐點序列（daemon writeMarketIndex 每 ~55 秒累積一點）。
// 供左上指數卡點擊彈出的即時走勢圖：指數線＋平盤紅綠填色＋每分鐘成交值量條。
export const runtime = 'nodejs';
export const GET = () => latestDoc('marketIndexIntraday', 'quote');
