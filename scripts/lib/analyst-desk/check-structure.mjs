// ─────────────────────────────────────────────────────────────────────────────
// 結構與固定欄位規則：R01（schema／封閉清單／鍵名）、R02（useRules／免責逐字）、R24（稽核可重現）、R25（每卡免責）。
// ─────────────────────────────────────────────────────────────────────────────
import {
  SCHEMA_VERSION, ISSUE_KIND, EDITIONS, CARD_IDS, CLAIM_KINDS, TIERS, DIRECTIONS, MECHANISMS, FMTS, SECTION_IDS, ANALYSTS, CONTRIBUTORS,
  FOCUS_KINDS, ENGINE_TIERS, EVIDENCE_ROLES, COND_OPS, FOCUS_KIND_BY_CARD, CARD_DATE_KEY, ALLOWED_DATE_KEYS, FORBIDDEN_KEY_RE, KEY_SCAN_EXEMPT,
  DYNAMIC_KEY_PATHS, REF_ID_RE, USE_RULES, DISCLAIMER, DISCLAIMER_SHORT, CARD_TITLE_RE, DAY_LABEL_RE, cardTitle, dayLabelOf, isIsoDate, mdOf,
  MAX_POINTS, MAX_NEXT_FOCUS, MAX_RISKS,
} from './constants.mjs';
import { isObj, arr } from './issue-units.mjs';

const isStr = x => typeof x === 'string';
const isNonEmptyStr = x => typeof x === 'string' && x.trim() !== '';
const isInt = x => Number.isInteger(x);
const HEX64 = /^[0-9a-f]{64}$/;

// ── 鍵名掃描 ──────────────────────────────────────────────────────────────────
function scanKeys(node, path, report) {
  if (Array.isArray(node)) { node.forEach(n => scanKeys(n, path, report)); return; }
  if (!isObj(node)) return;
  const dynamic = DYNAMIC_KEY_PATHS.includes(path);
  for (const [k, v] of Object.entries(node)) {
    if (!dynamic) {
      if (/(At|Date)$/.test(k) && !ALLOWED_DATE_KEYS.includes(k)) report(`${path || '$'}.${k}`, `鍵名「${k}」以 At／Date 結尾，只允許 ${ALLOWED_DATE_KEYS.join('／')}`);
      else if (FORBIDDEN_KEY_RE.test(k) && !KEY_SCAN_EXEMPT.includes(k)) report(`${path || '$'}.${k}`, `鍵名「${k}」命中禁用鍵名樣式（score|signal|buy|sell|rank|target|stop|entry|exit|action|rating|recommend）`);
    }
    scanKeys(v, dynamic ? `${path}.*` : path ? `${path}.${k}` : k, report);
  }
}

// ── 各結構驗證（回傳錯誤字串陣列）──────────────────────────────────────────────
function validateClaim(c, path, errs, warns) {
  if (!isObj(c)) { errs.push(`${path}：claim 不是物件`); return; }
  if (!isNonEmptyStr(c.id)) errs.push(`${path}.id 缺漏`);
  if (!isStr(c.raw) || c.raw.trim() === '') errs.push(`${path}.raw 缺漏`);
  if (!isStr(c.text)) errs.push(`${path}.text 缺漏（應為程式渲染後文字）`);
  if (!Array.isArray(c.refs) || c.refs.some(r => !isStr(r))) errs.push(`${path}.refs 必須是字串陣列`);
  if (!CLAIM_KINDS.includes(c.kind)) errs.push(`${path}.kind「${c.kind}」不在封閉清單`);
  if (!TIERS.includes(c.tier) && !(c.tier === null && arr(c.refs).length === 0)) errs.push(`${path}.tier「${c.tier}」不在封閉清單`);
  if (!DIRECTIONS.includes(c.direction)) errs.push(`${path}.direction「${c.direction}」不在封閉清單`);
  if (!Array.isArray(c.authors) || c.authors.length === 0 || c.authors.some(a => !ANALYSTS.includes(a))) errs.push(`${path}.authors 必須是非空的分析師 id 陣列`);
  if (c.cond !== undefined) {
    const k = c.cond;
    if (!isObj(k) || !isObj(k.if) || !isStr(k.if.ref) || !COND_OPS.includes(k.if.op) || !Number.isFinite(k.if.value) || !isNonEmptyStr(k.watch)) errs.push(`${path}.cond 形狀不合（需 if:{ref,op,value}、watch）`);
  }
  const allowed = new Set(['id', 'raw', 'text', 'refs', 'kind', 'tier', 'direction', 'authors', 'cond']);
  for (const k of Object.keys(c)) if (!allowed.has(k)) warns.push(`${path} 含契約外欄位「${k}」`);
}

