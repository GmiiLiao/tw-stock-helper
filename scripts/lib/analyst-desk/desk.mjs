// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊流程編排（契約 §5）：R0 pack（程式，已在外面組好）→ R1 三位獨立撰稿 → R2 交叉審閱＋連動
//   → R3 總編輯整合 → R4 機械查核＋LLM 紅隊（blocker 退回總編輯修 ≤2 輪；redaction 由程式刪）。
//   降級階梯：claude-cli → ollama（R1 三稿＋總編輯，略過 R2）→ template（meta.fallback='template'，頁面退回模板版）。
//   本檔只做編排與組稿，不寫檔（寫入／寫一次／manifest 在 archive.mjs）。LLM 輸出一律當不可信輸入：
//   claim.refs／tier／text 由程式從 raw 重算；個股的 name／market／industry／adverse／asOf 由程式從 pack 帶入；
//   卡片標題、useRules、免責、meta 由程式寫入，LLM 沒有這些欄位的寫入權。
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { callModel, EngineAuthError, ollamaFree } from './engine.mjs';
import * as P from './prompts.mjs';
import * as K from './constants.mjs';
import { deskChecks } from './desk-checks.mjs';
import { renderClaim, renderSlots, refsOfRaw, claimTier, SLOT_RE_SOURCE } from './slots.mjs';

const MAX_REPAIR = 2;
const SECTION_TITLE = { overview: '盤勢總覽', momentum: '交易動能', diff: '與前一交易日的差異', outlook: '觀察重點', linkage: '連動分析', news: '消息面', industry: '產業與族群', global: '全球與總經' };
const sha = o => createHash('sha256').update(typeof o === 'string' ? o : JSON.stringify(o)).digest('hex');
/** 槽位格式 LLM 無權選（R16）：一律改寫成 pack 的預設 fmt（ref 不存在則保持原樣，交給查核擋）。 */
const normRaw = (raw, pack) => str(raw).replace(new RegExp(SLOT_RE_SOURCE, 'g'), (m, ref) => { const f = pack.refs?.[ref]?.fmt; return f && K.FMTS.includes(f) ? `{{${ref}|${f}}}` : m; });
const arr = x => (Array.isArray(x) ? x : []);
const str = x => (typeof x === 'string' ? x : '');

/** 呼叫並要求 JSON；解析失敗重試一次（把失敗原因附在 user 後）。 */
async function callJson(base, log, label) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const user = attempt === 0 ? base.user : `${base.user}\n\n【上一次回覆無法解析為 JSON，請只輸出單一 JSON 物件】`;
    last = await (base.call || callModel)({ ...base, call: undefined, user });
    log?.({ label, attempt, model: last.model, usage: last.usage, ok: !!last.json, raw: last.json ? undefined : last.text.slice(0, 400) });
    if (last.json && typeof last.json === 'object') return last;
  }
  return { ...last, json: null };
}

// ── 組稿：把（不可信的）LLM 輸出變成符合契約的 issue ───────────────────────────
/** 「需讀內文」只屬於官方公告（mo.*）；其他句子給它只是雜訊，改為「無」（文字已寫利多／利空者不動，交給 R11）。 */
function normDirection(d, refs, text) {
  if (!K.DIRECTIONS.includes(d)) return '無';
  if (d === '需讀內文' && !refs.some(r => r.startsWith('mo.')) && !/利多|利空/.test(text)) return '無';
  return d;
}

function finishClaim(c, pack, analyst, nextId) {
  const raw = normRaw(c?.raw, pack).trim();
  if (!raw) return null;
  const rendered = renderClaim({ raw, kind: c.kind }, pack);
  const refs = refsOfRaw(raw);
  const kind = K.CLAIM_KINDS.includes(c.kind) ? c.kind : 'fact';
  const out = {
    id: nextId(), raw, text: rendered.text, refs, kind,
    tier: claimTier(refs, pack, kind),
    direction: normDirection(c.direction, refs, rendered.text),
    authors: [K.ANALYSTS.includes(analyst) ? analyst : 'editor'],
  };
  if (kind === 'conditional' && c.cond && c.cond.if?.ref) out.cond = { if: { ref: str(c.cond.if.ref), op: c.cond.if.op, value: c.cond.if.value }, watch: str(c.cond.watch) };
  return out;
}

