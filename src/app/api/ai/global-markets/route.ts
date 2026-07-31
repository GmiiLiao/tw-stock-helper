import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// GET /api/ai/global-markets — 國際指數；sectorLoop 盤中每 3 分鐘另外更新
// daemon 寫入節奏見 scripts/ai-daemon.mjs runDailyJobs()（15:10 / 16:30 / 21:45）。
export const GET = (request: Request) => latestDoc('globalMarkets', 'intraday', { request });
