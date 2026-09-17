// Taiwan Stock Market API Service
// Uses TWSE Open API (free, public data)

const TWSE_BASE = 'https://openapi.twse.com.tw/v1';
const TWSE_REPORT_BASE = 'https://www.twse.com.tw';
const PROXY_BASE = '/api/twse'; // Next.js API route proxy

export interface StockDayData {
  Date: string;
  Code: string;
  Name: string;
  TradeVolume: string;
  TradeValue: string;
  OpeningPrice: string;
  HighestPrice: string;
  LowestPrice: string;
  ClosingPrice: string;
  Change: string;
  Transaction: string;
}

export interface MarketIndex {
  Date: string;
  Index: string;
  Change: string;
  ChangePercent: string;
}

export interface StockInfo {
  code: string;
  name: string;
  price: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePercent: number;
  volume: number;
  value: number;
  transactions: number;
  market?: 'tse' | 'otc' | 'esb';   // 上市(tse) / 上櫃(otc) / 興櫃(esb)
}

// ── 市場別標籤：上市 / 上櫃 / ETF（00 開頭 4-6 碼為 ETF）──
export function marketBadge(s: { code: string; market?: string; name?: string }): { t: string; c: string } | null {
  if (/^00\d{2,4}$/.test(s.code)) return { t: 'ETF', c: '#a78bfa' };
  // 創新板（TIB）：證交所把它算在上市（STOCK_DAY_ALL 同一張表、market 也是 tse），
  // 只有名稱尾綴「-創」／「KY創」能辨識（2026-09-18 實測 36 檔）。使用者要看得出它是創新板，不是一般上市。
  if (s.name && /-創$|KY創$/.test(s.name.trim())) return { t: '創', c: '#34d399' };
  if (s.market === 'esb') return { t: '興', c: '#22d3ee' };
  if (s.market === 'otc') return { t: '櫃', c: '#f59e0b' };
  if (s.market === 'tse') return { t: '市', c: '#38bdf8' };
  return null;
}

// ── 集中市場普通股（上市＋上櫃，排除 ETF 與興櫃）─────────────────────────
// 漲跌停榜、漲跌停家數這類「有漲跌停才成立」的統計一律走這道濾網。
// ⚠ 興櫃**沒有漲跌停**（議價撮合、參考價是前一日均價），而它的代號同樣是
//   4 碼非 00 開頭（實案 7924 TLC-KY）——舊的 `/^\d{4}$/ && !startsWith('00')`
//   會把它當普通股收進來，+9.9% 的正常成交就會被報成「漲停」。
export function isExchangeListed(s: { code: string; market?: string }): boolean {
  return /^\d{4}$/.test(s.code) && !s.code.startsWith('00') && s.market !== 'esb';
}

// ── 精確漲跌停判定 ──
// 台股漲停價 = 昨收×1.1 向下取至檔位、跌停 = 昨收×0.9 向上取至檔位。
// 低價股因檔位進位，實際漲停 % 可低至 ~9.5%，不能用固定 % 門檻判斷。
export const tickSize = (p: number) => (p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5);
export function isLimitUp(close: number, change: number): boolean {
  const prev = close - change;
  if (!(prev > 0) || change <= 0) return false;
  const raw = prev * 1.1;
  const t = tickSize(raw);
  const lim = Math.floor(raw / t + 1e-9) * t;
  return close >= lim - 1e-6;
}
export function isLimitDown(close: number, change: number): boolean {
  const prev = close - change;
  if (!(prev > 0) || change >= 0) return false;
  const raw = prev * 0.9;
  const t = tickSize(raw);
  const lim = Math.ceil(raw / t - 1e-9) * t;
  return close <= lim + 1e-6;
}

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Parse ROC date (1150609 → YYYY-MM-DD)
export function parseROCDate(rocDate: string): string {
  if (!rocDate || rocDate.length < 7) return '';
  const year = parseInt(rocDate.slice(0, 3)) + 1911;
  const month = rocDate.slice(3, 5);
  const day = rocDate.slice(5, 7);
  return `${year}-${month}-${day}`;
}