function finishText(rawIn, pack) {            // 個股的 thesis／watchConditions／risks：raw 與渲染值一起存
  const raw = normRaw(rawIn, pack);
  const r = renderSlots(raw, pack);
  return { raw: raw.trim(), text: r.text, refs: refsOfRaw(raw) };
}

function finishStock(s, cardId, pack, dates, nominated = {}) {
  const code = str(s?.code).trim();
  const pool = arr(pack.pools?.[cardId]).find(x => x.code === code);
  const th = finishText(s.thesis, pack);
  const conds = arr(s.watchConditions).map(w => { const t = finishText(w?.text, pack); return { text: t.text, raw: t.raw, refs: t.refs }; });
  const risks = arr(s.risks).map(w => { const t = finishText(w?.text, pack); return { text: t.text, raw: t.raw, refs: t.refs }; });
  for (let i = risks.length - 1; i >= 0; i--) if (risks.findIndex(r => r.raw === risks[i].raw) !== i) risks.splice(i, 1);   // 編輯回送時可能重複
  // R08：risks 必須涵蓋 pack 算出的 adverse（反證不由 LLM 取捨）；沒涵蓋的由程式補一條只含引用的風險句
  const adverse = [...(pack.adverse?.[code] || [])];
  // 自身官方證據：LLM 沒帶就由程式補該檔收盤（st.{code}.close，官方）——事實來自資料包，不是 LLM
  const evidence = arr(s.evidence).filter(e => e?.ref).map(e => ({ ref: str(e.ref), role: K.EVIDENCE_ROLES.includes(e.role) ? e.role : 'context' }));
  const ownOfficial = evidence.some(e => e.ref.startsWith(`st.${code}.`) && ['官方', '官方衍生'].includes(pack.refs?.[e.ref]?.tier));
  const closeRef = cardId === 'prev' ? `st.${code}.prevClose` : `st.${code}.close`;   // prev 卡只能引用 D−1 的 ref（R17）
  if (!ownOfficial && pack.refs?.[closeRef]) evidence.unshift({ ref: closeRef, role: 'price' });
  // 明日卡（watch）要有帶 ref 的觀察條件：沒有就用該檔成交值延續與否（st.{code}.valM）——只描述觀察項，不預測
  const valRef = `st.${code}.valM`;
  if (cardId === 'next' && !conds.some(c => c.refs.length) && pack.refs?.[valRef]) { const raw = `觀察開盤後成交值是否延續前一交易日水準 [ref:${valRef}]`; conds.push({ text: renderSlots(raw, pack).text, raw, refs: [valRef] }); }
  if (!risks.length && !adverse.length) { const raw = `資料包未列出此檔反向資料 [ref:${closeRef}]`; if (pack.refs?.[closeRef]) risks.push({ text: renderSlots(raw, pack).text, raw, refs: [closeRef] }); }
  const covered = new Set(risks.flatMap(r => r.refs));
  const missing = adverse.filter(r => !covered.has(r));
  if (missing.length) { const raw = `另有反向資料 ${missing.map(r => `[ref:${r}]`).join('')}`; risks.push({ text: renderSlots(raw, pack).text, raw, refs: missing }); }
  return {
    code, name: pool?.name || '', market: pool?.market || '', industry: pool?.industry || '',
    cardId, kind: K.FOCUS_KIND_BY_CARD[cardId],
    thesis: th.text, thesisRaw: th.raw,
    evidence, watchConditions: conds, risks,
    adverse,
    sponsors: sponsorsOf(code, cardId, s, nominated),
    asOf: { day: dates[K.CARD_DATE_KEY[cardId]], closeRef },
  };
}

