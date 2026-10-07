// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1：盤前名單（W30、上市流動一般股、市值權重、價格樣本宇宙）——純函式
//   規格 design-v2.1 §3.2、§3.3、§8.2、§11.3。名單盤前只在記憶體；首判時另寫一次 openSensorUniverse/{date} 存證。
//   輸入全部由呼叫端讀好（chipArchive 前一交易日 closeJson、發行股數正快取／本機官方鏡像、全額交割／處置鏡像），0 上游請求。
//   一般股只算上市（O5）；排除 ETF（00xx）、TDR（91xx）、全額交割與變更交易（TWT85U）、分盤處置股（處置公告）。
// ─────────────────────────────────────────────────────────────────────────
import { SUB_BASIS, P, rnd } from './open-sensor-params.mjs';

const num = v => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? n : null; };
/** 民國 '1151003'／'115/10/03'／西元 '20261003' → 'YYYY-MM-DD'；認不得回 null */
export function rocToIso(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{2,3})[/年-](\d{1,2})[/月-](\d{1,2})/);
  if (m) return `${+m[1] + 1911}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const d = s.replace(/\D/g, '');
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`;
  if (/^\d{7}$/.test(d)) return `${+d.slice(0, 3) + 1911}-${d.slice(3, 5)}-${d.slice(5)}`;
  return null;
}

/** 價格樣本宇宙代號（rho_probe2 同口徑：4 碼或 00xx） */
export const inSample = c => /^\d{4}$/.test(c) || /^00\d{2,4}$/.test(c);
/** 普通股代號：4 碼、非 00 開頭、非 91 開頭（TDR） */
export const isCommonCode = c => /^\d{4}$/.test(c) && !c.startsWith('00') && !c.startsWith('91');

/** 上市發行股數（t187ap03_L openapi payload）→ { map:{code:股數}, feedIso }（出表日期＝來源自報） */
export function sharesFromTsePayload(payload) {
  const map = {};
  let feedIso = null;
  for (const r of Array.isArray(payload) ? payload : []) {
    const c = String(r?.['公司代號'] ?? '').trim();
    const s = num(r?.['已發行普通股數或TDR原股發行股數']);
    if (/^\d{4}$/.test(c) && s > 0) map[c] = s;
    if (!feedIso && r?.['出表日期']) feedIso = rocToIso(r['出表日期']);
  }
  return { map, feedIso };
}

/** 上櫃發行股數（tpex_oa_mopsfin_t187ap03_O payload）→ { map, feedIso } */
export function sharesFromOtcPayload(payload) {
  const map = {};
  let feedIso = null;
  for (const r of Array.isArray(payload) ? payload : []) {
    const c = String(r?.SecuritiesCompanyCode ?? '').trim();
    const s = num(r?.IssueShares);
    if (/^\d{4}$/.test(c) && s > 0) map[c] = s;
    if (!feedIso && r?.Date) feedIso = rocToIso(r.Date);
  }
  return { map, feedIso };
}

/** TWT85U（變更交易／全額交割；PeriodicCallAuctionTrading='**' 為分盤集合競價）→ { full:Set, periodic:Set } */
export function fullDeliveryFromPayload(payload) {
  const full = new Set(), periodic = new Set();
  for (const r of Array.isArray(payload) ? payload : []) {
    const c = String(r?.Code ?? '').trim();
    if (!/^\d{4}$/.test(c)) continue;
    full.add(c);
    if (String(r?.PeriodicCallAuctionTrading ?? '').includes('*')) periodic.add(c);
  }
  return { full, periodic };
}

/**
 * rwd 處置公告（twse_punish 鏡像 payload：{fields, data}）→ 處置期間涵蓋 iso 且為「分盤／人工管制撮合」的代號。
 *   處置內容寫「撮合」（約每 N 分鐘撮合一次）＝分盤；期間「115/10/01～115/10/07」兩端都含。
 */
export function splitFromPunishPayload(payload, iso) {
  const out = new Set();
  const t = payload && Array.isArray(payload.fields) ? payload : null;
  if (!t || !Array.isArray(t.data)) return out;
  const fi = re => t.fields.findIndex(f => re.test(String(f)));
  const ic = fi(/證券代號/), ip = fi(/處置起迄/), im = fi(/處置內容/);
  if (ic < 0 || ip < 0) return out;
  for (const r of t.data) {
    const c = String(r?.[ic] ?? '').trim();
    if (!/^\d{4}$/.test(c)) continue;
    const parts = String(r?.[ip] ?? '').split(/[～~]/).map(x => rocToIso(x.trim()));
    if (parts.length < 2 || !parts[0] || !parts[1] || iso < parts[0] || iso > parts[1]) continue;
    if (im >= 0 && !/撮合/.test(String(r[im] ?? ''))) continue;
    out.add(c);
  }
  return out;
}

