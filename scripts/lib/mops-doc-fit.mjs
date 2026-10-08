// ─────────────────────────────────────────────────────────────────────────────
// mopsNews/{發言日} 日文件的大小保護（位元組）——daemon ingestMops 的唯一實作
//
// 依據：jev-score-usage-spec 附錄 B X18；plan B2-4 i；使用者 2026-10-08「其它錯誤依建議修正」。
// 為什麼：舊版以 `JSON.stringify(items).length > 900_000`（**字元數**）判斷；中文 UTF-8 約 3 bytes／字，
//   位元組先超過 Firestore 單檔 1,048,576 bytes、裁切來不及觸發 ⇒ 整份寫入失敗（季報／董事會截止日可達上千則）。
//   而舊的退路「只保留最新 300 則內文」本身就放不下（300 則×1,200 字×3 bytes ≈ 1.08 MB）。
// 做法：沿用 news-verdict-write.mjs 的 firestoreDocBytes（官方 Storage size 算法）估**整份文件**
//   （含這次寫的欄位、merge 後留著的舊欄位），超過 MOPS_DOC_SOFT_MAX 才裁：
//   依發言時間新→舊保留「放得下的最多則」內文（二分搜尋），其餘內文清成 null 並標 bodyTrimmed——
//   公告本身（主旨、時間、代號）一則不少。
// ⚠ 清內文只是**暫行退路**（審查 2026-10-08；plan B2-4 i 與「大文件壓縮＋分片」硬規則要的是不清內文）：
//   · 門檻貼近 Firestore 上限（1,048,576 − 8,576 bytes 估算餘量）＝只在「不清就寫不進去」時才清；
//     舊版字元數判斷能完整寫入的日子（位元組 900,000～門檻）不會被清，不比舊版退化。
//   · bodyTrimmed 記的是本版裁切章 MOPS_BODY_TRIM_TAG，不是永久旗標：同一版下放不下的內文不重抓（每輪抓了又清只是浪費 MOPS 額度）；
//     壓縮／分片上線時換章，舊章的列就會重抓回來（skipBodyRefetch）。壓縮／分片要讀者先部署，待使用者裁定排程。
//   連一則內文都不留仍放不下（主旨就超標）⇒ fits=false，交給寫入端記錯；不截斷主旨、不捏造。
// 格式不變（itemsJson 明文）：讀者有網站 after-market-news／mops-news route、戰情、分析師 pack、wiki、規則證據，
//   改壓縮或分片要所有讀者先部署——不在本次範圍（留給 B2-4 i 第二步）。
// 純函式；不改動輸入。單元測試 mops-doc-fit.test.mjs。
// ─────────────────────────────────────────────────────────────────────────────
import { firestoreDocBytes } from './news-verdict-write.mjs';

/** Firestore 單一文件上限（bytes） */
export const FIRESTORE_DOC_MAX = 1_048_576;
/** 裁內文門檻：貼近上限、只留 8,576 bytes 給估算誤差（firestoreDocBytes 照官方算法；超過才清——不清就寫不進去） */
export const MOPS_DOC_SOFT_MAX = 1_040_000;
/** 本版裁切章：清掉的內文標這個值；換裁切方式（壓縮／分片）時改章，舊章的列會被重抓 */
export const MOPS_BODY_TRIM_TAG = 'mops-trim-v1-bytes';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** 寫入端補內文時是否跳過這一則：只有本版裁切章才跳過（放不下的內文同版下不重抓）；舊值、別版的章、沒標的都照常補 */
export function skipBodyRefetch(x) {
  return isObj(x) && x.bodyTrimmed === MOPS_BODY_TRIM_TAG;
}

/**
 * @param {{ docPath: string, items: Record<string, object>, fields?: object, keep?: object|null, maxBytes?: number }} p
 *   items：key → 公告（含 at、body）；fields：這次 set 的其他欄位（不含 itemsJson）；keep：merge 前的舊文件（留著的欄位也算大小）
 * @returns {{ items, json: string, bytes: number, fits: boolean, keptBodies: number|null, clearedBodies: number }}
 *   keptBodies：沒裁時為 null；裁了為保留內文的則數
 */
export function fitMopsDayDoc({ docPath, items, fields = {}, keep = null, maxBytes = MOPS_DOC_SOFT_MAX }) {
  const kept = {};
  if (isObj(keep)) for (const [k, v] of Object.entries(keep)) if (k !== 'itemsJson' && !(k in fields)) kept[k] = v;
  const sizeOf = json => firestoreDocBytes(docPath, { ...kept, ...fields, itemsJson: json });

  const json0 = JSON.stringify(items);
  const bytes0 = sizeOf(json0);
  if (bytes0 <= maxBytes) return { items, json: json0, bytes: bytes0, fits: true, keptBodies: null, clearedBodies: 0 };

  // 有內文的公告依發言時間新→舊；保留前 k 則的內文
  const withBody = Object.values(items).filter(x => x && x.body).sort((a, b) => (b.at || 0) - (a.at || 0)).map(x => x.key);
  const build = k => {
    const keepSet = new Set(withBody.slice(0, k));
    const out = {};
    // 清掉的標 bodyTrimmed＝本版裁切章：同一版下寫入端不再重抓這些放不下的內文（否則每輪都花 MOPS 內文額度抓了又清）
    for (const [key, x] of Object.entries(items)) out[key] = x && x.body && !keepSet.has(key) ? { ...x, body: null, bodyTrimmed: MOPS_BODY_TRIM_TAG } : x;
    const json = JSON.stringify(out);
    return { out, json, bytes: sizeOf(json) };
  };
  // 二分搜尋最大的 k（內文越多越大，單調）
  let lo = 0, hi = withBody.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = build(mid);
    if (r.bytes <= maxBytes) { best = { k: mid, ...r }; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) {
    const r = build(0);
    return { items: r.out, json: r.json, bytes: r.bytes, fits: false, keptBodies: 0, clearedBodies: withBody.length };
  }
  return { items: best.out, json: best.json, bytes: best.bytes, fits: true, keptBodies: best.k, clearedBodies: withBody.length - best.k };
}
