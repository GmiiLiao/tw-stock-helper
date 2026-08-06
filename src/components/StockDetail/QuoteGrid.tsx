'use client';

import type { StockInfo } from '@/lib/twse-api';
import styles from './QuoteGrid.module.css';

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

// ⚠**不加千分位**：手機一列要塞三組「標籤＋數值」，逗號多佔一格就會把數字截掉。
// 券商同樣是 4624.10 / 2151 這種無逗號寫法，讀起來也不會有障礙。
const nf = (v: number, d = 2) => v.toFixed(d);
const ni = (v: number) => String(Math.round(v));
const money = (v: number) => v >= 1e8 ? `${(v / 1e8).toFixed(2)}億` : v >= 1e4 ? `${(v / 1e4).toFixed(1)}萬` : String(Math.round(v));

export default function QuoteGrid({ stock, allTimeHigh, rsi, book }: {
  stock: StockInfo;
  allTimeHigh?: { high: number; date?: string } | null;
  rsi?: { r5: number; r10: number } | null;
  /** 五檔委託簿（daemon 優先集掃描寫入 bookDepth/latest）。非優先集個股會是 null。 */
  book?: { bid: [number, number][]; ask: [number, number][] } | null;
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
  const toATH = allTimeHigh?.high ? (stock.price / allTimeHigh.high - 1) * 100 : null;
  const perTx = stock.transactions && lots ? lots / stock.transactions : null;
  // 五檔委託簿：最佳一檔的買/賣量（＝券商的「買量/賣量」），以及五檔加總的委買賣力道。
  // ⚠這是**委託簿(掛單)**，不是券商的「內盤/外盤」——後者要逐筆成交分類，見檔頭說明。
  const bid1 = book?.bid?.[0], ask1 = book?.ask?.[0];
  const bidSum = book?.bid?.reduce((a, [, v]) => a + v, 0) ?? 0;
  const askSum = book?.ask?.reduce((a, [, v]) => a + v, 0) ?? 0;
  const bidPct = bidSum + askSum > 0 ? bidSum / (bidSum + askSum) * 100 : null;
  const vs = (v: number) => (v > prev ? UP : v < prev ? DOWN : FLAT);

  // ⚠回傳 **Fragment（兩個獨立網格項）** 而不是一個格子：
  //   標籤與數值必須各自落在自己的網格欄，才會像券商那樣「所有標籤對齊、所有數值對齊」。
  //   包成一個 div 的話每格自成一國，數值靠右推 → 標籤與數字中間出現大空隙，很難讀。
  const Cell = ({ k, v, c, sub, tail, chip }: {
    k: string; v: string; c?: string; sub?: string; tail?: string; chip?: 'hot' | 'cold' | 'warn';
  }) => (
    <>
      <span className={styles.key} style={{ color: LABEL }} title={sub}>{k}</span>
      <span className={styles.val} style={{ color: c ?? FLAT }} title={sub}>
        <span className={chip === 'hot' ? styles.chipHot : chip === 'cold' ? styles.chipCold : chip === 'warn' ? styles.chipWarn : ''}>{v}</span>
        {tail && <span className={styles.tail} style={{ color: LABEL }}>{tail}</span>}
      </span>
    </>
  );

  return (
    <div style={{ margin: '8px 0 10px' }}>
      <div className={styles.grid}>
        {/* 排列＝券商版面（橫向讀，每列三組）。內盤/外盤/單量/買量/賣量本站無資料源，
            換成我們算得準且同樣實用的欄位：收位、距漲跌停、歷史高、距高、RSI。 */}
        {/* 第 1 列 */}
        <Cell k="均價" v={avg != null ? nf(avg) : '—'} c={avg != null ? vs(avg) : FLAT} sub="均價＝成交值÷成交量" />
        <Cell k="振幅" v={amp != null ? `${amp.toFixed(2)}%` : '—'} c={amp != null && amp >= 5 ? '#fbbf24' : FLAT}
          chip={amp != null && amp >= 5 ? 'warn' : undefined} sub="振幅＝(最高−最低)÷昨收；≥5% 標黃" />
        <Cell k="均單" v={perTx != null ? perTx.toFixed(2) : '—'} c="#7dd3fc" tail="張" sub="每筆平均成交張數（越小＝散戶單越多）" />
        {/* 第 2 列 */}
        <Cell k="開盤" v={nf(stock.open)} c={vs(stock.open)} tail={gap != null ? `${gap >= 0 ? '+' : ''}${gap.toFixed(1)}%` : undefined} sub="開盤價（右為對昨收的跳空幅度）" />
        <Cell k="昨收" v={nf(prev)} />
        <Cell k="總量" v={ni(lots)} c="#7dd3fc" tail="張" />
        {/* 第 3 列 */}
        <Cell k="最高" v={nf(stock.high)} c={vs(stock.high)} />
        <Cell k="最低" v={nf(stock.low)} c={vs(stock.low)} />
        <Cell k="漲停" v={lim ? nf(lim.up) : '—'} chip="hot" sub="昨收×1.1，取合法跳動單位" />
        {/* 第 4 列 */}
        <Cell k="收位" v={`${(pos * 100).toFixed(0)}%`} c={pos >= 0.8 ? UP : pos <= 0.2 ? DOWN : FLAT} sub="日內位階＝(收−最低)÷(最高−最低)" />
        <Cell k="筆數" v={stock.transactions ? ni(stock.transactions) : '—'} c="#7dd3fc" />
        <Cell k="跌停" v={lim ? nf(lim.down) : '—'} chip="cold" sub="昨收×0.9，取合法跳動單位" />
        {/* 第 5 列 */}
        <Cell k="買量" v={bid1 ? String(bid1[1]) : '—'} c={UP} sub={bid1 ? `最佳買價 ${nf(bid1[0])}（五檔委買合計 ${bidSum} 張）` : '此檔不在即時五檔掃描範圍'} />
        <Cell k="賣量" v={ask1 ? String(ask1[1]) : '—'} c={DOWN} sub={ask1 ? `最佳賣價 ${nf(ask1[0])}（五檔委賣合計 ${askSum} 張）` : '此檔不在即時五檔掃描範圍'} />
        <Cell k="金額" v={money(stock.value)} c="#7dd3fc" sub="成交金額" />
        {/* 第 6 列 */}
        <Cell k="歷史高" v={allTimeHigh ? nf(allTimeHigh.high) : '—'} c="#fbbf24" tail={allTimeHigh?.date} />
        <Cell k="距高" v={toATH != null ? `${toATH.toFixed(1)}%` : '—'} c={toATH != null && toATH > -5 ? '#fbbf24' : FLAT} sub="現價距歷史最高價（負值＝仍在高點之下）" />
        <Cell k="RSI" v={rsi ? `${rsi.r5.toFixed(0)}/${rsi.r10.toFixed(0)}` : '—'}
          c={rsi && rsi.r5 >= 90 && rsi.r10 >= 90 ? UP : rsi && rsi.r5 < 12 ? '#fbbf24' : FLAT}
          chip={rsi && rsi.r5 >= 90 && rsi.r10 >= 90 ? 'hot' : undefined}
          sub="RSI(5)/RSI(10)：雙90+＝高檔勿接刀；雙<10＝極端超跌" />
      </div>

      {/* 底部力道條：**有五檔就畫委買/委賣**（真實掛單資料，與券商那條同樣一眼可讀）；
          沒有五檔（非優先集個股）才退回日內位階。
          ⚠標籤寫「委買/委賣」而不是「內盤/外盤」——後者是成交分類，我們沒有逐筆資料，
            名稱寫錯會讓人用錯口徑做判斷。 */}
      {bidPct != null ? (
        <div style={{ marginTop: 4 }} title={`五檔委買合計 ${bidSum} 張 vs 委賣合計 ${askSum} 張。這是掛單力道，不是成交的內外盤。`}>
          <div style={{ position: 'relative', height: 22, borderRadius: 11, overflow: 'hidden', display: 'flex' }}>
            <div style={{ width: `${bidPct}%`, background: UP, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: '#fff' }}>委買 {bidPct.toFixed(0)}%</span>
            </div>
            <div style={{ width: `${100 - bidPct}%`, background: DOWN, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: '#fff' }}>委賣 {(100 - bidPct).toFixed(0)}%</span>
            </div>
          </div>
        </div>
      ) : stock.high > stock.low ? (
        <div style={{ marginTop: 4 }}
          title="日內位階＝(收−最低)÷(最高−最低)。此檔不在即時五檔掃描範圍，故以日內位階替代。">
          <div style={{ position: 'relative', height: 22, borderRadius: 11, overflow: 'hidden', background: `linear-gradient(90deg, ${DOWN}55, #64748b33 50%, ${UP}55)` }}>
            <div style={{ position: 'absolute', left: `calc(${(pos * 100).toFixed(1)}% - 2px)`, top: 0, bottom: 0, width: 4, background: '#fff', boxShadow: '0 0 6px rgba(255,255,255,0.8)' }} />
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '0 8px', fontSize: 11.5, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden' }}>
              <span style={{ color: '#bbf7d0' }}>低 {nf(stock.low)}</span>
              <span style={{ color: '#fff' }}>收在區間 {(pos * 100).toFixed(0)}%</span>
              <span style={{ color: '#fecaca' }}>高 {nf(stock.high)}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
