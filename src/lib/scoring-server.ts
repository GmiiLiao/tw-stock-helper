// ============================================================
// Scoring Engine (server-only) — single source of truth
// Multi-factor scoring + Buy/Sell point prediction + risk overlay.
// Consumed by /api/twse/ai-recommend, /api/rating, and (indirectly,
// via /api/rating) the Screener. Do NOT duplicate this math client-side.
// Uses TWSE public STOCK_DAY_ALL data — no API key needed.
// ============================================================

import { gradeFromScore, targetPriceFromGrade, type Grade, type Signal } from './scoring';

export { gradeFromScore, targetPriceFromGrade };
export type { Grade, Signal };

// ─── Risk stock types ────────────────────────────────────────────
export interface RiskStockInfo {
  code: string;
  name: string;
  type: 'attention' | 'disposition';
  reason: string;
  measures?: string;
  startDate?: string;
  endDate?: string;
  source: 'TWSE' | 'TPEx';
}

export interface RiskStocksData {
  attention: RiskStockInfo[];
  disposition: RiskStockInfo[];
  allCodes: string[];
  attentionCodes: Set<string>;
  dispositionCodes: Set<string>;
  getInfo: (code: string) => RiskStockInfo | undefined;
}

export const EMPTY_RISK_DATA: RiskStocksData = {
  attention: [], disposition: [], allCodes: [],
  attentionCodes: new Set(), dispositionCodes: new Set(),
  getInfo: () => undefined,
};

// ─── Stock data types ────────────────────────────────────────────
export interface StockDayData {
  Code: string; Name: string;
  TradeVolume: string; TradeValue: string;
  OpeningPrice: string; HighestPrice: string;
  LowestPrice: string; ClosingPrice: string;
  Change: string; Transaction: string;
  Date?: string;
}

export interface ParsedStock {
  code: string; name: string;
  price: number; open: number; high: number; low: number; close: number;
  change: number; changePercent: number;
  volume: number; value: number; transactions: number;
  prevClose: number; range: number; closePosition: number;
}

export interface BuyZone {
  label: string;
  price: number;
  priceRange: [number, number];
  rationale: string;
  pattern: string;
  probability: number;
  riskReward: number;
  type: 'aggressive' | 'standard' | 'conservative' | 'dip';
}

export interface SellTarget {
  label: string;
  price: number;
  gainPercent: number;
  rationale: string;
  type: 'tp1' | 'tp2' | 'tp3' | 'trailing';
  probability: number;
  holdDays: string;
}

export interface PatternSignal {
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  strength: number;
  description: string;
  actionHint: string;
}

export interface ScoredStock {
  code: string; name: string;
  price: number; change: number; changePercent: number; volume: number;
  open: number; high: number; low: number;
  score: number;
  grade: Grade;
  strategy: 'momentum' | 'growth' | 'defensive' | 'value';
  reasons: string[];
  risks: string[];
  factors: { momentum: number; volume: number; stability: number; trend: number; value: number; };
  signal: Signal;
  confidence: number;

  buyZones: BuyZone[];
  sellTargets: SellTarget[];
  stopLoss: number;
  stopLossRationale: string;
  patterns: PatternSignal[];
  tradeSetup: TradeSetup;

  isAttention: boolean;
  isDisposition: boolean;
  riskLevel: 'high' | 'medium' | 'low';
  riskWarnings: Array<{
    type: 'attention' | 'disposition';
    label: string;
    reason: string;
    severity: 'critical' | 'warning';
    source: string;
    measures?: string;
    period?: string;
  }>;
}

export interface TradeSetup {
  style: '短線' | '波段' | '存股';
  entryTiming: string;
  maxRisk: number;
  expectedGain: number;
  holdPeriod: string;
  positionSizing: string;
  overallRiskReward: number;
}

/** Compact rating used by the Screener lookup table. */
export interface StockRating {
  code: string;
  score: number;
  grade: Grade;
  signal: Signal;
  targetPrice: number;
}

// ─── Parser ──────────────────────────────────────────────────

