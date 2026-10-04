'use client';

// 官方化重訓驗證：命中／漏網／母體外逐列瀏覽（伺服器端篩選＋分頁，每頁 200 列；/api/admin/surge-shadow?view=cvrows）。
// 文字／數字輸入一律非受控（defaultValue＋ref）：手機 IME 下受控輸入會把游標打回開頭（CLAUDE.md）。按「查詢」或 Enter 才送出。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CvVersion, CvTaskId, RowsCell } from '../../../scripts/lib/surge-lab-report.mjs';
import { labGet } from './surgeLabFetch';
import { MONO } from './AiLabParts';

interface Page { found: boolean; note?: string; doc?: { id: string; totalRows: number; keptRows: number; filterNote: string | null; model: string; verified?: boolean; verifyNote?: string | null }; cols: string[]; rows: RowsCell[][]; total: number; page: number; pages: number; pageSize: number; rankIgnored: boolean }
type Kind = 'hits' | 'misses' | 'outside';
const KIND_LABEL: Record<Kind, string> = { hits: '命中（前 10 內）', misses: '漏網（真事件、名次 >10）', outside: '母體外（被濾網擋掉的事件）' };
const COL_LABEL: Record<string, string> = { date: '打分日', event_day: '事件日', code: '代號', name: '名稱', market: '市場', score: '分數', rank: '同日名次', n_day: '當日母體', result: '結果', reason: '擋掉原因' };
const CORE = new Set(Object.keys(COL_LABEL));
const inputStyle: React.CSSProperties = { padding: '3px 8px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-input, var(--bg-secondary))', color: 'var(--text-primary)', fontSize: 'calc(12.5px * var(--fz))' };

function cellText(c: string, v: RowsCell): string {
  if (v === null || v === '') return '—';
  if (c === 'market') return v === 'tse' ? '上市' : v === 'otc' ? '上櫃' : String(v);
  if (c.startsWith('有值:')) return v === 1 ? '✓' : v === 0 ? '✗' : String(v);
  if (typeof v === 'number' && c.startsWith('pct_')) return v.toFixed(3);
  if (typeof v === 'number' && c === 'score') return v.toFixed(4);
  return String(v);
}

