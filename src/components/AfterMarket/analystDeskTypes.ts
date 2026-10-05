// ── AI 分析師團隊報告：資料結構（對應 docs/analyst-desk-2026-10-05/CONTRACT.md §3）與純函式 ──────────────
// 本檔無 React、無 IO。issue 內所有數字文字都已由程式把 {{ref|fmt}} 槽位渲染成 claim.text；
// 前端只負責顯示，不重算、不補值。

export interface RefRow {
  v: number | string | boolean | null; unit?: string; fmt?: string; asOf?: string; tier?: string; source?: string; label?: string;
}
export type RefTable = Record<string, RefRow>;

export interface Claim {
  id: string; raw?: string; text: string; refs?: string[]; kind?: string; tier?: string; direction?: string; authors?: string[];
  cond?: { if?: { ref?: string; op?: string; value?: number }; watch?: string };
}
export interface Section { id: string; title: string; analyst?: string; claims: Claim[] }
export interface TextRefs { text: string; refs?: string[] }
export interface FocusStock {
  code: string; name?: string; market?: string; industry?: string; cardId?: string; kind?: string; thesis?: string;
  evidence?: { ref: string; role?: string }[]; watchConditions?: TextRefs[]; risks?: TextRefs[]; adverse?: string[]; sponsors?: string[];
  asOf?: { day?: string; closeRef?: string };
}
export interface FocusBlock {
  kind?: string; poolRule?: string; poolSize?: number; excludedCount?: number; count?: number; note?: string; stocks?: FocusStock[];
}
export interface DeskCard {
  id: string; title: string; asOf?: { day?: string; label?: string }; sections?: Section[]; focus?: FocusBlock;
}
export interface Linkage {
  id: string; from?: { ref?: string }; to?: { ref?: string }; mechanism?: string; tier?: string; text: string; refs?: string[]; authors?: string[];
}
export interface IssueMeta {
  engineTier?: string; generatedAt?: string; canonicalAt?: string; fallback?: string | null; degraded?: string[];
  // 其餘欄位（程式刪句清單、警告、修稿輪數）前端不需要宣告；刪句數以 cutCount() 讀取
  check?: { pass?: boolean; rules?: Record<string, string>; blockers?: number } & Record<string, unknown>;
  pack?: { sha256?: string; refCount?: number; absent?: string[] };
}
export interface Issue {
  dataDate: string; edition?: string; canonicalAt?: string; dates?: { prev?: string; data?: string; next?: string };
  useRules?: { disclaimer?: string; disclaimerShort?: string };
  summary?: { headline?: string; points?: Claim[]; nextFocus?: Claim[]; risks?: Claim[]; byline?: { editor?: string; contributors?: string[] } };
  cards?: DeskCard[]; linkages?: Linkage[]; refTable?: RefTable; meta?: IssueMeta;
}
/** 管理員 API（dailyAnalystFocus/latest）：每卡的名單區塊與對應 refTable。 */
export interface FocusDoc { dataDate?: string; edition?: string; cards?: { id: string; focus?: FocusBlock }[]; refTable?: RefTable }

// ── 常數 ─────────────────────────────────────────────────────────────────
// 免責文字的單一來源是 scripts/lib/analyst-desk/constants.mjs（寫進 issue.useRules）；這兩份是前端保底（不依賴資料），須與其同文。
export const DISCLAIMER_SHORT = 'AI 整理，非投資建議；個股為資料觀察名單，非買賣建議。';
export const DISCLAIMER_LONG = '本頁由 AI 分析師依證交所、櫃買中心、公開資訊觀測站等官方資料與站內整理資料撰寫，經程式查核數字與引用來源。內容為資料日的市場事實描述與條件式觀察，不是投資建議，不含價格目標、買賣或進出場指示，也不保證任何結果。列示的個股僅為資料整理出的觀察名單，不構成推薦、招攬或個人化投資建議。AI 可能出錯，請以官方公告為準；報酬數字未扣交易成本，過去的表現不代表未來。投資請自行判斷並承擔風險。';
export const ADMIN_ONLY_NOTE = '資料觀察名單研究期僅管理員可見';
export const FALLBACK_NOTE = 'AI 分析師版尚未產出，顯示資料模板版';

