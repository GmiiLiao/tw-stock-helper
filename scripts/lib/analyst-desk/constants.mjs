// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊：程式常數單一來源（契約 §1／§3／§4；規格 04 §3.2／§4.4）
//   純常數＋純函式，零 IO。issue 內的 useRules／免責由程式從這裡寫入，LLM 欄位不收（R02／R25）。
//   ⚠ 命名紀律：任何「會進 issue JSON 的物件鍵」不得符合 /score|signal|buy|sell|rank|target|stop|entry|exit|action|rating|recommend/i，
//     不得發明 At／Date 結尾的新鍵（只允許 dataDate／generatedAt／canonicalAt／updatedAt）。
//     這裡的「禁用詞」是字串內容，不是鍵。
// ─────────────────────────────────────────────────────────────────────────────

/** 免責長版（04 §4.4）。頁首與 issue 檔內使用；程式寫入，逐字比對。（原文的粗體標記 ** 為排版，不屬文字內容，已去除。） */
export const DISCLAIMER = '本頁由 AI 分析師依證交所、櫃買中心、公開資訊觀測站等官方資料與站內整理資料撰寫，經程式查核數字與引用來源。內容為資料日的市場事實描述與條件式觀察，不是投資建議，不含價格目標、買賣或進出場指示，也不保證任何結果。列示的個股僅為資料整理出的觀察名單，不構成推薦、招攬或個人化投資建議。AI 可能出錯，請以官方公告為準；報酬數字未扣交易成本，過去的表現不代表未來。投資請自行判斷並承擔風險。';

/** 免責短版（每張卡底部，R25）。 */
export const DISCLAIMER_SHORT = 'AI 整理，非投資建議；個股為資料觀察名單，非買賣建議。';

/** 候選池規則版本（04 §3.3）。 */
export const POOL_RULE = 'pool-v1';

export const SCHEMA_VERSION = 1;
export const ISSUE_KIND = 'dailyAnalyst';
export const PACK_KIND = 'analystPack';

// ── 封閉清單（契約 §2／§3；R01）──────────────────────────────────────────────
export const EDITIONS = Object.freeze(['evening', 'morning']);
export const CARD_IDS = Object.freeze(['prev', 'data', 'next']);
export const CLAIM_KINDS = Object.freeze(['fact', 'comparison', 'linkage', 'conditional', 'caveat']);
/** 由強到弱（資料等級；「最低等級」＝順序最後者）。傳聞最弱；先驗·未驗證為假說層。 */
export const TIERS = Object.freeze(['官方', '官方衍生', '媒體', '站內整理', 'AI待驗', '先驗·未驗證', '傳聞']);
export const DIRECTIONS = Object.freeze(['偏強', '偏弱', '持平', '拉抬', '拖累', '利多', '利空', '需讀內文', '無']);
export const MECHANISMS = Object.freeze(['同業連動', '供應鏈', '匯率', '利率', '商品價格', '政策法規', '資金流向']);
export const FMTS = Object.freeze(['sg2', 'int', 'pts1', 'bn1', 'pct0', 'date', 'txt']);
export const SECTION_IDS = Object.freeze(['overview', 'momentum', 'diff', 'outlook', 'linkage', 'news', 'industry', 'global']);
export const ANALYSTS = Object.freeze(['momentum', 'industry', 'global', 'editor']);
export const CONTRIBUTORS = Object.freeze(['momentum', 'industry', 'global']);
export const FOCUS_KINDS = Object.freeze(['recap', 'watch']);
export const ENGINE_TIERS = Object.freeze(['claude', 'ollama', 'template']);
/** FocusStock.evidence[].role（契約只示例 price／news；其餘為本模組補齊的封閉清單，W3 提示詞須沿用）。 */
export const EVIDENCE_ROLES = Object.freeze(['price', 'volume', 'flow', 'news', 'announcement', 'industry', 'global', 'calendar', 'context']);
export const COND_OPS = Object.freeze(['<=', '>=', '<', '>', '==']);
/** 每張卡的 focus.kind（04 §1.1：昨日／今日＝回顧；明日＝觀察）。 */
export const FOCUS_KIND_BY_CARD = Object.freeze({ prev: 'recap', data: 'recap', next: 'watch' });
/** 卡片資料日取自 dates 的哪一格。 */
export const CARD_DATE_KEY = Object.freeze({ prev: 'prev', data: 'data', next: 'next' });

