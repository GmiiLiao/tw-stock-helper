'use client';

// ── 全站共用：個股名稱/代號旁的「注意/處置」標記 ──────────────────
// 放在任何顯示個股的地方；非風險股回傳 null，不佔版面。
import { useRiskCodes, shortRiskDate, isDispositionPending } from '@/lib/useRiskCodes';

export default function RiskBadge({ code, size = 'sm' }: { code: string; size?: 'sm' | 'xs' }) {
  const risk = useRiskCodes();
  const { attention, disposition, dispEnd, dispStart, attEnd } = risk;
  const pending = disposition.has(code) && isDispositionPending(risk, code);   // 已公告、明日起才處置
  const isDisp = disposition.has(code) && !pending;
  const isAtt = attention.has(code) && !isDisp;
  if (!isDisp && !isAtt && !pending) return null;

  const fs = size === 'xs' ? 9.5 : 11;
  const pad = size === 'xs' ? '0px 4px' : '1px 6px';
  const dispStyle = { fontSize: fs, fontWeight: 700, color: '#ef4444', background: 'rgba(239,68,68,0.18)', border: '1px solid rgba(239,68,68,0.35)', padding: pad, borderRadius: 4, whiteSpace: 'nowrap' as const };
  const pendingBadge = pending ? (
    <span title={`已公告處置，${shortRiskDate(dispStart.get(code))} 起至 ${shortRiskDate(dispEnd.get(code)) || '—'}（生效前仍為注意股）`} style={dispStyle}>
      🔴 {shortRiskDate(dispStart.get(code))}起處置
    </span>
  ) : null;
  if (pending && !isAtt) return pendingBadge;
  if (isDisp) {
    const until = shortRiskDate(dispEnd.get(code));
    return (
      <span title={until ? `處置股票，處置至 ${until}（交易受限、約每 2 分鐘撮合、預收全額款券·2026-08-10 新制）` : '處置股票，交易受限'}
        style={{ fontSize: fs, fontWeight: 700, color: '#ef4444', background: 'rgba(239,68,68,0.18)', border: '1px solid rgba(239,68,68,0.35)', padding: pad, borderRadius: 4, whiteSpace: 'nowrap' }}>
        🔴 處置{until ? `至${until}` : ''}
      </span>
    );
  }
  const until = shortRiskDate(attEnd.get(code));
  const attBadge = (
    <span title={until ? `注意股票（交易異常警示），至 ${until}` : '注意股票（交易異常警示）'}
      style={{ fontSize: fs, fontWeight: 700, color: '#eab308', background: 'rgba(234,179,8,0.18)', border: '1px solid rgba(234,179,8,0.35)', padding: pad, borderRadius: 4, whiteSpace: 'nowrap' }}>
      🟡 注意{until ? `至${until}` : ''}
    </span>
  );
  return pendingBadge ? <>{attBadge}{' '}{pendingBadge}</> : attBadge;
}
