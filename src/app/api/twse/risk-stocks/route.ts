import { NextResponse } from 'next/server';
import { fetchRiskStocks as fetchRiskStocksSource } from '@/lib/risk-stocks-source';
import { gzipJsonAuto } from '@/lib/gzip-response';

export const runtime = 'nodejs';

// ============================================================
// Risk Stocks API — 注意股票 & 處置股票
// GET /api/twse/risk-stocks
// Sources: TWSE + TPEx official OpenAPI
// ============================================================

export interface RiskStock {
  code: string;
  name: string;
  type: 'attention' | 'disposition';
  reason: string;
  startDate?: string;
  endDate?: string;
  measures?: string;       // 處置措施
  source: 'TWSE' | 'TPEx';
}

interface RiskStocksResponse {
  attention: RiskStock[];
  disposition: RiskStock[];
  allCodes: string[];        // quick lookup: all codes on either list
  fetchedAt: string;
  twseAttentionDate?: string | null;   // 上市注意股名單公布日（2026-09-17）
  tpexAttentionDate?: string | null;
  dispositionComplete: boolean;       // false＝處置來源抓取失敗、名單可能缺漏（G2-05）
}

// 快取與合流由 @/lib/risk-stocks-source 的 memoize 負責（2026-09-28 WM-SCAN G2-10：移除手寫 let cached）。
// 處置名單殘缺（任一處置來源抓取失敗且無上一份完整結果）時回 no-store 並標 dispositionComplete:false，
// 不讓 CDN 把殘缺名單快取 5 分鐘、也讓前端／daemon 知道「不在清單上」不代表「不是處置股」（G2-05）。
export async function GET() {
  // ⚠ 抓取與解析已抽到 @/lib/risk-stocks-source（2026-08-11）：
  //   這段邏輯原本在此與 lib/scoring-server.ts 各有一份，兩份都接錯端點，
  //   而我只修了其中一份 —— 複本就是同一個 bug 會出現第二次的原因。
  //   新增消費端請 import 該模組，不要再複製解析。
  const { attention, disposition, twseAttentionDate, tpexAttentionDate, dispositionComplete } = await fetchRiskStocksSource();

  const allCodes = [
    ...attention.map(a => a.code),
    ...disposition.map(d => d.code),
  ];

  const result: RiskStocksResponse = {
    attention,
    disposition,
    allCodes: [...new Set(allCodes)],
    fetchedAt: new Date().toISOString(),
    twseAttentionDate: twseAttentionDate ?? null,
    tpexAttentionDate: tpexAttentionDate ?? null,
    dispositionComplete: dispositionComplete === true,
  };

  return gzipJsonAuto(result, { 'Cache-Control': result.dispositionComplete ? 'public, s-maxage=300, stale-while-revalidate=60' : 'no-store' });
}

// ── Helpers ──────────────────────────────────────────────────

async function fetchWithTimeout(url: string, headers: Record<string, string>, timeout: number): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`[risk-stocks] ${url} returned ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    clearTimeout(timeoutId);
    console.warn(`[risk-stocks] Fetch failed: ${url}`, e);
    return null;
  }
}

function parseROCDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    // ROC: 1140620 or 114/06/20
    const cleaned = dateStr.replace(/\//g, '');
    if (cleaned.length >= 7) {
      const y = parseInt(cleaned.slice(0, 3)) + 1911;
      const m = cleaned.slice(3, 5);
      const d = cleaned.slice(5, 7);
      return `${y}/${m}/${d}`;
    }
    return dateStr;
  } catch {
    return dateStr;
  }
}
