'use client';

// ── 📈 指數分析（2026-08-05 由「指數·新聞」獨立頁改為「市場總覽」分頁）──
// 加權/櫃買/費半/那指/S&P/道瓊/日經 日週月K＋MA5/20/60＋VOL/RSI/MACD/KD 副圖
// ＋確定性自動判讀（趨勢/乖離/位階/波動/價量/指標——規則計算、非 AI 生成）＋近 20 根歷史表。
//
// 為什麼併回市場總覽：指數就是「大盤背景」，而使用者看大盤時本來就在市場總覽。
// 讓它獨立一頁等於要人記住「看指數要換頁」——那正是使用習慣固定不下來的原因。
//
// ⚠ 指標口徑與誠實界線：RSI=Wilder 5/10（與全站一致）、KD=9日⅔平滑（同 calculateKD）、
//   MACD=EMA12/26/DEA9。本站實測（個股宇宙·bt-core）：MACD/KD 交叉類「確認型訊號」
//   無預測增量——副圖與判讀是**盤勢描述**，不是買賣訊號，文案不得暗示方向。

import { useCallback, useEffect, useMemo, useState, useRef } from 'react';

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }

const SYMS = [
  { id: 'twii', label: '加權指數' }, { id: 'otc', label: '櫃買指數' },
  { id: 'sox', label: '費城半導體' }, { id: 'ixic', label: '那斯達克' },
  { id: 'gspc', label: 'S&P 500' }, { id: 'dji', label: '道瓊工業' }, { id: 'n225', label: '日經 225' },
];
const INTERVALS = [{ id: '1d', label: '日K' }, { id: '1wk', label: '週K' }, { id: '1mo', label: '月K' }] as const;
const WINDOWS = [60, 120, 250];
const UP = '#f03e3e', DOWN = '#2f9e44';

const fmtD = (t: number, iv: string) => {
  const d = new Date(t * 1000);
  return iv === '1mo' ? `${d.getFullYear()}/${d.getMonth() + 1}` : `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};
// ⚠ 軸標與游標讀數要用這個，不要用 fmtD（2026-08-11 實機發現）：
//   fmtD 只有月K會帶年份，日K/週K一律 MM/DD。
//   但 250 根週K橫跨約 5 年、250 根日K也跨年，
//   軸上就會出現「10/01、06/01、02/01、10/01、06/01」——同一組數字重複，
//   使用者無從分辨那是哪一年的 10 月。
//   跨年時改印 YY/MM：軸上的刻度間距本來就是數十根，日的精度沒有意義，
//   而確切日期在圖上方的游標讀數列（那裡是單一根，不會混淆）。
const fmtAxisD = (t: number, iv: string, multiYear: boolean) => {
  const d = new Date(t * 1000);
  if (iv === '1mo') return `${d.getFullYear()}/${d.getMonth() + 1}`;
  if (multiYear) return `${String(d.getFullYear() % 100).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};
const fmtN = (v: number) => v >= 10000 ? v.toLocaleString('zh-TW', { maximumFractionDigits: 0 }) : v.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
const fmtV = (v: number) => v >= 1e8 ? `${(v / 1e8).toFixed(2)}億` : v >= 1e4 ? `${(v / 1e4).toFixed(1)}萬` : String(Math.round(v));

// 均線（尾端對齊）
function ma(bars: Bar[], p: number): (number | null)[] {
  const out: (number | null)[] = []; let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c; if (i >= p) sum -= bars[i - p].c;
    out.push(i >= p - 1 ? sum / p : null);
  }
  return out;
}
function maOf(vals: number[], p: number): (number | null)[] {
  const out: (number | null)[] = []; let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i]; if (i >= p) sum -= vals[i - p];
    out.push(i >= p - 1 ? sum / p : null);
  }
  return out;
}

// RSI（Wilder·與全站/回測平台同口徑）
function rsiSeries(bars: Bar[], p: number): (number | null)[] {
  const out: (number | null)[] = [null];
  let g = 0, l = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (i <= p) {
      g += d > 0 ? d : 0; l += d < 0 ? -d : 0;
      out.push(i === p ? (l === 0 ? 100 : 100 - 100 / (1 + (g / p) / (l / p))) : null);
      if (i === p) { g /= p; l /= p; }
    } else {
      g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
      l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
      out.push(l === 0 ? 100 : 100 - 100 / (1 + g / l));
    }
  }
  return out;
}

// MACD（EMA12/26·DEA=DIF 的 EMA9·OSC=DIF-DEA）
function macdSeries(bars: Bar[]): { dif: (number | null)[]; dea: (number | null)[]; osc: (number | null)[] } {
  const ema = (p: number) => {
    const k = 2 / (p + 1); const out: number[] = []; let e: number | null = null;
    for (const b of bars) { e = e == null ? b.c : b.c * k + e * (1 - k); out.push(e); }
    return out;
  };
  const e12 = ema(12), e26 = ema(26);
  const dif: (number | null)[] = [], dea: (number | null)[] = [], osc: (number | null)[] = [];
  let d9: number | null = null; const k9 = 2 / 10;
  for (let i = 0; i < bars.length; i++) {
    if (i < 26) { dif.push(null); dea.push(null); osc.push(null); continue; }
    const df = e12[i] - e26[i];
    d9 = d9 == null ? df : df * k9 + d9 * (1 - k9);
    dif.push(df); dea.push(d9); osc.push(df - d9);
  }
  return { dif, dea, osc };
}

