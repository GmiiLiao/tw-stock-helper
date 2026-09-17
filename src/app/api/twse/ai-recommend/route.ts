import { NextRequest, NextResponse } from 'next/server';
import { gzipJsonAuto } from '@/lib/gzip-response';
import { getStockDayAllDataInternal } from '@/lib/twse-api-server';
import { parseStock, scoreStock, fetchRiskStocks, isRegularStock, SCORING_VERSION } from '@/lib/scoring-server';
import { getInstWeights } from '@/lib/inst-weight-server';
import { getFinWeights } from '@/lib/fin-server';
import { getRecommendAdj } from '@/lib/recommend-adj-server';
import { getAdminDb } from '@/lib/firebase-admin';

export const runtime = 'nodejs'; // firebase-admin（法人加權）需 Node runtime

// ============================================================
// AI Stock Recommendation Engine v2
// Thin route — all scoring math lives in lib/scoring-server.ts
// (single source of truth, shared with /api/rating).
// ============================================================

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get('mode') || 'daily';

  try {
    // 評分只用最近一個完整交易日的官方收盤資料（closeOnly）——
    // 盤中即時漲跌/未完成量能會讓五大因子失真，推薦分數與盤前不一致。
    const [rawData, riskData, iw, fw, adj] = await Promise.all([
      getStockDayAllDataInternal({ closeOnly: true }),
      fetchRiskStocks(),
      getInstWeights(), // 四大法人加權（回測驗證·保守，t-1 PIT 安全）
      getFinWeights(),  // 財報體質加權（2事件回測：重罰低分輕獎高分）
      getRecommendAdj(),// 已驗證訊號修正量（daemon 算·見 recommend-adj-server 檔頭）
    ]);
    // memoize 失敗會回 null（負快取）——降級成「只用五大因子」而不是整頁壞掉。
    // Ⓐ 本身兩窗超額也都是正的，降級後仍可用，只是少了避開型訊號。
    const ADJ = adj ?? { map: {} as Record<string, { a: number; w: string[] }>, weight: 3, date: null, bearDay: null, mktChg: null };
    const dataDate = rawData[0]?.Date ?? 'unknown';

    // AI 內文判別（daemon 的來源監看管線產出）。一次讀取供整份榜單使用。
    // 使用者 2026-08-29 指示：**要依內容是利多或利空納入排序**，
    //   不是一律排除。原本我因為「係數未經 newsLift 驗證」而全部不進排序，
    //   但那等於新聞的工作完全不影響「推薦什麼」——使用者最初的抱怨正是這個。
    //   仍保留 newsLift 對答案機制持續量測，係數之後依證據調整。
    // ⚠ 只有 AI **讀完內文**的判別能進來（使用者硬規定），標題關鍵字一律不得調分。
    let nvMap: Record<string, { label: string; confidence: string; strength?: string; reason: string; revision?: string; challenged?: boolean; strengthBasis?: string; dirChecked?: boolean; strengthChecked?: boolean; unverifiedNums?: string[]; at?: number }> = {};
    try {
      const db = getAdminDb();
      const snap = db ? await db.collection('newsVerdict').doc('latest').get() : null;
      const j = snap?.data()?.verdictJson;
      if (j) nvMap = JSON.parse(j);
    } catch { /* 判別讀不到就不顯示，不影響榜單 */ }

    // 新聞判別的加減分。
    // ⚠ **口徑陷阱**（2026-08-29 我自己踩到）：一開始設 8，理由是「與個股頁的
    //   利多/高信心 ≈ +8~9 對齊」——那是錯的。個股頁的 8 分是加在 0~100 的
    //   **絕對分數**上；這裡是**排序鍵**，兩者尺度完全不同。實測前 20 名的
    //   排序鍵只跨 9.5 分、相鄰名次中位差 0.50 分 ⇒ 8 分等於跨越 **16 個名次**，
    //   一則利多就能把第 17 名推上第 1。同一個數字、不同口徑。
    // 改用實測校準：
    //   法人+財報 ×1.5  → 中位 14.25、全距 11.25
    //   已驗證訊號 ×3    → 最大 6.00、全距 6.00   ← 這是**已回測驗證**的項目
    //   新聞尚未驗證，影響力不該超過已驗證的項目 ⇒ 取 4（低於 6）。
    // 時效衰減 3 日歸零：榜單沒有個股頁那套有效期機制，
    //   不衰減的話五天前的利多會一直用滿分推它上榜。
    const NEWS_W = 4;
    const newsAdjOf = (v?: { label: string; confidence: string; strength?: string; at?: number } | null) => {
      if (!v?.label || v.label === '中性') return 0;
      const dir = v.label === '利多' ? 1 : v.label === '利空' ? -1 : 0;
      if (!dir) return 0;
      const conf = v.confidence === '高' ? 1 : v.confidence === '中' ? 0.7 : 0.4;
      // 強度／1.2 ⇒ 以「中」為基準的相對倍率，讓 NEWS_W 的語意維持不變
      const str = (v.strength === '極強' ? 3 : v.strength === '強' ? 2 : v.strength === '弱' ? 0.6 : 1.2) / 1.2;
      const ageD = v.at ? (Date.now() - v.at) / 86400000 : 99;
      const decay = ageD >= 3 ? 0 : 1 - ageD / 3;
      return +(dir * conf * str * decay * NEWS_W).toFixed(2);
    };

    const stocks = rawData.filter(isRegularStock).map(d => parseStock(d));
    // 每檔附 instW/finW（透明呈現）；排序鍵 = 技術評分 + (法人加權+財報加權)×1.5
    const scored = stocks.map(s => {
      const r = scoreStock(s, mode, riskData);
      const f = fw.map[r.code];
      const a = ADJ.map[r.code];
      return { ...r, instW: iw.map[r.code] ?? 0, instW2: iw.map2?.[r.code] ?? 0, finW: f?.w ?? 0, finScore: f?.s ?? null, pe: f?.pe ?? null,
        // 已驗證訊號修正量與其理由（透明呈現：使用者看得到為什麼被加/扣）
        adj: a?.a ?? 0, adjWhy: a?.w ?? [],
        // 新聞判別與它對排序的實際加減分（透明呈現：使用者看得到為什麼被加/扣）
        newsVerdict: nvMap[r.code]
          ? {
              label: nvMap[r.code].label, confidence: nvMap[r.code].confidence,
              // 強度＝預期的市場反應大小。只顯示利多/利空看不出量級，
              // 而量級正是這份判別能用來跨個股比較的原因。
              strength: nvMap[r.code].strength ?? null,
              reason: nvMap[r.code].reason,
              // 挑戰是否執行過與修正說明——讓使用者看得出這是「多輪挑戰後的定案」
              // 還是「一次性判斷」，也才分得出模型有沒有敷衍。
              challenged: !!nvMap[r.code].challenged,
              revision: nvMap[r.code].revision ?? null,
              // 強度依據＝原文中支撐這個權重的具體事實。
              // 只看「強度：強」使用者無從判斷可不可信，看到依據才能自己評估。
              strengthBasis: nvMap[r.code].strengthBasis ?? null,
              // 防幻想管線走過哪幾關——沒走完的判別可信度本來就較低
              checked: !!nvMap[r.code].dirChecked && !!nvMap[r.code].strengthChecked,
              unverifiedNums: nvMap[r.code].unverifiedNums ?? null,
            }
          : null,
        newsAdj: newsAdjOf(nvMap[r.code]) };
    });
    // ── 排序鍵（2026-08-05 依對決結果定版）────────────────────────
    // 五大因子(修正後) + 法人/財報加權 + **已驗證訊號 × 3**。
    // ×3 是實測選出來的：×6 在主窗反而較差（Δ+0.233 vs ×3 的 +0.249）。
    // 對決全表見 recommend-adj-server.ts 檔頭與 model-core。
    const W = ADJ.weight ?? 3;
    // 2026-09-18 權值稽核 D2：法人改用修剪版 map2（只留外資方向）×0.5；財報加權 finW **不再進排序**（無回測，只顯示）。
    //   實證 screen-weights-v2.mjs（480 日·切點 06-10·每日前 20 名 vs 宇宙）：
    //   五大 樣本外 +0.29pp｜五大+法人×1.5 +0.21｜五大+法人×0.5 +0.27｜只用法人 −0.13（顯著負）。
    const INST_W = 0.5, FIN_W = 0;
    const key = (x: { score: number; instW2: number; finW: number; adj: number }) =>
      // ⚠ newsAdj **刻意不加進來**（使用者 2026-08-29 決定：先看 newsLift 再決定）。
      //   它仍會算出來並回傳，讓使用者看得到「若納入會加減幾分」，
      //   但排序目前只用已驗證的因子。
      //   實測背景：前 20 名排序鍵只跨 9.3 分 ⇒ 每 1 分約等於 3 個名次，
      //   4 分就能移動 13 個名次。未驗證的訊號不該有這種份量。
      x.score + x.instW2 * INST_W + x.finW * FIN_W + x.adj * W;
    const rank = (a: Parameters<typeof key>[0], b: Parameters<typeof key>[0]) => key(b) - key(a);


    // ── 可交易宇宙 gate（2026-08-05）──────────────────────────────
    // 推薦當日漲幅 >8.5% 者剔除：**收盤價已在漲停或貼近漲停，買不到**。
    // 實證（backfill-picks-scoreboard.mjs）：舊版 TOP20 的 5 日樣本有
    // 121/327（37%）屬於這一類，是記分板落後同期基準的最大單一來源——
    // 剔除後 5 日超額由 -2.12pp 收斂到 -0.40pp。
    // 這條 gate 與撿尾盤定版濾網、bt-core buildSamples 的 tradable 同口徑。
    const tradable = (r: { changePercent: number }) => r.changePercent <= 8.5;

    // Top 20 overall
    const recommendations = scored
      .filter(r => r.score >= 50 && tradable(r))
      .sort(rank)
      .slice(0, 20);

    // Strategy buckets（同樣套 gate——買不到的標的不該出現在任何一張推薦榜）
    const buyable = scored.filter(tradable);
    const strategies = {
      daily:     buyable.filter(s => s.strategy === 'momentum').sort(rank).slice(0, 20),
      growth:    buyable.filter(s => s.strategy === 'growth').sort(rank).slice(0, 20),
      defensive: buyable.filter(s => s.strategy === 'defensive').sort(rank).slice(0, 20),
    };

    return gzipJsonAuto({   // 2026-09-18：232KB 未壓縮 → gzip
      recommendations,
      strategies,
      totalAnalyzed: stocks.length,
      excludedLimitUp: scored.length - buyable.length,   // 因漲停買不到而剔除的檔數（誠實揭露）
      adjDate: ADJ.date, adjWeight: ADJ.weight, adjCount: Object.keys(ADJ.map).length,
      bearDay: ADJ.bearDay, mktChg: ADJ.mktChg,
      generatedAt: new Date().toISOString(),
      dataDate,
      instDate: iw.date || null, // 法人加權資料日（t-1）
      weightsVersion: { scoring: SCORING_VERSION, instWeight: iw.version, instW: INST_W, finW: FIN_W, adjW: W },   // 2026-09-18 D9：權值版本章
      mode,
      riskSummary: {
        attentionCount: riskData.attention.length,
        dispositionCount: riskData.disposition.length,
        totalRiskStocks: riskData.allCodes.length,
      },
    }, { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30' });

  } catch (error) {
    console.error('AI recommendation error:', error);
    return NextResponse.json({ error: 'Failed to generate recommendations' }, { status: 500 });
  }
}
