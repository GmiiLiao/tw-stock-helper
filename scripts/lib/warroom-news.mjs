// ─────────────────────────────────────────────────────────────────────────────
// 盤中戰情 v2·新聞判別（媒體 M 管線）的唯一實作：新聞燈、A1 KPI、B2 新聞事件、Z2 持股重大利空、A2 盤前新聞、
// 快看抽屜的權重明細。伺服器（src/lib/warroom/build-news.ts、build-feeds.ts）與前端共用；單元測試 warroom-news.test.mjs。
//
// 規範：.claude/skills/tw-news-impact-analyst/SKILL.md（新聞識讀唯一規範）；設計：PLAN/stoploss/news-weight.md（衝突以規範為準）。
// 影響權重 w 一律沿用 after-market-news.mjs 的 rankMediaVerdicts（強度×信心×確定性×新穎×尚未反映，0–1；盤後報告同名同口徑），
//   這裡只 import、不另算。使用者裁定（2026-10-05，停損規範 §10B／§13.2 B4）：w **研究期·只顯示**——不當任何等級的警示門檻、
//   不進排序與停損。Z2「持股重大利空」與停損收緊一律以**規則類別**判定（news-rule-classes.mjs；第二輪 A4「做skills判定與加權重」）。
//
// 來源只有 newsVerdict/latest（daemon 已寫好的 AI 讀內文判別；不擴大判別範圍、不呼叫 LLM、不打上游）。
//   每檔只取一筆判別（AI 讀完最多 4 篇內文後的個股結論），不加總 ⇒ 來源再多也不放大（規範 §2、§6.2 不變式）。
//   官方重訊（mopsNews，O 管線）只做獨立「重訊」徽章，不併入這裡的任何權重（§2：O 與 M 不可加總）。
//
// 規範硬規定在這裡的落實（程式強制，不看模型回答了什麼）：
//   §0   權重全是先驗、未校準、研究期不計分 ⇒ 只用來顯示燈號強弱；不當警示門檻、不進任何評分、排序鍵或模型
//        （清單排序一律用類別＋時間，不用權重）；畫面一律附「研究期·只顯示」（NEWS_WEIGHT_NOTE）。
//   §1.1／1.3／1.8 沒讀內文＝資訊不足：basis≠content、D 拒答、E 引用未過（規則類別除外）⇒ 空心燈、權重 0、不發警示。
//   §1.4 機器價格速報不是新聞：daemon 在標題層已剔除（NEWS_NOISE_RE／MACHINE_NEWS）；這裡再擋一次——AI 挑的關鍵句
//        是價格描述、且事件類型不是本業事實 ⇒「剔除」，權重 0、不判方向。
//   §1.5／§1.7 規則類利空（法律、財務危機、工安停工、交易限制…，新聞技能 §4.1 方向標「−（規則）」者）：只認 daemon 的程式規則判定
//        （ruleClassOf：ruleClass＋該類事實題答「是」〔ruleFacts〕；舊資料 C16a 認 ruleOverride／「【規則】」前綴）——AI 讀內文只認定事實
//        （主體是不是本檔、事件是否屬實），方向由規則定為利空。daemon 只對法律類 C16a 把 label 覆寫為利空；其他類別 label 維持 AI 原判
//        （使用者 2026-10-06 R1：label 連動推薦排序、個股評分、做空候選、squeeze-train），戰情一律以規則欄位判為利空（verdictState，
//        不看 label），AI 原判顯示為「AI 原判…」（aiOriginal；停損規範 §10A.2-3）。
//        AI 的 eventType='法律' 範圍很廣（和解金、聯貸、認證…），**不當規則類別**，燈照 AI 判的方向。
//        2026-10-05 起 daemon 對 AI 自判利空的也問事實（ruleFacts）；沒有事實回答的舊判別，AI 判利空且事件類型為法律、或依據句有
//        檢調／搜索／起訴等字樣的，仍標「可能為法律事件（未經規則確認）」（pl），只揭露、不升級，而且不套 §1.4／§1.6 的改判。
//   §1.6 關注度≠營運事實：關鍵句（缺時用理由）是目標價／評等／概念股／熱門股／ESG 等、且事件類型不是本業事實
//        ⇒ 灰燈「關注度」，不判方向、權重 0、不發警示；保留 AI 原判供追溯（aiOriginal）。
//        信評機構調降評等或展望（§4.1 C20b：−，規則）不是關注度 ⇒ 利空判別遇到信評字樣不套 §1.6。
//   §1.8 引用要能在內文逐字找到：daemon 只核對 E 階段的 quotes[]（精簡表 vq＝第一條），AI 的 keyQuote 沒有逐字核對
//        ⇒ 畫面標「AI 摘句（未逐字核對）」；keyQuote 是「無」或空字串一律當沒有。
//   §2   媒體半衰期最多 1 個交易日：只有「適用交易日＝今日」、非承接（carriedFrom）、且走過四角色挑戰的判別才列強弱、
//        進 KPI 與警示。daemon 的 14 日舊聞回退（近兩日沒有內文就拿 14 天內的舊報導判）不跑挑戰，判別表沒有存 stale ⇒
//        以 challenged 當代理：沒走挑戰的方向判別一律 ◆（可能是舊聞回退或挑戰失敗），不列強弱、不計入利空。
//        承接、前一交易日或沒走挑戰的判別只顯示方向＋◆，不列強弱。
//   §6.5 研究期分數「不影響任何排名或名單」⇒ 權重門檻類（w≥0.6、法律/處分 w≥0.3）不發任何等級的警示（停損規範 §13.2 B4 已確認）。
//        Z2 持股重大利空只看規則類別的**類別權重**（新聞技能 §4.1 baseWeight，先驗·未回測，不是 w）：≥0.7 一級、0.3–0.7 二級、
//        <0.3 不列 Z2（B2「我的」照列二級）。B2 全市場與「我的」新聞事件、A2 盤前清單的名單與排序都不用 w；
//        Z2 同日再發只看警示等級上升（二級→一級），不看強弱。w 只用來顯示強弱文字。
// ─────────────────────────────────────────────────────────────────────────────
import { rankMediaVerdicts } from './after-market-news.mjs';
import {
  RULE_LEGAL_PREFIX, ruleClassOf, ruleSubOf, classWeightOf, classWeightBand, ruleClassText, ruleFactAnswered,
} from './news-rule-classes.mjs';
import { toEpochMs } from './warroom-freshness.mjs';
import { taipeiDayStart, taipeiMinuteOfDay, taipeiYmd } from './warroom-session.mjs';

