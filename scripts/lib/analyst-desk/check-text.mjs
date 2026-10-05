// ─────────────────────────────────────────────────────────────────────────────
// 文字層規則：R03 數字授權、R05 日期一致、R09 禁用語、R10 預測句型、R19 分數／訊號名詞、R20 語言與格式、R22 傳導語氣。
//   一律掃 LLM 原文（槽位已被 § 取代，所以資料值裡的字不會誤殺）。
// ─────────────────────────────────────────────────────────────────────────────
import { MAX_SENTENCE_CHARS, STOCK_NAMESPACES, isIsoDate } from './constants.mjs';
import { renderClaim, renderSlots } from './slots.mjs';
import { stripSlots, scanNumbers, extractDateMentions, WEEKDAY_RE, REL_DAY_RES, REL_WEEK_RE, toHalfWidthDigits } from './numbers.mjs';
import { scanWords, FUTURE_MOVE_RE, CONDITIONAL_WORDS_RE, findSimplified, EMOJI_RE, MARKDOWN_RES, EXTERNAL_LINK_RE, isNegated, maskAllowed } from './words.mjs';
import { unitRefs, nsOf, seg2Of, arr, isObj } from './issue-units.mjs';

const clip = (s, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);
const loc = u => ({ claimId: u.claimId ?? undefined, path: u.path });

/** 已知股票代號：pack 池／排除表／adverse 鍵／st.nv.mo.wk 的第二段／issue 內 FocusStock.code／opts.knownCodes。 */
export function collectKnownCodes(issue, pack, opts) {
  const set = new Set(opts.knownCodes ?? []);
  for (const k of ['prev', 'data', 'next']) {
    for (const e of arr(pack?.pools?.[k])) if (e?.code) set.add(String(e.code));
    for (const e of arr(pack?.excluded?.[k])) if (e?.code) set.add(String(e.code));
  }
  for (const c of Object.keys(pack?.adverse ?? {})) set.add(c);
  for (const id of Object.keys(pack?.refs ?? {})) if (STOCK_NAMESPACES.includes(nsOf(id))) { const c = seg2Of(id); if (c) set.add(c); }
  for (const card of arr(issue?.cards)) for (const s of arr(card?.focus?.stocks)) if (s?.code) set.add(String(s.code));
  return set;
}

function citedRefMetas(u, pack) {
  return unitRefs(u).map(id => pack?.refs?.[id]).filter(Boolean);
}

// ── R03 ───────────────────────────────────────────────────────────────────────
export function r03(ctx) {
  const { pack, opts, units } = ctx;
  const knownCodes = ctx.knownCodes;
  for (const u of units) {
    if (!u.raw) continue;
    const { violations } = scanNumbers(u.raw, { knownCodes, mode: opts.numberMode ?? 'strict', citedRefs: citedRefMetas(u, pack), extraAllow: opts.extraNumberAllow });
    if (violations.length) {
      const head = violations.slice(0, 4).map(v => v.literal).join('、');
      ctx.block('R03', `未授權數字 ${violations.length} 處（${head}${violations.length > 4 ? '…' : ''}）：${violations[0].reason}`, loc(u));
    }
    if (u.stored !== undefined) {
      const expected = renderSlots(u.raw, pack).text;
      if (u.stored !== expected) ctx.block('R03', `渲染文字與原文槽位渲染結果不一致（疑似被改寫）：「${clip(u.stored)}」≠「${clip(expected)}」`, loc(u));
    }
    if (u.kind === 'claim' && typeof u.claim.raw === 'string' && typeof u.claim.text === 'string') {
      const expected = renderClaim(u.claim, pack).text;
      if (u.claim.text !== expected) ctx.block('R03', `claim.text 與「raw 槽位渲染＋等級標記」不一致（疑似被改寫）：「${clip(u.claim.text)}」≠「${clip(expected)}」`, loc(u));
    }
  }
}

