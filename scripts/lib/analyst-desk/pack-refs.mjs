// ─────────────────────────────────────────────────────────────────────────────
// 分析師團隊·資料包 refs 表建構（W1）：RefBook＋市場／指數／廣度／產業／籌碼／全球／行事曆區塊
//   · 所有 ref 的 v 都是「來源值（取整後）或程式預算差值」，分析師不做算術；缺值＝不產生該 ref（由上層列 absent），不補 0
//   · ref id 文法（CONTRACT §2）：^[a-z]{1,3}(\.[A-Za-z0-9^=_\-一-龥]+){1,4}$；
//     ⚠ 契約內部矛盾：§2 命名空間寫 `prev.*`／`diff.*`，但文法首段只允許 1–3 個小寫字母（prev／diff 為 4 字母）。
//       本實作遵守「文法」→ 以 `pv.*`（D−1 值）與 `df.*`（D 與 D−1 的程式預算差）代之；常數集中於 PREV_NS／DIFF_NS，契約定案後改一行即可。
//   · key（含 ref id）不得符合 FORBIDDEN_KEY_RE，且不得以 At／Date 結尾（只允許 dataDate／generatedAt／canonicalAt／updatedAt）
// ─────────────────────────────────────────────────────────────────────────────
import { expectedUsDay, nyCloseMs, nyDate, tpeDate, addDays } from './pack-sources.mjs';

export const PREV_NS = 'pv';
export const DIFF_NS = 'df';
export const REF_ID_RE = /^[a-z]{1,3}(\.[A-Za-z0-9^=_\-一-龥]+){1,4}$/;
export const FORBIDDEN_KEY_RE = /score|signal|buy|sell|rank|target|stop|entry|exit|action|rating|recommend/i;
export const TIER_ORDER = ['官方', '官方衍生', '站內整理', '媒體', 'AI待驗', '傳聞', '先驗·未驗證'];
export const lowerTier = (a, b) => (TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b);

/** 把任意字串轉成合法 ref 段（非法字元→_）。 */
export const seg = s => String(s).replace(/[^A-Za-z0-9^=_\-一-龥]+/g, '_').replace(/^_+|_+$/g, '') || '_';

export function rnd(x, dec = 2) {
  if (x == null || !Number.isFinite(x)) return null;
  const k = 10 ** dec;
  const r = Math.round(x * k) / k;
  return r === 0 ? 0 : r;
}

