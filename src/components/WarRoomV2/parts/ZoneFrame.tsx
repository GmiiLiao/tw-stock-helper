'use client';

// 區塊外框：標題、標題右側控制、資料章、頂列（KPI／摘要）、內容、頁尾。
// 桌機：放進格線的 grid-area（area 決定位置）；手機（variant='mobile'）：單欄段落，id 給 S2 跳轉用。
// 正式版不顯示 A1／B1 這類區塊代號（代號只在程式與文件裡用）。
import type { ReactNode } from 'react';
import styles from '../WarRoomV2.module.css';

export type ZoneArea = 'z0' | 'z1' | 'z2' | 'a1' | 'b1' | 'c1' | 'c2' | 'a2' | 'b2';
export type ZoneVariant = 'desk' | 'mobile';

/** 每個區塊元件（Zone*.tsx）的 props：desk＝桌機格線版；mobile＝手機段落（compact：前 5–8 列、52px 兩行卡） */
export interface ZoneProps {
  variant?: ZoneVariant;
}

const AREA_CLASS: Record<ZoneArea, string> = {
  z0: styles.areaZ0, z1: styles.areaZ1, z2: styles.areaZ2,
  a1: styles.areaA1, b1: styles.areaB1, c1: styles.areaC1,
  c2: styles.areaC2, a2: styles.areaA2, b2: styles.areaB2,
};

/** 手機段落 id（S2 跳轉列用）；Z0／Z1／Z2／C2 在手機不成段 */
export const MOBILE_SECTION_ID: Readonly<Partial<Record<ZoneArea, string>>> = {
  a1: 'wr-m-mine', a2: 'wr-m-focus', b1: 'wr-m-opp', b2: 'wr-m-feed', c1: 'wr-m-sectors',
};

export interface ZoneFrameProps {
  area: ZoneArea;
  title?: ReactNode;
  /** 標題右側的控制（chip、切換、全部 →） */
  extra?: ReactNode;
  /** 資料章 <Stamp/> */
  stamp?: ReactNode;
  /** 標題下方、內容上方的一列（KPI、AI 摘要） */
  top?: ReactNode;
  foot?: ReactNode;
  /** 時段強調（藍框）：開盤段 C2、盤中段 C1、A2 永遠 */
  emphasis?: boolean;
  variant?: ZoneVariant;
  /** 不畫外框與標題列（Z0／Z1／Z2 自己畫），只負責放進格線 */
  bare?: boolean;
  className?: string;
  /** 無障礙名稱（title 不是純文字時給） */
  label?: string;
  children?: ReactNode;
}

export default function ZoneFrame({
  area, title, extra, stamp, top, foot, emphasis, variant = 'desk', bare, className, label, children,
}: ZoneFrameProps) {
  const aria = label ?? (typeof title === 'string' ? title : undefined);

  if (variant === 'mobile') {
    return (
      <section id={MOBILE_SECTION_ID[area]} className={[styles.mSec, className].filter(Boolean).join(' ')} aria-label={aria}>
        {(title || extra || stamp) && (
          <header className={styles.mSecHead}>
            <span>{title}</span>
            <span>{extra}{stamp}</span>
          </header>
        )}
        {top && <div className={styles.ztop}>{top}</div>}
        {children}
        {foot && <div className={styles.foot}>{foot}</div>}
      </section>
    );
  }

  if (bare) {
    return (
      <div className={[styles.bar, AREA_CLASS[area], className].filter(Boolean).join(' ')} aria-label={aria}>
        {children}
      </div>
    );
  }

  return (
    <section
      className={[styles.zone, AREA_CLASS[area], emphasis ? styles.zoneEmphasis : '', className].filter(Boolean).join(' ')}
      aria-label={aria}
    >
      <header className={styles.zh}>
        <span className={styles.zt}>{title}</span>
        {extra && <span className={styles.zx}>{extra}</span>}
        <span className={styles.sp} />
        {stamp}
      </header>
      {top && <div className={styles.ztop}>{top}</div>}
      <div className={styles.zb}>{children}</div>
      {foot && <div className={styles.foot}>{foot}</div>}
    </section>
  );
}
