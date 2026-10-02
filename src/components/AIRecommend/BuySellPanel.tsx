'use client';

import styles from './BuySellPanel.module.css';
import { getChangeColor } from '@/lib/twse-api';

// ─── Types (matches API) ─────────────────────────────────────

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

interface BuySellPanelProps {
  currentPrice: number;
  high: number;
  low: number;
  open: number;
  buyZones: BuyZone[];
  sellTargets: SellTarget[];
  stopLoss: number;
  stopLossRationale: string;
  patterns: PatternSignal[];
  tradeSetup: TradeSetup;
}

// ─── Price Ladder Chart ──────────────────────────────────────

function PriceLadder({
  currentPrice, high, low, buyZones, sellTargets, stopLoss
}: {
  currentPrice: number; high: number; low: number;
  buyZones: BuyZone[]; sellTargets: SellTarget[]; stopLoss: number;
}) {
  // Collect all relevant prices and compute chart range
  const allPrices = [
    stopLoss,
    ...buyZones.map(z => z.price),
    currentPrice,
    ...sellTargets.filter(t => t.type !== 'trailing').map(t => t.price),
  ].filter(p => p > 0);

  const minP = Math.min(...allPrices) * 0.995;
  const maxP = Math.max(...allPrices) * 1.005;
  const priceRange = maxP - minP;

  const toY = (p: number) => ((maxP - p) / priceRange) * 100; // % from top

  const standardBuy = buyZones.find(z => z.type === 'standard')?.price || currentPrice;

  return (
    <div className={styles.ladderWrapper}>
      <div className={styles.ladderTitle}>📊 價格區間示意圖</div>
      <div className={styles.ladder}>
        {/* Sell targets */}
        {sellTargets.filter(t => t.type !== 'trailing').map(t => {
          const y = toY(t.price);
          const gainFromBuy = ((t.price - standardBuy) / standardBuy * 100).toFixed(1);
          return (
            <div
              key={t.type}
              className={`${styles.ladderLevel} ${styles.sellLevel}`}
              style={{ top: `${y}%` }}
            >
              <div className={styles.levelLine} style={{ borderColor: '#2f9e44' }} />
              <div className={styles.levelLabel}>
                <span className={styles.levelTag} style={{ background: 'rgba(47,158,68,0.15)', color: '#2f9e44', borderColor: 'rgba(47,158,68,0.3)' }}>
                  {t.type === 'tp1' ? '🎯 TP1' : t.type === 'tp2' ? '🎯 TP2' : '🚀 TP3'}
                </span>
                <span className={styles.levelPrice}>{t.price.toFixed(2)}</span>
                <span style={{ color: getChangeColor(Number(gainFromBuy)), fontSize: 'calc(12.5px * var(--fz))' }}>{Number(gainFromBuy) > 0 ? '+' : ''}{gainFromBuy}%</span>
              </div>
            </div>
          );
        })}

        {/* Current price */}
        <div
          className={`${styles.ladderLevel} ${styles.currentLevel}`}
          style={{ top: `${toY(currentPrice)}%` }}
        >
          <div className={styles.levelLine} style={{ borderColor: '#f59e0b', borderStyle: 'solid', borderWidth: '2px' }} />
          <div className={styles.levelLabel}>
            <span className={styles.levelTag} style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b', borderColor: 'rgba(245,158,11,0.3)' }}>
              ◆ 現價
            </span>
            <span className={styles.levelPrice}>{currentPrice.toFixed(2)}</span>
          </div>
        </div>

        {/* Buy zones */}
        {buyZones.filter(z => z.price < currentPrice).map(z => {
          const y = toY(z.price);
          const tagColors: Record<BuyZone['type'], { bg: string; color: string; border: string }> = {
            aggressive: { bg: 'rgba(240,62,62,0.15)', color: '#f03e3e', border: 'rgba(240,62,62,0.3)' },
            standard:   { bg: 'rgba(240,62,62,0.25)', color: '#c92a2a', border: 'rgba(201,42,42,0.5)' },
            conservative: { bg: 'rgba(240,62,62,0.1)', color: '#e67700', border: 'rgba(230,119,0,0.3)' },
            dip:         { bg: 'rgba(240,62,62,0.08)', color: '#868e96', border: 'rgba(134,142,150,0.2)' },
          };
          const tc = tagColors[z.type];
          return (
            <div
              key={z.type}
              className={`${styles.ladderLevel} ${styles.buyLevel}`}
              style={{ top: `${y}%` }}
            >
              <div className={styles.levelLine} style={{ borderColor: tc.color }} />
              <div className={styles.levelLabel}>
                <span className={styles.levelTag} style={{ background: tc.bg, color: tc.color, borderColor: tc.border }}>
                  🔴 {z.label}
                </span>
                <span className={styles.levelPrice}>{z.price.toFixed(2)}</span>
                <span style={{ color: tc.color, fontSize: 'calc(12.5px * var(--fz))' }}>{z.probability}%</span>
              </div>
            </div>
          );
        })}

        {/* Stop Loss */}
        <div
          className={`${styles.ladderLevel} ${styles.slLevel}`}
          style={{ top: `${toY(stopLoss)}%` }}
        >
          <div className={styles.levelLine} style={{ borderColor: '#868e96', borderStyle: 'dashed' }} />
          <div className={styles.levelLabel}>
            <span className={styles.levelTag} style={{ background: 'rgba(134,142,150,0.12)', color: '#868e96', borderColor: 'rgba(134,142,150,0.2)' }}>
              🚫 停損
            </span>
            <span className={styles.levelPrice}>{stopLoss.toFixed(2)}</span>
          </div>
        </div>

        {/* Background zones */}
        <div
          className={styles.sellZoneBg}
          style={{
            top: 0,
            height: `${toY(currentPrice)}%`,
          }}
        />
        <div
          className={styles.buyZoneBg}
          style={{
            top: `${toY(currentPrice)}%`,
            height: `${toY(stopLoss) - toY(currentPrice)}%`,
          }}
        />
      </div>
    </div>
  );
}

