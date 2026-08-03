'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { MODES, MODE_KEYS, dataProgress, type ModeKey } from '@/lib/trading-mode';

// ── 操作模式切換器（全站狀態）───────────────────────────────────────
// 選定後，評分／榜單／警報／問AI 技能注入全部跟著切。
// 設計重點：**每個模式都把自己的口徑與基準攤開講**——這個 app 的每個數字
// 都綁在一個口徑上，使用者不知道自己在哪個口徑就會誤用（波段訊號拿去隔日沖
// 是 -0.06%）。切換器本身就是口徑教學的位置。
// 當沖標為「資料累積中」且**不提供評分**，並顯示進度——原料只有 60 日、
// 距本站 480 日主窗＋OOT 標準還很遠，不做不誠實的宣稱。

const COLOR: Record<ModeKey, string> = { nextday: '#f03e3e', swing: '#3b82f6', daytrade: '#94a3b8' };

export default function ModeSwitcher({ compact = false }: { compact?: boolean }) {
  const mode = useAppStore(s => s.tradingMode);
  const setMode = useAppStore(s => s.setTradingMode);
  const [open, setOpen] = useState(false);
  // 資料閘門進度讀 daemon 算好的單一 doc——不要在前端數 intradayArchive 的文件數
  // （那是 N 次 Firestore 讀取 × 每個使用者，違反唯一不變式）。
  const [gate, setGate] = useState<{ intradayDays: number; snap0930Days: number; need: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    fetch('/api/system/mode-status')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.daytrade) setGate(d.daytrade); })
      .catch(() => {});
  }, [open]);
  const cur = MODES[mode];

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title={`目前操作模式：${cur.label}（${cur.horizon}）。點擊切換——切換後全站評分、榜單、警報與問AI 都會改用該模式的口徑。`}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          background: `${COLOR[mode]}1a`, border: `1px solid ${COLOR[mode]}66`,
          color: COLOR[mode], borderRadius: 8, padding: compact ? '3px 8px' : '5px 11px',
          fontSize: compact ? 11.5 : 12.5, fontWeight: 800, whiteSpace: 'nowrap',
        }}
      >
        <span>{cur.icon}</span>
        <span>{cur.label}</span>
        {!cur.hasScoreModel && <span style={{ fontSize: 9.5, opacity: 0.8 }}>無評分</span>}
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
          <div style={{
            position: 'absolute', top: '110%', right: 0, zIndex: 41, width: 320,
            background: 'var(--bg-card, #12151c)', border: '1px solid rgba(148,163,184,0.25)',
            borderRadius: 10, padding: 8, boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
          }}>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)', padding: '2px 6px 6px', lineHeight: 1.6 }}>
              每個模式的權重**各自回測、絕不互借**——同一個訊號換個持有期可以完全相反。
            </div>
            {MODE_KEYS.map(k => {
              const m = MODES[k], prog = dataProgress(k), on = k === mode;
              return (
                <button
                  key={k}
                  onClick={() => { setMode(k); setOpen(false); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    background: on ? `${COLOR[k]}14` : 'transparent',
                    border: `1px solid ${on ? `${COLOR[k]}55` : 'transparent'}`,
                    borderRadius: 8, padding: '7px 8px', marginTop: 3, color: 'var(--text-primary)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontWeight: 900, fontSize: 12.5, color: COLOR[k] }}>{m.icon} {m.label}</span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{m.horizon}</span>
                    {!m.hasScoreModel && (
                      <span style={{ marginLeft: 'auto', fontSize: 9.5, fontWeight: 800, color: '#fbbf24' }}>
                        {prog ? '資料累積中' : '無評分卡'}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.55, marginTop: 3 }}>
                    進場：{m.entry}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                    出場：{m.exit.replace(/\*\*/g, '')}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.55, marginTop: 2 }}>
                    基準：{m.baseline}｜成本 {m.costPct}%
                  </div>
                  {prog && (() => {
                    // 有線上實際進度就用實際的（daemon 每日更新），否則退回型別檔的靜態值
                    const have = k === 'daytrade' && gate ? Math.min(gate.intradayDays, gate.snap0930Days) : null;
                    const need = gate?.need ?? 480;
                    const pct = have != null ? Math.min(100, Math.round((have / need) * 100)) : prog.pct;
                    const txt = have != null
                      ? `第三關原料 ${gate!.intradayDays} 日／第一關原料 ${gate!.snap0930Days} 日（需 ${need}）`
                      : prog.text;
                    return (
                      <div style={{ marginTop: 4 }}>
                        <div style={{ height: 4, background: 'rgba(148,163,184,0.2)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${Math.max(pct, 1)}%`, height: '100%', background: '#fbbf24' }} />
                        </div>
                        <div style={{ fontSize: 9.5, color: '#fbbf24', marginTop: 2, lineHeight: 1.5 }}>
                          驗證原料 {txt} — 資料到位前只提供觀察工具，不給分數
                        </div>
                      </div>
                    );
                  })()}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
