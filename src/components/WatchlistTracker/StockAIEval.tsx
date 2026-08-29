'use client';

import { useState } from 'react';
import { useAppStore } from '@/lib/store';

// ── Premium-only collapsible per-stock local-AI evaluation for the
//    real-time tracking page: 強力買進 grading (deterministic), AI 波段
//    operation analysis (grounded), and news links. Lazy-loads on open. ──

const PREMIUM_LEVELS = ['premium', 'admin', 'superadmin'];

const SIGNAL_LABEL: Record<string, { label: string; color: string }> = {
  STRONG_BUY: { label: '強力買進', color: '#c92a2a' },
  BUY: { label: '買進', color: '#e67700' },
  WATCH: { label: '觀察', color: '#1971c2' },
  NEUTRAL: { label: '中性', color: '#868e96' },
};

interface NewsItem { id: string; title: string; source: string; time: string; url: string }

interface SwingSig {
  score: number; action: string; actionLabel: string; trend: string; biasPct: number; chase: boolean;
  components: { trend: number; bias: number; volume: number; ma: number; macd: number; rsi: number };
  reasons: string[]; risks: string[];
}
interface Loaded {
  signal: string; score: number; grade: string;
  buy: number | null; target: number | null; stop: number | null;
  isAttention: boolean; isDisposition: boolean;
  swing: string | null; swingModel: string | null; swingAt: number | null;
  swingSignal: SwingSig | null;
  newsSentiment: { gradedCount?: number; newsScore: number; adjustment: number; bull: number; bear: number; total: number; label: string } | null;
  news: NewsItem[];
}