/**
 * 盤前名單（記憶體）。
 * @param {object} a
 * @param {string} a.date      今天（交易日曆推定；首拍 t00 回音驗證在 G5）
 * @param {string} a.prevYmd   前一交易日 'YYYY-MM-DD'
 * @param {object} a.closeMap  chipArchive/{prevYmd}.closeJson：{code:[收盤, 量張, 開, 高, 低]}
 * @param {object} a.sharesTse 上市發行股數 {code:股數}
 * @param {object|null} a.sharesOtc 上櫃發行股數（E′_otc 用；沒有＝null）
 * @param {object} a.marketOf  {code:'tse'|'otc'}（主迴圈代碼表，只用來認上市 ETF 進價格樣本）
 * @param {object} a.excl      { full:Set, periodic:Set, split:Set, src:{…} }
 */
export function buildUniverse({ date, prevYmd, closeMap, sharesTse, sharesOtc = null, marketOf = {}, excl = {}, sharesAsOf = null, sharesSrc = null }) {
  if (!closeMap || !sharesTse) throw new Error('名單輸入缺：前一交易日收盤或上市發行股數');
  const tse = {}, otc = {};
  let tseCap = 0, otcCap = 0, etf = 0, tdr = 0;
  const sample = new Set();
  for (const code of Object.keys(closeMap)) {
    const row = closeMap[code];
    const y = num(row?.[0]), lots = num(row?.[1]);
    if (!(y > 0)) continue;
    const isTse = sharesTse[code] > 0 || marketOf[code] === 'tse';
    if (isTse && inSample(code)) sample.add(code);
    if (isTse && /^00\d{2,4}$/.test(code)) etf++;
    if (isTse && /^91\d{2}$/.test(code)) tdr++;
    if (isCommonCode(code) && sharesTse[code] > 0) {
      const cap = y * sharesTse[code];
      tse[code] = { y, lots: lots ?? 0, cap };
      tseCap += cap;
    } else if (isCommonCode(code) && sharesOtc && sharesOtc[code] > 0 && marketOf[code] !== 'tse') {
      const cap = y * sharesOtc[code];
      otc[code] = { y, cap };
      otcCap += cap;
    }
  }
  const ranked = Object.keys(tse).sort((a, b) => tse[b].cap - tse[a].cap);
  if (ranked.length < 100) throw new Error(`上市普通股只有 ${ranked.length} 檔，名單不完整`);
  for (const c of ranked) tse[c].w = tse[c].cap / tseCap * 100;
  for (const c of Object.keys(otc)) otc[c].w = otc[c].cap / otcCap * 100;
  const w30 = ranked.slice(0, 30), w30Set = new Set(w30);
  const w30Cap = w30.reduce((s, c) => s + tse[c].cap, 0);
  const full = excl.full || new Set(), split = new Set([...(excl.split || []), ...(excl.periodic || [])]);
  let nFull = 0, nSplit = 0;
  const liquid = [];
  for (const c of ranked) {
    if (w30Set.has(c) || !(tse[c].lots >= P.liquidMinLots)) continue;
    if (full.has(c)) { nFull++; continue; }
    if (split.has(c)) { nSplit++; continue; }
    liquid.push(c);
  }
  return {
    basis: SUB_BASIS.universe, date, prevYmd, sharesAsOf, sharesSrc,
    tse, tseCap, w30, w30Set, w30Cap,
    w30CapPct: rnd(w30Cap / tseCap * 100, 2),
    tsmcCapPct: tse['2330'] ? rnd(tse['2330'].cap / tseCap * 100, 2) : null,
    tsmcInW30Pct: tse['2330'] && w30Set.has('2330') ? rnd(tse['2330'].cap / w30Cap * 100, 2) : null,
    liquid, liquidSet: new Set(liquid),
    otc: Object.keys(otc).length ? otc : null, otcCap,
    sample,
    excluded: { etf, tdr, fullDelivery: nFull, split: nSplit },
    exclSrc: excl.src || null,
  };
}

/** 文件用的名單摘要（openSensor/{date}.universe） */
export function universeSummary(u) {
  return {
    sharesAsOf: u.sharesAsOf ?? null, sharesSrc: u.sharesSrc ?? null, prevYmd: u.prevYmd,
    w30CapPct: u.w30CapPct, tsmcCapPct: u.tsmcCapPct, tsmcInW30Pct: u.tsmcInW30Pct,
    liquidN: u.liquid.length, liquidMinLots: P.liquidMinLots,
    otcN: u.otc ? Object.keys(u.otc).length : 0,
  };
}

/** 名單存證文件 openSensorUniverse/{date}（create() 寫一次；codesJson＝[[code, 昨量張], …] 字串） */
export function universeDoc(u, createdAt) {
  return {
    date: u.date, basis: SUB_BASIS.universe, createdAt,
    sharesAsOf: u.sharesAsOf ?? null, sharesSrc: u.sharesSrc ?? null, prevYmd: u.prevYmd,
    w30: u.w30.map(c => ({ code: c, capYi: rnd(u.tse[c].cap / 1e8, 0), wPct: rnd(u.tse[c].cap / u.w30Cap * 100, 3) })),
    tsmcCapPct: u.tsmcCapPct, w30CapPct: u.w30CapPct,
    liquid: { n: u.liquid.length, minLots: P.liquidMinLots, codesJson: JSON.stringify(u.liquid.map(c => [c, u.tse[c].lots])) },
    excluded: u.excluded,
    exclSrc: u.exclSrc ?? null,
  };
}
