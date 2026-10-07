// ─────────────────────────────────────────────────────────────────────────────
// 規則類利空事實題的「判定細節＋稽核軌跡＋延續＋當日沿用」（唯一實作；純函式：不碰網路、不讀時鐘、不讀檔）。
// 類別表與 applyRuleFacts 在 news-rule-classes.mjs；這裡只處理「一題的回答怎麼變成 ruleFacts 的值」與它留下的證據。
// 單元測試 news-rule-evidence.test.mjs。規範：新聞技能 .claude/skills/tw-news-impact-analyst/SKILL.md §1.5、§1.8、§4.1、§5.4、§7.1；
//   停損規範 .claude/skills/tw-ai-stoploss/SKILL.md §10A.1、§10A.2。
//
// 使用者 2026-10-07 裁定（原話「n1 b／n2 依建議／其它依建議」）：
//   N1(b) C16a 只有「新聞視窗內有新進展」才觸發並改判利空：AI 逐字引用的法律事實句必須能在內文逐字找到（沿用 E 引用強制的正規化與
//     子字串比對；比不上就不算 ⇒ 'none'），AI 說是新進展、而且事件日期落在本次新聞視窗內 ⇒ 'yes'；否則（舊案：日期在視窗外、只在
//     背景句出現、日期讀不出來）⇒ 'old'＝「涉訟中」事實標籤，不改 label、不推播、不收緊停損。引用句本身、或它在原文所在的子句
//     （quoteClauseOf）寫明視窗外的日期（例「8 月」）又沒有「今日、昨日」這類相對時間字樣，或子句帶背景字樣（先前、曾遭…）時，
//     即使 AI 說是新進展也記 'old'（3037 欣興 10/05–10/07 誤判的型態；AI 挑沒日期的子字串也擋得住）。
//     同一檔同類別在有效期（RULE_CONT_TRADING_DAYS 個交易日，與停損事件收緊期限同值）內重複觸發 ⇒ ruleCont「延續」：
//     方向照規則（C16a 仍為利空）、但不當新事件、不重複推播、停損 ruleBearEvents 不再收。延續只從「被當成新事件」的那次起算
//     （ruleTrailEligible：主類別、挑戰過、非承接、讀過內文、label 利空），沒收成事件的判別不起算。
//   N2 工安事故後的檢察官相驗、勞檢、事故調查、業務過失偵查不算 C16a：引用句有工安字樣（ACCIDENT_LINK_RE），或引用句出現在 C17 的
//     報導裡而 C17 答「是」（或沒答「否」而引用句帶事故、爆炸等較寬字樣）⇒ C16a 記 'acc'，主類別由 C17 擔任（C17 只記欄位、不改 label，R1）。
//   其它：規則事實題留可稽核軌跡 ruleEvidence；同一檔同類別同一組報導當日已問過就沿用答案（不重問，減少 Ollama 呼叫）；
//     題數與答案分布依資料日累計（ruleAuditCounts，只放計數）。newsVerdict 單檔接近 1MB 時壓縮證據（fitVerdictJson）。
//
// 使用者 2026-10-07 再裁定（原話「依建議進行」，對 N3／N4／N5）：
//   N3 不回溯修改既有 newsVerdict 文件（不動歷史資料）。
//   N4 延續有效期內出現「事件日期晚於軌跡記的事件日期」的新進展（例：先搜索、兩天後羈押或起訴）⇒ 新事件：照既有 C16a 新進展規則
//     改判利空（引用逐字、日期在視窗內）、不標延續（可推播、停損收緊重新起算、戰情 Z2 依類別權重發級），軌跡換成新的 since 與
//     eventDate（renewOf 記被取代的舊事件日期，只留在發生的那一筆）。事件日期相同或更早、或任一邊讀不到 ⇒ 仍算延續；
//     舊軌跡沒有 eventDate ⇒ 延續，並以這次的事件日期補上（之後再有更晚日期的新進展才算新事件）。比較用 eventDateLater（區間要整段晚於）。
//   N5 讀不到日期就不改判（維持 resolveRuleFact 的 'old'／dateUnknown，不改程式）。
// 非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import {
  RULE_CLASS_BY_CODE, RULE_FACT_STATES, LABEL_OVERRIDE_CLASS, parseRuleFactAnswer, ruleClassOf, taipeiYmdOfMs,
} from './news-rule-classes.mjs';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const isYmd = v => typeof v === 'string' && YMD_RE.test(v);

