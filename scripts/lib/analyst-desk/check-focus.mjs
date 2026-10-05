// ─────────────────────────────────────────────────────────────────────────────
// 資料觀察名單規則：R06 候選池與名額、R07 個股證據、R08 反證必列、R15 池內再排除、R23 數量與分布。
//   Redact（程式刪該檔）：R06 超額／重複／跨卡過多、R07、R08 涵蓋不足、R23 同產業過多。
//   Block：R06 池外／池資訊不符、R08 adverse 被改、R15。
// ─────────────────────────────────────────────────────────────────────────────
import { POOL_RULE, FOCUS_MIN, FOCUS_MAX, MAX_SAME_INDUSTRY, MAX_CARDS_PER_CODE } from './constants.mjs';
import { arr, isObj, nsOf, seg2Of } from './issue-units.mjs';

const OWN_NS = ['st', 'nv', 'mo'];
const isOwn = (id, code) => OWN_NS.includes(nsOf(id)) && seg2Of(id) === String(code);
const POOL_EXCLUDE_FLAG_RE = /處置|注意|新上市|全額交割|變更交易|停止買賣|停牌|鎖死|無量|成交值不足|旗標不可驗證|可能處置/;

function* eachStock(issue) {
  for (const card of arr(issue?.cards)) {
    if (!isObj(card) || !isObj(card.focus)) continue;
    const stocks = arr(card.focus.stocks);
    for (let i = 0; i < stocks.length; i++) if (isObj(stocks[i])) yield { card, s: stocks[i], i, n: stocks.length };
  }
}
const at = (card, s) => ({ code: s.code, cardId: card.id });

// ── R06 ───────────────────────────────────────────────────────────────────────
export function r06(ctx) {
  const { issue, pack } = ctx;
  const seenAcross = new Map(); // code -> 已出現於幾張卡
  for (const card of arr(issue?.cards)) {
    if (!isObj(card) || !isObj(card.focus) || !['prev', 'data', 'next'].includes(card.id)) continue; // 非法 card id 由 R01 回報
    const f = card.focus;
    const pool = pack?.pools?.[card.id];
    const excluded = pack?.excluded?.[card.id];
    if (!Array.isArray(pool)) { ctx.block('R06', `pack 沒有 ${card.id} 卡的候選池，無法驗證名單`, { cardId: card.id }); continue; }
    const byCode = new Map(pool.map(e => [String(e.code), e]));
    if (f.poolRule !== POOL_RULE) ctx.block('R06', `focus.poolRule「${f.poolRule}」應為 ${POOL_RULE}`, { cardId: card.id });
    if (f.poolSize !== pool.length) ctx.block('R06', `focus.poolSize=${f.poolSize} 與 pack 候選池 ${pool.length} 不符`, { cardId: card.id });
    if (Array.isArray(excluded) && f.excludedCount !== excluded.length) ctx.block('R06', `focus.excludedCount=${f.excludedCount} 與 pack 排除表 ${excluded.length} 不符`, { cardId: card.id });
    const stocks = arr(f.stocks);
    const seenHere = new Set();
    stocks.forEach((s, idx) => {
      if (!isObj(s)) return;
      const code = String(s.code);
      const entry = byCode.get(code);
      if (!entry) { ctx.block('R06', `${code} 不在 ${card.id} 卡候選池（池外個股，LLM 不得自行加股）`, at(card, s)); return; }
      for (const k of ['name', 'market', 'industry']) if (entry[k] !== undefined && s[k] !== entry[k]) ctx.block('R06', `${code} 的 ${k}「${s[k]}」與候選池「${entry[k]}」不符`, at(card, s));
      if (seenHere.has(code)) { ctx.redact('R06', `${code} 在同一張卡重複`, at(card, s)); return; }
      seenHere.add(code);
      if (idx >= FOCUS_MAX) { ctx.redact('R06', `超額：第 ${idx + 1} 檔，每卡最多 ${FOCUS_MAX} 檔`, at(card, s)); return; }
      const n = (seenAcross.get(code) ?? 0) + 1;
      seenAcross.set(code, n);
      if (n > MAX_CARDS_PER_CODE) ctx.redact('R06', `${code} 已出現在 ${MAX_CARDS_PER_CODE} 張卡，同一檔最多出現 ${MAX_CARDS_PER_CODE} 張`, at(card, s));
    });
  }
}

