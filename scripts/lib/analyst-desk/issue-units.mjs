// ─────────────────────────────────────────────────────────────────────────────
// 走訪 issue：把所有「LLM 寫的文字」與「ref 引用處」攤平成清單，供各查核規則共用（純函式）。
// 容錯：issue 形狀不對時回傳盡量多的單元，不丟例外（R01 負責回報結構錯誤）。
// ─────────────────────────────────────────────────────────────────────────────
import { extractSlots, refsOfRaw } from './slots.mjs';

export const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export const arr = x => (Array.isArray(x) ? x : []);
export const str = x => (typeof x === 'string' ? x : '');

/**
 * 文字單元：
 *   { path, kind:'claim'|'text', field, scope:'summary'|'card'|'linkages'|'focus',
 *     cardId, sectionId, analyst, stockCode, claim, claimId, raw, declared (string[]|null), refsMode:'equal'|'superset'|'none',
 *     maxChars, futureOk }
 * maxChars：該欄位單句字數上限（R20）。
 */
export function collectUnits(issue) {
  const units = [];
  const push = u => units.push({ cardId: null, sectionId: null, analyst: null, stockCode: null, claim: null, claimId: null, declared: null, refsMode: 'none', ...u });
  const sum = isObj(issue?.summary) ? issue.summary : {};

  // W3 組稿慣例：headlineRaw／thesisRaw／watchConditions[].raw／linkages[].raw 存含槽位原文，headline／thesis／…text 存渲染後文字。
  //   有 raw 變體時掃 raw，並以 stored 記下渲染文字供「未被改寫」比對（R03）；沒有就把該欄位本身當原文。
  if (typeof sum.headline === 'string') {
    const hasRaw = typeof sum.headlineRaw === 'string';
    push({ path: 'summary.headline', kind: 'text', field: 'headline', scope: 'summary', raw: hasRaw ? sum.headlineRaw : sum.headline, stored: hasRaw ? sum.headline : undefined, maxChars: 40 });
  }
  for (const list of ['points', 'nextFocus', 'risks']) {
    arr(sum[list]).forEach((c, i) => claimUnits(push, c, `summary.${list}[${i}]`, { scope: 'summary', field: list }));
  }

  arr(issue?.cards).forEach((card, ci) => {
    if (!isObj(card)) return;
    arr(card.sections).forEach((sec, si) => {
      if (!isObj(sec)) return;
      arr(sec.claims).forEach((c, k) => claimUnits(push, c, `cards[${ci}].sections[${si}].claims[${k}]`, { scope: 'card', cardId: card.id, sectionId: sec.id, analyst: sec.analyst, field: 'claims' }));
    });
    const focus = isObj(card.focus) ? card.focus : {};
    if (typeof focus.note === 'string') push({ path: `cards[${ci}].focus.note`, kind: 'text', field: 'note', scope: 'focus', cardId: card.id, raw: focus.note, maxChars: 90 });
    arr(focus.stocks).forEach((s, si) => {
      if (!isObj(s)) return;
      const base = { scope: 'focus', cardId: card.id, stockCode: s.code };
      const p = `cards[${ci}].focus.stocks[${si}]`;
      if (typeof s.thesis === 'string') {
        const hasRaw = typeof s.thesisRaw === 'string';
        push({ ...base, path: `${p}.thesis`, kind: 'text', field: 'thesis', raw: hasRaw ? s.thesisRaw : s.thesis, stored: hasRaw ? s.thesis : undefined, maxChars: 80 });
      }
      for (const [field, extra] of [['watchConditions', { futureOk: true }], ['risks', {}]]) {
        arr(s[field]).forEach((w, wi) => {
          if (!isObj(w) || typeof w.text !== 'string') return;
          const hasRaw = typeof w.raw === 'string';
          push({ ...base, ...extra, path: `${p}.${field}[${wi}]`, kind: 'text', field, raw: hasRaw ? w.raw : w.text, stored: hasRaw ? w.text : undefined, declared: arr(w.refs), refsMode: 'superset', maxChars: 90 });
        });
      }
    });
  });

  arr(issue?.linkages).forEach((l, i) => {
    if (!isObj(l)) return;
    const hasRaw = typeof l.raw === 'string';
    push({ path: `linkages[${i}].text`, kind: 'text', field: 'linkages', scope: 'linkages', claimId: l.id ?? null, raw: hasRaw ? l.raw : str(l.text), stored: hasRaw ? str(l.text) : undefined, declared: arr(l.refs), refsMode: 'superset', maxChars: 90, futureOk: true });
  });
  return units;
}