function validateStock(s, path, card, errs, warns) {
  if (!isObj(s)) { errs.push(`${path}：不是物件`); return; }
  if (!isNonEmptyStr(s.code) || !/^[0-9A-Z]{4,6}$/.test(s.code)) errs.push(`${path}.code「${s.code}」格式不合`);
  for (const k of ['name', 'industry', 'thesis']) if (!isNonEmptyStr(s[k])) errs.push(`${path}.${k} 缺漏`);
  if (!['上市', '上櫃'].includes(s.market)) errs.push(`${path}.market「${s.market}」不在 上市｜上櫃`);
  if (s.cardId !== card.id) errs.push(`${path}.cardId「${s.cardId}」與所在卡「${card.id}」不符`);
  if (s.kind !== card.focus?.kind) errs.push(`${path}.kind「${s.kind}」與該卡 focus.kind 不符`);
  if (!Array.isArray(s.evidence)) errs.push(`${path}.evidence 必須是陣列`);
  else s.evidence.forEach((e, i) => { if (!isObj(e) || !isStr(e.ref) || !EVIDENCE_ROLES.includes(e.role)) errs.push(`${path}.evidence[${i}] 需 {ref, role∈${EVIDENCE_ROLES.join('|')}}`); });
  for (const k of ['watchConditions', 'risks']) {
    if (!Array.isArray(s[k])) errs.push(`${path}.${k} 必須是陣列`);
    else s[k].forEach((w, i) => { if (!isObj(w) || !isNonEmptyStr(w.text) || !Array.isArray(w.refs)) errs.push(`${path}.${k}[${i}] 需 {text, refs[]}`); });
  }
  if (!Array.isArray(s.adverse) || s.adverse.some(a => !isStr(a))) errs.push(`${path}.adverse 必須是字串陣列`);
  if (!Array.isArray(s.sponsors) || s.sponsors.length === 0 || s.sponsors.some(a => !ANALYSTS.includes(a))) errs.push(`${path}.sponsors 必須是非空的分析師 id 陣列`);
  if (!isObj(s.asOf) || !isIsoDate(s.asOf.day) || !isStr(s.asOf.closeRef)) errs.push(`${path}.asOf 需 {day:YYYY-MM-DD, closeRef}`);
  const allowed = new Set(['code', 'name', 'market', 'industry', 'cardId', 'kind', 'thesis', 'thesisRaw', 'evidence', 'watchConditions', 'risks', 'adverse', 'sponsors', 'asOf', 'reviewSpec']);
  for (const k of Object.keys(s)) if (!allowed.has(k)) warns.push(`${path} 含契約外欄位「${k}」`);
}

