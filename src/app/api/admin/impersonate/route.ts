import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/require-admin';
import { getAdminDb } from '@/lib/firebase-admin';
import { PRICE_ALERTS_DOC, resolvePriceAlerts, withPriceAlerts } from '../../../../../scripts/lib/alerts-split.mjs';

// ── 🎭 身分模擬（superadmin 專用·唯讀）─────────────────────────────
//
// 緣起：2026-08-06 的「投資組合整頁白畫面」事故——只持有 1 檔的高級會員必中，
//   但管理員自己的帳號持股多檔，怎麼點都正常，訪客模式又根本走不到那條路徑。
//   ⇒ **看不到會員實際看到的畫面，就查不出這一類 bug**。
//
// 設計原則（三條，缺一不可）：
//   ① **授權只認 verifyIdToken**：走 requireAdmin，uid/email 一律不從 body 或 query 取
//      （query 的 uid 只用來指定「要看誰」，不用來判斷「我是誰」）。
//   ② **唯讀**：本 route 只有 GET，不提供任何寫入；前端進入模擬後也會全面封鎖同步寫入，
//      避免管理員手滑改到會員的持倉。
//   ③ **留痕**：每次讀取都寫 activity_logs，管理員看了誰的資料有紀錄可查。
//
// 回傳除了會員的實際資料，還附 diagnostics——列出各 daemon 文件的欄位齊備狀況，
// 因為今天這個 bug 的本質就是「文件只有一半欄位」，肉眼看畫面不一定看得出來。

export const dynamic = 'force-dynamic';

const DAEMON_DOCS = [
  'portfolioAnalysis', 'portfolioRisk', 'rotation', 'theses', 'rebalance',
  'shadowAccount', 'weeklyReport', 'monthlyReport', 'dailySummary',
  'defenseReport', 'tradeReview', 'cashLedger', 'alertRules',
];

// portfolioRisk 曾因兩個技能共寫而只剩一半欄位 → 明確列出必要欄位做健檢
const REQUIRED_FIELDS: Record<string, string[]> = {
  portfolioRisk: ['avgCorrelation', 'concentrationHHI', 'topSector'],
  portfolioAnalysis: ['analyses'],
  rotation: ['items'],
  rebalance: ['weights'],
};

export async function GET(request: Request) {
  const gate = await requireAdmin(request);
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const db = getAdminDb();
  if (!db) return NextResponse.json({ error: 'DB unavailable' }, { status: 503 });

  const url = new URL(request.url);
  const target = url.searchParams.get('uid');

  // 清單模式：列出可模擬的會員＋各自的資料量（挑「1 檔持股」這種邊界情境用）
  if (!target) {
    const snap = await db.collection('users').orderBy('lastLogin', 'desc').limit(60).get();
    const members = await Promise.all(snap.docs.map(async d => {
      const u = d.data();
      const [hd, td] = await Promise.all([
        db.collection('users').doc(d.id).collection('data').doc('holdings').get(),
        db.collection('users').doc(d.id).collection('data').doc('trades').get(),
      ]);
      return {
        uid: d.id, email: u.email ?? null, level: u.level ?? 'registered',
        lastLogin: u.lastLogin ?? null,
        holdings: hd.exists ? (hd.data()?.holdings?.length ?? 0) : 0,
        trades: td.exists ? (td.data()?.tradeRecords?.length ?? 0) : 0,
      };
    }));
    return NextResponse.json({ members }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (!/^[A-Za-z0-9]{10,64}$/.test(target)) {
    return NextResponse.json({ error: 'Bad uid' }, { status: 400 });
  }

  const userSnap = await db.collection('users').doc(target).get();
  if (!userSnap.exists) return NextResponse.json({ error: 'Member not found' }, { status: 404 });
  const u = userSnap.data() ?? {};

  const ref = (n: string) => db.collection('users').doc(target).collection('data').doc(n);
  const [wl, hd, td, al, nt, pa] = await Promise.all(
    ['watchlist', 'holdings', 'trades', 'alerts', 'notifications', PRICE_ALERTS_DOC].map(n => ref(n).get())
  );
  // 價位警示 2026-10-05 起拆到 priceAlerts（critique H3）；尚未遷移的帳號仍在舊 alerts 文件——與登入時 loadPriceAlerts 同一套解析
  const legacyAlertsDoc = al.exists ? (al.data() ?? null) : null;
  const priceAlertList = resolvePriceAlerts({
    priceDoc: pa.exists ? (pa.data() ?? null) : null, legacyDoc: legacyAlertsDoc, localAlerts: [],
  }).list;

  // 各 daemon 文件的欄位健檢——缺欄位正是前端崩潰的來源
  const diagnostics: Array<{ doc: string; exists: boolean; missing: string[]; keys: number }> = [];
  const docs = await Promise.all(DAEMON_DOCS.map(n => ref(n).get()));
  docs.forEach((s, i) => {
    const name = DAEMON_DOCS[i];
    const data = s.exists ? (s.data() ?? {}) : {};
    const need = REQUIRED_FIELDS[name] ?? [];
    diagnostics.push({
      doc: name, exists: s.exists, keys: Object.keys(data).length,
      missing: s.exists ? need.filter(f => data[f] === undefined) : [],
    });
  });

  // 留痕（失敗不擋主流程——查不到資料比沒有日誌更糟）
  db.collection('activity_logs').add({
    type: 'admin_impersonate_read', adminUid: gate.uid, adminEmail: gate.email,
    targetUid: target, targetEmail: u.email ?? null, timestamp: Date.now(),
  }).catch((e) => {
    // G1-14：稽核紀錄寫入失敗不擋回應，但不可靜默——要留下可 grep 的 log。
    console.error('[admin/impersonate] audit log write failed:', { adminUid: gate.uid, targetUid: target }, e);
  });

  return NextResponse.json({
    profile: { uid: target, email: u.email ?? null, level: u.level ?? 'registered', lastLogin: u.lastLogin ?? null },
    data: {
      watchlist: wl.exists ? (wl.data()?.watchlist ?? []) : [],
      watchlistGroups: wl.exists ? (wl.data()?.watchlistGroups ?? []) : [],
      holdings: hd.exists ? (hd.data()?.holdings ?? []) : [],
      tradeRecords: td.exists ? (td.data()?.tradeRecords ?? []) : [],
      alerts: withPriceAlerts(legacyAlertsDoc?.alerts ?? [], priceAlertList),
      notifications: nt.exists ? (nt.data()?.notifications ?? []) : [],
    },
    diagnostics,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
