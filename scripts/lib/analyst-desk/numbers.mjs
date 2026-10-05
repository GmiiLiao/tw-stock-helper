// ─────────────────────────────────────────────────────────────────────────────
// R03 數字授權與 R05 日期抽取（純函式）。
//
// R03 規則：LLM 文字中「所有數值字面量」必須來自槽位 {{ref|fmt}}，或屬於下列白名單；其餘一律是未授權的裸數字。
//   數字白名單（本檔 scanNumbers 實作；順序即遮罩順序）：
//     W1 日期：YYYY-MM-DD、YYYY年M月(D日)、M月D日、M/D（月 1–12、日 1–31）——日期正確性交給 R05
//     W2 年份：19xx／20xx 後接「年」
//     W3 月份名稱：「10 月」「9月份」（不接「日」者）；季度：Q1–Q4、第 N 季（N=1–4）
//     W4 股票代號：4 位數字且在 knownCodes（pack 候選池／排除表／st.* nv.* mo.* wk.* 的第二段／issue 內 FocusStock.code）；
//        ETF 代號 00xxx(x)(A)；代號後緊接 點／元／億／萬／張／檔／%… 時視為數量，不當代號
//     W5 「前 N 大／檔／名」：N 必須等於同句列出的筆數（以「、」「與」「及」「和」分項；冒號後為清單）；對不上或沒列＝擋
//     W6 條列序號：句首 1. 1) 1、（1）；句中 （1）
//     W7 結構性數字：5–10、3–5（schema 名額寫法）
//     W8 固定名稱內的數字：5G／3C／3D／N 奈米／N 吋／N 年期／S&P 500／Nasdaq 100／HBM3／DDR5／T+1…（NAMED_NUMBER_RES）
//   中文數字＋單位（四成、兩倍、十億、三百點）同樣視為數值字面量（CN_NUM_UNIT_RE），不在白名單內即擋。
//   寬鬆模式（opts.numberMode='relaxed'）：裸數字若與「同句引用的 ref 之一」的值在使用者打出的小數位四捨五入後相等、且單位一致，放行
//     （04 R03：0.57 與 0.6、1,144,137 與 1144137）。預設 strict：任何裸數字都擋。
// ─────────────────────────────────────────────────────────────────────────────
import { SLOT_RE_SOURCE, CITE_RE_SOURCE, roundHalfAway } from './slots.mjs';

