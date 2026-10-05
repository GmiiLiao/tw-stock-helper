// 盤中戰情 v2 的數字格式與漲跌色（站上規範：紅漲、綠跌、灰平；漲跌% 固定 2 位；價格小數依檔位；缺值「—」不當 0）。
import { tickSize } from '@/lib/twse-api';
import styles from '../WarRoomV2.module.css';

export type Tone = 'up' | 'dn' | 'flat';

const MINUS = '−';   // U+2212（與預覽頁一致，比連字號好讀）
const DASH = '—';

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** 漲跌方向：>0 up、<0 dn、0 或缺值 flat */
export function toneOf(n: number | null | undefined): Tone {
  if (!isNum(n) || n === 0) return 'flat';
  return n > 0 ? 'up' : 'dn';
}

/** 法人淨額口徑：0 也算紅（站上規範「法人淨額 0 顯示紅色 +0」） */
export function netToneOf(n: number | null | undefined): Tone {
  if (!isNum(n)) return 'flat';
  return n >= 0 ? 'up' : 'dn';
}

const TONE_CLASS: Record<Tone, string> = { up: styles.up, dn: styles.dn, flat: styles.flat };

/** 漲跌色 class（var(--color-up/down/flat)） */
export function toneClass(n: number | null | undefined): string {
  return TONE_CLASS[toneOf(n)];
}
export function toneClassOf(t: Tone): string {
  return TONE_CLASS[t];
}

/** 正負號：'+'、'−'、''（0） */
export function sign(n: number): string {
  return n > 0 ? '+' : n < 0 ? MINUS : '';
}

/** ▲／▼／''（指數、價差用） */
export function arrow(n: number | null | undefined): string {
  if (!isNum(n) || n === 0) return '';
  return n > 0 ? '▲' : '▼';
}

/** 漲跌%：'+1.23%'、'−0.82%'、'0.00%'；缺值 '—' */
export function fmtPct(n: number | null | undefined, digits = 2): string {
  if (!isNum(n)) return DASH;
  return `${sign(n)}${Math.abs(n).toFixed(digits)}%`;
}

/** 帶號數字：'+12.50'、'−3.00'；缺值 '—' */
export function fmtSigned(n: number | null | undefined, digits = 2): string {
  if (!isNum(n)) return DASH;
  return `${sign(n)}${Math.abs(n).toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 指數漲跌點數：'▲286.17'、'▼8.81' */
export function fmtArrowChange(n: number | null | undefined, digits = 2): string {
  if (!isNum(n)) return DASH;
  return `${arrow(n)}${Math.abs(n).toFixed(digits)}`;
}

/** 價格小數位：依檔位（<10 元 0.01、<50 元 0.05 ⇒ 2 位；<500 元 ⇒ 1 位；≥500 ⇒ 0 位）；ETF（00 開頭）一律 2 位 */
export function priceDecimals(price: number, code?: string): number {
  if (code && code.startsWith('00')) return 2;
  const t = tickSize(price);
  return t >= 1 ? 0 : t >= 0.1 ? 1 : 2;
}

/** 價格：'1,685'、'182.5'、'41.85'；缺值或 ≤0 回 '—' */
export function fmtPrice(price: number | null | undefined, code?: string): string {
  if (!isNum(price) || price <= 0) return DASH;
  const d = priceDecimals(price, code);
  return price.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 整數千分位：'1,012'；缺值 '—' */
export function fmtInt(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  return Math.round(n).toLocaleString('zh-TW');
}

/** 股數 → 張（無條件捨去）：'2,860 張' */
export function fmtLots(shares: number | null | undefined): string {
  if (!isNum(shares)) return DASH;
  return `${Math.floor(shares / 1000).toLocaleString('zh-TW')} 張`;
}

/** 法人淨額（張）：'+1,245'、'+0'、'−312'；配色用 netToneOf */
export function fmtNet(n: number | null | undefined): string {
  if (!isNum(n)) return DASH;
  return `${n >= 0 ? '+' : MINUS}${Math.abs(Math.round(n)).toLocaleString('zh-TW')}`;
}

/** 億元：'2,184 億' */
export function fmtYi(n: number | null | undefined, digits = 0): string {
  if (!isNum(n)) return DASH;
  return `${n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits })} 億`;
}

/** 倍數：'×2.4'（量比、成交值比） */
export function fmtX(n: number | null | undefined, digits = 1): string {
  if (!isNum(n)) return DASH;
  return `×${n.toFixed(digits)}`;
}

export { hhmmss, hhmm, mmdd } from './freshness';