/** 提名人由程式依 R1 提名記錄決定（LLM 填的只當補充）；編輯從池內補選、無人提名者署名 editor。 */
function sponsorsOf(code, cardId, s, nominated) {
  const set = new Set(nominated[`${cardId}:${code}`] || []);
  for (const a of arr(s?.sponsors)) if (K.CONTRIBUTORS.includes(a) && set.size === 0) set.add(a);
  return set.size ? K.CONTRIBUTORS.filter(a => set.has(a)) : ['editor'];
}

function collectRefs(issue) {
  const set = new Set();
  const addAll = xs => xs.forEach(r => set.add(r));
  const visitClaim = c => { addAll(arr(c?.refs)); if (c?.cond?.if?.ref) set.add(c.cond.if.ref); };
  arr(issue.summary?.points).concat(arr(issue.summary?.nextFocus), arr(issue.summary?.risks)).forEach(visitClaim);
  for (const card of issue.cards) {
    card.sections.forEach(s => s.claims.forEach(visitClaim));
    for (const st of card.focus.stocks) {
      addAll(st.evidence.map(e => e.ref)); addAll(st.adverse);
      st.watchConditions.concat(st.risks).forEach(x => addAll(x.refs)); addAll(refsOfRaw(st.thesisRaw));
      addAll(arr(K.REF_ID_RE.test(st.asOf.closeRef) ? [st.asOf.closeRef] : []));
    }
  }
  issue.linkages.forEach(l => { addAll(arr(l.refs)); if (l.from?.ref) set.add(l.from.ref); if (l.to?.ref) set.add(l.to.ref); });
  return set;
}

export function assembleIssue(ed, pack, { engineTier, analysts, editorMeta, todayISO, nominated } = {}) {
  let n = 0; const nextId = () => `c${++n}`;
  const dates = pack.dates;
  const cards = K.CARD_IDS.map(id => {
    const src = arr(ed.cards).find(c => c?.id === id) || {};
    const sections = arr(src.sections).filter(s => K.SECTION_IDS.includes(s?.id)).map(s => ({
      id: s.id, title: SECTION_TITLE[s.id], analyst: K.ANALYSTS.includes(s.analyst) ? s.analyst : 'editor',
      claims: arr(s.claims).map(c => finishClaim(c, pack, s.analyst, nextId)).filter(Boolean),
    })).filter(s => s.claims.length);
    const stocks = [];
    const seen = new Set();
    for (const st of arr(src.focus?.stocks)) {
      const code = str(st?.code).trim();
      if (!code || seen.has(code)) continue; seen.add(code);
      stocks.push(finishStock(st, id, pack, dates, nominated || {}));
    }
    return {
      id, title: K.cardTitle(id, dates[K.CARD_DATE_KEY[id]], todayISO),
      asOf: { day: dates[K.CARD_DATE_KEY[id]], label: K.dayLabelOf(id, dates[K.CARD_DATE_KEY[id]], todayISO) },
      sections,
      focus: { kind: K.FOCUS_KIND_BY_CARD[id], poolRule: K.POOL_RULE, poolSize: arr(pack.pools?.[id]).length, excludedCount: arr(pack.excluded?.[id]).length, stocks, note: str(src.focus?.focusNote) },
    };
  });
  const sum = ed.summary || {};
  const mapC = (xs, a = 'editor') => arr(xs).map(c => finishClaim(c, pack, a, nextId)).filter(Boolean);
  const linkages = arr(ed.linkages).map((l, i) => {
    const raw = normRaw(l?.text, pack).trim();
    const refs = refsOfRaw(raw);
    for (const r of [l?.from?.ref, l?.to?.ref, ...arr(l?.refs)]) if (r && !refs.includes(r)) refs.push(r);
    return {
      id: `l${i + 1}`, from: { ref: str(l?.from?.ref) }, to: { ref: str(l?.to?.ref) },
      mechanism: K.MECHANISMS.includes(l?.mechanism) ? l.mechanism : '', tier: claimTier(refs, pack, 'linkage') || '站內整理',   // 等級＝引用 refs 的最弱者（連動最高只到站內整理）
      raw, text: renderSlots(raw, pack).text, refs, authors: arr(l?.authors).filter(a => K.CONTRIBUTORS.includes(a)),
    };
  }).filter(l => l.raw);
  const issue = {
    schema: K.SCHEMA_VERSION, kind: K.ISSUE_KIND, dataDate: pack.dataDate, edition: pack.edition, dates: { ...dates },
    useRules: K.buildUseRules(),
    summary: {
      headline: renderSlots(normRaw(sum.headline, pack), pack).text, headlineRaw: normRaw(sum.headline, pack).trim(),
      points: mapC(sum.points), nextFocus: mapC(sum.nextFocus), risks: mapC(sum.risks),
      byline: { editor: '總編輯', contributors: [...K.CONTRIBUTORS] },
    },
    cards, linkages, refTable: {},
    meta: {
      engineTier, analysts: analysts || [], editor: editorMeta || {},
      check: { pass: false, rules: {}, blockers: 0, redactions: [], warnings: [], repairRounds: 0 },
      degraded: [...(pack.degraded || [])], fallback: null,
      pack: { sha256: sha(pack), refCount: Object.keys(pack.refs || {}).length, absent: [...(pack.absent || [])] },
    },
  };
  for (const id of collectRefs(issue)) if (pack.refs?.[id]) issue.refTable[id] = pack.refs[id];
  return issue;
}

