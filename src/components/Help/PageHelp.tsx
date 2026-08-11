'use client';

// ── 每頁收合說明 ───────────────────────────────────────────────────
// 各頁頂部一顆「❔ 本頁說明」：這頁做什麼→怎麼操作→怎麼判讀→術語。
// 內容來自 help-content.ts；開合狀態記憶於 localStorage（預設收合）。
// 術語點擊展開白話解釋；「📖 完整說明書」連到帳號選單的說明書頁。

import { useEffect, useState } from 'react';
import { PAGE_HELP, GLOSSARY, visibleLines } from '@/lib/help-content';
import { useAppStore } from '@/lib/store';
import { usePremiumAccess } from '@/lib/access';

export default function PageHelp({ id }: { id: string }) {
  const content = PAGE_HELP[id];
  const hasPremium = usePremiumAccess();
  const navigateTo = useAppStore(s => s.navigateTo);
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState<string | null>(null);

  useEffect(() => {
    try { setOpen(localStorage.getItem(`pageHelp:${id}`) === '1'); } catch { /* ignore */ }
  }, [id]);
  const toggle = () => {
    setOpen(o => {
      const n = !o;
      try { localStorage.setItem(`pageHelp:${id}`, n ? '1' : '0'); } catch { /* ignore */ }
      return n;
    });
  };

  // 權限一致性：整頁高級限定的說明，非會員（頁面本就到不了）不渲染
  if (!content || (content.premium && !hasPremium)) return null;
  const how = visibleLines(content.how, hasPremium);
  const read = visibleLines(content.read, hasPremium);

  return (
    <div style={{ marginBottom: 10 }}>
      <button onClick={toggle} aria-expanded={open}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderRadius: 14, fontSize: 'calc(12px * var(--fz))', fontWeight: 700, cursor: 'pointer',
          border: `1px solid ${open ? 'rgba(125,211,252,0.55)' : 'var(--border-primary)'}`,
          background: open ? 'rgba(125,211,252,0.12)' : 'transparent',
          color: open ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        ❔ 本頁說明 {open ? '▾' : '▸'}
      </button>

      {open && (
        <div style={{ marginTop: 8, padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid rgba(125,211,252,0.25)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.8 }}>
          <div style={{ fontWeight: 900, fontSize: 'calc(13.5px * var(--fz))', marginBottom: 4 }}>{content.icon} {content.title}：{content.what}</div>

          <div style={{ fontWeight: 800, color: '#7dd3fc', margin: '8px 0 2px' }}>🖱 怎麼操作</div>
          {how.map((h, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>· {h}</div>)}

          <div style={{ fontWeight: 800, color: '#f6a06a', margin: '8px 0 2px' }}>👁 怎麼判讀</div>
          {read.map((r, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>· {r}</div>)}

          {content.terms.length > 0 && (
            <>
              <div style={{ fontWeight: 800, color: '#c4b5fd', margin: '8px 0 4px' }}>📚 本頁術語（點擊看解釋）</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {content.terms.map(t => {
                  const on = term === t;
                  return (
                    <button key={t} onClick={() => setTerm(on ? null : t)}
                      style={{ padding: '2px 10px', borderRadius: 12, fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700, cursor: 'pointer',
                        border: `1px solid ${on ? 'rgba(196,181,253,0.6)' : 'var(--border-primary)'}`,
                        background: on ? 'rgba(196,181,253,0.14)' : 'transparent',
                        color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {t}
                    </button>
                  );
                })}
              </div>
              {term && GLOSSARY[term] && (
                <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: 'rgba(196,181,253,0.08)', border: '1px solid rgba(196,181,253,0.3)' }}>
                  <b style={{ color: '#c4b5fd' }}>{term}</b>：{GLOSSARY[term]}
                </div>
              )}
            </>
          )}

          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={() => navigateTo('help')}
              style={{ padding: '4px 12px', borderRadius: 10, fontSize: 'calc(11.5px * var(--fz))', fontWeight: 800, cursor: 'pointer', border: '1px solid rgba(125,211,252,0.45)', background: 'rgba(125,211,252,0.10)', color: '#7dd3fc' }}>
              📖 完整說明書（操作流程＋全部術語）
            </button>
            <span style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)' }}>非投資建議。</span>
          </div>
        </div>
      )}
    </div>
  );
}
