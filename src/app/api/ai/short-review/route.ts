import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 做空候選每日對答案（昨日榜→今日結果·前瞻累積）。只讀 Firestore。非投資建議。
export const GET = () => latestDoc('shortReview', 'daily');
