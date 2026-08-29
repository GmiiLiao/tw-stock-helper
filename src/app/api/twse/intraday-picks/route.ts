import { NextResponse } from 'next/server';
import { closePositionOf } from '@/lib/scoring-server';
import { getStockDayAllDataInternal, isMarketOpen } from '@/lib/twse-api-server';
import { parseStock, scoreStock, fetchRiskStocks, isRegularStock } from '@/lib/scoring-server';
import { getAdminDb } from '@/lib/firebase-admin';
import { getInstWeights } from '@/lib/inst-weight-server';

export const runtime = 'nodejs';

// ============================================================
// 盤中潛力榜 — 與 AI 評分（鎖完整交易日收盤）互補的「即時」推薦。
// 演算法（全 deterministic·2026-07-19 依 audit-tailend.mjs 2年×15.6萬樣本稽核修正）：
//   量比  30%：放量程度（明開賣口徑：量比越高越好·單調；明收賣口徑相反——保留權重、移除「>5利多出盡」舊宣稱）
//   動能  25%：甜蜜區實測為 3~7%（舊 1~7 為誤；>7 與 <1 兩口徑皆差），峰值移至 6
//   位置   0%：⚠稽核反向——pos≥0.9 明開賣淨-0.36%/pos≤0.2 唯一淨正+0.05%（兩窗單調一致），
//              貼高加分廢除、改為 pos≥0.9 記警示；與綜合評分「強尾單獨−2」互證
//   跳空  10%：開盤站上昨收（唯一兩口徑×兩窗全過的權重，保留）
//   體質  15%：昨日完整交易日 AI 評分（離線無法重建，未稽核、暫保留）
// 資料範圍：daemon 優先掃描的即時個股（自選/持股/高成交值~150檔）。
// ============================================================

const gradeOf = (s: number) => (s >= 85 ? 'A+' : s >= 75 ? 'A' : s >= 65 ? 'B+' : s >= 55 ? 'B' : 'C');

