// ─────────────────────────────────────────────────────────────────────────────
// 引用層規則：R04 ref 存在／宣告一致、R11 方向詞、R12 傳聞、R13 M／O 不加總、R14 等級標示、R16 口徑一致、R17 時點隔離、
//   R18 總結不引入新事實、R21 降級誠實。
// ref 命名空間（契約 §2）：nv.{code}.*＝媒體判別（M）；mo.{code}.{type}.*＝官方公告（O）；wk.*＝wiki；gl.*＝全球…
// ─────────────────────────────────────────────────────────────────────────────
import { REF_ID_RE, STOCK_NAMESPACES, FORBIDDEN_REF_RES, MISSING_TEXT, COMPANION_RULES, ABSENT_SOURCE_KEYWORDS, tierMark, isIsoDate } from './constants.mjs';
import { extractSlots, refsOfRaw, renderSlots, claimTier, tierMarks } from './slots.mjs';
import { stripSlots } from './numbers.mjs';
import { unitRefs, collectRefUses, nsOf, seg2Of, lastSegOf, arr, isObj } from './issue-units.mjs';

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const loc = u => ({ claimId: u.claimId ?? undefined, path: u.path });
const refMeta = (ctx, id) => ctx.pack?.refs?.[id];

// ── R04 ───────────────────────────────────────────────────────────────────────
export function r04(ctx) {
  const { pack, issue, units } = ctx;
  const refs = pack?.refs;
  if (!isObj(refs)) { ctx.block('R04', 'pack.refs 缺漏，無法驗證引用'); return; }
  const uses = collectRefUses(issue, units);
  const reported = new Set();
  for (const use of uses) {
    const key = `${use.id}|${use.path}`;
    if (reported.has(key)) continue; reported.add(key);
    const where = { claimId: use.claimId ?? undefined, path: use.path };
    if (!REF_ID_RE.test(use.id)) { ctx.block('R04', `ref「${use.id}」不合 id 文法`, where); continue; }
    if (!(use.id in refs)) { ctx.block('R04', `ref「${use.id}」不在 pack.refs`, where); continue; }
    if (FORBIDDEN_REF_RES.some(re => re.test(use.id))) ctx.block('R04', `ref「${use.id}」屬已知不可用欄位（口徑錯誤）`, where);
    // 張冠李戴：個股區塊只能引用該檔自己的 st／nv／mo／wk
    if (use.scope === 'focus' && use.stockCode && STOCK_NAMESPACES.includes(nsOf(use.id)) && seg2Of(use.id) !== String(use.stockCode)) {
      ctx.block('R04', `個股 ${use.stockCode} 的區塊引用了他檔的 ref「${use.id}」`, where);
    }
  }
  // 值槽位不可填缺值（缺值用 [ref:id]＋「來源未提供」）
  for (const u of units) {
    for (const s of extractSlots(u.raw)) {
      if (s.kind !== 'slot' || !(s.ref in refs)) continue;
      const { missing } = renderSlots(`{{${s.ref}}}`, pack);
      if (missing.includes(s.ref)) ctx.block('R04', `值槽位「${s.ref}」在 pack 中缺值（來源未提供）；請改用 [ref:${s.ref}] 並寫「來源未提供」`, loc(u));
    }
    // 宣告與抽出一致
    if (!u.declared) continue;
    const extracted = refsOfRaw(u.raw);
    const declared = u.declared.filter(x => typeof x === 'string');
    if (u.refsMode === 'equal' && !sameSet(extracted, [...new Set(declared)])) ctx.block('R04', `claim.refs 與文字抽出的槽位／標記不一致（宣告 [${declared}]｜抽出 [${extracted}]）`, loc(u));
    if (u.refsMode === 'superset') { const lack = extracted.filter(x => !declared.includes(x)); if (lack.length) ctx.block('R04', `refs 未涵蓋文字內引用：${lack.join('、')}`, loc(u)); }
  }
  // refTable 與 pack 一致
  const table = isObj(issue?.refTable) ? issue.refTable : {};
  for (const [id, r] of Object.entries(table)) {
    const p = refs[id];
    if (!p) { ctx.block('R04', `refTable 含 pack 沒有的 ref「${id}」`); continue; }
    for (const k of ['v', 'unit', 'fmt', 'asOf', 'tier', 'source']) {
      if (JSON.stringify(r?.[k]) !== JSON.stringify(p[k])) ctx.block('R04', `refTable.${id}.${k} 與 pack 不一致（疑似被改寫）`);
    }
  }
  const used = new Set(uses.map(x => x.id));
  const lacking = [...used].filter(id => id in refs && !(id in table));
  if (lacking.length) ctx.warn('R04', `refTable 缺 ${lacking.length} 個被引用的 ref（前端證據晶片會缺值）：${lacking.slice(0, 5).join('、')}`);
  const extra = Object.keys(table).filter(id => !used.has(id));
  if (extra.length) ctx.warn('R04', `refTable 含 ${extra.length} 個未被引用的 ref：${extra.slice(0, 5).join('、')}`);
}

