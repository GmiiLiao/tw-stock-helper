'use client';

// 🤖 AI 實驗後台共用元件（2026-09-24 UX 重整）：數字卡、交易單、查核徽章、人工檢討框。
// 設計原則：先給結論（淨損益元、勝率、AI 有沒有贏基準）→ 再給逐筆交易單（買賣時間、金額、費稅一眼可對）→ AI 的理由收在下面。
import { Fragment, useState } from 'react';
import type { SimLedger } from '../../../scripts/lib/ai-swing-lab.mjs';
import { storageGet, storageSet } from '@/lib/safe-storage';

export const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums' };
export const upDn = (v: number | null | undefined) => (v == null ? 'var(--text-muted)' : v > 0 ? 'var(--color-up)' : v < 0 ? 'var(--color-down)' : 'var(--text-muted)');
export const twd = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString()} 元`);
export const pct = (v: number | null | undefined, unit = '%') => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}${unit}`);
export const tw = (t: number | null | undefined, withDate = false) => {
  if (!t) return '—';
  const s = new Date(t + 8 * 3600000).toISOString();
  return withDate ? `${s.slice(5, 10)} ${s.slice(11, 19)}` : s.slice(11, 19);
};
const dur = (ms: number | null) => {
  if (ms == null) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} 分鐘`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小時 ${m % 60} 分`;
  return `${Math.round(m / 60 / 24)} 天`;
};

export function Kpi({ label, value, sub, color, hint }: { label: string; value: string; sub?: string; color?: string; hint?: string }) {
  return (
    <div title={hint} style={{ flex: '1 1 10em', minWidth: '10em', padding: '10px 12px', borderRadius: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)' }}>
      <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ ...MONO, fontSize: 'calc(20px * var(--fz))', fontWeight: 900, color: color || 'var(--text-primary)', lineHeight: 1.3 }}>{value}</div>
      {sub && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

export function VerifyBadge({ ok, decidedAt, entryAt }: { ok: boolean | null | undefined; decidedAt?: number | null; entryAt?: number | null }) {
  if (ok == null) return <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>反事實（非 AI 交易）</span>;
  return (
    <span title={`AI 決定：${tw(decidedAt, true)}\n進場：${tw(entryAt, true)}`}
      style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '1px 7px', borderRadius: 999, background: ok ? 'rgba(34,197,94,0.14)' : 'rgba(239,68,68,0.16)', color: ok ? '#22c55e' : '#ef4444' }}>
      {ok ? '✓ 先決定後成交' : '⚠ 時序異常（成交早於決定）'}
    </span>
  );
}

/**
 * 交易單：買進 | 賣出 兩欄對照（做空時「賣出」在前，時間會標出先後）＋ 費稅與淨損益。
 * counterfactual＝AI 沒下單、「若照工作台規則做」的模擬單（2026-09-29 使用者誤認為 AI 成交）：
 *   灰色虛線框＋頂部標示「不計入帳戶」、腿標「模擬」、損益不用紅綠大字，改寫「放棄得對／錯過獲利」判讀。
 */
