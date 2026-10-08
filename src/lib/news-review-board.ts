// ─────────────────────────────────────────────────────────────────────────────
// 新聞判別對答案（newsVerdictReview/summary）的盤中前視加註——網站顯示的唯一實作（X16 網站端；審查 2026-10-08）
//
// 依據：jev-score-usage-spec 附錄 B X16「舊板加註『含盤中前視 x% 列』…加註下一次網站部署」；反證 S8。
// 背景：舊板口徑「昨收→今開」要求判讀在開盤前就存在，但適用日文件混有盤中趟（開盤後才產生）的判讀，數字偏樂觀。
//   daemon（computeNewsVerdictReview）重啟後在 summary 多寫：
//   · lookahead：舊板列中開盤後產生的比例（pct）與說明（note）；
//   · preOpen：只收適用日 09:00 前判讀的新板（boardVersion nvr-v2-preopen-0900），新舊板分開、歷史數字不覆蓋。
// 讀者：戰情室軋空面板 SqueezePanel（/api/ai/news-verdict-review 唯一網站讀者）。
// 舊文件（daemon 尚未重算）沒有這兩組欄位：照樣加註「含盤中前視列」，但不寫數字（不捏造比例）、不顯示新板。
// 本檔不 import 任何東西（scripts/lib/news-review-board.test.mjs 直接以 Node 型別剝除載入）。
// ─────────────────────────────────────────────────────────────────────────────

export interface ReviewStat { n: number; mean: number | null; win: number | null }
export interface ReviewLookahead { rows: number; preOpen: number; postOpen: number; unknownTime: number; pct: number | null; note?: string }
export interface ReviewBoard {
  boardVersion?: string; basis?: string; days: number;
  bull: ReviewStat; neutral: ReviewStat; bear: ReviewStat; newsLift: number | null; conclusive?: boolean;
}
export interface ReviewSummaryLike { boardVersion?: string; lookahead?: ReviewLookahead | null; preOpen?: ReviewBoard | null }

const GENERIC_DETAIL = '本板含開盤後才產生的盤中趟判讀（對「昨收→今開」屬前視，數字偏樂觀）；比例與只收 09:00 前判讀的新板待 daemon 下次重算後顯示';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStat = (v: unknown): v is ReviewStat => isObj(v) && typeof v.n === 'number';

/** 舊板短加註：有 lookahead 照實寫比例；沒有可對答案的列不加註；舊文件寫「含盤中前視列」不帶數字 */
export function lookaheadBadge(r: ReviewSummaryLike | null | undefined): string {
  const la = r?.lookahead;
  if (isObj(la)) {
    if (typeof la.pct === 'number' && Number.isFinite(la.pct)) return `含盤中前視 ${la.pct}% 列`;
    if (la.rows === 0) return '';
  }
  return '含盤中前視列';
}

/** 舊板長說明（明細與提示框用）：daemon 的 note 優先；舊文件給通用說明 */
export function lookaheadDetail(r: ReviewSummaryLike | null | undefined): string {
  const note = r?.lookahead?.note;
  return typeof note === 'string' && note ? note : GENERIC_DETAIL;
}

/** 新板（只收適用日 09:00 前判讀）：形狀完整才回傳，否則 null（舊文件不顯示） */
export function preOpenBoardOf(r: ReviewSummaryLike | null | undefined): ReviewBoard | null {
  const p = r?.preOpen;
  if (!isObj(p) || typeof p.days !== 'number' || !isStat(p.bull) || !isStat(p.neutral) || !isStat(p.bear)) return null;
  return p;
}
