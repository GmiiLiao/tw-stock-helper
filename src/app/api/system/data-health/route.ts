import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 全站資料源健康狀態（wm-freshness-health-monitoring 的對外投影）。
// 由 scripts/audit-data-sources.mjs --write 產出，daemon 每日 16:10 執行。
//
// 內容：52 個 Firestore 資料源的三道閘門檢測 ——
//   ① 新鮮度 maxStale（依 session 分盤中/每日/全天，避免收盤後誤報）
//   ② 覆蓋率 minRecords（抓「很新但幾乎全空」）
//   ③ **資料日漂移**（抓「有值、很新、筆數也夠，但代表的是別天」）
// 外加 6 個外部端點的自報日期落後檢測。
export const GET = (request: Request) => latestDoc('system', 'intraday', { request, docId: 'dataHealth' });
