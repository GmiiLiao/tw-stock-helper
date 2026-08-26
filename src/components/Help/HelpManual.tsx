'use client';

// ── 📖 使用說明書（帳號選單進入）──────────────────────────────────
// 三部分：① 隔日沖操作流程（使用者投資觀念導入） ② 各頁功能說明
// ③ 完整術語表（可搜尋）。內容與每頁收合說明同源（help-content.ts）。

import { useMemo, useState, useEffect } from 'react';
import { PrivacyContent } from '@/components/Help/PrivacyNotice';
import { PAGE_HELP, GLOSSARY, WORKFLOW, ONBOARDING, visibleLines, type FlowStep } from '@/lib/help-content';
import { useAppStore } from '@/lib/store';
import { usePremiumAccess } from '@/lib/access';

const PAGE_ORDER = ['dashboard', 'picker', 'war', 'desk', 'tracker', 'portfolio', 'backtest', 'stock'];
type Section = 'onboard' | 'flow' | 'pages' | 'glossary' | 'privacy';

// 依權限過濾步驟並重編號（premium 步驟隱藏後序號不跳號）；plus＝高級補充句
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
function stepsFor(steps: FlowStep[], hasPremium: boolean): { t: string; d: string }[] {
  return steps
    .filter(s => !s.premium || hasPremium)
    .map((s, i) => ({
      t: `${CIRCLED[i] || `${i + 1}.`} ${s.t.replace(/^[①-⑩]\s*/, '')}`,
      d: s.plus && hasPremium ? `${s.d}${s.plus}` : s.d,
    }));
}

