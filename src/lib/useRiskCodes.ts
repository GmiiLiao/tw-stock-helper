'use client';

// ── 全站共用：注意/處置股名單（一次抓取、模組級快取，供任何元件標注） ──
import { useEffect, useState } from 'react';

export type RiskInfo = {
  attention: Set<string>;
  disposition: Set<string>;
  dispEnd: Map<string, string>;
  dispStart: Map<string, string>;
  attEnd: Map<string, string>;
};

const emptyRisk = (): RiskInfo => ({ attention: new Set(), disposition: new Set(), dispEnd: new Map(), dispStart: new Map(), attEnd: new Map() });

/** 台北日曆日 YYYY-MM-DD */
export const taipeiToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

/** 處置已公告但尚未生效（startDate 在今天之後）——3441 實案：公告日當天還只是注意股，不能掛「處置中」。 */
export function isDispositionPending(r: RiskInfo, code: string, today = taipeiToday()): boolean {
  const s = r.dispStart.get(code);
  return !!s && s > today;
}

let _riskCache: RiskInfo | null = null;
let _riskPromise: Promise<RiskInfo> | null = null;

export function fetchRiskCodes(): Promise<RiskInfo> {
  if (!_riskPromise) {
    _riskPromise = fetch('/api/twse/risk-stocks', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const r = emptyRisk();
        for (const x of (d?.disposition || []) as Array<{ code: string; startDate?: string; endDate?: string }>) {
          if (x.code) { r.disposition.add(x.code); if (x.endDate) r.dispEnd.set(x.code, x.endDate); if (x.startDate) r.dispStart.set(x.code, x.startDate); }
        }
        for (const x of (d?.attention || []) as Array<{ code: string; endDate?: string }>) {
          if (x.code) { r.attention.add(x.code); if (x.endDate) r.attEnd.set(x.code, x.endDate); }
        }
        _riskCache = r;
        return r;
      })
      .catch(() => emptyRisk());
  }
  return _riskPromise;
}

export function useRiskCodes(): RiskInfo {
  const [v, setV] = useState<RiskInfo>(_riskCache || emptyRisk());
  useEffect(() => {
    if (_riskCache) { setV(_riskCache); return; }
    let live = true;
    fetchRiskCodes().then(r => { if (live) setV(r); });
    return () => { live = false; };
  }, []);
  return v;
}

/** YYYY-MM-DD / MMDD → M/D 精簡顯示 */
export function shortRiskDate(d?: string): string {
  if (!d) return '';
  const m = d.match(/(\d{1,2})[-/](\d{1,2})$/) || d.match(/(\d{2})(\d{2})$/);
  return m ? `${parseInt(m[1], 10)}/${parseInt(m[2], 10)}` : d;
}
