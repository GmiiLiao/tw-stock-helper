'use client';

import { useAppStore } from '@/lib/store';
import AIRecommend from '@/components/AIRecommend/AIRecommend';
import Screener from '@/components/Screener/Screener';
import NlScreen from './NlScreen';
import StrategyPicks from './StrategyPicks';
import SignalBoards from './SignalBoards';
import TopicPicks from './TopicPicks';
import { MODES } from '@/lib/trading-mode';
import styles from './StockPicker.module.css';
import PageHelp from '@/components/Help/PageHelp';

type PickerTab = 'recommend' | 'boards' | 'topic' | 'strategy' | 'screen';

// 📋 訊號榜單（2026-08-03 新增）：整理前選股清單散在市場總覽(6張)、指數新聞(2張)、
//   本頁、盤中戰情、即時追蹤共五處，使用者得先想「這張在哪一頁」。全部收攏到這裡
//   並依操作模式過濾——切模式就換一整組榜單。
// hint 不再寫死「隔日沖」：模式化之後那句話只有在隔日沖模式才成立。
const tabs = (modeLabel: string, modeHorizon: string): { id: PickerTab; label: string; icon: string; hint: string }[] => [
  { id: 'recommend', label: 'AI 推薦選股', icon: '🤖', hint: '全市場評分 · 買賣點' },
  { id: 'boards',    label: '訊號榜單',   icon: '📋', hint: `${modeLabel} · ${modeHorizon}` },
  // ⚠hint 固定寫「隔日沖」是刻意的——StrategyPicks 的內容是撿尾盤定版濾網，
  //   **純隔日沖口徑**（明開賣）。把 hint 改成跟著模式跑會變成說謊：
  //   在波段模式顯示「實測驗證·波段」，但裡面給的是隔日沖的策略。
  //   內容沒有多口徑版本之前，標籤就得誠實地釘死在它真正的口徑上。
  // 🎯話題選股（2026-08-05 由「指數·新聞」搬來）：hint 同樣釘死在它真正的口徑上。
  //   它**不掛任何模式**——三張清單的窗口各不相同（5日/隔日/避開），
  //   掛上某個模式等於宣稱它有那個模式的實證。
  { id: 'topic',     label: '話題選股',   icon: '🎯', hint: '新聞話題 × 5日線 · 不分模式' },
  { id: 'strategy',  label: '選股策略',   icon: '📐', hint: '實測驗證 · 隔日沖口徑' },
  { id: 'screen',    label: '進階篩選',   icon: '🔍', hint: '自訂條件 · 比較分析' },
];

/**
 * Unified stock-picking page. Merges the former separate "AI 推薦選股" and
 * "選股引擎" nav entries into one page with two tabs. Both share the same
 * backend rating source (/api/rating), so grades/signals stay consistent.
 */
export default function StockPicker() {
  // 主分頁存在 store，進個股再返回時回到原本分頁而非重置
  const tab = useAppStore(s => s.pickerTab) as PickerTab;
  const setTab = useAppStore(s => s.setPickerTab);
  const mode = useAppStore(s => s.tradingMode);
  const M = MODES[mode];
  const TABS = tabs(M.label, M.horizon);

  return (
    <div className={styles.wrapper}>
      <PageHelp id="picker" />
      {/* 自然語言選股（AI 解析白話需求 → 篩選） */}
      <NlScreen />

      <div className={styles.tabBar} role="tablist" aria-label="選股模式">
        {TABS.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            id={`picker-tab-${t.id}`}
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className={styles.tabIcon}>{t.icon}</span>
            <span className={styles.tabLabel}>{t.label}</span>
            <span className={styles.tabHint}>{t.hint}</span>
          </button>
        ))}
      </div>

      <div className={styles.panel}>
        {/* Keep both mounted-on-demand; each manages its own data fetching. */}
        {tab === 'recommend' && <AIRecommend />}
        {tab === 'boards' && <SignalBoards />}
        {tab === 'topic' && <TopicPicks />}
        {tab === 'strategy' && (
          <>
            {/* 跨模式口徑警告：本分頁內容是隔日沖的撿尾盤定版濾網，在別的模式
                進來時必須明說，否則會拿隔日沖清單去做 5 日波段（實測 -0.06%）。 */}
            {mode !== 'nextday' && (
              <div style={{ margin: '0 0 12px', padding: '9px 12px', borderRadius: 9, background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.35)', fontSize: 'calc(12px * var(--fz))', color: '#fbbf24', lineHeight: 1.7 }}>
                ⚠ 你目前在 <b>{M.icon}{M.label}模式（{M.horizon}）</b>，但本分頁的策略是<b>隔日沖口徑</b>（今收買→明開賣）的實測結果。
                兩者持有期不同，<b>數字不可互推</b>——波段起漲訊號拿去隔日沖實測是 -0.06%。要看本模式的清單請切到「📋 訊號榜單」。
              </div>
            )}
            <StrategyPicks />
          </>
        )}
        {tab === 'screen' && <Screener />}
      </div>
    </div>
  );
}
