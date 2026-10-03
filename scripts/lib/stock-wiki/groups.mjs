// ─────────────────────────────────────────────────────────────────────────────
// 集團／關係企業推導（站內推導，不是官方集團名冊——官方沒有「集團」這個欄位）
//
// 依據兩份官方揭露：
//   t187ap11_L 董監事持股明細：職稱「…本人」且姓名是法人 ⇒ 該法人是這家公司的法人董監／大股東（含目前持股股數）
//   t187ap02_L 持股逾 10% 大股東
// 規則（2026-10-03 改為「單一母公司樹」）：
//   每家公司只認**一個**上層節點＝持股比例最高的法人（「最大法人股東」），且比例 ≥ 5% 或名列 10% 大股東。
//   ⚠ 這包含控制關係與策略投資（例：華碩持研華 13%、祥碩持文曄 15%），不等於公司法的「關係企業」——頁面照實說明。
//   母節點可以是上市櫃公司（名稱比對全名）或非上市法人（家族投資公司）；同一母節點底下的公司同群。
//   ⚠ 舊版把「所有」法人董監關係做遞移串連，合資與策略投資（中華電信、統一、中鋼…各在多家公司掛法人董事）
//     會把不同集團橋接成一坨（實測 114 家一群）。單一母公司讓結構變成樹，次要股東只列為關係、不串群。
//   公股（國發基金、財政部、公營銀行…）與創投不當母節點（只列為股東）。
// 群名＝群內市值最大者「{簡稱}關係企業群」——是推導標籤，不是集團自稱。
// ─────────────────────────────────────────────────────────────────────────────
import { normCompanyName } from './util.mjs';

const CORP_RE = /股份有限公司|有限公司|公司$|投資|控股|基金會|財團法人|社團法人|協會|管理委員會|合作社|銀行|基金|委員會$|政府|^財政部$|^經濟部$|^交通部$|^國防部$|^內政部$/;
export const PUBLIC_RE = /耀華玻璃.*管理委員會|台灣糖業|臺灣糖業|台灣中油|臺灣中油|中國石油|台灣電力|臺灣電力|航空事業發展基金會|榮民|退除役|國家發展基金|國發基金|財政部|經濟部|交通部|國防部|內政部|行政院|勞動部|勞工保險|勞動基金|退休基金|退撫|郵政|公庫|縣政府|市政府|農業部|國軍|輔導會|臺灣銀行|台灣銀行|土地銀行|合作金庫|彰化商業銀行|第一商業銀行|華南商業銀行|兆豐國際商業銀行|臺灣中小企業銀行|中華開發|信託財產|保管|受託|專戶/;
export const VC_RE = /創業投資|創投|開發資本|Venture|Capital|VENTURE|CAPITAL/;
export const MIN_PARENT_STAKE = 0.05;

export const isCorporateName = (n) => CORP_RE.test(String(n || '').trim());

/** 從董監明細＋大股東名單抽出 { code, holder, rel, shares }（holder 是法人名稱；同公司同法人合併、持股取最大） */
export function corporateHoldings(directorRows = [], majorRows = []) {
  const byKey = new Map();
  const add = (code, holder, rel, shares) => {
    code = String(code || '').trim(); holder = String(holder || '').trim();
    if (!code || !holder || !isCorporateName(holder)) return;
    const k = `${code}|${normCompanyName(holder)}`;
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, { code, holder, rel, shares: shares || 0 }); return; }
    if (rel === 'major_holder') prev.rel = 'major_holder';   // 同時是董監又是大股東，以大股東標示
    prev.shares = Math.max(prev.shares, shares || 0);
  };
  for (const r of directorRows) {
    const title = String(r['職稱'] || '');
    if (!/本人$/.test(title)) continue;   // 「之法人代表人」是自然人，跳過
    const rel = /大股東/.test(title) ? 'major_holder' : 'director';
    add(r['公司代號'], r['姓名'], rel, Number(String(r['目前持股'] || '0').replace(/,/g, '')) || 0);
  }
  for (const r of majorRows) add(r['公司代號'], r['大股東名稱'], 'major_holder', 0);
  return [...byKey.values()];
}

