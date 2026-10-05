'use client';

// C2 漲停順序流的列（區塊與放大層共用）。新到舊；同題材第 3 家下方標「族群成形」，已成形題材的列左側紅色條。
// 點整列＝快看抽屜；點代號＝個股頁。「5日N板」是近 5 日漲停次數（daemon 的 luCnt5），不是連板數。
import type { KeyboardEvent, MouseEvent } from 'react';
import { useAppStore } from '@/lib/store';
import type { LimitFlowRow } from '@/lib/warroom/build-feeds';
import { useWarUi } from './WarRoomContext';
import styles from './WarRoomV2.module.css';
import ls from './ZoneLimitFlow.module.css';

/** 「族群成形」說明列算 0.6 列高（33px 列、約 20px 說明） */
const FORMED_COST = 0.6;

/** 依可用列數挑出要顯示的列（新到舊） */
export function fitFlowRows(rows: readonly LimitFlowRow[], budget: number): LimitFlowRow[] {
  const out: LimitFlowRow[] = [];
  let used = 0;
  for (const r of rows) {
    const cost = 1 + (r.formed ? FORMED_COST : 0);
    if (used + cost > budget) break;
    out.push(r);
    used += cost;
  }
  return out;
}

function goStock(e: MouseEvent, code: string) {
  e.stopPropagation();
  useAppStore.getState().navigateTo('stock', code);
}

function FlowRow({ r }: { r: LimitFlowRow }) {
  const { openDrawer } = useWarUi();
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(r.code); }
  };
  const groupTitle = r.groupKind === 'industry' ? `${r.group}（官方產業別；無題材對照）` : r.group ?? '';
  return (
    <>
      <div
        className={r.inFormedGroup ? `${ls.lf} ${ls.grp}` : ls.lf}
        role="button" tabIndex={0} onClick={() => openDrawer(r.code)} onKeyDown={onKey}
        title={`當日第 ${r.rank} 家觸及漲停`}
      >
        <span className={ls.tm}>{r.time}</span>
        <span className={ls.who}>
          <button type="button" className={ls.codeBtn} onClick={(e) => goStock(e, r.code)} title="個股頁">{r.code}</button>
          <span className={ls.nm}>{r.name}</span>
        </span>
        <span className={r.groupKind === 'industry' ? `${ls.cl} ${ls.clInd}` : ls.cl} title={groupTitle}>
          {r.group ?? '—'}{r.groupKind === 'theme' && r.groupRank ? ` ${r.groupRank}` : ''}
        </span>
        <span className={ls.boards} title={r.boards?.startsWith('5日') ? '近 5 個交易日的漲停次數（含今日），不是連板數' : undefined}>{r.boards ?? ''}</span>
      </div>
      {r.formed && <div className={ls.formed}>↳ {r.group} 第 {r.groupRank} 家·族群成形</div>}
    </>
  );
}

export function LimitFlowList({ rows }: { rows: readonly LimitFlowRow[] }) {
  return <div>{rows.map((r) => <FlowRow key={r.code} r={r} />)}</div>;
}

/** 手機卡片（手機版目前不掛 C2；保留 variant 一致性） */
export function LimitFlowCard({ r }: { r: LimitFlowRow }) {
  const { openDrawer } = useWarUi();
  return (
    <div className={styles.card} role="button" tabIndex={0} onClick={() => openDrawer(r.code)}
      onKeyDown={(e) => { if (e.key === 'Enter') openDrawer(r.code); }}>
      <div className={styles.cardA}>
        <span className={ls.tm}>{r.time}</span>
        <span className={styles.code}>{r.code}</span>
        <span className={styles.name}>{r.name}</span>
        <span className={`${styles.cardPx} ${ls.boards}`}>{r.boards ?? ''}</span>
      </div>
      <div className={styles.cardB}>
        <span>第 {r.rank} 家</span>
        {r.group && <span>{r.group}{r.groupKind === 'theme' && r.groupRank ? ` 第 ${r.groupRank} 家` : ''}</span>}
        {r.formed && <span>族群成形</span>}
      </div>
    </div>
  );
}
