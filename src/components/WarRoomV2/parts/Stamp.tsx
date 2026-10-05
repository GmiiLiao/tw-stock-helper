'use client';

// 資料章：每個區塊標題列右側，顯示「資料本身的時間」（不是抓取時間）。
// ● 即時 hh:mm:ss · ◐ 延遲 n 分 · ▲ 過期 n 分·重試中 · ■ 收盤 hh:mm · ◆ 前交易日 mm/dd · ○ 未開盤
import { useWarData } from '../WarRoomContext';
import { stampOf, type FreshKind } from './freshness';
import styles from '../WarRoomV2.module.css';

export interface StampProps {
  /** 門檻種類：quote 120/300 秒、index 60/180 秒、list 5/10 分、sector 8/15 分、news 30/60 分 */
  kind: FreshKind;
  /** 資料本身的時間（epoch ms；Section.asOf、revealAt、指數用 TopView.indexAsOf…）；null＝沒有資料 */
  asOf: number | null | undefined;
  /** 只在開盤後才有意義（家數、榜單、族群、報價）：盤前與清空窗顯示「○ 未開盤」 */
  openOnly?: boolean;
  /** 即時字樣（預設「即時」；A1 用「揭示」） */
  liveLabel?: string;
}

export default function Stamp({ kind, asOf, openOnly, liveLabel }: StampProps) {
  const { now, segment } = useWarData();
  const info = stampOf({ kind, asOf: asOf ?? null, now, segment, openOnly, liveLabel });
  const rest = info.text.startsWith(info.glyph) ? info.text.slice(info.glyph.length).trimStart() : info.text;
  return (
    <span className={styles.stamp} data-state={info.state} title="資料本身的時間（揭示或產出時刻），不是抓取時間">
      <i className={styles.stampGlyph} aria-hidden="true">{info.glyph}</i>
      {rest}
    </span>
  );
}
