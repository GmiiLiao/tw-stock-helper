// ─────────────────────────────────────────────────────────────────────────────
// 機械查核器 checkIssue(issue, pack, opts)：規格 04 §3.2 的 R01–R25（併入 01 的 16 條、02 的 L1–L22、03 的 R1–R16 中可機械化者）。
//   純函式、零 IO、零網路、不改輸入、輸出確定。
//   回傳 { pass, blockers, redactions, warnings, rules }
//     pass            ＝無 blocker（redaction 由程式 applyRedactions 後再查一次）
//     blockers        擋稿退回：{ rule, claimId?, path?, code?, cardId?, msg }
//     redactions      程式刪除該 claim／該檔（不重打 LLM）：{ rule, claimId | code(+cardId), msg }
//     warnings        只記錄
//     rules           { R01..R25: 'pass'|'fail'|'skip' }（fail＝有 blocker 或 redaction；skip＝需 LLM 判斷或缺輸入）
//   opts（皆選填）：
//     today／todayISO    YYYY-MM-DD，提供時卡片標題／asOf.label 必須與 cardTitle() 逐字相同
//     numberMode         'strict'（預設）｜'relaxed'（裸數字與同句引用 ref 的值在使用者小數位四捨五入後相等即放行）
//     knownCodes         額外已知股票代號
//     extraNumberAllow   [RegExp] 額外放行的含數字固定寫法
//     allowedDates       額外允許出現的日期（ISO）
//     minValueBn         R15 成交值下限（億，預設 1＝暫訂待量測；null＝不查）
//     nextDayNamespaces  morning 版 next 卡可引用「下一交易日當日」資料的命名空間（預設 gl fx adr cal mo nv）
//     absentKeywords     R21 額外的 {來源名: RegExp}
//     companionRules     R14 伴隨 ref 規則 [{when:'regex 字串', needs:'refId'}]
//     packSha256 / issueSha256 / manifestSha256   R24 雜湊比對
//     rendered           R25 渲染層輸出（string｜string[]｜{prev,data,next}）
// ─────────────────────────────────────────────────────────────────────────────
import { collectUnits, isObj, arr } from './issue-units.mjs';
import { collectKnownCodes, r03, r05, r09, r10, r19, r20, r22 } from './check-text.mjs';
import { r01, r02, r24, r25 } from './check-structure.mjs';
import { r04, r11, r12, r13, r14, r16, r17, r18, r21 } from './check-refs.mjs';
import { r06, r07, r08, r15, r23 } from './check-focus.mjs';

