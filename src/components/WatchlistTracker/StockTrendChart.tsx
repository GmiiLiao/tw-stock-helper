'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useAppStore } from '@/lib/store';
import { type CandleData } from '@/lib/twse-api';
import { format } from 'date-fns';
import {
  ResponsiveContainer, ComposedChart, Area, Bar, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine,
} from 'recharts';
import styles from './WatchlistTracker.module.css';

interface StockTrendChartProps {
  code: string;
  name: string;
  closePrice?: number;
  /** Current MIS realtime price — appended as the live tip (Yahoo intraday lags ~20min). */
  livePrice?: number;
  /** 今日漲跌% — 供勝率雷達判斷「散戶追價·過熱」階段。 */
  changePercent?: number;
  /** 今日成交量(股) — 供勝率雷達「外資佔量%」比例門檻(較 chipArchive 即時準確)。 */
  volume?: number;
}

// 四種 K 線：即時(以時間為單位) / 日 / 週 / 月。日週月為蠟燭圖，可 +/- 或滾輪縮放、拖曳平移。
type Mode = 'rt' | 'day' | 'week' | 'month';
const INTERVAL: Record<Exclude<Mode, 'rt'>, string> = { day: '1d', week: '1wk', month: '1mo' };
const DEFAULT_SIZE: Record<Exclude<Mode, 'rt'>, number> = { day: 30, week: 30, month: 72 }; // 30日/30週/72月(6年)
const MODE_LABEL: Record<Mode, string> = { rt: '即時', day: '日', week: '週', month: '月' };

interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

const isTradingHours = () => {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return day >= 1 && day <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
};

