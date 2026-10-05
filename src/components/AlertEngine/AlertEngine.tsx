'use client';

import { useEffect, useRef, useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import { useAppStore } from '@/lib/store';
import type { AppNotification, AlertItem, WatchlistGroup } from '@/lib/store';
import { shouldPollNow, revealTick } from '@/lib/market-clock';
import { publishWarEvent, type WarEventInput } from '@/components/WarRoomV2/events';
import {
  isWarBusActive, subscribeWarBus, getWarBusState, registerWarFastCodes, clearWarFastCodes,
} from '@/components/WarRoomV2/useWarRoomBus';
import styles from './AlertEngine.module.css';

type NotificationInput = Omit<AppNotification, 'id' | 'timestamp' | 'read'>;

// ── 盤中戰情 v2（2026-10-05·critique C1 第 4 點）：戰情 v2 頁改吃匯流排快層報價，不再每 30 秒抓全市場 stock-day-all（約 650KB）──
// 匯流排運作中（WarRoomProvider 掛載＝在戰情 v2 頁且有資格）時，把要評估的代號（未觸發的價位警示＋自選群組）以 owner 'alerts'
// 登記到快層（上限 WAR_ALERT_FAST_MAX；快層 40 檔名額中 'alerts' 優先序最低，不會擠掉持股 'mine' 與快看抽屜 'drawer'）。
// 每輪評估時：匯流排已有的代號直接用；缺的（超過上限、名額被排在後面、尚未抓到）只補抓那幾檔
//   （/api/twse/mis-quote?nv=1，每批 ≤50 檔、最多 WAR_ALERT_FILL_MAX 檔）；缺太多或有英數代號（mis-quote 不收）才照舊抓 stock-day-all。
// 其他頁行為完全不變。
const WAR_ALERT_OWNER = 'alerts';
const WAR_ALERT_FAST_MAX = 20;
const MIS_QUOTE_BATCH = 50;          // /api/twse/mis-quote 每次最多 50 檔（路由端截斷）
const WAR_ALERT_FILL_MAX = 150;      // 補抓上限（3 批）；更多就退回整份 stock-day-all（一次請求比多批小請求划算）
const MIS_CODE_RE = /^\d{4,6}$/;    // 與 mis-quote 路由的白名單同口徑
const FETCH_TIMEOUT_MS = 8_000;
const PRICE_ALERT_TYPES: ReadonlySet<string> = new Set(['PRICE_ABOVE', 'PRICE_BELOW', 'CHANGE_ABOVE', 'CHANGE_BELOW']);

type StockTick = { code: string; name: string; price: number; change: number; changePercent: number; volume: number };

/**
 * 這一輪要評估的代號（未觸發的價位警示＋自選群組；去重、排序——當作 effect 依賴的穩定鍵）。
 * 在 render 階段跑、資料來自 Firestore（firebase-sync 只做 `|| []`，不逐項正規化）⇒ 形狀不對的群組／個股／警示一律略過，
 * 不讓一筆髒資料把全站常駐的 AlertEngine 弄掛（不信任外部資料）。
 */
function alertWatchCodes(alerts: readonly AlertItem[], groups: readonly WatchlistGroup[]): string[] {
  const set = new Set<string>();
  for (const a of Array.isArray(alerts) ? alerts : []) {
    if (a && !a.triggered && PRICE_ALERT_TYPES.has(a.type) && typeof a.code === 'string' && a.code) set.add(a.code);
  }
  for (const g of Array.isArray(groups) ? groups : []) {
    const stocks = Array.isArray(g?.stocks) ? g.stocks : [];
    for (const s of stocks) if (s && typeof s.code === 'string' && s.code) set.add(s.code);
  }
  return [...set].sort();
}

/** 戰情 v2：匯流排已有的報價＋缺的代號；匯流排沒在跑回 null（呼叫端照舊抓 stock-day-all） */
function warBusCoverage(codes: readonly string[]): { map: Record<string, StockTick>; missing: string[] } | null {
  if (!isWarBusActive()) return null;
  const quotes = getWarBusState().quotes;
  const map: Record<string, StockTick> = {};
  const missing: string[] = [];
  for (const c of codes) {
    const q = quotes[c];
    if (!q || !(q.price > 0)) { missing.push(c); continue; }
    map[c] = { code: c, name: q.name, price: q.price, change: q.change, changePercent: q.changePercent, volume: q.volume };
  }
  return { map, missing };
}

/** 只補抓匯流排缺的幾檔（nv=1：不登記瀏覽中、不佔 daemon 快線名額）。不適合補抓（太多、有英數代號）或失敗回 null */
async function fetchMissingQuotes(codes: readonly string[]): Promise<Record<string, StockTick> | null> {
  if (codes.length > WAR_ALERT_FILL_MAX || codes.some(c => !MIS_CODE_RE.test(c))) return null;
  const sorted = [...codes].sort();
  const batches: string[][] = [];
  for (let i = 0; i < sorted.length; i += MIS_QUOTE_BATCH) batches.push(sorted.slice(i, i + MIS_QUOTE_BATCH));
  const tick = revealTick();
  try {
    const results = await Promise.all(batches.map(async (b) => {
      const r = await fetch(`/api/twse/mis-quote?codes=${b.join(',')}&nv=1&t=${tick}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) throw new Error(`mis-quote ${r.status}`);
      return r.json() as Promise<{ quotes?: unknown }>;
    }));
    const map: Record<string, StockTick> = {};
    for (const j of results) {
      if (!Array.isArray(j?.quotes)) return null;
      for (const raw of j.quotes as Array<Record<string, unknown>>) {
        const code = typeof raw?.code === 'string' ? raw.code : '';
        const price = Number(raw?.price);
        if (!code || !(price > 0)) continue;
        map[code] = {
          code, name: typeof raw.name === 'string' ? raw.name : code, price,
          change: Number(raw.change) || 0, changePercent: Number(raw.changePercent) || 0, volume: Number(raw.volume) || 0,
        };
      }
    }
    return map;
  } catch {
    return null;   // 補抓失敗：這一輪退回 stock-day-all，不漏評估
  }
}

// ── 盤中戰情 v2（2026-10-05）：戰情 v2 頁不疊 toast（plan「不做全頁閃爍，也不疊 toast」），改送戰情事件匯流排 ──
// 只在「目前在戰情頁、版面是 v2、而且 v2 已掛載（匯流排運作中＝有資格、不是會員鎖畫面）」時改道；其他頁行為完全不變。
// 等級（使用者裁定第 8 題）：自選觸價＝二級；自選漲跌幅 ≥9.9%（這裡是 stock-day-all 的近似口徑，不是 marketPulse 的檔位口徑，
// 所以標「我的」而不叫「首觸漲停」）、量能異常＝二級；開盤前提醒＝三級。文案只寫代號與事件，不寫自設價。
const stripEmoji = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, '').trim();

function toWarEvent(n: NotificationInput): WarEventInput {
  const who = `${n.stockCode} ${n.stockName}`.trim();
  const at = Date.now();
  const code = n.stockCode || undefined;
  switch (n.type) {
    case 'price_alert':
      return { at, kind: 'watchPrice', level: 2, code, mine: true, text: `${who} ${stripEmoji(n.message)}（自設）` };
    case 'limit_up':
      return { at, kind: 'mine', level: 2, code, mine: true, text: `${who} 自選漲幅達 9.9% 以上` };
    case 'limit_down':
      return { at, kind: 'mine', level: 2, code, mine: true, text: `${who} 自選跌幅達 9.9% 以上` };
    case 'volume_alert':
      return { at, kind: 'mine', level: 2, code, mine: true, text: `${who} 自選成交量為近期均量 3 倍以上` };
    case 'premarket_reminder':
      return { at, kind: 'info', level: 3, text: '台股 09:00 開盤' };
    default:
      return { at, kind: 'mine', level: 2, code, mine: true, text: `${who} ${stripEmoji(n.message)}`.trim() };
  }
}

interface ToastItem {
  id: string;
  notification: AppNotification;
  exiting: boolean;
}

// Icons for each severity / type
function SeverityIcon({ severity }: { severity: AppNotification['severity'] }) {
  if (severity === 'critical') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );
  }
  if (severity === 'warning') {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function Toast({ item, onClose }: { item: ToastItem; onClose: (id: string) => void }) {
  return (
    <div
      className={`${styles.toast} ${styles[item.notification.severity]} ${item.exiting ? styles.toastExit : styles.toastEnter}`}
      role="alert"
    >
      <div className={styles.toastIcon}>
        <SeverityIcon severity={item.notification.severity} />
      </div>
      <div className={styles.toastBody}>
        <div className={styles.toastTitle}>{item.notification.message}</div>
        <div className={styles.toastDetail}>{item.notification.detail}</div>
        {item.notification.stockCode && (
          <div className={styles.toastStock}>{item.notification.stockCode} · {item.notification.stockName}</div>
        )}
      </div>
      <button
        className={styles.toastClose}
        onClick={() => onClose(item.id)}
        aria-label="關閉通知"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

// Track volume history per stock (5-day window estimate)
const volumeHistory: Record<string, number[]> = {};
// Track which alerts have been fired to avoid duplicates within same poll cycle
const firedAlertIds = new Set<string>();
// Track which limit events have been sent
const firedLimitCodes = new Set<string>();
// Track if premarket reminder was sent today
let lastPremarketDate = '';

export default function AlertEngine() {
  const alerts = useAppStore(s => s.alerts);
  const watchlistGroups = useAppStore(s => s.watchlistGroups);
  const addNotification = useAppStore(s => s.addNotification);
  const triggerAlert = useAppStore(s => s.triggerAlert);
  const currentPage = useAppStore(s => s.currentPage);
  const warLayout = useAppStore(s => s.warLayout);
  // 用 ref 傳給 fireNotification：不讓換頁改變 fireNotification 的參照（否則輪詢 effect 會重掛並立刻多抓一次 stock-day-all）
  const onWarV2Ref = useRef(false);
  useEffect(() => { onWarV2Ref.current = currentPage === 'war' && warLayout !== 'classic'; }, [currentPage, warLayout]);

  // 戰情 v2：要評估的代號登記到匯流排快層（只在匯流排運作中；離開戰情頁＝Provider 卸載＝active 轉 false ⇒ 撤銷登記）
  const warBusActive = useSyncExternalStore(subscribeWarBus, isWarBusActive, () => false);
  const watchKey = useMemo(() => alertWatchCodes(alerts, watchlistGroups).join(','), [alerts, watchlistGroups]);
  useEffect(() => {
    const codes = watchKey ? watchKey.split(',') : [];
    if (!warBusActive || codes.length > WAR_ALERT_FAST_MAX) {
      clearWarFastCodes(WAR_ALERT_OWNER);   // 超過上限不登記：每輪只補抓缺的代號（太多才退回 stock-day-all），不漏評估
      return undefined;
    }
    registerWarFastCodes(WAR_ALERT_OWNER, codes);
    return () => clearWarFastCodes(WAR_ALERT_OWNER);
  }, [warBusActive, watchKey]);

  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const pushToast = useCallback((notification: AppNotification) => {
    const toastItem: ToastItem = {
      id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      notification,
      exiting: false,
    };

    setToasts(prev => {
      const next = [toastItem, ...prev].slice(0, 3);
      return next;
    });

    // Auto-dismiss after 3s
    setTimeout(() => {
      setToasts(prev =>
        prev.map(t => t.id === toastItem.id ? { ...t, exiting: true } : t)
      );
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== toastItem.id));
      }, 400);
    }, 3000);
  }, []);

  const closeToast = useCallback((id: string) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 400);
  }, []);

  const fireNotification = useCallback((notif: NotificationInput) => {
    addNotification(notif);
    if (onWarV2Ref.current && isWarBusActive()) {
      publishWarEvent(toWarEvent(notif));   // 戰情 v2：進 B2 異動流紀錄，不跳 toast
      return;
    }
    // Build a full notification to pass to toast (id/timestamp will be set by store, we fake it here for display)
    const fakeNotif: AppNotification = {
      ...notif,
      id: `fake-${Date.now()}`,
      timestamp: Date.now(),
      read: false,
    };
    pushToast(fakeNotif);
  }, [addNotification, pushToast]);

  // Premarket reminder checker
  useEffect(() => {
    const checkPremarket = () => {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const day = now.getDay(); // 0=Sun, 6=Sat
      const dateKey = now.toDateString();
      const isWeekday = day >= 1 && day <= 5;

      if (isWeekday && hours === 8 && minutes >= 25 && minutes < 27 && dateKey !== lastPremarketDate) {
        lastPremarketDate = dateKey;
        fireNotification({
          type: 'premarket_reminder',
          stockCode: '',
          stockName: '',
          message: '⏰ 開盤前提醒',
          detail: '台股即將在 09:00 開盤，請注意您的自選股和警報設定。',
          severity: 'info',
        });
      }
    };

    const interval = setInterval(checkPremarket, 60_000);
    checkPremarket();
    return () => clearInterval(interval);
  }, [fireNotification]);

  // Main polling engine — every 30 seconds
  useEffect(() => {
    const poll = async () => {
      // 休市或分頁在背景就跳過。這支回應約 650KB，原本 24/7 每 30 秒打一次，
      // 其中約 81% 落在資料完全不會變的時段。
      if (!shouldPollNow()) return;
      try {
        // 戰情 v2：匯流排已有的直接用、缺的只補抓那幾檔 ⇒ 不抓 stock-day-all（補不了才退回）
        let fromBus: Record<string, StockTick> | null = null;
        const cov = warBusCoverage(alertWatchCodes(alerts, watchlistGroups));
        if (cov) {
          if (!cov.missing.length) fromBus = cov.map;
          else {
            const filled = await fetchMissingQuotes(cov.missing);
            if (filled) fromBus = { ...cov.map, ...filled };
          }
        }
        const stockMap: Record<string, StockTick> = fromBus ?? {};

        if (!fromBus) {
          const res = await fetch('/api/twse/stock-day-all', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
          if (!res.ok) return;
          const data = await res.json();

          // data is expected to be an array of stock objects
          // Each item typically has: code, name, closingPrice, change, changePercent, volume, etc.
          if (Array.isArray(data)) {
            for (const item of data) {
              const code = item.Code || item.code || item['證券代號'];
              const name = item.Name || item.name || item['證券名稱'];
              const price = parseFloat(item.ClosingPrice || item.closingPrice || item['收盤價'] || '0');
              const change = parseFloat(item.Change || item.change || item['漲跌價差'] || '0');
              const volume = parseFloat(item.TradeVolume || item.tradeVolume || item['成交股數'] || '0');
              const changePercent = price > 0 && change !== 0
                ? (change / (price - change)) * 100
                : 0;

              if (code && !isNaN(price)) {
                stockMap[code] = { code, name, price, change, changePercent, volume };
              }
            }
          }
        }

        // Check price alerts
        for (const alert of alerts) {
          if (alert.triggered || firedAlertIds.has(alert.id)) continue;
          const stock = stockMap[alert.code];
          if (!stock) continue;

          let triggered = false;
          let message = '';
          let detail = '';
          let severity: AppNotification['severity'] = 'warning';

          if (alert.type === 'PRICE_ABOVE' && stock.price >= alert.value) {
            triggered = true;
            message = `📈 價格突破警報`;
            detail = `${alert.name}（${alert.code}）現價 $${stock.price.toFixed(2)} 已超過設定的 $${alert.value}`;
            severity = 'warning';
          } else if (alert.type === 'PRICE_BELOW' && stock.price <= alert.value) {
            triggered = true;
            message = `📉 價格跌破警報`;
            detail = `${alert.name}（${alert.code}）現價 $${stock.price.toFixed(2)} 已低於設定的 $${alert.value}`;
            severity = 'critical';
          } else if (alert.type === 'CHANGE_ABOVE' && stock.changePercent >= alert.value) {
            triggered = true;
            message = `🚀 漲幅警報`;
            detail = `${alert.name}（${alert.code}）今日漲幅 +${stock.changePercent.toFixed(2)}% 超過設定值`;
            severity = 'warning';
          } else if (alert.type === 'CHANGE_BELOW' && stock.changePercent <= alert.value) {
            triggered = true;
            message = `⚠ 跌幅警報`;
            detail = `${alert.name}（${alert.code}）今日跌幅 ${stock.changePercent.toFixed(2)}% 超過設定值`;
            severity = 'critical';
          }

          if (triggered) {
            firedAlertIds.add(alert.id);
            triggerAlert(alert.id);
            fireNotification({
              type: 'price_alert',
              stockCode: alert.code,
              stockName: alert.name,
              message,
              detail,
              severity,
            });
          }
        }

        // Check watchlist groups for limit-up/limit-down and volume anomaly
        const allGroupStocks = watchlistGroups.flatMap(g => g.stocks);
        const uniqueStocks = Array.from(new Map(allGroupStocks.map(s => [s.code, s])).values());

        for (const ws of uniqueStocks) {
          const stock = stockMap[ws.code];
          if (!stock) continue;

          const limitKey = `${ws.code}-${new Date().toDateString()}`;

          // Limit-up detection (>= 9.9%)
          if (stock.changePercent >= 9.9 && !firedLimitCodes.has(`up-${limitKey}`)) {
            firedLimitCodes.add(`up-${limitKey}`);
            fireNotification({
              type: 'limit_up',
              stockCode: ws.code,
              stockName: ws.name,
              message: `🔥 漲停板！`,
              detail: `${ws.name}（${ws.code}）今日漲停，漲幅 +${stock.changePercent.toFixed(2)}%`,
              severity: 'critical',
            });
          }

          // Limit-down detection (<= -9.9%)
          if (stock.changePercent <= -9.9 && !firedLimitCodes.has(`down-${limitKey}`)) {
            firedLimitCodes.add(`down-${limitKey}`);
            fireNotification({
              type: 'limit_down',
              stockCode: ws.code,
              stockName: ws.name,
              message: `🧊 跌停板！`,
              detail: `${ws.name}（${ws.code}）今日跌停，跌幅 ${stock.changePercent.toFixed(2)}%`,
              severity: 'critical',
            });
          }

          // Volume anomaly detection (> 3x 5-day average)
          if (!volumeHistory[ws.code]) volumeHistory[ws.code] = [];
          const hist = volumeHistory[ws.code];

          if (hist.length >= 2) {
            const avgVol = hist.slice(-5).reduce((a, b) => a + b, 0) / Math.min(hist.length, 5);
            const volKey = `vol-${limitKey}`;
            if (avgVol > 0 && stock.volume > avgVol * 3 && !firedLimitCodes.has(volKey)) {
              firedLimitCodes.add(volKey);
              fireNotification({
                type: 'volume_alert',
                stockCode: ws.code,
                stockName: ws.name,
                message: `📊 量能異常`,
                detail: `${ws.name}（${ws.code}）今日成交量 ${(stock.volume / 1000).toFixed(0)}千股，為近期均量的 ${(stock.volume / avgVol).toFixed(1)} 倍`,
                severity: 'warning',
              });
            }
          }

          // Update history
          if (stock.volume > 0) {
            hist.push(stock.volume);
            if (hist.length > 10) hist.shift();
          }
        }
      } catch (_err) {
        // Silently ignore polling errors
      }
    };

    // Poll immediately then every 30s
    poll();
    const interval = setInterval(poll, 30_000);
    return () => clearInterval(interval);
  }, [alerts, watchlistGroups, fireNotification, triggerAlert]);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.toastContainer} aria-live="polite" aria-atomic="false">
      {toasts.map(item => (
        <Toast key={item.id} item={item} onClose={closeToast} />
      ))}
    </div>
  );
}
