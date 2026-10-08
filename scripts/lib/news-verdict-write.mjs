// ─────────────────────────────────────────────────────────────────────────────
// newsVerdict 文件的寫入大小保護——寫入端唯一實作（daemon 四個寫入點共用：夜補、盤中、盤後／晨間的分段與最終存檔、latest；2026-10-08）
//
// 為什麼：2026-10-07 盤後趟 newsVerdict/2026-10-08 的 verdictJson＋seenJson 超過 Firestore 單檔 1,048,576 bytes，
//   舊保護（fitVerdictJson：只估 verdictJson＋seenJson 的字串長度、只會拿掉稽核軌跡）擋不住 ⇒ 整趟寫入失敗（詳見 news-verdict-codec.mjs 檔頭）。
// 做法：以「實際序列化後的位元組」估整份文件（含所有欄位名、Firestore 每欄／每文件開銷、merge 後留著的舊欄位），
//   超過安全門檻 NV_DOC_SOFT_MAX 就依序降級，直到放得下——**保證不會因大小寫入失敗**：
//   日文件（archive：適用日的存檔，對答案／分析師團隊／停損影子／明日承接都讀它）：先無損、後有損——
//     plain     明文 verdictJson＋seenJson（相容尚未更新的讀取端；放得下就一律用這個）
//     seen-gz   已見標題改壓縮 seenGz
//     gz        判別表也改壓縮 verdictGz
//     gz-text   ＋稽核軌跡去文字欄（留鍵、狀態、事件日期）
//     gz-noev   ＋稽核軌跡整段拿掉（ruleFacts、ruleTrail 照留）
//     seen-trim ＋已見標題每檔只留最近 NV_SEEN_TRIM 則
//     seen-drop ＋已見標題整份不存（下一趟會重判那些標題，只是多花 Ollama）
//     drop-old  ＋丟掉最舊的判別（承接來的先丟）直到放得下（最後手段；記 log）
//   latest（display：網站與盤中讀者的顯示副本；沒有 seen）：相容優先——
//     plain → text（去證據文字）→ noev（拿掉證據）→ gz-noev（壓縮；網站讀者要部署新版才讀得到）→ drop-old
//     （日文件保有完整證據，latest 只是副本，所以先犧牲證據、最後才壓縮。）
// 寫入端寫壓縮欄位時要把同名明文欄位刪掉（回傳 clear；merge 寫入時換成 FieldValue.delete()），反之亦然——
//   否則 merge 會把舊的明文 seenJson 留在文件裡，照樣超過上限。
// 純函式（只用 node:zlib 經 codec）；不碰網路、不讀時鐘。單元測試 news-verdict-write.test.mjs。
// ─────────────────────────────────────────────────────────────────────────────
import { gzB64 } from './news-verdict-codec.mjs';
import { slimRuleEvidence } from './news-rule-evidence.mjs';

/** 安全門檻：估計值超過就降級（上限 1,048,576；留約 14% 給估算誤差與其他寫入端加的小欄位） */
export const NV_DOC_SOFT_MAX = 900_000;
/** seen-trim 等級每檔留的已見標題數（平常上限 90） */
export const NV_SEEN_TRIM = 30;
/** 這支管理的四個大欄位（每次寫入都明確寫入或刪除，不靠 merge 留舊值） */
export const NV_MANAGED_FIELDS = Object.freeze(['verdictJson', 'verdictGz', 'seenJson', 'seenGz']);
/** 降級等級的中文說明（log 用） */
export const NV_LEVEL_TEXT = Object.freeze({
  plain: '明文', 'seen-gz': '已見標題壓縮', gz: '判別表與已見標題皆壓縮', 'gz-text': '壓縮＋稽核軌跡去文字欄',
  'gz-noev': '壓縮＋稽核軌跡拿掉', 'seen-trim': `壓縮＋已見標題每檔只留 ${NV_SEEN_TRIM} 則`, 'seen-drop': '壓縮＋已見標題不存',
  text: '稽核軌跡去文字欄', noev: '稽核軌跡拿掉', 'drop-old': '丟掉最舊的判別',
});
/** 有損等級（日文件從 gz-text 起、latest 從 text 起）——寫入端用它決定 log 用 ⚠ 還是一般訊息 */
export const NV_LOSSY_LEVELS = Object.freeze(new Set(['gz-text', 'gz-noev', 'seen-trim', 'seen-drop', 'text', 'noev', 'drop-old']));