// ── R1／R2／R3／R4 ────────────────────────────────────────────────────────────
function roleDraft(j) {
  return { claims: arr(j?.claims).filter(c => c && typeof c.raw === 'string'), focusProposals: arr(j?.focusProposals).filter(s => s && s.code) };
}

async function runR1(pack, ctx) {
  const poolsText = P.poolsToText(pack);
  const roles = Object.keys(P.ROLES);
  const results = await Promise.all(roles.map(async role => {
    const sys = P.system(role);
    const user = P.r1User({ packText: P.packToText(pack, P.ROLES[role].prefixes), poolsText, dates: pack.dates, absent: pack.absent || [], degraded: pack.degraded || [] });
    try {
      const r = await callJson({ engine: ctx.engine, role, system: sys, user, filesDir: ctx.filesDir, model: ctx.draftModel, effort: ctx.draftEffort, timeoutMs: ctx.timeoutMs, call: ctx.call }, ctx.log, `r1:${role}`);
      if (!r.json) return { role, draft: null, meta: { id: role, engine: ctx.engine, model: r.model, rounds: 1, error: 'json' }, promptSha: P.promptSha(sys) };
      return { role, draft: roleDraft(r.json), meta: { id: role, engine: ctx.engine, model: r.model, promptSha256: P.promptSha(sys), rounds: 2 } };
    } catch (e) {
      if (e instanceof EngineAuthError) throw e;
      ctx.log?.({ label: `r1:${role}`, error: e.message });
      return { role, draft: null, meta: { id: role, engine: ctx.engine, model: null, rounds: 1, error: e.message } };
    }
  }));
  return results;
}

async function runR2(pack, r1, ctx) {
  const live = r1.filter(x => x.draft);
  const refIndex = P.refIndexText(pack);
  const out = await Promise.all(live.map(async x => {
    const others = Object.fromEntries(live.filter(y => y.role !== x.role).map(y => [y.role, y.draft]));
    try {
      const r = await callJson({ engine: ctx.engine, role: x.role, round: 'r2', system: P.r2System(x.role), user: P.r2User({ role: x.role, others, absent: pack.absent || [], degraded: pack.degraded || [], refIndex }), filesDir: ctx.filesDir, model: ctx.draftModel, effort: ctx.draftEffort, timeoutMs: ctx.timeoutMs, call: ctx.call }, ctx.log, `r2:${x.role}`);
      return r.json ? { role: x.role, crossNotes: arr(r.json.crossNotes), linkages: arr(r.json.linkages), vetoes: arr(r.json.vetoes) } : null;
    } catch (e) { if (e instanceof EngineAuthError) throw e; ctx.log?.({ label: `r2:${x.role}`, error: e.message }); return null; }
  }));
  return out.filter(Boolean);
}

