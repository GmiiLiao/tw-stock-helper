'use client';

import { useState, useEffect } from 'react';
import { industryLineOf, stopRefCellText, type Reading, type ReadingKey, type TodayMove, type StopRef, type QuotePhase } from '@/lib/stock-readings';
import ReadingRow from '@/components/shared/ReadingRow';
import styles from './TrendPanel.module.css';

// 2026-10-08 使用者裁定「不使用原來的寫死值，使用判讀結果真實表示」（hardcoded-to-real-spec F1–F13、F24、F27）：
//   動能儀表、法人看好度、共識評等、平均目標漲幅、短中長期判斷、催化劑／風險、產業模板新聞、明日開盤建議全部移除，
//   改讀 trend-analysis 的新欄位（todayMove／readings／stopRef／expectedOpeningRange.basis／companyProfile.scale）。
//   新欄位不存在（部署切換期間的舊 JSON）一律顯示「暫時無法取得」，不退回讀 legacy 鍵。非投資建議。

// ─── Types ────────────────────────────────────────────────────

interface TrendReason { icon: string; title: string; detail: string; strength: 'strong' | 'moderate' | 'weak'; category: string; }
interface TrendAnalysis { summary: string; reasons: TrendReason[]; }
interface NewsHeadline { source: string; headline: string; date: string; type: 'official' | 'industry' | 'analysis' | 'news'; sentiment: 'positive' | 'negative' | 'neutral'; url?: string; }
interface IndustryInfo { code: string; name: string; sector: string; emoji: string; description: string; }

interface OrderLevel { label: string; price: number; rationale: string; }
interface PreMarketRecommendation {
  todayClose: number; prevClose: number; todayChangePercent: number;
  expectedOpeningRange: { low: number; high: number; basis?: string };
  orderLevels: OrderLevel[];
  stopRef?: StopRef;
  riskWarning?: string;
}

interface CompanyProfile {
  code: string; fullName: string; shortName: string;
  chairman: string; ceo: string; spokesperson: string;
  address: string; phone: string;
  foundedDate: string; listedDate: string;
  capitalAmount: string; capitalBillion: number;
  industryCategory: string; industryCode: string;
  mainBusiness: string; keyProducts: string[]; keyProductsSource?: string | null; officialIndustry?: string | null;
  scale?: 'large' | 'mid' | 'small' | null;
  dataSource?: string;
  ageYears: number; listingAgeYears: number;
}

interface TrendData {
  code: string; companyName: string; industry: IndustryInfo;
  phase?: QuotePhase;
  todayMove?: TodayMove | null;
  readings?: Partial<Record<ReadingKey, Reading>>;
  trendAnalysis: TrendAnalysis; newsHeadlines: NewsHeadline[];
  preMarketRecommendation: PreMarketRecommendation;
  companyProfile: CompanyProfile;
}

