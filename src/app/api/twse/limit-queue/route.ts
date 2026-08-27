import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 搶漲停排隊警示（買一貼漲停×賣一全空×尚未成交上去）。只讀 Firestore。
export const GET = () => latestDoc('limitQueue', 'tick');