// Fetch all stocks day data
export async function fetchAllStocksDayData(): Promise<StockInfo[]> {
  try {
    // 同上：移除 cache-buster 與 no-store，交給 route 的 Cache-Control 決定
    const res = await fetch(`${PROXY_BASE}/stock-day-all`);
    if (!res.ok) throw new Error('Failed to fetch');
    const data: StockDayData[] = await res.json();
    return data
      .filter(d => d.ClosingPrice && d.TradeVolume)
      .map(d => parseStockDayData(d));
  } catch (error) {
    console.error('Error fetching stock data:', error);
    return [];
  }
}

export function parseStockDayData(d: StockDayData & { _changePercent?: string; _prevClose?: string; _source?: string; _market?: string }): StockInfo {
  const close = parseFloat(d.ClosingPrice) || 0;
  const change = parseFloat(d.Change) || 0;
  const open = parseFloat(d.OpeningPrice) || 0;

  // If MIS-merged record, use the accurate changePercent from MIS
  const changePercent = d._changePercent
    ? parseFloat(d._changePercent)
    : (open > 0 ? parseFloat(((change / (close - change)) * 100).toFixed(2)) : 0);

  return {
    code: d.Code,
    name: d.Name,
    price: close,
    open,
    high: parseFloat(d.HighestPrice) || 0,
    low: parseFloat(d.LowestPrice) || 0,
    close,
    change,
    changePercent,
    volume: parseInt(d.TradeVolume.replace(/,/g, '')) || 0,
    value: parseInt(d.TradeValue.replace(/,/g, '')) || 0,
    transactions: parseInt(d.Transaction?.replace(/,/g, '') || '0') || 0,
    market: d._market === 'otc' ? 'otc' : d._market === 'tse' ? 'tse' : undefined,
  };
}

// Fetch historical OHLCV data for a stock
export async function fetchStockHistory(
  code: string,
  dateStr: string // YYYYMMDD format
): Promise<CandleData[]> {
  try {
    const res = await fetch(`${PROXY_BASE}/stock-history?code=${code}&date=${dateStr}`);
    if (!res.ok) throw new Error('Failed to fetch history');
    const json = await res.json();
    if (!json.data) return [];

    return json.data.map((row: string[]) => {
      const dateRaw = row[0].replace(/\//g, '');
      const [y, m, d] = [
        parseInt(dateRaw.slice(0, 3)) + 1911,
        dateRaw.slice(3, 5),
        dateRaw.slice(5, 7)
      ];
      const dateStr = `${y}-${m}-${d}`;
      const ts = new Date(dateStr).getTime() / 1000;

      return {
        time: ts,
        open: parseFloat(row[3].replace(/,/g, '')) || 0,
        high: parseFloat(row[4].replace(/,/g, '')) || 0,
        low: parseFloat(row[5].replace(/,/g, '')) || 0,
        close: parseFloat(row[6].replace(/,/g, '')) || 0,
        volume: parseInt(row[1].replace(/,/g, '')) || 0,
      };
    }).filter((c: CandleData) => c.open > 0);
  } catch (error) {
    console.error('Error fetching history:', error);
    return [];
  }
}

// Fetch market index
export async function fetchMarketIndex(): Promise<{ weighted: number; weightedChange: number; weightedChangePercent: number }> {
  try {
    const res = await fetch(`${PROXY_BASE}/market-index`);
    if (!res.ok) throw new Error('Failed');
    return await res.json();
  } catch {
    return { weighted: 0, weightedChange: 0, weightedChangePercent: 0 };
  }
}

// Fetch institutional investors (三大法人)
export async function fetchInstitutional(code: string) {
  try {
    const res = await fetch(`${PROXY_BASE}/institutional?code=${code}`);
    if (!res.ok) throw new Error('Failed');
    return await res.json();
  } catch {
    return null;
  }
}

// Format large numbers
export function formatVolume(vol: number): string {
  if (vol >= 100000000) return `${(vol / 100000000).toFixed(1)}億`;
  if (vol >= 10000) return `${(vol / 10000).toFixed(0)}萬`;
  return vol.toLocaleString();
}

export function formatValue(val: number): string {
  if (val >= 100000000) return `${(val / 100000000).toFixed(2)}億`;
  if (val >= 10000) return `${(val / 10000).toFixed(0)}萬`;
  return val.toLocaleString();
}

export function formatChangeSign(change: number): string {
  return change > 0 ? `+${change.toFixed(2)}` : change.toFixed(2);
}

export function formatChangePercentSign(change: number): string {
  return change > 0 ? `+${change.toFixed(2)}%` : `${change.toFixed(2)}%`;
}

/**
 * Single source of truth for Taiwan price-direction color.
 * 🔴 up / 🟢 down / grey flat — returns a CSS variable string.
 * Replaces the inline `isUp ? 'var(--color-up)' : ...` logic duplicated
 * across Dashboard, WatchlistTracker and the AI panels.
 */
export function getChangeColor(change: number): string {
  if (change > 0) return 'var(--color-up)';
  if (change < 0) return 'var(--color-down)';
  return 'var(--color-flat)';
}

// Technical Indicators
export function calculateSMA(data: number[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    const slice = data.slice(i - period + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / period;
  });
}

export function calculateEMA(data: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  const result: (number | null)[] = [];
  let ema: number | null = null;

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
      result.push(ema);
    } else {
      ema = data[i] * k + (ema as number) * (1 - k);
      result.push(ema);
    }
  }
  return result;
}

