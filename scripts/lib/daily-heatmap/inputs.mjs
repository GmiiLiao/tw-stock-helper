// ─────────────────────────────────────────────────────────────────────────────
// 每日熱力：讀第二大腦官方鏡像（唯讀、零上游請求）並解析成統一列。
//   只讀 second-brain/official 與 second-brain/wiki、backup/chipArchive；不 import 任何會打網路的模組。
//   欄位位置與陷阱的依據見 .claude/skills/tw-daily-heatmap/SKILL.md §2。
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

export const DS = {
  mi: ['www.twse.com.tw', 'twse_mi_index'],
  ref: ['www.twse.com.tw', 'twse_twt84u'],
  qfiis: ['www.twse.com.tw', 'twse_mi_qfiis'],
  t187: ['openapi.twse.com.tw', 'twse_oa_opendata_t187ap03_L'],
  tpex: ['www.tpex.org.tw', 'tpex_dailyquotes'],
};

/** 普通股：4 碼、首碼 1–9、非 91xx（TDR）。ETF（00xx）、特別股（含字母）、權證自然被排除。 */
export const isCommonStock = code => /^[1-9]\d{3}$/.test(code) && !code.startsWith('91');

export const num = v => {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '' || s === '--' || s === '---' || s === 'X') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** 台北民國日期 '115年10月02日'／'115/10/02'／'115.10.01'／'1151003'／'20261002' → 'YYYY-MM-DD' */
export function toIsoDate(v) {
  if (v == null) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (m) return `${+m[1] + 1911}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{2,3})\s*[年/.]\s*(\d{1,2})\s*[月/.]\s*(\d{1,2})/);
  if (m) return `${+m[1] + 1911}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

export function mirrorPaths(root) {
  const official = join(root, 'official');
  return {
    official,
    wiki: join(root, 'wiki', '_graph', 'stocks.json'),
    chip: join(root, 'backup', 'chipArchive'),
    out: join(root, 'daily-heatmap'),
  };
}

export function readJsonGz(file) {
  return JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
}

export function readManifest(official, [host, id]) {
  const f = join(official, host, id, '_manifest.json');
  if (!existsSync(f)) return null;
  return JSON.parse(readFileSync(f, 'utf8'));
}

/** 交易日清單＝上市 MI_INDEX 鏡像中 status=ok 的日期（舊→新）。「前一交易日」只准從這裡取，不用日曆減一。 */
export function tradingDates(official) {
  const man = readManifest(official, DS.mi);
  if (!man) return [];
  return Object.keys(man.rows || {}).filter(d => man.rows[d]?.status === 'ok').sort();
}

export function prevTradingDate(dates, s) {
  let prev = null;
  for (const d of dates) { if (d < s) prev = d; else break; }
  return prev;
}

/** 讀某資料集某日的檔；回 {entry, final, echo, file} 或 null（沒有／manifest 非 ok）。 */
export function readDataset(official, ds, date) {
  const man = readManifest(official, ds);
  const row = man?.rows?.[date];
  if (!row || row.status !== 'ok') return null;
  const file = join(official, ds[0], ds[1], row.file || `${date}.json.gz`);
  if (!existsSync(file)) return null;
  return { entry: readJsonGz(file), final: row.final === true, echo: row.echo ?? null, file };
}

/** 上市 MI_INDEX：個股收盤列、官方加權指數、家數、成交值合計。表一律用 title 定位。 */
export function parseMiIndex(entry) {
  const p = entry.payload || entry;
  const tables = p.tables || [];
  const stockT = tables.find(t => /每日收盤行情/.test(t?.title || ''));
  const idxT = tables.find(t => /價格指數\(臺灣證券交易所\)/.test(t?.title || ''));
  const breadthT = tables.find(t => t?.title === '漲跌證券數合計');
  const statT = tables.find(t => /大盤統計資訊/.test(t?.title || ''));
  const titleDay = toIsoDate(stockT?.title) || toIsoDate(statT?.title);
  const rows = new Map();
  for (const r of stockT?.data || []) {
    const code = String(r[0]).trim();
    rows.set(code, {
      code, name: String(r[1]).trim(), vol: num(r[2]), val: num(r[4]),
      open: num(r[5]), high: num(r[6]), low: num(r[7]), close: num(r[8]),
    });
  }
  // 官方加權指數：漲跌百分比偶為 '--'，一律用點數反推；符號含 green＝負
  let index = null;
  const ir = (idxT?.data || []).find(r => r[0] === '發行量加權股價指數');
  if (ir) {
    const close = num(ir[1]);
    const pts = num(ir[3]);
    const neg = /green/.test(String(ir[2]));
    index = { close, change: pts == null ? null : (neg ? -pts : pts) };
  }
  let breadth = null;
  if (breadthT) {
    const pick = label => {
      const r = breadthT.data.find(x => String(x[0]).startsWith(label));
      const m = String(r?.[2] ?? '').match(/^([\d,]+)(?:\((\d+)\))?/);
      return m ? { n: num(m[1]), limit: m[2] ? +m[2] : 0 } : null;
    };
    breadth = { up: pick('上漲'), down: pick('下跌'), flat: pick('持平') };
  }
  const gen = (statT?.data || []).find(r => String(r[0]).startsWith('1.一般股票'));
  return { titleDay, rows, index, breadth, officialStockValue: gen ? num(gen[1]) : null };
}

/** 上市 TWT84U：漲停價[2]、當日參考價[3]、跌停價[4]、前日收盤[6]（欄名「開盤競價基準」重複兩次，只能按位置取）。 */
export function parseTwt84u(entry) {
  const p = entry.payload || entry;
  const rows = new Map();
  for (const r of p.data || []) {
    const code = String(r[0]).trim();
    rows.set(code, { limitUp: num(r[2]), ref: num(r[3]), limitDown: num(r[4]), prevClose: num(r[6]), lastDeal: toIsoDate(r[9]) });
  }
  return { titleDay: toIsoDate(p.title) || toIsoDate(p.date), rows };
}

export function parseQfiis(entry) {
  const p = entry.payload || entry;
  const rows = new Map();
  for (const r of p.data || []) rows.set(String(r[0]).trim(), { shares: num(r[3]) });
  return { titleDay: toIsoDate(p.title) || toIsoDate(p.date), rows };
}

export function parseT187(entry) {
  const arr = entry.payload || entry;
  const rows = new Map();
  for (const r of Array.isArray(arr) ? arr : []) {
    const code = String(r['公司代號'] || '').trim();
    if (!code) continue;
    const ld = String(r['上市日期'] || '').trim();
    rows.set(code, {
      shares: num(r['已發行普通股數或TDR原股發行股數']),
      listDate: /^\d{8}$/.test(ld) ? `${ld.slice(0, 4)}-${ld.slice(4, 6)}-${ld.slice(6, 8)}` : null,
    });
  }
  return { echo: entry.meta?.echo ?? null, rows };
}

/** 上櫃 dailyQuotes：收盤[2]、漲跌[3]（可能是『除息／除權』中文）、發行股數[15]、次日參考價[16]、次日漲停[17]、次日跌停[18]。 */
export function parseTpex(entry) {
  const p = entry.payload || entry;
  const t = (p.tables || [])[0] || {};
  const rows = new Map();
  for (const r of t.data || []) {
    const code = String(r[0]).trim();
    rows.set(code, {
      code, name: String(r[1]).trim(), close: num(r[2]), chg: num(String(r[3]).replace(/[+\s]/g, '')),
      chgText: String(r[3]).trim(), open: num(r[4]), high: num(r[5]), low: num(r[6]),
      vol: num(r[8]), val: num(r[9]), shares: num(r[15]), nextRef: num(r[16]), nextLimitUp: num(r[17]), nextLimitDown: num(r[18]),
    });
  }
  return { titleDay: toIsoDate(t.date) || toIsoDate(p.date), rows };
}

/** wiki stocks.json：只取熱力用得到的欄位（其餘 AI 層欄位不讀，避免誤用）。 */
export function readWiki(file) {
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, 'utf8'));
  const stocks = new Map();
  for (const [code, v] of Object.entries(d.stocks || {})) {
    stocks.set(code, {
      name: v.name, market: v.market, industry: v.industry ?? null,
      chains: Array.isArray(v.chains) ? v.chains : [], group: v.group ?? null,
      families: [...new Set((v.productGeo || []).map(x => x?.family).filter(Boolean))],
      upstream: v.upstream || [], downstream: v.downstream || [],
    });
  }
  return { generatedAt: d.generatedAt ?? null, stocks };
}

