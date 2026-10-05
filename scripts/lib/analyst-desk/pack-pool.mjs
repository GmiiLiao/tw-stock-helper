// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊·候選池（pool-v1）與排除（W1）
//   每卡一池（prev／data／next）、每池 ≤ POOL_MAX 檔、程式產生（LLM 不能自己加股票）。
//   產生器依序（01 §個股 K1–K3、02 §選股漏斗）：K1 熱度前5產業各1 → K2 指數推手／拖累 → K3 外資＋投信同買 → 媒體判別 → 官方公告 → 行事曆法說 → 漲幅榜 → 成交值榜。
//   每個產生器沿「它自己的排序」往下掃，掃過去的被排除者記入 excluded（附原因）；單一產生器掃描深度有上限（SCAN_DEPTH），
//   所以 excluded 是「被掃到而排除」的名單，不是全市場的排除明細。
//   ⚠ 以下常數為暫訂值、待校準（需回測／使用者裁定），集中於此，不散落各處。
// ─────────────────────────────────────────────────────────────────────────────
import { isCommonStock } from './pack-sources.mjs';

export const POOL_RULE = 'pool-v1';
export const POOL_MAX = 30;
export const SCAN_DEPTH = 120;
export const NEW_LISTING_MIN_DAYS = 25;  // 暫訂·待校準：上市未滿 N 個交易日（與熱力 index-contrib NEW_LISTING_DAYS 同為經驗值）
export const MIN_VAL_YI = 3;             // 暫訂·待校準：成交值下限（億元）；草案 02 建議 3 億，草案 01 用 10 億
export const EXCLUDE_ANY_LIMIT = true;   // 暫訂·待校準：true＝漲停／跌停收盤一律排除（草案 01／02 §5.1）；false＝只排「鎖死漲停」
export const EXCLUDE_REASONS = ['處置', '注意', '新上市', '全額交割', '鎖死漲停', '漲停', '跌停', '除權息日', '無漲跌幅', '成交值不足', '旗標不可驗證'];
export const QUOTA = { k1PerIndustry: 1, k1Industries: 5, k2Contrib: 3, k2Drag: 3, k3: 5, news: 4, official: 4, cal: 5, gainers: 4, byValue: 4 };

/** 熱力 stocks[]（[code, ret, valM, flags, res, industry]）→ Map（只留 4 碼普通股）。 */
export function stockUniverse(H) {
  const m = new Map();
  for (const r of H?.stocks || []) {
    if (!isCommonStock(r[0])) continue;
    m.set(r[0], { code: r[0], ret: r[1], valM: r[2], flags: r[3], res: r[4], industry: r[5] });
  }
  return m;
}

/**
 * 風險旗標評估。snapRes＝readRiskSnapshot 結果（可能 absent）。
 *  strict：該市場「處置名單＋當日注意名單」都可得才算可驗證；lenient：只要處置名單可得（注意名單缺→標 partial，adverse 會揭露）。
 *  activeDay：判斷處置期間是否涵蓋的日期（prev 池＝D−1、data 池＝D、next 池＝N）；處置「公告日≤activeDay≤迄日」即排除（含公告後尚未生效者）。
 */
export function evalRisk(snapRes, { activeDay, policy = 'strict' }) {
  const v = snapRes && !snapRes.absent ? snapRes.data.verified : null;
  const verified = { tse: false, otc: false };
  const partial = { tse: false, otc: false };
  for (const k of ['tse', 'otc']) {
    if (!v) continue;
    if (v[k].disposal && v[k].attention) verified[k] = true;
    else if (policy === 'lenient' && v[k].disposal) { verified[k] = true; partial[k] = true; }
  }
  const data = snapRes && !snapRes.absent ? snapRes.data : null;
  return {
    verified, partial, hasSnapshot: !!data,
    check(code) {
      if (!data) return null;
      for (const e of data.disposal.get(code) || []) {
        // 公告日（已知）≤ 判斷日 ≤ 迄日 即視為處置：公告後尚未生效者（起日在判斷日之後）也排除；公告日缺才退回起日
        const known = e.announce ?? e.start;
        if ((known == null || known <= activeDay) && (e.end == null || activeDay <= e.end)) return '處置';
      }
      if (data.attention.has(code) || data.near.has(code)) return '注意';
      return null;
    },
  };
}

