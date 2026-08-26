'use client';

// ── 「只看候選」開關（各頁功能內使用候選便條）──────────────────────
// 放在各榜單/面板的控制列：開啟後該頁只顯示候選便條內的個股，
// 用該頁自己的分析角度評估候選。候選 0 檔時停用。

import { useAppStore } from '@/lib/store';

export default function OnlyCandidatesToggle({ on, setOn }: { on: boolean; setOn: (v: boolean) => void }) {
  const count = useAppStore(s => s.compareCodes.length);
  const disabled = count === 0;
  return (
    <button type="button" disabled={disabled}
      onClick={() => setOn(!on)}
      title={disabled ? '候選便條是空的——先在任一頁按「＋候選」' : '只顯示候選便條內的個股'}
      style={{ padding: '3px 10px', borderRadius: 13, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, cursor: disabled ? 'not-allowed' : 'pointer',
        border: `1px solid ${on ? 'rgba(245,159,0,0.65)' : 'var(--border-primary)'}`,
        background: on ? 'rgba(245,159,0,0.16)' : 'transparent',
        color: disabled ? 'var(--text-muted)' : on ? '#f59f00' : 'var(--text-muted)', opacity: disabled ? 0.5 : 1 }}>
      🗒️ 只看候選{count > 0 ? ` ${count}` : ''}
    </button>
  );
}

// 候選高亮框（方塊/列共用）：是候選 → 金色外框
export function candidateRing(isCandidate: boolean): React.CSSProperties {
  return isCandidate ? { boxShadow: '0 0 0 1.5px rgba(245,159,0,0.75)' } : {};
}