function claimUnits(push, c, path, base) {
  if (!isObj(c)) return;
  const raw = typeof c.raw === 'string' ? c.raw : typeof c.text === 'string' ? c.text : '';
  push({ ...base, path, kind: 'claim', claim: c, claimId: c.id ?? null, raw, declared: arr(c.refs), refsMode: 'equal', maxChars: 90 });
  if (isObj(c.cond) && typeof c.cond.watch === 'string') push({ ...base, path: `${path}.cond.watch`, kind: 'text', field: 'cond.watch', claim: c, claimId: c.id ?? null, raw: c.cond.watch, maxChars: 90, futureOk: true });
}

/** 一個單元實際引用的 ref：槽位∪標記∪宣告。 */
export function unitRefs(u) {
  const out = new Set(refsOfRaw(u.raw));
  for (const r of u.declared ?? []) if (typeof r === 'string') out.add(r);
  return [...out];
}

/** 全部 ref 使用處：[{ id, path, via, cardId, claimId, stockCode }]（供 R04／R17）。 */
export function collectRefUses(issue, units = collectUnits(issue)) {
  const uses = [];
  const add = (id, path, via, extra) => { if (typeof id === 'string') uses.push({ id, path, via, cardId: null, claimId: null, stockCode: null, ...extra }); };
  for (const u of units) {
    const base = { cardId: u.cardId, claimId: u.claimId, stockCode: u.stockCode, scope: u.scope };
    for (const s of extractSlots(u.raw)) add(s.ref, u.path, s.kind, base);
    for (const r of u.declared ?? []) add(r, u.path, 'declared', base);
    if (u.field === 'cond.watch') add(u.claim?.cond?.if?.ref, `${u.path}.if`, 'cond', base);
  }
  arr(issue?.cards).forEach((card, ci) => arr(card?.focus?.stocks).forEach((s, si) => {
    if (!isObj(s)) return;
    const base = { cardId: card.id, stockCode: s.code, scope: 'focus' };
    const p = `cards[${ci}].focus.stocks[${si}]`;
    arr(s.evidence).forEach((e, ei) => add(e?.ref, `${p}.evidence[${ei}]`, 'evidence', base));
    arr(s.adverse).forEach((a, ai) => add(a, `${p}.adverse[${ai}]`, 'adverse', base));
    add(s.asOf?.closeRef, `${p}.asOf.closeRef`, 'closeRef', base);
  }));
  arr(issue?.linkages).forEach((l, i) => {
    add(l?.from?.ref, `linkages[${i}].from`, 'linkage', { scope: 'linkages', claimId: l?.id ?? null });
    add(l?.to?.ref, `linkages[${i}].to`, 'linkage', { scope: 'linkages', claimId: l?.id ?? null });
  });
  return uses;
}

// 前綴命名空間（D−1 值／程式預算差值）：prev／diff（契約 §2）與 W1 實作的 pv／df；判斷「是哪一類 ref」時先剝掉前綴。
const PREFIX_NS = new Set(['prev', 'diff', 'pv', 'df']);
const core = id => { const p = String(id).split('.'); return PREFIX_NS.has(p[0]) && p.length > 2 ? p.slice(1) : p; };
/** ref id 的命名空間（第一段，剝掉 prev／diff／pv／df 前綴）與代號段（第二段）。 */
export const nsOf = id => core(id)[0];
export const seg2Of = id => core(id)[1];
export const lastSegOf = id => { const p = String(id).split('.'); return p[p.length - 1]; };