/** 紅隊：只看成稿＋pack；回傳 findings（converted 成 blocker 形狀）。引擎失敗不擋稿（記 warning）。 */
async function runRedTeam(issue, pack, ctx) {
  const slim = JSON.parse(JSON.stringify(issue)); delete slim.refTable; delete slim.useRules; delete slim.meta;
  try {
    const r = await callJson({ engine: ctx.engine, role: 'redteam', system: P.redTeamSystem, user: P.redTeamUser({ issue: slim, packText: P.packToText(pack, null, 500) }), filesDir: ctx.filesDir, model: ctx.draftModel, effort: ctx.draftEffort, timeoutMs: ctx.timeoutMs, call: ctx.call }, ctx.log, 'r4:redteam');
    if (!r.json) return { ok: false, findings: [], model: r.model };
    return { ok: true, model: r.model, findings: arr(r.json.findings).filter(f => f && f.claimId && f.msg).map(f => ({ rule: `LLM:${str(f.kind) || 'unsupported'}`, claimId: String(f.claimId), msg: str(f.msg) })) };
  } catch (e) { if (e instanceof EngineAuthError) throw e; ctx.log?.({ label: 'r4:redteam', error: e.message }); return { ok: false, findings: [], model: null }; }
}

/** 程式刪除 claim／個股（紅隊 findings 與最後仍未過的 blocker 用）。 */
export function dropByIds(issue, ids) {
  const s = new Set(ids);
  const keep = c => !s.has(c.id);
  const next = JSON.parse(JSON.stringify(issue));
  next.summary.points = next.summary.points.filter(keep); next.summary.nextFocus = next.summary.nextFocus.filter(keep); next.summary.risks = next.summary.risks.filter(keep);
  next.linkages = next.linkages.filter(l => !s.has(l.id));
  for (const card of next.cards) {
    card.sections = card.sections.map(sec => ({ ...sec, claims: sec.claims.filter(keep) })).filter(sec => sec.claims.length);
    card.focus.stocks = card.focus.stocks.filter(st => !s.has(st.code));
  }
  return next;
}

export function editorToLoose(issue) {   // 給修稿用：回送「編輯輸入格式」——只含含槽位的原文，不含渲染後的數字（否則編輯會照抄裸數字）
  const claim = c => ({ id: c.id, card: undefined, raw: c.raw, kind: c.kind, direction: c.direction, ...(c.cond ? { cond: c.cond } : {}) });
  return {
    summary: { headline: issue.summary.headlineRaw, points: issue.summary.points.map(claim), nextFocus: issue.summary.nextFocus.map(claim), risks: issue.summary.risks.map(claim) },
    cards: issue.cards.map(c => ({
      id: c.id,
      sections: c.sections.map(s => ({ id: s.id, analyst: s.analyst, claims: s.claims.map(claim) })),
      focus: { focusNote: c.focus.note, stocks: c.focus.stocks.map(st => ({ code: st.code, thesis: st.thesisRaw, evidence: st.evidence, watchConditions: st.watchConditions.map(w => ({ text: w.raw, refs: w.refs })), risks: st.risks.map(w => ({ text: w.raw, refs: w.refs })), sponsors: st.sponsors })) },
    })),
    linkages: issue.linkages.map(l => ({ id: l.id, from: l.from, to: l.to, mechanism: l.mechanism, tier: l.tier, text: l.raw, refs: l.refs, authors: l.authors })),
  };
}

/**
 * runDesk({ pack, engine, filesDir, model, log, todayISO, check }) → { issue, transcript }
 * check＝{ checkIssue, applyRedactions }（由呼叫端注入，方便測試；預設動態載入 ./check.mjs）。
 * 拋 EngineAuthError＝未登入（呼叫端據以降級並寫 _alerts）。
 */
