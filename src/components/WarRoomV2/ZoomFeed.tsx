'use client';

// D2 放大層「即時異動流·全部紀錄」：本工作階段累積的全部事件（伺服器最近 40 則逐輪累積、最多 300 則、24 小時內）
// ＋我的警示紀錄；同樣的篩選與 10 分鐘合併規則。
import { useState } from 'react';
import { useWarData } from './WarRoomContext';
import { useArrivals, useFeedEvents } from './FeedData';
import { FEED_FOOT, FEED_MISSING_NOTE, FeedFilterChips, FeedList, useFeedGroups, type FeedFilter } from './FeedRows';
import styles from './WarRoomV2.module.css';
import fs from './ZoneFeed.module.css';

export default function ZoomFeed() {
  const { now } = useWarData();
  const { items, loaded, section } = useFeedEvents();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const { isNew, flashing } = useArrivals(items, now, !!section?.ok);
  const { groups, mineCount } = useFeedGroups(items, filter, now);

  return (
    <div>
      <div className={fs.zoomBar}>
        <FeedFilterChips value={filter} onChange={setFilter} mineCount={mineCount} />
        <span className={styles.muted}>共 {groups.length} 列</span>
      </div>
      {groups.length
        ? <div className={fs.zoomList}><FeedList groups={groups} isNew={isNew} flashing={flashing} /></div>
        : <div className={styles.empty}>{loaded ? '目前沒有異動紀錄' : '載入中…'}</div>}
      <p className={fs.zoomNote}>
        {FEED_FOOT}。
        <br />
        {FEED_MISSING_NOTE}
        <br />
        紀錄自開啟本頁起逐輪累積（伺服器每次固定回最近 40 則，所有人同一份）；重新整理後從最近 40 則重新累積。非投資建議。
      </p>
    </div>
  );
}
