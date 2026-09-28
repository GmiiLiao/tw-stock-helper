import { getAdminDb } from '@/lib/firebase-admin';
import { cacheHeader, unavailable } from '@/lib/api-cache';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { memoize } from '@/lib/singleflight';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// 當沖工作台交易日誌彙總（daemon 寫 daytradeJournal/{date}：所有候選與觸發，含否決、未交易）。
// 口徑依 tw-day-trading 技巧的 journal-schema：勝率＝淨R>0／有效成交；最大連敗依成交時間排序；
// 每一格都附 n——稀疏格只是假設，不直接改規則（開發集 ≥100、驗證集 ≥30 筆前不調參）。
interface Entry { code: string; name: string; side: 'long' | 'short'; type: string; t: number; bucket: string; traded: boolean; veto: string[]; netR: number | null; exit: { reason: string } | null; score?: { total: number; knownMax: number; tier: string | null } }
interface Stat { side: string; type: string; bucket: string; n: number; win: number | null; avgR: number | null; medR: number | null; maxLoss: number }

const DAYS = 20;

function stat(side: string, type: string, bucket: string, xs: Entry[]): Stat {
  const done = xs.filter(e => e.traded && e.netR != null).sort((a, b) => a.t - b.t);
  const rs = done.map(e => e.netR as number);
  let streak = 0, maxLoss = 0; for (const r of rs) { streak = r < 0 ? streak + 1 : 0; maxLoss = Math.max(maxLoss, streak); }
  const sorted = [...rs].sort((a, b) => a - b);
  return {
    side, type, bucket, n: rs.length,
    win: rs.length ? Math.round(rs.filter(r => r > 0).length / rs.length * 100) : null,
    avgR: rs.length ? +(rs.reduce((a, r) => a + r, 0) / rs.length).toFixed(2) : null,
    medR: rs.length ? sorted[Math.floor(sorted.length / 2)] : null,
    maxLoss,
  };
}

// G2-12：CDN miss 併發時合流成一次 Firestore 查詢＋彙總（TTL 60 秒 < intraday 層 2 分鐘）。
const JOURNAL_TTL_MS = 60_000;
const getJournalSummary = memoize('daytrade-journal:summary', JOURNAL_TTL_MS, buildJournalSummary);

export async function GET() {
  const db = getAdminDb();
  if (!db) return unavailable('daytrade-journal');
  // memoize 內部已吞錯並記 log；失敗且無舊值 ⇒ null（與舊版 catch 分支同樣回 null＋no-store）。
  const payload = await getJournalSummary();
  if (!payload) return unavailable('daytrade-journal');
  return gzipJsonAuto(payload, { 'Cache-Control': cacheHeader('intraday') });
}

async function buildJournalSummary() {
  const db = getAdminDb();
  if (!db) throw new Error('admin db unavailable');
  const snap = await db.collection('daytradeJournal').orderBy('date', 'desc').limit(DAYS).get();
  if (snap.empty) return { found: false } as const;
  const all: Entry[] = []; const days: string[] = []; const versions = new Set<string>();
  let latest: { date: string; entries: Entry[]; candidates: number } | null = null;
  const fb: Record<string, number> = { long: 0, short: 0 };
  for (const d of snap.docs) {
    const x = d.data() as { date: string; version?: string; entriesJson?: string; candidatesJson?: string; falseBreaksJson?: string };
    const entries = Object.values(JSON.parse(x.entriesJson || '{}')) as Entry[];
    days.push(x.date); if (x.version) versions.add(x.version);
    all.push(...entries);
    const f = JSON.parse(x.falseBreaksJson || '{}') as Record<string, number>;
    for (const k in f) { const side = k.split(':')[0]; fb[side] = (fb[side] || 0) + f[k]; }
    if (!latest) latest = { date: x.date, entries: entries.sort((a, b) => b.t - a.t), candidates: Object.keys(JSON.parse(x.candidatesJson || '{}')).length };
  }
  const stats: Stat[] = [];
  for (const side of ['long', 'short']) {
    const s = all.filter(e => e.side === side);
    stats.push(stat(side, '全部', '全部', s));
    for (const type of [...new Set(s.map(e => e.type))]) {
      stats.push(stat(side, type, '全部', s.filter(e => e.type === type)));
      for (const bucket of [...new Set(s.filter(e => e.type === type).map(e => e.bucket))].sort()) stats.push(stat(side, type, bucket, s.filter(e => e.type === type && e.bucket === bucket)));
    }
  }
  const vetoed = { long: all.filter(e => e.side === 'long' && !e.traded).length, short: all.filter(e => e.side === 'short' && !e.traded).length };
  return { found: true, days: days.sort(), versions: [...versions], stats, vetoed, falseBreaks: fb, latest } as const;
}
