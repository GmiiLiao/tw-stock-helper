'use client';

// ── 候選便條（全頁浮動）───────────────────────────────────────────
// 跨頁選股工作流的核心：帶著候選走。任何頁「＋候選」加入，這裡隨時看/移除，
// 一鍵進盤中戰情的「決策工作台」分頁比對出策略與勝率。收合為小膠囊，常駐。

import { useState } from 'react';
import { useAppStore } from '@/lib/store';

export default function CandidateDock() {
  const codes = useAppStore(s => s.compareCodes);
  const allStocks = useAppStore(s => s.allStocks);
  const toggle = useAppStore(s => s.toggleCandidate);
  const clear = useAppStore(s => s.clearCandidates);
  const navigateTo = useAppStore(s => s.navigateTo);
  const setWarTab = useAppStore(s => s.setWarTab);
  const currentPage = useAppStore(s => s.currentPage);
  const warTab = useAppStore(s => s.warTab);
  const [open, setOpen] = useState(false);

  const openDesk = () => { setWarTab('desk'); navigateTo('war'); };

  if (currentPage === 'war' && warTab === 'desk') return null; // 工作台分頁內不重複顯示

  const rows = codes.map(code => {
    const s = allStocks.find(x => x.code === code);
    return { code, name: s?.name, price: s?.price, chg: s?.changePercent };
  });

  return (
    <div style={{ position: 'fixed', right: 12, bottom: 84, zIndex: 900, maxWidth: 'calc(100vw - 24px)' }}>
      {open ? (
        <div style={{ width: 288, maxWidth: 'calc(100vw - 24px)', borderRadius: 14, overflow: 'hidden',
          background: 'var(--bg-elevated)', border: '1px solid rgba(245,159,0,0.4)', boxShadow: '0 8px 28px rgba(0,0,0,0.35)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 12px', background: 'rgba(245,159,0,0.12)', borderBottom: '1px solid var(--border-primary)' }}>
            <span style={{ fontWeight: 900, fontSize: 13.5, color: '#f6a06a' }}>🗒️ 候選便條</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)' }}>{codes.length} 檔</span>
            <button onClick={clear} style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>清空</button>
            <button onClick={() => setOpen(false)} title="收合" style={{ fontSize: 14, lineHeight: 1, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer' }}>▾</button>
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto', padding: '6px 6px' }}>
            {rows.length === 0 && (
              <div style={{ padding: '10px 8px', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
                還沒有候選。瀏覽各頁時按 <b style={{ color: '#f59f00' }}>＋候選</b> 把有興趣的個股撿進來，
                再到各頁開「🗒️ 只看候選」用該頁角度評估，或進決策工作台比對。
              </div>
            )}
            {rows.map(r => (
              <div key={r.code} onClick={() => navigateTo('stock', r.code)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 7px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5 }}>
                <span style={{ fontWeight: 800, minWidth: 40, color: '#7dd3fc' }}>{r.code}</span>
                <span style={{ fontWeight: 600, flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name || '—'}</span>
                {r.price != null && <span style={{ color: 'var(--text-secondary)' }}>{r.price}</span>}
                {r.chg != null && <span style={{ fontWeight: 700, minWidth: 42, textAlign: 'right', color: r.chg >= 0 ? '#f03e3e' : '#2f9e44' }}>{r.chg >= 0 ? '+' : ''}{r.chg.toFixed(1)}%</span>}
                <button onClick={(e) => { e.stopPropagation(); toggle(r.code); }} title="移除"
                  style={{ fontSize: 13, lineHeight: 1, color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 2px' }}>×</button>
              </div>
            ))}
          </div>
          {rows.length > 0 && (
            <div style={{ padding: '8px 10px', borderTop: '1px solid var(--border-primary)' }}>
              <button onClick={openDesk}
                style={{ width: '100%', padding: '9px', borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: 'pointer',
                  border: 'none', background: 'linear-gradient(135deg,#f59e0b,#e8590c)', color: '#fff' }}>
                → 決策工作台（比對策略＋勝率）
              </button>
            </div>
          )}
        </div>
      ) : (
        <button onClick={() => setOpen(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 15px', borderRadius: 24, cursor: 'pointer',
            border: '1px solid rgba(245,159,0,0.5)', background: 'var(--bg-elevated)', boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
            fontSize: 13.5, fontWeight: 800, color: '#f6a06a' }}>
          🗒️ 候選 <span style={{ background: '#f59e0b', color: '#fff', borderRadius: 10, padding: '1px 8px', fontSize: 12 }}>{codes.length}</span>
        </button>
      )}
    </div>
  );
}