/** chipArchive 法人（選用）：instJson＝{code:[外資, 投信]}（張）。檔案缺／空殼回 null；缺值＝來源未提供，不補 0。 */
export function readChipInst(chipDir, date) {
  const f = join(chipDir, `${date}.json`);
  if (!existsSync(f)) return null;
  try {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    if (!d.instJson) return null;
    const inst = JSON.parse(d.instJson);
    return Object.keys(inst).length ? inst : null;
  } catch { return null; }
}

// ── 發行股數校正（歷史日／t187 當日檔不存在時）─────────────────────────────────────────
// MI_QFIIS 的發行股數只在公司向外資持股系統申報時更新，分割／減資後會過期（緯穎 6669：2026-09-02 三比一分割，
// 股數 21 個交易日沒更新，歷史重建的指數殘差因此變紅）。t187ap03_L 只有當前快照、無法回補歷史。
// 校正規則（要同時滿足，才用 t187 當前股數取代該日 qfiis 股數；不憑「前收×股數連續」捏造股數）：
//   ① t187/qfiis 比值 ≥1.5 或 ≤1/1.5（分割／減資量級，一般增資不會這麼大）
//   ② 該日之前 30 個交易日內，twt84u 出現「參考價/前收」跳動 >25% 的事件日 e（分割、減資）
//   ③ 事件的價格比（前收/參考價）與 ① 的股數比相差 <15%（互相印證）
export function buildSharesFix({ official, dates, date, qfiis, t187Latest, windowDays = 30 }) {
  const fix = new Map();
  if (!qfiis || !t187Latest) return fix;
  const idx = dates.indexOf(date);
  const win = dates.slice(Math.max(0, idx - windowDays + 1), idx + 1);
  const cache = new Map();
  const refRows = d => { if (!cache.has(d)) { const e = readDataset(official, DS.ref, d); cache.set(d, e ? parseTwt84u(e.entry).rows : new Map()); } return cache.get(d); };
  for (const [code, a] of t187Latest.rows) {
    const b = qfiis.rows.get(code)?.shares;
    if (!isCommonStock(code) || !(a.shares > 0) || !(b > 0)) continue;
    const ratio = a.shares / b;
    if (ratio < 1.5 && ratio > 1 / 1.5) continue;
    for (const d of win) {
      const x = refRows(d).get(code);
      if (!x || !(x.prevClose > 0) || !(x.ref > 0)) continue;
      if (Math.abs(x.ref / x.prevClose - 1) <= 0.25) continue;
      if (Math.abs(ratio / (x.prevClose / x.ref) - 1) < 0.15) { fix.set(code, { from: b, to: a.shares, eventDay: d }); break; }
    }
  }
  return fix;
}

