import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// GET /api/ai/asia-premarket — 日韓早盤風向（台股開盤前的領先窗口）。
// 日本與韓國都是 UTC+9，兩地 09:00 開盤＝台北 08:00；台股 09:00 才開盤，
// 所以開盤前有 30~60 分鐘的日韓實盤資訊。
// daemon 於交易日 08:00–09:05 每 15 分寫入一次（見 computeAsiaPremarket）。
// ⚠預測力為**初步**（n=54 交易日），實證數字與警語都在 payload 內。非投資建議。
export const GET = (request: Request) => latestDoc('asiaPremarket', 'intraday', { request });
