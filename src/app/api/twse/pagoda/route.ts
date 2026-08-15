import { latestDoc } from '@/lib/api-cache';

// 🗼 寶塔線訊號（daemon computePagodaSignals 每 ~15 分鐘更新）：
// dailyJson=日K全市場判定、h60Json=60分K（歸檔 929 檔）、flipUpDaily/flipUp60=今日翻多榜。
export const runtime = 'nodejs';
export const GET = () => latestDoc('pagodaSignals', 'intraday');
