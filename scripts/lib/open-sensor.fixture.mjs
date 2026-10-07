// 開盤感應器測試夾具（只給 *.test.mjs 用）：假 Firestore、合成交易日（不打網路、不碰真 Firestore）
/** 假 Firestore：collection/doc/get/set(merge)/create/runTransaction/getAll；writes 記錄每次寫入的路徑 */
export function fakeDb() {
  const store = new Map(), writes = [];
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const merge = (a, b) => { const o = { ...(a || {}) }; for (const k of Object.keys(b)) o[k] = isObj(b[k]) && isObj(o[k]) ? merge(o[k], b[k]) : structuredClone(b[k]); return o; };
  const ref = (col, id) => {
    const key = `${col}/${id}`;
    return {
      key, id,
      get: async () => ({ exists: store.has(key), id, data: () => structuredClone(store.get(key)) }),
      set: async (data, opts) => { writes.push(key); store.set(key, opts?.merge ? merge(store.get(key), data) : structuredClone(data)); },
      create: async data => { if (store.has(key)) { const e = new Error('6 ALREADY_EXISTS: Document already exists'); e.code = 6; throw e; } writes.push(key); store.set(key, structuredClone(data)); },
    };
  };
  return {
    store, writes,
    collection: col => ({ doc: id => ref(col, id) }),
    runTransaction: async fn => fn({ get: r => r.get(), set: (r, d, o) => { r.set(d, o); } }),
    getAll: async (...refs) => Promise.all(refs.filter(r => r && r.get).map(r => r.get())),
  };
}

/**
 * 合成市場：n 檔上市普通股（2330 最大），全部以同一個漲跌幅開出；回傳產生報價與 t00 拍子的函式。
 *   wPct：權值 30 漲跌%；gPct：其餘漲跌%；price 基準 300 元（讓 P̄ 接近實盤量級）。
 */
export function mkMarket({ n = 120, wPct = 2.6, gPct = 0.6, unopened = [] } = {}) {
  const closeMap = {}, sharesTse = {}, marketOf = {};
  const codes = [];
  for (let i = 0; i < n; i++) {
    const c = i === 0 ? '2330' : String(1100 + i);
    codes.push(c);
    closeMap[c] = [300, 5000]; sharesTse[c] = i === 0 ? 2e10 : 1e9 - i * 1e6; marketOf[c] = 'tse';
  }
  for (let i = 0; i < 1000; i++) marketOf[String(5000 + i)] = 'otc';   // 代碼表規模（名單建置要求 ≥1000）
  const w30 = new Set(codes.slice(0, 30));
  const quotesAt = (revealAt, volume) => {
    const mis = {};
    for (const c of codes) {
      const pct = w30.has(c) ? wPct : gPct;
      mis[c] = unopened.includes(c)
        ? { price: 300, prev: 300, volume: 0, open: 0, revealAt, hasLive: false }
        : { price: +(300 * (1 + pct / 100)).toFixed(2), prev: 300, volume, open: 300.9, revealAt, hasLive: true };
    }
    return mis;
  };
  const tickAt = (revealAt, m) => ({ price: 48000 * (1 + wPct / 100), prev: 48000, mVal: m, open: 48100, revealAt, realTrade: true });
  const otcAt = revealAt => ({ price: 430, prev: 426.93, mVal: 0, open: 427, revealAt, realTrade: true });
  return { closeMap, sharesTse, marketOf, codes, quotesAt, tickAt, otcAt };
}

/** openMarks（openSensorMarks-v1）合成：c(T) 依檢查點固定比例 */
export function mkOpenMarks() {
  const pct = { m0902: 0.0726, m0903: 0.0902, m0904: 0.1068, m0910: 0.1748, m0920: 0.2485, m0930: 0.3131, m0940: 0.367, m0950: 0.4094, m1000: 0.45 };
  const marks = {};
  for (const [k, p] of Object.entries(pct)) marks[k] = { t: `${k.slice(1, 3)}:${k.slice(3)}:00`, yi: 10_000 * p, lots: Math.round(12_000_000 * p), pctYi: p };
  return { basis: 'openSensorMarks-v1', auction: { t: '09:00:05', yi: 150, lots: 120_000 }, day: { yi: 10_000, lots: 12_000_000 }, marks };
}