export async function GET() {
  try {
    const marketOpen = isMarketOpen();
    const [live, base, riskData, iw, sqDoc] = await Promise.all([
      getStockDayAllDataInternal(),
      getStockDayAllDataInternal({ closeOnly: true }),
      fetchRiskStocks(),
      getInstWeights(), // 四大法人加權（回測驗證·保守，盤中 = t-1，PIT 安全）
      // 軋空啟動 setup（daemon 每日寫：昨日融券增≥昨量0.5% 名單）
      (async () => { try { const db0 = getAdminDb(); if (!db0) return null; const d = await db0.collection('squeezeSetup').doc('latest').get(); return d.exists ? d.data() : null; } catch { return null; } })(),
    ]);
    let squeezeSet: Record<string, number> = {};
    try { squeezeSet = sqDoc?.codesJson ? JSON.parse(sqDoc.codesJson as string) : {}; } catch { squeezeSet = {}; }
    const baseBy: Record<string, { value: number; score: number }> = {};
    for (const d of base) {
      if (!isRegularStock(d)) continue;
      baseBy[d.Code] = { value: parseFloat(d.TradeValue) || 0, score: 0 };
    }

    // 盤中時間進度（09:00–13:30 共 270 分鐘），非交易時段視為 1（全日量）。
    const tw = new Date(Date.now() + (new Date().getTimezoneOffset() * 60000) + 8 * 3600000);
    const mins = tw.getHours() * 60 + tw.getMinutes();
    const progress = marketOpen ? Math.min(Math.max((mins - 540) / 270, 0.08), 1) : 1;

    // 候選：有真實即時成交、漲幅 0.5%~8.5%（未鎖死漲停）
    const candidates = live.filter(d => {
      if (d._source !== 'mis_live' || !isRegularStock(d) || !baseBy[d.Code]) return false;
      const chg = parseFloat(d._changePercent || '0');
      return chg >= 0.5 && chg <= 8.5 && (parseFloat(d.TradeValue) || 0) > 0;
    });

    const picks = candidates.map(d => {
      const chg = parseFloat(d._changePercent || '0');
      const price = parseFloat(d.ClosingPrice) || 0;
      const open = parseFloat(d.OpeningPrice) || 0;
      const high = parseFloat(d.HighestPrice) || 0;
      const low = parseFloat(d.LowestPrice) || 0;
      const prevClose = parseFloat(d._prevClose || '0');
      // MIS 即時量單位是「張」→ 快照的 value=price×張，需 ×1000 才是元（與昨日成交值同單位）
      const todayValue = (parseFloat(d.TradeValue) || 0) * 1000;
      const yValue = baseBy[d.Code].value;

      const volRatio = yValue > 0 ? todayValue / (yValue * progress) : 0;
      const volPart = Math.min(volRatio / 2.5, 1) * 30;
      const momPart = (chg <= 6 ? chg / 6 : Math.max((8.5 - chg) / 2.5, 0.4)) * 25; // 甜蜜區 3~7 峰值 6（2年實測）
      const pos = closePositionOf(price, high, low, prevClose);
      const posPart = 0; // 2年稽核：貼高加分反向（pos 越高隔日越差），廢除
      const gapPart = open > prevClose && prevClose > 0 ? 10 : 0;
      // 體質分：用昨日收盤資料完整評分（僅對候選算，控制成本）
      const baseRow = base.find(b => b.Code === d.Code);
      const baseScore = baseRow ? scoreStock(parseStock(baseRow), 'daily', riskData).score : 0;
      const basePart = (baseScore / 100) * 15;
      const total = Math.round(volPart + momPart + posPart + gapPart + basePart);

      const reasons: string[] = [];
      if (volRatio >= 1.5) reasons.push(`📦 量比 ${volRatio.toFixed(1)} 倍（較昨日同時段放量）`);
      if (chg >= 1) reasons.push(`⚡ 盤中上攻 +${chg.toFixed(2)}%，距漲停仍有空間`);
      if (pos != null && pos >= 0.9) reasons.push('⚠️ 極度貼高（收位≥90%）——2年實測明開賣淨-0.36%/筆·開高率僅46%（貼高慣性反向，勿因強勢加碼）');
      else if (pos != null && pos >= 0.7) reasons.push('📈 現價貼近今日高點（提示：2年實測貼高組隔日偏弱，此項已不加分）');
      if (gapPart) reasons.push('🔴 開盤站上昨收（跳空開高）');
      if (baseScore >= 60) reasons.push(`🤖 昨日完整評分 ${baseScore} 分，體質穩健`);

      // ⚡ 軋空啟動（2年稽核 46.0-47.7%·淨+0.33~0.48%/筆 vs 基準·兩窗穩定）：昨日融券增＋今日強漲
      const isSqueeze = squeezeSet[d.Code] != null && chg > 2;
      if (isSqueeze) reasons.unshift(`⚡ 軋空啟動：昨日融券增 ${squeezeSet[d.Code].toLocaleString()} 張＋今日強漲（2年實測 46.0-47.7%·淨+0.33~0.48%/筆 vs 基準）`);

      // 收位提示（2026-07-19 稽核：舊「弱尾盤-0.5%/筆」為 120 日舊值且方向不穩，改為兩口徑實測提示）
      if (pos != null && pos <= 0.2) reasons.push(`💡 收位 ${Math.round(pos * 100)}%（回落收低）——2年實測此組明開賣唯一淨正(+0.05%)·開高率65%（V型買回效應）；惟屬逆勢接法，僅適合明開即賣的紀律者`);

      // 四大法人加權（t-1）：三方同買/連買/外資大買加分、外資賣超重罰
      const instW = iw.map[d.Code] ?? 0;
      if (instW >= 5) reasons.push('🏦 法人籌碼強力加持（三方同買/連買/外資大買）');
      else if (instW <= -3) reasons.push('⚠️ 昨日外資賣超，追價風險偏高');

      // 借用標準評分產生完整卡片欄位（買點/目標/停損以即時價計）
      const full = scoreStock(parseStock(d), 'daily', riskData);
      return {
        ...full,
        score: total, grade: gradeOf(total),
        signal: total >= 75 ? 'STRONG_BUY' : total >= 60 ? 'BUY' : 'WATCH',
        reasons: reasons.length ? reasons : full.reasons,
        instW,
        squeeze: isSqueeze,
        _intraday: { volRatio: +volRatio.toFixed(2), position: pos == null ? null : +pos.toFixed(2), baseScore },
      };
    })
      .sort((a, b) => (b.score + b.instW * 1.5) - (a.score + a.instW * 1.5))
      .slice(0, 20);

    const db = getAdminDb();
    // 盤中有結果 → 持久化；收盤後/尚無候選 → 回當日最後一次盤中榜單
    if (marketOpen && picks.length > 0 && db) {
      db.collection('intradayPicks').doc('latest')
        .set({ picks: JSON.stringify(picks), universe: candidates.length, savedAt: Date.now() })
        .catch(() => {});
    } else if (picks.length === 0 && db) {
      try {
        const saved = (await db.collection('intradayPicks').doc('latest').get()).data();
        if (saved?.picks) {
          return NextResponse.json(
            { picks: JSON.parse(saved.picks), marketOpen, universe: saved.universe, stale: true, savedAt: saved.savedAt, generatedAt: new Date().toISOString() },
            { headers: { 'Cache-Control': 'public, s-maxage=300' } },
          );
        }
      } catch { /* fall through */ }
    }

    return NextResponse.json(
      { picks, marketOpen, universe: candidates.length, progress: +progress.toFixed(2), generatedAt: new Date().toISOString() },
      { headers: { 'Cache-Control': marketOpen ? 'public, s-maxage=30' : 'public, s-maxage=300' } },
    );
  } catch (e) {
    console.error('[intraday-picks] error:', e);
    return NextResponse.json({ error: 'failed' }, { status: 500 });
  }
}
