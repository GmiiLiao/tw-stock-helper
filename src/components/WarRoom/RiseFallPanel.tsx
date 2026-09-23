'use client';

// ── 盤中戰情「📈 即時漲跌」分頁 ──────────────────────────────────────
// 全市場(~1900檔)左右兩欄熱力方塊：左=全部上漲、右=全部下跌（不設上限）。
// 欄數可調(桌機·localStorage 記憶)、左右獨立排序(漲幅/價量/成交量/價格)、
// 點方塊展開即時K線。資料：/api/twse/market-snapshot（daemon 每分掃）。

import { useEffect, useMemo, useState } from 'react';
import { storageGet, storageSet } from '@/lib/safe-storage';
import { shouldPollNow , inPreOpenBlackout} from '@/lib/market-clock';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import OnlyCandidatesToggle from '@/components/Candidates/OnlyCandidatesToggle';
import { useAppStore } from '@/lib/store';

interface Snap {
  code: string; name: string; price: number; change: number; changePercent: number;
  volume: number; volX: number | null; market: string; open: number; high: number; low: number;
}
type SortKey = 'chg' | 'score' | 'value' | 'vol' | 'price';
const SORTS: { key: SortKey; label: string }[] = [
  { key: 'chg', label: '漲跌幅' },
  { key: 'score', label: '強度分' },
  { key: 'value', label: '價量(成交值)' },
  { key: 'vol', label: '成交量' },
  { key: 'price', label: '價格' },
];

// 強度評比（與急漲跌頁同制）：|漲跌幅|×5(≤50) + 量能倍數×10(≤30) + |漲跌幅|×2(≤20)
const scoreOf = (q: Snap) => Math.round(
  Math.min(50, Math.abs(q.changePercent) * 5) + Math.min(30, (q.volX ?? 1) * 10) + Math.min(20, Math.abs(q.changePercent) * 2)
);
const strengthOf = (chg: number): { t: string; c: string } => {
  const a = Math.abs(chg);
  if (a >= 9.9) return { t: chg > 0 ? '漲停' : '跌停', c: chg > 0 ? '#f03e3e' : '#2f9e44' };
  if (a >= 7) return { t: chg > 0 ? '強勢' : '急跌', c: chg > 0 ? '#f97316' : '#16a34a' };
  if (a >= 5) return { t: chg > 0 ? '中強' : '中跌', c: '#eab308' };
  return { t: '溫和', c: '#94a3b8' };
};

function isTwTradingHours(): boolean {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
}

// 單欄初次渲染的方塊數上限。全市場約 900 漲 / 800 跌，全畫會讓低階手機捲不動。
const INITIAL_TILES = 200;

// 熱力底色：漲紅跌綠，強度隨 |漲跌幅| 遞增（台股慣例）
const tileBg = (chg: number) => {
  const a = Math.min(0.55, 0.10 + Math.abs(chg) / 10 * 0.45);
  return chg >= 0 ? `rgba(240,62,62,${a})` : `rgba(47,158,68,${a})`;
};

