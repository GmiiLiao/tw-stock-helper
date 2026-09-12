'use client';

import { useState, useEffect } from 'react';
import { storageGet, storageSet } from '@/lib/safe-storage';
import { useAppStore } from '@/lib/store';
import styles from './Navbar.module.css';
import AiNewsTicker, { NavbarIndexWidget } from '@/components/AiNewsTicker/AiNewsTicker';
import { useIsPremium } from '@/lib/view-as';

const NAV_ITEMS = [
  // 2026-08-05：「指數·新聞」不再是獨立入口——指數與新聞已成為市場總覽的分頁
  //   （指數＝大盤背景，人看大盤時本來就在這一頁）；話題選股搬到「選股」。
  { id: 'dashboard', label: '市場總覽', icon: '📊' },
  { id: 'picker',    label: '選股',     icon: '🎯', badge: 'AI' },
  { id: 'war',       label: '盤中戰情',   icon: '⚡', badge: 'LIVE', premium: true }, // 高級會員限定，非會員完全隱藏（決策工作台為其分頁）
  { id: 'tracker',   label: '即時追蹤',   icon: '📡' },
  { id: 'portfolio', label: '投資組合',   icon: '💼' },
  { id: 'backtest',  label: '策略回測',   icon: '🧪' },
];
// 等級清單已集中到 lib/view-as（PREMIUM_LEVELS）——此處不再各自定義，避免模擬只改到一半
const TRIAL_DAYS = 14; // 與選股策略一致：新註冊 14 天免費體驗(依 Firebase Auth 註冊時間)

import { auth } from '@/lib/firebase';
import { useShallow } from 'zustand/react/shallow';

const getLevelLabel = (level?: string) => {
  switch (level) {
    case 'superadmin': return '👑 超級管理員';
    case 'admin':      return '🛡️ 管理員';
    case 'premium':    return '💎 高級會員';
    case 'junior':     return '✨ 初級會員';
    case 'registered': return '👤 註冊使用者';
    default:           return '👤 註冊使用者';
  }
};