/** 延續的有效期（交易日，含首次判定的適用日）＝停損事件收緊期限 STOP_PARAMS.eventHoldDays（測試釘住同值；先驗·未回測） */
export const RULE_CONT_TRADING_DAYS = 5;
/** 稽核軌跡各欄位的字數上限（控制 newsVerdict 單檔大小）；qctx＝引用句所在子句（只在它否決新進展時記） */
export const RULE_EVIDENCE_MAX = Object.freeze({ ctx: 80, title: 40, src: 16, ans: 60, quote: 60, dateText: 16, qctx: 80 });
/** newsVerdict 日文件（verdictJson＋seenJson）超過這個位元組數就壓縮證據（Firestore 單檔上限 1,048,576） */
export const RULE_DOC_SOFT_MAX = 900_000;
/** 引用句至少幾個字（正規化後；同 daemon E 引用強制的 6 字下限） */
export const QUOTE_MIN_CHARS = 6;
/**
 * N2：法律事實句帶這些字樣 ⇒ 是工安事故後的相驗、勞檢、業務過失偵查，不算 C16a（記 'acc'）。只放工安語境明確的字樣——
 * 2026-10-07 審查修正：單獨的「事故」「爆炸」「死傷」「傷亡」太寬，理專挪用事故、資安事故的搜索會被吃成 'acc'（兩邊都不算 ⇒
 * 違反 2026-08-29「被搜索就是利空」）；那些較寬的字樣改由 reconcileAccident 在 C17 語境下才認（ACCIDENT_CONTEXT_RE）。
 */
export const ACCIDENT_LINK_RE = /相驗|勞檢|勞動檢查|職安署|職業安全|工安|職災|火災|失火|起火|火警|氣爆|爆炸事故|意外事故|業務過失|過失致死|過失傷害/;
/**
 * N2 較寬的事故字樣：只有 C16a 的引用句同時出現在 C17（工安停工）觸發的報導裡、而且 C17 沒有答「否」時才算工安事故（記 'acc'）。
 * 沒有 C17 語境（例「偵辦隱匿理專挪用事故並背信」）照一般 C16a 判。
 */
export const ACCIDENT_CONTEXT_RE = /事故|爆炸|罹難|死傷|傷亡|殉職|喪生|身亡/;
/**
 * 引用句前後文的範圍（N1(b) 舊案判定；2026-10-07 審查修正）：從引用句在原文的位置往前到上一個子句界（，。；！？換行）、最多
 * QUOTE_CTX_BACK 字，往後到下一個子句界、最多 QUOTE_CTX_FWD 字。只看子句、不看整句：「繼 8 月遭搜索後，調查局今再度約談」
 * 這類新進展不可被同一句前半的舊日期否決。
 */
export const QUOTE_CTX_BACK = 30;
export const QUOTE_CTX_FWD = 20;
const CLAUSE_BOUND_RE = /[，,。；;！!？?\n]/;
/**
 * 引用句裡的相對日子字樣（今日、昨日、今(7)日、日前、稍早、本週）：有它就不用引用句裡的絕對日期否決「新進展」。
 * 只認「哪一天」的相對字樣；上午、晚間這類時段字不算（「8月25日上午遭搜索」仍要被 8 月否決）。
 */
const RELATIVE_TIME_RE = /今[日天晨早午晚]|今\s*[(（]\s*\d{1,2}\s*[)）]|昨[日天晚]|昨\s*[(（]\s*\d{1,2}\s*[)）]|日前|稍早|本週/;
/**
 * 舊案背景字樣（先前、此前、早前、日前曾、曾遭／曾被…）：引用句所在子句帶這些字、又沒有今日／昨日這類相對日子字樣 ⇒ 背景句。
 * 不用單獨的「曾」（曾姓負責人）、也不用「之前」（「起訴之前已約談」）；「日前曾」裡的「日前」不當相對日子。
 */
const BACKGROUND_RE = /先前|此前|早前|日前曾|曾(?:遭|被|經|因|涉)/;

const cut = (v, n) => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n) : t;
};
/** 只留有值的欄位（Firestore 不收 undefined；null 也不存，省單檔大小） */
const compact = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

// ── 引用逐字核對（沿用 daemon E 引用強制的正規化：去空白與標點後做子字串比對） ─────────────

/** 正規化時去掉的字元（空白與標點；單字比對與整串取代共用同一個字元類） */
const QUOTE_DROP_SRC = '[\\s「」『』"\'“”，,。．.、；;：:！!？?（）()]';
const QUOTE_DROP_ALL = new RegExp(QUOTE_DROP_SRC, 'g');
const QUOTE_DROP_ONE = new RegExp(QUOTE_DROP_SRC);

/** E 引用強制同一套正規化（ai-daemon.mjs judgeOneStock 的 norm；改了兩邊一起改） */
export function normForQuote(t) {
  return String(t || '').replace(QUOTE_DROP_ALL, '');
}

/** 引用句能不能在這些報導（標題＋內文）裡逐字找到；正規化後少於 QUOTE_MIN_CHARS 字一律不算 */
export function quoteInArticles(quote, articles) {
  const q = normForQuote(quote);
  if (q.length < QUOTE_MIN_CHARS) return false;
  const corpus = normForQuote((Array.isArray(articles) ? articles : []).map(a => `${a?.title ?? ''} ${a?.content ?? ''}`).join(' '));
  return corpus.includes(q);
}

