import { latestDoc } from '@/lib/api-cache';
export const runtime = 'nodejs';
// ⚡ 盤中漲停預測（戰情新頁，2026-09-22）：讀 limitUpForecast/live——盤中每分多鐘用即時價重算，名單會變。
// 盤後定案、凍結一整天的預測名單走 /api/ai/limitup-forecast（latest）。gzip 由 latestDoc 處理。
export const GET = () => latestDoc('limitUpForecast', 'intraday', { docId: 'live' });
