// 從其他頁導進盤中戰情 v2 時，順便指定要打開的放大層（例：決策工作台「去即時漲跌撿股」⇒ 漲跌分布）。
// 刻意獨立成小模組：呼叫端（DecisionDesk 等）只 import 這支，不把戰情 v2 的匯流排與 context 打進自己的 bundle。
// 規則：請求只在 30 秒內有效、只被取用一次（WarRoomProvider 掛載時取）；戰情 v2 沒掛起來（會員鎖、舊版）就自然過期。
import type { ZoomTarget } from './WarRoomContext';

const PENDING_ZOOM_TTL_MS = 30_000;   // 涵蓋戰情 v2 分塊在慢速網路下的載入時間
let pending: { target: ZoomTarget; at: number } | null = null;

/** 記下「下次進戰情 v2 要打開的放大層」（呼叫端接著 navigateTo('war')） */
export function requestWarZoom(target: ZoomTarget): void {
  pending = { target, at: Date.now() };
}

/** 取出並清掉待開的放大層；逾時或沒有回 null（只給 WarRoomProvider 掛載時呼叫） */
export function takePendingZoom(): ZoomTarget | null {
  const p = pending;
  pending = null;
  return p && Date.now() - p.at <= PENDING_ZOOM_TTL_MS ? p.target : null;
}