export function parseStock(d: StockDayData): ParsedStock {
  const close = parseFloat(d.ClosingPrice) || 0;
  const change = parseFloat(d.Change) || 0;
  const open = parseFloat(d.OpeningPrice) || close;
  const prevClose = close - change;
  const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
  const high = parseFloat(d.HighestPrice) || close;
  const low = parseFloat(d.LowestPrice) || close;
  const range = high - low;
  const closePosition = range > 0 ? (close - low) / range : 0.5;

  return {
    code: d.Code, name: d.Name,
    price: close, open, high, low, close,
    change, changePercent,
    prevClose,
    volume: parseInt(d.TradeVolume.replace(/,/g, '')) || 0,
    value: parseInt(d.TradeValue.replace(/,/g, '')) || 0,
    transactions: parseInt(d.Transaction?.replace(/,/g, '') || '0') || 0,
    range, closePosition,
  };
}

// ─── Pattern Recognition ─────────────────────────────────────

export function detectPatterns(s: ParsedStock): PatternSignal[] {
  const patterns: PatternSignal[] = [];
  const chg = s.changePercent;
  const range = s.range;
  const bodySize = Math.abs(s.close - s.open);
  const lowerWick = Math.min(s.close, s.open) - s.low;
  const bodyRatio = range > 0 ? bodySize / range : 0;
  const isGreen = s.close >= s.open; // Taiwan: close > open = up day

  // 1. 強勢長紅K
  if (isGreen && bodyRatio >= 0.7 && chg > 3) {
    patterns.push({
      name: '強勢長紅K',
      type: 'bullish',
      strength: Math.min(80 + bodyRatio * 20, 95),
      description: `實體佔比 ${(bodyRatio * 100).toFixed(0)}%，無上影線壓力，買盤完全主導`,
      actionHint: '今收盤價或次日小拉回即為良好買點',
    });
  }

  // 2. 跳空高開強收
  if (s.open > s.prevClose * 1.01 && s.closePosition >= 0.75 && chg > 0) {
    const gapPct = ((s.open / s.prevClose) - 1) * 100;
    patterns.push({
      name: '跳空高開強收',
      type: 'bullish',
      strength: 78,
      description: `跳空 ${gapPct.toFixed(1)}% 高開，且收盤守住漲幅，籌碼鎖定良好`,
      actionHint: '跳空缺口下緣為強支撐，可在此附近分批布局',
    });
  }

  // 3. 爆量漲停
  if (chg >= 9.9 && s.value > 500_000_000) {
    patterns.push({
      name: '爆量漲停板',
      type: 'bullish',
      strength: 90,
      description: `今日漲停，成交值 ${(s.value / 1e8).toFixed(1)} 億，主力強力護盤`,
      actionHint: '漲停次日開盤 ±2% 為追蹤觀察點，確認守住再加碼',
    });
  }

  // 4. 量縮近漲停
  if (chg >= 7 && chg < 9.9 && s.closePosition >= 0.8) {
    patterns.push({
      name: '強攻接近漲停',
      type: 'bullish',
      strength: 75,
      description: `漲幅 ${chg.toFixed(1)}%，收在日高，明日有機會挑戰漲停`,
      actionHint: '若次日量能持續放大，可小量追進',
    });
  }

  // 5. 小量整理
  if (Math.abs(chg) < 1 && s.value < 200_000_000 && s.value > 50_000_000) {
    patterns.push({
      name: '量縮整理蓄勢',
      type: 'neutral',
      strength: 55,
      description: '成交量明顯縮減，價格窄幅整理，通常為下一波突破前的蓄積',
      actionHint: '等待放量突破前高再介入，避免過早進場',
    });
  }

  // 6. 長下影線
  if (lowerWick > bodySize * 2 && lowerWick > range * 0.4 && chg >= 0) {
    patterns.push({
      name: '下影支撐買盤強',
      type: 'bullish',
      strength: 70,
      description: `長下影線（佔日線 ${(lowerWick / range * 100).toFixed(0)}%），低點有強力承接`,
      actionHint: '下影線低點為短期重要支撐，可在此附近設定買點',
    });
  }

  // 7. 高開低走
  if (s.open > s.prevClose * 1.02 && s.closePosition < 0.4 && isGreen) {
    patterns.push({
      name: '高開低走警示',
      type: 'bearish',
      strength: 65,
      description: '高開後未能守住漲幅，賣壓較重，短期需要整理',
      actionHint: '建議等待量能縮減、止跌企穩後再考慮進場',
    });
  }

  // 8. 法人資金型態
  if (s.value > 2_000_000_000 && chg > 1 && s.closePosition > 0.6) {
    patterns.push({
      name: '法人資金推升',
      type: 'bullish',
      strength: 82,
      description: `成交值達 ${(s.value / 1e8).toFixed(0)} 億，大資金持續流入，法人認同度高`,
      actionHint: '法人買盤結構穩定，可採波段持有策略',
    });
  }

  return patterns.slice(0, 3); // Max 3 patterns
}

