'use client';

import { useEffect, useMemo, useState } from 'react';
import { techScoreOf, isRiskScored, TECH_SCORE_TIP } from '@/lib/tech-score';

// ── 訊號分析（用 /api/rating，伺服器端完整歷史→永遠有資料）：波段訊號 + 進場買點
//    + ATR 停損 + 風險報酬比停利 + 部位大小建議（固定風險法）。 ──

interface Zone { label: string; price: number; type: string }
interface Target { label: string; price: number; gainPercent: number; type: string; probability?: number; holdDays?: string }
interface Rating {
  price: number; score: number; grade: string; signal: string;
  baseScore?: number; baseSignal?: string; isDisposition?: boolean; isAttention?: boolean;   // lib/tech-score
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
  // 卡片標題 13→14px（2026-10-01）：底部試算說明已放大到 13px，標題須比它大一級
  const h: React.CSSProperties = { fontSize: 'calc(14px * var(--fz))', color: 'var(--text-muted)', marginBottom: 10, fontWeight: 600 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* 訊號 + 評分 + 波段 */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>綜合訊號</div>
          <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, color: sigCfg.c }}>{sigCfg.t}</div>
          {isRiskScored(st) && st.baseSignal && (
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }} title="處置／注意期間不給買進訊號；括號內是未含風險的技術訊號">
              {st.isDisposition ? '處置' : '注意'}期間不給買進訊號（技術面：{(SIGNAL[st.baseSignal] ?? SIGNAL.NEUTRAL).t}）
            </div>
          )}
        </div>
        <div style={{ width: 1, height: 36, background: 'var(--border-primary)' }} />
        <div>
          {/* ⚠ 標明口徑（2026-08-29）：這個分數與榜單頁**本來就不同**
              （實測 2330 榜單 81／此處 84、2454 榜單 82／此處 88），
              因為榜單要掃兩千多檔、無法逐檔抓日線與財報與新聞，只跑技術面快篩。
              不說出來的話，使用者看到兩個數字只會覺得程式壞了，也不知道該信哪個。 */}
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}
               title="個股頁的評分含日線技術面、財報與（若已判別）新聞加權；榜單頁為全市場快篩，僅技術面，兩者本來就會有差距。">
            AI 評分<span style={{ opacity: .6 }}>（深度）</span>
          </div>
          <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800 }} title={isRiskScored(st) ? TECH_SCORE_TIP : undefined}>
            {techScoreOf(st)} <span style={{ fontSize: isRiskScored(st) ? 'calc(12.5px * var(--fz))' : 'calc(14px * var(--fz))', color: 'var(--text-muted)' }}>{isRiskScored(st) ? '未含風險扣分' : st.grade}</span>
          </div>
        </div>
        {sw && <>
          <div style={{ width: 1, height: 36, background: 'var(--border-primary)' }} />
          <div>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>🎯 波段訊號</div>
            <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700 }}>{sw.actionLabel} <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{sw.trend}·{sw.score}/100{sw.chase ? '·⚠️乖離過大' : ''}</span></div>
          </div>
        </>}
      </div>

      {/* 進場 / 停損 / 停利 (波動率風控) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%),1fr))', gap: 14 }}>
        <div style={card}>
          <div style={h}>🟢 進場買點</div>
          {(st.buyZones ?? []).map(z => (
            <div key={z.type} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'calc(14px * var(--fz))', padding: '3px 0' }}>
              <span style={{ color: 'var(--text-secondary)' }}>{z.label}</span><b>{z.price.toFixed(2)}</b>
            </div>
          ))}
        </div>
        <div style={card}>
          <div style={h}>⛔ 停損（ATR 波動率）／🎯 停利（風險報酬比）</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'calc(14px * var(--fz))', padding: '3px 0' }}>
            <span style={{ color: 'var(--color-down)' }}>停損 1R</span><b style={{ color: 'var(--color-down)' }}>{stop.toFixed(2)}</b>
          </div>
          {(st.sellTargets ?? []).filter(t => t.type !== 'trailing').map((t, i) => (
            <div key={t.type} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'calc(14px * var(--fz))', padding: '3px 0' }}>
              <span style={{ color: 'var(--color-up)' }}>{t.label} <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{[1.5, 2.5, 4][i] ? `${[1.5, 2.5, 4][i]}R` : ''}</span></span>
              <b style={{ color: 'var(--color-up)' }}>{t.price.toFixed(2)} <span style={{ fontSize: 'calc(12.5px * var(--fz))' }}>(+{t.gainPercent}%)</span></b>
            </div>
          ))}
        </div>
      </div>

      {/* 部位大小建議 (固定風險法) */}
      <div style={{ ...card, borderColor: 'rgba(99,102,241,0.3)' }}>
        <div style={h}>📐 部位大小建議 <span style={{ fontWeight: 400, fontSize: 'calc(13px * var(--fz))' }}>固定風險法 — 每筆只賭總資金的一小部分</span></div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <label style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>總資金（元）
            <input type="number" className="input" value={capital} min={0} step={100000}
              onChange={e => setCapital(Math.max(0, parseInt(e.target.value) || 0))}
              style={{ display: 'block', marginTop: 4, width: 160 }} />
          </label>
          <label style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>單筆風險
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
                  <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{x.l}</div>
                  <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, color: x.c, fontFamily: "'JetBrains Mono',monospace" }}>{x.v}</div>
                </div>
              ))}
            </div>
          ) : <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--color-down)' }}>以此風險預算，連 1 張都買不起（每張風險 {fmt(sizing.riskPerLot)} 元）；請提高資金或選風險較低的標的。</div>
        ) : <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>需有效的進場價與停損價才能計算部位大小。</div>}
        <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
          以「進場 {entry.toFixed(2)}、停損 {stop.toFixed(2)}（每股風險 {riskPerShare.toFixed(2)} 元）」計算，控制單筆最大虧損 ≤ 總資金 × {riskPct}%。※ 試算參考，非投資建議。
        </div>
      </div>
    </div>
  );
}