export const RULE_IDS = Object.freeze(Array.from({ length: 25 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`));

/** 規則表：級別（04 §3.2）與機械化程度。 */
export const RULE_META = Object.freeze({
  R01: { title: 'schema／封閉清單／鍵名掃描', level: 'block', coverage: 'full' },
  R02: { title: 'usedForScoring／免責與 forbidden 逐字相等', level: 'block', coverage: 'full' },
  R03: { title: '數字授權（裸數字必須來自槽位或白名單）＋渲染文字未被改寫', level: 'block', coverage: 'full' },
  R04: { title: 'ref 存在、宣告與抽出一致、個股 ref 不張冠李戴、refTable 一致、缺值槽位', level: 'block', coverage: 'full' },
  R05: { title: '日期一致（頂層、文字日期、昨日／今日／明日、星期用語）', level: 'block', coverage: 'full' },
  R06: { title: '候選池與名額（池外 Block；超額／重複／跨卡 Redact）', level: 'block+redact', coverage: 'full' },
  R07: { title: '個股證據（自身官方證據、watch 條件、風險）', level: 'redact', coverage: 'full' },
  R08: { title: '反證必列（adverse 被改 Block；risks 未涵蓋 Redact）', level: 'block+redact', coverage: 'full' },
  R09: { title: '禁用語（買賣／價格目標／保證）', level: 'block', coverage: 'full' },
  R10: { title: '預測句型與未來時態結構', level: 'block', coverage: 'full' },
  R11: { title: '方向詞與 ref 值一致（M label／O 規則方向／法律事件／標題級／正負號）', level: 'block', coverage: 'partial', note: '「句意是否支持方向」需 LLM 紅隊；此處只做 ref 值與符號的機械比對' },
  R12: { title: '傳聞標示與位置', level: 'block', coverage: 'full' },
  R13: { title: 'M／O 不加總', level: 'block', coverage: 'full' },
  R14: { title: '等級＝refs 最低等級、渲染標記、wk／先驗不得單獨依據、連動上限', level: 'block', coverage: 'full' },
  R15: { title: '池內再排除（排除表、風險旗標、鎖死、成交值）', level: 'block', coverage: 'partial', note: 'flags 僅解析文字／字串陣列；數字位元旗標需 W1 先轉成文字；成交值門檻暫訂 1 億待量測' },
  R16: { title: '數字口徑一致（槽位 fmt 由 pack 決定）', level: 'block', coverage: 'partial', note: '「報酬須標參考價口徑／成本須標未扣成本」的語意部分未機械化' },
  R17: { title: '時點隔離', level: 'block', coverage: 'full' },
  R18: { title: '總結卡不引入新事實', level: 'block', coverage: 'full' },
  R19: { title: 'score／signal／評分／評級名詞', level: 'block', coverage: 'full' },
  R20: { title: '語言與格式（簡體、Markdown、emoji、連結、單句長度）', level: 'block+warn', coverage: 'full' },
  R21: { title: '降級誠實（absent／degraded／缺值引用）', level: 'block', coverage: 'partial', note: '來源與字樣的對應表（ABSENT_SOURCE_KEYWORDS、DEGRADED_RULES）需隨 pack 來源名演進' },
  R22: { title: '傳導語氣（linkage／outlook）', level: 'block+warn', coverage: 'full' },
  R23: { title: '名單數量與分布（同產業 Redact；不足／單一提名者過半 Warn）', level: 'redact+warn', coverage: 'full' },
  R24: { title: '稽核可重現（pack／issue 雜湊、refCount、engineTier 一致）', level: 'block', coverage: 'partial', note: '雜湊比對需 opts.packSha256／issueSha256／manifestSha256；未提供則只驗結構一致' },
  R25: { title: '每卡免責短版（渲染層）', level: 'block', coverage: 'partial', note: '需 opts.rendered；未提供＝skip' },
});

const RULE_FNS = [
  ['R01', r01], ['R02', r02], ['R03', r03], ['R04', r04], ['R05', r05], ['R06', r06], ['R07', r07], ['R08', r08], ['R09', r09],
  ['R10', r10], ['R11', r11], ['R12', r12], ['R13', r13], ['R14', r14], ['R15', r15], ['R16', r16], ['R17', r17], ['R18', r18],
  ['R19', r19], ['R20', r20], ['R21', r21], ['R22', r22], ['R23', r23], ['R24', r24], ['R25', r25],
];

export function checkIssue(issue, pack, opts = {}) {
  const o = isObj(opts) ? { ...opts } : {};
  if (o.today === undefined && o.todayISO !== undefined) o.today = o.todayISO; // W3 desk.mjs 以 todayISO 傳入
  const blockers = [], redactions = [], warnings = [];
  const skipped = new Map();
  const redactedKeys = new Set();
  const units = collectUnits(issue);
  const strip = e => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined));

  const ctx = {
    issue, pack: isObj(pack) ? pack : {}, opts: o, units, redactedKeys,
    knownCodes: collectKnownCodes(issue, isObj(pack) ? pack : {}, o),
    block: (rule, msg, extra = {}) => blockers.push(strip({ rule, ...extra, msg })),
    redact: (rule, msg, extra = {}) => { redactions.push(strip({ rule, ...extra, msg })); if (extra.code !== undefined) redactedKeys.add(`${extra.cardId}|${extra.code}`); },
    warn: (rule, msg, extra = {}) => warnings.push(strip({ rule, ...extra, msg })),
    skip: (rule, why) => skipped.set(rule, why),
  };

  for (const [id, fn] of RULE_FNS) {
    try { fn(ctx); } catch (e) { ctx.block(id, `查核內部錯誤（視為未通過）：${e?.message ?? e}`); }
  }

  const failed = new Set([...blockers, ...redactions].map(e => e.rule));
  const rules = {};
  for (const id of RULE_IDS) rules[id] = failed.has(id) ? 'fail' : skipped.has(id) ? 'skip' : 'pass';
  return { pass: blockers.length === 0, blockers, redactions, warnings, rules };
}

/**
 * 套用 redaction（程式刪除，不重打 LLM）。回傳新 issue（深拷貝，不改輸入）。
 *   claimId 型：刪除 summary 與各卡內該 id 的 claim；code 型：刪除該卡（cardId 有給才限定）的該檔個股。
 *   刪個股後若該卡不足 5 檔且無 focus.note，補一句固定原因（不補列、不降門檻）；
 *   並把本次刪除記進 meta.check.redactions（若 meta.check 存在）。
 */
export function applyRedactions(issue, redactions) {
  const out = JSON.parse(JSON.stringify(issue ?? {}));
  const list = arr(redactions);
  const claimIds = new Set(list.filter(r => r && r.claimId !== undefined).map(r => r.claimId));
  const stockKeys = list.filter(r => r && r.code !== undefined);
  const dropClaims = claims => arr(claims).filter(c => !(isObj(c) && claimIds.has(c.id)));

  if (isObj(out.summary)) for (const k of ['points', 'nextFocus', 'risks']) if (Array.isArray(out.summary[k])) out.summary[k] = dropClaims(out.summary[k]);
  for (const card of arr(out.cards)) {
    if (!isObj(card)) continue;
    for (const sec of arr(card.sections)) if (isObj(sec) && Array.isArray(sec.claims)) sec.claims = dropClaims(sec.claims);
    const f = card.focus;
    if (!isObj(f) || !Array.isArray(f.stocks)) continue;
    // 同一 code 在同卡重複時，redaction 只針對「後出現者」——以出現順序消耗
    const budget = new Map();
    for (const r of stockKeys) if (r.cardId === undefined || r.cardId === card.id) budget.set(String(r.code), (budget.get(String(r.code)) ?? 0) + 1);
    const before = f.stocks.length;
    const dupSeen = new Map();
    f.stocks = f.stocks.filter(s => {
      const code = String(s?.code);
      const need = budget.get(code) ?? 0;
      if (need === 0) return true;
      const seen = (dupSeen.get(code) ?? 0) + 1;
      dupSeen.set(code, seen);
      const total = f.stocks.filter(x => String(x?.code) === code).length;
      return seen <= total - need; // 刪除最後 need 個出現者（單一出現＝全刪）
    });
    if (f.stocks.length < before && f.stocks.length < 5 && !(typeof f.note === 'string' && f.note.trim())) f.note = '部分個股未通過程式查核已移除，不足額部分不補列、不降低門檻。';
  }
  if (isObj(out.meta?.check)) {
    const prev = arr(out.meta.check.redactions);
    const add = list.map(r => (r.claimId !== undefined ? { claimId: r.claimId, rule: r.rule } : { code: r.code, ...(r.cardId !== undefined ? { cardId: r.cardId } : {}), rule: r.rule }));
    out.meta.check.redactions = [...prev, ...add];
  }
  return out;
}
