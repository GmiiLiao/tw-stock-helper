'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAppStore } from '@/lib/store';
import { marketBadge, type StockInfo } from '@/lib/twse-api';
import RiskBadge from '@/components/shared/RiskBadge';
import styles from './AfterMarket.module.css';

// 盤後報告共用骨架：一張卡＝一個公開 API。掛載時 fetch 一次（不輪詢），失敗只顯示本卡錯誤、不影響其他卡。
// 只放「盤後定版或收盤後穩定」的公開資料；會員限定（premium）與盤中即時資料不進這一頁。

export type ApiState = 'loading' | 'ok' | 'empty' | 'error';

// 同一網址 60 秒內共用同一次 fetch（頁首更新時間、分析報告、各分頁都讀同一支 API 時不重複請求）；失敗不快取。
const FETCH_CACHE = new Map<string, { t: number; p: Promise<unknown> }>();
function fetchCached(url: string): Promise<unknown> {
  const hit = FETCH_CACHE.get(url);
  if (hit && Date.now() - hit.t < 60_000) return hit.p;
  const p = fetch(url).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
  FETCH_CACHE.set(url, { t: Date.now(), p });
  p.catch(() => FETCH_CACHE.delete(url));
  return p;
}

/** 讀一個 JSON API。null／空物件／{found:false} 視為 empty；HTTP 非 2xx（含 503）視為 error。 */
export function useApi<T>(url: string): { data: T | null; state: ApiState } {
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<ApiState>('loading');
  useEffect(() => {
    let live = true;
    fetchCached(url)
      .then((j) => {
        if (!live) return;
        const o = j as Record<string, unknown> | null;
        const empty = o == null || (typeof o === 'object' && (Object.keys(o).length === 0 || o.found === false));
        if (empty) { setState('empty'); return; }
        setData(j as T); setState('ok');
      })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [url]);
  return { data, state };
}

/** 時戳（epoch ms 或 ISO 字串）→ 台北時間「10/04 23:17」；缺值「—」。 */
export function fmtTs(v: number | string | null | undefined): string {
  if (v == null) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 代號→名稱（全站即時清單，缺就回代號本身）。 */
export function useNameOf(): (code: string) => string {
  const allStocks = useAppStore(s => s.allStocks);
  const map = new Map(allStocks.map(s => [s.code, s.name]));
  return code => map.get(code) ?? code;
}

// ── 報價名稱統一（2026-10-05 使用者）──────────────────────────────────────────
//   現價＝即時價（盤中即時、收盤後即收盤價）；前交易日 M/D＝該日收盤資料；其餘一律標註日期。
//   資料日早於今天（台北）稱「前交易日」，等於今天（收盤後定版）稱「當日」。
export const taipeiToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
export const mdOf = (iso?: string | null) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${+iso.slice(5, 7)}/${iso.slice(8, 10)}` : '');
export const dayLabel = (iso?: string | null) => (iso ? `${iso < taipeiToday() ? '前交易日' : '當日'} ${mdOf(iso)}` : '資料日');
/** 資料日標籤（例：前交易日 10/02），由頁面最上層提供，表頭、小標共用。 */
export const AsOfContext = createContext<string>('前交易日');
export const useAsOf = () => useContext(AsOfContext);

export const sg = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}`);
/** 台股慣例：紅漲綠跌 */
export const tone = (x: number | null | undefined) => (x == null || x === 0 ? '' : x > 0 ? styles.up : styles.dn);

// 代號→即時清單（價格、市場別）：以 allStocks 陣列為鍵快取，避免每一列各建一份 Map。
const STOCK_MAPS = new WeakMap<StockInfo[], Map<string, StockInfo>>();
function stockMapOf(list: StockInfo[]): Map<string, StockInfo> {
  let m = STOCK_MAPS.get(list);
  if (!m) { m = new Map(list.map(x => [x.code, x])); STOCK_MAPS.set(list, m); }
  return m;
}
export function useStockInfo(): (code: string) => StockInfo | undefined {
  const list = useAppStore(s => s.allStocks);
  const m = stockMapOf(list);
  return code => m.get(code);
}

const MARKET_TITLE: Record<string, string> = { 市: '上市', 櫃: '上櫃', 創: '創新板', 興: '興櫃', ETF: 'ETF' };

/** 個股欄：市場別小圖示（市／櫃／創…）＋代號名稱（可點進個股分析）＋注意／處置標記（全站共用 RiskBadge）。 */
export function StockCell({ code, name }: { code: string; name?: string }) {
  const info = useStockInfo()(code);
  const b = info ? marketBadge(info) : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
      {b && <span title={MARKET_TITLE[b.t] ?? b.t} style={{ fontSize: 'calc(12px * var(--fz))', fontWeight: 800, color: b.c, border: `1px solid ${b.c}55`, borderRadius: 4, padding: '0 4px', lineHeight: 1.4 }}>{b.t}</span>}
      <StockLink code={code} name={name ?? info?.name} />
      <RiskBadge code={code} size="xs" />
    </span>
  );
}

