'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';

// ── 同業比較（financial-services comps-analysis 台股化）──
// daemon 每日算好 peerComps/latest；此處只呈現：同產業 PE/PB/殖利率/營收YoY/評分/RS。

interface Peer { code: string; name: string; price: number | null; changePct: number | null; pe: number | null; pb: number | null; yield: number | null; revYoY: number; score: number | null; signal: string | null; rs: number | null }
interface Median { count: number; medPe: number | null; medPb: number | null; medYield: number | null; medRevYoY: number | null }
interface Resp { updatedAt: number; month: string; industry: string | null; median: Median | null; peers: Peer[] }

const SIG: Record<string, { t: string; c: string }> = {
  STRONG_BUY: { t: '強力買進', c: '#dc2626' }, BUY: { t: '買進', c: '#f97316' },
  WATCH: { t: '觀察', c: '#f59e0b' }, NEUTRAL: { t: '中性', c: '#94a3b8' },
};
const num = (v: number | null, digits = 1) => (v == null ? '—' : v.toFixed(digits));

export default function PeerComps({ code }: { code: string }) {
  const navigateTo = useAppStore(st => st.navigateTo);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true); setData(null);
    fetch(`/api/ai/peer-comps?code=${code}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (live) { setData(d); setLoading(false); } })
      .catch(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [code]);

  if (loading) return <div style={{ padding: 24, color: 'var(--text-muted)' }}>載入同業比較中…</div>;
  if (!data || !data.industry || !data.peers.length) return <div style={{ padding: 24, color: 'var(--text-muted)' }}>暫無同業比較資料（每日收盤後更新，僅涵蓋上市公司）。</div>;

  const m = data.median;
  const me = data.peers.find(p => p.code === code);
  const rank = me ? data.peers.indexOf(me) + 1 : null;
  // 相對估值評語（純規則，不用 LLM）
  const verdicts: string[] = [];
  if (me && m) {
    if (me.pe != null && m.medPe != null) verdicts.push(me.pe < m.medPe ? `本益比 ${num(me.pe)} 低於產業中位 ${num(m.medPe)}（相對便宜）` : `本益比 ${num(me.pe)} 高於產業中位 ${num(m.medPe)}（相對較貴）`);
    if (me.revYoY != null && m.medRevYoY != null) verdicts.push(me.revYoY > m.medRevYoY ? `營收年增 ${num(me.revYoY)}% 優於同業中位 ${num(m.medRevYoY)}%` : `營收年增 ${num(me.revYoY)}% 落後同業中位 ${num(m.medRevYoY)}%`);
  }

  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 'calc(1rem * var(--fz))' }}>🏭 {data.industry}</span>
        <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-secondary)' }}>共 {data.peers.length} 檔{rank ? ` · 本股評分排名第 ${rank}` : ''}{data.month ? ` · 營收月份 ${data.month}` : ''}</span>
      </div>
      {verdicts.length > 0 && (
        <div style={{ marginBottom: 12, padding: '10px 14px', borderRadius: 10, background: 'var(--bg-tertiary)', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.8, color: 'var(--text-secondary)' }}>
          {verdicts.map(v => <div key={v}>• {v}</div>)}
        </div>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(13px * var(--fz))', whiteSpace: 'nowrap' }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', fontSize: 'calc(12px * var(--fz))', textAlign: 'right' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>個股</th>
              <th style={{ padding: '6px 8px' }}>現價</th>
              <th style={{ padding: '6px 8px' }}>漲跌%</th>
              <th style={{ padding: '6px 8px' }}>PE</th>
              <th style={{ padding: '6px 8px' }}>PB</th>
              <th style={{ padding: '6px 8px' }}>殖利率%</th>
              <th style={{ padding: '6px 8px' }}>營收YoY%</th>
              <th style={{ padding: '6px 8px' }}>評分</th>
              <th style={{ padding: '6px 8px' }}>RS</th>
              <th style={{ padding: '6px 8px' }}>訊號</th>
            </tr>
          </thead>
          <tbody>
            {m && (
              <tr style={{ color: 'var(--text-muted)', fontSize: 'calc(12px * var(--fz))', borderBottom: '1px solid var(--border-primary)' }}>
                <td style={{ padding: '6px 8px' }}>產業中位數</td>
                <td /><td />
                <td style={{ textAlign: 'right', padding: '6px 8px' }}>{num(m.medPe)}</td>
                <td style={{ textAlign: 'right', padding: '6px 8px' }}>{num(m.medPb, 2)}</td>
                <td style={{ textAlign: 'right', padding: '6px 8px' }}>{num(m.medYield)}</td>
                <td style={{ textAlign: 'right', padding: '6px 8px' }}>{num(m.medRevYoY)}</td>
                <td /><td /><td />
              </tr>
            )}
            {data.peers.slice(0, 30).map(p => {
              const self = p.code === code;
              return (
                <tr key={p.code} onClick={() => !self && navigateTo('stock', p.code)}
                  style={{ cursor: self ? 'default' : 'pointer', background: self ? 'rgba(56,189,248,0.10)' : undefined, borderBottom: '1px solid var(--border-primary)' }}>
                  <td style={{ padding: '7px 8px', fontWeight: self ? 800 : 600 }}>
                    <span style={{ color: '#e2e8f0' }}>{p.code}</span> <span style={{ color: '#7dd3fc' }}>{p.name}</span>{self ? ' ◄' : ''}
                  </td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', fontFamily: "'JetBrains Mono',monospace" }}>{p.price ?? '—'}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: (p.changePct ?? 0) > 0 ? 'var(--color-up)' : (p.changePct ?? 0) < 0 ? 'var(--color-down)' : 'var(--color-flat)' }}>{p.changePct == null ? '—' : `${p.changePct > 0 ? '+' : ''}${p.changePct}%`}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px' }}>{num(p.pe)}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px' }}>{num(p.pb, 2)}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px' }}>{num(p.yield)}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: p.revYoY > 0 ? 'var(--color-up)' : p.revYoY < 0 ? 'var(--color-down)' : undefined }}>{num(p.revYoY)}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', fontWeight: 700, color: '#fbbf24' }}>{p.score ?? '—'}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', color: '#fbbf24' }}>{p.rs ?? '—'}</td>
                  <td style={{ textAlign: 'right', padding: '7px 8px', fontWeight: 700, color: p.signal ? (SIG[p.signal] || SIG.NEUTRAL).c : 'var(--text-muted)' }}>{p.signal ? (SIG[p.signal] || SIG.NEUTRAL).t : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {data.peers.length > 30 && <div style={{ marginTop: 8, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>依評分排序，顯示前 30／{data.peers.length} 檔。</div>}
    </div>
  );
}
