'use client';

// 當沖工作台資料層：警示文件（5 秒鎖相）、盤中漲停預測（60 秒）、兩側名單（只列可當沖、排除處置股、各 30 檔）
import { useEffect, useMemo, useState } from 'react';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { useRiskCodes, taipeiToday } from '@/lib/useRiskCodes';
import { startLiveLoop, isForeground, getSession } from '@/lib/market-clock';
import { classifyFade, TIER_STYLE, TIER_RANK, type FadeSnap } from '@/lib/fade-patterns';
import type { AlertDoc, BaseRow } from './types';

export const LIST_N = 30;   // 兩側同為 30 檔（使用者 2026-09-23）

interface LuPick { code: string; name: string; market: string; price: number; chg: number; score: number; reasons: string[] }

export function useAlertDoc(): [AlertDoc | null, number] {
  const [doc, setDoc] = useState<AlertDoc | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    const load = () => {
      setNow(Date.now());
      if (!isForeground()) return;
      fetch('/api/ai/daytrade-alerts').then(r => (r.ok ? r.json() : null)).then(d => { if (alive && d) setDoc(d); }).catch(() => {});
    };
    load();
    const stop = startLiveLoop(load);   // 盤中 5 秒鎖相、休市 10 分鐘、背景暫停（間隔每拍重算）
    return () => { alive = false; stop(); };
  }, []);
  return [doc, now];
}

function useLuLive(): LuPick[] {
  const [list, setList] = useState<LuPick[]>([]);
  useEffect(() => {
    let alive = true;
    // aMore＝備位 31～60 名：前 30 有不可當沖／處置股時遞補
    const load = () => fetch('/api/ai/limitup-live').then(r => (r.ok ? r.json() : null)).then(d => { if (alive && d?.found) setList([...(d.aList || []), ...(d.aMore || [])] as LuPick[]); }).catch(() => {});
    load();
    const stop = startLiveLoop(load, () => (isForeground() && getSession() !== 'closed' ? 60_000 : 600_000));
    return () => { alive = false; stop(); };
  }, []);
  return list;
}

type DtInfo = ReturnType<typeof useDayTradeCodes>;
const canLongOf = (dt: DtInfo, disp: Set<string>, code: string) => { if (disp.has(code)) return false; const st = statusOf(dt, code); return st === 1 || st === 2; };
const canShortOf = (dt: DtInfo, disp: Set<string>, code: string) => !disp.has(code) && statusOf(dt, code) === 1;
function baseRow(side: 'long' | 'short', s: FadeSnap | undefined, code: string, name: string, market: string, rank: number, label: string, labelColor: string, reason: string, fallback?: { price: number; chg: number }): BaseRow {
  const prev = s ? s.price - s.change : null;
  return {
    side, code, name, market, rank, price: s?.price ?? fallback?.price ?? null, chg: s?.changePercent ?? fallback?.chg ?? null,
    hiUp: s && prev ? (s.high / prev - 1) * 100 : null, give: s && prev ? (s.high - s.price) / prev * 100 : null,
    vwapDev: s?.vwap ? (s.price / s.vwap - 1) * 100 : null, label, labelColor, reason,
  };
}

/** 兩側名單＋可當沖／處置判斷。dtLoaded=false 時兩側皆空（確認可當沖前不列任何個股）。 */
export function useDeskLists(snaps: FadeSnap[], marketOpen: boolean) {
  const lu = useLuLive();
  const dt = useDayTradeCodes();
  const risk = useRiskCodes();
  const disp = useMemo(() => { const t = taipeiToday(); return new Set([...risk.disposition].filter(c => (risk.dispEnd.get(c) ?? '9999') >= t)); }, [risk]);
  const snapMap = useMemo(() => { const m: Record<string, FadeSnap> = {}; for (const s of snaps) m[s.code] = s; return m; }, [snaps]);

  const long = useMemo<BaseRow[]>(() => {
    if (!dt.loaded) return [];
    const out: BaseRow[] = [];
    for (const p of lu) {
      if (out.length >= LIST_N) break;
      if (!canLongOf(dt, disp, p.code)) continue;
      out.push(baseRow('long', snapMap[p.code], p.code, p.name, p.market, out.length + 1, `模型 ${p.score.toFixed(1)}`, '#fbbf24', p.reasons.slice(0, 4).join('·'), { price: p.price, chg: p.chg }));
    }
    return out;
  }, [lu, snapMap, dt, disp]);

  const short = useMemo<BaseRow[]>(() => {
    if (!dt.loaded) return [];
    const { rows, avoid } = classifyFade(snaps, marketOpen, dt);
    const out: BaseRow[] = []; const seen = new Set<string>();
    for (const r of [...rows].sort((a, b) => TIER_RANK[a.main.tier] - TIER_RANK[b.main.tier] || b.m.give - a.m.give)) {
      if (out.length >= LIST_N) break; if (!canShortOf(dt, disp, r.s.code)) continue;
      const ts = TIER_STYLE[r.main.tier]; seen.add(r.s.code);
      out.push(baseRow('short', r.s, r.s.code, r.s.name, r.s.market, out.length + 1, `型態${ts.t}`, ts.c, `${r.main.label}｜${r.main.oos}`));
    }
    // 補足：今日曾漲≥5%、尚未成立型態的觀察股 → 最後才用「不建議放空」墊底並寫明理由
    const avoidWhy = new Map(avoid.map(a => [a.s.code, a.why]));
    const watch = snaps.filter(q => {
      if (seen.has(q.code) || avoidWhy.has(q.code) || !/^\d{4}$/.test(q.code) || q.code.startsWith('00') || !canShortOf(dt, disp, q.code)) return false;
      const prev = q.price - q.change; return prev > 10 && q.high > 0 && (q.volume || 0) / 1000 >= 500 && (q.high / prev - 1) * 100 >= 5;
    }).sort((a, b) => b.price * b.volume - a.price * a.volume);
    for (const q of watch) { if (out.length >= LIST_N) break; seen.add(q.code); out.push(baseRow('short', q, q.code, q.name, q.market, out.length + 1, '觀察', 'var(--text-muted)', '曾漲≥5%·尚未成立轉空型態（回放未驗證）')); }
    for (const a of avoid.filter(x => canShortOf(dt, disp, x.s.code) && !seen.has(x.s.code)).sort((x, y) => y.s.price * y.s.volume - x.s.price * x.s.volume)) {
      if (out.length >= LIST_N) break; seen.add(a.s.code); out.push(baseRow('short', a.s, a.s.code, a.s.name, a.s.market, out.length + 1, '避', '#f59e0b', `⚠ 不建議放空：${a.why}`));
    }
    return out;
  }, [snaps, marketOpen, dt, disp]);

  const canLong = (code: string) => canLongOf(dt, disp, code);
  const canShort = (code: string) => canShortOf(dt, disp, code);
  return { long, short, dtLoaded: dt.loaded, canLong, canShort };
}
