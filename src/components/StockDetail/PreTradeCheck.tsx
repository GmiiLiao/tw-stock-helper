'use client';

import { useEffect, useState } from 'react';

// ── 下單前檢查（記錄持倉時強制看見出場計畫）──
// 買的當下就把停損/風險金額定好——防止「先買再說」變成深度套牢。
// stopLoss 由 /api/rating 提供（ATR 波動停損），零前端推估。

interface Resp { stock?: { score: number; signal: string; stopLoss?: number; stopLossRationale?: string; buyZones?: { type: string; price: number }[] } }

export default function PreTradeCheck({ code, price, qty }: { code: string; price: number; qty: number }) {
  const [d, setD] = useState<Resp | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/rating?code=${code}`).then(r => (r.ok ? r.json() : null)).then(x => { if (live) setD(x); }).catch(() => {});
    return () => { live = false; };
  }, [code]);

  if (!d?.stock || !(price > 0)) return null;
  const s = d.stock;
  const stop = s.stopLoss && s.stopLoss > 0 ? s.stopLoss : +(price * 0.92).toFixed(2);
  const buy = (s.buyZones || []).find(z => z.type === 'standard')?.price;
  const riskPerLot = Math.max(Math.round((price - stop) * 1000), 0);
  const totalRisk = qty > 0 ? riskPerLot * qty : null;

  return (
    <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: 'rgba(56,189,248,0.07)', border: '1px solid rgba(56,189,248,0.25)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.9 }}>
      <b>📋 下單前檢查（AI 出場計畫）</b>
      <div>· AI 評分 <b style={{ color: '#fbbf24' }}>{s.score}</b>
        {buy ? <>，建議買點 <b>{buy}</b>{price > buy * 1.03 ? <span style={{ color: '#f59e0b' }}>（你的買價高出 {((price / buy - 1) * 100).toFixed(1)}%，注意追高）</span> : null}</> : null}
      </div>
      <div>· 建議停損 <b style={{ color: '#ef4444' }}>{stop}</b>（每張風險約 {riskPerLot.toLocaleString()} 元
        {totalRisk ? <>；此筆 {qty} 張最大虧損約 <b style={{ color: '#ef4444' }}>{totalRisk.toLocaleString()}</b> 元</> : null}）
      </div>
      {s.stopLossRationale && <div style={{ color: 'var(--text-muted)' }}>· {s.stopLossRationale}</div>}
      <div style={{ color: 'var(--text-muted)' }}>記錄後論點卡自動建立；跌破停損將啟動每日紀律追蹤，直到你處理為止。</div>
    </div>
  );
}