// KD（9 日·⅔平滑——與站上 calculateKD 同口徑）
function kdSeries(bars: Bar[], p = 9): { K: (number | null)[]; D: (number | null)[] } {
  const K: (number | null)[] = [], D: (number | null)[] = [];
  let k = 50, d = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < p - 1) { K.push(null); D.push(null); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (bars[j].h > hi) hi = bars[j].h; if (bars[j].l < lo) lo = bars[j].l; }
    const rsv = hi > lo ? (bars[i].c - lo) / (hi - lo) * 100 : 50;
    k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3;
    K.push(k); D.push(d);
  }
  return { K, D };
}

// 確定性判讀（規則計算·非AI）
function readIndex(bars: Bar[], name: string, iv: string): { headline: string; lines: string[]; ind: string[] } {
  const n = bars.length;
  if (n < 65) return { headline: '資料不足', lines: [], ind: [] };
  const c = bars[n - 1].c;
  const m5 = ma(bars, 5)[n - 1]!, m20 = ma(bars, 20)[n - 1]!, m60 = ma(bars, 60)[n - 1]!;
  const m60p = ma(bars, 60)[n - 6]!;
  const unit = iv === '1d' ? '日' : iv === '1wk' ? '週' : '月';
  const chg5 = (c - bars[n - 6].c) / bars[n - 6].c * 100;
  const chg20 = (c - bars[n - 21].c) / bars[n - 21].c * 100;
  const hi20 = Math.max(...bars.slice(-20).map(b => b.h)), lo20 = Math.min(...bars.slice(-20).map(b => b.l));
  const pos = hi20 > lo20 ? (c - lo20) / (hi20 - lo20) : 0.5;
  const bias20 = (c - m20) / m20 * 100;
  const amp = bars.slice(-20).reduce((s, b) => s + (b.h - b.l) / b.c, 0) / 20 * 100;
  const bull = c > m5 && m5 > m20 && m20 > m60, bear = c < m5 && m5 < m20 && m20 < m60;
  const trend60 = m60 > m60p ? '上揚' : m60 < m60p ? '下彎' : '走平';
  const headline = bull ? `多頭排列（價>MA5>MA20>MA60）· 季線${trend60}` : bear ? `空頭排列（價<MA5<MA20<MA60）· 季線${trend60}` : `均線糾結 · 季線${trend60}`;
  const lines = [
    `位階：收 ${fmtN(c)}，位於 20${unit}區間 ${fmtN(lo20)}~${fmtN(hi20)} 的 ${(pos * 100).toFixed(0)}% 高度${pos >= 0.85 ? '（貼近區間頂）' : pos <= 0.15 ? '（貼近區間底）' : ''}。`,
    `動能：近 5${unit} ${chg5 >= 0 ? '+' : ''}${chg5.toFixed(2)}%、近 20${unit} ${chg20 >= 0 ? '+' : ''}${chg20.toFixed(2)}%。`,
    `乖離：距 20${unit}均線 ${bias20 >= 0 ? '+' : ''}${bias20.toFixed(2)}%${Math.abs(bias20) >= 5 ? '——乖離偏大，追價/追空風險升高' : '，屬正常範圍'}。`,
    `波動：近 20${unit}平均振幅 ${amp.toFixed(2)}%/${unit}${amp >= 2.5 ? '（波動偏高，部位宜縮）' : ''}。`,
    `支撐/壓力參考：MA20 ${fmtN(m20)}、MA60 ${fmtN(m60)}；20${unit}高 ${fmtN(hi20)}、20${unit}低 ${fmtN(lo20)}。`,
  ];
  // 價量：Yahoo 當根量常延遲回補（今日收盤後仍可能為 0），
  // 回退到最後一根「有量」的 K 棒並標明是哪一根——寧可標日期，不要靜默不顯示。
  const vi = (() => { for (let i = n - 1; i >= n - 5 && i > 0; i--) if (bars[i].v > 0) return i; return -1; })();
  if (vi > 20) {
    const v1 = bars[vi].v;
    const av5 = bars.slice(vi - 5, vi).reduce((s, b) => s + b.v, 0) / 5;
    const av20 = bars.slice(vi - 20, vi).reduce((s, b) => s + b.v, 0) / 20;
    const vChg = (bars[vi].c - bars[vi - 1].c) / bars[vi - 1].c * 100;
    if (av5 > 0) {
      const vx = v1 / av5;
      const pv = vChg >= 0
        ? (vx >= 1.2 ? '量增價漲（多方有跟）' : vx <= 0.8 ? '量縮價漲（追價意願弱·漲勢待確認）' : '量平價漲')
        : (vx >= 1.2 ? '量增價跌（賣壓實在）' : vx <= 0.8 ? '量縮價跌（殺盤力道趨緩）' : '量平價跌');
      const stale = vi < n - 1 ? `（最新一${unit}量尚未回補，取 ${fmtD(bars[vi].t, iv)}）` : '';
      lines.push(`價量：${fmtV(v1)}＝5${unit}均量的 ${vx.toFixed(2)} 倍${av20 > 0 ? `（5${unit}均量/20${unit}均量 ${(av5 / av20).toFixed(2)}）` : ''}——${pv}${stale}。`);
    }
  }
  // 指標讀數（描述性·非訊號——見檔頭誠實界線）
  const r5 = rsiSeries(bars, 5), r10 = rsiSeries(bars, 10);
  const { dif, dea, osc } = macdSeries(bars);
  const { K, D } = kdSeries(bars);
  const ind: string[] = [];
  const R5 = r5[n - 1], R5p = r5[n - 2], R10 = r10[n - 1];
  if (R5 != null && R10 != null) {
    const st = R5 > 80 && R5p != null && R5p > 80 ? '（連2' + unit + '>80 高檔）'
      : R5 < 20 && R5p != null && R5p < 20 ? '（連2' + unit + '<20 低檔）' : '';
    ind.push(`RSI：RSI5 ${R5.toFixed(1)}、RSI10 ${R10.toFixed(1)}${st}。本站實測：指數層級超買≠將跌（動能延續居多），低檔連2${unit}僅在全市場恐慌時有反彈統計。`);
  }
  const DF = dif[n - 1], DE = dea[n - 1], OS = osc[n - 1], OSp = osc[n - 2];
  if (DF != null && DE != null && OS != null && OSp != null) {
    const cross = OSp <= 0 && OS > 0 ? '——DIF 上穿 DEA（黃金交叉）' : OSp >= 0 && OS < 0 ? '——DIF 下穿 DEA（死亡交叉）' : OS > 0 && OS > OSp ? '·紅柱放大' : OS > 0 ? '·紅柱收斂' : OS < OSp ? '·綠柱放大' : '·綠柱收斂';
    ind.push(`MACD：DIF ${DF.toFixed(0)}、DEA ${DE.toFixed(0)}、柱 ${OS >= 0 ? '+' : ''}${OS.toFixed(0)}${cross}。實測註記：交叉屬確認型（遲到），無預測增量，僅作趨勢描述。`);
  }
  const Kv = K[n - 1], Dv = D[n - 1], Kp = K[n - 2], Dp = D[n - 2];
  if (Kv != null && Dv != null && Kp != null && Dp != null) {
    const cross = Kp <= Dp && Kv > Dv ? '——K 上穿 D（金叉）' : Kp >= Dp && Kv < Dv ? '——K 下穿 D（死叉）' : '';
    const blunt = Kv > 80 ? '·高檔區' : Kv < 20 ? '·低檔區' : '';
    ind.push(`KD：K ${Kv.toFixed(1)}、D ${Dv.toFixed(1)}${blunt}${cross}。實測註記：KD 交叉/鈍化在本站個股回測無買賣增量（K>90 避開為個股層級結論），此處僅描述位置。`);
  }
  if (name === '加權指數' || name === '櫃買指數') lines.push('個股操作以大盤為背景風險：市場健康度 <40 時模型建議休兵（見市場總覽）。');
  return { headline, lines, ind };
}

