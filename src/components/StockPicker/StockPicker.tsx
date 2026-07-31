'use client';

import { useAppStore } from '@/lib/store';
import AIRecommend from '@/components/AIRecommend/AIRecommend';
import Screener from '@/components/Screener/Screener';
import NlScreen from './NlScreen';
import StrategyPicks from './StrategyPicks';
import styles from './StockPicker.module.css';
import PageHelp from '@/components/Help/PageHelp';

type PickerTab = 'recommend' | 'strategy' | 'screen';

const TABS: { id: PickerTab; label: string; icon: string; hint: string }[] = [
  { id: 'recommend', label: 'AI 推薦選股', icon: '🤖', hint: '全市場評分 · 買賣點' },
  { id: 'strategy',  label: '選股策略',   icon: '📐', hint: '實測驗證 · 隔日沖' },
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
        {tab === 'strategy' && <StrategyPicks />}
        {tab === 'screen' && <Screener />}
      </div>
    </div>
  );
}
