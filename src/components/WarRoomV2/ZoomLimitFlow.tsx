'use client';

// D2 放大層「漲停動態」上半：今日漲停順序流全量（新到舊）。下半的盤中漲停預測 A 榜由 ZoomLayer 掛原有的 LimitUpPanel source="live"。
import { useMemo } from 'react';
import { useWarData } from './WarRoomContext';
import { useFeedsSections } from './FeedData';
import { LimitFlowList } from './LimitFlowRows';
import { mmdd } from './parts/fmt';
import { taipeiMsOf } from '../../../scripts/lib/warroom-feeds.mjs';
import styles from './WarRoomV2.module.css';
import ls from './ZoneLimitFlow.module.css';

export default function ZoomLimitFlow() {
  const { clock } = useWarData();
  const { limitFlow } = useFeedsSections();
  const data = limitFlow?.ok ? limitFlow.data : null;
  const rows = useMemo(() => (data ? data.rows.slice().reverse() : []), [data]);
  const day = data?.flowDate ? taipeiMsOf(data.flowDate, '12:00') : null;
  const isToday = data?.flowDate === clock.ymd;

  return (
    <section aria-label="漲停順序流全量">
      <div className={ls.zoomHead}>
        漲停順序流{data ? `·${isToday ? '今日' : `◆ ${day ? mmdd(day) : data.flowDate}`}觸及 ${data.total} 家` : ''}
      </div>
      {rows.length
        ? <div className={ls.zoomList}><LimitFlowList rows={rows} /></div>
        : <div className={styles.empty}>{limitFlow && !limitFlow.ok ? limitFlow.error : '今日尚無個股觸及漲停'}</div>}
      <p className={styles.muted}>
        首次觸及漲停的時間序（daemon 每輪記錄、要求當日最高真的到過漲停價）。鎖住／開板狀態需要第二階段新資料，本頁不推論。
        「5日N板」為近 5 個交易日漲停次數（含今日），不是連板數。紅條＝同題材今日已 ≥3 家。
      </p>
    </section>
  );
}
