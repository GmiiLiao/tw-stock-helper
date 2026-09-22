import { latestDoc } from '@/lib/api-cache';
export const runtime = 'nodejs';
// 🚪 軋空當日入選／離榜帳（daemon computeSqueezePicks 盤中每 3 分鐘更新 squeezePicksLedger/latest）。
// 戰情室軋空候選表下方的「當日離榜」對照用；intraday 層（2 分鐘），gzip 由 latestDoc 處理。
export const GET = () => latestDoc('squeezePicksLedger', 'intraday');
