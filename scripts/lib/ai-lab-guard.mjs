// ─────────────────────────────────────────────────────────────────────────────
// AI 實驗鏈的重覆執行／凍結防呆（2026-10-04 使用者：「看起來都是因為事件重覆執行性問題，比對後保持正確且最新的版本，
//   統一修復並加上防呆機制使工作順暢」；WM-SCAN G4-19／G2-20／G2-23／G2-26／G2-28／G2-30／G2-31）
//
//   原則（各執行器共用，不要再各處手寫）：
//     ① 冪等以「資料日」為鍵，不用日曆日（午夜後一輪不可吃掉當天傍晚的工作）。
//     ② 「失敗」與「已完成」分開：基礎設施故障（Ollama 連不上／HTTP 錯／逾時、讀取失敗）不計入重試額度、
//        持續重試到決策時窗結束才放棄，凍結文字寫明原因；回覆看不懂才計入額度。
//     ③ 重跑時比對後保留較完整／較新的版本，永不以較殘缺的結果覆蓋較完整的。
//     ④ 定版前看資料到齊（兩市收盤＋必要欄位），沿用 ./canonical-gate.mjs 的判斷。
//   全部是純函式；讀寫 Firestore／呼叫 Ollama 在執行器（ai-swing-runner／ai-daytrade-runner）與 daemon。
// ─────────────────────────────────────────────────────────────────────────────
import { archiveDayStatus } from './canonical-gate.mjs';
import { factorsFromItems } from './price-factors.mjs';

// ── Ollama 呼叫結果分類 ───────────────────────────────────────────────────────
/** 基礎設施類：不是模型回答得不好，而是根本沒拿到回答 ⇒ 不計入重試額度 */
export const OLLAMA_INFRA_KINDS = Object.freeze(['connect', 'http', 'timeout']);
export const OLLAMA_KIND_LABEL = Object.freeze({ ok: '正常', connect: '連線失敗', http: 'HTTP 錯誤', timeout: '逾時', empty: '空回覆' });
export const isInfraFailure = kind => OLLAMA_INFRA_KINDS.includes(kind);

/**
 * 統一呼叫 Ollama 並回傳 { text, kind, detail }。
 *   askOllamaEx（daemon 提供）＝回傳 { text, kind, detail } 的版本；沒有時退回 askOllama（只回字串或 null）——
 *   這時無法分辨原因，null 一律記為 'empty'（沿用舊語意：計入重試額度），不冒充「連線失敗」。
 */
export async function askWithOutcome({ askOllama, askOllamaEx }, prompt, opts) {
  if (typeof askOllamaEx === 'function') {
    try {
      const r = await askOllamaEx(prompt, opts);
      const text = r?.text ? String(r.text) : null;
      let kind = r?.kind || (text ? 'ok' : 'empty');
      if (kind === 'ok' && !text) kind = 'empty';
      return { text: isInfraFailure(kind) ? null : text, kind, detail: r?.detail ?? null };
    } catch (e) { return { text: null, kind: 'connect', detail: String(e?.message || e).slice(0, 120) }; }
  }
  try {
    const text = await askOllama(prompt, opts);
    return text ? { text: String(text), kind: 'ok', detail: null } : { text: null, kind: 'empty', detail: null };
  } catch (e) { return { text: null, kind: 'connect', detail: String(e?.message || e).slice(0, 120) }; }
}

/**
 * LLM 決策的下一步：
 *   'ok'｜'retry-infra'（不計次，時窗內再試）｜'freeze-infra'（時窗最後一次仍連不上）｜'retry-parse'（計次）｜'freeze-parse'（額度用完或最後一次）
 * attempts＝含本次在內的「回覆無法解析」次數。
 */
export function llmNextStep({ kind, parsedOk, attempts = 0, maxAttempts = 3, lastChance = false }) {
  if (isInfraFailure(kind)) return lastChance ? 'freeze-infra' : 'retry-infra';
  if (parsedOk) return 'ok';
  return attempts >= maxAttempts || lastChance ? 'freeze-parse' : 'retry-parse';
}

// ── 台北時間／交易日 ───────────────────────────────────────────────────────────
/** epoch ms → 台北 'YYYY-MM-DDTHH:MM' */
export const twClock = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16);
/** 'YYYY-MM-DDTHH:MM' ＋ min 分鐘 */
export const addMinutes = (tw, min) => new Date(Date.parse(`${tw}:00Z`) + min * 60e3).toISOString().slice(0, 16);
const shiftDay = (iso, k) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };

/**
 * dataDate 之後下一個交易日的 08:30（試撮）＝ 'YYYY-MM-DDT08:30'；20 天內找不到交易日 ⇒ null（日曆異常，呼叫端保守處理）。
 * 與 canonical-gate.beforeNextOpen 同一定義：beforeNextOpen(d, now) ⇔ now < nextOpenOf(d)。
 */
