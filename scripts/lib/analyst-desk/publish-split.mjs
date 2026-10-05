// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊：發佈前的純函式（無 IO、不連 Firestore）——把定版 issue 拆成「公開」與「管理員專用」兩份文件。
//   公開 dailyAnalyst/{latest,D}：不含任何個股名單明細（cards[].focus 只留 kind/poolRule/poolSize/excludedCount/count/note；
//     refTable 剔除「僅供個股名單使用」的個股專屬 ref）；研究期個股「資料觀察名單」只給管理員。
//   管理員 dailyAnalystFocus/{latest,D}：{ dataDate, edition, canonicalAt, cards:[{id, focus:{…, stocks}}], refTable }
//     （形狀對齊 src/components/AfterMarket/analystDeskTypes.ts 的 focusByCard()）。
//   另含：鍵名掃描（constants.mjs 的 FORBIDDEN_KEY_RE／KEY_SCAN_EXEMPT／DYNAMIC_KEY_PATHS）、900KB 守門、發佈決策。
// ─────────────────────────────────────────────────────────────────────────────
import { FORBIDDEN_KEY_RE, KEY_SCAN_EXEMPT, DYNAMIC_KEY_PATHS, STOCK_NAMESPACES } from './constants.mjs';

export const MAX_DOC_BYTES = 900_000;
export const PUBLIC_FOCUS_KEYS = Object.freeze(['kind', 'poolRule', 'poolSize', 'excludedCount', 'count', 'note']);
/** 公開文件任何位置都不得出現的個股明細鍵（防洩漏的第二道保險；refTable 子樹是動態鍵 map 不掃鍵）。 */
export const STOCK_DETAIL_KEYS = Object.freeze(['stocks', 'thesis', 'thesisRaw', 'watchConditions', 'evidence', 'adverse', 'sponsors']);

const arr = x => (Array.isArray(x) ? x : []);

/** 個股專屬 ref：st./nv./mo./wk. 開頭（第二段是代號）。 */
export const isStockSpecificRef = id => {
  const p = String(id).split('.');
  return p.length >= 3 && STOCK_NAMESPACES.includes(p[0]);
};

/** 公開 focus：只留計數與規則，stocks 的有無以 count 表示。 */
export function publicFocus(focus) {
  const f = focus || {};
  return {
    kind: f.kind ?? '', poolRule: f.poolRule ?? '', poolSize: f.poolSize ?? 0, excludedCount: f.excludedCount ?? 0,
    count: arr(f.stocks).length, note: f.note ?? '',
  };
}

const claimRefs = c => arr(c?.refs);

/** 公開內容（總結、各卡分段 claims、連動）引用到的 ref。 */
export function publicRefs(issue) {
  const set = new Set();
  const add = xs => xs.forEach(r => set.add(r));
  const s = issue.summary || {};
  [...arr(s.points), ...arr(s.nextFocus), ...arr(s.risks)].forEach(c => add(claimRefs(c)));
  for (const card of arr(issue.cards)) for (const sec of arr(card.sections)) for (const c of arr(sec.claims)) add(claimRefs(c));
  for (const l of arr(issue.linkages)) { add(arr(l.refs)); if (l.from?.ref) set.add(l.from.ref); if (l.to?.ref) set.add(l.to.ref); }
  return set;
}

/** 個股名單引用到的 ref（evidence／adverse／條件／風險／收盤 ref／thesisRaw 與條件 raw 內的槽位）。 */
export function stockRefs(issue) {
  const set = new Set();
  const add = xs => xs.forEach(r => set.add(r));
  const slots = raw => { for (const m of String(raw || '').matchAll(/\{\{\s*([^|}\s]+)\s*(?:\|[^}]*)?\}\}|\[ref:([^\]]+)\]/g)) set.add(m[1] || m[2]); };
  for (const card of arr(issue.cards)) {
    for (const st of arr(card.focus?.stocks)) {
      add(arr(st.evidence).map(e => e?.ref).filter(Boolean)); add(arr(st.adverse));
      for (const x of [...arr(st.watchConditions), ...arr(st.risks)]) { add(arr(x.refs)); slots(x.raw); }
      slots(st.thesisRaw);
      if (st.asOf?.closeRef) set.add(st.asOf.closeRef);
    }
  }
  return set;
}

const pick = (table, ids) => { const o = {}; for (const id of ids) if (table[id] !== undefined) o[id] = table[id]; return o; };

/**
 * 拆成 { pub, focus }。stamps＝{ canonicalAt(ISO)、updatedAt(ms) }（時間戳由發佈端給，檔本體沒有）。
 * pub.refTable：保留公開內容用到的 ref；其餘只留「非個股專屬」者；個股專屬且僅被個股名單引用者剔除。
 */