export function calculateMACD(
  data: number[],
  fast = 12,
  slow = 26,
  signal = 9
): { macd: (number | null)[]; signal: (number | null)[]; histogram: (number | null)[] } {
  const emaFast = calculateEMA(data, fast);
  const emaSlow = calculateEMA(data, slow);

  const macd: (number | null)[] = emaFast.map((f, i) => {
    const s = emaSlow[i];
    if (f === null || s === null) return null;
    return parseFloat((f - s).toFixed(4));
  });

  const macdValues = macd.filter(v => v !== null) as number[];
  const signalLine = calculateEMA(macdValues, signal);

  // Align signal to macd length
  const macdNonNull = macd.reduce((acc: number, v) => acc + (v !== null ? 1 : 0), 0);
  const padding = macd.length - macdNonNull;
  const signalAligned: (number | null)[] = [
    ...Array(padding).fill(null),
    ...signalLine
  ];

  const histogram: (number | null)[] = macd.map((m, i) => {
    const s = signalAligned[i];
    if (m === null || s === null) return null;
    return parseFloat((m - s).toFixed(4));
  });

  return { macd, signal: signalAligned, histogram };
}

export function calculateRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = Array(period).fill(null);
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = data[i] - data[i - 1];
    if (change >= 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs = avgGain / (avgLoss || 0.0001);
  result.push(parseFloat((100 - 100 / (1 + rs)).toFixed(2)));

  for (let i = period + 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.abs(Math.min(change, 0));
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const r = avgGain / (avgLoss || 0.0001);
    result.push(parseFloat((100 - 100 / (1 + r)).toFixed(2)));
  }
  return result;
}

export function calculateKD(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 9
): { k: (number | null)[]; d: (number | null)[] } {
  const k: (number | null)[] = [];
  const d: (number | null)[] = [];
  let prevK = 50, prevD = 50;

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      k.push(null);
      d.push(null);
      continue;
    }
    const highSlice = highs.slice(i - period + 1, i + 1);
    const lowSlice = lows.slice(i - period + 1, i + 1);
    const hn = Math.max(...highSlice);
    const ln = Math.min(...lowSlice);
    const rsv = hn === ln ? 50 : ((closes[i] - ln) / (hn - ln)) * 100;
    const kVal = parseFloat((prevK * 2 / 3 + rsv / 3).toFixed(2));
    const dVal = parseFloat((prevD * 2 / 3 + kVal / 3).toFixed(2));
    prevK = kVal;
    prevD = dVal;
    k.push(kVal);
    d.push(dVal);
  }
  return { k, d };
}