// ─── Buy Zone Calculator ──────────────────────────────────────

export function calculateBuyZones(s: ParsedStock, patterns: PatternSignal[]): BuyZone[] {
  const p = s.price;
  const h = s.high;
  const l = s.low;
  const range = h - l;
  const chg = s.changePercent;
  const hasBullishPattern = patterns.some(pt => pt.type === 'bullish');

  const zones: BuyZone[] = [];

  // ── Zone 1: 積極追買 ──
  if (chg > 5 && s.closePosition > 0.8) {
    const entry = p;
    const entryMax = p * 1.012;
    zones.push({
      label: '積極追買',
      price: parseFloat(entry.toFixed(2)),
      priceRange: [parseFloat(entry.toFixed(2)), parseFloat(entryMax.toFixed(2))],
      rationale: `強勢突破型，收在日高附近，趨勢確立中，當日收盤附近可積極介入`,
      pattern: '強勢突破跟進',
      probability: 85,
      riskReward: parseFloat(((chg * 1.5) / 7).toFixed(1)),
      type: 'aggressive',
    });
  }

  // ── Zone 2: 標準買點 ──
  const stdEntry = p * (chg > 3 ? 0.978 : 0.983);
  const stdEntryMax = p * (chg > 3 ? 0.990 : 0.994);
  zones.push({
    label: '標準買點',
    price: parseFloat(stdEntry.toFixed(2)),
    priceRange: [parseFloat(stdEntry.toFixed(2)), parseFloat(stdEntryMax.toFixed(2))],
    rationale: chg > 3
      ? `等待強勢股次日小幅回測，約 ${(p - stdEntry).toFixed(2)} 元的正常整理回拉，風險控制更佳`
      : `溫和上漲型，小回測至今日均價附近即可進場`,
    pattern: chg > 3 ? '強勢回測買點' : '均價附近布局',
    probability: 72,
    riskReward: 2.0,
    type: 'standard',
  });

  // ── Zone 3: 保守買點 ──
  const conservativeRef = Math.max(s.open, l + range * 0.35);
  const conservEntry = Math.min(conservativeRef, p * 0.955);
  const conservEntryMax = conservEntry * 1.015;
  zones.push({
    label: '保守買點',
    price: parseFloat(conservEntry.toFixed(2)),
    priceRange: [parseFloat(conservEntry.toFixed(2)), parseFloat(conservEntryMax.toFixed(2))],
    rationale: `較深回調至今日開盤附近或均線支撐區，適合風險承受度低的投資人，確認守住再進場`,
    pattern: '開盤支撐區買進',
    probability: 45,
    riskReward: 2.8,
    type: 'conservative',
  });

  // ── Zone 4: 逢低佈局 ──
  if (hasBullishPattern && s.value > 500_000_000) {
    const dipEntry = p * 0.930;
    const dipEntryMax = p * 0.945;
    zones.push({
      label: '逢低佈局',
      price: parseFloat(dipEntry.toFixed(2)),
      priceRange: [parseFloat(dipEntry.toFixed(2)), parseFloat(dipEntryMax.toFixed(2))],
      rationale: `若股價因市場系統性回落至此區，代表主力明顯洗盤，可視為絕佳長期進場機會`,
      pattern: '主力洗盤吸籌',
      probability: 20,
      riskReward: 4.5,
      type: 'dip',
    });
  }

  return zones;
}

