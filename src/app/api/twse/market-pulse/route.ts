import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 大盤即時脈動（漲跌×量能×漲停跌停家數 → 軋空環境評級）。只讀 Firestore。
export const GET = () => latestDoc('marketPulse', 'tick');