const FW_DIGITS = /[０-９]/g;
export const toHalfWidthDigits = s => String(s ?? '').replace(FW_DIGITS, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

const PH = '▒'; // 遮罩占位（不含數字）

/** 去掉槽位與引用標記（槽位以 § 占位，保留句型；緊接的 %／％ 一併吃掉，避免殘留）。 */
export function stripSlots(raw) {
  return String(raw ?? '')
    .replace(new RegExp(`${SLOT_RE_SOURCE}[%％]?`, 'g'), '§')
    .replace(new RegExp(`\\s*${CITE_RE_SOURCE}`, 'g'), '');
}

function mask(s, re) { return s.replace(re, m => PH.repeat(m.length)); }

// ── 日期 ──────────────────────────────────────────────────────────────────────
const ISO_RE = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g;
const CN_YMD_RE = /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?/g;
const CN_MD_RE = /(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
const SLASH_MD_RE = /(?<![\d./])(\d{1,2})\/(\d{1,2})(?![\d/])/g;
const validMD = (m, d) => m >= 1 && m <= 12 && d >= 1 && d <= 31;

/** 抽出文字內的日期提及。回傳 [{ raw, y|null, m, d|null, index }]，並回傳遮罩後字串。 */
export function extractDateMentions(text) {
  let s = toHalfWidthDigits(text);
  const found = [];
  const take = (re, build) => {
    s = s.replace(re, (...a) => {
      const m = a[0];
      const idx = a[a.length - 2];
      const d = build(a);
      if (!d) return m;
      found.push({ raw: m, ...d, index: idx });
      return PH.repeat(m.length);
    });
  };
  take(ISO_RE, a => ({ y: +a[1], m: +a[2], d: +a[3] }));
  take(CN_YMD_RE, a => ({ y: +a[1], m: +a[2], d: a[3] ? +a[3] : null }));
  take(CN_MD_RE, a => (validMD(+a[1], +a[2]) ? { y: null, m: +a[1], d: +a[2] } : null));
  take(SLASH_MD_RE, a => (validMD(+a[1], +a[2]) ? { y: null, m: +a[1], d: +a[2] } : null));
  found.sort((a, b) => a.index - b.index);
  return { dates: found, masked: s };
}

/** 週幾／星期幾（R05：口語星期容易寫錯，禁用）。 */
export const WEEKDAY_RE = /(?:週|周|星期|禮拜)[一二三四五六日天]/g;
/** 相對日詞（R05 依卡片 scope 檢查）。 */
export const REL_DAY_RES = Object.freeze({
  yesterday: /昨日|昨天/g,
  today: /今日|今天/g,
  tomorrow: /明日|明天/g,
  tomorrowLoose: /隔日|次日|翌日/g,
});
export const REL_WEEK_RE = /上週|本週|下週|上個月|本月|下個月|上月|下月/g;

// ── 固定名稱內的數字（W8）───────────────────────────────────────────────────────
export const NAMED_NUMBER_RES = Object.freeze([
  /S&P\s*500/gi, /Nasdaq\s*100/gi, /MSCI/g, /\b[56]G\b/g, /\b3[CD]\b/g, /2\.5D/g,
  /\d+\s*(?:奈米|nm|吋|寸|年期)/gi,
  /\bHBM\d*[A-Z]?\b/g, /\bLPDDR\d+[A-Z]?\b/g, /\bDDR\d\b/g, /\bGDDR\d+[A-Z]?\b/g, /\bT\+\d\b/g,
  /\bQ[1-4]\b/g, /(?<!\d)[1-4]Q(?:\d{2})?\b/g, /(?<!\d)\d{2,4}Q[1-4]\b/g, /第\s*[1-4]\s*季/g,
  /(?<!\d)(?:19|20)\d{2}\s*年/g,
  /(?<!\d)\d{1,2}\s*月份?(?!\s*\d)/g,
]);
const ETF_CODE_RE = /(?<![\d.])00\d{2,4}[A-Z]?(?![\d])/g;
const STRUCTURAL_RE = /(?<![\d.])(?:5\s*[–\-~～至到]\s*10|3\s*[–\-~～至到]\s*5)(?![\d])/g;
const ORDINAL_RES = [/(?:^|\n)\s*\d{1,2}\s*(?:[)、）]|\.(?!\d))/g, /[（(]\s*\d{1,2}\s*[)）]/g];

/** 中文數字＋單位（四成、兩倍、十億、三百點）。「一點」「半點」等口語不算。 */
export const CN_NUM_UNIT_RE = /(?<![一二三四五六七八九十])(?!一點|半點)[零〇一二兩三四五六七八九十百千][零〇一二兩三四五六七八九十百千萬億]*(?:成|倍|百分點|億|萬元|萬張|萬股|點|元)|(?:百|千)分之[零〇一二兩三四五六七八九十百\d.]+/g;

// ── 前 N 大（W5）──────────────────────────────────────────────────────────────
const TOP_N_RE = /前\s*(\d{1,3}|[一二兩三四五六七八九十]{1,3})\s*(大|檔|名|強|弱|個|家|筆)/g;
/** 中文數字（一～九十九）轉整數；無法解析回 NaN。 */
export function cnToInt(t) {
  const D = { 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const m = String(t).match(/^([一二兩三四五六七八九])?(十)?([一二兩三四五六七八九])?$/);
  if (!m || !String(t)) return NaN;
  if (m[2]) return (m[1] ? D[m[1]] : 1) * 10 + (m[3] ? D[m[3]] : 0);
  return m[1] && !m[3] ? D[m[1]] : NaN;
}
/** 估算「前 N 大」後面列出的項數；無清單回 0。 */
export function countListedItems(tail) {
  let t = String(tail ?? '');
  const colon = t.search(/[：:]/);
  if (colon >= 0 && colon <= 14) t = t.slice(colon + 1);
  else if (!/、/.test(t)) return 0;
  t = t.split(/[。！？\n]/)[0].replace(/[（(][^）)]*[）)]/g, '').replace(/等$/, '');
  const items = t.split(/、|與|及|和/).map(x => x.trim()).filter(Boolean);
  return items.length >= 2 ? items.length : 0;
}

// ── 主掃描 ────────────────────────────────────────────────────────────────────
const NUM_RE = /[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?%?/g;
const QTY_UNIT_AFTER = /^\s{0,1}[點元億萬張檔家筆日月年週天%％倍成股口]/;
const UNIT_SCALE = [
  { re: /^\s*億/, unitIn: ['億'], scale: 1 },
  { re: /^\s*萬(?:張|股|元)?/, unitIn: ['張', '股', '元'], scale: 1e4 },
  { re: /^\s*%/, unitIn: ['%', 'pp', '％'], scale: 1 },
  { re: /^\s*點/, unitIn: ['點', 'pts'], scale: 1 },
];

function decimalsOf(lit) { const m = lit.replace(/,/g, '').match(/\.(\d+)/); return m ? m[1].length : 0; }

/** 寬鬆模式：裸數字字面量是否等於某個被引用 ref 的值（同使用者小數位、單位一致）。 */
function matchesCitedRef(lit, after, citedRefs) {
  const n = Number(lit.replace(/[,%−]/g, m => (m === '−' ? '-' : '')));
  if (!Number.isFinite(n)) return false;
  const d = decimalsOf(lit);
  const us = UNIT_SCALE.find(u => u.re.test(after));
  for (const r of citedRefs) {
    const v = typeof r.v === 'number' ? r.v : null;
    if (v === null) continue;
    const pctLike = /^\s*[%％]/.test(after) || lit.endsWith('%');
    const unit = r.unit ?? '';
    // 單位一致：寫了 億／萬／% 就要對得上 ref 的單位；沒寫單位則 ref 單位不得是 % 億 萬
    if (us && !us.unitIn.includes(unit)) { if (!(pctLike && (unit === '' || unit === '比率'))) continue; }
    if (!us && !pctLike && ['%', 'pp', '億', '張', '股'].includes(unit)) continue;
    const cand = pctLike && (unit === '' || unit === '比率') ? v * 100 : v / (us?.scale ?? 1);
    if (roundHalfAway(cand, d) === roundHalfAway(Math.abs(n) * (n < 0 ? -1 : 1), d)) return true;
  }
  return false;
}

/**
 * 掃描裸數字。
 * @param raw        LLM 原文（含槽位）
 * @param ctx.knownCodes   Set<string> 已知股票代號
 * @param ctx.mode         'strict'｜'relaxed'
 * @param ctx.citedRefs    [{v, unit}]（relaxed 用）
 * @param ctx.extraAllow   [RegExp] 額外放行（使用者擴充白名單）
 * @returns { violations:[{literal,index,reason}], dates:[...], masked }
 */
export function scanNumbers(raw, ctx = {}) {
  const knownCodes = ctx.knownCodes ?? new Set();
  const violations = [];
  let s = toHalfWidthDigits(stripSlots(raw));

  // W1 日期（同時回傳給 R05）
  const dm = extractDateMentions(s);
  s = dm.masked;

  // W7／W8／ETF／使用者擴充：先遮「固定寫法」
  s = mask(s, STRUCTURAL_RE);
  for (const re of NAMED_NUMBER_RES) s = mask(s, new RegExp(re.source, re.flags));
  for (const re of ctx.extraAllow ?? []) s = mask(s, new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));
  s = mask(s, ETF_CODE_RE);
  for (const re of ORDINAL_RES) s = mask(s, new RegExp(re.source, re.flags));

  // W5 前 N 大
  s = s.replace(TOP_N_RE, (m, nStr, unit, off, whole) => {
    const n = /^\d+$/.test(nStr) ? Number(nStr) : cnToInt(nStr);
    const tail = whole.slice(off + m.length);
    const listed = countListedItems(tail);
    if (listed === 0) violations.push({ literal: m, index: off, reason: `「${m}」未在同句列出清單，無法驗證 N；請改用槽位或列出名稱` });
    else if (listed !== n) violations.push({ literal: m, index: off, reason: `「${m}」的 N=${n} 與列出筆數 ${listed} 不一致` });
    return `前${PH.repeat(nStr.length)}${unit}`;
  });

  // 中文數字＋單位
  for (const m of s.matchAll(CN_NUM_UNIT_RE)) violations.push({ literal: m[0], index: m.index, reason: `中文數量「${m[0]}」未經槽位` });

  // 其餘阿拉伯數字
  for (const m of s.matchAll(NUM_RE)) {
    const lit = m[0];
    const bare = lit.replace(/^[+\-−]/, '').replace(/%$/, '');
    const after = s.slice(m.index + lit.length, m.index + lit.length + 3);
    const isInt = /^\d{4,6}$/.test(bare);
    if (isInt && knownCodes.has(bare) && !QTY_UNIT_AFTER.test(after)) continue;                 // W4 股票代號
    if (ctx.mode === 'relaxed' && matchesCitedRef(lit, after, ctx.citedRefs ?? [])) continue;   // 寬鬆模式
    violations.push({ literal: lit, index: m.index, reason: knownCodes.has(bare) ? `「${lit}」後接單位，視為數量而非代號，必須用槽位` : `裸數字「${lit}」未經槽位` });
  }
  violations.sort((a, b) => a.index - b.index);
  return { violations, dates: dm.dates, masked: s };
}