// ── 常數 ────────────────────────────────────────────────────────────────────

/** 畫面上影響權重旁一律附的說明（規範 §0；停損規範 wording.md §4「影響權重（研究期·只顯示）」） */
export const NEWS_WEIGHT_NOTE = '研究期·只顯示';
/** 強弱分級切點（依 09-21 起 916 筆方向判別的分布定，未用報酬校準） */
export const NEWS_TIER_CUTS = Object.freeze({ strong: 0.6, mid: 0.3 });
export const NEWS_TIER_LABEL = Object.freeze({ strong: '強', mid: '中', weak: '弱' });
/** 精簡表文字長度上限（daemon 理由存 70 字、關鍵句 40 字） */
export const NEWS_TEXT_MAX = Object.freeze({ reason: 70, quote: 60, revision: 80 });
/** 判別趟次（daemon newsVerdict 的 pass） */
export const PASS_LABEL = Object.freeze({ evening: '盤後', night: '夜補', morning: '晨間', intraday: '盤中' });
export const PREMARKET_PASSES = Object.freeze(['evening', 'night', 'morning']);
/** daemon 閘門字樣（scripts/ai-daemon.mjs judgeOneStock） */
export const GATE_D = 'D-拒答門檻';
export const GATE_E = 'E-引用強制';
/** daemon 法律規則覆寫的理由前綴（唯一定義在 news-rule-classes.mjs；這裡轉出給既有呼叫端） */
export { RULE_LEGAL_PREFIX };
const AI_NO_REPLY_RE = /AI 判別未回應/;
/** 本業事實類事件（daemon L1 事件類型清單裡屬營運事實的）：不套 §1.4／§1.6 的價格描述、關注度判定 */
export const HARD_FACT_TYPES = Object.freeze(['訂單', '財測', '擴產', '法律', '處分', '減資', '併購', '營收財報', '新產品']);
/** §1.4 機器價格速報／價格描述（與 daemon MACHINE_NEWS 同字樣，另加價格結果描述） */
export const PRICE_BULLETIN_RE = /盤中速報|收盤速報|漲速|自動生成|快訊[:：]?\s*股價|股價(?:一度|盤中|早盤|尾盤|今日?)?(?:拉至|拉升|急拉|急殺|直奔|攻上|亮燈|強攻|重挫|大漲|大跌|勁揚|走揚|走低|下跌|上漲|跳空)|(?:拉至|攻上|亮燈|鎖住?)漲停|(?:摜破|鎖住?)跌停|爆量|成交量(?:放大|暴增|激增)|指數(?:重挫|大漲|大跌)/;
/** §1.6 關注度（入選概念股、目標價、評等、熱門股、ESG／綠建築認證、題材） */
export const ATTENTION_RE = /目標價|評等|評級|概念股|題材股|主旋律|熱門(?:股|零股)|人氣股|ESG|綠建築|永續(?:評鑑|認證|評比)|入選/;
/** §4.1 C20b 信評機構（調降評等或展望＝−，規則）：利空判別遇到這些字樣不套 §1.6 關注度 */
export const CREDIT_RATING_RE = /信評|信用評[等級]|惠譽|穆迪|標準普爾|Fitch|Moody/i;
/** §1.5 法律事件字樣（同 daemon LEGAL，去掉過寬的「調查」）：只用來揭露「可能為法律事件」與豁免 §1.4／§1.6，不動方向與權重 */
export const LEGAL_TEXT_RE = /檢調|搜索|搜查|約談|起訴|羈押|背信|掏空|調查局|地檢署|檢察官/;
/** 「同一關鍵句隔日再判利空＝持續」的記錄保留天數（日曆日，約 5 個交易日） */
export const NEWS_REPEAT_KEEP_DAYS = 7;

const CODE_RE = /^\d{4,6}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATES = new Set(['bull', 'bear', 'neutral', 'insufficient', 'unjudged', 'attention', 'excluded']);
const DAY_MS = 86_400_000;
const TPE_OFFSET_MS = 8 * 3_600_000;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const numOrNull = (v) => (isNum(v) ? v : null);
const ymdOf = (v) => (typeof v === 'string' && YMD_RE.test(v) ? v : null);
const cut = (v, n) => {
  const s = str(v);
  if (!s) return null;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const pad2 = (n) => String(n).padStart(2, '0');
/** AI 沒句可引時回「無」（提示詞規定）⇒ 當沒有 */
const NONE_QUOTE_RE = /^[（(]?(?:無|没有|沒有|none|n\/a)[）)]?$/i;
const quoteText = (v) => {
  const s = str(v);
  return s && !NONE_QUOTE_RE.test(s) ? s : null;
};
/** daemon E 階段逐字核對通過的第一條引文（quotes[] 只存通過的） */
const verifiedQuoteOf = (v) => (Array.isArray(v.quotes) ? v.quotes.map(quoteText).find(Boolean) ?? null : null);
const passOf = (v) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(PASS_LABEL, v) ? v : null);

