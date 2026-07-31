import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// GET /api/ai/dividend-calendar — 未來除權息日曆
// daemon 寫入節奏見 scripts/ai-daemon.mjs runDailyJobs()（15:10 / 16:30 / 21:45）。
export const GET = (request: Request) => latestDoc('dividendCalendar', 'daily', { request });
