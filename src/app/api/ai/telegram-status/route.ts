import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
export const runtime = 'nodejs';

// Telegram 綁定狀態：botUsername(組 deep link 用) + 該 uid 是否已綁定
export async function GET(request: NextRequest) {
  const uid = request.nextUrl.searchParams.get('uid') || '';
  const db = getAdminDb();
  if (!db || !/^[A-Za-z0-9]{10,64}$/.test(uid)) return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } });
  try {
    const [cfg, link] = await Promise.all([
      db.collection('config').doc('telegram').get(),
      db.collection('users').doc(uid).collection('data').doc('telegram').get(),
    ]);
    return NextResponse.json({
      botUsername: cfg.data()?.botUsername || null,
      linked: !!link.data()?.chatId,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json(null, { headers: { 'Cache-Control': 'no-store' } }); }
}
