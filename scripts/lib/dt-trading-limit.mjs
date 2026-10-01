// ─────────────────────────────────────────────────────────────────────────────
// 當沖 AI 帳戶的交易規則（2026-10-01 使用者，比照交易所與券商規則）：
//   · 不設單筆上限；只能整張；張數由 AI 交易員在剩餘額度內決定；不限交易次數
//   · 每日交易額度：現金 50 萬 ⇒ 100 萬。每個交易日重新計算；只算進場那一邊的成交價金（不含手續費），
//     當日平倉不回補；額度用完當天就不再交易
//   · 處置股（含已公告待生效）與非現股當沖標的不交易：做多需「可先買後賣」（名單 1、2），做空需「可先賣後買」（名單 1）；
//     名單取不到一律不交易（fail-closed）
//   · 帳戶現金（50 萬＋已實現損益）超過目前額度 ⇒ AI 交易員發訊息申請提高（建議額度＝現金×2），使用者在後台核准後才生效
//   · 每筆的手續費與證交稅由 ./sim-ledger.mjs 計入損益
// ─────────────────────────────────────────────────────────────────────────────

export const DT_DAILY_LIMIT = 1_000_000;
export const DT_LIMIT_MULTIPLE = 2;   // 建議額度＝現金×2（同 50 萬 ⇒ 100 萬）
const LOT = 1000;

/** 今日已用額度：已成交記錄的進場價金（fillPx × shares）；已平倉者照算（不回補） */
export function limitUsed(records) {
  return records.filter(r => r.status === 'filled' && r.fillPx > 0 && r.shares > 0).reduce((a, r) => a + Math.round(r.fillPx * r.shares), 0);
}

/** 剩餘額度（不為負） */
export function limitLeft(limit, records) {
  return Math.max(0, limit - limitUsed(records));
}

/** 以 px 計、剩餘額度內最多可下幾張（只能整張） */
export function maxLots(px, left) {
  return px > 0 && left > 0 ? Math.floor(left / (px * LOT)) : 0;
}

/**
 * 交易資格：回傳 null＝可交易；否則為不可交易的原因。
 * disposition：true／false；null＝處置名單取不到。elig：當沖資格名單值（1＝可先買後賣及先賣後買、2＝僅先買後賣、0＝非當沖標的）；null＝名單取不到。
 */
export function tradeBlock({ side, disposition, elig }) {
  if (disposition == null) return '處置名單取不到，依規則不交易';
  if (disposition) return '處置股（含已公告待生效）依規則不交易';
  if (elig == null) return '現股當沖資格名單取不到，依規則不交易';
  if (side === 'long') return elig === 1 || elig === 2 ? null : '非現股當沖標的（不可先買後賣）';
  return elig === 1 ? null : '不可先賣後買（交易所名單僅限先買後賣或非當沖標的）';
}

/**
 * 是否申請提高額度：現金超過目前額度才申請；待審中不重複；被拒後現金創新高才再申請。
 * last：上一次申請 { status: 'pending'|'approved'|'rejected', cash }。回傳申請內容或 null。
 */
export function limitRequestOf({ cash, limit, last = null }) {
  if (!(cash > limit)) return null;
  if (last?.status === 'pending') return null;
  if (last?.status === 'rejected' && !(cash > last.cash)) return null;
  return { current: limit, cash: Math.round(cash), proposed: Math.ceil(cash * DT_LIMIT_MULTIPLE / 100_000) * 100_000 };
}

/** 分批出場也只能整張：n 張分 1R／2R／3R 三批、餘數往後放（1 張＝0／0／1、2 張＝0／1／1、4 張＝1／1／2），回傳股數 */
export function lotTranches(shares) {
  const n = Math.floor((shares || 0) / LOT);
  return [0, 1, 2].map(i => Math.floor((n + i) / 3) * LOT);
}