// ─── Sell Target Calculator ───────────────────────────────────

export function calculateSellTargets(s: ParsedStock, buyZones: BuyZone[]): SellTarget[] {
  const standardBuy = buyZones.find(z => z.type === 'standard')?.price || s.price;
  const chg = s.changePercent;
  const targets: SellTarget[] = [];

  // ── Target 1: 短線獲利 ──
  const tp1Gain = chg > 5 ? 5 : 8;
  const tp1 = parseFloat((standardBuy * (1 + tp1Gain / 100)).toFixed(2));
  targets.push({
    label: `第一目標 TP1`,
    price: tp1,
    gainPercent: tp1Gain,
    rationale: `短線技術面目標，預計達到前高或整數關卡附近，可先出 30-50% 部位`,
    type: 'tp1',
    probability: 68,
    holdDays: '3~7 個交易日',
  });

  // ── Target 2: 波段目標 ──
  const tp2Gain = chg > 7 ? 10 : (chg > 3 ? 15 : 18);
  const tp2 = parseFloat((standardBuy * (1 + tp2Gain / 100)).toFixed(2));
  targets.push({
    label: `第二目標 TP2`,
    price: tp2,
    gainPercent: tp2Gain,
    rationale: `波段主升段目標，通常對應前波高點或技術壓力區，建議此處再出 30-40%`,
    type: 'tp2',
    probability: 45,
    holdDays: '2~4 週',
  });

  // ── Target 3: 強波目標 ──
  if (s.value > 1_000_000_000 || chg > 7) {
    const tp3Gain = 25;
    const tp3 = parseFloat((standardBuy * (1 + tp3Gain / 100)).toFixed(2));
    targets.push({
      label: `強波目標 TP3`,
      price: tp3,
      gainPercent: tp3Gain,
      rationale: `主升趨勢目標，法人資金持續護盤且基本面支撐下，有機會達到的波段高點`,
      type: 'tp3',
      probability: 28,
      holdDays: '1~3 個月',
    });
  }

  // ── Trailing Stop ──
  targets.push({
    label: '移動停利建議',
    price: parseFloat((standardBuy * 1.05).toFixed(2)),
    gainPercent: 5,
    rationale: `達到 5% 獲利後，可將停損調整至成本+2%（保本），並每漲 3% 向上移動停損點`,
    type: 'trailing',
    probability: 0,
    holdDays: '彈性',
  });

  return targets;
}

// ─── Stop Loss Calculator ─────────────────────────────────────

// 無歷史庫時的停損：用「今日真實波幅(含跳空)」當作 1 日 ATR 代理，使停損仍依
// 個股當日波動調整(優於純固定%)。有歷史的個股走 analysis-enrich 的 14 日 ATR 停損。
export function calculateStopLoss(s: ParsedStock): { price: number; rationale: string } {
  const p = s.price;
  if (!(p > 0)) return { price: 0, rationale: '無有效報價' };
  const prevClose = p - s.change;
  // True Range = max(高−低, |高−昨收|, |低−昨收|)
  const tr = Math.max(
    (s.high || p) - (s.low || p),
    Math.abs((s.high || p) - prevClose),
    Math.abs((s.low || p) - prevClose),
  ) || p * 0.03;
  // 停損 = 今日低點下方 0.5×TR（跌破當日低 + 半個波幅緩衝），風控夾 −3%~−15%。
  const raw = (s.low || p) - 0.5 * tr;
  const stop = Math.min(Math.max(raw, p * 0.85), p * 0.97);
  const lossPct = ((stop - p) / p) * 100;
  return {
    price: parseFloat(stop.toFixed(2)),
    rationale: `波動率停損(無歷史庫，用今日真實波幅 ${tr.toFixed(2)} 為 1 日 ATR 代理)：設於今日低點 ${(s.low || p).toFixed(2)} 下方約 0.5×波幅，風險 ${lossPct.toFixed(1)}%（依當日波動調整）。`,
  };
}

// ─── Trade Setup ──────────────────────────────────────────────