const utf8 = s => Buffer.byteLength(s, 'utf8');
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 一個欄位值在 Firestore 的儲存大小（官方「Storage size calculations」）：字串＝UTF-8 位元組＋1、數字 8、布林 1、null 1、
 * 時間戳 8、Bytes＝長度、陣列＝元素和、map＝Σ(鍵 UTF-8＋1＋值)。
 */
export function firestoreValueBytes(v) {
  if (v === null || v === undefined) return 1;
  switch (typeof v) {
    case 'string': return utf8(v) + 1;
    case 'boolean': return 1;
    case 'number': case 'bigint': return 8;
    case 'object': {
      if (v instanceof Uint8Array) return v.length;
      if (v instanceof Date || typeof v.toDate === 'function') return 8;
      if (Array.isArray(v)) return v.reduce((a, x) => a + firestoreValueBytes(x), 0);
      return Object.entries(v).reduce((a, [k, x]) => a + utf8(k) + 1 + firestoreValueBytes(x), 0);
    }
    default: return 8;
  }
}

/** 整份文件大小：文件名（每段 UTF-8＋1，再＋16）＋Σ欄位（欄位名 UTF-8＋1＋值）＋32 */
export function firestoreDocBytes(docPath, fields) {
  const name = String(docPath).split('/').filter(Boolean).reduce((a, s) => a + utf8(s) + 1, 0) + 16;
  return name + Object.entries(fields || {}).reduce((a, [k, v]) => a + utf8(k) + 1 + firestoreValueBytes(v), 0) + 32;
}

/** merge 寫入後還會留在文件裡的舊欄位（不是這次寫的、也不是四個大欄位） */
function keptFields(keep, written) {
  if (!isObj(keep)) return {};
  const out = {};
  for (const [k, v] of Object.entries(keep)) if (!NV_MANAGED_FIELDS.includes(k) && !(k in written)) out[k] = v;
  return out;
}

const ARCHIVE_STEPS = Object.freeze([
  { level: 'plain', ev: 'full', vGz: false, seen: 'plain' },
  { level: 'seen-gz', ev: 'full', vGz: false, seen: 'gz' },
  { level: 'gz', ev: 'full', vGz: true, seen: 'gz' },
  { level: 'gz-text', ev: 'text', vGz: true, seen: 'gz' },
  { level: 'gz-noev', ev: 'all', vGz: true, seen: 'gz' },
  { level: 'seen-trim', ev: 'all', vGz: true, seen: 'trim' },
  { level: 'seen-drop', ev: 'all', vGz: true, seen: 'none' },
]);
const DISPLAY_STEPS = Object.freeze([
  { level: 'plain', ev: 'full', vGz: false, seen: 'none' },
  { level: 'text', ev: 'text', vGz: false, seen: 'none' },
  { level: 'noev', ev: 'all', vGz: false, seen: 'none' },
  { level: 'gz-noev', ev: 'all', vGz: true, seen: 'none' },
]);

