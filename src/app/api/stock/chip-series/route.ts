import { NextRequest } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { memoize } from '@/lib/singleflight';
import { cacheHeader } from '@/lib/api-cache';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// 個股 K 線副圖用的籌碼序列（法人 / 融資券 / 千張大戶）。
//
// 不變式：只讀 Firestore（chipArchive / tdccArchive），零上游請求。
// 全市場索引 memoize 到 instance —— 逐檔查詢若各自去讀 120 份 chipArchive
// 文件（每份 ~150KB）就是每次請求搬 18MB，這裡改成整個 instance 共用一份
// 打包好的索引：120 天 × ~2,900 檔 × 4 欄位以 Int32Array 存 ~5MB。
//
// 欄位語意（與 daemon 歸檔端一致，勿臆測）：
//   instJson[code]   = [外資買賣超, 投信買賣超]  單位：張（日資料）
//   marginJson[code] = [融資餘額, 融券餘額]      單位：張（日資料，是**餘額**不是買賣超）
//   tdccArchive.distJson[code].r[14] = 千張以上持股占比 %（週資料）
const DAYS = 160;

interface ChipIndex {
  dates: string[];
  idx: Record<string, number>;
  fgn: Int32Array; trust: Int32Array; mgn: Int32Array; shrt: Int32Array;
  hasInst: boolean[]; hasMargin: boolean[];
  archDate: string | null;
}

const getChipIndex = memoize('chip-series-index', 3 * 3600_000, async (): Promise<ChipIndex> => {
  const db = getAdminDb();
  if (!db) throw new Error('admin db unavailable');
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(DAYS).get();
  // 只留真的有籌碼欄位的日子。⚠ 當日文件是分批長出來的，空殼若原樣入列，
  // 之後每一天都會往後位移一格（CLAUDE.md 記載已重演兩次的錯誤）。
  const docs = snap.docs
    .map(d => d.data() as { date: string; instJson?: string; marginJson?: string })
    .filter(a => a && a.date && (a.instJson || a.marginJson))
    .reverse();

  const dates = docs.map(d => d.date);
  // ⚠ 逐欄位的「有沒有」必須分開記（2026-08-26 實案）：當日文件是**分批**長出來的
  //   —— 法人 15:00 後、資券 21:45 才寫。只看「文件存在」就把缺的欄位補 0，
  //   畫面會出現「融資餘額 0、融券 0」＝全數回補完畢，那是憑空捏造的爆炸性訊號
  //   （台虹 8039 昨日融資 25,941 今日顯示 0）。缺資料要回 null，不是 0。
  const hasInst: boolean[] = docs.map(d => !!d.instJson);
  const hasMargin: boolean[] = docs.map(d => !!d.marginJson);
  const codeSet = new Set<string>();
  const parsed = docs.map(d => {
    let inst: Record<string, number[]> = {}, margin: Record<string, number[]> = {};
    try { inst = d.instJson ? JSON.parse(d.instJson) : {}; } catch { /* 壞的當空 */ }
    try { margin = d.marginJson ? JSON.parse(d.marginJson) : {}; } catch { /* 壞的當空 */ }
    for (const c in inst) codeSet.add(c);
    for (const c in margin) codeSet.add(c);
    return { inst, margin };
  });

  const codes = [...codeSet];
  const idx: Record<string, number> = {};
  codes.forEach((c, i) => { idx[c] = i; });
  const n = codes.length, m = dates.length;
  const fgn = new Int32Array(n * m), trust = new Int32Array(n * m);
  const mgn = new Int32Array(n * m), shrt = new Int32Array(n * m);
  for (let t = 0; t < m; t++) {
    const { inst, margin } = parsed[t];
    for (const c in inst) {
      const i = idx[c]; if (i === undefined) continue;
      const v = inst[c];
      fgn[i * m + t] = Math.round(v?.[0] ?? 0);
      trust[i * m + t] = Math.round(v?.[1] ?? 0);
    }
    for (const c in margin) {
      const i = idx[c]; if (i === undefined) continue;
      const v = margin[c];
      mgn[i * m + t] = Math.round(v?.[0] ?? 0);
      shrt[i * m + t] = Math.round(v?.[1] ?? 0);
    }
  }
  return { dates, idx, fgn, trust, mgn, shrt, hasInst, hasMargin, archDate: dates[dates.length - 1] || null };
}, { timeoutMs: 60_000 });

