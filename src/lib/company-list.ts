// ─────────────────────────────────────────────────────────────────────────────
// 上市／上櫃公司基本資料（官方 t187ap03_L／t187ap03_O）的驗證、查找與產業別對照
//
// 純函式、**沒有任何 import**：測試直接以 Node 型別剝除載入本檔
//   node --test scripts/lib/company-list.test.mjs
// 抓取、memoize 與打包進 bundle 的備援檔在 company-list-server.ts。
//
// 2026-10-08 止血（WP2-0）：線上 openapi t187ap03_L 失敗時，舊程式用 process.cwd() 讀
// src/lib 下的備援檔，而部署產物不含 src/ ⇒ 全上市股公司資訊空白、產業「未分類」。
// 這裡把「上游回什麼才算可用」寫死成驗證規則：非陣列（HTML 錯誤頁、{message}）、
// 筆數不足（殘缺清單）一律拋錯，由呼叫端改走備援。「總數 > 0」不是完整性條件。
// ─────────────────────────────────────────────────────────────────────────────

/** 頁面用到的公司欄位（兩個市場統一成上市版的中文鍵）。值一律是字串，'' ＝來源未提供。 */
export interface CompanyInfo {
  /** 來源自報的出表日期（民國 YYYMMDD）——備援時拿它標「備援資料日」 */
  '出表日期': string;
  '公司代號': string;
  '公司名稱': string;
  '公司簡稱': string;
  '產業別': string;
  '董事長': string;
  '總經理': string;
  '成立日期': string;
  '上市日期': string;
  '實收資本額': string;
  '住址': string;
  '總機電話': string;
  '發言人': string;
  // 以下為 2026-08-27 補齊：t187ap03 兩個市場都有，過去整批被丟掉，
  // 於是個股頁的「公司資料」長期只有半套（使用者要求處理完整）。
  '發言人職稱': string;
  '代理發言人': string;
  '網址': string;
  '電子郵件信箱': string;
  '傳真機號碼': string;
  '英文簡稱': string;
  '營利事業統一編號': string;
  '股票過戶機構': string;
  '過戶電話': string;
  '簽證會計師事務所': string;
}

export type CompanyMarket = 'tse' | 'otc';
/** live＝本次（或 TTL 內）上游成功；fallback＝打包進 bundle 的官方鏡像快照；none＝兩者都查無 */
export type CompanySource = 'live' | 'fallback' | 'none';

export interface CompanyLookup {
  company: CompanyInfo | null;
  market: CompanyMarket | null;
  source: CompanySource;
  /** 來源自報的出表日期（YYYY-MM-DD）；查無或來源沒給時 null */
  asOf: string | null;
}

/** 完整性門檻：2026-10 實際上市 1,095、上櫃 892。低於門檻＝殘缺清單，改走備援。 */
export const MIN_LISTED_ROWS = 900;
export const MIN_OTC_ROWS = 700;

// 來源的「沒有」有三種寫法：空字串、全形破折號「－」、只有空白。統一成 ''。
// ⚠ TPEx 的值尾端常帶**全形空白**（實測 WebAddress、Symbol 都有），不 trim 掉會讓 https 網址變成壞連結。
const z = (v: unknown): string => {
  const t = String(v ?? '').replace(/[\s　]+/g, ' ').trim();
  return /^[－—–-]*$/.test(t) ? '' : t;
};
/** 原樣轉字串（保留既有顯示行為：董事長等欄位過去就是原值直出） */
const s = (v: unknown): string => (v == null ? '' : String(v));
/**
 * 來源偶把網址填進信箱欄（實測 TPEx 1584）——不像信箱就當來源未提供，不要渲染成壞的 mailto:
 * 一欄可能填多個信箱（實測 2427「a; b」）或用全形「＠」（實測 6831）：逐個切開，留合法的，以逗號串（mailto 可接多個）。
 */
