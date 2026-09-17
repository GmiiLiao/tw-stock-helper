'use client';

import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useLiveQuotes } from '@/lib/useLiveQuotes';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import { storageGet, storageSet } from '@/lib/safe-storage';

// ── 📈 波段持有：近 5／10／20／60 日連續成長榜＋整合榜（2026-09-16）──
// 資料：daemon 每交易日 16:45 定版寫 swingHold/latest；歷史 swingHold/{dataDate} 可用日期選單回看。
// 每日一份、不輪詢（掛載時抓一次；換日期再抓）。即時價由 useLiveQuotes 帶入（共用快線，不打上游）。
// ⚠ 這是動能排行不是進場訊號——本站尚未對它做持有期回測，payload.caveats 一律原樣顯示。非投資建議。

import { MaChip, SeqBars, type MaFlags, type Seq } from '@/components/shared/SeqIndicators';   // 09-17 抽成共用（自選各子分頁同款）
interface Item { rank: number; code: string; name: string; market: string; c0: number; price: number; gain: number; up: number; maxStreak: number; streak: number; maxDD: number; type: '穩健' | '劇烈' | '一般'; amtM: number; ma?: MaFlags; seq?: Seq }
interface Board { window: number; from: string; to: string; eligible: number; items: Item[] }
interface ComboItem { rank: number; code: string; name: string; market: string; price: number; boards: number; score: number; ranks: Record<string, number>; gains: Record<string, number>; streak: number; amtM: number; ma?: MaFlags; seq?: Seq | null; seqWin?: number }
interface Data { found: boolean; date?: string; dataDate?: string; universe?: number; liquidityGate?: string; method?: string; caveats?: string[]; boards?: Record<string, Board>; combo?: { items: ComboItem[] } }

type Tab = 'combo' | 'd5' | 'd10' | 'd20' | 'd60';
const TABS: { id: Tab; label: string }[] = [{ id: 'combo', label: '🏁 整合榜' }, { id: 'd5', label: '5日' }, { id: 'd10', label: '10日' }, { id: 'd20', label: '20日' }, { id: 'd60', label: '60日' }];
const UP = '#f03e3e', DOWN = '#2f9e44', MUTED = 'var(--text-muted)';
const mono = "'JetBrains Mono', monospace";
const typeStyle: Record<string, { bg: string; fg: string }> = { 穩健: { bg: 'rgba(34,197,94,0.15)', fg: '#4ade80' }, 劇烈: { bg: 'rgba(249,115,22,0.15)', fg: '#f97316' }, 一般: { bg: 'rgba(148,163,184,0.15)', fg: 'var(--text-muted)' } };

// 即時狀態小提示：漲停鎖死（買不到）／跌停
function LiveChip({ chg }: { chg?: number }) {
  if (chg == null) return null;
  if (chg >= 9.5) return <span title="即時已達漲停（鎖死買不到）" style={{ marginLeft: 4, fontSize: 'calc(11px * var(--fz))', padding: '0 5px', borderRadius: 5, background: 'rgba(240,62,62,0.16)', color: UP, fontWeight: 800 }}>🔒漲停</span>;
  if (chg <= -9.5) return <span title="即時已達跌停" style={{ marginLeft: 4, fontSize: 'calc(11px * var(--fz))', padding: '0 5px', borderRadius: 5, background: 'rgba(47,158,68,0.16)', color: DOWN, fontWeight: 800 }}>跌停</span>;
  return null;
}

