import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_MODE, isModeKey, type ModeKey } from './trading-mode';
import type { StockInfo } from '@/lib/twse-api';
import { doc, runTransaction, setDoc, type Transaction } from 'firebase/firestore';
import { db } from './firebase';
import { logActivity } from './activity-logger';
import {
  PRICE_ALERTS_DOC, LEGACY_ALERTS_DOC, applyPriceAlertOp, resolvePriceAlerts, stripUserPriceAlerts, withPriceAlerts,
  type PriceAlertOp,
} from '../../scripts/lib/alerts-split.mjs';

export interface WatchlistItem {
  code: string;
  name: string;
  addedAt: number;
}

export interface WatchlistGroup {
  id: string;
  name: string;
  color: string; // hex or css color
  stocks: WatchlistItem[];
  createdAt: number;
  analysisRecords?: Array<{ timestamp: number; report: string }>;
}

export interface HoldingItem {
  id: string;
  code: string;
  name: string;
  buyPrice: number;
  quantity: number;
  buyDate: string;
  note?: string;
  unit?: 'lot' | 'share';  // 建立時使用者選的顯示單位（見 tw-fee.fmtQty）；未指定＝'lot'
}

export interface TradeRecord {
  id: string;
  code: string;
  name: string;
  type: 'buy' | 'sell' | 'dividend';  // 買入/賣出/股利
  price: number;           // 成交價
  quantity: number;        // 張數（內部一律以張儲存，可小數；0.35 = 350 股）
  unit?: 'lot' | 'share';  // 輸入時選的單位，只影響顯示：'share' 一律寫成「N 股」不進位成張
  fee: number;             // 手續費
  tax: number;             // 交易稅（賣出 0.3%）
  totalAmount: number;     // 實際金額（含費用）
  date: string;            // YYYY-MM-DD
  note?: string;
  createdAt: number;
  realizedPnL?: number;    // 已實現淨損益（賣出時，含買賣雙邊成本）
  costBasis?: number;      // 成本基礎（買入均價）
  dayTrade?: boolean;      // 現股當沖（證交稅減半 0.15%）
  holdingId?: string;      // 關聯的持倉 ID（買入時）
  consumedHoldings?: Array<{ id: string; buyPrice: number; quantity: number; buyDate: string; note?: string }>; // 扣抵的持倉明細（賣出時）
}

export interface AlertItem {
  id: string;
  code: string;
  name: string;
  type: 'PRICE_ABOVE' | 'PRICE_BELOW' | 'CHANGE_ABOVE' | 'CHANGE_BELOW';
  value: number;
  triggered: boolean;
  createdAt: number;
}

export interface AppNotification {
  id: string;
  type: 'price_alert' | 'signal_alert' | 'volume_alert' | 'premarket_reminder' | 'ai_signal' | 'limit_up' | 'limit_down';
  stockCode: string;
  stockName: string;
  message: string;
  detail: string;
  timestamp: number;
  read: boolean;
  severity: 'info' | 'warning' | 'critical';
}

// ── 🎭 身分模擬的唯讀閘門（2026-08-06）────────────────────────────
// 管理員模擬會員身分時，畫面上的資料是**別人的**。若同步照常運作，
// 任何一次「加自選 / 記錄持倉」都會寫進該會員的 Firestore ——
// 所以在模擬期間把所有寫入集中封在這一道，而不是逐一在 30 個呼叫點加判斷
// （漏一個就是事故）。
let _syncReadOnly = false;
export const setSyncReadOnly = (v: boolean) => { _syncReadOnly = v; };

const syncWatchlist = async (uid: string, watchlist: any[], watchlistGroups: any[]) => {
  if (_syncReadOnly) return;
  try {
    const data = JSON.parse(JSON.stringify({ watchlist, watchlistGroups }));
    await setDoc(doc(db, 'users', uid, 'data', 'watchlist'), data);
  } catch (e) {
    console.error('Error syncing watchlist:', e);
  }
};

const syncHoldings = async (uid: string, holdings: any[]) => {
  if (_syncReadOnly) return;
  try {
    const data = JSON.parse(JSON.stringify({ holdings }));
    await setDoc(doc(db, 'users', uid, 'data', 'holdings'), data);
  } catch (e) {
    console.error('Error syncing holdings:', e);
  }
};

const syncTrades = async (uid: string, tradeRecords: any[]) => {
  if (_syncReadOnly) return;
  try {
    // updatedAt：daemon 的配置漂移監看拿它與 rebalance.updatedAt 比大小，
    // 記/改/刪一筆交易後右下再平衡卡才會在數分鐘內重算（原本缺這欄＝監看盲區）。
    const data = JSON.parse(JSON.stringify({ tradeRecords, updatedAt: Date.now() }));
    await setDoc(doc(db, 'users', uid, 'data', 'trades'), data);
  } catch (e) {
    console.error('Error syncing trades:', e);
  }
};

// ── 使用者價位警示：獨立文件 users/{uid}/data/priceAlerts（2026-10-05·critique H3）────────────
// 舊版把價位警示和 daemon 警示（停損、反轉…）存在同一個 alerts 陣列，並以「登入時讀到的整份陣列」setDoc 回寫：
//   價位警示一觸發就抹掉登入後 daemon 寫入的停損警示與「收到」紀錄；daemon 的 slice(0,40) 也會擠掉價位警示。
// 現在：價位警示只存 priceAlerts；每次寫入都是「交易內讀最新文件 → 只改這一個 id」，不再用記憶體裡的整份陣列覆寫。
// 舊 alerts 文件（daemon 與 PortfolioAlerts 用）前端只在同一個交易內移除其中的價位警示，daemon 警示與 ack 原封不動。
// 遷移／清理規則唯一實作：scripts/lib/alerts-split.mjs（有單元測試）。
const firestoreReady = () => typeof window !== 'undefined' && typeof (db as { type?: unknown }).type !== 'undefined';

