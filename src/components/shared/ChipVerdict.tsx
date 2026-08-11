'use client';

// ── 籌碼判讀（持倉狀態卡＋個股頁共用）──────────────────────────────
// 資料：/api/ai/chip-verdict（daemon chipVerdicts，全部回測背書的規則）。
// 行動分級：清倉 > 優先減碼(外資先轉賣95%領先) > 觀望(雙賣=調節) > 減碼 > 留意 > 可加碼 > 續抱。

import { useEffect, useState } from 'react';
import { METRIC_TIPS } from '@/lib/metric-tips';
import { TIER_META, tierDisplay } from '@/lib/tier-meta';

export interface Verdict {
  a: string; r: string; tier: string; win: number | null; dist: number;
  f: number; t: number; d: number; streak: number; sellStreak: number;
}

const ACTION_STYLE: Record<string, { c: string; bg: string; icon: string }> = {
  清倉: { c: '#ef4444', bg: 'rgba(239,68,68,0.14)', icon: '🚨' },
  優先減碼: { c: '#e8590c', bg: 'rgba(232,89,12,0.14)', icon: '🔻' },
  減碼: { c: '#f59e0b', bg: 'rgba(245,158,11,0.14)', icon: '⚠️' },
  觀望: { c: '#94a3b8', bg: 'rgba(148,163,184,0.12)', icon: '👀' },
  留意: { c: '#fbbf24', bg: 'rgba(251,191,36,0.10)', icon: '👁' },
  可加碼: { c: '#f03e3e', bg: 'rgba(240,62,62,0.12)', icon: '📈' },
  續抱: { c: '#3d8ef8', bg: 'rgba(61,142,248,0.10)', icon: '🤝' },
};

// hook：批次取多檔判讀（持倉用，一次請求）
export function useChipVerdicts(codes: string[]): Record<string, Verdict> {
  const [map, setMap] = useState<Record<string, Verdict>>({});
  const key = codes.slice().sort().join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    const load = () => fetch(`/api/ai/chip-verdict?codes=${key}`)
      .then(r => (r.ok ? r.json() : null))
      .then(x => { if (live && x?.byCode) setMap(x.byCode); }).catch(() => {});
    load();
    const t = setInterval(load, 120000);
    return () => { live = false; clearInterval(t); };
  }, [key]);
  return map;
}

// 小徽章（列表列內用）
export function VerdictBadge({ v, compact = false }: { v?: Verdict | null; compact?: boolean }) {
  if (!v) return null;
  const s = ACTION_STYLE[v.a] || ACTION_STYLE.續抱;
  return (
    <span title={`${v.r}｜${tierDisplay(v.tier)}${TIER_META[v.tier] ? `（${TIER_META[v.tier].hint}）` : ''}｜倒貨 ${v.dist}%｜外${v.f >= 0 ? '+' : ''}${v.f}/投${v.t >= 0 ? '+' : ''}${v.t}(張)\n\n${METRIC_TIPS.勝率雷達分級}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: compact ? '1px 7px' : '2px 9px', borderRadius: 8, fontSize: compact ? 10.5 : 12, fontWeight: 800, background: s.bg, color: s.c, border: `1px solid ${s.c}55`, whiteSpace: 'nowrap' }}>
      {s.icon} {v.a}
    </span>
  );
}

// 完整判讀列（個股頁/持倉展開用）：行動＋理由＋關鍵數字
export function VerdictStrip({ v }: { v?: Verdict | null }) {
  if (!v) return null;
  const s = ACTION_STYLE[v.a] || ACTION_STYLE.續抱;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '7px 10px', borderRadius: 8, background: s.bg, border: `1px solid ${s.c}44`, fontSize: 'calc(12.5px * var(--fz))' }}>
      <span style={{ fontWeight: 900, color: s.c }}>{s.icon} 籌碼判讀：{v.a}</span>
      <span style={{ color: 'var(--text-secondary)' }}>{v.r}</span>
      <span style={{ marginLeft: 'auto', fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace' }}>
        {tierDisplay(v.tier) || `${v.tier}級`} · 倒貨{v.dist}% · 外{v.f >= 0 ? '+' : ''}{v.f}/投{v.t >= 0 ? '+' : ''}{v.t}張
      </span>
    </div>
  );
}