// ── R11 ───────────────────────────────────────────────────────────────────────
const normDir = v => {
  if (v === '利多' || v === '+' || v === '＋' || v === 1 || v === '正' || v === 'bullish') return '利多';
  if (v === '利空' || v === '-' || v === '−' || v === '－' || v === -1 || v === '負' || v === 'bearish') return '利空';
  return null;
};
const SIGNED_FMTS = ['sg2', 'pts1'];
const UP_RE = /上漲|走強|拉抬|收漲|上揚|攀升/;
const DOWN_RE = /下跌|走弱|拖累|收跌|下滑|下挫|重挫/;
const LEGAL_RE = /法律|C16a|legal/i;
const DIR_STRONG = ['利多', '利空', '偏強', '偏弱', '拉抬', '拖累'];

export function r11(ctx) {
  const { pack, units } = ctx;
  for (const u of units) {
    if (u.kind !== 'claim') continue;
    const c = u.claim;
    const ids = unitRefs(u);
    const metas = ids.map(id => ({ id, m: refMeta(ctx, id) })).filter(x => x.m);
    const nvLabels = metas.filter(x => nsOf(x.id) === 'nv' && lastSegOf(x.id) === 'label');
    const moDirs = metas.filter(x => nsOf(x.id) === 'mo' && lastSegOf(x.id) === 'dir');
    const plain = stripSlots(u.raw);
    const dir = c.direction;
    const L = loc(u);

    if (dir === '利多' || dir === '利空') {
      if (nvLabels.length) {
        const vals = nvLabels.map(x => normDir(x.m.v));
        if (vals.some(v => v === null)) ctx.block('R11', `方向「${dir}」但引用的 ${nvLabels.find((x, i) => vals[i] === null).id} 值為「${nvLabels.find((x, i) => vals[i] === null).m.v}」（非利多／利空）`, L);
        else if (new Set(vals).size > 1) ctx.block('R11', `引用的 nv label 方向互相矛盾（${vals.join('／')}），不可寫成單一方向`, L);
        else if (vals[0] !== dir) ctx.block('R11', `claim.direction「${dir}」與 ${nvLabels[0].id} 的 label「${nvLabels[0].m.v}」不一致`, L);
      } else if (moDirs.length) {
        const vals = moDirs.map(x => normDir(x.m.v));
        if (vals.some(v => v === null)) ctx.block('R11', `O 管線 ${moDirs[vals.indexOf(null)].id} 無規則方向，只准寫「需讀內文」`, L);
        else if (vals.some(v => v !== dir)) ctx.block('R11', `claim.direction「${dir}」與 O 規則方向（${vals.join('／')}）不一致`, L);
      } else ctx.block('R11', `「${dir}」只能用於 M 管線 nv.*.label 或 O 規則方向 mo.*.dir 的引用`, L);
    }
    // 中性／資訊不足不得被寫成偏多
    if (['利多', '偏強', '拉抬'].includes(dir)) {
      const bad = nvLabels.find(x => ['中性', '資訊不足'].includes(x.m.v) || x.m.v == null);
      if (bad) ctx.block('R11', `${bad.id} 為「${bad.m.v ?? '無'}」，不得寫成「${dir}」`, L);
    }
    // 涉法律事件一律利空
    const legal = metas.find(x => nsOf(x.id) === 'nv' && lastSegOf(x.id) === 'eventType' && LEGAL_RE.test(String(x.m.v)));
    if (legal && dir !== '利空') ctx.block('R11', `涉法律事件（${legal.id}＝${legal.m.v}）方向必須為「利空」`, L);
    // 標題級判別（basis≠content 或 gate 非空）不得判方向
    if (DIR_STRONG.includes(dir)) {
      const weak = metas.find(x => nsOf(x.id) === 'nv' && ((lastSegOf(x.id) === 'basis' && x.m.v !== 'content') || (lastSegOf(x.id) === 'gate' && x.m.v != null && x.m.v !== '')));
      if (weak) ctx.block('R11', `${weak.id}＝${weak.m.v}：僅標題或資訊不足，不得判方向`, L);
    }
    // 文字中的利多／利空要與 direction 一致
    const hasUp = /利多/.test(plain), hasDn = /利空/.test(plain);
    if (hasUp && hasDn) ctx.block('R11', '同句同時出現「利多」與「利空」', L);
    else if (hasUp && dir !== '利多') ctx.block('R11', `文字寫「利多」但 direction=「${dir}」`, L);
    else if (hasDn && dir !== '利空') ctx.block('R11', `文字寫「利空」但 direction=「${dir}」`, L);
    // priced 不是「尚未反映」的證據（99/103 為否）
    if (/尚未反映|未反映|尚未消化|未消化/.test(plain) && metas.some(x => nsOf(x.id) === 'nv' && lastSegOf(x.id) === 'priced')) ctx.block('R11', 'priced 欄位不可作為「尚未反映」的證據（只能用公告時點）', L);
    // 方向詞／漲跌字樣與數值正負一致
    const signed = metas.filter(x => SIGNED_FMTS.includes(x.m.fmt) && typeof x.m.v === 'number');
    const pos = signed.filter(x => x.m.v > 0).length, neg = signed.filter(x => x.m.v < 0).length;
    if (['偏強', '拉抬'].includes(dir) && pos === 0 && neg > 0) ctx.block('R11', `direction「${dir}」但引用的數值皆為負（${signed.map(x => x.id)}）`, L);
    if (['偏弱', '拖累'].includes(dir) && neg === 0 && pos > 0) ctx.block('R11', `direction「${dir}」但引用的數值皆為正（${signed.map(x => x.id)}）`, L);
    const up = UP_RE.test(plain), dn = DOWN_RE.test(plain);
    if (up && !dn && pos === 0 && neg > 0) ctx.block('R11', '文字寫上漲／走強，但引用的數值為負', L);
    if (dn && !up && neg === 0 && pos > 0) ctx.block('R11', '文字寫下跌／走弱，但引用的數值為正', L);
  }
}

