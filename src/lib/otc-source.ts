// ============================================================
// 上櫃收盤第三方後備的「來源註記」旗標（server／client 共用、零 import）
//
// 使用者 2026-10-09 裁定（實際頻率 a）：後備資料上站；**只在用到後備的那一天**，在上櫃相關數據旁加一行小字，
//   平常網站完全不出現來源字樣。註記文字只放在 src/components/shared/ThirdPartyNote.tsx。
//
// 旗標與數據同源（不會在官方覆蓋後殘留）：
//   - 列：getStockDayAllDataInternal 的上櫃列在 tpexClose 文件 grade≠official 時帶 _grade（twse-api-server.ts；兩個出口都帶）。
//   - API：由「這次回應實際用到的列」算出 otcSource，跟數據放在同一個 body ⇒ 同一份 CDN 快取、同一份 memoize 結果；
//     daemon 之後以官方整份覆蓋 tpexClose/latest，下一次算出的 body 自然沒有旗標，不另存狀態。
//   - stock-day-all 是陣列（舊形狀不動），旗標就是列上的 _grade；前端 parseStockDayData 原樣帶成 StockInfo.otcGrade。
// 判斷口徑與 scripts/lib/tpex-close-parse.mjs 的 isThirdPartyRow 相同：_grade 有值且不是 'official'。
// 測試：node --test scripts/lib/otc-source-note.test.mjs
// ============================================================

/** 第三方後備的等級代號（tpexClose 文件 grade／列上 _grade；scripts/lib/tpex-close-finmind.mjs THIRD_PARTY.grade） */
export const OTC_THIRD_PARTY_GRADE = '3P';

/** API 回應的頂層旗標：只在當次回應用到第三方後備列時出現；沒有＝全官方（或沒有上櫃列） */
export interface OtcSource {
  /** 列上的 _grade 原樣（目前只有 '3P'） */
  grade: string;
  /** 第三方後備列自報的資料日 YYYY-MM-DD；列上日期認不得＝null（不捏造） */
  dataDate: string | null;
}

interface GradedRow {
  _grade?: unknown;
  Date?: unknown;
}

/** 等級是否為第三方（有值且不是 official） */
export function isThirdPartyGrade(g: unknown): boolean {
  return typeof g === 'string' && g !== '' && g !== 'official';
}

/** 民國 YYYMMDD 或 YYYY-MM-DD → YYYY-MM-DD；認不得回 null */
function isoOf(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  const roc = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  const iso = roc ? `${Number(roc[1]) + 1911}-${roc[2]}-${roc[3]}` : s;
  return /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(iso) ? iso : null;
}

/** 這批列有第三方後備列 ⇒ { grade, dataDate }（資料日取第一個認得的第三方列）；全官方／空 ⇒ null */
export function otcSourceOf(rows: ReadonlyArray<GradedRow | null | undefined>): OtcSource | null {
  let grade: string | null = null;
  for (const r of rows) {
    if (!r || !isThirdPartyGrade(r._grade)) continue;
    grade ??= String(r._grade);
    const dataDate = isoOf(r.Date);
    if (dataDate) return { grade, dataDate };
  }
  return grade ? { grade, dataDate: null } : null;
}

/** 回應 body 用：有第三方列 ⇒ { otcSource }；沒有 ⇒ {}（展開進 body，官方回應連鍵都沒有，舊形狀不變） */
export function otcSourceField(rows: ReadonlyArray<GradedRow | null | undefined>): { otcSource?: OtcSource } {
  const s = otcSourceOf(rows);
  return s ? { otcSource: s } : {};
}

/** 物件 → OtcSource；形狀不符或不是第三方回 null */
function otcSourceShape(v: unknown): OtcSource | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { grade?: unknown; dataDate?: unknown };
  if (!isThirdPartyGrade(o.grade)) return null;
  return { grade: String(o.grade), dataDate: isoOf(o.dataDate) };
}

/** 前端：從 API 回應（或 Firestore 存檔）讀頂層 otcSource；沒有／形狀不符回 null */
export function readOtcSource(body: unknown): OtcSource | null {
  if (!body || typeof body !== 'object') return null;
  return otcSourceShape((body as { otcSource?: unknown }).otcSource);
}

/** 前端：盤勢報告（marketReports）的 meta.otc.grade／dataDate */
export function readReportOtcSource(report: unknown): OtcSource | null {
  if (!report || typeof report !== 'object') return null;
  const meta = (report as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return null;
  return otcSourceShape((meta as { otc?: unknown }).otc);
}

/** 前端 allStocks（StockInfo.otcGrade）是否含第三方後備列；StockInfo 沒有資料日 ⇒ dataDate null */
export function otcSourceOfStocks(stocks: ReadonlyArray<{ otcGrade?: string } | null | undefined>): OtcSource | null {
  for (const s of stocks) {
    if (s && isThirdPartyGrade(s.otcGrade)) return { grade: String(s.otcGrade), dataDate: null };
  }
  return null;
}

/**
 * 前端：只看「沒有即時價、改用 allStocks 收盤列」的代號（持股市值、決策工作台、法人表的現價欄）。
 *   hasOwnPrice(code)＝這檔畫面上的價格來自自己的即時報價（不是 allStocks）；條件要與呼叫端實際取價一致。
 *   有即時價的那幾檔不看 allStocks 的列 ⇒ 不因它是後備列而加註。
 */
export function otcSourceOfFallbackRows(
  codes: ReadonlyArray<string>,
  hasOwnPrice: (code: string) => boolean,
  stocks: ReadonlyArray<{ code: string; otcGrade?: string } | null | undefined>,
): OtcSource | null {
  const fallback = new Set(codes.filter(c => !hasOwnPrice(c)));
  if (fallback.size === 0) return null;
  return otcSourceOfStocks(stocks.filter(s => s != null && fallback.has(s.code)));
}

/**
 * 前端：整份回應的旗標（例：/api/rating 全市場 otcSource）只套到「畫面上真的有上櫃股」的區塊。
 *   評分是逐檔用自己那一列算的——清單全是上市股時，這些數字沒用到上櫃資料，不加註。
 *   isOtc 只用來判斷市場別（靜態屬性）；旗標本身仍取自同一次回應（與數據同源）。
 */
export function otcSourceIfShowsOtc(
  source: OtcSource | null | undefined,
  codes: Iterable<string>,
  isOtc: (code: string) => boolean,
): OtcSource | null {
  if (!source || !shouldShowOtcNote(source)) return null;
  for (const c of codes) if (isOtc(c)) return source;
  return null;
}

/** 註記要不要顯示：只認第三方後備（3P）——其他等級不是同一個來源，不套這行字 */
export function shouldShowOtcNote(source: OtcSource | null | undefined): boolean {
  return source?.grade === OTC_THIRD_PARTY_GRADE;
}
