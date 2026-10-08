// ─────────────────────────────────────────────────────────────────────────────
// 年報原文核對（使用者 2026-10-08 J4-4「ok並強制不可有幻覺」）——純函式、無 I/O
//
// 年報層（wiki 用本機模型從年報節錄萃取的輪廓）只留「原文找得到、關係原文寫得出來」的項目：
//   textUsable(T, anchors)         節錄 0 字、過短、錨點沒命中實質小節 ⇒ 整份不用
//   isGarbledName(name)            含 <0xHH> 位元組字面、U+FFFD ⇒ 亂碼名不用（讀取端不還原，J4 設計 R2）
//   isPlaceholderCounterparty      甲客戶／A公司／客戶1／AE001／其他客戶 ⇒ 代號名不用
//   groundName(name, T)            名稱在原文（逐字或「不改指涉」的正規化）找不到 ⇒ 不用
//   counterpartyEvidence(...)      客戶／供應商要原文寫明是交易關係、角色和欄位相符（proven）才用
// 正規化只做不改指涉的轉換：空白、NFKC、大小寫、標點、台→臺、公司型態後綴、少量異體字、地名別名、組合名逐段。
// 不做同義詞、簡稱還原、翻譯、子序列猜測——一律視為找不到。
// 參考實作：J4 批次 annual-grounding.ref.mjs（scratchpad）；角色判定依定稿 §4.2 O9 改寫（取代 counterpartyRole）。
// 寫入端（wiki）日後要 import 同一份，不另寫（J4 設計 §1.1）。
// ─────────────────────────────────────────────────────────────────────────────

/** 規則版本：改任何判定或詞表都要升版，讀取端的剔除統計依此分段 */
export const GROUND_VER = 'ag-2026-10-09.1';

/** 節錄門檻：實測非 0 最短 3,093 字且全數可核對，1～3,000 字 0 份；800 只擋 0 字與「只有標題」的節錄 */
export const MIN_TEXT_CHARS = 800;
/** 錨點至少命中一個實質小節（wiki annual-report.mjs 的 ANCHORS 鍵） */
export const REQUIRED_ANCHORS = Object.freeze(['products', 'materials', 'counterparties', 'chain']);

const BYTE_RUN = /(?:<0x[0-9A-Fa-f]{2}>)+/g;
const decodeRun = (run) => Buffer.from(run.match(/[0-9A-Fa-f]{2}(?=>)/g).map(h => parseInt(h, 16))).toString('utf8');
/** Ollama 位元組後備漏成字面「<0xEF><0xA7><0xA3>」→ 還原（只給原文用；實體名一律當亂碼） */
export const decodeByteLiterals = (s) => String(s ?? '').replace(BYTE_RUN, decodeRun);
/** 亂碼名：含位元組字面（含被截斷的「<0x」尾巴）或 U+FFFD */
export const isGarbledName = (s) => /<0x|\uFFFD/i.test(String(s ?? ''));

// 少量異體／簡體：只收實測遇到、一對一不改指涉者（PDF 字型把「市」抽成 U+5DFF「巿」見於 24 份節錄）
const VARIANT = { 巿: '市', 炖: '燉', 统: '統', 国: '國', 电: '電', 业: '業', 发: '發', 应: '應', 开: '開', 营: '營', 贸: '貿', 为: '為', 长: '長', 网: '網', 达: '達', 台: '臺' };
const PUNCT_CHARS = '()[]{}【】「」『』〔〕《》〈〉.,，、。:：;；\'"`’‘“”·•・-–—_/／\\&+*~!?！？%％';
const PUNCT_SET = new Set(PUNCT_CHARS);
const PUNCT_CODE = new Uint8Array(65536); for (const c of PUNCT_CHARS) PUNCT_CODE[c.charCodeAt(0)] = 1;
const PUNCT_RE = new RegExp(`[${PUNCT_CHARS.replace(/[\]\\^-]/g, '\\$&')}]`, 'g');
const VARIANT_RE = new RegExp(`[${Object.keys(VARIANT).join('')}]`, 'g');

