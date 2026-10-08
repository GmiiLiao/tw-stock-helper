'use client';

import styles from './BuySellPanel.module.css';
import { getChangeColor } from '@/lib/twse-api';

// 2026-10-08（hardcoded-to-real-spec F16–F19、F24、F28、F29）：
//   達到率（固定 85／72／45／20、68／45／28）沒有依據 ⇒ 顯示「尚無校準結果」；風報與交易設定總覽改由同面板實際價格算；
//   型態強度 % 與動作提示不顯示；「推薦／首選」標籤刪除；停損統一標「參考停損（進場前）」（tw-ai-stoploss §2）。非投資建議。
const NO_CALIB = '達到率：尚無校準結果';
const NO_CALIB_HINT = '回測至此價的歷史比例表尚未發佈；舊版固定值（85／72／45／20）沒有依據，已移除。';
/** 賣點在現價上方、舊固定值也不同（68／45／28；scoring-server 舊版 TP1／TP2／TP3），不能沿用買點的提示 */
const NO_CALIB_HINT_TP = '漲至此價的歷史比例表尚未發佈；舊版固定值（68／45／28）沒有依據，已移除。';
const STOP_LABEL = '參考停損（進場前）';

/** 風報（至 TP1）＝(TP1 − 買點) ÷ (買點 − 停損)；買點不在停損與 TP1 之間時 null */
function rrToTp1(entry: number, tp1: number | null, stop: number): number | null {
  if (tp1 == null || !(entry > stop) || !(tp1 > entry)) return null;
  return (tp1 - entry) / (entry - stop);
}

// ─── Types (matches API) ─────────────────────────────────────

interface BuyZone {
  label: string;
  price: number;
  priceRange: [number, number];
  rationale: string;
  pattern: string;
  probability: number | null;   // 2026-10-08 起為 null（未校準，不顯示）
  riskReward: number;
  type: 'aggressive' | 'standard' | 'conservative' | 'dip';
}

interface SellTarget {
  label: string;
  price: number;
  gainPercent: number;
  rationale: string;
  type: 'tp1' | 'tp2' | 'tp3' | 'trailing';
  probability: number | null;   // 2026-10-08 起為 null（未校準，不顯示）
  holdDays: string;
}

interface PatternSignal {
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  strength: number;
  description: string;
  actionHint: string;
}

// API 的 tradeSetup 仍帶常數欄位（最大虧損／預期獲利／部位建議／進場時機，L11 server 端一致化）；本元件只讀規則分類與持有週期
interface TradeSetup {
  style: '短線' | '波段' | '存股';
  holdPeriod: string;
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
              🚫 {STOP_LABEL}
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
      </div>
      <p className={styles.patternDesc}>{p.description}</p>
    </div>
  );
}

// ─── Trade Setup Summary ─────────────────────────────────────

function TradeSetupCard({ setup, currentPrice, stopLoss, buyZones, sellTargets }: {
  setup: TradeSetup; currentPrice: number; stopLoss: number; buyZones: BuyZone[]; sellTargets: SellTarget[];
}) {
  const styleColors: Record<string, { color: string; bg: string }> = {
    '短線': { color: '#f03e3e', bg: 'rgba(240,62,62,0.1)' },
    '波段': { color: '#3d8ef8', bg: 'rgba(61,142,248,0.1)' },
    '存股': { color: '#2f9e44', bg: 'rgba(47,158,68,0.1)' },
  };
  const sc = styleColors[setup.style] ?? { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)' };
  // 全部由同一面板實際顯示的價格算（舊版是 5／7／8% 常數與 TP1 常數漲幅，深度版停損／停利改了也不跟著變）
  const tp1 = sellTargets.find(t => t.type === 'tp1')?.price ?? null;
  const std = buyZones.find(z => z.type === 'standard')?.price ?? null;
  const stopDist = currentPrice > 0 && stopLoss > 0 && stopLoss < currentPrice ? ((currentPrice - stopLoss) / currentPrice) * 100 : null;
  const tp1Dist = tp1 != null && currentPrice > 0 && tp1 > currentPrice ? ((tp1 - currentPrice) / currentPrice) * 100 : null;
  const rr = std != null ? rrToTp1(std, tp1, stopLoss) : null;

  return (
    <div className={styles.setupCard}>
      <div className={styles.setupHeader}>
        <span className={styles.setupStyle} style={{ background: sc.bg, color: sc.color }}>
          {setup.style}（規則分類）
        </span>
        <div className={styles.setupRR}>
          <span style={{ color: '#94a3b8', fontSize: 'calc(12.5px * var(--fz))' }}>風報比（標準買點進場）</span>
          <span style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: 'calc(1.1rem * var(--fz))', fontFamily: 'JetBrains Mono, monospace' }}>
            {rr != null ? `1:${rr.toFixed(1)}` : '—'}
          </span>
        </div>
      </div>

      <div className={styles.setupGrid}>
        <div className={styles.setupItem}>
          <div className={styles.setupItemLabel}>停損距現價</div>
          <div className={styles.setupItemValue} style={{ color: 'var(--text-secondary)' }}>{stopDist != null ? `-${stopDist.toFixed(1)}%` : '—'}</div>
        </div>
        <div className={styles.setupItem}>
          <div className={styles.setupItemLabel}>TP1 距現價</div>
          <div className={styles.setupItemValue} style={{ color: 'var(--text-secondary)', fontSize: tp1Dist != null ? undefined : 'calc(12.5px * var(--fz))' }}>
            {tp1Dist != null ? `+${tp1Dist.toFixed(1)}%` : tp1 != null ? 'TP1 低於現價（以回測買點為前提）' : '—'}
          </div>
        </div>
        <div className={styles.setupItem}>
          <div className={styles.setupItemLabel}>持有週期（規則設定）</div>
          <div className={styles.setupItemValue} style={{ fontSize: 'calc(12.5px * var(--fz))' }}>{setup.holdPeriod}</div>
        </div>
      </div>
      <div className={styles.entryTimingBox}>
        <div className={styles.entryTimingText}>
          以同面板的{STOP_LABEL} {stopLoss > 0 ? stopLoss.toFixed(2) : '—'}、標準買點 {std != null ? std.toFixed(2) : '—'}、TP1 {tp1 != null ? tp1.toFixed(2) : '—'} 計算；本卡不提供倉位比例，固定風險法的部位試算見個股頁「訊號分析」。
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────

