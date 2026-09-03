import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 做空風控候選榜（盤中戰情「🐻 空方候選」分頁）。daemon 盤中每 10 分鐘刷新、
// 盤後定榜。只讀 Firestore。第一期展示排序未經 OOT——分數僅供排列。非投資建議。
export const GET = () => latestDoc('shortCandidates', 'intraday');
