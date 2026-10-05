// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊·資料包（W1）buildPack({ date, edition, root, fsGet, now, riskPolicy }) → CONTRACT §2 的 pack
//   · 純讀：本機 second-brain 檔＋注入的 fsGet（Firestore 只 get）。不打網路、不 import firebase-admin。
//   · 確定性：同輸入（含 now）同輸出；refs 依 id 碼位序、其餘陣列順序由規則決定；pack 內無牆鐘時間戳（只有 meta.cutoff 這個推導值）。
//   · 時點隔離：cutoff＝min(now, 版次資料截止)——evening＝D 當日 23:59:59（台北）、morning＝D 的下一個日曆日 07:30。
//     Firestore 來源一律以各筆自身時間戳（verdict.at／item.at／quoteAt／updatedAt）濾掉 cutoff 之後者；ref.asOf＝資訊日（不是適用日）。
//   · 缺就 absent、不捏造；degraded 記降級原因（'calendar:approx'、'global:overnight-not-updated'…）。
//   ⚠ 契約出入處見 pack-refs.mjs 檔頭（prev/diff 命名空間 vs 文法）；其餘見最終回報。
// ─────────────────────────────────────────────────────────────────────────────
import { join } from 'node:path';
import { classifyOfficial, rankMediaVerdicts } from '../after-market-news.mjs';
import {
  mirrorTradingDates, latestHeatmapDay, readHeatmapDay, readMiIndexDay, readMiStockValueDay, readTpexQuotesDay, readInstDay, readBfi82uDay,
  readChipArchiveDay, readTaifexDay, readRiskSnapshot, readWikiStocks, readListingDates, readOtcIndexDays,
  readNewsVerdictDoc, readMopsNewsDoc, readNewsDigest, readGlobalMarkets, readAsiaPremarket, readAdrPremium, readSectorSpot,
  readTaifexPositions, readCatalystCalendar, readDividendCalendar, readTradingCalendar,
  tpeDate, tpeHHMM, taipeiMs, addDays, weekdayOf, isoOfMs,
} from './pack-sources.mjs';
import {
  RefBook, rnd, seg, industryView, addMarketRefs, addIndustryRefs, addWatchLayerRefs, estimateInstBn, creditFromChip, addChipRefs,
  addGlobalRefs, addDigestRefs, addCalendarRefs, PREV_NS,
} from './pack-refs.mjs';
import {
  POOL_RULE, POOL_MAX, NEW_LISTING_MIN_DAYS, MIN_VAL_YI, EXCLUDE_ANY_LIMIT, stockUniverse, evalRisk, makeChecker, buildCardPool,
} from './pack-pool.mjs';

export { PREV_NS, POOL_RULE };
export const EDITIONS = ['evening', 'morning'];
const CARDS = ['prev', 'data', 'next'];
const CLOSE_HHMM = '13:30';
const MO_TOP = 12; // 每範圍官方公告排行前 N 群組入 refs（另加候選池股票的全部群組）
const NV_TOP = 8;  // 每範圍媒體判別方向性前 N 檔入 refs（另加候選池股票）

/**
 * 版次的資料截止時刻（台北）：evening＝D 當日結束（23:59:59）；morning＝D 下一個日曆日 07:30（排程硬死線）。
 * 實際 cutoff＝min(now, 此值)：即時跑＝跑的當下（輪詢可能落在 23:20–00:30），重播舊日＝此值——兩者都不會看到版次之後的資料。
 * evening 不含 D 之後的日曆日資料（否則 N 為隔日時會偷看 N 日資料）。
 */
export function nominalCutoffMs(D, edition) {
  return edition === 'evening' ? taipeiMs(D, 23, 59) + 59_999 : taipeiMs(addDays(D, 1), 7, 30);
}

