'use client';

import dynamic from 'next/dynamic';
import { useAppStore } from '@/lib/store';
import type { StockInfo } from '@/lib/twse-api';
import { formatVolume, formatChangeSign, formatChangePercentSign, getChangeColor, isLimitUp, isLimitDown, marketBadge, isExchangeListed } from '@/lib/twse-api';
import PremarketBrief from './PremarketBrief';
import PremarketHub from './PremarketHub';
import MarketInsights from './MarketInsights';
import IndexAnalysis from '@/components/IndexNews/IndexAnalysis';
import DailyNews from '@/components/IndexNews/DailyNews';
import TradingRules from '@/components/TradingRules/TradingRules';
import RiskBadge from '@/components/shared/RiskBadge';
import ThirdPartyNote from '@/components/shared/ThirdPartyNote';
import { otcSourceOfStocks } from '@/lib/otc-source';
import WindHub from '@/components/WindHub/WindHub';
import WashoutBanner from './WashoutBanner';
import ChipSignals from '@/components/ChipSignals/ChipSignals';
import EtfInfluence from '@/components/EtfInfluence/EtfInfluence';
import { useLiveQuotes } from '@/lib/useLiveQuotes';
import styles from './Dashboard.module.css';
import PageHelp from '@/components/Help/PageHelp';
import { useShallow } from 'zustand/react/shallow';
import { useDayTradeCodes, statusOf, DT_STYLE } from '@/lib/useDayTradeCodes';

// 盤後報告頁（每日熱力、當晚消息排行、盤後整理的分析資料）：只有點到分頁才下載（首屏不增加 bundle）
const AfterMarketReport = dynamic(() => import('@/components/AfterMarket/AfterMarketReport'));