/** 目前鏡像中最新的 t187 快照（沒有就 null）。 */
export function latestT187(official) {
  const man = readManifest(official, DS.t187);
  const ds = man ? Object.keys(man.rows || {}).filter(d => man.rows[d]?.status === 'ok').sort() : [];
  const last = ds[ds.length - 1];
  const e = last ? readDataset(official, DS.t187, last) : null;
  return e ? { date: last, ...parseT187(e.entry) } : null;
}

// ── 除權息預告（現金股利／配股率）──────────────────────────────────────────────────────
// 加權指數是價格指數：現金股利不調整（除息日指數會機械性下跌），配股與現增由指數公司調整除數（市值中性）。
// 官方除權除息「計算結果表」TWT49U 只給「權值+息值」總額，拆不出現金／配股；預告表 TWT48U_ALL（鏡像每日快照）
// 有每股現金股利 CashDividend 與配股率 StockDividendRatio。鏡像只從 2026-10-02 起有快照 ⇒ 更早的日子無法拆分（維持舊口徑並標示）。
const TWT48U = ['openapi.twse.com.tw', 'twse_oa_exchangeReport_TWT48U_ALL'];

/** 取「資料日 ≤ date」最新一份預告快照中、除權息日＝date 的個股。回 Map code→{type,c,g,sub,snapshot}；無快照回 null。 */
export function loadExDivPlan(official, date) {
  const man = readManifest(official, TWT48U);
  const snaps = man ? Object.keys(man.rows || {}).filter(d => man.rows[d]?.status === 'ok' && d <= date).sort() : [];
  const snap = snaps[snaps.length - 1];
  if (!snap) return null;
  const e = readDataset(official, TWT48U, snap);
  if (!e) return null;
  const plan = new Map();
  for (const r of Array.isArray(e.entry.payload) ? e.entry.payload : []) {
    if (toIsoDate(r.Date) !== date) continue;
    const code = String(r.Code || '').trim();
    if (!isCommonStock(code)) continue;
    plan.set(code, { type: r.Exdividend || null, c: num(r.CashDividend) ?? 0, g: num(r.StockDividendRatio) ?? 0, sub: num(r.SubscriptionRatio) ?? 0, snapshot: snap });
  }
  return plan;
}