function Column({ title, icon, color, items, sort, setSort, cols, openCode, setOpenCode, candidateSet }: {
  title: string; icon: string; color: string; items: Snap[];
  sort: SortKey; setSort: (s: SortKey) => void; cols: number;
  openCode: string | null; setOpenCode: (c: string | null) => void;
  candidateSet: Set<string>;
}) {
  // 預設只畫 INITIAL_TILES 個，其餘由使用者按鈕展開。
  // limit 刻意不隨 items 變動重置 —— items 每 30 秒換成新陣列，
  // 重置的話使用者剛按下的「顯示全部」會在下一輪被打回去。
  const [limit, setLimit] = useState(INITIAL_TILES);
  const rest = items.length - limit;

  // 三個統計原本寫在 render body 裡，對 ~900 筆做 3 次全掃，每次重繪都重算。
  const stat = useMemo(() => {
    let a = 0, b = 0, c2 = 0;
    for (const q of items) {
      const x = Math.abs(q.changePercent);
      if (x >= 9.9) a++;
      else if (x >= 7) b++;
      else if (x >= 5) c2++;
    }
    const up = title === '上漲';
    return `${up ? '漲停' : '跌停'}${a}·${up ? '強勢' : '急跌'}${b}·${up ? '中強' : '中跌'}${c2}`;
  }, [items, title]);

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontWeight: 900, fontSize: 'calc(13.5px * var(--fz))', color }}>{icon} {title}</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: 'var(--text-muted)' }}>{items.length.toLocaleString()} 檔</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          {stat}
        </span>
        {/* ⚠ 這排鈕要能橫向捲（2026-08-11 手機回報）：
            左右兩欄各只有 ~150px，五顆排序鈕塞不下，原本會被壓縮成
            「價/量/(成/交/值)」一字一行的直條，把磚塊區也一起擠變形。
            改為整排 nowrap + 自身可捲：塞不下就左右滑，不去壓縮任何一顆。 */}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4, flexWrap: 'nowrap', overflowX: 'auto', maxWidth: '100%', scrollbarWidth: 'none' }}>
          {SORTS.map(s => (
            <button key={s.key} onClick={() => setSort(s.key)}
              style={{ padding: '2px 8px', borderRadius: 10, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                border: `1px solid ${sort === s.key ? `${color}88` : 'var(--border-primary)'}`,
                background: sort === s.key ? `${color}22` : 'transparent',
                color: sort === s.key ? 'var(--text-primary)' : 'var(--text-muted)' }}>
              {s.label}
            </button>
          ))}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 4 }}>
        {items.slice(0, limit).map(q => {
          const otc = q.market === 'otc';
          const open = openCode === q.code;
          return (
            <div key={q.code} style={{ display: 'contents' }}>
              <div onClick={() => setOpenCode(open ? null : q.code)}
                style={{ position: 'relative', cursor: 'pointer', padding: '5px 7px', borderRadius: 7,
                  // ⚠ overflow:hidden 不可省（2026-08-11 實機截圖）：
                  //   下面兩行是 white-space:nowrap，磚塊只有 72~110px，
                  //   「6,301 張·0.4x」與「漲停87」會直接印到**隔壁磚塊**上，
                  //   看起來像兩層字疊在一起。minWidth:0 只讓格子縮得下去，
                  //   擋不住已經溢出的內容——要靠 overflow 裁掉。
                  background: tileBg(q.changePercent), border: open ? '1px solid #7dd3fc' : '1px solid transparent', minWidth: 0, overflow: 'hidden',
                  ...(candidateSet.has(q.code) ? { boxShadow: '0 0 0 1.5px rgba(245,159,0,0.8)' } : {}) }}>
                <span style={{ position: 'absolute', top: 2, right: 4, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: otc ? '#fcd34d' : '#93c5fd', opacity: 0.9 }}>{otc ? '櫃' : '市'}</span>
                <span style={{ position: 'absolute', top: 2, left: 3 }}><AddCandidateButton code={q.code} variant="icon" /></span>
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, lineHeight: 1.25 }}>{q.code}</div>
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{q.name}</div>
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {q.price} <span>{q.changePercent >= 0 ? '+' : ''}{q.changePercent.toFixed(1)}%</span>
                </div>
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'rgba(255,255,255,0.75)', whiteSpace: 'nowrap', display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{Math.round(q.volume / 1000).toLocaleString()} 張{q.volX != null ? `·${q.volX}x` : ''}</span>
                  {(() => { const st = strengthOf(q.changePercent); return <span style={{ marginLeft: 'auto', flexShrink: 0, fontWeight: 800, color: st.c === '#94a3b8' ? 'rgba(255,255,255,0.6)' : '#fff', background: `${st.c}66`, borderRadius: 4, padding: '0 3px' }}>{st.t}{scoreOf(q)}</span>; })()}
                </div>
              </div>
              {open && (
                <div style={{ gridColumn: '1 / -1', padding: '4px 2px 8px' }} onClick={e => e.stopPropagation()}>
                  <StockTrendChart code={q.code} name={q.name} closePrice={q.price} livePrice={q.price} changePercent={q.changePercent} volume={q.volume} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {rest > 0 && (
        <button onClick={() => setLimit(items.length)}
          style={{ marginTop: 6, width: '100%', padding: '6px 0', borderRadius: 8, cursor: 'pointer',
            fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: 'var(--text-muted)',
            background: 'transparent', border: '1px dashed var(--border-primary)' }}>
          顯示其餘 {rest.toLocaleString()} 檔
        </button>
      )}
      {items.length === 0 && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: '10px 4px' }}>無</div>}
    </div>
  );
}

