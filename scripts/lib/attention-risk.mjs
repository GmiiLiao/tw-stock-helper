// ─────────────────────────────────────────────────────────────────────────────
// ⚠ 注意股 → 處置的風險分級（2026-10-03 使用者「都做，依建議進行」；研究 docs/SURGE-ATTENTION-2026-10-03.md §5、§9.2）
//
//   等級（互斥，優先序 高＞中＞低）——以官方處置規則判定，歷史 10 個交易日內出現處置公告的機率見校準檔：
//     high＝官方「注意累計次數可能達處置標準」名單（TWSE rwd notetrans、TPEx www bulletin/warning）：次一營業日再被注意且達處置標準即處置
//     mid ＝當日注意、且含**計入處置**的條款（上市第 1～5、7、8 款；上櫃第 1～8 款）；條款解析不到也算 mid（保守）
//     low ＝當日注意、但只因不計入處置的條款（上市第 6、9～13 款；上櫃第 9～13 款）
//   ⚠ 不要用公告列的「累計次數」：上市＝查詢區間內該股列數（含之後的公告＝前視）、上櫃＝當日公告總股數（研究端已證實）。
//
//   為什麼「可能達處置」名單在 daemon 端抓、而不是加進 src/lib/risk-stocks-source.ts：
//     那份是注意／處置名單的全站唯一來源（這裡**不**重抓、不重解析注意／處置名單，條款只從它回的 reason 取數字）；
//     「可能達處置」是另一張官方表，網站只拿落後一日的 openapi 版加註文字。新功能走 daemon（CLAUDE.md），
//     並且要帶資料日回音（盤後選股要知道名單是不是今天的）。
//   純函式＋一個帶快取的抓取器（createNearDisposalSource）；校準數字讀 scripts/data/attention-calibration.json。
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';

/** 計入處置計算的條款（官方作業要點；以 2026-10-02 兩市官方名單逐檔驗證） */
export const COUNTING_CLAUSES = Object.freeze({ TWSE: Object.freeze([1, 2, 3, 4, 5, 7, 8]), TPEx: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]) });
export const ATTN_TIERS = Object.freeze(['high', 'mid', 'low']);

const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const cnNum = s => (s.length === 1 ? CN[s] : s[0] === '十' ? 10 + (CN[s[1]] || 0) : (CN[s[0]] || 0) * 10 + (CN[s[1]] || 0));
/** 公告文字裡的條款編號（上市「﹝第一款﹞」、上櫃「(第十款)」皆吃）；找不到回空陣列 */
export function parseClauses(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/第([一二三四五六七八九十]{1,2})款/g)) { const n = cnNum(m[1]); if (n >= 1 && n <= 13) out.add(n); }
  return [...out].sort((a, b) => a - b);
}

/**
 * 單檔等級。near＝在官方可能達處置名單上；att＝{ src:'TWSE'|'TPEx', clauses:number[] } 或 null（當日不是注意股）。
 * 回 { tier, src, clausesKnown } 或 null（無風險標記）。
 */
export function attentionTier({ near = null, att = null } = {}) {
  if (near) return { tier: 'high', src: near, clausesKnown: att ? att.clauses.length > 0 : null };
  if (!att) return null;
  if (!att.clauses.length) return { tier: 'mid', src: att.src, clausesKnown: false };
  const counting = COUNTING_CLAUSES[att.src] || COUNTING_CLAUSES.TPEx;
  return { tier: att.clauses.some(c => counting.includes(c)) ? 'mid' : 'low', src: att.src, clausesKnown: true };
}

