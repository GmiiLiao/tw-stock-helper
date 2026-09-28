// ============================================================
// 高級會員授權閘門（server-only；2026-09-28 WM-SCAN G1-07）
//
// 付費功能原本只在前端擋（元件顯示 🔒），API 對任何人公開——知道網址就拿得到全部內容。
// 規則與前端 src/lib/access.ts 相同：premium／admin／superadmin，或**註冊 14 天內的體驗期**；
// 站主身分只認已驗證的 token email（同 require-admin，G1-01）。
// 信任邊界：uid 只來自 verifyIdToken()。等級與註冊時間逐 uid 快取 5 分鐘（有界），
// 避免每次請求都讀 Firestore／Auth。
// ============================================================

import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export type PremiumCheck =
  | { ok: true; uid: string; trial: boolean }
  | { ok: false; status: 401 | 403 | 503; error: string };

const ADMIN_EMAIL = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';
const PAID_LEVELS = ['premium', 'admin', 'superadmin'];
const TRIAL_DAYS = 14;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 2000;
const _cache = new Map<string, { at: number; paid: boolean; createdAt: number | null }>();

async function profileOf(uid: string): Promise<{ paid: boolean; createdAt: number | null }> {
  const hit = _cache.get(uid);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  const db = getAdminDb(), auth = getAdminAuth();
  if (!db || !auth) throw new Error('admin unavailable');
  const [snap, user] = await Promise.all([db.collection('users').doc(uid).get(), auth.getUser(uid)]);
  const paid = PAID_LEVELS.includes(String(snap.data()?.level ?? ''));
  const createdAt = Date.parse(user.metadata.creationTime) || null;
  if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value as string);
  const v = { at: Date.now(), paid, createdAt };
  _cache.set(uid, v);
  return v;
}

export async function requirePremium(request: Request): Promise<PremiumCheck> {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, error: 'Missing bearer token' };
  const auth = getAdminAuth();
  if (!auth) return { ok: false, status: 503, error: 'Auth unavailable' };

  let uid: string, ownerEmail = false;
  try {
    const decoded = await auth.verifyIdToken(token);
    uid = decoded.uid;
    ownerEmail = !!decoded.email_verified && decoded.email === ADMIN_EMAIL;
  } catch (e) {
    const code = (e as { code?: string })?.code || '';
    if (/auth\/(id-token-expired|id-token-revoked|argument-error|invalid-id-token|user-disabled|user-not-found)/.test(code)) {
      return { ok: false, status: 401, error: 'Invalid or expired token' };
    }
    console.error('[requirePremium] verifyIdToken 非 token 錯誤', code || (e as Error)?.message);
    return { ok: false, status: 503, error: 'Auth temporarily unavailable' };
  }
  if (ownerEmail) return { ok: true, uid, trial: false };

  let p: { paid: boolean; createdAt: number | null };
  try { p = await profileOf(uid); }
  catch (e) { console.error('[requirePremium] 讀取會員資料失敗', (e as Error)?.message); return { ok: false, status: 503, error: 'Auth temporarily unavailable' }; }
  if (p.paid) return { ok: true, uid, trial: false };
  if (p.createdAt && (Date.now() - p.createdAt) / 86_400_000 < TRIAL_DAYS) return { ok: true, uid, trial: true };
  return { ok: false, status: 403, error: 'Premium required' };
}
