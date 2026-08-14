'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { useDataUid, canWriteUserData } from './view-as';
import { DEFAULT_BROKER, type BrokerSettings } from './tw-fee';

// 券商成本設定（手續費折讓/最低手續費）。
// 2026-08-14 改存 Firestore（users/{uid}/data/cashLedger.broker）——原本存
// localStorage 是裝置本機偏好，手機/桌機各設各的，一台對了另一台照樣用全額
// 費率算錯交割金額（實案：券商 2.8 折，未設折讓的裝置每天交割試算多上萬元）。
// localStorage 保留為快取與未登入 fallback；首次登入時若雲端沒有而本機有，自動上傳。
const KEY = 'brokerSettings';

function readLocal(): BrokerSettings | null {
  if (typeof window === 'undefined') return null;
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s || typeof s !== 'object') return null;
    return { discount: s.discount ?? DEFAULT_BROKER.discount, minFee: s.minFee ?? DEFAULT_BROKER.minFee };
  } catch { return null; }
}

export function readBrokerSettings(): BrokerSettings {
  return readLocal() ?? DEFAULT_BROKER;
}

export function useBrokerSettings(): [BrokerSettings, (s: BrokerSettings) => void] {
  const dataUid = useDataUid();   // 模擬中＝被模擬者——費率要用「資料主人」的，金額才對
  const [settings, setSettings] = useState<BrokerSettings>(DEFAULT_BROKER);

  useEffect(() => {
    // 未登入/無 Firestore：退回 localStorage
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') {
      setSettings(readBrokerSettings());
      return;
    }
    const ref = doc(db, 'users', dataUid, 'data', 'cashLedger');
    const unsub = onSnapshot(ref, snap => {
      const b = snap.exists() ? (snap.data() as { broker?: Partial<BrokerSettings> }).broker : null;
      if (b && typeof b.discount === 'number') {
        const s = { discount: b.discount, minFee: b.minFee ?? DEFAULT_BROKER.minFee };
        setSettings(s);
        try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
      } else {
        // 雲端沒有 → 本機有就用並上傳（一次性遷移），都沒有用預設
        const local = readLocal();
        setSettings(local ?? DEFAULT_BROKER);
        if (local && canWriteUserData()) {
          setDoc(ref, { broker: local, updatedAt: Date.now() }, { merge: true }).catch(() => {});
        }
      }
    }, () => { setSettings(readBrokerSettings()); });
    return () => unsub();
  }, [dataUid]);

  const save = (s: BrokerSettings) => {
    setSettings(s);
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
    if (dataUid && db && typeof (db as { type?: unknown }).type !== 'undefined' && canWriteUserData()) {
      setDoc(doc(db, 'users', dataUid, 'data', 'cashLedger'), { broker: s, updatedAt: Date.now() }, { merge: true }).catch(() => {});
    }
  };
  return [settings, save];
}
