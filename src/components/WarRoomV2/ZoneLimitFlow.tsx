'use client';

// C2 漲停順序流：誰帶頭、族群有沒有成形。
// 資料：board.feeds.limitFlow（limitUpForecast/live.flow＝daemon 記錄的「首次觸及漲停」分鐘；要求當日最高真的到過漲停價）。
// 同題材第 3 家標「族群成形」；鎖住／開板狀態需要第二階段新資料（ND3），本期不顯示、也不推論。
// 開盤段（segment==='open'）加強調。桌機依區塊高度放 9–11 列（新到舊），其餘「全部 →」（全量＋盤中漲停預測 A 榜）。
// 手機版不掛這個區塊（WarRoomV2 外殼決定）；variant='mobile' 仍給卡片版以保持介面一致。
import { useMemo } from 'react';
import ZoneFrame, { type ZoneProps } from './parts/ZoneFrame';
import Stamp from './parts/Stamp';
import { MoreButton } from './parts/Chip';
import { useMediaQuery } from './parts/useMedia';
import { useWarData, useWarUi } from './WarRoomContext';
import { useFeedsSections } from './FeedData';
import { LimitFlowCard, LimitFlowList, fitFlowRows } from './LimitFlowRows';
import styles from './WarRoomV2.module.css';
import ls from './ZoneLimitFlow.module.css';

/** ≥1800 時 C2 跨兩列（464px），其餘 392px；扣標題與頁尾後可放的列數 */
const ROWS_WIDE = 11;
const ROWS_NARROW = 9;
const MOBILE_ROWS = 5;
const EMPTY_PRE = '09:00 起依首次觸及漲停的時間排列';

export default function ZoneLimitFlow({ variant = 'desk' }: ZoneProps) {
  const { segment, clock } = useWarData();
  const { openZoom } = useWarUi();
  const { limitFlow: section, loaded, failing } = useFeedsSections();
  const wide = useMediaQuery('(min-width: 1800px)');
  const mobile = variant === 'mobile';

  const data = section?.ok ? section.data : null;
  const preOpen = segment === 'pre' || segment === 'preclear';
  // 盤中只顯示今日的；盤後／休市沿用最後一個交易日（資料章標 ◆ 前交易日），盤前一律不拿昨天當今天
  const usable = !!data && !preOpen && (data.flowDate === clock.ymd || segment === 'after' || segment === 'nontrading');
  const newestFirst = useMemo(() => (usable && data ? data.rows.slice().reverse() : []), [usable, data]);
  const shown = useMemo(
    () => (mobile ? newestFirst.slice(0, MOBILE_ROWS) : fitFlowRows(newestFirst, wide ? ROWS_WIDE : ROWS_NARROW)),
    [mobile, newestFirst, wide],
  );

  const body = (() => {
    if (preOpen) return <div className={styles.empty}>{EMPTY_PRE}</div>;
    if (!data) {
      const msg = section && !section.ok ? `${section.error}${failing ? '·重試中' : ''}` : !loaded ? (failing ? '讀取失敗·重試中' : '載入中…') : '資料尚未產生';
      return <div className={styles.empty}>{msg}</div>;
    }
    if (!usable) return <div className={styles.empty}>{EMPTY_PRE}·今日資料尚未產生</div>;
    if (!shown.length) return <div className={styles.empty}>今日尚無個股觸及漲停</div>;
    if (mobile) return shown.map((r) => <LimitFlowCard key={r.code} r={r} />);
    return <LimitFlowList rows={shown} />;
  })();

  // 標題列不放家數：漲停家數全頁只留大盤脈動一處（同名必同口徑；觸及家數的全量在放大層）
  const foot = (
    <>
      <span className={ls.footNote}>首次觸及漲停的時間序·紅條＝同題材已 ≥3 家·板數為近 5 日漲停次數</span>
      <MoreButton onClick={() => openZoom('limitFlow')} />
    </>
  );

  return (
    <ZoneFrame
      area="c2" variant={variant} title="漲停順序流" foot={foot}
      stamp={<Stamp kind="list" openOnly asOf={section?.asOf} />}
      emphasis={segment === 'open'}
    >
      {body}
    </ZoneFrame>
  );
}
