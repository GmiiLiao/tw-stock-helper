// 外資台指期未平倉文件（taifexPositions/latest）的口徑版本——零相依，網站前端（client bundle）、戰情室、daemon 共用（2026-10-08）。
//   v2＝期交所三大法人（區分各期貨契約）臺股期貨×外資及陸資 多方未平倉口數−空方未平倉口數（口）。
//   沒有 basisVersion 的舊文件＝舊口徑（外資及陸資 23 種期貨「交易」口數淨額合計，錯值；沒有歷史可修）⇒ 讀者不可把它當未平倉顯示。
//   寫入端與解析：scripts/lib/taifex-positions.mjs。
export const TAIFEX_POSITIONS_BASIS = 'txf-foreign-oi-v2';

/** 文件的 foreignTxfNetOI 是否為現行口徑 */
export const isCurrentTaifexBasis = doc => !!doc && typeof doc === 'object' && doc.basisVersion === TAIFEX_POSITIONS_BASIS;