export default function Navbar() {
  const {
    currentPage,
    pageHistory,
    navigateTo,
    navigateBack,
    selectedStock,
    user,
    authLoading,
    setShowAuthModal,
    setHelpSection
  } = useAppStore(useShallow((s) => ({
    currentPage: s.currentPage,
    pageHistory: s.pageHistory,
    navigateTo: s.navigateTo,
    navigateBack: s.navigateBack,
    selectedStock: s.selectedStock,
    setHelpSection: s.setHelpSection,
    user: s.user,
    authLoading: s.authLoading,
    setShowAuthModal: s.setShowAuthModal,
  })));
  const canGoBack = pageHistory.length > 0;
  const adminEmail = process.env.NEXT_PUBLIC_ADMIN_EMAIL;
  const isAdmin = user && (user.level === 'superadmin' || user.level === 'admin' || (adminEmail && user.email === adminEmail));

  // 高級會員限定項目（盤中戰情）：非會員且非體驗期 → 導覽完全隱藏
  // ⚠會員限定項目走**有效等級**（受身分模擬影響）；上面的 isAdmin 刻意用真實等級——
  //   否則模擬成一般會員時管理後台入口會消失，就回不去了。
  const isPremiumUser = useIsPremium();
  const trialActive = (() => {
    if (isPremiumUser || !user?.uid) return false;
    const ct = (auth as { currentUser?: { metadata?: { creationTime?: string } } })?.currentUser?.metadata?.creationTime;
    if (!ct) return false;
    return (Date.now() - new Date(ct).getTime()) / 86400000 < TRIAL_DAYS;
  })();
  const visibleNavItems = NAV_ITEMS.filter(item => !('premium' in item && item.premium) || isPremiumUser || trialActive);

  const [showUserMenu, setShowUserMenu] = useState(false);

  // ── 字體大小比例（無障礙）：zoom 整頁縮放、版面自動重排，設定存本機 ──
  const [fontScale, setFontScale] = useState(1);
  useEffect(() => {
    const saved = parseFloat(storageGet('fontScale') || '1');
    if (saved >= 1 && saved <= 2.5) { setFontScale(saved); applyFontScale(saved); }
  }, []);
  // ── 游標防護：Chromium 的 body.zoom × 手機IME insertText bug ──
  // 字體放大（zoom≠1）時，手機鍵盤每次插字後游標被打回位置0，下一字插在最前面
  // （輸入 1736 變 6371）。input 事件後偵測到此異常即把游標推回尾端。
  // 全站生效（搜尋、建倉數字…所有輸入框）；zoom=1 或使用者正常編輯不受影響。
  useEffect(() => {
    const guard = (e: Event) => {
      const el = e.target as HTMLInputElement | HTMLTextAreaElement;
      if (!el || typeof el.value !== 'string' || !('selectionStart' in el)) return;
      if ((e as InputEvent).isComposing) return;   // 中文組字中不干預
      const zoom = (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom;
      if (!zoom || zoom === '1') return;
      if (document.activeElement === el && el.selectionStart === 0 && el.value.length > 0) {
        const n = el.value.length;
        try { el.setSelectionRange(n, n); } catch { /* type=number 等不支援 selection 的欄位 */ }
      }
    };
    document.addEventListener('input', guard, true);
    return () => document.removeEventListener('input', guard, true);
  }, []);

  const applyFontScale = (v: number) => {
    (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = v === 1 ? '' : String(v);
    const nav = document.querySelector('nav') as (HTMLElement & { style: CSSStyleDeclaration & { zoom?: string } }) | null;
    if (!nav) return;
    if (window.innerWidth <= 768 && v > 1) {
      // 手機底部導覽列「補償縮放」維持標準大小：8 顆項目放大後會超出螢幕擠壓難按
      nav.style.zoom = String(1 / v);
      nav.style.height = ''; nav.style.minHeight = '';
    } else {
      nav.style.zoom = '';
      // 桌面關鍵修正：body zoom 會把 100vh 側欄「視覺放大 v 倍」——元素本身伸出
      // 螢幕外，帳號區位於元素下半截、任何 overflow 捲動都救不到。
      // 高度反向補償成 100vh/v，側欄實際貼合視窗，內部的選單捲動與帳號釘底才生效。
      nav.style.height = v > 1 ? `calc(100vh / ${v})` : '';
      nav.style.minHeight = v > 1 ? `calc(100vh / ${v})` : '';
    }
  };
  const changeFontScale = (v: number) => {
    setFontScale(v);
    storageSet('fontScale', String(v));
    applyFontScale(v);
  };
  const FontScaleRow = () => (
    <div style={{ padding: '8px 14px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#8b9bb8', marginBottom: 6 }}>🔠 字體大小</div>
      <div style={{ display: 'flex', gap: 6 }}>
        {[[1, '標準', 12], [1.3, '大', 14], [1.75, '特大', 17], [2.5, '超大', 20]].map(([v, label, fs]) => (
          <button key={String(v)} onClick={e => { e.stopPropagation(); changeFontScale(v as number); }}
            style={{ flex: 1, padding: '6px 0', borderRadius: 8, cursor: 'pointer', fontWeight: 700,
              fontSize: fs as number,
              border: fontScale === v ? '1px solid #3d8ef8' : '1px solid rgba(255,255,255,0.12)',
              background: fontScale === v ? 'rgba(61,142,248,0.15)' : 'transparent',
              color: fontScale === v ? '#3d8ef8' : '#94a3b8' }}>
            {label as string}
          </button>
        ))}
      </div>
    </div>
  );

  useEffect(() => {
    if (!showUserMenu) return;
    const handleClose = () => setShowUserMenu(false);
    window.addEventListener('click', handleClose);
    return () => window.removeEventListener('click', handleClose);
  }, [showUserMenu]);

  const toggleUserMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowUserMenu(prev => !prev);
  };

  return (
    <nav className={styles.navbar}>
      {/* ── Brand ── */}
      <div className={styles.brand}>
        <div className={styles.brandIcon}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M3 17l5-5 4 4 5-6 4 3" stroke="#3d8ef8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <circle cx="3"  cy="17" r="1.5" fill="#3d8ef8"/>
            <circle cx="8"  cy="12" r="1.5" fill="#3d8ef8"/>
            <circle cx="12" cy="16" r="1.5" fill="#f03e3e"/>
            <circle cx="17" cy="10" r="1.5" fill="#3d8ef8"/>
            <circle cx="21" cy="13" r="1.5" fill="#3d8ef8"/>
          </svg>
        </div>
        <div>
          <div className={styles.brandName}>台股助手</div>
          <div className={styles.brandSub}>TW Stock Pro</div>
        </div>
      </div>

      {/* ⚠ 操作模式切換器已移到「選股」頁的選股模型上方（2026-08-11 使用者指定）。
           原本放在這裡的理由仍然成立且未消失：使用者必須隨時知道自己在哪個口徑，
           否則會把波段訊號拿去隔日沖（實測 -0.06%）。
           搬走之後，在選股頁以外就看不到目前模式了——若之後發現有人在個股頁誤用口徑，
           優先考慮的是「在各頁加一個唯讀的模式標示」，而不是把切換器搬回來。 */}

      {/* ── 台股指數 Widget ── */}
      <NavbarIndexWidget />

      {/* ── Back Button ── */}
      {canGoBack && (
        <button
          id="nav-back"
          className={styles.backBtn}
          onClick={navigateBack}
          title={`回上一頁（${pageHistory[pageHistory.length - 1]?.page}）`}
          aria-label="回上一頁"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <span className={styles.backLabel}>返回</span>
        </button>
      )}

      {/* ── Nav Items ── */}
      <div className={styles.navItems}>
        {visibleNavItems.map(item => (
          <button
            key={item.id}
            id={`nav-${item.id}`}
            className={`${styles.navItem} ${currentPage === item.id ? styles.active : ''}`}
            onClick={() => navigateTo(item.id as typeof currentPage)}
          >
            <span className={styles.navIcon}>{item.icon}</span>
            <span className={styles.navLabel}>{item.label}</span>
            {'badge' in item && item.badge && (
              <span className={styles.navBadge}>{item.badge}</span>
            )}
            {currentPage === item.id && <div className={styles.activeIndicator} />}
          </button>
        ))}

        {selectedStock && (
          <button
            id="nav-stock-detail"
            className={`${styles.navItem} ${currentPage === 'stock' ? styles.active : ''}`}
            onClick={() => navigateTo('stock')}
          >
            <span className={styles.navIcon}>📈</span>
            <span className={styles.navLabel}>個股分析</span>
            {currentPage === 'stock' && <div className={styles.activeIndicator} />}
          </button>
        )}

        {/* 手機版帳號入口（桌面版隱藏——桌面用側欄底部的帳號區）：
            訪客→開登入視窗；已登入→開帳號選單（選單已有手機定位樣式） */}
        <button
          id="nav-mobile-user"
          className={`${styles.navItem} ${styles.mobileUserItem}`}
          onClick={e => { e.stopPropagation(); if (user) setShowUserMenu(v => !v); else setShowAuthModal(true); }}
        >
          <span className={styles.navIcon}>👤</span>
          <span className={styles.navLabel}>{user ? '我的' : '登入'}</span>
        </button>

        {/* 手機版帳號選單（桌面選單在側欄 authPanel，手機被隱藏故另渲染一份） */}
        {user && showUserMenu && (
          <div className={`${styles.userDropdown} ${styles.mobileUserItem}`} onClick={e => e.stopPropagation()}>
            <div className={styles.dropdownHeader}>
              <span className={styles.dropdownTitle}>{user.displayName || '用戶'} · {getLevelLabel(user.level)}</span>
            </div>
            {isAdmin && (
              <button className={styles.dropdownItem} onClick={() => { navigateTo('admin'); setShowUserMenu(false); }}>
                <span>🔒 管理員後台</span>
              </button>
            )}
            <button className={styles.dropdownItem} onClick={() => { navigateTo('help'); setShowUserMenu(false); }}>
              <span>📖 使用說明書</span>
            </button>
            <button className={styles.dropdownItem} onClick={() => { setHelpSection('privacy'); navigateTo('help'); setShowUserMenu(false); }}>
              <span>🔒 隱私聲明</span>
            </button>
            <FontScaleRow />
            <button
              className={styles.dropdownItem}
              onClick={() => { import('firebase/auth').then(({ signOut }) => { signOut(auth); setShowUserMenu(false); }); }}
            >
              <span style={{ color: '#ff6b6b' }}>🚪 登出帳號</span>
            </button>
          </div>
        )}


      </div>

      {/* ── AI News Agent Ticker ── */}
      <AiNewsTicker />

      {/* ── Auth / User Panel ── */}
      <div className={styles.authPanel} id="navbar-auth-panel">
        {authLoading ? (
          <div className={styles.authLoading}><div className="spinner" style={{ width: 14, height: 14 }} /></div>
        ) : user ? (
          <div className={styles.userProfile} onClick={toggleUserMenu} style={{ cursor: 'pointer' }}>
            <div className={styles.userAvatar}>
              {user.displayName?.charAt(0).toUpperCase() || '👤'}
            </div>
            <div className={styles.userInfo}>
              <div className={styles.userName}>{user.displayName || '用戶'}</div>
              <span className={`${styles.roleBadge} ${styles[user.level || 'registered']}`}>
                {getLevelLabel(user.level)}
              </span>
              <div className={styles.userEmail}>{user.email}</div>
            </div>
            <div className={styles.menuChevron}>
              {showUserMenu ? '▲' : '▼'}
            </div>

            {/* ── User Dropdown floating menu ── */}
            {showUserMenu && (
              <div className={styles.userDropdown} onClick={(e) => e.stopPropagation()}>
                <div className={styles.dropdownHeader}>
                  <span className={styles.dropdownTitle}>帳戶設定</span>
                </div>
                {isAdmin && (
                  <button
                    className={`${styles.dropdownItem} ${currentPage === 'admin' ? styles.dropdownItemActive : ''}`}
                    onClick={() => {
                      navigateTo('admin');
                      setShowUserMenu(false);
                    }}
                  >
                    <span>🔒 管理員後台</span>
                  </button>
                )}
                <button
                  className={`${styles.dropdownItem} ${currentPage === 'help' ? styles.dropdownItemActive : ''}`}
                  onClick={() => { navigateTo('help'); setShowUserMenu(false); }}
                >
                  <span>📖 使用說明書</span>
                </button>
                <button
                  className={`${styles.dropdownItem} ${currentPage === 'help' ? styles.dropdownItemActive : ''}`}
                  onClick={() => { setHelpSection('privacy'); navigateTo('help'); setShowUserMenu(false); }}
                >
                  <span>🔒 隱私聲明</span>
                </button>
                <FontScaleRow />
                <button
                  className={styles.dropdownItem}
                  onClick={() => {
                    import('firebase/auth').then(({ signOut }) => {
                      signOut(auth);
                      setShowUserMenu(false);
                    });
                  }}
                >
                  <span style={{ color: '#ff6b6b' }}>🚪 登出帳號</span>
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.guestPanel}>
            <span className={styles.guestLabel}>⚠️ 未註冊使用者</span>
            <button onClick={() => setShowAuthModal(true)} className={styles.loginBtn}>
              👤 登入 / 註冊
            </button>
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <div className={styles.navFooter}>
        <div className={styles.marketStatus}>
          <div className={styles.statusDot} id="market-status-dot" />
          <span className={styles.statusText} id="market-status-text">台股資料</span>
        </div>
        <div className={styles.version}>v1.0</div>
      </div>
    </nav>
  );
}