export function calculateBollingerBands(
  data: number[],
  period = 20,
  stdDev = 2
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const middle = calculateSMA(data, period);
  const upper: (number | null)[] = [];
  const lower: (number | null)[] = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    const slice = data.slice(i - period + 1, i + 1);
    const mean = middle[i] as number;
    const variance = slice.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper.push(parseFloat((mean + stdDev * std).toFixed(2)));
    lower.push(parseFloat((mean - stdDev * std).toFixed(2)));
  }
  return { upper, middle, lower };
}

// Signal Detection
export interface TradingSignal {
  type: 'BUY' | 'SELL' | 'WATCH' | 'NEUTRAL';
  strength: number; // 0-100
  reasons: string[];
}

export function detectSignal(
  candles: CandleData[],
  stock: StockInfo
): TradingSignal {
  if (candles.length < 26) return { type: 'NEUTRAL', strength: 0, reasons: ['數據不足'] };

  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const sma5 = calculateSMA(closes, 5);
  const sma20 = calculateSMA(closes, 20);
  const sma60 = calculateSMA(closes, 60);
  const { macd, signal: macdSignal, histogram } = calculateMACD(closes);
  const rsi = calculateRSI(closes);
  const { k, d } = calculateKD(highs, lows, closes);

  const n = closes.length - 1;
  const reasons: string[] = [];
  let bullScore = 0;
  let bearScore = 0;

  // MA alignment
  const ma5 = sma5[n];
  const ma20 = sma20[n];
  const ma60 = sma60[n];
  const price = closes[n];

  if (ma5 && ma20 && ma5 > ma20) { bullScore += 15; reasons.push('✅ MA5 > MA20 多頭排列'); }
  if (ma20 && ma60 && ma20 > ma60) { bullScore += 10; reasons.push('✅ MA20 > MA60 中長期多頭'); }
  if (ma5 && price > ma5) { bullScore += 5; }
  if (ma5 && ma20 && ma5 < ma20) { bearScore += 15; reasons.push('❌ MA5 < MA20 空頭排列'); }

  // MACD
  const macdVal = macd[n];
  const sigVal = macdSignal[n];
  const histVal = histogram[n];
  const prevHistVal = histogram[n - 1];

  if (macdVal !== null && sigVal !== null && macdVal > sigVal) {
    bullScore += 20;
    reasons.push('✅ MACD > Signal 多頭動能');
  }
  if (macdVal !== null && sigVal !== null && macdVal < sigVal) {
    bearScore += 20;
    reasons.push('❌ MACD < Signal 空頭動能');
  }
  if (histVal !== null && prevHistVal !== null) {
    if (histVal > 0 && histVal > prevHistVal) { bullScore += 10; reasons.push('✅ MACD 柱狀遞增'); }
    if (histVal < 0 && histVal < prevHistVal) { bearScore += 10; }
  }

  // RSI
  const rsiVal = rsi[n];
  if (rsiVal !== null) {
    if (rsiVal >= 50 && rsiVal <= 70) { bullScore += 10; reasons.push(`✅ RSI ${rsiVal.toFixed(0)} 強勢區`); }
    if (rsiVal < 30) { bullScore += 15; reasons.push(`✅ RSI ${rsiVal.toFixed(0)} 超賣反彈機會`); }
    if (rsiVal > 80) { bearScore += 20; reasons.push(`❌ RSI ${rsiVal.toFixed(0)} 超買警示`); }
    if (rsiVal < 50) { bearScore += 5; }
  }

  // KD
  const kVal = k[n];
  const dVal = d[n];
  if (kVal !== null && dVal !== null) {
    if (kVal > dVal && kVal < 80) { bullScore += 10; reasons.push(`✅ KD 黃金交叉 K${kVal.toFixed(0)}`); }
    if (kVal < dVal && kVal > 20) { bearScore += 10; reasons.push(`❌ KD 死亡交叉`); }
    if (kVal < 20 && dVal < 20) { bullScore += 15; reasons.push('✅ KD 超賣區 低檔機會'); }
    if (kVal > 80 && dVal > 80) { bearScore += 15; reasons.push('❌ KD 超買區 注意回調'); }
  }

  // Volume
  const avgVol5 = volumes.slice(n - 5, n).reduce((a, b) => a + b, 0) / 5;
  const todayVol = volumes[n];
  if (todayVol > avgVol5 * 1.5 && stock.change > 0) {
    bullScore += 15;
    reasons.push('✅ 量增價漲 爆量突破');
  }
  if (todayVol > avgVol5 * 1.5 && stock.change < 0) {
    bearScore += 15;
    reasons.push('❌ 量增價跌 爆量下殺');
  }

  // Determine signal
  const netScore = bullScore - bearScore;
  const strength = Math.min(100, Math.abs(netScore));

  if (netScore >= 30) return { type: 'BUY', strength, reasons };
  if (netScore <= -30) return { type: 'SELL', strength, reasons };
  if (netScore >= 10) return { type: 'WATCH', strength, reasons };
  return { type: 'NEUTRAL', strength, reasons };
}

