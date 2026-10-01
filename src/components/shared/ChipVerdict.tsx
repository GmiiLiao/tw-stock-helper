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
    <span title={`${v.r}｜${tierDisplay(v.tier)}${TIER_META[v.tier] ? `（${TIER_META[v.tier].hint}）` : ''}｜倒貨 ${v.dist}%｜外${v.f >= 0 ? '+' : ''}${v.f}/投${v.t >= 0 ? '+' : ''}${v.t}/自${v.d >= 0 ? '+' : ''}${v.d}(張)\n\n${METRIC_TIPS.勝率雷達分級}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: compact ? '1px 7px' : '2px 9px', borderRadius: 8, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, background: s.bg, color: s.c, border: `1px solid ${s.c}55`, whiteSpace: 'nowrap' }}>
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
      {/* ⚠ 三大法人補齊自營（2026-08-11 使用者指示「三大法人的數據可以放到籌碼判讀裡，省下空間」）：
          原本這裡只印外資/投信，自營明明 API 就有（Verdict.d）卻沒顯示；
          而個股頁的 K 線標頭又另外畫了一整行「三大法人 外/投/自」——同一組數字出現兩次、
          還多佔一行。現在自營補進來，K 線那一行整條移除。 */}
      {/* ⚠ 整段**不可**設 nowrap（2026-08-11 我自己剛踩到）：
          補上自營之後這一串變成 359px，在 375px 手機上直接把 <main> 推出去 15px。
          正確做法是「每一個不該被拆開的小段各自 nowrap，段與段之間可以換行」——
          與量價背離、籌碼風向那幾處同一條規矩：要斷就在整段邊界斷，不在數值中間斷。 */}
      <span style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: '0 6px', justifyContent: 'flex-end',
        fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', fontFamily: 'JetBrains Mono, monospace', minWidth: 0 }}>
        <span style={{ whiteSpace: 'nowrap' }}>{tierDisplay(v.tier) || `${v.tier}級`}</span>
        {/* ⚠ 只在理由句沒提過時才印（2026-08-11 使用者圈出重複）：
            理由句常已含「未倒貨(0%)」，右側又印一次「· 倒貨0%」＝同一個數字出現兩次。
            但**不能一律刪**——有些個股的理由句是「外資布局中·勝率58%」，不含倒貨，
            刪掉就少一項資訊。依理由句內容決定，才不會為了整齊而丟資料。 */}
        {!/倒貨/.test(v.r) && <span style={{ whiteSpace: 'nowrap' }}>· 倒貨{v.dist}%</span>}
        <span style={{ whiteSpace: 'nowrap' }}>· 外{v.f >= 0 ? '+' : ''}{v.f}</span>
        <span style={{ whiteSpace: 'nowrap' }}>投{v.t >= 0 ? '+' : ''}{v.t}</span>
        <span style={{ whiteSpace: 'nowrap' }}>自{v.d >= 0 ? '+' : ''}{v.d}張</span>
      </span>
    </div>
  );
}
