'use client';

import { Component, type ReactNode } from 'react';

// ── 單張卡片的錯誤邊界（2026-08-06 白畫面事故後補）────────────────
//
// 事故：投資組合有 14 張卡片各自訂閱 daemon 寫的 Firestore 文件，
//   其中 PortfolioRisk 讀到「只有一半欄位」的文件（兩個 daemon 技能寫同一份文件，
//   而只持有 1 檔的會員只會被其中一個寫入），undefined.toFixed() 丟出 TypeError，
//   **整棵 React 樹被卸載 → 使用者看到的是整頁全白**，且沒有任何線索。
//
// 這裡的原則：**一張卡片的資料有問題，只能弄壞那張卡片**。
//   外部資料（尤其是非同步、由另一個程式寫入的）永遠可能缺欄位或換形狀，
//   逐欄防護會漏，邊界則是結構性的保證。
//   失敗時顯示可辨識的訊息（含卡片名）而非靜默隱藏——靜默會讓問題查不出來。
export default class CardBoundary extends Component<
  { name: string; children: ReactNode },
  { err: Error | null }
> {
  state: { err: Error | null } = { err: null };

  static getDerivedStateFromError(err: Error) { return { err }; }

  componentDidCatch(err: Error) {
    console.error(`[CardBoundary] ${this.props.name} 渲染失敗：`, err);
  }

  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{
        marginBottom: 16, padding: '12px 14px', borderRadius: 12,
        background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.35)',
        fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.7,
      }}>
        <div style={{ fontWeight: 800, color: 'var(--text-primary)', marginBottom: 2 }}>
          ⚠️ 「{this.props.name}」暫時無法顯示
        </div>
        本區塊的資料格式異常，已略過以免影響其他功能；頁面其餘部分正常可用。
        <span style={{ color: 'var(--text-muted)' }}>（{this.state.err.message.slice(0, 80)}）</span>
      </div>
    );
  }
}