export async function runDesk(opts) {
  const { pack, engine, filesDir, todayISO } = opts;
  const transcript = [];
  const log = e => { transcript.push({ ...e }); opts.log?.(e); };
  // 模型分工（僅 claude-cli 有意義；ollama／files 不傳）：草稿／交叉審閱／紅隊用 draftModel＋draftEffort，總編輯與修稿用 editorModel＋editorEffort
  const cli = engine === 'claude-cli';
  const ctx = { engine, filesDir, timeoutMs: opts.timeoutMs || 900000, log, call: opts.callModel,
    draftModel: cli ? (opts.draftModel || opts.model || 'opus') : opts.model, draftEffort: cli ? (opts.draftEffort || 'low') : undefined,
    editorModel: cli ? (opts.editorModel || opts.model || 'opus') : opts.model, editorEffort: cli ? (opts.editorEffort || 'high') : undefined };
  const base = opts.check || await import('./check.mjs');
  const chk = { applyRedactions: base.applyRedactions, checkIssue: (i, p, o) => { const r = base.checkIssue(i, p, o); const extra = deskChecks(i); return extra.length ? { ...r, pass: false, blockers: [...r.blockers, ...extra] } : r; } };
  const engineTier = engine === 'claude-cli' || engine === 'files' ? 'claude' : engine === 'ollama' ? 'ollama' : 'template';

  const r1 = await runR1(pack, ctx);
  const live = r1.filter(x => x.draft);
  if (!live.length) throw Object.assign(new Error('三位分析師皆無有效稿件'), { code: 'no-drafts' });
  transcript.push({ label: 'r1:drafts', drafts: Object.fromEntries(r1.map(x => [x.role, x.draft])) });
  const analysts = r1.map(x => x.meta);

  const r2 = engine === 'ollama' ? [] : await runR2(pack, r1, ctx);
  transcript.push({ label: 'r2:cross', cross: r2 });

  const edSys = P.editorSystem();
  const edBase = { engine, role: 'editor', system: edSys, filesDir, model: ctx.editorModel, effort: ctx.editorEffort, timeoutMs: ctx.timeoutMs, call: ctx.call };
  const drafts = Object.fromEntries(r1.map(x => [x.role, x.draft]));
  const cross = { notes: r2.flatMap(x => arr(x.crossNotes).map(n => ({ ...n, by: x.role }))), linkages: r2.flatMap(x => arr(x.linkages)), vetoes: r2.flatMap(x => arr(x.vetoes).map(v => ({ ...v, by: x.role }))) };
  let ed = await callJson({ ...edBase, user: P.editorUser({ drafts, cross, poolsText: P.poolsToText(pack), packText: P.packToText(pack, null, 600), dates: pack.dates, absent: pack.absent || [], degraded: pack.degraded || [] }) }, log, 'r3:editor');
  if (!ed.json) throw Object.assign(new Error('總編輯未產出可解析的稿件'), { code: 'no-editor' });
  const editorMeta = { engine, model: ed.model, promptSha256: P.promptSha(edSys) };
  const nominated = {};
  for (const x of r1) for (const p of arr(x.draft?.focusProposals)) (nominated[`${str(p.card)}:${str(p.code).trim()}`] ||= []).push(x.role);
  const build = j => assembleIssue(j, pack, { engineTier, analysts, editorMeta, todayISO, nominated });
  let issue = build(ed.json);

  // R4：機械查核＋紅隊，blocker 退回總編輯修（≤MAX_REPAIR 輪）
  const red = await runRedTeam(issue, pack, ctx);
  let findings = red.findings;
  let rounds = 0, res = chk.checkIssue(issue, pack, { todayISO });
  for (;;) {
    const blockers = [...res.blockers, ...findings];
    log({ label: `r4:check:${rounds}`, blockers: res.blockers.length, llmFindings: findings.length, detail: res.blockers.slice(0, 40), cuts: (res.redactions || []).slice(0, 40), llm: findings.slice(0, 40) });
    if (!blockers.length || rounds >= MAX_REPAIR) break;
    rounds++;
    try { ed = await callJson({ ...edBase, round: `fix${rounds}`, user: P.repairUser({ previous: editorToLoose(issue), findings: blockers }) }, log, `r3:repair${rounds}`); }
    catch (e) { if (e instanceof EngineAuthError) throw e; log({ label: `r3:repair${rounds}`, error: e.message }); break; }
    if (!ed.json) break;
    issue = build(ed.json);
    findings = [];                                   // 紅隊只在第一版跑；修稿後以機械查核為準
    res = chk.checkIssue(issue, pack, { todayISO });
  }
  // 終稿再過一次紅隊（只刪不修）：修稿輪可能引入新問題，這是最後一道語意檢查
  const red2 = rounds > 0 ? await runRedTeam(issue, pack, ctx) : { ok: red.ok, findings: [] };
  const lateIds = red2.findings.flatMap(f => [f.claimId]).filter(Boolean);
  if (lateIds.length) { issue = dropByIds(issue, lateIds); res = chk.checkIssue(issue, pack, { todayISO }); log({ label: 'r4:redteam-final', dropped: lateIds }); }
  // 仍有 blocker／紅隊意見：能指到 claim／個股的由程式刪，再查一次
  const leftover = [...res.blockers, ...findings].flatMap(b => [b.claimId, b.code]).filter(Boolean);
  if (leftover.length) { issue = dropByIds(issue, leftover); res = chk.checkIssue(issue, pack, { todayISO }); }
  const cuts = [...(res.redactions || [])];
  if (cuts.length) { issue = chk.applyRedactions(issue, cuts); res = chk.checkIssue(issue, pack, { todayISO }); log({ label: 'r4:redactions', cuts: cuts.slice(0, 60) }); }

  issue.meta.check = { pass: !!res.pass, rules: res.rules || {}, blockers: res.blockers.length, redactions: [...(issue.meta.check?.redactions || []), ...cuts].filter((x, i, a) => a.findIndex(y => JSON.stringify(y) === JSON.stringify(x)) === i), warnings: res.warnings || [], repairRounds: rounds };
  issue.meta.editor = { ...editorMeta, redTeam: { ran: red.ok, model: red.model, findings: red.findings.length } };
  issue.refTable = {};
  for (const id of collectRefs(issue)) if (pack.refs?.[id]) issue.refTable[id] = pack.refs[id];
  return { issue, transcript, blockers: res.blockers };
}