export class RefBook {
  constructor() { this.map = new Map(); }
  add(id, { v, unit, fmt, asOf, tier, source, label }) {
    if (!REF_ID_RE.test(id)) throw new Error(`ref id 文法不符：${id}`);
    if (FORBIDDEN_KEY_RE.test(id)) throw new Error(`ref id 含禁用字樣：${id}`);
    if (/(At|Date)$/.test(id.split('.').pop())) throw new Error(`ref id 末段不得以 At／Date 結尾：${id}`);
    if (this.map.has(id)) throw new Error(`ref id 重複：${id}`);
    const o = { v: v ?? null, unit, fmt, asOf, tier, source };
    if (label) o.label = label;
    this.map.set(id, o);
    return id;
  }
  /** 衝突時自動加尾碼（只給站內層級 key 經 seg 後可能撞名的情況）。 */
  addUnique(id, spec) {
    let k = id; let n = 2;
    while (this.map.has(k)) k = `${id}_${n++}`;
    return this.add(k, spec);
  }
  has(id) { return this.map.has(id); }
  get(id) { return this.map.get(id); }
  get size() { return this.map.size; }
  /** 依 id（UTF-16 碼位序，與語系無關）排序後輸出，鍵序固定。 */
  toObject() {
    const o = {};
    for (const k of [...this.map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) o[k] = this.map.get(k);
    return o;
  }
}

/**
 * 同一指標的 D／D−1／差值三連發：base（D）、pv.base（D−1）、df.base（D−D−1，由「已取整後的兩值」相減再取整，確保 df＝v−pv）。
 * spec: {unit, fmt, dec, tier, source, label, asOfD, asOfP}；任一邊缺值就只產另一邊（不產 df）。
 */
export function addPair(book, base, spec, vD, vP) {
  const d = rnd(vD, spec.dec ?? 2);
  const p = rnd(vP, spec.dec ?? 2);
  const common = { unit: spec.unit, fmt: spec.fmt, tier: spec.tier, source: spec.source };
  if (d != null) book.add(base, { ...common, v: d, asOf: spec.asOfD, label: spec.label });
  if (p != null) book.add(`${PREV_NS}.${base}`, { ...common, v: p, asOf: spec.asOfP, label: spec.label ? `${spec.label}（前一交易日）` : undefined });
  if (d != null && p != null) {
    book.add(`${DIFF_NS}.${base}`, {
      ...common, v: rnd(d - p, spec.dec ?? 2), unit: spec.unit === '%' ? 'pp' : spec.unit, fmt: spec.diffFmt ?? DIFF_FMT[spec.fmt] ?? spec.fmt,
      asOf: spec.asOfD, label: spec.label ? `${spec.label}（較前一交易日）` : undefined,
    });
  }
}

/** 差值一律帶號顯示：整數仍用 int（負數自帶 -）、1 位小數用 pts1、其餘用 sg2。 */
const DIFF_FMT = { int: 'int', bn1: 'pts1', txt: 'sg2', sg2: 'sg2', pts1: 'pts1', pct0: 'sg2' };

const OFFICIAL = '官方';
const DERIVED = '官方衍生';

// ── 市場／廣度／指數／權值股貢獻 ──────────────────────────────────────────────────
const splitOf = (H, n) => H?.index?.splits?.find(s => s.n === n) ?? null;
const contribIndex = H => {
  const m = new Map();
  for (const x of [...(H?.index?.top || []), ...(H?.index?.contributors || []), ...(H?.index?.draggers || [])]) if (!m.has(x.code)) m.set(x.code, x);
  return m;
};

/** c: {D, P, hd, hp, miD, miP, otcD, otcP, stockVal:{ratio5D,ratio20D,ratio5P,ratio20P}} （hd／hp＝熱力 payload，可能 null） */
export function addMarketRefs(book, c) {
  const { D, P, hd, hp, miD, miP } = c;
  const S = '每日熱力定版（官方收盤自算）';
  const mk = (id, label, unit, fmt, dec, getD, getP, tier = DERIVED, source = S) =>
    addPair(book, id, { unit, fmt, dec, tier, source, label, asOfD: D, asOfP: P }, hd ? getD(hd) : null, hp ? getP(hp) : null);
  const both = f => [f, f];

  // 兩市（參考價口徑）
  const M = k => h => h.market?.[k];
  for (const [k, id, label, unit, fmt, dec] of [
    ['n', 'm.n', '兩市有成交普通股檔數', '檔', 'int', 0], ['ew', 'm.ew', '全市場等權報酬（參考價口徑）', '%', 'sg2', 2],
    ['capW', 'm.capW', '全市場市值加權報酬（診斷）', '%', 'sg2', 2], ['sigma', 'm.sigma', '全市場報酬橫斷面標準差', '%', 'txt', 2],
    ['up', 'm.up', '兩市上漲檔數（參考價口徑）', '檔', 'int', 0], ['dn', 'm.dn', '兩市下跌檔數（參考價口徑）', '檔', 'int', 0], ['flat', 'm.flat', '兩市平盤檔數（參考價口徑）', '檔', 'int', 0],
    ['luN', 'm.luN', '兩市漲停檔數', '檔', 'int', 0], ['ldN', 'm.ldN', '兩市跌停檔數', '檔', 'int', 0],
    ['lockU', 'm.lockU', '兩市鎖死漲停檔數', '檔', 'int', 0], ['lockD', 'm.lockD', '兩市鎖死跌停檔數', '檔', 'int', 0],
  ]) mk(id, label, unit, fmt, dec, ...both(M(k)));
  mk('m.valTotalBn', '兩市股票成交值合計', '億', 'bn1', 1, h => (h.market?.valTotalM != null ? h.market.valTotalM / 100 : null), h => (h.market?.valTotalM != null ? h.market.valTotalM / 100 : null));
  // 上市一般股票成交金額（官方 MI_INDEX 大盤統計）＋量比（對前 5／20 個交易日均值，上市口徑）
  addPair(book, 'm.tseValBn', { unit: '億', fmt: 'bn1', dec: 1, tier: OFFICIAL, source: '證交所 MI_INDEX 大盤統計（一般股票）', label: '上市一般股票成交金額', asOfD: D, asOfP: P },
    miD?.officialStockValue != null ? miD.officialStockValue / 1e8 : null, miP?.officialStockValue != null ? miP.officialStockValue / 1e8 : null);
  const sv = c.stockVal || {};
  addPair(book, 'm.valRatio5', { unit: '%', fmt: 'pct0', dec: 0, tier: DERIVED, source: '證交所 MI_INDEX（自算）', label: '上市成交值÷前5交易日均值', asOfD: D, asOfP: P }, sv.ratio5D ?? null, sv.ratio5P ?? null);
  addPair(book, 'm.valRatio20', { unit: '%', fmt: 'pct0', dec: 0, tier: DERIVED, source: '證交所 MI_INDEX（自算）', label: '上市成交值÷前20交易日均值', asOfD: D, asOfP: P }, sv.ratio20D ?? null, sv.ratio20P ?? null);

  // 官方上市家數（漲跌證券數合計·股票欄）
  const B = k => h => h.breadth?.[k];
  for (const [k, id, label, unit, fmt, dec, tier, scale] of [
    ['up', 'br.up', '上市上漲家數（官方）', '檔', 'int', 0, OFFICIAL, 1], ['dn', 'br.dn', '上市下跌家數（官方）', '檔', 'int', 0, OFFICIAL, 1], ['flat', 'br.flat', '上市持平家數（官方）', '檔', 'int', 0, OFFICIAL, 1],
    ['upLimit', 'br.upLimit', '上市漲停家數（官方）', '檔', 'int', 0, OFFICIAL, 1], ['dnLimit', 'br.dnLimit', '上市跌停家數（官方）', '檔', 'int', 0, OFFICIAL, 1],
    ['adr', 'br.adr', '上市漲跌比（漲÷(漲＋跌)）', '%', 'pct0', 0, DERIVED, 100], ['net', 'br.net', '上市漲家數減跌家數', '檔', 'int', 0, DERIVED, 1],
    ['indexRetPct', 'br.indexRetPct', '加權指數漲跌幅', '%', 'sg2', 2, DERIVED, 1], ['tseEwPct', 'br.tseEwPct', '上市等權報酬', '%', 'sg2', 2, DERIVED, 1],
    ['gapPp', 'br.gapPp', '指數漲幅減上市等權（大於0＝權值較強）', 'pp', 'sg2', 2, DERIVED, 1],
  ]) mk(id, label, unit, fmt, dec, h => (B(k)(h) != null ? B(k)(h) * scale : null), h => (B(k)(h) != null ? B(k)(h) * scale : null), tier, tier === OFFICIAL ? '證交所 MI_INDEX 漲跌證券數合計' : S);

  // 官方指數（MI_INDEX 價格指數表；漲跌點取 HTML 顏色符號、百分比由點數反推）
  const idxName = { twii: '發行量加權股價指數', tw50: '臺灣50指數', mid100: '臺灣中型100指數', small300: '小型股300指數', elec: '電子工業類指數', semi: '半導體類指數', fin: '金融保險類指數' };
  const labelOf = { twii: '加權指數', tw50: '臺灣50指數', mid100: '臺灣中型100指數', small300: '小型股300指數', elec: '電子工業類指數', semi: '半導體類指數', fin: '金融保險類指數' };
  for (const [key, name] of Object.entries(idxName)) {
    const a = miD?.indices?.[name];
    const b = miP?.indices?.[name];
    const src = '證交所 MI_INDEX 價格指數';
    if (key === 'twii') {
      addPair(book, 'ix.twii.close', { unit: '點', fmt: 'txt', dec: 2, tier: OFFICIAL, source: src, label: '加權指數收盤', asOfD: D, asOfP: P }, a?.close ?? null, b?.close ?? null);
      addPair(book, 'ix.twii.pts', { unit: '點', fmt: 'sg2', dec: 2, tier: OFFICIAL, source: src, label: '加權指數漲跌點', asOfD: D, asOfP: P }, a?.pts ?? null, b?.pts ?? null);
    }
    addPair(book, `ix.${key}.pct`, { unit: '%', fmt: 'sg2', dec: 2, tier: OFFICIAL, source: src, label: `${labelOf[key]}漲跌幅`, asOfD: D, asOfP: P }, a?.pct ?? null, b?.pct ?? null);
  }
  // 櫃買指數（backup indexHistory：相鄰交易日收盤差）
  const oD = c.otcD ?? null; const oP = c.otcP ?? null; const oPP = c.otcPP ?? null;
  const otcSrc = '櫃買指數日線（indexHistory）';
  addPair(book, 'ix.otc.close', { unit: '點', fmt: 'txt', dec: 2, tier: DERIVED, source: otcSrc, label: '櫃買指數收盤', asOfD: D, asOfP: P }, oD, oP);
  addPair(book, 'ix.otc.pts', { unit: '點', fmt: 'sg2', dec: 2, tier: DERIVED, source: otcSrc, label: '櫃買指數漲跌點', asOfD: D, asOfP: P }, oD != null && oP != null ? oD - oP : null, oP != null && oPP != null ? oP - oPP : null);
  addPair(book, 'ix.otc.pct', { unit: '%', fmt: 'sg2', dec: 2, tier: DERIVED, source: otcSrc, label: '櫃買指數漲跌幅', asOfD: D, asOfP: P }, oD != null && oP != null ? (oD / oP - 1) * 100 : null, oP != null && oPP != null ? (oP / oPP - 1) * 100 : null);

  // 權值股貢獻與集中度（熱力 index 區塊）
  mk('ix.conc10', '前10大權值股權重合計', '%', 'bn1', 1, h => h.index?.conc10, h => h.index?.conc10);
  mk('ix.w1', '第一大權值股權重', '%', 'bn1', 1, h => h.index?.w1, h => h.index?.w1);
  mk('ix.top5Pts', '前5大權值股對指數貢獻', '點', 'pts1', 1, h => splitOf(h, 5)?.pts, h => splitOf(h, 5)?.pts);
  mk('ix.top5RestPts', '其餘個股對指數貢獻（前5大以外）', '點', 'pts1', 1, h => splitOf(h, 5)?.restPts, h => splitOf(h, 5)?.restPts);
  mk('ix.top10Pts', '前10大權值股對指數貢獻', '點', 'pts1', 1, h => splitOf(h, 10)?.pts, h => splitOf(h, 10)?.pts);
  mk('ix.top10RestPts', '其餘個股對指數貢獻（前10大以外）', '點', 'pts1', 1, h => splitOf(h, 10)?.restPts, h => splitOf(h, 10)?.restPts);
  mk('ix.residualBp', '指數歸因殘差', 'bp', 'sg2', 2, h => h.index?.residualBp, h => h.index?.residualBp);
  if (hd?.index?.grade) book.add('ix.grade', { v: hd.index.grade, unit: '文字', fmt: 'txt', asOf: D, tier: DERIVED, source: S, label: '指數歸因殘差等級（紅＝歸因不可靠）' });
  if (hd?.index) {
    const cd = contribIndex(hd); const cp = hp ? contribIndex(hp) : new Map();
    const codes = [...new Set([
      '2330', ...(hd.index.contributors || []).slice(0, 3).map(x => x.code), ...(hd.index.draggers || []).slice(0, 3).map(x => x.code),
    ])].filter(k => cd.has(k));
    for (const code of codes) {
      const a = cd.get(code); const b = cp.get(code) ?? null;
      book.add(`ix.${code}.name`, { v: a.name, unit: '文字', fmt: 'txt', asOf: D, tier: DERIVED, source: S });
      const pairOne = (k, label, unit, fmt, dec, pick) => addPair(book, `ix.${code}.${k}`, { unit, fmt, dec, tier: DERIVED, source: S, label: `${a.name}${label}`, asOfD: D, asOfP: P }, pick(a), b ? pick(b) : null);
      pairOne('pts', '對指數貢獻', '點', 'pts1', 1, x => x.pts);
      pairOne('ret', '當日報酬', '%', 'sg2', 2, x => x.ret);
      pairOne('wPrev', '前一日權重', '%', 'txt', 2, x => x.wPrev);
    }
  }
}

// ── 官方產業別熱度 ─────────────────────────────────────────────────────────────────
/** 回 Map key → {n,ew,exMkt,upRatio,luN,heat,heatNo,shape}；heatNo＝heat 由大到小的名次（僅 n≥8 有 heat 者），同分依 key。 */
export function industryView(H) {
  const m = new Map();
  if (!H?.industries) return m;
  const ranked = H.industries.filter(i => i.heat != null).sort((a, b) => b.heat - a.heat || (a.key < b.key ? -1 : 1));
  const no = new Map(ranked.map((i, k) => [i.key, k + 1]));
  for (const i of H.industries) {
    m.set(i.key, { n: i.n, ew: i.ew, exMkt: i.exMkt, upRatio: i.upRatio != null ? i.upRatio * 100 : null, luN: i.luN, heat: i.heat ?? null, heatNo: no.get(i.key) ?? null, shape: i.shape ?? null, order: ranked.length });
  }
  return m;
}

/** keys：要輸出的產業；lead：key → 領漲文字（由上層以 stocks[] 算好）。 */
export function addIndustryRefs(book, { D, P, vD, vP, keys, lead }) {
  const S = '每日熱力定版（官方產業別）';
  for (const key of keys) {
    const a = vD.get(key) ?? null; const b = vP.get(key) ?? null;
    const base = `ind.${seg(key)}`;
    const one = (k, label, unit, fmt, dec, pick) => addPair(book, `${base}.${k}`, { unit, fmt, dec, tier: DERIVED, source: S, label: `${key}${label}`, asOfD: D, asOfP: P }, a ? pick(a) : null, b ? pick(b) : null);
    one('ew', '等權報酬', '%', 'sg2', 2, x => x.ew);
    one('exMkt', '超額（對全市場等權）', 'pp', 'sg2', 2, x => x.exMkt);
    one('upRatio', '上漲占比', '%', 'pct0', 0, x => x.upRatio);
    one('luN', '漲停檔數', '檔', 'int', 0, x => x.luN);
    one('heat', '熱度值（0.5·Z超額等權＋0.5·Z漲停占比）', '值', 'sg2', 2, x => x.heat);
    one('heatNo', '熱度名次（n≥8 才排）', '名', 'int', 0, x => x.heatNo);
    if (a) {
      book.add(`${base}.n`, { v: a.n, unit: '檔', fmt: 'int', asOf: D, tier: DERIVED, source: S, label: `${key}成分檔數` });
      if (a.shape) book.add(`${base}.shape`, { v: a.shape, unit: '文字', fmt: 'txt', asOf: D, tier: DERIVED, source: S, label: `${key}型態（普遍型／少數帶動型）` });
      const ld = lead?.get(key);
      if (ld) book.add(`${base}.lead`, { v: ld, unit: '文字', fmt: 'txt', asOf: D, tier: DERIVED, source: S, label: `${key}領漲個股（成交值≥暫訂門檻）` });
    }
  }
}

/** 熱力 watch.continue／layers：一律 tier:'先驗·未驗證'，原層級與 caveat 寫在 label。 */
export function addWatchLayerRefs(book, { D, H }) {
  if (!H) return;
  const S = '每日熱力 watch／layers';
  for (const w of H.watch?.continue || []) {
    book.add(`ind.${seg(w.key)}.watch`, { v: '持續觀察', unit: '文字', fmt: 'txt', asOf: D, tier: '先驗·未驗證', source: S, label: `${w.trigger?.rule ?? ''}｜${w.evidence?.level ?? ''}｜${w.evidence?.caveat ?? ''}` });
  }
  const pick = (arr, k) => (arr || []).filter(x => x.n >= 3 && x.exMkt != null).sort((a, b) => b.exMkt - a.exMkt || (a.key < b.key ? -1 : 1)).slice(0, k);
  for (const [name, abbr] of [['chains', 'chain'], ['segments', 'seg'], ['groups', 'grp']]) {
    for (const x of pick(H.layers?.[name], 3)) {
      const base = `ly.${abbr}.${seg(x.key)}`;
      const lab = `${x.key}（${x.tier}${x.lowN ? '·僅觀察(n小)' : ''}）`;
      const add = (k, v, unit, fmt, l) => book.addUnique(`${base}.${k}`, { v, unit, fmt, asOf: D, tier: '先驗·未驗證', source: S, label: `${lab}${l}` });
      add('ew', rnd(x.ew, 2), '%', 'sg2', '等權報酬');
      add('exMkt', rnd(x.exMkt, 2), 'pp', 'sg2', '超額');
      add('n', x.n, '檔', 'int', '成分檔數');
    }
  }
}

// ── 籌碼 ─────────────────────────────────────────────────────────────────────────
/** 法人估算（億元）：逐檔（買賣超股數×當日收盤）加總，含 ETF（與 BFI82U 對照 10-02 差 0.3–6.7 億）。缺收盤的檔略過並計入 skipped。 */
export function estimateInstBn(instRows, closeOf) {
  let f = 0; let t = 0; let d = 0; let n = 0; let skipped = 0;
  for (const [code, r] of instRows) {
    const close = closeOf(code);
    if (close == null) { skipped++; continue; }
    if (r.foreign != null) f += r.foreign * close;
    if (r.trust != null) t += r.trust * close;
    if (r.dealer != null) d += r.dealer * close;
    n++;
  }
  return { foreign: f / 1e8, trust: t / 1e8, dealer: d / 1e8, n, skipped };
}

const sum4 = (obj, i) => { let s = 0; let n = 0; for (const [k, v] of Object.entries(obj || {})) if (/^\d{4}$/.test(k)) { const x = Array.isArray(v) ? v[i] : v; if (Number.isFinite(x)) { s += x; n++; } } return n ? s : null; };

/** 融資融券借券（張，4 碼）、上市當沖比（同檔法）。 */
export function creditFromChip(chip) {
  if (!chip) return null;
  const margin = sum4(chip.margin, 0); const short = sum4(chip.margin, 1);
  const sblBal = sum4(chip.sbl, 0); const sblDay = sum4(chip.sbl, 1);
  let dtLots = 0; let volLots = 0;
  for (const [k, v] of Object.entries(chip.dayTrade || {})) {
    const vol = chip.close?.[k]?.[1];
    if (/^\d{4}$/.test(k) && Number.isFinite(v) && Number.isFinite(vol) && vol > 0) { dtLots += v; volLots += vol; }
  }
  return {
    margin, short, ratio: margin && short != null ? (short / margin) * 100 : null, sblBal, sblDay,
    dtTseRatio: volLots > 0 ? (dtLots / volLots) * 100 : null, dtOtcLots: chip.dtOtcStat?.lots ?? null,
  };
}

export function addChipRefs(book, c) {
  const { D, P, estD, estP, bfiD, bfiP, crD, crP, taD, taP } = c;
  const mkInst = (mkt, label, eD, eP) => {
    for (const [k, nm] of [['foreign', '外資'], ['trust', '投信'], ['dealer', '自營商']]) {
      addPair(book, `ch.${mkt}.${k}Bn`, { unit: '億', fmt: 'bn1', dec: 1, tier: DERIVED, source: `三大法人逐檔×收盤價（估）`, label: `${label}${nm}買賣超（估：逐檔股數×收盤價）`, asOfD: D, asOfP: P }, eD ? eD[k] : null, eP ? eP[k] : null);
    }
  };
  mkInst('tse', '上市', estD?.tse, estP?.tse);
  mkInst('otc', '上櫃', estD?.otc, estP?.otc);
  const o = (k, nm, fD, fP) => addPair(book, `ch.tse.official.${k}Bn`, { unit: '億', fmt: 'bn1', dec: 1, tier: OFFICIAL, source: '證交所 BFI82U 三大法人買賣金額', label: `上市${nm}買賣超（官方）`, asOfD: D, asOfP: P }, fD, fP);
  const yi = v => (v != null ? v / 1e8 : null);
  o('foreign', '外資及陸資', yi(bfiD?.foreign), yi(bfiP?.foreign));
  o('trust', '投信', yi(bfiD?.trust), yi(bfiP?.trust));
  o('dealerSelf', '自營商(自行買賣)', yi(bfiD?.dealerSelf), yi(bfiP?.dealerSelf));
  o('dealerHedge', '自營商(避險)', yi(bfiD?.dealerHedge), yi(bfiP?.dealerHedge));
  o('total', '三大法人合計', yi(bfiD?.total), yi(bfiP?.total));
  const cs = '籌碼歸檔 chipArchive（融資融券借券、當沖；4碼股票）';
  const cr = (id, label, unit, fmt, dec, pick) => addPair(book, id, { unit, fmt, dec, tier: DERIVED, source: cs, label, asOfD: D, asOfP: P }, crD ? pick(crD) : null, crP ? pick(crP) : null);
  cr('ch.margin.lots', '融資餘額', '張', 'int', 0, x => x.margin);
  cr('ch.short.lots', '融券餘額', '張', 'int', 0, x => x.short);
  cr('ch.short.ratio', '券資比（融券÷融資）', '%', 'txt', 2, x => x.ratio);
  cr('ch.sbl.balLots', '借券賣出餘額', '張', 'int', 0, x => x.sblBal);
  cr('ch.sbl.dayLots', '當日借券賣出', '張', 'int', 0, x => x.sblDay);
  cr('ch.dt.tseRatio', '上市當沖比（同檔法）', '%', 'txt', 2, x => x.dtTseRatio);
  cr('ch.dt.otcLots', '上櫃當沖張數（占比口徑待核，不放占比）', '張', 'int', 0, x => x.dtOtcLots);
  // 期交所（官方鏡像；站內 taifexPositions.foreignTxfNetOI 口徑有誤，不採用）
  const ts = '期交所（官方鏡像）';
  const tf = (id, label, unit, fmt, dec, pick) => addPair(book, id, { unit, fmt, dec, tier: OFFICIAL, source: ts, label, asOfD: D, asOfP: P }, taD ? pick(taD) : null, taP ? pick(taP) : null);
  tf('ch.fut.oiNet', '外資臺股期貨未平倉淨額', '口', 'int', 0, x => x.foreignTxf?.oiNet);
  tf('ch.fut.tradeNet', '外資臺股期貨交易口數淨額', '口', 'int', 0, x => x.foreignTxf?.tradeNet);
  tf('ch.fut.pcOi', '臺指選擇權買賣權未平倉量比', '%', 'txt', 2, x => x.putCall?.oiRatio);
  tf('ch.fut.pcVol', '臺指選擇權買賣權成交量比', '%', 'txt', 2, x => x.putCall?.volRatio);
  tf('ch.fut.vixOpen', '臺指VIX開盤值', '點', 'txt', 2, x => x.vixOpen);
}

// ── 全球／匯率／ADR／商品／日韓／標題 ──────────────────────────────────────────────────
const GL_SYM = { '^SOX': 'sox', '^IXIC': 'ixic', '^DJI': 'dji', '^GSPC': 'gspc', 'CL=F': 'wti' };
const SPOT_SLUG = { 'CL=F': 'wti', 'BZ=F': 'brent', 'NG=F': 'ng', 'HG=F': 'cu', 'ALI=F': 'al', 'GC=F': 'gold', 'SI=F': 'silver' };
const NON_OFFICIAL = '站內整理'; // 契約 tier 清單沒有「第三方行情」→ 以站內整理標示，source 字串寫明 Yahoo（非官方）

/**
 * 全球市場（Yahoo，非官方）：美股場次日由 quoteAt 以 America/New_York 換算；時點隔離＝quoteAt 不得晚於 cutoff；
 * 盤中值（quoteAt 早於該場次 16:00 ET）不引用。回 {degraded:[], absent:[], overnightStale, usDay}。
 */
export function addGlobalRefs(book, { D, cutoffMs, gm, asia, adr, spot }) {
  const degraded = []; const absent = [];
  const afterCut = []; const notFinal = []; const noTime = [];
  const expected = expectedUsDay(cutoffMs);
  let usDay = null; let allFinal = true; let nIdx = 0;
  const idxSyms = ['^SOX', '^IXIC', '^DJI', '^GSPC'];
  if (!gm || gm.absent) absent.push(`globalMarkets${gm?.reason ? `(${gm.reason})` : ''}`);
  else {
    for (const m of gm.data.markets) {
      const key = GL_SYM[m.sym];
      const isFx = m.sym === 'TWD=X';
      if (!key && !isFx) continue;
      if (!Number.isFinite(m.quoteAt)) { noTime.push(m.sym); continue; }
      if (m.quoteAt > cutoffMs) { afterCut.push(m.sym); continue; }
      const sess = nyDate(m.quoteAt);
      const close = nyCloseMs(sess);
      const final = close != null && m.quoteAt >= close;
      if (!final) { notFinal.push(m.sym); if (idxSyms.includes(m.sym)) allFinal = false; continue; }
      const base = isFx ? 'fx.usdtwd' : `gl.${key}`;
      const src = 'Yahoo Finance（非官方來源）';
      book.add(`${base}.${isFx ? 'price' : 'close'}`, { v: rnd(m.price, 2), unit: isFx ? '元' : '點', fmt: 'txt', asOf: sess, tier: NON_OFFICIAL, source: src, label: `${m.name}${isFx ? '' : '收盤'}（美東場次 ${sess}）` });
      book.add(`${base}.chg`, { v: rnd(m.changePct, 2), unit: '%', fmt: 'sg2', asOf: sess, tier: NON_OFFICIAL, source: src, label: `${m.name}漲跌幅（美東場次 ${sess}）` });
      if (idxSyms.includes(m.sym)) { nIdx++; if (usDay == null || sess > usDay) usDay = sess; }
    }
  }
  if (afterCut.length) degraded.push(`global:quote-after-cutoff:${afterCut.join(',')}`);
  if (notFinal.length) degraded.push(`global:quote-not-final:${notFinal.join(',')}`);
  if (noTime.length) degraded.push(`global:no-quote-time:${noTime.join(',')}`);
  const stale = !(nIdx > 0 && allFinal && usDay != null && expected != null && usDay >= expected);
  if (stale) degraded.push('global:overnight-not-updated');
  book.add('gl.meta.expectedUsDay', { v: expected, unit: '文字', fmt: 'date', asOf: D, tier: '官方衍生', source: '依 America/New_York 16:00 收盤與 cutoff 推算', label: 'cutoff 當下已收盤的最近美股平日（美股假日無來源，可能偏晚一天）' });
  if (usDay) book.add('gl.meta.usDay', { v: usDay, unit: '文字', fmt: 'date', asOf: usDay, tier: NON_OFFICIAL, source: 'globalMarkets 回聲（quoteAt→美東日）', label: '已採用之美股指數場次日' });
  book.add('gl.meta.usFinal', { v: nIdx > 0 && allFinal, unit: '文字', fmt: 'txt', asOf: D, tier: '官方衍生', source: 'quoteAt ≥ 該場次 16:00 ET', label: '美股指數報價是否為收盤定版' });
  book.add('gl.meta.overnightStale', { v: stale, unit: '文字', fmt: 'txt', asOf: D, tier: '官方衍生', source: 'usDay 對 expectedUsDay', label: '隔夜美股資料是否未更新（true＝不得評論隔夜）' });

  // 日韓
  if (!asia || asia.absent) absent.push(`asiaPremarket${asia?.reason ? `(${asia.reason})` : ''}`);
  else if (asia.data.lateCatchup) degraded.push('asia:lateCatchup');
  else if (Number.isFinite(asia.data.updatedAt) && asia.data.updatedAt > cutoffMs) degraded.push('asia:after-cutoff');
  else {
    const day = asia.data.date;
    const tag = `${asia.data.slot ?? '?'} ${asia.data.phase ?? '?'}`;
    const slug = { '^N225': 'n225', '^KS11': 'kospi', '^KQ11': 'kosdaq', '005930.KS': 'samsung', '000660.KS': 'hynix', '8035.T': 'tel', '6857.T': 'advantest', '034220.KS': 'lgd', '6981.T': 'murata', '6954.T': 'fanuc', '7203.T': 'toyota', '6758.T': 'sony' };
    for (const x of [...asia.data.indices, ...asia.data.bellwethers]) {
      const k = slug[x.sym] ?? seg(x.sym.toLowerCase());
      if (x.total == null || !day) continue;
      book.add(`gl.${k}.chg`, { v: rnd(x.total, 2), unit: '%', fmt: 'sg2', asOf: day, tier: NON_OFFICIAL, source: `Yahoo Finance 日韓盤（非官方，延遲約20分；${tag}）`, label: `${x.name}相對前收（${tag}）` });
    }
  }
  // ADR（無 ADR 報價時間 → 只用 updatedAt 日期，且不得晚於 cutoff；非 PIT）
  if (!adr || adr.absent) absent.push(`adrPremium${adr?.reason ? `(${adr.reason})` : ''}`);
  else if (!Number.isFinite(adr.data.updatedAt) || adr.data.updatedAt > cutoffMs) degraded.push('adr:after-cutoff-or-no-time');
  else {
    const day = tpeDate(adr.data.updatedAt);
    for (const x of adr.data.items) {
      const k = String(x.adr).toLowerCase();
      const src = 'adrPremium（站內，無ADR報價時間；盤中時為盤中價）';
      const add = (n, v, unit, fmt, l) => v != null && book.add(`adr.${k}.${n}`, { v: rnd(v, 2), unit, fmt, asOf: day, tier: NON_OFFICIAL, source: src, label: `${x.adr}${l}` });
      add('premium', x.premium, '%', 'sg2', 'ADR換算溢價（水位，不是漲跌預測）');
      add('adrUsd', x.adrUsd, '元', 'txt', '美元報價');
      add('implied', x.implied, '元', 'txt', '換算台幣價');
      add('twPrice', x.twPrice, '元', 'txt', '台股收盤價');
    }
    degraded.push('adr:non-pit');
  }
  // 商品現貨（sectorSpot：items[].asOf＝報價日；quoteAt 不得晚於 cutoff）
  if (!spot || spot.absent) absent.push(`sectorSpot${spot?.reason ? `(${spot.reason})` : ''}`);
  else {
    let spotCut = 0;
    for (const x of spot.data.items) {
      if (x.key === 'CL=F') continue; // 與 globalMarkets 的 WTI 重複
      const slug = SPOT_SLUG[x.key] ?? seg(String(x.key).toLowerCase());
      if (!x.asOf || (Number.isFinite(x.quoteAt) && x.quoteAt > cutoffMs)) { spotCut++; continue; }
      if (x.price == null) continue;
      const src = `${x.source ?? '來源未標'}（非官方）`;
      book.addUnique(`gl.${slug}.price`, { v: rnd(x.price, 2), unit: x.unit ?? '', fmt: 'txt', asOf: x.asOf, tier: NON_OFFICIAL, source: src, label: `${x.name}（${x.unit ?? ''}）` });
      if (x.chgPct != null) book.addUnique(`gl.${slug}.chg`, { v: rnd(x.chgPct, 2), unit: '%', fmt: 'sg2', asOf: x.asOf, tier: NON_OFFICIAL, source: src, label: `${x.name}漲跌幅` });
    }
    if (spotCut) degraded.push(`spot:after-cutoff(${spotCut}項)`);
  }
  return { degraded, absent, overnightStale: stale, usDay, expectedUsDay: expected };
}

/** newsDigest 標題（36 小時內；標題級、方向 null；不放連結與內文）。 */
export function addDigestRefs(book, { D, cutoffMs, digest, maxPerCat = 5, freshMs = 36 * 3600e3 }) {
  if (!digest || digest.absent) return { absent: [`newsDigest${digest?.reason ? `(${digest.reason})` : ''}`] };
  for (const cat of digest.data.cats) {
    const items = (cat.items || []).filter(x => Number.isFinite(x.at) && x.at <= cutoffMs && cutoffMs - x.at <= freshMs).sort((a, b) => b.at - a.at).slice(0, maxPerCat);
    items.forEach((x, i) => {
      book.add(`gl.news.${seg(cat.key)}.${i + 1}.title`, { v: String(x.title).slice(0, 120), unit: '文字', fmt: 'txt', asOf: tpeDate(x.at), tier: '媒體', source: `Google News 標題（${String(x.src ?? '').slice(0, 30)}）`, label: `${cat.label ?? cat.key}：標題級，方向 null，不得由標題推論方向／金額／受惠族群` });
    });
  }
  return { absent: [] };
}

// ── 行事曆 ─────────────────────────────────────────────────────────────────────────
/**
 * 只放 catalystCalendar 內真有的日期：(D, N+4] 區間，最多 maxN 筆（N 日優先）。type 保留原值；macro 為手寫常數→站內整理。
 * 缺口：美國 CPI／非農／央行等不在日曆 → 分析師不得補日期（此處不產 ref，也不暗示）。
 */
export function addCalendarRefs(book, { D, N, cal, maxN = 80 }) {
  if (!cal || cal.absent) return { absent: [`catalystCalendar${cal?.reason ? `(${cal.reason})` : ''}`], events: [] };
  const hi = addDays(N, 4);
  const seen = new Set(); const picked = [];
  for (const e of cal.data.events) {
    if (!e?.date || e.date <= D || e.date > hi) continue;
    const key = `${e.date}|${e.type}|${e.code ?? ''}|${e.title}`;
    if (seen.has(key)) continue;
    seen.add(key); picked.push(e);
  }
  picked.sort((a, b) => ((a.date === N ? 0 : 1) - (b.date === N ? 0 : 1)) || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (String(a.type) < String(b.type) ? -1 : 1) || (String(a.code ?? '') < String(b.code ?? '') ? -1 : 1));
  const taken = picked.slice(0, maxN);
  const asOf = (() => { const u = Number.isFinite(cal.data.updatedAt) ? tpeDate(cal.data.updatedAt) : D; return u > D ? D : u; })();
  const events = [];
  let k = 0;
  for (const e of taken) {
    const id = `cal.${e.date}.${seg(e.type)}.${e.code ? seg(e.code) : `n${++k}`}`;
    const ref = book.addUnique(id, { v: String(e.title).slice(0, 120), unit: '文字', fmt: 'txt', asOf, tier: e.type === 'macro' ? '站內整理' : '官方衍生', source: 'catalystCalendar（站內彙整官方日程）', label: `${e.type}｜${e.name ?? ''}` });
    events.push({ id: ref, date: e.date, type: e.type, code: e.code ?? null });
  }
  if (cal.data.from) book.add('cal.meta.from', { v: cal.data.from, unit: '文字', fmt: 'date', asOf, tier: '官方衍生', source: 'catalystCalendar', label: '日曆涵蓋起日（日曆薄≠沒事，不得寫「沒有重大事件」）' });
  if (cal.data.to) book.add('cal.meta.to', { v: cal.data.to, unit: '文字', fmt: 'date', asOf, tier: '官方衍生', source: 'catalystCalendar', label: '日曆涵蓋迄日' });
  return { absent: [], events, nonPit: Number.isFinite(cal.data.updatedAt) && tpeDate(cal.data.updatedAt) > D };
}
