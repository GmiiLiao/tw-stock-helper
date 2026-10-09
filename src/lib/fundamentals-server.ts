// ============================================================
// Fundamentals & chips data (server-only, cached).
// Whole-market maps keyed by stock code:
//   • Valuation   — PER / dividend yield / PBR     (TWSE BWIBBU_ALL openapi)
//   • Margin      — 融資今日/前日餘額 / 限額         (TWSE MI_MARGN openapi)
//   • Institutional 三大法人買賣超(張)               (TWSE T86, dated)
// All TWSE public endpoints, no API key. Cached ~10 min.
// ============================================================

import { isTradingDay } from './twse-api-server';
import { memoize } from './singleflight';
import { taipeiToday } from './market-clock';

export interface Valuation { pe: number | null; dividendYield: number | null; pb: number | null; }
export interface Margin {
  balance: number;       // 融資今日餘額 (張)
  prevBalance: number;   // 融資前日餘額 (張)
  limit: number;         // 融資限額 (張)
  changePct: number;     // 日增減 %
  utilization: number;   // 餘額 / 限額 %
}
export interface Institutional {
  foreignNetLots: number; // 外資(張)，正=買超
  trustNetLots: number;   // 投信(張)
  dealerNetLots: number;  // 自營商(張)
  totalNetLots: number;   // 三大法人合計(張)
}

// ⚠ 快取一律走 singleflight.memoize，不要手寫 `let cached; let cachedAt;`（CLAUDE.md 規矩）。
// 這裡曾經是三份手寫 TTL 快取（2026-08-12 收斂）：手寫版沒有 in-flight 合流
// ——TTL 到期瞬間 N 個併發 request＝N 次直打 TWSE；也沒有失敗負快取
// ——TWSE 一掛，每個 request 都立刻重打。region 已在台灣（asia-east1），
// 這些直打**會成功**，正面違反「上游請求數與線上人數脫鉤」的唯一不變式。
// memoize 的 timeoutMs 必須涵蓋函式內的**連續多段** fetch（預設 8 秒會把它們砍半）。
const TTL = 10 * 60 * 1000;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)', Accept: 'application/json' };