/**
 * 價位警示的唯一雲端寫入口（單一交易）：
 *   ① priceAlerts 不存在 ⇒ 一次性遷移（舊 alerts 文件的價位警示；舊文件也沒有 ⇒ 本機 store.alerts）
 *   ② 套用 op（add／remove／trigger；null＝只載入）
 *   ③ 舊 alerts 文件若還有價位警示副本 ⇒ 移除（只動這些項目；daemon 同時寫入時交易會重試，不會蓋掉 daemon 警示）
 * 回傳雲端（交易後）的價位警示清單。
 */
const syncPriceAlerts = (uid: string, op: PriceAlertOp<AlertItem> | null): Promise<AlertItem[]> =>
  runTransaction(db, async (tx: Transaction) => {
    const priceRef = doc(db, 'users', uid, 'data', PRICE_ALERTS_DOC);
    const legacyRef = doc(db, 'users', uid, 'data', LEGACY_ALERTS_DOC);
    const cur = await tx.get(priceRef);
    const legacy = await tx.get(legacyRef);
    const legacyDoc = legacy.exists() ? legacy.data() : null;
    const resolved = resolvePriceAlerts<AlertItem>({
      priceDoc: cur.exists() ? cur.data() : null,
      legacyDoc,
      localAlerts: useAppStore.getState().alerts,
    });
    const next = op ? applyPriceAlertOp<AlertItem>(resolved.list, op) : { list: resolved.list, changed: false };
    if (resolved.migrate || next.changed) {
      const payload = { alerts: next.list, updatedAt: Date.now(), ...(resolved.migrate ? { migratedFrom: resolved.source } : {}) };
      tx.set(priceRef, JSON.parse(JSON.stringify(payload)));
    }
    const legacyKept = stripUserPriceAlerts(legacyDoc);
    if (legacyKept) tx.update(legacyRef, { alerts: legacyKept, updatedAt: Date.now() });
    return next.list;
  });

/** store 動作用：對雲端 priceAlerts 套用單一操作。身分模擬中（唯讀）不寫；失敗只記錄，本機狀態保留。 */
const writePriceAlertOp = async (uid: string, op: PriceAlertOp<AlertItem>) => {
  if (_syncReadOnly || !firestoreReady()) return;
  try {
    await syncPriceAlerts(uid, op);
  } catch (e) {
    console.error('Error syncing price alerts:', e);
  }
};

const syncNotifications = async (uid: string, notifications: any[]) => {
  if (_syncReadOnly) return;
  try {
    const data = JSON.parse(JSON.stringify({ notifications }));
    await setDoc(doc(db, 'users', uid, 'data', 'notifications'), data);
  } catch (e) {
    console.error('Error syncing notifications:', e);
  }
};

interface AppState {
  // View
  // 'prep'＝盤前備課（2026-10-05 使用者裁定：盤中戰情 v2 移出的籌碼推選／凍結版漲停預測／跳空漲停／隔日沖決策工作台／軋空與空方完整版）
  currentPage: 'dashboard' | 'stock' | 'picker' | 'portfolio' | 'backtest' | 'tracker' | 'war' | 'prep' | 'admin' | 'help' | 'privacy' | 'indexnews';
  // ⚠ 歷史要連**捲動位置**一起記（2026-08-11 使用者要求「返回能回到上一個狀態位置」）：
  //   先前只記 {page, stock}，所以從清單捲到第 30 檔點進個股，返回時被丟回最頂端，
  //   使用者得重新捲一次才找得到剛剛看的那一檔——清單越長越難用。
  pageHistory: Array<{ page: AppState['currentPage']; stock?: string | null; scrollY?: number; anchor?: string | null }>;  // navigation stack；anchor＝離開時點進的個股（返回捲到該列）
  // 返回時要還原到的捲動位置；由 page.tsx 的 effect 消費後清成 null。
  // 不能在 store 裡直接 scrollTo——那時候新頁面還沒渲染完，捲了也會被內容撐掉。
  pendingScrollY: number | null;
  // 返回時優先捲到的錨點列（來源頁上 data-anchor=代號 的元素）；找不到才退回 pendingScrollY。
  // 2026-09-17 使用者實案：scrollY 有還原，但清單頁的子分頁重新掛載後回到預設，原本那列根本不在畫面上。
  pendingAnchor: string | null;
  selectedStock: string | null;
  activeTab: string;
  // 頁面內分頁選取：存在 store(非持久化)，讓「進個股→返回」時回到原本的子分頁而非重置
  pickerTab: string;      // 選股頁主分頁(recommend/boards/topic/strategy/screen)
  dashTab: string;        // 市場總覽主分頁(market/index/news)
  /** 使用說明書要開在哪個章節（隱私聲明由選單深連結進來用） */
  helpSection: string | null;
  warTab: string;         // 盤中戰情主分頁(radar/risefall/chip/limitup/volsurge/desk)——只有舊版（warLayout='classic'）用
  // 盤中戰情版面（2026-10-05 使用者裁定第 14 題）：v2＝一頁 9 區塊新版（預設）；classic＝舊版分頁式，保留 2 週後移除。persist。
  warLayout: 'v2' | 'classic';
  // 戰情 v2 專注模式（第 6 題：預設開）：側欄收成 64px 圖示欄、網站頂列 Header 與側欄指數卡／AI 跑馬燈「卸載」（不是 CSS 隱藏——
  // 卸載才省流量）、LimitQueueAlert 與 CandidateDock 不掛載。只在 currentPage==='war' 且 warLayout==='v2' 時生效。persist。
  warFocus: boolean;
  recommendTab: string;   // AI 推薦選股的策略子分頁(all/intraday/momentum…)
  trackerGroupId: string; // 即時追蹤的群組分頁

