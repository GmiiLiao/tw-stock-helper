import { collection, addDoc } from 'firebase/firestore';
import { db, auth } from './firebase';

// ── 近期足跡緩衝（決策歸因用）─────────────────────────────────────
// 記憶體內保留最近 30 分鐘／最多 40 筆事件；下單時隨歸因快照存檔，
// 讓「用了哪些功能得出這筆選股」可被事後分析。不落地、重整即清。
export interface FootprintEvent { action: string; details: Record<string, unknown>; t: number }
const FOOTPRINT_MAX = 40;
const FOOTPRINT_TTL = 30 * 60000;
const _footprint: FootprintEvent[] = [];
export const getFootprint = (): FootprintEvent[] => {
  const cut = Date.now() - FOOTPRINT_TTL;
  return _footprint.filter(e => e.t >= cut);
};

// Helper to check if Firebase is initialized
const isFirebaseReady = () => {
  return auth && auth.app;
};

/**
 * Logs a user activity event to Firestore /activity_logs
 * @param action The name of the action (e.g. 'navigate', 'add_watchlist')
 * @param details Metadata details for the action (e.g. { page: 'stock', code: '2330' })
 */
export const logActivity = async (action: string, details: Record<string, any> = {}) => {
  // 足跡緩衝（不需登入也記，供本機歸因；只有 Firestore 落地才要求登入）
  _footprint.push({ action, details, t: Date.now() });
  if (_footprint.length > FOOTPRINT_MAX) _footprint.splice(0, _footprint.length - FOOTPRINT_MAX);

  if (!isFirebaseReady()) return;

  const currentUser = auth.currentUser;
  if (!currentUser) return; // Only log activity for logged-in users to enforce database security rules

  try {
    const logData = {
      uid: currentUser.uid,
      email: currentUser.email,
      displayName: currentUser.displayName || currentUser.email?.split('@')[0] || '用戶',
      action,
      details,
      timestamp: Date.now(),
    };

    await addDoc(collection(db, 'activity_logs'), logData);
  } catch (err) {
    console.error('Failed to write activity log:', err);
  }
};
