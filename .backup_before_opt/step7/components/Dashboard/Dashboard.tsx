'use client';

import { useAppStore } from '@/lib/store';
import type { StockInfo } from '@/lib/twse-api';
import { formatVolume, formatChangeSign, formatChangePercentSign, getChangeColor, isLimitUp, isLimitDown, marketBadge } from '@/lib/twse-api';
import PremarketBrief from './PremarketBrief';
import MarketInsights from './MarketInsights';
import TradingRules from '@/components/TradingRules/TradingRules';
import RiskBadge from '@/components/shared/RiskBadge';
import WindHub from '@/components/WindHub/WindHub';
import WashoutBanner from './WashoutBanner';
import ChipSignals from '@/components/ChipSignals/ChipSignals';
import EtfInfluence from '@/components/EtfInfluence/EtfInfluence';
import { useLiveQuotes } from '@/lib/useLiveQuotes';
import styles from './Dashboard.module.css';
import PageHelp from '@/components/Help/PageHelp';

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
  const { watchlist, allStocks, navigateTo, removeFromWatchlist } = useAppStore();
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
  const { navigateTo } = useAppStore();
  const color = type === 'up' ? 'var(--color-up)' : 'var(--color-down)';

  return (
    <div className={styles.sectionCard}>
      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{title}</h2>
      </div>
      <div className={styles.moversTable}>
        <div className={styles.moversHeader}>
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
              {(() => { const b = marketBadge(stock); return b ? <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 800, color: b.c, border: `1px solid ${b.c}55`, borderRadius: 4, padding: '0 3px' }}>{b.t}</span> : null; })()}
              <RiskBadge code={stock.code} size="xs" />
            </span>
            <span className={styles.moversPrice}>{stock.price.toFixed(2)}</span>
            <span className={styles.moversChange} style={{ color }}>
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
  const { navigateTo } = useAppStore();
  const byValue = (a: StockInfo, b: StockInfo) => b.value - a.value;
  // 普通股（上市+上櫃，4 碼非 00 開頭）；漲跌停用精確檔位算法（昨收×1.1 向下取檔），
  // 低價股實際漲停 % 可低至 ~9.5%，固定 % 門檻會漏。
  const isRegular = (s: StockInfo) => /^\d{4}$/.test(s.code) && !s.code.startsWith('00');
  const ups = stocks.filter(s => isRegular(s) && s.price > 0 && isLimitUp(s.price, s.change)).sort(byValue);
  const downs = stocks.filter(s => isRegular(s) && s.price > 0 && isLimitDown(s.price, s.change)).sort(byValue);
  if (!ups.length && !downs.length) return null;

  const cell = (s: StockInfo, up: boolean) => {
    const badge = marketBadge(s);
    return (
      <button key={s.code} className={styles.heatmapCell}
        style={{ background: up ? 'rgba(201,42,42,0.6)' : 'rgba(30,126,52,0.6)', position: 'relative' }}
        onClick={() => navigateTo('stock', s.code)} title={`${s.code} ${s.name} ${s.price}（${badge?.t === '櫃' ? '上櫃' : badge?.t === '市' ? '上市' : badge?.t || ''}）`}>
        {badge && <span style={{ position: 'absolute', top: 2, right: 3, fontSize: 9, fontWeight: 800, color: badge.c, opacity: 0.95 }}>{badge.t}</span>}
        <span className={styles.heatCode}>{s.code}</span>
        <span className={styles.heatName}>{s.name}</span>
        <span className={styles.heatChange} style={{ color: up ? '#ffb3b3' : '#9fe8ac' }}>
          {s.price} <span style={{ fontSize: '0.82em', opacity: 0.95 }}>{s.changePercent >= 0 ? '+' : ''}{s.changePercent?.toFixed(1)}%</span>
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

  const { navigateTo } = useAppStore();

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
              style={{ background: bg }}
              onClick={() => { navigateTo('stock', stock.code); }}
              title={`${stock.code} ${stock.name}`}
            >
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

export default function Dashboard() {
  const { allStocks } = useAppStore();

  const validStocks = allStocks.filter(s => s.price > 0 && s.volume > 0);
  const upStocks = validStocks.filter(s => s.change > 0);
  const downStocks = validStocks.filter(s => s.change < 0);
  const flatStocks = validStocks.filter(s => s.change === 0);

  const topGainers = [...upStocks].sort((a, b) => b.changePercent - a.changePercent);
  const topLosers = [...downStocks].sort((a, b) => a.changePercent - b.changePercent);
  const topVolume = [...validStocks].sort((a, b) => b.volume - a.volume);

  // 漲跌停家數：普通股(上市+上櫃)、精確檔位判定（與漲停跌停榜同口徑）
  const regular = validStocks.filter(s => /^\d{4}$/.test(s.code) && !s.code.startsWith('00'));
  const limitUp = regular.filter(s => isLimitUp(s.price, s.change));
  const limitDown = regular.filter(s => isLimitDown(s.price, s.change));

  return (
    <div className={styles.dashboard}>
      <PageHelp id="dashboard" />
      {/* Premium pre-market AI strategy brief */}
      <PremarketBrief />

      {/* 風向總覽：題材風向 × 籌碼風向 × 量價背離 整合 */}
      <WashoutBanner />
      <WindHub compact />

      {/* 三大法人籌碼訊號：四準則判讀 */}
      <ChipSignals compact />

      {/* 第四法人：ETF 被動買賣盤影響 */}
      <EtfInfluence compact />

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
          label="上市股票"
          value={validStocks.length.toLocaleString()}
          sub="今日有成交"
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
    </div>
  );
}
