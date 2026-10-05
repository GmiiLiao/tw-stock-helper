'use client';

// C1 族群資金：資金往哪裡跑、我的族群流入還是流出。
// 資料：board.feeds.sectors（marketWind/latest 題材；漲跌＝成交值加權；紅底＝今日觸及漲停家數，與漲停順序流同源·檔位口徑）。
// 持股所在族群置頂並標 ★（代號→族群用 themeMap 成分股對照；前端原本沒有這份對照，由伺服器一併回傳）。
// 不做熱力警示、族群排名換位不閃色（使用者裁定）；「較 15 分前」需要族群短序列（第二階段 ND12），本期不顯示。
// 盤中段（segment==='mid'）加強調。桌機最多 8 列、手機前 5 列，其餘「全部 →」開放大層（MarketWind 完整版＋官方 33 類）。
import { useMemo } from 'react';
import { isTradingSegment } from '@/lib/warroom/session';
import { flowSummaryOf, orderSectorRows, sectorChgOf, type SectorRow } from '../../../scripts/lib/warroom-feeds.mjs';
import ZoneFrame, { type ZoneProps } from './parts/ZoneFrame';
import Stamp from './parts/Stamp';
import { MoreButton } from './parts/Chip';
import { fmtPct, hhmm, toneClass } from './parts/fmt';
import { useWarData, useWarUi } from './WarRoomContext';
import { useFeedsSections, useMineCodes } from './FeedData';
import styles from './WarRoomV2.module.css';
import cs from './ZoneSectors.module.css';

const DESK_ROWS = 8;
const MOBILE_ROWS = 5;
const MIN_SCALE = 2;   // 橫條滿格至少代表 ±2%（避免全場微漲時每條都拉滿）

type Row = SectorRow & { mine: boolean };

function LuBox({ n }: { n: number | null }) {
  if (n == null) return <span className={`${cs.lu} ${cs.luZero}`} title="漲停流與族群資料日不同，不湊數">—</span>;
  return <span className={n > 0 ? cs.lu : `${cs.lu} ${cs.luZero}`} title="今日觸及漲停家數（檔位口徑·與漲停順序流同源）">{n}</span>;
}

function Bar({ chg, scale }: { chg: number | null; scale: number }) {
  if (chg == null || chg === 0) return <span className={cs.bars} />;
  const w = Math.min((Math.abs(chg) / scale) * 50, 50);
  return (
    <span className={cs.bars} aria-hidden="true">
      <i className={`${cs.bar} ${chg > 0 ? cs.barUp : cs.barDn}`} style={{ width: `${w}%` }} />
    </span>
  );
}

function Name({ r }: { r: Row }) {
  return (
    <span className={cs.name} title={r.valueShare != null ? `${r.name}·成交占比 ${r.valueShare}%` : r.name}>
      {r.mine && <span className={cs.star} aria-label="持股族群">★</span>}
      {r.name}
    </span>
  );
}

export default function ZoneSectors({ variant = 'desk' }: ZoneProps) {
  const { segment, clock } = useWarData();
  const { openZoom } = useWarUi();
  const { sectors: section, loaded, failing } = useFeedsSections();
  const { holdings } = useMineCodes();
  const mobile = variant === 'mobile';
  const limit = mobile ? MOBILE_ROWS : DESK_ROWS;

  const data = section?.ok ? section.data : null;
  const rows = useMemo<Row[]>(() => (data ? orderSectorRows(data.rows, holdings, limit) : []), [data, holdings, limit]);
  const scale = useMemo(() => Math.max(MIN_SCALE, ...rows.map((r) => Math.abs(sectorChgOf(r) ?? 0))), [rows]);

  // 盤前，或開盤後 daemon 第一輪（約 3.5 分）還沒寫出今日風向：不把前交易日的族群當今天顯示
  const preOpen = segment === 'pre' || segment === 'preclear'
    || (isTradingSegment(segment) && !!data?.dataDate && data.dataDate < clock.ymd);
  const stamp = <Stamp kind="sector" openOnly asOf={section?.asOf} />;
  const foot = (
    <>
      <span className={cs.footNote}>
        ★ 持股族群·紅底＝今日觸及漲停家數·漲跌為成交值加權{data && !data.mapped ? '·題材對照未載入，持股族群以領漲股比對' : ''}
      </span>
      <MoreButton onClick={() => openZoom('sectors')} />
    </>
  );

  // 盤前：不顯示昨天的族群當成今天（只附一句前交易日事實）
  const prevLine = data && data.dataDate && data.dataDate < clock.ymd ? flowSummaryOf(data.rows) : null;
  const body = (() => {
    if (preOpen) {
      return (
        <div className={styles.empty}>
          <div>
            09:00 開盤後約 4 分鐘第一次更新
            {prevLine && <div className={cs.prevNote}>◆ 前交易日：{prevLine}</div>}
          </div>
        </div>
      );
    }
    if (!data) {
      const msg = section && !section.ok ? `${section.error}${failing ? '·重試中' : ''}` : !loaded ? (failing ? '讀取失敗·重試中' : '載入中…') : '資料尚未產生';
      return <div className={styles.empty}>{msg}</div>;
    }
    if (!rows.length) return <div className={styles.empty}>目前沒有族群資料</div>;
    if (mobile) {
      return rows.map((r) => (
        <div key={r.key} className={r.mine ? `${cs.mRow} ${cs.mine}` : cs.mRow}>
          <Name r={r} />
          <span className={`${cs.pct} ${toneClass(sectorChgOf(r))}`}>{fmtPct(sectorChgOf(r))}</span>
          <LuBox n={r.touched} />
        </div>
      ));
    }
    return rows.map((r) => (
      <div key={r.key} className={r.mine ? `${cs.sec} ${cs.mine}` : cs.sec}>
        <Name r={r} />
        <Bar chg={sectorChgOf(r)} scale={scale} />
        <span className={`${cs.pct} ${toneClass(sectorChgOf(r))}`}>{fmtPct(sectorChgOf(r))}</span>
        <LuBox n={r.touched} />
      </div>
    ));
  })();

  const summary = !preOpen && data?.summary ? (
    <span className={cs.summary} title={data.summary.ai ? '本機 AI 依新聞標題產生的敘事（每 30 分重寫），只供參考、不進任何評分' : '依各族群成交值加權漲跌排序的事實摘要'}>
      <span className={cs.summaryLabel}>{data.summary.ai ? `AI 摘要${data.summary.asOf ? ` ${hhmm(data.summary.asOf)}` : ''}：` : '摘要：'}</span>
      {data.summary.text}
    </span>
  ) : undefined;

  return (
    <ZoneFrame
      area="c1" variant={variant} title="族群資金" stamp={stamp} top={summary} foot={foot}
      emphasis={segment === 'mid'}
    >
      {body}
    </ZoneFrame>
  );
}
