import { NextResponse } from 'next/server';
import { fetchRiskStocks as fetchRiskStocksSource } from '@/lib/risk-stocks-source';

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
}

// ── In-memory cache (5 min TTL) ─────────────────────────────
let cachedResult: RiskStocksResponse | null = null;
let cachedAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function GET() {
  // Return cache if still fresh
  if (cachedResult && Date.now() - cachedAt < CACHE_TTL) {
    return NextResponse.json(cachedResult, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
    });
  }

  // ⚠ 抓取與解析已抽到 @/lib/risk-stocks-source（2026-08-11）：
  //   這段邏輯原本在此與 lib/scoring-server.ts 各有一份，兩份都接錯端點，
  //   而我只修了其中一份 —— 複本就是同一個 bug 會出現第二次的原因。
  //   新增消費端請 import 該模組，不要再複製解析。
  const { attention, disposition } = await fetchRiskStocksSource();

  const allCodes = [
    ...attention.map(a => a.code),
    ...disposition.map(d => d.code),
  ];

  const result: RiskStocksResponse = {
    attention,
    disposition,
    allCodes: [...new Set(allCodes)],
    fetchedAt: new Date().toISOString(),
  };

  // Cache result
  cachedResult = result;
  cachedAt = Date.now();

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60' },
  });
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
