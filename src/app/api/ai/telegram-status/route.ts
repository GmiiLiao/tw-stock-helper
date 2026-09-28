import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { rateLimit } from '@/lib/rate-limit';
export const runtime = 'nodejs';

// Firebase Auth uid：英數，實務上 28 碼；保留 10~64 的既有口徑。
const UID_RE = /^[A-Za-z0-9]{10,64}$/;
// G1-16：uid 來自 query 且此 route no-store（每次都打 Firestore 兩讀）⇒ 需要限流。
// 前端 PushSetup 每 15 秒輪詢一次（每人每分鐘 4 次）；60 容納同一 NAT 後多人。
const RATE_LIMIT_PER_MIN = 60;

// Telegram 綁定狀態：botUsername(組 deep link 用) + 該 uid 是否已綁定
export async function GET(request: NextRequest) {
  const limited = await rateLimit(request, 'telegram-status', RATE_LIMIT_PER_MIN);
  if (limited) return limited;
  const uid = request.nextUrl.searchParams.get('uid') || '';
  const db = getAdminDb();
  if (!db || !UID_RE.test(uid)) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const [cfg, link] = await Promise.all([
      db.collection('config').doc('telegram').get(),
      db.collection('users').doc(uid).collection('data').doc('telegram').get(),
    ]);
    return NextResponse.json({
      botUsername: cfg.data()?.botUsername || null,
      linked: !!link.data()?.chatId,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    console.error('[telegram-status] Firestore read failed:', e);
    return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  }
}
