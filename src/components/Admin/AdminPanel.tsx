'use client';

import { useState, useEffect, useMemo } from 'react';
import { useAppStore } from '@/lib/store';
import { auth, db } from '@/lib/firebase';
import { collection, onSnapshot, doc, setDoc, query, orderBy, limit } from 'firebase/firestore';
import styles from './AdminPanel.module.css';

import OpsPanel from './OpsPanel';
import SwingLab from './SwingLab';
import AiLabHub from './AiLabHub';
import SqueezeModel from './SqueezeModel';
import ViewAsPanel from './ViewAsPanel';
import { useShallow } from 'zustand/react/shallow';

interface UserDoc {
  uid: string;
  email: string | null;
  displayName: string | null;
  lastLogin: number;
  level: string;
}

interface AgentStatus {
  active: boolean;
  lastHeartbeat: number;
}

interface AgentMessage {
  id: string;
  type: string;
  label: string;
  emoji: string;
  text: string;
  summary: string;
  severity: string;
  stocks: string[];
  timestamp: number;
}

interface ActivityLog {
  id: string;
  uid: string;
  email: string | null;
  displayName: string | null;
  action: string;
  details: Record<string, any>;
  timestamp: number;
}

// store 裡的 `user` 是序列化過的純物件，沒有 getIdToken()。
// ID token 一律跟 Firebase Auth 的 currentUser 拿（會自動處理續期）。
async function authToken(): Promise<string> {
  return (await auth.currentUser?.getIdToken()) ?? '';
}

