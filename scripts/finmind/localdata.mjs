// ── 本機資料（只讀）：交易日、休市日、各日要抓哪些代號、官方鏡像收盤 ───────────────────────
// 各日抓哪些股票用本機官方收盤（chipArchive 備份）決定，不每天再花 1 次請求向 FinMind 要清單（目錄員建議）。
//   tradingDays：second-brain/backup/chipArchive 有收盤的日子（2022-07-18 起）＋已下載的 FinMind TaiwanStockTradingDate（更早）
//   holidays：官方鏡像 twse_oa_holidaySchedule（「開始交易／最後交易」是交易日標記不是休市，CLAUDE.md 同一條規則）
//   stocksFor：當日 4 碼股票、成交量>0、依量由大到小（流動性高的先抓）；chipArchive 沒有的日子退回 FinMind 還原股價（見 finmindVolumes）
//   etfsFor：官方鏡像上市 MI_INDEX＋上櫃 dailyQuotes 的 00 開頭代號、有成交；鏡像沒有的日子同上
//   brokersFor：FinMind 證券商清單快照的全部券商（不依 date 欄過濾：2026-10-08 試抓實測 date 不是設立日，聯邦 8580～8588 date=2026-05-04 卻在 2023 年有成交）
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const DATE_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;
const SHELL_MAX_BYTES = 2048;   // 空殼文件（只有 date/at/market）遠小於此；超過才解析確認
const CACHE_DAYS = 4;

export function rocToIso(s) {
  const m = String(s ?? '').match(/^(\d{3})(\d{2})(\d{2})$/);
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}

export function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || s === '--' || s === '---') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const readJsonGz = p => JSON.parse(gunzipSync(readFileSync(p)).toString('utf8'));
const listDir = d => { try { return readdirSync(d); } catch { return []; } };

function lru(limit) {
  const m = new Map();
  return (key, make) => {
    if (m.has(key)) return m.get(key);
    const v = make();
    m.set(key, v);
    if (m.size > limit) m.delete(m.keys().next().value);
    return v;
  };
}

/** 從官方鏡像 payload 找欄位符合 pick(fields) 的表，回傳 [{欄名: 值}]。 */
export function tableRows(payload, pick) {
  const tables = Array.isArray(payload?.tables) ? payload.tables : payload?.fields ? [payload] : [];
  const out = [];
  for (const t of tables) {
    const fields = (t.fields || []).map(f => String(f).trim());
    if (!pick(fields, t)) continue;
    for (const row of t.data || []) out.push(Object.fromEntries(fields.map((f, i) => [f, row[i]])));
  }
  return out;
}