// ── 可能達處置名單（帶資料日回音）────────────────────────────────────────────
const rocTitleIso = t => { const m = String(t || '').match(/(\d{2,3})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/); return m ? `${+m[1] + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const ymd8Iso = v => { const s = String(v ?? ''); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : null; };
const codesOf = (fields, data) => {
  const i = Array.isArray(fields) ? fields.indexOf('證券代號') : -1;
  if (i < 0) return null;
  return [...new Set((data || []).map(r => String(r?.[i] ?? '').trim()).filter(c => /^\d{4,6}$/.test(c)))];
};
/**
 * 解析兩份官方「可能達處置」名單。任何一邊身分／日期對不上 ⇒ 該邊 null（＝未知，不是「沒有」）。
 *   上市 rwd notetrans：title「115年10月02日 公布注意累計次數可能達處置標準之有價證券一覽表」、fields 含「證券代號」
 *   上櫃 www bulletin/warning：tables[0].title 含「可能達處置」、tables[0].date＝20261002
 */
export function parseNearDisposal({ twse = null, tpex = null } = {}) {
  let tw = null, tp = null;
  if (twse && twse.stat === 'OK' && /可能達處置/.test(String(twse.title || ''))) {
    const date = rocTitleIso(twse.title), codes = codesOf(twse.fields, twse.data);
    if (date && codes) tw = { date, codes };
  }
  const t0 = tpex?.tables?.[0];
  if (t0 && /可能達處置/.test(String(t0.title || ''))) {
    const date = ymd8Iso(t0.date), codes = codesOf(t0.fields, t0.data);
    if (date && codes) tp = { date, codes };
  }
  return { twse: tw, tpex: tp };
}

export const NEAR_DISPOSAL_URLS = Object.freeze({
  twse: 'https://www.twse.com.tw/rwd/zh/announcement/notetrans?response=json',
  tpex: 'https://www.tpex.org.tw/www/zh-tw/bulletin/warning?response=json',
});

/**
 * 帶快取的抓取器：TTL 內（預設 10 分鐘）重用、失敗 1 分鐘負快取——會員再多也只打一次上游（唯一不變式）。
 * get() 回 parseNearDisposal 的結果（兩邊各自可能為 null）；兩邊都失敗回 null。
 */
export function createNearDisposalSource({ fetchImpl = fetch, clock = () => Date.now(), ttlMs = 10 * 60_000, failTtlMs = 60_000, log = () => {} } = {}) {
  let cache = null, inflight = null;
  const getJson = async url => {
    try {
      const r = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' }, signal: AbortSignal.timeout(8000) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  return {
    async get() {
      if (cache && clock() - cache.at < (cache.v ? ttlMs : failTtlMs)) return cache.v;
      if (inflight) return inflight;
      inflight = (async () => {
        const [twse, tpex] = await Promise.all([getJson(NEAR_DISPOSAL_URLS.twse), getJson(NEAR_DISPOSAL_URLS.tpex)]);
        const p = parseNearDisposal({ twse, tpex });
        const v = p.twse || p.tpex ? p : null;
        if (!p.twse || !p.tpex) log(`⚠ 可能達處置名單取不到或格式不符：${[!p.twse && '上市', !p.tpex && '上櫃'].filter(Boolean).join('、')}（視為未知）`);
        cache = { at: clock(), v };
        return v;
      })().finally(() => { inflight = null; });
      return inflight;
    },
  };
}

/**
 * /api/twse/risk-stocks 回應 → 「當日」注意股的條款：{ code: { src, clauses } }，只收公告日＝該市場名單日的列。
 *   ⚠ 上櫃 openapi 同時回最近兩個公告日（2026-10-03 審查實測：10-01 18 列＋10-02 22 列）——不過濾的話，D−1 才被注意的
 *     股票會被標成中／低級並套上「當日注意」的處置比例。上市 rwd 本來就只取最新一批，舊版 API 沒有 date 欄時仍可用；
 *     上櫃列沒有 date（網站尚未部署帶日期的版本）⇒ 無法分辨哪天 ⇒ 不給等級（退回舊的「⚠注意股」標示）。
 * 回 { info, tpexUndated, currentCodes }：tpexUndated＝因缺公告日而略過的上櫃列數（給 log）；
 *   currentCodes＝AI 波段要標「注意股」的代號＝當日注意（info 的鍵）＋缺公告日、無法判斷哪天的上櫃（部署前沿用舊標示）——
 *   D−1 才被注意的不在內（2026-10-03 第二輪審查：否則它退回「⚠注意股」，標得比當日低級還重、且說明表裡沒有這一級）。
 */
export function attentionInfoOf(rs) {
  const info = {}; let tpexUndated = 0; const undated = new Set();
  const listDate = { TWSE: rs?.twseAttentionDate ?? null, TPEx: rs?.tpexAttentionDate ?? null };
  for (const a of rs?.attention || []) {
    if (!a?.code || !(a.source in listDate)) continue;
    if (a.source === 'TPEx' && !a.date) { tpexUndated++; undated.add(a.code); continue; }
    if (!listDate[a.source]) { undated.add(a.code); continue; }   // 名單日不明（來源沒回日期）⇒ 不分級、沿用舊標示
    if ((a.date ?? listDate[a.source]) !== listDate[a.source]) continue;
    const prev = info[a.code];
    info[a.code] = { src: a.source, clauses: [...new Set([...(prev?.clauses || []), ...parseClauses(a.reason)])].sort((x, y) => x - y) };
  }
  return { info, tpexUndated, currentCodes: new Set([...Object.keys(info), ...undated]) };
}

/**
 * 組合單檔風險（給 buildPool／持股用）。nearMap：Map(code → 'TWSE'|'TPEx')；attentionInfo：{ code: { src, clauses } }。
 * 回 { [code]: { tier, src, clausesKnown } }，只含有等級的代號。
 */
export function riskTiersOf({ nearMap = null, attentionInfo = null } = {}) {
  const out = {};
  const codes = new Set([...(nearMap ? nearMap.keys() : []), ...Object.keys(attentionInfo || {})]);
  for (const code of codes) {
    const t = attentionTier({ near: nearMap?.get(code) || null, att: attentionInfo?.[code] || null });
    if (t) out[code] = t;
  }
  return out;
}

// ── 校準（研究端產出；讀不到就不顯示機率，功能照常）────────────────────────────
let CAL = null;
try { CAL = JSON.parse(readFileSync(new URL('../data/attention-calibration.json', import.meta.url), 'utf8')); } catch { CAL = null; }
export const attentionCalibration = () => CAL;
/** 測試用：注入／清除校準資料（傳 null＝模擬檔案不存在）；回傳先前的值以便還原。正式執行不呼叫，行為仍是啟動時讀檔。
 *  scripts/data/*.json 依專案規則不進版控，所以測試不能假設 attention-calibration.json 存在。 */
export function setAttentionCalibration(cal) { const prev = CAL; CAL = cal ?? null; return prev; }
const MKT = { TWSE: 'tse', TPEx: 'otc' };
/** 歷史 10 個交易日內出現處置公告的機率（0~1）；無校準回 null */
export function dispositionProb10(tier, src) {
  const v = CAL?.escalation10?.[tier]?.[MKT[src]]?.p;
  return Number.isFinite(v) ? v : null;
}
