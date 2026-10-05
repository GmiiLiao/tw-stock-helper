'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import styles from './AfterMarket.module.css';
import { dayLabel, fmtTs, useApi } from './shared';

// ── 🌙 盤後報告（市場總覽分頁）──────────────────────────────────────────────
// 只放其他頁沒有的收盤後資料：當晚消息（依影響比重排行）、每日熱力與權值股貢獻、價格結構事件與現貨。
// 大盤總覽已有的（風向總覽、籌碼訊號、第四法人、大盤體質、法人連買、ETF 折溢價、借券、千張大戶、外資期貨、高當沖、事件日曆、
//   盤後回顧）、「每日新聞」的要聞導讀、「選股」頁的榜單（選股掃描、RS、隔日沖、軋空、推薦成績、話題、波段）一律不重複放
//   （2026-10-04 使用者：重疊太多，取消不必要的；選股訊號分頁已依建議移除）。
// 一個子分頁＝一組 API，切到才掛載；全部是公開、盤後定版或收盤後穩定的資料。
// 不放：盤中即時、盤前、會員限定（盤中戰情區）、管理／營運資料、使用者專屬資料。
// 本頁自己算的是「每日熱力」與「當晚消息排行」；價格結構事件與現貨是站內既有資料（站上其他頁沒有消費端）。
// 本頁不預測、不計分；排序與熱度都是描述，非投資建議。

const lazy = <T,>(p: () => Promise<{ default: React.ComponentType<T> }>) => dynamic(p, { loading: () => <p className={styles.note}>載入中…</p> });

const News = lazy(() => import('./AfterMarketNews'));
const Analysis = lazy(() => import('./AnalysisReport'));
const DailyHeatmap = lazy(() => import('@/components/DailyHeatmap/DailyHeatmap'));

const PriceEventsCard = lazy(() => import('./cards/PriceEventsCard'));
const SectorSpotCard = lazy(() => import('./cards/SectorSpotCard'));

type Tab = 'news' | 'heat' | 'events' | 'report';
const TABS: { id: Tab; label: string }[] = [
  { id: 'news', label: '📰 當晚消息' }, { id: 'heat', label: '🔥 熱力·權值股' }, { id: 'events', label: '📅 事件與現貨' }, { id: 'report', label: '📝 分析報告' },
];

/** 頁首更新時間：熱力定版、媒體消息判讀、官方公告各自的時間（資料日標註在前）。 */
function UpdatedAt() {
  const heat = useApi<{ dataDate: string; canonicalAt: string }>('/api/twse/daily-heatmap');
  const news = useApi<{ media: { updatedAt: number | null; targetDate: string | null }; official: { updatedAt: number | null } }>('/api/twse/after-market-news');
  const parts: string[] = [];
  if (heat.data) parts.push(`每日熱力：${dayLabel(heat.data.dataDate)} 收盤資料，定版 ${fmtTs(heat.data.canonicalAt)}`);
  if (news.data) {
    parts.push(`媒體消息判讀：更新 ${fmtTs(news.data.media.updatedAt)}（適用交易日 ${news.data.media.targetDate ?? '—'}）`);
    parts.push(`官方重大訊息：最新公告 ${fmtTs(news.data.official.updatedAt)}`);
  }
  return <p className={styles.note}>🕒 <b>更新時間</b>　{parts.length ? parts.join('｜') : '載入中…'}</p>;
}

export default function AfterMarketReport() {
  const [tab, setTab] = useState<Tab>('news');
  return (
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h2>🌙 盤後報告</h2>
        <p className={styles.note}>
          本頁只放其他頁沒有的盤後資料（當晚消息排行、熱力與權值股貢獻、價格結構事件與現貨）；風向、籌碼、事件日曆請見「大盤總覽」，榜單與推薦成績請見「選股」。各區塊標明資料日；不預測、不計分，排序與熱度都是描述，<b>非投資建議</b>。
        </p>
        <UpdatedAt />
        <p className={styles.note}>報價名稱：<b>現價</b>＝目前價（盤中為即時價、收盤後即收盤價），<b>昨收</b>＝前一交易日收盤價；<b>前交易日 M/D</b>＝該日收盤資料，其餘數字都標註日期。</p>
      </header>
      <div className={styles.tabsBar}>
        <div className={styles.tabs} role="tablist" aria-label="盤後報告分頁">
          {TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? styles.tabOn : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </div>
      </div>

      {tab === 'news' && <News />}
      {tab === 'heat' && <DailyHeatmap />}
      {tab === 'report' && <Analysis />}
      {tab === 'events' && (
        <div className={styles.stack}>
          <h3 className={styles.groupTitle}>價格結構事件與現貨報價</h3>
          <div className={styles.grid}><PriceEventsCard /><SectorSpotCard /></div>
          <p className={styles.note}>除權息行事曆與事件日曆請見「大盤總覽」，要聞導讀請見「每日新聞」，選股榜單請見「選股」。</p>
        </div>
      )}
    </div>
  );
}