  // 操作模式（2026-08-03 模式化）：全站狀態。選定後評分/榜單/警報/問AI 全部跟著切。
  // 口徑隔離鐵律——每個模式的權重各自回測、絕不互借，詳見 @/lib/trading-mode。
  // 持久化到 localStorage（立即生效）＋同步到 users/{uid}.tradingMode（跨裝置與 daemon 共用）。
  tradingMode: ModeKey;

  // Auth
  user: { uid: string; email: string | null; displayName: string | null; level: string } | null;
  /** 本機（localStorage）持股／交易／自選／警報屬於哪個帳號（2026-09-28 WM-SCAN G3-11）。
   *  null＝訪客或舊版資料（擁有者不明）。登入時只有擁有者相符才可把本機資料補上雲端，否則新帳號一律從空白開始。 */
  dataOwnerUid: string | null;
  // 🎭 身分模擬（僅 superadmin·唯讀·不持久化——重新整理即自動結束）
  viewAs: { level: string | null; uid: string | null; email: string | null; at: number } | null;
  authLoading: boolean;
  showAuthModal: boolean;

  // Data
  allStocks: StockInfo[];
  lastFetchTime: number;

  // User data (legacy - backward compatible)
  watchlist: WatchlistItem[];
  holdings: HoldingItem[];
  tradeRecords: TradeRecord[];
  alerts: AlertItem[];

  // Watchlist groups
  watchlistGroups: WatchlistGroup[];

  // Notifications
  notifications: AppNotification[];

  // UI preferences
  chartPeriod: '1M' | '3M' | '6M' | '1Y';
  activeIndicators: string[];

  // Actions
  setCurrentPage: (page: AppState['currentPage']) => void;
  navigateTo: (page: AppState['currentPage'], stock?: string | null) => void;
  clearPendingScroll: () => void;
  navigateBack: () => void;
  setSelectedStock: (code: string | null) => void;
  setActiveTab: (tab: string) => void;
  setPickerTab: (tab: string) => void;
  setDashTab: (tab: string) => void;
  setHelpSection: (v: string | null) => void;
  setWarTab: (tab: string) => void;
  setWarLayout: (layout: AppState['warLayout']) => void;
  setWarFocus: (on: boolean) => void;
  setRecommendTab: (tab: string) => void;
  setTrackerGroupId: (id: string) => void;
  setAllStocks: (stocks: StockInfo[]) => void;
  setLastFetchTime: (time: number) => void;
  setUser: (user: AppState['user']) => void;
  enterViewAs: (v: { level?: string | null; uid?: string | null; email?: string | null; data?: Partial<Pick<AppState, 'watchlist' | 'watchlistGroups' | 'holdings' | 'tradeRecords' | 'alerts' | 'notifications'>> }) => void;
  exitViewAs: () => void;
  setTradingMode: (m: ModeKey) => void;
  setAuthLoading: (loading: boolean) => void;
  setShowAuthModal: (show: boolean) => void;

  // Watchlist (legacy)
  addToWatchlist: (stock: StockInfo) => void;
  removeFromWatchlist: (code: string) => void;
  isInWatchlist: (code: string) => boolean;

  // Watchlist Groups
  addWatchlistGroup: (name: string, color: string) => void;
  addWatchlistGroupWithStocks: (id: string, name: string, color: string, stocks: WatchlistItem[]) => void;
  removeWatchlistGroup: (id: string) => void;
  updateWatchlistGroup: (id: string, name: string, color: string) => void;
  addToGroup: (groupId: string, stock: WatchlistItem) => void;
  removeFromGroup: (groupId: string, code: string) => void;
  reorderGroupStocks: (groupId: string, fromIndex: number, toIndex: number) => void;
  addGroupAnalysisRecord: (groupId: string, record: { timestamp: number; report: string }) => void;

  // Holdings
  addHolding: (holding: Omit<HoldingItem, 'id'>) => void;
  removeHolding: (id: string) => void;
  updateHolding: (id: string, updates: Partial<HoldingItem>) => void;
  replaceHoldings: (items: Array<Omit<HoldingItem, 'id'>>) => void;

  // Trade Records
  addTradeRecord: (record: Omit<TradeRecord, 'id' | 'createdAt'>) => void;
  removeTradeRecord: (id: string) => void;
  updateTradeRecord: (id: string, updates: Partial<Omit<TradeRecord, 'id' | 'createdAt'>>) => void;

  // Alerts
  addAlert: (alert: Omit<AlertItem, 'id' | 'triggered' | 'createdAt'>) => void;
  removeAlert: (id: string) => void;
  triggerAlert: (id: string) => void;

  // Notifications
  addNotification: (n: Omit<AppNotification, 'id' | 'timestamp' | 'read'>) => void;
  markNotificationRead: (id: string) => void;
  clearAllNotifications: () => void;

  // Chart
  setChartPeriod: (period: AppState['chartPeriod']) => void;
  toggleIndicator: (indicator: string) => void;

  // Screener/Compare state persistence
  compareCodes: string[];
  compareBudget: number;
  compareProfitTarget: number;
  compareProfitTargetType: 'percent' | 'amount';
  compareTradeDuration: 'day' | 'swing';
  compareLotType: 'lot' | 'odd';
  compareSelectedGroupId: string;