function StatCard({
  label,
  value,
  sub,
  color,
  icon,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: string;
  icon?: string;
}) {
  return (
    <div className={styles.statCard}>
      <div className={styles.statHeader}>
        <span className={styles.statLabel}>{label}</span>
        {icon && <span className={styles.statIcon}>{icon}</span>}
      </div>
      <div className={styles.statValue} style={{ color: color || 'var(--text-primary)' }}>
        {value}
      </div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
}

function WatchlistCard() {
  const { watchlist, allStocks, navigateTo, removeFromWatchlist } = useAppStore(useShallow((s) => ({ watchlist: s.watchlist, allStocks: s.allStocks, navigateTo: s.navigateTo, removeFromWatchlist: s.removeFromWatchlist })));
  const live = useLiveQuotes(watchlist.map(w => w.code));

  const watchStocks = watchlist.map(w => {
    const info = allStocks.find(s => s.code === w.code);
    const base = info || { code: w.code, name: w.name, price: 0, change: 0, changePercent: 0, volume: 0 } as StockInfo;
    const q = live[w.code];
    // Overlay real-time MIS price when available.
    return q && q.price > 0 ? { ...base, price: q.price, change: q.change, changePercent: q.changePercent } : base;
  });

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>⭐ 自選股</h2>
        <span className={styles.sectionBadge}>{watchlist.length}</span>
      </div>
      <div className={styles.watchlist}>
        {watchStocks.length === 0 ? (
          <div className={styles.emptyState}>搜尋股票後點擊星號加入自選股</div>
        ) : (
          watchStocks.map(stock => {
            const color = getChangeColor(stock.change);
            return (
              <div
                key={stock.code}
                id={`watchlist-${stock.code}`}
                className={styles.watchlistItem}
                onClick={() => {
                  navigateTo('stock', stock.code);
                }}
              >
                <div className={styles.watchlistLeft}>
                  <span className={styles.watchCode}>{stock.code}</span>
                  <span className={styles.watchName}>{stock.name}</span>
                  <RiskBadge code={stock.code} size="xs" />
                </div>
                <div className={styles.watchlistRight}>
                  <span className={styles.watchPrice} style={{ color }}>
                    {stock.price > 0 ? stock.price.toFixed(2) : '--'}
                  </span>
                  <span className={styles.watchChange} style={{ color }}>
                    {stock.price > 0 ? formatChangeSign(stock.change) : '--'}
                    {stock.price > 0 ? ` (${formatChangePercentSign(stock.changePercent)})` : ''}
                  </span>
                </div>
                <button
                  className={styles.removeBtn}
                  onClick={(e) => { e.stopPropagation(); removeFromWatchlist(stock.code); }}
                  title="移除自選股"
                >×</button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function TopMoversTable({ title, stocks, type }: { title: string; stocks: StockInfo[]; type: 'up' | 'down' }) {
  const navigateTo = useAppStore((s) => s.navigateTo);
  // 漲跌幅顏色依「每一檔自己的漲跌」決定（上漲紅、下跌綠、平盤灰），不能依表的類型——
  //   2026-10-02 使用者實報：成交量排行（type="up"）整欄紅字，下跌也是紅；跌勢日的漲幅榜／漲勢日的跌幅榜也會錯色

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{title}</h2>
      </div>
      <div className={styles.moversTable}>
        {/* ⚠ 第一格是排名欄的佔位，**不可刪**（2026-08-10 實測）：
            資料列有 6 格（排名／代號／名稱／現價／漲跌幅／成交量），表頭原本只有 5 格，
            於是每個標題都往左偏一欄——「代號」壓在排名欄上、「成交量」被擠出格線外，
            手機上直接被壓成 20px 的直排。表頭與資料列的格數必須一致。 */}
        <div className={styles.moversHeader}>
          <span aria-hidden="true" />
          <span>代號</span>
          <span>名稱</span>
          <span>現價</span>
          <span>漲跌幅</span>
          <span>成交量</span>
        </div>
        {stocks.slice(0, 10).map((stock, i) => (
          <div
            key={stock.code}
            id={`mover-${type}-${stock.code}`}
            className={styles.moversRow}
            onClick={() => { navigateTo('stock', stock.code); }}
          >
            <span className={styles.rankNum}>{i + 1}</span>
            <span className={styles.moversCode}>{stock.code}</span>
            <span className={styles.moversName}>
              {stock.name}
              {(() => { const b = marketBadge(stock); return b ? <span style={{ marginLeft: 4, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: b.c, border: `1px solid ${b.c}55`, borderRadius: 4, padding: '0 3px' }}>{b.t}</span> : null; })()}
              <RiskBadge code={stock.code} size="xs" />
            </span>
            <span className={styles.moversPrice}>{stock.price.toFixed(2)}</span>
            <span className={styles.moversChange} style={{ color: getChangeColor(stock.changePercent) }}>
              {formatChangePercentSign(stock.changePercent)}
            </span>
            <span className={styles.moversVol}>{formatVolume(stock.volume)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// 漲停/跌停全列表 — 熱力圖同款緊湊格狀排版，全部顯示不截斷。
function LimitBoard({ stocks }: { stocks: StockInfo[] }) {
  // 漲停榜是當沖最常下手的地方：追進去卻不能當沖，就只能被迫留倉。
  const dt = useDayTradeCodes();
  const navigateTo = useAppStore((s) => s.navigateTo);
  const byValue = (a: StockInfo, b: StockInfo) => b.value - a.value;
  // 普通股（上市+上櫃，4 碼非 00 開頭）；漲跌停用精確檔位算法（昨收×1.1 向下取檔），
  // 低價股實際漲停 % 可低至 ~9.5%，固定 % 門檻會漏。
  // 興櫃沒有漲跌停，必須排除（7924 TLC-KY 這類 4 碼非 00 開頭會被舊濾網誤納）
  const isRegular = (s: StockInfo) => isExchangeListed(s);
  const ups = stocks.filter(s => isRegular(s) && s.price > 0 && isLimitUp(s.price, s.change)).sort(byValue);
  const downs = stocks.filter(s => isRegular(s) && s.price > 0 && isLimitDown(s.price, s.change)).sort(byValue);
  if (!ups.length && !downs.length) return null;

  const cell = (s: StockInfo, up: boolean) => {
    const badge = marketBadge(s);
    return (
      <button key={s.code} className={styles.heatmapCell}
        style={{ background: up ? 'rgba(201,42,42,0.6)' : 'rgba(30,126,52,0.6)', position: 'relative' }}
        onClick={() => navigateTo('stock', s.code)} title={`${s.code} ${s.name} ${s.price}（${badge?.t === '櫃' ? '上櫃' : badge?.t === '市' ? '上市' : badge?.t === '創' ? '創新板' : badge?.t || ''}）`}>
        {badge && <span style={{ position: 'absolute', top: 2, right: 3, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: badge.c, opacity: 0.95 }}>{badge.t}</span>}
        {(() => { const st = statusOf(dt, s.code); return st == null ? null : (
          <span title={DT_STYLE[st].title}
            style={{ position: 'absolute', top: 2, left: 3, fontSize: 'calc(12.5px * var(--fz))', opacity: st === 1 ? 0.55 : 1 }}>
            {DT_STYLE[st].short}
          </span>); })()}
        <span className={styles.heatCode}>{s.code}</span>
        <span className={styles.heatName}>{s.name}</span>
        <span className={styles.heatChange} style={{ color: up ? '#ffb3b3' : '#9fe8ac' }}>
          {s.price} <span style={{ fontSize: 'calc(12.5px * var(--fz))', opacity: 0.95 }}>{s.changePercent >= 0 ? '+' : ''}{s.changePercent?.toFixed(1)}%</span>
        </span>
      </button>
    );
  };

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} style={{ whiteSpace: 'nowrap' }}>🧱 漲停跌停榜</h2>
        <span className={styles.sectionSub}>
          <span style={{ color: 'var(--color-up)', fontWeight: 700 }}>漲停 {ups.length}</span>
          {' · '}
          <span style={{ color: 'var(--color-down)', fontWeight: 700 }}>跌停 {downs.length}</span>
          {'　依成交值排序'}
        </span>
      </div>
      {ups.length > 0 && (
        <div className={styles.heatmap} style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', paddingBottom: downs.length ? 4 : 12 }}>
          {ups.map(s => cell(s, true))}
        </div>
      )}
      {downs.length > 0 && (
        <div className={styles.heatmap} style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', paddingTop: ups.length ? 4 : 12 }}>
          {downs.map(s => cell(s, false))}
        </div>
      )}
    </div>
  );
}

function MarketHeatmap({ stocks }: { stocks: StockInfo[] }) {
  // Simple top-30 by volume heatmap
  const top30 = [...stocks]
    .filter(s => s.volume > 0 && s.price > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 30);

  const navigateTo = useAppStore((s) => s.navigateTo);
  const dt = useDayTradeCodes();

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>🗺️ 市值熱力圖 (Top 30)</h2>
        <span className={styles.sectionSub}>依成交值排序</span>
      </div>
      <div className={styles.heatmap}>
        {top30.map(stock => {
          const change = stock.changePercent;
          const intensity = Math.min(Math.abs(change) / 5, 1);
          const isLimitUp = change >= 9.9;
          const isLimitDown = change <= -9.9;
          let bg, fg;
          if (change > 0) {
            // Taiwan: red = up
            bg = isLimitUp
              ? `rgba(201, 42, 42, 0.6)`
              : `rgba(240, 62, 62, ${0.1 + intensity * 0.45})`;
            fg = isLimitUp ? '#ff8080' : `rgba(240, 62, 62, ${0.7 + intensity * 0.3})`;
          } else if (change < 0) {
            // Taiwan: green = down
            bg = isLimitDown
              ? `rgba(30, 126, 52, 0.6)`
              : `rgba(47, 158, 68, ${0.1 + intensity * 0.45})`;
            fg = isLimitDown ? '#6bcf7f' : `rgba(47, 158, 68, ${0.7 + intensity * 0.3})`;
          } else {
            bg = 'rgba(148, 163, 184, 0.08)';
            fg = 'var(--color-flat)';
          }
          return (
            <button
              key={stock.code}
              id={`heatmap-${stock.code}`}
              className={styles.heatmapCell}
              style={{ background: bg, position: 'relative' }}
              onClick={() => { navigateTo('stock', stock.code); }}
              title={`${stock.code} ${stock.name}`}
            >
              {(() => { const st = statusOf(dt, stock.code); return st == null ? null : (
                <span title={DT_STYLE[st].title}
                  style={{ position: 'absolute', top: 2, left: 3, fontSize: 'calc(12.5px * var(--fz))', opacity: st === 1 ? 0.55 : 1 }}>
                  {DT_STYLE[st].short}
                </span>); })()}
              <span className={styles.heatCode}>{stock.code}</span>
              <span className={styles.heatName}>{stock.name}</span>
              <span className={styles.heatChange} style={{ color: fg }}>
                {formatChangePercentSign(stock.changePercent)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── 市場總覽分頁（2026-08-05 併入指數與新聞）────────────────────
// 使用者：「將指數、新聞，搬到市場總覽裡，該是分頁的請做好分頁」。
// 併回來的理由：指數與新聞都是**大盤背景**，而人要看大盤時本來就在這一頁。
//   讓它們獨立成「指數·新聞」一頁，等於要使用者記住「看指數要換頁」——
//   跟選股清單散在五處是同一類問題：東西沒錯，位置需要記憶。
// 話題選股不留在這裡：它是**選股清單**，已搬到「選股 → 🎯 話題選股」。
const DASH_TABS = [
  { id: 'market', icon: '📊', label: '大盤總覽', hint: '風向 · 籌碼 · 漲跌停 · 排行' },
  { id: 'index',  icon: '📈', label: '指數分析', hint: '日週月K · 自動判讀' },
  { id: 'news',   icon: '📰', label: '每日新聞', hint: '07:00 首發 · 3小時滾動刷新' },
  { id: 'report', icon: '🌙', label: '盤後報告', hint: '當晚消息排行 · 熱力 · 權值股貢獻' },
] as const;
type DashTab = typeof DASH_TABS[number]['id'];

export default function Dashboard() {
  const allStocks = useAppStore((s) => s.allStocks);
  // 分頁存 store：進個股頁再返回時回到原本分頁，而不是被重設回大盤
  const tab = (useAppStore(s => s.dashTab) || 'market') as DashTab;
  const setTab = useAppStore(s => s.setDashTab);

  // 興櫃不進任何排行/榜單（沒有漲跌停、議價撮合、流動性極低）——只保留搜尋與個股頁
  const validStocks = allStocks.filter(s => s.price > 0 && s.volume > 0 && s.market !== 'esb');
  const upStocks = validStocks.filter(s => s.change > 0);
  const downStocks = validStocks.filter(s => s.change < 0);
  const flatStocks = validStocks.filter(s => s.change === 0);

  const topGainers = [...upStocks].sort((a, b) => b.changePercent - a.changePercent);
  const topLosers = [...downStocks].sort((a, b) => a.changePercent - b.changePercent);
  const topVolume = [...validStocks].sort((a, b) => b.volume - a.volume);

  // 漲跌停家數：普通股(上市+上櫃)、精確檔位判定（與漲停跌停榜同口徑）
  const regular = validStocks.filter(s => isExchangeListed(s));
  const limitUp = regular.filter(s => isLimitUp(s.price, s.change));
  const limitDown = regular.filter(s => isLimitDown(s.price, s.change));

  return (
    <div className={styles.dashboard}>
      <PageHelp id="dashboard" />

      <div className={styles.dashTabs} role="tablist" aria-label="市場總覽分頁">
        {DASH_TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={`${styles.dashTab} ${tab === t.id ? styles.dashTabOn : ''}`}
            onClick={() => setTab(t.id)}>
            <span className={styles.dashTabTop}>{t.icon} {t.label}</span>
            <span className={styles.dashTabHint}>{t.hint}</span>
          </button>
        ))}
      </div>

      {tab === 'index' && <IndexAnalysis />}
      {tab === 'news' && <DailyNews />}
{tab === 'report' && <AfterMarketReport />}

      {tab === 'market' && (<>
      {/* 🌅 盤前總覽：隔夜國際盤 × 今晨日韓 × 盤前晨報 三合一（見 PremarketHub 檔頭） */}
      <PremarketHub />
      <PremarketBrief />

      <WashoutBanner />

      {/* ── 三張市場結構卡並排成欄（2026-08-05）─────────────────────
          使用者：「風向總覽、籌碼訊號與第四法人都應該用欄位的方式」。
          原本三張各佔一整列，桌機上要捲三個螢幕才看得完，而它們回答的是
          同一層問題（今天的資金往哪走），本該並排對照。
          三者都用 slot 佔位，沒資料時不會讓後面的欄往前遞補。 */}
      <div className={styles.structGrid}>
        <WindHub compact />
        <ChipSignals compact slot />
        <EtfInfluence compact slot />
      </div>

      {/* Market Stats Row */}
      <div className={styles.statsGrid}>
        <StatCard
          label="上漲家數"
          value={upStocks.length.toLocaleString()}
          sub={`漲停 ${limitUp.length} 家`}
          color="var(--color-up)"
          icon="📈"
        />
        <StatCard
          label="下跌家數"
          value={downStocks.length.toLocaleString()}
          sub={`跌停 ${limitDown.length} 家`}
          color="var(--color-down)"
          icon="📉"
        />
        <StatCard
          label="持平家數"
          value={flatStocks.length.toLocaleString()}
          color="var(--color-flat)"
          icon="➡️"
        />
        <StatCard
          label="上市櫃（含 ETF）"
          value={validStocks.length.toLocaleString()}
          sub="今日有成交（漲跌家數同此範圍）"
          icon="🏢"
        />
        <StatCard
          label="市場強弱"
          value={validStocks.length > 0 ? `${((upStocks.length / validStocks.length) * 100).toFixed(0)}%` : '--'}
          sub="上漲比例"
          color={upStocks.length > downStocks.length ? 'var(--color-up)' : 'var(--color-down)'}
          icon="⚖️"
        />
      </div>
      {/* 上櫃第三方後備來源註記（只在用到後備時出現）：下方家數／漲跌停／熱力／排行都取自同一份 validStocks */}
      <ThirdPartyNote source={otcSourceOfStocks(validStocks)} />

      {/* 第二大腦洞察：產業輪動 / 法人連續買超 / 策略回測勝率 */}
      {/* 漲停/跌停全列表（熱力圖模式，全數顯示） */}
      <LimitBoard stocks={validStocks} />

      <MarketInsights />

      {/* Main Content */}
      <div className={styles.mainGrid}>
        {/* Left Column */}
        <div className={styles.leftCol}>
          <WatchlistCard />
          <MarketHeatmap stocks={validStocks} />
        </div>

        {/* Right Column */}
        <div className={styles.rightCol}>
          <TopMoversTable title="🚀 今日漲幅排行" stocks={topGainers} type="up" />
          <TopMoversTable title="📉 今日跌幅排行" stocks={topLosers} type="down" />
          <TopMoversTable title="💰 成交量排行" stocks={topVolume} type="up" />
        </div>
      </div>

      {/* 新手必讀：交易規則與稅務 */}
      <TradingRules />
      </>)}
    </div>
  );
}
