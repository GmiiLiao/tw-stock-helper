'use client';

import { useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import { useFirebaseSync } from '@/lib/firebase-sync';
import Navbar from '@/components/Navbar/Navbar';
import Header from '@/components/Header/Header';
import Dashboard from '@/components/Dashboard/Dashboard';
import StockDetail from '@/components/StockDetail/StockDetail';
import StockPicker from '@/components/StockPicker/StockPicker';
import Portfolio from '@/components/Portfolio/Portfolio';
import Backtest from '@/components/Backtest/Backtest';
import AlertEngine from '@/components/AlertEngine/AlertEngine';
import WatchlistTracker from '@/components/WatchlistTracker/WatchlistTracker';
import WarRoom from '@/components/WarRoom/WarRoom';
import AuthModal from '@/components/Auth/AuthModal';
import AdminPanel from '@/components/Admin/AdminPanel';
import CandidateDock from '@/components/Candidates/CandidateDock';
import HelpManual from '@/components/Help/HelpManual';
import IndexNewsPage from '@/components/IndexNews/IndexNewsPage';
import { PrivacyPage, ConsentBanner } from '@/components/Help/PrivacyNotice';
import styles from './page.module.css';

export default function App() {
  const { currentPage } = useAppStore();

  // Run the Firebase Auth and Data synchronization hook
  useFirebaseSync();

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

      <Navbar />
      <div className={styles.mainArea}>
        <Header />
        <main className={styles.content} id="main-content">
          {currentPage === 'dashboard' && <Dashboard />}
          {currentPage === 'stock'     && <StockDetail />}
          {currentPage === 'picker'    && <StockPicker />}
          {currentPage === 'portfolio' && <Portfolio />}
          {currentPage === 'backtest'  && <Backtest />}
          {currentPage === 'tracker'   && <WatchlistTracker />}
          {currentPage === 'war'       && <WarRoom />}
          {currentPage === 'admin'     && <AdminPanel />}
          {currentPage === 'indexnews' && <IndexNewsPage />}
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