export const cleanEmail = (v: unknown): string => {
  const parts = z(v).replace(/＠/g, '@').split(/[;,；，\s]+/).filter(Boolean);
  return parts.filter(p => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p)).join(',');
};

type RawRow = Record<string, unknown>;

function rowsOf(raw: unknown, codeKey: string, minRows: number, label: string): RawRow[] {
  if (!Array.isArray(raw)) throw new Error(`${label}: 回應不是陣列（${raw === null ? 'null' : typeof raw}）`);
  const rows = raw.filter((r): r is RawRow =>
    !!r && typeof r === 'object' && typeof (r as RawRow)[codeKey] === 'string' && !!String((r as RawRow)[codeKey]).trim());
  if (rows.length < minRows) throw new Error(`${label}: 只有 ${rows.length} 筆有效列（門檻 ${minRows}），視為殘缺`);
  return rows;
}

/** openapi.twse.com.tw t187ap03_L（中文鍵）→ CompanyInfo[]；不可用時拋錯 */
export function normalizeListed(raw: unknown, minRows: number = MIN_LISTED_ROWS): CompanyInfo[] {
  return rowsOf(raw, '公司代號', minRows, 't187ap03_L').map(r => ({
    '出表日期': z(r['出表日期']),
    '公司代號': z(r['公司代號']),
    '公司名稱': s(r['公司名稱']),
    '公司簡稱': s(r['公司簡稱']),
    '產業別': z(r['產業別']),
    '董事長': s(r['董事長']),
    '總經理': s(r['總經理']),
    '成立日期': s(r['成立日期']),
    '上市日期': s(r['上市日期']),
    '實收資本額': s(r['實收資本額']),
    '住址': s(r['住址']),
    '總機電話': s(r['總機電話']),
    '發言人': s(r['發言人']),
    '發言人職稱': s(r['發言人職稱']),
    '代理發言人': s(r['代理發言人']),
    '網址': s(r['網址']),
    '電子郵件信箱': cleanEmail(r['電子郵件信箱']),
    '傳真機號碼': s(r['傳真機號碼']),
    '英文簡稱': s(r['英文簡稱']),
    '營利事業統一編號': s(r['營利事業統一編號']),
    '股票過戶機構': s(r['股票過戶機構']),
    '過戶電話': s(r['過戶電話']),
    '簽證會計師事務所': s(r['簽證會計師事務所']),
  }));
}

/** www.tpex.org.tw mopsfin_t187ap03_O（英文鍵）→ CompanyInfo[]；不可用時拋錯 */
export function normalizeOtc(raw: unknown, minRows: number = MIN_OTC_ROWS): CompanyInfo[] {
  return rowsOf(raw, 'SecuritiesCompanyCode', minRows, 't187ap03_O').map(item => ({
    '出表日期': z(item.Date),
    '公司代號': z(item.SecuritiesCompanyCode),
    '公司名稱': s(item.CompanyName),
    '公司簡稱': s(item.CompanyAbbreviation),
    '產業別': z(item.SecuritiesIndustryCode),
    '董事長': s(item.Chairman),
    '總經理': s(item.GeneralManager),
    '成立日期': s(item.DateOfIncorporation),
    '上市日期': s(item.DateOfListing),
    '實收資本額': s(item['Paidin.Capital.NTDollars']),
    '住址': s(item.Address),
    '總機電話': s(item.Telephone),
    '發言人': s(item.Spokesman),
    '發言人職稱': z(item.TitleOfSpokesman),
    '代理發言人': z(item.DeputySpokesperson),
    '網址': z(item.WebAddress),
    '電子郵件信箱': cleanEmail(item.EmailAddress),
    '傳真機號碼': z(item.Fax),
    '英文簡稱': z(item.Symbol),
    '營利事業統一編號': z(item['UnifiedBusinessNo.']),
    '股票過戶機構': z(item.StockTransferAgent),
    '過戶電話': z(item.StockTransferAgentTelephone),
    '簽證會計師事務所': z(item.AccountingFirm),
  }));
}

