'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useAppStore } from '@/lib/store';
import type { AppNotification } from '@/lib/store';
import { shouldPollNow } from '@/lib/market-clock';
import styles from './AlertEngine.module.css';

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

  const fireNotification = useCallback((notif: Omit<AppNotification, 'id' | 'timestamp' | 'read'>) => {
    addNotification(notif);
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
        const res = await fetch('/api/twse/stock-day-all');
        if (!res.ok) return;
        const data = await res.json();

        // data is expected to be an array of stock objects
        // Each item typically has: code, name, closingPrice, change, changePercent, volume, etc.
        const stockMap: Record<string, {
          code: string;
          name: string;
          price: number;
          change: number;
          changePercent: number;
          volume: number;
        }> = {};

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
