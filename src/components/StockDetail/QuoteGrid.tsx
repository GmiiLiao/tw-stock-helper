'use client';

import type { StockInfo } from '@/lib/twse-api';

// ── 📋 報價總覽格子（2026-08-06 依使用者提供的券商版面重做）──────────
//
// 目標：像券商 App 一樣「一眼看完」——三欄格子、大數字、漲跌用顏色直接講完。
//
// ⚠**只放算得出來的欄位**：券商那張有「內盤/外盤/單量/買量/賣量」，
//   那些來自即時五檔委託簿，本站沒有這個資料源（bookDepth 只有尾盤歸檔、且非全市場）。
//   寧可少一格，也不放推估值假裝是實際成交明細——那會讓人拿去做判斷。
//
// 漲跌停價用台股跳動單位(tick)取整，實測與券商一致：
//   大立光昨收 4575 → 4575×1.1=5032.5，≥1000 檔 tick=5 → 5030 ✓（券商顯示 5030）
//                  → 4575×0.9=4117.5 → 向上取整 → 4120 ✓（券商顯示 4120）

const UP = '#f03e3e', DOWN = '#2f9e44', FLAT = '#e2e8f7';
const LABEL = '#a9b6d6';   // 標籤色：偏亮的藍灰，不用純灰

/** 台股最小跳動單位（依價格分級） */
function tickOf(p: number): number {
  if (p < 10) return 0.01;
  if (p < 50) return 0.05;
  if (p < 100) return 0.1;
  if (p < 500) return 0.5;
  if (p < 1000) return 1;
  return 5;
}
/** 漲停＝昨收×1.1 向下取到合法跳動點；跌停＝昨收×0.9 向上取 */
function limitPrices(prevClose: number): { up: number; down: number } {
  const rawUp = prevClose * 1.1, rawDown = prevClose * 0.9;
  const tu = tickOf(rawUp), td = tickOf(rawDown);
  return {
    up: Math.floor(rawUp / tu + 1e-9) * tu,
    down: Math.ceil(rawDown / td - 1e-9) * td,
  };
}

const nf = (v: number, d = 2) => v.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (v: number) => v >= 1e8 ? `${(v / 1e8).toFixed(2)} 億` : v >= 1e4 ? `${(v / 1e4).toFixed(1)} 萬` : String(Math.round(v));

export default function QuoteGrid({ stock, allTimeHigh }: {
  stock: StockInfo;
  allTimeHigh?: { high: number; date?: string } | null;
}) {
  const prev = stock.price - stock.change;
  const lim = prev > 0 ? limitPrices(prev) : null;
  const amp = prev > 0 ? (stock.high - stock.low) / prev * 100 : null;      // 振幅
  const avg = stock.volume > 0 ? stock.value / stock.volume : null;          // 均價＝成交值/成交量
  const gap = prev > 0 ? (stock.open - prev) / prev * 100 : null;            // 開盤跳空
  const pos = stock.high > stock.low ? (stock.price - stock.low) / (stock.high - stock.low) : 0.5;
  const lots = Math.round(stock.volume / 1000);
  const toUp = lim && lim.up > 0 ? (lim.up - stock.price) / stock.price * 100 : null;
  const toDown = lim && lim.down > 0 ? (stock.price - lim.down) / stock.price * 100 : null;
  const vs = (v: number) => (v > prev ? UP : v < prev ? DOWN : FLAT);

  const Cell = ({ k, v, c, sub }: { k: string; v: string; c?: string; sub?: string }) => (
    <div style={{ padding: '7px 10px', background: 'var(--bg-tertiary)', borderRadius: 8, minWidth: 0 }}>
      <div style={{ fontSize: 11, color: LABEL, marginBottom: 1 }}>{k}</div>
      <div style={{ fontSize: 15, fontWeight: 800, color: c ?? FLAT, fontFamily: "'JetBrains Mono',monospace", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</div>
      {sub && <div style={{ fontSize: 10.5, color: LABEL }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ margin: '8px 0 10px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))', gap: 6 }}>
        <Cell k="均價" v={avg != null ? nf(avg) : '—'} c={avg != null ? vs(avg) : FLAT} sub="成交值÷成交量" />
        <Cell k="振幅" v={amp != null ? `${amp.toFixed(2)}%` : '—'} c={amp != null && amp >= 5 ? '#fbbf24' : FLAT} sub="(高−低)÷昨收" />
        <Cell k="開盤" v={nf(stock.open)} c={vs(stock.open)} sub={gap != null ? `跳空 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%` : undefined} />
        <Cell k="昨收" v={nf(prev)} />
        <Cell k="最高" v={nf(stock.high)} c={vs(stock.high)} />
        <Cell k="最低" v={nf(stock.low)} c={vs(stock.low)} />
        <Cell k="漲停" v={lim ? nf(lim.up) : '—'} c={UP} sub={toUp != null ? `距 ${toUp.toFixed(2)}%` : undefined} />
        <Cell k="跌停" v={lim ? nf(lim.down) : '—'} c={DOWN} sub={toDown != null ? `距 ${toDown.toFixed(2)}%` : undefined} />
        <Cell k="總量" v={`${lots.toLocaleString()} 張`} c="#7dd3fc" />
        <Cell k="成交金額" v={money(stock.value)} c="#7dd3fc" />
        <Cell k="成交筆數" v={stock.transactions ? stock.transactions.toLocaleString() : '—'} c="#7dd3fc"
          sub={stock.transactions && lots ? `均單 ${(lots / stock.transactions).toFixed(2)} 張` : undefined} />
        <Cell k="歷史高" v={allTimeHigh ? nf(allTimeHigh.high) : '—'} c="#fbbf24" sub={allTimeHigh?.date} />
      </div>

      {/* 當日價格位置條：收盤落在「最低—最高」的哪裡。
          （券商那條是內外盤比，需要即時委託簿；本站沒有該資料源，改用同樣一眼可讀、
            而且我們算得準的日內位階，並標明口徑，不冒充成內外盤。） */}
      {stock.high > stock.low && (
        <div style={{ marginTop: 6 }}>
          <div style={{ position: 'relative', height: 20, borderRadius: 10, overflow: 'hidden', background: `linear-gradient(90deg, ${DOWN}55, #64748b33 50%, ${UP}55)` }}>
            <div style={{ position: 'absolute', left: `calc(${(pos * 100).toFixed(1)}% - 2px)`, top: 0, bottom: 0, width: 4, background: '#fff', boxShadow: '0 0 6px rgba(255,255,255,0.8)' }} />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px', fontSize: 11, fontWeight: 800 }}>
              <span style={{ color: '#bbf7d0' }}>低 {nf(stock.low)}</span>
              <span style={{ color: '#fff' }}>收在區間 {(pos * 100).toFixed(0)}%</span>
              <span style={{ color: '#fecaca' }}>高 {nf(stock.high)}</span>
            </div>
          </div>
          <div style={{ fontSize: 10.5, color: LABEL, marginTop: 3 }}>
            日內位階＝(收−最低)÷(最高−最低)。⚠內盤/外盤、買量/賣量需即時五檔委託簿，本站無此資料源，故不顯示（不以推估值充數）。
          </div>
        </div>
      )}
    </div>
  );
}