const nfkc = (s) => decodeByteLiterals(s).normalize('NFKC');
/** 逐字層：去空白＋NFKC（PDFKit 抽出的相容表意字，115／334 份節錄有） */
export const normExact = (s) => nfkc(s).replace(/\s+/g, '');
/** 正規化層：再加大小寫、標點、異體 */
export const normLoose = (s) => normExact(s).toLowerCase().replace(VARIANT_RE, c => VARIANT[c]).replace(PUNCT_RE, '');

// 公司型態後綴：只去掉「確實是獨立後綴」者——英文要有空白／標點隔開（參考實作在去標點後才剝，會把 SEMCO 剝成 sem）
const LEGAL_ZH = /(?:股份有限公司|有限公司|\(股\)公司|\(股\)|股公司|公司)$/;
const LEGAL_EN = /[\s,.]+(?:co\.?,?\s*ltd|co|ltd|limited|inc|incorporated|corp|corporation|company|pte\.?\s*ltd|pte|pty|gmbh|llc|plc|s\.?a|ag|b\.?v|k\.?k|sdn\.?\s*bhd|bhd|lp)\.?$/i;
/** 去公司型態後綴後的正規化形；剝不動或剩不到 2 字回 null */
function legalStem(name) {
  let x = nfkc(name).replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) { const y = x.replace(LEGAL_EN, '').trim(); if (y === x) break; x = y; }
  const s = normLoose(x.replace(/\s+/g, '').replace(LEGAL_ZH, ''));
  return s.length >= 2 && s !== normLoose(name) ? s : null;
}
// wiki sanitizeProfile 會把「大陸／中國大陸」改寫成「中國」：核對時反查原文寫法
const PLACE_SOURCES = { 中國: ['中國', '大陸', '中國大陸', '內地'], 韓國: ['韓國', '南韓'], 臺灣: ['臺灣'], 香港: ['香港'] };

/**
 * 年報節錄 → 比對索引（每份只做一次）。loose 逐字由 exact 轉出，looseMap[j]＝loose 第 j 字在 exact 的位置。
 * @param {string} raw
 */
export function prepareText(raw) {
  const r = String(raw ?? '');
  const nonWs = r.replace(/\s+/g, '').length;
  const exact = normExact(r);
  const lower = exact.toLowerCase();
  if (lower.length === exact.length) {
    // 常見情形：小寫化不改長度 ⇒ 逐 UTF-16 單位對齊（標點、異體字都在 BMP；全部 3 MB 節錄約 80ms）
    const loose = lower.replace(VARIANT_RE, c => VARIANT[c]).replace(PUNCT_RE, '');
    const looseMap = new Int32Array(loose.length); let j = 0;
    for (let i = 0; i < lower.length; i++) if (!PUNCT_CODE[lower.charCodeAt(i)]) looseMap[j++] = i;
    return { nonWs, exact, loose, looseMap };
  }
  const parts = []; const looseMap = [];
  for (let i = 0; i < exact.length; i++) {
    const cp = exact.codePointAt(i); const ch = String.fromCodePoint(cp);
    let c = ch.toLowerCase(); c = VARIANT[c] || c;
    if (!PUNCT_SET.has(c)) { parts.push(c); for (let k = 0; k < c.length; k++) looseMap.push(i); }
    if (cp > 0xffff) i++;
  }
  return { nonWs, exact, loose: parts.join(''), looseMap };
}

/**
 * 這份節錄可以當核對原文嗎（J4 I1／R7 之外的輸入門檻）
 * @returns {{ ok: true } | { ok: false, reason: 'text-empty'|'text-short'|'no-anchor' }}
 */
export function textUsable(T, anchors = []) {
  if (!T || !T.nonWs) return { ok: false, reason: 'text-empty' };
  if (T.nonWs < MIN_TEXT_CHARS) return { ok: false, reason: 'text-short' };
  if (!(Array.isArray(anchors) ? anchors : []).some(a => REQUIRED_ANCHORS.includes(a))) return { ok: false, reason: 'no-anchor' };
  return { ok: true };
}