export default function HelpManual() {
  const navigateTo = useAppStore(s => s.navigateTo);
  const hasPremium = usePremiumAccess();
  // 深連結：選單「🔒 隱私聲明」設定 helpSection 後導到本頁，這裡開在該章節。
  // 用完即清，否則下次從別處進說明書還會停在隱私頁。
  const deepLink = useAppStore(s2 => s2.helpSection);
  const setHelpSection = useAppStore(s2 => s2.setHelpSection);
  const [section, setSection] = useState<Section>((deepLink as Section) || 'onboard');
  useEffect(() => { if (deepLink) setHelpSection(null); }, [deepLink, setHelpSection]);
  const [q, setQ] = useState('');
  const [openPage, setOpenPage] = useState<string | null>(hasPremium ? 'war' : 'dashboard');
  // 權限一致性（使用者定案）：沒有權限的功能，說明書也不出現
  const visiblePages = PAGE_ORDER.filter(pid => !PAGE_HELP[pid]?.premium || hasPremium);
  const onboardSteps = stepsFor(ONBOARDING.steps, hasPremium);
  const flowSteps = stepsFor(WORKFLOW.steps, hasPremium);

  const glossaryEntries = useMemo(() => {
    const entries = Object.entries(GLOSSARY);
    if (!q.trim()) return entries;
    const k = q.trim();
    return entries.filter(([t, d]) => t.includes(k) || d.includes(k));
  }, [q]);

  const SECTIONS: { key: Section; label: string }[] = [
    { key: 'onboard', label: '🚀 新手上路' },
    { key: 'flow', label: '🧭 隔日沖操作流程' },
    { key: 'pages', label: '🗂 各頁功能說明' },
    { key: 'glossary', label: '📚 術語表' },
    { key: 'privacy', label: '🔒 隱私聲明' },
  ];

  return (
    <div style={{ padding: '14px 16px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900 }}>📖 使用說明書</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>操作流程 · 各頁說明 · 術語解釋（每頁也有「❔本頁說明」可就地查看）</span>
      </div>

      {/* 章節切換 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 14px' }}>
        {SECTIONS.map(s => {
          const on = section === s.key;
          return (
            <button key={s.key} onClick={() => setSection(s.key)}
              style={{ padding: '6px 14px', borderRadius: 10, fontSize: 'calc(13px * var(--fz))', fontWeight: 800, cursor: 'pointer',
                border: `1px solid ${on ? 'rgba(125,211,252,0.6)' : 'var(--border-primary)'}`,
                background: on ? 'rgba(125,211,252,0.14)' : 'transparent',
                color: on ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {s.label}
            </button>
          );
        })}
      </div>

      {section === 'onboard' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(125,211,252,0.08)', border: '1px solid rgba(125,211,252,0.35)', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.8 }}>
            <div style={{ fontWeight: 900, fontSize: 'calc(14.5px * var(--fz))', marginBottom: 4 }}>{ONBOARDING.title}</div>
            <div style={{ color: 'var(--text-secondary)' }}>{ONBOARDING.intro}</div>
          </div>
          {onboardSteps.map((s2, i) => (
            <div key={i} style={{ padding: '10px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.8 }}>
              <div style={{ fontWeight: 900, color: '#7dd3fc' }}>{s2.t}</div>
              <div style={{ color: 'var(--text-secondary)' }}>{s2.d}</div>
            </div>
          ))}
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.8 }}>
            ⚠ 流程為工具使用順序建議、非投資建議；所有勝率為歷史回測估計非保證，交易風險自負。
          </div>
        </div>
      )}

      {section === 'flow' && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(245,159,0,0.07)', border: '1px solid rgba(245,159,0,0.3)', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.8 }}>
            <div style={{ fontWeight: 900, fontSize: 'calc(14.5px * var(--fz))', marginBottom: 4 }}>{WORKFLOW.title}</div>
            <div style={{ color: 'var(--text-secondary)' }}>{WORKFLOW.intro}</div>
          </div>
          {flowSteps.map((s, i) => (
            <div key={i} style={{ padding: '10px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.8 }}>
              <div style={{ fontWeight: 900, color: '#f6a06a' }}>{s.t}</div>
              <div style={{ color: 'var(--text-secondary)' }}>{s.d}</div>
            </div>
          ))}
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.8 }}>
            ⚠ 本流程為工具使用順序建議，非投資建議；所有勝率為歷史回測估計、非未來保證。交易風險自負，進場鐵律：單筆風險≤1%。
          </div>
        </div>
      )}

      {section === 'pages' && (
        <div style={{ display: 'grid', gap: 8 }}>
          {visiblePages.map(pid => {
            const c = PAGE_HELP[pid];
            if (!c) return null;
            const open = openPage === pid;
            const how = visibleLines(c.how, hasPremium);
            const read = visibleLines(c.read, hasPremium);
            return (
              <div key={pid} style={{ borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', overflow: 'hidden' }}>
                <div onClick={() => setOpenPage(open ? null : pid)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer' }}>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
                  <span style={{ fontWeight: 900, fontSize: 'calc(13.5px * var(--fz))' }}>{c.icon} {c.title}</span>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.what}</span>
                </div>
                {open && (
                  <div style={{ padding: '0 14px 12px', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.8 }}>
                    <div style={{ fontWeight: 800, color: '#7dd3fc', margin: '4px 0 2px' }}>🖱 怎麼操作</div>
                    {how.map((h, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>· {h}</div>)}
                    <div style={{ fontWeight: 800, color: '#f6a06a', margin: '8px 0 2px' }}>👁 怎麼判讀</div>
                    {read.map((r, i) => <div key={i} style={{ color: 'var(--text-secondary)' }}>· {r}</div>)}
                    {c.terms.length > 0 && (
                      <div style={{ marginTop: 8, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                        相關術語：{c.terms.join('、')}（見「📚 術語表」）
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {section === 'glossary' && (
        <div>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="搜尋術語或內容…（例：倒貨、T+2、勝率）"
            style={{ width: '100%', maxWidth: 420, padding: '8px 12px', borderRadius: 10, fontSize: 'calc(13px * var(--fz))', marginBottom: 12,
              border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)' }} />
          <div style={{ display: 'grid', gap: 6 }}>
            {glossaryEntries.map(([t, d]) => (
              <div key={t} style={{ padding: '9px 13px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.8 }}>
                <b style={{ color: '#c4b5fd' }}>{t}</b>
                <span style={{ color: 'var(--text-secondary)' }}>：{d}</span>
              </div>
            ))}
            {glossaryEntries.length === 0 && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: '10px 4px' }}>找不到「{q}」——換個關鍵字試試。</div>}
          </div>
        </div>
      )}

      {/* 🔒 隱私聲明（2026-08-27 使用者要求：由獨立頁併入說明書）
          內容單一來源在 PrivacyNotice.tsx，兩處共用，不複製第二份。 */}
      {section === 'privacy' && <PrivacyContent />}

      <div style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => navigateTo('dashboard')}
          style={{ padding: '7px 16px', borderRadius: 10, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, cursor: 'pointer', border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-secondary)' }}>
          ← 回市場總覽
        </button>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>本說明書隨功能更新同步維護。非投資建議。</span>
      </div>
    </div>
  );
}