function validateCard(card, i, issue, opts, errs, warns) {
  const p = `cards[${i}]`;
  if (!isObj(card)) { errs.push(`${p}：不是物件`); return; }
  if (!CARD_IDS.includes(card.id)) { errs.push(`${p}.id「${card.id}」不在 prev｜data｜next`); return; }
  const day = issue.dates?.[CARD_DATE_KEY[card.id]];
  if (!isNonEmptyStr(card.title) || !CARD_TITLE_RE.test(card.title)) errs.push(`${p}.title「${card.title}」不合程式標題格式`);
  else {
    const m = card.title.match(CARD_TITLE_RE);
    if (m && isIsoDate(day) && `${m[3]}/${m[4]}` !== mdOf(day)) errs.push(`${p}.title 的 M/D 與該卡資料日 ${day} 不符`);
    if (m && ({ prev: '昨日股市', data: '今日盤後', next: '明日預期' })[card.id] !== m[1]) errs.push(`${p}.title 字面與卡 id 不符`);
    if (isIsoDate(opts.today) && isIsoDate(day) && card.title !== cardTitle(card.id, day, opts.today)) errs.push(`${p}.title 與程式產生的標題不同（應為「${cardTitle(card.id, day, opts.today)}」）`);
  }
  if (!isObj(card.asOf) || !isIsoDate(card.asOf.day)) errs.push(`${p}.asOf.day 需為 YYYY-MM-DD`);
  else {
    if (isIsoDate(day) && card.asOf.day !== day) errs.push(`${p}.asOf.day ${card.asOf.day} 與 dates.${CARD_DATE_KEY[card.id]}=${day} 不符`);
    if (!isStr(card.asOf.label) || !DAY_LABEL_RE.test(card.asOf.label)) errs.push(`${p}.asOf.label「${card.asOf.label}」格式不合`);
    else if (isIsoDate(opts.today) && card.asOf.label !== dayLabelOf(card.id, card.asOf.day, opts.today)) errs.push(`${p}.asOf.label 與程式產生的不同`);
  }
  if (!Array.isArray(card.sections)) errs.push(`${p}.sections 必須是陣列`);
  else {
    const seen = new Set();
    card.sections.forEach((sec, j) => {
      const sp = `${p}.sections[${j}]`;
      if (!isObj(sec)) { errs.push(`${sp}：不是物件`); return; }
      if (!SECTION_IDS.includes(sec.id)) errs.push(`${sp}.id「${sec.id}」不在封閉清單`);
      if (seen.has(sec.id)) errs.push(`${sp}.id「${sec.id}」重複`); seen.add(sec.id);
      if (!isNonEmptyStr(sec.title)) errs.push(`${sp}.title 缺漏`);
      if (!ANALYSTS.includes(sec.analyst)) errs.push(`${sp}.analyst「${sec.analyst}」不在封閉清單`);
      if (!Array.isArray(sec.claims)) errs.push(`${sp}.claims 必須是陣列`);
      else sec.claims.forEach((c, k) => validateClaim(c, `${sp}.claims[${k}]`, errs, warns));
    });
  }
  const f = card.focus;
  if (!isObj(f)) { errs.push(`${p}.focus 缺漏`); return; }
  if (!FOCUS_KINDS.includes(f.kind)) errs.push(`${p}.focus.kind「${f.kind}」不在 recap｜watch`);
  else if (f.kind !== FOCUS_KIND_BY_CARD[card.id]) errs.push(`${p}.focus.kind「${f.kind}」與卡 ${card.id} 應有的「${FOCUS_KIND_BY_CARD[card.id]}」不符`);
  if (!isNonEmptyStr(f.poolRule)) errs.push(`${p}.focus.poolRule 缺漏`);
  if (!isInt(f.poolSize) || f.poolSize < 0) errs.push(`${p}.focus.poolSize 需為非負整數`);
  if (!isInt(f.excludedCount) || f.excludedCount < 0) errs.push(`${p}.focus.excludedCount 需為非負整數`);
  if (f.note !== undefined && !isStr(f.note)) errs.push(`${p}.focus.note 需為字串`);
  if (!Array.isArray(f.stocks)) errs.push(`${p}.focus.stocks 必須是陣列`);
  else f.stocks.forEach((s, k) => validateStock(s, `${p}.focus.stocks[${k}]`, card, errs, warns));
}

