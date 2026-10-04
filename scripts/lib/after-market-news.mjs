// ─────────────────────────────────────────────────────────────────────────────
// 盤後報告「當晚新聞與分析消息」的影響比重排序（純函式，顯示用）
//
//   ⚠ 這是「顯示排序」，不是分數：權重全是先驗（tw-news-impact-analyst §0：沒有一個經過量測），
//     不進任何模型、不動任何分數、不當交易訊號；輸出欄位刻意叫 weight／share，不叫 score／signal。
//   ⚠ O（官方重大訊息）與 M（媒體判別）兩條管線**分開排、分開算占比，不可加總**（§2）。
//   ⚠ 方向：M 用 daemon 的 AI「讀完內文」判別結果（label）；O 只有 §4.1 標「規則」的類型才給方向，其餘「需讀內文」。
//   ⚠ 官方類型只靠公告主旨比對（未讀內文）→ 明標 basis:'主旨'，比對不到記「未分類」，不猜。
// ─────────────────────────────────────────────────────────────────────────────

const STRENGTH = { 極強: 1.0, 強: 0.75, 中: 0.45, 弱: 0.2 };
const CONFIDENCE = { 高: 1.0, 中: 0.7, 低: 0.4 };
const CERTAINTY = { 已確認: 1.0, 預期: 0.7, 傳聞: 0.4 };
const NOVELTY = { 首次: 1.0, 重複: 0.5 };
const PRICED = { 否: 1.0, 不確定: 0.8, 是: 0.4 };
const MISSING = 0.4; // 欄位缺值＝保守取低，不補高

const r4 = x => Math.round(x * 10000) / 10000;

/** 媒體判別（AI 讀完內文）：只排利多／利空；中性、資訊不足只計數。weight＝各因子乘積（0–1，先驗）。 */
export function rankMediaVerdicts(verdicts, { limit = 40 } = {}) {
  const rows = [];
  let neutral = 0, insufficient = 0;
  for (const [code, v] of Object.entries(verdicts || {})) {
    if (!v || typeof v !== 'object') continue;
    if (v.label === '資訊不足') { insufficient++; continue; }
    if (v.label !== '利多' && v.label !== '利空') { neutral++; continue; }
    const f = {
      strength: STRENGTH[v.strength] ?? MISSING, confidence: CONFIDENCE[v.confidence] ?? MISSING,
      certainty: CERTAINTY[v.certainty] ?? MISSING, novelty: NOVELTY[v.novelty] ?? MISSING, priced: PRICED[v.priced] ?? MISSING,
    };
    const weight = f.strength * f.confidence * f.certainty * f.novelty * f.priced;
    rows.push({
      code, label: v.label, strength: v.strength ?? null, confidence: v.confidence ?? null, certainty: v.certainty ?? null,
      novelty: v.novelty ?? null, priced: v.priced ?? null, eventType: v.eventType ?? null,
      reason: v.reason ?? null, impactPath: v.impactPath ?? null, keyQuote: v.keyQuote ?? null,
      // AI 判讀分析明細（收合區顯示）：原文引句與核對、AI 自我挑戰與修正、強度依據、未被原文支持的說法、讀了幾篇、判別通道
      challenge: v.challenge ?? null, revision: v.revision ?? null, strengthBasis: v.strengthBasis ?? null,
      quotes: Array.isArray(v.quotes) ? v.quotes.slice(0, 5).map(q => String(q).slice(0, 200)) : [],
      quoteVerified: Number.isFinite(v.quoteVerified) ? v.quoteVerified : null, quoteFailed: Number.isFinite(v.quoteFailed) ? v.quoteFailed : null,
      unsupported: Array.isArray(v.unsupported) ? v.unsupported.slice(0, 3).map(q => String(q).slice(0, 200)) : [],
      basis: v.basis ?? null, articlesRead: Number.isFinite(v.n) ? v.n : null, pass: v.pass ?? null, verdictAt: Number.isFinite(v.at) ? v.at : null,
      px: Number.isFinite(v.px) ? v.px : null, pxSrc: v.pxSrc ?? null,
      weight: r4(weight),
    });
  }
  rows.sort((a, b) => b.weight - a.weight || (a.code < b.code ? -1 : 1));
  const total = rows.reduce((s, x) => s + x.weight, 0);
  const items = rows.slice(0, limit).map((x, i) => ({ ...x, order: i + 1, share: total ? r4(x.weight / total) : null }));
  return { items, total: rows.length, bullish: rows.filter(x => x.label === '利多').length, bearish: rows.filter(x => x.label === '利空').length, neutral, insufficient };
}

