'use client';

// ─────────────────────────────────────────────────────────────────────────────
// B1 盤中機會榜（視覺照規畫資料夾 preview.html renderB1；資料 board.b1，慢層 60 秒）
//   做多＝盤中雷達 8 策略合併去重（命中 ≥2＝★共識，金框只給前 3 名）；做空＝轉空 A／B 級觀察（只列可先賣當沖）。
//   標題列：做多／做空、策略下拉（單選或全部）、★共識開關；開盤段預選「開盤強勢」並多「缺口」欄、尾盤段多「尾盤位置」欄。
//   盤前不顯示昨天的榜（「09:00 開盤後產生」）；點列開快看抽屜、點代號開個股頁；「全部 →」開放大層完整版。
//   不自己開輪詢（全頁唯一的匯流排在 WarRoomProvider）。
// ─────────────────────────────────────────────────────────────────────────────
import { useMemo, useState, type ReactNode } from 'react';
import { taipeiYmd, type WarSegment } from '@/lib/warroom/session';
import type { Section } from '@/lib/warroom/types';
import type { B1Long, B1LongRow, B1Short, B1ShortRow } from '@/lib/warroom/build-b1';
import {
  RADAR_STRAT_DISPLAY, RADAR_STRAT_LABEL, RADAR_STRAT_NAME, b1Phase, defaultStrat, extraColumn, filterLong, goldCodes,
  isConsensus, isEarlySample, isRadarStrat, stratCounts, type StratSelect,
} from '../../../scripts/lib/warroom-b1-view.mjs';
import { useWarData, useWarUi } from './WarRoomContext';
import { useWarEvents } from './events';
import ZoneFrame, { type ZoneProps } from './parts/ZoneFrame';
import Stamp from './parts/Stamp';
import { Chip, MoreButton } from './parts/Chip';
import { useOppMarks } from './OppBits';
import { LongTable, ShortTable } from './OppTable';
import { LongCards, ShortCards } from './OppCards';
import styles from './WarRoomV2.module.css';
import css from './ZoneOpportunity.module.css';

type Mode = 'long' | 'short';

const LONG_FOOT = '榜單價每分鐘更新·量比為線性估計·策略：起漲 爆量 新高 開盤強勢 回踩 續強 外資 軋空';
const SHORT_FOOT = '觀察工具·回放扣成本為負·非放空訊號·只列可先賣當沖';
const NOON_NOTE = '12:00 後成立的轉空型態回放為負（訓練 −0.52%／樣本外 −0.30%），A／B 級不列出';
const EMPTY_LONG: readonly B1LongRow[] = Object.freeze([]);
const EMPTY_SHORT: readonly B1ShortRow[] = Object.freeze([]);

const toStrat = (v: string): StratSelect => (isRadarStrat(v) ? v : 'all');

/** 子區段出錯時沿用上一份成功的（asOf 不前進 ⇒ 資料章自然轉延遲／過期，不清空畫面）。
 *  render 中比對前值更新 state 是 React 文件建議的「依前次 render 調整 state」寫法，不需 effect。 */
function useHeld<T>(sec: Section<T> | undefined): Section<T> | undefined {
  const [held, setHeld] = useState<Section<T> | undefined>(undefined);
  if (sec?.ok && sec !== held) setHeld(sec);
  return sec?.ok ? sec : held ?? sec;
}

function emptyLongText(strat: StratSelect, consOnly: boolean): string {
  if (strat !== 'all') return `「${RADAR_STRAT_LABEL[strat]}」目前沒有${consOnly ? ' ★共識' : '命中的'}個股`;
  return consOnly ? '目前沒有 ★共識（命中 ≥2 策略）的個股' : '目前沒有命中策略的個股';
}

