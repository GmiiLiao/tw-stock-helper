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

        let currentLevel = 'registered';
        if (firebaseUser.email === 'nicholas@gmii.tw') {
          currentLevel = 'superadmin';
        } else {
          try {
            const userDocRef = doc(db, 'users', uid);
            const userDocSnap = await getDoc(userDocRef);
            if (userDocSnap.exists()) {
              const data = userDocSnap.data();
              currentLevel = data.level || 'registered';
            }
          } catch (err) {
            console.warn('Failed to fetch user level from Firestore, defaulting to registered:', err);
          }
        }

        try {
          // 1. Sync user profile to root /users collection (for Admin Panel query)
          await setDoc(
            doc(db, 'users', uid),
            {
              uid,
              email: firebaseUser.email,
              displayName: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
              lastLogin: Date.now(),
              level: currentLevel,
            },
            { merge: true }
          );

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
