import { NextRequest, NextResponse } from 'next/server';
import { secretEquals } from '@/lib/cron-auth';
import { getStockDayAllDataInternal, isTradingDay } from '@/lib/twse-api-server';
import { parseStock, scoreStock, fetchRiskStocks, isRegularStock } from '@/lib/scoring-server';
import {
  getValuationMap, getMarginMap, getInstitutionalMap, deriveFundamentalSignals,
  type Valuation, type Margin, type Institutional,
} from '@/lib/fundamentals-server';
import { enrichScoredStock } from '@/lib/analysis-enrich';
import { appendTodayBars, readHistories, type DailyBar } from '@/lib/history-store';
import { writeMarketReport, type MarketReport, type ReportPick } from '@/lib/report-store';
import { splitRowsByDate, officialBarRows } from '../../../../../scripts/lib/tpex-close-parse.mjs';
import { readTpexClose } from '@/lib/tpex-close-store';

export const runtime = 'nodejs';
export const maxDuration = 120; // heavy batch job; see firebase.json timeoutSeconds

// ============================================================
// POST /api/cron/daily-close  — after-close batch job (Phase 3)
//
// 1. Guards: CRON_SECRET + trading-day (override with ?force=1).
// 2. Incremental history append: today's bar → each stored stock.
// 3. Whole-market base scoring + market breadth.
// 4. Enrich the top-N candidates (MA zones + fundamentals + vol sells).
// 5. Persist a 盤勢分析 report (marketReports/{date} + /latest).
//
// Schedule via Cloud Scheduler → POST with `x-cron-secret` header on
// trading days after 14:00 Taipei. Idempotent (safe to re-run).
// ============================================================

