// ─────────────────────────────────────────────────────────────────────────────
// 第一階段（stop-v1.1 生效前）停損：LLM 提示詞片段與輸出量測（使用者第 4 項裁定「LLM 只能照抄系統停損」）。
//
// ⚠ 時程（SKILL §10.1、llm-contract.md）：S3 影子期**不改任何提示詞**——daemon 只用 phase1HoldingStop／phase1HypotheticalStop
//   算比對值、measureLlmStop（expectRef:false）量測現有輸出。下面的提示詞片段（PHASE1_STOP_RULE、*StopLine、splitStopRef）
//   在 S3 **不接進 daemon**；要在 S5 之前提前換提示詞，須先經使用者核可並同步改 SKILL §10.1 與 llm-contract.md。
//
// 為什麼不是 ai-stoploss-llm.mjs 的 stopPromptLines：那是 S5（v1.1 生效）用的——給 v1.1 生效停損與它的來源標籤。
//   現在推播仍是第一階段口徑（daemon checkAlerts：持股分析 ATR 帶 >0 就用、否則均價×0.92；legacyPushStop），
//   規範「生效範圍」明定不得拿 v1.1 條文去改第一階段算法 ⇒ 提示詞給的「系統停損」＝使用者實際收到推播所用的那個數字。
//   S5 切換時把這裡換成 stopPromptLines／hypotheticalStopLine（llm-contract §1）。
// 量測：validateLlmStopText 的 measure 模式（只記錄、不改字；enforce 要 S5b 使用者核可，llm-contract §4）。
//
// ⚠ 依賴刻意只到 ai-stoploss-{base,core,llm}.mjs（不經集線器）：集線器會連帶載入 warroom-news → after-market-news（另一流程的檔），
//   daemon 是 disk 即部署，靜態 import 鏈上任何一檔壞掉都會讓 daemon 起不來；這三檔只依賴 warroom-session。
// 純函式。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { legacyPushStop } from './ai-stoploss-core.mjs';
import { parseStopRef, stripStopRef, validateLlmStopText, STOP_REF_FORMAT } from './ai-stoploss-llm.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;

export { STOP_REF_FORMAT };

/**
 * 第一階段的停損規則句（接在 STRICT_RULE 之後）。與 STOP_PROMPT_RULE（S5）的差別：
 *   第一階段推播的停損本身就是持股分析的 ATR 帶，所以不寫「不得把 ATR 帶當日值稱為停損」；
 *   第一階段系統不依新聞調整停損（事件收緊只在影子試算），所以不寫「系統已依規則處理」。
 */
export const PHASE1_STOP_RULE = '\n【停損規則】停損數字只能原樣引用上面的「停損」，不得自訂、調寬或調緊；不得把支撐買點或目標價稱為停損；'
  + '處置／注意是交易限制，不是走勢強弱，不得作為停損理由；新聞不得作為自行調整停損的理由。';

const SOURCE_TEXT = Object.freeze({ ai: 'AI 停損', cost: '成本 −8%' });

/** 持股分析：與停損推播同口徑的停損（AI 停損＝持股分析 ATR 帶 >0 優先，否則均價×0.92）；成本缺回 null */
export function phase1HoldingStop(avgCost, ratingBand) {
  return legacyPushStop(avgCost, ratingBand);
}

/** 持股分析提示詞的停損行（數字照推播原樣，不另取檔位：LLM 照抄的數字要與推播一字不差） */
export function phase1HoldingStopLine(stop) {
  if (!stop || !isPos(stop.price)) return '停損：成本資料缺，不提供停損數字';
  return `停損（與停損推播同口徑·${SOURCE_TEXT[stop.source] ?? SOURCE_TEXT.cost}）：${stop.price}`;
}

/** 標準買點（/api/rating buyZones 的 type 'standard'）；沒有回 null */
export function standardBuyPoint(buyZones) {
  const z = (Array.isArray(buyZones) ? buyZones : []).find(x => x && x.type === 'standard' && isPos(x.price));
  return z ? z.price : null;
}

/**
 * 個股波段分析（未持有）：若以標準買點 B 進場，與停損推播同口徑的停損——
 * ATR 帶 >0 且低於 B 就用帶（帶 ≥ B 時不能當 B 進場的停損），否則 B×0.92；B 缺回 null（不猜）。
 */
export function phase1HypotheticalStop(buyPoint, ratingBand) {
  if (!isPos(buyPoint)) return null;
  if (isPos(ratingBand) && ratingBand < buyPoint) return { price: ratingBand, source: 'ai' };
  return { price: +(buyPoint * 0.92).toFixed(2), source: 'cost' };
}

/** 個股波段分析提示詞的停損行 */
export function phase1HypotheticalStopLine(buyPoint, stop) {
  if (!isPos(buyPoint) || !stop || !isPos(stop.price)) return '停損：未持有且沒有標準買點，不提供停損數字';
  return `停損：若以標準買點 ${buyPoint} 進場，停損＝${stop.price}（與停損推播同口徑·${SOURCE_TEXT[stop.source] ?? SOURCE_TEXT.cost}）`;
}

/**
 * LLM 輸出的停損解析（llm-contract §1.1 解析順序）：先取 STOP_REF、再整行剝除，之後才交給 parseAction／parseTrigger／
 * parseRationale／parseSwing（兩支都擷取到全文結尾，不先剝除 STOP_REF 會落在正文尾端顯示給使用者）。
 */
export function splitStopRef(text) {
  const raw = String(text ?? '');
  // 模型常把格式範例的角括號原樣回傳（STOP_REF: <52.35>）——解析前先去掉（llm-contract §2-4）
  const unbracketed = raw.replace(/(STOP_REF\s*[:：]\s*)[<＜「]\s*([\d,]+(?:\.\d+)?)\s*[>＞」]/g, '$1$2');
  return { stopRef: parseStopRef(unbracketed), text: stripStopRef(raw) };
}

/**
 * 量測（measure，只記錄）：對每個欄位跑 T1–T5，比對對象可以有兩個——推播口徑停損（使用者現在看到的）與 v1.1 影子停損（llm-contract §4「S3 量測的比對對象」）。
 * expectRef：提示詞有沒有要求 STOP_REF。S3 影子期提示詞不變（不要求）⇒ 傳 false，T1（refMissing／refMismatch）不記——
 *   T1 從 S5 換提示詞起才有資料（llm-contract §4 上線三段）；預設 true（S5 起的呼叫端不用改）。
 * 回 { push: violations[], shadow: violations[]|null }；欄位不改。
 */
export function measureLlmStop(fields, { stop, shadowStop = null, refPrice = null, band = null, buyPoints = [], lastPrice = null, stopRef = null, isEtf = false, expectRef = true } = {}) {
  const ctx = { refPrice, band, buyPoints, lastPrice, stopRef, isEtf, mode: 'measure' };
  const keep = vs => (expectRef ? vs : vs.filter(v => v.rule !== 'T1'));
  const push = isPos(stop) ? keep(validateLlmStopText(fields, { ...ctx, stop }).violations) : [];
  const shadow = isPos(shadowStop) ? keep(validateLlmStopText(fields, { ...ctx, stop: shadowStop }).violations) : null;
  return { push, shadow };
}

/** 違規清單 → 計數（只放計數，供公開的 stopSpecAudit；不含代號與句子） */
export function llmViolationCounts(violations) {
  const out = {};
  for (const v of Array.isArray(violations) ? violations : []) if (v && typeof v.code === 'string') out[v.code] = (out[v.code] ?? 0) + 1;
  return out;
}