export function r01(ctx) {
  const { issue, opts } = ctx;
  const errs = [], warns = [];
  if (!isObj(issue)) { ctx.block('R01', 'issue 不是物件'); return; }
  const keyHits = [];
  scanKeys(issue, '', (path, msg) => keyHits.push({ path, msg }));
  for (const h of keyHits) ctx.block('R01', h.msg, { path: h.path });

  if (issue.schema !== SCHEMA_VERSION) errs.push(`schema 應為 ${SCHEMA_VERSION}`);
  if (issue.kind !== ISSUE_KIND) errs.push(`kind 應為 ${ISSUE_KIND}`);
  if (!isIsoDate(issue.dataDate)) errs.push('dataDate 需為 YYYY-MM-DD');
  if (!EDITIONS.includes(issue.edition)) errs.push(`edition「${issue.edition}」不在 ${EDITIONS.join('｜')}`);
  if (!isObj(issue.dates) || !['prev', 'data', 'next'].every(k => isIsoDate(issue.dates[k]))) errs.push('dates 需含 prev／data／next（YYYY-MM-DD）');
  else if (!(issue.dates.prev < issue.dates.data && issue.dates.data < issue.dates.next)) errs.push('dates 需 prev < data < next');
  if (!isObj(issue.useRules)) errs.push('useRules 缺漏');

  const s = issue.summary;
  if (!isObj(s)) errs.push('summary 缺漏');
  else {
    if (!isNonEmptyStr(s.headline)) errs.push('summary.headline 缺漏');
    for (const [k, max] of [['points', MAX_POINTS], ['nextFocus', MAX_NEXT_FOCUS], ['risks', MAX_RISKS]]) {
      if (!Array.isArray(s[k])) { errs.push(`summary.${k} 必須是陣列`); continue; }
      if (s[k].length > max) errs.push(`summary.${k} 最多 ${max} 條（現 ${s[k].length}）`);
      s[k].forEach((c, i) => validateClaim(c, `summary.${k}[${i}]`, errs, warns));
    }
    if (Array.isArray(s.points) && s.points.length < 3) warns.push('summary.points 少於 3 條');
    const b = s.byline;
    if (!isObj(b) || b.editor !== '總編輯' || !Array.isArray(b.contributors) || b.contributors.some(c => !CONTRIBUTORS.includes(c))) errs.push('summary.byline 需 {editor:"總編輯", contributors⊆momentum|industry|global}');
  }

  if (!Array.isArray(issue.cards) || issue.cards.length === 0) errs.push('cards 需為非空陣列');
  else {
    const ids = issue.cards.map(c => c?.id);
    if (new Set(ids).size !== ids.length) errs.push('cards.id 重複');
    const order = ids.map(i => CARD_IDS.indexOf(i));
    if (order.some(o => o < 0) === false && order.some((o, i) => i > 0 && o < order[i - 1])) errs.push('cards 順序應為 prev → data → next');
    issue.cards.forEach((c, i) => validateCard(c, i, issue, opts, errs, warns));
    const seenClaim = new Set();
    for (const u of ctx.units) {
      if (u.kind !== 'claim' || u.claimId == null) continue;
      if (seenClaim.has(u.claimId)) errs.push(`claim id「${u.claimId}」重複（${u.path}）`);
      seenClaim.add(u.claimId);
    }
  }

  if (!Array.isArray(issue.linkages)) errs.push('linkages 必須是陣列');
  else issue.linkages.forEach((l, i) => {
    const p = `linkages[${i}]`;
    if (!isObj(l)) { errs.push(`${p}：不是物件`); return; }
    if (!isNonEmptyStr(l.id)) errs.push(`${p}.id 缺漏`);
    if (!isObj(l.from) || !isStr(l.from.ref) || !isObj(l.to) || !isStr(l.to.ref)) errs.push(`${p}.from／to 需 {ref}`);
    if (!MECHANISMS.includes(l.mechanism)) errs.push(`${p}.mechanism「${l.mechanism}」不在封閉清單`);
    if (!TIERS.includes(l.tier)) errs.push(`${p}.tier「${l.tier}」不在封閉清單`);
    if (!isNonEmptyStr(l.text)) errs.push(`${p}.text 缺漏`);
    if (!Array.isArray(l.refs)) errs.push(`${p}.refs 必須是陣列`);
    if (!Array.isArray(l.authors) || new Set(l.authors).size < 2 || l.authors.some(a => !ANALYSTS.includes(a))) errs.push(`${p}.authors 需至少兩位不同分析師共同署名`);
  });

  if (!isObj(issue.refTable)) errs.push('refTable 缺漏');
  else for (const [id, r] of Object.entries(issue.refTable)) {
    if (!REF_ID_RE.test(id)) errs.push(`refTable 鍵「${id}」不合 ref id 文法`);
    if (!isObj(r) || !('v' in r) || !isStr(r.unit) || !FMTS.includes(r.fmt) || !isIsoDate(r.asOf) || !TIERS.includes(r.tier) || !isStr(r.source)) errs.push(`refTable.${id} 需 {v, unit, fmt, asOf, tier, source}`);
  }

  const m = issue.meta;
  if (!isObj(m)) errs.push('meta 缺漏');
  else {
    if (!ENGINE_TIERS.includes(m.engineTier)) errs.push(`meta.engineTier「${m.engineTier}」不在封閉清單`);
    if (!Array.isArray(m.analysts)) errs.push('meta.analysts 必須是陣列');
    if (!Array.isArray(m.degraded)) errs.push('meta.degraded 必須是陣列');
    if (m.fallback !== null && m.fallback !== 'template') errs.push('meta.fallback 需為 null 或 "template"');
    if (!isObj(m.pack) || !HEX64.test(m.pack.sha256 ?? '') || !isInt(m.pack.refCount) || !Array.isArray(m.pack.absent)) errs.push('meta.pack 需 {sha256(64 hex), refCount, absent[]}');
    if (m.check !== undefined && (!isObj(m.check) || typeof m.check.pass !== 'boolean' || !isObj(m.check.rules))) errs.push('meta.check 需 {pass:boolean, rules:{…}, …}');
  }

  for (const e of errs) ctx.block('R01', e);
  for (const w of warns) ctx.warn('R01', w);
}