export const FOCUS_MIN = 5;
export const FOCUS_MAX = 10;
export const MAX_SENTENCE_CHARS = 90;
export const MAX_HEADLINE_CHARS = 40;
export const MAX_FOCUS_THESIS_CHARS = 80;
export const MAX_SAME_INDUSTRY = 4;
export const MAX_CARDS_PER_CODE = 2;
export const MAX_POINTS = 5;
export const MAX_NEXT_FOCUS = 3;
export const MAX_RISKS = 3;

/** 缺值固定句（CLAUDE.md：不給資料欄位捏造預設值）。 */
export const MISSING_TEXT = '來源未提供';

/** 日期鍵白名單：新鍵不得以 At／Date 結尾，只能用這四個（契約抬頭）。 */
export const ALLOWED_DATE_KEYS = Object.freeze(['dataDate', 'generatedAt', 'canonicalAt', 'updatedAt']);
/** 鍵名禁用正規式（04 R01＋契約）。 */
export const FORBIDDEN_KEY_RE = /score|signal|buy|sell|rank|target|stop|entry|exit|action|rating|recommend/i;
/**
 * 鍵名例外：契約自己定義的 `meta.check.redactions` 含子字串 "action"（red-action-s），照字面會被 FORBIDDEN_KEY_RE 擋；
 * 這是契約內部矛盾，這裡明文豁免這一個鍵（其餘一律不豁免）。
 */
export const KEY_SCAN_EXEMPT = Object.freeze(['redactions']);
/** 鍵名＝動態識別字的 map（鍵是 refId／來源名，不掃鍵，只掃其值）。 */
export const DYNAMIC_KEY_PATHS = Object.freeze(['refTable', 'meta.check.rules', 'meta.pack.inputs']);

/**
 * ref id 文法（契約 §2：首段 1–3 個小寫字母）。⚠ 契約內部矛盾：§2 同時列 `prev.*`／`diff.*` 命名空間（4 字母），照字面會被自己的文法擋掉；
 * 這裡把首段放寬為 1–4 字母，使 prev.*／diff.* 可用（W1 pack-refs.mjs 仍是 1–3，其 prev.*／diff.* 會在 pack 端被丟棄，需 W1 對齊）。
 */
export const REF_ID_RE = /^[a-z]{1,4}(\.[A-Za-z0-9^=_\-\u4e00-\u9fa5]+){1,4}$/;

/** 同時需要「紅線」的 ref 命名空間（個股專屬）：第二段必為代號。 */
export const STOCK_NAMESPACES = Object.freeze(['st', 'nv', 'mo', 'wk']);

/** 傳聞最弱等級顯示用標記：渲染時由程式自動附加（R14），不依賴 LLM。 */
export const MARK_TIERS = Object.freeze(['AI待驗', '站內整理', '先驗·未驗證']);
export const tierMark = tier => `（${tier}）`;

/** 等級強弱序（index 越大越弱）。未知等級回 -1。 */
export const tierIndex = tier => TIERS.indexOf(tier);
/** 取一組等級中最弱者；空或皆未知回 null。 */
export function lowestTier(tiers) {
  let worst = -1;
  for (const t of tiers) { const i = tierIndex(t); if (i > worst) worst = i; }
  return worst < 0 ? null : TIERS[worst];
}
/** 推導型內容（連動）最高只到「站內整理」：比它強的一律夾到「站內整理」。 */
export function clampDerivedTier(tier) {
  if (tier == null) return null;
  const cap = tierIndex('站內整理');
  return tierIndex(tier) < cap ? '站內整理' : tier;
}

/** 使用規則（仿 scripts/lib/daily-heatmap/compute.mjs 的 USE_RULES；issue.useRules 必須與之逐字相等，R02）。 */
export const USE_RULES = Object.freeze({
  usedForScoring: false,
  nature: 'AI 依資料包整理的盤後分析與觀察名單；描述事實與條件式觀察，不是買賣建議、不是評分、不是預測',
  forbidden: Object.freeze([
    '進任何模型分數、排序鍵、濾網、門檻',
    '餵新聞識讀／AI 波段 LLM 當方向依據',
    '寫入 picksHistory／picksScoreboard／任何推薦榜',
  ]),
  disclaimer: DISCLAIMER,
  disclaimerShort: DISCLAIMER_SHORT,
});

