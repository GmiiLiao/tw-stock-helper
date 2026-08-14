// ============================================================
// 台股交易成本精算（教育整理，以券商/主管機關公告為準）
// 手續費：成交金額 × 0.1425% × 折讓，未達最低手續費以最低計；買賣各收一次。
// 零股（不足 1 張，lots 以小數表示如 0.35=350 股）：費率相同，低消依券商，
//   本站以盤中零股常見「最低 1 元」計；證交稅同率、最低 1 元。
// 證交稅（賣出才收）：一般 0.3%；現股當沖 0.15%（減半，政策至 2028 年底）；
//   ETF(00開頭) 0.1%；債券 ETF 免稅（此處不特別處理，需要再擴充）。
// ============================================================

export const STD_FEE_RATE = 0.001425; // 0.1425%
export const STD_TAX_RATE = 0.003;    // 0.3%
export const DAYTRADE_TAX_RATE = 0.0015; // 現股當沖 0.15%
export const ETF_TAX_RATE = 0.001;    // ETF 0.1%

export interface BrokerSettings {
  discount: number;  // 手續費折讓，1=無折、0.6=6折、0.28=28折
  minFee: number;    // 最低手續費（元），常見 20；當沖折後可能更低
}
export const DEFAULT_BROKER: BrokerSettings = { discount: 1, minFee: 20 };
export const ODD_LOT_MIN_FEE = 1; // 零股單低消（各券商 1~20 元不等，以常見電子下單 1 元計）

// 張數（可含小數）→ 股數
export function sharesOf(lots: number): number { return Math.round(lots * 1000); }

// 數量顯示單位。內部儲存一律是「張」（可小數），這個旗標只決定**怎麼寫給人看**。
export type QtyUnit = 'lot' | 'share';

// 張數顯示：整張→「N 張」；純零股→「N 股」；混合→「N 張 M 股」。
//
// unit='share'（使用者在表單上選了「股(零股)」）時**一律以股表示、不進位成張**：
//   1313 股就寫「1313 股」，不是「1 張 313 股」。
//   零股交易者心裡的單位就是股，硬換成張反而要自己再乘回去
//   （2026-08-12 使用者指定）。整張模式才做 1000 進位。
export function fmtQty(lots: number, unit?: QtyUnit): string {
  const shares = sharesOf(lots);
  if (unit === 'share') return `${shares.toLocaleString()} 股`;
  const whole = Math.floor(shares / 1000), odd = shares % 1000;
  if (whole === 0) return `${odd} 股`;
  if (odd === 0) return `${whole} 張`;
  return `${whole} 張 ${odd} 股`;
}

// 單邊手續費（買或賣各一次）。成交金額不足時仍收最低手續費。
export function calcFee(price: number, lots: number, s: BrokerSettings = DEFAULT_BROKER): number {
  const shares = sharesOf(lots);
  const gross = price * shares;
  if (gross <= 0) return 0;
  const raw = gross * STD_FEE_RATE * (s.discount ?? 1);
  const minFee = shares < 1000 ? ODD_LOT_MIN_FEE : (s.minFee ?? 0);  // 純零股單低消 1 元
  // 元以下捨去（2026-08-14 以券商 app 近三日交割逐筆對帳驗證：floor 對到個位數，round 差 1~2 元）
  return Math.max(Math.floor(raw), minFee);
}

export function isEtf(code: string): boolean {
  return /^00/.test(code);
}

// 證交稅（賣出才收）。dayTrade=現股當沖減半；ETF 0.1%。
export function calcTax(price: number, lots: number, opts?: { dayTrade?: boolean; code?: string }): number {
  const gross = price * sharesOf(lots);
  if (gross <= 0) return 0;
  const rate = opts?.dayTrade ? DAYTRADE_TAX_RATE : (opts?.code && isEtf(opts.code)) ? ETF_TAX_RATE : STD_TAX_RATE;
  // 元以下捨去（證交稅法定捨去；實測 2409 稅 799.5 券商收 799，round 會多 1 元）
  return Math.max(1, Math.floor(gross * rate));
}

export function taxRateLabel(opts?: { dayTrade?: boolean; code?: string }): string {
  if (opts?.dayTrade) return '0.15%(當沖減半)';
  if (opts?.code && isEtf(opts.code)) return '0.1%(ETF)';
  return '0.3%';
}

// 一筆交易的成本明細（買：支出＝成交+手續費；賣：收入＝成交−手續費−稅）
export interface TradeCost {
  gross: number; fee: number; tax: number; net: number;
}
export function tradeCost(
  type: 'buy' | 'sell', price: number, lots: number,
  broker: BrokerSettings = DEFAULT_BROKER, opts?: { dayTrade?: boolean; code?: string },
): TradeCost {
  const gross = Math.round(price * sharesOf(lots));
  const fee = calcFee(price, lots, broker);
  const tax = type === 'sell' ? calcTax(price, lots, opts) : 0;
  const net = type === 'buy' ? gross + fee : gross - fee - tax;
  return { gross, fee, tax, net };
}

// 已實現淨損益（含買賣雙邊成本）：賣出收入(淨) − 買進成本(含買進手續費)。
// buyFeePerShare：買進時支付的手續費÷股數（若無紀錄，用均價×折讓估算）。
export function netRealizedPnL(
  sellPrice: number, avgCost: number, lots: number,
  broker: BrokerSettings = DEFAULT_BROKER, opts?: { dayTrade?: boolean; code?: string; buyFee?: number },
): { pnl: number; sellFee: number; tax: number; buyFee: number; roi: number } {
  const shares = sharesOf(lots);
  const sellGross = sellPrice * shares;
  const sellFee = calcFee(sellPrice, lots, broker);
  const tax = calcTax(sellPrice, lots, opts);
  const buyGross = avgCost * shares;
  const buyFee = opts?.buyFee != null ? opts.buyFee : calcFee(avgCost, lots, broker);
  const pnl = Math.round(sellGross - sellFee - tax - buyGross - buyFee);
  const cost = buyGross + buyFee;
  return { pnl, sellFee: Math.round(sellFee), tax: Math.round(tax), buyFee: Math.round(buyFee), roi: cost > 0 ? +(pnl / cost * 100).toFixed(2) : 0 };
}