// ── R02 ───────────────────────────────────────────────────────────────────────
export function r02(ctx) {
  const u = ctx.issue?.useRules;
  if (!isObj(u)) { ctx.block('R02', 'useRules 缺漏'); return; }
  if (u.usedForScoring !== false) ctx.block('R02', 'useRules.usedForScoring 必須為 false');
  if (u.disclaimer !== DISCLAIMER) ctx.block('R02', 'useRules.disclaimer 與程式常數不逐字相等');
  if (u.disclaimerShort !== DISCLAIMER_SHORT) ctx.block('R02', 'useRules.disclaimerShort 與程式常數不逐字相等');
  if (u.nature !== USE_RULES.nature) ctx.block('R02', 'useRules.nature 與程式常數不相等');
  if (JSON.stringify(u.forbidden) !== JSON.stringify(USE_RULES.forbidden)) ctx.block('R02', 'useRules.forbidden 被改動');
  const extra = Object.keys(u).filter(k => !(k in USE_RULES));
  if (extra.length) ctx.block('R02', `useRules 含契約外欄位：${extra.join('、')}`);
}

// ── R24 ───────────────────────────────────────────────────────────────────────
const ENGINE_FAMILY = { claude: /^claude/, ollama: /^ollama/, template: /^template/ };
export function r24(ctx) {
  const { issue, pack, opts } = ctx;
  const m = issue?.meta;
  if (!isObj(m)) return;
  if (opts.packSha256 !== undefined && m.pack?.sha256 !== opts.packSha256) ctx.block('R24', `meta.pack.sha256 與實際 pack 雜湊不符（issue=${m.pack?.sha256}｜disk=${opts.packSha256}）`);
  if (opts.issueSha256 !== undefined && opts.manifestSha256 !== undefined && opts.issueSha256 !== opts.manifestSha256) ctx.block('R24', 'issue 雜湊與 manifest 不符');
  if (isObj(pack?.refs) && isObj(m.pack) && m.pack.refCount !== Object.keys(pack.refs).length) ctx.block('R24', `meta.pack.refCount=${m.pack.refCount} 與 pack 實際 ${Object.keys(pack.refs).length} 不符`);
  const fam = ENGINE_FAMILY[m.engineTier];
  if (fam) {
    for (const a of arr(m.analysts)) {
      if (!isObj(a) || typeof a.engine !== 'string') { ctx.block('R24', 'meta.analysts[].engine 缺漏'); continue; }
      if (!fam.test(a.engine)) ctx.block('R24', `engineTier=${m.engineTier} 但分析師 ${a.id} 的 engine=${a.engine}`);
    }
    if (m.engineTier === 'template' && m.fallback !== 'template') ctx.block('R24', 'engineTier=template 時 meta.fallback 必須是 "template"');
  }
}

// ── R25 ───────────────────────────────────────────────────────────────────────
/**
 * opts.rendered：渲染層輸出。string（整頁／整份 Markdown，免責短版出現次數須 ≥ 卡數）
 *   或 { prev:string, data:string, next:string }（逐卡）或 string[]（與 cards 同序）。
 * 未提供＝skip（本函式是純函式，無法自行渲染）；issue.useRules 的逐字相等由 R02 負責。
 */
export function r25(ctx) {
  const { issue, opts } = ctx;
  const cards = arr(issue?.cards).filter(isObj);
  const r = opts.rendered;
  if (r === undefined || r === null) { ctx.skip('R25', '未提供 opts.rendered（需渲染層輸出才能驗每卡免責）'); return; }
  const has = t => typeof t === 'string' && t.includes(DISCLAIMER_SHORT);
  if (typeof r === 'string') {
    const n = r.split(DISCLAIMER_SHORT).length - 1;
    if (n < cards.length) ctx.block('R25', `渲染結果免責短版只出現 ${n} 次，少於卡數 ${cards.length}`);
  } else if (Array.isArray(r)) {
    cards.forEach((c, i) => { if (!has(r[i])) ctx.block('R25', `第 ${i + 1} 張卡（${c.id}）渲染結果缺免責短版`); });
  } else if (isObj(r)) {
    for (const c of cards) if (!has(r[c.id])) ctx.block('R25', `卡 ${c.id} 渲染結果缺免責短版`);
  } else ctx.block('R25', 'opts.rendered 型別不支援');
  if (issue?.useRules?.disclaimerShort !== DISCLAIMER_SHORT) ctx.block('R25', 'issue.useRules.disclaimerShort 與程式常數不符');
}
