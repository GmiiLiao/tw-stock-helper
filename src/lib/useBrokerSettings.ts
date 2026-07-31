'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_BROKER, type BrokerSettings } from './tw-fee';

// 券商成本設定（手續費折讓/最低手續費）——裝置本機偏好，存 localStorage。
const KEY = 'brokerSettings';

export function readBrokerSettings(): BrokerSettings {
  if (typeof window === 'undefined') return DEFAULT_BROKER;
  try { const s = JSON.parse(localStorage.getItem(KEY) || '{}'); return { discount: s.discount ?? DEFAULT_BROKER.discount, minFee: s.minFee ?? DEFAULT_BROKER.minFee }; }
  catch { return DEFAULT_BROKER; }
}

export function useBrokerSettings(): [BrokerSettings, (s: BrokerSettings) => void] {
  const [settings, setSettings] = useState<BrokerSettings>(DEFAULT_BROKER);
  useEffect(() => { setSettings(readBrokerSettings()); }, []);
  const save = (s: BrokerSettings) => {
    setSettings(s);
    try { localStorage.setItem(KEY, JSON.stringify(s)); window.dispatchEvent(new Event('broker-settings')); } catch { /* ignore */ }
  };
  // 跨元件同步
  useEffect(() => {
    const h = () => setSettings(readBrokerSettings());
    window.addEventListener('broker-settings', h);
    return () => window.removeEventListener('broker-settings', h);
  }, []);
  return [settings, save];
}