export function nextOpenOf(dataDate, isTradingDayIso) {
  for (let i = 1; i <= 20; i++) { const iso = shiftDay(dataDate, i); if (isTradingDayIso(iso)) return `${iso}T08:30`; }
  return null;
}

/**
 * 「到 nowTw 為止、資料應已產生」的最近交易日：今天是交易日且已過 readyMin（台北分鐘）⇒ 今天；否則往前找最近的交易日。
 *   波段 AI 選股：readyMin＝17:00（兩榜收盤版）；v3 影子：readyMin＝13:30（收盤）。
 */
export function latestTradingDayAsOf(nowTw, isTradingDayIso, readyMin) {
  const today = nowTw.slice(0, 10), mins = +nowTw.slice(11, 13) * 60 + +nowTw.slice(14, 16);
  if (isTradingDayIso(today) && mins >= readyMin) return today;
  for (let i = 1; i <= 20; i++) { const iso = shiftDay(today, -i); if (isTradingDayIso(iso)) return iso; }
  return null;
}
export const SWING_PICK_READY_MIN = 17 * 60;
/** 波段 AI 選股這一輪「應處理」的資料日（G2-31：冪等鍵＝資料日，不是日曆今天） */
export const expectedSwingDataDate = (nowTw, isTradingDayIso) => latestTradingDayAsOf(nowTw, isTradingDayIso, SWING_PICK_READY_MIN);

// ── 波段 AI 凍結前的資料閘門（G2-30）──────────────────────────────────────────
const fourDigitN = closeJson => { try { return Object.keys(JSON.parse(closeJson || '{}')).filter(c => /^\d{4}$/.test(c)).length; } catch { return 0; } };
const BOARD_SLACK = 0.95;          // 與 computeSwingHold 冪等同一個容差
const PICKS_STALE_MS = 10 * 60e3;  // 波段起漲榜未標宇宙檔數（舊版）時：須在波段持有榜之前 10 分鐘內或之後重算

/**
 * 寫一次的 AI 波段凍結檔之前：收盤歸檔兩市都在，且兩張榜都是以兩市到齊的歸檔算出（不是 15:10「只有上市」那一版）。
 *   archiveDoc＝chipArchive/{date}；swingHold.universeAll＝算榜時歸檔的 4 碼檔數；swingPicks.universeN 同（舊版沒有 ⇒ 看時間）。
 * @returns {{ ready: boolean, missing: string[] }}
 */
export function swingFreezeGate({ archiveDoc, swingHold, swingPicks }) {
  const missing = [];
  if (!archiveDoc) return { ready: false, missing: ['收盤歸檔讀不到'] };
  const st = archiveDayStatus(archiveDoc);
  for (const m of st.missing) if (m.endsWith('收盤')) missing.push(`收盤歸檔缺${m}`);
  const n = fourDigitN(archiveDoc.closeJson);
  if (!(Number(swingHold?.universeAll) >= n * BOARD_SLACK)) missing.push(`波段持有榜以殘缺歸檔算出（宇宙 ${swingHold?.universeAll ?? '—'}／歸檔 ${n}）`);
  if (typeof swingPicks?.universeN === 'number') {
    if (!(swingPicks.universeN >= n * BOARD_SLACK)) missing.push(`波段起漲榜以殘缺歸檔算出（宇宙 ${swingPicks.universeN}／歸檔 ${n}）`);
  } else if (!(Number(swingPicks?.updatedAt) >= Number(swingHold?.updatedAt || 0) - PICKS_STALE_MS)) {
    missing.push('波段起漲榜早於兩市到齊後的重算（等下一輪重算）');
  }
  return { ready: missing.length === 0, missing };
}

// ── 凍結檔：失敗凍結的辨識（手動重新決策只允許覆蓋這種）────────────────────────
/** 是否為「失敗凍結」（Ollama 未回應／回覆無法解析而今日不操作）。成功的決策永不被重新決策覆蓋。 */
export function isFailureFreeze(doc) {
  if (!doc) return false;
  if (doc.failure?.kind) return true;
  // 本機制上線前的舊凍結檔：note 固定字樣＋沒有任何委託
  const noOrders = !(doc.picks || []).some(p => p?.position?.shares > 0) && !(doc.review?.sells || []).length;
  return noOrders && /皆無法解析|Ollama 未回應/.test(String(doc.note || ''));
}

