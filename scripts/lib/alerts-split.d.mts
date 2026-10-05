// 型別橋接：讓 src/（TS）能 import 這份共用 mjs（唯一實作，勿另寫 TS 版）
export type UserPriceAlertType = 'PRICE_ABOVE' | 'PRICE_BELOW' | 'CHANGE_ABOVE' | 'CHANGE_BELOW';

/** 使用者價位警示（與 src/lib/store.ts 的 AlertItem 同形；遷移時原物件照搬，故欄位皆視為可能缺漏） */
export interface UserPriceAlertLike {
  id?: string;
  code?: string;
  name?: string;
  type: UserPriceAlertType;
  value?: number;
  triggered?: boolean;
  createdAt?: number;
}

export type PriceAlertOp<T extends UserPriceAlertLike = UserPriceAlertLike> =
  | { kind: 'add'; item: T }
  | { kind: 'remove'; id: string }
  | { kind: 'trigger'; id: string };

export const USER_PRICE_ALERT_TYPES: readonly UserPriceAlertType[];
export const PRICE_ALERTS_DOC: 'priceAlerts';
export const LEGACY_ALERTS_DOC: 'alerts';

export function isUserPriceAlert(a: unknown): a is UserPriceAlertLike;
export function pickUserPriceAlerts<T extends UserPriceAlertLike = UserPriceAlertLike>(list: unknown): T[];
export function resolvePriceAlerts<T extends UserPriceAlertLike = UserPriceAlertLike>(p: {
  priceDoc: Record<string, unknown> | null | undefined;
  legacyDoc: Record<string, unknown> | null | undefined;
  localAlerts: unknown;
}): { list: T[]; migrate: boolean; source: 'priceAlerts' | 'legacy' | 'local' };
export function applyPriceAlertOp<T extends UserPriceAlertLike = UserPriceAlertLike>(
  list: unknown,
  op: PriceAlertOp<T>,
): { list: T[]; changed: boolean };
/** store.alerts＝雲端價位警示＋原有的非價位警示項目（daemon 警示，只供顯示） */
export function withPriceAlerts<T>(storeAlerts: readonly T[] | unknown, priceList: unknown): T[];
/** 舊 alerts 文件移除使用者價位警示後的陣列；沒有要移除的回 null */
export function stripUserPriceAlerts(legacyDoc: Record<string, unknown> | null | undefined): unknown[] | null;
export function ackAlertIn<T extends { id?: string; ack?: number; ackVia?: string }>(
  list: readonly T[] | unknown,
  id: string,
  at: number,
  via: string,
): { list: T[]; changed: boolean };