/** 民國 YYYMMDD（或 YYMMDD）→ YYYY-MM-DD；格式不對回 null（不猜） */
export function rocDateToIso(roc: string | null | undefined): string | null {
  const d = String(roc ?? '').replace(/\D/g, '');
  if (d.length !== 7 && d.length !== 6) return null;
  const y = parseInt(d.slice(0, d.length - 4), 10) + 1911;
  const m = d.slice(-4, -2);
  const day = d.slice(-2);
  if (+m < 1 || +m > 12 || +day < 1 || +day > 31) return null;
  return `${y}-${m}-${day}`;
}

export interface CompanySources {
  listedLive: CompanyInfo[] | null;
  otcLive: CompanyInfo[] | null;
  listedFallback: CompanyInfo[];
  otcFallback: CompanyInfo[];
}

/**
 * 依序查：上市即時 → 上櫃即時 → 上市備援 → 上櫃備援。
 * 即時清單可用但查無（例：即時清單殘缺卻過了門檻）時仍會查備援，並標 source='fallback'。
 */
export function findCompany(code: string, src: CompanySources): CompanyLookup {
  const order: Array<[CompanyInfo[] | null, CompanyMarket, CompanySource]> = [
    [src.listedLive, 'tse', 'live'],
    [src.otcLive, 'otc', 'live'],
    [src.listedFallback, 'tse', 'fallback'],
    [src.otcFallback, 'otc', 'fallback'],
  ];
  for (const [list, market, source] of order) {
    const company = list?.find(c => c['公司代號'] === code);
    if (company) return { company, market, source, asOf: rocDateToIso(company['出表日期']) };
  }
  return { company: null, market: null, source: 'none', asOf: null };
}

/** 用備援時給頁面的標示；即時資料回 '' */
export function fallbackNote(lookup: CompanyLookup): string {
  if (lookup.source !== 'fallback') return '';
  return lookup.asOf ? `備援資料日 ${lookup.asOf}` : '備援資料（資料日不明）';
}

// ─── 產業別 ────────────────────────────────────────────────────────────────

export interface IndustryInfo {
  code: string;
  name: string;
  sector: string;
  emoji: string;
  description: string;
}

/**
 * 官方產業代碼（t187ap03 的「產業別」／SecuritiesIndustryCode）。
 * 名稱依據：官方鏡像 2026-10-02 的 L（1,095 檔）、O（892 檔）、興櫃 R（361 檔）逐代碼對 MOPS t05st03 的
 * industryCategory（wiki .cache，唯讀）——全部一對一相符。上市／上櫃差異：
 *   - 17：上市叫「金融保險業」、上櫃叫「金融業」（見 OTC_NAME_OVERRIDE）
 *   - 32 文化創意業、33 農業科技：只有上櫃／興櫃有公司，上市 0 檔
 *   - 91 存託憑證：只有上市有
 *   - 16：官方現名「觀光餐旅」（舊名觀光事業已停用）
 *   - 34：三表皆 0 檔（2023 產業別調整後已無公司使用）。名稱沿用櫃買舊分類「電子商務」，**本機無官方資料可驗**
 *   - 13 電子工業、19 綜合：現行上市櫃 0 檔，公開發行公司（t187ap03_P）仍有 13，保留
 * 01–31 沿用既有短名（NewsTab 以 name 組產業新聞查詢詞，改名會改變查詢，故不動）。
 */