export default function SwingHoldBoard() {
  const dt = useDayTradeCodes();
  const navigateTo = useAppStore(s => s.navigateTo);
  const [tab, setTabState] = useState<Tab>(() => { const v = storageGet('swingHoldTab'); return (['combo', 'd5', 'd10', 'd20', 'd60'] as string[]).includes(v || '') ? (v as Tab) : 'combo'; });
  const setTab = (t: Tab) => { setTabState(t); storageSet('swingHoldTab', t); };   // 子分頁記本機：返回時不重置，錨點列才在畫面上
  const [data, setData] = useState<Data | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [pick, setPick] = useState<string>('');           // '' = latest
  const [openCode, setOpenCode] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/ai/swing-hold?list=1').then(r => (r.ok ? r.json() : null)).then(d => { if (live && d?.dates) setDates(d.dates); }).catch(() => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true; setErr(null);
    fetch(pick ? `/api/ai/swing-hold?date=${pick}` : '/api/ai/swing-hold')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!live) return; if (d) setData(d); else setErr('讀取失敗'); })
      .catch(() => { if (live) setErr('讀取失敗'); });
    return () => { live = false; };
  }, [pick]);

  const board = tab === 'combo' ? null : data?.boards?.[tab];
  const codes = useMemo(() => (tab === 'combo' ? data?.combo?.items : board?.items)?.map(i => i.code) ?? [], [tab, data, board]);
  const quotes = useLiveQuotes(codes, 60, { register: false });   // 整張榜不搶快線名額；展開走勢那檔由圖自己登記

  if (err) return <div style={{ padding: 20, color: MUTED }}>⚠ 波段持有榜{err}（伺服器暫時讀不到，不是空榜）</div>;
  if (!data) return <div style={{ padding: 20, color: MUTED }}>載入中…</div>;
  if (!data.found) return <div style={{ padding: 20, color: MUTED }}>波段持有榜尚未產出（daemon 每交易日 16:45 定版；{data.date && data.date !== 'latest' ? `${data.date} 無資料` : '首次上線需等下一個收盤'}）</div>;

  const cell: React.CSSProperties = { padding: '5px 6px', whiteSpace: 'nowrap', textAlign: 'right', fontFamily: mono, fontSize: 'calc(12.5px * var(--fz))' };
  const head: React.CSSProperties = { ...cell, fontFamily: 'inherit', color: MUTED, fontWeight: 400 };
  const liveCell = (code: string, price: number) => {
    const q = quotes[code];
    if (!q?.price) return <span style={{ color: MUTED }}>—</span>;
    const d = (q.price / price - 1) * 100;
    return <span style={{ color: d >= 0 ? UP : DOWN }} title="即時價（相對資料日收盤）">{q.price.toFixed(2)} <span style={{ fontSize: 'calc(11.5px * var(--fz))' }}>{d >= 0 ? '+' : ''}{d.toFixed(1)}%</span></span>;
  };
  const nameCell = (it: { code: string; name: string; ma?: MaFlags }) => (
    <td style={{ ...cell, textAlign: 'left', fontFamily: 'inherit' }}>
      <button onClick={() => setOpenCode(c => (c === it.code ? null : it.code))} title="展開／收合即時走勢" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 700, fontFamily: mono }}>{openCode === it.code ? '▾' : '▸'} {it.code}</button>
      <span style={{ marginLeft: 6, cursor: 'pointer' }} onClick={() => navigateTo('stock', it.code)} title="開個股頁">{it.name}</span>
      {(() => { const st = statusOf(dt, it.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()}
      <span style={{ marginLeft: 6 }}><AddCandidateButton code={it.code} variant="icon" /></span>
      <MaChip ma={it.ma} />
      <LiveChip chg={quotes[it.code]?.changePercent} />
    </td>
  );
  const chartRow = (it: { code: string; name: string; price: number }, span: number) => openCode === it.code ? (
    <tr key={it.code + '-chart'}><td colSpan={span} style={{ padding: '4px 0 10px' }}><StockTrendChart code={it.code} name={it.name} closePrice={it.price} changePercent={quotes[it.code]?.changePercent ?? 0} livePrice={quotes[it.code]?.price} volume={quotes[it.code]?.volume} /></td></tr>
  ) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, fontSize: 'calc(12.5px * var(--fz))', color: MUTED }}>
        <span>📈 <strong style={{ color: 'var(--text-primary)' }}>波段持有</strong>：近 5／10／20／60 日連續成長榜各 25 檔＋整合榜</span>
        <span>｜資料日 <strong style={{ color: 'var(--text-primary)' }}>{data.dataDate}</strong>（收盤定版）｜宇宙 {data.universe} 檔（{data.liquidityGate}）</span>
        <label style={{ marginLeft: 'auto' }}>回看：
          <select value={pick} onChange={e => { setPick(e.target.value); setOpenCode(null); }} style={{ marginLeft: 4, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-primary)', borderRadius: 6, padding: '2px 6px' }}>
            <option value="">最新</option>
            {dates.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setOpenCode(null); }} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border-primary)', cursor: 'pointer', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 600, background: tab === t.id ? 'var(--bg-elevated)' : 'transparent', color: tab === t.id ? 'var(--text-primary)' : MUTED }}>{t.label}</button>
        ))}
      </div>
      {data.caveats?.length ? (
        <div style={{ fontSize: 'calc(12px * var(--fz))', color: '#f59e0b', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 8, padding: '8px 12px', lineHeight: 1.5 }}>
          {data.caveats.map((c, i) => <div key={i}>⚠ {c}</div>)}
        </div>
      ) : null}
      <div style={{ fontSize: 'calc(12px * var(--fz))', color: MUTED, lineHeight: 1.5 }}>📐 {data.method}</div>

      <div style={{ overflowX: 'auto' }}>
        {tab === 'combo' ? (
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead><tr>
              <th style={head}>#</th><th style={{ ...head, textAlign: 'left' }}>標的</th><th style={head}>收盤</th><th style={head}>即時</th>
              <th style={head} title="逐日漲跌×成交量縮圖（優先 20 日窗）：紅＝漲、綠＝跌，柱高＝量">量序</th>
              <th style={head} title="進了幾個窗的榜（最多 4）">上榜</th><th style={head} title="Σ(26−名次)，越高越靠前">分數</th>
              <th style={head}>5日</th><th style={head}>10日</th><th style={head}>20日</th><th style={head}>60日</th><th style={head}>目前連漲</th><th style={head}>均額(百萬)</th>
            </tr></thead>
            <tbody>
              {(data.combo?.items ?? []).flatMap(it => [
                <tr key={it.code} data-anchor={it.code} style={{ borderTop: '1px solid var(--border-primary)' }}>
                  <td style={cell}>{it.rank}</td>{nameCell(it)}<td style={cell}>{it.price}</td><td style={cell}>{liveCell(it.code, it.price)}</td>
                  <td style={{ ...cell, textAlign: 'center' }}><SeqBars seq={it.seq} win={it.seqWin} /></td>
                  <td style={{ ...cell, fontWeight: 700, color: it.boards >= 3 ? UP : 'var(--text-primary)' }}>{it.boards}/4</td><td style={cell}>{it.score}</td>
                  {['d5', 'd10', 'd20', 'd60'].map(k => <td key={k} style={{ ...cell, color: it.gains[k] != null ? UP : MUTED }}>{it.gains[k] != null ? `+${it.gains[k]}% (#${it.ranks[k]})` : '—'}</td>)}
                  <td style={cell}>{it.streak} 日</td><td style={cell}>{it.amtM.toLocaleString()}</td>
                </tr>,
                chartRow(it, 13),
              ])}
            </tbody>
          </table>
        ) : board ? (
          <>
            <div style={{ fontSize: 'calc(12px * var(--fz))', color: MUTED, marginBottom: 6 }}>區間 {board.from} → {board.to}（{board.window} 個交易日）｜正報酬 {board.eligible} 檔，取前 25</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead><tr>
                <th style={head}>#</th><th style={{ ...head, textAlign: 'left' }}>標的</th><th style={head}>起 → 收</th><th style={head}>{board.window}日漲幅</th><th style={head}>即時</th>
                <th style={head} title="區間逐日漲跌×成交量縮圖（舊→新）：紅＝漲、綠＝跌，柱高＝量。量增價漲＝起漲，量縮價跌＝回落">量序</th>
                <th style={head} title="區間內收盤高於前一日的天數">上漲日</th><th style={head}>最長連漲</th><th style={head}>目前連漲</th><th style={head} title="區間內自高點的最大跌幅">最大回檔</th><th style={head}>型態</th><th style={head}>均額(百萬)</th>
              </tr></thead>
              <tbody>
                {board.items.flatMap(it => [
                  <tr key={it.code} data-anchor={it.code} style={{ borderTop: '1px solid var(--border-primary)' }}>
                    <td style={cell}>{it.rank}</td>{nameCell(it)}<td style={cell}>{it.c0} → {it.price}</td>
                    <td style={{ ...cell, fontWeight: 700, color: UP }}>+{it.gain}%</td><td style={cell}>{liveCell(it.code, it.price)}</td>
                    <td style={{ ...cell, textAlign: 'center' }}><SeqBars seq={it.seq} win={board.window} /></td>
                    <td style={cell}>{it.up}/{board.window}</td><td style={cell}>{it.maxStreak}</td><td style={cell}>{it.streak}</td>
                    <td style={{ ...cell, color: it.maxDD > 12 ? '#f97316' : MUTED }}>−{it.maxDD}%</td>
                    <td style={{ ...cell, fontFamily: 'inherit' }}><span style={{ padding: '1px 6px', borderRadius: 6, background: typeStyle[it.type].bg, color: typeStyle[it.type].fg, fontSize: 'calc(11.5px * var(--fz))' }}>{it.type}</span></td>
                    <td style={cell}>{it.amtM.toLocaleString()}</td>
                  </tr>,
                  chartRow(it, 12),
                ])}
              </tbody>
            </table>
          </>
        ) : <div style={{ color: MUTED }}>此窗無資料</div>}
      </div>
      <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: MUTED }}>穩健＝上漲日 ≥60% 且最大回檔 ≤8%；劇烈＝最大回檔 ＞12%。平盤日不算上漲也不中斷連漲。非投資建議。</div>
    </div>
  );
}