// §4.1 公司層事件的 baseWeight（先驗）。順序即優先序：高風險規則類在前，例行公告（權重 0）在其後、一般事件之前。
// dir：+／−＝§4.1「方向（來源）」標「規則」者（程式強制）；標「條件」或「AI」者一律 null＝需讀內文，不憑主旨給方向
//   （例：C09 現金增資的主旨也包含「初次上櫃前現金增資承銷價」這類 IPO 公告，不是稀釋）。
export const OFFICIAL_RULES = [
  { id: 'C16a', label: '檢調／調查（對象須是本公司）', w: 0.90, dir: '−', re: /搜索|搜查|約談|起訴|羈押|背信|掏空|檢調|調查局|偵辦/ },
  { id: 'C22', label: '財務危機', w: 0.85, dir: '−', re: /退票|重整|財務危機|拒絕往來|延遲申報|破產|無法如期|非無保留/ },
  { id: 'C23', label: '變更交易／全額交割／停止買賣', w: 0.90, dir: '−', re: /變更交易|全額交割|停止買賣|終止上市|下市|暫停交易/ },
  { id: 'C17', label: '工安／火災／停工／天災', w: 0.70, dir: '−', re: /工安|火災|停工|爆炸|地震|淹水|颱風.*(停|損)/ },
  { id: 'C24', label: '例行公告', w: 0, dir: null, re: /股東(常)?會|董事會(通過|決議|召開)|背書保證|資金貸與|代子公司|使用權資產|更名|面額|董事辭世|異動|獨立董事|職稱|法人說明會|召開.*說明會|財務報告.*董事會|公告期間/ },
  { id: 'C13b', label: '公開收購', w: 0.80, dir: null, re: /公開收購/ },
  { id: 'C28', label: '得標／決標', w: 0.60, dir: null, re: /得標|決標/ },
  { id: 'C18a', label: '主要客戶砍單／倒閉', w: 0.55, dir: null, re: /客戶.*(倒閉|砍單|取消訂單)/ },
  { id: 'C07', label: '財測／指引', w: 0.50, dir: null, re: /財務預測|財測|上修|下修/ },
  { id: 'C26', label: '匯損益／關稅影響', w: 0.50, dir: null, re: /匯兌(損失|利益)|匯損|關稅.*影響/ },
  { id: 'C01', label: '接單／重大合約', w: 0.45, dir: null, re: /重大(訂單|合約)|簽訂.*合約|取得.*訂單|接獲.*訂單/ },
  { id: 'C05', label: '財報／自結損益', w: 0.40, dir: null, re: /自結|累計.*(盈餘|損益)|財務報告|合併財報|每股盈餘/ },
  { id: 'C04', label: '月營收', w: 0.35, dir: null, re: /月營收|營業收入淨額|營收/ },
  { id: 'C09', label: '現金增資', w: 0.35, dir: null, re: /現金增資/ },
  { id: 'C16b', label: '裁罰／重大訴訟', w: 0.35, dir: '−', re: /裁罰|罰鍰|重大訴訟|判決|提起訴訟/ },
  { id: 'C15a', label: '董監／大股東轉讓', w: 0.30, dir: '−', re: /(董事|監察人|大股東|經理人).*(轉讓|出售)|申報轉讓/ },
  { id: 'C13a', label: '併購／合併', w: 0.30, dir: null, re: /合併|併購|取得.*股權|收購/ },
  { id: 'C21', label: '澄清媒體報導', w: 0.30, dir: null, re: /澄清|媒體報導/ },
  { id: 'C25', label: '經營權之爭', w: 0.30, dir: null, re: /經營權|委託書/ },
  { id: 'C11', label: '減資', w: 0.25, dir: null, re: /減資/ },
  { id: 'C14', label: '處分資產／子公司股權', w: 0.25, dir: null, re: /處分/ },
  { id: 'C12', label: '庫藏股', w: 0.20, dir: '+', re: /庫藏股/ },
  { id: 'C15b', label: '董監增持', w: 0.20, dir: '+', re: /增持/ },
  { id: 'C10', label: '可轉債', w: 0.20, dir: null, re: /可轉換公司債|可轉債/ },
  { id: 'C03', label: '擴產／資本支出', w: 0.20, dir: null, re: /擴產|資本支出|取得.*(廠房|設備)/ },
];

/** 官方公告主旨 → 事件類型（只看主旨；比對不到＝未分類，不猜）。 */
export function classifyOfficial(subject) {
  const s = String(subject || '');
  for (const r of OFFICIAL_RULES) if (r.re.test(s)) return { id: r.id, label: r.label, weight: r.w, dir: r.dir };
  return { id: null, label: '未分類', weight: null, dir: null };
}

/** 官方重大訊息：同一家公司同一事件類型的多則公告合併成一列（「共 N 則」，展開看全部），按事件基礎權重排序。
 *  權重不隨則數累加（來源越多槓桿越大是已知問題，tw-news-impact-analyst §2）；例行（權重 0）與未分類只計數、不入排行。 */
export function rankOfficial(items, { limit = 40 } = {}) {
  const groups = new Map();
  let routine = 0, unclassified = 0, rankedAnn = 0;
  for (const it of items || []) {
    const c = classifyOfficial(it.subject);
    if (c.id === null) { unclassified++; continue; }
    if (c.weight === 0) { routine++; continue; }
    rankedAnn++;
    const ann = { subject: String(it.subject || '').replace(/\s+/g, ' ').slice(0, 160), at: it.at ?? null, body: it.body ? String(it.body).slice(0, 900) : null };
    const k = `${it.code}|${c.id}`;
    const g = groups.get(k) || groups.set(k, { code: it.code, name: it.name, type: c.id, typeLabel: c.label, dir: c.dir, weight: c.weight, basis: '主旨', announcements: [] }).get(k);
    g.announcements.push(ann);
  }
  const rows = [...groups.values()].map(g => {
    g.announcements.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
    return { ...g, announcements: g.announcements.slice(0, 8), count: g.announcements.length, subject: g.announcements[0].subject, at: g.announcements[0].at };
  });
  rows.sort((a, b) => b.weight - a.weight || b.count - a.count || (b.at ?? 0) - (a.at ?? 0) || (a.code < b.code ? -1 : 1));
  const total = rows.reduce((s, x) => s + x.weight, 0);
  return {
    items: rows.slice(0, limit).map((x, i) => ({ ...x, order: i + 1, share: total ? r4(x.weight / total) : null })),
    total: (items || []).length, ranked: rows.length, rankedAnnouncements: rankedAnn, routine, unclassified,
  };
}