export function createLocalData({ backup, official, finmind }) {
  const chipDir = join(backup, 'chipArchive');
  const closeCache = lru(CACHE_DAYS);
  const quoteCache = lru(CACHE_DAYS);
  const volCache = lru(CACHE_DAYS);
  let days = null; let hol = null; let brokers = null;

  function readChip(date) {
    const p = join(chipDir, `${date}.json`);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  }

  function closeFor(date) {
    return closeCache(date, () => {
      const doc = readChip(date);
      if (!doc?.closeJson) return null;
      let close; try { close = JSON.parse(doc.closeJson); } catch { return null; }
      const m = new Map();
      for (const [code, a] of Object.entries(close)) {
        if (Array.isArray(a)) m.set(code, { close: num(a[0]), lots: num(a[1]), open: num(a[2]), high: num(a[3]), low: num(a[4]) });
      }
      return m.size ? m : null;
    });
  }

  function finmindTradingDates() {
    const dir = join(finmind, 'TaiwanStockTradingDate');
    const out = [];
    for (const f of listDir(dir)) {
      if (!/\.jsonl\.gz$/.test(f) || f.includes('.part.')) continue;
      try { for (const line of gunzipSync(readFileSync(join(dir, f))).toString('utf8').split('\n')) if (line) out.push(JSON.parse(line).date); } catch { /* 壞檔略過，下次重抓 */ }
    }
    return out;
  }

  function tradingDays() {
    if (days) return days;
    const set = new Set(finmindTradingDates().filter(Boolean).map(d => String(d).slice(0, 10)));
    for (const f of listDir(chipDir)) {
      const m = f.match(DATE_FILE); if (!m) continue;
      let size = 0; try { size = statSync(join(chipDir, f)).size; } catch { continue; }
      if (size > SHELL_MAX_BYTES || closeFor(m[1])) set.add(m[1]);
    }
    days = [...set].sort();
    return days;
  }

  function mirrorPayload(host, id, date) {
    const p = join(official, host, id, `${date}.json.gz`);
    if (!existsSync(p)) return null;
    try { const j = readJsonGz(p); return typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload; } catch { return null; }
  }

  function holidays() {
    if (hol) return hol;
    hol = new Set();
    const dir = join(official, 'openapi.twse.com.tw', 'twse_oa_holidaySchedule_holidaySchedule');
    const files = listDir(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort();
    for (const f of files) {
      let list; try { const j = readJsonGz(join(dir, f)); list = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload; } catch { continue; }
      for (const h of Array.isArray(list) ? list : []) {
        if (/開始交易|最後交易/.test(String(h.Name || ''))) continue;
        const iso = rocToIso(h.Date); if (iso) hol.add(iso);
      }
    }
    return hol;
  }

  function officialQuotes(date) {
    return quoteCache(date, () => {
      const m = new Map();
      const tse = mirrorPayload('www.twse.com.tw', 'twse_mi_index', date);
      for (const r of tableRows(tse, f => f.includes('證券代號') && f.includes('收盤價'))) {
        m.set(String(r['證券代號']).trim(), { market: 'tse', shares: num(r['成交股數']), open: num(r['開盤價']), high: num(r['最高價']), low: num(r['最低價']), close: num(r['收盤價']) });
      }
      const otc = mirrorPayload('www.tpex.org.tw', 'tpex_dailyquotes', date);
      for (const r of tableRows(otc, f => f.includes('代號') && f.includes('收盤'))) {
        m.set(String(r['代號']).trim(), { market: 'otc', shares: num(r['成交股數']), open: num(r['開盤']), high: num(r['最高']), low: num(r['最低']), close: num(r['收盤']),
          issued: num(r['發行股數']), nextRef: num(r['次日 參考價']), nextUp: num(r['次日 漲停價']), nextDown: num(r['次日 跌停價']) });
      }
      return m.size ? m : null;
    });
  }

  // chipArchive／官方鏡像只到 2022-07-18：更早的日子（空閒佇列）退回已下載的 FinMind 還原股價（全市場逐日；Trading_Volume＝官方成交股數，
  //   2026-10-08 試抓實測 100% 相同）。B 段要先跑完 TaiwanStockPriceAdj 的 2023 以前，分 K／逐筆的 2023 以前才排得出代號。
  function finmindVolumes(date) {
    return volCache(date, () => {
      const p = join(finmind, 'TaiwanStockPriceAdj', date.slice(0, 4), `${date}.jsonl.gz`);
      if (!existsSync(p)) return null;
      const m = new Map();
      try {
        for (const line of gunzipSync(readFileSync(p)).toString('utf8').split('\n')) {
          if (!line) continue;
          const r = JSON.parse(line); const v = num(r.Trading_Volume);
          if (r.stock_id != null && v > 0) m.set(String(r.stock_id).trim(), v);
        }
      } catch { return null; }   // 壞檔：當作沒有清單（計畫列為略過），不猜
      return m.size ? m : null;
    });
  }
  const byVolumeDesc = entries => entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code]) => code);

  function stocksFor(date) {
    const c = closeFor(date);
    if (!c) { const f = finmindVolumes(date); return f ? byVolumeDesc([...f.entries()].filter(([code]) => /^\d{4}$/.test(code))) : null; }
    return byVolumeDesc([...c.entries()].filter(([code, v]) => /^\d{4}$/.test(code) && v.lots > 0).map(([code, v]) => [code, v.lots]));
  }

  function etfsFor(date) {
    const q = officialQuotes(date);
    if (!q) { const f = finmindVolumes(date); return f ? byVolumeDesc([...f.entries()].filter(([code]) => /^00\w+$/.test(code))) : null; }
    return byVolumeDesc([...q.entries()].filter(([code, v]) => /^00\w+$/.test(code) && v.shares > 0).map(([code, v]) => [code, v.shares]));
  }

  function brokerList() {
    if (brokers) return brokers;
    const dir = join(finmind, 'TaiwanSecuritiesTraderInfo');
    const snap = listDir(dir).filter(f => /^snapshot_.*\.jsonl\.gz$/.test(f) && !f.includes('.part.')).sort().pop();
    if (!snap) return null;
    brokers = gunzipSync(readFileSync(join(dir, snap))).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
      .map(b => ({ id: String(b.securities_trader_id).trim(), since: b.date ? String(b.date).slice(0, 10) : null })).filter(b => b.id);
    return brokers;
  }

  // 參數保留（呼叫端以日期查詢）；清單本身不隨日期變
  function brokersFor(_date) {
    const list = brokerList(); if (!list) return null;
    return list.map(b => b.id).sort();
  }

  return { tradingDays, holidays, closeFor, stocksFor, etfsFor, officialQuotes, mirrorPayload, brokersFor };
}