export function buildTradeSetup(s: ParsedStock, _buyZones: BuyZone[], sellTargets: SellTarget[]): TradeSetup {
  const chg = s.changePercent;
  const val = s.value;

  const tp1 = sellTargets.find(t => t.type === 'tp1');
  const stopPct = chg > 7 ? 5 : chg > 3 ? 7 : 8;
  const gainPct = tp1?.gainPercent || 8;

  let style: '短線' | '波段' | '存股' = '波段';
  if (chg > 7 || val < 500_000_000) style = '短線';
  else if (val > 3_000_000_000 && chg < 5) style = '存股';

  const rr = parseFloat((gainPct / stopPct).toFixed(2));

  let entryTiming = '';
  if (chg > 7) entryTiming = '次日開盤後觀察15分鐘，若高開低走則不追，若持平或小漲可分批介入';
  else if (chg > 3) entryTiming = '次日回測當日均量支撐線（今日最低價附近）時可分批買進';
  else entryTiming = '今日收盤前30分鐘若持續守穩則可試單，或次日低開後反彈確認時進場';

  return {
    style,
    entryTiming,
    maxRisk: stopPct,
    expectedGain: gainPct,
    holdPeriod: style === '短線' ? '3~10 個交易日' : style === '波段' ? '2~6 週' : '3 個月以上',
    positionSizing: rr >= 2 ? '建議配置 10-15% 倉位' : rr >= 1.5 ? '建議配置 8-12% 倉位' : '建議輕倉 5-8% 試探',
    overallRiskReward: rr,
  };
}

// ─── Main Scorer ──────────────────────────────────────────────