// ── R05 ───────────────────────────────────────────────────────────────────────
function allowedDateSet(pack, opts) {
  const set = new Set(opts.allowedDates ?? []);
  for (const k of ['prev', 'data', 'next']) if (isIsoDate(pack?.dates?.[k])) set.add(pack.dates[k]);
  if (isIsoDate(pack?.calendar?.nextTradingDay)) set.add(pack.calendar.nextTradingDay);
  for (const d of arr(pack?.calendar?.holidaysAhead)) if (isIsoDate(d)) set.add(d);
  for (const [id, r] of Object.entries(pack?.refs ?? {})) if ((r?.fmt === 'date' || id.startsWith('cal.')) && isIsoDate(r?.v)) set.add(r.v);
  return set;
}
const dateAllowed = (m, set) => {
  for (const iso of set) {
    const y = +iso.slice(0, 4), mo = +iso.slice(5, 7), d = +iso.slice(8, 10);
    if (m.y !== null && m.y !== y) continue;
    if (m.m !== mo) continue;
    if (m.d !== null && m.d !== d) continue;
    return true;
  }
  return false;
};
/** 相對日詞各自允許的卡（summary 不限）。 */
const REL_DAY_CARDS = { yesterday: ['prev', 'data'], today: ['data'], tomorrow: ['next'] };
const REL_LABEL = { yesterday: '昨日', today: '今日', tomorrow: '明日' };

export function r05(ctx) {
  const { issue, pack, opts, units } = ctx;
  if (isIsoDate(pack?.dataDate) && issue?.dataDate !== pack.dataDate) ctx.block('R05', `issue.dataDate ${issue?.dataDate} ≠ pack.dataDate ${pack.dataDate}`);
  for (const k of ['prev', 'data', 'next']) if (isIsoDate(pack?.dates?.[k]) && issue?.dates?.[k] !== pack.dates[k]) ctx.block('R05', `issue.dates.${k} ${issue?.dates?.[k]} ≠ pack.dates.${k} ${pack.dates[k]}`);
  if (pack?.edition && issue?.edition !== pack.edition) ctx.block('R05', `issue.edition ${issue?.edition} ≠ pack.edition ${pack.edition}`);

  const allowed = allowedDateSet(pack, opts);
  for (const u of units) {
    if (!u.raw) continue;
    const plain = toHalfWidthDigits(stripSlots(u.raw));
    const { dates } = extractDateMentions(plain);
    for (const m of dates) {
      if (!dateAllowed(m, allowed)) ctx.block('R05', `文字中的日期「${m.raw}」不在 pack.dates／cal.* 事件日內`, loc(u));
    }
    const wk = plain.match(WEEKDAY_RE);
    if (wk) ctx.block('R05', `禁用星期用語「${wk[0]}」（請用日期槽位）`, loc(u));
    const rw = plain.match(REL_WEEK_RE);
    if (rw) ctx.warn('R05', `相對期間用語「${rw[0]}」易與資料日錯位`, loc(u));
    if (u.scope === 'summary') continue; // 總結卡可用三張卡的名稱字樣
    for (const [key, cards] of Object.entries(REL_DAY_CARDS)) {
      const re = new RegExp(REL_DAY_RES[key].source, 'g');
      const hit = plain.match(re);
      if (hit && !(u.cardId && cards.includes(u.cardId))) ctx.block('R05', `「${hit[0]}」只准出現在 ${cards.join('／')} 卡（此處：${u.cardId ?? u.scope}）`, loc(u));
    }
    const loose = plain.match(new RegExp(REL_DAY_RES.tomorrowLoose.source, 'g'));
    if (loose && u.cardId !== 'next') ctx.warn('R05', `「${loose[0]}」等同「明日」，只應出現在 next 卡`, loc(u));
  }
}

// ── 掃詞類（R09／R10／R19／R22）───────────────────────────────────────────────
function emitHits(ctx, rule, u, hits) {
  const blocks = hits.filter(h => h.level === 'block');
  const warns = hits.filter(h => h.level === 'warn');
  if (blocks.length) ctx.block(rule, `命中禁用詞：${[...new Set(blocks.map(h => h.term))].slice(0, 5).join('、')}`, loc(u));
  if (warns.length) ctx.warn(rule, `疑似用語：${[...new Set(warns.map(h => h.term))].slice(0, 5).join('、')}`, loc(u));
}
const plainOf = u => stripSlots(u.raw);