// ── R12 ───────────────────────────────────────────────────────────────────────
const isRumorRef = (id, m) => m?.tier === '傳聞' || (nsOf(id) === 'nv' && lastSegOf(id) === 'certainty' && m?.v === '傳聞');
const RUMOR_WORD = /傳聞|媒體報導/;

export function r12(ctx) {
  const { issue, units } = ctx;
  for (const u of units) {
    const rumor = unitRefs(u).filter(id => isRumorRef(id, refMeta(ctx, id)));
    if (!rumor.length) continue;
    if (u.scope === 'summary' && (u.field === 'headline' || u.field === 'points')) ctx.block('R12', `傳聞（${rumor[0]}）不得出現在 summary.${u.field}`, loc(u));
    else if (!RUMOR_WORD.test(stripSlots(u.raw))) ctx.block('R12', `引用傳聞（${rumor[0]}）的句子必須含「傳聞」或「媒體報導」`, loc(u));
  }
  arr(issue?.cards).forEach(card => arr(card?.focus?.stocks).forEach(s => {
    const ev = arr(s?.evidence).map(e => e?.ref).filter(Boolean);
    if (ev.length && ev.every(id => isRumorRef(id, refMeta(ctx, id)))) ctx.block('R12', `個股 ${s.code} 的證據全為傳聞，不得入名單`, { code: s.code, cardId: card.id });
  }));
}