/** 回傳可寫進 issue 的深拷貝（凍結物件不可被後續流程誤改）。 */
export function buildUseRules() {
  return { usedForScoring: USE_RULES.usedForScoring, nature: USE_RULES.nature, forbidden: [...USE_RULES.forbidden], disclaimer: USE_RULES.disclaimer, disclaimerShort: USE_RULES.disclaimerShort };
}

/** 程式固定句：這些字串出現在文字內時不掃禁用詞（它們是程式常數，不是 LLM 輸出）。 */
export const FIXED_PHRASES = Object.freeze([DISCLAIMER, DISCLAIMER_SHORT, USE_RULES.nature, ...USE_RULES.forbidden]);

// ── 卡片標題（程式產生；LLM 不收）──────────────────────────────────────────────
const CARD_LEAD = Object.freeze({ prev: '昨日股市', data: '今日盤後', next: '明日預期' });
export const CARD_LEADS = CARD_LEAD;

export function isIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** M/DD（與 src/components/AfterMarket/shared.tsx 的 mdOf 同形：月不補零、日補零，例 10/02）。 */
export const mdOf = iso => (isIsoDate(iso) ? `${+iso.slice(5, 7)}/${iso.slice(8, 10)}` : '');

/**
 * 資料日標籤，沿用站上 dayLabel 規則：資料日早於今天＝「前交易日」、等於今天＝「當日」；晚於今天＝「下一交易日」（明日卡）。
 * todayISO 未提供時（純函式不讀時鐘）：prev／data → 前交易日，next → 下一交易日。
 */
export function dayLabelOf(id, dayISO, todayISO) {
  if (!isIsoDate(dayISO)) return '資料日';
  const md = mdOf(dayISO);
  let lead;
  if (isIsoDate(todayISO)) lead = dayISO < todayISO ? '前交易日' : dayISO === todayISO ? '當日' : '下一交易日';
  else lead = id === 'next' ? '下一交易日' : '前交易日';
  return `${lead} ${md}`;
}

/** 卡片標題：昨日股市／今日盤後／明日預期 ＋（前交易日｜當日｜下一交易日 M/DD）。 */
export function cardTitle(id, dayISO, todayISO) {
  const lead = CARD_LEAD[id];
  if (!lead) throw new Error(`cardTitle: 未知卡 id ${String(id)}`);
  if (!isIsoDate(dayISO)) return `${lead}（資料日）`;
  return `${lead}（${dayLabelOf(id, dayISO, todayISO)}）`;
}

/** 標題格式樣式（R01：不知 today 時只驗格式）。 */
export const CARD_TITLE_RE = /^(昨日股市|今日盤後|明日預期)（(前交易日|當日|下一交易日) (\d{1,2})\/(\d{2})）$/;
export const DAY_LABEL_RE = /^(前交易日|當日|下一交易日) (\d{1,2})\/(\d{2})$/;

/** 與 01 R10 對應的伴隨 ref 規則（預設空；W1 定了 ref 命名後可填，例：引用 ind.*.heat 時須同句引用熱度口徑說明）。 */
export const COMPANION_RULES = Object.freeze([]);

/** 已知不可用的 ref（02 L19：avgChg 不得用於產業報酬；03 R13：foreignTxfNetOI 實為交易口數淨額，不得當未平倉）。 */
export const FORBIDDEN_REF_RES = Object.freeze([/avgChg/i, /foreignTxfNetOI/i]);

/** pack 內來源缺席（absent）時，哪些字樣代表「在談那個來源」（R21）。鍵＝來源名（pack.absent 的值）。 */
export const ABSENT_SOURCE_KEYWORDS = Object.freeze({
  adrPremium: /ADR|存託憑證/i,
  taifexPositions: /未平倉|台指期|期貨|TAIFEX/i,
  globalMarkets: /費半|那斯達克|標普|道瓊|美股|隔夜/,
  mopsNews: /重訊|重大訊息|公開資訊觀測站|MOPS/i,
  newsVerdict: /消息面|媒體判別/,
  chipArchive: /法人|外資|投信|自營商|籌碼|買賣超/,
  heatmap: /熱力/,
});
