'use client';

// ── ＋候選 切換鈕（跨頁選股工作流）──────────────────────────────
// 灑在各頁(方塊/列/個股頁)，隨手把股票撿進候選便條。沿用 store compareCodes。
// variant：'icon' 精簡(方塊角落) / 'chip' 小膠囊(列) / 'full' 帶字(個股頁)。

import { useAppStore } from '@/lib/store';
import { logActivity } from '@/lib/activity-logger';

interface Props {
  code: string;
  variant?: 'icon' | 'chip' | 'full';
  className?: string;
}

export default function AddCandidateButton({ code, variant = 'chip', className }: Props) {
  const inPool = useAppStore(s => s.compareCodes.includes(code));
  const toggle = useAppStore(s => s.toggleCandidate);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // 不觸發所在列/方塊的導航
    e.preventDefault();
    logActivity(inPool ? 'remove_candidate' : 'add_candidate', { code });
    toggle(code);
  };

  const on = inPool;
  const base: React.CSSProperties = {
    cursor: 'pointer', fontWeight: 800, lineHeight: 1,
    border: `1px solid ${on ? 'rgba(245,159,0,0.65)' : 'var(--border-primary)'}`,
    background: on ? 'rgba(245,159,0,0.16)' : 'transparent',
    color: on ? '#f59f00' : 'var(--text-muted)',
    transition: 'all 120ms',
  };

  if (variant === 'icon') {
    return (
      <button type="button" onClick={onClick} title={on ? '已在候選便條' : '加入候選便條'} aria-pressed={on}
        className={className}
        style={{ ...base, width: '1.45em', height: '1.45em', minWidth: 18, minHeight: 18, borderRadius: 5, fontSize: 'calc(12.5px * var(--fz))', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
        {on ? '✓' : '＋'}
      </button>
    );
  }
  if (variant === 'full') {
    return (
      <button type="button" onClick={onClick} aria-pressed={on} className={className}
        style={{ ...base, padding: '6px 14px', borderRadius: 10, fontSize: 'calc(13px * var(--fz))', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {on ? '✓ 已在候選便條' : '🗒️ ＋加入候選'}
      </button>
    );
  }
  // chip
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={on ? '已在候選便條' : '加入候選便條'} className={className}
      style={{ ...base, padding: '2px 8px', borderRadius: 10, fontSize: 'calc(12.5px * var(--fz))', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      {on ? '✓候選' : '＋候選'}
    </button>
  );
}
