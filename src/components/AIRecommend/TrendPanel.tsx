'use client';

import { useState, useEffect } from 'react';
import styles from './TrendPanel.module.css';

// ─── Types ────────────────────────────────────────────────────

interface TrendReason { icon: string; title: string; detail: string; strength: 'strong' | 'moderate' | 'weak'; category: string; }
interface TrendAnalysis { summary: string; reasons: TrendReason[]; momentum: 'strong_bull' | 'bull' | 'mild_bull' | 'neutral' | 'bear'; momentumScore: number; }
interface NewsHeadline { source: string; headline: string; date: string; type: 'official' | 'industry' | 'analysis' | 'news'; sentiment: 'positive' | 'negative' | 'neutral'; url?: string; }
interface IndustryInfo { code: string; name: string; sector: string; emoji: string; description: string; }
interface IndustryOutlook { industry: IndustryInfo; shortTerm: string; midTerm: string; longTerm: string; catalysts: string[]; risks: string[]; consensusRating: string; avgTargetUpside: string; institutionalSentiment: number; }

interface OrderLevel { label: string; price: number; rationale: string; style: 'aggressive' | 'standard' | 'conservative' | 'limit'; riskLevel: 'high' | 'medium' | 'low'; }
interface PreMarketRecommendation {
  todayClose: number; prevClose: number; todayChangePercent: number;
  expectedOpeningRange: { low: number; high: number };
  recommendation: 'strong_buy' | 'buy' | 'wait' | 'avoid';
  recommendationText: string; optimalOrderTime: string;
  orderLevels: OrderLevel[]; stopLossPrice: number;
  auctionStrategy: string; dayTradingNote: string; riskWarning: string;
}

interface CompanyProfile {
  code: string; fullName: string; shortName: string;
  chairman: string; ceo: string; spokesperson: string;
  address: string; phone: string;
  foundedDate: string; listedDate: string;
  capitalAmount: string; capitalBillion: number;
  industryCategory: string; industryCode: string;
  mainBusiness: string; keyProducts: string[];
  companyScale: 'large' | 'mid' | 'small';
  ageYears: number; listingAgeYears: number;
}

interface TrendData {
  code: string; companyName: string; industry: IndustryInfo;
  trendAnalysis: TrendAnalysis; newsHeadlines: NewsHeadline[];
  industryOutlook: IndustryOutlook;
  preMarketRecommendation: PreMarketRecommendation;
  companyProfile: CompanyProfile;
}

// ─── Sub-components ───────────────────────────────────────────

function MomentumGauge({ score }: { score: number }) {
  const angle = (score / 100) * 180 - 90;
  const color = score >= 75 ? '#f03e3e' : score >= 55 ? '#e67700' : score >= 45 ? '#94a3b8' : '#2f9e44';
  const levelText = score >= 75 ? '強勢' : score >= 60 ? '偏多' : score >= 45 ? '中性' : '偏弱';
  return (
    <div className={styles.gaugeWrapper}>
      <svg viewBox="0 0 120 70" className={styles.gaugeSvg}>
        <path d="M 10 65 A 50 50 0 0 1 110 65" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="10" strokeLinecap="round" />
        <path d="M 10 65 A 50 50 0 0 1 35 22" fill="none" stroke="rgba(47,158,68,0.5)" strokeWidth="10" strokeLinecap="round" />
        <path d="M 35 22 A 50 50 0 0 1 60 15" fill="none" stroke="rgba(148,163,184,0.4)" strokeWidth="10" strokeLinecap="round" />
        <path d="M 60 15 A 50 50 0 0 1 85 22" fill="none" stroke="rgba(230,119,0,0.5)" strokeWidth="10" strokeLinecap="round" />
        <path d="M 85 22 A 50 50 0 0 1 110 65" fill="none" stroke="rgba(240,62,62,0.5)" strokeWidth="10" strokeLinecap="round" />
        <line x1="60" y1="65" x2={60 + 40 * Math.cos((angle - 90) * Math.PI / 180)} y2={65 + 40 * Math.sin((angle - 90) * Math.PI / 180)} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="60" cy="65" r="5" fill={color} />
        <text x="8" y="76" fontSize="8" fill="rgba(47,158,68,0.8)" textAnchor="middle">弱</text>
        <text x="112" y="76" fontSize="8" fill="rgba(240,62,62,0.8)" textAnchor="middle">強</text>
      </svg>
      <div className={styles.gaugeScore} style={{ color }}>{score}</div>
      <div className={styles.gaugeLevel} style={{ color }}>{levelText}</div>
      <div className={styles.gaugeLabel}>動能強度</div>
    </div>
  );
}

