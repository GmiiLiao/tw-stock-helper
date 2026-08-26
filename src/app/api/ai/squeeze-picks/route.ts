import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 軋空候選（daemon 實測校準規則，見 SQUEEZE_SKILL）。只讀 Firestore。
export const GET = () => latestDoc('squeezePicks', 'intraday');
