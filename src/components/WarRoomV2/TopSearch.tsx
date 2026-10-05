'use client';

// 代號搜尋（專注模式下網站頂列 Header 被卸載，搜尋改由指揮列／手機面板承接）。
// 規則與 Header 的搜尋一致（src/components/Header/Header.tsx「Search」段）：
//   · 非受控輸入框：打字只寫 ref＋150ms 計時器，不觸發重繪；輸入法組字中不搜尋（注音反序事故）
//   · 比對 store.allStocks 的代號／名稱，取前 8 筆；清單沒有但是 4–6 碼代號 → 直接開個股頁
//   · Enter 開第一筆（組字確認的 Enter 放行給輸入法）；選取用 pointerdown（iOS 第一觸就生效）
// 不打任何請求：allStocks 是首屏載入的快照（專注模式期間不刷新）——所以下拉不顯示價格，只顯示代號與名稱。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import type { StockInfo } from '@/lib/twse-api';
import css from './TopZones.module.css';

const DEBOUNCE_MS = 150;
const MAX_RESULTS = 8;
const CODE_RE = /^\d{4,6}[a-z]?$/;

interface Hit { code: string; name: string; direct?: boolean }

function searchStocks(all: readonly StockInfo[], raw: string): Hit[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const out: Hit[] = [];
  for (const s of all) {
    if (!s) continue;
    const code = String(s.code ?? '').toLowerCase();
    const name = String(s.name ?? '').toLowerCase();
    if (code.includes(q) || name.includes(q)) out.push({ code: String(s.code), name: String(s.name ?? '') });
    if (out.length >= MAX_RESULTS) break;
  }
  if (!out.length && CODE_RE.test(q)) {
    out.push({ code: q.toUpperCase(), name: all.length ? '（不在清單）直接開啟' : '（清單載入中）直接開啟', direct: true });
  }
  return out;
}

function bestHit(all: readonly StockInfo[], raw: string): string | null {
  const q = raw.trim().toLowerCase();
  if (!q) return null;
  const exact = all.find(s => s && String(s.code).toLowerCase() === q);
  if (exact) return String(exact.code);
  const part = all.find(s => s && (String(s.code).toLowerCase().includes(q) || String(s.name ?? '').toLowerCase().includes(q)));
  if (part) return String(part.code);
  return CODE_RE.test(q) ? q.toUpperCase() : null;
}

const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

export default function TopSearch({ hotkey = false, placeholder = '搜尋代號　/' }: { hotkey?: boolean; placeholder?: string }) {
  const allStocks = useAppStore(s => s.allStocks);
  const navigateTo = useAppStore(s => s.navigateTo);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef('');
  const composingRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const hits = useMemo(() => searchStocks(allStocks, query), [allStocks, query]);

  const schedule = (v: string) => {
    queryRef.current = v;
    if (composingRef.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setQuery(queryRef.current); setOpen(true); }, DEBOUNCE_MS);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const reset = useCallback(() => {
    queryRef.current = '';
    setQuery('');
    setOpen(false);
    if (inputRef.current) { inputRef.current.value = ''; inputRef.current.blur(); }
  }, []);

  const go = useCallback((code: string) => {
    navigateTo('stock', code);
    reset();
  }, [navigateTo, reset]);

  // 點外面收起
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 「/」聚焦（桌機指揮列；正在輸入別的欄位時不攔）
  useEffect(() => {
    if (!hotkey) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { reset(); return; }
    if (e.key !== 'Enter') return;
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;   // 輸入法組字確認
    const code = bestHit(allStocks, queryRef.current);
    if (!code) return;
    e.preventDefault();
    go(code);
  };

  return (
    <div ref={wrapRef} className={css.search}>
      <input
        ref={inputRef}
        type="text"
        className={css.searchInput}
        placeholder={placeholder}
        defaultValue=""
        aria-label="搜尋股票代號或名稱"
        autoComplete="off"
        inputMode="search"
        enterKeyHint="search"
        onChange={(e) => schedule(e.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={(e) => { composingRef.current = false; schedule((e.target as HTMLInputElement).value); }}
        onFocus={() => { if (queryRef.current) setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {open && query.trim() && (
        <div className={css.searchDrop} role="listbox" aria-label="搜尋結果">
          {hits.length ? hits.map(h => (
            <button
              key={h.code}
              type="button"
              role="option"
              aria-selected={false}
              className={css.searchItem}
              onPointerDown={(e) => { e.preventDefault(); go(h.code); }}
              onClick={() => go(h.code)}
            >
              <span className={css.searchCode}>{h.code}</span>
              <span className={css.searchName}>{h.name}</span>
            </button>
          )) : <div className={css.searchEmpty}>找不到符合的代號或名稱</div>}
        </div>
      )}
    </div>
  );
}