/** 下一交易日：以 system/tradingCalendar 的休市日推（週末與休市日略過）；取不到＝下一個平日並標 approx。 */
export function nextTradingDay(D, calRes, mirrorDays = []) {
  const approx = !calRes || calRes.absent;
  const hol = new Set(approx ? [] : calRes.data.holidays);
  let from = null;
  for (let i = 1; i <= 21 && !from; i++) {
    const c = addDays(D, i);
    const wd = weekdayOf(c);
    if (wd === 0 || wd === 6 || hol.has(c)) continue;
    from = c;
  }
  const cover = !approx && calRes.data.coverYear != null && Number(from.slice(0, 4)) > calRes.data.coverYear;
  const actual = mirrorDays.find(d => d > D) ?? null; // 重播舊日時，鏡像已有真實的下一交易日
  const holidaysAhead = approx ? [] : calRes.data.holidays.filter(h => h > D && h <= addDays(D, 30));
  return { N: actual ?? from, approx: approx || cover, mismatch: actual != null && actual !== from, holidaysAhead };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniq = a => [...new Set(a)];
const isMinutesAfterClose = ms => {
  const d = tpeDate(ms);
  const wd = weekdayOf(d);
  return wd === 0 || wd === 6 || tpeHHMM(ms) >= CLOSE_HHMM;
};

// ── 官方公告（O）分組 ─────────────────────────────────────────────────────────────
/** 依 code|類型 分組（類型取主旨規則 classifyOfficial，僅供參考；比對不到＝'U' 未分類）。例行（權重 0）與未分類只計數、除非屬池內股票。 */
function groupOfficial(items) {
  const groups = new Map();
  let routine = 0; let unclassified = 0;
  for (const it of items) {
    const c = classifyOfficial(it.subject);
    if (c.id === null) unclassified++;
    else if (c.weight === 0) routine++;
    const type = c.id ?? 'U';
    const k = `${it.code}|${type}`;
    const g = groups.get(k) || groups.set(k, { code: it.code, name: it.name ?? null, type, label: c.label, weight: c.weight ?? 0, dir: c.dir, items: [] }).get(k);
    g.items.push(it);
  }
  for (const g of groups.values()) g.items.sort((a, b) => a.at - b.at || cmp(a.key, b.key));
  const ranked = [...groups.values()].filter(g => g.weight > 0).sort((a, b) => b.weight - a.weight || b.items.length - a.items.length || b.items.at(-1).at - a.items.at(-1).at || cmp(a.code, b.code));
  return { groups, ranked, total: items.length, routine, unclassified };
}

const FLAG_NAMES = [[4, '鎖死漲停'], [1, '漲停'], [2, '跌停'], [32, '除權息'], [64, '無漲跌幅']];
const flagsText = f => { const t = FLAG_NAMES.filter(([b]) => ((f || 0) & b) !== 0).map(([, n]) => n); return t.length ? t.join('、') : '無'; };
const NEXT_NS = ['gl', 'fx', 'adr', 'cal', 'mo', 'nv'];
const verdictOk = v => v && v.basis === 'content' && !v.gate;
const POS_STRENGTH = new Set(['中', '強', '極強']);
const POS_CONF = new Set(['高', '中']);

export async function buildPack({ date, edition = 'evening', root, fsGet = null, now = Date.now(), riskPolicy = 'strict' } = {}) {
  if (!EDITIONS.includes(edition)) throw new Error(`edition 必須是 ${EDITIONS.join('|')}`);
  if (!root) throw new Error('需要 root（second-brain 目錄）');
  if (!['strict', 'lenient'].includes(riskPolicy)) throw new Error('riskPolicy 必須是 strict|lenient');
  const official = join(root, 'official');
  const absent = []; const degraded = []; const inputs = {};
  const note = (name, res, dataDate) => {
    if (!res) return;
    if (res.absent) absent.push(`${res.source}${res.reason ? `(${res.reason})` : ''}`);
    else inputs[name] = { dataDate: dataDate ?? null, echo: res.echo ?? null, sha256: res.sha256 ?? null };
    for (const p of res.absentParts || []) absent.push(p);
  };

  // ── 日期 ──
  const td = mirrorTradingDates(official);
  const D = date ?? latestHeatmapDay(root);
  if (!D) throw new Error('無資料日：未指定 date，且 daily-heatmap/latest.json 不存在');
  const iD = td.indexOf(D);
  if (iD < 0) throw new Error(`${D} 不在官方鏡像交易日清單（MI_INDEX manifest）`);
  if (iD < 2) throw new Error(`${D} 之前的交易日不足 2 個`);
  const P = td[iD - 1]; const P2 = td[iD - 2]; const PP = P2;
  const calRes = await readTradingCalendar(fsGet);
  note('tradingCalendar', calRes, null);
  const nt = nextTradingDay(D, calRes, td);
  const N = nt.N;
  if (nt.approx) degraded.push('calendar:approx');
  if (nt.mismatch) degraded.push('calendar:mismatch-with-mirror');
  const cutoffMs = Math.min(now, nominalCutoffMs(D, edition));

  // ── 熱力（P1／P2 閘門）──
  const hdRes = readHeatmapDay(root, D);
  if (hdRes.absent) throw new Error(`熱力 ${D} 不可用（${hdRes.reason}）——P1 硬閘門，不組包`);
  const hpRes = readHeatmapDay(root, P);
  note('dailyHeatmap.data', hdRes, D); note('dailyHeatmap.prev', hpRes, P);
  const hd = hdRes.data.payload; const hp = hpRes.absent ? null : hpRes.data.payload;
  if (hdRes.data.rebuilt) degraded.push('heatmap:data-rebuilt');
  if (hp && hpRes.data.rebuilt) degraded.push('heatmap:prev-rebuilt');
  if (!hp) degraded.push('heatmap:prev-missing');

  // ── 官方鏡像／本機 ──
  const miD = readMiIndexDay(root, D); const miP = readMiIndexDay(root, P); const miPP = readMiIndexDay(root, P2);
  const tpD = readTpexQuotesDay(root, D); const tpP = readTpexQuotesDay(root, P); const tpPP = readTpexQuotesDay(root, P2);
  const instD = readInstDay(root, D); const instP = readInstDay(root, P); const instPP = readInstDay(root, P2);
  const bfiD = readBfi82uDay(root, D); const bfiP = readBfi82uDay(root, P);
  const chipD = readChipArchiveDay(root, D); const chipP = readChipArchiveDay(root, P);
  const taD = readTaifexDay(root, D); const taP = readTaifexDay(root, P);
  const riskD = readRiskSnapshot(root, D); let riskP = readRiskSnapshot(root, P);
  const wikiRes = readWikiStocks(root); const listRes = readListingDates(root);
  const otcRes = readOtcIndexDays(root, [D, P, P2]);
  for (const [n, r, d] of [['twse_mi_index.data', miD, D], ['twse_mi_index.prev', miP, P], ['tpex_dailyquotes.data', tpD, D], ['tpex_dailyquotes.prev', tpP, P],
    ['inst.data', instD, D], ['inst.prev', instP, P], ['twse_bfi82u.data', bfiD, D], ['twse_bfi82u.prev', bfiP, P], ['chipArchive.data', chipD, D], ['chipArchive.prev', chipP, P],
    ['taifex.data', taD, D], ['taifex.prev', taP, P], ['risk.data', riskD, D], ['risk.prev', riskP, P], ['wiki', wikiRes, null], ['listingDates', listRes, null], ['otcIndex', otcRes, null]]) note(n, r, d);
  for (const r of [miPP, tpPP, instPP]) { if (r.absent) absent.push(`${r.source}(${r.reason ?? 'absent'})`); for (const p of r.absentParts || []) absent.push(p); }
  const wiki = wikiRes.absent ? null : wikiRes.data;
  if (wiki && wiki.generatedAt && wiki.generatedAt > D) degraded.push(`wiki:non-pit(generatedAt=${wiki.generatedAt})`);
  const listing = listRes.absent ? null : listRes.data.map;
  if (!listing) degraded.push('listing:unavailable');

  // 量比（對前 5／20 個交易日均值；全部要有值才算）
  const valCache = new Map();
  const valOf = day => { if (!valCache.has(day)) valCache.set(day, readMiStockValueDay(root, day)); return valCache.get(day); };
  const ratioOf = (day, n) => {
    const i = td.indexOf(day); if (i < n) return null;
    const vals = td.slice(i - n, i).map(valOf);
    const v = valOf(day);
    if (v == null || vals.some(x => x == null)) return null;
    return (v / (vals.reduce((a, b) => a + b, 0) / n)) * 100;
  };
  const stockVal = { ratio5D: ratioOf(D, 5), ratio20D: ratioOf(D, 20), ratio5P: ratioOf(P, 5), ratio20P: ratioOf(P, 20) };

  // ── Firestore ──
  const dig = tpeDate(cutoffMs);
  const mopsDays = []; for (let d = addDays(D, 1); d <= dig && mopsDays.length < 8; d = addDays(d, 1)) mopsDays.push(d);
  const [nvP, nvD, nvN, mopsP, mopsD, gm, asia, adr, spot, tpos, cal, div] = await Promise.all([
    readNewsVerdictDoc(fsGet, P), readNewsVerdictDoc(fsGet, D), readNewsVerdictDoc(fsGet, N),
    readMopsNewsDoc(fsGet, P), readMopsNewsDoc(fsGet, D),
    readGlobalMarkets(fsGet), readAsiaPremarket(fsGet), readAdrPremium(fsGet), readSectorSpot(fsGet), readTaifexPositions(fsGet),
    readCatalystCalendar(fsGet), readDividendCalendar(fsGet),
  ]);
  const mopsLater = await Promise.all(mopsDays.map(d => readMopsNewsDoc(fsGet, d)));
  let digest = await readNewsDigest(fsGet, dig);
  if (digest.absent) digest = await readNewsDigest(fsGet, 'latest');
  for (const [n, r] of [['newsVerdict.prev', nvP], ['newsVerdict.data', nvD], ['newsVerdict.next', nvN], ['mopsNews.prev', mopsP], ['mopsNews.data', mopsD],
    ['globalMarkets', gm], ['asiaPremarket', asia], ['adrPremium', adr], ['sectorSpot', spot], ['taifexPositions', tpos], ['catalystCalendar', cal], ['dividendCalendar', div], ['newsDigest', digest]]) note(n, r, null);
  mopsLater.forEach((r, i) => note(`mopsNews.${mopsDays[i]}`, r, mopsDays[i]));
  // 站內 taifexPositions 只當備援（官方鏡像缺時用 P/C）；foreignTxfNetOI 口徑不符，讀取器根本不暴露
  const taDataD = taD.absent ? {} : { ...taD.data };
  if (taDataD.putCall == null && !tpos.absent && tpos.echo === D && tpos.data.putCallOi != null) {
    taDataD.putCall = { oiRatio: tpos.data.putCallOi, volRatio: null };
    degraded.push('taifex:pcOi-from-site-taifexPositions');
  }

  // ── 收盤價／身分／法人（逐檔，億元估）──
  const closeMapOf = (mi, tp) => ({ tse: mi.absent ? new Map() : mi.data.rows, otc: tp.absent ? new Map() : tp.data.rows });
  const cmD = closeMapOf(miD, tpD); const cmP = closeMapOf(miP, tpP); const cmPP = closeMapOf(miPP, tpPP);
  const closeIn = cm => code => cm.tse.get(code)?.close ?? cm.otc.get(code)?.close ?? null;
  const instBn = (inst, cm) => {
    const closeOf = closeIn(cm); const out = new Map();
    for (const [mkt, src] of [['tse', inst.data.tse], ['otc', inst.data.otc]]) {
      if (!src) continue;
      for (const [code, r] of src.rows) {
        if (!/^\d{4}$/.test(code)) continue;
        const px = closeOf(code);
        if (px == null || r.foreign == null || r.trust == null) continue;
        out.set(code, { foreign: (r.foreign * px) / 1e8, trust: (r.trust * px) / 1e8, mkt });
      }
    }
    return out;
  };
  const ibD = instBn(instD, cmD); const ibP = instBn(instP, cmP); const ibPP = instBn(instPP, cmPP);
  const haveInst = x => x.data.tse || x.data.otc;
  const estOf = (inst, cm) => ({
    tse: inst.data.tse ? estimateInstBn(inst.data.tse.rows, closeIn({ tse: cm.tse, otc: new Map() })) : null,
    otc: inst.data.otc ? estimateInstBn(inst.data.otc.rows, closeIn({ tse: new Map(), otc: cm.otc })) : null,
  });
  const estD = haveInst(instD) ? estOf(instD, cmD) : null; const estP = haveInst(instP) ? estOf(instP, cmP) : null;

  const wk = code => wiki?.stocks?.[code] ?? null;
  const marketOf = cm => code => wk(code)?.market ?? (cm.tse.has(code) ? '上市' : cm.otc.has(code) ? '上櫃' : null);
  const identity = cm => code => {
    const w = wk(code);
    if (w) return { name: w.name, market: w.market, industry: w.industry };
    const r = cm.tse.get(code) ?? cm.otc.get(code);
    return r ? { name: r.name ?? null, market: cm.tse.has(code) ? '上市' : '上櫃', industry: null } : null;
  };

  // ── 新聞（M／O）以 cutoff 濾；O 分 prev／data／next 三個範圍 ──
  const scopeVerdicts = res => {
    const m = new Map();
    if (res.absent) return m;
    for (const [code, v] of Object.entries(res.data.verdicts)) if (v && Number.isFinite(v.at) && v.at <= cutoffMs && /^\d{4}$/.test(code)) m.set(code, v);
    return m;
  };
  const nvScope = { prev: scopeVerdicts(nvP), data: scopeVerdicts(nvD), next: scopeVerdicts(nvN) };
  const rankedV = map => rankMediaVerdicts(Object.fromEntries(map), { limit: 100000 }).items.filter(x => verdictOk(map.get(x.code)));
  const posCodes = map => rankedV(map).filter(x => x.label === '利多').map(x => x.code).filter(code => {
    const v = map.get(code);
    return v.certainty !== '傳聞' && POS_CONF.has(v.confidence) && POS_STRENGTH.has(v.strength);
  });
  const topCodes = (map, k) => rankedV(map).slice(0, k).map(x => x.code);

  const itemsOk = res => (res.absent ? [] : res.data.items.filter(x => Number.isFinite(x.at) && x.at <= cutoffMs));
  const closeD = taipeiMs(D, 13, 30);
  const mopsAll = [...mopsLater.flatMap(itemsOk)];
  const oScope = {
    prev: itemsOk(mopsP),
    data: itemsOk(mopsD),
    next: [...itemsOk(mopsD).filter(x => x.at >= closeD), ...mopsAll],
  };
  const noTimeItems = [mopsP, mopsD, ...mopsLater].reduce((n, r) => n + (r.absent ? 0 : r.data.items.filter(x => !Number.isFinite(x.at)).length), 0);
  if (noTimeItems) degraded.push(`mops:items-without-time:${noTimeItems}`);
  const oGroups = { prev: groupOfficial(oScope.prev), data: groupOfficial(oScope.data), next: groupOfficial(oScope.next) };
  const offCodes = scope => uniq(oGroups[scope].ranked.filter(g => g.dir !== '−').map(g => g.code)).filter(c => /^\d{4}$/.test(c));

  // 行事曆（先放 refs 才能拿到 N 日法說代號與除權息 id）
  const book = new RefBook();
  const calOut = addCalendarRefs(book, { D, N, cal });
  for (const a of calOut.absent) absent.push(a);
  if (calOut.nonPit) degraded.push('calendar:non-pit(updatedAt>D)');
  const callCodes = uniq((calOut.events || []).filter(e => e.date === N && e.type === 'earnings-call' && e.code).map(e => e.code));
  const exdivIds = new Map(); // code → ref id（N 日除權息）
  for (const e of calOut.events || []) if (e.date === N && e.type === 'exdiv' && e.code) exdivIds.set(e.code, e.id);

  // ── 候選池 ──
  const risk = {
    prev: (() => {
      if (!riskP.absent) return evalRisk(riskP, { activeDay: P, policy: riskPolicy });
      if (riskPolicy === 'lenient' && !riskD.absent) { degraded.push('risk:prev-uses-data-day-snapshot(lenient)'); return evalRisk(riskD, { activeDay: P, policy: riskPolicy }); }
      return evalRisk(null, { activeDay: P, policy: riskPolicy });
    })(),
    data: evalRisk(riskD, { activeDay: D, policy: riskPolicy }),
    next: evalRisk(riskD, { activeDay: N, policy: riskPolicy }),
  };
  for (const k of CARDS) for (const m of ['tse', 'otc']) {
    if (risk[k].partial[m]) degraded.push(`risk:partial:${k}:${m === 'tse' ? '上市' : '上櫃'}(當日注意股名單缺)`);
    if (!risk[k].verified[m]) degraded.push(`risk:unverifiable:${k}:${m === 'tse' ? '上市' : '上櫃'}`);
  }
  const universe = { prev: hp ? stockUniverse(hp) : new Map(), data: stockUniverse(hd) };
  const cardCtx = {
    prev: { H: hp, stocks: universe.prev, cm: cmP, inst: haveInst(instP) ? ibP : null, asOfDay: P, news: 'prev' },
    data: { H: hd, stocks: universe.data, cm: cmD, inst: haveInst(instD) ? ibD : null, asOfDay: D, news: 'data' },
    next: { H: hd, stocks: universe.data, cm: cmD, inst: haveInst(instD) ? ibD : null, asOfDay: D, news: 'next' },
  };
  const pools = {}; const excluded = {};
  for (const k of CARDS) {
    const c = cardCtx[k];
    const check = makeChecker({ stocks: c.stocks, marketOf: marketOf(c.cm), risk: risk[k], listing, tradingDays: td, asOfDay: c.asOfDay });
    const r = buildCardPool({
      H: c.H, stocks: c.stocks, check, identity: identity(c.cm), inst: c.inst,
      newsCodes: posCodes(nvScope[c.news]), officialCodes: offCodes(c.news), calCodes: k === 'next' ? callCodes : [], max: POOL_MAX,
    });
    pools[k] = r.pool; excluded[k] = r.excluded;
    for (const s of r.skippedGenerators) degraded.push(`pool:${k}:${s}`);
  }
  const poolCodes = { prev: new Set(pools.prev.map(x => x.code)), data: new Set(pools.data.map(x => x.code)), next: new Set(pools.next.map(x => x.code)) };
  const allCodes = [...new Set([...poolCodes.prev, ...poolCodes.data, ...poolCodes.next])].sort(cmp);

  // ── refs：市場／指數／廣度／籌碼 ──
  addMarketRefs(book, {
    D, P, hd, hp, miD: miD.data, miP: miP.data, stockVal,
    otcD: otcRes.data?.closeByDay?.[D] ?? null, otcP: otcRes.data?.closeByDay?.[P] ?? null, otcPP: otcRes.data?.closeByDay?.[PP] ?? null,
  });
  // 產業：熱度前 8＋後 3＋前一日前 5＋watch.continue
  const vD = industryView(hd); const vP = industryView(hp);
  const orderOf = v => [...v.entries()].filter(([, x]) => x.heatNo != null).sort((a, b) => a[1].heatNo - b[1].heatNo).map(([k]) => k);
  const oD = orderOf(vD); const oP = orderOf(vP);
  const indKeys = uniq([...oD.slice(0, 8), ...oD.slice(-3), ...oP.slice(0, 5), ...(hd.watch?.continue || []).map(w => w.key)]).filter(k => vD.has(k) || vP.has(k));
  const lead = new Map();
  const nameOf = code => identity(cmD)(code)?.name ?? identity(cmP)(code)?.name ?? code;
  for (const key of indKeys) {
    const top = [...universe.data.values()].filter(s => s.industry === key && s.valM >= MIN_VAL_YI * 100).sort((a, b) => b.ret - a.ret || cmp(a.code, b.code)).slice(0, 3);
    if (top.length) lead.set(key, top.map(s => `${s.code}${nameOf(s.code)}${s.ret >= 0 ? '+' : ''}${s.ret.toFixed(2)}%`).join('、'));
  }
  addIndustryRefs(book, { D, P, vD, vP, keys: indKeys, lead });
  addWatchLayerRefs(book, { D, H: hd });
  const crD = chipD.absent ? null : creditFromChip(chipD.data); const crP = chipP.absent ? null : creditFromChip(chipP.data);
  addChipRefs(book, {
    D, P, estD, estP, bfiD: bfiD.absent ? null : bfiD.data, bfiP: bfiP.absent ? null : bfiP.data, crD, crP,
    taD: taDataD, taP: taP.absent ? null : taP.data,
  });
  // 全球
  const gl = addGlobalRefs(book, { D, cutoffMs, gm, asia, adr, spot });
  for (const x of gl.degraded) degraded.push(x);
  for (const x of gl.absent) absent.push(x);
  const dg = addDigestRefs(book, { D, cutoffMs, digest });
  for (const x of dg.absent) absent.push(x);

  // ── refs：候選個股事實 ──
  const NV = '媒體'; const OFF = '官方'; const DER = '官方衍生';
  const stSrc = '每日熱力定版（官方收盤自算）';
  const px = (cm, code) => closeIn(cm)(code);
  const stockRefs = (code, k, asOf, U, cm, ibMap) => {
    const sfx = k === 0 ? '' : k === 1 ? 'prev' : 'prev2';
    const nm = base => (sfx ? `${sfx}${base[0].toUpperCase()}${base.slice(1)}` : base);
    const s = U?.get(code);
    const add = (base, v, unit, fmt, tier, source, label) => v != null && book.add(`st.${code}.${nm(base)}`, { v, unit, fmt, asOf, tier, source, label });
    if (s) {
      add('ret', rnd(s.ret, 2), '%', 'sg2', DER, stSrc, '當日報酬（官方參考價口徑，未扣成本）');
      add('valM', s.valM, '百萬', 'int', DER, stSrc, '當日成交值（百萬元）');
      add('close', px(cm, code), '元', 'txt', OFF, '證交所 MI_INDEX／櫃買日收盤', '當日收盤價');
      add('flags', flagsText(s.flags), '文字', 'txt', DER, stSrc, '當日價格旗標（漲停／跌停／鎖死漲停／除權息／無漲跌幅；無＝皆無）');
      if (k === 0) add('lockU', ((s.flags || 0) & 4) !== 0, '文字', 'txt', DER, stSrc, '是否鎖死漲停（買不到）');
      if (k === 0) {
        add('res', s.res, '文字', 'txt', '先驗·未驗證', stSrc, '共振標籤A族群/B產業/C個股獨行/D無連結（緊密鍵可能含AI待驗層）');
      }
    }
    const ib = ibMap?.get(code);
    if (ib) {
      add('fgnBn', rnd(ib.foreign, 1), '億', 'bn1', DER, '三大法人逐檔×收盤價（估）', '外資買賣超（估：股數×收盤價）');
      add('trustBn', rnd(ib.trust, 1), '億', 'bn1', DER, '三大法人逐檔×收盤價（估）', '投信買賣超（估：股數×收盤價）');
    }
  };
  for (const code of allCodes) {
    const w = wk(code);
    const id = identity(cmD)(code) ?? identity(cmP)(code);
    const s = universe.data.get(code) ?? universe.prev.get(code);
    const industry = universe.data.get(code)?.industry ?? universe.prev.get(code)?.industry ?? id?.industry ?? null;
    if (id?.market) book.add(`st.${code}.market`, { v: id.market, unit: '文字', fmt: 'txt', asOf: D, tier: OFF, source: 'wiki 官方欄（MOPS 公司基本資料）', label: '市場別' });
    if (industry) book.add(`st.${code}.industry`, { v: industry, unit: '文字', fmt: 'txt', asOf: D, tier: OFF, source: '官方產業別', label: '官方產業別' });
    if (s || universe.data.has(code)) stockRefs(code, 0, D, universe.data, cmD, ibD);
    if (universe.prev.has(code) || ibP.has(code)) stockRefs(code, 1, P, universe.prev, cmP, ibP);
    if (poolCodes.prev.has(code) && ibPP.has(code)) stockRefs(code, 2, P2, null, cmPP, ibPP);
    if (hd.watch?.risk?.some(x => x.key === code)) book.add(`st.${code}.watch`, { v: '追價風險', unit: '文字', fmt: 'txt', asOf: D, tier: '先驗·未驗證', source: '每日熱力 watch.risk', label: '個股獨行大漲，歷史上隔日多半小幅回吐（描述統計，非訊號）' });
    if (hp?.watch?.risk?.some(x => x.key === code)) book.add(`st.${code}.prevWatch`, { v: '追價風險', unit: '文字', fmt: 'txt', asOf: P, tier: '先驗·未驗證', source: '每日熱力 watch.risk（前一日）', label: '個股獨行大漲，歷史上隔日多半小幅回吐（描述統計，非訊號）' });
    // 風險旗標部分缺（lenient）：揭露「注意股名單缺」（prev 卡用 prevRisk，asOf＝D−1，避免時點隔離死結）
    for (const k of CARDS) {
      if (!poolCodes[k].has(code)) continue;
      const mk = marketOf(cardCtx[k].cm)(code) === '上市' ? 'tse' : 'otc';
      if (!risk[k].partial[mk]) continue;
      const rid = k === 'prev' ? `st.${code}.prevRisk` : `st.${code}.risk`;
      if (!book.has(rid)) book.add(rid, { v: `${mk === 'tse' ? '上市' : '上櫃'}當日注意股名單來源缺，無法排除注意股`, unit: '文字', fmt: 'txt', asOf: k === 'prev' ? P : D, tier: OFF, source: '風險旗標快照', label: '風險旗標部分不可驗證（riskPolicy=lenient）' });
    }
    // wiki 標籤
    if (w) {
      const WK = '台股 wiki（stocks.json）';
      const wasOf = wiki.generatedAt && wiki.generatedAt < D ? wiki.generatedAt : D;
      const add = (n, v, tier, label) => v && book.add(`wk.${code}.${n}`, { v, unit: '文字', fmt: 'txt', asOf: wasOf, tier, source: WK, label });
      add('industry', w.industry, OFF, '官方產業別（MOPS t05st03）');
      add('chains', (w.chains || []).map(c => `${c.name}/${c.role ?? ''}${c.label ? `·${c.label}` : ''}`).join('、'), '站內整理', '主題鏈（人工 seed；位置≠供應關係）');
      add('group', w.group, '站內整理', '集團關聯（持股標籤；傳導屬推論）');
      add('upstream', (w.derivedUpstream || []).slice(0, 8).join('、'), DER, '年報推導上游（兩端原文逐字相同）');
      add('downstream', (w.derivedDownstream || []).slice(0, 8).join('、'), DER, '年報推導下游（兩端原文逐字相同）');
      add('aiUp', (w.derivedUpstreamAi || []).slice(0, 8).join('、'), 'AI待驗', 'AI 推導上游（待驗；只當標籤，不是事實）');
      add('aiDown', (w.derivedDownstreamAi || []).slice(0, 8).join('、'), 'AI待驗', 'AI 推導下游（待驗；只當標籤，不是事實）');
    }
  }

  // ── refs：媒體判別 nv.*（M）與官方公告 mo.*（O）——兩個子樹、不提供合計 ──
  const nvId = (code, scope, f) => `nv.${code}${scope === 'data' ? '' : `.${scope}`}.${f}`;
  const nvSrc = 'newsVerdict（AI 讀完內文後的判別結果；不含新聞內文）';
  const nvCodes = {};
  for (const scope of CARDS) {
    nvCodes[scope] = uniq([...poolCodes[scope], ...topCodes(nvScope[scope], NV_TOP)]).filter(c => nvScope[scope].has(c)).sort(cmp);
    for (const code of nvCodes[scope]) {
      const v = nvScope[scope].get(code);
      const asOf = tpeDate(v.at);
      const add = (f, val, label) => val != null && val !== '' && book.add(nvId(code, scope, f), { v: val, unit: '文字', fmt: 'txt', asOf, tier: NV, source: nvSrc, label });
      add('label', v.label, '媒體判別方向（利多／利空／中性／資訊不足）');
      add('strength', v.strength, '強度'); add('confidence', v.confidence, '信心'); add('certainty', v.certainty, '確定性（已確認／預期／傳聞）');
      add('novelty', v.novelty, '新穎度'); add('priced', v.priced, '價格是否已反映（資訊量低，不可單獨當依據）'); add('eventType', v.eventType, '事件類型');
      add('basis', v.basis, '判別依據（content＝讀完內文）');
      add('gate', v.gate, '判別閘門（非空＝拒答門檻／引用強制未過，不得判方向）');
      add('reason', typeof v.reason === 'string' ? v.reason.slice(0, 200) : null, 'AI 判別理由（≤200字）');
      book.add(nvId(code, scope, 'override'), { v: typeof v.reason === 'string' && v.reason.startsWith('【規則】'), unit: '文字', fmt: 'txt', asOf, tier: NV, source: nvSrc, label: '是否為規則覆寫（涉法律事件一律利空；覆寫時不得再引 impactPath 當利多論述）' });
    }
    book.add(`nv.meta.${scope === 'data' ? 'n' : `${scope}N`}`, { v: nvScope[scope].size, unit: '檔', fmt: 'int', asOf: D, tier: NV, source: nvSrc, label: `媒體判別文件（${scope === 'prev' ? P : scope === 'data' ? D : N}）cutoff 前有判別的檔數（宇宙＝當日有新聞出現的股票，沒有判別≠沒有消息）` });
  }
  const moSrc = '公開資訊觀測站重大訊息（t05st02；官方原文）';
  const moIds = {}; // code → [{id(.dir), dir}]
  for (const scope of CARDS) {
    const og = oGroups[scope];
    const wantCodes = poolCodes[scope];
    // 入 refs：該範圍排行前 MO_TOP 的非例行群組＋該卡候選池股票的全部群組（含例行／未分類，讓分析師可讀內文重判）
    const picked = new Map();
    for (const g of [...og.ranked.slice(0, MO_TOP), ...[...og.groups.values()].filter(x => wantCodes.has(x.code))]) picked.set(`${g.code}|${g.type}`, g);
    for (const g of [...picked.values()].sort((a, b) => cmp(a.code, b.code) || cmp(a.type, b.type))) {
      if (!/^\d{4}$/.test(g.code)) continue;
      const last = g.items.at(-1);
      const base = `mo.${g.code}.${seg(g.type)}${scope === 'data' ? '' : `.${scope}`}`;
      const asOf = tpeDate(last.at);
      const add = (f, val, unit, fmt, label) => val != null && val !== '' && book.add(`${base}.${f}`, { v: val, unit, fmt, asOf, tier: OFF, source: moSrc, label });
      add('subject', String(last.subject).replace(/\s+/g, ' ').slice(0, 160), '文字', 'txt', `${g.name ?? ''} 官方公告主旨`);
      add('cls', g.type === 'U' ? '未分類' : g.label, '文字', 'txt', '主旨分類僅供參考（規則比對主旨、未讀內文；已知會誤判，例如董事會通過資本支出被歸為例行）');
      add('dir', g.dir ?? '需讀內文', '文字', 'txt', '規則方向（只有規則強制類才有方向；其餘需讀內文）');
      add('count', g.items.length, '則', 'int', '同公司同類型公告則數（不與媒體加總）');
      add('hhmm', tpeHHMM(last.at), '文字', 'txt', '公告時刻（台北）');
      add('afterClose', isMinutesAfterClose(last.at), '文字', 'txt', '是否為收盤（13:30）後公告（由時間機械判定）');
      const withBody = [...g.items].reverse().find(x => x.body);
      if (withBody) add('body', String(withBody.body).replace(/\s+/g, ' ').slice(0, 300), '文字', 'txt', '公告內文摘要（前300字；主旨分類僅供參考）');
      (moIds[g.code] ||= []).push({ id: `${base}.dir`, dir: g.dir });
    }
    const sfx = s => (scope === 'data' ? s : `${scope}${s[0].toUpperCase()}${s.slice(1)}`);
    for (const [f, v, l] of [['total', og.total, '當範圍官方公告總則數'], ['routine', og.routine, '例行公告（規則比對，僅計數）'], ['unclassified', og.unclassified, '未分類公告（僅計數）']]) {
      book.add(`mo.meta.${sfx(f)}`, { v, unit: '則', fmt: 'int', asOf: D, tier: OFF, source: moSrc, label: `${l}（${scope}；官方管線自己的計數，不與媒體加總）` });
    }
  }

  // ── adverse：每檔預算全部反向 refs（逐卡計算、再取「所在各卡皆可引用」者）──
  // 契約的 adverse 是每檔一份（與卡無關），但各卡有時點隔離（R17）：prev 卡不得引 asOf>D−1、next 卡不得引 N 日資料。
  // 為避免「R08 要求涵蓋、R17 又禁止引用」的死結：adverse[code]＝各卡候選反證的聯集中、對該檔所在每一張卡都可引用的 refs；
  // 完整的逐卡版另放 adverseByCard（W2 若改為逐卡檢查可直接採用）。
  const validFor = (card, id) => {
    const a = book.get(id)?.asOf;
    if (!a) return false;
    if (card === 'prev') return a <= P;
    if (card === 'data') return a <= D;
    return a < N || (edition === 'morning' && NEXT_NS.includes(id.split('.')[0]) && a <= N);
  };
  const adverseByCard = { prev: {}, data: {}, next: {} };
  const neg = id => book.get(id)?.v != null && book.get(id).v < 0;
  for (const card of CARDS) {
    for (const code of [...poolCodes[card]].sort(cmp)) {
      const a = new Set();
      for (const scope of CARDS) {
        if (book.get(nvId(code, scope, 'label'))?.v === '利空') a.add(nvId(code, scope, 'label'));
        if (book.get(nvId(code, scope, 'priced'))?.v === '是') a.add(nvId(code, scope, 'priced'));
        if (book.get(nvId(code, scope, 'certainty'))?.v === '傳聞') a.add(nvId(code, scope, 'certainty'));
      }
      for (const m of moIds[code] || []) if (m.dir === '−') a.add(m.id);
      for (const id of [`st.${code}.risk`, `st.${code}.prevRisk`, `st.${code}.watch`, `st.${code}.prevWatch`]) if (book.has(id)) a.add(id);
      if (card === 'next' && exdivIds.has(code)) a.add(exdivIds.get(code));
      for (const f of ['Fgn', 'Trust']) {
        const [x, y] = card === 'prev' ? [`st.${code}.prev${f}Bn`, `st.${code}.prev2${f}Bn`] : [`st.${code}.${f.toLowerCase()}Bn`, `st.${code}.prev${f}Bn`];
        if (neg(x) && neg(y)) { a.add(x); a.add(y); }
      }
      adverseByCard[card][code] = [...a].filter(id => book.has(id) && validFor(card, id)).sort(cmp);
    }
  }
  const adverse = {};
  for (const code of allCodes) {
    const cards = CARDS.filter(c => poolCodes[c].has(code));
    const union = new Set(cards.flatMap(c => adverseByCard[c][code]));
    adverse[code] = [...union].filter(id => cards.every(c => validFor(c, id))).sort(cmp);
  }

  // ── absent：只放「這個版次的 D 日（或不分日）核心輸入缺席」的來源名（R21 以來源名對應關鍵字），細節另列 meta.absentDetail ──
  const has = pre => [...book.map.keys()].some(k => k.startsWith(pre));
  const absentNames = new Set();
  if (!hp) absentNames.add('heatmap');
  if (miD.absent) absentNames.add('twse_mi_index');
  if (tpD.absent) absentNames.add('tpex_dailyquotes');
  if (!haveInst(instD) || chipD.absent) { absentNames.add('chipArchive'); degraded.push('chip:data-not-ready'); }
  if (bfiD.absent) absentNames.add('twse_bfi82u');
  if (!has('ch.fut.')) absentNames.add('taifexPositions');
  if (riskD.absent) absentNames.add('riskFlags');
  if (wikiRes.absent) absentNames.add('wiki');
  if (listRes.absent) absentNames.add('listingDates');
  if (otcRes.absent) absentNames.add('otcIndex');
  if (calRes.absent) absentNames.add('tradingCalendar');
  if (nvD.absent) absentNames.add('newsVerdict');
  if (mopsD.absent) absentNames.add('mopsNews');
  if (nvD.absent || nvScope.data.size < 40) degraded.push('news:coverage-low');
  if (!has('gl.sox.') && !has('gl.ixic.') && !has('gl.gspc.')) absentNames.add('globalMarkets');
  if (!has('adr.')) absentNames.add('adrPremium');
  if (!has('gl.n225.') && !has('gl.kospi.')) absentNames.add('asiaPremarket');
  if (spot.absent || !has('gl.brent.') && !has('gl.cu.') && !has('gl.gold.')) absentNames.add('sectorSpot');
  if (cal.absent) absentNames.add('catalystCalendar');
  if (div.absent) absentNames.add('dividendCalendar');
  if (!has('gl.news.')) absentNames.add('newsDigest');
  // 官方鏡像沒有「全額交割／變更交易」逐檔清單 → 無法排除、必須揭露（不假裝已排除）
  absentNames.add('fullDeliveryList'); absent.push('fullDeliveryList(來源未鏡像，無法排除全額交割／變更交易股票)'); degraded.push('risk:full-delivery-list-unavailable');

  // ── 組裝 ──
  const tradingDays = [...td.filter(d => d <= D).slice(-25), N];
  const pack = {
    schema: 1, kind: 'analystPack', dataDate: D, dates: { prev: P, data: D, next: N }, edition,
    refs: book.toObject(),
    pools, excluded, adverse, adverseByCard,
    absent: [...absentNames].sort(cmp),
    degraded: uniq(degraded).sort(cmp),
    calendar: { tradingDays, nextTradingDay: N, holidaysAhead: nt.holidaysAhead },
    meta: {
      refCount: book.size, bytes: 0, cutoff: `${isoOfMs(cutoffMs + 8 * 3600e3).slice(0, 19)}+08:00`, riskPolicy, poolRule: POOL_RULE,
      constants: { newListingMinDays: NEW_LISTING_MIN_DAYS, minValYi: MIN_VAL_YI, poolMax: POOL_MAX, excludeAnyLimit: EXCLUDE_ANY_LIMIT, note: '暫訂值，待校準' },
      absentDetail: uniq(absent).sort(cmp),
      inputs: Object.fromEntries(Object.entries(inputs).sort((a, b) => cmp(a[0], b[0]))),
    },
  };
  // bytes：以「meta.bytes 填入自身位元組數」的序列化長度為準（迭代到穩定）
  let b = 0;
  for (let i = 0; i < 6; i++) {
    pack.meta.bytes = b;
    const len = Buffer.byteLength(JSON.stringify(pack));
    if (len === b) break;
    b = len;
  }
  pack.meta.bytes = b;
  return pack;
}
