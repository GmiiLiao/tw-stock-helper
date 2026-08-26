import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 軋空候選的新聞判別（開盤前 1 小時由本機 AI 讀內文後產出）。只讀 Firestore。
export const GET = () => latestDoc('squeezeRecommend', 'intraday');