// ── SVG 蠟燭圖＋均線＋VOL/RSI/MACD/KD 副圖 ──────────────────────
// ── 多欄式線圖：主圖＋VOL／RSI／MACD／KD 各自獨立一欄 ────────────────
// （2026-08-11 使用者指定「使用個股分析那個格式，可以放大縮小有標線，
//   vol/rsi/macd/kd 都獨立一個線圖欄」。）
//
// 三個關鍵決定，改動前先讀：
//
// ① **指標一律用全序列算，算完才切視窗**。
//    舊版是先 `all.slice(-win)` 再算指標，於是視窗最前面那幾根沒有暖身資料——
//    MACD 需要 26 根、KD 需要 9 根，畫出來的頭段是空的或失真的。
//    現在傳進來的是完整序列，切窗只發生在「畫」的階段。
//
// ② **每一欄是自己的 <svg>，但共用同一組 x 幾何**（W/padL/padR/view 長度相同），
//    所以同一個 index 在五欄的 x 位置完全對齊，一條標線讀得穿。
//    hover 狀態提在父層 → 摸任何一欄，五欄同時出現標線。
//
// ③ **軸文字全部走 HTML 疊層**。這裡的 <svg> 用 preserveAspectRatio="none"
//    （高度固定、寬度撐滿，這樣手機上副圖不會被壓扁），代價是 x/y 縮放比不同，
//    文字放進 SVG 會被水平壓扁成細長黑影——與個股 K 線圖同一個坑。
function MultiPaneChart({ all, iv, initSize }: { all: Bar[]; iv: string; initSize: number }) {
  const n = all.length;
  const [size, setSize] = useState(Math.min(initSize, n || initSize));
  const [offset, setOffset] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSize(Math.min(initSize, n || initSize)); setOffset(0); setHover(null); }, [initSize, n, iv]);

  const ind = useMemo(() => ({
    m5: ma(all, 5), m20: ma(all, 20), m60: ma(all, 60),
    r5: rsiSeries(all, 5), r10: rsiSeries(all, 10),
    macd: macdSeries(all), kd: kdSeries(all),
    vma5: maOf(all.map(b => b.v), 5),
  }), [all]);

  const clampSize = Math.max(8, Math.min(size, n || 8));
  const clampOffset = Math.max(0, Math.min(offset, Math.max(0, n - clampSize)));
  const start = Math.max(0, n - clampSize - clampOffset);
  const end = n - clampOffset;
  const view = all.slice(start, end);

  // 滾輪縮放（passive:false 才能 preventDefault，否則頁面會跟著捲）
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // ⚠ 資料還沒到（n=0）時**必須直接返回**（2026-08-11 實測）：
      //   原本寫 Math.min(n || 8, …)，載入中滾一下滑鼠就變成 min(8, 120)=8，
      //   而且會卡住不還原 —— 進頁面看到的是「8/1214 根日K」，只剩八根 K 棒。
      //   這種「用 `|| 預設值` 掩蓋未初始化狀態」的寫法，錯的時候不會報錯，只會靜靜給出爛值。
      if (n < 8) return;
      e.preventDefault();
      setSize(s => Math.round(Math.max(8, Math.min(n, s * (e.deltaY > 0 ? 1.18 : 0.85)))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [n]);

  const W = 1000, padL = 52, padR = 10;
  const slot = (W - padL - padR) / Math.max(1, view.length);
  const xOf = (i: number) => padL + (i + 0.5) * slot;

  // ⚠ 按下先讀值、位移超過門檻才改判為平移（沿用個股 K 線的做法）：
  //   若一按下就進拖曳分支，觸控裝置永遠叫不出標線——手指沒有 hover 這回事。
  const PAN_THRESHOLD = 6;
  const drag = useRef<{ x: number; off: number; per: number; panning: boolean } | null>(null);
  const hoverFromX = (el: HTMLElement, clientX: number) => {
    const r = el.getBoundingClientRect();
    const vbX = (clientX - r.left) / r.width * W;
    const i = Math.round((vbX - padL) / slot - 0.5);
    setHover(i >= 0 && i < view.length ? i : null);
  };
  const onDown = (e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 指標已結束就略過，不該擋掉讀值 */ }
    drag.current = { x: e.clientX, off: clampOffset, per: (e.currentTarget as HTMLElement).clientWidth / Math.max(1, view.length), panning: false };
    hoverFromX(e.currentTarget as HTMLElement, e.clientX);
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current && !drag.current.panning) {
      if (Math.abs(e.clientX - drag.current.x) < PAN_THRESHOLD) { hoverFromX(e.currentTarget as HTMLElement, e.clientX); return; }
      drag.current.panning = true; setHover(null);
    }
    if (drag.current) {
      const moved = Math.round((e.clientX - drag.current.x) / drag.current.per);
      setOffset(Math.max(0, Math.min(Math.max(0, n - clampSize), drag.current.off + moved)));
      return;
    }
    hoverFromX(e.currentTarget as HTMLElement, e.clientX);
  };
  const onUp = () => { drag.current = null; };
  const onLeave = () => { drag.current = null; setHover(null); };
  const panProps = { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerLeave: onLeave };

  if (!view.length) return <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#cbd5f5', padding: 24 }}>無資料</div>;

  const gi = hover != null ? start + hover : end - 1;   // 讀數用的全序列索引
  const hv = hover != null ? view[hover] : null;
  const at = (a: (number | null)[]) => a[gi];
  const sliceOf = (a: (number | null)[]) => view.map((_, i) => a[start + i]);
  const multiYear = view.length > 1 &&
    new Date(view[0].t * 1000).getFullYear() !== new Date(view[view.length - 1].t * 1000).getFullYear();
  const dateStep = Math.max(1, Math.ceil(view.length / 6));

  // 一欄 = 一張獨立的圖：自己的標題列、自己的 Y 軸、共用的 x 與標線
  // ⚠ 這是**渲染函式**不是元件，呼叫方式固定為 {renderPane({...})}（2026-08-11）：
  //   若寫成 `const Pane = (props) => ...` 再用 <Pane /> 掛載，
  //   由於它定義在 render 內部，每次 render 都是一個**新的元件型別**，
  //   React 會卸載整棵子樹再重掛 —— 拖曳中的 pointer capture 會斷、標線會閃掉，
  //   實測第一次模擬 pointerdown 量到五欄標線全是 0。
  //   當成純函式呼叫就沒有元件識別，等同把 JSX 直接寫在原地。
  const renderPane = ({ h, title, legend, lo, hi, fmtY, ticks, showDates, draw }: {
    h: number; title: string; legend?: React.ReactNode; lo: number; hi: number;
    fmtY: (v: number) => string; ticks: number[]; showDates?: boolean;
    draw: (yOf: (v: number) => number) => React.ReactNode;
  }) => {
    const padT = 6, padB = 6;
    const yOf = (v: number) => padT + ((hi - v) / ((hi - lo) || 1)) * (h - padT - padB);
    return (
      <div style={{ border: '1px solid var(--border-primary)', borderRadius: 10, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, rowGap: 2, flexWrap: 'wrap', padding: '4px 8px',
          fontSize: 'calc(11px * var(--fz))', fontWeight: 700, color: 'var(--text-muted)', borderBottom: '1px solid var(--border-primary)' }}>
          <span style={{ whiteSpace: 'nowrap' }}>{title}</span>{legend}
        </div>
        <div style={{ position: 'relative', touchAction: 'none', cursor: 'crosshair', userSelect: 'none' }} {...panProps}>
          <svg viewBox={`0 0 ${W} ${h}`} width="100%" height={h} preserveAspectRatio="none">
            {ticks.map(v => <line key={v} x1={padL} x2={W - padR} y1={yOf(v)} y2={yOf(v)} stroke="rgba(148,163,184,0.16)" />)}
            {draw(yOf)}
            {hover != null && <line x1={xOf(hover)} x2={xOf(hover)} y1={padT} y2={h - padB} stroke="rgba(255,255,255,0.5)" strokeWidth={1} strokeDasharray="3 3" />}
          </svg>
          {ticks.map(v => (
            <span key={v} style={{ position: 'absolute', left: 0, top: yOf(v), transform: 'translateY(-50%)', width: padL - 6,
              textAlign: 'right', pointerEvents: 'none', whiteSpace: 'nowrap',
              fontSize: 'calc(10px * var(--fz))', color: '#9fb0c9', fontFamily: 'JetBrains Mono, monospace' }}>{fmtY(v)}</span>
          ))}
          {/* 日期軸只掛在主圖與最末欄：五欄各掛一條會多吃 75px，而 x 是共用的，
              中間三欄照著上下兩條對就讀得到。 */}
          {showDates && (
            <div style={{ position: 'absolute', left: 0, right: 0, bottom: -15, height: 15, overflow: 'hidden', pointerEvents: 'none' }}>
              {view.map((b, i) => (i % dateStep === 0 ? (
                <span key={b.t} style={{ position: 'absolute', left: `${(xOf(i) / W) * 100}%`, bottom: 0, transform: 'translateX(-50%)',
                  whiteSpace: 'nowrap', fontSize: 'calc(9.5px * var(--fz))', color: '#9fb0c9', fontFamily: 'JetBrains Mono, monospace' }}>
                  {fmtAxisD(b.t, iv, multiYear)}
                </span>
              ) : null))}
            </div>
          )}
        </div>
        {showDates && <div style={{ height: 15 }} />}
      </div>
    );
  };

  // 主圖範圍：含均線，否則均線會被畫到框外
  const maVis = [ind.m5, ind.m20, ind.m60].flatMap(a => sliceOf(a).filter((v): v is number => v != null));
  const pLo = Math.min(...view.map(b => b.l), ...(maVis.length ? maVis : [Infinity]));
  const pHi = Math.max(...view.map(b => b.h), ...(maVis.length ? maVis : [-Infinity]));
  const pPad = (pHi - pLo) * 0.06 || 1;
  const yLo = pLo - pPad, yHi = pHi + pPad;
  const vMax = Math.max(...view.map(b => b.v), 1);
  const oscV = sliceOf(ind.macd.osc).filter((v): v is number => v != null);
  const difV = [...sliceOf(ind.macd.dif), ...sliceOf(ind.macd.dea)].filter((v): v is number => v != null);
  const mAbs = Math.max(...oscV.map(Math.abs), ...difV.map(Math.abs), 1e-9);
  const hasVol = view.some(b => b.v > 0);

  const poly = (a: (number | null)[], yOf: (v: number) => number, color: string, sw = 1.4) => {
    const pts: string[] = [];
    sliceOf(a).forEach((v, i) => { if (v != null) pts.push(`${pts.length ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`); });
    return pts.length > 1 ? <path d={pts.join(' ')} fill="none" stroke={color} strokeWidth={sw} /> : null;
  };
  const chip = (color: string, label: string, val: string) => (
    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
      <span style={{ display: 'inline-block', padding: '0 4px', borderRadius: 3, background: color, color: '#0b1220',
        fontWeight: 900, fontSize: 'calc(9.5px * var(--fz))', lineHeight: '13px' }}>{label}</span>
      <b style={{ color, fontFamily: 'JetBrains Mono, monospace' }}>{val}</b>
    </span>
  );
  const nz = (v: number | null | undefined, d = 1) => (v == null ? '—' : v.toFixed(d));

  return (
    <div ref={wrapRef} style={{ display: 'grid', gap: 6, minWidth: 0 }}>
      {/* 游標讀數：哪一根、開高低收 */}
      <div style={{ display: 'flex', gap: 8, rowGap: 2, flexWrap: 'wrap', fontSize: 'calc(11px * var(--fz))', color: '#dbe4f5', minWidth: 0 }}>
        <b style={{ whiteSpace: 'nowrap' }}>{fmtD((hv ?? view[view.length - 1]).t, iv)}{multiYear && iv !== '1mo' ? `（${new Date((hv ?? view[view.length - 1]).t * 1000).getFullYear()}）` : ''}</b>
        {(() => { const b = hv ?? view[view.length - 1]; return (
          <>
            <span style={{ whiteSpace: 'nowrap' }}>開 {fmtN(b.o)}</span>
            <span style={{ whiteSpace: 'nowrap' }}>高 <b style={{ color: UP }}>{fmtN(b.h)}</b></span>
            <span style={{ whiteSpace: 'nowrap' }}>低 <b style={{ color: DOWN }}>{fmtN(b.l)}</b></span>
            <span style={{ whiteSpace: 'nowrap' }}>收 <b style={{ color: b.c >= b.o ? UP : DOWN }}>{fmtN(b.c)}</b></span>
          </>
        ); })()}
        <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{hv ? '游標' : '最新'}</span>
      </div>

      {renderPane({ h: 230, title: 'K線', lo: yLo, hi: yHi, showDates: true,
        fmtY: v => fmtN(v), ticks: [yHi, yLo + (yHi - yLo) * 0.5, yLo],
        legend: (<>{chip('#f6c945', '5', nz(at(ind.m5), 0))}{chip('#3d8ef8', '20', nz(at(ind.m20), 0))}{chip('#c084fc', '60', nz(at(ind.m60), 0))}</>),
        draw: yOf => (<>
          {view.map((b, i) => {
            const up = b.c >= b.o, col = up ? UP : DOWN;
            const yO = yOf(b.o), yC = yOf(b.c);
            return (
              <g key={b.t}>
                <line x1={xOf(i)} x2={xOf(i)} y1={yOf(b.h)} y2={yOf(b.l)} stroke={col} strokeWidth={1} />
                <rect x={xOf(i) - Math.max(slot * 0.31, 0.6)} y={Math.min(yO, yC)} width={Math.max(slot * 0.62, 1.2)} height={Math.max(Math.abs(yO - yC), 1)} fill={col} />
              </g>
            );
          })}
          {poly(ind.m5, yOf, '#f6c945')}{poly(ind.m20, yOf, '#3d8ef8')}{poly(ind.m60, yOf, '#c084fc')}
          <line x1={padL} x2={W - padR} y1={yOf(view[view.length - 1].c)} y2={yOf(view[view.length - 1].c)} stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 4" opacity={0.85} />
          {hv && <line x1={padL} x2={W - padR} y1={yOf(hv.c)} y2={yOf(hv.c)} stroke="rgba(255,255,255,0.5)" strokeWidth={1} strokeDasharray="3 3" />}
        </>) })}

      {hasVol && renderPane({ h: 84, title: 'VOL 成交量', lo: 0, hi: vMax,
        fmtY: v => fmtV(v), ticks: [vMax, vMax / 2, 0],
        legend: (<>{chip('#f6c945', '均5', at(ind.vma5) != null ? fmtV(at(ind.vma5)!) : '—')}
            <span style={{ fontFamily: 'JetBrains Mono, monospace', color: '#dbe4f5' }}>{fmtV((hv ?? view[view.length - 1]).v)}</span></>),
        draw: yOf => (<>
            {view.map((b, i) => (
              <rect key={b.t} x={xOf(i) - Math.max(slot * 0.31, 0.6)} y={yOf(b.v)} width={Math.max(slot * 0.62, 1.2)}
                height={Math.max(yOf(0) - yOf(b.v), 0.5)} fill={b.c >= b.o ? UP : DOWN} opacity={0.5} />
            ))}
            {poly(ind.vma5, yOf, '#f6c945', 1.2)}
          </>) })}

      {renderPane({ h: 84, title: 'RSI 5／10（Wilder）', lo: 0, hi: 100,
        fmtY: v => String(v), ticks: [80, 50, 20],
        legend: (<>{chip('#f6c945', '5', nz(at(ind.r5)))}{chip('#7dd3fc', '10', nz(at(ind.r10)))}</>),
        draw: yOf => (<>{poly(ind.r5, yOf, '#f6c945', 1.3)}{poly(ind.r10, yOf, '#7dd3fc', 1.3)}</>) })}

      {renderPane({ h: 84, title: 'MACD 12·26·9', lo: -mAbs, hi: mAbs,
        fmtY: v => (Math.abs(v) < 1e-6 ? '0' : v.toFixed(0)), ticks: [mAbs, 0, -mAbs],
        legend: (<>{chip('#f6c945', 'DIF', nz(at(ind.macd.dif)))}{chip('#7dd3fc', 'DEA', nz(at(ind.macd.dea)))}
          <span style={{ whiteSpace: 'nowrap' }}>柱 <b style={{ color: (at(ind.macd.osc) ?? 0) >= 0 ? UP : DOWN, fontFamily: 'JetBrains Mono, monospace' }}>{nz(at(ind.macd.osc))}</b></span></>),
        draw: yOf => (<>
          {view.map((b, i) => {
            const v = sliceOf(ind.macd.osc)[i]; if (v == null) return null;
            const y0 = yOf(0), y1 = yOf(v);
            return <rect key={b.t} x={xOf(i) - Math.max(slot * 0.27, 0.5)} y={Math.min(y0, y1)} width={Math.max(slot * 0.54, 1)}
              height={Math.max(Math.abs(y1 - y0), 0.5)} fill={v >= 0 ? UP : DOWN} opacity={0.55} />;
          })}
          {poly(ind.macd.dif, yOf, '#f6c945', 1.3)}{poly(ind.macd.dea, yOf, '#7dd3fc', 1.3)}
        </>) })}

      {renderPane({ h: 84, title: 'KD 9（⅔平滑）', lo: 0, hi: 100, showDates: true,
        fmtY: v => String(v), ticks: [80, 50, 20],
        legend: (<>{chip('#f6c945', 'K', nz(at(ind.kd.K)))}{chip('#7dd3fc', 'D', nz(at(ind.kd.D)))}</>),
        draw: yOf => (<>{poly(ind.kd.K, yOf, '#f6c945', 1.3)}{poly(ind.kd.D, yOf, '#7dd3fc', 1.3)}</>) })}

      {/* 縮放列：與個股 K 線同一組操作（－／＋／根數／最新 ›） */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, rowGap: 4, flexWrap: 'wrap', marginTop: 2,
        fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>
        <button onClick={() => setSize(s => Math.round(Math.min(n, s * 1.4)))} title="縮小（顯示更多根）" style={zoomBtn}>－</button>
        <button onClick={() => setSize(s => Math.round(Math.max(8, s * 0.7)))} title="放大（顯示更少根）" style={zoomBtn}>＋</button>
        <span style={{ whiteSpace: 'nowrap' }}>{view.length}/{n} 根{iv === '1d' ? '日' : iv === '1wk' ? '週' : '月'}K</span>
        <span className="desktop-only" style={{ whiteSpace: 'nowrap' }}>· 滾輪縮放 · 拖曳平移</span>
        {clampOffset > 0 && <button onClick={() => setOffset(0)} style={{ ...zoomBtn, marginLeft: 'auto' }}>最新 ›</button>}
      </div>
    </div>
  );
}

