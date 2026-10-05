// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2·D1「快看抽屜」的純函式（唯一實作；前端經 warroom-drawer.d.mts 匯入，單元測試 warroom-drawer.test.mjs）。
//   ① 瀏覽中登記的前端配額（critique M1）：15 分鐘內最多登記 3 個不同代號，第 4 個起不登記、畫面標「登記前為延遲資料」
//   ② 回本檔數：買 1 張後要漲幾個檔位，賣出所得才蓋得過「買賣手續費（依券商折讓、含最低手續費）＋當沖證交稅」
//      手續費／稅／檔位函式由呼叫端注入（前端傳 tw-fee 的 calcFee／calcTax 與 twse-api 的 tickSize），這裡不另寫一份費率
// ─────────────────────────────────────────────────────────────────────────────

/** 伺服器端「瀏覽中」保留時間（live-requests-store 15 分鐘）＝前端配額視窗 */
export const REG_WINDOW_MS = 15 * 60_000;
/** 15 分鐘內最多登記幾個不同代號 */
export const REG_MAX = 3;

const CODE_RE = /^\d{4,6}$/;
const isPos = v => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** 清掉格式不對與超過 15 分鐘的登記，同代號只留最新一筆（新→舊排序） */
export function pruneRegs(list, now) {
  const best = new Map();
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || typeof r.code !== 'string' || !CODE_RE.test(r.code)) continue;
    const at = Number(r.at);
    if (!Number.isFinite(at) || at > now + 60_000 || now - at >= REG_WINDOW_MS) continue;
    const old = best.get(r.code);
    if (!old || old.at < at) best.set(r.code, { code: r.code, at });
  }
  return [...best.values()].sort((a, b) => b.at - a.at);
}

/**
 * 這次能不能登記 code。
 * - 15 分鐘內已登記過同代號 ⇒ 可以（更新時間，不多佔名額）
 * - 不同代號未滿 3 個 ⇒ 可以（加入）
 * - 已滿 ⇒ 不可以（next 只是清理過的清單）
 * @returns {{ allowed: boolean, next: Array<{code, at}>, held: string[] }} held＝目前佔用名額的代號
 */
export function decideRegistration(list, code, now) {
  const cur = pruneRegs(list, now);
  if (!CODE_RE.test(String(code))) return { allowed: false, next: cur, held: cur.map(r => r.code) };
  const has = cur.some(r => r.code === code);
  if (has || cur.length < REG_MAX) {
    const next = [{ code, at: now }, ...cur.filter(r => r.code !== code)];
    return { allowed: true, next, held: next.map(r => r.code) };
  }
  return { allowed: false, next: cur, held: cur.map(r => r.code) };
}

/** 往上走 n 個檔位（跨檔位級距時逐檔換算，避免浮點誤差取 0.01） */
export function addTicks(price, n, tick) {
  let p = price;
  for (let i = 0; i < n; i++) p = Math.round((p + tick(p)) * 100) / 100;
  return p;
}

/**
 * 回本檔數（參考值）：以 price 買 1 張、當沖賣出，最少要漲幾檔，(賣價−買價)×1000 才 ≥ 買手續費＋賣手續費＋賣出證交稅。
 * @param price 買進價
 * @param fns { fee(price) 單邊手續費（元，1 張；已含折讓與最低手續費）, tax(price) 賣出證交稅（元，1 張）, tick(price) 檔位 }
 * @param maxTicks 上限（找不到回 null）
 * @returns {number | null}
 */
export function breakevenTicks(price, fns, maxTicks = 60) {
  if (!isPos(price) || !fns || typeof fns.fee !== 'function' || typeof fns.tax !== 'function' || typeof fns.tick !== 'function') return null;
  const buyFee = fns.fee(price);
  let sell = price;
  for (let n = 1; n <= maxTicks; n++) {
    sell = addTicks(sell, 1, fns.tick);
    const net = (sell - price) * 1000 - buyFee - fns.fee(sell) - fns.tax(sell);
    if (net >= -1e-6) return n;
  }
  return null;
}
