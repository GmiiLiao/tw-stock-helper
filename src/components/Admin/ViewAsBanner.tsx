'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '@/lib/store';

// ── 🎭 模擬中橫幅：必須「不可能被忽略」──────────────────────────
//
// 模擬狀態最危險的失敗模式不是功能壞掉，是**管理員忘了自己在模擬**——
// 看到別人的持倉還以為是自己的、或以為站上真的壞了。
// 所以：固定在最上方、佔滿整寬、高對比、隨時顯示還剩多久，且一鍵結束。
//
// 自動到期 30 分鐘：測試本來就是短工作，忘了關比關太早危險得多。

// ⚠**一定要用 portal 掛到 body**（2026-08-06 破版事故）：
//   app 的根容器 .appLayout 是 `display: flex`（左側欄版面），
//   直接把橫幅放進去它會變成**一個 flex item**，於是佔掉一整欄、把內容擠到右半邊。
//   ⇒ 橫幅這種「浮在全站之上」的元素不能參與版面流：portal 到 body ＋ position: fixed，
//     再用 body 的 padding-top 把整個 app 往下推，才不會蓋住 Header。
const LIMIT_MS = 30 * 60 * 1000;
const BAR_H = 40;
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

  // 模擬期間把整個 app 往下推，讓出橫幅的高度（結束時精準還原原值）。
  // ⚠body 的 padding **推不動 position:fixed 的元素**（側欄）與 sticky 的 Header——
  //   它們改吃 --viewas-offset 這顆變數（平時 0），這裡一併設定。
  useEffect(() => {
    if (!viewAs || typeof document === 'undefined') return;
    const prevPad = document.body.style.paddingTop;
    document.body.style.paddingTop = `${BAR_H}px`;
    document.documentElement.style.setProperty('--viewas-offset', `${BAR_H}px`);
    return () => {
      document.body.style.paddingTop = prevPad;
      document.documentElement.style.removeProperty('--viewas-offset');
    };
  }, [viewAs]);

  if (!viewAs || typeof document === 'undefined') return null;
  const mm = Math.max(0, Math.floor(left / 60000));
  const ss = Math.max(0, Math.floor((left % 60000) / 1000));

  return createPortal(
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, height: BAR_H,
      zIndex: 100000, display: 'flex', alignItems: 'center',
      gap: 12, flexWrap: 'nowrap', overflowX: 'auto', padding: '0 14px',
      background: 'repeating-linear-gradient(45deg,#7c2d12,#7c2d12 12px,#9a3412 12px,#9a3412 24px)',
      color: '#fff', fontSize: 'calc(13px * var(--fz))', fontWeight: 700,
      boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
    }}>
      <span style={{ fontSize: 'calc(16px * var(--fz))', flexShrink: 0 }}>🎭</span>
      <span style={{ whiteSpace: 'nowrap' }}>
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
          fontWeight: 900, fontSize: 'calc(13.5px * var(--fz))',
        }}>
        結束模擬並回到我的帳號
      </button>
    </div>,
    document.body,
  );
}