  setCompareCodes: (codes: string[]) => void;
  // 候選便條（跨頁選股工作流）：沿用 compareCodes 為候選池，各頁「＋候選」隨手撿
  toggleCandidate: (code: string) => void;
  clearCandidates: () => void;
  setCompareBudget: (budget: number) => void;
  setCompareProfitTarget: (target: number) => void;
  setCompareProfitTargetType: (type: 'percent' | 'amount') => void;
  setCompareTradeDuration: (duration: 'day' | 'swing') => void;
  setCompareLotType: (type: 'lot' | 'odd') => void;
  setCompareSelectedGroupId: (id: string) => void;
}

const DEFAULT_STOCKS: WatchlistItem[] = [
  { code: '2330', name: '台積電', addedAt: Date.now() },
  { code: '2317', name: '鴻海', addedAt: Date.now() },
  { code: '2454', name: '聯發科', addedAt: Date.now() },
  { code: '0050', name: '元大台灣50', addedAt: Date.now() },
];

const DEFAULT_GROUPS: WatchlistGroup[] = [
  {
    id: 'default',
    name: '我的自選',
    color: '#f03e3e',
    stocks: DEFAULT_STOCKS,
    createdAt: Date.now(),
  },
];

/** 新帳號的起始資料（2026-09-28 使用者：新用戶應預設空白）：自選清單空白、保留一個空的「我的自選」群組供加入。
 *  訪客（未登入）仍看 DEFAULT_STOCKS 示範清單。 */
