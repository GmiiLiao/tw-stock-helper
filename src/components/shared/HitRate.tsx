'use client';

import { useEffect, useState } from 'react';

// ── 榜單命中率條（2026-08-05）─────────────────────────────────────
// 使用者：「戰情頁裡所有預測推薦選股，也要出示推薦命中率」。
//
// 設計上只有一條規則，但它是這個元件存在的全部理由：
//   **絕對勝率單獨顯示會騙人。**
//   同一個「5 日勝率 32%」，在等權大盤 -11% 的空頭段是正常，在多頭段是災難。
//   所以這裡永遠把「超額（vs 同期可交易宇宙等權基準）」放大字，
//   絕對勝率／均報退成括號裡的小字。超額才是「選得準不準」。
//
// 資料來自 daemon 每日收盤後的 trackPicks（picksScoreboard/latest）：
//   同日進場、同持有期、基準宇宙 = 4 碼普通股 × 量≥300 張 × 剔除進場日漲停
//   （漲停買不到，計入等於量幻想部位）——與 bt-core 同口徑。
//
// 尚未累積的榜單顯示「累積中」而不是隱藏：**沒有成績本身就是一種成績**，
// 藏起來會讓使用者以為它已被驗證過。

interface Cell {
  n: number; winRate: number; avgRet: number;
  base?: { n: number; winRate: number; avgRet: number } | null;
  excess?: number | null; excessTradable?: number | null;
  skipped?: number; entryDays?: number;
}
interface Board { records: number; from?: string; calib?: string; calibFrom?: string; recordsV2?: number;
  agg: Record<string, Record<string, Cell>>; aggV2?: Record<string, Record<string, Cell>> }

let cache: Board | null = null;
let inflight: Promise<Board | null> | null = null;

/** 多個面板共用同一次請求——一頁可能同時掛 3 個本元件（唯一不變式） */
function load(): Promise<Board | null> {
  if (cache) return Promise.resolve(cache);
  inflight ||= fetch('/api/ai/picks-scoreboard')
    .then(r => (r.ok ? r.json() : null))
    .then((d: Board | null) => { if (d?.agg) cache = d; return cache; })
    .catch(() => null)
    .finally(() => { inflight = null; });
  return inflight;
}

export default function HitRate({ list, label, horizons = [5, 10] }: {
  /** picksScoreboard.agg 的鍵：radar / chipPicks / volSurge / swing / strength / top20 … */
  list: string;
  /** 榜單人話名稱，顯示在句首 */
  label: string;
  horizons?: number[];
}) {
  const [b, setB] = useState<Board | null>(cache);
  useEffect(() => { let live = true; load().then(d => { if (live) setB(d); }); return () => { live = false; }; }, []);

  // 口徑優先序（2026-08-05）：先用**現行口徑**的成績；沒有才退回全歷史。
  // 退回時必須標明——用舊系統的成績替現行系統背書，就是這輪一直在清的問題。
  const gV2 = b?.aggV2?.[list];
  const gAll = b?.agg?.[list];
  const g = (gV2 && Object.keys(gV2).length) ? gV2 : gAll;
  const isLegacy = !(gV2 && Object.keys(gV2).length) && !!gAll && Object.keys(gAll).length > 0;
  const box: React.CSSProperties = {
    display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap',
    padding: '6px 10px', borderRadius: 8, marginBottom: 8,
    background: 'rgba(148,163,184,0.06)', border: '1px solid rgba(148,163,184,0.16)',
    fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.7,
  };

  if (!b) return null;
  if (!g || !Object.keys(g).length) {
    return (
      <div style={box}>
        <span style={{ fontWeight: 800 }}>🏅 {label}命中率</span>
        <span style={{ color: 'var(--text-muted)' }}>
          累積中——本榜自 2026-08-05 起逐日對答案，第 5 個交易日後出現第一筆。
          <b style={{ color: '#fbbf24' }}> 在那之前，這張榜沒有經過驗證的命中率</b>。
        </span>
      </div>
    );
  }

  return (
    <div style={box}>
      <span style={{ fontWeight: 800 }}>🏅 {label}命中率</span>
      {horizons.map(h => {
        const c = g[`d${h}`];
        if (!c || c.excess == null) return null;
        const thin = (c.entryDays ?? 0) < 5;
        return (
          // 只鎖「N日超額 +x.xpp」這段不換行，括號內明細可換行（2026-09-17 窄卡片溢出）
          <span key={h} style={{ minWidth: 0 }}>
            <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{h}日超額</span>{' '}
            <b style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 'calc(12.5px * var(--fz))', color: c.excess > 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
              {c.excess > 0 ? '+' : ''}{c.excess}pp
            </b>
            {thin && <span title={`只有 ${c.entryDays} 個進場日，樣本互相重疊，尚不足以當估計值`} style={{ color: '#fbbf24' }}>⚠</span>}
            <span style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>
              （勝率 {c.winRate}%／均 {c.avgRet >= 0 ? '+' : ''}{c.avgRet}%
              {c.base ? `，同期基準 ${c.base.winRate}%／${c.base.avgRet >= 0 ? '+' : ''}${c.base.avgRet}%` : ''}）
            </span>
          </span>
        );
      })}
      {isLegacy && (
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#fbbf24' }} title="2026-08-05 改了評分/濾網/排序鍵，此處顯示的是改版前的成績">
          ⚠舊口徑（{b.calibFrom ? `${b.calibFrom} 前` : '改版前'}）
        </span>
      )}
      <span style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))', marginLeft: 'auto' }}>
        超額＝減去同期可交易宇宙等權；追蹤 {isLegacy ? b.records : (b.recordsV2 ?? b.records)} 日。非投資建議。
      </span>
    </div>
  );
}