// ── R13 ───────────────────────────────────────────────────────────────────────
const CROSS_SUM = /(?:官方|公告|重訊)[^。，；]{0,6}(?:與|及|和|加)[^。，；]{0,6}(?:媒體|新聞)[^。，；]{0,10}(?:合計|加總|總計|共)|(?:媒體|新聞)[^。，；]{0,6}(?:與|及|和|加)[^。，；]{0,6}(?:官方|公告|重訊)[^。，；]{0,10}(?:合計|加總|總計|共)/;
const AGG_COUNT = /(?:共|合計|總計|累計|總共)\s*(?:§|\d+)?\s*(?:則|件|筆|篇)/;
const BULL_BEAR_COUNT = /利多[^。]{0,12}(?:件|則|筆)[^。]{0,12}利空[^。]{0,12}(?:件|則|筆)|利空[^。]{0,12}(?:件|則|筆)[^。]{0,12}利多[^。]{0,12}(?:件|則|筆)/;

export function r13(ctx) {
  for (const u of ctx.units) {
    const ids = unitRefs(u);
    const nv = ids.filter(id => nsOf(id) === 'nv'), mo = ids.filter(id => nsOf(id) === 'mo');
    const plain = stripSlots(u.raw);
    if (nv.length && mo.length) {
      const numeric = [...nv, ...mo].some(id => typeof refMeta(ctx, id)?.v === 'number');
      if (numeric) ctx.block('R13', `同一句同時引用 M（${nv[0]}）與 O（${mo[0]}）的數值：M／O 不可加總`, loc(u));
      else if (AGG_COUNT.test(plain)) ctx.block('R13', '同一句跨 M／O 管線出現總數字樣（共／合計 N 則）', loc(u));
    }
    if (CROSS_SUM.test(plain)) ctx.block('R13', '出現官方與媒體合計／加總字樣', loc(u));
    if (BULL_BEAR_COUNT.test(plain)) ctx.block('R13', '不可用「利多 N 件 vs 利空 M 件」比較市況強弱（偏斜）', loc(u));
  }
}

// ── R14 ───────────────────────────────────────────────────────────────────────
export function r14(ctx) {
  const { pack, issue, units, opts } = ctx;
  for (const u of units) {
    if (u.kind !== 'claim') continue;
    const c = u.claim;
    const ids = refsOfRaw(u.raw);
    const metas = ids.map(id => ({ id, m: refMeta(ctx, id) })).filter(x => x.m);
    const expected = claimTier(ids, pack, c.kind);
    if (ids.length && expected && c.tier !== expected) ctx.block('R14', `claim.tier「${c.tier}」應為 refs 中最低等級「${expected}」`, loc(u));
    if (typeof c.text === 'string') {
      for (const t of tierMarks(ids, pack, c.kind)) if (!c.text.includes(tierMark(t))) ctx.block('R14', `渲染文字缺等級標記「${tierMark(t)}」（須由程式附加）`, loc(u));
    }
    if (metas.length && metas.every(x => nsOf(x.id) === 'wk' || x.m.tier === '先驗·未驗證')) ctx.block('R14', 'wiki／熱力先驗層不得為唯一依據', loc(u));
    for (const rule of opts.companionRules ?? COMPANION_RULES) {
      const re = new RegExp(rule.when);
      if (ids.some(id => re.test(id)) && !ids.includes(rule.needs)) ctx.block('R14', `引用 ${ids.find(id => re.test(id))} 時必須同句引用 ${rule.needs}`, loc(u));
    }
  }
  arr(issue?.linkages).forEach(l => {
    if (!isObj(l)) return;
    const ids = [...new Set([l.from?.ref, l.to?.ref, ...arr(l.refs)].filter(x => typeof x === 'string'))];
    const expected = claimTier(ids, pack, 'linkage');
    if (expected && l.tier !== expected) ctx.block('R14', `linkage ${l.id} 的 tier「${l.tier}」應為「${expected}」（連動最高只到站內整理）`, { claimId: l.id });
  });
}