const zoomBtn: React.CSSProperties = {
  flexShrink: 0, whiteSpace: 'nowrap', padding: '3px 10px', borderRadius: 7,
  border: '1px solid var(--border-primary)', background: 'var(--bg-elevated)',
  color: 'var(--text-primary)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'calc(11.5px * var(--fz))',
};

// ── 指數分頁 ─────────────────────────────────────────────────────
export default function IndexAnalysis() {
  const [sym, setSym] = useState('twii');
  const [iv, setIv] = useState<'1d' | '1wk' | '1mo'>('1d');
  const [win, setWin] = useState(120);
  const [all, setAll] = useState<Bar[]>([]);
  const [name, setName] = useState('加權指數');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const j = await fetch(`/api/index/candles?sym=${sym}&interval=${iv}`).then(r => (r.ok ? r.json() : null));
      setAll(j?.candles || []); setName(j?.name || sym); setNote(j?.note || '');
    } catch { setAll([]); } finally { setLoading(false); }
  }, [sym, iv]);
  useEffect(() => { load(); }, [load]);

  const read = useMemo(() => readIndex(all, name, iv), [all, name, iv]);
  const last = all[all.length - 1], prev = all[all.length - 2];
  const chg = last && prev ? (last.c - prev.c) / prev.c * 100 : 0;
  const hist = useMemo(() => [...all.slice(-20)].reverse(), [all]);

  // ── 改用個股分析頁的分頁列格式（2026-08-11 使用者指定）───────────────
  // 原本三組選擇器都是 flex-wrap 的膠囊：手機上 7 個指數換 2~3 行、
  // 加上週期與根數共佔掉 4 行，把圖表一路擠到畫面外。
  // 個股頁那組 .tabs 是**橫向捲動**的（塞不下就左右滑，不換行、不推高版面），
  // 這裡沿用同一個 class，操作手感與個股頁一致。
  // ⚠ minWidth: 0 不可省——這幾條是 grid 子項，預設 min-width:auto ＝
  //   「不縮到 min-content 以下」，而 min-content 是所有 nowrap 分頁的總寬。
  //   只寫 overflowX:auto 沒有用：捲動殼自己就先被撐爆了（實測仍溢出 33px）。
  const strip: React.CSSProperties = {
    display: 'flex', gap: 2, background: 'var(--bg-secondary)', borderRadius: 10,
    padding: 3, minWidth: 0, maxWidth: '100%', overflowX: 'auto', scrollbarWidth: 'none',
  };
  const chip = (on: boolean): React.CSSProperties => ({
    flexShrink: 0, whiteSpace: 'nowrap', padding: '6px 12px', borderRadius: 7, border: 'none',
    fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    background: on ? 'var(--bg-elevated)' : 'transparent',
    color: on ? 'var(--text-primary)' : 'var(--text-muted)',
    boxShadow: on ? 'var(--shadow-sm)' : 'none',
  });

  return (
    // ⚠ 必須明寫 gridTemplateColumns: minmax(0, 1fr)（2026-08-11 實測）：
    //   隱式 auto 軌道會被子項的 max-content 拉大——即使子項已 minWidth:0 + overflowX:auto，
    //   軌道仍被算成 387.6px（容器只有 335px），整頁溢出 33px。
    //   子項的 maxWidth:100% 在這裡是循環參照（百分比對上正在計算中的軌道），救不了。
    //   釘成 minmax(0, 1fr) 之後軌道＝容器寬，捲動殼才真的在殼裡捲。
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8, minWidth: 0 }}>
      {/* 指數：7 個，手機一定塞不下 → 橫向捲 */}
      <div style={strip}>
        {SYMS.map(s => <button key={s.id} onClick={() => setSym(s.id)} style={chip(sym === s.id)}>{s.label}</button>)}
      </div>
      {/* 週期＋根數合併成一列（原本各佔一行）；中間用細分隔線區隔兩組語意 */}
      <div style={strip}>
        {INTERVALS.map(i => <button key={i.id} onClick={() => setIv(i.id)} style={chip(iv === i.id)}>{i.label}</button>)}
        <span style={{ flexShrink: 0, width: 1, margin: '4px 6px', background: 'var(--border-primary)' }} />
        {WINDOWS.map(w => <button key={w} onClick={() => setWin(w)} style={chip(win === w)} title={`初始顯示 ${w} 根（圖上可再用 －／＋ 或滾輪縮放、拖曳平移）`}>{w}根</button>)}
      </div>
      {last && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, rowGap: 2, flexWrap: 'wrap', fontSize: 'calc(14px * var(--fz))', fontWeight: 900, minWidth: 0, maxWidth: '100%' }}>
          <span style={{ whiteSpace: 'nowrap' }}>{name}</span>
          <span style={{ fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>{fmtN(last.c)}</span>
          <span style={{ color: chg >= 0 ? UP : DOWN, whiteSpace: 'nowrap' }}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}%</span>
          <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 400, color: '#cbd5f5', whiteSpace: 'nowrap' }}>{fmtD(last.t, iv)}</span>
        </div>
      )}

      <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
        {loading ? <div style={{ fontSize: 12.5, color: '#cbd5f5', padding: 24 }}>載入 {name} K 線…</div>
          : all.length ? <MultiPaneChart all={all} iv={iv} initSize={win} /> : <div style={{ fontSize: 12.5, color: '#cbd5f5', padding: 24 }}>無資料</div>}
        {note && <div style={{ fontSize: 11, color: '#cbd5f5', marginTop: 4 }}>ℹ {note}</div>}
      </div>

      {read.lines.length > 0 && (
        <div style={{ padding: '12px 14px', borderRadius: 12, background: 'rgba(125,211,252,0.06)', border: '1px solid rgba(125,211,252,0.3)', fontSize: 12.5, lineHeight: 1.9 }}>
          <div style={{ fontWeight: 900, marginBottom: 4 }}>🧭 自動判讀（規則計算·非 AI 生成）：{read.headline}</div>
          {read.lines.map((l, i) => <div key={i} style={{ color: '#dbe4f5' }}>· {l}</div>)}
          {read.ind.length > 0 && <>
            <div style={{ fontWeight: 900, margin: '8px 0 2px' }}>📐 指標讀數（描述性·非買賣訊號）</div>
            {read.ind.map((l, i) => <div key={'i' + i} style={{ color: '#dbe4f5' }}>· {l}</div>)}
          </>}
          <div style={{ marginTop: 6, fontSize: 11, color: '#cbd5f5' }}>判讀為技術面描述，非預測、非投資建議。MACD/KD 交叉類為確認型指標，本站回測無預測增量。</div>
        </div>
      )}

      <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
        <div style={{ fontWeight: 900, fontSize: 13, marginBottom: 6 }}>📋 歷史資料（近 20 根{INTERVALS.find(i => i.id === iv)?.label}）</div>
        <div className="mobile-only" style={{ fontSize: 'calc(10.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 4 }}>← 左右滑動可看完 9 個欄位</div>
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          {/* ⚠ 這張表**必須**給 td/th padding（2026-08-11 使用者：「歷史資料的數字都粘在一起了，無法判讀」）：
              9 個欄位裡只有「日期」那格寫了 padding，其餘 8 格是 0，
              加上 borderCollapse:'collapse' 連框線間距都沒有，
              於是「24,318 24,402 24,201」在手機上直接黏成一長串數字。
              padding 撐開後整表約需 560px > 手機 335px，所以配 minWidth＋外層 overflowX:auto
              讓它在卡片內橫向捲動——寧可捲，也不要把數字擠在一起。
              nowrap 是同一件事的另一半：絕不在一個數值中間換行。 */}
          <table className="idxHistTable" style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse', fontSize: 'calc(12px * var(--fz))', fontFamily: 'JetBrains Mono, monospace' }}>
            <thead><tr style={{ color: '#cbd5f5', textAlign: 'right' }}>
              <th style={{ textAlign: 'left' }}>日期</th><th>開盤</th><th>最高</th><th>最低</th><th>收盤</th><th>漲跌%</th><th>成交量</th><th>RSI5</th><th>K</th>
            </tr></thead>
            <tbody>
              {hist.map((b, i) => {
                const p = hist[i + 1]; const ch = p ? (b.c - p.c) / p.c * 100 : null;
                const gi = all.length - 1 - i;   // hist 是反轉切片 → 對回全序列索引
                const r5all = readCache(all, gi);
                return (
                  <tr key={b.t} style={{ textAlign: 'right', borderTop: '1px solid rgba(148,163,184,0.08)' }}>
                    <td style={{ textAlign: 'left', color: '#dbe4f5' }}>{fmtD(b.t, iv)}</td>
                    <td>{fmtN(b.o)}</td><td>{fmtN(b.h)}</td><td>{fmtN(b.l)}</td>
                    <td style={{ fontWeight: 700, color: b.c >= b.o ? UP : DOWN }}>{fmtN(b.c)}</td>
                    <td style={{ color: ch == null ? '#cbd5f5' : ch >= 0 ? UP : DOWN }}>{ch == null ? '—' : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%`}</td>
                    <td style={{ color: '#cbd5f5' }}>{b.v > 0 ? fmtV(b.v) : '—'}</td>
                    <td style={{ color: '#cbd5f5' }}>{r5all.r5 ?? '—'}</td>
                    <td style={{ color: '#cbd5f5' }}>{r5all.k ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// 歷史表的 RSI/K 讀數：全序列算一次、模組級快取（避免每列重算 O(n²)）
let _rcKey: Bar[] | null = null;
let _rcVal: { r5: (number | null)[]; k: (number | null)[] } | null = null;
function readCache(all: Bar[], i: number): { r5: string | null; k: string | null } {
  if (_rcKey !== all) { _rcKey = all; _rcVal = { r5: rsiSeries(all, 5), k: kdSeries(all).K }; }
  const r = _rcVal!.r5[i], k = _rcVal!.k[i];
  return { r5: r == null ? null : r.toFixed(1), k: k == null ? null : k.toFixed(1) };
}