function SentimentBar({ value, label }: { value: number; label: string }) {
  const color = value >= 70 ? '#f03e3e' : value >= 50 ? '#e67700' : '#2f9e44';
  return (
    <div className={styles.sentimentRow}>
      <span className={styles.sentimentLabel}>{label}</span>
      <div className={styles.sentimentTrack}>
        <div className={styles.sentimentFill} style={{ width: `${value}%`, background: `linear-gradient(90deg, ${color}80, ${color})` }} />
      </div>
      <span className={styles.sentimentValue} style={{ color }}>{value}%</span>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────

export default function TrendPanel({ stockCode, stockName }: { stockCode: string; stockName: string }) {
  const [data, setData] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!stockCode) return;
    setLoading(true); setError(''); setData(null);
    fetch(`/api/twse/trend-analysis?code=${stockCode}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(() => setError('分析資料載入失敗'))
      .finally(() => setLoading(false));
  }, [stockCode]);

  if (loading) return (
    <div className={styles.loadingState}>
      <div className="spinner" style={{ width: 28, height: 28 }} />
      <span>AI 正在分析 {stockName} 近期走勢、公司資料與開盤策略...</span>
    </div>
  );
  if (error || !data) return <div className={styles.errorState}>⚠️ {error || '資料不可用'}</div>;

  const { trendAnalysis, newsHeadlines, industryOutlook, industry, preMarketRecommendation: pm, companyProfile: cp } = data;

  const momentumConfig = {
    strong_bull: { label: '強勢多頭', color: '#c92a2a', bg: 'rgba(201,42,42,0.12)', icon: '🚀' },
    bull:        { label: '偏多趨勢', color: '#e67700', bg: 'rgba(230,119,0,0.12)', icon: '📈' },
    mild_bull:   { label: '溫和偏多', color: '#1971c2', bg: 'rgba(25,113,194,0.12)', icon: '↗️' },
    neutral:     { label: '中性整理', color: '#868e96', bg: 'rgba(134,142,150,0.1)', icon: '➡️' },
    bear:        { label: '偏弱格局', color: '#2f9e44', bg: 'rgba(47,158,68,0.1)', icon: '📉' },
  };
  const mCfg = momentumConfig[trendAnalysis.momentum];
  const ratingColor = industryOutlook.consensusRating.startsWith('BUY') ? '#f03e3e' : '#868e96';
  const newsTypeConfig = {
    official: { label: '交易所公告', color: '#1971c2', bg: 'rgba(25,113,194,0.1)' },
    industry: { label: '產業動態', color: '#e67700', bg: 'rgba(230,119,0,0.1)' },
    analysis: { label: 'AI 分析', color: '#c92a2a', bg: 'rgba(201,42,42,0.1)' },
    news:     { label: '市場新聞', color: '#2f9e44', bg: 'rgba(47,158,68,0.1)' },
  };
  const strengthConfig = {
    strong:   { color: '#f03e3e', label: '關鍵因素', border: 'rgba(240,62,62,0.3)' },
    moderate: { color: '#e67700', label: '重要因素', border: 'rgba(230,119,0,0.3)' },
    weak:     { color: '#868e96', label: '次要觀察', border: 'rgba(134,142,150,0.2)' },
  };
  const recConfig = {
    strong_buy: { label: '強力建議進場', color: '#c92a2a', bg: 'rgba(201,42,42,0.12)', icon: '🔴' },
    buy:        { label: '建議進場',     color: '#e67700', bg: 'rgba(230,119,0,0.12)', icon: '📈' },
    wait:       { label: '等待觀察',    color: '#1971c2', bg: 'rgba(25,113,194,0.12)', icon: '⏳' },
    avoid:      { label: '暫緩進場',    color: '#868e96', bg: 'rgba(134,142,150,0.1)', icon: '⚠️' },
  };
  const recCfg = recConfig[pm.recommendation];
  const orderStyleConfig = {
    aggressive:   { label: '積極', color: '#f03e3e', bg: 'rgba(240,62,62,0.1)' },
    standard:     { label: '標準', color: '#e67700', bg: 'rgba(230,119,0,0.1)' },
    conservative: { label: '保守', color: '#2f9e44', bg: 'rgba(47,158,68,0.1)' },
    limit:        { label: '限制', color: '#868e96', bg: 'rgba(134,142,150,0.1)' },
  };
  const riskLevelConfig = {
    high:   '⚠️',
    medium: '🔶',
    low:    '✅',
  };
  const scaleConfig = {
    large: { label: '大型股', color: '#c92a2a' },
    mid:   { label: '中型股', color: '#e67700' },
    small: { label: '小型股', color: '#1971c2' },
  };

  return (
    <div className={styles.panel}>

      {/* ════════════════════════════════════════
          SECTION 0: Company Profile
          ════════════════════════════════════════ */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          🏢 個股公司介紹
          <span className={styles.industryTag}>{industry.emoji} {industry.name} · {industry.sector}</span>
          <span className={styles.scaleBadge} style={{ color: scaleConfig[cp.companyScale].color }}>
            {scaleConfig[cp.companyScale].label}
          </span>
        </div>

        <div className={styles.companyCard}>
          {/* Company Header */}
          <div className={styles.companyHeader}>
            <div className={styles.companyLogoPlaceholder}>
              {cp.shortName?.charAt(0) || stockCode.charAt(0)}
            </div>
            <div className={styles.companyHeaderInfo}>
              <div className={styles.companyFullName}>{cp.fullName}</div>
              <div className={styles.companyCodeRow}>
                <span className={styles.companyCodeTag}>{cp.code}</span>
                <span className={styles.companyShortName}>{cp.shortName}</span>
                {cp.ageYears > 0 && <span className={styles.companyAge}>創立 {cp.ageYears} 年</span>}
                {cp.listingAgeYears > 0 && <span className={styles.companyAge}>上市 {cp.listingAgeYears} 年</span>}
              </div>
            </div>
            {cp.capitalBillion > 0 && (
              <div className={styles.capitalBlock}>
                <div className={styles.capitalLabel}>實收資本</div>
                <div className={styles.capitalValue}>{cp.capitalAmount}</div>
              </div>
            )}
          </div>

          {/* Main Business */}
          <div className={styles.businessSection}>
            <div className={styles.businessLabel}>📋 主要業務</div>
            <div className={styles.businessText}>{cp.mainBusiness}</div>
          </div>

          {/* Key Products */}
          <div className={styles.productsSection}>
            <div className={styles.businessLabel}>🔧 核心產品 / 服務項目</div>
            <div className={styles.productsList}>
              {cp.keyProducts.map((p, i) => (
                <span key={i} className={styles.productTag}>{p}</span>
              ))}
            </div>
          </div>

          {/* Info Grid */}
          <div className={styles.companyInfoGrid}>
            {[
              { label: '董事長', value: cp.chairman },
              { label: '總經理', value: cp.ceo },
              { label: '發言人', value: cp.spokesperson },
              { label: '成立日期', value: cp.foundedDate },
              { label: '上市日期', value: cp.listedDate },
              { label: '公司地址', value: cp.address, wide: true },
            ].filter(item => item.value && item.value !== '--').map((item, i) => (
              <div key={i} className={`${styles.infoItem} ${item.wide ? styles.infoWide : ''}`}>
                <span className={styles.infoLabel}>{item.label}</span>
                <span className={styles.infoValue}>{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════
          SECTION 1: AI Momentum Summary
          ════════════════════════════════════════ */}
      <div className={styles.summarySection}>
        <div className={styles.momentumTag} style={{ background: mCfg.bg, color: mCfg.color }}>
          {mCfg.icon} {mCfg.label}
        </div>
        <div className={styles.summaryText}>{trendAnalysis.summary}</div>
        <MomentumGauge score={trendAnalysis.momentumScore} />
      </div>

      {/* ════════════════════════════════════════
          SECTION 2: Pre-Market Order Recommendation
          ════════════════════════════════════════ */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          ⏰ 開盤前委買建議
          <span className={styles.timeBadge}>
            🕗 {pm.optimalOrderTime}
          </span>
        </div>

        <div className={styles.preMarketCard}>
          {/* Recommendation banner */}
          <div className={styles.recBanner} style={{ background: recCfg.bg, borderColor: `${recCfg.color}40` }}>
            <span className={styles.recIcon}>{recCfg.icon}</span>
            <div className={styles.recContent}>
              <div className={styles.recLabel} style={{ color: recCfg.color }}>{recCfg.label}</div>
              <div className={styles.recText}>{pm.recommendationText}</div>
            </div>
          </div>

          {/* Price overview */}
          <div className={styles.priceOverviewGrid}>
            <div className={styles.priceOverItem}>
              <span className={styles.priceOverLabel}>昨日收盤</span>
              <span className={styles.priceOverValue}>{pm.todayClose.toFixed(2)}</span>
            </div>
            <div className={styles.priceOverItem} style={{ borderColor: 'rgba(240,62,62,0.3)' }}>
              <span className={styles.priceOverLabel} style={{ color: '#f03e3e' }}>預期開盤低</span>
              <span className={styles.priceOverValue} style={{ color: '#f03e3e' }}>{pm.expectedOpeningRange.low.toFixed(2)}</span>
            </div>
            <div className={styles.priceOverItem} style={{ borderColor: 'rgba(240,62,62,0.3)' }}>
              <span className={styles.priceOverLabel} style={{ color: '#f03e3e' }}>預期開盤高</span>
              <span className={styles.priceOverValue} style={{ color: '#f03e3e' }}>{pm.expectedOpeningRange.high.toFixed(2)}</span>
            </div>
            <div className={styles.priceOverItem} style={{ borderColor: 'rgba(47,158,68,0.3)' }}>
              <span className={styles.priceOverLabel} style={{ color: '#2f9e44' }}>建議停損</span>
              <span className={styles.priceOverValue} style={{ color: '#2f9e44' }}>{pm.stopLossPrice.toFixed(2)}</span>
            </div>
          </div>

          {/* Order levels */}
          <div className={styles.orderLevelsSection}>
            <div className={styles.orderLevelsTitle}>📋 委買掛單策略</div>
            <div className={styles.orderLevelsList}>
              {pm.orderLevels.map((level, i) => {
                const osc = orderStyleConfig[level.style];
                return (
                  <div key={i} className={styles.orderLevelCard} id={`order-level-${i}-${stockCode}`}>
                    <div className={styles.orderLevelHeader}>
                      <span className={styles.orderStyleBadge} style={{ background: osc.bg, color: osc.color }}>
                        {osc.label}
                      </span>
                      <span className={styles.orderLevelLabel}>{level.label}</span>
                      <span className={styles.orderRiskIcon}>{riskLevelConfig[level.riskLevel]}</span>
                      <span className={styles.orderLevelPrice} style={{ color: '#f03e3e' }}>
                        {level.price.toFixed(2)} 元
                      </span>
                    </div>
                    <div className={styles.orderLevelRationale}>{level.rationale}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Auction strategy */}
          <div className={styles.auctionBox}>
            <div className={styles.auctionTitle}>🏛️ 競價策略 (08:30~09:00)</div>
            <div className={styles.auctionText}>{pm.auctionStrategy}</div>
          </div>

          {/* Day trading note */}
          <div className={styles.dtNote}>
            <span className={styles.dtNoteLabel}>📊 當日沖銷建議</span>
            <span className={styles.dtNoteText}>{pm.dayTradingNote}</span>
          </div>

          <div className={styles.preMarketWarning}>{pm.riskWarning}</div>
        </div>
      </div>

      {/* ════════════════════════════════════════
          SECTION 3: Trend Reasons
          ════════════════════════════════════════ */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          🔍 近期漲勢原因分析
          <span className={styles.sectionBadge}>{trendAnalysis.reasons.length} 項因素</span>
        </div>
        <div className={styles.reasonsList}>
          {trendAnalysis.reasons.map((reason, i) => {
            const sc = strengthConfig[reason.strength];
            return (
              <div key={i} className={styles.reasonCard} style={{ borderColor: sc.border }}>
                <div className={styles.reasonHeader}>
                  <span className={styles.reasonIcon}>{reason.icon}</span>
                  <span className={styles.reasonTitle}>{reason.title}</span>
                  <span className={styles.reasonStrength} style={{ color: sc.color }}>{sc.label}</span>
                </div>
                <div className={styles.reasonDetail}>{reason.detail}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ════════════════════════════════════════
          SECTION 4: News Headlines
          ════════════════════════════════════════ */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          📰 相關新聞標題
          <span className={styles.liveTag}>
            <span className="live-dot" style={{ width: 6, height: 6 }} />
            即時
          </span>
        </div>
        <div className={styles.newsList}>
          {newsHeadlines.length === 0 ? (
            <div className={styles.noNews}>目前無相關新聞，請稍後再查</div>
          ) : (
            newsHeadlines.map((news, i) => {
              const nc = newsTypeConfig[news.type] || newsTypeConfig.analysis;
              const sentimentIcon = news.sentiment === 'positive' ? '🔴' : news.sentiment === 'negative' ? '🟢' : '⚪';
              return (
                <div key={i} className={styles.newsCard} id={`trend-news-${i}-${stockCode}`}>
                  <div className={styles.newsTop}>
                    <span className={styles.newsTypeBadge} style={{ background: nc.bg, color: nc.color }}>{nc.label}</span>
                    <span className={styles.newsSentiment}>{sentimentIcon}</span>
                    <span className={styles.newsDate}>{news.date}</span>
                  </div>
                  <div className={styles.newsHeadline}>{news.headline}</div>
                  <div className={styles.newsSource}>來源：{news.source}</div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ════════════════════════════════════════
          SECTION 5: Industry Outlook
          ════════════════════════════════════════ */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          {industry.emoji} 產業面市場預期走向
          <span className={styles.industryTag}>{industry.name} · {industry.sector}</span>
        </div>
        <div className={styles.outlookCard}>
          <div className={styles.horizonGrid}>
            {[
              { period: '短期（1個月）', value: industryOutlook.shortTerm },
              { period: '中期（3個月）', value: industryOutlook.midTerm },
              { period: '長期（6個月）', value: industryOutlook.longTerm },
            ].map(h => {
              const isPos = h.value.includes('多') || h.value.includes('強');
              const hColor = isPos ? '#f03e3e' : h.value.includes('弱') ? '#2f9e44' : '#868e96';
              return (
                <div key={h.period} className={styles.horizonItem}>
                  <div className={styles.horizonPeriod}>{h.period}</div>
                  <div className={styles.horizonValue} style={{ color: hColor }}>{h.value}</div>
                </div>
              );
            })}
          </div>
          <div className={styles.sentimentSection}>
            <SentimentBar value={industryOutlook.institutionalSentiment} label="法人看好度" />
          </div>
          <div className={styles.consensusRow}>
            <div className={styles.consensusItem}>
              <span className={styles.consensusLabel}>市場共識評等</span>
              <span className={styles.consensusValue} style={{ color: ratingColor }}>{industryOutlook.consensusRating}</span>
            </div>
            <div className={styles.consensusItem}>
              <span className={styles.consensusLabel}>平均目標漲幅</span>
              <span className={styles.consensusValue} style={{ color: '#2f9e44' }}>{industryOutlook.avgTargetUpside}</span>
            </div>
          </div>
          <div className={styles.catalystsSection}>
            <div className={styles.catalystsTitle}>🚀 上漲催化劑</div>
            <div className={styles.catalystsList}>
              {industryOutlook.catalysts.map((c, i) => (
                <div key={i} className={styles.catalystItem}>
                  <span className={styles.catalystDot} />
                  <span>{c}</span>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.risksSection}>
            <div className={styles.risksTitle}>⚠️ 主要下行風險</div>
            <div className={styles.risksList}>
              {industryOutlook.risks.map((r, i) => (
                <div key={i} className={styles.riskItem}>
                  <span className={styles.riskDot} />
                  <span>{r}</span>
                </div>
              ))}
            </div>
          </div>
          <div className={styles.industryDesc}>{industry.description}</div>
        </div>
      </div>

      {/* Disclaimer */}
      <div className={styles.disclaimer}>
        ⚠️ 以上分析由 AI 基於 TWSE 公開資料自動生成，開盤價格預測為統計模型推算，不構成投資建議。請自行判斷並承擔投資風險。
      </div>
    </div>
  );
}