/** 排除判定。回 undefined＝不是候選（非普通股／當日無成交），null＝通過，字串＝排除原因。 */
export function makeChecker({ stocks, marketOf, risk, listing, tradingDays, asOfDay }) {
  const idx = tradingDays.indexOf(asOfDay);
  const daysSince = ld => {
    if (!ld) return null;
    let n = 0;
    for (let i = idx; i >= 0 && tradingDays[i] > ld; i--) n++;
    return n;
  };
  return code => {
    const s = stocks.get(code);
    if (!s) return undefined;
    const mkt = marketOf(code);
    const key = mkt === '上市' ? 'tse' : mkt === '上櫃' ? 'otc' : null;
    if (!key || !risk.verified[key]) return '旗標不可驗證';
    const rk = risk.check(code);
    if (rk) return rk;
    const ld = listing?.get(code)?.date ?? null;
    const ds = daysSince(ld);
    if (ds != null && ds < NEW_LISTING_MIN_DAYS) return '新上市';
    const f = s.flags || 0;
    if (f & 4) return '鎖死漲停';
    if (EXCLUDE_ANY_LIMIT) {
      if (f & 1) return '漲停';
      if (f & 2) return '跌停';
    }
    if (f & 32) return '除權息日';
    if (f & 64) return '無漲跌幅';
    if (s.valM == null || s.valM < MIN_VAL_YI * 100) return '成交值不足';
    return null;
  };
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 建一張卡的池。
 * c: { H, stocks, check, identity(code)→{name,market,industry}|null, inst: Map code→{foreign,trust}(億)|null,
 *      newsCodes:[], officialCodes:[], calCodes:[], max }
 * 回 { pool:[{code,name,market,industry,from}], excluded:[{code,reason}], skippedGenerators:[...] }
 */
export function buildCardPool(c) {
  const max = c.max ?? POOL_MAX;
  const members = new Map();
  const excl = new Map();
  const skipped = [];
  const tag = (code, t) => { const m = members.get(code); if (!m.from.includes(t)) m.from.push(t); };
  function fill(codes, quota, t) {
    let added = 0; let scanned = 0;
    for (const code of codes) {
      if (added >= quota || members.size >= max || scanned++ >= SCAN_DEPTH) break;
      if (members.has(code)) { tag(code, t); continue; }
      const why = c.check(code);
      if (why === undefined) continue;
      if (why) { if (!excl.has(code)) excl.set(code, why); continue; }
      members.set(code, { code, from: [t] });
      added++;
    }
  }
  const byRetDesc = (a, b) => b.ret - a.ret || b.valM - a.valM || cmpStr(a.code, b.code);
  const all = [...c.stocks.values()];

  // K1：熱度前 5 產業各 1（產業內報酬最高且通過排除者；產業內無人＝空缺不遞補）
  const inds = (c.H?.industries || []).filter(i => i.heat != null).sort((a, b) => b.heat - a.heat || cmpStr(a.key, b.key)).slice(0, QUOTA.k1Industries);
  for (const i of inds) fill(all.filter(s => s.industry === i.key).sort(byRetDesc).map(s => s.code), QUOTA.k1PerIndustry, 'heat.industry');
  // K2：指數推手／拖累（依熱力 index 區塊的順序）
  fill((c.H?.index?.contributors || []).map(x => x.code), QUOTA.k2Contrib, 'idx.contributor');
  fill((c.H?.index?.draggers || []).map(x => x.code), QUOTA.k2Drag, 'idx.dragger');
  // K3：外資＋投信同日買超（合計金額由大到小）
  if (c.inst) {
    const both = [...c.inst.entries()].filter(([, v]) => v.foreign > 0 && v.trust > 0).sort((a, b) => (b[1].foreign + b[1].trust) - (a[1].foreign + a[1].trust) || cmpStr(a[0], b[0])).map(([k]) => k);
    fill(both, QUOTA.k3, 'inst.fgnTrust');
  } else skipped.push('inst.fgnTrust(法人資料缺)');
  fill(c.newsCodes || [], QUOTA.news, 'news.verdict');
  fill(c.officialCodes || [], QUOTA.official, 'news.official');
  fill(c.calCodes || [], QUOTA.cal, 'cal.call');
  fill([...all].sort(byRetDesc).map(s => s.code), QUOTA.gainers, 'board.gainers');
  fill([...all].sort((a, b) => b.valM - a.valM || cmpStr(a.code, b.code)).map(s => s.code), QUOTA.byValue, 'board.byValue');

  const pool = [...members.values()].map(m => {
    const id = c.identity(m.code) || {};
    const s = c.stocks.get(m.code);
    return { code: m.code, name: id.name ?? null, market: id.market ?? null, industry: s?.industry ?? id.industry ?? null, from: m.from };
  });
  const excluded = [...excl.entries()].filter(([code]) => !members.has(code)).map(([code, reason]) => ({ code, reason })).sort((a, b) => cmpStr(a.code, b.code));
  return { pool, excluded, skippedGenerators: skipped };
}
