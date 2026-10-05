'use client';

// Z2 一級警示帶（preview.html renderZ2）：只放一級警示（events.ts level 1），依嚴重度排序，要按「收到」。
//   大盤危險 ⇒ 紫色全寬橫幅＋「你有 n 檔逼近停損」；其他一級 ⇒ 琥珀框「一級 n」＋最嚴重的一則；沒有 ⇒ 「目前沒有需要立即處理的事」。
// 試撮窗（08:30–09:00、13:25–13:30）價格類一級警示暫停（觸停損依規範 stop-v1.1 在這兩段不判定）；畫面照實說明暫停中。
// 一級事件引擎（daemon 個人警示訂閱、大盤危險狀態機、持股重大利空）也掛在這裡（桌機）；手機由 MobileBars 掛。
import type { WarSegment } from '@/lib/warroom/session';
import ZoneFrame, { type ZoneProps } from './parts/ZoneFrame';
import { useWarData } from './WarRoomContext';
import { useTopState, type TopDanger } from './TopStore';
import { useTopAlertEngine, useLevel1, ackTopEvent } from './TopAlertEngine';
import { hhmm, hhmmss } from './parts/fmt';
import type { NearStop } from '../../../scripts/lib/warroom-top.mjs';
import styles from './WarRoomV2.module.css';
import css from './TopZones.module.css';

const NEAR_LIST_MAX = 3;

/** 「你有 n 檔逼近停損：2317 鴻海、3231 緯創」（停損依規範 stop-v1.1，與 A1 同一個值；在停損下或距停損 ≤1 ATR，沒有 ATR14 時 ≤2%；不寫停損價） */
export function nearStopText(near: readonly NearStop[], holdingCount: number, known = true): string {
  if (!holdingCount) return '';
  if (!known) return '逼近停損：暫無法計算';
  if (!near.length) return '持股沒有逼近停損（距停損 ≤1 ATR，沒有 ATR 時 ≤2%）';
  const names = near.slice(0, NEAR_LIST_MAX).map(n => `${n.code} ${n.name}`.trim()).join('、');
  return `你有 ${near.length} 檔逼近停損：${names}${near.length > NEAR_LIST_MAX ? '…' : ''}`;
}

/** 沒有一級警示時的一句話（事實描述，不寫指令句） */
export function calmText(segment: WarSegment, danger: TopDanger, dangerAcked: boolean, holdingCount: number, checkedAt: number | null): string {
  const head = danger.active && dangerAcked ? '已收到·大盤危險狀態仍持續（看盤勢燈）·' : '';
  if (segment === 'auction') return `${head}收盤集合競價中：價格為試撮指示價，價格類一級警示暫停到收盤揭示`;
  if (segment === 'pre' || segment === 'preclear') return `${head}目前沒有需要立即處理的事·盤前為試撮指示價，價格類一級警示暫停到 09:00`;
  const base = `${head}目前沒有需要立即處理的事`;
  if (!holdingCount) return `${base}·尚無持股資料`;
  const trading = segment === 'open' || segment === 'mid' || segment === 'tail';
  if (!trading) return `${base}·持股 ${holdingCount} 檔`;
  return `${base}·持股 ${holdingCount} 檔監控中${checkedAt != null ? `·最後檢查 ${hhmm(checkedAt)}` : ''}`;
}

export default function ZoneAlerts({ variant = 'desk' }: ZoneProps) {
  useTopAlertEngine();
  const { segment, pulse } = useWarData();
  const { danger, nearStop, nearStopKnown, holdingCount } = useTopState();
  const { list, danger: dangerEvent } = useLevel1();
  if (variant === 'mobile') return null;   // 手機：一級警示收成 S1 計數點（MobileBars）

  if (dangerEvent) {
    const near = nearStopText(nearStop, holdingCount, nearStopKnown);
    return (
      <ZoneFrame area="z2" bare label="一級警示">
        <div key={dangerEvent.id} className={`${css.z2} ${css.z2Danger} ${styles.flashOutline}`} role="alert">
          <span className={css.cnt}>⚠ 一級</span>
          <span className={css.msg}><b>{dangerEvent.text}{near ? `｜${near}` : ''}</b></span>
          <button type="button" className={css.ackBtn} onClick={() => { void ackTopEvent(dangerEvent.id); }}>收到</button>
        </div>
      </ZoneFrame>
    );
  }

  if (list.length) {
    const first = list[0];
    return (
      <ZoneFrame area="z2" bare label="一級警示">
        <div key={first.id} className={`${css.z2} ${styles.flashOutline}`} role="alert">
          <span className={css.cnt}>一級 {list.length}</span>
          <span className={css.msg}>
            <span className={css.msgTime}>{hhmmss(first.at)}</span>{first.text}
            {list.length > 1 && <span className={styles.muted}>（另 {list.length - 1} 則，收到後顯示下一則）</span>}
          </span>
          <button type="button" className={css.ackBtn} onClick={() => { void ackTopEvent(first.id); }}>收到</button>
        </div>
      </ZoneFrame>
    );
  }

  const checkedAt = pulse?.top?.asOf ?? null;
  return (
    <ZoneFrame area="z2" bare label="一級警示">
      <div className={`${css.z2} ${css.z2Calm}`}>
        <span className={`${css.cnt} ${css.cntCalm}`}>0</span>
        <span className={`${css.msg} ${styles.muted}`}>{calmText(segment, danger, !dangerEvent, holdingCount, checkedAt)}</span>
      </div>
    </ZoneFrame>
  );
}