function rocToIso(roc: string): string {
  // "1150618" → "2026-06-18"
  const m = roc?.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (!m) return '';
  return `${parseInt(m[1], 10) + 1911}-${m[2]}-${m[3]}`;
}

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // 安全修正 (2026-07-30)：原本 `if (!secret) return true` 是 fail-open ——
  // 忘了設環境變數就等於整支端點全開，而這支會跑 120 秒的全市場批次
  // 加上 Firestore bulkWriter 大量寫入。改成 fail-closed。
  if (!secret) {
    if (process.env.NODE_ENV !== 'production') return true; // 本機開發仍放行
    console.error('[cron/daily-close] CRON_SECRET 未設定，拒絕執行');
    return false;
  }
  // 只收 header：原本也接受 query string，secret 會被寫進 access log。
  return secretEquals(req.headers.get('x-cron-secret'), secret);   // timing-safe，見 cron-auth.ts
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const force = request.nextUrl.searchParams.get('force') === '1';
  const topN = Math.min(100, Math.max(5, parseInt(request.nextUrl.searchParams.get('top') || '40', 10) || 40));

  if (!isTradingDay() && !force) {
    return NextResponse.json({ skipped: true, reason: 'not a trading day' });
  }

  try {
    // ── 1. Gather raw market data + fundamentals/risk in parallel ──
    const [rawData, riskData, valMap, marginMap, instRes] = await Promise.all([
      getStockDayAllDataInternal({ closeOnly: true }), // 歷史紀錄只存官方收盤，不含盤中快照
      fetchRiskStocks(),
      getValuationMap().catch(() => ({} as Record<string, Valuation>)),
      getMarginMap().catch(() => ({} as Record<string, Margin>)),
      getInstitutionalMap().catch(() => ({ map: {} as Record<string, Institutional>, date: '' })),
    ]);
    const instMap = instRes.map;
    const rocDate = rawData[0]?.Date ?? '';
    const isoDate = rocToIso(rocDate) || new Date().toISOString().slice(0, 10);

    // ── 2. Base-score the whole market + breadth ──
    // 只用「資料日＝isoDate」的列（2026-10-08）：上櫃列來自 tpexClose/latest，櫃買晚到或 daemon 尚未取得當日檔時仍是前一日——
    //   前一日的上櫃列（連同前一日的漲跌）不可算進今天的評分、漲跌家數與精選，也不可寫成今天的 K 棒（審查 MEDIUM）。
    //   日期不符的列整批排除，報告 meta.otc 與 riskHighlights 明說上櫃沒進來；沒有 Date 或認不得格式的列沿用上市資料日＝舊行為。
    const { same: regular, off: offDate } = splitRowsByDate(rawData.filter(isRegularStock), isoDate) as { same: typeof rawData; off: typeof rawData };
    if (offDate.length) console.warn(`[cron/daily-close] ${offDate.length} 列資料日與上市 ${isoDate} 不符（例：${offDate[0].Code} ${offDate[0].Date}），不列入今日評分／家數／K 棒`);
    const isOtcRow = (d: (typeof rawData)[number]) => (d as { _market?: string })._market === 'otc';
    const otcSame = regular.filter(isOtcRow).length;
    const otcOff = offDate.filter(isOtcRow);
    const otcIso: string | null = otcSame === 0 ? (rocToIso(String(otcOff[0]?.Date ?? '')) || null) : isoDate;
    const otcMeta = { included: otcSame > 0, dataDate: otcIso, excluded: offDate.length };
    const scored = regular.map(d => scoreStock(parseStock(d), 'daily', riskData));

    let up = 0, down = 0, flat = 0;
    for (const d of regular) {
      const chg = parseFloat(d.Change) || 0;
      if (chg > 0) up++; else if (chg < 0) down++; else flat++;
    }
    const total = regular.length;

    // ── 3. Incremental history append (no-op until backfill seeds docs) ──
    // 歷史 K 棒只收官方收盤（2026-10-08）：上櫃列若來自 daemon 第三方後備，不寫成 K 棒。兩道判斷（officialBarRows）：
    //   ① 列上的 _grade≠official（twse-api-server 兩個出口都帶，2026-10-08 審查 MEDIUM 補上）；
    //   ② 防線：tpexClose 文件（memoize，與上面取列同一份快取，通常 0 次額外讀取）同資料日是 3P ⇒ 上櫃列一律排除。
    //   ⚠ daily-close 只寫「這一次」的 isoDate K 棒：官方之後到了，D 日上櫃 K 棒不會由下一次 daily-close 補（下一次寫的是 D+1），
    //   要靠 scripts/topup-stock-history.mjs 回補。評分／家數照用 3P（價與官方逐位相同）。
    const otcDoc = await readTpexClose();
    const { keep: officialRows, thirdParty: thirdPartyRows } = officialBarRows(regular, { iso: isoDate, otcDoc }) as { keep: typeof rawData; thirdParty: typeof rawData };
    if (thirdPartyRows.length) console.warn(`[cron/daily-close] ${thirdPartyRows.length} 列上櫃來自第三方後備（grade 3P）——不寫歷史 K 棒（官方到了要跑 topup-stock-history 補）`);
    // 上櫃第三方後備來源註記（2026-10-09 使用者裁定 A）：這些列雖不寫 K 棒，但已進了上面的評分／家數（regular）⇒ 報告 meta.otc 標 grade，
    //   盤勢報告畫面據此加註；官方時不加鍵（報告形狀不變）。重跑 daily-close（官方已到）會整份覆蓋，旗標隨之消失。
    const otcGrade = thirdPartyRows.length ? (thirdPartyRows[0]._grade || otcDoc?.grade || null) : null;
    const otcReportMeta = otcGrade ? { ...otcMeta, grade: otcGrade } : otcMeta;
    const barEntries = officialRows
      .map(d => {
        const bar: DailyBar = {
          d: isoDate,
          o: parseFloat(d.OpeningPrice) || 0,
          h: parseFloat(d.HighestPrice) || 0,
          l: parseFloat(d.LowestPrice) || 0,
          c: parseFloat(d.ClosingPrice) || 0,
          v: parseInt((d.TradeVolume || '0').replace(/,/g, ''), 10) || 0,
        };
        return { code: d.Code, name: d.Name, bar };
      })
      .filter(e => e.bar.c > 0);
    const appendResult = await appendTodayBars(barEntries).catch(e => {
      console.warn('[cron] appendTodayBars failed', e);
      return { updated: 0, skipped: barEntries.length };
    });

    // ── 4. Enrich top-N candidates ──
    const candidates = scored
      .filter(s => s.score >= 50 && !s.isDisposition)
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    const candidateCodes = candidates.map(s => s.code);
    const histories = await readHistories(candidateCodes);

    const enrichedPicks = candidates.map(base => {
      const bars = histories.get(base.code)?.bars ?? null;
      const fund = deriveFundamentalSignals(
        valMap[base.code] ?? null,
        marginMap[base.code] ?? null,
        instMap[base.code] ?? null,
      );
      return enrichScoredStock(base, bars && bars.length >= 20 ? bars : null, fund);
    });

    // Re-rank by the enriched score and shape into report picks
    const topPicks: ReportPick[] = enrichedPicks
      .sort((a, b) => b.stock.score - a.stock.score)
      .slice(0, Math.min(15, topN))
      .map(({ stock }) => ({
        code: stock.code,
        name: stock.name,
        score: stock.score,
        grade: stock.grade,
        signal: stock.signal,
        price: stock.price,
        changePercent: stock.changePercent,
        buy: stock.buyZones.find(z => z.type === 'standard')?.price ?? stock.buyZones[0]?.price ?? null,
        target: stock.sellTargets.find(t => t.type === 'tp1')?.price ?? null,
        stopLoss: stock.stopLoss ?? null,
        reasons: stock.reasons.slice(0, 4),
      }));

    // ── 5. Risk highlights + summary ──
    const riskHighlights: string[] = [];
    // G2-10：處置名單殘缺時 !s.isDisposition 篩不掉處置股，要在報告上明說（signal 已由 scoreStock 壓成 WATCH）
    if (!riskData.dispositionComplete) {
      console.warn('[cron/daily-close] 處置名單殘缺（來源故障），精選名單未能排除處置股');
      riskHighlights.push('⚠️ 處置股名單本次未能完整取得，精選名單可能含處置股，交易前請自行查核');
    }
    if (!otcMeta.included) riskHighlights.push(otcMeta.dataDate
      ? `⚠️ 上櫃收盤資料日 ${otcMeta.dataDate} 與上市 ${isoDate} 不同（櫃買晚出或尚未取得），本報告的漲跌家數與精選只含上市`
      : '⚠️ 上櫃收盤本次未取得，本報告的漲跌家數與精選只含上市');
    if (riskData.disposition.length) riskHighlights.push(`🔴 處置股票 ${riskData.disposition.length} 檔`);
    if (riskData.attention.length) riskHighlights.push(`🟡 注意股票 ${riskData.attention.length} 檔`);
    const overheated = candidates.filter(s => (marginMap[s.code]?.utilization ?? 0) >= 80).length;
    if (overheated) riskHighlights.push(`🔥 入選股中 ${overheated} 檔融資使用率 ≥80%`);

    const advancePct = total ? parseFloat(((up / total) * 100).toFixed(1)) : 0;
    const tone = advancePct >= 60 ? '偏多' : advancePct <= 40 ? '偏空' : '中性震盪';
    const summary =
      `收盤盤勢${tone}：上漲 ${up} / 下跌 ${down} / 持平 ${flat}（漲家數佔 ${advancePct}%）。` +
      `全市場分析 ${total} 檔，精選 ${topPicks.length} 檔強勢標的。` +
      (enrichedPicks.some(e => e.enriched.buyZones) ? '買賣點已套用均線支撐與波動度模型。' : '（歷史庫尚未回填，買賣點暫用技術面估算。）');

    const report: MarketReport = {
      date: isoDate,
      generatedAt: Date.now(),
      breadth: { up, down, flat, total, advancePct },
      topPicks,
      riskHighlights,
      summary,
      meta: {
        totalAnalyzed: total,
        enriched: enrichedPicks.filter(e => e.enriched.buyZones).length,
        historyCovered: histories.size,
        dispositionComplete: riskData.dispositionComplete,
        otc: otcReportMeta,
      },
    };

    let persisted = true;
    try {
      await writeMarketReport(report);
    } catch (e) {
      persisted = false;
      console.warn('[cron] writeMarketReport failed (admin creds?)', e);
    }

    return NextResponse.json({
      ok: true,
      date: isoDate,
      persisted,
      historyAppend: appendResult,
      breadth: report.breadth,
      topPicksCount: topPicks.length,
      meta: report.meta,
      report: persisted ? undefined : report, // return inline if not persisted
    });
  } catch (error) {
    console.error('[cron/daily-close] error', error);
    return NextResponse.json({ error: 'daily-close job failed' }, { status: 500 });
  }
}

// 安全修正 (2026-07-30)：GET 只在非 production 開放。
// 原本 production 也能用 GET 觸發 120 秒批次作業，任何人都能無限打。
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }
  return POST(request);
}