/** 引用句在原文的位置（逐篇比對標題與內文，正規化同 normForQuote）→ { text, start, end }（end 不含）或 null */
function locateQuote(quote, articles) {
  const q = normForQuote(quote);
  if (q.length < QUOTE_MIN_CHARS) return null;
  for (const a of Array.isArray(articles) ? articles : []) {
    for (const text of [a?.title, a?.content]) {
      if (typeof text !== 'string' || !text) continue;
      let norm = '';
      const pos = [];
      for (let i = 0; i < text.length; i += 1) {
        if (QUOTE_DROP_ONE.test(text[i])) continue;
        norm += text[i];
        pos.push(i);
      }
      const k = norm.indexOf(q);
      if (k >= 0) return { text, start: pos[k], end: pos[k + q.length - 1] + 1 };
    }
  }
  return null;
}

/**
 * 引用句所在的子句（原文）：往前到上一個子句界、最多 QUOTE_CTX_BACK 字，往後到下一個子句界、最多 QUOTE_CTX_FWD 字。
 * AI 從舊案背景句挑一段沒有日期的子字串（例「遭檢調搜索，公司強調營運正常」）時，日期與背景字樣要從這裡讀。找不到位置回 null。
 */
export function quoteClauseOf(quote, articles) {
  const loc = locateQuote(quote, articles);
  if (!loc) return null;
  const { text, start, end } = loc;
  let s = start;
  while (s > 0 && start - s < QUOTE_CTX_BACK && !CLAUSE_BOUND_RE.test(text[s - 1])) s -= 1;
  let e = end;
  while (e < text.length && e - end < QUOTE_CTX_FWD && !CLAUSE_BOUND_RE.test(text[e])) e += 1;
  return text.slice(s, e);
}

/** 子句是不是舊案的背景句：有背景字樣（先前、此前、曾遭…）而且沒有今日、昨日這類相對日子字樣（「日前曾」不算相對日子） */
export function isBackgroundClause(text) {
  const t = String(text ?? '');
  return BACKGROUND_RE.test(t) && !RELATIVE_TIME_RE.test(t.replace(/日前曾/g, ''));
}

// ── C16a 回答的細節（新進展、日期、引用） ──────────────────────────────────