// ── 重啟接回：同一筆記錄取較新版本（G2-20）──────────────────────────────────────
const STATUS_RANK = { pending: 0, error: 1, 'out-of-window': 1, ineligible: 1, 'no-limit': 1, missed: 2, skipped: 2, filled: 2 };
const progressOf = r => (STATUS_RANK[r?.status] ?? 1) * 10 + (r?.exitAt ? 5 : 0) + (r?.decidedAt ? 1 : 0);
/**
 * persisted（Firestore live 的記錄）與 current（行程記憶體的記錄）以 id 合併：同 id 取進度較多者（同進度取記憶體版＝較新），
 * 順序依首次出現（persisted 在前）。不改傳入陣列。
 */
export function mergeRecordsById(persisted = [], current = []) {
  const out = new Map();
  for (const r of persisted) if (r?.id != null) out.set(r.id, r);
  for (const r of current) {
    if (r?.id == null) continue;
    const prev = out.get(r.id);
    out.set(r.id, !prev || progressOf(r) >= progressOf(prev) ? r : prev);
  }
  return [...out.values()];
}

// ── 收盤歸檔 → 交易日序列（G2-28：殘缺日標缺值，不位移）──────────────────────────
/**
 * docs＝chipArchive 文件（任意順序，{date, closeJson, …}）。回傳舊→新的交易日序列：
 *   · 有收盤但檔數不足（例：只有上市）的日子＝殘缺日：保留一格，m 只放有的檔（缺的就是缺值）——
 *     不再整天濾掉讓「5 日」跨 6 個交易日（partial:true）；
 *   · 沒有收盤的文件（空殼）：給了休市日曆 isTradingDayIso 時，交易日的空殼保留一格（整天缺值）、非交易日的空殼丟掉；
 *     沒給日曆時一律丟掉——休市日曆的「臨時休市」本來就是由歸檔空洞反推（實例 2026-07-10 颱風假留有空殼文件），
 *     所以「沒有收盤＝不是交易日」與日曆同一口徑；
 *   · 序列尾端的空殼（當天盤前建立、收盤未歸檔）一律丟掉（droppedTail）。
 * @returns {{ days: {date, m, partial, raw}[], partialDates: string[], droppedTail: string[], droppedShells: string[] }}
 */
export function alignArchiveDays(docs, { fullMin = 1500, parse = s => JSON.parse(s), isTradingDayIso = null } = {}) {
  const sorted = (docs || []).filter(d => d?.date).slice().sort((a, b) => a.date.localeCompare(b.date));
  const droppedTail = [], droppedShells = [];
  while (sorted.length && !sorted[sorted.length - 1].closeJson) droppedTail.unshift(sorted.pop().date);
  const kept = sorted.filter(d => {
    if (d.closeJson || (isTradingDayIso && isTradingDayIso(d.date))) return true;
    droppedShells.push(d.date); return false;
  });
  const partialDates = [];
  const days = kept.map(d => {
    let m = {};
    if (d.closeJson) { try { m = parse(d.closeJson) || {}; } catch { m = {}; } }
    const n = Object.keys(m).filter(c => /^\d{4}$/.test(c)).length;
    const partial = n < fullMin;
    if (partial) partialDates.push(d.date);
    return { date: d.date, m, partial, raw: d };
  });
  return { days, partialDates, droppedTail, droppedShells };
}

// ── priceEvents/latest（G2-26）────────────────────────────────────────────────
/** priceEvents/latest 文件 → 還原係數；文件不存在或沒有 items 陣列＝讀取失敗（丟錯，不可退回「不還原」寫死結果） */
export function priceFactorsFromDoc(doc) {
  if (!doc) throw new Error('priceEvents/latest 不存在');
  if (!Array.isArray(doc.items)) throw new Error('priceEvents/latest 沒有 items');
  return factorsFromItems(doc.items);
}

// ── v3 影子的資料日（G2-23）──────────────────────────────────────────────────
/**
 * 影子記錄只寫「預期的最新交易日」且兩市收盤＋法人到齊；否則回報原因、不寫（不可改寫昨天）。
 * @returns {{ ok: boolean, why: string|null }}
 */
export function shadowDayCheck({ lastDate, expected, archiveDoc }) {
  if (!expected) return { ok: false, why: '交易日曆異常，無法判定預期資料日' };
  if (lastDate !== expected) return { ok: false, why: `最新完整歸檔日 ${lastDate || '—'} ≠ 預期的最新交易日 ${expected}（不改寫舊日）` };
  const st = archiveDayStatus(archiveDoc);
  if (!st.ready) return { ok: false, why: `${expected} 歸檔未到齊（${st.missing.join('、')}）` };
  return { ok: true, why: null };
}

// ── 牆鐘預算（G4-29）───────────────────────────────────────────────────────────
/** 迴圈的牆鐘預算：expired()＝已用完（不再開始下一位）；left()＝剩餘毫秒 */
export function createBudget(ms, now = () => Date.now()) {
  const t0 = now();
  return { expired: () => now() - t0 >= ms, left: () => Math.max(0, ms - (now() - t0)), elapsed: () => now() - t0 };
}