export default function AdminPanel() {
  const { user, navigateTo } = useAppStore(useShallow((s) => ({ user: s.user, navigateTo: s.navigateTo })));
  const adminEmail = process.env.NEXT_PUBLIC_ADMIN_EMAIL;
  const isAdmin = user && (user.level === 'superadmin' || user.level === 'admin' || (adminEmail && user.email === adminEmail));

  // Tabs state
  const [activeTab, setActiveTab] = useState<'users' | 'analytics' | 'logs' | 'ops' | 'viewas' | 'lab' | 'sqmodel' | 'dtlab'>('users');
  // 🤖 當沖 AI 實驗：只給超級管理員（與站主帳號）看——伺服器端 API 另有同一道閘門
  const isSuper = !!user && (user.level === 'superadmin' || (!!adminEmail && user.email === adminEmail));

  // Real-time data states
  const [users, setUsers] = useState<UserDoc[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingAgent, setLoadingAgent] = useState(true);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [isTriggeringAgent, setIsTriggeringAgent] = useState(false);

  // System Metric Mocks
  const [cpuUsage, setCpuUsage] = useState(12);
  const [memUsage, setMemUsage] = useState(42);
  const [cacheHit, setCacheHit] = useState(94.2);

  // Handle user level promotion/demotion
  const handleUpdateUserLevel = async (targetUid: string, newLevel: string) => {
    if (!user || (user.level !== 'superadmin' && user.level !== 'admin' && user.email !== adminEmail)) {
      alert('權限不足，無法變更用戶等級！');
      return;
    }

    const targetUser = users.find(u => u.uid === targetUid);
    if (targetUser && targetUser.email === adminEmail) {
      alert('系統保護：無法變更超級管理員擁有的帳號等級！');
      return;
    }

    try {
      await setDoc(doc(db, 'users', targetUid), { level: newLevel }, { merge: true });
    } catch (e) {
      console.error('Failed to update user level:', e);
      alert('更新用戶等級失敗：' + (e instanceof Error ? e.message : String(e)));
    }
  };

  // Calculate membership level counts
  const levelCounts = useMemo(() => {
    const counts = {
      superadmin: 0,
      admin: 0,
      premium: 0,
      junior: 0,
      registered: 0,
    };
    users.forEach((u) => {
      const lvl = (u.level || 'registered') as keyof typeof counts;
      if (counts[lvl] !== undefined) {
        counts[lvl]++;
      } else {
        counts.registered++;
      }
    });
    return counts;
  }, [users]);


  // 1. Subscribe to registered users list (admins only)
  useEffect(() => {
    if (!isAdmin) return;
    const q = query(collection(db, 'users'), orderBy('lastLogin', 'desc'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const uList: UserDoc[] = [];
      snapshot.forEach((doc) => {
        uList.push(doc.data() as UserDoc);
      });
      setUsers(uList);
      setLoadingUsers(false);
    }, (error) => {
      console.error("Error fetching users:", error);
      setLoadingUsers(false);
    });

    return () => unsubscribe();
  }, [isAdmin]);

  // 2. Subscribe to agent control state
  useEffect(() => {
    if (!isAdmin) return;
    const unsubscribe = onSnapshot(doc(db, 'system', 'monitor-agent'), (docSnap) => {
      if (docSnap.exists()) {
        setAgentStatus(docSnap.data() as AgentStatus);
      } else {
        setDoc(doc(db, 'system', 'monitor-agent'), { active: true, lastHeartbeat: Date.now() }, { merge: true });
        setAgentStatus({ active: true, lastHeartbeat: Date.now() });
      }
      setLoadingAgent(false);
    }, (error) => {
      console.error("Error fetching agent status:", error);
      setLoadingAgent(false);
    });

    return () => unsubscribe();
  }, [isAdmin]);

  // 3. Subscribe to user activity logs (Firestore)
  useEffect(() => {
    if (!isAdmin) return;
    const q = query(collection(db, 'activity_logs'), orderBy('timestamp', 'desc'), limit(100));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const logs: ActivityLog[] = [];
      snapshot.forEach((doc) => {
        logs.push({ id: doc.id, ...doc.data() } as ActivityLog);
      });
      setActivityLogs(logs);
      setLoadingLogs(false);
    }, (error) => {
      console.error("Error fetching activity logs:", error);
      setLoadingLogs(false);
    });

    return () => unsubscribe();
  }, [isAdmin]);

  // 4. Fetch latest messages from API (Heartbeats)
  const fetchMessages = async () => {
    try {
      const res = await fetch('/api/ai-analysis');
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages || []);
      }
    } catch (e) {
      console.error('Failed to fetch messages:', e);
    }
  };

  useEffect(() => {
    if (!isAdmin) return;
    fetchMessages();
    const timer = setInterval(fetchMessages, 15000);
    return () => clearInterval(timer);
  }, [isAdmin]);

  // CPU/Memory simulation
  useEffect(() => {
    if (!isAdmin) return;
    const interval = setInterval(() => {
      setCpuUsage(Math.min(100, Math.max(5, Math.round(15 + Math.random() * 20 - 10))));
      setMemUsage(Math.min(100, Math.max(30, Math.round(42 + Math.random() * 4 - 2))));
      setCacheHit(Math.min(99.9, Math.max(90, parseFloat((94.2 + Math.random() * 2 - 1).toFixed(1)))));
    }, 4000);
    return () => clearInterval(interval);
  }, [isAdmin]);

  // Toggle Agent state
  const handleToggleAgent = async () => {
    if (!agentStatus) return;
    try {
      await setDoc(
        doc(db, 'system', 'monitor-agent'),
        { active: !agentStatus.active },
        { merge: true }
      );
    } catch (e) {
      console.error('Failed to toggle agent:', e);
    }
  };

  // Trigger manual AI Agent analysis
  const handleTriggerAgent = async () => {
    if (!user) return;
    setIsTriggeringAgent(true);
    try {
      // 2026-07-31：改帶 Firebase ID token。原本送 uid/email，
      // 但那是 client 自己填的字串，server 無從分辨真偽。
      const res = await fetch('/api/ai-analysis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await authToken()}`,
        },
        body: JSON.stringify({ action: 'trigger' }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        alert('✨ 成功觸發 AI 股市分析 Agent，已重新生成最新 4 筆大盤與個股分析！');
        fetchMessages();
      } else {
        alert('❌ 觸發失敗：' + (data.error || '未知錯誤'));
      }
    } catch (e) {
      console.error('Failed to trigger agent:', e);
      alert('❌ 連線錯誤，請確認網路或後台服務是否正常。');
    } finally {
      setIsTriggeringAgent(false);
    }
  };

  // Clear messages queue
  const handleClearMessages = async () => {
    if (!confirm('確認要清空所有 AI 推送訊息佇列嗎？')) return;
    try {
      if (!user) return;
      const res = await fetch('/api/ai-analysis', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await authToken()}` },
      });
      if (res.ok) {
        setMessages([]);
      }
    } catch (e) {
      console.error('Failed to clear messages:', e);
    }
  };

  // 5. Analytics calculations based on activity logs
  const analytics = useMemo(() => {
    const stats = {
      actionBreakdown: {} as Record<string, number>,
      topStocks: {} as Record<string, number>,
      topPages: {} as Record<string, number>,
      uniqueUsers: new Set<string>().size,
    };

    const uniqueUids = new Set<string>();

    activityLogs.forEach((log) => {
      // 1. Action type breakdown
      stats.actionBreakdown[log.action] = (stats.actionBreakdown[log.action] || 0) + 1;

      // 2. Count active users
      if (log.uid) uniqueUids.add(log.uid);

      // 3. Count page visits
      if (log.action === 'navigate' && log.details?.page) {
        stats.topPages[log.details.page] = (stats.topPages[log.details.page] || 0) + 1;
      }

      // 4. Count visited stocks
      const stockCode = log.details?.stock || log.details?.code;
      if (stockCode) {
        stats.topStocks[stockCode] = (stats.topStocks[stockCode] || 0) + 1;
      }
    });

    stats.uniqueUsers = uniqueUids.size;

    // Convert objects to sorted arrays
    const sortedStocks = Object.entries(stats.topStocks)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const sortedPages = Object.entries(stats.topPages)
      .map(([page, count]) => ({ page, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      actionBreakdown: stats.actionBreakdown,
      topStocks: sortedStocks,
      topPages: sortedPages,
      activeUsers: stats.uniqueUsers,
    };
  }, [activityLogs]);

  const formatTime = (ts: number) => {
    if (!ts) return '無';
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  };

  const formatActionName = (action: string) => {
    switch (action) {
      case 'navigate': return '🌐 切換頁面';
      case 'add_watchlist': return '⭐️ 加自選';
      case 'remove_watchlist': return '🗑️ 移自選';
      case 'add_holding': return '💼 新增持倉';
      case 'remove_holding': return '💼 移除持倉';
      case 'add_alert': return '🚨 設警報';
      case 'remove_alert': return '🚨 刪警報';
      default: return `⚡ ${action}`;
    }
  };

  const getActionClass = (action: string) => {
    switch (action) {
      case 'navigate': return styles.badgeNav;
      case 'add_watchlist': return styles.badgeWatchlist;
      case 'add_holding': return styles.badgeHolding;
      case 'add_alert': return styles.badgeAlert;
      default: return styles.badgeDefault;
    }
  };

  const formatActionDescription = (log: ActivityLog) => {
    const d = log.details || {};
    switch (log.action) {
      case 'navigate':
        const pageNames: Record<string, string> = {
          dashboard: '市場總覽', stock: '個股分析', screener: '選股引擎',
          portfolio: '投資組合', backtest: '策略回測', ai: 'AI推薦選股',
          tracker: '即時追蹤', admin: '管理員後台'
        };
        return `瀏覽了 ${pageNames[d.page] || d.page} ${d.stock ? `(${d.stock})` : ''}`;
      case 'add_watchlist':
        return `將股票 ${d.name || ''} (${d.code}) 加入自選股`;
      case 'remove_watchlist':
        return `將自選股中的代號 ${d.code} 移除`;
      case 'add_holding':
        return `新增持倉 ${d.code}：以 ${d.buyPrice}元 買進 ${d.quantity >= 1 && d.quantity % 1 === 0 ? `${d.quantity}張` : `${Math.round(d.quantity * 1000)}股`}`;
      case 'remove_holding':
        return `移除了持倉記錄 ${d.code || ''}`;
      case 'add_alert':
        const types: Record<string, string> = {
          PRICE_ABOVE: '價格高於', PRICE_BELOW: '價格低於',
          CHANGE_ABOVE: '漲幅大於', CHANGE_BELOW: '跌幅大於'
        };
        return `設定警報 ${d.code}：當${types[d.type] || d.type} ${d.value}`;
      case 'remove_alert':
        return `刪除了警報 ${d.code || ''}`;
      default:
        return JSON.stringify(d);
    }
  };

  const isAgentOnline = agentStatus && (Date.now() - agentStatus.lastHeartbeat < 10 * 60 * 1000);

  const filteredUsers = users.filter((u) => {
    const term = searchQuery.toLowerCase();
    return (
      u.email?.toLowerCase().includes(term) ||
      u.displayName?.toLowerCase().includes(term) ||
      u.uid.toLowerCase().includes(term)
    );
  });

  // Access check — placed after all hooks so hook order stays stable
  // (React rules-of-hooks). Effects above are guarded by `isAdmin`.
  if (!isAdmin) {
    return (
      <div className={styles.restrictedContainer}>
        <div className={styles.restrictedCard}>
          <div className={styles.restrictedIcon}>🔒</div>
          <h1>存取被拒絕</h1>
          <p>此區域僅限系統管理員登入存取。請確認您的帳號權限或重新登入。</p>
          <div className={styles.restrictedActions}>
            <button className={styles.backBtn} onClick={() => navigateTo('dashboard')}>
              返回大廳
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.adminDashboard}>
      {/* ── Dashboard Header ── */}
      <div className={styles.header}>
        <div className={styles.headerTitle}>
          <h1>🔒 管理員控制台</h1>
          <p>系統狀態監控、註冊用戶管理與使用行為分析</p>
        </div>
        <div className={styles.adminBadge}>
          <span className={styles.badgeGold}>👑 超級管理員</span>
          <span className={styles.adminEmail}>{user?.email}</span>
        </div>
      </div>

      {/* ── Top Analytics Cards ── */}
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>👤</div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>總註冊用戶</span>
            <span className={styles.statVal}>{users.length}</span>
            <span className={styles.statSub}>
              💎 {levelCounts.premium} 高級 | ✨ {levelCounts.junior} 初級
            </span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>📝</div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>累計操作行為</span>
            <span className={styles.statVal}>{activityLogs.length} 條</span>
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statIcon}>🔥</div>
          <div className={styles.statInfo}>
            <span className={styles.statLabel}>日活躍用戶 (DAU)</span>
            <span className={styles.statVal}>{analytics.activeUsers}</span>
          </div>
        </div>
      </div>

      <div className={styles.layoutGrid}>
        {/* ── LEFT: Main Tabs Area ── */}
        <div className={styles.cardMain}>
          <div className={styles.tabBar}>
            <button
              className={`${styles.tabBtn} ${activeTab === 'users' ? styles.tabBtnActive : ''}`}
              onClick={() => setActiveTab('users')}
            >
              👤 用戶管理
            </button>
            <button
              className={`${styles.tabBtn} ${activeTab === 'analytics' ? styles.tabBtnActive : ''}`}
              onClick={() => setActiveTab('analytics')}
            >
              📊 使用分析
            </button>
            <button
              className={`${styles.tabBtn} ${activeTab === 'ops' ? styles.tabBtnActive : ''}`}
              onClick={() => setActiveTab('ops')}
            >
              📈 營運數據
            </button>
            <button
              className={`${styles.tabBtn} ${activeTab === 'logs' ? styles.tabBtnActive : ''}`}
              onClick={() => setActiveTab('logs')}
            >
              📝 使用記錄
            </button>
            <button
              className={`${styles.tabBtn} ${activeTab === 'viewas' ? styles.tabBtnActive : ''}`}
              onClick={() => setActiveTab('viewas')}
            >
              🎭 身分模擬
            </button>
            <button
              className={`${styles.tabBtn} ${activeTab === 'lab' ? styles.tabBtnActive : ''}`}
              onClick={() => setActiveTab('lab')}
            >
              🧪 技巧實驗室
            </button>
            <button
              className={`${styles.tabBtn} ${activeTab === 'sqmodel' ? styles.tabBtnActive : ''}`}
              onClick={() => setActiveTab('sqmodel')}
            >
              🧠 軋空判讀模型
            </button>
            {isSuper && (
              <button
                className={`${styles.tabBtn} ${activeTab === 'dtlab' ? styles.tabBtnActive : ''}`}
                onClick={() => setActiveTab('dtlab')}
              >
                🤖 AI 實驗
              </button>
            )}
          </div>

          {/* ── TAB: 🧠 軋空判讀模型（主/分支模型狀態·訓練資料·歷史報表）── */}
          {activeTab === 'sqmodel' && (
            <div className={styles.tabContent}>
              <SqueezeModel />
            </div>
          )}

          {/* ── TAB: 🤖 AI 實驗（超級管理員）：當沖／波段持有 ── */}
          {activeTab === 'dtlab' && isSuper && (
            <div className={styles.tabContent}>
              <AiLabHub />
            </div>
          )}

          {/* ── TAB: 🧪 波段技巧實驗室（回測實證視覺驗證·pass 才生成 skill）── */}
          {activeTab === 'lab' && (
            <div className={styles.tabContent}>
              <SwingLab />
            </div>
          )}

          {/* ── TAB 1: User Management ── */}
          {activeTab === 'users' && (
            <div className={styles.tabContent}>
              <div className={styles.searchWrapper}>
                <h3>註冊用戶清單 ({users.length} 人)</h3>
                <input
                  type="text"
                  placeholder="搜尋用戶 Email、暱稱或 UID..."
                  /* 非受控：本面板有輪詢會重渲染，controlled 回寫在手機 IME 下會把游標打回開頭
                     （見 CLAUDE.md「輸入框反序」）。 */
                  defaultValue=""
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={styles.searchBar}
                />
              </div>

              <div className={styles.usersListContainer}>
                {loadingUsers ? (
                  <div className={styles.loader}>載入用戶清單中...</div>
                ) : filteredUsers.length === 0 ? (
                  <div className={styles.empty}>找不到符合條件的用戶</div>
                ) : (
                  <table className={styles.usersTable}>
                    <thead>
                      <tr>
                        <th>顯示名稱</th>
                        <th>電子信箱</th>
                        <th>會員等級</th>
                        <th>UID</th>
                        <th>最後登入時間</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map((u) => (
                        <tr key={u.uid} className={u.email === adminEmail ? styles.adminRow : ''}>
                          <td className={styles.userNameCol}>
                            {u.displayName}
                          </td>
                          <td className={styles.userEmailCol}>{u.email}</td>
                          <td className={styles.userLevelCol}>
                            <select
                              value={u.level || 'registered'}
                              onChange={(e) => handleUpdateUserLevel(u.uid, e.target.value)}
                              className={styles.levelSelect}
                              disabled={u.email === adminEmail || (user?.level !== 'superadmin' && user?.email !== adminEmail)}
                            >
                              <option value="registered">👤 註冊使用者</option>
                              <option value="junior">✨ 初級會員</option>
                              <option value="premium">💎 高級會員</option>
                              <option value="admin">🛡️ 管理員</option>
                              <option value="superadmin">👑 超級管理員</option>
                            </select>
                          </td>
                          <td className={styles.userUidCol}>
                            <code>{u.uid.substring(0, 8)}...</code>
                          </td>
                          <td className={styles.userTimeCol}>{formatTime(u.lastLogin)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          )}

          {activeTab === 'viewas' && (
            <div className={styles.tabContent}><ViewAsPanel /></div>
          )}

          {/* ── TAB 2: Usage Analytics ── */}
          {activeTab === 'ops' && (
            <div className={styles.tabContent}>
              <OpsPanel userNameOf={(uid) => { const u = users.find(x => x.uid === uid); return u?.displayName || u?.email || uid.slice(0, 8) + '…'; }} />
            </div>
          )}

          {activeTab === 'analytics' && (
            <div className={styles.tabContent}>
              <div className={styles.analyticsGrid}>
                {/* Actions Breakdown */}
                <div className={styles.analyticsSection}>
                  <h3>⚡ 操作行為類型分佈</h3>
                  <div className={styles.chartList}>
                    {Object.entries(analytics.actionBreakdown).map(([action, count]) => {
                      const total = activityLogs.length || 1;
                      const percent = ((count / total) * 100).toFixed(1);
                      return (
                        <div key={action} className={styles.barItem}>
                          <div className={styles.barLabel}>
                            <span>{formatActionName(action)}</span>
                            <span>{count} 次 ({percent}%)</span>
                          </div>
                          <div className={styles.barBg}>
                            <div className={styles.barFill} style={{ width: `${percent}%`, background: 'var(--accent-blue)' }} />
                          </div>
                        </div>
                      );
                    })}
                    {Object.keys(analytics.actionBreakdown).length === 0 && (
                      <div className={styles.empty}>尚無足夠的行為數據進行分析</div>
                    )}
                  </div>
                </div>

                {/* Popular Pages */}
                <div className={styles.analyticsSection}>
                  <h3>🌐 熱門功能版面排行</h3>
                  <div className={styles.chartList}>
                    {analytics.topPages.map(({ page, count }) => {
                      const total = activityLogs.filter(l => l.action === 'navigate').length || 1;
                      const percent = ((count / total) * 100).toFixed(1);
                      const pageNames: Record<string, string> = {
                        dashboard: '市場總覽', stock: '個股分析', screener: '選股引擎',
                        portfolio: '投資組合', backtest: '策略回測', ai: 'AI推薦選股',
                        tracker: '即時追蹤', admin: '管理員後台'
                      };
                      return (
                        <div key={page} className={styles.barItem}>
                          <div className={styles.barLabel}>
                            <span>💻 {pageNames[page] || page}</span>
                            <span>{count} 次 ({percent}%)</span>
                          </div>
                          <div className={styles.barBg}>
                            <div className={styles.barFill} style={{ width: `${percent}%`, background: '#a78bfa' }} />
                          </div>
                        </div>
                      );
                    })}
                    {analytics.topPages.length === 0 && (
                      <div className={styles.empty}>尚無瀏覽記錄</div>
                    )}
                  </div>
                </div>

                {/* Top Stocks */}
                <div className={styles.analyticsSection} style={{ gridColumn: 'span 2' }}>
                  <h3>🔥 熱門關注個股 Top 5</h3>
                  <div className={styles.stockLeaderboard}>
                    {analytics.topStocks.map((item, index) => (
                      <div key={item.code} className={styles.leaderboardRow}>
                        <div className={styles.leaderboardRank}>{index + 1}</div>
                        <div className={styles.leaderboardName}>
                          <strong>{item.code}</strong>
                        </div>
                        <div className={styles.leaderboardBarWrapper}>
                          <div
                            className={styles.leaderboardBar}
                            style={{
                              width: `${(item.count / (analytics.topStocks[0]?.count || 1)) * 100}%`
                            }}
                          />
                        </div>
                        <div className={styles.leaderboardCount}>{item.count} 次點閱/自選</div>
                      </div>
                    ))}
                    {analytics.topStocks.length === 0 && (
                      <div className={styles.empty}>尚無個股關注統計</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── TAB 3: Usage Logs ── */}
          {activeTab === 'logs' && (
            <div className={styles.tabContent}>
              <div className={styles.logsHeaderRow}>
                <h3>📝 即時使用者操作記錄（顯示最新 100 筆）</h3>
              </div>
              <div className={styles.fullLogsContainer}>
                {loadingLogs ? (
                  <div className={styles.loader}>載入歷史日誌中...</div>
                ) : activityLogs.length === 0 ? (
                  <div className={styles.empty}>目前尚無任何使用者操作日誌</div>
                ) : (
                  <div className={styles.logListScroll}>
                    {activityLogs.map((log) => (
                      <div key={log.id} className={styles.logRow}>
                        <div className={styles.logUserIcon}>
                          {log.displayName?.charAt(0).toUpperCase() || '👤'}
                        </div>
                        <div className={styles.logUserMeta}>
                          <div className={styles.logUserEmail}>{log.email}</div>
                          <div className={styles.logUserTime}>{formatTime(log.timestamp)}</div>
                        </div>
                        <div className={styles.logActionWrapper}>
                          <span className={`${styles.actionBadge} ${getActionClass(log.action)}`}>
                            {formatActionName(log.action)}
                          </span>
                        </div>
                        <div className={styles.logDetailsCol}>
                          {formatActionDescription(log)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: Agent Controller & System metrics ── */}
        <div className={styles.cardSidebar}>
          {/* Agent Remote Switch */}
          <div className={styles.controlPanel}>
            <h3>🤖 股市監控 Agent 控制台</h3>
            {loadingAgent ? (
              <div className={styles.loader}>連線中...</div>
            ) : (
              <div className={styles.agentStatusCard}>
                <div className={styles.statusRow}>
                  <span className={styles.statusLabel}>連線狀態:</span>
                  <div className={styles.indicatorWrapper}>
                    <span
                      className={`${styles.statusIndicator} ${
                        !agentStatus?.active
                          ? styles.statusPaused
                          : isAgentOnline
                          ? styles.statusOnline
                          : styles.statusOffline
                      }`}
                    />
                    <span className={styles.statusText}>
                      {!agentStatus?.active ? '已暫停' : isAgentOnline ? '即時監控中' : '離線/異常'}
                    </span>
                  </div>
                </div>

                <div className={styles.statusRow}>
                  <span className={styles.statusLabel}>遠端開關:</span>
                  <button
                    onClick={handleToggleAgent}
                    className={`${styles.toggleBtn} ${
                      agentStatus?.active ? styles.btnActive : styles.btnInactive
                    }`}
                  >
                    {agentStatus?.active ? '🟢 監控已啟動 (點擊暫停)' : '🔴 監控已關閉 (點擊重啟)'}
                  </button>
                </div>

                <div className={styles.statusRow}>
                  <span className={styles.statusLabel}>最後心跳:</span>
                  <span className={styles.heartbeatValue}>
                    {agentStatus ? formatTime(agentStatus.lastHeartbeat) : '無'}
                  </span>
                </div>

                <div className={styles.statusRow} style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px dashed var(--border-primary)' }}>
                  <span className={styles.statusLabel}>手動執行:</span>
                  <button
                    onClick={handleTriggerAgent}
                    disabled={isTriggeringAgent}
                    className={`${styles.triggerBtn} ${isTriggeringAgent ? styles.btnLoading : ''}`}
                  >
                    {isTriggeringAgent ? '⚡ 分析生成中...' : '⚡ 立即執行分析'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* System Metrics */}
          <div className={styles.metricsPanel}>
            <h3>🖥️ 系統運作指標</h3>
            <div className={styles.metricItem}>
              <div className={styles.metricLabel}>
                <span>CPU 負載</span>
                <span>{cpuUsage}%</span>
              </div>
              <div className={styles.progressBarBg}>
                <div
                  className={styles.progressBarFill}
                  style={{ width: `${cpuUsage}%`, backgroundColor: cpuUsage > 75 ? 'var(--color-up)' : 'var(--accent-blue)' }}
                />
              </div>
            </div>

            <div className={styles.metricItem}>
              <div className={styles.metricLabel}>
                <span>記憶體佔用</span>
                <span>{memUsage}%</span>
              </div>
              <div className={styles.progressBarBg}>
                <div
                  className={styles.progressBarFill}
                  style={{ width: `${memUsage}%`, backgroundColor: 'var(--accent-blue)' }}
                />
              </div>
            </div>

            <div className={styles.metricItem}>
              <div className={styles.metricLabel}>
                <span>API 緩存命中率</span>
                <span>{cacheHit}%</span>
              </div>
              <div className={styles.progressBarBg}>
                <div
                  className={styles.progressBarFill}
                  style={{ width: `${cacheHit}%`, backgroundColor: '#2f9e44' }}
                />
              </div>
            </div>
          </div>

          {/* Latest logs from ai-analysis */}
          <div className={styles.logsPanel}>
            <div className={styles.logsHeader}>
              <h3>📝 最近 5 條 Agent 推送記錄</h3>
              <button onClick={handleClearMessages} className={styles.clearBtn}>
                🗑️ 清空
              </button>
            </div>
            <div className={styles.logsList}>
              {messages.length === 0 ? (
                <div className={styles.emptyLogs}>目前無推播分析訊息</div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className={styles.logCard}>
                    <div className={styles.logMeta}>
                      <span className={styles.logTag}>
                        {msg.emoji} {msg.label}
                      </span>
                      <span className={styles.logTime}>{formatTime(msg.timestamp)}</span>
                    </div>
                    <p className={styles.logText}>{msg.summary}</p>
                    <div className={styles.logStocks}>
                      {msg.stocks.map((s) => (
                        <span key={s} className={styles.stockBadge}>
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
