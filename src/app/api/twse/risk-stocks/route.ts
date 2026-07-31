import { NextResponse } from 'next/server';

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

  const attention: RiskStock[] = [];
  const disposition: RiskStock[] = [];

  const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' };
  const TIMEOUT = 8000;

  // ── Fetch all 4 sources concurrently ──────────────────────
  const [twseAttRes, twseDispRes, tpexAttRes, tpexDispRes] = await Promise.allSettled([
    fetchWithTimeout('https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL', UA, TIMEOUT),
    fetchWithTimeout('https://openapi.twse.com.tw/v1/announcement/punish', UA, TIMEOUT),
    fetchWithTimeout('https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information', UA, TIMEOUT),
    fetchWithTimeout('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information', UA, TIMEOUT),
  ]);

  // ── 1. TWSE 注意股票 ─────────────────────────────────────
  if (twseAttRes.status === 'fulfilled' && twseAttRes.value) {
    try {
      const data = twseAttRes.value;
      if (Array.isArray(data)) {
        for (const item of data) {
          const code = item['證券代號'] || item['Code'] || item['SecuritiesCode'] || '';
          const name = item['證券名稱'] || item['Name'] || item['SecuritiesName'] || '';
          const reason = item['注意交易資訊'] || item['AttentionInfo'] || item['Reason'] || 
                         item['注意事項'] || '列為注意股票';
          if (code && /^\d{4,5}$/.test(code.trim())) {
            attention.push({
              code: code.trim(),
              name: name.trim(),
              type: 'attention',
              reason: reason.trim().slice(0, 200),
              source: 'TWSE',
            });
          }
        }
      }
    } catch (e) {
      console.error('[risk-stocks] TWSE attention parse error:', e);
    }
  }

  // ── 2. TWSE 處置股票 ─────────────────────────────────────
  if (twseDispRes.status === 'fulfilled' && twseDispRes.value) {
    try {
      const data = twseDispRes.value;
      if (Array.isArray(data)) {
        for (const item of data) {
          const code = item['Code'] || item['公司代號'] || item['證券代號'] || '';
          const name = item['Name'] || item['公司名稱'] || item['證券名稱'] || '';
          const measures = item['DispositionMeasures'] || item['處置措施'] || item['Measures'] || '';
          // DispositionPeriod e.g. "115/06/12～115/06/26"
          const period = item['DispositionPeriod'] || item['處置期間'] || '';
          const [startRaw, endRaw] = String(period).split(/[～~﹣－—-]/).map(s => s.trim());
          const reason = item['ReasonsOfDisposition'] || item['處置原因'] || item['事由'] || measures || '列為處置股票';

          if (code && /^\d{4,5}$/.test(code.trim())) {
            disposition.push({
              code: code.trim(),
              name: name.trim(),
              type: 'disposition',
              reason: reason.trim().slice(0, 200),
              measures: measures.trim(),
              startDate: parseROCDate(startRaw || ''),
              endDate: parseROCDate(endRaw || ''),
              source: 'TWSE',
            });
          }
        }
      }
    } catch (e) {
      console.error('[risk-stocks] TWSE disposition parse error:', e);
    }
  }

  // ── 3. TPEx 注意股票 ─────────────────────────────────────
  if (tpexAttRes.status === 'fulfilled' && tpexAttRes.value) {
    try {
      const data = tpexAttRes.value;
      if (Array.isArray(data)) {
        for (const item of data) {
          const code = item['SecuritiesCompanyCode'] || item['證券代號'] || item['Code'] || '';
          const name = item['CompanyName'] || item['公司名稱'] || item['Name'] || '';
          const reason = item['Reason'] || item['注意事項'] || item['AttentionInfo'] || '列為注意股票';

          if (code && /^\d{4,5}$/.test(code.trim())) {
            // Avoid duplicates (stock could be on both TWSE & TPEx)
            if (!attention.some(a => a.code === code.trim())) {
              attention.push({
                code: code.trim(),
                name: name.trim(),
                type: 'attention',
                reason: reason.trim().slice(0, 200),
                source: 'TPEx',
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('[risk-stocks] TPEx attention parse error:', e);
    }
  }

  // ── 4. TPEx 處置股票 ─────────────────────────────────────
  if (tpexDispRes.status === 'fulfilled' && tpexDispRes.value) {
    try {
      const data = tpexDispRes.value;
      if (Array.isArray(data)) {
        for (const item of data) {
          const code = item['SecuritiesCompanyCode'] || item['證券代號'] || item['Code'] || '';
          const name = item['CompanyName'] || item['公司名稱'] || item['Name'] || '';
          const measures = item['DisposalMeasures'] || item['處置措施'] || item['Measures'] || '';
          const startDate = item['StartDate'] || item['處置開始日期'] || '';
          const endDate = item['EndDate'] || item['處置結束日期'] || '';
          const reason = item['Reason'] || item['事由'] || measures || '列為處置股票';

          if (code && /^\d{4,5}$/.test(code.trim())) {
            if (!disposition.some(d => d.code === code.trim())) {
              disposition.push({
                code: code.trim(),
                name: name.trim(),
                type: 'disposition',
                reason: reason.trim().slice(0, 200),
                measures: measures.trim(),
                startDate: parseROCDate(startDate),
                endDate: parseROCDate(endDate),
                source: 'TPEx',
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('[risk-stocks] TPEx disposition parse error:', e);
    }
  }

  // Build quick-lookup list of all risk codes
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
