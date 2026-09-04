// 部署身分（wm-deploy-drift-watchdog·WM-SCAN F10·2026-09-04）
// 「已部署」的定義＝線上回的 sha 等於本機 HEAD；部署腳本比對後才可宣稱。
// GIT_SHA 由 next.config.ts 在 build 時從 git 讀入（App Hosting 由本機 build 上傳，故有 git）。
// ?debug=1 且管理員：回 x-forwarded-for 全串與跳數，供 R6（限流取哪一跳）線上取樣；匿名只回跳數。
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const xff = request.headers.get('x-forwarded-for') || '';
  const hops = xff ? xff.split(',').length : 0;
  // 只回請求者自己的鏈（尾兩跳、末段遮罩）：拿自己的 IP 對照就能定位「client 在第幾跳」，不需管理員
  const mask = (ip: string) => ip.trim().replace(/\.\d+$/, '.x').replace(/:[0-9a-f]*:[0-9a-f]*$/i, ':x:x');
  const body: Record<string, unknown> = {
    sha: process.env.GIT_SHA || null,
    builtAt: process.env.BUILD_AT || null,
    xffHops: hops,
    xffTailMasked: xff ? xff.split(',').slice(-2).map(mask) : [],
    host: request.headers.get('host') || null,   // 分辨「經 Hosting」vs「cloudfunctions 直連」的訊號（R6）；GFE 對錯配 Host 回 404，故可信
    forwardedHeaderNames: [...request.headers.keys()].filter(k => /^(x-forwarded|forwarded|x-real-ip|fastly|via|x-served|x-client)/i.test(k)),
  };
  if (request.nextUrl.searchParams.get('debug') === '1') {
    const admin = await requireAdmin(request);
    if (!admin.ok) return NextResponse.json({ error: admin.error }, { status: admin.status, headers: { 'Cache-Control': 'no-store' } });
    body.xff = xff;
    body.forwarded = Object.fromEntries([...request.headers.entries()].filter(([k]) => /^(x-forwarded|forwarded|x-real-ip|cf-connecting-ip|fastly|via)/i.test(k)));
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}
