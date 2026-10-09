// ─────────────────────────────────────────────────────────────────────────────
// chipArchive 視窗對齊「列資料日」（2026-10-03）
//
//   readArchive 回傳新→舊、而且**不排除當日**：15:10 收盤歸檔寫入後 arch[0] 就是今天。
//   把 arch[0] 當「昨收」、arch[0..19] 當「前 20 日」的寫法，盤中（歸檔還沒有今天）是對的；
//   收盤後、開機、週末就整段多算進一天——昨收＝今日收盤（漲幅恆 0%）、前 20 日高已含今天（突破恆不成立）。
//   實案：撿尾盤 close 版自 2026-07-17 14:34 起每一輪都是 0 檔（275 輪）。07-17 之前收盤歸檔以「執行日」
//   戳記，doc D 裝的是 D-1 收盤，這個錯位恰好把它抵銷；07-17 改依 CSV 自報資料日歸檔（正確）後就露餡。
//   對齊基準一律用列資料**自報**的資料日（STOCK_DAY_ALL 民國首欄、快照 dataDate），不用日曆日。
//   這裡是純函式；讀 Firestore 在 ai-daemon.mjs。
// ─────────────────────────────────────────────────────────────────────────────

/** 'YYYYMMDD'（rocToYmd 輸出）或 'YYYY-MM-DD' → 'YYYY-MM-DD'；其餘 null */
export function toIsoDate(s) {
  const t = String(s ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return null;
}

/**
 * 只留資料日早於 dataDate 的歸檔（新→舊順序不變、不改原陣列）。
 * dataDate 缺就回空——呼叫端應棄權，不可退回未對齊的視窗。
 * @param {{date: string}[]} arch 新→舊
 * @param {string|null} dataDate 'YYYY-MM-DD'
 */
export function archiveBefore(arch, dataDate) {
  if (!dataDate) return [];
  return arch.filter(a => a?.date && a.date < dataDate);
}

/** 新→舊的歸檔裡，資料日 ≥ dataDate 的前導筆數（＝要跳過幾筆才是 dataDate 之前的交易日） */
export function leadingOnOrAfter(arch, dataDate) {
  let n = 0;
  while (n < arch.length && arch[n]?.date >= dataDate) n++;
  return n;
}

/**
 * 撿尾盤基準：昨收＝maps[0]、近 20 日最高收盤＝maps[0..19]、5 日均量＝maps[0..4]（張，量 0 不計）。
 * maps 必須已用 archiveBefore 對齊到「列資料日之前」（新→舊，每筆 {code:[收, 量張, …]}）。
 */
export function tailBaselines(maps) {
  const hi20 = {}, avgVol = {}, prevClose = {};
  const allCodes = new Set(); for (const m of maps) for (const k in m) allCodes.add(k);
  for (const code of allCodes) {
    let h = 0, vs = 0, vn = 0;
    for (let k = 0; k < 20; k++) { const row = maps[k]?.[code]; if (!row) continue; if (row[0] > h) h = row[0]; if (k < 5 && row[1] > 0) { vs += row[1]; vn++; } }
    hi20[code] = h; avgVol[code] = vn ? vs / vn : 0; prevClose[code] = maps[0]?.[code]?.[0] || 0;
  }
  return { hi20, avgVol, prevClose };
}

/**
 * 新一輪榜單的資料日是否早於現存榜（例：14:00 開機時 STOCK_DAY_ALL 尚未換日，不可拿昨天的榜蓋掉今天的盤中榜）。
 * 現存榜的資料日：有 dataDate 用 dataDate；舊版無此欄位時只有盤中榜（source='live'）的 date 等於資料日，
 * 舊版收盤榜的 date 是日曆日（週末會寫成週六），無法比較 ⇒ 視為未知、不擋。
 */
export function olderThanCurrent(existing, nextDataDate) {
  const cur = existing?.dataDate ?? (existing?.source === 'live' ? existing?.date : null);
  return !!cur && nextDataDate < cur;
}