export const INDUSTRY_MAP: Record<string, IndustryInfo> = {
  '01': { code: '01', name: '水泥工業', sector: '傳統產業', emoji: '🏗️', description: '建材基礎工業，與基建政策高度相關' },
  '02': { code: '02', name: '食品工業', sector: '民生消費', emoji: '🍜', description: '食品飲料，受通膨與消費力影響' },
  '03': { code: '03', name: '塑膠工業', sector: '石化材料', emoji: '🔬', description: '石化下游，景氣循環型產業' },
  '04': { code: '04', name: '紡織纖維', sector: '傳統製造', emoji: '🧵', description: '紡織成衣，東南亞布局加速中' },
  '05': { code: '05', name: '電機機械', sector: '機械設備', emoji: '⚙️', description: '工業自動化需求持續增長' },
  '06': { code: '06', name: '電器電纜', sector: '電力設備', emoji: '⚡', description: '電網升級與再生能源帶動需求' },
  '08': { code: '08', name: '玻璃陶瓷', sector: '傳統產業', emoji: '🏺', description: '建材需求與工業用途' },
  '09': { code: '09', name: '造紙工業', sector: '原材料', emoji: '📄', description: '環保包材、紙類需求趨勢' },
  '10': { code: '10', name: '鋼鐵工業', sector: '基礎工業', emoji: '🔩', description: '全球鋼價週期與基建景氣同步' },
  '11': { code: '11', name: '橡膠工業', sector: '材料工業', emoji: '🔄', description: '汽車零組件與工業用橡膠' },
  '12': { code: '12', name: '汽車工業', sector: '汽車整車', emoji: '🚗', description: '電動車轉型關鍵期，新能源車滲透率上升' },
  '13': { code: '13', name: '電子工業', sector: '電子零組件', emoji: '💡', description: '電子零組件，AI 算力需求帶動供應鏈' },
  '14': { code: '14', name: '建材營造', sector: '房地產', emoji: '🏢', description: '都更與危老重建政策推動需求' },
  '15': { code: '15', name: '航運業', sector: '交通運輸', emoji: '🚢', description: '運費指數波動，受地緣政治影響' },
  '16': { code: '16', name: '觀光餐旅', sector: '服務消費', emoji: '✈️', description: '觀光、旅宿與餐飲服務，受入境旅遊與內需消費影響' },
  '17': { code: '17', name: '金融保險', sector: '金融業', emoji: '🏦', description: '升息週期受益，壽險與銀行股業績改善' },
  '18': { code: '18', name: '貿易百貨', sector: '零售通路', emoji: '🛒', description: '零售消費趨勢，電商與實體競合' },
  '19': { code: '19', name: '綜合', sector: '多角化', emoji: '🔀', description: '多元化集團，各子事業體業績分散' },
  '20': { code: '20', name: '其他', sector: '特殊產業', emoji: '📊', description: '特殊業務類型，需個別分析' },
  '21': { code: '21', name: '化學工業', sector: '石化工業', emoji: '⚗️', description: '化工材料，景氣循環與原油價格連動' },
  '22': { code: '22', name: '生技醫療', sector: '醫療生技', emoji: '💊', description: 'AI 新藥開發、CRO/CDMO 全球化佈局加速' },
  '23': { code: '23', name: '油電燃氣', sector: '公用事業', emoji: '🔋', description: '能源轉型主題，再生能源佈局受矚目' },
  '24': { code: '24', name: '半導體', sector: '科技龍頭', emoji: '🔲', description: 'AI 算力需求爆發，先進製程訂單高度滿載' },
  '25': { code: '25', name: '電腦週邊', sector: '硬體設備', emoji: '💻', description: 'AI PC 換機潮、伺服器市場高速成長' },
  '26': { code: '26', name: '光電業', sector: '光電顯示', emoji: '🖥️', description: 'OLED/MicroLED 新世代顯示技術驅動換機' },
  '27': { code: '27', name: '通信網路', sector: '網路通訊', emoji: '📡', description: '5G/6G 基礎建設、衛星通訊快速普及' },
  '28': { code: '28', name: '電子零組件', sector: '零組件', emoji: '🔌', description: 'AI 伺服器供應鏈、被動元件需求成長' },
  '29': { code: '29', name: '電子通路', sector: '電子通路', emoji: '📦', description: '半導體零組件通路商，AI 訂單快速拉貨' },
  '30': { code: '30', name: '資訊服務', sector: '軟體服務', emoji: '☁️', description: '雲端、AI、資安軟體需求高速擴張' },
  '31': { code: '31', name: '其他電子', sector: '電子製造', emoji: '🔧', description: '各類電子製造，受惠 AI 終端設備普及' },
  '32': { code: '32', name: '文化創意業', sector: '文化內容', emoji: '🎨', description: '影視、出版、遊戲與設計等文化內容產業（櫃買市場類別）' },
  '33': { code: '33', name: '農業科技', sector: '農業生技', emoji: '🌾', description: '農業生技、育種與農產加工等農業科技產業（櫃買市場類別）' },
  '34': { code: '34', name: '電子商務', sector: '網路零售', emoji: '🛍️', description: '電子商務平台與網路零售（舊分類代碼，現行已無公司使用）' },
  '35': { code: '35', name: '綠能環保', sector: '能源環保', emoji: '♻️', description: '再生能源、節能與環保工程等綠能環保產業' },
  '36': { code: '36', name: '數位雲端', sector: '數位服務', emoji: '🌐', description: '雲端服務、數位平台與網路服務等數位雲端產業' },
  '37': { code: '37', name: '運動休閒', sector: '休閒消費', emoji: '🏃', description: '運動用品、健身器材與休閒產品等運動休閒產業' },
  '38': { code: '38', name: '居家生活', sector: '居家消費', emoji: '🛋️', description: '家具、家電與居家用品等居家生活產業' },
  '91': { code: '91', name: '存託憑證', sector: '外國企業', emoji: '📜', description: '臺灣存託憑證（TDR），表彰外國公司股票；實際業務依原股公司' },
};