// ─── Pattern Badges ──────────────────────────────────────────

function PatternBadge({ p }: { p: PatternSignal }) {
  const cfg = p.type === 'bullish'
    ? { bg: 'rgba(240,62,62,0.1)', color: '#f03e3e', border: 'rgba(240,62,62,0.3)', icon: '🔴' }
    : p.type === 'bearish'
    ? { bg: 'rgba(47,158,68,0.1)', color: '#2f9e44', border: 'rgba(47,158,68,0.3)', icon: '🟢' }
    : { bg: 'rgba(245,158,11,0.1)', color: '#e67700', border: 'rgba(245,158,11,0.3)', icon: '⚪' };

  return (
    <div className={styles.patternCard} style={{ borderColor: cfg.border }}>
      <div className={styles.patternHeader}>
        <span className={styles.patternBadge} style={{ background: cfg.bg, color: cfg.color }}>
          {cfg.icon} {p.name}
        </span>
        <div className={styles.patternStrength}>
          <div className={styles.strengthBar}>
            <div className={styles.strengthFill} style={{ width: `${p.strength}%`, background: cfg.color }} />
          </div>
          <span style={{ color: cfg.color, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700 }}>{p.strength}%</span>
        </div>
      </div>
      <p className={styles.patternDesc}>{p.description}</p>
      <div className={styles.patternHint}>
        <span>💡</span>
        <span>{p.actionHint}</span>
      </div>
    </div>
  );
}

// ─── Trade Setup Summary ─────────────────────────────────────