export const blankUserData = () => ({
  watchlist: [] as WatchlistItem[],
  watchlistGroups: [{ id: 'default', name: '我的自選', color: '#f03e3e', stocks: [] as WatchlistItem[], createdAt: Date.now() }] as WatchlistGroup[],
  holdings: [] as AppState['holdings'],
  tradeRecords: [] as AppState['tradeRecords'],
  alerts: [] as AppState['alerts'],
  notifications: [] as AppState['notifications'],
});

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      currentPage: 'dashboard',
      pageHistory: [],
      pendingScrollY: null,
      pendingAnchor: null,
      selectedStock: null,
      activeTab: 'overview',
      pickerTab: 'recommend',
      helpSection: null,
      dashTab: 'market',
      warTab: 'risefall',
      warLayout: 'v2',
      warFocus: true,
      recommendTab: 'all',
      trackerGroupId: 'tail',
      user: null,
      authLoading: true,
      showAuthModal: false,
      allStocks: [],
      lastFetchTime: 0,
      watchlist: DEFAULT_STOCKS,
      holdings: [],
      tradeRecords: [],
      alerts: [],
      watchlistGroups: DEFAULT_GROUPS,
      notifications: [],
      chartPeriod: '3M',
      activeIndicators: ['MA5', 'MA20', 'MA60', 'MACD', 'RSI', 'KD', 'VOL'],

      // Screener/Compare persistence
      compareCodes: [],
      compareBudget: 500000,
      compareProfitTarget: 10,
      compareProfitTargetType: 'percent',
      compareTradeDuration: 'swing',
      compareLotType: 'lot',
      compareSelectedGroupId: 'all',

      setCompareCodes: (codes) => set({ compareCodes: codes }),
      toggleCandidate: (code) => set((state) => ({
        compareCodes: state.compareCodes.includes(code)
          ? state.compareCodes.filter((c) => c !== code)
          : [...state.compareCodes, code],
      })),
      clearCandidates: () => set({ compareCodes: [] }),
      setCompareBudget: (budget) => set({ compareBudget: budget }),
      setCompareProfitTarget: (target) => set({ compareProfitTarget: target }),
      setCompareProfitTargetType: (type) => set({ compareProfitTargetType: type }),
      setCompareTradeDuration: (duration) => set({ compareTradeDuration: duration }),
      setCompareLotType: (type) => set({ compareLotType: type }),
      setCompareSelectedGroupId: (id) => set({ compareSelectedGroupId: id }),

      setCurrentPage: (page) => set({ currentPage: page }),

      navigateTo: (page, stock) => {
        logActivity('navigate', { page, ...(stock ? { stock } : {}) });
        set((state) => {
          const nextStock = stock !== undefined ? stock : state.selectedStock;
          // 導向與目前完全相同的頁面(且同一個股)時不推入歷史，避免「上一頁」按了沒反應
          if (page === state.currentPage && nextStock === state.selectedStock) {
            return { currentPage: page, selectedStock: nextStock };
          }
          return {
            pageHistory: [
              ...state.pageHistory.slice(-19),  // keep max 20 history items
              // 記下離開當下的捲動位置，返回時才回得到同一個地方
              { page: state.currentPage, stock: state.selectedStock, scrollY: typeof window !== 'undefined' ? window.scrollY : 0,
                anchor: page === 'stock' ? (nextStock ?? null) : null },   // 從清單點進個股 ⇒ 返回時捲到那一列
            ],
            currentPage: page,
            selectedStock: nextStock,
            pendingScrollY: null,   // 前進一律回到頂端（新頁面從頭看）
            pendingAnchor: null,
          };
        });
      },

      navigateBack: () => set((state) => {
        if (state.pageHistory.length === 0) return {};
        const prev = state.pageHistory[state.pageHistory.length - 1];
        return {
          pageHistory: state.pageHistory.slice(0, -1),
          currentPage: prev.page,
          // 精確還原來源頁的個股選取(含 null)，回到清單頁時清掉殘留的個股選取，
          // 否則「個股分析」項目會殘留、且來源頁狀態混亂
          selectedStock: prev.stock ?? null,
          pendingScrollY: prev.scrollY ?? 0,
          pendingAnchor: prev.anchor ?? null,
        };
      }),

      clearPendingScroll: () => set({ pendingScrollY: null, pendingAnchor: null }),

      setSelectedStock: (code) => set({ selectedStock: code }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setPickerTab: (tab) => set({ pickerTab: tab }),
      setDashTab: (tab) => set({ dashTab: tab }),
      setHelpSection: (v) => set({ helpSection: v }),
      setWarTab: (tab) => set({ warTab: tab }),
      // 只收合法值：persist 的舊／壞值不可讓版面落到未定義狀態（page.tsx 另以「非 classic 即 v2」兜底）
      setWarLayout: (layout) => set({ warLayout: layout === 'classic' ? 'classic' : 'v2' }),
      setWarFocus: (on) => set({ warFocus: on === true }),
      setRecommendTab: (tab) => set({ recommendTab: tab }),
      setTrackerGroupId: (id) => set({ trackerGroupId: id }),
      setAllStocks: (stocks) => set({ allStocks: stocks }),
      setLastFetchTime: (time) => set({ lastFetchTime: time }),
      tradingMode: DEFAULT_MODE,
      // 切模式時同步寫回 users/{uid}.tradingMode——daemon 的問AI 技能注入讀的是那裡，
      // 只存 localStorage 的話「網頁顯示波段、AI 卻用隔日沖口徑回答」就會發生。
      setTradingMode: (m) => {
        if (!isModeKey(m)) return;
        set({ tradingMode: m });
        // ID token 一律跟 Firebase Auth 的 currentUser 拿（store 裡的 user 是
        // 序列化過的純物件，沒有 getIdToken()）。後端只信 verifyIdToken 的 uid。
        if (get().user?.uid) {
          void (async () => {
            try {
              const { auth } = await import('./firebase');
              const token = await auth.currentUser?.getIdToken();
              if (!token) return;
              await fetch('/api/user/trading-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ mode: m }),
              });
            } catch { /* 離線或 token 拿不到時只保留本地，下次切換再同步 */ }
          })();
        }
      },
      viewAs: null,
      dataOwnerUid: null,
      enterViewAs: ({ level = null, uid = null, email = null, data }) => {
        setSyncReadOnly(true);                       // 先鎖寫入，再換資料——順序不可顛倒
        set({ viewAs: { level, uid, email, at: Date.now() }, ...(data ?? {}) });
      },
      // 結束模擬一律走「整頁重載」而不是還原快照：重載會重跑 firebase-sync，
      // 把管理員自己的資料從 Firestore 重新讀回來，不會有還原不完全的風險。
      exitViewAs: () => {
        setSyncReadOnly(false);
        set({ viewAs: null });
        if (typeof window !== 'undefined') window.location.reload();
      },
      setUser: (user) => set({ user }),
      setAuthLoading: (loading) => set({ authLoading: loading }),
      setShowAuthModal: (show) => set({ showAuthModal: show }),

      addToWatchlist: (stock) => set((state) => {
        logActivity('add_watchlist', { code: stock.code, name: stock.name });
        const updated = state.watchlist.find(w => w.code === stock.code)
          ? state.watchlist
          : [...state.watchlist, { code: stock.code, name: stock.name, addedAt: Date.now() }];
        if (state.user) syncWatchlist(state.user.uid, updated, state.watchlistGroups);
        return { watchlist: updated };
      }),

      removeFromWatchlist: (code) => set((state) => {
        logActivity('remove_watchlist', { code });
        const updated = state.watchlist.filter(w => w.code !== code);
        if (state.user) syncWatchlist(state.user.uid, updated, state.watchlistGroups);
        return { watchlist: updated };
      }),

      isInWatchlist: (code) => get().watchlist.some(w => w.code === code),

      // Watchlist Groups
      addWatchlistGroup: (name, color) => set((state) => {
        const updated = [
          ...state.watchlistGroups,
          {
            id: `group-${Date.now()}`,
            name,
            color,
            stocks: [],
            createdAt: Date.now(),
          },
        ];
        if (state.user) syncWatchlist(state.user.uid, state.watchlist, updated);
        return { watchlistGroups: updated };
      }),

      addWatchlistGroupWithStocks: (id, name, color, stocks) => set((state) => {
        const updated = [
          ...state.watchlistGroups,
          {
            id,
            name,
            color,
            stocks,
            createdAt: Date.now(),
          },
        ];
        if (state.user) syncWatchlist(state.user.uid, state.watchlist, updated);
        return { watchlistGroups: updated };
      }),

      removeWatchlistGroup: (id) => set((state) => {
        const updated = state.watchlistGroups.filter(g => g.id !== id);
        if (state.user) syncWatchlist(state.user.uid, state.watchlist, updated);
        return { watchlistGroups: updated };
      }),

      updateWatchlistGroup: (id, name, color) => set((state) => {
        const updated = state.watchlistGroups.map(g =>
          g.id === id ? { ...g, name, color } : g
        );
        if (state.user) syncWatchlist(state.user.uid, state.watchlist, updated);
        return { watchlistGroups: updated };
      }),

      addToGroup: (groupId, stock) => set((state) => {
        const updated = state.watchlistGroups.map(g =>
          g.id === groupId
            ? {
                ...g,
                stocks: g.stocks.find(s => s.code === stock.code)
                  ? g.stocks
                  : [...g.stocks, stock],
              }
            : g
        );
        if (state.user) syncWatchlist(state.user.uid, state.watchlist, updated);
        return { watchlistGroups: updated };
      }),

      removeFromGroup: (groupId, code) => set((state) => {
        const updated = state.watchlistGroups.map(g =>
          g.id === groupId
            ? { ...g, stocks: g.stocks.filter(s => s.code !== code) }
            : g
        );
        if (state.user) syncWatchlist(state.user.uid, state.watchlist, updated);
        return { watchlistGroups: updated };
      }),

      reorderGroupStocks: (groupId, fromIndex, toIndex) => set((state) => {
        const groupIndex = state.watchlistGroups.findIndex(g => g.id === groupId);
        if (groupIndex === -1) return {};
        const group = state.watchlistGroups[groupIndex];
        const stocks = [...group.stocks];
        const [removed] = stocks.splice(fromIndex, 1);
        stocks.splice(toIndex, 0, removed);

        const updatedGroups = [...state.watchlistGroups];
        updatedGroups[groupIndex] = { ...group, stocks };
        if (state.user) syncWatchlist(state.user.uid, state.watchlist, updatedGroups);
        return { watchlistGroups: updatedGroups };
      }),

      addGroupAnalysisRecord: (groupId, record) => set((state) => {
        const updated = state.watchlistGroups.map(g =>
          g.id === groupId
            ? {
                ...g,
                analysisRecords: [record, ...(g.analysisRecords || [])].slice(0, 10),
              }
            : g
        );
        if (state.user) syncWatchlist(state.user.uid, state.watchlist, updated);
        return { watchlistGroups: updated };
      }),

      addHolding: (holding) => set((state) => {
        logActivity('add_holding', { code: holding.code, buyPrice: holding.buyPrice, quantity: holding.quantity });
        const holdingId = `h-${Date.now()}`;
        const updated = [...state.holdings, { ...holding, id: holdingId }];
        if (state.user) syncHoldings(state.user.uid, updated);
        // 同步產生對應買入交易紀錄（使用者回饋：記錄持倉與交易紀錄要雙向同步——
        // 否則交易分析/資金推算漏掉這些買入）。費稅以未折讓計。
        const gross = Math.round(holding.buyPrice * holding.quantity * 1000);
        const shares = Math.round(holding.quantity * 1000);
        const fee = gross > 0 ? Math.max(shares < 1000 ? 1 : 20, Math.round(gross * 0.001425)) : 0;
        const rec: TradeRecord = {
          id: `t-${Date.now()}`, createdAt: Date.now(), holdingId,
          code: holding.code, name: holding.name, type: 'buy',
          price: holding.buyPrice, quantity: holding.quantity,
          fee, tax: 0, totalAmount: gross + fee, date: holding.buyDate,
          note: holding.note ? `${holding.note}（由記錄持倉同步）` : '（由記錄持倉同步）',
        };
        const updatedRecords = [rec, ...state.tradeRecords];
        if (state.user) syncTrades(state.user.uid, updatedRecords);
        return { holdings: updated, tradeRecords: updatedRecords };
      }),

      removeHolding: (id) => set((state) => {
        const holding = state.holdings.find(h => h.id === id);
        logActivity('remove_holding', { code: holding?.code, id });
        const updated = state.holdings.filter(h => h.id !== id);
        if (state.user) syncHoldings(state.user.uid, updated);
        // 同步刪除對應的「買入」交易紀錄（使用者定案：刪持倉＝連同該筆買入一起刪，
        // 否則現金推算殘留孤兒支出）。賣出紀錄為歷史事實不動。
        const linked = state.tradeRecords.filter(t => t.holdingId === id && t.type === 'buy');
        if (linked.length > 0) {
          const updatedRecords = state.tradeRecords.filter(t => !(t.holdingId === id && t.type === 'buy'));
          if (state.user) syncTrades(state.user.uid, updatedRecords);
          return { holdings: updated, tradeRecords: updatedRecords };
        }
        return { holdings: updated };
      }),

      updateHolding: (id, updates) => set((state) => {
        const updated = state.holdings.map(h => h.id === id ? { ...h, ...updates } : h);
        if (state.user) syncHoldings(state.user.uid, updated);
        return { holdings: updated };
      }),

      // 依交易紀錄推算結果整批重建持倉（帳本引擎對帳後的一鍵修復入口）。
      // 覆蓋整份手動持倉——呼叫端必須先讓使用者看過差異並確認。
      replaceHoldings: (items) => set((state) => {
        logActivity('replace_holdings', { count: items.length });
        const now = Date.now();
        const holdings: HoldingItem[] = items.map((h, i) => ({ ...h, id: `h-${now}-${i}` }));
        if (state.user) syncHoldings(state.user.uid, holdings);
        return { holdings };
      }),

      // 修改既有交易（修錯價/錯量用）。不動手動持倉的 FIFO 帳——
      // 改完若與持倉不一致，總覽的對帳卡會顯示差異並提供重建。
      // 存死的 realizedPnL/costBasis 一併清掉：損益顯示一律以帳本重算為準。
      updateTradeRecord: (id, updates) => set((state) => {
        const idx = state.tradeRecords.findIndex(t => t.id === id);
        if (idx === -1) return {};
        logActivity('update_trade', { id, code: state.tradeRecords[idx].code });
        const next = { ...state.tradeRecords[idx], ...updates };
        delete next.realizedPnL;
        delete next.costBasis;
        const updatedTrades = [...state.tradeRecords];
        updatedTrades[idx] = next;
        if (state.user) syncTrades(state.user.uid, updatedTrades);
        return { tradeRecords: updatedTrades };
      }),

      addTradeRecord: (record) => set((state) => {
        logActivity('add_trade', { code: record.code, type: record.type, price: record.price, quantity: record.quantity });

        let updatedHoldings = [...state.holdings];
        let newRecord = { ...record, id: `t-${Date.now()}`, createdAt: Date.now() } as TradeRecord;

        // 決策歸因快照（買入時 PIT，fire-and-forget 不影響下單）
        if (record.type === 'buy') {
          import('./analytics').then(({ captureTradeContext }) =>
            captureTradeContext({ id: newRecord.id, code: record.code, type: record.type, price: record.price, quantity: record.quantity, date: record.date }, state.compareCodes)
          ).catch(() => {});
        }
        
        if (record.type === 'buy') {
          const newHoldingId = `h-${Date.now()}`;
          newRecord.holdingId = newHoldingId;
          const newHolding: HoldingItem = {
            id: newHoldingId,
            code: record.code,
            name: record.name,
            buyPrice: record.price,
            quantity: record.quantity,
            unit: record.unit,          // 零股買進 → 持倉也以股顯示，不要進位成張
            buyDate: record.date,
            note: record.note,
          };
          updatedHoldings = [...updatedHoldings, newHolding];
        } else if (record.type === 'sell') {
          // Consume holdings (FIFO - oldest first)
          const stockHoldings = state.holdings.filter(h => h.code === record.code);
          const sortedHoldings = [...stockHoldings].sort(
            (a, b) => new Date(a.buyDate).getTime() - new Date(b.buyDate).getTime()
          );
          
          let remainingToSell = record.quantity;
          const consumedHoldings: Array<{ id: string; buyPrice: number; quantity: number; buyDate: string; note?: string }> = [];
          
          for (const h of sortedHoldings) {
            if (remainingToSell <= 0) break;
            
            const holdingIndex = updatedHoldings.findIndex(item => item.id === h.id);
            if (holdingIndex === -1) continue;
            
            const targetHolding = updatedHoldings[holdingIndex];
            
            if (targetHolding.quantity <= remainingToSell) {
              consumedHoldings.push({
                id: targetHolding.id,
                buyPrice: targetHolding.buyPrice,
                quantity: targetHolding.quantity,
                buyDate: targetHolding.buyDate,
                note: targetHolding.note,
              });
              remainingToSell -= targetHolding.quantity;
              updatedHoldings.splice(holdingIndex, 1);
            } else {
              consumedHoldings.push({
                id: targetHolding.id,
                buyPrice: targetHolding.buyPrice,
                quantity: remainingToSell,
                buyDate: targetHolding.buyDate,
                note: targetHolding.note,
              });
              updatedHoldings[holdingIndex] = {
                ...targetHolding,
                quantity: targetHolding.quantity - remainingToSell,
              };
              remainingToSell = 0;
            }
          }
          if (consumedHoldings.length > 0) {
            newRecord.consumedHoldings = consumedHoldings;
          }
        }
        
        const updatedTrades = [newRecord, ...state.tradeRecords];
        if (state.user) {
          syncTrades(state.user.uid, updatedTrades);
          syncHoldings(state.user.uid, updatedHoldings);
        }
        return { tradeRecords: updatedTrades, holdings: updatedHoldings };
      }),
 
      removeTradeRecord: (id) => set((state) => {
        const trade = state.tradeRecords.find(t => t.id === id);
        logActivity('remove_trade', { code: trade?.code, id });
        const updatedTrades = state.tradeRecords.filter(t => t.id !== id);
        
        let updatedHoldings = [...state.holdings];
        if (trade) {
          if (trade.type === 'buy') {
            if (trade.holdingId) {
              updatedHoldings = updatedHoldings.filter(h => h.id !== trade.holdingId);
            } else {
              // Fallback for older buy trade records without holdingId
              const idx = updatedHoldings.findIndex(h =>
                h.code === trade.code &&
                h.buyPrice === trade.price &&
                h.quantity === trade.quantity &&
                h.buyDate === trade.date
              );
              if (idx !== -1) {
                updatedHoldings.splice(idx, 1);
              }
            }
          } else if (trade.type === 'sell' && trade.consumedHoldings) {
            // Restore consumed holdings
            trade.consumedHoldings.forEach(ch => {
              const existingIndex = updatedHoldings.findIndex(h => h.id === ch.id);
              if (existingIndex !== -1) {
                updatedHoldings[existingIndex] = {
                  ...updatedHoldings[existingIndex],
                  quantity: updatedHoldings[existingIndex].quantity + ch.quantity,
                };
              } else {
                updatedHoldings.push({
                  id: ch.id,
                  code: trade.code,
                  name: trade.name,
                  buyPrice: ch.buyPrice,
                  quantity: ch.quantity,
                  buyDate: ch.buyDate,
                  note: ch.note,
                });
              }
            });
          }
        }
        
        if (state.user) {
          syncTrades(state.user.uid, updatedTrades);
          syncHoldings(state.user.uid, updatedHoldings);
        }
        return { tradeRecords: updatedTrades, holdings: updatedHoldings };
      }),

      // 價位警示：本機先改、雲端以單一 id 操作寫入 priceAlerts（不再整份覆寫；見上方 writePriceAlertOp）
      addAlert: (alert) => set((state) => {
        logActivity('add_alert', { code: alert.code, type: alert.type, value: alert.value });
        const item: AlertItem = { ...alert, id: `a-${Date.now()}`, triggered: false, createdAt: Date.now() };
        if (state.user) void writePriceAlertOp(state.user.uid, { kind: 'add', item });
        return { alerts: [...state.alerts, item] };
      }),

      removeAlert: (id) => set((state) => {
        const alert = state.alerts.find(a => a.id === id);
        logActivity('remove_alert', { code: alert?.code, type: alert?.type, id });
        if (state.user) void writePriceAlertOp(state.user.uid, { kind: 'remove', id });
        return { alerts: state.alerts.filter(a => a.id !== id) };
      }),

      triggerAlert: (id) => set((state) => {
        if (state.user) void writePriceAlertOp(state.user.uid, { kind: 'trigger', id });
        return { alerts: state.alerts.map(a => a.id === id ? { ...a, triggered: true } : a) };
      }),

      addNotification: (n) => set((state) => {
        const updated = [
          {
            ...n,
            id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            timestamp: Date.now(),
            read: false,
          },
          ...state.notifications,
        ].slice(0, 100);
        if (state.user) syncNotifications(state.user.uid, updated);
        return { notifications: updated };
      }),

      markNotificationRead: (id) => set((state) => {
        const updated = state.notifications.map(n =>
          n.id === id ? { ...n, read: true } : n
        );
        if (state.user) syncNotifications(state.user.uid, updated);
        return { notifications: updated };
      }),

      clearAllNotifications: () => set((state) => {
        if (state.user) syncNotifications(state.user.uid, []);
        return { notifications: [] };
      }),

      setChartPeriod: (period) => set({ chartPeriod: period }),

      toggleIndicator: (indicator) => set((state) => ({
        activeIndicators: state.activeIndicators.includes(indicator)
          ? state.activeIndicators.filter(i => i !== indicator)
          : [...state.activeIndicators, indicator]
      })),
    }),
    {
      name: 'tw-stock-app-storage',
      // ⚠**必須 skipHydration**（2026-08-06 修·React error #418 整站白畫面的根因）：
      //   預設行為是在**模組載入時同步**把 localStorage 套進 store，於是
      //   伺服器端渲染用的是預設值、瀏覽器第一次渲染用的是已存狀態 → 兩邊 HTML 不一致
      //   → React 判定 hydration 失敗並中止整棵樹 → 使用者看到
      //     「Application error: a client-side exception has occurred」。
      //   ⇒ 改為**掛載後才手動 rehydrate**（見 app/page.tsx 的 useAppStore.persist.rehydrate()），
      //     讓 SSR 與 client 的第一次渲染都用預設值，之後再換上本機狀態。
      //   代價：載入瞬間可能閃一下預設自選清單——遠比整站崩潰可接受。
      //   ⚠這也解釋了「常常出現」：**用過 app 的人（有自選/改過模式）必中，新訪客不會**。
      skipHydration: true,
      // ⚠模擬期間**不得持久化任何屬於他人的資料**：否則重新整理後 viewAs 已清空、
      //   localStorage 卻留著會員的持倉，會被當成管理員自己的並同步回其帳號。
      // warLayout／warFocus 是本機版面偏好（不是任何人的資料），模擬期間也照常保存。
      partialize: (state) => (state.viewAs ? { tradingMode: state.tradingMode, warLayout: state.warLayout, warFocus: state.warFocus } : {
        tradingMode: state.tradingMode,
        warLayout: state.warLayout,
        warFocus: state.warFocus,
        dataOwnerUid: state.dataOwnerUid,
        watchlist: state.watchlist,
        watchlistGroups: state.watchlistGroups,
        holdings: state.holdings,
        tradeRecords: state.tradeRecords,
        alerts: state.alerts,
        notifications: state.notifications,
        chartPeriod: state.chartPeriod,
        activeIndicators: state.activeIndicators,
        compareCodes: state.compareCodes,
        compareBudget: state.compareBudget,
        compareProfitTarget: state.compareProfitTarget,
        compareProfitTargetType: state.compareProfitTargetType,
        compareTradeDuration: state.compareTradeDuration,
        compareLotType: state.compareLotType,
        compareSelectedGroupId: state.compareSelectedGroupId,
      }) as never,
    }
  )
);

