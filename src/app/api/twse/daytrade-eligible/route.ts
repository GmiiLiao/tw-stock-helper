import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// ── 當沖資格名單（全站合規標示）──────────────────────────────────────
// 由 daemon 於盤前 07:30 抓交易所「當日沖銷交易標的」寫入 Firestore，
// 這裡只讀快照——**不要**改成在 route 內直打上游，那會讓請求數隨線上人數成長。
//
// 'daily' 層級：名單一天只換一次，且 daemon 盤前就寫好了。
export const GET = (request: Request) => latestDoc('dayTradeEligible', 'daily', { request });
