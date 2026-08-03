import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// GET /api/system/mode-status —— 各模式的資料閘門進度（目前只有當沖需要）。
// daemon 每日 15:40 歸檔後更新 system/modeStatus。
// ⚠不要在前端直接數 intradayArchive 的文件數——那是 N 次 Firestore 讀取 × 每個
//   使用者，違反唯一不變式。一律讀 daemon 算好的單一 doc。
export const GET = (request: Request) => latestDoc('system', 'daily', { request, docId: 'modeStatus' });
