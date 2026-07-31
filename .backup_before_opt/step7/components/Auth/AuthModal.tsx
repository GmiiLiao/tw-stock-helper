'use client';

import { useState, useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  GoogleAuthProvider,
} from 'firebase/auth';
import { auth } from '@/lib/firebase';
import styles from './AuthModal.module.css';

const googleProvider = new GoogleAuthProvider();

export default function AuthModal() {
  const { showAuthModal, setShowAuthModal } = useAppStore();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Handle redirect result on mount (for signInWithRedirect fallback)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    getRedirectResult(auth)
      .then((result) => {
        if (result?.user) {
          setShowAuthModal(false);
        }
      })
      .catch((err) => {
        console.error('[Auth] Redirect result error:', err);
        // Don't show error for redirect — user may not have attempted redirect
      });
  }, [setShowAuthModal]);

  if (!showAuthModal) return null;

  const handleClose = () => {
    setShowAuthModal(false);
    setError('');
    setEmail('');
    setPassword('');
    setDisplayName('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      if (isRegister) {
        const userCredential = await createUserWithEmailAndPassword(auth, email, password);
        if (displayName.trim()) {
          await updateProfile(userCredential.user, {
            displayName: displayName.trim(),
          });
        }
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
      handleClose();
    } catch (err: any) {
      console.error('[Auth] Email auth error:', err);
      let msg = '操作失敗，請檢查輸入';
      if (err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
        msg = '帳號或密碼錯誤';
      } else if (err.code === 'auth/email-already-in-use') {
        msg = '該電子信箱已被註冊';
      } else if (err.code === 'auth/invalid-email') {
        msg = '無效的電子信箱格式';
      } else if (err.code === 'auth/weak-password') {
        msg = '密碼強度不足（至少需要6個字元）';
      } else if (err.code === 'auth/invalid-credential') {
        msg = '帳號或密碼輸入錯誤';
      } else if (err.code === 'auth/too-many-requests') {
        msg = '嘗試次數過多，請稍後再試';
      } else if (err.code === 'auth/network-request-failed') {
        msg = '網路連線失敗，請檢查網路後重試';
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      // Try popup first (works on desktop)
      await signInWithPopup(auth, googleProvider);
      handleClose();
    } catch (err: any) {
      console.error('[Auth] Google sign-in error:', err?.code, err?.message);

      // If popup was blocked or failed, try redirect
      if (
        err.code === 'auth/popup-blocked' ||
        err.code === 'auth/popup-closed-by-user' ||
        err.code === 'auth/cancelled-popup-request'
      ) {
        if (err.code === 'auth/popup-blocked') {
          // Popup was blocked by browser, use redirect
          try {
            await signInWithRedirect(auth, googleProvider);
            return; // Will redirect away
          } catch (redirectErr: any) {
            console.error('[Auth] Redirect fallback error:', redirectErr);
            setError('Google 登入失敗，請確認已允許彈出視窗');
          }
        }
        // popup-closed-by-user: user closed it intentionally, no error
        // cancelled-popup-request: another popup was opened, no error
      } else if (err.code === 'auth/unauthorized-domain') {
        setError('此網域尚未授權 Google 登入，請聯繫管理員設定 Firebase Authentication');
      } else if (err.code === 'auth/operation-not-allowed') {
        setError('Google 登入尚未啟用，請聯繫管理員在 Firebase Console 啟用 Google 提供者');
      } else if (err.code === 'auth/internal-error') {
        // Try redirect as fallback for internal errors (often cookie-related)
        try {
          await signInWithRedirect(auth, googleProvider);
          return;
        } catch (redirectErr: any) {
          console.error('[Auth] Redirect fallback error:', redirectErr);
          setError('Google 登入發生內部錯誤，請稍後再試');
        }
      } else if (err.code === 'auth/network-request-failed') {
        setError('網路連線失敗，請檢查網路後重試');
      } else {
        setError('Google 登入失敗：' + (err.code || err.message || '未知錯誤'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h2>{isRegister ? '🤖 註冊新帳號' : '👤 會員登入'}</h2>
          <button className={styles.closeBtn} onClick={handleClose}>×</button>
        </div>

        <form onSubmit={handleSubmit} className={styles.form}>
          {error && <div className={styles.error}>{error}</div>}

          {isRegister && (
            <div className={styles.formGroup}>
              <label>暱稱 / 姓名</label>
              <input
                type="text"
                placeholder="例如：小明"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="input"
                required
              />
            </div>
          )}

          <div className={styles.formGroup}>
            <label>電子信箱</label>
            <input
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              required
            />
          </div>

          <div className={styles.formGroup}>
            <label>密碼</label>
            <input
              type="password"
              placeholder="請輸入密碼（至少 6 碼）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              required
            />
          </div>

          <button type="submit" className={styles.submitBtn} disabled={loading}>
            {loading ? '處理中...' : isRegister ? '註冊帳號' : '立即登入'}
          </button>
        </form>

        <div className={styles.divider}>
          <span>或</span>
        </div>

        <button type="button" onClick={handleGoogleSignIn} className={styles.googleBtn} disabled={loading}>
          <svg className={styles.googleIcon} viewBox="0 0 24 24" width="16" height="16">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
          </svg>
          {loading ? '處理中...' : `使用 Google 帳號${isRegister ? '註冊' : '登入'}`}
        </button>

        <div className={styles.switch}>
          {isRegister ? (
            <span>
              已經有帳號？{' '}
              <button type="button" onClick={() => { setIsRegister(false); setError(''); }} className={styles.switchLink}>
                立即登入
              </button>
            </span>
          ) : (
            <span>
              還沒有帳號？{' '}
              <button type="button" onClick={() => { setIsRegister(true); setError(''); }} className={styles.switchLink}>
                免費註冊
              </button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