import LimitUpPanel from '@/components/WarRoom/LimitUpPanel';
import FadeWatch from '@/components/WarRoom/FadeWatch';

// 2026-09-23 使用者：「⚡ 盤中漲停預測」併入即時漲跌頁。版面：標題列右側一組二段切換——
//   漲跌分布（原頁）／盤中漲停預測（limitUpForecast/live）。同一頁、同一個標題、一個入口；
//   切到預測時暫停 308KB 全市場快照輪詢（不看的東西不下載，見下載量記憶）。選擇記本機。
// 2026-09-23 再加第三段「📉 即時轉空預測」：與漲跌分布共用同一份全市場快照，前端計算、不新增上游請求。
// 第四段「⚔️ 多空同屏」（2026-09-23 使用者：做多當沖看漲停預測、做空看即時轉空，要同時即時監控）。
type RfView = 'board' | 'forecast' | 'fade' | 'dual';

export default function RiseFallPanel({ initialView }: { initialView?: RfView } = {}) {
  const [view, setViewState] = useState<RfView>(() => { const v = storageGet('rfView'); return initialView ?? (v === 'forecast' || v === 'fade' || v === 'dual' ? v : 'board'); });
  const setView = (v: RfView) => { setViewState(v); storageSet('rfView', v); };
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [marketOpen, setMarketOpen] = useState(false);
  const [sortUp, setSortUp] = useState<SortKey>('chg');
  const [sortDn, setSortDn] = useState<SortKey>('chg');
  const [cols, setCols] = useState(4);
  // ⚠ 手機要 clamp 欄數（2026-08-11）：使用者存的偏好可能是 4~10 欄，
  //   窄螢幕照搬會把磚塊壓到剩三十幾 px，代號/名稱/漲跌幅互相疊字。
  //   一塊磚要放得下 4 位代號 + 漲跌幅，至少需要 ~66px。
  //   ⇒ 只在渲染時 clamp（見下方 effCols），**不動使用者存下來的偏好**，桌機照舊。
  //   註：手機同時改為上下排（見下方 stacked），所以每一區拿得到整個寬度，
  //       上限可以放到 3 欄；這段註解先前寫「一律並排」已作廢。
  const [vw, setVw] = useState(1200);
  useEffect(() => {
    const on = () => setVw(window.innerWidth);
    on(); window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  // 手機：上下排（2026-08-11 使用者改定案，取代先前的「一律並排」）。
  // 疊成上下之後每一區都拿得到整個寬度，所以欄數可以比並排時多。
  const stacked = vw <= 820;
  const effCols = stacked ? Math.min(cols, 3) : cols;
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [onlyCand, setOnlyCand] = useState(false);
  const compareCodes = useAppStore(s => s.compareCodes);
  const candidateSet = useMemo(() => new Set(compareCodes), [compareCodes]);

  useEffect(() => { const c = parseInt(storageGet('rfCols') || '4'); if (c >= 2 && c <= 10) setCols(c); }, []);
  const saveCols = (c: number) => { setCols(c); storageSet('rfCols', String(c)); };

  useEffect(() => {
    let live = true;
    // force=true 用於**首次載入**：收盤後也要載入，才顯示得出當日最終結算資料。
    // 舊寫法連第一次都被 shouldPollNow 擋掉 ⇒ 盤後畫面永遠是 0 檔
    // （使用者 2026-08-31 截圖：晚上 8 點看到「全市場 0 檔·無」，當日資訊整個消失）。
    if (view === 'forecast') return () => { live = false; };   // 漲停預測檢視不需要全市場快照（漲跌分布與即時轉空都要）
    const load = (force = false) => {
      // 開盤前 5 分鐘清空：昨日資料已無參考價值，今日尚未開始
      if (inPreOpenBlackout()) { setSnaps([]); return; }
      if (!force && !shouldPollNow()) return;   // 休市 or 分頁在背景 → 跳過輪詢（計時器照跑）
      fetch('/api/twse/market-snapshot').then(r => (r.ok ? r.json() : null)).then(d => {
        if (!live || !d?.quotes) return;
        setSnaps(d.quotes); setUpdatedAt(d.updatedAt ?? null); setMarketOpen(!!d.marketOpen);
      }).catch(() => {});
    };
    load(true);   // 首次一律載入，盤後才看得到最終結算資料
    // 10 秒：API 已含 5 秒快線覆蓋（正在看的股票），30 秒會吃掉快線的增益
    // ⚠ 間隔每一拍重算（CLAUDE.md：三元判斷只在掛載時算一次，之後永不重算——盤中掛載的分頁
    //   收盤後仍每 10 秒打 308KB 一整夜；2026-09-18 Hosting 下載量事故的一半來自這裡）。
    let t: ReturnType<typeof setTimeout>;
    const tick = () => { load(); t = setTimeout(tick, isTwTradingHours() ? 10000 : 120000); };
    t = setTimeout(tick, isTwTradingHours() ? 10000 : 120000);
    return () => { live = false; clearTimeout(t); };
  }, [view]);

  const sorter = (k: SortKey, up: boolean) => (a: Snap, b: Snap) =>
    k === 'chg' ? (up ? b.changePercent - a.changePercent : a.changePercent - b.changePercent)
      : k === 'score' ? scoreOf(b) - scoreOf(a)
      : k === 'value' ? (b.price * b.volume) - (a.price * a.volume)
      : k === 'vol' ? b.volume - a.volume
      : b.price - a.price;

  const pool = useMemo(() => onlyCand ? snaps.filter(q => candidateSet.has(q.code)) : snaps, [snaps, onlyCand, candidateSet]);
  const risers = useMemo(() => pool.filter(q => q.changePercent > 0).sort(sorter(sortUp, true)), [pool, sortUp]);
  const fallers = useMemo(() => pool.filter(q => q.changePercent < 0).sort(sorter(sortDn, false)), [pool, sortDn]);
  const flat = pool.length - risers.length - fallers.length;

  return (
    <div style={{ flex: '1 1 100%', minWidth: 0, padding: '10px 12px', borderRadius: 12, background: 'rgba(61,142,248,0.05)', border: '1px solid rgba(61,142,248,0.22)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 900, color: '#7dd3fc' }}>📈 即時漲跌</span>
        <span role="tablist" aria-label="即時漲跌檢視" style={{ display: 'inline-flex', padding: 2, borderRadius: 999, background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' }}>
          {([['board', '漲跌分布'], ['forecast', '⚡ 盤中漲停預測'], ['fade', '📉 即時轉空預測'], ['dual', '⚔️ 多空同屏']] as [RfView, string][]).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
              style={{ padding: '3px 12px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700,
                background: view === k ? (k === 'forecast' ? 'rgba(253,164,175,0.18)' : k === 'fade' ? 'rgba(74,222,128,0.16)' : k === 'dual' ? 'rgba(251,191,36,0.16)' : 'rgba(125,211,252,0.18)') : 'transparent',
                color: view === k ? (k === 'forecast' ? '#fda4af' : k === 'fade' ? '#4ade80' : k === 'dual' ? '#fbbf24' : '#7dd3fc') : 'var(--text-muted)' }}>{label}</button>
          ))}
        </span>
        {view !== 'forecast' && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          全市場 {snaps.length.toLocaleString()} 檔 · ▲{risers.length.toLocaleString()} ▼{fallers.length.toLocaleString()} 平{flat}
          {updatedAt ? ` · ${new Date(updatedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` : ''}{!marketOpen ? ' · ⏸ 非盤中(最後快照)' : ''}
        </span>}
        {view !== 'forecast' && <OnlyCandidatesToggle on={onlyCand} setOn={setOnlyCand} />}
        {view === 'board' && <span className="mobile-hide" style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
          欄數
          <select value={cols} onChange={e => saveCols(+e.target.value)}
            style={{ background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', borderRadius: 6, fontSize: 'calc(12.5px * var(--fz))', padding: '2px 4px' }}>
            {[2, 3, 4, 5, 6, 8, 10].map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <span>· 點方塊看即時K線</span>
        </span>}
      </div>
      {view === 'forecast' ? <LimitUpPanel source="live" /> : view === 'fade' ? <FadeWatch snaps={pool} marketOpen={marketOpen} /> : view === 'dual' ? (
        // 寬螢幕左右並排（左多右空，對應紅漲綠跌的閱讀習慣），窄螢幕上下排；各欄內容過寬時各自橫向捲動，互不擠壓
        <div style={{ display: 'grid', gridTemplateColumns: vw >= 1500 ? 'minmax(0, 1fr) minmax(0, 1fr)' : '1fr', gap: 12, alignItems: 'flex-start' }}>
          <section style={{ minWidth: 0, borderRadius: 10, border: '1px solid rgba(240,62,62,0.35)', padding: '8px 10px', background: 'rgba(240,62,62,0.04)' }}>
            <div style={{ fontWeight: 900, color: 'var(--color-up)', marginBottom: 6, fontSize: 'calc(13.5px * var(--fz))' }}>▲ 做多當沖：盤中漲停預測</div>
            <div style={{ overflowX: 'auto' }}><LimitUpPanel source="live" /></div>
          </section>
          <section style={{ minWidth: 0, borderRadius: 10, border: '1px solid rgba(47,158,68,0.35)', padding: '8px 10px', background: 'rgba(47,158,68,0.04)' }}>
            <div style={{ fontWeight: 900, color: 'var(--color-down)', marginBottom: 6, fontSize: 'calc(13.5px * var(--fz))' }}>▼ 做空當沖：即時轉空預測</div>
            <FadeWatch snaps={pool} marketOpen={marketOpen} />
          </section>
        </div>
      ) : <>
      {/* 版面規則（2026-08-11 更新）：
          桌機＝漲左跌右並排；**手機＝上漲整區在上、下跌整區在下**。
          先前的定案是「一律並排、不換上下排」，但實機驗證下來，
          手機每欄只剩 ~150px，磚塊被壓到 72px、字互相疊在一起，
          使用者因此改為手機採上下排。並排的桌機行為不變。 */}
      <div style={{ display: 'grid', gridTemplateColumns: stacked ? '1fr' : 'minmax(0, 1fr) minmax(0, 1fr)', gap: stacked ? 14 : 12, alignItems: 'flex-start' }}>
        <Column title="上漲" icon="▲" color="#f03e3e" items={risers} sort={sortUp} setSort={setSortUp} cols={effCols} openCode={openCode} setOpenCode={setOpenCode} candidateSet={candidateSet} />
        <Column title="下跌" icon="▼" color="#2f9e44" items={fallers} sort={sortDn} setSort={setSortDn} cols={effCols} openCode={openCode} setOpenCode={setOpenCode} candidateSet={candidateSet} />
      </div>
      <div style={{ marginTop: 8, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
        底色深淺＝漲跌幅強度（紅漲綠跌）；漲跌兩區各自獨立排序（手機為上下排、桌機為左右並排）；每 30 秒更新。非投資建議。
      </div>
      </>}
    </div>
  );
}
