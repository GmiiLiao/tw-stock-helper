// ─────────────────────────────────────────────────────────────────────────────
// 槽位語法（契約 §4；規格 04 §3.1）：LLM 不准自己打數字。
//   {{ref|fmt}}   值槽位：程式依 pack.refs[ref].v 與固定格式填值；LLM 寫的 |fmt 若與 pack 預設不同＝badFmt（R16）。
//   [ref:id]      引用標記：宣告該句依據但不填值（渲染時移除，前端以證據晶片呈現）。
//   純函式、零 IO、零網路。
// ─────────────────────────────────────────────────────────────────────────────
import { FMTS, MISSING_TEXT, MARK_TIERS, TIERS, tierIndex, lowestTier, clampDerivedTier, tierMark, isIsoDate, mdOf } from './constants.mjs';

// 值槽位（可帶緊接的 % ：pct0 自帶 % 時吃掉重複的那個）
const SLOT_SRC = String.raw`\{\{\s*([^{}|\s]+)\s*(?:\|\s*([^{}|\s]*)\s*)?\}\}`;
const CITE_SRC = String.raw`\[ref:\s*([^\]\s]+)\s*\]`;
export const SLOT_RE_SOURCE = SLOT_SRC;
export const CITE_RE_SOURCE = CITE_SRC;

/** 解析原文內所有槽位與引用標記，依出現順序回傳。fmt＝LLM 寫的格式（未寫為 null）；kind＝slot｜cite。 */
export function extractSlots(raw) {
  const s = typeof raw === 'string' ? raw : '';
  const out = [];
  for (const m of s.matchAll(new RegExp(SLOT_SRC, 'g'))) out.push({ ref: m[1], fmt: m[2] === undefined ? null : m[2], kind: 'slot', index: m.index });
  for (const m of s.matchAll(new RegExp(CITE_SRC, 'g'))) out.push({ ref: m[1], fmt: null, kind: 'cite', index: m.index });
  out.sort((a, b) => a.index - b.index);
  return out;
}

/** 原文引用到的 ref（槽位∪標記），依首次出現順序去重——claim.refs 必須等於它（R04）。 */
export function refsOfRaw(raw) {
  const seen = new Set();
  for (const x of extractSlots(raw)) seen.add(x.ref);
  return [...seen];
}

// ── 數值格式化 ────────────────────────────────────────────────────────────────

/** 四捨五入（半數遠離零；以十進位字串位移避免 1.005→1.00 這類二進位誤差）。 */
export function roundHalfAway(x, digits = 0) {
  const a = Math.abs(x);
  const s = String(a);
  const r = /e/i.test(s) ? Number(a.toFixed(digits)) : Number(`${Math.round(Number(`${s}e${digits}`))}e-${digits}`);
  return x < 0 ? -r : r;
}

function withCommas(intStr) { return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** 固定小數位＋千分位；負數用 ASCII 連字號；-0 → 0。signed＝正數加 +。 */
function numStr(v, digits, { signed = false, commas = true } = {}) {
  const r = roundHalfAway(v, digits);
  if (r === 0) return digits > 0 ? (0).toFixed(digits) : '0';
  const [i, f] = Math.abs(r).toFixed(digits).split('.');
  const body = (commas ? withCommas(i) : i) + (f ? `.${f}` : '');
  return r < 0 ? `-${body}` : signed ? `+${body}` : body;
}

const toNum = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*[+-]?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
};

/**
 * 依 fmt 格式化值。缺值（null／undefined／非有限數）回「來源未提供」。
 *   sg2  帶號兩位小數（+0.57／-1.20／0.00）          int  千分位整數（1,144,137）
 *   pts1 帶號一位小數＋千分位（+1,234.5，點數貢獻）   bn1  一位小數＋千分位（億元，4,123.5）
 *   pct0 百分比整數，輸出自帶 %：v 為比率（0.614→61%）；unit 為 % 或 pp 時 v 已是百分數（61.4→61%）
 *   date ISO→M/DD（2026-10-02→10/02，同站上 mdOf）    txt  文字原樣（布林→是／否；空白收斂）
 */
