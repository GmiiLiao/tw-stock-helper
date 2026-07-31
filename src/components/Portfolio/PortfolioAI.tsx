'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── Member-exclusive (premium+) AI holdings analysis, powered by the
//    resident local-AI daemon. Shows daemon status + per-holding advice. ──

const PREMIUM_LEVELS = ['premium', 'admin', 'superadmin'];

interface HoldingAnalysis {
  code: string; name: string;
  action: string; pnlPct: number;
  targetPrice: { low: number | null; mid: number | null; high: number | null };
  stopLoss: number | null;
  sellTrigger: string; newsSummary: string; rationale: string;
  isRisk: boolean; riskType: 'attention' | 'disposition' | null;
  swingAdvice: string | null;
}
interface AnalysisDoc { generatedAt: number; model: string; analyses: Record<string, HoldingAnalysis>; }
interface DaemonStatus { running: boolean; lastHeartbeat: number | null; ageSeconds?: number; host?: string; model?: string }

const ACTION_COLOR: Record<string, string> = {
  續抱: 'var(--color-up)', 加碼: '#c92a2a', 減碼: '#e67700', 出脫: 'var(--color-down)', 換股: '#1971c2', 觀望: '#868e96',
};

function StatusBadge({ s }: { s: DaemonStatus | null }) {
  const running = !!s?.running;
  const color = running ? '#22c55e' : '#ef4444';
  const label = running ? '常駐運作中' : (s?.lastHeartbeat ? '常駐已停止' : '常駐未啟動');
  const ago = s?.lastHeartbeat ? `${Math.round((s.ageSeconds ?? 0))}s 前回報` : '無心跳';
  return (
    <span title={`本地 AI 常駐服務 · ${ago}${s?.host ? ` · ${s.host}` : ''}${s?.model ? ` · ${s.model}` : ''}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color, fontWeight: 600 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: running ? `0 0 8px ${color}` : 'none', animation: running ? 'pulse-dot 1.5s ease-in-out infinite' : 'none' }} />
      {label}
    </span>
  );
}

export default function PortfolioAI({ codes }: { codes: Array<{ code: string; name: string }> }) {
  const user = useAppStore(st => st.user);
  const isPremium = !!user && PREMIUM_LEVELS.includes(user.level);
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [data, setData] = useState<AnalysisDoc | null>(null);

  // poll daemon status
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/daemon-status').then(r => r.ok ? r.json() : null).then(d => { if (live && d) setStatus(d); }).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => { live = false; clearInterval(id); };
  }, []);

  // live subscribe to own portfolio analysis
  useEffect(() => {
    if (!isPremium || !user?.uid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', user.uid, 'data', 'portfolioAnalysis');
    const unsub = onSnapshot(ref, snap => { setData(snap.exists() ? (snap.data() as AnalysisDoc) : null); }, () => {});
    return () => unsub();
  }, [isPremium, user?.uid]);

  return (
    <div style={{ marginTop: 20, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-lg)', padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: '1rem' }}>🤖 AI 持倉投資分析</span>
        <span style={{ fontSize: '0.66rem', fontWeight: 800, padding: '2px 7px', borderRadius: 999, background: 'rgba(245,158,11,0.15)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.3)' }}>💎 高級會員</span>
        <span style={{ marginLeft: 'auto' }}><StatusBadge s={status} /></span>
      </div>

      {!isPremium ? (
        <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>此為高級會員專屬功能</div>
          <div style={{ fontSize: '0.82rem' }}>本地 AI 將分析你的每檔持股：續抱／出脫／換股建議、AI 推估目標價、近一月新聞與注意/處置股波段策略。</div>
        </div>
      ) : !data ? (
        <div style={{ padding: '18px 4px', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {status?.running
            ? '常駐 AI 服務運作中，分析將於下個週期產生（約 30 分鐘一次）。'
            : '尚無分析資料。請在本機啟動常駐服務：bash scripts/install-ai-daemon.sh'}
        </div>
      ) : (
        <>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 10 }}>
            更新：{new Date(data.generatedAt).toLocaleString('zh-TW')} · 模型 {data.model}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {codes.map(({ code, name }) => {
              const a = data.analyses[code];
              if (!a) return null;
              const ac = ACTION_COLOR[a.action] || '#868e96';
              return (
                <div key={code} style={{ border: `1px solid ${a.isRisk ? 'rgba(245,158,11,0.4)' : 'var(--border-primary)'}`, borderRadius: 'var(--radius-md)', padding: '12px 14px', background: a.isRisk ? 'rgba(245,158,11,0.04)' : 'var(--bg-secondary)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: 'var(--accent-blue)' }}>{code}</span>
                    <span style={{ fontWeight: 600 }}>{name}</span>
                    <span style={{ fontSize: '0.72rem', fontWeight: 800, padding: '2px 9px', borderRadius: 999, background: `${ac}1f`, color: ac, border: `1px solid ${ac}` }}>{a.action}</span>
                    {a.isRisk && <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>{a.riskType === 'disposition' ? '🔴 處置股' : '🟡 注意股'}</span>}
                    <span style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: a.pnlPct >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{a.pnlPct >= 0 ? '+' : ''}{a.pnlPct.toFixed(2)}%</span>
                  </div>

                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '8px 0', fontSize: '0.78rem', fontFamily: 'JetBrains Mono, monospace' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>🎯 AI 推估目標：
                      <span style={{ color: 'var(--color-up)' }}> {a.targetPrice.low ?? '—'} / {a.targetPrice.mid ?? '—'} / {a.targetPrice.high ?? '—'}</span>
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}>🚫 停損 <span style={{ color: 'var(--color-down)' }}>{a.stopLoss ?? '—'}</span></span>
                  </div>

                  {a.sellTrigger && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-primary)', marginBottom: 6 }}>⏱️ <strong>脫手時機：</strong>{a.sellTrigger}</div>
                  )}
                  <div style={{ fontSize: '0.82rem', lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{a.rationale}</div>

                  {a.swingAdvice && (
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', fontSize: '0.8rem', lineHeight: 1.6, color: '#fcd34d' }}>
                      📈 <strong>波段操作建議：</strong>{a.swingAdvice}
                    </div>
                  )}

                  {a.newsSummary && (
                    <div style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--text-muted)' }}>📰 近一月新聞：{a.newsSummary}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 10, fontSize: '0.68rem', color: 'var(--text-muted)' }}>⚠️ 建議綜合技術/估值/新聞＋三大法人籌碼（勝率雷達階段·主力倒貨）研判；目標價為 AI 推估，僅供參考、非投資建議。</div>
        </>
      )}
    </div>
  );
}
