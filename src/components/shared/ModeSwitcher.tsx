'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/lib/store';
import { MODES, MODE_KEYS, dataProgress, type ModeKey } from '@/lib/trading-mode';

// ── 操作模式切換器（全站狀態）───────────────────────────────────────
// 選定後，評分／榜單／警報／問AI 技能注入全部跟著切。
// 設計重點：**每個模式都把自己的口徑與基準攤開講**——這個 app 的每個數字
// 都綁在一個口徑上，使用者不知道自己在哪個口徑就會誤用（波段訊號拿去隔日沖
// 是 -0.06%）。切換器本身就是口徑教學的位置。
//
// ⚠**下拉必須用 portal**（2026-08-03 修）：本元件掛在左側邊欄裡，而
//   `.navbar` 有 `overflow-x: hidden` + `overflow-y: auto`——絕對定位的面板會
//   被水平裁掉、而且跟著側邊欄捲動，結果就是「看得到一半、點不到選項」。
//   改為 createPortal 到 document.body ＋ fixed 定位（座標取自按鈕的
//   getBoundingClientRect），完全脫離父層的 overflow 與 stacking context。

const COLOR: Record<ModeKey, string> = { nextday: '#f03e3e', swing: '#3b82f6', daytrade: '#94a3b8' };
const PANEL_W = 330;

export default function ModeSwitcher({ compact = false }: { compact?: boolean }) {
  const mode = useAppStore(s => s.tradingMode);
  const setMode = useAppStore(s => s.setTradingMode);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 資料閘門進度讀 daemon 算好的單一 doc——不要在前端數 intradayArchive 的文件數
  // （那是 N 次 Firestore 讀取 × 每個使用者，違反唯一不變式）。
  const [gate, setGate] = useState<{ intradayDays: number; snap0930Days: number; need: number } | null>(null);

  useEffect(() => { setMounted(true); }, []);   // portal 只能在 client 掛載後用

  useEffect(() => {
    if (!open || gate) return;
    fetch('/api/system/mode-status')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d?.daytrade) setGate(d.daytrade); })
      .catch(() => {});
  }, [open, gate]);

  // 面板座標：夾在視窗內，避免右側或下方溢出（手機直式會貼齊左緣）
  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - PANEL_W - 8));
    setPos({ top: r.bottom + 6, left });
  }, []);

  // ⚠**不要用全螢幕遮罩關閉**（2026-08-03 實測踩到）：遮罩會在 mousedown 與
  //   mouseup 之間掛上，滑鼠放開時落在遮罩上 → 面板當場被關掉，看起來就是
  //   「按了沒反應」。改用 document 的 pointerdown 判斷點擊是否落在面板/按鈕外。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return;
    const on = () => place();
    window.addEventListener('resize', on);
    window.addEventListener('scroll', on, true);   // capture：側邊欄自己捲動時也要跟上
    return () => { window.removeEventListener('resize', on); window.removeEventListener('scroll', on, true); };
  }, [open, place]);

  const cur = MODES[mode];

  const panel = pos && (
      <div
        ref={panelRef}
        role="listbox"
        aria-label="操作模式"
        style={{
          position: 'fixed', top: pos.top, left: pos.left, zIndex: 3001,
          width: PANEL_W, maxWidth: 'calc(100vw - 16px)',
          maxHeight: 'calc(100vh - 90px)', overflowY: 'auto',
          background: 'var(--bg-card, #12151c)', border: '1px solid rgba(148,163,184,0.28)',
          borderRadius: 10, padding: 8, boxShadow: '0 10px 32px rgba(0,0,0,0.55)',
        }}
      >
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', padding: '2px 6px 6px', lineHeight: 1.6 }}>
          每個模式的權重各自回測、絕不互借——同一個訊號換個持有期可以完全相反。
        </div>
        {MODE_KEYS.map(k => {
          const m = MODES[k], prog = dataProgress(k), on = k === mode;
          const have = k === 'daytrade' && gate ? Math.min(gate.intradayDays, gate.snap0930Days) : null;
          const need = gate?.need ?? 480;
          const pct = have != null ? Math.min(100, Math.round((have / need) * 100)) : prog?.pct ?? 0;
          return (
            <button
              key={k}
              role="option"
              aria-selected={on}
              onClick={() => { setMode(k); setOpen(false); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                background: on ? `${COLOR[k]}1f` : 'transparent',
                border: `1px solid ${on ? `${COLOR[k]}66` : 'rgba(148,163,184,0.12)'}`,
                borderRadius: 8, padding: '8px 9px', marginTop: 4, color: 'var(--text-primary)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 900, fontSize: 12.5, color: COLOR[k] }}>{m.icon} {m.label}</span>
                <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{m.horizon}</span>
                {on && <span style={{ fontSize: 10, fontWeight: 800, color: COLOR[k] }}>✓ 使用中</span>}
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
              {prog && (
                <div style={{ marginTop: 5 }}>
                  <div style={{ height: 4, background: 'rgba(148,163,184,0.2)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.max(pct, 1)}%`, height: '100%', background: '#fbbf24' }} />
                  </div>
                  <div style={{ fontSize: 9.5, color: '#fbbf24', marginTop: 3, lineHeight: 1.5 }}>
                    {have != null
                      ? `第三關原料 ${gate!.intradayDays} 日／第一關原料 ${gate!.snap0930Days} 日（需 ${need}）`
                      : prog.text}
                    ——資料到位前只提供觀察工具，不給分數
                  </div>
                </div>
              )}
            </button>
          );
        })}
      </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`目前操作模式：${cur.label}（${cur.horizon}）。點擊切換——切換後全站評分、榜單、警報與問AI 都會改用該模式的口徑。`}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
          background: `${COLOR[mode]}1a`, border: `1px solid ${COLOR[mode]}66`,
          color: COLOR[mode], borderRadius: 8, padding: compact ? '4px 9px' : '5px 11px',
          fontSize: compact ? 11.5 : 12.5, fontWeight: 800, whiteSpace: 'nowrap',
        }}
      >
        <span>{cur.icon}</span>
        <span>{cur.label}</span>
        {!cur.hasScoreModel && <span style={{ fontSize: 9.5, opacity: 0.8 }}>無評分</span>}
        <span style={{ fontSize: 9, opacity: 0.7, transform: open ? 'rotate(180deg)' : undefined }}>▾</span>
      </button>
      {mounted && open && createPortal(panel, document.body)}
    </>
  );
}