export default function ZoneOpportunity({ variant = 'desk' }: ZoneProps) {
  const isMobile = variant === 'mobile';
  const { board, layers, segment, clock, now } = useWarData();
  const ui = useWarUi();
  const marks = useOppMarks();

  const b1 = board?.b1;
  const long = useHeld<B1Long>(b1?.ok ? b1.data.long : undefined);
  const short = useHeld<B1Short>(b1?.ok ? b1.data.short : undefined);

  // 「雷達新進 ★共識」的 B2 事件只由伺服器 build-feeds（consensusEvents，id＝s:consensus:代號:首次上榜）產生；
  // 這裡不再另發本機事件（兩份 id 不同會在 B2 重複成「×2」，且本機事件會被當成「我的」樣式）。

  // 做多／做空：手動優先；未手動時，當日出現「大盤危險」一級事件自動切到做空觀察（preview 急跌情境）
  const events = useWarEvents();
  const dangerToday = useMemo(
    () => events.some(e => e.kind === 'marketDanger' && taipeiYmd(e.at) === clock.ymd),
    [events, clock.ymd],
  );
  const [modePick, setModePick] = useState<Mode | null>(null);
  const mode: Mode = modePick ?? (dangerToday ? 'short' : 'long');

  // 策略：時段預選（開盤段＝開盤強勢），手動選擇只在同一時段內有效
  const [stratPick, setStratPick] = useState<{ segment: WarSegment; strat: StratSelect } | null>(null);
  const strat = stratPick && stratPick.segment === segment ? stratPick.strat : defaultStrat(segment);
  const [consOnly, setConsOnly] = useState(false);

  const longRows = long?.ok ? long.data.rows : EMPTY_LONG;
  const longTotal = long?.ok ? long.data.total : 0;
  const counts = useMemo(() => stratCounts(longRows), [longRows]);
  const consCount = useMemo(() => longRows.filter(isConsensus).length, [longRows]);
  const gold = useMemo(() => new Set(goldCodes(longRows)), [longRows]);
  const shownLong = useMemo(() => filterLong(longRows, { strat, consensusOnly: consOnly }), [longRows, strat, consOnly]);
  const shortRows = short?.ok ? short.data.rows : EMPTY_SHORT;
  // 處置已生效的再擋一次（交易所當沖名單在處置生效前一天仍列可當沖）
  const shownShort = useMemo(() => shortRows.filter(r => !marks.dispActive(r.code)), [shortRows, marks]);

  const sec = mode === 'long' ? long : short;
  const preOpen = segment === 'pre' || segment === 'preclear' || clock.beforeOpen;
  const phase = b1Phase({ segment, beforeOpen: clock.beforeOpen, ymd: clock.ymd, dataDate: sec?.ok ? sec.data.dataDate : null });
  const extra = extraColumn(segment);
  const indicative = segment === 'auction';
  const early = mode === 'long' && isEarlySample(segment, clock.minute);
  const openZoom = () => ui.openZoom(mode === 'long' ? 'radar' : 'short');

  // ── 標題列控制
  const modeChips = (
    <>
      <Chip on={mode === 'long'} onClick={() => setModePick('long')}>做多</Chip>
      <Chip
        on={mode === 'short'}
        onClick={() => setModePick('short')}
        title={dangerToday && !modePick ? '大盤危險：已自動切到做空觀察' : '轉空觀察（非放空訊號）'}
      >
        做空
      </Chip>
    </>
  );
  const stratSelect = (
    <select
      className={css.sel}
      aria-label="策略篩選"
      value={strat}
      onChange={e => setStratPick({ segment, strat: toStrat(e.target.value) })}
    >
      <option value="all">全部策略 {longRows.length}{longTotal > longRows.length ? `／${longTotal}` : ''}</option>
      {RADAR_STRAT_DISPLAY.map(k => (
        <option key={k} value={k} title={RADAR_STRAT_NAME[k]}>{RADAR_STRAT_LABEL[k]} {counts[k]}</option>
      ))}
    </select>
  );
  const consChip = (
    <Chip on={consOnly} onClick={() => setConsOnly(v => !v)} title="只看命中 ≥2 策略的共識股">★共識 {consCount}</Chip>
  );
  const stamp = <Stamp kind="list" openOnly asOf={sec?.ok ? sec.asOf : null} />;

  // ── 內容
  const empty = (node: ReactNode) => <div className={isMobile ? `${styles.empty} ${css.mEmpty}` : styles.empty}>{node}</div>;
  let body: ReactNode;
  if (preOpen) {
    body = empty(isMobile ? '09:00 開盤後產生' : (
      <div>
        <div className={css.preTitle}>09:00 開盤後產生</div>
        <div className={css.preSub}>
          盤前不顯示昨天的榜單，避免把昨天的強勢當成今天的機會。<br />開盤前要看的清單在「時段焦點·開盤劇本」。
        </div>
      </div>
    ));
  } else if (!board) {
    body = empty(layers.board.failCount > 0 ? '讀取失敗·重試中' : '讀取中…');
  } else if (!sec) {
    body = empty(b1 && !b1.ok ? b1.error : '讀取中…');
  } else if (!sec.ok) {
    body = empty(sec.error);
  } else if (phase === 'waiting') {
    body = empty(mode === 'long' ? '等待今日第一份榜單（09:00 起約每分鐘更新）' : '等待今日盤中快照');
  } else if (mode === 'long') {
    const common = { marks, indicative, onOpen: ui.openDrawer, now, asOf: sec.asOf };
    body = !shownLong.length
      ? empty(emptyLongText(strat, consOnly))
      : isMobile
        ? <LongCards rows={shownLong} {...common} />
        : <LongTable rows={shownLong} gold={gold} extra={extra} {...common} />;
  } else {
    const s = short?.ok ? short.data : null;
    const common = { marks, indicative, onOpen: ui.openDrawer };
    body = !shownShort.length
      ? empty(s?.noonDemote ? `${NOON_NOTE}${s.demoted ? `（${s.demoted} 檔）` : ''}` : '目前沒有符合 A／B 級的轉空型態')
      : isMobile
        ? <ShortCards rows={shownShort} {...common} />
        : <ShortTable rows={shownShort} extra={extra} {...common} />;
  }

  const footText = preOpen
    ? '榜單價每分鐘更新·量比為線性估計'
    : mode === 'long'
      ? `${early ? `開盤 ${Math.max(0, Math.floor(clock.minute - 540))} 分鐘·樣本少·` : ''}${LONG_FOOT}`
      : SHORT_FOOT;
  const foot = (
    <>
      <span className={css.footText} title={footText}>{footText}</span>
      {!preOpen && <MoreButton onClick={openZoom} />}
    </>
  );

  if (isMobile) {
    return (
      <ZoneFrame
        area="b1"
        title="機會"
        variant="mobile"
        extra={<span className={css.mCtl}>{modeChips}</span>}
        stamp={stamp}
        top={mode === 'long' && !preOpen ? <div className={css.mTop}>{stratSelect}{consChip}</div> : undefined}
        foot={foot}
      >
        {body}
      </ZoneFrame>
    );
  }

  return (
    <ZoneFrame
      area="b1"
      title="盤中機會榜"
      extra={(
        <span className={css.ctl}>
          {modeChips}
          {mode === 'long' ? <>{stratSelect}{consChip}</> : <span className={css.fixedTag}>轉空 A／B 級</span>}
        </span>
      )}
      stamp={stamp}
      foot={foot}
    >
      {body}
    </ZoneFrame>
  );
}