function TradeSetupCard({ setup }: { setup: TradeSetup }) {
  const styleColors: Record<string, { color: string; bg: string }> = {
    '短線': { color: '#f03e3e', bg: 'rgba(240,62,62,0.1)' },
    '波段': { color: '#3d8ef8', bg: 'rgba(61,142,248,0.1)' },
    '存股': { color: '#2f9e44', bg: 'rgba(47,158,68,0.1)' },
  };
  const sc = styleColors[setup.style];
  const rrColor = setup.overallRiskReward >= 2 ? '#2f9e44' : setup.overallRiskReward >= 1.5 ? '#e67700' : '#f03e3e';

  return (
    <div className={styles.setupCard}>
      <div className={styles.setupHeader}>
        <span className={styles.setupStyle} style={{ background: sc.bg, color: sc.color }}>
          {setup.style}操作
        </span>
        <div className={styles.setupRR}>
          <span style={{ color: '#94a3b8', fontSize: 'calc(12.5px * var(--fz))' }}>風報比</span>
          <span style={{ color: rrColor, fontWeight: 800, fontSize: 'calc(1.1rem * var(--fz))', fontFamily: 'JetBrains Mono, monospace' }}>
            1:{setup.overallRiskReward}
          </span>
        </div>
      </div>

      <div className={styles.setupGrid}>
        <div className={styles.setupItem}>
          <div className={styles.setupItemLabel}>最大虧損</div>
          <div className={styles.setupItemValue} style={{ color: 'var(--color-down)' }}>-{setup.maxRisk}%</div>
        </div>
        <div className={styles.setupItem}>
          <div className={styles.setupItemLabel}>預期獲利</div>
          <div className={styles.setupItemValue} style={{ color: 'var(--color-up)' }}>+{setup.expectedGain}%</div>
        </div>
        <div className={styles.setupItem}>
          <div className={styles.setupItemLabel}>持有週期</div>
          <div className={styles.setupItemValue} style={{ fontSize: 'calc(12.5px * var(--fz))' }}>{setup.holdPeriod}</div>
        </div>
        <div className={styles.setupItem}>
          <div className={styles.setupItemLabel}>部位建議</div>
          <div className={styles.setupItemValue} style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#94a3b8' }}>{setup.positionSizing}</div>
        </div>
      </div>

      <div className={styles.entryTimingBox}>
        <div className={styles.entryTimingLabel}>⏰ 進場時機建議</div>
        <div className={styles.entryTimingText}>{setup.entryTiming}</div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

export default function BuySellPanel(props: BuySellPanelProps) {
  const { currentPrice, buyZones, sellTargets, stopLoss, stopLossRationale, patterns, tradeSetup, high, low, open } = props;

  const buyTypeConfig: Record<BuyZone['type'], { color: string; badge: string; icon: string }> = {
    aggressive:   { color: '#f03e3e', badge: '積極', icon: '🔴' },
    standard:     { color: '#c92a2a', badge: '標準 ★', icon: '🔴' },
    conservative: { color: '#e67700', badge: '保守', icon: '🟠' },
    dip:          { color: '#868e96', badge: '逢低', icon: '🟡' },
  };

  return (
    <div className={styles.panel} id="buy-sell-panel">
      {/* Section 1: Trade Setup Summary */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>⚡ 交易設定總覽</div>
        <TradeSetupCard setup={tradeSetup} />
      </div>

      {/* Section 2: Two-column Buy & Sell */}
      <div className={styles.twoCol}>
        {/* Buy Zones */}
        <div className={styles.buySection}>
          <div className={styles.colHeader} style={{ color: '#f03e3e' }}>
            <span>🔴 買點分析</span>
            <span className={styles.colSubtitle}>分批進場策略</span>
          </div>
          <div className={styles.zoneList}>
            {buyZones.map(zone => {
              const cfg = buyTypeConfig[zone.type];
              return (
                <div
                  key={zone.type}
                  className={`${styles.zoneCard} ${zone.type === 'standard' ? styles.zoneHighlight : ''}`}
                  style={zone.type === 'standard' ? { borderColor: 'rgba(201,42,42,0.4)' } : {}}
                >
                  <div className={styles.zoneTop}>
                    <div className={styles.zoneMeta}>
                      <span className={styles.zoneLabel} style={{ color: cfg.color }}>
                        {cfg.icon} {zone.label}
                      </span>
                      {zone.type === 'standard' && (
                        <span className={styles.recommendedTag}>推薦</span>
                      )}
                    </div>
                    <div className={styles.zonePrice} style={{ color: cfg.color }}>
                      {zone.price.toFixed(2)}
                    </div>
                  </div>
                  <div className={styles.zoneRange}>
                    區間：{zone.priceRange[0].toFixed(2)} ~ {zone.priceRange[1].toFixed(2)}
                  </div>
                  <div className={styles.zoneMiniStats}>
                    <span>型態：{zone.pattern}</span>
                    <span>達到率 {zone.probability}%</span>
                    <span>風報 1:{zone.riskReward}</span>
                  </div>
                  <div className={styles.zoneRationale}>{zone.rationale}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Sell Targets */}
        <div className={styles.sellSection}>
          <div className={styles.colHeader} style={{ color: '#2f9e44' }}>
            <span>🟢 賣點目標</span>
            <span className={styles.colSubtitle}>分批出場策略</span>
          </div>
          <div className={styles.zoneList}>
            {sellTargets.map(target => {
              const isTrailing = target.type === 'trailing';
              return (
                <div
                  key={target.type}
                  className={`${styles.zoneCard} ${target.type === 'tp1' ? styles.zoneHighlightSell : ''}`}
                  style={target.type === 'tp1' ? { borderColor: 'rgba(47,158,68,0.4)' } : {}}
                >
                  <div className={styles.zoneTop}>
                    <div className={styles.zoneMeta}>
                      <span className={styles.zoneLabel} style={{ color: '#2f9e44' }}>
                        {isTrailing ? '🔄' : '🎯'} {target.label}
                      </span>
                      {target.type === 'tp1' && (
                        <span className={styles.recommendedTag} style={{ background: 'rgba(47,158,68,0.15)', color: '#2f9e44', borderColor: 'rgba(47,158,68,0.3)' }}>首選</span>
                      )}
                    </div>
                    {!isTrailing && (
                      <div className={styles.zonePrice} style={{ color: '#2f9e44' }}>
                        {target.price.toFixed(2)}
                      </div>
                    )}
                  </div>
                  <div className={styles.zoneMiniStats}>
                    {!isTrailing && <span className={styles.gainChip}>+{target.gainPercent}%</span>}
                    {!isTrailing && <span>達到率 {target.probability}%</span>}
                    <span>持有：{target.holdDays}</span>
                  </div>
                  <div className={styles.zoneRationale}>{target.rationale}</div>
                </div>
              );
            })}
          </div>

          {/* Stop Loss Card */}
          <div className={styles.stopLossCard}>
            <div className={styles.slHeader}>
              <span className={styles.slLabel}>🚫 停損設定</span>
              <span className={styles.slPrice}>{stopLoss.toFixed(2)}</span>
            </div>
            <div className={styles.slPercent}>
              較現價 -{((currentPrice - stopLoss) / currentPrice * 100).toFixed(1)}%
            </div>
            <div className={styles.slRationale}>{stopLossRationale}</div>
          </div>
        </div>
      </div>

      {/* Section 3: Price Ladder */}
      <div className={styles.section}>
        <PriceLadder
          currentPrice={currentPrice}
          high={high}
          low={low}
          buyZones={buyZones}
          sellTargets={sellTargets}
          stopLoss={stopLoss}
        />
      </div>

      {/* Section 4: Pattern Recognition */}
      {patterns.length > 0 && (
        <div className={styles.section}>
          <div className={styles.sectionTitle}>🔍 K線型態識別</div>
          <div className={styles.patternList}>
            {patterns.map((p, i) => (
              <PatternBadge key={i} p={p} />
            ))}
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <div className={styles.disclaimer}>
        ⚠️ 以上買賣點為 AI 量化模型預測，基於今日技術數據。股市有風險，請結合基本面判斷並嚴守停損紀律。勿全倉操作。
      </div>
    </div>
  );
}