/**
 * produceIssue：降級階梯。engines＝依序嘗試的引擎（預設 claude-cli → ollama）；全敗回 template 殼。
 * 回傳 { issue, transcript, engineUsed, errors[] }；template 殼：cards=[]、meta.fallback='template'，頁面退回模板版。
 */
export async function produceIssue(opts) {
  const { pack, engines = ['claude-cli', 'ollama'], signalsDir } = opts;
  const errors = [], transcript = [];
  for (const engine of engines) {
    if (engine === 'ollama' && !ollamaFree(signalsDir)) { errors.push({ engine, error: 'ollama 忙碌（daemon 佔用），讓路' }); continue; }
    try {
      const r = await runDesk({ ...opts, engine });
      transcript.push(...r.transcript);
      if (r.issue.meta.check.pass) return { issue: r.issue, transcript, engineUsed: engine, errors };
      errors.push({ engine, error: `查核未過（blockers ${r.blockers.length}）`, blockers: r.blockers.slice(0, 20) });
    } catch (e) {
      errors.push({ engine, error: e.message, auth: e instanceof EngineAuthError });
      if (e instanceof EngineAuthError && engine === 'claude-cli') continue;
    }
  }
  const shell = assembleIssue({}, pack, { engineTier: 'template', analysts: [], editorMeta: {} });
  shell.meta.fallback = 'template';
  shell.meta.degraded = [...shell.meta.degraded, ...errors.map(e => `engine:${e.engine}:failed`)];
  shell.cards = [];
  return { issue: shell, transcript, engineUsed: 'template', errors };
}
