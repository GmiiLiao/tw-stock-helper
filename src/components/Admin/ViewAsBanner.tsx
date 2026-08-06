'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';

// ── 🎭 模擬中橫幅：必須「不可能被忽略」──────────────────────────
//
// 模擬狀態最危險的失敗模式不是功能壞掉，是**管理員忘了自己在模擬**——
// 看到別人的持倉還以為是自己的、或以為站上真的壞了。
// 所以：固定在最上方、佔滿整寬、高對比、隨時顯示還剩多久，且一鍵結束。
//
// 自動到期 30 分鐘：測試本來就是短工作，忘了關比關太早危險得多。

const LIMIT_MS = 30 * 60 * 1000;
const LABEL: Record<string, string> = {
  superadmin: '👑 超級管理員', admin: '🛡️ 管理員', premium: '💎 高級會員',
  junior: '✨ 初級會員', registered: '👤 註冊使用者',
};

export default function ViewAsBanner() {
  const viewAs = useAppStore(s => s.viewAs);
  const exitViewAs = useAppStore(s => s.exitViewAs);
  const [left, setLeft] = useState(LIMIT_MS);

  useEffect(() => {
    if (!viewAs) return;
    const tick = () => {
      const remain = LIMIT_MS - (Date.now() - viewAs.at);
      setLeft(remain);
      if (remain <= 0) exitViewAs();      // 到期自動退出（會重載頁面還原本人資料）
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [viewAs, exitViewAs]);

  if (!viewAs) return null;
  const mm = Math.max(0, Math.floor(left / 60000));
  const ss = Math.max(0, Math.floor((left % 60000) / 1000));

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 9999, display: 'flex', alignItems: 'center',
      gap: 12, flexWrap: 'wrap', padding: '8px 16px',
      background: 'repeating-linear-gradient(45deg,#7c2d12,#7c2d12 12px,#9a3412 12px,#9a3412 24px)',
      color: '#fff', fontSize: 13, fontWeight: 700,
      boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
    }}>
      <span style={{ fontSize: 16 }}>🎭</span>
      <span>
        身分模擬中 — 你正在以
        <b style={{ margin: '0 4px', textDecoration: 'underline' }}>
          {viewAs.email ? `${viewAs.email}（${LABEL[viewAs.level ?? ''] ?? viewAs.level}）` : LABEL[viewAs.level ?? ''] ?? viewAs.level}
        </b>
        的身分檢視
      </span>
      <span style={{ padding: '2px 8px', borderRadius: 999, background: 'rgba(0,0,0,0.35)', fontWeight: 800 }}>
        🔒 唯讀（所有寫入已封鎖）
      </span>
      <span style={{ fontFamily: "'JetBrains Mono',monospace", opacity: 0.9 }}>
        剩餘 {mm}:{String(ss).padStart(2, '0')}
      </span>
      <button
        onClick={exitViewAs}
        style={{
          marginLeft: 'auto', padding: '5px 14px', borderRadius: 8, cursor: 'pointer',
          border: '1px solid rgba(255,255,255,0.6)', background: '#fff', color: '#7c2d12',
          fontWeight: 900, fontSize: 12.5,
        }}>
        結束模擬並回到我的帳號
      </button>
    </div>
  );
}