export default function SurgeCvRows({ task, v }: { task: CvTaskId; v: CvVersion }) {
  const [model, setModel] = useState<'base' | 'official'>('official');
  const [kind, setKind] = useState<Kind>('misses');
  const [market, setMarket] = useState<'all' | 'tse' | 'otc'>('all');
  const [sort, setSort] = useState<'date' | 'rank'>('date');
  const [page, setPage] = useState(1);
  const [showPct, setShowPct] = useState(false);
  const [showSrc, setShowSrc] = useState(false);
  const [data, setData] = useState<Page | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(0);   // 「查詢」被按的次數：輸入框是非受控，靠它觸發重查
  const qRef = useRef<HTMLInputElement>(null); const minRef = useRef<HTMLInputElement>(null); const maxRef = useRef<HTMLInputElement>(null);
  const fromRef = useRef<HTMLInputElement>(null); const toRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const filt = useRef<Record<string, string>>({});   // 按「查詢」當下的輸入框快照：翻頁沿用已套用的條件，不吃打到一半的字

  const load = useCallback(async () => {
    const my = ++seq.current;
    const p = new URLSearchParams({ view: 'cvrows', task, version: v.id, model, kind, market, sort, page: String(page) });
    for (const [k, x] of Object.entries(filt.current)) if (x) p.set(k, x);
    setBusy(true); setErr('');
    const r = await labGet<Page>(p.toString());
    if (my !== seq.current) return;
    setBusy(false);
    if (r.ok) setData(r.data); else setErr(r.error);
  }, [task, v.id, model, kind, market, sort, page]);
  // applied 變動（按查詢）也要重查；load 的依賴只有受控條件
  useEffect(() => { void load(); }, [load, applied]);

  const apply = () => {
    const val = (el: HTMLInputElement | null) => el?.value.trim() ?? '';
    filt.current = { q: val(qRef.current), rankMin: val(minRef.current), rankMax: val(maxRef.current), from: val(fromRef.current), to: val(toRef.current) };
    setPage(1); setApplied(n => n + 1);
  };
  const onKey = (e: React.KeyboardEvent) => { if (e.key === 'Enter') apply(); };
  const cols = data?.cols ?? [];
  const visible = cols.map((c, i) => [c, i] as const).filter(([c]) => CORE.has(c) || (showPct && c.startsWith('pct_')) || (showSrc && c.startsWith('有值:')));
  const sel = (on: boolean): React.CSSProperties => ({ ...inputStyle, cursor: 'pointer', fontWeight: on ? 700 : 400 });
  const rowsSlot = v.rows?.[model] as Record<string, { filterNote?: string | null; skipped?: string }> | { skipped: string } | undefined;
  const skipped = rowsSlot && 'skipped' in rowsSlot && typeof rowsSlot.skipped === 'string' ? rowsSlot.skipped : null;
  const outSlot = v.rows?.outside?.[model] as { skipped?: string } | undefined;
  const outSkipped = typeof outSlot?.skipped === 'string' ? outSlot.skipped : null;

  return (
    <div style={{ display: 'grid', gap: 8, fontSize: 'calc(12.5px * var(--fz))' }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <select aria-label="模型" value={model} onChange={e => { setModel(e.target.value as 'base' | 'official'); setPage(1); }} style={sel(false)}><option value="official">official</option><option value="base">base</option></select>
        <select aria-label="種類" value={kind} onChange={e => { setKind(e.target.value as Kind); setPage(1); }} style={sel(false)}>
          {(Object.keys(KIND_LABEL) as Kind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select aria-label="市場" value={market} onChange={e => { setMarket(e.target.value as 'all' | 'tse' | 'otc'); setPage(1); }} style={sel(false)}><option value="all">全部市場</option><option value="tse">上市</option><option value="otc">上櫃</option></select>
        <select aria-label="排序" value={sort} onChange={e => { setSort(e.target.value as 'date' | 'rank'); setPage(1); }} style={sel(false)}><option value="date">日期新→舊</option><option value="rank">名次小→大</option></select>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input ref={qRef} defaultValue="" placeholder="代號／名稱" maxLength={20} onKeyDown={onKey} style={{ ...inputStyle, width: '8em' }} />
        <span>名次</span>
        <input ref={minRef} defaultValue="" inputMode="numeric" placeholder="最小" onKeyDown={onKey} style={{ ...inputStyle, width: '4.5em' }} />
        <span>～</span>
        <input ref={maxRef} defaultValue="" inputMode="numeric" placeholder="最大" onKeyDown={onKey} style={{ ...inputStyle, width: '4.5em' }} />
        <input ref={fromRef} defaultValue="" placeholder="起 YYYY-MM-DD" maxLength={10} onKeyDown={onKey} style={{ ...inputStyle, width: '8.5em', ...MONO }} />
        <input ref={toRef} defaultValue="" placeholder="迄 YYYY-MM-DD" maxLength={10} onKeyDown={onKey} style={{ ...inputStyle, width: '8.5em', ...MONO }} />
        <button type="button" onClick={apply} style={{ ...inputStyle, cursor: 'pointer', color: '#7dd3fc', fontWeight: 800 }}>查詢</button>
        <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={showPct} onChange={e => setShowPct(e.target.checked)} />特徵百分位</label>
        <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={showSrc} onChange={e => setShowSrc(e.target.checked)} />來源有值</label>
      </div>
      {skipped && kind !== 'outside' && <div style={{ color: '#f59e0b' }}>⚠ 這個模型的逐列未發佈：{skipped}</div>}
      {outSkipped && kind === 'outside' && <div style={{ color: '#f59e0b' }}>⚠ 這個模型的母體外未發佈：{outSkipped}</div>}
      {data?.found && data.doc?.verified === false && <div style={{ color: '#f59e0b' }}>⚠ {data.doc.verifyNote || '未驗證：這份逐列沒有可對照的摘要筆數'}</div>}
      {err && <div style={{ color: '#ef4444' }}>載入失敗：{err}</div>}
      {data && !data.found && <div style={{ color: 'var(--text-muted)' }}>{data.note || '沒有資料'}</div>}
      {data?.found && (
        <>
          <div style={{ color: 'var(--text-muted)' }}>
            符合 <b style={{ color: 'var(--text-primary)' }}>{data.total.toLocaleString()}</b> 列（文件 {data.doc?.keptRows.toLocaleString()}／原始 {data.doc?.totalRows.toLocaleString()} 列）
            {data.doc?.filterNote ? `｜${data.doc.filterNote}` : ''}{data.doc?.model === 'all' ? '｜母體外與模型無關（兩模型同一份）' : ''}{data.rankIgnored ? '｜母體外沒有名次，名次條件不適用' : ''}{busy ? '｜載入中…' : ''}
          </div>
          <div style={{ overflow: 'auto', maxHeight: 520, border: '1px solid var(--border-primary)', borderRadius: 10 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', ...MONO, fontSize: 'calc(12px * var(--fz))', whiteSpace: 'nowrap' }}>
              <thead><tr>{visible.map(([c], j) => <th key={c} style={{ position: 'sticky', top: 0, zIndex: j === 0 ? 2 : 1, left: j === 0 ? 0 : undefined, background: 'var(--bg-secondary)', padding: '4px 8px', textAlign: 'left', color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)' }}>{COL_LABEL[c] ?? c.replace(/^pct_/, '')}</th>)}</tr></thead>
              <tbody>{data.rows.map((r, k) => (
                <tr key={k} style={{ borderBottom: '1px dashed var(--border-primary)' }}>
                  {visible.map(([c, i], j) => <td key={c} style={{ padding: '3px 8px', ...(j === 0 ? { position: 'sticky', left: 0, background: 'var(--bg-elevated, var(--bg-primary))' } : {}) }}>{cellText(c, r[i])}</td>)}
                </tr>
              ))}</tbody>
            </table>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" disabled={data.page <= 1 || busy} onClick={() => setPage(p => Math.max(1, p - 1))} style={{ ...inputStyle, cursor: 'pointer' }}>‹ 上一頁</button>
            <span style={MONO}>{data.page}／{data.pages}</span>
            <button type="button" disabled={data.page >= data.pages || busy} onClick={() => setPage(p => p + 1)} style={{ ...inputStyle, cursor: 'pointer' }}>下一頁 ›</button>
          </div>
        </>
      )}
      <div style={{ color: 'var(--text-muted)' }}>百分位＝同日母體內百分位（0～1）；有值＝該來源當天對這檔有資料。研究記錄，未扣成本；非投資建議。</div>
    </div>
  );
}
