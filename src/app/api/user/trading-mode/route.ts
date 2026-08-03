import { NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { isModeKey } from '@/lib/trading-mode';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/user/trading-mode —— 寫入使用者的操作模式（隔日沖/波段/當沖）。
//
// 為什麼要有這支：模式存 localStorage 就夠前端用了，但 **daemon 的問AI 技能注入
// 讀的是 users/{uid}.tradingMode**。只存本地會造成「網頁顯示波段、AI 卻用隔日沖
// 口徑回答」——那正是模式化要解決的問題本身。
//
// 信任邊界（同 require-admin 的規則）：**uid 只能來自 verifyIdToken()**。
// body 裡的 uid/email 一律視為可偽造字串，否則等於任何人都能改別人的模式。
export async function POST(request: Request) {
  const limited = await rateLimit(request, 'trading-mode', 30);
  if (limited) return limited;

  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return NextResponse.json({ error: 'Missing bearer token' }, { status: 401 });

  const auth = getAdminAuth(), db = getAdminDb();
  if (!auth || !db) return NextResponse.json({ error: 'Auth unavailable' }, { status: 503 });

  let uid: string;
  try {
    const decoded = await auth.verifyIdToken(token, true);   // checkRevoked：停用帳號立即失效
    uid = decoded.uid;
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  let mode: unknown;
  try { mode = (await request.json())?.mode; } catch { /* 下面統一擋 */ }
  if (!isModeKey(mode)) return NextResponse.json({ error: 'Invalid mode' }, { status: 400 });

  await db.collection('users').doc(uid).set({ tradingMode: mode, tradingModeAt: Date.now() }, { merge: true });
  return NextResponse.json({ ok: true, mode }, { headers: { 'Cache-Control': 'no-store' } });
}