// ── R16 ───────────────────────────────────────────────────────────────────────
export function r16(ctx) {
  for (const u of ctx.units) {
    if (!u.raw) continue;
    const { badFmt } = renderSlots(u.raw, ctx.pack);
    if (badFmt.length) ctx.block('R16', `槽位格式與 pack 預設不同或不在封閉清單：${badFmt.map(b => `${b.ref}|${b.written}（應為 ${b.expected ?? '—'}）`).join('、')}`, loc(u));
  }
}

// ── R17 ───────────────────────────────────────────────────────────────────────
const DEFAULT_NEXT_DAY_NS = ['gl', 'fx', 'adr', 'cal', 'mo', 'nv'];
export function r17(ctx) {
  const { pack, issue, opts } = ctx;
  const refs = pack?.refs ?? {};
  const dates = issue?.dates ?? pack?.dates ?? {};
  const D = dates.data, N = dates.next, P = dates.prev;
  const morning = (issue?.edition ?? pack?.edition) === 'morning';
  const nextNs = opts.nextDayNamespaces ?? DEFAULT_NEXT_DAY_NS;
  const bad = new Set();
  for (const use of collectRefUses(issue, ctx.units)) {
    const m = refs[use.id];
    if (!m) continue; // R04
    if (!isIsoDate(m.asOf)) { bad.add(`${use.id}|noasof`); ctx.block('R17', `ref「${use.id}」缺 asOf，無法驗證時點`, { claimId: use.claimId ?? undefined, path: use.path }); continue; }
    let ok = true, why = '';
    if (use.cardId === 'prev') { ok = m.asOf <= P; why = `prev 卡只能引用 asOf ≤ ${P}`; }
    else if (use.cardId === 'data') { ok = m.asOf <= D; why = `data 卡只能引用 asOf ≤ ${D}`; }
    else if (use.cardId === 'next') {
      ok = m.asOf < N || (morning && nextNs.includes(nsOf(use.id)) && m.asOf <= N);
      why = `next 卡不得引用下一交易日 ${N} 的資料（evening 版一律；morning 版僅 ${nextNs.join('／')} 命名空間可到當日）`;
    } else { ok = m.asOf <= D || (morning && nextNs.includes(nsOf(use.id)) && m.asOf <= N); why = `引用 asOf ≤ ${D}`; }
    if (!ok) {
      const key = `${use.id}|${use.cardId}|${use.path}`;
      if (bad.has(key)) continue; bad.add(key);
      ctx.block('R17', `ref「${use.id}」asOf=${m.asOf}：${why}`, { claimId: use.claimId ?? undefined, path: use.path });
    }
  }
}

