'use client';

// B2 即時異動流：剛剛發生了什麼（也是手機唯一的新聞入口）。
// 資料：board.feeds.events（伺服器最近 40 則，所有人同一個網址、前端去重累積）＋ events.ts 的我的警示紀錄
//       ＋ 依持股／釘選補出的「我的」重訊與新聞判別。篩選 全部／我的／做多／做空；桌機最多 8 列、手機最新 6 則，其餘「全部 →」。
// 二級事件：新到的列 NEW 3 分鐘；我的與本機警示底色閃 3 秒；標題計數「+n」。當沖事件不放這裡（只在時段焦點）。
import { useState } from 'react';
import { isTradingSegment } from '@/lib/warroom/session';
import ZoneFrame, { type ZoneProps } from './parts/ZoneFrame';
import Stamp from './parts/Stamp';
import { MoreButton } from './parts/Chip';
import { useWarData, useWarUi } from './WarRoomContext';
import { useArrivals, useFeedEvents } from './FeedData';
import { FEED_FOOT, FeedCard, FeedFilterChips, FeedList, useFeedGroups, type FeedFilter } from './FeedRows';
import styles from './WarRoomV2.module.css';
import fs from './ZoneFeed.module.css';

const DESK_ROWS = 8;
const MOBILE_ROWS = 6;

export default function ZoneFeed({ variant = 'desk' }: ZoneProps) {
  const { now, segment } = useWarData();
  const { openZoom } = useWarUi();
  const { items, section, loaded, failing } = useFeedEvents();
  const [filter, setFilter] = useState<FeedFilter>('all');
  const { isNew, flashing, newCount } = useArrivals(items, now, !!section?.ok);
  const { groups, mineCount } = useFeedGroups(items, filter, now);
  const mobile = variant === 'mobile';
  const shown = groups.slice(0, mobile ? MOBILE_ROWS : DESK_ROWS);

  // 盤中資料章看「市場事件」的時間（重訊、新聞很新不代表盤中事件沒停更）；盤前盤後看全部來源
  const asOf = section?.ok ? (isTradingSegment(segment) ? section.data.marketAsOf ?? section.asOf : section.asOf) : null;
  const failed = section?.ok ? section.data.failed : [];

  const empty = (() => {
    if (shown.length) return null;
    if (section && !section.ok) return `${section.error}${failing ? '·重試中' : ''}`;
    if (!loaded) return failing ? '讀取失敗·重試中' : '載入中…';
    if (filter !== 'all') return '這個篩選目前沒有事件';
    return segment === 'pre' || segment === 'preclear' || segment === 'after' || segment === 'nontrading'
      ? '目前沒有新的新聞判別或重大訊息'
      : '目前沒有異動紀錄';
  })();

  const title = (
    <>
      即時異動流
      {newCount > 0 && <span className={fs.plusN} title={`3 分鐘內新增 ${newCount} 則`}>+{newCount}</span>}
    </>
  );
  const chips = <FeedFilterChips value={filter} onChange={setFilter} mineCount={mineCount} />;
  const foot = (
    <>
      <span className={fs.footNote}>
        {FEED_FOOT}
        {failed.length > 0 && `·${failed.join('、')}讀取失敗`}
      </span>
      <MoreButton onClick={() => openZoom('feed')} />
    </>
  );

  if (mobile) {
    return (
      <ZoneFrame
        area="b2" variant="mobile" label="即時異動流" title={title}
        stamp={<Stamp kind="list" asOf={asOf} />}
        top={<div className={fs.chipsRow}>{chips}</div>}
        foot={foot}
      >
        {empty ? <div className={styles.empty}>{empty}</div> : shown.map((g) => (
          <FeedCard key={g.head.id} group={g} isNew={isNew(g.head.id)} flash={flashing.has(g.head.id)} />
        ))}
      </ZoneFrame>
    );
  }

  return (
    <ZoneFrame area="b2" label="即時異動流" title={title} extra={chips} stamp={<Stamp kind="list" asOf={asOf} />} foot={foot}>
      {empty ? <div className={styles.empty}>{empty}</div> : <FeedList groups={shown} isNew={isNew} flashing={flashing} />}
    </ZoneFrame>
  );
}
