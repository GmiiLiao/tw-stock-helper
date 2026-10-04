import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 每日熱力分析（最後交易日報告頁）。技能 tw-daily-heatmap 收盤後定版、publish-daily-heatmap.mjs 發佈；
// 一天只變一次 → daily tier。只讀 Firestore，不打上游。
export const GET = (request: Request) => latestDoc('dailyHeatmap', 'daily', { request });