/** 台北 hh:mm */
export function tpeHhmm(ms) {
  if (!isNum(ms)) return '—';
  const d = new Date(ms + TPE_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
/** 'YYYY-MM-DD' → 'MM/DD' */
export function ymdShort(ymd) {
  return ymdOf(ymd) ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}` : '—';
}

/**
 * 判別時間標記（B2 伺服器事件與前端「我的」事件共用，同一則判別兩處同字）：
 * 早於今天＝「（mm/dd）」、今天 09:00 前＝「（盤前）」、其餘＝''。
 */
export function newsTimeTag(atMs, nowMs) {
  if (!isNum(atMs) || !isNum(nowMs)) return '';
  if (atMs < taipeiDayStart(nowMs)) return `（${ymdShort(taipeiYmd(atMs))}）`;
  return taipeiMinuteOfDay(atMs) < 9 * 60 ? '（盤前）' : '';
}

// ── 單筆判別的分類（規範 §1 的程式強制） ───────────────────────────────────

/** 規則類利空（§1.5／§1.7）：daemon 程式規則判定留下的類別（ruleClassOf），AI 只認定事實。eventType='法律' 不算。 */
export function isRuleBear(v) {
  return ruleClassOf(v) !== null;
}

/** 法律事件（C16a）規則判定：AI 已確認對象是本公司，方向由規則定為利空。eventType='法律' 不算。 */
export function isRuleLegal(v) {
  return ruleClassOf(v) === 'C16a';
}

/** AI 讀過內文（§1.1／1.3／1.8）：basis=content、不是 D 拒答、不是「AI 未回應」的保守中性、E 引用未過者除非規則類別 */
export function isAiRead(v) {
  if (!isObj(v) || v.basis !== 'content') return false;
  if (v.gate === GATE_D) return false;
  if (v.label === '中性' && AI_NO_REPLY_RE.test(String(v.reason ?? ''))) return false;
  if (v.gate === GATE_E && !isRuleBear(v)) return false;
  return true;
}

/** 判別依據句：AI 從內文挑的關鍵句（「無」或空字串時用理由）——§1.4／§1.6 只看它，不看標題 */
function evidenceOf(v) {
  return quoteText(v.keyQuote) ?? str(v.reason) ?? '';
}
const hardFact = (v) => HARD_FACT_TYPES.includes(v.eventType);

/**
 * §1.5 可能為法律事件（未經規則確認）：AI 自己判利空、不是法律規則判定、**也沒有法律事實的回答**（2026-10-05 前的舊判別，
 * 或 C16a 沒觸發／事實題沒答），而事件類型是法律、或依據句／理由／已核對引文有檢調、搜索、起訴等字樣。只揭露、不改方向與權重、不升級。
 * 法律事實答「否」（主體不是本公司）的不算。
 */
export function isPossibleLegalBear(v) {
  if (!isObj(v) || v.label !== '利空' || isRuleLegal(v) || ruleFactAnswered(v, 'C16a')) return false;
  if (v.eventType === '法律') return true;
  const text = [quoteText(v.keyQuote), str(v.reason), ...(Array.isArray(v.quotes) ? v.quotes.map(quoteText) : [])].filter(Boolean).join(' ');
  return LEGAL_TEXT_RE.test(text);
}

/** §1.4：依據句是價格描述（結果不是原因），且事件類型不是本業事實 */
export function isPriceBulletin(v) {
  if (!isObj(v) || hardFact(v)) return false;
  return PRICE_BULLETIN_RE.test(evidenceOf(v));
}

/** §1.6：依據句是關注度（目標價、概念股、ESG…），且事件類型不是本業事實；信評機構調降（C20b）的利空不算 */
export function isAttentionOnly(v) {
  if (!isObj(v) || hardFact(v)) return false;
  const text = evidenceOf(v);
  if (v.label === '利空' && CREDIT_RATING_RE.test(text)) return false;
  return ATTENTION_RE.test(text);
}

/**
 * 一筆判別 → 狀態：bull／bear／neutral（AI 讀內文的判別）｜insufficient（資訊不足：沒讀到內文）｜unjudged（AI 未回應、標籤不明）
 * ｜attention（§1.6 關注度）｜excluded（§1.4 價格描述）。規則類利空（AI 讀過內文）一律 bear，**不看 label**：方向由規則定——
 * C16a 的 label daemon 已覆寫為利空；其他類別 daemon 不改 label（2026-10-06 R1），AI 原判在 aiOriginal／label。
 * 也不受 §1.4／§1.6 影響（§1.5／§1.7 優先）。
 */
export function verdictState(v) {
  if (!isObj(v)) return 'unjudged';
  if (isRuleBear(v) && isAiRead(v)) return 'bear';
  if (v.label === '資訊不足') return 'insufficient';
  if (v.label !== '利多' && v.label !== '利空' && v.label !== '中性') return 'unjudged';
  if (v.label === '中性' && AI_NO_REPLY_RE.test(String(v.reason ?? ''))) return 'unjudged';
  if (!isAiRead(v)) return 'insufficient';
  // §1.5 優先：可能為法律事件的 AI 利空不套 §1.4／§1.6（例：關鍵句同時寫到檢調搜索與股價重挫）
  if (v.label !== '中性' && !isPossibleLegalBear(v)) {
    if (isPriceBulletin(v)) return 'excluded';
    if (isAttentionOnly(v)) return 'attention';
  }
  return v.label === '利多' ? 'bull' : v.label === '利空' ? 'bear' : 'neutral';
}

/** 強弱分級：w≥0.6 強、0.3≤w<0.6 中、w<0.3 弱；沒有權重 null */
export function newsTier(w) {
  if (!isNum(w)) return null;
  if (w >= NEWS_TIER_CUTS.strong) return 'strong';
  if (w >= NEWS_TIER_CUTS.mid) return 'mid';
  return 'weak';
}

/** 規則判定時 AI 的原判（aiOriginal.label；沒有就看現在的 label）；與利空相同（AI 自己也判利空）回 null */
function aiOriginalOf(v) {
  const orig = str(v.aiOriginal?.label) ?? str(v.label);
  return orig && orig !== '利空' ? orig : null;
}

function entryOf(v, w) {
  const st = verdictState(v);
  const directional = st === 'bull' || st === 'bear';
  const overridden = st === 'attention' || st === 'excluded';
  const rc = st === 'bear' ? ruleClassOf(v) : null;
  // 規則定的方向與 AI 原判不同（AI 判中性／利多、規則定為利空；aiOriginal 記原判）：w 屬於 AI 的方向，不顯示在利空燈上
  const weight = directional && isNum(w) && !(rc && aiOriginalOf(v)) ? w : null;
  // 關鍵句只給利空與「強」的利多、修正說明只給利空（控制慢層 payload；其餘到個股頁看完整判讀）
  const quote = st === 'bear' || (weight != null && weight >= NEWS_TIER_CUTS.strong);
  return {
    st,
    // 權重只給 AI 讀內文的利多／利空（rankMediaVerdicts 同一個數字）；中性、資訊不足、關注度、剔除＝0（不顯示）
    w: weight,
    s: str(v.strength), c: str(v.confidence), ct: str(v.certainty), nv: str(v.novelty), pr: str(v.priced),
    ev: str(v.eventType),
    lg: rc === 'C16a',
    rc,
    rs: rc ? ruleSubOf(v, rc) : null,
    ra: rc ? aiOriginalOf(v) : null,
    pl: st === 'bear' && isPossibleLegalBear(v),
    ch: v.challenged === true,
    cr: ymdOf(v.carriedFrom),
    at: toEpochMs(v.at),
    p: passOf(v.pass),
    qv: numOrNull(v.quoteVerified),
    qf: numOrNull(v.quoteFailed),
    un: Array.isArray(v.unverifiedNums) ? v.unverifiedNums.length : 0,
    n: numOrNull(v.n),
    r: directional || overridden ? cut(v.reason, NEWS_TEXT_MAX.reason) : null,
    // kq＝AI 摘的關鍵句（沒有逐字核對）；vq＝daemon E 階段逐字核對通過的第一條引文（§1.8）
    kq: quote || overridden ? cut(quoteText(v.keyQuote), NEWS_TEXT_MAX.quote) : null,
    vq: quote ? cut(verifiedQuoteOf(v), NEWS_TEXT_MAX.quote) : null,
    rv: st === 'bear' ? cut(v.revision, NEWS_TEXT_MAX.revision) : null,
    ai: overridden ? v.label : null,
  };
}

/**
 * newsVerdict/latest → 全市場精簡表 { meta, map }（所有人同一份，前端用自己的持股／自選過濾；網址不帶個人參數）。
 * 文件不存在或 verdictJson 壞掉回 null（不捏造空表冒充「全部未判別」）。
 * 只讀 verdictJson：同一檔即使也出現在軋空、漲停預測名單，這裡不併、不加總（§2、§6.2）。
 */
export function newsBoardFromDoc(doc) {
  if (!isObj(doc) || typeof doc.verdictJson !== 'string') return null;
  let raw;
  try { raw = JSON.parse(doc.verdictJson); } catch { return null; }
  if (!isObj(raw)) return null;
  const clean = {};
  for (const [code, v] of Object.entries(raw)) if (CODE_RE.test(code) && isObj(v)) clean[code] = v;
  const ranked = rankMediaVerdicts(clean, { limit: Number.MAX_SAFE_INTEGER });
  const wBy = new Map(ranked.items.map((x) => [x.code, x.weight]));
  const map = {};
  for (const [code, v] of Object.entries(clean)) map[code] = entryOf(v, wBy.has(code) ? wBy.get(code) : null);
  return {
    meta: {
      targetDate: ymdOf(doc.targetDate) ?? ymdOf(doc.date),
      lastPass: passOf(doc.lastPass),
      updatedAt: toEpochMs(doc.updatedAt),
      covered: Object.keys(map).length,
    },
    map,
  };
}

// ── 時效（§2：媒體半衰期最多 1 個交易日） ─────────────────────────────────

/**
 * 判別表與「今日適用交易日」的關係：today 同一天｜prev 表是前幾個交易日的（daemon 盤後或晨間沒跑）｜
 * next 表已是下一交易日的（23:00 盤後趟寫完後）｜unknown 缺日期。
 * applicableYmd＝今天若是交易日就是今天，否則下一個交易日（呼叫端以休市日曆算好）。
 */
export function newsCtxOf(meta, applicableYmd) {
  const targetDate = isObj(meta) ? ymdOf(meta.targetDate) : null;
  const app = ymdOf(applicableYmd);
  let fresh = 'unknown';
  if (targetDate && app) fresh = targetDate === app ? 'today' : targetDate < app ? 'prev' : 'next';
  return { fresh, targetDate, applicableYmd: app };
}

/**
 * 今日適用、非承接、但沒走四角色挑戰的判別：daemon 的 14 日舊聞回退不跑挑戰（判別表沒存 stale），以此當代理
 * ——也可能是挑戰呼叫失敗（偏保守：只會少列，不會誤發）。
 */
export function isUnchallengedEntry(entry, ctx) {
  return isObj(entry) && isObj(ctx) && ctx.fresh === 'today' && !entry.cr && entry.ch !== true;
}

/** 這筆判別屬於今日適用交易日、不是承接前一日的、而且走過四角色挑戰（只有這種才列強弱、進 KPI 與警示；§2 媒體時效） */
export function isCurrentEntry(entry, ctx) {
  return isObj(entry) && isObj(ctx) && ctx.fresh === 'today' && !entry.cr && entry.ch === true;
}

/** 個股新聞識讀的範圍：4 碼普通股（ETF 00 開頭、權證、6 碼不做）——不在範圍的顯示「—」，不寫「未判別」 */
export function isNewsUniverse(code) {
  return typeof code === 'string' && /^[1-9]\d{3}$/.test(code);
}

function oldTagOf(entry, ctx) {
  if (entry?.cr) return `承接 ${ymdShort(entry.cr)}`;
  if (ctx?.fresh === 'prev') return `前交易日 ${ymdShort(ctx.targetDate)} 判別`;
  if (ctx?.fresh === 'next') return `下一交易日 ${ymdShort(ctx.targetDate)} 的判別`;
  if (isUnchallengedEntry(entry, ctx)) return UNCHALLENGED_TAG;
  return '適用交易日不明';
}
/** 沒走四角色挑戰的短標（燈、短字）；說明全文 UNCHALLENGED_NOTE */
export const UNCHALLENGED_TAG = '未走挑戰（可能舊聞）';
export const UNCHALLENGED_NOTE = '未走四角色挑戰（可能是 14 日舊聞回退或挑戰失敗）：不列強弱、不計入利空、不發警示';
/** 可能為法律事件的揭露句（燈 tooltip、抽屜、B2） */
export const POSSIBLE_LEGAL_NOTE = '可能為法律事件（未經規則確認：這筆判別沒有法律事實的回答，多為 10/05 規則補問前的判別；只揭露，不發 Z2 警示）';

/** 精簡表一列的規則類別（新表 rc；舊表只有 lg＝法律） */
function entryRuleClass(entry) {
  if (!isObj(entry)) return null;
  if (typeof entry.rc === 'string' && entry.rc) return entry.rc;
  return entry.lg ? 'C16a' : null;
}

/**
 * 規則類利空的說明句（燈 tooltip、快看抽屜）：類別、AI 讀內文確認事實、方向由規則定、類別權重（先驗·未回測，**不是**影響權重 w）、
 * AI 原判（與利空不同時）。不是規則類利空回 null。
 */
export function ruleClassNote(entry) {
  const cls = entryRuleClass(entry);
  const what = cls ? ruleClassText(cls) : null;
  const cw = cls ? classWeightOf(cls, entry.rs ?? null) : null;
  if (!what || !cw) return null;
  return `規則類利空：${what}——AI 讀內文確認主體與事實，方向由規則定為利空${cls === 'C16a' ? '（公司否認或澄清不中和）' : ''}`
    + `·類別權重 ${cw.weight.toFixed(2)}（新聞技能 §4.1 先驗·未回測；不是影響權重）${entry.ra ? `·AI 原判${entry.ra}` : ''}`;
}

const LABEL_OF = { bull: '利多', bear: '利空', neutral: '中性', insufficient: '資訊不足', unjudged: '未判別', attention: '關注度', excluded: '價格描述' };

function judgedText(entry) {
  const when = entry.at != null ? tpeHhmm(entry.at) : null;
  const pass = entry.p ? PASS_LABEL[entry.p] : null;
  if (pass && when) return `${pass} ${when} 判讀`;
  if (pass) return `${pass}判讀`;
  return when ? `${when} 判讀` : '判讀時間不明';
}

/**
 * 新聞燈的顯示。tone：up 利多紅｜dn 利空綠｜flat 灰（中性、關注度）｜none 空心（未判別、資訊不足、價格描述）｜na「—」（不做個股新聞識讀）。
 * tier：只有今日適用、非承接的利多／利空才有（強／中／弱）；其餘 null。title＝tooltip 全文（影響權重附「研究期·只顯示」；規則類利空附類別與類別權重）。rule＝規則類利空的類別短字。
 */
export function newsLampView(entry, ctx, { universe = true } = {}) {
  const mk = (tone, label, title, extra = {}) => ({ tone, tier: null, tierLabel: null, label, current: false, old: null, legal: false, rule: null, title, ...extra });
  if (!universe) return mk('na', '—', '不做個股新聞識讀（ETF、權證等）');
  if (!isObj(entry) || !STATES.has(entry.st)) return mk('none', '未判別', '未判別：AI 尚未讀到這檔可判別的內文（判別範圍未擴大）');
  const st = entry.st;
  if (st === 'insufficient') return mk('none', '資訊不足', `資訊不足：沒有讀到可判別方向的內文（只有標題、零提及或引文對不上原文）·不判方向、權重 0、不發警示${entry.at != null ? `·${judgedText(entry)}` : ''}`);
  if (st === 'unjudged') return mk('none', '未判別', '未判別：AI 判別未回應（保守不判方向）');
  if (st === 'excluded') return mk('none', '價格描述', `價格描述（機器速報類，結果不是原因）：不當新聞、不判方向、權重 0（新聞識讀規範 §1.4）·AI 原判 ${entry.ai ?? '—'}`);
  const current = isCurrentEntry(entry, ctx);
  const old = current ? null : oldTagOf(entry, ctx);
  if (st === 'attention') {
    return mk('flat', '關注度', `關注度（目標價、評等、概念股、熱門股、ESG 等）不是營運事實：不判方向、權重 0、不發警示（新聞識讀規範 §1.6）·AI 原判 ${entry.ai ?? '—'}·${judgedText(entry)}${old ? `·◆ ${old}` : ''}`, { current, old });
  }
  if (st === 'neutral') {
    return mk('flat', '中性', `中性：AI 讀內文判中性·${judgedText(entry)}${old ? `·◆ ${old}` : ''}`, { current, old });
  }
  const label = LABEL_OF[st];
  const tone = st === 'bull' ? 'up' : 'dn';
  const parts = [];
  let tier = null;
  const cls = st === 'bear' ? entryRuleClass(entry) : null;
  if (current) {
    tier = newsTier(entry.w);
    parts.push(`${label}·${tier ? NEWS_TIER_LABEL[tier] : cls ? '規則' : '—'}`);
    if (entry.w != null) parts.push(`影響權重 ${entry.w.toFixed(2)}（${NEWS_WEIGHT_NOTE}）`);
  } else {
    const unch = isUnchallengedEntry(entry, ctx);
    parts.push(`${label}·◆ ${old}`);
    parts.push(`${unch ? UNCHALLENGED_NOTE : '已過適用交易日（媒體時效 ≤1 交易日），不列強弱'}${entry.w != null ? `·原判權重 ${entry.w.toFixed(2)}` : ''}`);
  }
  const rn = cls ? ruleClassNote(entry) : null;
  if (rn) parts.push(rn);
  if (entry.pl) parts.push(POSSIBLE_LEGAL_NOTE);
  parts.push(judgedText(entry));
  if (current && ctx?.targetDate) parts.push(`適用 ${ymdShort(ctx.targetDate)}`);
  if (!entry.ch && !isUnchallengedEntry(entry, ctx)) parts.push('未走四角色挑戰');
  if (entry.r) parts.push(entry.r);
  return {
    tone, tier, tierLabel: tier ? NEWS_TIER_LABEL[tier] : null, label, current, old, legal: cls === 'C16a',
    rule: cls ? ruleClassText(cls) : null,
    title: parts.join('·'),
  };
}

/** 一行短字：「利空·強·權重 0.75」「利多◆承接 10/02」「未判別」 */
export function newsShortText(entry, ctx, opts) {
  const v = newsLampView(entry, ctx, opts);
  if (v.tone === 'na' || v.tone === 'none' || v.label === '關注度') return v.label;
  if (v.label === '中性') return v.current ? '中性' : `中性◆${v.old}`;
  if (!v.current) return `${v.label}◆${v.old}`;
  if (v.legal) return '利空·法律事件（法律判定前視為利空）';
  if (v.rule) return `利空·${v.rule}（規則判定）`;
  return `${v.label}·${v.tierLabel ?? '—'}${entry.w != null ? `·權重 ${entry.w.toFixed(2)}` : ''}`;
}

/** 抽屜的權重明細（因子用 AI 原標籤列出；數值與盤後報告同一支 rankMediaVerdicts） */
export function newsWeightText(entry) {
  if (!isObj(entry) || entry.w == null) return null;
  const f = (name, v) => `${name}（${v ?? '—，缺值取 0.4'}）`;
  return `影響權重＝${f('強度', entry.s)}×${f('信心', entry.c)}×${f('確定性', entry.ct)}×${f('新穎', entry.nv)}×${f('已被預期', entry.pr)}`
    + `＝${entry.w.toFixed(3)}（${NEWS_WEIGHT_NOTE}：先驗·未校準，只用來顯示強弱；不是分數，不進排序、警示與停損）`;
}

// ── A1 KPI ─────────────────────────────────────────────────────────────────

/**
 * 持股的新聞 KPI：bear＝今日適用、非承接、走過挑戰、AI 讀內文判利空的檔數；missing＝未判別／資訊不足／價格描述；
 * old＝有判別但不算今日（承接、前一交易日、或沒走挑戰＝可能舊聞回退）；na＝不在個股新聞識讀範圍（ETF 等）。
 */
export function newsKpi(codes, map, ctx) {
  const out = { bear: 0, missing: 0, old: 0, na: 0 };
  for (const code of codes ?? []) {
    if (!isNewsUniverse(code)) { out.na++; continue; }
    const e = isObj(map) ? map[code] : null;
    if (!isObj(e) || e.st === 'insufficient' || e.st === 'unjudged' || e.st === 'excluded') { out.missing++; continue; }
    if (!isCurrentEntry(e, ctx)) { out.old++; continue; }
    if (e.st === 'bear') out.bear++;
  }
  return out;
}

// ── Z2 持股重大利空（news-weight.md §3.6 條件 A–D＋規則類別；停損規範 §10A.1 同一套述詞） ─────────────────

/**
 * 條件：A 持股（自選＝scope 'watch' 只列二級）｜B 今日適用、非承接、判讀時間 ≥ minAtMs（上一交易日 13:30）｜
 * C AI 讀內文、狀態利空｜D 走過四角色挑戰（非 14 日舊聞回退的代理）｜E 規則類利空（程式規則判定；不看影響權重 w——B4）。
 * 級別看**類別權重**（新聞技能 §4.1 baseWeight，先驗·未回測；classWeightBand）：high（≥0.7）一級、mid（0.3–0.7）二級、
 * low（<0.3）不列 Z2（B2「我的」照列二級）。自選一律二級。
 * 回 { level, basis:'rule-legal'(C16a)|'rule-class', scope, cls, band } 或 null。
 */
export function majorBearOf(entry, { scope = 'holding', ctx, minAtMs = null } = {}) {
  if (!isObj(entry) || (scope !== 'holding' && scope !== 'watch')) return null;
  if (!isCurrentEntry(entry, ctx) || entry.at == null) return null;
  if (isNum(minAtMs) && entry.at < minAtMs) return null;
  if (entry.st !== 'bear' || entry.ch !== true) return null;
  const cls = entryRuleClass(entry);
  const band = cls ? classWeightBand(cls, entry.rs ?? null) : null;
  if (band !== 'high' && band !== 'mid') return null;
  const level = scope === 'watch' || band === 'mid' ? 2 : 1;
  return { level, basis: cls === 'C16a' ? 'rule-legal' : 'rule-class', scope, cls, band };
}

/** Z2 條件的說明短句（快看抽屜） */
export function majorBearNote(mb) {
  if (!isObj(mb)) return null;
  if (mb.level === 1) return '達持股重大利空一級條件（規則類別·類別權重 ≥0.7；Z2 警示）';
  if (mb.scope === 'watch') return mb.band === 'high' ? '達重大利空一級條件（自選只列二級）' : '規則類利空（自選只列二級）';
  return '規則類利空·類別權重 0.3–0.7（Z2 二級）';
}

/** 去重等級＝警示等級（一級 2、二級 1）：同日再發只看等級上升（例：新出現法律覆寫），不看強弱（§6.5 權重不當觸發門檻） */
const alertRank = (mb) => (mb?.level === 1 ? 2 : 1);

/** 關鍵句雜湊（djb2；只用來辨認「同一句話隔日再判一次」，不存原文） */
export function quoteHash(s) {
  let h = 5381;
  for (const ch of String(s ?? '')) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return h.toString(36);
}
/** 「同一句話」的鍵：逐字核對過的引文，沒有就用理由（AI 摘句沒核對、可能是「無」，不拿來當鍵）；都沒有回 null（不判持續） */
const quoteKeyOf = (code, entry) => {
  const t = entry.vq ?? entry.r;
  return t ? `${code}:${quoteHash(t)}` : null;
};

export function initialMajorBearState() {
  return { t: null, sent: {}, q: {} };
}

/** localStorage 讀回：形狀不對的欄位一律丟掉（不信任本機資料） */
export function parseMajorBearState(raw) {
  if (!isObj(raw)) return initialMajorBearState();
  const sent = {};
  if (isObj(raw.sent)) {
    for (const [code, x] of Object.entries(raw.sent)) {
      if (!CODE_RE.test(code) || !isObj(x) || !isNum(x.at) || !isNum(x.rank) || !isNum(x.seq) || x.seq < 1) continue;
      sent[code] = { at: x.at, rank: x.rank, seq: Math.floor(x.seq), cont: x.cont === true };
    }
  }
  const q = {};
  if (isObj(raw.q)) for (const [k, d] of Object.entries(raw.q)) if (k.length <= 40 && ymdOf(d)) q[k] = d;
  return { t: ymdOf(raw.t), sent, q };
}

function pruneQ(q, targetDate) {
  const limit = Date.parse(`${targetDate}T00:00:00Z`) - NEWS_REPEAT_KEEP_DAYS * DAY_MS;
  const out = {};
  for (const [k, d] of Object.entries(q ?? {})) if (Date.parse(`${d}T00:00:00Z`) >= limit) out[k] = d;
  return out;
}

/**
 * 推進一步（每次判別表或持股變動時）。cands：[{ code, entry, mb }]（mb＝majorBearOf 非 null 的持股）。
 * 規則（news-weight.md §3.6）：
 *   · 同一適用日每檔只發一次；判讀時間較新「且」警示等級上升（二級→一級，例：新出現法律覆寫）才再發（seq+1，新 id）。
 *     強弱（權重）升級不再發（§6.5）。
 *   · 同一關鍵句在前一個適用日已判過利空 ⇒ 降二級「持續」（法律事件方向不變，但只有新進展才重新觸發，§5.4）。
 *   · 換適用日：當日記錄清空；關鍵句記錄保留 NEWS_REPEAT_KEEP_DAYS 天（只記第一次判到的日子）。
 * 回 { state, items:[{ code, level, seq, cont, mb, entry }], changed }——items 每次都回（同 id 重送由 events.ts 去重；
 * 重新整理後已發未收到的會重新掛回，已收到的由本機收到記錄過濾）。
 */
export function stepMajorBear(prev, cands, { targetDate }) {
  const t = ymdOf(targetDate);
  if (!t) return { state: prev ?? initialMajorBearState(), items: [], changed: false };
  let s = prev && prev.t === t ? prev : { t, sent: {}, q: pruneQ(prev?.q, t) };
  let changed = s !== prev;
  const items = [];
  for (const c of cands ?? []) {
    if (!c || !CODE_RE.test(c.code) || !isObj(c.entry) || !c.mb || !isNum(c.entry.at)) continue;
    const rank = alertRank(c.mb);
    const qk = quoteKeyOf(c.code, c.entry);
    let sent = s.sent[c.code];
    if (!sent) {
      const firstDay = qk ? s.q[qk] : undefined;
      const cont = !!firstDay && firstDay < t;
      sent = { at: c.entry.at, rank, seq: 1, cont };
      s = { ...s, sent: { ...s.sent, [c.code]: sent }, q: firstDay || !qk ? s.q : { ...s.q, [qk]: t } };
      changed = true;
    } else if (c.entry.at > sent.at && rank > sent.rank) {
      sent = { at: c.entry.at, rank, seq: sent.seq + 1, cont: false };
      s = { ...s, sent: { ...s.sent, [c.code]: sent }, q: !qk || s.q[qk] ? s.q : { ...s.q, [qk]: t } };
      changed = true;
    }
    items.push({ code: c.code, level: sent.cont ? 2 : c.mb.level, seq: sent.seq, cont: sent.cont, mb: c.mb, entry: c.entry });
  }
  return { state: s, items, changed };
}

/** Z2／B2 事件文案（只寫事實；不寫指令句、不寫個人成本；不寫影響權重 w——它不是 Z2 的條件） */
export function majorBearText(code, name, item) {
  const who = `${code} ${name ?? ''}`.trim();
  const e = item.entry;
  const when = judgedText(e);
  const quotes = isNum(e.qv) && e.qv > 0 ? `·引文 ${e.qv} 條已核對` : '';
  const cls = item.mb?.cls ?? entryRuleClass(e);
  const what = (cls && ruleClassText(cls)) || '規則類利空';
  if (item.cont) {
    return `${who} 利空持續（同一關鍵句前一適用日已判利空）·${what}·${when}`;
  }
  const head = item.mb.scope === 'watch' ? '自選' : '持股';
  const cw = cls ? classWeightOf(cls, e.rs ?? null) : null;
  const cwText = cw ? `·類別權重 ${cw.weight.toFixed(2)}（先驗·未回測）` : '';
  const ai = e.ra ? `·AI 原判${e.ra}` : '';
  const lv = item.level === 1 ? '' : item.mb.scope === 'watch' ? '·自選只列二級' : '·類別權重未達一級切點，列二級';
  return `${who} ${head} 規則判定利空·${what}·AI 讀內文確認主體與事實${cwText}${ai}${lv}·${when}${quotes}`;
}

/**
 * stepMajorBear 的 items → 戰情事件輸入（events.ts WarEventInput）。
 * 一級：kind 'majorNegative'、id `majorNegative:${適用日}:${代號}:${seq}`；二級（持續、類別權重 0.3–0.7、自選）：kind 'newsVerdict'。
 */
export function majorBearEvents(items, names, targetDate) {
  const out = [];
  for (const it of items ?? []) {
    const at = it.entry?.at;
    if (!isNum(at)) continue;
    const name = names && typeof names.get === 'function' ? names.get(it.code) : undefined;
    const text = majorBearText(it.code, name, it);
    if (it.level === 1) {
      out.push({ id: `majorNegative:${targetDate}:${it.code}:${it.seq}`, at, kind: 'majorNegative', level: 1, code: it.code, mine: true, source: 'M', side: 'short', text });
    } else {
      out.push({ id: `newsBear:${targetDate}:${it.code}:${it.seq}${it.cont ? 'c' : ''}`, at, kind: 'newsVerdict', level: 2, code: it.code, mine: true, source: 'M', side: 'short', text });
    }
  }
  return out;
}

// ── B2 新聞事件 ─────────────────────────────────────────────────────────────

const evId = (code, at) => `s:newsVerdict:${code}:${at}`;

function dirEventText(entry, ctx) {
  if (entry.st === 'neutral') return '判中性·AI 已讀內文';
  const cls = entry.st === 'bear' ? entryRuleClass(entry) : null;
  if (cls) return `利空·${ruleClassText(cls)}·規則判定·AI 已讀內文確認事實${entry.ra ? `（AI 原判${entry.ra}）` : ''}`;
  return `${newsShortText(entry, ctx)}${entry.pl ? '·可能為法律事件（未經規則確認）' : ''}·AI 已讀內文`;
}

/**
 * B2 全市場（伺服器端；所有人同一份）：今日盤中趟（pass=intraday）新出現的 AI 讀內文利多／利空。
 * 不用權重篩選（§6.5：未校準權重不決定名單）；盤前各趟不發 B2（在 A1 燈與 A2 盤前清單）。
 * todayYmd＝伺服器的台北今日；判別表適用日不是今日就不發。
 */
export function b2MarketNewsEvents(board, { todayYmd, cap = 15 } = {}) {
  if (!isObj(board) || !isObj(board.map) || board.meta?.targetDate !== todayYmd) return [];
  const ctx = { fresh: 'today', targetDate: todayYmd, applicableYmd: todayYmd };
  const out = [];
  for (const [code, e] of Object.entries(board.map)) {
    if (e.p !== 'intraday' || (e.st !== 'bull' && e.st !== 'bear') || e.cr || !isNum(e.at)) continue;
    out.push({ id: evId(code, e.at), at: e.at, kind: 'newsVerdict', code, name: code, text: dirEventText(e, ctx), source: 'M', side: e.st === 'bull' ? 'long' : 'short' });
  }
  out.sort((a, b) => b.at - a.at || a.code.localeCompare(b.code));
  return out.slice(0, cap);
}

/** 判別表裡今日適用、AI 讀過內文（利多／利空／中性）的代號——B2 重訊「今日有動靜」用 */
export function activeNewsCodes(board, todayYmd) {
  if (!isObj(board) || !isObj(board.map) || board.meta?.targetDate !== todayYmd) return [];
  return Object.entries(board.map).filter(([, e]) => !e.cr && (e.st === 'bull' || e.st === 'bear' || e.st === 'neutral')).map(([c]) => c);
}

/**
 * B2「我的」（前端；只用使用者自己的持股／自選／釘選過濾同一份表，網址不帶個人參數）——全部二級：
 *   · 盤中趟的 AI 讀內文判別（含中性，灰色「判中性」）；
 *   · 持股、自選、釘選的盤前各趟利空——不看權重全列（§6.5：未校準權重不決定名單，也不影響註記）。
 * 持股符合重大利空條件的（規則類別、類別權重 ≥0.3）由 Z2 引擎發（majorBearEvents），這裡略過避免重複。
 * 只列今日適用、非承接、走過挑戰的判別（isCurrentEntry；沒走挑戰的可能是 14 日舊聞回退）。
 */
export function mineNewsEvents(board, { holdings, watch, pinned, ctx, minAtMs = null, nowMs }) {
  if (!isObj(board) || !isObj(board.map) || ctx?.fresh !== 'today') return [];
  const has = (set, c) => !!set && typeof set.has === 'function' && set.has(c);
  const pool = new Set([...(holdings ?? []), ...(watch ?? []), ...(pinned ?? [])]);
  const out = [];
  for (const code of pool) {
    const e = board.map[code];
    if (!isObj(e) || !isCurrentEntry(e, ctx) || !isNum(e.at)) continue;
    if (e.st !== 'bull' && e.st !== 'bear' && e.st !== 'neutral') continue;
    const isH = has(holdings, code);
    if (isH && majorBearOf(e, { scope: 'holding', ctx, minAtMs })) continue;
    const isW = !isH && has(watch, code);
    const intraday = e.p === 'intraday';
    const premarketBear = !intraday && e.st === 'bear';
    if (!intraday && !premarketBear) continue;
    // 「達一級條件」只是文字註記（自選只列二級）；不決定列不列
    const watchMb = isW && e.st === 'bear' ? majorBearOf(e, { scope: 'watch', ctx, minAtMs }) : null;
    let suffix = '';
    if (watchMb?.band === 'high') suffix = '（自選·達一級條件，自選只列二級）';
    else if (premarketBear) suffix = isH ? '（持股）' : isW ? '（自選）' : '（釘選）';
    out.push({
      id: evId(code, e.at), at: e.at, kind: 'newsVerdict', code, name: code,
      text: `${dirEventText(e, ctx)}${suffix}${newsTimeTag(e.at, nowMs)}`,
      source: 'M', ...(e.st === 'bull' ? { side: 'long' } : e.st === 'bear' ? { side: 'short' } : {}),
    });
  }
  return out.sort((a, b) => b.at - a.at || a.code.localeCompare(b.code));
}

// ── A2 盤前新聞判別（只列我的池） ──────────────────────────────────────────

/**
 * 盤前清單：持股＋自選中，盤後／夜補／晨間趟判出的判別（前一交易日盤中趟判出、被承接到今日表的也列，落在「非今日適用」）。
 * 排序（只用類別＋時間，不用權重——§0／§6.5 權重不當排序鍵，也不決定誰排進前幾檔）：規則類利空 → 利空 → 利多 → 中性 → 關注度
 * → 非今日適用（承接、前一交易日、沒走挑戰）；同類新到舊。cat：0 規則類利空、2 利空、3 利多、4 中性、5 關注度、7 非今日適用。
 * mb 只給燈號標一級用。missing＝未判別／資訊不足／價格描述；na＝不在個股新聞識讀範圍（ETF 等）。
 */
export function premarketNewsRows(board, { holdings, watch, ctx, minAtMs = null }) {
  const hold = new Set(holdings ?? []);
  const seen = new Set();
  const rows = [];
  const missing = [];
  const na = [];
  const map = isObj(board) && isObj(board.map) ? board.map : {};
  for (const code of [...(holdings ?? []), ...(watch ?? [])]) {
    if (seen.has(code)) continue;
    seen.add(code);
    if (!isNewsUniverse(code)) { na.push(code); continue; }
    const e = map[code];
    if (!isObj(e) || e.st === 'insufficient' || e.st === 'unjudged' || e.st === 'excluded') { missing.push(code); continue; }
    if (e.p === 'intraday' && !e.cr) continue;   // 今日盤中趟判出的不屬盤前清單（在 B2）；承接的照列（◆）
    const current = isCurrentEntry(e, ctx);
    const mb = e.st === 'bear' ? majorBearOf(e, { scope: hold.has(code) ? 'holding' : 'watch', ctx, minAtMs }) : null;
    let cat;
    if (!current) cat = 7;
    else if (e.st === 'bear' && entryRuleClass(e)) cat = 0;
    else if (e.st === 'bear') cat = 2;
    else if (e.st === 'bull') cat = 3;
    else if (e.st === 'neutral') cat = 4;
    else cat = 5;   // 關注度
    rows.push({ code, entry: e, cat, mb, holding: hold.has(code) });
  }
  rows.sort((a, b) => a.cat - b.cat || (b.entry.at ?? 0) - (a.entry.at ?? 0) || a.code.localeCompare(b.code));
  return { rows, missing, na };
}

// ── 資料健康（不拿 updatedAt 套過期門檻：盤中趟沒有新消息時不寫入） ────────

/**
 * 新聞判別的健康列：state ok（●）｜bad（▲：判別表不是今日適用＝daemon 盤後或晨間沒跑、或讀不到）。text 不含符號（呼叫端畫）。
 * ⚠ 只看適用日；判別表 updatedAt 舊不代表故障（盤中趟每 25 分掃描，無新消息不寫入）。daemon 是否活著看心跳列。
 */
export function newsHealthOf(meta, ctx) {
  if (!isObj(meta)) return { state: 'bad', glyph: '▲', text: '無資料', note: '判別表讀不到' };
  const pass = meta.lastPass ? PASS_LABEL[meta.lastPass] : '—';
  const at = meta.updatedAt != null ? `${ymdShort(taipeiYmd(meta.updatedAt))} ${tpeHhmm(meta.updatedAt)}` : '—';
  const cov = `涵蓋 ${meta.covered} 檔（判別範圍未擴大，沒涵蓋的顯示「未判別」）`;
  if (ctx?.fresh === 'today') {
    return { state: 'ok', glyph: '●', text: `${at}（${pass}）`, note: `適用 ${ymdShort(ctx.targetDate)}·${cov}·盤中每 25 分掃描，無新消息不寫入` };
  }
  if (ctx?.fresh === 'next') {
    return { state: 'ok', glyph: '●', text: `${at}（${pass}）`, note: `已是下一交易日 ${ymdShort(ctx.targetDate)} 的判別·${cov}` };
  }
  if (ctx?.fresh === 'prev') {
    return { state: 'bad', glyph: '▲', text: `前交易日 ${ymdShort(ctx.targetDate)} 判別`, note: 'daemon 盤後或晨間判別尚未更新：燈照常顯示（◆），不列強弱、不發警示' };
  }
  return { state: 'bad', glyph: '▲', text: '適用日不明', note: '判別表缺適用交易日' };
}
