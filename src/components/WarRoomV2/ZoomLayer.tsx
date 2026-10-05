'use client';

// D2 放大檢視層：依 ui.zoomTarget 掛「原有的完整元件」（功能一個不刪），打開時才載入（dynamic import）、關閉即卸載
// ——元件自己的輪詢隨卸載停止。Esc 由 WarRoomProvider 統一處理（先關放大層、再關抽屜）；瀏覽器／手機返回鍵也能關
// （開啟時推一筆 history，返回即關閉；用按鈕或 Esc 關閉時把那一筆退掉）。開啟時焦點移到關閉鈕、Tab 鎖在視窗內，關閉後焦點回原處。
//
// 對照（使用者定案）：雷達完整版＝舊版 WarRoom 的雷達分頁（雷達寫在 WarRoom 內、無法單獨抽出 ⇒ 掛整個 WarRoom 並預選 radar，
//   關閉時還原舊版的分頁選擇）；漲跌分布＝RiseFallPanel；當沖工作台＝RiseFallPanel 的工作台檢視（DayTradeDesk 需要它供應全市場快照）；
//   轉空＝RiseFallPanel 的即時轉空檢視（FadeWatch，同理）；盤中漲停預測＝LimitUpPanel source="live"；族群＝MarketWind 完整版（含官方 33 類參考）；
//   撿尾盤＝MarketPatternBanner（即時追蹤頁的同一份）；我的部位全部＝持倉頁 Portfolio；異動流全部、漲停順序流全量、資料健康＝本區自建。
import dynamic from 'next/dynamic';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useAppStore } from '@/lib/store';
import { useWarUi, type ZoomTarget } from './WarRoomContext';
import ZoomFeed from './ZoomFeed';
import ZoomLimitFlow from './ZoomLimitFlow';
import ZoomHealth from './ZoomHealth';
import styles from './WarRoomV2.module.css';
import zs from './ZoomLayer.module.css';

function Loading() {
  return <div className={zs.loading}>載入中…</div>;
}

const WarRoom = dynamic(() => import('@/components/WarRoom/WarRoom'), { ssr: false, loading: Loading });
const RiseFallPanel = dynamic(() => import('@/components/WarRoom/RiseFallPanel'), { ssr: false, loading: Loading });
const LimitUpPanel = dynamic(() => import('@/components/WarRoom/LimitUpPanel'), { ssr: false, loading: Loading });
const MarketWind = dynamic(() => import('@/components/MarketWind/MarketWind'), { ssr: false, loading: Loading });
const Portfolio = dynamic(() => import('@/components/Portfolio/Portfolio'), { ssr: false, loading: Loading });
const MarketPatternBanner = dynamic(
  () => import('@/components/MarketPattern/MarketPatternBanner').then((m) => m.MarketPatternBanner),
  { ssr: false, loading: Loading },
);

const TITLES: Readonly<Record<ZoomTarget, string>> = {
  mine: '我的部位（持倉完整頁）',
  radar: '盤中機會榜（雷達完整版）',
  short: '轉空觀察（即時轉空完整版）',
  risefall: '漲跌分布（全市場）',
  daytrade: '當沖工作台',
  limitFlow: '漲停動態（順序流全量＋盤中漲停預測）',
  sectors: '族群資金（題材風向全文＋官方 33 類）',
  feed: '即時異動流（全部紀錄）',
  tailPicks: '撿尾盤（盤型與候選完整版）',
  health: '資料健康（每個來源的資料時間）',
};

/** 雷達完整版：掛舊版 WarRoom 並預選雷達分頁；卸載時還原原本的分頁（warTab 只有舊版用，不持久化） */
function RadarZoom() {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const st = useAppStore.getState();
    const prev = st.warTab;
    st.setWarTab('radar');
    setReady(true);
    return () => { useAppStore.getState().setWarTab(prev); };
  }, []);
  return ready ? <WarRoom /> : <Loading />;
}

function ZoomBody({ target }: { target: ZoomTarget }) {
  switch (target) {
    case 'radar': return <RadarZoom />;
    case 'short': return <RiseFallPanel initialView="fade" />;
    case 'risefall': return <RiseFallPanel initialView="board" />;
    case 'daytrade': return <RiseFallPanel initialView="dual" />;
    case 'limitFlow': return <><ZoomLimitFlow /><LimitUpPanel source="live" /></>;
    case 'sectors': return <MarketWind />;
    case 'feed': return <ZoomFeed />;
    case 'tailPicks': return <MarketPatternBanner />;
    case 'mine': return <Portfolio />;
    case 'health': return <ZoomHealth />;
    default: return null;
  }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 返回鍵關閉：開啟時推一筆 history（Next.js 會把自己的路由狀態複製進去），popstate＝關閉；按鈕／Esc 關閉時退掉那一筆 */
function useBackToClose(open: boolean, close: () => void) {
  const pushed = useRef(false);
  const ignoreUntil = useRef(0);
  useEffect(() => {
    if (!open) {
      if (pushed.current) {
        pushed.current = false;
        ignoreUntil.current = Date.now() + 1_000;   // 自己退的那一次 popstate 不算使用者按返回
        try { window.history.back(); } catch { /* 沙箱或嵌入環境可能擋，忽略 */ }
      }
      return;
    }
    if (!pushed.current) {
      try {
        window.history.pushState({ wrZoom: 1 }, '');
        pushed.current = true;
      } catch { /* 擋掉就只靠 Esc／按鈕關閉 */ }
    }
    const onPop = () => {
      if (Date.now() < ignoreUntil.current) return;
      pushed.current = false;
      close();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open, close]);
}

function ZoomDialog({ target, onClose }: { target: ZoomTarget; onClose: () => void }) {
  const titleId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 開啟：記住原焦點、移到關閉鈕；關閉：焦點回原處（元素還在的話）
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { if (opener && opener.isConnected) opener.focus(); };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !boxRef.current) return;
    const nodes = Array.from(boxRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <div
      className={styles.overlay}
      role="dialog" aria-modal="true" aria-labelledby={titleId}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={boxRef} className={`${styles.overlayBox} ${zs.box}`} onKeyDown={onKeyDown}>
        <button ref={closeRef} type="button" className={styles.closeBtn} onClick={onClose} aria-label="關閉放大檢視（Esc）">✕ Esc</button>
        <div className={zs.head}>
          <h2 id={titleId} className={zs.title}>{TITLES[target]}</h2>
          <span className={zs.hint}>打開時才載入、關閉即停止更新·Esc 或返回鍵關閉</span>
        </div>
        <div className={zs.body}>
          <ZoomBody target={target} />
        </div>
        <p className={zs.foot}>觀察工具·非投資建議</p>
      </div>
    </div>
  );
}

export default function ZoomLayer() {
  const { zoomTarget, closeZoom } = useWarUi();
  useBackToClose(zoomTarget != null, closeZoom);
  if (!zoomTarget) return null;
  // key＝目標：切換到別的面板時整個重掛（前一個元件的輪詢隨卸載停止）
  return <ZoomDialog key={zoomTarget} target={zoomTarget} onClose={closeZoom} />;
}
