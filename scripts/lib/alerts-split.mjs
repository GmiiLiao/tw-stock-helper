// ─────────────────────────────────────────────────────────────────────────
// 使用者價位警示 vs daemon 警示：拆成兩份文件（2026-10-05·盤中戰情 v2 規畫 critique H3）
//
// 事故（既有問題）：users/{uid}/data/alerts 同一個陣列有兩種格式、三個整份覆寫的寫入端——
//   ① 前端 store：使用者自設價位警示（type＝PRICE_ABOVE／PRICE_BELOW／CHANGE_ABOVE／CHANGE_BELOW），
//      addAlert／removeAlert／triggerAlert 以「登入時讀到的整份陣列」setDoc 回寫；
//   ② daemon：停損、停利、反轉、自訂條件…約 25 處，皆「讀→[新, ...舊].slice(0,40)→整份 set」；
//   ③ PortfolioAlerts「✅ 收到」：以 onSnapshot 當下的陣列整份回寫。
//   ⇒ 使用者價位警示一觸發，就把登入後 daemon 寫入的停損警示與「收到」紀錄整批抹掉；
//     反過來 daemon 每寫 40 則，排在尾端的使用者價位警示也會被 slice 擠掉。
//
// 解法（本檔是唯一實作，有單元測試 alerts-split.test.mjs）：
//   · 使用者價位警示改存 users/{uid}/data/priceAlerts（{ alerts, updatedAt }），只放使用者格式。
//   · 寫入一律是「針對單一 id 的操作」（add／remove／trigger），在交易內讀最新文件再改，
//     不再用前端記憶體裡的整份陣列覆寫雲端。
//   · priceAlerts 不存在時一次性遷移：舊 alerts 文件存在＝取其中使用者格式項目（原樣搬，不重組欄位）；
//     舊文件不存在＝取本機 store.alerts（firebase-sync 已套用「本機擁有者」規則）中的使用者格式項目。
//   · 舊 alerts 文件前端不再整份覆寫；只在同一個交易內移除其中的使用者價位警示（stripUserPriceAlerts），
//     daemon 警示與 ack 原封保留（daemon 若同時寫入，前端交易重試，不會蓋掉 daemon 的新警示）。
//     遷移完成後 priceAlerts 是唯一真相：舊文件之後若又出現使用者格式項目（舊版分頁、daemon 讀寫空窗），一律清掉不回併。
//   · daemon 警示的「收到」改為交易內只改該 id（ackAlertIn），不再整份覆寫。
// ─────────────────────────────────────────────────────────────────────────

/** 使用者自設價位警示的四種 type（daemon 警示的 type 全是小寫英文字，兩者不會重疊） */
export const USER_PRICE_ALERT_TYPES = Object.freeze(['PRICE_ABOVE', 'PRICE_BELOW', 'CHANGE_ABOVE', 'CHANGE_BELOW']);

/** 新文件：users/{uid}/data/priceAlerts */
export const PRICE_ALERTS_DOC = 'priceAlerts';
/** 舊文件：users/{uid}/data/alerts（daemon 警示；遷移前也混著使用者價位警示） */
export const LEGACY_ALERTS_DOC = 'alerts';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 是否為使用者自設價位警示（只看 type——這是兩種格式唯一可靠的分界；其他欄位缺漏也照樣保留，不丟使用者資料） */
export function isUserPriceAlert(a) {
  return isObj(a) && USER_PRICE_ALERT_TYPES.includes(a.type);
}

/**
 * 從任意陣列挑出使用者價位警示（原物件照搬、不補欄位）。
 * 同 id 只留第一筆；沒有 id 的照樣保留（使用者資料寧多勿漏）。
 */
export function pickUserPriceAlerts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const a of list) {
    if (!isUserPriceAlert(a)) continue;
    const id = typeof a.id === 'string' && a.id ? a.id : null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(a);
  }
  return out;
}

/**
 * 決定這個帳號的價位警示清單從哪裡來。
 * @param {{ priceDoc: object|null, legacyDoc: object|null, localAlerts: unknown }} p
 *   priceDoc＝priceAlerts 文件資料（null＝不存在）；legacyDoc＝舊 alerts 文件資料（null＝不存在）；
 *   localAlerts＝本機 store.alerts（firebase-sync 已套用擁有者規則）
 * @returns {{ list: object[], migrate: boolean, source: 'priceAlerts'|'legacy'|'local' }}
 *   migrate＝priceAlerts 尚不存在、需要寫入一次（即使 list 為空也要寫，作為「已遷移」的標記）
 */