/** 丟判別的順序：承接來的（carriedFrom）先、再依判別時刻由舊到新、同時刻依代號 */
function dropOrder(verdicts) {
  const carried = c => (verdicts[c]?.carriedFrom ? 1 : 0);
  const at = c => (Number.isFinite(verdicts[c]?.at) ? verdicts[c].at : 0);
  return Object.keys(verdicts).sort((a, b) => (carried(b) - carried(a)) || (at(a) - at(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 判別表（＋已見標題）→ 這次要寫的大欄位。
 * @param {object} o
 * @param {string} o.docPath  例 'newsVerdict/2026-10-09'（文件名也算進大小）
 * @param {Record<string, any>} o.verdicts  判別表（不會被改動）
 * @param {Record<string, string[]> | null} [o.seen]  已見標題（latest 不傳）
 * @param {Record<string, unknown>} [o.meta]  同一次寫入的其他欄位（算進大小）
 * @param {Record<string, unknown> | null} [o.keep]  merge 寫入前文件既有的欄位（沒被這次覆寫的會留著，算進大小）
 * @param {boolean} [o.archive]  true＝日文件（無損優先）；false＝latest（相容優先）
 * @param {number} [o.maxBytes]
 * @returns {{ fields: Record<string, unknown>, clear: string[], level: string, bytes: number, dropped: number, lossy: boolean }}
 *   fields：要寫的大欄位＋sizeLevel；clear：要刪掉的大欄位（merge 寫入時換成 FieldValue.delete()）
 */
export function fitNewsVerdictDoc({ docPath, verdicts, seen = null, meta = {}, keep = null, archive = true, maxBytes = NV_DOC_SOFT_MAX }) {
  const v0 = isObj(verdicts) ? verdicts : {};
  const hasSeen = archive && isObj(seen);
  const evCache = {};
  const evOf = ev => (evCache[ev] ??= ev === 'full' ? v0 : slimRuleEvidence(v0, ev));
  const seenCache = {};
  const seenOf = mode => {
    if (!hasSeen || mode === 'none') return null;
    if (seenCache[mode] !== undefined) return seenCache[mode];
    const src = mode === 'trim'
      ? Object.fromEntries(Object.entries(seen).map(([c, t]) => [c, Array.isArray(t) ? t.slice(-NV_SEEN_TRIM) : t]))
      : seen;
    const json = JSON.stringify(src);
    return (seenCache[mode] = mode === 'plain' ? { seenJson: json } : { seenGz: gzB64(json) });
  };
  const build = (step, vObj) => {
    const vJson = JSON.stringify(vObj);
    const fields = { ...(step.vGz ? { verdictGz: gzB64(vJson) } : { verdictJson: vJson }), ...(seenOf(step.seen) || {}), sizeLevel: step.level };
    const written = { ...meta, ...fields };
    const bytes = firestoreDocBytes(docPath, { ...keptFields(keep, written), ...written });
    return { fields, bytes };
  };
  const finish = (step, r, dropped = 0, level = step.level) => {
    const fields = { ...r.fields, sizeLevel: level };
    return {
      fields, clear: NV_MANAGED_FIELDS.filter(k => !(k in fields)), level, bytes: r.bytes, dropped,
      lossy: NV_LOSSY_LEVELS.has(level),
    };
  };

  // 沒有 seen（latest，或日文件意外沒帶）：與 seen 有關的等級和前一級相同，去重
  const steps = [];
  for (const st of (archive ? ARCHIVE_STEPS : DISPLAY_STEPS)) {
    const s = hasSeen ? st : { ...st, seen: 'none' };
    if (!steps.some(x => x.ev === s.ev && x.vGz === s.vGz && x.seen === s.seen)) steps.push(s);
  }
  let last = null, lastStep = null;
  for (const s of steps) {
    const r = build(s, evOf(s.ev));
    last = r; lastStep = s;
    if (r.bytes <= maxBytes) return finish(s, r);
  }
  // 最後手段：丟最舊的判別（每輪少一成，直到放得下；到 0 筆一定放得下，除非 meta／keep 本身就超過——那不是這支能救的）
  const slim = evOf(lastStep.ev);
  const order = dropOrder(slim);
  let n = order.length;
  while (n > 0) {
    n = Math.floor(n * 0.9);
    const kept = Object.fromEntries(order.slice(order.length - n).map(c => [c, slim[c]]));
    const r = build({ ...lastStep, level: 'drop-old' }, kept);
    last = r;
    if (r.bytes <= maxBytes || n === 0) return finish(lastStep, r, order.length - n, 'drop-old');
  }
  return finish(lastStep, last, order.length, 'drop-old');
}
