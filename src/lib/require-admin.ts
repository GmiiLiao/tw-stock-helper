// ============================================================
// 管理員授權閘門（server-only）
//
// 信任邊界：**只有經過 verifyIdToken() 的 uid 可以拿來查權限。**
// request body / query / 自訂 header 裡的 uid、email 一律視為可偽造字串 ——
// 呼叫端寫什麼就是什麼，等於讓攻擊者自己宣告自己是管理員。
//
// 2026-07-31 稽核發現：`/api/ai-analysis` 的 POST 雖已改成只信 Firestore 讀出的
// userData，但 `uid` 本身仍來自 body（知道管理員 uid 就能通過）；
// GET 與 DELETE 則完全沒有任何授權，DELETE 可被匿名呼叫清空訊息佇列。
// 這支 helper 是三者共用的修法。
// ============================================================

import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export type AdminCheck =
  | { ok: true; uid: string; email: string | null; level: string }
  | { ok: false; status: 401 | 403 | 503; error: string };

const ADMIN_EMAIL = process.env.NEXT_PUBLIC_ADMIN_EMAIL || 'nicholas@gmii.tw';

/**
 * 驗證 `Authorization: Bearer <Firebase ID token>` 並確認該帳號具管理員權限。
 *
 * 回傳 discriminated union，呼叫端據此決定 401 / 403 / 503，
 * 不在這裡直接組 NextResponse，方便各 route 附加自己的錯誤內容。
 */
export async function requireAdmin(request: Request): Promise<AdminCheck> {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, error: 'Missing bearer token' };

  const auth = getAdminAuth();
  const db = getAdminDb();
  if (!auth || !db) return { ok: false, status: 503, error: 'Auth unavailable' };

  let uid: string;
  let tokenEmail: string | null = null;
  try {
    // checkRevoked=true：帳號被停用或 token 被撤銷時立即失效，不等 1 小時到期
    const decoded = await auth.verifyIdToken(token, true);
    uid = decoded.uid;
    // 站主身分只認「已驗證的 token email」（2026-09-28 WM-SCAN G1-01）
    tokenEmail = decoded.email && decoded.email_verified ? decoded.email : null;
  } catch (e) {
    // G1-12：只有 token 本身的問題才回 401；驗證服務暫時失效（網路、憑證抓取）回 503，前端可重試
    const code = (e as { code?: string })?.code || '';
    if (/auth\/(id-token-expired|id-token-revoked|argument-error|invalid-id-token|user-disabled|user-not-found)/.test(code)) {
      return { ok: false, status: 401, error: 'Invalid or expired token' };
    }
    console.error('[requireAdmin] verifyIdToken 非 token 錯誤', code || (e as Error)?.message);
    return { ok: false, status: 503, error: 'Auth temporarily unavailable' };
  }

  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return { ok: false, status: 403, error: 'User not found' };

  const data = snap.data() ?? {};
  const level = String(data.level ?? '');
  // ⚠ 2026-09-28 WM-SCAN G1-01（提權漏洞）：原本比對 users/{uid}.email，但該欄是使用者自己可寫的
  //   ⇒ 任何登入者把 email 欄改成站主信箱就通過所有管理 API。現在站主身分只看 verifyIdToken 的
  //   已驗證 email；level 欄由 rules 鎖定（只有管理員／Admin SDK 能改），仍可作為授權依據。
  const isAdmin = level === 'superadmin' || level === 'admin' || tokenEmail === ADMIN_EMAIL;
  if (!isAdmin) return { ok: false, status: 403, error: 'Permission denied' };

  return { ok: true, uid, email: tokenEmail, level };
}