export function resolvePriceAlerts({ priceDoc, legacyDoc, localAlerts }) {
  if (isObj(priceDoc)) return { list: pickUserPriceAlerts(priceDoc.alerts), migrate: false, source: 'priceAlerts' };
  if (isObj(legacyDoc)) return { list: pickUserPriceAlerts(legacyDoc.alerts), migrate: true, source: 'legacy' };
  return { list: pickUserPriceAlerts(localAlerts), migrate: true, source: 'local' };
}

/**
 * 對價位警示清單套用單一操作（純函式，回傳新陣列）。
 * @param {object[]} list
 * @param {{ kind: 'add', item: object } | { kind: 'remove', id: string } | { kind: 'trigger', id: string }} op
 * @returns {{ list: object[], changed: boolean }}
 */
export function applyPriceAlertOp(list, op) {
  const base = pickUserPriceAlerts(list);
  if (!isObj(op)) return { list: base, changed: false };
  if (op.kind === 'add') {
    const item = op.item;
    if (!isUserPriceAlert(item)) return { list: base, changed: false };
    if (typeof item.id === 'string' && item.id && base.some((a) => a.id === item.id)) return { list: base, changed: false };
    return { list: [...base, item], changed: true };
  }
  if (typeof op.id !== 'string' || !op.id) return { list: base, changed: false };
  if (op.kind === 'remove') {
    const next = base.filter((a) => a.id !== op.id);
    return { list: next, changed: next.length !== base.length };
  }
  if (op.kind === 'trigger') {
    let changed = false;
    const next = base.map((a) => {
      if (a.id !== op.id || a.triggered === true) return a;
      changed = true;
      return { ...a, triggered: true };
    });
    return { list: next, changed };
  }
  return { list: base, changed: false };
}

/**
 * 舊 alerts 文件的清理：移除其中的使用者價位警示（已搬到 priceAlerts），daemon 警示與其 ack 原封保留、順序不變。
 * 為什麼要清：firebase-sync 每次登入會先把舊文件整份放進 store.alerts，再由 priceAlerts 換掉；
 *   若舊文件留著 triggered:false 的過期副本，AlertEngine 在這段空窗可能把「早已觸發」的警示再發一次。
 * 必須在讀到該文件的同一個交易內寫回（daemon 若同時寫入，交易會重試，不會蓋掉 daemon 的新警示）。
 * @returns {object[] | null} 清理後的陣列；沒有要移除的項目回 null（不需要寫）
 */
export function stripUserPriceAlerts(legacyDoc) {
  if (!isObj(legacyDoc) || !Array.isArray(legacyDoc.alerts)) return null;
  const kept = legacyDoc.alerts.filter((a) => !isUserPriceAlert(a));
  return kept.length === legacyDoc.alerts.length ? null : kept;
}

/**
 * 登入後換上 priceAlerts 時的 store.alerts：價位警示換成雲端清單，其餘（firebase-sync 從舊 alerts 文件載入的
 * daemon 警示）原樣保留在後面——即時追蹤頁的 🔔（WatchlistTracker：store.alerts 有該代號就顯示）沿用舊行為，不因拆檔消失。
 * 這些 daemon 項目只供顯示；雲端寫入一律走 applyPriceAlertOp，不會被整份寫回。
 */
export function withPriceAlerts(storeAlerts, priceList) {
  const others = Array.isArray(storeAlerts) ? storeAlerts.filter((a) => !isUserPriceAlert(a)) : [];
  return [...pickUserPriceAlerts(priceList), ...others];
}

/**
 * daemon 警示的「收到」：只改指定 id 那一則（已確認過的不覆寫原確認時間與管道）。
 * @returns {{ list: object[], changed: boolean }}
 */
export function ackAlertIn(list, id, at, via) {
  const base = Array.isArray(list) ? list : [];
  if (typeof id !== 'string' || !id) return { list: base, changed: false };
  let changed = false;
  const next = base.map((a) => {
    if (!isObj(a) || a.id !== id || a.ack) return a;
    changed = true;
    return { ...a, ack: at, ackVia: via };
  });
  return { list: next, changed };
}