export function TradeSlip({ L, muted = false, withDate = false, note, counterfactual = false }: { L: SimLedger; muted?: boolean; withDate?: boolean; note?: string; counterfactual?: boolean }) {
  const first = L.side === 'short' ? 'sell' : 'buy';
  const cf = counterfactual;
  const leg = (k: 'buy' | 'sell') => {
    const x = L[k];
    return (
      <div style={{ flex: '1 1 12em', minWidth: 0, padding: '6px 10px', borderRadius: 8, background: cf ? 'rgba(148,163,184,0.08)' : k === 'buy' ? 'rgba(240,62,62,0.06)' : 'rgba(47,158,68,0.06)' }}>
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          {cf ? '模擬' : ''}{k === 'buy' ? '買進' : '賣出'}{k === first ? '（先）' : '（後）'} · <span style={MONO}>{tw(x.at, withDate)}</span>
        </div>
        <div style={{ ...MONO, fontWeight: 800 }}>{L.legs && L.legs.filter(g => g.side === k).length > 1 ? `均價 ${x.px}` : x.px} × {L.shares.toLocaleString()} 股</div>
        <div style={{ ...MONO, fontSize: 'calc(12.5px * var(--fz))' }}>＝ {x.amount.toLocaleString()} 元<span style={{ color: 'var(--text-muted)' }}> · 手續費 {x.fee}{k === 'sell' ? ` · 稅 ${(x as SimLedger['sell']).tax}` : ''}</span></div>
      </div>
    );
  };
  const avoided = L.pnlTwd < 0;
  return (
    <div style={{ opacity: muted && !cf ? 0.78 : 1, ...(cf ? { border: '1px dashed rgba(148,163,184,0.55)', borderRadius: 10, padding: '6px 8px', color: 'var(--text-secondary, var(--text-muted))' } : {}) }}>
      {cf && <div style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 800, color: 'var(--text-muted)', marginBottom: 4 }}>🧪 AI 沒下單・以下是「若照工作台規則做」的模擬結果——不是 AI 的交易，不計入帳戶</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{first === 'buy' ? <>{leg('buy')}{leg('sell')}</> : <>{leg('sell')}{leg('buy')}</>}</div>
      {L.legs && L.legs.length > 2 && (
        <div style={{ marginTop: 4, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          分批明細：{L.legs.map((g, i) => <span key={i} style={{ ...MONO, marginRight: 10 }}>{g.side === 'buy' ? '買' : '賣'} {tw(g.at, withDate)} {g.px}×{g.shares}＝{g.amount.toLocaleString()}</span>)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline', marginTop: 4, fontSize: 'calc(13px * var(--fz))' }}>
        {cf ? <>
          <span style={{ ...MONO, color: 'var(--text-muted)' }}>若照做 淨 {twd(L.pnlTwd)}（{pct(L.retPct)}）</span>
          <span style={{ fontWeight: 800, color: avoided ? '#22c55e' : '#f59e0b' }}>{avoided ? '✅ AI 放棄＝避開這筆虧損' : L.pnlTwd > 0 ? '⚠ AI 放棄＝錯過這筆獲利' : '放棄與否損益相同'}</span>
        </> : <>
          <span style={{ ...MONO, fontSize: 'calc(15px * var(--fz))', fontWeight: 900, color: upDn(L.pnlTwd) }}>淨 {twd(L.pnlTwd)}</span>
          <span style={{ ...MONO, color: upDn(L.retPct) }}>{pct(L.retPct)}</span>
        </>}
        <span style={{ color: 'var(--text-muted)' }}>費稅合計 {L.costTwd} 元 · 持有 {dur(L.holdMs)} · {L.dayTrade ? '當沖稅 0.15%' : '證交稅 0.3%'} · 手續費 0.1425%{L.feeDiscount ? `×券商 ${+(L.feeDiscount * 10).toFixed(2)} 折（會員自己的折讓）` : ' 無折讓'}</span>
        {!cf && <VerifyBadge ok={L.noLookahead} decidedAt={L.decidedAt} entryAt={L.entryAt} />}
        {note && <span style={{ color: '#f59e0b' }}>{note}</span>}
      </div>
    </div>
  );
}

export function NotesBox({ initial, meta, onSave, msg, placeholder }: { initial: string; meta?: string; onSave: (v: string) => void; msg: string; placeholder: string }) {
  const [el, setEl] = useState<HTMLTextAreaElement | null>(null);
  return (
    <div style={{ marginTop: 12, padding: 10, borderRadius: 10, border: '1px dashed var(--border-primary)' }}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>📝 我的檢討與改進說明{meta ? <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>（{meta}）</span> : null}</div>
      {/* 非受控：後台有即時監聽會重繪，受控輸入會把游標打回開頭（CLAUDE.md） */}
      <textarea ref={setEl} defaultValue={initial} rows={4} maxLength={4000} placeholder={placeholder}
        style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6 }} />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
        <button onClick={() => el && onSave(el.value)} style={{ padding: '4px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: 'rgba(125,211,252,0.2)', color: '#7dd3fc', fontWeight: 800, fontSize: 'calc(13px * var(--fz))' }}>儲存</button>
        <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>{msg || '只存在獨立欄位、不改 AI 記錄；15 分鐘內同步到第二大腦'}</span>
      </div>
    </div>
  );
}

export function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(14px * var(--fz))' }}>{title}</span>
        {sub && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{sub}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * 清單表格：表頭固定、欄位對齊、窄螢幕橫向捲動；right＝靠右的數字欄。
 * （2026-09-30 使用者「清單內容可開啟收合」）選用：details＝每列的展開內容（點該列展開／收合，整列跨欄顯示）；
 *   stickyFirst＝第一欄（個股）橫向捲動時固定在左側；rowKeys＝每列穩定鍵（展開狀態依鍵記住，資料重載換序也不會開錯列）。
 *   三者預設關閉，既有頁面行為不變。
 */
export function ListTable({ head, rows, right = [], foot, empty = '無', maxHeight = 420, details, stickyFirst = false, rowKeys }: { head: string[]; rows: React.ReactNode[][]; right?: number[]; foot?: React.ReactNode[]; empty?: string; maxHeight?: number; details?: (React.ReactNode | null)[]; stickyFirst?: boolean; rowKeys?: string[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const keyOf = (k: number) => rowKeys?.[k] ?? String(k);
  const cell = (i: number): React.CSSProperties => ({ padding: '4px 8px', whiteSpace: 'nowrap', textAlign: right.includes(i) ? 'right' : 'left', ...(right.includes(i) ? MONO : {}),
    ...(stickyFirst && i === 0 ? { position: 'sticky', left: 0, background: 'var(--bg-elevated, var(--bg-primary))', zIndex: 1 } : {}) });
  if (!rows.length) return <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>{empty}</div>;
  const toggle = (id: string) => setOpen(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <div style={{ overflow: 'auto', maxHeight, border: '1px solid var(--border-primary)', borderRadius: 10 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'calc(12.5px * var(--fz))' }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={{ ...cell(i), position: 'sticky', top: 0, zIndex: stickyFirst && i === 0 ? 2 : 1, background: 'var(--bg-secondary)', color: 'var(--text-muted)', fontWeight: 700, borderBottom: '1px solid var(--border-primary)' }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, k) => {
          const det = details?.[k], id = keyOf(k);
          const isOpen = open.has(id);
          return (
            <Fragment key={id}>
              <tr onClick={det ? () => toggle(id) : undefined} style={{ borderBottom: isOpen ? 'none' : '1px dashed var(--border-primary)', cursor: det ? 'pointer' : undefined }}>
                {r.map((c, i) => <td key={i} style={cell(i)}>{i === 0 && det ? <button type="button" aria-expanded={isOpen} aria-label={isOpen ? '收合明細' : '展開明細'} onClick={e => { e.stopPropagation(); toggle(id); }} style={{ background: 'none', border: 'none', padding: '0 4px 0 0', cursor: 'pointer', color: '#7dd3fc' }}>{isOpen ? '▾' : '▸'}</button> : null}{c}</td>)}
              </tr>
              {det && isOpen && <tr style={{ borderBottom: '1px dashed var(--border-primary)' }}><td colSpan={head.length} style={{ padding: '6px 12px 10px 28px', background: 'var(--bg-secondary)', whiteSpace: 'normal', fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6 }}>{det}</td></tr>}
            </Fragment>
          );
        })}</tbody>
        {foot && <tfoot><tr style={{ fontWeight: 900, background: 'var(--bg-secondary)' }}>{foot.map((c, i) => <td key={i} style={cell(i)}>{c}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

/**
 * 可收合區塊（2026-09-30）：標題列可點開／收合，數量徽章讓收起來時也看得到有幾筆；開合狀態記在本機（下次打開維持）。
 * id 須全站唯一（存成 labCollapse:<id>）。
 */
export function Collapse({ id, title, sub, count, defaultOpen = true, tone, children }: { id: string; title: string; sub?: string; count?: number | string; defaultOpen?: boolean; tone?: string; children: React.ReactNode }) {
  const key = `labCollapse:${id}`;
  // 初始即讀本機記憶（避免掛載後才翻轉造成閃動）；僅用於用戶端渲染的區塊（此頁資料載入後才渲染，不在 SSR 輸出內）
  const [isOpen, setIsOpen] = useState(() => { const v = typeof window === 'undefined' ? null : storageGet(key); return v === '1' ? true : v === '0' ? false : defaultOpen; });
  const flip = () => setIsOpen(v => { storageSet(key, v ? '0' : '1'); return !v; });
  return (
    <section style={{ marginTop: 12, border: '1px solid var(--border-primary)', borderRadius: 12, overflow: 'hidden' }}>
      <button type="button" onClick={flip} aria-expanded={isOpen}
        style={{ width: '100%', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', padding: '8px 12px', background: 'var(--bg-secondary)', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text-primary)' }}>
        <span style={{ color: '#7dd3fc', width: 12 }}>{isOpen ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 900, fontSize: 'calc(14px * var(--fz))' }}>{title}</span>
        {count != null && <span style={{ ...MONO, fontSize: 'calc(12.5px * var(--fz))', padding: '0 8px', borderRadius: 999, background: tone || 'rgba(125,211,252,0.15)', color: 'var(--text-primary)' }}>{count}</span>}
        {sub && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{sub}</span>}
      </button>
      {isOpen && <div style={{ padding: '8px 10px 10px' }}>{children}</div>}
    </section>
  );
}