export function scoreStock(s: ParsedStock, _mode: string, riskData: RiskStocksData): ScoredStock {
  const reasons: string[] = [];
  const risks: string[] = [];
  let score = 0;
  const chg = s.changePercent;
  const val = s.value;

  // ─── Risk check: 注意/處置股票 ──────────────────────────
  const isAttention = riskData.attentionCodes.has(s.code);
  const isDisposition = riskData.dispositionCodes.has(s.code);
  const riskWarnings: ScoredStock['riskWarnings'] = [];

  if (isDisposition) {
    const info = riskData.disposition.find(d => d.code === s.code);
    riskWarnings.push({
      type: 'disposition',
      label: '🔴 處置股票',
      reason: info?.reason || '已被列為處置股票',
      severity: 'critical',
      source: info?.source || 'TWSE',
      measures: info?.measures,
      period: info?.startDate && info?.endDate ? `${info.startDate} ~ ${info.endDate}` : undefined,
    });
    risks.push(`🔴 處置股票：${info?.reason || '交易受限，需預收款券'}`);
    if (info?.measures) risks.push(`📋 處置措施：${info.measures}`);
  }

  if (isAttention) {
    const info = riskData.attention.find(a => a.code === s.code);
    riskWarnings.push({
      type: 'attention',
      label: '🟡 注意股票',
      reason: info?.reason || '已被列為注意股票',
      severity: 'warning',
      source: info?.source || 'TWSE',
    });
    risks.push(`🟡 注意股票：${info?.reason || '交易異常，已列入注意'}`);
  }

  // Factor 1: Momentum (20)
  let momentumScore = 0;
  if (chg > 7)       { momentumScore = 20; reasons.push(`🔴 今日大漲 ${chg.toFixed(2)}%，強勢突破`); }
  else if (chg > 4)  { momentumScore = 17; reasons.push(`🔴 今日漲幅 ${chg.toFixed(2)}%，量能充沛`); }
  else if (chg > 2)  { momentumScore = 14; reasons.push(`📈 今日上漲 ${chg.toFixed(2)}%，走勢偏強`); }
  else if (chg > 0)  { momentumScore = 10; reasons.push(`📊 今日小漲 ${chg.toFixed(2)}%，溫和向上`); }
  else if (chg === 0){ momentumScore = 6; }
  else if (chg > -2) { momentumScore = 4;  risks.push(`⚠️ 今日小跌 ${Math.abs(chg).toFixed(2)}%`); }
  else               { momentumScore = 0;  risks.push(`🟢 今日下跌 ${Math.abs(chg).toFixed(2)}%，注意支撐`); }

  // Factor 2: Volume (20)
  let volumeScore = 0;
  if (val > 5_000_000_000)      { volumeScore = 20; reasons.push('💰 成交值超過 50億，主力大量介入'); }
  else if (val > 1_000_000_000) { volumeScore = 17; reasons.push('💰 成交值超過 10億，法人資金關注'); }
  else if (val > 500_000_000)   { volumeScore = 14; reasons.push('📦 成交值超過 5億，流動性良好'); }
  else if (val > 100_000_000)   { volumeScore = 10; reasons.push('📦 成交值 1-5億，中等流動性'); }
  else if (val > 50_000_000)    { volumeScore = 6; }
  else                          { volumeScore = 2;  risks.push('⚠️ 成交量偏低，流動性需注意'); }

  if (chg > 1 && val > 500_000_000) {
    volumeScore = Math.min(volumeScore + 3, 20);
    reasons.push('✅ 量增價漲，多頭確認訊號');
  }

  // Factor 3: Intraday Position (20)
  let trendScore = 0;
  const cp = s.closePosition;
  if (cp >= 0.85)      { trendScore = 20; reasons.push('💪 收在日高附近，上影線短，買盤強勁'); }
  else if (cp >= 0.70) { trendScore = 16; reasons.push('📈 收在日線上半段，多方佔優'); }
  else if (cp >= 0.50) { trendScore = 12; }
  else if (cp >= 0.30) { trendScore = 7;  risks.push('⚠️ 收在日線下半段，賣壓較重'); }
  else                 { trendScore = 3;  risks.push('🟢 收在日低附近，今日賣壓明顯'); }

  if (s.open > s.prevClose * 1.005 && chg > 1) {
    trendScore = Math.min(trendScore + 2, 20);
    reasons.push('⬆️ 今日高開，開盤即強');
  }

  // Factor 4: Stability (20)
  let stabilityScore = 0;
  if (s.price >= 500)      { stabilityScore = 18; reasons.push('💎 高價股，法人持股比例通常較高'); }
  else if (s.price >= 100) { stabilityScore = 16; reasons.push('🏢 中高價股，股性穩健'); }
  else if (s.price >= 30)  { stabilityScore = 14; }
  else if (s.price >= 10)  { stabilityScore = 10; }
  else                     { stabilityScore = 6;  risks.push('⚠️ 低價股，波動可能較大'); }

  if (s.transactions > 50000) {
    stabilityScore = Math.min(stabilityScore + 2, 20);
    reasons.push('🔄 成交筆數多，籌碼分散度高');
  }

  // Factor 5: Value/Pattern (20)
  let valueScore = 12;
  const isLimitUp   = chg >= 9.9;
  const isNearLimit = chg >= 7 && chg < 9.9;
  const isLimitDown = chg <= -9.9;

  if (isLimitUp)        { valueScore = 15; reasons.push('🔴 觸及漲停板，籌碼高度鎖定'); }
  else if (isNearLimit) { valueScore = 18; reasons.push('🔴 接近漲停，動能強勁'); }
  else if (isLimitDown) { valueScore = 0;  risks.push('🟢 觸及跌停，短期避開'); }
  else if (chg > 0 && chg < 5) { valueScore = 15; reasons.push('⚖️ 漲幅溫和，非追高風險操作'); }

  score = momentumScore + volumeScore + trendScore + stabilityScore + valueScore;

  // ─── Apply Risk Penalties ───────────────────────────────
  if (isDisposition) {
    score = Math.max(score - 40, 0);
    reasons.length > 2 && reasons.splice(2);
  } else if (isAttention) {
    score = Math.max(score - 20, 0);
  }

  // Risk level
  let riskLevel: 'high' | 'medium' | 'low' = 'low';
  if (isDisposition) riskLevel = 'high';
  else if (isAttention) riskLevel = 'medium';
  else if (risks.length >= 3) riskLevel = 'medium';

  // Strategy classification
  let strategy: ScoredStock['strategy'] = 'momentum';
  if (chg > 0 && val > 1_000_000_000 && cp > 0.7)           strategy = 'growth';
  else if (chg >= 0 && chg < 3 && val > 500_000_000)         strategy = 'defensive';
  else if (s.price < 50 && chg > 2)                           strategy = 'value';

  // Grade & signal share thresholds with rateStock() below — keep in sync.
  const grade = gradeFromScore(score);

  let signal: Signal = 'NEUTRAL';
  if (isDisposition) {
    signal = 'NEUTRAL';
  } else if (score >= 80 && chg > 0) {
    signal = isAttention ? 'WATCH' : 'STRONG_BUY';
  } else if (score >= 65 && chg > 0) {
    signal = isAttention ? 'WATCH' : 'BUY';
  } else if (score >= 55) {
    signal = 'WATCH';
  }

  // Confidence
  const fa = [momentumScore > 12, volumeScore > 12, trendScore > 12, stabilityScore > 12].filter(Boolean).length;
  let confidence = parseFloat(Math.min(50 + fa * 12 + (score - 50) * 0.5, 95).toFixed(1));
  if (isDisposition) confidence = Math.min(confidence * 0.5, 30);
  else if (isAttention) confidence = Math.min(confidence * 0.75, 60);

  // ─── Buy/Sell Predictions ──────────────────────────────
  const patterns    = detectPatterns(s);
  const buyZones    = calculateBuyZones(s, patterns);
  const sellTargets = calculateSellTargets(s, buyZones);
  const sl          = calculateStopLoss(s);
  const tradeSetup  = buildTradeSetup(s, buyZones, sellTargets);

  return {
    code: s.code, name: s.name,
    price: s.price, change: s.change, changePercent: s.changePercent, volume: s.volume,
    open: s.open, high: s.high, low: s.low,
    score, grade, strategy,
    reasons: reasons.slice(0, 5),
    risks: risks.slice(0, 5),
    factors: { momentum: momentumScore, volume: volumeScore, stability: stabilityScore, trend: trendScore, value: valueScore },
    signal, confidence,
    buyZones,
    sellTargets,
    stopLoss: sl.price,
    stopLossRationale: sl.rationale,
    patterns,
    tradeSetup,
    isAttention,
    isDisposition,
    riskLevel,
    riskWarnings,
  };
}

