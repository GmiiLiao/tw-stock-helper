import { useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { useAppStore } from './store';

export function useFirebaseSync() {
  const setUser = useAppStore((s) => s.setUser);
  const setAuthLoading = useAppStore((s) => s.setAuthLoading);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setAuthLoading(true);

      if (firebaseUser) {
        const uid = firebaseUser.uid;

        // ⚠**會員等級只能讀、不能由登入流程回寫**（2026-08-06 修）：
        //   舊版是 `let currentLevel = 'registered'` → 讀失敗就維持 'registered'
        //   → 接著 setDoc({ level: currentLevel }, {merge:true}) **把真實等級蓋掉**。
        //   一次網路抖動就能讓付費會員被靜默降級成 registered，而且**不會自己好**
        //   （下次登入讀到的就是被蓋掉的 registered），症狀＝盤中戰情消失、
        //   投資組合的 AI 持倉分析變 🔒、daemon 也不再為他產生分析/警報/週報。
        //   規則：level 只在「這個帳號第一次建檔」時寫入，其餘情況一律不碰。
        let currentLevel = 'registered';
        let isNewAccount = false;
        if (firebaseUser.email === 'nicholas@gmii.tw') {
          currentLevel = 'superadmin';
        } else {
          const readLevel = async () => {
            const snap = await getDoc(doc(db, 'users', uid));
            return snap.exists() ? { found: true, level: snap.data().level || 'registered' } : { found: false, level: 'registered' };
          };
          try {
            const r = await readLevel();
            currentLevel = r.level; isNewAccount = !r.found;
          } catch {
            // 讀失敗重試一次；仍失敗則**維持未知**——UI 暫以 registered 呈現（fail-closed），
            // 但絕不寫回 Firestore，等下次登入自然恢復。
            try {
              const r = await readLevel();
              currentLevel = r.level; isNewAccount = !r.found;
            } catch (err) {
              console.warn('讀取會員等級失敗，本次不寫回 level（避免誤降級）:', err);
            }
          }
        }

        // 1. Sync user profile to root /users collection (for Admin Panel query)
        //    ⚠與下方資料載入**分開 try**：舊版共用一個 try，profile 寫入一失敗，
        //    後面 watchlist/holdings/trades 的載入會整段被跳過＝投資組合看起來全空。
        try {
          const profile: Record<string, unknown> = {
            uid,
            email: firebaseUser.email,
            displayName: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
            lastLogin: Date.now(),
          };
          if (isNewAccount) profile.level = currentLevel;   // 只有全新帳號才寫等級
          await setDoc(doc(db, 'users', uid), profile, { merge: true });
        } catch (e) {
          console.error('同步使用者 profile 失敗（不影響資料載入）:', e);
        }

        try {
          // 2. Fetch user stock data from Firestore
          const [watchlistSnap, holdingsSnap, alertsSnap, notificationsSnap, tradesSnap] = await Promise.all([
            getDoc(doc(db, 'users', uid, 'data', 'watchlist')),
            getDoc(doc(db, 'users', uid, 'data', 'holdings')),
            getDoc(doc(db, 'users', uid, 'data', 'alerts')),
            getDoc(doc(db, 'users', uid, 'data', 'notifications')),
            getDoc(doc(db, 'users', uid, 'data', 'trades')),
          ]);

          const store = useAppStore.getState();

          // watchlist sync
          if (watchlistSnap.exists()) {
            const data = watchlistSnap.data();
            useAppStore.setState({
              watchlist: data.watchlist || [],
              watchlistGroups: data.watchlistGroups || [],
            });
          } else {
            // New user: upload current local guest watchlist
            await setDoc(doc(db, 'users', uid, 'data', 'watchlist'), {
              watchlist: store.watchlist,
              watchlistGroups: store.watchlistGroups,
            });
          }

          // holdings sync
          if (holdingsSnap.exists()) {
            const data = holdingsSnap.data();
            useAppStore.setState({ holdings: data.holdings || [] });
          } else {
            // New user: upload guest holdings
            await setDoc(doc(db, 'users', uid, 'data', 'holdings'), {
              holdings: store.holdings,
            });
          }

          // alerts sync
          if (alertsSnap.exists()) {
            const data = alertsSnap.data();
            useAppStore.setState({ alerts: data.alerts || [] });
          } else {
            // New user: upload guest alerts
            await setDoc(doc(db, 'users', uid, 'data', 'alerts'), {
              alerts: store.alerts,
            });
          }

          // notifications sync
          if (notificationsSnap.exists()) {
            const data = notificationsSnap.data();
            useAppStore.setState({ notifications: data.notifications || [] });
          } else {
            // New user: upload guest notifications
            await setDoc(doc(db, 'users', uid, 'data', 'notifications'), {
              notifications: store.notifications,
            });
          }

          // trade records sync
          if (tradesSnap.exists()) {
            const data = tradesSnap.data();
            useAppStore.setState({ tradeRecords: data.tradeRecords || [] });
          } else {
            // New user: upload guest trade records
            await setDoc(doc(db, 'users', uid, 'data', 'trades'), {
              tradeRecords: store.tradeRecords || [],
            });
          }
        } catch (e) {
          console.error('Error loading user data from Firestore:', e);
        }

        // Set user in store
        setUser({
          uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || '用戶',
          level: currentLevel,
        });
      } else {
        // Logged out: reset to guest/default states
        const previousUser = useAppStore.getState().user;
        console.log('[FirebaseSync] previousUser:', previousUser);
        setUser(null);
        if (previousUser !== null && previousUser !== undefined) {
          useAppStore.setState({
            watchlist: [
              { code: '2330', name: '台積電', addedAt: Date.now() },
              { code: '2317', name: '鴻海', addedAt: Date.now() },
              { code: '2454', name: '聯發科', addedAt: Date.now() },
              { code: '0050', name: '元大台灣50', addedAt: Date.now() },
            ],
            watchlistGroups: [
              {
                id: 'default',
                name: '我的自選',
                color: '#f03e3e',
                stocks: [
                  { code: '2330', name: '台積電', addedAt: Date.now() },
                  { code: '2317', name: '鴻海', addedAt: Date.now() },
                  { code: '2454', name: '聯發科', addedAt: Date.now() },
                  { code: '0050', name: '元大台灣50', addedAt: Date.now() },
                ],
                createdAt: Date.now(),
              },
            ],
            holdings: [],
            tradeRecords: [],
            alerts: [],
            notifications: [],
          });
        }
      }

      setAuthLoading(false);
    });

    return () => unsubscribe();
  }, [setUser, setAuthLoading]);
}
