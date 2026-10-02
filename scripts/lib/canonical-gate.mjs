// ─────────────────────────────────────────────────────────────────────────────
// 定版記錄閘門（2026-10-02 使用者：「依確實取得與驗證檔案後，進行後續」；「修正已查到的缺失漏洞，補強它不要再發生」）
//
//   事前存檔／當日記錄（picksHistory/{日}、shortCandidates/{日}、limitUpForecast/pred-{日}…）是「寫一次、之後拿來對答案」的資料。
//   舊版以時鐘為準（15:10 排程第一個寫的贏），實測：
//     · 15:10 時收盤歸檔只有上市（上櫃官方日檔 16:07–16:49 才併入，09-24 晚到 21:37；上市法人 T86 16:11–16:37）
//       ⇒ 9 月起每一份漲停預測存檔 pred-{日} 都不含任何上櫃股，記分板一直只評上市。
//     · 開機、盤中刷新都會再寫一次：重啟會把定版記錄蓋成較晚／殘缺的版本；做空候選盤中每 10 分鐘改寫前一日事前存檔（偷看答案）。
//   這裡是純函式（判斷）；讀寫 Firestore 在 ai-daemon.mjs。
// ─────────────────────────────────────────────────────────────────────────────

/** 上市權值樣本（必在 STOCK_DAY_ALL 與 T86）——與 archiveChipDaily 的 hasTseInst 同一組 */
export const TSE_SAMPLES = ['2330', '2317', '2454', '2882'];
/** 上櫃樣本——與 archiveChipDaily 的 hasOtcInst 同一組 */
export const OTC_SAMPLES = ['6274', '8069', '3260', '5347', '3105'];

const parse = s => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const has = (m, codes, need) => !!m && codes.filter(c => m[c]).length >= need;

/**
 * 收盤歸檔 chipArchive/{日} 是否「兩市都確實取得並驗證」：
 *   上市收盤（STOCK_DAY_ALL 依資料自報日期歸檔）、上櫃收盤（otcPending=false＝寫入端回聲驗證日期後併入）、
 *   上市法人（T86）、上櫃法人（TPEx）。日期驗證由寫入端負責；這裡只判斷「該有的都進來了沒」。
 * 樣本股容許個別停牌（收盤 3/4、3/5；法人各至少 1 檔，同寫入端判定）；上櫃收盤另接受「總檔數 ≥ 1,700」（上市約 1,230 檔，
 * 不含上櫃不可能到這個數）——樣本股日後下市／轉板時閘門不會因此永久關閉。
 * basis：上櫃收盤若由缺漏掃描以第三方（Yahoo）補上（gapFixSource 含 yahoo），記為非官方，供定版記錄註明。
 * @returns {{ ready: boolean, missing: string[], basis: string }}
 */
export function archiveDayStatus(doc) {
  const close = parse(doc?.closeJson), inst = parse(doc?.instJson);
  const missing = [];
  if (!has(close, TSE_SAMPLES, 3)) missing.push('上市收盤');
  // otcPending 只有明確為 true 才算未併入：寫入端一律寫布林值；undefined＝此旗標出現前（2026-07-17 以前）的舊檔，實測皆兩市完整
  if (doc?.otcPending === true || !(has(close, OTC_SAMPLES, 3) || Object.keys(close || {}).length >= 1700)) missing.push('上櫃收盤');
  if (!has(inst, TSE_SAMPLES, 1)) missing.push('上市法人');
  if (!has(inst, OTC_SAMPLES, 1)) missing.push('上櫃法人');
  const basis = /yahoo/i.test(String(doc?.gapFixSource || '')) ? '上市官方＋上櫃含第三方補洞' : '兩市官方';
  return { ready: missing.length === 0, missing, basis };
}

/** 只看收盤（上市＋上櫃已併入）——到期評估只需要收盤價，不必等法人（審查 M-a） */
export function archiveCloseReady(doc) {
  const m = archiveDayStatus(doc).missing;
  return !m.includes('上市收盤') && !m.includes('上櫃收盤');
}

/**
 * 定版記錄要不要寫：
 *   未到齊 → 不寫（--force 也不行）；已過下一個交易日開盤 → 不寫（事前存檔＝偷看答案）；
 *   已定版（有 canonicalAt）→ 不覆蓋，除非 --force；修正前的舊檔（無 canonicalAt）→ 到齊後以完整版補成定版。
 * @returns {'write'|'skip-not-ready'|'skip-after-open'|'skip-exists'}
 */
export function canonicalDecision({ existing, ready, force = false, open = true }) {
  if (!ready) return 'skip-not-ready';
  if (!open) return 'skip-after-open';
  if (existing?.canonicalAt && !force) return 'skip-exists';
  return 'write';
}

/**
 * 現在是否仍在 dataDate 之後「下一個交易日 08:30（試撮）」之前。
 * nowTw＝台北時間 'YYYY-MM-DDTHH:MM'；isTradingDayIso(YYYY-MM-DD)＝是否交易日（含休市日曆）。
 */
export function beforeNextOpen(dataDate, nowTw, isTradingDayIso) {
  const d = new Date(`${dataDate}T00:00:00Z`);
  for (let i = 0; i < 20; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (isTradingDayIso(iso)) return nowTw < `${iso}T08:30`;
  }
  return false;   // 20 天內找不到交易日＝日曆異常 ⇒ 保守不寫
}

/** 日期存檔「不可變薄」：新版筆數少於既有 98% 視為某來源失敗，不覆蓋（null＝尚無既有檔） */
export function neverThinner(existingN, newN) {
  if (existingN == null) return true;
  return newN >= existingN * 0.98;
}