const fieldOf = (text, label) => {
  const m = text.match(new RegExp(`(?:^|\\n)\\s*${label}\\s*[:：]\\s*([^\\n]*)`));
  return m ? m[1].trim() : null;
};
const stripQuotes = s => String(s ?? '').trim().replace(/^[「『"“'”]+/, '').replace(/[」』"”'“]+$/, '').trim();

/** 「新進展: …」的值 → 'yes'｜'no'｜null（不確定、照抄範本、讀不出來） */
function yesNoOf(v) {
  const s = stripQuotes(v);
  if (!s) return null;
  if (/^是\s*[、／/或]\s*否/.test(s)) return null;   // 照抄範本「是、否或不確定」
  if (/^(?:是|有)(?=$|[\s，,。.、:：;；!！（(·])/.test(s)) return 'yes';
  if (/^(?:否|不是|沒有|無|非)(?=$|[\s，,。.、:：;；!！（(·]|新)/.test(s)) return 'no';
  return null;
}

/**
 * C16a 的多行回答 → { newDev:'yes'|'no'|null, date:string|null（AI 原字）, quote:string|null }。
 * 引用：先讀「引用:」那一行；沒有就取回答中第一段 8 字以上的「…」（同 E 引用強制的後備解析：放寬解析不放寬把關，驗證仍由程式做）。
 */
export function parseLegalFactDetail(answer) {
  const a = String(answer ?? '').replace(/\*/g, '').replace(/\r/g, '');
  const newDev = yesNoOf(fieldOf(a, '新進展'));
  const rawDate = stripQuotes(fieldOf(a, '日期'));
  const date = rawDate && !/^(?:不明|不確定|未知|無法|無$|沒有|只填)/.test(rawDate) ? rawDate.slice(0, 40) : null;
  let quote = stripQuotes(fieldOf(a, '引用'));
  if (!quote || /^(?:無|沒有|不確定)$/.test(quote)) {
    const m = a.match(/[「『“"]([^」』”"\n]{8,160})[」』”"]/);
    quote = m ? m[1].trim() : null;
  }
  return { newDev, date, quote: quote || null };
}

// ── 日期 ────────────────────────────────────────────────────────────────

const pad2 = n => String(n).padStart(2, '0');
const yearOf = s => { const y = Number(s); return y < 1000 ? y + 1911 : y; };   // 民國年（3 碼）換西元
const validYmd = (y, m, d) => {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? `${y}-${pad2(m)}-${pad2(d)}` : null;
};
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthSpan = (y, m) => (m >= 1 && m <= 12 ? { lo: `${y}-${pad2(m)}-01`, hi: `${y}-${pad2(m)}-${pad2(lastDayOf(y, m))}` } : null);
/** 沒寫年份的月日：取今年；落在今天之後就當去年（未來日期不是「已發生的新進展」） */
const inferYear = (m, d, todayYmd) => {
  const ty = Number(String(todayYmd).slice(0, 4));
  const cand = validYmd(ty, m, d ?? 1);
  return cand && cand > todayYmd ? ty - 1 : ty;
};

/**
 * 一個日期字串（AI 回答的「日期:」）→ { lo, hi }（'YYYY-MM-DD'，含）或 null。認得：2026-10-06、2026/10/06、2026年10月6日、
 * 115年10月6日（民國）、10/06、10月6日、2026年8月、8月（整月）、2025年（整年）、去年、前年。讀不出來回 null（不猜）。
 */
export function factDateSpan(text, todayYmd) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s || !isYmd(todayYmd)) return null;
  const ty = Number(todayYmd.slice(0, 4));
  let m = s.match(/(\d{3,4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) { const d = validYmd(yearOf(m[1]), Number(m[2]), Number(m[3])); return d ? { lo: d, hi: d } : null; }
  m = s.match(/(\d{3,4})年(\d{1,2})月/) || s.match(/(\d{4})[-/.](\d{1,2})(?![-/.\d])/);
  if (m) return monthSpan(yearOf(m[1]), Number(m[2]));
  m = s.match(/(?:^|[^\d])(\d{1,2})[/\-.月](\d{1,2})(?:日|號)?(?!\d)/);
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]);
    const ymd = validYmd(inferYear(mo, d, todayYmd), mo, d);
    return ymd ? { lo: ymd, hi: ymd } : null;
  }
  m = s.match(/(\d{1,2})月/);
  if (m) { const mo = Number(m[1]); return monthSpan(inferYear(mo, 1, todayYmd), mo); }
  m = s.match(/(\d{3,4})年/);
  if (m) { const y = yearOf(m[1]); return { lo: `${y}-01-01`, hi: `${y}-12-31` }; }
  if (/前年/.test(s)) return { lo: `${ty - 2}-01-01`, hi: `${ty - 2}-12-31` };
  if (/去年/.test(s)) return { lo: `${ty - 1}-01-01`, hi: `${ty - 1}-12-31` };
  return null;
}

/** 日期區間與新聞視窗 { from, to } 的關係：'in'（整段在視窗內）｜'out'（整段在視窗外）｜'unknown'（缺值或跨界） */
export function windowRelation(span, window) {
  if (!isObj(span) || !isYmd(span.lo) || !isYmd(span.hi) || !isObj(window) || !isYmd(window.from) || !isYmd(window.to)) return 'unknown';
  if (span.lo >= window.from && span.hi <= window.to) return 'in';
  if (span.hi < window.from || span.lo > window.to) return 'out';
  return 'unknown';
}

/**
 * 引用句本身寫的絕對日期（月日、月、年、去年）與新聞視窗的關係：有相對時間字樣（今日、昨日…）⇒ 'none'（不用它否決）；
 * 寫了日期而且全部在視窗外 ⇒ 'out'；有任何一個在視窗內或跨界 ⇒ 'in'；沒寫日期 ⇒ 'none'。
 */
export function quoteDateRelation(quote, window, todayYmd) {
  const q = String(quote ?? '');
  if (!q || RELATIVE_TIME_RE.test(q)) return 'none';
  const exprs = q.match(/\d{3,4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月(?!\s*\d)|\d{3,4}\s*年|去年|前年/g) || [];
  if (!exprs.length) return 'none';
  const rel = exprs.map(e => windowRelation(factDateSpan(e, todayYmd), window));
  return rel.every(r => r === 'out') ? 'out' : 'in';
}

const spanText = sp => (sp ? (sp.lo === sp.hi ? sp.lo : `${sp.lo}~${sp.hi}`) : null);

// ── 一題的判定 ─────────────────────────────────────────────────────────

/**
 * 一題的回答 → { yes, sub, state, answered, ev }（applyRuleFacts 的 facts[code]）。
 *   state：'yes'｜'no'｜'none'｜'old'｜'acc'（news-rule-classes RULE_FACT_STATES）；answered＝AI 有回覆（呼叫失敗或空白為 false，不快取）。
 *   ev（稽核軌跡，寫進 newsVerdict.ruleEvidence[code]）：key、day（問的日子）、trig／ctx（觸發字與前後文）、title／src／pub（第一篇報導）、
 *   ans（AI 回答前 60 字）；C16a 另有 quote、quoteOk、newDev、dateText、eventDate、isNew、why（不算新進展的原因）、qctx（子句否決時的引用子句）。
 * opts：{ articles（ruleTriggerScan.byCode[code] 給 AI 看的那幾篇）, window:{ from, to }, todayYmd, day, key }。
 */
export function resolveRuleFact(code, answer, { articles = [], window = null, todayYmd = null, day = null, key = null } = {}) {
  const arts = Array.isArray(articles) ? articles : [];
  const a0 = isObj(arts[0]) ? arts[0] : {};
  const text = String(answer ?? '').trim();
  const ev = compact({
    key, day, trig: cut(a0.hit?.trig, 16), ctx: cut(a0.hit?.ctx, RULE_EVIDENCE_MAX.ctx), title: cut(a0.title, RULE_EVIDENCE_MAX.title),
    src: cut(a0.src, RULE_EVIDENCE_MAX.src), pub: taipeiYmdOfMs(a0.at), ans: cut(text, RULE_EVIDENCE_MAX.ans),
  });
  if (!text) return { yes: null, sub: null, state: 'none', answered: false, ev: { ...ev, why: 'noAnswer' } };
  const p = parseRuleFactAnswer(code, text);
  if (!p) return { yes: null, sub: null, state: 'none', answered: true, ev: { ...ev, why: 'unsure' } };
  if (!p.yes) return { yes: false, sub: null, state: 'no', answered: true, ev };
  if (code !== LABEL_OVERRIDE_CLASS) {
    return { yes: true, sub: p.sub, state: 'yes', answered: true, ev: p.sub ? { ...ev, sub: p.sub } : ev };
  }
  const d = parseLegalFactDetail(text);
  const quoteOk = !!d.quote && quoteInArticles(d.quote, arts);
  const span = factDateSpan(d.date, todayYmd);
  const base = {
    ...ev, ...compact({ quote: cut(d.quote, RULE_EVIDENCE_MAX.quote), newDev: d.newDev, dateText: cut(d.date, RULE_EVIDENCE_MAX.dateText), eventDate: spanText(span) }),
    quoteOk,
  };
  // 引用比不上就不算（沿用 E 引用強制）：連「涉訟中」標籤也不給
  if (!quoteOk) return { yes: null, sub: null, state: 'none', answered: true, ev: { ...base, isNew: false, why: 'quote' } };
  // N2：工安事故後的相驗、勞檢、業務過失偵查不算 C16a（較寬的「事故」「爆炸」字樣要有 C17 語境，見 reconcileAccident）
  if (ACCIDENT_LINK_RE.test(d.quote)) return { yes: false, sub: null, state: 'acc', answered: true, ev: { ...base, isNew: false, why: 'accident' } };
  const rel = windowRelation(span, window);
  // 舊案否決（2026-10-07 審查修正）：引用句本身、以及它在原文所在的子句，寫了視窗外的日期或背景字樣 ⇒ 不是新進展
  //   （AI 從「欣興今年8月遭檢調搜索，公司強調營運正常」挑「遭檢調搜索，公司強調營運正常」這種沒日期的子字串也擋得住）
  const clause = quoteClauseOf(d.quote, arts) ?? d.quote;
  const quoteOut = quoteDateRelation(d.quote, window, todayYmd) === 'out';
  const clauseOut = !quoteOut && quoteDateRelation(clause, window, todayYmd) === 'out';
  const background = isBackgroundClause(clause);
  const isNew = d.newDev === 'yes' && rel === 'in' && !quoteOut && !clauseOut && !background;
  let why = null;
  if (!isNew) {
    if (d.newDev !== 'yes') why = 'notNew';
    else if (rel === 'out') why = 'dateOut';
    else if (rel === 'unknown') why = 'dateUnknown';
    else if (quoteOut) why = 'quoteDateOut';
    else why = clauseOut ? 'clauseDateOut' : 'background';
  }
  const qctx = (why === 'clauseDateOut' || why === 'background') && clause !== d.quote ? cut(clause, RULE_EVIDENCE_MAX.qctx) : null;
  return {
    yes: isNew, sub: null, state: isNew ? 'yes' : 'old', answered: true,
    ev: { ...base, isNew, ...(why ? { why } : {}), ...(qctx ? { qctx } : {}) },
  };
}

/**
 * 同一檔同類別同一組報導的鍵（當日沿用用）：代號、類別、問的日子、新聞視窗、每篇的標題＋內文（給 AI 看的那段）。
 * 任何一項不同就重問（內文更新、視窗換日都算不同組）。djb2 雜湊，只用來比對、不存原文。
 */
export function ruleFactKey({ code, cls, day, window = null, articles = [] } = {}) {
  const parts = [code, cls, day, window?.from ?? '', window?.to ?? '',
    ...(Array.isArray(articles) ? articles : []).map(a => `${a?.title ?? ''}\u0001${a?.content ?? ''}`)];
  let h = 5381;
  for (const ch of parts.join('\u0002')) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return `${cls}-${day}-${h.toString(36)}`;
}

/**
 * 前一筆判別（同一檔、同一份 newsVerdict）就同一題留下的答案 → 沿用（不重問）。條件：ruleEvidence[code].key 相同（同日、同視窗、
 * 同一組報導）、ruleFacts[code] 是已知狀態、而且當時 AI 有回覆（why≠'noAnswer'）。回 resolveRuleFact 同形（ev.reused＝true）或 null。
 */
export function reuseRuleFact(prevVerdict, code, key) {
  if (!isObj(prevVerdict) || !key) return null;
  const e = isObj(prevVerdict.ruleEvidence) ? prevVerdict.ruleEvidence[code] : null;
  const state = isObj(prevVerdict.ruleFacts) ? prevVerdict.ruleFacts[code] : null;
  if (!isObj(e) || e.key !== key || !RULE_FACT_STATES.includes(state) || e.why === 'noAnswer') return null;
  return { yes: state === 'yes' ? true : state === 'none' ? null : false, sub: typeof e.sub === 'string' ? e.sub : null, state, answered: true, ev: { ...e, reused: true } };
}

/** 記憶體快取（daemon）取回的結果標成沿用（不改快取裡的物件） */
export function asReused(fact) {
  return isObj(fact) ? { ...fact, ev: { ...(isObj(fact.ev) ? fact.ev : {}), reused: true } } : null;
}

/**
 * N2 同一起事故：C16a 答「是」或「舊案」，而且 C16a 的引用句出現在 C17（工安停工）觸發的報導裡，再加上下列其一 ⇒ C16a 記 'acc'，
 * 主類別由 C17 擔任（C17 只記欄位、不改 label，R1）：
 *   · C17 答「是」（why 'accidentC17'）；
 *   · C17 沒有答「否」、而引用句帶較寬的事故字樣（ACCIDENT_CONTEXT_RE：事故、爆炸、死傷…；why 'accident'）。
 * 沒有 C17 語境（該篇沒命中 C17 觸發字）的法律事件照一般 C16a 判（2026-10-07 審查修正：理專挪用事故的搜索仍是 C16a）。
 * byCode：ruleTriggerScan 的 byCode。回新物件（不改輸入）；不適用回原物件。
 */
export function reconcileAccident(facts, byCode) {
  if (!isObj(facts)) return facts;
  const f16 = facts.C16a;
  if (!isObj(f16) || !(f16.state === 'yes' || f16.state === 'old')) return facts;
  const quote = f16.ev?.quote;
  if (!quote || !quoteInArticles(quote, byCode?.C17)) return facts;
  const s17 = facts.C17?.state;
  const why = s17 === 'yes' ? 'accidentC17' : s17 !== 'no' && ACCIDENT_CONTEXT_RE.test(quote) ? 'accident' : null;
  if (!why) return facts;
  return { ...facts, C16a: { ...f16, yes: false, state: 'acc', ev: { ...(f16.ev ?? {}), isNew: false, why } } };
}

// ── 延續（同一檔同類別在有效期內重複觸發） ─────────────────────────────────

const EVENT_SPAN_RE = /^(\d{4}-\d{2}-\d{2})(?:~(\d{4}-\d{2}-\d{2}))?$/;

/** 事件日期字串（resolveRuleFact 的 eventDate：'YYYY-MM-DD' 或 'YYYY-MM-DD~YYYY-MM-DD'）→ { lo, hi }；格式不對回 null */
export function eventDateSpan(text) {
  const m = typeof text === 'string' ? text.match(EVENT_SPAN_RE) : null;
  if (!m) return null;
  const lo = m[1], hi = m[2] ?? m[1];
  return lo <= hi ? { lo, hi } : null;
}

/**
 * 新事件日期 a 是不是「晚於」舊事件日期 b（N4）：兩邊都讀得到、而且 a 整段在 b 之後（a.lo > b.hi）。
 * 相同、更早、區間重疊、任一邊讀不到 ⇒ false（算延續，保守）。
 */
export function eventDateLater(a, b) {
  const sa = eventDateSpan(a), sb = eventDateSpan(b);
  return !!sa && !!sb && sa.lo > sb.hi;
}

const validEventDate = v => (eventDateSpan(v) ? v : null);

/**
 * 判別裡某類別的事件日期：先看延續軌跡 ruleTrail[cls].eventDate（事件身分，ruleEvidence 被瘦身時也還在），沒有再看
 * ruleEvidence[cls].eventDate；都沒有（非 C16a 類別、2026-10-07 前的舊資料）回 null。停損 ruleBearEvents 用它帶事件日期。
 */
export function ruleEventDateOf(v, cls) {
  if (!isObj(v) || typeof cls !== 'string') return null;
  const t = isObj(v.ruleTrail) && isObj(v.ruleTrail[cls]) ? validEventDate(v.ruleTrail[cls].eventDate) : null;
  if (t) return t;
  return isObj(v.ruleEvidence) && isObj(v.ruleEvidence[cls]) ? validEventDate(v.ruleEvidence[cls].eventDate) : null;
}

/**
 * 這筆判別的主類別有沒有「被當成新事件」（延續的起算條件；2026-10-07 審查修正）：主類別（ruleClass，該類事實答「是」）、
 * 走過四角色挑戰（challenged）、非承接（carriedFrom）、AI 讀過內文（basis 'content'）、label 利空。
 *   停損 ruleBearEvents 與戰情 Z2 只收挑戰過、非承接、讀過內文的（isCurrentEntry、isAiRead）；推播（完成訊號利空清單、盤中突發）
 *   與 Z2 只認 label 利空（非法律類別 label 照 AI 原判，R1）。任一條沒過 ⇒ 這次沒有被當成新事件 ⇒ 不起算延續，下一次判別照新事件
 *   處理（停損的同一事件由 stepEventOverlay 的事件身分去重）；ruleHits 裡的次要類別也不起算（當天收的是主類別）。
 *   取捨：寧可多推一次、不可永久漏收——首次判定沒挑戰過卻已在完成訊號列過利空的，隔日挑戰過會再列一次。
 */
export function ruleTrailEligible(v) {
  if (!isObj(v) || typeof v.ruleClass !== 'string' || !isObj(v.ruleFacts) || v.ruleFacts[v.ruleClass] !== 'yes') return false;
  return v.challenged === true && !v.carriedFrom && v.basis === 'content' && v.label === '利空';
}

/**
 * 判別 → 帶上延續軌跡的新判別。prevTrail：同一檔前一筆判別的 ruleTrail（{ [code]: { since, eventDate?, renewOf? } }）；
 * targetDate：這筆判別的適用交易日；contFromYmd：有效期的第一個交易日（＝適用日往前數 RULE_CONT_TRADING_DAYS 個交易日，含適用日）。
 * - 有效期內的舊軌跡照抄 since、eventDate（這次沒答「是」也保留，免得中間某次沒觸發就讓之後的重複觸發被當新事件）；renewOf 不抄；
 * - 主類別沒有軌跡、而且這筆判別「被當成新事件」（ruleTrailEligible）⇒ 以適用日為 since 新建。沒被當成新事件的（沒挑戰過、
 *   次要類別、label 不是利空）不起算——否則隔日真的收成事件時會被標延續、從頭到尾沒收（2026-10-07 審查修正）；
 * - N4（2026-10-07「依建議進行」）：主類別已有軌跡，這筆的事件日期晚於軌跡的事件日期（eventDateLater）⇒ 新事件、不標延續；
 *   這筆也「被當成新事件」時軌跡換成 { since: 適用日, eventDate: 新日期, renewOf: 舊日期 }（有效期從新的 since 重算），
 *   沒被當成新事件的（例：挑戰失敗）軌跡不動、下一筆照新事件判（同首次起算的取捨：寧可多推一次、不可永久漏收）；
 * - 舊軌跡沒有 eventDate（相容）：讀不到就比不了 ⇒ 延續，並補上這筆的事件日期（之後更晚日期的新進展才算新事件）；
 * - 主類別（ruleClass）的 since 早於適用日、而且不是 N4 的較晚新進展 ⇒ ruleCont＝since（延續：不當新事件、不重複推播、停損不再收）。
 *   同一適用日的重判（例如晨間判到、盤中再判）不是延續：當日的停損與戰情要照常認得它。
 */
export function withRuleTrail(verdict, prevTrail, { targetDate, contFromYmd = null } = {}) {
  if (!isObj(verdict) || !isYmd(targetDate)) return verdict;
  const { ruleTrail: _oldTrail, ruleCont: _oldCont, ...rest } = verdict;
  const trail = {};
  for (const [c, t] of Object.entries(isObj(prevTrail) ? prevTrail : {})) {
    if (!RULE_CLASS_BY_CODE[c] || !isObj(t) || !isYmd(t.since) || t.since > targetDate) continue;
    if (isYmd(contFromYmd) && t.since < contFromYmd) continue;
    trail[c] = compact({ since: t.since, eventDate: validEventDate(t.eventDate) });
  }
  const facts = isObj(rest.ruleFacts) ? rest.ruleFacts : {};
  const primary = typeof rest.ruleClass === 'string' && facts[rest.ruleClass] === 'yes' ? rest.ruleClass : null;
  if (!primary) return Object.keys(trail).length ? { ...rest, ruleTrail: trail } : rest;
  const ed = isObj(rest.ruleEvidence) && isObj(rest.ruleEvidence[primary]) ? validEventDate(rest.ruleEvidence[primary].eventDate) : null;
  const prev = trail[primary] ?? null;
  const later = !!prev && eventDateLater(ed, prev.eventDate);
  if (!prev || later) {
    if (ruleTrailEligible(rest)) trail[primary] = compact({ since: targetDate, eventDate: ed, renewOf: later ? prev.eventDate : null });
  } else if (!prev.eventDate && ed) {
    trail[primary] = { ...prev, eventDate: ed };
  }
  const out = Object.keys(trail).length ? { ...rest, ruleTrail: trail } : rest;
  const t = trail[primary];
  if (t && !later && t.since < targetDate) return { ...out, ruleCont: t.since };
  return out;
}

/** 規則類利空而且是延續（ruleCont）：不當新事件、不重複推播、停損 ruleBearEvents 不再收 */
export function isRuleContinuation(v) {
  return isObj(v) && isYmd(v.ruleCont) && ruleClassOf(v) !== null;
}

/**
 * N4：這筆判別是「有效期內事件日期較晚的新進展」而把主類別軌跡換新（ruleTrail[ruleClass].renewOf＝被取代的舊事件日期）。
 * 只在發生換新的那一筆為真（之後的判別抄軌跡時不抄 renewOf）；計數與 daemon log 用。
 */
export function isRuleRenewal(v) {
  if (!isObj(v) || typeof v.ruleClass !== 'string' || ruleClassOf(v) !== v.ruleClass || !isObj(v.ruleTrail)) return false;
  const t = v.ruleTrail[v.ruleClass];
  return isObj(t) && typeof t.renewOf === 'string' && !isYmd(v.ruleCont);
}

/** C16a 舊案（涉訟中）：法律事實答「舊案」，而且這筆不是法律規則判定 */
export function isLegalOngoing(v) {
  return isObj(v) && isObj(v.ruleFacts) && v.ruleFacts.C16a === 'old' && ruleClassOf(v) !== 'C16a';
}

// ── 計數（依資料日累計進 stopSpecAudit/{資料日}.newsRule；只放計數，不放代號與句子） ─────────────

/**
 * 一筆判別的事實題 → 計數：asked（實際送出的題數，含失敗）、reused（當日沿用、沒送出）、fail（呼叫失敗或空白）、
 * ans（新送出且有回覆的答案分布，依 state）、quoteFail（C16a 引用比不上）、cont（延續）、renew（N4 有效期內較晚的新進展換新軌跡）。
 * 只回有值的鍵。
 */
export function ruleAuditCounts(facts, verdict = null) {
  const out = { asked: {}, reused: {}, fail: {}, ans: {}, quoteFail: {}, cont: {}, renew: {} };
  const inc = (k, c, sub = null) => {
    if (sub) { out[k][c] = { ...(out[k][c] ?? {}) }; out[k][c][sub] = (out[k][c][sub] ?? 0) + 1; }
    else out[k][c] = (out[k][c] ?? 0) + 1;
  };
  for (const [c, f] of Object.entries(isObj(facts) ? facts : {})) {
    if (!RULE_CLASS_BY_CODE[c] || !isObj(f)) continue;
    if (f.ev?.reused) { inc('reused', c); continue; }
    inc('asked', c);
    if (f.answered === false) { inc('fail', c); continue; }
    inc('ans', c, RULE_FACT_STATES.includes(f.state) ? f.state : 'none');
    if (f.ev?.why === 'quote') inc('quoteFail', c);
  }
  if (isRuleContinuation(verdict)) inc('cont', verdict.ruleClass);
  if (isRuleRenewal(verdict)) inc('renew', verdict.ruleClass);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => Object.keys(v).length));
}

// ── 單檔大小（newsVerdict 日文件逼近 1MB 時壓縮證據） ─────────────────────────

const EVIDENCE_TEXT_KEYS = Object.freeze(['ctx', 'title', 'src', 'ans', 'quote', 'dateText', 'qctx']);

/**
 * 判別表的證據瘦身：level 'text' ＝去掉文字欄（前後文、標題、來源、回答、引用、日期原字、引用子句），留鍵、狀態、日期、旗標；
 * level 'all' ＝整個 ruleEvidence 拿掉（ruleFacts、ruleTrail 照留）。回新物件（只複製有證據的那幾筆）。
 */
export function slimRuleEvidence(verdicts, level = 'text') {
  if (!isObj(verdicts)) return verdicts;
  const out = {};
  for (const [code, v] of Object.entries(verdicts)) {
    if (!isObj(v) || !isObj(v.ruleEvidence)) { out[code] = v; continue; }
    if (level === 'all') { const { ruleEvidence: _e, ...rest } = v; out[code] = rest; continue; }
    out[code] = {
      ...v,
      ruleEvidence: Object.fromEntries(Object.entries(v.ruleEvidence).map(([c, e]) => [
        c, isObj(e) ? Object.fromEntries(Object.entries(e).filter(([k]) => !EVIDENCE_TEXT_KEYS.includes(k))) : e,
      ])),
    };
  }
  return out;
}

const utf8Bytes = s => new TextEncoder().encode(s).length;

/**
 * 判別表 → 要寫進 Firestore 的 verdictJson：加上 otherBytes（同檔的 seenJson 等）超過 maxBytes 就依序瘦身證據（text → all）。
 * 回 { json, level:'full'|'text'|'all', bytes }。判別本身（label、理由、規則欄位）一律不動；瘦到 all 仍超過也照回（不截判別）。
 */
export function fitVerdictJson(verdicts, { maxBytes = RULE_DOC_SOFT_MAX, otherBytes = 0 } = {}) {
  const fits = json => {
    if ((json.length * 3) + otherBytes <= maxBytes) return { ok: true, bytes: null };   // UTF-16 長度 ×3 是 UTF-8 位元組上界
    const bytes = utf8Bytes(json);
    return { ok: bytes + otherBytes <= maxBytes, bytes };
  };
  let json = JSON.stringify(verdicts ?? {});
  let r = fits(json);
  if (r.ok) return { json, level: 'full', bytes: r.bytes };
  json = JSON.stringify(slimRuleEvidence(verdicts, 'text'));
  r = fits(json);
  if (r.ok) return { json, level: 'text', bytes: r.bytes };
  json = JSON.stringify(slimRuleEvidence(verdicts, 'all'));
  r = fits(json);
  return { json, level: 'all', bytes: r.bytes ?? utf8Bytes(json) };
}
