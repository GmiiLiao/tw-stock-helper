// ─────────────────────────────────────────────────────────────────────────────
// LLM 輸出的數字校驗（從 ai-daemon.mjs 抽出·WM-SCAN G2-25·2026-10-04）
//
//   把回答裡「有單位的數字」逐一比對來源資料，對不上就是編造的。
//   2026-08-31 起分析類（每日分析、個股分析、波段分析、交易覆盤）只寫 log 不改輸出（量測模式），
//   誤報率量到 3% 後，使用者 2026-10-04 裁定：**改為在輸出上標示**——和問AI 同一句提示，
//   讓使用者看得到哪些數字查不到。
//
//   標示格式＝純文字尾段（前端四個消費端都是 whiteSpace: pre-wrap 純文字渲染，
//   StockAIEval／PortfolioSummary／PortfolioTradeReview／PremarketBrief），不新增欄位。
//   ⚠ 標示會把查不到的數字原樣寫進文字；stockAI.swing 會被 daemon 問AI 的 buildQAContext 再餵回提示詞，
//     若不先 stripNumberMark，這些數字就會出現在問AI 的語料裡、讓問AI 的校驗誤判為「可查證」。
// ─────────────────────────────────────────────────────────────────────────────

/** 標示句首——與問AI（daemon processQuestions）既有字樣相同，前端與使用者只需認一種 */
export const NUMBER_MARK_LEAD = '⚠ 下列數字未能在提供的資料中查證，請勿採信：';
const MARK_SEP = '\n\n';
/** 標示最多列幾個數字（與問AI 相同） */
export const NUMBER_MARK_MAX = 5;

/**
 * mode='quote'：模型**只該引用**資料（問AI）⇒ 驗完整單位集，含元/張/點。
 * mode='derive'：模型**本來就會算**（分析路徑會給目標價、停損、部位張數）
 *   ⇒ 只驗事實型單位（%/倍/億/萬），否則誤報會蓋掉真警訊。
 * 分界是量出來的（2026-08-31，400 次分析輸出）：查不到的數字裡 元146/張74/點5＝算出來的，
 *   億13/萬5/%4＝引用型。全單位集誤報率 20%，只看事實型降到 3%。
 * ⚠ 只驗有單位的數字。純序號、年份、條列編號不算。
 * @returns {string[]} 查不到的數字（去重、保留出現順序）
 */
export function unverifiedNumbers(answer, sourceText, mode = 'quote') {
  const norm = t => String(t || '').replace(/[,，\s]/g, '');
  const corpus = norm(sourceText);
  const re = mode === 'derive'
    ? /\d+(?:\.\d+)?(?:%|％|倍|億|萬)/g
    : /\d+(?:\.\d+)?(?:%|％|倍|億|萬|元|張|點)/g;
  const nums = [...new Set(norm(answer).match(re) || [])];
  return nums.filter(n => !corpus.includes(n) && !corpus.includes(n.replace(/％/, '%')));
}

/**
 * 截斷到 maxLen，並在有查不到的數字時於尾端加標示。標示一定保留（先讓出空間再截內文），
 * 否則舊寫法 `.slice(0, 900)` 會把尾段標示截掉、等於沒標。
 * @param {string} text  已 trim 的輸出
 * @param {string[]} bad unverifiedNumbers 的結果
 * @param {number} maxLen 欄位既有長度上限
 */
export function markUnverified(text, bad, maxLen) {
  const body = String(text || '');
  if (!Array.isArray(bad) || !bad.length) return body.slice(0, maxLen);
  const note = `${MARK_SEP}${NUMBER_MARK_LEAD}${bad.slice(0, NUMBER_MARK_MAX).join('、')}`;
  if (note.length >= maxLen) return note.trim().slice(0, maxLen);
  return body.slice(0, maxLen - note.length).trimEnd() + note;
}

/** 移除 markUnverified 加上的尾段（把 daemon 自己的輸出再餵回提示詞前用） */
export function stripNumberMark(text) {
  const s = String(text ?? '');
  const i = s.indexOf(NUMBER_MARK_LEAD);
  return i < 0 ? s : s.slice(0, i).trimEnd();
}