export default function StockAIEval({ code, name }: { code: string; name: string }) {
  const user = useAppStore(s => s.user);
  const isPremium = !!user && PREMIUM_LEVELS.includes(user.level);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<Loaded | null>(null);
  const [err, setErr] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !data && !loading && isPremium) {
      setLoading(true); setErr(false);
      try {
        const [ratingRes, evalRes, newsRes] = await Promise.all([
          fetch(`/api/rating?code=${code}`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`/api/ai/stock-eval?code=${code}`).then(r => r.ok ? r.json() : null).catch(() => null),
          fetch(`/api/twse/stock-news?code=${code}&name=${encodeURIComponent(name || '')}`).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        const st = ratingRes?.stock;
        setData({
          signal: st?.signal ?? 'NEUTRAL',
          score: st?.score ?? 0, grade: st?.grade ?? 'C',
          buy: st?.buyZones?.find((z: { type: string }) => z.type === 'standard')?.price ?? st?.buyZones?.[0]?.price ?? null,
          target: st?.sellTargets?.find((t: { type: string }) => t.type === 'tp1')?.price ?? null,
          stop: st?.stopLoss ?? null,
          isAttention: !!st?.isAttention, isDisposition: !!st?.isDisposition,
          swing: evalRes?.swing ?? null, swingModel: evalRes?.model ?? null, swingAt: evalRes?.generatedAt ?? null,
          swingSignal: ratingRes?.swingSignal ?? null,
          newsSentiment: ratingRes?.newsSentiment ?? null,
          news: (newsRes?.news ?? []).slice(0, 6),
        });
      } catch { setErr(true); }
      finally { setLoading(false); }
    }
  };

  const wrap: React.CSSProperties = { marginTop: 8, border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)', overflow: 'hidden' };
  const headBtn: React.CSSProperties = { width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-primary)', fontFamily: 'inherit', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 600, textAlign: 'left' };

  if (!isPremium) {
    return (
      <div style={wrap}>
        <div style={{ ...headBtn, cursor: 'default', color: 'var(--text-muted)' }}>
          🔒 本地 AI 評估說明<span style={{ fontSize: 'calc(12.5px * var(--fz))', marginLeft: 6 }}>（高級會員專屬：波段操作分析・強力買進分級・新聞依據）</span>
        </div>
      </div>
    );
  }

  const sig = data ? (SIGNAL_LABEL[data.signal] || SIGNAL_LABEL.NEUTRAL) : null;

  return (
    <div style={wrap} onClick={e => e.stopPropagation()}>
      <button style={headBtn} onClick={toggle}>
        <span>🤖 本地 AI 評估說明</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '1px 6px', borderRadius: 999, background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>💎</span>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>{open ? '▲ 收合' : '▼ 展開'}</span>
      </button>

      {open && (
        <div style={{ padding: '4px 12px 12px', fontSize: 'calc(12.5px * var(--fz))' }}>
          {loading ? (
            <div style={{ color: 'var(--text-muted)', padding: '8px 0' }}>分析載入中…</div>
          ) : err || !data ? (
            <div style={{ color: 'var(--text-muted)', padding: '8px 0' }}>暫時無法載入評估，請稍後再試。</div>
          ) : (
            <>
              {/* Deterministic grading + levels (evidence-based, not AI) */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '2px 9px', borderRadius: 999, background: `${sig!.color}1f`, color: sig!.color, border: `1px solid ${sig!.color}` }}>
                  {sig!.label}
                </span>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>AI 技術評分 {data.score}（{data.grade}）</span>
                {data.isDisposition && <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>🔴 處置股</span>}
                {data.isAttention && !data.isDisposition && <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '1px 7px', borderRadius: 999, background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>🟡 注意股</span>}
              </div>

              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(12.5px * var(--fz))', marginBottom: 8 }}>
                <span style={{ color: 'var(--color-up)' }}>建議買點 {data.buy?.toFixed(2) ?? '—'}</span>
                <span style={{ color: 'var(--color-down)' }}>目標 {data.target?.toFixed(2) ?? '—'}</span>
                <span style={{ color: 'var(--text-muted)' }}>停損 {data.stop?.toFixed(2) ?? '—'}</span>
              </div>

              {/* Swing signal — chjm-ai discipline model (不追高) */}
              {data.swingSignal && (() => {
                const ss = data.swingSignal;
                const buy = ss.action === 'STRONG_BUY' || ss.action === 'BUY';
                const sell = ss.action === 'SELL' || ss.action === 'STRONG_SELL';
                const col = ss.chase ? '#e67700' : buy ? 'var(--color-up)' : sell ? 'var(--color-down)' : '#94a3b8';
                return (
                  <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.2)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700 }}>🎯 波段訊號</span>
                      <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '2px 9px', borderRadius: 999, background: `${col}1f`, color: col, border: `1px solid ${col}` }}>{ss.actionLabel}</span>
                      <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>紀律評分 {ss.score}/100 · {ss.trend} · 乖離 {ss.biasPct >= 0 ? '+' : ''}{ss.biasPct}%</span>
                    </div>
                    {ss.chase && (
                      <div style={{ marginTop: 4, fontSize: 'calc(12.5px * var(--fz))', color: '#e67700', fontWeight: 600 }}>🚫 乖離過大，嚴禁追高 — 建議等回測 MA 再進場（提升勝率）</div>
                    )}
                    <div style={{ marginTop: 4, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                      趨勢{ss.components.trend} · 乖離{ss.components.bias} · 量價{ss.components.volume} · 均線{ss.components.ma} · MACD{ss.components.macd} · RSI{ss.components.rsi}
                    </div>
                  </div>
                );
              })()}

              {/* AI swing analysis (grounded prose from resident daemon) */}
              <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>📈 波段操作分析</div>
              {data.swing ? (
                <div style={{ lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{data.swing}</div>
              ) : (
                <div style={{ color: 'var(--text-muted)' }}>常駐 AI 服務尚未產生此股波段分析（會分析你自選股與持股，約 30 分鐘一輪）。</div>
              )}
              {data.swing && data.swingModel && (
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 4 }}>
                  本地模型 {data.swingModel}{data.swingAt ? ` · ${new Date(data.swingAt).toLocaleString('zh-TW')}` : ''}
                </div>
              )}

              {/* News sentiment (20% weight) — only applied when news obtained */}
              {(() => {
                const ns = data.newsSentiment;
                const obtained = !!ns && ns.total > 0;
                if (obtained && ns!.adjustment !== 0) {
                  const pos = ns!.adjustment > 0;
                  const c = pos ? 'var(--color-up)' : 'var(--color-down)';
                  return (
                    <div style={{ marginTop: 10, fontSize: 'calc(12.5px * var(--fz))' }}>
                      <span style={{ fontWeight: 600 }}>📰 新聞情緒：</span>
                      <span style={{ color: c, fontWeight: 700 }}>{ns!.label}</span>
                      <span style={{ color: 'var(--text-muted)' }}> · {ns!.bull} 利多 / {ns!.bear} 利空 · 影響評分 </span>
                      <span style={{ color: c, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>{pos ? '+' : ''}{ns!.adjustment} 分</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>（20% 權重，已去重並計入有效期）</span>
                    </div>
                  );
                }
                // News not obtained (or neutral) → explicitly excluded from scoring.
                return (
                  <div style={{ marginTop: 10, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                    {/* ⚠ 這裡不可以寫「新聞情緒中性」：調分為 0 的原因有兩種，
                        混為一談就是捏造判斷。gradedCount=0 代表**根本還沒判別**，
                        不是判別完是中性。（使用者 2026-08-29 明令：
                        只有 AI 讀完內文的判別才能調分。） */}
                    📰 新聞加權：{
                      !obtained ? '本次未取得相關新聞'
                      : !ns!.gradedCount ? `已取得 ${ns!.total} 則新聞，但尚未經 AI 讀完內文判別`
                      : 'AI 內文判別為中性'
                    }，未計入評分（不佔權重比例）。
                  </div>
                );
              })()}

              {/* News links (sourced; only if available) */}
              {data.news.length > 0 && (
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>📰 近期新聞（來源連結）</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {data.news.map(n => (
                      <a key={n.id} href={n.url} target="_blank" rel="noopener noreferrer"
                        style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--accent-blue)', textDecoration: 'none' }}
                        onClick={e => e.stopPropagation()}>
                        ・{n.title} <span style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>— {n.source}</span>
                      </a>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ marginTop: 10, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                ⚠️ 分級與價位為量化模型計算、新聞為來源連結；AI 波段敘述僅依據上述實際數據生成，不含臆測。僅供參考，非投資建議。
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
