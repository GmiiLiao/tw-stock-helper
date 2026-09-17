import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 📢 公開資訊觀測站「當日重大訊息」索引（2026-09-17 新聞判讀計畫第一段）。
// daemon 07:00~23:30 每 30 分鐘抓取去重寫 mopsNews/latest（今日索引；內文在 mopsNews/{日期}）。
// 只讀 Firestore；官方第一手、未判別、未進評分。非投資建議。
export const GET = () => latestDoc('mopsNews', 'intraday');