/** 價格欄（站上統一用語 2026-10-05：有比較價格的畫面＝現價與昨收）：現價（盤中為即時價、收盤後即收盤價）、昨收（前一交易日收盤價）、
 *  漲跌%；全站即時清單沒有該檔顯示「—」。有獨立漲跌欄的表傳 showChange={false} 避免重複。 */
export function PriceCell({ code, showChange = true }: { code: string; showChange?: boolean }) {
  const info = useStockInfo()(code);
  if (!info || !(info.price > 0)) return <span>—</span>;
  const prev = info.price - info.change;
  return (
    <span title="現價：盤中為即時價，收盤後即收盤價；昨收：前一交易日收盤價">
      <b>{info.price.toFixed(2)}</b>
      {showChange && <> <span className={tone(info.changePercent)}>{sg(info.changePercent)}%</span></>}
      {prev > 0 && <span style={{ color: 'var(--text-muted)', fontSize: 'calc(11.5px * var(--fz))' }}> 昨收 {prev.toFixed(2)}</span>}
    </span>
  );
}

export function StockLink({ code, name }: { code: string; name?: string }) {
  const navigateTo = useAppStore(s => s.navigateTo);
  return <button className={styles.link} onClick={() => navigateTo('stock', code)}>{code}{name && name !== code ? ` ${name}` : ''}</button>;
}

/** 卡片外框：標題、等級標籤、資料日、載入／空／錯誤狀態統一處理；標題列可點擊收合（預設展開，收合只隱藏內容、不重打 API）。 */
export function Card({ title, state, dataDate, dateLabel = '資料日', tier, note, defaultOpen = true, wide = false, children }: {
  title: string; state: ApiState; dataDate?: string | null; dateLabel?: string; tier?: string; note?: string; defaultOpen?: boolean; wide?: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`${styles.card} ${wide ? styles.wide : ''}`}>
      <h3>
        <button type="button" className={styles.fold} aria-expanded={open} onClick={() => setOpen(o => !o)}>
          <span aria-hidden>{open ? '▾' : '▸'}</span> {title}
        </button>
        {tier && <span className={styles.tier}>{tier}</span>}{dataDate && <span className={styles.date}>{dateLabel} {dataDate}</span>}
      </h3>
      {open && (
        <>
          {state === 'loading' && <p className={styles.note}>載入中…</p>}
          {state === 'error' && <p className={styles.note}>暫時讀取失敗，稍後再試（不影響其他區塊）。</p>}
          {state === 'empty' && <p className={styles.note}>尚無資料（收盤後由系統整理，來源未提供時不補值）。</p>}
          {state === 'ok' && children}
          {state === 'ok' && note && <p className={styles.note}>{note}</p>}
        </>
      )}
    </section>
  );
}

/** 列內展開用的小區塊（標題＋內容）；詳情區統一版型。 */
export function Detail({ title, children }: { title: string; children: ReactNode }) {
  return <div className={styles.detail}><h4>{title}</h4>{children}</div>;
}

export { styles as amStyles };
