import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 🎯 縮量跳空漲停榜（盤中戰情分頁）。daemon 13:36 從快照定榜並推播、15:10 歸檔後重算、
// 每日對答案累積樣本外。只讀 Firestore。實測數字見 docs/ARROW-SETUP-2026-09-05.md。非投資建議。
export const GET = () => latestDoc('gapLimitUp', 'intraday');
