'use client';

// 小徽章、燈號、價齡標記（區塊共用）。
// 配色規則：紅綠只代表漲跌；處置／注意用風險紫外框（risk）；危險用紫（danger）；逼近停損等一級非危險用琥珀（amber）。
import type { ReactNode } from 'react';
import type { RowAge } from './freshness';
import styles from '../WarRoomV2.module.css';

export type BadgeTone = 'plain' | 'risk' | 'dt' | 't1' | 'amber' | 'danger';

const BADGE_CLASS: Record<BadgeTone, string> = {
  plain: '', risk: styles.bRisk, dt: styles.bDt, t1: styles.bT1, amber: styles.bAmber, danger: styles.bDanger,
};

/** 小徽章：risk＝處置／注意／分盤（風險紫外框）· dt＝可當沖「沖」· t1＝前交易日資料 · amber · danger · plain（觀察、多／空…） */
export function Badge({ tone = 'plain', title, children }: { tone?: BadgeTone; title?: string; children: ReactNode }) {
  return <span className={[styles.badge, BADGE_CLASS[tone]].filter(Boolean).join(' ')} title={title}>{children}</span>;
}

export type LampTone = 'up' | 'dn' | 'flat' | 'none';
const LAMP_CLASS: Record<LampTone, string> = { up: styles.lampUp, dn: styles.lampDn, flat: styles.lampFlat, none: styles.lampNone };
const LAMP_TITLE: Record<LampTone, string> = {
  up: '利多·AI 已讀內文', dn: '利空·AI 已讀內文', flat: '中性·AI 已讀內文', none: '未判別',
};

/** 新聞燈：利多紅、利空綠、中性灰、未判別空心（沒涵蓋到的代號也要顯示 none，不留白） */
export function Lamp({ tone, title }: { tone: LampTone; title?: string }) {
  const t = title ?? LAMP_TITLE[tone];
  return <span className={[styles.lamp, LAMP_CLASS[tone]].join(' ')} title={t} role="img" aria-label={t} />;
}

/** 每列價齡：aging 空心點（揭示 >120 秒）、old「舊」（>300 秒）、notrade「無成交」；fresh／none 不顯示 */
export function RowAgeMark({ age }: { age: RowAge }) {
  if (age === 'aging') return <span className={styles.ageDot} title="揭示超過 120 秒" role="img" aria-label="揭示超過 120 秒" />;
  if (age === 'old') return <span className={styles.oldTag} title="揭示超過 300 秒">舊</span>;
  if (age === 'notrade') return <span className={styles.noTradeTag} title="今日尚無成交（冷門股是市場事實，不是故障）">無成交</span>;
  return null;
}

/** 「NEW」標記（二級事件，3 分鐘後由呼叫端拿掉） */
export function NewTag() {
  return <span className={styles.newTag}>NEW</span>;
}

/** 試撮指示價標記：價格改斜體並標「指」（盤前、收盤競價） */
export function Indicative({ children }: { children: ReactNode }) {
  return <><span className={styles.ital}>{children}</span><span className={styles.ind} title="試撮指示價，可能不成交">指</span></>;
}
