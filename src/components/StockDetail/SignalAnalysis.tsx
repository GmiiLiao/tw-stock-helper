'use client';

import { useEffect, useMemo, useState } from 'react';

// ── 訊號分析（用 /api/rating，伺服器端完整歷史→永遠有資料）：波段訊號 + 進場買點
//    + ATR 停損 + 風險報酬比停利 + 部位大小建議（固定風險法）。 ──

interface Zone { label: string; price: number; type: string }
interface Target { label: string; price: number; gainPercent: number; type: string; probability?: number; holdDays?: string }
interface Rating {
  price: number; score: number; grade: string; signal: string;
  stopLoss: number; stopLossRationale?: string;
  buyZones?: Zone[]; sellTargets?: Target[];
}
interface Swing { actionLabel: string; score: number; trend: string; biasPct: number; chase?: boolean }

const SIGNAL = {
  STRONG_BUY: { t: '強力買進', c: 'var(--color-up)' }, BUY: { t: '買進', c: 'var(--color-up)' },
  WATCH: { t: '觀察', c: '#f59e0b' }, NEUTRAL: { t: '中性', c: 'var(--text-muted)' },
  SELL: { t: '賣出', c: 'var(--color-down)' },
} as Record<string, { t: string; c: string }>;

const fmt = (n: number) => n.toLocaleString('zh-TW', { maximumFractionDigits: 0 });

export default function SignalAnalysis({ code, name, price }: { code: string; name: string; price: number }) {
  const [data, setData] = useState<{ stock: Rating; swingSignal?: Swing } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(false);
  const [capital, setCapital] = useState(1_000_000);
  const [riskPct, setRiskPct] = useState(2);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(false);
    fetch(`/api/rating?code=${code}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(j => { if (alive) { setData(j); setLoading(false); } })
      .catch(() => { if (alive) { setErr(true); setLoading(false); } });
    return () => { alive = false; };
  }, [code]);

  const st = data?.stock;
  const entry = st?.buyZones?.find(z => z.type === 'standard')?.price ?? st?.price ?? price;
  const stop = st?.stopLoss ?? 0;
  const riskPerShare = entry > 0 && stop > 0 && entry > stop ? entry - stop : 0;

  // 部位大小（固定風險法）：單筆最大虧損 = 總資金 × 風險% → 反推可買張數。
  const sizing = useMemo(() => {
    if (!(riskPerShare > 0) || !(entry > 0)) return null;
    const budget = capital * (riskPct / 100);          // 願意承受的最大虧損
    const riskPerLot = riskPerShare * 1000;            // 每張風險(元)
    const lots = Math.floor(budget / riskPerLot);
    const cost = lots * entry * 1000;
    const maxLoss = lots * riskPerLot;
    return { budget, lots, cost, maxLoss, riskPerLot };
  }, [capital, riskPct, riskPerShare, entry]);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>載入訊號分析…</div>;
  if (err || !st) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>訊號分析載入失敗，請稍後再試。</div>;

  const sigCfg = SIGNAL[st.signal] ?? SIGNAL.NEUTRAL;
  const sw = data?.swingSignal;
  const card: React.CSSProperties = { background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: 12, padding: '14px 16px' };
  const h: React.CSSProperties = { fontSize: 13, color: 'var(--text-muted)', marginBottom: 10, fontWeight: 600 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 訊號 + 評分 + 波段 */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>綜合訊號</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: sigCfg.c }}>{sigCfg.t}</div>
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--border-primary)' }} />
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>AI 評分</div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{st.score} <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>{st.grade}</span></div>
        </div>
        {sw && <>
          <div style={{ width: 1, height: 36, background: 'var(--border-primary)' }} />
          <div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>🎯 波段訊號</div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{sw.actionLabel} <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sw.trend}·{sw.score}/100{sw.chase ? '·⚠️乖離過大' : ''}</span></div>
          </div>
        </>}
      </div>

      {/* 進場 / 停損 / 停利 (波動率風控) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%),1fr))', gap: 14 }}>
        <div style={card}>
          <div style={h}>🟢 進場買點</div>
          {(st.buyZones ?? []).map(z => (
            <div key={z.type} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '3px 0' }}>
              <span style={{ color: 'var(--text-secondary)' }}>{z.label}</span><b>{z.price.toFixed(2)}</b>
            </div>
          ))}
        </div>
        <div style={card}>
          <div style={h}>⛔ 停損（ATR 波動率）／🎯 停利（風險報酬比）</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '3px 0' }}>
            <span style={{ color: 'var(--color-down)' }}>停損 1R</span><b style={{ color: 'var(--color-down)' }}>{stop.toFixed(2)}</b>
          </div>
          {(st.sellTargets ?? []).filter(t => t.type !== 'trailing').map((t, i) => (
            <div key={t.type} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, padding: '3px 0' }}>
              <span style={{ color: 'var(--color-up)' }}>{t.label} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{[1.5, 2.5, 4][i] ? `${[1.5, 2.5, 4][i]}R` : ''}</span></span>
              <b style={{ color: 'var(--color-up)' }}>{t.price.toFixed(2)} <span style={{ fontSize: 11 }}>(+{t.gainPercent}%)</span></b>
            </div>
          ))}
        </div>
      </div>

      {/* 部位大小建議 (固定風險法) */}
      <div style={{ ...card, borderColor: 'rgba(99,102,241,0.3)' }}>
        <div style={h}>📐 部位大小建議 <span style={{ fontWeight: 400 }}>固定風險法 — 每筆只賭總資金的一小部分</span></div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>總資金（元）
            <input type="number" className="input" value={capital} min={0} step={100000}
              onChange={e => setCapital(Math.max(0, parseInt(e.target.value) || 0))}
              style={{ display: 'block', marginTop: 4, width: 160 }} />
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>單筆風險
            <select className="input" value={riskPct} onChange={e => setRiskPct(parseFloat(e.target.value))} style={{ display: 'block', marginTop: 4, width: 90 }}>
              <option value={1}>1%</option><option value={2}>2%</option><option value={3}>3%</option>
            </select>
          </label>
        </div>
        {sizing && riskPerShare > 0 ? (
          sizing.lots > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: 10 }}>
              {[
                { l: '建議張數', v: `${sizing.lots} 張`, c: 'var(--accent-purple,#818cf8)' },
                { l: '投入金額', v: `${fmt(sizing.cost)} 元`, c: 'var(--text-primary)' },
                { l: '最大虧損', v: `${fmt(sizing.maxLoss)} 元`, c: 'var(--color-down)' },
                { l: '每張風險', v: `${fmt(sizing.riskPerLot)} 元`, c: 'var(--text-secondary)' },
              ].map(x => (
                <div key={x.l} style={{ padding: '10px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{x.l}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: x.c, fontFamily: "'JetBrains Mono',monospace" }}>{x.v}</div>
                </div>
              ))}
            </div>
          ) : <div style={{ fontSize: 13, color: 'var(--color-down)' }}>以此風險預算，連 1 張都買不起（每張風險 {fmt(sizing.riskPerLot)} 元）；請提高資金或選風險較低的標的。</div>
        ) : <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>需有效的進場價與停損價才能計算部位大小。</div>}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
          以「進場 {entry.toFixed(2)}、停損 {stop.toFixed(2)}（每股風險 {riskPerShare.toFixed(2)} 元）」計算，控制單筆最大虧損 ≤ 總資金 × {riskPct}%。※ 試算參考，非投資建議。
        </div>
      </div>
    </div>
  );
}
