'use client';

import { useEffect } from 'react';
import dynamic from 'next/dynamic';
import { useAppStore } from '@/lib/store';
import { useFirebaseSync } from '@/lib/firebase-sync';
import { setHolidays } from '@/lib/market-clock';
import Navbar from '@/components/Navbar/Navbar';
import Header from '@/components/Header/Header';
import Dashboard from '@/components/Dashboard/Dashboard';
import AlertEngine from '@/components/AlertEngine/AlertEngine';
import AuthModal from '@/components/Auth/AuthModal';
import CandidateDock from '@/components/Candidates/CandidateDock';
import { PrivacyPage, ConsentBanner } from '@/components/Help/PrivacyNotice';
import LimitQueueAlert from '@/components/shared/LimitQueueAlert';
import { useWarV2Allowed, useWarV2Layout } from '@/components/WarRoomV2/parts/useWarAccess';
import styles from './page.module.css';

// ── Code splitting ────────────────────────────────────────────
// 這些元件原本是靜態 import + `{currentPage === 'x' && <X />}` 條件渲染。
// **條件渲染不做 code splitting** —— 元件只是不掛載，程式碼照樣下載並解析。
// 首屏原本約 1.28MB 原始碼（92 個模組）打成單一 chunk。
//
// 上面留在靜態 import 的是：入口必經（Navbar / Header / Dashboard 預設頁）
// 或全域常駐（AlertEngine / AuthModal / CandidateDock / ConsentBanner）。
// 其餘全部按頁切開，切換時才下載。
const StockDetail       = dynamic(() => import('@/components/StockDetail/StockDetail'));
const StockPicker       = dynamic(() => import('@/components/StockPicker/StockPicker'));
const Portfolio         = dynamic(() => import('@/components/Portfolio/Portfolio'));
const Backtest          = dynamic(() => import('@/components/Backtest/Backtest'));
const WatchlistTracker  = dynamic(() => import('@/components/WatchlistTracker/WatchlistTracker'));
const WarRoom           = dynamic(() => import('@/components/WarRoom/WarRoom'));
// 盤中戰情 v2（2026-10-05 使用者定案）與盤前備課：只在瀏覽器渲染——它們讀 localStorage／matchMedia，且只會在
// 掛載後的頁面切換時出現（currentPage 不持久化、首屏一定是 dashboard），不需要 SSR。
const WarRoomV2         = dynamic(() => import('@/components/WarRoomV2/WarRoomV2'), { ssr: false });
const PrepRoom          = dynamic(() => import('@/components/PrepRoom/PrepRoom'), { ssr: false });
// AdminPanel 只有管理員用得到，卻是所有使用者都在下載的 31KB。
const AdminPanel        = dynamic(() => import('@/components/Admin/AdminPanel'));
// 模擬中橫幅：必須在所有頁面之上且永遠可見（忘了自己在模擬比功能壞掉更危險）
const ViewAsBanner      = dynamic(() => import('@/components/Admin/ViewAsBanner'), { ssr: false });
// HelpManual 連帶 help-content.ts（34KB 純靜態說明文字）
const HelpManual        = dynamic(() => import('@/components/Help/HelpManual'));

