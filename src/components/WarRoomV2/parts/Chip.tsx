'use client';

// 標題列控制：Chip（切換／篩選）與 MoreButton（「全部 →」開放大層）。
import type { ReactNode } from 'react';
import styles from '../WarRoomV2.module.css';

export function Chip({ on = false, onClick, title, children }: { on?: boolean; onClick?: () => void; title?: string; children: ReactNode }) {
  return (
    <button type="button" className={on ? `${styles.chip} ${styles.chipOn}` : styles.chip} aria-pressed={on} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

export function MoreButton({ onClick, children = '全部 →' }: { onClick: () => void; children?: ReactNode }) {
  return <button type="button" className={styles.more} onClick={onClick}>{children}</button>;
}
