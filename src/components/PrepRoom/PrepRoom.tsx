'use client';

// ─────────────────────────────────────────────────────────────────────────────
// 📋 盤前備課（currentPage 'prep'；2026-10-05 使用者裁定第 5 題）
// 收盤中戰情 v2 移出的「非盤中」清單：籌碼推選、凍結版漲停預測、跳空漲停、隔日沖決策工作台、軋空候選、空方候選。
//   - 每個分頁 dynamic import、只掛目前分頁（切走即卸載＝停止該面板的輪詢）；
//   - 記住上次分頁（prepTabs.ts：模組層級＋safe-storage，讀寫失敗退預設）；
//   - 進場資格＝盤中戰情 v2（useWarV2Allowed：只限超管，受身分模擬影響——2026-10-05「v2版只有超管可以用，暫不開放其它人使用」）；
//     其他人（含直連或從「上一頁」回到這裡）只顯示未開放說明與回盤中戰情的按鈕，不掛任何面板（不打任何 API）。
//     超管必為高級會員等級，原本的會員鎖（useWarAccess）因此不再需要。
// 面板本身沿用舊版戰情的元件（兩邊共用），輪詢違規已在元件內修正（SqueezePanel 閘門、GapLimitUpPanel 每拍重算、
// DecisionDesk 非受控輸入框）。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import dynamic from 'next/dynamic';
import { useRef, type ComponentType, type KeyboardEvent } from 'react';
import { useWarV2Allowed } from '@/components/WarRoomV2/parts/useWarAccess';
import { useAppStore } from '@/lib/store';
import { logActivity } from '@/lib/activity-logger';
import { PREP_TABS, usePrepTab, setPrepTab, type PrepTabId } from './prepTabs';
import styles from './PrepRoom.module.css';

function PanelLoading() {
  return <p className={styles.loading}>載入中…</p>;
}

const ChipPicksPanel = dynamic(() => import('@/components/WarRoom/ChipPicksPanel'), { loading: PanelLoading });
const LimitUpPanel = dynamic(() => import('@/components/WarRoom/LimitUpPanel'), { loading: PanelLoading });
/** 凍結版（盤後定案）；盤中即時重算版 source="live" 在盤中戰情 */
function LimitUpFrozen() {
  return <LimitUpPanel source="frozen" />;
}
const GapLimitUpPanel = dynamic(() => import('@/components/WarRoom/GapLimitUpPanel'), { loading: PanelLoading });
const DecisionDesk = dynamic(() => import('@/components/Candidates/DecisionDesk'), { loading: PanelLoading });
const SqueezePanel = dynamic(() => import('@/components/WarRoom/SqueezePanel'), { loading: PanelLoading });
const ShortPanel = dynamic(() => import('@/components/WarRoom/ShortPanel'), { loading: PanelLoading });

const PANELS: Record<PrepTabId, ComponentType> = {
  chip: ChipPicksPanel,
  limitup: LimitUpFrozen,
  gaplu: GapLimitUpPanel,
  desk: DecisionDesk,
  squeeze: SqueezePanel,
  short: ShortPanel,
};

const PANEL_ID = 'prep-panel';
const tabId = (id: PrepTabId) => `prep-tab-${id}`;

/** 非超管進到 'prep'（例：超管模擬會員時按「上一頁」回到這裡）：只說明事實並提供回盤中戰情（舊版）的入口 */
function NotOpen() {
  const navigateTo = useAppStore(s => s.navigateTo);
  return (
    <div className={styles.lock}>
      <div aria-hidden="true" className={styles.lockIcon}>🔒</div>
      <b>盤前備課目前未開放</b>
      籌碼推選、漲停預測、跳空漲停、隔日沖決策工作台、軋空與空方候選在盤中戰情的各分頁。
      <div style={{ marginTop: 12 }}>
        <button type="button" className={styles.toWar} style={{ marginLeft: 0, minHeight: 44 }} onClick={() => navigateTo('war')}>
          回盤中戰情 →
        </button>
      </div>
    </div>
  );
}

function TabBar({ active }: { active: PrepTabId }) {
  const refs = useRef<Partial<Record<PrepTabId, HTMLButtonElement | null>>>({});
  const select = (id: PrepTabId) => {
    if (id === active) return;
    setPrepTab(id);
    logActivity('prep_tab', { tab: id });
  };
  // 方向鍵／Home／End 在分頁間移動（WAI-ARIA tabs：自動啟用）
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = PREP_TABS.findIndex(t => t.id === active);
    const last = PREP_TABS.length - 1;
    const next = e.key === 'ArrowRight' ? (idx >= last ? 0 : idx + 1)
      : e.key === 'ArrowLeft' ? (idx <= 0 ? last : idx - 1)
        : e.key === 'Home' ? 0
          : e.key === 'End' ? last
            : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = PREP_TABS[next].id;
    select(id);
    refs.current[id]?.focus();
  };
  return (
    <div className={styles.tabs} role="tablist" aria-label="盤前備課分頁" onKeyDown={onKeyDown}>
      {PREP_TABS.map(t => {
        const on = t.id === active;
        return (
          <button
            key={t.id}
            ref={el => { refs.current[t.id] = el; }}
            type="button"
            role="tab"
            id={tabId(t.id)}
            aria-selected={on}
            aria-controls={PANEL_ID}
            tabIndex={on ? 0 : -1}
            className={on ? `${styles.tab} ${styles.tabOn}` : styles.tab}
            onClick={() => select(t.id)}
          >
            <span aria-hidden="true">{t.icon}</span>
            <span className={styles.labelFull}>{t.label}</span>
            <span className={styles.labelShort}>{t.shortLabel}</span>
          </button>
        );
      })}
    </div>
  );
}

function Room() {
  const active = usePrepTab();
  const navigateTo = useAppStore(s => s.navigateTo);
  const meta = PREP_TABS.find(t => t.id === active) ?? PREP_TABS[0];
  const Panel = PANELS[meta.id];
  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h1>📋 盤前備課</h1>
        <p className={styles.lead}>
          這些清單用的是前一交易日或盤後資料，適合盤前或盤後準備。盤中即時的部位、機會榜與異動在
          <button type="button" className={styles.toWar} onClick={() => navigateTo('war')}>盤中戰情 →</button>
          <br /><b>非投資建議。</b>
        </p>
      </header>
      <TabBar active={meta.id} />
      <p className={styles.basis}><b>資料時點</b>　{meta.basis}</p>
      <section className={styles.panel} role="tabpanel" id={PANEL_ID} aria-labelledby={tabId(meta.id)}>
        <Panel key={meta.id} />
      </section>
      <p className={styles.foot}>研究工具·資料為交易所公布與本站彙整·非投資建議</p>
    </div>
  );
}

export default function PrepRoom() {
  const allowed = useWarV2Allowed();
  if (!allowed) return <NotOpen />;   // 不掛任何面板 ⇒ 不打任何 API
  return <Room />;
}
