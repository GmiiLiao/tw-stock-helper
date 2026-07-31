'use client';

// ── 全站共用：個股名稱/代號旁的「注意/處置」標記 ──────────────────
// 放在任何顯示個股的地方；非風險股回傳 null，不佔版面。
import { useRiskCodes, shortRiskDate } from '@/lib/useRiskCodes';

export default function RiskBadge({ code, size = 'sm' }: { code: string; size?: 'sm' | 'xs' }) {
  const { attention, disposition, dispEnd, attEnd } = useRiskCodes();
  const isDisp = disposition.has(code);
  const isAtt = attention.has(code) && !isDisp;
  if (!isDisp && !isAtt) return null;

  const fs = size === 'xs' ? 9.5 : 11;
  const pad = size === 'xs' ? '0px 4px' : '1px 6px';
  if (isDisp) {
    const until = shortRiskDate(dispEnd.get(code));
    return (
      <span title={until ? `處置股票，處置至 ${until}（交易受限、約每5分鐘撮合、預收款券）` : '處置股票，交易受限'}
        style={{ fontSize: fs, fontWeight: 700, color: '#ef4444', background: 'rgba(239,68,68,0.18)', border: '1px solid rgba(239,68,68,0.35)', padding: pad, borderRadius: 4, whiteSpace: 'nowrap' }}>
        🔴 處置{until ? `至${until}` : ''}
      </span>
    );
  }
  const until = shortRiskDate(attEnd.get(code));
  return (
    <span title={until ? `注意股票（交易異常警示），至 ${until}` : '注意股票（交易異常警示）'}
      style={{ fontSize: fs, fontWeight: 700, color: '#eab308', background: 'rgba(234,179,8,0.18)', border: '1px solid rgba(234,179,8,0.35)', padding: pad, borderRadius: 4, whiteSpace: 'nowrap' }}>
      🟡 注意{until ? `至${until}` : ''}
    </span>
  );
}