// ── 登入後換上 priceAlerts（2026-10-05·critique H3）──────────────────────────────────────
// firebase-sync 每次登入（含重新整理）先把舊 alerts 文件的整份陣列放進 store.alerts，最後才呼叫 setUser
// （setUser 只有 firebase-sync 會呼叫，每次都是新物件）。所以 user 物件一換，就以 priceAlerts 取代 store.alerts 中的價位警示：
// 不存在就一次性遷移，舊文件殘留的價位警示副本同交易移除。空窗內 store.alerts 仍是舊陣列也無妨——
// 雲端寫入一律是單一 id 的交易操作，不會拿它整份覆寫。身分模擬中（唯讀）不讀不寫，維持模擬資料。
let _priceAlertsLoadSeq = 0;
async function loadPriceAlerts(uid: string): Promise<void> {
  if (_syncReadOnly || !firestoreReady()) return;
  const seq = ++_priceAlertsLoadSeq;
  try {
    const list = await syncPriceAlerts(uid, null);
    const st = useAppStore.getState();
    // 載入期間換了帳號、登出或進入身分模擬 ⇒ 丟棄這次結果
    if (seq !== _priceAlertsLoadSeq || st.user?.uid !== uid || st.viewAs || _syncReadOnly) return;
    // 只換掉價位警示；firebase-sync 載入的 daemon 警示項目保留（即時追蹤頁 🔔 沿用舊行為），它們不會被寫回雲端
    const next = withPriceAlerts<AlertItem>(st.alerts, list);
    // 內容沒變就不換參照：AlertEngine 的輪詢 effect 依賴 alerts 陣列參照，換了會立刻多抓一次 stock-day-all（每次登入／重新整理）
    if (JSON.stringify(next) === JSON.stringify(st.alerts)) return;
    useAppStore.setState({ alerts: next });
  } catch (e) {
    console.error('[priceAlerts] 載入／遷移失敗（本次維持登入時的清單；寫入仍只走單一 id 交易）:', e);
  }
}

if (typeof window !== 'undefined') {
  useAppStore.subscribe((state, prev) => {
    if (state.user === prev.user) return;
    if (state.user?.uid) void loadPriceAlerts(state.user.uid);
    else _priceAlertsLoadSeq++;   // 登出：作廢進行中的載入
  });
}