export default function App() {
  const currentPage = useAppStore((s) => s.currentPage);
  // 盤中戰情 v2＋專注模式（使用者裁定第 6、14 題）——只限超管（2026-10-05 使用者：「v2版只有超管可以用，暫不開放其它人使用」）：
  //   超管：warLayout 非 'classic' 一律視為 v2（persist 的舊／壞值兜底）；
  //     專注模式＝v2 戰情頁且 warFocus：Header、側欄指數卡、AI 跑馬燈、LimitQueueAlert、CandidateDock **卸載**
  //     （CSS 隱藏不會停輪詢，卸載才省流量——critique C1），側欄收成 64px 圖示欄。AlertEngine 照舊全域掛載。
  //   非超管（含未登入、一般、高級會員、admin，以及身分模擬中的超管）：戰情頁永遠是舊版 WarRoom，
  //     完全不看 warLayout／warFocus（專注模式不生效、上述元件照常掛載），也不顯示新舊版切換列。
  const v2Allowed = useWarV2Allowed();
  const v2Layout = useWarV2Layout();
  const warFocus = useAppStore((s) => s.warFocus);
  const setWarLayout = useAppStore((s) => s.setWarLayout);
  const isWarV2 = currentPage === 'war' && v2Layout;
  const focusMode = isWarV2 && warFocus;

  // Run the Firebase Auth and Data synchronization hook
  useFirebaseSync();

  // 休市日曆：market-clock 的 holidays 表預設是空的（fail-open 只擋週末），
  // 不在這裡填上的話，國定假日與颱風假都會被當成交易日照常輪詢。
  // 一天只變一次，CDN daily tier 擋掉幾乎所有回源。
  // persist 改為 skipHydration（見 lib/store.ts 註解）→ 必須在掛載後手動補回，
  // 否則本機狀態(自選/模式/指標)永遠不會載入。放在最前面的 effect，越早越好。
  useEffect(() => { void useAppStore.persist.rehydrate(); }, []);

  // ── 返回時還原捲動位置（2026-08-11 使用者要求）────────────────────
  // navigateBack 會把來源頁離開時的 scrollY 放進 pendingScrollY，這裡負責套用。
  // ⚠ 為什麼不在 store 裡直接 window.scrollTo：
  //   那個時間點新頁面還沒渲染，文件高度可能只有幾百 px，
  //   scrollTo(3000) 會被截成可捲的最大值，等內容長出來就停在錯的地方。
  // ⇒ 等到「文件高度已經夠」再捲；用 rAF 輪詢最多 ~1 秒，避免資料慢到而放棄。
  //   （清單頁的資料是非同步載入的，高度不是一次到位。）
  const pendingScrollY = useAppStore(s => s.pendingScrollY);
  const pendingAnchor = useAppStore(s => s.pendingAnchor);
  const clearPendingScroll = useAppStore(s => s.clearPendingScroll);
  useEffect(() => {
    if (pendingScrollY == null) return;
    let raf = 0; const t0 = Date.now();
    // 錨點優先（2026-09-17）：從清單點進個股再返回，捲到「那一列」比捲到「那個高度」可靠——
    // 清單資料是非同步的、子分頁也可能重掛載，同一個 scrollY 未必還對到同一列。
    // 錨點元素最多等 4 秒（榜單 API 回來要 1～2 秒）；等不到才退回 scrollY。
    const ANCHOR_WAIT = 4000, HEIGHT_WAIT = 3000;
    const tryScroll = () => {
      const elapsed = Date.now() - t0;
      if (pendingAnchor) {
        const el = document.querySelector<HTMLElement>(`[data-anchor="${pendingAnchor}"]`);
        if (el) { el.scrollIntoView({ block: 'center', behavior: 'auto' }); clearPendingScroll(); return; }
        if (elapsed < ANCHOR_WAIT) { raf = requestAnimationFrame(tryScroll); return; }
      }
      const reachable = document.documentElement.scrollHeight - window.innerHeight;
      if (reachable >= pendingScrollY - 2 || elapsed > HEIGHT_WAIT) {
        window.scrollTo({ top: pendingScrollY, behavior: 'auto' });
        clearPendingScroll();
        return;
      }
      raf = requestAnimationFrame(tryScroll);
    };
    raf = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(raf);
  }, [pendingScrollY, pendingAnchor, clearPendingScroll]);

  useEffect(() => {
    let alive = true;
    fetch('/api/market-clock')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (alive && Array.isArray(j?.holidays)) setHolidays(j.holidays); })
      .catch(() => { /* 失敗＝維持 fail-open 只擋週末，不影響可用性 */ });
    return () => { alive = false; };
  }, []);

  // Web Push 通知點擊會帶 ?code=<股票代號> 開啟本站 → 解析後直接開個股分析頁，
  // 再清掉 query 避免重新整理/返回時重複觸發。
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('code');
    if (code && /^\d{4,6}$/.test(code)) {
      useAppStore.getState().navigateTo('stock', code);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  // NOTE: Forced landscape / fullscreen orientation lock was removed — it is a
  // mobile anti-pattern that fought portrait users and was blocked by most
  // browsers anyway. The layout is now fully responsive in both orientations.

  const layoutClass = [styles.appLayout, isWarV2 ? styles.warV2 : '', focusMode ? styles.focusMode : ''].filter(Boolean).join(' ');

  return (
    <div className={layoutClass}>

      {/* Global alert engine — mounts invisibly, handles notifications + toasts */}
      <AlertEngine />

      {/* Global authentication modal */}
      <AuthModal />

      <ViewAsBanner />
      <Navbar rail={focusMode} />
      <div className={styles.mainArea}>
        {/* 專注模式：網站頂列由戰情指揮列（Z0）／手機摘要列（S1）取代——卸載，不是隱藏 */}
        {!focusMode && <Header />}
        <main className={styles.content} id="main-content">
          {(currentPage === 'dashboard' || currentPage === 'indexnews') && <Dashboard />}
          {currentPage === 'stock'     && <StockDetail />}
          {currentPage === 'picker'    && <StockPicker />}
          {currentPage === 'portfolio' && <Portfolio />}
          {currentPage === 'backtest'  && <Backtest />}
          {currentPage === 'tracker'   && <WatchlistTracker />}
          {isWarV2 && <WarRoomV2 />}
          {currentPage === 'war' && !isWarV2 && (
            <>
              {/* 舊版保留 2 週（第 14 題）：一鍵回新版——只給超管（其他人沒有新版，看到的就是原本的戰情頁）。
                  放在這裡而不是改 WarRoom.tsx，舊版元件原樣不動 */}
              {v2Allowed && (
                <div className={styles.layoutSwitch}>
                  <span>目前是舊版盤中戰情（保留至 10/19）</span>
                  <button type="button" onClick={() => setWarLayout('v2')}>切換新版 →</button>
                </div>
              )}
              <WarRoom />
            </>
          )}
          {/* 盤前備課：入口守門在 PrepRoom 內（非超管只顯示未開放說明、不掛任何面板） */}
          {currentPage === 'prep'      && <PrepRoom />}
          {currentPage === 'admin'     && <AdminPanel />}
          {currentPage === 'help'      && <HelpManual />}
          {currentPage === 'privacy'   && <PrivacyPage />}
        </main>
      </div>

      {/* 🚨 搶漲停排隊警示（09:15 前·全頁浮動反底色閃爍）——戰情專注模式不掛載（排隊改由戰情頁內呈現） */}
      {!focusMode && <LimitQueueAlert />}

      {/* 候選便條（跨頁選股工作流）：全頁浮動，帶著候選走——戰情專注模式不掛載（不蓋住版面、不多一條 5 秒輪詢） */}
      {!focusMode && <CandidateDock />}

      {/* 隱私首次告知（登入後一次性） */}
      <ConsentBanner />
    </div>
  );
}