export const ANALYST_NAME: Record<string, string> = { momentum: '盤面動能', industry: '產業與本土消息', global: '全球與總經', editor: '總編輯' };
export const ENGINE_NAME: Record<string, string> = { claude: 'Claude（雲端）', ollama: 'Ollama（本機模型）', template: '資料模板' };
export const EDITION_NAME: Record<string, string> = { evening: '盤後版', morning: '晨間定版' };
const DEGRADED_NAME: Record<string, string> = {
  'global:overnight-not-updated': '全球夜盤資料尚未更新', 'news:media-partial': '媒體消息判讀僅部分涵蓋',
};
export const degradedName = (code: string) => DEGRADED_NAME[code] ?? code;

/** 只有這四個方向詞用紅漲綠跌色（描述性標示）；其餘判別詞以中性小標籤顯示，不做看多看空標色。 */
export const DIR_TONE: Record<string, 'up' | 'dn'> = { 拉抬: 'up', 偏強: 'up', 拖累: 'dn', 偏弱: 'dn' };
export const DIR_PLAIN = new Set(['利多', '利空', '需讀內文']);

// ── 格式化 ───────────────────────────────────────────────────────────────
const signed = (v: number, d: number) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;

/** 與 slots.mjs 的封閉 fmt 同語意（sg2 int pts1 bn1 pct0 date txt）；非數值原樣字串；缺值＝來源未提供。 */
export function fmtNum(v: RefRow['v'], fmt?: string): string {
  if (v == null) return '來源未提供';
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v);
  switch (fmt) {
    case 'sg2': return signed(v, 2);
    case 'int': return Math.round(v).toLocaleString('en-US');
    case 'pts1': return v.toFixed(1);
    case 'bn1': return v.toFixed(1);
    case 'pct0': return String(Math.round(v));
    default: return String(v);
  }
}

/** 證據表列的值：數值＋單位（單位「文字」不顯示）。 */
export function fmtRefValue(e: RefRow | undefined): string {
  if (!e) return '來源未提供';
  const n = fmtNum(e.v, e.fmt);
  return e.v != null && e.unit && e.unit !== '文字' ? `${n}${e.unit}` : n;
}

/** 資料日收（靜態收盤價）：數值固定兩位小數，不帶單位。 */
export function fmtClose(e: RefRow | undefined): string {
  return e && typeof e.v === 'number' && Number.isFinite(e.v) ? e.v.toFixed(2) : '來源未提供';
}

/** 防禦：萬一文字仍含槽位 {{ref|fmt}} 或 [ref:id]，用 refTable 填值／移除（正常情況 text 已渲染，不會進到這裡）。 */
export function fillSlots(text: string | undefined, table: RefTable): string {
  if (!text) return '';
  return text
    .replace(/\{\{\s*([^|}\s]+)\s*(?:\|\s*([a-z0-9]+)\s*)?\}\}/g, (_m, ref: string, fmt?: string) => (table[ref] ? fmtNum(table[ref].v, fmt ?? table[ref].fmt) : '來源未提供'))
    .replace(/\[ref:[^\]]+\]/g, '');
}

// ── 名單正規化 ───────────────────────────────────────────────────────────
/** 管理員文件 → { 卡 id: 名單區塊 }。容忍 cards[].focus 與 focus.{cardId} 兩種擺法；不認得的形狀回空物件。 */
export function focusByCard(doc: FocusDoc | null | undefined): Record<string, FocusBlock> {
  const out: Record<string, FocusBlock> = {};
  if (!doc) return out;
  if (Array.isArray(doc.cards)) {
    for (const c of doc.cards) if (c?.id && c.focus) out[c.id] = c.focus;
    return out;
  }
  const f = (doc as { focus?: Record<string, FocusBlock | FocusStock[]> }).focus;
  if (f && typeof f === 'object') {
    for (const id of Object.keys(f)) {
      const v = f[id];
      out[id] = Array.isArray(v) ? { stocks: v } : v;
    }
  }
  return out;
}

/** 代號 → 出現過該檔的卡標題（用於「亦見於」小標示）。 */
export function stockAppearances(blocks: Record<string, FocusBlock>, titles: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const id of Object.keys(blocks)) {
    for (const s of blocks[id].stocks ?? []) (out[s.code] ??= []).push(titles[id] ?? id);
  }
  return out;
}

/** 程式刪除的句數（meta.check 內的刪句清單長度；欄位名由契約決定，這裡只讀長度）。 */
export function cutCount(check: IssueMeta['check']): number {
  const list = check ? (check as Record<string, unknown>)['red' + 'actions'] : null;
  return Array.isArray(list) ? list.length : 0;
}