// ── 布林通道 BBAND（2026-08-06 補·對齊券商「主圖」指標）────────────
// 中軌＝N 日 SMA，上/下軌＝中軌 ± k×母體標準差（券商慣例 N=20、k=2）。
// ⚠標準差用**母體**(÷N)而非樣本(÷N-1)——這是台股各家看盤軟體的一致做法，
//   用樣本會與券商畫出來的線對不上，使用者會以為我們算錯。
export function calculateBBands(
  closes: number[], period = 20, mult = 2,
): { mid: (number | null)[]; upper: (number | null)[]; lower: (number | null)[] } {
  const mid: (number | null)[] = [], upper: (number | null)[] = [], lower: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { mid.push(null); upper.push(null); lower.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const m = sum / period;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (closes[j] - m) ** 2;
    const sd = Math.sqrt(sq / period);
    mid.push(m); upper.push(m + mult * sd); lower.push(m - mult * sd);
  }
  return { mid, upper, lower };
}

// ── SAR 拋物線轉向（Wilder 原始定義·AF 0.02 起、每次創新極值 +0.02、上限 0.2）──
// 回傳 { sar, rising }：rising=true 代表目前是多頭段（SAR 在價格下方）。
// ⚠翻轉當根的 SAR 取「前一段的極值(EP)」，且要用前兩根的高/低夾住——
//   少了這道夾擠，翻轉點會落在 K 棒裡面，看起來像畫錯。
export function calculateSAR(
  highs: number[], lows: number[], step = 0.02, max = 0.2,
): { sar: (number | null)[]; rising: boolean[] } {
  const n = highs.length;
  const sar: (number | null)[] = new Array(n).fill(null);
  const rising: boolean[] = new Array(n).fill(true);
  if (n < 3) return { sar, rising };

  let up = highs[1] >= highs[0];         // 初始方向：第二根較高視為多頭
  let af = step;
  let ep = up ? highs[1] : lows[1];      // 極值
  let cur = up ? lows[0] : highs[0];     // 起始 SAR
  sar[1] = cur; rising[1] = up;

  for (let i = 2; i < n; i++) {
    let next = cur + af * (ep - cur);
    if (up) {
      next = Math.min(next, lows[i - 1], lows[i - 2]);   // 不可高於前兩根低點
      if (lows[i] < next) {                              // 跌破 → 轉空
        up = false; next = ep; ep = lows[i]; af = step;
      } else if (highs[i] > ep) { ep = highs[i]; af = Math.min(af + step, max); }
    } else {
      next = Math.max(next, highs[i - 1], highs[i - 2]); // 不可低於前兩根高點
      if (highs[i] > next) {                             // 突破 → 轉多
        up = true; next = ep; ep = highs[i]; af = step;
      } else if (lows[i] < ep) { ep = lows[i]; af = Math.min(af + step, max); }
    }
    cur = next; sar[i] = cur; rising[i] = up;
  }
  return { sar, rising };
}
