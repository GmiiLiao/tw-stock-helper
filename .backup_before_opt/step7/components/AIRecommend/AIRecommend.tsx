'use client';

import { useState, useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import styles from './AIRecommend.module.css';
import BuySellPanel from './BuySellPanel';
import TrendPanel from './TrendPanel';
import RiskBadge from '@/components/shared/RiskBadge';

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
  generatedAt: string;
}

const STRATEGY_TABS = [
  { id: 'all', label: '🤖 AI 精選 TOP 20', desc: '綜合評分最高' },
  { id: 'intraday', label: '⚡ 盤中潛力', desc: '即時放量上攻' },
  { id: 'daily', label: '🚀 動能強勢', desc: '今日強勢股' },
  { id: 'growth', label: '📈 成長潛力', desc: '法人資金進駐' },
  { id: 'defensive', label: '🛡️ 穩健防禦', desc: '低波動優質股' },
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
  const { navigateTo, addToWatchlist, isInWatchlist } = useAppStore();
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
                      <span style={{ fontSize: '0.72rem', fontWeight: 800, padding: '2px 9px', borderRadius: 999, background: `${col}1f`, color: col, border: `1px solid ${col}` }}>{swingSig.actionLabel}</span>
                      <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>紀律評分 {swingSig.score}/100 · {swingSig.trend} · 乖離 {swingSig.biasPct >= 0 ? '+' : ''}{swingSig.biasPct}%</span>
                    </div>
                    {swingSig.chase && <div style={{ marginTop: 4, fontSize: '0.78rem', color: '#e67700', fontWeight: 600 }}>🚫 乖離過大，嚴禁追高 — 等回測均線再進場（提升勝率）</div>}
                    <div style={{ marginTop: 4, fontSize: '0.7rem', color: 'var(--text-muted)' }}>趨勢{swingSig.components.trend}·乖離{swingSig.components.bias}·量價{swingSig.components.volume}·均線{swingSig.components.ma}·MACD{swingSig.components.macd}·RSI{swingSig.components.rsi}</div>
                  </div>
                );
              })()}

              {/* Reasons */}
              <div className={styles.reasonsSection}>
                <div className={styles.detailTitle}>✅ 推薦理由 {enrichLoading && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>· 載入基本面…</span>}</div>
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
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                          PER {fundamentals.valuation.pe ?? '—'} · 殖利率 {fundamentals.valuation.dividendYield ?? '—'}% · PBR {fundamentals.valuation.pb ?? '—'}
                        </span>
                      </div>
                    )}
                    {fundamentals.institutional && (
                      <div className={styles.factorRow}>
                        <span className={styles.factorLabel}>法人</span>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                          外資 {fundamentals.institutional.foreignNetLots.toLocaleString()} 張 · 投信 {fundamentals.institutional.trustNetLots.toLocaleString()} 張 · 合計 {fundamentals.institutional.totalNetLots.toLocaleString()} 張
                        </span>
                      </div>
                    )}
                    {fundamentals.margin && (
                      <div className={styles.factorRow}>
                        <span className={styles.factorLabel}>融資</span>
                        <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
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
  const { navigateTo } = useAppStore();
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
  const [scoreboard, setScoreboard] = useState<{ records: number; agg: Record<string, Record<string, { n: number; winRate: number; avgRet: number }>> } | null>(null);
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
            基於五大因子量化評分，從 {data?.totalAnalyzed?.toLocaleString() || '--'} 支股票中精選潛力標的
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

      {/* 推薦成績記分板：各榜單 5/10/20 日勝率（可信度校準） */}
      {scoreboard && (Object.keys(scoreboard.agg.top20 || {}).length > 0 || Object.keys(scoreboard.agg.intraday || {}).length > 0) && (
        <div style={{ marginBottom: 16, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
          <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: 8 }}>🏅 AI 推薦成績（滾動追蹤 {scoreboard.records} 個交易日）
            <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>每檔推薦於 5/10/20 日後以收盤結算</span>
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12.5 }}>
            {([['top20', '🤖 TOP20'], ['intraday', '⚡ 盤中潛力']] as const).map(([k, label]) => (
              <div key={k}>
                <b>{label}</b>：
                {(['d5', 'd10', 'd20'] as const).map(h => {
                  const s = scoreboard.agg[k]?.[h];
                  return s ? <span key={h} style={{ marginLeft: 8 }}>{h.slice(1)}日 勝率 <b style={{ color: s.winRate >= 55 ? 'var(--color-up)' : s.winRate >= 45 ? '#f59e0b' : 'var(--color-down)' }}>{s.winRate}%</b>（均 {s.avgRet >= 0 ? '+' : ''}{s.avgRet}%，n={s.n}）</span> : null;
                })}
                {!scoreboard.agg[k] || !Object.keys(scoreboard.agg[k]).length ? <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>累積中（5 個交易日後出現）</span> : null}
              </div>
            ))}
          </div>
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
            採用 <strong>五大因子</strong> 量化評估：動能（今日漲幅）× 量能（成交值）× 趨勢（收盤位置）× 穩定性（股價層級）× 價值評估（漲停分析）。
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
                <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '2px 4px 8px' }}>
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