const MOVE_TONE = {
  up:   { color: '#c92a2a', bg: 'rgba(201,42,42,0.12)', icon: '📈' },
  down: { color: '#2f9e44', bg: 'rgba(47,158,68,0.1)', icon: '📉' },
  flat: { color: '#868e96', bg: 'rgba(134,142,150,0.1)', icon: '➡️' },
};
// 重要度標籤（依 |漲跌幅| 對稱給），不是方向——一律中性色
const STRENGTH_LABEL = {
  strong:   { color: '#cbd5e1', label: '主要事實', border: 'rgba(148,163,184,0.45)' },
  moderate: { color: '#94a3b8', label: '次要事實', border: 'rgba(148,163,184,0.3)' },
  weak:     { color: '#868e96', label: '參考', border: 'rgba(134,142,150,0.2)' },
};
const SCALE_CONFIG = {
  large: { label: '大型股', color: '#c92a2a' },
  mid:   { label: '中型股', color: '#e67700' },
  small: { label: '小型股', color: '#1971c2' },
};

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
      <span>載入 {stockName} 的走勢、公司資料與價格參考…</span>
    </div>
  );
  if (error || !data) return <div className={styles.errorState}>⚠️ {error || '資料不可用'}</div>;

  const { trendAnalysis, newsHeadlines, industry, preMarketRecommendation: pm, companyProfile: cp } = data;
  const rd = data.readings;
  const isNew = !!rd;
  const move = data.todayMove ?? null;
  const tone = MOVE_TONE[move?.tone ?? 'flat'];
  const scale = cp.scale ?? null;
  const stopRef = pm.stopRef ?? null;
  const anchor = data.phase === 'intraday' ? '目前價' : data.phase === 'quote' ? '最新價' : '今收';

  return (
    <div className={styles.panel}>

      {/* ════════════════════════════════════════
          SECTION 0: Company Profile
          ════════════════════════════════════════ */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          🏢 個股公司介紹
          <span className={styles.industryTag}>{industryLineOf(industry, cp)}</span>
          {scale && (
            <span className={styles.scaleBadge} style={{ color: SCALE_CONFIG[scale].color }} title="依實收資本額分級（本站規則：≥500 億大型、≥50 億中型）">
              {SCALE_CONFIG[scale].label}
            </span>
          )}
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

          {/* Main Business（L13）：公開資訊觀測站登記原文；空值據實說明 */}
          <div className={styles.businessSection}>
            <div className={styles.businessLabel}>📋 主要業務</div>
            <div className={styles.businessText}>{cp.mainBusiness || '來源未提供（公開資訊觀測站查無此公司登記資料）'}</div>
          </div>

          {/* Key Products（空陣列不渲染） */}
          {cp.keyProducts.length > 0 && (
            <div className={styles.productsSection}>
              <div className={styles.businessLabel}>🔧 核心產品 / 服務項目{cp.keyProductsSource ? `（${cp.keyProductsSource}）` : ''}</div>
              <div className={styles.productsList}>
                {cp.keyProducts.map((p, i) => (
                  <span key={i} className={styles.productTag}>{p}</span>
                ))}
              </div>
            </div>
          )}

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

      {!isNew && (
        <div className={styles.section}>
          <div className={styles.noNews}>走勢與判讀資料暫時無法取得，請重新整理。</div>
        </div>
      )}

      {isNew && (
        <>
          {/* ════════════════════════════════════════
              SECTION 1: 今日走勢（描述）
              ════════════════════════════════════════ */}
          <div className={styles.summarySection}>
            <div className={styles.momentumTag} style={{ background: tone.bg, color: tone.color }}>
              {tone.icon} {move?.label ?? '暫時無法取得'}
            </div>
            <div className={styles.summaryText}>{trendAnalysis.summary}</div>
          </div>

          {/* ════════════════════════════════════════
              SECTION 2: 價格參考（公式試算）＋明日方向
              ════════════════════════════════════════ */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>⏰ 價格參考（公式試算）</div>

            <div className={styles.preMarketCard}>
              <ReadingRow reading={rd?.nextDayDir} fallbackLabel="明日方向" />

              {/* Price overview */}
              <div className={styles.priceOverviewGrid}>
                <div className={styles.priceOverItem}>
                  <span className={styles.priceOverLabel}>{anchor}</span>
                  <span className={styles.priceOverValue}>{pm.todayClose > 0 ? pm.todayClose.toFixed(2) : '—'}</span>
                </div>
                <div className={styles.priceOverItem}>
                  <span className={styles.priceOverLabel}>開盤參考低（公式）</span>
                  <span className={styles.priceOverValue}>{pm.expectedOpeningRange.low > 0 ? pm.expectedOpeningRange.low.toFixed(2) : '—'}</span>
                </div>
                <div className={styles.priceOverItem}>
                  <span className={styles.priceOverLabel}>開盤參考高（公式）</span>
                  <span className={styles.priceOverValue}>{pm.expectedOpeningRange.high > 0 ? pm.expectedOpeningRange.high.toFixed(2) : '—'}</span>
                </div>
                <div className={styles.priceOverItem}>
                  <span className={styles.priceOverLabel}>{stopRef?.label ?? '參考停損（進場前）'}</span>
                  <span className={styles.priceOverValue}>{stopRefCellText(stopRef)}</span>
                </div>
              </div>
              <div className={styles.orderLevelRationale}>
                開盤參考區間：{pm.expectedOpeningRange.basis ?? '—'}
                <br />
                {stopRef?.label ?? '參考停損（進場前）'}：{stopRef?.basis ?? '—'}{stopRef?.note ? `；${stopRef.note}` : ''}
              </div>
              <ReadingRow reading={rd?.openRange} fallbackLabel="歷史落入率" />

              {/* Order levels（公式倍數；不顯示積極／保守徽章與風險圖示） */}
              {pm.orderLevels.length > 0 && (
                <div className={styles.orderLevelsSection}>
                  <div className={styles.orderLevelsTitle}>📋 價格參考（公式試算，非買賣建議）</div>
                  <div className={styles.orderLevelsList}>
                    {pm.orderLevels.map((level, i) => (
                      <div key={i} className={styles.orderLevelCard} id={`order-level-${i}-${stockCode}`}>
                        <div className={styles.orderLevelHeader}>
                          <span className={styles.orderLevelLabel}>{level.label}</span>
                          <span className={styles.orderLevelPrice}>{level.price.toFixed(2)} 元</span>
                        </div>
                        <div className={styles.orderLevelRationale}>{level.rationale}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {pm.riskWarning && <div className={styles.preMarketWarning}>{pm.riskWarning}</div>}
            </div>
          </div>

          {/* ════════════════════════════════════════
              SECTION 3: 今日走勢觀察（描述）
              ════════════════════════════════════════ */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>
              🔍 今日走勢觀察（描述）
              <span className={styles.sectionBadge}>{trendAnalysis.reasons.length} 項事實</span>
            </div>
            <div className={styles.reasonsList}>
              {trendAnalysis.reasons.length === 0 ? (
                <div className={styles.noNews}>今日沒有達到描述門檻的事實項目（漲跌 ≥2%、成交值逾 10 億元、收在日內兩端、跳空逾 1%）。</div>
              ) : trendAnalysis.reasons.map((reason, i) => {
                const sc = STRENGTH_LABEL[reason.strength] ?? STRENGTH_LABEL.weak;
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
              SECTION 4: 重大訊息（公開資訊觀測站近 7 日、上市櫃，L24；未判別利多利空）
              ════════════════════════════════════════ */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>📰 重大訊息（公開資訊觀測站）</div>
            <div className={styles.newsList}>
              {newsHeadlines.length === 0 ? (
                <div className={styles.noNews}>
                  近 7 日公開資訊觀測站重大訊息沒有本檔（上市櫃皆比對）。新聞判別見「📊 因子 & 推薦」分頁（若本檔有）。
                </div>
              ) : (
                newsHeadlines.map((news, i) => (
                  <div key={i} className={styles.newsCard} id={`trend-news-${i}-${stockCode}`}>
                    <div className={styles.newsHeadline}>{news.headline}</div>
                    <div className={styles.newsSource}>來源：{news.source} {news.date}</div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* ════════════════════════════════════════
              SECTION 5: 📊 判讀結果（F1–F5）
              ════════════════════════════════════════ */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>📊 判讀結果</div>
            <div className={styles.outlookCard}>
              <ReadingRow reading={rd?.horizonShort} fallbackLabel="隔日方向" />
              <ReadingRow reading={rd?.horizonMid} fallbackLabel="5 日方向" />
              <ReadingRow reading={rd?.horizonLong} fallbackLabel="20 日以上方向" />
              <ReadingRow reading={rd?.instFlow} fallbackLabel="法人籌碼動向（描述）" />
              <ReadingRow reading={rd?.model20} fallbackLabel="模型評等（20 日）" />
              <ReadingRow reading={rd?.dist20} fallbackLabel="歷史同條件 20 日報酬分布" />
              <ReadingRow reading={rd?.newsDir} fallbackLabel="新聞判讀（利多／利空）" last />
            </div>
          </div>
        </>
      )}

      {/* Disclaimer */}
      <div className={styles.disclaimer}>
        ⚠️ 以上價位為公式試算；判讀欄位依各自來源與資料日顯示。非投資建議。
      </div>
    </div>
  );
}