/** Compact rating (score/grade/signal/targetPrice) — for the Screener lookup table. */
export function rateStock(s: ParsedStock, riskData: RiskStocksData): StockRating {
  const full = scoreStock(s, 'daily', riskData);
  return {
    code: s.code,
    score: full.score,
    grade: full.grade,
    signal: full.signal,
    targetPrice: targetPriceFromGrade(full.grade, s.price),
  };
}

// ─── Risk Stocks Fetcher (server-only, cached) ────────────────

let cachedRiskData: RiskStocksData | null = null;
let riskCachedAt = 0;
const RISK_CACHE_TTL = 5 * 60 * 1000;

export async function fetchRiskStocks(): Promise<RiskStocksData> {
  if (cachedRiskData && Date.now() - riskCachedAt < RISK_CACHE_TTL) {
    return cachedRiskData;
  }

  try {
    const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' };

    const [twseAttRes, twseDispRes, tpexAttRes, tpexDispRes] = await Promise.allSettled([
      fetchJSON('https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL', UA),
      fetchJSON('https://openapi.twse.com.tw/v1/opendata/t187ap10_L', UA),
      fetchJSON('https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information', UA),
      fetchJSON('https://www.tpex.org.tw/openapi/v1/tpex_disposal_information', UA),
    ]);

    const attention: RiskStockInfo[] = [];
    const disposition: RiskStockInfo[] = [];

    if (twseAttRes.status === 'fulfilled' && Array.isArray(twseAttRes.value)) {
      for (const item of twseAttRes.value) {
        const code = (item['證券代號'] || item['Code'] || '').trim();
        if (code && /^\d{4,5}$/.test(code)) {
          attention.push({
            code, name: (item['證券名稱'] || item['Name'] || '').trim(),
            type: 'attention', source: 'TWSE',
            reason: (item['注意交易資訊'] || item['Reason'] || '列為注意股票').trim().slice(0, 200),
          });
        }
      }
    }

    if (twseDispRes.status === 'fulfilled' && Array.isArray(twseDispRes.value)) {
      for (const item of twseDispRes.value) {
        const code = (item['公司代號'] || item['證券代號'] || item['Code'] || '').trim();
        if (code && /^\d{4,5}$/.test(code)) {
          disposition.push({
            code, name: (item['公司名稱'] || item['證券名稱'] || '').trim(),
            type: 'disposition', source: 'TWSE',
            reason: (item['處置原因'] || item['事由'] || item['處置措施'] || '列為處置股票').trim().slice(0, 200),
            measures: (item['處置措施'] || item['Measures'] || '').trim(),
            startDate: item['處置開始日期'] || item['處分期間起日'] || '',
            endDate: item['處置結束日期'] || item['處分期間迄日'] || '',
          });
        }
      }
    }

    if (tpexAttRes.status === 'fulfilled' && Array.isArray(tpexAttRes.value)) {
      for (const item of tpexAttRes.value) {
        const code = (item['SecuritiesCompanyCode'] || item['證券代號'] || '').trim();
        if (code && /^\d{4,5}$/.test(code) && !attention.some(a => a.code === code)) {
          attention.push({
            code, name: (item['CompanyName'] || item['公司名稱'] || '').trim(),
            type: 'attention', source: 'TPEx',
            reason: (item['Reason'] || item['注意事項'] || '列為注意股票').trim().slice(0, 200),
          });
        }
      }
    }

    if (tpexDispRes.status === 'fulfilled' && Array.isArray(tpexDispRes.value)) {
      for (const item of tpexDispRes.value) {
        const code = (item['SecuritiesCompanyCode'] || item['證券代號'] || '').trim();
        if (code && /^\d{4,5}$/.test(code) && !disposition.some(d => d.code === code)) {
          disposition.push({
            code, name: (item['CompanyName'] || item['公司名稱'] || '').trim(),
            type: 'disposition', source: 'TPEx',
            reason: (item['Reason'] || item['事由'] || '列為處置股票').trim().slice(0, 200),
            measures: (item['DisposalMeasures'] || item['處置措施'] || '').trim(),
            startDate: item['StartDate'] || '',
            endDate: item['EndDate'] || '',
          });
        }
      }
    }

    const attentionCodes = new Set(attention.map(a => a.code));
    const dispositionCodes = new Set(disposition.map(d => d.code));
    const allCodes = [...new Set([...attentionCodes, ...dispositionCodes])];

    const result: RiskStocksData = {
      attention, disposition, allCodes, attentionCodes, dispositionCodes,
      getInfo: (code: string) => disposition.find(d => d.code === code) || attention.find(a => a.code === code),
    };

    cachedRiskData = result;
    riskCachedAt = Date.now();
    return result;

  } catch (e) {
    console.error('[scoring-server] Risk stocks fetch error:', e);
    // 負快取 (2026-07-30)：原本失敗時不寫快取，導致上游異常時
    // 每一個 request 都重打 4 個 openapi/tpex 端點，5 分鐘 TTL 完全失效。
    // 記錄 30 秒的冷卻；有舊資料就繼續供應舊的，沒有才回空。
    const fallback = cachedRiskData ?? EMPTY_RISK_DATA;
    cachedRiskData = fallback;
    riskCachedAt = Date.now() - (RISK_CACHE_TTL - 30 * 1000);
    return fallback;
  }
}

async function fetchJSON(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal, cache: 'no-store' });
    clearTimeout(tid);
    return res.ok ? await res.json() : null;
  } catch {
    clearTimeout(tid);
    return null;
  }
}

/** Shared filter: regular 4-digit stocks with valid price/volume. */
export function isRegularStock(d: StockDayData): boolean {
  return Boolean(
    d.ClosingPrice && d.TradeVolume &&
    parseFloat(d.ClosingPrice) > 0 &&
    parseInt(d.TradeVolume.replace(/,/g, '')) > 0 &&
    /^\d{4}$/.test(d.Code) &&
    !['00', '01'].some(prefix => d.Code.startsWith(prefix))
  );
}