/**
 * 實體名稱是否在原文出現（亂碼名先擋：讀取端不還原）
 * @returns {{ ok: boolean, tier: 'exact'|'loose'|'none'|'garbled' }}
 */
export function groundName(name, T) {
  if (isGarbledName(name)) return { ok: false, tier: 'garbled' };
  if (!T || !T.exact) return { ok: false, tier: 'none' };
  const ne = normExact(name); if (!ne) return { ok: false, tier: 'none' };
  if (T.exact.includes(ne)) return { ok: true, tier: 'exact' };
  const nl = normLoose(name);
  const cands = [nl, legalStem(name), ...(PLACE_SOURCES[ne] || []).map(normLoose)].filter(Boolean);
  if (cands.some(c => T.loose.includes(c))) return { ok: true, tier: 'loose' };
  // 組合名（「A、B」）：每一段都要找得到
  const parts = ne.split(/[、／/,，及與和&＋+]/).map(normLoose).filter(p => p.length >= 2);
  if (parts.length >= 2 && parts.every(p => T.loose.includes(p))) return { ok: true, tier: 'loose' };
  return { ok: false, tier: 'none' };
}

/** 交易對手代號名：年報以甲乙／A B／客戶1 代稱者（萃取提示詞已禁止，實測仍有 459 項、140 檔）；HP、LG 這類真實兩字母公司不擋 */
//   2026-10-08 讀取端實測再補：客戶名稱A、客戶-A(輪胎)、集團A客戶、FD-001、第一大銷貨客戶、HY廠商，以及「國際廠商」「車規客戶」這類以客戶／廠商／供應商／業者收尾的泛稱
//   2026-10-09 反證審查再補（ag-2026-10-09.1）：純數字（210594、293、1000221）、字母＋數字（S08、A01、BAA001、KM1035、C100014、D00619，可帶「(註)」）、
//   字母代號＋商（R商、L-H商）、「其他(註)」——年報進銷貨表註明「得以代號為之」的寫法；3M、HP、LG、ABB 這類真實名稱不擋
export const PLACEHOLDER = /^(?:[A-Z]|[A-Z](?:公司|客戶|廠商|供應商|集團)|[甲乙丙丁戊己庚辛壬癸](?:公司|客戶|廠商|供應商|集團)?|(?:客戶|廠商|供應商|公司)(?:名稱)?[-－]?[A-Z甲乙丙丁戊己庚辛壬癸0-9]{0,2}(?:\(.{0,8}\))?|集團[A-Z甲乙丙丁]客戶|(?:\d+|[A-Z]{1,4}-?\d{2,8})(?:\(.{0,8}\))?|[A-Z](?:-[A-Z])?商|第[一二三四五六七八九十0-9]{1,2}大(?:銷貨|進貨)?(?:客戶|供應商|廠商)|.{0,40}(?:客戶|廠商|供應商|業者)|其[他它](?:客戶|供應商|廠商)?(?:\(.{0,8}\))?|未揭露|未明列|未提及)$/;
export const isPlaceholderCounterparty = (name) => PLACEHOLDER.test(normExact(name));

/** 年報以 1～3 個大寫字母代稱交易對手（1449「AU公司、BC公司…」代號表）：名稱只以「X公司」出現，且同份節錄有 ≥5 個這種代號 */
export function codedAliasInText(name, T) {
  const n = normExact(name);
  if (!/^[A-Z]{1,3}$/.test(n) || !T?.exact) return false;
  if (!T.exact.includes(`${n}公司`)) return false;
  return new Set(T.exact.match(/(?<![A-Za-z])[A-Z]{1,3}(?=公司)/g) || []).size >= 5;
}