// ── R07 ───────────────────────────────────────────────────────────────────────
export function r07(ctx) {
  const { pack } = ctx;
  for (const { card, s } of eachStock(ctx.issue)) {
    const ev = arr(s.evidence).map(e => e?.ref).filter(x => typeof x === 'string');
    const own = ev.filter(id => isOwn(id, s.code));
    if (ev.length === 0) { ctx.redact('R07', `${s.code} 沒有任何證據 ref`, at(card, s)); continue; }
    if (own.length === 0) ctx.redact('R07', `${s.code} 的證據沒有任何一筆屬於該檔本身（st／nv／mo.${s.code}.*）`, at(card, s));
    else if (!own.some(id => ['官方', '官方衍生'].includes(pack?.refs?.[id]?.tier))) ctx.redact('R07', `${s.code} 的自身證據沒有官方或官方衍生等級`, at(card, s));
    if (card.focus?.kind === 'watch') {
      const wc = arr(s.watchConditions).filter(w => isObj(w) && typeof w.text === 'string' && w.text.trim() && arr(w.refs).length > 0);
      if (wc.length === 0) ctx.redact('R07', `${s.code}（watch）缺少帶 ref 的觀察條件`, at(card, s));
    }
    if (!arr(s.risks).some(w => isObj(w) && typeof w.text === 'string' && w.text.trim())) ctx.redact('R07', `${s.code} 缺少風險說明（risks 至少 1 條）`, at(card, s));
  }
}

// ── R08 ───────────────────────────────────────────────────────────────────────
export function r08(ctx) {
  const { pack } = ctx;
  for (const { card, s } of eachStock(ctx.issue)) {
    const expected = arr(pack?.adverse?.[String(s.code)]);
    const declared = arr(s.adverse);
    if (declared.length !== expected.length || !expected.every(x => declared.includes(x))) {
      ctx.block('R08', `${s.code} 的 adverse 與 pack 預算不一致（程式欄位，LLM 不得增刪）`, at(card, s));
      continue;
    }
    const covered = new Set(arr(s.risks).flatMap(r => (isObj(r) ? arr(r.refs) : [])));
    const lack = expected.filter(x => !covered.has(x));
    if (lack.length) ctx.redact('R08', `${s.code} 的 risks 未涵蓋反證 ref：${lack.join('、')}（反證必列，不得由 LLM 自行刪）`, at(card, s));
  }
}

// ── R15 ───────────────────────────────────────────────────────────────────────
const flagText = v => (Array.isArray(v) ? v.join(' ') : typeof v === 'string' ? v : '');
export function r15(ctx) {
  const { pack, opts } = ctx;
  const minBn = opts.minValueBn === undefined ? 1 : opts.minValueBn; // 暫訂 1 億（04 §3.3：待量測）
  for (const { card, s } of eachStock(ctx.issue)) {
    const code = String(s.code);
    const ex = arr(pack?.excluded?.[card.id]).find(e => String(e?.code) === code);
    if (ex) ctx.block('R15', `${code} 在 ${card.id} 卡排除表（${ex.reason}），不得入名單`, at(card, s));
    const flags = flagText(pack?.refs?.[`st.${code}.flags`]?.v);
    const m = flags.match(POOL_EXCLUDE_FLAG_RE);
    if (m) ctx.block('R15', `${code} 的風險旗標含「${m[0]}」，不得入名單`, at(card, s));
    if (card.id === 'next' && pack?.refs?.[`st.${code}.lockU`]?.v === true) ctx.block('R15', `${code} 已鎖死漲停（買不到），明日卡不得列入`, at(card, s));
    const val = pack?.refs?.[`st.${code}.valM`];
    if (minBn !== null && typeof val?.v === 'number') {
      const bn = val.unit === '億' ? val.v : val.unit === '百萬' ? val.v / 100 : val.unit === '元' ? val.v / 1e8 : null;
      if (bn !== null && bn < minBn) ctx.block('R15', `${code} 成交值 ${bn.toFixed(2)} 億低於門檻 ${minBn} 億（暫訂，待量測）`, at(card, s));
    }
  }
}

// ── R23 ───────────────────────────────────────────────────────────────────────
export function r23(ctx) {
  const redactedHere = new Set(ctx.redactedKeys); // R06 已刪者不重複計
  for (const card of arr(ctx.issue?.cards)) {
    if (!isObj(card) || !isObj(card.focus)) continue;
    const stocks = arr(card.focus.stocks).filter(s => isObj(s) && !redactedHere.has(`${card.id}|${s.code}`));
    const n = stocks.length;
    if (n < FOCUS_MIN) {
      if (typeof card.focus.note !== 'string' || !card.focus.note.trim()) ctx.warn('R23', `${card.id} 卡名單僅 ${n} 檔（<${FOCUS_MIN}），須於 focus.note 寫明原因；不得降門檻湊數`, { cardId: card.id });
    }
    const perIndustry = new Map();
    stocks.forEach(s => {
      const k = s.industry ?? '';
      const c = (perIndustry.get(k) ?? 0) + 1;
      perIndustry.set(k, c);
      if (c > MAX_SAME_INDUSTRY) ctx.redact('R23', `${card.id} 卡同一產業「${k}」超過 ${MAX_SAME_INDUSTRY} 檔，移除 ${s.code}`, at(card, s));
    });
    const bySponsor = new Map();
    for (const s of stocks) for (const a of new Set(arr(s.sponsors))) bySponsor.set(a, (bySponsor.get(a) ?? 0) + 1);
    for (const [a, c] of bySponsor) if (n >= 2 && c > n / 2) ctx.warn('R23', `${card.id} 卡有 ${c}／${n} 檔由 ${a} 單一分析師提名，超過一半（避免單一觀點主導）`, { cardId: card.id });
  }
}
