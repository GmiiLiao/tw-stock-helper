'use client';

import type { TradingSignal, StockInfo, CandleData } from '@/lib/twse-api';
import { calculateRSI, calculateSMA, calculateKD, calculateMACD } from '@/lib/twse-api';
import { useMemo } from 'react';
import styles from './SignalPanel.module.css';

interface Props {
  signal: TradingSignal;
  stock: StockInfo;
  candles: CandleData[];
}

export default function SignalPanel({ signal, stock, candles }: Props) {
  const indicators = useMemo(() => {
    if (candles.length < 26) return null;
    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const n = closes.length - 1;

    const ma5 = calculateSMA(closes, 5)[n];
    const ma20 = calculateSMA(closes, 20)[n];
    const ma60 = calculateSMA(closes, 60)[n];
    const rsi = calculateRSI(closes)[n];
    const { k, d } = calculateKD(highs, lows, closes);
    const { macd, signal: sig } = calculateMACD(closes);

    return {
      ma5, ma20, ma60, rsi,
      k: k[n], d: d[n],
      macd: macd[n], macdSignal: sig[n],
      price: closes[n],
    };
  }, [candles]);

  const signalConfig = {
    BUY: { label: '買進訊號', emoji: '🟢', color: 'var(--color-up)', bg: 'var(--color-up-bg)', desc: '多項技術指標共振向上，建議考慮買進機會。請結合基本面與籌碼面確認後再行動。' },
    SELL: { label: '賣出警示', emoji: '🔴', color: 'var(--color-down)', bg: 'var(--color-down-bg)', desc: '技術指標出現空頭訊號，建議注意風險並考慮設置停損。' },
    WATCH: { label: '持續觀察', emoji: '🟡', color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', desc: '技術指標偏多但力道不足，建議持續觀察等待確認訊號。' },
    NEUTRAL: { label: '中性整理', emoji: '⚪', color: 'var(--text-muted)', bg: 'rgba(100,116,139,0.1)', desc: '技術指標無明確方向，建議等待趨勢明確後再行動。' },
  };

  const cfg = signalConfig[signal.type];

  const stopLoss = stock.price * 0.92; // 8% stop loss
  const target1 = stock.price * 1.10; // 10% target
  const target2 = stock.price * 1.20; // 20% target

  const indicatorRows = [
    { label: 'MA5', value: indicators?.ma5?.toFixed(2) ?? '--', state: indicators && indicators.price > (indicators.ma5 ?? 0) ? 'bull' : 'bear' },
    { label: 'MA20', value: indicators?.ma20?.toFixed(2) ?? '--', state: indicators && indicators.price > (indicators.ma20 ?? 0) ? 'bull' : 'bear' },
    { label: 'MA60', value: indicators?.ma60?.toFixed(2) ?? '--', state: indicators && indicators.price > (indicators.ma60 ?? 0) ? 'bull' : 'bear' },
    { label: 'RSI', value: indicators?.rsi?.toFixed(1) ?? '--', state: indicators?.rsi != null && indicators.rsi > 50 && indicators.rsi < 80 ? 'bull' : indicators?.rsi != null && indicators.rsi > 80 ? 'overbought' : 'bear' },
    { label: 'K值', value: indicators?.k?.toFixed(1) ?? '--', state: indicators && (indicators.k ?? 0) > (indicators.d ?? 0) && (indicators.k ?? 0) < 80 ? 'bull' : 'neutral' },
    { label: 'D值', value: indicators?.d?.toFixed(1) ?? '--', state: 'neutral' },
    { label: 'MACD', value: indicators?.macd?.toFixed(4) ?? '--', state: indicators && (indicators.macd ?? 0) > (indicators.macdSignal ?? 0) ? 'bull' : 'bear' },
    { label: 'Signal', value: indicators?.macdSignal?.toFixed(4) ?? '--', state: 'neutral' },
  ];

  const stateLabel = (s: string) => {
    if (s === 'bull') return { text: '多', color: 'var(--color-up)' };
    if (s === 'bear') return { text: '空', color: 'var(--color-down)' };
    if (s === 'overbought') return { text: '超買', color: '#f59e0b' };
    return { text: '中', color: 'var(--text-muted)' };
  };

  return (
    <div className={styles.panel}>
      {/* Signal Summary */}
      <div className={styles.signalCard} style={{ background: cfg.bg, borderColor: cfg.color }}>
        <div className={styles.signalTop}>
          <span className={styles.signalEmoji}>{cfg.emoji}</span>
          <div>
            <div className={styles.signalLabel} style={{ color: cfg.color }}>{cfg.label}</div>
            <div className={styles.signalDesc}>{cfg.desc}</div>
          </div>
          <div className={styles.signalStrength}>
            <div className={styles.strengthLabel}>訊號強度</div>
            <div className={styles.strengthValue} style={{ color: cfg.color }}>{signal.strength.toFixed(0)}%</div>
            <div className={styles.strengthBar}>
              <div className={styles.strengthFill} style={{ width: `${signal.strength}%`, background: cfg.color }} />
            </div>
          </div>
        </div>
      </div>

      {/* Two columns */}
      <div className={styles.grid2}>
        {/* Indicator status */}
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>📊 指標狀態</h3>
          <div className={styles.indicatorTable}>
            {indicatorRows.map(row => {
              const state = stateLabel(row.state);
              return (
                <div key={row.label} className={styles.indicatorRow}>
                  <span className={styles.indLabel}>{row.label}</span>
                  <span className={styles.indValue}>{row.value}</span>
                  <span className={styles.indState} style={{ color: state.color }}>{state.text}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Risk Management */}
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>🛡️ 風險管理建議</h3>
          <div className={styles.riskTable}>
            <div className={styles.riskRow}>
              <span className={styles.riskLabel}>現價</span>
              <span className={styles.riskValue}>{stock.price.toFixed(2)}</span>
            </div>
            <div className={styles.riskRow}>
              <span className={styles.riskLabel} style={{ color: 'var(--color-down)' }}>建議停損 (-8%)</span>
              <span className={styles.riskValue} style={{ color: 'var(--color-down)' }}>{stopLoss.toFixed(2)}</span>
            </div>
            <div className={styles.riskRow}>
              <span className={styles.riskLabel} style={{ color: 'var(--color-up)' }}>目標一 (+10%)</span>
              <span className={styles.riskValue} style={{ color: 'var(--color-up)' }}>{target1.toFixed(2)}</span>
            </div>
            <div className={styles.riskRow}>
              <span className={styles.riskLabel} style={{ color: 'var(--color-up)' }}>目標二 (+20%)</span>
              <span className={styles.riskValue} style={{ color: 'var(--color-up)' }}>{target2.toFixed(2)}</span>
            </div>
            <div className={styles.riskRow}>
              <span className={styles.riskLabel}>風險報酬比</span>
              <span className={styles.riskValue}>1 : 1.25</span>
            </div>
          </div>

          <div className={styles.disclaimer}>
            ⚠️ 以上為技術分析建議，非投資建議。實際操作請結合個人風險承受能力。
          </div>
        </div>
      </div>

      {/* Signal Reasons */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>📋 訊號依據</h3>
        <div className={styles.reasonsList}>
          {signal.reasons.map((r, i) => (
            <div key={i} className={styles.reasonItem}>{r}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