class UnionFind {
  constructor() { this.p = new Map(); }
  find(x) { if (!this.p.has(x)) this.p.set(x, x); let r = x; while (this.p.get(r) !== r) r = this.p.get(r); this.p.set(x, r); return r; }
  union(a, b) { const ra = this.find(a); const rb = this.find(b); if (ra !== rb) this.p.set(rb, ra); }
}

/**
 * @param holdings  corporateHoldings() 的輸出
 * @param companies Map(code → { code, name, fullName, mktCap, shares })
 * @returns { links, holders, groups, groupOf }
 *   links:   [{ from: holderCode|null, holder, to: code, rel, kind: 'listed'|'private'|'public'|'vc' }]
 *   holders: Map(holderName → { name, kind, codes:Set, listedCode })
 *   groups:  [{ id, name, core, members:[code], viaHolders:[name] }]（≥2 家上市櫃才成群）
 *   groupOf: Map(code → groupId)
 */
export function deriveGroups(holdings, companies) {
  // 法人名稱只比對「全名」——用簡稱比對會把「承啟股份有限公司」錯配到 2425 承啟科技（2026-10-03 審查）；
  //   全名未知的公司才退而用簡稱
  const byNorm = new Map();
  for (const c of companies.values()) {
    const k = normCompanyName(c.fullName || c.name);
    if (k && !byNorm.has(k)) byNorm.set(k, c.code);
  }
  const holders = new Map(); const links = [];
  for (const h of holdings) {
    if (!companies.has(h.code)) continue;
    const listedCode = byNorm.get(normCompanyName(h.holder)) || null;
    const kind = listedCode ? 'listed' : PUBLIC_RE.test(h.holder) ? 'public' : VC_RE.test(h.holder) ? 'vc' : 'private';
    if (listedCode === h.code) continue;   // 自己持有自己（庫藏、名稱誤配）不算
    const e = holders.get(h.holder) || { name: h.holder, kind, codes: new Set(), listedCode };
    e.codes.add(h.code); holders.set(h.holder, e);
    const total = companies.get(h.code)?.shares;
    const raw = total && h.shares ? h.shares / total : null;
    const stake = raw != null && raw <= 1 ? raw : null;   // >100%＝董監表與股數不同期（減資後），不當事實顯示
    links.push({ from: listedCode, holder: h.holder, to: h.code, rel: h.rel, kind, stake });
  }
  // 每家公司選一個母節點：比例最高者；比例未知但名列 10% 大股東者視為 10%
  const parentOf = new Map();
  for (const l of links) {
    if (l.kind !== 'listed' && l.kind !== 'private') continue;
    const eff = l.stake ?? (l.rel === 'major_holder' ? 0.1 : 0);
    if (eff < MIN_PARENT_STAKE && l.rel !== 'major_holder') continue;
    const cur = parentOf.get(l.to);
    if (!cur || eff > cur.eff) parentOf.set(l.to, { node: l.from ? `c:${l.from}` : `h:${l.holder}`, holder: l.holder, eff });
  }
  for (const l of links) l.isParent = parentOf.get(l.to)?.holder === l.holder;
  const uf = new UnionFind(); const via = new Map();
  for (const [code, p] of parentOf) {
    uf.union(p.node, `c:${code}`);
    (via.get(code) || via.set(code, new Set()).get(code)).add(p.holder);
  }
  const comp = new Map();
  for (const code of companies.keys()) {
    if (!uf.p.has(`c:${code}`)) continue;
    const r = uf.find(`c:${code}`); (comp.get(r) || comp.set(r, []).get(r)).push(code);
  }
  const groups = []; const groupOf = new Map();
  for (const members of comp.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => (companies.get(b)?.mktCap || 0) - (companies.get(a)?.mktCap || 0) || a.localeCompare(b));
    const core = members[0];
    const name = `${companies.get(core)?.name || core}關係企業群`;
    const viaHolders = [...new Set(members.flatMap(c => [...(via.get(c) || [])]))].sort();
    const g = { id: name, name, core, members, viaHolders };
    groups.push(g);
    for (const c of members) groupOf.set(c, g.id);
  }
  groups.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
  return { links, holders, groups, groupOf };
}
