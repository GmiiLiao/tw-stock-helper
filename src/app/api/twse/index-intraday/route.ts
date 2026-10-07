import { latestDoc } from '@/lib/api-cache';

// 大盤/櫃買盤中逐點序列（daemon writeMarketIndex 每 ~55 秒累積一點）。
// 供左上指數卡點擊彈出的即時走勢圖：指數線＋平盤紅綠填色＋每分鐘上市成交量量條。
// ⚠ 序列第三欄上市＝t00 m÷1000＝累積成交量（千張），不是成交值；上櫃 o00 m 語意待證（開盤感應器 v2.1 §10），單位見文件 seriesUnits。
export const runtime = 'nodejs';
export const GET = () => latestDoc('marketIndexIntraday', 'quote');