export function splitIssue(issue, { canonicalAt, updatedAt }) {
  const table = issue.refTable || {};
  const used = publicRefs(issue);
  const pubIds = Object.keys(table).filter(id => used.has(id) || !isStockSpecificRef(id));
  const pub = {
    ...issue,
    cards: arr(issue.cards).map(c => ({ ...c, focus: publicFocus(c.focus) })),
    refTable: pick(table, pubIds),
    canonicalAt,
    meta: { ...(issue.meta || {}), canonicalAt },
    updatedAt,
  };
  const need = stockRefs(issue);
  const focus = {
    dataDate: issue.dataDate, edition: issue.edition, canonicalAt, updatedAt,
    cards: arr(issue.cards).map(c => ({ id: c.id, focus: { ...publicFocus(c.focus), stocks: arr(c.focus?.stocks) } })),
    refTable: pick(table, [...need].filter(id => table[id] !== undefined)),
  };
  return { pub, focus };
}

// ── 鍵名掃描 ─────────────────────────────────────────────────────────────────
/**
 * 掃所有物件鍵：不得符合 FORBIDDEN_KEY_RE（KEY_SCAN_EXEMPT 的鍵例外）；DYNAMIC_KEY_PATHS 的 map 不掃其鍵（鍵是 refId／規則編號／來源名），只掃其值。
 * 回傳違規 [{path,key}]。
 */
export function scanKeys(doc) {
  const bad = [];
  const dyn = new Set(DYNAMIC_KEY_PATHS);
  const walk = (v, path) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      const dynamic = dyn.has(path);
      for (const k of Object.keys(v)) {
        if (!dynamic && !KEY_SCAN_EXEMPT.includes(k) && FORBIDDEN_KEY_RE.test(k)) bad.push({ path, key: k });
        walk(v[k], path ? `${path}.${k}` : k);
      }
    }
  };
  walk(doc, '');
  return bad;
}

/** 公開文件不得含個股明細鍵；回傳出現的 [{path,key}]（refTable 子樹的鍵是 refId，不掃）。 */
export function scanStockDetail(doc) {
  const hits = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') {
      const dynamic = DYNAMIC_KEY_PATHS.includes(path);
      for (const k of Object.keys(v)) {
        if (!dynamic && STOCK_DETAIL_KEYS.includes(k)) hits.push({ path, key: k });
        walk(v[k], path ? `${path}.${k}` : k);
      }
    }
  };
  walk(doc, '');
  return hits;
}

export const docBytes = doc => Buffer.byteLength(JSON.stringify(doc));

/** Firestore 不收 undefined、不允許巢狀陣列；序列化往返去掉 undefined，並回報巢狀陣列路徑。 */
export function toFirestoreSafe(doc) {
  const clean = JSON.parse(JSON.stringify(doc));
  const nested = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) { v.forEach((x, i) => { if (Array.isArray(x)) nested.push(`${path}[${i}]`); walk(x, `${path}[${i}]`); }); return; }
    if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k);
  };
  walk(clean, '');
  return { doc: clean, nested };
}

/**
 * 發佈前總檢：回傳 { ok, problems[], pub, focus, bytes:{pub,focus} }。
 * problems：鍵名違規、公開文件含個股明細、nested array、超過 900KB。
 */
export function prepareDocs(issue, stamps) {
  const { pub, focus } = splitIssue(issue, stamps);
  const problems = [];
  const sp = toFirestoreSafe(pub), sf = toFirestoreSafe(focus);
  for (const [name, d] of [['dailyAnalyst', sp.doc], ['dailyAnalystFocus', sf.doc]]) {
    for (const b of scanKeys(d)) problems.push(`${name} 鍵名違規：${b.path ? b.path + '.' : ''}${b.key}`);
  }
  for (const h of scanStockDetail(sp.doc)) problems.push(`dailyAnalyst 含個股明細鍵：${h.path ? h.path + '.' : ''}${h.key}`);
  for (const p of sp.nested) problems.push(`dailyAnalyst 有巢狀陣列：${p}`);
  for (const p of sf.nested) problems.push(`dailyAnalystFocus 有巢狀陣列：${p}`);
  const bytes = { pub: docBytes(sp.doc), focus: docBytes(sf.doc) };
  if (bytes.pub > MAX_DOC_BYTES) problems.push(`dailyAnalyst ${bytes.pub}B 逼近 1MB（上限 ${MAX_DOC_BYTES}），請改壓縮分片`);
  if (bytes.focus > MAX_DOC_BYTES) problems.push(`dailyAnalystFocus ${bytes.focus}B 逼近 1MB（上限 ${MAX_DOC_BYTES}），請改壓縮分片`);
  return { ok: problems.length === 0, problems, pub: sp.doc, focus: sf.doc, bytes };
}

/**
 * 發佈決策（cur＝Firestore 目前 dailyAnalyst/latest 的內容或 null）：
 *   skip-same（同一份定版 canonicalAt 相同，且非 force）｜skip-older（不讓舊資料日蓋新 latest）｜
 *   skip-edition（同一資料日 morning 定版不被 evening 蓋掉）｜write
 */
export function decidePublish({ cur, doc, force = false }) {
  if (!cur) return 'write';
  if (cur.dataDate > doc.dataDate) return 'skip-older';
  if (cur.dataDate === doc.dataDate && cur.edition === 'morning' && doc.edition === 'evening') return 'skip-edition';
  if (!force && cur.canonicalAt === doc.canonicalAt && cur.dataDate === doc.dataDate && cur.edition === doc.edition) return 'skip-same';
  return 'write';
}