// 千張大戶（週）：tdccArchive 每週一份全市場 15 分級，r[14] 是千張以上占比。
const getTdccIndex = memoize('chip-series-tdcc', 6 * 3600_000, async () => {
  const db = getAdminDb();
  if (!db) return { weeks: [] as string[], byCode: {} as Record<string, number[]> };
  const snap = await db.collection('tdccArchive').orderBy('date', 'desc').limit(60).get();
  const docs = snap.docs.map(d => d.data() as { date: string; distJson?: string })
    .filter(a => a?.distJson).reverse();
  const weeks = docs.map(d => d.date);
  const byCode: Record<string, number[]> = {};
  docs.forEach((d, t) => {
    let dist: Record<string, { r?: number[] }> = {};
    try { dist = JSON.parse(d.distJson as string); } catch { return; }
    for (const c in dist) {
      const r = dist[c]?.r;
      if (!Array.isArray(r) || r.length < 15) continue;
      (byCode[c] ||= new Array(weeks.length).fill(0))[t] = r[14];   // 第15級=千張以上
    }
  });
  // 補齊長度（後來才出現的股票前面補 0）
  for (const c in byCode) while (byCode[c].length < weeks.length) byCode[c].push(0);
  return { weeks, byCode };
}, { timeoutMs: 60_000 });

export async function GET(req: NextRequest) {
  const code = (req.nextUrl.searchParams.get('code') || '').trim();
  if (!/^\d{4}[A-Z]?$/.test(code)) return NextResponse.json({ error: 'bad code' }, { status: 400 });
  try {
    const [ix, td] = await Promise.all([getChipIndex(), getTdccIndex()]);
    if (!ix || !td) return NextResponse.json({ error: 'index unavailable' }, { status: 503 });
    const i = ix.idx[code];
    const m = ix.dates.length;
    const daily = i === undefined ? [] : ix.dates.map((d, t) => ({
      date: d,
      // 該日該欄位沒歸檔 → null（「不知道」），絕不可寫 0（「是零」）
      fgn: ix.hasInst[t] ? ix.fgn[i * m + t] : null,
      trust: ix.hasInst[t] ? ix.trust[i * m + t] : null,
      inst: ix.hasInst[t] ? ix.fgn[i * m + t] + ix.trust[i * m + t] : null,
      mgn: ix.hasMargin[t] ? ix.mgn[i * m + t] : null,     // 融資餘額（張）
      shrt: ix.hasMargin[t] ? ix.shrt[i * m + t] : null,   // 融券餘額（張）
    })) as Array<{ date: string; fgn: number | null; trust: number | null; inst: number | null; mgn: number | null; shrt: number | null; mgnChg?: number | null; shrtChg?: number | null }>;
    // 融資券是**餘額**，看趨勢要的是日增減 → 一併給出，前端可直接畫柱狀
    for (let t = daily.length - 1; t > 0; t--) {
      const cur = daily[t], prev = daily[t - 1];
      // 跨過缺漏日就不要硬算增減——那會把「兩天的變化」誤標成「一天的變化」
      cur.mgnChg = cur.mgn != null && prev.mgn != null ? cur.mgn - prev.mgn : null;
      cur.shrtChg = cur.shrt != null && prev.shrt != null ? cur.shrt - prev.shrt : null;
    }
    if (daily[0]) { daily[0].mgnChg = null; daily[0].shrtChg = null; }

    const ratios = td.byCode[code] || [];
    const holders = td.weeks.map((w, t) => ({ week: w, ratio: ratios[t] ?? 0 }))
      .filter(x => x.ratio > 0);

    return NextResponse.json(
      {
        code, daily, holders,
        archDate: ix.archDate,
        // 誠實揭露：千張大戶是**週**資料，且本站自 tdccArchive 首週起才有；
        // 前端要據此標示「資料自 X 起累積」，不要讓使用者以為是完整歷史。
        holdersFrom: holders[0]?.week || null,
        holdersNote: '千張大戶為集保週資料（每週一次），本站自歸檔首週起累積',
      },
      { headers: { 'Cache-Control': cacheHeader('daily') } },
    );
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || 'failed' }, { status: 500 });
  }
}
