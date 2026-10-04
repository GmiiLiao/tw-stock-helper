'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import styles from './AfterMarket.module.css';

// ── 🌙 盤後報告（市場總覽分頁）──────────────────────────────────────────────
// 把收盤後整理出的分析資料集中在一頁：當晚消息（依影響比重排行）、每日熱力與權值股貢獻、市場結構、籌碼、選股訊號、事件日曆。
// 一個子分頁＝一組 API，切到才掛載（不一次打 20 支）；全部是公開、盤後定版或收盤後穩定的資料。
// 不放：盤中即時（量能暴增、漲停預測 live…）、盤前、會員限定（盤中戰情區）、管理／營運資料、使用者專屬資料。
// 本頁自己算的是「每日熱力」與「當晚消息排行」；其餘區塊是站內既有分析的彙整顯示，各卡標明資料日。
// 本頁不預測、不計分；排序與熱度都是描述，非投資建議。

const lazy = <T,>(p: () => Promise<{ default: React.ComponentType<T> }>) => dynamic(p, { loading: () => <p className={styles.note}>載入中…</p> });

const News = lazy(() => import('./AfterMarketNews'));
const DailyHeatmap = lazy(() => import('@/components/DailyHeatmap/DailyHeatmap'));
const WindHub = lazy<{ compact?: boolean }>(() => import('@/components/WindHub/WindHub'));
const ChipSignals = lazy<{ compact?: boolean; slot?: boolean }>(() => import('@/components/ChipSignals/ChipSignals'));
const EtfInfluence = lazy<{ compact?: boolean; slot?: boolean }>(() => import('@/components/EtfInfluence/EtfInfluence'));
const TopicPicks = lazy(() => import('@/components/StockPicker/TopicPicks'));
const SwingCurveBoard = lazy(() => import('@/components/StockPicker/SwingCurveBoard'));

const MarketHealthCard = lazy(() => import('./cards/MarketHealthCard'));
const MultiTimeframeCard = lazy(() => import('./cards/MultiTimeframeCard'));
const DayTradeRatioCard = lazy(() => import('./cards/DayTradeRatioCard'));
const TaifexCard = lazy(() => import('./cards/TaifexCard'));
const MarketReportCard = lazy(() => import('./cards/MarketReportCard'));
const InstStreaksCard = lazy(() => import('./cards/InstStreaksCard'));
const EtfPremiumCard = lazy(() => import('./cards/EtfPremiumCard'));
const MarginShortCard = lazy(() => import('./cards/MarginShortCard'));
const LendingCard = lazy(() => import('./cards/LendingCard'));
const MajorHoldersCard = lazy(() => import('./cards/MajorHoldersCard'));
const ScannerCard = lazy(() => import('./cards/ScannerCard'));
const RsRankingCard = lazy(() => import('./cards/RsRankingCard'));
const TradeSignalsCard = lazy(() => import('./cards/TradeSignalsCard'));
const PicksScoreboardCard = lazy(() => import('./cards/PicksScoreboardCard'));
const CatalystCalendarCard = lazy(() => import('./cards/CatalystCalendarCard'));
const DividendCalendarCard = lazy(() => import('./cards/DividendCalendarCard'));
const PriceEventsCard = lazy(() => import('./cards/PriceEventsCard'));
const SectorSpotCard = lazy(() => import('./cards/SectorSpotCard'));

type Tab = 'news' | 'heat' | 'structure' | 'chip' | 'picks' | 'events';
const TABS: { id: Tab; label: string }[] = [
  { id: 'news', label: '📰 當晚消息' }, { id: 'heat', label: '🔥 熱力·權值股' }, { id: 'structure', label: '🧭 市場結構' },
  { id: 'chip', label: '🏦 籌碼' }, { id: 'picks', label: '🎯 選股訊號' }, { id: 'events', label: '📅 事件日曆' },
];

export default function AfterMarketReport() {
  const [tab, setTab] = useState<Tab>('news');
  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h2>🌙 盤後報告</h2>
        <p className={styles.note}>
          收盤後整理的分析資料集中於此，各區塊標明資料日。本頁不預測、不計分；排序與熱度都是描述，<b>非投資建議</b>。
          盤中即時、盤前與會員限定資料不在此頁。
        </p>
      </header>
      <div className={styles.tabs} role="tablist" aria-label="盤後報告分頁">
        {TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? styles.tabOn : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>

      {tab === 'news' && <News />}
      {tab === 'heat' && <DailyHeatmap />}
      {tab === 'structure' && (
        <div className={styles.stack}>
          <MarketReportCard />
          <WindHub />
          <div className={styles.grid}><MarketHealthCard /><MultiTimeframeCard /><DayTradeRatioCard /><TaifexCard /></div>
        </div>
      )}
      {tab === 'chip' && (
        <div className={styles.stack}>
          <div className={styles.grid}><ChipSignals compact slot /><EtfInfluence compact slot /></div>
          <div className={styles.grid}><InstStreaksCard /><EtfPremiumCard /><MarginShortCard /><LendingCard /><MajorHoldersCard /></div>
        </div>
      )}
      {tab === 'picks' && (
        <div className={styles.stack}>
          <p className={styles.note}>以下是站內既有盤後榜單的彙整，非本頁預測；各榜單的口徑與警語以其原頁面為準。</p>
          <div className={styles.grid}><ScannerCard /><RsRankingCard /><TradeSignalsCard /><PicksScoreboardCard /></div>
          <TopicPicks />
          <SwingCurveBoard />
        </div>
      )}
      {tab === 'events' && (
        <div className={styles.grid}><CatalystCalendarCard /><DividendCalendarCard /><PriceEventsCard /><SectorSpotCard /></div>
      )}
    </div>
  );
}