export default function BuySellPanel(props: BuySellPanelProps) {
  const { currentPrice, buyZones, sellTargets, stopLoss, stopLossRationale, patterns, tradeSetup, high, low, open } = props;
  const tp1Price = sellTargets.find(t => t.type === 'tp1')?.price ?? null;

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
        <TradeSetupCard setup={tradeSetup} currentPrice={currentPrice} stopLoss={stopLoss} buyZones={buyZones} sellTargets={sellTargets} />
      </div>

      {/* Section 2: Two-column Buy & Sell */}
      <div className={styles.twoCol}>
        {/* Buy Zones */}
        <div className={styles.buySection}>
          <div className={styles.colHeader} style={{ color: '#f03e3e' }}>
            <span>🔴 買點分析</span>
            <span className={styles.colSubtitle}>規則試算</span>
          </div>
          <div className={styles.zoneList}>
            {buyZones.map(zone => {
              const cfg = buyTypeConfig[zone.type];
              const rr = rrToTp1(zone.price, tp1Price, stopLoss);
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
                    </div>
                    <div className={styles.zonePrice} style={{ color: cfg.color }}>
                      {zone.price.toFixed(2)}
                    </div>
                  </div>
                  <div className={styles.zoneRange}>
                    區間：{zone.priceRange[0].toFixed(2)} ~ {zone.priceRange[1].toFixed(2)}
                  </div>
                  <div className={styles.zoneMiniStats}>
                    <span>{zone.pattern}</span>
                    <span title={NO_CALIB_HINT}>{NO_CALIB}</span>
                    <span title="以此買點進場、TP1 停利、面板停損計算">
                      {rr != null ? `風報（至 TP1）1:${rr.toFixed(1)}` : '風報：—（此買點不在停損與 TP1 之間）'}
                    </span>
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
            <span className={styles.colSubtitle}>規則試算</span>
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
                    </div>
                    {!isTrailing && (
                      <div className={styles.zonePrice} style={{ color: '#2f9e44' }}>
                        {target.price.toFixed(2)}
                      </div>
                    )}
                  </div>
                  <div className={styles.zoneMiniStats}>
                    {!isTrailing && <span className={styles.gainChip} title="以標準買點為基準（交易設定總覽的「TP1 距現價」以現價為基準）">較標準買點 +{target.gainPercent}%</span>}
                    {!isTrailing && <span title={NO_CALIB_HINT_TP}>{NO_CALIB}</span>}
                    <span>持有（規則設定）：{target.holdDays}</span>
                  </div>
                  <div className={styles.zoneRationale}>{target.rationale}</div>
                </div>
              );
            })}
          </div>

          {/* Stop Loss Card */}
          <div className={styles.stopLossCard}>
            <div className={styles.slHeader}>
              <span className={styles.slLabel}>🚫 {STOP_LABEL}</span>
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
        ⚠️ 以上買賣點為規則試算（固定倍數，或均線支撐＋ATR 停損＋R 倍數停利），不是預測；達到率尚無校準結果。非投資建議。
      </div>
    </div>
  );
}