export function fmtValue(v, fmt, unit) {
  if (v === null || v === undefined) return MISSING_TEXT;
  if (fmt === 'txt') {
    if (typeof v === 'boolean') return v ? '是' : '否';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : MISSING_TEXT;
    const t = String(v).replace(/\s+/g, ' ').trim();
    return t === '' ? MISSING_TEXT : t;
  }
  if (fmt === 'date') return isIsoDate(v) ? mdOf(v) : MISSING_TEXT;
  const n = toNum(v);
  if (n === null) return MISSING_TEXT;
  switch (fmt) {
    case 'sg2': return numStr(n, 2, { signed: true });
    case 'int': return numStr(n, 0);
    case 'pts1': return numStr(n, 1, { signed: true });
    case 'bn1': return numStr(n, 1);
    case 'pct0': {
      const asPercent = unit === '%' || unit === 'pp' || unit === '％';
      return `${numStr(asPercent ? n : n * 100, 0)}%`;
    }
    default: return MISSING_TEXT;
  }
}

/**
 * 渲染槽位。回傳 { text, missing, badFmt }：
 *   missing  值缺（ref 不在 pack、v 為 null、或格式化失敗）的 ref；槽位處填「來源未提供」
 *   badFmt   LLM 寫的 |fmt 與 pack 預設不同，或不在封閉清單（R16）；渲染一律用 pack 預設
 */
export function renderSlots(raw, pack) {
  const refs = (pack && pack.refs) || {};
  const missing = [];
  const badFmt = [];
  const noteMissing = ref => { if (!missing.includes(ref)) missing.push(ref); };
  const s = typeof raw === 'string' ? raw : '';

  let text = s.replace(new RegExp(`${SLOT_SRC}([%％])?`, 'g'), (_m, ref, written, pctChar) => {
    const meta = refs[ref];
    const expected = meta && FMTS.includes(meta.fmt) ? meta.fmt : null;
    const w = written === undefined ? null : written;
    if (w !== null && !FMTS.includes(w)) badFmt.push({ ref, written: w, expected, reason: 'unknown-fmt' });
    else if (w !== null && expected && w !== expected) badFmt.push({ ref, written: w, expected, reason: 'differs-from-pack' });
    const eff = expected ?? (w !== null && FMTS.includes(w) ? w : 'txt');
    if (!meta) { noteMissing(ref); return MISSING_TEXT + (pctChar ?? ''); }
    const out = fmtValue(meta.v, eff, meta.unit);
    if (out === MISSING_TEXT) { noteMissing(ref); return out + (pctChar ?? ''); }
    return eff === 'pct0' ? out : out + (pctChar ?? ''); // pct0 自帶 %，吃掉緊接的重複 %
  });

  // 引用標記：移除（連同前導空白）；不在 pack 的 ref 也列入 missing
  text = text.replace(new RegExp(`\\s*${CITE_SRC}`, 'g'), (_m, ref) => { if (!refs[ref]) noteMissing(ref); return ''; });
  text = text.replace(/\s+(?=[。，；、！？）」])/g, '').trim();
  return { text, missing, badFmt };
}

// ── 等級與標記（R14）─────────────────────────────────────────────────────────

/** claim 的等級＝其 refs 中最弱者；連動（kind='linkage'）最高只到「站內整理」。無有效 ref 回 null。 */
export function claimTier(refIds, pack, kind) {
  const refs = (pack && pack.refs) || {};
  const t = lowestTier((refIds || []).map(id => refs[id]?.tier).filter(Boolean));
  return kind === 'linkage' ? clampDerivedTier(t ?? '站內整理') : t;
}

/** 需自動附標記的等級（固定順序）：refs 內出現者＋claim 等級。 */
export function tierMarks(refIds, pack, kind) {
  const refs = (pack && pack.refs) || {};
  const present = new Set((refIds || []).map(id => refs[id]?.tier).filter(Boolean));
  const eff = claimTier(refIds, pack, kind);
  if (eff) present.add(eff);
  return MARK_TIERS.filter(t => present.has(t));
}

/** 渲染一則 claim 的顯示文字＝槽位渲染＋等級標記（程式附加，不依賴 LLM）。 */
export function renderClaim(claim, pack) {
  const raw = typeof claim?.raw === 'string' ? claim.raw : '';
  const { text, missing, badFmt } = renderSlots(raw, pack);
  const marks = tierMarks(refsOfRaw(raw), pack, claim?.kind).map(tierMark).join('');
  return { text: text + marks, missing, badFmt };
}

export { TIERS, tierIndex };