// ── 蠟燭圖（自繪 SVG，支援縮放/平移）─────────────────────────────
function CandleChart({ candles, mode, code, onView }: { candles: Candle[]; mode: Exclude<Mode, 'rt'>; code: string; onView?: (s: { highest: number; lowest: number; pct: number }) => void }) {
  const n = candles.length;
  const [size, setSize] = useState(DEFAULT_SIZE[mode]);
  const [offset, setOffset] = useState(0); // 從最新往回偏移的根數
  const [hoverIdx, setHoverIdx] = useState<number | null>(null); // 游標所指的 K 棒
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSize(Math.min(DEFAULT_SIZE[mode], n || DEFAULT_SIZE[mode])); setOffset(0); setHoverIdx(null); }, [mode, code, n]);

  const clampSize = Math.max(8, Math.min(size, n || 8));
  const clampOffset = Math.max(0, Math.min(offset, Math.max(0, n - clampSize)));
  const start = Math.max(0, n - clampSize - clampOffset);
  const end = n - clampOffset;
  const view = candles.slice(start, end);

  // 回報可視區間的最高/最低/漲跌 → 右側面板「區間」隨縮放平移更新
  useEffect(() => {
    if (!view.length || !onView) return;
    const highest = Math.max(...view.map(c => c.h)), lowest = Math.min(...view.map(c => c.l));
    const s0 = view[0].c, s1 = view[view.length - 1].c;
    onView({ highest, lowest, pct: s0 > 0 ? (s1 - s0) / s0 * 100 : 0 });
  }, [start, end, n]); // eslint-disable-line react-hooks/exhaustive-deps

  // 滾輪縮放（需 passive:false 才能 preventDefault）
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.18 : 0.85;
      setSize(s => Math.round(Math.max(8, Math.min(n || 8, s * f))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [n]);

  // 拖曳平移
  // ⚠ 手機上「碰一下」必須是**看十字線**，不是平移（2026-08-11 使用者回報
  //   「日週月的線圖沒有標線，無法準確查看」）：
  //   舊版 onDown 一律進入拖曳模式，onMove 又在拖曳分支就 return，
  //   於是觸控裝置**永遠叫不出十字線**——沒有游標可以 hover，只能拖著跑。
  //   ⇒ 按下時先不算拖曳，位移超過 PAN_THRESHOLD 才切成平移；
  //     在那之前照樣更新 hoverIdx，點哪根就讀哪根。
  const PAN_THRESHOLD = 6;
  const drag = useRef<{ x: number; off: number; per: number; panning: boolean } | null>(null);
  const setHoverFromX = (el: HTMLElement, clientX: number) => {
    const rect = el.getBoundingClientRect();
    const vbX = (clientX - rect.left) / rect.width * 1000;
    const slotW = (1000 - 48 - 10) / Math.max(1, clampSize);
    const idx = Math.round((vbX - 48) / slotW - 0.5);
    setHoverIdx(idx >= 0 && idx < clampSize ? idx : null);
  };
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, off: clampOffset, per: (e.currentTarget as HTMLElement).clientWidth / Math.max(1, view.length), panning: false };
    setHoverFromX(e.currentTarget as HTMLElement, e.clientX);   // 按下即顯示十字線
  };
  const onMove = (e: React.PointerEvent) => {
    if (drag.current && !drag.current.panning) {
      if (Math.abs(e.clientX - drag.current.x) < PAN_THRESHOLD) {
        setHoverFromX(e.currentTarget as HTMLElement, e.clientX);   // 還在門檻內＝繼續讀值
        return;
      }
      drag.current.panning = true;
      setHoverIdx(null);
    }
    if (drag.current) {
      const barsMoved = Math.round((e.clientX - drag.current.x) / drag.current.per);
      setOffset(Math.max(0, Math.min(Math.max(0, n - clampSize), drag.current.off + barsMoved)));
      return;
    }
    // 未拖曳：依游標 x 對應到 K 棒（viewBox 0..1000，padL=48、padR=10）
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const vbX = (e.clientX - rect.left) / rect.width * 1000;
    const vLen = clampSize; // 一般情況 view.length === clampSize
    const slotW = (1000 - 48 - 10) / Math.max(1, vLen);
    const idx = Math.round((vbX - 48) / slotW - 0.5);
    setHoverIdx(idx >= 0 && idx < vLen ? idx : null);
  };
  const onUp = () => { drag.current = null; };
  const onLeave = () => { drag.current = null; setHoverIdx(null); };

  // 均線（台股慣稱：週線=MA5、月線=MA20、季線=MA60）——以全序列計算再切視窗
  // ⚠ 標籤一律用短名（2026-08-11 手機回報「文字用詞太長」）：
  //   原本日線模式會顯示「週MA5 / 月MA20 / 季MA60」，三個加上數值約 390px，
  //   剛好超過手機可用寬度 → 每一條各佔一行，圖例就吃掉三整行高度。
  //   台股慣稱（週線/月線/季線）改放在 title 提示裡，需要的人長按就看得到。
  const MA_DEFS = [
    { p: 5, label: 'MA5', color: '#f6c945' },
    { p: 20, label: 'MA20', color: '#3d8ef8' },
    { p: 60, label: 'MA60', color: '#c084fc' },
  ];
  const maFull = useMemo(() => MA_DEFS.map(d => {
    const out: (number | null)[] = new Array(candles.length).fill(null);
    let sum = 0;
    for (let i = 0; i < candles.length; i++) {
      sum += candles[i].c;
      if (i >= d.p) sum -= candles[i - d.p].c;
      if (i >= d.p - 1) out[i] = sum / d.p;
    }
    return out;
  }), [candles]); // eslint-disable-line react-hooks/exhaustive-deps

  if (view.length === 0) return <div className={styles.chartError}>無 K 線數據</div>;

  const W = 1000, H = 240, padL = 48, padR = 10, padT = 8, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maVisible = maFull.flatMap(arr => view.map((_, i) => arr[start + i]).filter((v): v is number => v != null));
  const lo = Math.min(...view.map(c => c.l), ...(maVisible.length ? maVisible : [Infinity])),
        hi = Math.max(...view.map(c => c.h), ...(maVisible.length ? maVisible : [-Infinity]));
  const pad = (hi - lo) * 0.06 || 1; const yMin = lo - pad, yMax = hi + pad;
  const slot = plotW / view.length;
  const cw = Math.max(1, slot * 0.62);
  const xOf = (i: number) => padL + (i + 0.5) * slot;
  const yOf = (v: number) => padT + ((yMax - v) / (yMax - yMin)) * plotH;
  const fmt = mode === 'month' ? 'yyyy/MM' : mode === 'week' ? 'yy/MM/dd' : 'MM/dd';
  const step = Math.max(1, Math.ceil(view.length / 7));
  const yTicks = 4;

  const hv = hoverIdx !== null && hoverIdx < view.length ? view[hoverIdx] : null;
  const hvFmt = mode === 'month' ? 'yyyy/MM' : 'yyyy/MM/dd';

  const legendIdx = hoverIdx !== null && hoverIdx < view.length ? start + hoverIdx : end - 1;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, rowGap: 2, flexWrap: 'wrap', fontSize: 'calc(11px * var(--fz))', padding: '2px 4px 3px', color: 'var(--text-muted)' }}>
        {MA_DEFS.map((d, di) => {
          const v = maFull[di][legendIdx];
          return (
            // ⚠ 圖例用「色線＋週期數」當圖示（2026-08-11 使用者要求以 icon 縮減文字）：
            //   顏色本身就是識別，"MA" 三個字母對每一條都重複、純粹佔位。
            //   全名與台股慣稱留在 title，長按/hover 看得到。
            <span key={d.p} title={`MA${d.p}：${d.p} 根收盤均價${mode === 'day' ? `（台股慣稱${d.p === 5 ? '週線' : d.p === 20 ? '月線' : '季線'}）` : ''}`}
              style={{ cursor: 'help', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              {/* 週期做成色塊標籤，而不是裸數字——「5 488.10」會被誤讀成同一個數字，
                  在報價畫面上讀錯數字比佔空間嚴重得多。 */}
              <span style={{ display: 'inline-block', padding: '0 4px', borderRadius: 3, background: d.color,
                color: '#0b1220', fontWeight: 900, fontSize: 'calc(9.5px * var(--fz))', lineHeight: '13px' }}>{d.p}</span>
              <b style={{ color: d.color }}>{v != null ? v.toFixed(2) : '—'}</b>
            </span>
          );
        })}
      </div>
      <div ref={wrapRef} style={{ position: 'relative', touchAction: 'none', cursor: 'crosshair', userSelect: 'none' }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onLeave}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none">
          {/* Y 網格＋刻度 */}
          {Array.from({ length: yTicks + 1 }, (_, i) => {
            const v = yMin + (yMax - yMin) * (i / yTicks); const y = yOf(v);
            return (
              <g key={i}>
                <line x1={padL} y1={y} x2={W - padR} y2={y} stroke="rgba(255,255,255,0.11)" />
              </g>
            );
          })}
          {/* 蠟燭 */}
          {view.map((c, i) => {
            const up = c.c >= c.o;            // 台股：漲紅跌綠
            const col = up ? '#f03e3e' : '#2f9e44';
            const x = xOf(i);
            const yO = yOf(c.o), yC = yOf(c.c);
            const bodyTop = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yO - yC));
            return (
              <g key={c.t}>
                <line x1={x} y1={yOf(c.h)} x2={x} y2={yOf(c.l)} stroke={col} strokeWidth={1} />
                <rect x={x - cw / 2} y={bodyTop} width={cw} height={bodyH} fill={col} />
              </g>
            );
          })}
          {/* 均線（週/月/季）——蠟燭之上、十字線之下 */}
          {MA_DEFS.map((d, di) => {
            const pts: string[] = [];
            for (let i = 0; i < view.length; i++) {
              const v = maFull[di][start + i];
              if (v == null) continue;
              pts.push(`${pts.length === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`);
            }
            if (pts.length < 2) return null;
            return <path key={d.p} d={pts.join(' ')} fill="none" stroke={d.color} strokeWidth={1.4} opacity={0.9} />;
          })}
          {/* ── 最新價基準線（券商標配）──────────────────────────────
              沒有這條線時，要判斷「現在離某根 K 棒多遠」只能目測，
              使用者回報「無法準確查看」有一半是這個原因。 */}
          {view.length > 0 && (
            <line x1={padL} y1={yOf(view[view.length - 1].c)} x2={W - padR} y2={yOf(view[view.length - 1].c)}
              stroke="#f59e0b" strokeWidth={1} strokeDasharray="4 4" opacity={0.85} />
          )}
          {/* 游標十字線：縱線標時間、**橫線標價格**（原本只有縱線，讀不出價位） */}
          {hv && (
            <>
              <line x1={xOf(hoverIdx!)} y1={padT} x2={xOf(hoverIdx!)} y2={H - padB} stroke="rgba(255,255,255,0.45)" strokeWidth={1} strokeDasharray="3 3" />
              <line x1={padL} y1={yOf(hv.c)} x2={W - padR} y2={yOf(hv.c)} stroke="rgba(255,255,255,0.45)" strokeWidth={1} strokeDasharray="3 3" />
            </>
          )}
        </svg>
        {/* ── 座標軸標籤：**必須畫在 HTML 層，不能放進上面那個 SVG**（2026-08-11）──
            那個 SVG 是 viewBox 1000 寬 ＋ preserveAspectRatio="none"，
            在手機上實際只有 301px → **x 縮放 0.301、y 縮放 1**。
            文字被水平壓成 30%：「2049」四個字只有 7.5px 寬、12.2px 高，
            變成幾條細長黑影，使用者回報「xy 軸的資訊完全看不到」就是這個。
            非等比縮放對線條無所謂（線本來就要跟著拉伸），但對文字是毀滅性的。
            ⇒ 軸標籤改用絕對定位的 HTML，字級不受 SVG 變形影響。 */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const v = yMin + (yMax - yMin) * (i / yTicks);
          return (
            <span key={`yl${i}`} style={{
              position: 'absolute', left: 0, top: yOf(v), transform: 'translateY(-50%)',
              width: padL - 6, textAlign: 'right', pointerEvents: 'none',
              fontSize: 'calc(10px * var(--fz))', color: '#9fb0c9', fontFamily: "'JetBrains Mono', monospace",
            }}>{v.toFixed(v < 50 ? 1 : 0)}</span>
          );
        })}
        {/* 最新價 / 游標價 的價格標籤——同樣畫在 HTML 層，
            放進 SVG 會被 preserveAspectRatio="none" 壓扁（見上方註解）。 */}
        {view.length > 0 && (
          <span style={{
            position: 'absolute', right: 2, top: yOf(view[view.length - 1].c), transform: 'translateY(-50%)',
            padding: '0 4px', borderRadius: 3, background: '#f59e0b', color: '#1a1200',
            fontSize: 'calc(9.5px * var(--fz))', fontWeight: 900, lineHeight: '14px',
            fontFamily: "'JetBrains Mono', monospace", pointerEvents: 'none',
          }}>{view[view.length - 1].c.toFixed(2)}</span>
        )}
        {hv && (
          <span style={{
            position: 'absolute', left: 0, top: yOf(hv.c), transform: 'translateY(-50%)',
            width: padL - 6, textAlign: 'right', padding: '0 3px', borderRadius: 3,
            background: 'rgba(255,255,255,0.9)', color: '#0b1220',
            fontSize: 'calc(9.5px * var(--fz))', fontWeight: 900, lineHeight: '14px',
            fontFamily: "'JetBrains Mono', monospace", pointerEvents: 'none',
          }}>{hv.c.toFixed(2)}</span>
        )}
        {/* X 軸日期獨立成一條帶狀區並 overflow:hidden——
            最左/最右的標籤置中後會探出容器 2px，把整頁推寬；裁掉即可，視覺上看不出來。 */}
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 15, overflow: 'hidden', pointerEvents: 'none' }}>
          {view.map((c, i) => (i % step === 0 ? (
            <span key={`xl${c.t}`} style={{
              position: 'absolute', left: `${(xOf(i) / W) * 100}%`, bottom: 0, transform: 'translateX(-50%)',
              whiteSpace: 'nowrap',
              fontSize: 'calc(10px * var(--fz))', color: '#9fb0c9', fontFamily: "'JetBrains Mono', monospace",
            }}>{format(new Date(c.t * 1000), fmt)}</span>
          ) : null))}
        </div>
        {/* 游標數值框：日期/開高低收/量(張) */}
        {hv && (
          <div style={{ position: 'absolute', top: 4, left: hoverIdx! < view.length / 2 ? 'auto' : 8, right: hoverIdx! < view.length / 2 ? 8 : 'auto',
            background: 'rgba(15,23,42,0.92)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '5px 8px', fontSize: 'calc(11px * var(--fz))', color: '#e2e8f0', pointerEvents: 'none', lineHeight: 1.6, whiteSpace: 'nowrap' }}>
            <div style={{ color: '#94a3b8' }}>{format(new Date(hv.t * 1000), hvFmt)}</div>
            <div>開 {hv.o}　高 <span style={{ color: '#f87171' }}>{hv.h}</span>　低 <span style={{ color: '#4ade80' }}>{hv.l}</span></div>
            <div>收 <b style={{ color: hv.c >= hv.o ? '#f87171' : '#4ade80' }}>{hv.c}</b>　量 {(hv.v / 1000).toLocaleString(undefined, { maximumFractionDigits: 0 })} 張</div>
          </div>
        )}
      </div>
      {/* 縮放控制 */}
      {/* ⚠ 這一列必須 wrap（2026-08-11 手機回報）：
          原本 flex 不換行，手機上三顆鈕加一段長說明擠在一起，
          鈕被壓到只剩一個字寬 →「縮小」變成 縮/小 直排（實機截圖可見）。
          用詞同時縮短：「－ 縮小 / ＋ 放大 / 回到最新 ›」→「－ / ＋ / 最新」，
          說明從「顯示 30 根日K（共 1214）· 滾輪縮放 · 拖曳平移」
          縮成「30/1214 根」——滾輪提示在手機上本來就沒有意義，只在桌機顯示。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, rowGap: 4, flexWrap: 'wrap', marginTop: 5, fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>
        <button className={styles.periodTab} style={{ flexShrink: 0, whiteSpace: 'nowrap', padding: '3px 10px' }} title="縮小（顯示更多根）"
          onClick={() => setSize(s => Math.round(Math.min(n, s * 1.4)))}>－</button>
        <button className={styles.periodTab} style={{ flexShrink: 0, whiteSpace: 'nowrap', padding: '3px 10px' }} title="放大（顯示更少根）"
          onClick={() => setSize(s => Math.round(Math.max(8, s * 0.7)))}>＋</button>
        <span style={{ whiteSpace: 'nowrap' }}>{view.length}/{n} 根{MODE_LABEL[mode]}K</span>
        <span className="desktop-only" style={{ whiteSpace: 'nowrap' }}>· 滾輪縮放 · 拖曳平移</span>
        {clampOffset > 0 && (
          <button className={styles.periodTab} style={{ marginLeft: 'auto', flexShrink: 0, whiteSpace: 'nowrap', padding: '3px 10px' }}
            onClick={() => setOffset(0)}>最新 ›</button>
        )}
      </div>
    </div>
  );
}

// 🎯 勝率雷達：判斷個股處於「三大法人買賣超作用機制」的哪個階段 + 回測勝率。
// 4 階段（用 rating 三大法人 + chip-signals 連買/標籤 + 當日漲幅判定）：
//   ① 外資布局（連買，投信未跟）~46-50%  ② 投信跟進/三方同買（S/A）49-50%（2年實測）
//   ③ 散戶追價·過熱（漲多但投信沒跟）慎追  ④ 外資賣超·危險 39%（迴避）
// 勝率為 scripts/backtest-chip-weight.mjs 隔日沖 83 日回測值，歷史值非保證。
type Phase = { n: number; icon: string; label: string; win: number | null; grade?: string; color: string; bg: string; action: string };
// 「外資大買」改用相對比例：外資買超佔當日成交量 ≥10%（上市/上櫃一致，自動依股本大小縮放；
// 無量資料才退回絕對 5000 張）。門檻 10% ≈ 典型上市大型股 5000 張，回測基準得以延續。
function classifyPhase(f: number, t: number, d: number, streak: number, chgPct: number, retail: boolean, vol: number): Phase {
  // 外資大買 = 佔成交量≥10% 且 有意義下限≥500張(濾掉小型股比例被放大的雜訊，如統領累計僅70張)
  const heavy = f >= 500 && (vol > 0 ? (f / vol >= 0.10) : (f >= 5000));
  const weak = f < 500 || (vol > 0 ? (f / vol < 0.02) : (f < 1000)); // 外資買力弱
  if (f < 0) {
    if (t > 0 && (f + t + d) > 0) return { n: 1, icon: '🏛️', label: '投信主導·外資調節', win: 50, grade: 'B', color: '#3d8ef8', bg: 'rgba(61,142,248,0.14)', action: '外資小幅調節但投信買超撐盤、法人合計仍買超；觀察外資是否回補' };
    return retail
      ? { n: 4, icon: '⚠️', label: '外資賣·散戶接棒', win: 39, color: '#e8590c', bg: 'rgba(232,89,12,0.15)', action: '外資退場、融資接棒——危險，勿追，持有宜減碼' }
      : { n: 4, icon: '⚠️', label: '外資賣超·轉弱', win: 39, color: '#e8590c', bg: 'rgba(232,89,12,0.15)', action: '外資轉賣、法人合計偏賣，隔日沖勝率僅39%，避免追價' };
  }
  if (heavy && t > 0) return { n: 2, icon: '🚀', label: '投信跟進·強勢加速', win: 59, grade: 'S', color: '#f03e3e', bg: 'rgba(240,62,62,0.15)', action: '外資大買（佔量高）＋投信跟進，籌碼共識最強（回測勝率最高）' };
  if (f > 0 && t > 0 && d > 0) return { n: 2, icon: '🔴', label: '三方同買·強勢', win: 55, grade: 'A', color: '#f03e3e', bg: 'rgba(240,62,62,0.13)', action: '外資＋投信＋自營齊買，強勢多頭' };
  if (heavy) return { n: 2, icon: '🔴', label: '外資大買·主導', win: 52, grade: 'B+', color: '#e8590c', bg: 'rgba(232,89,12,0.13)', action: '外資買超佔成交量≥10%主導，投信尚未跟；隔日易有支撐但留意投信是否轉買' };
  // 散戶追價·過熱：漲多但法人買力弱、且外資「沒在連買」(streak<2)才算——連買中屬布局非過熱
  if (chgPct >= 7 && weak && t <= 0 && streak < 2) return { n: 3, icon: '🔥', label: '散戶追價·過熱', win: 47, color: '#f59f00', bg: 'rgba(245,159,0,0.14)', action: '漲多但法人買力弱（外資佔量<2%、投信沒買、非連買），追價力道偏散戶，慎防拉高出貨' };
  if (streak >= 3 || f > 0) return { n: 1, icon: '📈', label: '外資布局中', win: 50, grade: 'B', color: '#3d8ef8', bg: 'rgba(61,142,248,0.14)', action: '外資進場（未達大買）、投信尚未跟，可留意但未確立' };
  return { n: 0, icon: '😐', label: '籌碼中性', win: null, color: '#94a3b8', bg: 'rgba(148,163,184,0.12)', action: '無明顯法人共識，觀望' };
}

function InstStrip({ code, changePercent = 0, volume = 0 }: { code: string; changePercent?: number; volume?: number }) {
  const [d, setD] = useState<{ f: number; t: number; dl: number; streak: number; vol: number; fCum: number; tCum: number; dCum: number } | null>(null);
  const [retail, setRetail] = useState(false);
  useEffect(() => {
    let live = true;
    // 主來源：chipDaily（全個股皆有、可靠）；散戶接棒細分用 chip-signals 標籤（有才加）
    fetch(`/api/ai/inst-daily?code=${code}`).then(r => (r.ok ? r.json() : null)).then(j => {
      if (!live || !j?.found) return;
      setD({ f: j.foreign || 0, t: j.trust || 0, dl: j.dealer || 0, streak: j.streak || 0, vol: j.vol || 0, fCum: j.foreignCum || 0, tCum: j.trustCum || 0, dCum: j.dealerCum || 0 });
    }).catch(() => {});
    fetch(`/api/ai/chip-signals?code=${code}`).then(r => (r.ok ? r.json() : null)).then(j => { if (live) setRetail(!!(j?.signal?.tags || []).includes('retailBagholder')); }).catch(() => {});
    return () => { live = false; };
  }, [code]);
  if (!d) return null;
  // 外資連買≥2日：改用累計籌碼判斷（單日易被雜訊誤導）；成交量以 單日量×連買天數 估累計。
  const useCum = d.streak >= 2;
  const ef = useCum ? d.fCum : d.f, et = useCum ? d.tCum : d.t, ed = useCum ? d.dCum : d.dl;
  // 分母優先用個股頁即時成交量(股→張，較 chipArchive 準)；退回 inst-daily vol。連買則×天數估累計量。
  const volLots = volume > 0 ? Math.round(volume / 1000) : d.vol;
  const p = classifyPhase(ef, et, ed, d.streak, changePercent, retail, volLots);
  const tip = `🎯 勝率雷達 — 三大法人籌碼階段（2年×41萬樣本實測隔日勝率·2026-07-19 稽核修正，非保證）\n① 外資布局(連買·投信未跟) 46-47%\n② 投信跟進(A) 50%／三方同買(S) 49%／B+ 47%\n③ 大漲未鎖 42%（二次修正：舊53%為漲停幻覺——81%樣本是買不到的鎖死日；可交易部分實測34-43%屬弱勢群）\n④ 外資賣超·危險 44% 迴避\n\n目前：${p.label}\n${p.action}`;
  return (
    <div style={{ flex: '1 1 100%', display: 'flex', justifyContent: 'center', gap: 8, rowGap: 3, alignItems: 'center', flexWrap: 'wrap', fontSize: 'calc(12px * var(--fz))', color: 'var(--text-secondary)', minWidth: 0, padding: '0 4px' }} title={tip}>
      {/* ⚠ 徽章本體不可 nowrap（2026-08-11 手機實測溢出 46px）：
          「🚀 投信跟進·強勢加速 · S級 勝率59%」整串 219px，加上 nowrap 就縮不下去，
          在 375px 手機上把整個 <main> 推出去 46px。
          改為允許整體換行、上限 100%；只有「勝率59%」這種**不該被拆開的數值**保留 nowrap。 */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', maxWidth: '100%', fontWeight: 800, padding: '2px 10px', borderRadius: 20, color: p.color, background: p.bg, border: `1px solid ${p.color}55`, lineHeight: 1.5 }}>
        {p.icon} {p.label}
        {p.win != null && <span style={{ fontSize: 'calc(11px * var(--fz))', fontWeight: 700, whiteSpace: 'nowrap' }}>· {p.grade ? `${p.grade}級 ` : ''}勝率{p.win}%</span>}
      </span>
      {/* ⚠ 三大法人數值已移至「籌碼判讀」卡（2026-08-11 使用者指示「可以放到籌碼判讀裡，省下空間」）：
          同一組數字原本在個股頁出現兩次，圖表這裡又要多佔一整行。
          此處只留**階段判讀徽章**（那是圖表的解讀，留著才有意義）。 */}
    </div>
  );
}

export default function StockTrendChart({ code, name, closePrice, livePrice, changePercent, volume }: StockTrendChartProps) {
  const navigateTo = useAppStore(s => s.navigateTo);
  const [mode, setMode] = useState<Mode>('rt'); // 預設即時
  const [candles, setCandles] = useState<CandleData[]>([]);        // 即時分時
  const [kline, setKline] = useState<Candle[]>([]);                // 日/週/月蠟燭
  const [kView, setKView] = useState<{ highest: number; lowest: number; pct: number } | null>(null); // 蠟燭可視區間統計
  const [intradayPrevClose, setIntradayPrevClose] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRealtime = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/twse/stock-intraday?code=${code}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('intraday failed');
      const json = await res.json();
      setIntradayPrevClose(json.prevClose);
      // 分時只留正規時段 09:00–13:30（台北）——收盤後快照/零股時段點會把 X 軸拖到 15:xx
      const inSession = (tSec: number) => {
        const d = new Date(new Date(tSec * 1000).toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const v = d.getHours() * 60 + d.getMinutes();
        return v >= 9 * 60 && v <= 13 * 60 + 30;
      };
      setCandles((json.ticks || []).filter((t: { time: number }) => inSession(t.time)).map((t: { time: number; close: number; volume: number }) => ({ time: t.time, open: t.close, high: t.close, low: t.close, close: t.close, volume: t.volume })));
    } catch {
      // 盤中：Yahoo 無此檔分時(創新板/冷門股)且 daemon 序列尚未建立——已透過 mis-quote
      // 登記追蹤，每 5 秒輪詢會自動接上，顯示建立中而非死錯誤。
      setError(isTradingHours() ? '即時序列建立中…（首次開啟約需 1 分鐘）' : '無法載入即時走勢');
    } finally { setLoading(false); }
  }, [code]);

  // 即時模式盤中：把本檔登記為「瀏覽中」(mis-quote 會 recordLiveRequests)——
  // daemon 據此納入 MIS 即時掃描並累積分時序列。Yahoo 對創新板/冷門股常無分時，
  // 未登記前 stock-intraday 會 404（例：漲停預測展開 6969 顯示無法載入）。
  useEffect(() => {
    if (!isTradingHours()) return;
    const ping = () => { fetch(`/api/twse/mis-quote?codes=${code}`, { cache: 'no-store' }).catch(() => { /* 登記失敗下次再試 */ }); };
    ping();
    const t = setInterval(ping, 60000);
    return () => clearInterval(t);
  }, [code]);

  const loadKline = useCallback(async (m: Exclude<Mode, 'rt'>) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/twse/candles?code=${code}&interval=${INTERVAL[m]}`);
      if (!res.ok) throw new Error('candles failed');
      const json = await res.json();
      setKline(json.candles || []);
      if (!json.candles?.length) setError('無 K 線數據');
    } catch { setError('無法載入 K 線'); } finally { setLoading(false); }
  }, [code]);

  useEffect(() => {
    setKView(null); // 換模式先清可視統計，待蠟燭圖回報
    if (mode === 'rt') {
      loadRealtime();
      let poll: ReturnType<typeof setInterval> | null = null;
      if (isTradingHours()) poll = setInterval(loadRealtime, 5000);
      return () => { if (poll) clearInterval(poll); };
    }
    loadKline(mode);
  }, [mode, loadRealtime, loadKline]);

  // 官方平盤：由當下價與官方漲跌%反推(closePrice/(1+chg%))。除權息日 Yahoo 的
  // chartPreviousClose 用「未調整昨收」與官方除權息參考價不符(台數科實案：Yahoo 76.4
  // → 顯示-1.66%，官方參考價 74.10 → +4.05%)。有 props 時以此為準，與榜單口徑一致。
  const authPrevClose = useMemo(() => {
    if (mode === 'rt' && closePrice && closePrice > 0 && changePercent != null && Number.isFinite(changePercent)) {
      const p = closePrice / (1 + changePercent / 100);
      if (p > 0) return +p.toFixed(2);
    }
    return null;
  }, [mode, closePrice, changePercent]);
  const refPrev = authPrevClose ?? intradayPrevClose;

  // 即時：append MIS 即時價為最新點（Yahoo 分時延遲）
  const displayCandles = useMemo(() => {
    if (mode === 'rt' && livePrice && livePrice > 0 && isTradingHours()) {   // 收盤後不附加（避免 15:xx 假點）
      const last = candles[candles.length - 1];
      if (!last || Math.abs(last.close - livePrice) > 1e-9) {
        const now = Math.floor(Date.now() / 1000);
        return [...candles, { time: now, open: livePrice, high: livePrice, low: livePrice, close: livePrice, volume: 0 }];
      }
    }
    return candles;
  }, [candles, mode, livePrice]);

  const chartData = useMemo(() => displayCandles.map(c => ({
    date: format(new Date(c.time * 1000), 'HH:mm'), close: c.close, volume: c.volume,
  })), [displayCandles]);

  const stats = useMemo(() => {
    if (mode === 'rt') {
      if (displayCandles.length === 0) return null;
      const closes = displayCandles.map(c => c.close);
      const startP = refPrev ?? closes[0]; const endP = closes[closes.length - 1];
      return { highest: Math.max(...closes), lowest: Math.min(...closes), pct: startP > 0 ? (endP - startP) / startP * 100 : 0 };
    }
    if (kline.length === 0) return null;
    // 蠟燭圖用可視區間統計(隨縮放/平移更新)；尚未回報時退回全期
    if (kView) return kView;
    const startP = kline[0].c, endP = kline[kline.length - 1].c;
    return { highest: Math.max(...kline.map(c => c.h)), lowest: Math.min(...kline.map(c => c.l)), pct: startP > 0 ? (endP - startP) / startP * 100 : 0 };
  }, [mode, displayCandles, kline, refPrev, kView]);

  const isUp = (stats?.pct ?? 0) >= 0;
  const chartColor = isUp ? 'var(--color-up)' : 'var(--color-down)';

  const yDomain = useMemo(() => {
    if (chartData.length === 0) return ['auto', 'auto'] as [number | string, number | string];
    if (refPrev && refPrev > 0) return [+(refPrev * 0.85).toFixed(2), +(refPrev * 1.15).toFixed(2)];
    const closes = chartData.map(d => d.close); const mn = Math.min(...closes), mx = Math.max(...closes);
    const p = (mx - mn) * 0.05 || 1; return [Math.floor(mn - p), Math.ceil(mx + p)];
  }, [chartData, refPrev]);

  return (
    <div className={styles.trendChartContainer} onClick={e => e.stopPropagation()}>
      <div className={styles.chartHeader}>
        <div className={styles.chartTitleArea}>
          <span className={styles.chartTitleText}>{name} ({code}) {mode === 'rt' ? '即時走勢' : `${MODE_LABEL[mode]}K線`}</span>
          {stats && (
            <span className={styles.chartPeriodChange} style={{ color: isUp ? 'var(--color-up)' : 'var(--color-down)' }}>
              {mode === 'rt' ? '今日漲跌' : '此區間'}：{isUp ? '▲' : '▼'}{Math.abs(stats.pct).toFixed(2)}%
            </span>
          )}
        </div>
        <InstStrip code={code} changePercent={changePercent} volume={volume} />
        <div className={styles.periodTabs}>
          {(['rt', 'day', 'week', 'month'] as Mode[]).map(m => (
            <button key={m} className={`${styles.periodTab} ${mode === m ? styles.periodTabActive : ''}`} onClick={() => setMode(m)}>
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.chartBody}>
        <div className={styles.chartMain}>
          {loading && ((mode === 'rt' && candles.length === 0) || (mode !== 'rt' && kline.length === 0)) ? (
            <div className={styles.chartLoading}><div className={styles.chartSpinner} /><span>載入{MODE_LABEL[mode]}數據中...</span></div>
          ) : error ? (
            <div className={styles.chartError}>{error}</div>
          ) : mode === 'rt' ? (
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                <defs>
                  <linearGradient id={`gradient-${code}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chartColor} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={chartColor} stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: '#7e8ba3', fontSize: 10 }} axisLine={false} tickLine={false} />
                <YAxis domain={yDomain as [number, number]} tick={{ fill: '#7e8ba3', fontSize: 10 }} axisLine={false} tickLine={false} orientation="left" tickFormatter={v => v.toFixed(0)} />
                {/* 量軸（隱藏）：domain 放大 4 倍→量棒只佔圖表下方約 1/4，不干擾價格線 */}
                <YAxis yAxisId="vol" hide domain={[0, (dMax: number) => (dMax || 1) * 4]} />
                <Tooltip contentStyle={{ background: 'rgba(15,23,42,0.9)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 'calc(11px * var(--fz))', color: '#e2e8f0' }}
                  labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 4 }}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(value: any, nm: any) => (nm === 'close' ? [parseFloat(String(value)).toFixed(2), '成交價'] : nm === 'volume' ? [`${Math.round(parseFloat(String(value)) / 1000).toLocaleString()} 張`, '成交量'] : [value, nm])} />
                {refPrev !== null && refPrev > 0 && (
                  <ReferenceLine y={refPrev} stroke="#fbbf24" strokeDasharray="5 4" strokeWidth={1.5} ifOverflow="extendDomain"
                    label={{ value: `平盤 ${refPrev.toFixed(2)}`, position: 'insideTopRight', fill: '#fbbf24', fontSize: 'calc(10px * var(--fz))', fontWeight: 700 }} />
                )}
                <Bar yAxisId="vol" dataKey="volume" name="volume" fill={chartColor} opacity={0.28} isAnimationActive={false} />
                <Area type="monotone" dataKey="close" name="close" stroke={chartColor} strokeWidth={2} fill={`url(#gradient-${code})`} dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: chartColor }} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <CandleChart candles={kline} mode={mode} code={code} onView={setKView} />
          )}
        </div>

        {stats && (
          <div className={styles.chartStatsPanel}>
            <div className={styles.statGrid}>
              <div className={styles.statBox}><span className={styles.statBoxLabel}>區間最高</span><span className={styles.statBoxValue} style={{ color: 'var(--color-up)' }}>{stats.highest.toFixed(2)}</span></div>
              <div className={styles.statBox}><span className={styles.statBoxLabel}>區間最低</span><span className={styles.statBoxValue} style={{ color: 'var(--color-down)' }}>{stats.lowest.toFixed(2)}</span></div>
            </div>
            <button className={styles.detailBtn} onClick={(e) => { e.stopPropagation(); navigateTo('stock', code); }}>📊 詳細分析</button>
          </div>
        )}
      </div>
    </div>
  );
}
