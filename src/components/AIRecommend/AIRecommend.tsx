'use client';

import { useState, useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import styles from './AIRecommend.module.css';
import BuySellPanel from './BuySellPanel';
import TrendPanel from './TrendPanel';
import RiskBadge from '@/components/shared/RiskBadge';
import { useShallow } from 'zustand/react/shallow';
import DayTradeBadge from '@/components/shared/DayTradeBadge';

interface BuyZone {
  label: string;
  price: number;
  priceRange: [number, number];
  rationale: string;
  pattern: string;
  probability: number;
  riskReward: number;
  type: 'aggressive' | 'standard' | 'conservative' | 'dip';
}

interface SellTarget {
  label: string;
  price: number;
  gainPercent: number;
  rationale: string;
  type: 'tp1' | 'tp2' | 'tp3' | 'trailing';
  probability: number;
  holdDays: string;
}

interface PatternSignal {
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  strength: number;
  description: string;
  actionHint: string;
}

interface TradeSetup {
  style: '短線' | '波段' | '存股';
  entryTiming: string;
  maxRisk: number;
  expectedGain: number;
  holdPeriod: string;
  positionSizing: string;
  overallRiskReward: number;
}

interface ScoredStock {
  code: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  score: number;
  grade: 'A+' | 'A' | 'B+' | 'B' | 'C';
  strategy: 'momentum' | 'growth' | 'defensive' | 'value';
  reasons: string[];
  risks: string[];
  // AI 內文判別（daemon 來源監看管線）。僅供呈現，**不影響排序**
  // ——係數尚未經 newsLift 驗證，不讓未驗證的訊號決定「推薦什麼」。
  newsVerdict?: { label: string; confidence: string; reason: string } | null;
  factors: {
    momentum: number;
    volume: number;
    stability: number;
    trend: number;
    value: number;
  };
  signal: 'STRONG_BUY' | 'BUY' | 'WATCH' | 'NEUTRAL';
  targetPrice: number;
  stopLoss: number;
  stopLossRationale: string;
  confidence: number;
  buyZones: BuyZone[];
  sellTargets: SellTarget[];
  patterns: PatternSignal[];
  tradeSetup: TradeSetup;
}

interface FundamentalView {
  valuation: { pe: number | null; dividendYield: number | null; pb: number | null } | null;
  margin: { balance: number; changePct: number; utilization: number } | null;
  institutional: { foreignNetLots: number; trustNetLots: number; totalNetLots: number } | null;
  bonus: number;
  reasons: string[];
  riskFlags: string[];
}

interface SwingSig {
  score: number; action: string; actionLabel: string; trend: string; biasPct: number; chase: boolean;
  components: { trend: number; bias: number; volume: number; ma: number; macd: number; rsi: number };
}

interface AIResponse {
  recommendations: ScoredStock[];
  strategies: {
    daily: ScoredStock[];
    growth: ScoredStock[];
    defensive: ScoredStock[];
  };
  totalAnalyzed: number;
  bearDay?: boolean | null;
  mktChg?: number | null;
  excludedLimitUp?: number;
  generatedAt: string;
}

const STRATEGY_TABS = [
  { id: 'all', label: '🤖 AI 精選 TOP 20', desc: '綜合評分最高' },
  { id: 'intraday', label: '⚡ 盤中潛力', desc: '即時放量上攻' },
  { id: 'daily', label: '🚀 動能強勢', desc: '今日強勢股' },
  { id: 'growth', label: '📈 成長潛力', desc: '法人資金進駐' },
  { id: 'defensive', label: '🛡️ 穩健防禦', desc: '低波動優質股' },
];

// 記分板列：與上方 5 個分頁一一對應（2026-08-05 起 5 榜全記，先前只記前 2 個）
const SCORE_ROWS: [string, string][] = [
  ['top20', '🤖 AI 精選 TOP20'],
  ['intraday', '⚡ 盤中潛力'],
  ['daily', '🚀 動能強勢'],
  ['growth', '📈 成長潛力'],
  ['defensive', '🛡️ 穩健防禦'],
];

const GRADE_COLORS: Record<string, string> = {
  'A+': '#c92a2a',
  'A': '#e67700',
  'B+': '#1971c2',
  'B': '#2f9e44',
  'C': '#495057',
};

const SIGNAL_CONFIG = {
  STRONG_BUY: { label: '強力推薦', color: '#c92a2a', bg: 'rgba(201,42,42,0.12)', emoji: '🔥' },
  BUY: { label: '建議關注', color: '#e67700', bg: 'rgba(230,119,0,0.12)', emoji: '⭐' },
  WATCH: { label: '持續追蹤', color: '#1971c2', bg: 'rgba(25,113,194,0.12)', emoji: '👁️' },
  NEUTRAL: { label: '中性觀望', color: '#868e96', bg: 'rgba(134,142,150,0.08)', emoji: '⚪' },
};

function FactorBar({ label, value, max = 20 }: { label: string; value: number; max?: number }) {
  const pct = (value / max) * 100;
  const color = pct >= 75 ? '#c92a2a' : pct >= 50 ? '#e67700' : pct >= 30 ? '#1971c2' : '#868e96';
  return (
    <div className={styles.factorRow}>
      <span className={styles.factorLabel}>{label}</span>
      <div className={styles.factorBar}>
        <div className={styles.factorFill} style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className={styles.factorVal} style={{ color }}>{value}/{max}</span>
    </div>
  );
}

function StockCard({ stock, rank }: { stock: ScoredStock; rank: number }) {
  const { navigateTo, addToWatchlist, isInWatchlist } = useAppStore(useShallow((s) => ({ navigateTo: s.navigateTo, addToWatchlist: s.addToWatchlist, isInWatchlist: s.isInWatchlist })));
  const [expanded, setExpanded] = useState(false);
  const [detailTab, setDetailTab] = useState<'analysis' | 'buysell' | 'trend'>('analysis');

  // Phase 2: on first expand, fetch the enriched single-stock analysis
  // (MA-support buy zones, volatility sell odds, valuation/chips) and use it
  // in place of the list's base technical scoring.
  const [enrichedStock, setEnrichedStock] = useState<ScoredStock | null>(null);
  const [fundamentals, setFundamentals] = useState<FundamentalView | null>(null);
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [aiNote, setAiNote] = useState<{ analysis: string; model: string; generatedAt: number } | null>(null);
  const [swingSig, setSwingSig] = useState<SwingSig | null>(null);
  useEffect(() => {
    if (!expanded || enrichedStock || enrichLoading) return;
    setEnrichLoading(true);
    fetch(`/api/rating?code=${stock.code}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data?.stock) setEnrichedStock(data.stock as ScoredStock);
        if (data?.fundamentals) setFundamentals(data.fundamentals as FundamentalView);
        if (data?.swingSignal) setSwingSig(data.swingSignal as SwingSig);
      })
      .catch(() => { /* keep base data */ })
      .finally(() => setEnrichLoading(false));
    // Local-AI note (Phase 4) — shown if the second-brain pipeline produced one.
    fetch(`/api/ai/stock-note?code=${stock.code}`)
      .then(r => (r.ok ? r.json() : null))
      .then(n => { if (n?.analysis) setAiNote({ analysis: n.analysis, model: n.model, generatedAt: n.generatedAt }); })
      .catch(() => { /* no note */ });
  }, [expanded, enrichedStock, enrichLoading, stock.code]);

  // Enriched view when available, else the base list data.
  const view = enrichedStock ?? stock;

  const isUp = view.change >= 0;
  const changeColor = isUp ? 'var(--color-up)' : 'var(--color-down)';
  const signalCfg = SIGNAL_CONFIG[view.signal];
  const gradeColor = GRADE_COLORS[view.grade] || '#495057';
  const inWL = isInWatchlist(stock.code);

  // Best buy zone for quick display
  const bestBuy = view.buyZones?.find(z => z.type === 'standard') || view.buyZones?.[0];
  const firstTarget = view.sellTargets?.find(t => t.type === 'tp1');

  return (
    <div
      className={`${styles.stockCard} ${expanded ? styles.expanded : ''}`}
      id={`ai-card-${stock.code}`}
    >
      {/* Card Header */}
      <div className={styles.cardTop} onClick={() => setExpanded(v => !v)}>
        {/* Rank */}
        <div className={styles.rank}>
          {rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : `#${rank}`}
        </div>

        {/* Stock Info */}
        <div className={styles.stockInfo}>
          <div className={styles.stockMeta}>
            <span className={styles.stockCode}>{stock.code}</span>
            <span className={styles.stockName}>{stock.name}</span>
            <RiskBadge code={stock.code} size="xs" />
            <DayTradeBadge code={stock.code} size="xs" />
            <span
              className={styles.gradeBadge}
              style={{ background: `${gradeColor}18`, color: gradeColor, borderColor: gradeColor }}
            >
              {view.grade}
            </span>
          </div>
          <div className={styles.signalTag} style={{ background: signalCfg.bg, color: signalCfg.color }}>
            {signalCfg.emoji} {signalCfg.label}
          </div>
        </div>

        {/* Price */}
        <div className={styles.priceBlock}>
          <div className={styles.price}>{stock.price.toFixed(2)}</div>
          <div className={styles.priceChange} style={{ color: changeColor }}>
            {isUp ? '+' : ''}{stock.change.toFixed(2)} ({isUp ? '+' : ''}{stock.changePercent.toFixed(2)}%)
          </div>
        </div>

        {/* Score Ring */}
        <div className={styles.scoreBlock}>
          <svg viewBox="0 0 36 36" className={styles.scoreRing}>
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke="rgba(255,255,255,0.06)"
              strokeWidth="3"
            />
            <path
              d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
              fill="none"
              stroke={gradeColor}
              strokeWidth="3"
              strokeDasharray={`${view.score}, 100`}
              strokeLinecap="round"
            />
            <text x="18" y="14" textAnchor="middle" className={styles.ringScore}>{view.score}</text>
            <text x="18" y="23" textAnchor="middle" className={styles.ringLabel}>分</text>
          </svg>
        </div>

        {/* Confidence */}
        <div className={styles.confidence}>
          <div className={styles.confidenceLabel}>信心度</div>
          <div className={styles.confidenceValue} style={{ color: gradeColor }}>
            {view.confidence.toFixed(0)}%
          </div>
        </div>

        {/* Expand toggle */}
        <div className={`${styles.expandIcon} ${expanded ? styles.expandedIcon : ''}`}>⌄</div>
      </div>

      {/* Quick Info Bar — buy/sell summary */}
      <div className={styles.quickInfoBar}>
        <div className={styles.quickInfoItem} style={{ borderColor: 'rgba(240,62,62,0.25)' }}>
          <span className={styles.quickInfoLabel} style={{ color: '#f03e3e' }}>🔴 建議買點</span>
          <span className={styles.quickInfoValue} style={{ color: '#f03e3e' }}>
            {bestBuy ? bestBuy.price.toFixed(2) : '--'}
          </span>
        </div>
        <div className={styles.quickInfoItem} style={{ borderColor: 'rgba(47,158,68,0.25)' }}>
          <span className={styles.quickInfoLabel} style={{ color: '#2f9e44' }}>🟢 第一目標</span>
          <span className={styles.quickInfoValue} style={{ color: '#2f9e44' }}>
            {firstTarget ? `${firstTarget.price.toFixed(2)} (+${firstTarget.gainPercent}%)` : '--'}
          </span>
        </div>
        <div className={styles.quickInfoItem} style={{ borderColor: 'rgba(134,142,150,0.2)' }}>
          <span className={styles.quickInfoLabel} style={{ color: '#868e96' }}>🚫 停損</span>
          <span className={styles.quickInfoValue} style={{ color: '#868e96' }}>
            {view.stopLoss.toFixed(2)}
          </span>
        </div>
        <div className={styles.quickInfoActions}>
          <button
            id={`ai-goto-${stock.code}`}
            className="btn btn-ghost btn-sm"
            onClick={() => { navigateTo('stock', stock.code); }}
          >
            📊 K線
          </button>
          <button
            id={`ai-watch-${stock.code}`}
            className="btn btn-ghost btn-sm"
            style={inWL ? { color: '#f59e0b' } : {}}
            onClick={() => !inWL && addToWatchlist({ code: stock.code, name: stock.name, price: stock.price, change: stock.change, changePercent: stock.changePercent, volume: stock.volume, value: 0, open: 0, high: 0, low: 0, close: stock.price, transactions: 0 })}
          >
            {inWL ? '★' : '☆'}
          </button>
        </div>
      </div>

      {/* Expanded Detail with Tabs */}
      {expanded && (
        <div className={styles.cardDetail}>
          {/* Tab Switcher — 3 tabs */}
          <div className={styles.detailTabs}>
            <button
              className={`${styles.detailTab} ${detailTab === 'analysis' ? styles.detailTabActive : ''}`}
              onClick={() => setDetailTab('analysis')}
            >
              📊 因子 & 推薦
            </button>
            <button
              className={`${styles.detailTab} ${detailTab === 'buysell' ? styles.detailTabActiveBuySell : ''}`}
              onClick={() => setDetailTab('buysell')}
            >
              🎯 買賣點預測
            </button>
            <button
              className={`${styles.detailTab} ${detailTab === 'trend' ? styles.detailTabActiveTrend : ''}`}
              onClick={() => setDetailTab('trend')}
            >
              📰 漲勢分析 & 新聞
            </button>
          </div>

          {detailTab === 'analysis' ? (
            <div className={styles.analysisContent}>
              {/* Factor Bars */}
              <div className={styles.factorsSection}>
                <div className={styles.detailTitle}>📊 五因子評分</div>
                <div className={styles.factorBars}>
                  <FactorBar label="動能" value={view.factors.momentum} />
                  <FactorBar label="量能" value={view.factors.volume} />
                  <FactorBar label="趨勢" value={view.factors.trend} />
                  <FactorBar label="穩定" value={view.factors.stability} />
                  <FactorBar label="價值" value={view.factors.value} />
                </div>
              </div>

              {/* Swing signal — chjm-ai discipline model (不追高) */}
              {swingSig && (() => {
                const buy = swingSig.action === 'STRONG_BUY' || swingSig.action === 'BUY';
                const sell = swingSig.action === 'SELL' || swingSig.action === 'STRONG_SELL';
                const col = swingSig.chase ? '#e67700' : buy ? '#c92a2a' : sell ? '#2f9e44' : '#868e96';
                return (
                  <div className={styles.reasonsSection}>
                    <div className={styles.detailTitle}>🎯 波段訊號（不追高紀律）</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                      <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, padding: '2px 9px', borderRadius: 999, background: `${col}1f`, color: col, border: `1px solid ${col}` }}>{swingSig.actionLabel}</span>
                      <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>紀律評分 {swingSig.score}/100 · {swingSig.trend} · 乖離 {swingSig.biasPct >= 0 ? '+' : ''}{swingSig.biasPct}%</span>
                    </div>
                    {swingSig.chase && <div style={{ marginTop: 4, fontSize: 'calc(12.5px * var(--fz))', color: '#e67700', fontWeight: 600 }}>🚫 乖離過大，嚴禁追高 — 等回測均線再進場（提升勝率）</div>}
                    <div style={{ marginTop: 4, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>趨勢{swingSig.components.trend}·乖離{swingSig.components.bias}·量價{swingSig.components.volume}·均線{swingSig.components.ma}·MACD{swingSig.components.macd}·RSI{swingSig.components.rsi}</div>
                  </div>
                );
              })()}

              {/* Reasons */}
              {/* AI 讀完內文的多空判別。標明「不影響排序」——使用者若不知道
                  這件事，看到「利多」卻沒排前面會以為排序壞了。 */}
              {view.newsVerdict && (
                <div className={styles.reasonsSection}>
                  <div className={styles.detailTitle}>
                    📰 新聞判別（AI 讀完內文）
                    <span style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', fontWeight: 400 }}>
                      　僅供參考，尚未納入排序
                    </span>
                  </div>
                  <div className={styles.reasonItem}>
                    <b style={{
                      color: view.newsVerdict.label === '利多' ? 'var(--color-up)'
                        : view.newsVerdict.label === '利空' ? 'var(--color-down)' : 'var(--text-muted)',
                    }}>{view.newsVerdict.label}</b>
                    <span style={{ color: 'var(--text-muted)' }}>（信心{view.newsVerdict.confidence}）</span>
                    {view.newsVerdict.reason ? `：${view.newsVerdict.reason}` : ''}
                  </div>
                </div>
              )}

              <div className={styles.reasonsSection}>
                <div className={styles.detailTitle}>✅ 推薦理由 {enrichLoading && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>· 載入基本面…</span>}</div>
                <div className={styles.reasonsList}>
                  {view.reasons.map((r, i) => (
                    <div key={i} className={styles.reasonItem}>{r}</div>
                  ))}
                </div>
              </div>

              {/* Valuation & chips (Phase 2 — fundamentals/institutional/margin) */}
              {fundamentals && (fundamentals.valuation || fundamentals.institutional || fundamentals.margin) && (
                <div className={styles.reasonsSection}>
                  <div className={styles.detailTitle}>🏦 基本面 / 籌碼面</div>
                  <div className={styles.factorBars}>
                    {fundamentals.valuation && (
                      <div className={styles.factorRow}>
                        <span className={styles.factorLabel}>估值</span>
                        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>
                          PER {fundamentals.valuation.pe ?? '—'} · 殖利率 {fundamentals.valuation.dividendYield ?? '—'}% · PBR {fundamentals.valuation.pb ?? '—'}
                        </span>
                      </div>
                    )}
                    {fundamentals.institutional && (
                      <div className={styles.factorRow}>
                        <span className={styles.factorLabel}>法人</span>
                        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>
                          外資 {fundamentals.institutional.foreignNetLots.toLocaleString()} 張 · 投信 {fundamentals.institutional.trustNetLots.toLocaleString()} 張 · 合計 {fundamentals.institutional.totalNetLots.toLocaleString()} 張
                        </span>
                      </div>
                    )}
                    {fundamentals.margin && (
                      <div className={styles.factorRow}>
                        <span className={styles.factorLabel}>融資</span>
                        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>
                          餘額 {fundamentals.margin.balance.toLocaleString()} 張 · 使用率 {fundamentals.margin.utilization}% · 日增減 {fundamentals.margin.changePct}%
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Risks */}
              {view.risks.length > 0 && (
                <div className={styles.risksSection}>
                  <div className={styles.detailTitle}>⚠️ 注意風險</div>
                  <div className={styles.risksList}>
                    {view.risks.map((r, i) => (
                      <div key={i} className={styles.riskItem}>{r}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Local-AI commentary (Phase 4 — second brain + Ollama) */}
              {aiNote && (
                <div className={styles.aiNoteSection}>
                  <div className={styles.detailTitle}>🧠 本地 AI 深度解讀</div>
                  <div className={styles.aiNoteBody}>{aiNote.analysis}</div>
                  <div className={styles.aiNoteMeta}>
                    {aiNote.model} · {new Date(aiNote.generatedAt).toLocaleString('zh-TW')}
                  </div>
                </div>
              )}

              <div className={styles.disclaimer}>
                ⚠️ AI 評分僅供參考，基於技術面分析。投資決策請結合基本面判斷，並自行承擔風險。
              </div>
            </div>
          ) : detailTab === 'buysell' ? (
            /* Buy/Sell Panel */
            view.buyZones ? (
              <BuySellPanel
                currentPrice={view.price}
                high={view.high}
                low={view.low}
                open={view.open}
                buyZones={view.buyZones}
                sellTargets={view.sellTargets}
                stopLoss={view.stopLoss}
                stopLossRationale={view.stopLossRationale}
                patterns={view.patterns}
                tradeSetup={view.tradeSetup}
              />
            ) : null
          ) : (
            /* Trend Analysis & News Panel */
            <TrendPanel stockCode={stock.code} stockName={stock.name} />
          )}
        </div>
      )}
    </div>
  );
}

function MarketNewsPanel() {
  const [news, setNews] = useState<Array<{
    id: string;
    title: string;
    source: string;
    category: string;
    stockCode: string;
    time: string;
    url: string;
  }>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/twse/market-news');
        if (res.ok) {
          const data = await res.json();
          setNews(data.news || []);
        }
      } finally {
        setLoading(false);
      }
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const categoryConfig: Record<string, { icon: string; color: string }> = {
    announcement: { icon: '📋', color: '#1971c2' },
    market: { icon: '📊', color: '#c92a2a' },
    education: { icon: '💡', color: '#2f9e44' },
    analysis: { icon: '🔍', color: '#e67700' },
  };

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className={styles.newsPanel} id="market-news-panel">
      <div className={styles.newsPanelHeader}>
        <div className={styles.newsPanelTitle}>
          <div className={styles.liveDot} />
          即時市場訊息
        </div>
        {loading && <div className="spinner" />}
      </div>
      <div className={styles.newsList}>
        {news.length === 0 && !loading && (
          <div className={styles.newsEmpty}>暫無最新訊息</div>
        )}
        {news.map(item => {
          const cfg = categoryConfig[item.category] || { icon: '📌', color: '#868e96' };
          return (
            <div key={item.id} className={styles.newsItem} id={`news-${item.id}`}>
              <div className={styles.newsIcon} style={{ color: cfg.color }}>{cfg.icon}</div>
              <div className={styles.newsContent}>
                <div className={styles.newsTitle}>{item.title}</div>
                <div className={styles.newsMeta}>
                  <span className={styles.newsSource} style={{ color: cfg.color }}>{item.source}</span>
                  {item.stockCode && (
                    <span className={styles.newsStock}>{item.stockCode}</span>
                  )}
                  <span className={styles.newsTime}>{formatTime(item.time)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface MarketReportData {
  date: string;
  generatedAt: number;
  breadth: { up: number; down: number; flat: number; total: number; advancePct: number };
  topPicks: Array<{ code: string; name: string; score: number; grade: string; signal: string; price: number; changePercent: number; buy: number | null; target: number | null; stopLoss: number | null; reasons: string[] }>;
  riskHighlights: string[];
  summary: string;
  meta: { totalAnalyzed: number; enriched: number; historyCovered: number };
}

/** After-close 盤勢分析 banner — reads the latest report written by the daily cron. */
function MarketReportBanner() {
  const navigateTo = useAppStore((s) => s.navigateTo);
  const [report, setReport] = useState<MarketReportData | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    fetch('/api/market-report')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (d && !d.error) setReport(d as MarketReportData); })
      .catch(() => { /* no report yet */ });
  }, []);

  if (!report) return null;
  const b = report.breadth;

  return (
    <div className={styles.reportBanner}>
      <div className={styles.reportHead} onClick={() => setOpen(v => !v)}>
        <span className={styles.reportTitle}>📊 收盤盤勢分析</span>
        <span className={styles.reportDate}>{report.date}</span>
        <span className={styles.reportSummary}>{report.summary}</span>
        <span className={styles.reportToggle}>{open ? '▲' : '▼'}</span>
      </div>

      {open && (
        <div className={styles.reportBody}>
          {/* breadth bar */}
          <div className={styles.breadthRow}>
            <span style={{ color: 'var(--color-up)' }}>▲ {b.up.toLocaleString()}</span>
            <div className={styles.breadthBar}>
              <div style={{ width: `${b.advancePct}%`, background: 'var(--color-up)', height: '100%' }} />
              <div style={{ width: `${100 - b.advancePct}%`, background: 'var(--color-down)', height: '100%' }} />
            </div>
            <span style={{ color: 'var(--color-down)' }}>▼ {b.down.toLocaleString()}</span>
            <span className={styles.breadthFlat}>持平 {b.flat}｜漲家數 {b.advancePct}%</span>
          </div>

          {report.riskHighlights.length > 0 && (
            <div className={styles.reportRisks}>
              {report.riskHighlights.map((r, i) => <span key={i} className={styles.reportRiskTag}>{r}</span>)}
            </div>
          )}

          {/* enriched top picks */}
          <div className={styles.reportPicks}>
            {report.topPicks.slice(0, 8).map(p => {
              const up = p.changePercent >= 0;
              return (
                <button key={p.code} className={styles.reportPick} onClick={() => navigateTo('stock', p.code)}>
                  <div className={styles.reportPickTop}>
                    <span className={styles.reportPickCode}>{p.code}</span>
                    <span className={styles.reportPickName}>{p.name}</span>
                    <span className={styles.reportPickGrade}>{p.grade}</span>
                  </div>
                  <div className={styles.reportPickRow}>
                    <span style={{ color: up ? 'var(--color-up)' : 'var(--color-down)' }}>{p.price.toFixed(2)}（{up ? '+' : ''}{p.changePercent.toFixed(2)}%）</span>
                  </div>
                  <div className={styles.reportPickRow}>
                    <span style={{ color: 'var(--color-up)' }}>買 {p.buy?.toFixed(2) ?? '--'}</span>
                    <span style={{ color: 'var(--color-down)' }}>標 {p.target?.toFixed(2) ?? '--'}</span>
                    <span style={{ color: 'var(--text-muted)' }}>損 {p.stopLoss?.toFixed(2) ?? '--'}</span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className={styles.reportMeta}>
            分析 {report.meta.totalAnalyzed} 檔｜強化 {report.meta.enriched} 檔｜歷史涵蓋 {report.meta.historyCovered} 檔 · 點選個股看完整買賣點
          </div>
        </div>
      )}
    </div>
  );
}

export default function AIRecommend() {
  const [data, setData] = useState<AIResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // 子分頁存在 store，進個股再返回時回到原本分頁(如「盤中潛力」)而非重置為 all
  const activeTab = useAppStore(s => s.recommendTab);
  const setActiveTab = useAppStore(s => s.setRecommendTab);
  const [error, setError] = useState('');
  const [intraday, setIntraday] = useState<{ picks: ScoredStock[]; marketOpen: boolean; universe: number } | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/twse/ai-recommend');
        if (!res.ok) throw new Error('API failed');
        const d = await res.json();
        setData(d);
      } catch {
        setError('資料載入失敗，請稍後再試');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // 盤中潛力榜：進入分頁時載入，每 60 秒更新（即時資料，與鎖收盤的 AI 評分互補）
  useEffect(() => {
    if (activeTab !== 'intraday') return;
    let live = true;
    const load = () => fetch('/api/twse/intraday-picks')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (live && d?.picks) setIntraday({ picks: d.picks, marketOpen: d.marketOpen, universe: d.universe }); })
      .catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => { live = false; clearInterval(id); };
  }, [activeTab]);

  // 推薦成績記分板（AI 榜單可信度）
  // 2026-08-05 擴充：加入同期基準與超額。**絕對勝率單獨看是沒有意義的**——
  //   同一個 -5.44% 在多頭市場是災難、在崩盤市場可能是勝利。超額才是選股能力。
  const [scoreboard, setScoreboard] = useState<{
    records: number; from?: string; cost?: number;
    calib?: string; calibFrom?: string; recordsV2?: number;
    aggV2?: Record<string, Record<string, {
      n: number; winRate: number; avgRet: number; excess?: number | null; entryDays?: number;
      base?: { n: number; winRate: number; avgRet: number; medRet: number } | null;
    }>>;
    agg: Record<string, Record<string, {
      n: number; winRate: number; avgRet: number; medRet?: number; netRet?: number;
      base?: { n: number; winRate: number; avgRet: number; medRet: number } | null;
      excess?: number | null; excessTradable?: number | null;
      skipped?: number; tradableN?: number; tradableAvg?: number | null;
      entryDays?: number;
    }>>;
  } | null>(null);
  useEffect(() => {
    fetch('/api/ai/picks-scoreboard').then(r => (r.ok ? r.json() : null)).then(d => d?.agg && setScoreboard(d)).catch(() => {});
  }, []);

  const stocks = activeTab === 'intraday' ? (intraday?.picks || []) :
    !data ? [] :
    activeTab === 'all' ? data.recommendations :
    activeTab === 'daily' ? data.strategies.daily :
    activeTab === 'growth' ? data.strategies.growth :
    activeTab === 'defensive' ? data.strategies.defensive :
    data.recommendations;

  return (
    <div className={styles.page}>
      {/* Page Header */}
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.pageTitle}>🤖 AI 智能選股推薦</h1>
          <p className={styles.pageSubtitle}>
            五大因子（已依四窗實證修正）＋已驗證訊號疊加，從 {data?.totalAnalyzed?.toLocaleString() || '--'} 支可交易股票中排序（漲停股已排除——收盤價買不到）
          </p>
        </div>
        {data && (
          <div className={styles.lastUpdate}>
            <div className={styles.liveDot} />
            <span>
              更新時間：{new Date(data.generatedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        )}
      </div>

      {/* ── 🏅 推薦成績記分板（2026-08-05 加入同期基準）───────────────
          使用者問「勝率怎麼這麼差？是選股能力太差嗎？」——舊版只給絕對報酬，
          答不出這個問題。現在每個窗口都並列**同期可交易宇宙等權基準**：
          追蹤期間全市場等權 5 日就是 -3.72%，所以 -5.84% 的真正意義是
          「比隨便買差 2.12pp」，而不是「跌了 5.84%」。
          超額用大字、絕對報酬用小字——這是刻意的排序。 */}
      {scoreboard && Object.keys(scoreboard.agg || {}).length > 0 && (
        <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
          <div style={{ fontWeight: 700, fontSize: 'calc(0.9rem * var(--fz))', marginBottom: 4 }}>🏅 AI 推薦成績
            <span style={{ fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginLeft: 8 }}>
              每檔推薦於 5/10/20 個交易日後以官方收盤結算
            </span>
          </div>

          {/* ── 口徑分界（2026-08-05）─────────────────────────────────
              今天同時改了三件會改變「推薦是什麼」的事：五大因子依四窗檢定修正、
              加可交易宇宙 gate、排序鍵加上已驗證訊號×3。
              ⇒ 今天之後的推薦與 08-04 以前**不是同一個系統**。
              把兩者平均在一起，使用者會把已汰換評分器的 -2.12pp
              讀成「現行推薦很爛」。所以分開顯示，而且**現行口徑放前面**。 */}
          <div style={{ padding: '8px 12px', borderRadius: 9, background: 'rgba(125,211,252,0.07)', border: '1px solid rgba(125,211,252,0.3)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.8, marginBottom: 10 }}>
            <b style={{ color: 'var(--text-primary)' }}>🆕 現行口徑（{scoreboard.calib ?? 'v2'}）成績：累積中</b>
            {scoreboard.calibFrom && <span style={{ color: 'var(--text-muted)' }}>——自 {scoreboard.calibFrom} 起共 {scoreboard.recordsV2 ?? 0} 個交易日，第 5 個交易日後出現第一筆。</span>}
            <br />
            <span style={{ color: 'var(--text-muted)' }}>
              2026-08-05 同時改了三件事：五大因子依 bt-core 四窗檢定修正（「收在日高」由滿分改為扣分）、
              加入可交易宇宙 gate（漲停股剔除，舊版佔 TOP20 的 37%）、排序鍵加上已驗證訊號 ×3。
              <b style={{ color: '#fbbf24' }}>下面那張表量的是改版前的舊系統</b>，照實保留但不代表現在這張榜。
            </span>
          </div>

          <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: 'var(--text-muted)', marginBottom: 4 }}>
            📜 舊口徑歷史成績（{scoreboard.from} ~ 2026-08-04 · {scoreboard.records} 個交易日 · <span style={{ color: '#fbbf24' }}>系統已汰換</span>）
          </div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.7, marginBottom: 8 }}>
            <b style={{ color: '#7dd3fc' }}>先看超額，不要只看勝率。</b>
            超額＝推薦均報 −「同期可交易宇宙等權」基準。<b>絕對報酬主要由市況決定</b>——
            空頭段裡任何只做多的清單都會是負的；超額才是「選得準不準」。
            基準口徑與本站回測平台一致：4 碼普通股、量 ≥300 張、<b>剔除進場日漲停</b>（收盤價買不到）。
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 'calc(12.5px * var(--fz))', minWidth: 620 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>
                  <th style={{ textAlign: 'left', padding: '4px 8px' }}>榜單</th>
                  {[5, 10, 20].map(h => <th key={h} style={{ textAlign: 'right', padding: '4px 10px' }}>{h} 日超額</th>)}
                  <th style={{ textAlign: 'left', padding: '4px 10px' }}>絕對報酬（勝率／均報／同期基準）</th>
                </tr>
              </thead>
              <tbody>
                {SCORE_ROWS.map(([k, label]) => {
                  const g = scoreboard.agg[k];
                  return (
                    <tr key={k} style={{ borderTop: '1px solid rgba(148,163,184,0.12)' }}>
                      <td style={{ padding: '5px 8px', fontWeight: 800, whiteSpace: 'nowrap' }}>{label}</td>
                      {[5, 10, 20].map(h => {
                        const r = g?.[`d${h}`];
                        if (!r || r.excess == null) return <td key={h} style={{ textAlign: 'right', padding: '5px 10px', color: 'var(--text-muted)' }}>—</td>;
                        const thin = (r.entryDays ?? 0) < 5;   // 進場日太少＝還不是估計值
                        return (
                          <td key={h} style={{ textAlign: 'right', padding: '5px 10px', fontFamily: "'JetBrains Mono',monospace", whiteSpace: 'nowrap' }}>
                            <b style={{ fontSize: 'calc(13px * var(--fz))', color: r.excess > 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                              {r.excess > 0 ? '+' : ''}{r.excess}pp
                            </b>
                            {thin && <span title={`只有 ${r.entryDays} 個進場日，樣本互相重疊，尚不足以當作估計值`} style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#fbbf24', marginLeft: 3 }}>⚠{r.entryDays}日</span>}
                          </td>
                        );
                      })}
                      <td style={{ padding: '5px 10px', color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))', whiteSpace: 'nowrap' }}>
                        {[5, 10, 20].map(h => {
                          const r = g?.[`d${h}`];
                          if (!r) return null;
                          return <span key={h} style={{ marginRight: 10 }}>
                            {h}日 {r.winRate}%／{r.avgRet >= 0 ? '+' : ''}{r.avgRet}%
                            {r.base ? <span style={{ opacity: 0.7 }}>（基準 {r.base.winRate}%／{r.base.avgRet >= 0 ? '+' : ''}{r.base.avgRet}%）</span> : null}
                          </span>;
                        })}
                        {!g && <span>尚未累積（本榜自 2026-08-05 起記錄，5 個交易日後出現第一筆）</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(() => {
            const t = scoreboard.agg.top20?.d5;
            if (!t || !t.skipped) return null;
            return (
              <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#fbbf24', lineHeight: 1.7, marginTop: 8 }}>
                ⚠ <b>可交易性</b>：TOP20 的 5 日樣本中有 <b>{t.skipped}/{t.n}（{Math.round(t.skipped / t.n * 100)}%）</b>
                在推薦當日就漲停——<b>收盤價買不到</b>。五大因子把「今日漲幅」與「漲停分析」算成加分，
                所以榜首天生偏向當天最強、也最買不到的那幾檔。
                剔除這些之後的超額是 <b>{t.excessTradable != null && t.excessTradable > 0 ? '+' : ''}{t.excessTradable}pp</b>。
              </div>
            );
          })()}
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.7 }}>
            均報為未扣費稅的價差；來回成本 {scoreboard.cost ?? 0.4425}%（手續費×2＋證交稅）需自行扣除。
            歷史績效不代表未來；本記分板是**誠實揭露**，不是推薦保證。非投資建議。
          </div>
        </div>
      )}

      {/* ── 市況穩定度揭露（2026-08-05 晚·取代同日稍早的「空頭日提示」）──
          稍早我依 gate search 的結果上了一條「空頭日的前 5 名最接近正報酬」提示。
          當晚做成分拆解（screen-bearday-amplifier.mjs）後**那個敘事被否證**：
            · Ⓗ1 市場擇時：大跌隔日基準 主窗 +0.36% / OOT -0.46%——**兩窗反向**，
              而且六個分桶在兩窗都不單調。「大跌隔天會反彈」不成立。
            · Ⓗ2 訊號增益：各訊號的超額 Δ **不隨跌幅變大**
              （OOT 中跌/小跌/小漲＝0.259/0.263/0.259，幾乎是常數）。
          ⇒ 「空頭日·前5」看起來最好，只是那個二分把主窗的好桶與壞桶切在剛好的
             位置——**分桶邊界的巧合**，不是 regime 效應。提示已撤。
          但拆解同時給了一個**更強**的正面結論：超額不挑市況。這才是該講的。 */}
      {scoreboard && (
        <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 10, background: 'rgba(125,211,252,0.06)', border: '1px solid rgba(125,211,252,0.28)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.8, color: 'var(--text-secondary)' }}>
          📐 <b style={{ color: 'var(--text-primary)' }}>這張榜的超額不挑市況</b>——
          把交易日依當日大盤中位數漲幅分成六桶後，本榜前 5 名相對同桶基準的超額
          在第三獨立窗幾乎是常數（中跌 <b>+0.259</b>／小跌 <b>+0.263</b>／小漲 <b>+0.259</b> pp）。
          也就是說<b>不需要挑多空日</b>，排序本身的相對優勢是穩定的。
          <br />
          <span style={{ color: '#fbbf24' }}>⚠ 但「穩定的相對優勢」≠「賺錢」</span>：
          已測 65 組濾網（名次／避開訊號／破高×強尾／波動／漲幅／多空日交叉），
          <b>沒有任何一組</b>能讓絕對淨報酬在主窗與第三獨立窗的四個半窗全為正。
          本榜有經證實的「比隨便買好」，沒有經證實的「穩定賺」。
        </div>
      )}

      {/* After-close market report (Phase 3 output) */}
      <MarketReportBanner />

      {/* AI Info Banner */}
      <div className={styles.aiBanner}>
        <div className={styles.aiBannerIcon}>🤖</div>
        <div className={styles.aiBannerText}>
          <div className={styles.aiBannerTitle}>AI 評分說明</div>
          <div className={styles.aiBannerDesc}>
            排序鍵 ＝ <strong>五大因子</strong>（動能／量能／收盤位置／股價層級／形態）
            ＋ 法人與財報加權 ＋ <strong>已驗證訊號 ×3</strong>。
            <br />
            {/* 使用者若比對兩處分數會看到不一致（實測 2330 榜單 81／個股頁 84），
                不說明就只會被當成 bug，而且不知道該信哪個。2026-08-29 補。 */}
            <span style={{ color: 'var(--text-muted)' }}>
              本榜為<strong>全市場快篩</strong>（兩千多檔，只跑技術面）；
              點進個股頁後會再加上日線技術面、財報與新聞判別，
              <strong>分數本來就會不同</strong>，以個股頁的深度評分為準。
            </span>
            <br />
            <span style={{ color: '#fbbf24' }}>⚠ 2026-08-05 依 bt-core 四窗檢定修正</span>：
            原本「收在日高」給滿分 20，但主窗＋第三獨立窗都顯示該組隔日<b>最差</b>（淨勝 33%，五組最低），
            已降為 8 分並改寫成風險；「接近漲停」的最高分也移除（與動能重複計分且檢定不過）。
            另加入本站唯一一批通過兩半窗＋OOT＋regime 的訊號作為疊加項
            （🏔破高×強尾 +2／💪強尾單獨 −2／🐑跟風 −2／🔥5日過熱 −2／📉KD超買 −2／😴低波動 −2）。
            <br />
            <span style={{ color: '#7dd3fc' }}>實測（每日取前 20 名·明開賣扣費稅）</span>：
            修正後排序相對「同期可交易宇宙等權」的超額，主窗 <b>+0.249pp</b>[兩半窗 0.068/0.391]、
            第三獨立窗 <b>+0.184pp</b>[0.173/0.190]——四個半窗全正。
            <b>但絕對淨報酬只有主窗為正（+0.115%），OOT 約打平（-0.001%）</b>：
            它是「比隨便買好」，不是「穩定賺」。分數是排序與避開的工具，不是進場保證。
            總分 <strong>100分制</strong>，A+ 為最高等級（85分以上）。
          </div>
        </div>
        <div className={styles.aiBannerFactors}>
          {[
            { label: '動能', icon: '⚡', desc: '20分' },
            { label: '量能', icon: '📦', desc: '20分' },
            { label: '趨勢', icon: '📈', desc: '20分' },
            { label: '穩定', icon: '🛡️', desc: '20分' },
            { label: '價值', icon: '💎', desc: '20分' },
          ].map(f => (
            <div key={f.label} className={styles.factorChip}>
              <span>{f.icon}</span>
              <span>{f.label}</span>
              <span className={styles.factorChipMax}>{f.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Main Layout */}
      <div className={styles.mainLayout}>
        {/* Left: Recommendations */}
        <div className={styles.leftPanel}>
          {/* Strategy Tabs */}
          <div className={styles.strategyTabs}>
            {STRATEGY_TABS.map(t => (
              <button
                key={t.id}
                id={`ai-tab-${t.id}`}
                className={`${styles.strategyTab} ${activeTab === t.id ? styles.activeTab : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                <span className={styles.tabLabel}>{t.label}</span>
                <span className={styles.tabDesc}>{t.desc}</span>
              </button>
            ))}
          </div>

          {/* Stock Cards */}
          {loading ? (
            <div className={styles.loadingState}>
              <div className="spinner" style={{ width: 40, height: 40 }} />
              <div>AI 正在分析市場中所有股票...</div>
              <div className={styles.loadingHint}>分析 1,000+ 支股票的五大因子中...</div>
            </div>
          ) : error ? (
            <div className={styles.errorState}>{error}</div>
          ) : (
            <div className={styles.cardList} id="ai-recommendations-list">
              {activeTab === 'intraday' && (
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: '2px 4px 8px' }}>
                  ⚡ 即時榜單（每 60 秒更新）：量比×動能×高點位置×跳空×昨日體質。
                  {intraday ? `監測 ${intraday.universe} 檔上攻中個股` : '載入中…'}
                  {intraday && !intraday.marketOpen ? '（非交易時段，顯示最後一次盤中結果）' : ''}
                </div>
              )}
              {stocks.length === 0 ? (
                <div className={styles.emptyState}>{activeTab === 'intraday' ? '目前無符合「放量上攻」條件的個股（開盤初期或盤勢偏弱時屬正常）' : '此策略目前無符合條件的股票'}</div>
              ) : (
                stocks.map((stock, i) => (
                  <StockCard key={stock.code} stock={stock} rank={i + 1} />
                ))
              )}
            </div>
          )}
        </div>

        {/* Right: News Panel */}
        <div className={styles.rightPanel}>
          <MarketNewsPanel />
        </div>
      </div>
    </div>
  );
}