/** 同代碼、上櫃官方名稱不同者（MOPS 實測：上櫃 17 全數為「金融業」） */
const OTC_NAME_OVERRIDE: Record<string, string> = { '17': '金融業' };

export const ETF_INDUSTRY: IndustryInfo = {
  code: 'ETF', name: 'ETF', sector: '指數股票型基金', emoji: '📈',
  description: 'ETF 是基金不是公司：官方上市／上櫃公司清單（t187ap03）不含 ETF，沒有產業別；追蹤指數與成分股請見發行投信的公開說明書',
};
export const ESB_INDUSTRY: IndustryInfo = {
  code: 'ESB', name: '興櫃', sector: '興櫃市場', emoji: '🌱',
  description: '興櫃股票（無漲跌幅限制）。本頁的上市／上櫃公司清單不含興櫃，官方產業別尚未接入',
};
export const UNKNOWN_INDUSTRY: IndustryInfo = {
  code: '99', name: '產業別未提供', sector: '其他', emoji: '📋',
  description: '官方上市／上櫃公司清單（含備援快照）查無此代號，產業別來源未提供',
};

/** ETF 代號：00 開頭 4~6 碼，可帶一個英文尾碼（0050、00878、006208、00632R） */
export const isEtfCode = (code: string): boolean => /^00\d{2,4}[A-Z]?$/.test(code);

/**
 * @param dayMarket 日行情的市場別（'tse'｜'otc'｜'esb'），用來辨識興櫃；拿不到就不判興櫃。
 */
export function resolveIndustry(lookup: CompanyLookup, code: string, dayMarket?: string): IndustryInfo {
  const ic = lookup.company?.['產業別'] ?? '';
  if (lookup.company) {
    const base = INDUSTRY_MAP[ic];
    if (base) {
      const otcName = lookup.market === 'otc' ? OTC_NAME_OVERRIDE[ic] : undefined;
      return otcName ? { ...base, name: otcName } : base;
    }
    // 官方有給代碼、只是對照表沒收：據實顯示代碼，不要落回「未分類」
    if (ic) return { code: ic, name: `產業代碼 ${ic}`, sector: '其他', emoji: '📋', description: `官方產業代碼 ${ic} 尚未收錄於對照表` };
    return UNKNOWN_INDUSTRY;
  }
  if (isEtfCode(code)) return ETF_INDUSTRY;
  if (dayMarket === 'esb') return ESB_INDUSTRY;
  return UNKNOWN_INDUSTRY;
}