// ── R18 ───────────────────────────────────────────────────────────────────────
export function r18(ctx) {
  const { issue, units } = ctx;
  const cardRefs = new Set();
  const cardClaimRefs = [];
  for (const u of units) {
    if (u.scope === 'summary' || u.scope === 'linkages') continue;
    for (const id of unitRefs(u)) cardRefs.add(id);
    if (u.kind === 'claim') cardClaimRefs.push(new Set(unitRefs(u)));
  }
  arr(issue?.cards).forEach(card => arr(card?.focus?.stocks).forEach(s => arr(s?.evidence).forEach(e => e?.ref && cardRefs.add(e.ref))));
  for (const u of units) {
    if (u.scope !== 'summary') continue;
    const ids = unitRefs(u);
    const novel = ids.filter(id => !cardRefs.has(id));
    if (novel.length) ctx.block('R18', `總結引入了各卡未用的 ref：${novel.slice(0, 4).join('、')}`, loc(u));
    if (u.field === 'points' && u.kind === 'claim') {
      if (ids.length === 0 && u.claim.kind !== 'caveat') ctx.block('R18', '總結 point 沒有任何 ref，無法對應到卡內 claim', loc(u));
      else if (ids.length && !cardClaimRefs.some(set => ids.some(id => set.has(id)))) ctx.block('R18', '總結 point 在各卡內找不到共用 ref 的 claim（不得引入新事實）', loc(u));
    }
  }
}

// ── R21 ───────────────────────────────────────────────────────────────────────
const DEGRADED_RULES = Object.freeze([
  { test: /overnight|隔夜/i, re: /隔夜|昨夜|昨晚|美股(?:昨|收盤|夜盤)/, unless: /未更新|來源未提供/, level: 'block', why: '全球夜盤未更新' },
  { test: /chip|籌碼/i, re: /法人|外資|投信|自營|買賣超|籌碼/, unless: /未提供|不足|未到齊/, level: 'block', why: '籌碼資料未到齊' },
  { test: /media|news/i, re: /消息面/, unless: /覆蓋|不足|未完整/, level: 'warn', why: '媒體判別覆蓋不足，不得斷言消息面' },
]);

export function r21(ctx) {
  const { pack, issue, units, opts } = ctx;
  const absent = arr(pack?.absent), degraded = arr(pack?.degraded);
  const kw = { ...ABSENT_SOURCE_KEYWORDS, ...(opts.absentKeywords ?? {}) };
  for (const u of units) {
    if (!u.raw) continue;
    const plain = stripSlots(u.raw);
    const honest = plain.includes(MISSING_TEXT);
    for (const name of absent) {
      const re = kw[name];
      const hit = re ? re.test(plain) : plain.includes(name);
      if (hit && !honest) ctx.block('R21', `來源「${name}」缺席（pack.absent），不得描述其內容；應寫「${MISSING_TEXT}」`, loc(u));
    }
    for (const d of degraded) {
      for (const rule of DEGRADED_RULES) {
        if (!rule.test.test(d) || !rule.re.test(plain) || rule.unless.test(plain)) continue;
        if (rule.level === 'block') ctx.block('R21', `降級（${d}）：${rule.why}，此句不得斷言`, loc(u));
        else ctx.warn('R21', `降級（${d}）：${rule.why}`, loc(u));
      }
    }
    // 引用 pack 內值為 null 的 ref（[ref:id]）：句子必須明寫「來源未提供」
    for (const id of refsOfRaw(u.raw)) {
      const m = refMeta(ctx, id);
      if (m && (m.v === null || m.v === undefined) && !honest) ctx.block('R21', `ref「${id}」在 pack 中缺值，此句必須明寫「${MISSING_TEXT}」`, loc(u));
      if (m && absent.includes(m.source)) ctx.block('R21', `ref「${id}」的來源「${m.source}」在 pack.absent 內`, loc(u));
    }
  }
  const md = arr(issue?.meta?.degraded);
  const lack = degraded.filter(d => !md.includes(d));
  if (lack.length) ctx.block('R21', `meta.degraded 未揭露 pack 降級項：${lack.join('、')}`);
  if (isObj(issue?.meta?.pack) && !sameSet(arr(issue.meta.pack.absent), absent)) ctx.block('R21', 'meta.pack.absent 與 pack.absent 不一致');
}
