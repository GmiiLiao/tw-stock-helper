'use client';

import { Fragment, useEffect, useState } from 'react';

// ── 🎯 三大法人籌碼（當日｜累計 合併卡）──────────────────────────────
// 合併原 ChipSignals(當日四準則標籤) + ChipCumulativeCard(累計淨買賣超)。
// 當日＝最新 T86 單日；累計＝自起始日逐日累加(籌碼流向，非絕對持股)。

interface Sig { tags: string[]; foreign: number; trust: number; dealer: number; streak: number; newHigh: boolean; marginChg: number }
interface Cum { found: boolean; foreign?: number; trust?: number; dealer?: number; total?: number; startIso?: string; lastIso?: string; days?: number }

const RULES: Record<string, { label: string; icon: string; color: string; bg: string; desc: string }> = {
  foreignHeavyBuy: { label: '外資大買', icon: '💰', color: '#f03e3e', bg: 'rgba(240,62,62,0.10)', desc: '外資單日買超 ≥5000 張，隔日易有支撐' },
  tripleAlign: { label: '三方同買', icon: '🔴', color: '#f03e3e', bg: 'rgba(240,62,62,0.10)', desc: '外資＋投信＋自營同時買超，強烈多頭訊號' },
  streakNewHigh: { label: '連買創高', icon: '🚀', color: '#e8590c', bg: 'rgba(232,89,12,0.10)', desc: '外資連買≥3日且股價創20日新高，籌碼追蹤最佳入場' },
  retailBagholder: { label: '散戶接棒', icon: '⚠️', color: '#f59f00', bg: 'rgba(245,159,0,0.10)', desc: '外資賣超但融資增加，散戶接棒、危險訊號' },
};

const fmt = (n?: number) => (n == null ? '—' : (n >= 0 ? '+' : '') + Math.round(n).toLocaleString());
const col = (n?: number) => (n == null ? 'var(--text-muted)' : n > 0 ? '#f03e3e' : n < 0 ? '#2f9e44' : 'var(--text-muted)');

export default function ChipDualCard({ code }: { code: string }) {
  const [sig, setSig] = useState<Sig | null>(null);
  const [day, setDay] = useState<{ foreign: number; trust: number; dealer: number; date: string } | null>(null);
  const [sigDate, setSigDate] = useState<string | null>(null);
  const [cum, setCum] = useState<Cum | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/ai/chip-signals?code=${code}`).then(r => (r.ok ? r.json() : null)).then(d => { if (live && d) { setSig(d.signal); setDay(d.day ?? null); setSigDate(d.day?.date || d.dataDate); } }).catch(() => {});
    fetch(`/api/ai/chip-cumulative?code=${code}`).then(r => (r.ok ? r.json() : null)).then(d => { if (live) setCum(d); }).catch(() => {});
    return () => { live = false; };
  }, [code]);

  const tags = sig?.tags || [];
  const rows: { label: string; icon: string; day?: number; cum?: number }[] = [
    // 當日數字：day＝全市場來源（chipDaily·每檔都有）優先；sig 僅訊號股才有（後備相容）
    { label: '外資', icon: '🌐', day: day?.foreign ?? sig?.foreign, cum: cum?.found ? cum.foreign : undefined },
    { label: '投信', icon: '🏛️', day: day?.trust ?? sig?.trust, cum: cum?.found ? cum.trust : undefined },
    { label: '自營商', icon: '🏢', day: day?.dealer ?? sig?.dealer, cum: cum?.found ? cum.dealer : undefined },
  ];
  const src = day ?? sig;
  const dayTotal = src ? (src.foreign || 0) + (src.trust || 0) + (src.dealer || 0) : undefined;
  const hasDay = !!src, hasCum = !!cum?.found;
  if (!hasDay && !hasCum) return null;

  return (
    <div style={{ marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(1rem * var(--fz))' }}>🎯 三大法人籌碼</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          {sigDate ? `當日 ${sigDate}` : ''}{hasCum ? ` · 累計 ${cum!.startIso}→${cum!.lastIso}（${cum!.days}日）` : ''}
        </span>
      </div>

      {/* 四準則標籤 */}
      {tags.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            {tags.map(t => {
              const m = RULES[t]; if (!m) return null;
              return <span key={t} style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '3px 10px', borderRadius: 20, color: m.color, background: m.bg, border: `1px solid ${m.color}55` }}>{m.icon} {m.label}</span>;
            })}
          </div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            {tags.map(t => RULES[t] && <div key={t}>· {RULES[t].desc}</div>)}
          </div>
        </div>
      )}

      {/* 當日 ｜ 累計 雙欄表 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, fontSize: 'calc(13px * var(--fz))' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>法人</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))', textAlign: 'right' }}>當日(張)</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))', textAlign: 'right' }}>累計(張)</div>
        {rows.map(r => (
          <Fragment key={r.label}>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '4px 0' }}>{r.icon} {r.label}</div>
            <div style={{ textAlign: 'right', fontWeight: 700, color: col(r.day), padding: '4px 0' }}>{hasDay ? fmt(r.day) : '—'}</div>
            <div style={{ textAlign: 'right', fontWeight: 700, color: col(r.cum), padding: '4px 0' }}>{hasCum ? fmt(r.cum) : '—'}</div>
          </Fragment>
        ))}
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '5px 0', borderTop: '1px solid var(--border-primary)' }}>合計</div>
        <div style={{ textAlign: 'right', fontWeight: 900, color: col(dayTotal), padding: '5px 0', borderTop: '1px solid var(--border-primary)' }}>{hasDay ? fmt(dayTotal) : '—'}</div>
        <div style={{ textAlign: 'right', fontWeight: 900, color: col(cum?.total), padding: '5px 0', borderTop: '1px solid var(--border-primary)' }}>{hasCum ? fmt(cum!.total) : '—'}</div>
      </div>

      {sig && (sig.streak > 0 || sig.marginChg !== 0) && (
        <div style={{ marginTop: 6, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          {sig.streak > 0 && <span>外資連買 {sig.streak} 日　</span>}
          {sig.marginChg !== 0 && <span>融資{sig.marginChg > 0 ? '增' : '減'} {Math.abs(Math.round(sig.marginChg)).toLocaleString()} 張</span>}
        </div>
      )}
      <div style={{ marginTop: 6, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        當日＝最新 T86 單日買賣超；累計＝自起始日逐日累加（籌碼流向，非絕對總持股）。確定性統計，非投資建議。
      </div>
    </div>
  );
}