export function r09(ctx) { for (const u of ctx.units) if (u.raw) emitHits(ctx, 'R09', u, scanWords(plainOf(u), { rules: ['R09'] })); }
export function r19(ctx) { for (const u of ctx.units) if (u.raw) emitHits(ctx, 'R19', u, scanWords(plainOf(u), { rules: ['R19'] })); }

const isOutlookScope = u => u.claim?.kind === 'conditional' || u.claim?.kind === 'linkage' || u.sectionId === 'linkage' || u.sectionId === 'outlook' || u.scope === 'linkages' || u.field === 'cond.watch';

export function r10(ctx) {
  for (const u of ctx.units) {
    if (!u.raw) continue;
    const plain = plainOf(u);
    emitHits(ctx, 'R10', u, scanWords(plain, { rules: ['R10'] }));
    // 未來時態句：只准出現在條件式（conditional／next 卡 outlook／linkage／連動／觀察條件），且須含條件詞
    const masked = maskAllowed(plain);
    const fut = [...masked.matchAll(new RegExp(FUTURE_MOVE_RE.source, 'g'))].filter(m => !isNegated(masked, m.index));
    const allowedFuture = u.claim?.kind === 'conditional' || u.futureOk || (u.cardId === 'next' && (u.sectionId === 'outlook' || u.sectionId === 'linkage'));
    if (fut.length) {
      if (!allowedFuture) ctx.block('R10', `未來時態句「${fut[0][0]}」只准出現在條件式（conditional／明日卡 outlook・linkage）`, loc(u));
      else if (!CONDITIONAL_WORDS_RE.test(plain)) ctx.block('R10', `未來句「${fut[0][0]}」必須含 若／當／觀察／留意／是否 等條件詞`, loc(u));
    }
    if (u.kind === 'claim' && u.claim.kind === 'conditional') {
      const c = u.claim.cond;
      if (!isObj(c) || !isObj(c.if) || typeof c.if.ref !== 'string' || typeof c.watch !== 'string') ctx.block('R10', 'conditional 型 claim 必須帶 cond（可觀測條件＋門檻 ref）', loc(u));
    }
  }
}

export function r22(ctx) {
  for (const u of ctx.units) {
    if (!u.raw || !isOutlookScope(u)) continue;
    emitHits(ctx, 'R22', u, scanWords(plainOf(u), { rules: ['R22'] }));
  }
}

// ── R20 ───────────────────────────────────────────────────────────────────────
const charLen = s => [...s].length;
export function r20(ctx) {
  const { pack, units } = ctx;
  for (const u of units) {
    if (!u.raw) continue;
    const plain = plainOf(u);
    const simp = findSimplified(plain);
    if (simp.length) ctx.block('R20', `含簡體字：${simp.slice(0, 6).join('')}`, loc(u));
    if (EMOJI_RE.test(plain)) ctx.block('R20', '含 emoji／圖示符號', loc(u));
    const md = MARKDOWN_RES.find(m => m.re.test(plain));
    if (md) ctx.block('R20', `含 Markdown 殘留（${md.id}）`, loc(u));
    if (EXTERNAL_LINK_RE.test(plain)) ctx.block('R20', '含外部連結', loc(u));
    const rendered = renderSlots(u.raw, pack).text;
    const n = charLen(rendered);
    const max = u.maxChars ?? MAX_SENTENCE_CHARS;
    if (n > max) ctx.block('R20', `單句 ${n} 字，超過上限 ${max}`, loc(u));
    const sentences = rendered.split(/[。！？!?]/).map(x => x.trim()).filter(Boolean);
    if (sentences.length > 1 && u.kind === 'claim') ctx.warn('R20', `一句一檢：本則含 ${sentences.length} 句`, loc(u));
  }
}
