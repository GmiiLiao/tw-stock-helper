import { useEffect } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { useAppStore, blankUserData, setSyncReadOnly } from './store';

// 讀取失敗時為保護雲端資料而上的同步鎖；只解除自己上的鎖（身分模擬另有自己的鎖，不可誤解）
let _lockedByLoadFailure = false;

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
          // ⚠ 本機資料擁有者（2026-09-28 WM-SCAN G3-11；使用者：新用戶應預設空白資料）：
          //   localStorage 的持股／交易／自選／警報沒有擁有者，舊版在「雲端還沒有該文件」時直接上傳本機那份——
          //   同一台瀏覽器上一位使用者（沒按登出就關掉、token 過期、直接切換帳號）或訪客試用的資料，
          //   就會變成新帳號的資料。現在只有本機擁有者＝這個 uid 才上傳（自己尚未同步成功的資料），
          //   其餘一律以空白起始；雲端已有的文件照舊以雲端為準。
          const ownLocal = store.dataOwnerUid === uid;
          const blank = blankUserData();
          const next: Partial<ReturnType<typeof blankUserData>> = {};
          const writes: Promise<void>[] = [];
          const fill = <K extends keyof ReturnType<typeof blankUserData>>(key: K, cloud: ReturnType<typeof blankUserData>[K] | undefined, local: ReturnType<typeof blankUserData>[K]) => {
            (next as Record<string, unknown>)[key] = cloud ?? (ownLocal ? local : blank[key]);
          };

          if (watchlistSnap.exists()) {
            const data = watchlistSnap.data();
            fill('watchlist', data.watchlist || [], store.watchlist);
            fill('watchlistGroups', data.watchlistGroups || [], store.watchlistGroups);
          } else {
            fill('watchlist', undefined, store.watchlist);
            fill('watchlistGroups', undefined, store.watchlistGroups);
            writes.push(setDoc(doc(db, 'users', uid, 'data', 'watchlist'), { watchlist: next.watchlist, watchlistGroups: next.watchlistGroups }));
          }
          if (holdingsSnap.exists()) fill('holdings', holdingsSnap.data().holdings || [], store.holdings);
          else { fill('holdings', undefined, store.holdings); writes.push(setDoc(doc(db, 'users', uid, 'data', 'holdings'), { holdings: next.holdings })); }
          if (alertsSnap.exists()) fill('alerts', alertsSnap.data().alerts || [], store.alerts);
          else { fill('alerts', undefined, store.alerts); writes.push(setDoc(doc(db, 'users', uid, 'data', 'alerts'), { alerts: next.alerts })); }
          if (notificationsSnap.exists()) fill('notifications', notificationsSnap.data().notifications || [], store.notifications);
          else { fill('notifications', undefined, store.notifications); writes.push(setDoc(doc(db, 'users', uid, 'data', 'notifications'), { notifications: next.notifications })); }
          if (tradesSnap.exists()) fill('tradeRecords', tradesSnap.data().tradeRecords || [], store.tradeRecords || []);
          else { fill('tradeRecords', undefined, store.tradeRecords || []); writes.push(setDoc(doc(db, 'users', uid, 'data', 'trades'), { tradeRecords: next.tradeRecords })); }

          // 先換上這個帳號的資料並標擁有者，再寫雲端（寫入失敗不影響畫面；下次登入擁有者已相符會補寫）
          if (_lockedByLoadFailure) { setSyncReadOnly(false); _lockedByLoadFailure = false; }
          useAppStore.setState({ ...next, dataOwnerUid: uid });
          await Promise.all(writes);
        } catch (e) {
          console.error('Error loading user data from Firestore:', e);
          // 讀取失敗且本機資料不是這個帳號的：畫面換成空白並鎖住同步寫入，
          // 否則別人的本機資料會掛在這個帳號名下顯示、一操作就同步蓋掉他雲端的真資料。重新整理即重試。
          if (useAppStore.getState().dataOwnerUid !== uid) {
            setSyncReadOnly(true); _lockedByLoadFailure = true;
            useAppStore.setState(blankUserData());
          }
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
            dataOwnerUid: null,
          });
        }
      }

      setAuthLoading(false);
    });

    return () => unsubscribe();
  }, [setUser, setAuthLoading]);
}