async function fetchJSON(url: string): Promise<any> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch(url, { headers: UA, signal: c.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { clearTimeout(t); return null; }
}

function num(s: unknown): number | null {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}
function intClean(s: unknown): number {
  const n = parseInt(String(s ?? '').replace(/,/g, '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

// ── Valuation（本益比／殖利率／股價淨值比）────────────────────────────
//
// ⚠ PRIMARY 必須是 rwd，不能是 openapi（2026-08-11 實證後修正）：
//   本益比、殖利率、股價淨值比**全都是價格導出的**，用昨天的收盤價算出來的
//   估值，在今天漲跌 5% 的股票上就直接錯 5%。而這裡原本打的是 openapi 鏡像，
//   它誠實地落後一個交易日（Date=1150810，數值對應 08-10 收盤）
//   ⇒ 站上顯示的 PER/殖利率一直是**昨天的**。
//
//   同一份報表的 rwd 端點給的是**最新一個交易日收盤**的資料，但有兩個怪癖：
//   ① 忽略 date 參數（帶 20260701、20261231 都回同一份）——所以不能拿來查歷史。
//   ② **`date` 欄是「今天的日曆日」，不是資料日；`title` 開頭的民國日期才是資料日。**
//
//   ⚠ 這一條我在 2026-08-11 判斷錯過一次，寫成「date 欄才是真正的資料日」。
//     錯的原因很有教育意義：那次是**收盤後**測的，當天的收盤已經發布，
//     於是「服務日」恰好等於「資料日」，兩個欄位看起來都對，我挑了錯的那個。
//     2026-08-12 09:32（盤中、當日收盤尚未存在）再測就露餡了：
//       date=20260812、title=115/08/11，而內容經數值反推是 08-11 的。
//     驗證方式（別只看欄位，要驗數值）：PBR ∝ 價格。
//       · 08-11 測：PBR(rwd)/PBR(openapi) == 收盤(08-11)/收盤(08-10)，9 檔全中
//         → rwd 領先 openapi 一天（此結論仍成立）
//       · 08-12 測：openapi 已追到 08-11，兩邊 PBR 比值恆為 1.0000，
//         openapi 自報 Date=1150811 → rwd 內容就是 08-11 ⇒ title 對、date 錯
//     另以 date 參數掃描確認：req=20260805/20260701/20261231 回傳的
//     date 一律是 20260812、title 一律 115/08/11、PBR 一字不差 ⇒ date 純粹是服務日。
//   ⇒ 資料日一律從 title 解析；date 欄只在 title 解不出來時當退路。
//
//   openapi 保留為 FALLBACK：rwd 偶有維護時段，寧可退回昨天的估值也不要整片空白，
//   但**必須把資料日一起回傳**，讓呼叫端能揭露「這是哪一天的估值」。


function ymdOf(v: unknown): string | null {
  const m = String(v ?? '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// title 形如「115/08/11 個股日本益比、殖利率及股價淨值比」——開頭的民國日期才是資料日。
function rocDateOf(title: unknown): string | null {
  const m = String(title ?? '').match(/(\d{2,3})\/(\d{2})\/(\d{2})/);
  return m ? `${+m[1] + 1911}-${m[2]}-${m[3]}` : null;
}

export async function getValuationMap(): Promise<Record<string, Valuation>> {
  return (await getValuation()).map;
}

// 回傳估值與**它代表的資料日**。缺了資料日就無法分辨「今天的」與「昨天的」，
// 而這正是本專案栽過四次的那道閘門。
const _valuation = memoize('fund:valuation', TTL, async () => {
  const map: Record<string, Valuation> = {};
  let date: string | null = null;

  // PRIMARY：rwd（當日）。欄序 [股票代號, 股票名稱, 本益比, 殖利率(%), 股價淨值比]
  const today = taipeiToday().replace(/-/g, '');   // 舊式（偏移＋480 分再 toISOString）只在 UTC 主機正確，非 UTC 主機會變回 UTC 日期
  const rwd = await fetchJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_ALL?date=${today}&response=json`);
  if (rwd?.stat === 'OK' && Array.isArray(rwd.data) && rwd.data.length > 500) {
    for (const row of rwd.data) {
      const code = String(row[0] || '').trim();
      if (code) map[code] = { pe: num(row[2]), dividendYield: num(row[3]), pb: num(row[4]) };
    }
    // title 優先（真資料日）；解不出來才退回 date 欄（服務日，可能超前一天）。
    date = rocDateOf(rwd.title) ?? ymdOf(rwd.date);
  }

  // FALLBACK：openapi（落後一日）。只有在 rwd 整批失敗時才用。
  if (!Object.keys(map).length) {
    const arr = await fetchJSON('https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL');
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const code = (it.Code || '').trim();
        if (code) map[code] = { pe: num(it.PEratio), dividendYield: num(it.DividendYield), pb: num(it.PBratio) };
      }
      // openapi 的 Date 是民國 1150810 格式
      const m = String(arr[0]?.Date ?? '').match(/^(\d{3})(\d{2})(\d{2})$/);
      if (m) date = `${+m[1] + 1911}-${m[2]}-${m[3]}`;
    }
  }

  return { map, date };
}, { timeoutMs: 20_000, isDegraded: v => !Object.keys((v as { map: object }).map).length });

export async function getValuation(): Promise<{ map: Record<string, Valuation>; date: string | null }> {
  return (await _valuation()) ?? { map: {}, date: null };
}

// ── Margin (MI_MARGN) ───────────────────────────────────────
const _margin = memoize('fund:margin', TTL, async () => {
  const arr = await fetchJSON('https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN');
  const map: Record<string, Margin> = {};
  if (Array.isArray(arr)) {
    for (const it of arr) {
      const code = (it['股票代號'] || '').trim();
      if (!code) continue;
      const balance = intClean(it['融資今日餘額']);
      const prev = intClean(it['融資前日餘額']);
      const limit = intClean(it['融資限額']);
      map[code] = {
        balance, prevBalance: prev, limit,
        changePct: prev > 0 ? parseFloat((((balance - prev) / prev) * 100).toFixed(2)) : 0,
        utilization: limit > 0 ? parseFloat(((balance / limit) * 100).toFixed(1)) : 0,
      };
    }
  }
  return map;
}, { timeoutMs: 12_000, isDegraded: v => !Object.keys(v as object).length });

export async function getMarginMap(): Promise<Record<string, Margin>> {
  return (await _margin()) ?? {};
}

import { getAdminDb } from './firebase-admin';

// ── Institutional (T86 上市 ＋ 第二大腦 chipDaily 補上櫃, dated) ────
// timeoutMs 35s：候選日最多 4 個、逐一嘗試（每個 fetch 自身 8s 上限）——
// 假日連休後第一次呼叫就是會走滿，砍太短等於假日後法人恆空。
const _inst = memoize('fund:institutional', TTL, async () => {

  // Build candidate dates: today, then walk back over recent trading days.
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const fmt = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const candidates: string[] = [];
  const cur = new Date(tw.getTime());
  for (let i = 0; i < 8 && candidates.length < 4; i++) {
    if (i === 0 || isTradingDay(cur)) candidates.push(fmt(cur));
    cur.setDate(cur.getDate() - 1);
  }

  const map: Record<string, Institutional> = {};
  let usedDate = '';
  for (const date of candidates) {
    const data = await fetchJSON(`https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${date}&selectType=ALL`);
    if (data?.stat === 'OK' && Array.isArray(data.data) && data.data.length > 0) {
      for (const row of data.data) {
        const code = (row[0] || '').trim();
        if (!code) continue;
        const foreignNet = intClean(row[4]) + intClean(row[7]); // 外陸資 + 外資自營商
        const trustNet = intClean(row[10]);
        const dealerNet = intClean(row[11]);
        const totalNet = intClean(row[18]);
        map[code] = {
          foreignNetLots: Math.round(foreignNet / 1000),
          trustNetLots: Math.round(trustNet / 1000),
          dealerNetLots: Math.round(dealerNet / 1000),
          totalNetLots: Math.round(totalNet / 1000),
        };
      }
      usedDate = date;
      break;
    }
  }

  // 上櫃補齊（2026-07-20 修正：T86 僅上市——台燿等上櫃股個股頁法人恆空）。
  // 用第二大腦 chipDaily（daemon 每日合併上市+上櫃+自營）補 T86 沒有的碼。
  try {
    const db = getAdminDb();
    if (db) {
      const cd = (await db.collection('chipDaily').orderBy('date', 'desc').limit(1).get()).docs[0];
      const m2 = cd?.data()?.codesJson ? JSON.parse(cd.data().codesJson) as Record<string, number[]> : null;
      if (m2) {
        let added = 0;
        for (const code in m2) {
          if (map[code]) continue;
          const [f, t, d] = m2[code];
          map[code] = { foreignNetLots: f || 0, trustNetLots: t || 0, dealerNetLots: d || 0, totalNetLots: (f || 0) + (t || 0) + (d || 0) };
          added++;
        }
        if (added > 0) console.warn(`[fundamentals] chipDaily 補上櫃法人 ${added} 檔（${cd!.data().date}）`);
      }
    }
  } catch { /* 第二大腦不可用時維持上市-only */ }

  return { map, date: usedDate };
}, { timeoutMs: 35_000, isDegraded: v => !Object.keys((v as { map: object }).map).length });

export async function getInstitutionalMap(): Promise<{ map: Record<string, Institutional>; date: string }> {
  return (await _inst()) ?? { map: {}, date: '' };
}

// ── Derived factors & risk flags ────────────────────────────
export interface FundamentalSignals {
  valuation: Valuation | null;
  margin: Margin | null;
  institutional: Institutional | null;
  /** −10..+10 contribution to score from valuation + chips. */
  bonus: number;
  reasons: string[];
  riskFlags: string[];
}

/**
 * Turn raw fundamentals/chips into a small score bonus, reasons and risk flags.
 * Conservative weights — meant to nudge, not dominate, the technical score.
 */
export function deriveFundamentalSignals(
  valuation: Valuation | null,
  margin: Margin | null,
  inst: Institutional | null,
): FundamentalSignals {
  const reasons: string[] = [];
  const riskFlags: string[] = [];
  let bonus = 0;

  // Valuation
  if (valuation) {
    if (valuation.pe != null && valuation.pe > 0 && valuation.pe < 12) { bonus += 3; reasons.push(`💲 本益比偏低 (PER ${valuation.pe})，評價具吸引力`); }
    else if (valuation.pe != null && valuation.pe > 60) { bonus -= 2; riskFlags.push(`⚠️ 本益比偏高 (PER ${valuation.pe})，評價偏貴`); }
    if (valuation.dividendYield != null && valuation.dividendYield >= 5) { bonus += 2; reasons.push(`💰 殖利率 ${valuation.dividendYield}%，現金流報酬佳`); }
    if (valuation.pb != null && valuation.pb > 0 && valuation.pb < 1) { bonus += 2; reasons.push(`📘 股價淨值比 < 1 (PBR ${valuation.pb})，低於帳面價值`); }
  }

  // Institutional chips (三大法人：外資 / 投信 / 自營商 + 一致性)
  if (inst) {
    const { foreignNetLots: f, trustNetLots: tr, dealerNetLots: dl, totalNetLots: tot } = inst;
    // 外資
    if (f >= 3000) { bonus += 4; reasons.push(`🌐 外資買超 ${f.toLocaleString()} 張，資金強力流入`); }
    else if (f >= 500) { bonus += 2; reasons.push(`🌐 外資買超 ${f.toLocaleString()} 張`); }
    else if (f <= -3000) { bonus -= 3; riskFlags.push(`🌐 外資賣超 ${Math.abs(f).toLocaleString()} 張，資金撤離`); }
    // 投信（ETF 多由投信發行，ETF 調節籌碼亦反映於此）
    if (tr >= 500) { bonus += 2; reasons.push(`🏦 投信買超 ${tr.toLocaleString()} 張（含 ETF 調節），作帳/認養訊號`); }
    else if (tr <= -1000) { bonus -= 1; riskFlags.push(`🏦 投信賣超 ${Math.abs(tr).toLocaleString()} 張`); }
    // 自營商
    if (dl >= 1000) { bonus += 1; reasons.push(`🏛️ 自營商買超 ${dl.toLocaleString()} 張，短線承接積極`); }
    else if (dl <= -1500) { bonus -= 1; riskFlags.push(`🏛️ 自營商賣超 ${Math.abs(dl).toLocaleString()} 張`); }
    // 三大法人一致性（最強訊號）
    const allBuy = f > 0 && tr > 0 && dl > 0;
    const allSell = f < 0 && tr < 0 && dl < 0;
    if (allBuy && tot >= 2000) { bonus += 2; reasons.push(`✅ 三大法人同步買超（合計 ${tot.toLocaleString()} 張），籌碼一致偏多`); }
    else if (allSell) { bonus -= 2; riskFlags.push(`⚠️ 三大法人同步賣超（合計 ${tot.toLocaleString()} 張），籌碼轉弱`); }
    else if (tot >= 5000) { bonus += 1; reasons.push(`✅ 三大法人合計買超 ${tot.toLocaleString()} 張`); }
  }

  // Margin (融資)
  if (margin) {
    if (margin.utilization >= 80) { bonus -= 3; riskFlags.push(`🔥 融資使用率 ${margin.utilization}%，籌碼過熱、回檔風險高`); }
    if (margin.changePct >= 15) { bonus -= 2; riskFlags.push(`🔥 融資餘額單日暴增 ${margin.changePct}%，散戶追高`); }
    else if (margin.changePct <= -15) { reasons.push(`🧹 融資餘額大減 ${margin.changePct}%，浮額清洗`); }
  }

  bonus = Math.max(-10, Math.min(10, bonus));
  return { valuation, margin, institutional: inst, bonus, reasons, riskFlags };
}

/** Convenience: fetch all three maps and derive signals for one code. */
export async function getFundamentalSignals(code: string): Promise<FundamentalSignals> {
  const [val, margin, inst] = await Promise.all([
    getValuationMap().catch(() => ({} as Record<string, Valuation>)),
    getMarginMap().catch(() => ({} as Record<string, Margin>)),
    getInstitutionalMap().catch(() => ({ map: {} as Record<string, Institutional>, date: '' })),
  ]);
  return deriveFundamentalSignals(val[code] ?? null, margin[code] ?? null, inst.map[code] ?? null);
}
