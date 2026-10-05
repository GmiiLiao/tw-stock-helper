'use client';

// B2 即時異動流的列（桌機列、手機卡片、放大層全部紀錄共用）與篩選。
// 互動統一：點整列＝快看抽屜（ui.openDrawer）；點代號＝進個股頁（navigateTo('stock', code)）。
// 合併規則：同檔同類 10 分鐘併成一列「（×n）」；最近 15 分鐘內我的警示（本機 events.ts）最多 3 則置頂。
import { useMemo, type KeyboardEvent, type MouseEvent } from 'react';
import { useAppStore } from '@/lib/store';
import { mergeFeedGroups, pinMineFirst } from '../../../scripts/lib/warroom-feeds.mjs';
import { WAR_EVENT_LABEL } from './events';
import { useWarUi } from './WarRoomContext';
import { Chip } from './parts/Chip';
import { NewTag } from './parts/Badge';
import { hhmm, hhmmss } from './parts/fmt';
import type { FeedItem } from './FeedData';
import styles from './WarRoomV2.module.css';
import fs from './ZoneFeed.module.css';

export type FeedFilter = 'all' | 'mine' | 'long' | 'short';
export interface FeedGroup { head: FeedItem; count: number }

const FILTERS: readonly { key: FeedFilter; label: string }[] = [
  { key: 'all', label: '全部' }, { key: 'mine', label: '我的' }, { key: 'long', label: '做多' }, { key: 'short', label: '做空' },
];

function passes(it: FeedItem, f: FeedFilter): boolean {
  if (f === 'mine') return it.mine;
  if (f === 'long') return it.side === 'long';
  if (f === 'short') return it.side === 'short';
  return true;
}

/** 篩選 → 同檔同類 10 分鐘合併 → 我的警示置頂 */
export function groupFeed(items: readonly FeedItem[], filter: FeedFilter, now: number): FeedGroup[] {
  const list = filter === 'all' ? items : items.filter((it) => passes(it, filter));
  return pinMineFirst(mergeFeedGroups(list), now, { isPinnable: (g) => g.head.local && (g.head.mine || g.head.level === 1) });
}

export function useFeedGroups(items: readonly FeedItem[], filter: FeedFilter, now: number) {
  const groups = useMemo(() => groupFeed(items, filter, now), [items, filter, now]);
  const mineCount = useMemo(() => mergeFeedGroups(items.filter((it) => it.mine)).length, [items]);
  return { groups, mineCount };
}

export function FeedFilterChips({ value, onChange, mineCount }: { value: FeedFilter; onChange: (f: FeedFilter) => void; mineCount: number }) {
  return (
    <>
      {FILTERS.map((f) => (
        <Chip key={f.key} on={value === f.key} onClick={() => onChange(f.key)}>
          {f.key === 'mine' && mineCount > 0 ? `${f.label} ${mineCount}` : f.label}
        </Chip>
      ))}
    </>
  );
}

function typeLabel(it: FeedItem): string {
  if (it.local && it.level === 1) return '我的·一級';
  return WAR_EVENT_LABEL[it.kind] ?? '訊息';
}

function typeClass(it: FeedItem): string {
  if (it.local || (it.mine && it.level === 1)) return `${fs.ty} ${fs.tyMine}`;
  if (it.source === 'O') return `${fs.ty} ${fs.tyO}`;
  return fs.ty;
}

const SOURCE_TITLE = { O: '官方公告（公開資訊觀測站）', M: '媒體新聞（AI 讀過內文才判別）' } as const;

function goStock(e: MouseEvent, code: string) {
  e.stopPropagation();
  useAppStore.getState().navigateTo('stock', code);
}

/** 代號＋名稱＋描述（伺服器事件）；本機事件的文案已含代號，直接顯示。NEW 放在描述前，長文被截斷時仍看得到 */
function Body({ it, count, isNew }: { it: FeedItem; count: number; isNew: boolean }) {
  return (
    <>
      {!it.local && it.code && (
        <>
          <button type="button" className={fs.codeBtn} onClick={(e) => goStock(e, it.code!)} title="個股頁">{it.code}</button>
          {it.name && <span className={fs.nm}>{it.name}</span>}
        </>
      )}
      {isNew && <span className={fs.newWrap}><NewTag /></span>}
      {it.text}
      {count > 1 && <span className={fs.cnt}>（×{count}）</span>}
    </>
  );
}

function useRowOpen(code?: string) {
  const { openDrawer } = useWarUi();
  if (!code) return {};
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: () => openDrawer(code),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(code); }
    },
  };
}

export function FeedRow({ group, isNew, flash }: { group: FeedGroup; isNew: boolean; flash: boolean }) {
  const it = group.head;
  const open = useRowOpen(it.code);
  const cls = [fs.ev, it.code ? fs.click : '', it.mine ? fs.mine : '', flash ? styles.flashBg : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} {...open}>
      <span className={fs.tm}>{hhmmss(it.at)}</span>
      <span className={typeClass(it)} title={typeLabel(it)}>{typeLabel(it)}</span>
      <span className={fs.tx}><Body it={it} count={group.count} isNew={isNew} /></span>
      {it.source ? <span className={fs.src} title={SOURCE_TITLE[it.source]}>{it.source}</span> : <span />}
    </div>
  );
}

export function FeedCard({ group, isNew, flash }: { group: FeedGroup; isNew: boolean; flash: boolean }) {
  const it = group.head;
  const open = useRowOpen(it.code);
  const cls = [styles.card, it.mine ? fs.cardMine : '', it.code ? '' : fs.cardStatic, flash ? styles.flashBg : ''].filter(Boolean).join(' ');
  return (
    <div className={cls} {...open}>
      <div className={styles.cardA}>
        <span className={fs.tm}>{hhmm(it.at)}</span>
        <span className={typeClass(it)}>{typeLabel(it)}</span>
        {!it.local && it.code && <span className={styles.code}>{it.code}</span>}
        {!it.local && it.name && <span className={styles.name}>{it.name}</span>}
        {isNew && <NewTag />}
        {it.source && <span className={`${fs.src} ${styles.cardPx}`} title={SOURCE_TITLE[it.source]}>&nbsp;{it.source}&nbsp;</span>}
      </div>
      <div className={styles.cardB}>
        <span className={fs.cardText}>{it.text}{group.count > 1 ? `（×${group.count}）` : ''}</span>
      </div>
    </div>
  );
}

export function FeedList({ groups, isNew, flashing }: { groups: readonly FeedGroup[]; isNew: (id: string) => boolean; flashing: ReadonlySet<string> }) {
  return (
    <div className={fs.list}>
      {groups.map((g) => <FeedRow key={g.head.id} group={g} isNew={isNew(g.head.id)} flash={flashing.has(g.head.id)} />)}
    </div>
  );
}

/** 頁尾說明：資料來源標記＋本期沒有資料來源的事件類型（不捏造） */
export const FEED_FOOT = 'O＝官方公告·M＝媒體新聞（AI 讀過內文才判別；影響權重研究期·只顯示，只表強弱）·同檔同類 10 分鐘合併·當沖事件只在時段焦點';
export const FEED_MISSING_NOTE = '首觸跌停與新增處置目前沒有 daemon 資料文件，本頁不列（不捏造）。重訊只列今日有動靜的個股與你的持股、釘選。';