// ── 客戶／供應商關係核對（J4 定稿 O9：名稱在、關係不在，也是幻覺）──────────────────
// 每一次出現逐一判（名稱嵌在較長的已知名稱裡不算出現）：
//   ① 同一句（只以「。」斷句，分號常是名單分組）前 80 字最近的敘述標記：供應／銷售／產業列舉、競爭、金融往來
//   ② 名稱後同一子句的動詞（重要契約表的「銷售合約」、「向X購買」「由X供應」）
//   ③ 只有關係企業字樣（子公司、轉投資…）⇒ 不算交易對手
//   ①② 得到供應或銷售、但落在產業上中下游段落且句中沒有本公司當主詞 ⇒ 產業列舉
//   ④ 都沒有：前 600 字最近的進／銷貨表頭，或前 400 字的非交易段落標題（上中下游、重要契約、資安）；再沒有＝不明
//   2026-10-09 反證審查（ag-2026-10-09.1）：「供應加工絲原料之廠商有X」是本檔原料的供應廠商、不是產業列舉（1447 宏州、中纖）；
//   「售予／售與X」算銷售敘述（1513 台電公司）；名稱後的「供電／供水／供氣／供需」不是供應動詞（「捷運供電系統工程」）
const SUP_TABLE = /(?:[占佔]全年度?進貨|[占佔]當年度截至.{0,8}進貨|進貨總額|進貨淨額|進貨廠商|進貨供應商|供應商名單|主要供應商資料|主要原(?:物)?料之?供應(?:狀況|情形|情況)|原料之供應|主要來源供應情形|供應來源|[0-9一二][.、．]進貨[(（:：])/g;
const CUS_TABLE = /(?:[占佔]全年度?銷貨|[占佔]當年度截至.{0,8}銷貨|銷貨總額|銷貨淨額|(?<!進)銷貨客戶|主要客戶名單|主要客戶資料|[0-9一二][.、．]銷貨[(（:：])/g;
const NONTX_SECTION = /(?:上、?中、?下游之?的?關聯|上中下游|產業上下游|產業關聯圖|重要契約|資通安全|資安)/g;
const SUP_PROSE = /(?:主要供應商|供應來源|供應廠商(?:有|為|包括|如)?|供應[^。，,；;：:]{0,12}之廠商(?:有|為|包括|如)?|供應廠為|供應商為|其供應商|供應商有|供應商包括|供應商係|購自|採購自|係向|主要向|均向|亦向|定期向|固定向|代理)/g;
const CUS_PROSE = /(?:主要客戶|銷售對象|銷貨地點|銷售客戶|客戶為|客戶有|客戶包括|客戶如|銷售予|銷貨予|銷售給|出貨給|出貨予|供應給|供應予|供貨給|供貨予|交貨給|售予|售與)/g;
// 產業列舉／競爭描述／金融往來（「供應廠商有」「進貨廠商為」是本檔的交易對手，不算）
const NONTX_PROSE = /(?:主要廠商(?:為|有|包括)|(?:業者|(?<!供應|進貨|供應[^。，,；;：:]{0,12}之)廠商|廠家|鋼廠)則?(?:有|為|包括|如)|生產廠家|產業為|市場[^。]{0,8}?主要仍?由|主要仍由|競爭|佔了|往來銀行|授信|聯貸|策略聯盟)/g;
// 關係企業字樣（「※合併公司1、磐亞公司」章節標頭、「轉投資公司X」）：同句另有供應／銷售敘述或名稱後的動詞就照它，否則不算交易對手
const AFFIL_PROSE = /(?:合併公司|子公司|轉投資|被投資公司)/g;
const POST_CUS = /^.{0,20}?(?:向本(?:公司|集團)|(?:購買|採購|訂購)本(?:公司|集團))/;
const POST_SUP = /(?:供料|購買|採購|購入|進貨)/;
const POST_NONTX = /(?:業者|搶占|搶佔|主導|市占|市場佔有|生產廠)/;
const POST_SUP_WEAK = /供應(?!商)|供貨|供(?![應貨料商電水氣需])/;
// 重要契約表「買賣 X(股)公司 115/01/01~115/12/31 銷售合約」＝本檔賣給 X（1725 實例）；採購／供料合約＝向 X 買。只認表格列（名稱後直接接日期）
const CONTRACT_ROW = /^(?:\(股\))?(?:股份有限)?(?:公司)?[0-9/~.\-年月日至起迄]{6,30}((?:銷售|銷貨|出售)|(?:採購|進貨|購料|購買|供料|供應|原料))合約/;
// 產業上中下游段落裡的「主要供應商包括…」多半是產業列舉（2302 嘉晶），句中沒有本公司當主詞就不算本檔的交易對手
const CHAIN_SECTION = /(?:上、?中、?下游之?的?關聯|上中下游|產業上下游|產業關聯圖)/g;
const SELF_SUBJECT = /(?:本公司|本集團|本廠|我司|我們|本行|本企業)/;
const NEAR = 80; const TABLE_WIN = 600; const SECTION_WIN = 400; const POST_WIN = 30; const CONTRACT_WIN = 48; const SENTENCE_WIN = 300;
/** 名稱嵌在較長的已知名稱裡（「東南亞」裡的「南亞」、「中鋼構」裡的「中鋼」）不算出現 */
export const EXTENSION_WORDS = Object.freeze(['東南亞', '南亞洲', '東南亞洲', '中南美']);

function lastMarker(re, s) { let m; let end = -1; re.lastIndex = 0; while ((m = re.exec(s))) end = m.index + m[0].length; return end < 0 ? Infinity : s.length - end; }
function nearestOf(pairs) { let best = null; for (const [role, d] of pairs) if (d !== Infinity && (!best || d < best[1])) best = [role, d]; return best?.[0] ?? null; }

/** 敘述句落在產業上中下游段落、比任何進銷貨表頭都近，且句中沒有本公司當主詞 ⇒ 產業列舉 */
function industryFramed(t, e) {
  const sentence = t.slice(Math.max(0, e - SENTENCE_WIN), e);
  if (SELF_SUBJECT.test(sentence.slice(sentence.lastIndexOf('。') + 1))) return false;
  const sect = t.slice(Math.max(0, e - SECTION_WIN), e);
  const dChain = lastMarker(CHAIN_SECTION, sect);
  return dChain !== Infinity && dChain < Math.min(lastMarker(SUP_TABLE, sect), lastMarker(CUS_TABLE, sect));
}

/** 名稱後同一子句的動詞（分號、逗號、冒號、括號都斷句） */
function postRole(t, f) {
  const row = CONTRACT_ROW.exec(t.slice(f, f + CONTRACT_WIN));
  if (row) return /銷售|銷貨|出售/.test(row[1]) ? 'customer' : 'supplier';
  const post = t.slice(f, f + POST_WIN).split(/[。;；:：,，(（]/)[0];
  if (POST_CUS.test(post)) return 'customer';
  if (POST_SUP.test(post)) return 'supplier';
  if (POST_NONTX.test(post)) return 'nontx';
  if (POST_SUP_WEAK.test(post)) return 'supplier';
  return null;
}

/** 敘述與名稱後動詞給的角色（表頭以外）；沒有回 null */
function proseRole(t, e, f) {
  const near = t.slice(Math.max(0, e - NEAR), e); const clause = near.slice(near.lastIndexOf('。') + 1);
  const prose = nearestOf([['nontx', lastMarker(NONTX_PROSE, clause)], ['supplier', lastMarker(SUP_PROSE, clause)], ['customer', lastMarker(CUS_PROSE, clause)], ['supplier', /向$/.test(clause) ? 0 : Infinity]]);
  if (prose) return prose;
  const post = postRole(t, f);
  if (post) return post;
  return affiliationOnly(clause) ? 'nontx' : null;
}

/** 句中有關係企業字樣、而且不是表格裡上一列的「與發行人之關係」欄（字樣前緊接金額／比率，或字樣與名稱之間還有數字） */
function affiliationOnly(clause) {
  let m; let last = null; AFFIL_PROSE.lastIndex = 0;
  while ((m = AFFIL_PROSE.exec(clause))) last = m;
  if (!last) return false;
  const before = clause.slice(Math.max(0, last.index - 12), last.index);
  const after = clause.slice(last.index + last[0].length).replace(/^\d{1,2}[、.．]/, '');
  return !/\d/.test(after) && !/\d[\d,.]*%?[^\d]{0,8}$/.test(before);
}

/** 單一次出現的角色：'supplier'|'customer'|'nontx'|'unknown'（位置 e..f 在 T.exact） */
function occurrenceRole(t, e, f) {
  const prose = proseRole(t, e, f);
  if (prose) return prose !== 'nontx' && industryFramed(t, e) ? 'nontx' : prose;
  const wide = t.slice(Math.max(0, e - TABLE_WIN), e); const sect = t.slice(Math.max(0, e - SECTION_WIN), e);
  return nearestOf([['supplier', lastMarker(SUP_TABLE, wide)], ['customer', lastMarker(CUS_TABLE, wide)], ['nontx', lastMarker(NONTX_SECTION, sect)]]) || 'unknown';
}

/** 已知名稱（上市櫃簡稱等）→ 延伸防呆用的正規化清單（每批只做一次；含 EXTENSION_WORDS） */
export function prepareKnownNames(names = []) {
  return Object.freeze([...new Set([...EXTENSION_WORDS, ...names].map(normLoose).filter(k => k.length >= 2))]);
}
const DEFAULT_KNOWN = prepareKnownNames();
const LONGER_MEMO = new WeakMap();
function longerOf(n, known) {
  let memo = LONGER_MEMO.get(known); if (!memo) LONGER_MEMO.set(known, (memo = new Map()));
  if (!memo.has(n)) memo.set(n, known.filter(k => k.length > n.length && k.includes(n)));
  return memo.get(n);
}
function coveredByLonger(loose, j, n, longer) {
  for (const L of longer) for (let k = L.indexOf(n); k >= 0; k = L.indexOf(n, k + 1)) if (j - k >= 0 && loose.startsWith(L, j - k)) return true;
  return false;
}

/**
 * 年報客戶／供應商的關係證據。
 * @param {string} name
 * @param {ReturnType<typeof prepareText>} T
 * @param {'customers'|'suppliers'} field
 * @param {{ known?: readonly string[] }} [opts]  prepareKnownNames() 的結果（延伸防呆；缺省只防地名）
 * @returns {{ verdict: 'proven'|'opposite'|'non-transaction'|'unknown'|'both', roles: string[] }}
 *   proven＝至少一處寫明是本欄角色、且沒有一處寫成相反角色；其餘一律不可當交易對手（O9）
 */
export function counterpartyEvidence(name, T, field, { known = DEFAULT_KNOWN } = {}) {
  const roles = [];
  if (!T?.exact || isGarbledName(name)) return { verdict: 'unknown', roles };
  const forms = [...new Set([normLoose(name), legalStem(name)])].filter(x => x && x.length >= 2);
  const longer = forms.map(f => longerOf(f, known));
  const seen = new Set();
  forms.forEach((n, fi) => {
    for (let j = T.loose.indexOf(n); j >= 0; j = T.loose.indexOf(n, j + 1)) {
      const e = T.looseMap[j]; if (seen.has(e)) continue; seen.add(e);
      if (coveredByLonger(T.loose, j, n, longer[fi])) continue;
      roles.push(occurrenceRole(T.exact, e, T.looseMap[j + n.length - 1] + 1));
    }
  });
  const want = field === 'suppliers' ? 'supplier' : 'customer'; const opp = want === 'supplier' ? 'customer' : 'supplier';
  const has = (r) => roles.includes(r);
  const verdict = has(want) && has(opp) ? 'both' : has(want) ? 'proven' : has(opp) ? 'opposite' : has('nontx') ? 'non-transaction' : 'unknown';
  return { verdict, roles };
}
