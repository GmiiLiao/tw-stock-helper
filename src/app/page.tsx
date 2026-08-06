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
// AdminPanel 只有管理員用得到，卻是所有使用者都在下載的 31KB。
const AdminPanel        = dynamic(() => import('@/components/Admin/AdminPanel'));
// 模擬中橫幅：必須在所有頁面之上且永遠可見（忘了自己在模擬比功能壞掉更危險）
const ViewAsBanner      = dynamic(() => import('@/components/Admin/ViewAsBanner'), { ssr: false });
// HelpManual 連帶 help-content.ts（34KB 純靜態說明文字）
const HelpManual        = dynamic(() => import('@/components/Help/HelpManual'));

export default function App() {
  const currentPage = useAppStore((s) => s.currentPage);

  // Run the Firebase Auth and Data synchronization hook
  useFirebaseSync();

  // 休市日曆：market-clock 的 holidays 表預設是空的（fail-open 只擋週末），
  // 不在這裡填上的話，國定假日與颱風假都會被當成交易日照常輪詢。
  // 一天只變一次，CDN daily tier 擋掉幾乎所有回源。
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

  return (
    <div className={styles.appLayout}>

      {/* Global alert engine — mounts invisibly, handles notifications + toasts */}
      <AlertEngine />

      {/* Global authentication modal */}
      <AuthModal />

      <ViewAsBanner />
      <Navbar />
      <div className={styles.mainArea}>
        <Header />
        <main className={styles.content} id="main-content">
          {(currentPage === 'dashboard' || currentPage === 'indexnews') && <Dashboard />}
          {currentPage === 'stock'     && <StockDetail />}
          {currentPage === 'picker'    && <StockPicker />}
          {currentPage === 'portfolio' && <Portfolio />}
          {currentPage === 'backtest'  && <Backtest />}
          {currentPage === 'tracker'   && <WatchlistTracker />}
          {currentPage === 'war'       && <WarRoom />}
          {currentPage === 'admin'     && <AdminPanel />}
          {currentPage === 'help'      && <HelpManual />}
          {currentPage === 'privacy'   && <PrivacyPage />}
        </main>
      </div>

      {/* 候選便條（跨頁選股工作流）：全頁浮動，帶著候選走 */}
      <CandidateDock />

      {/* 隱私首次告知（登入後一次性） */}
      <ConsentBanner />
    </div>
  );
}
