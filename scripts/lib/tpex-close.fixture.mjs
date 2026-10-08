// 上櫃收盤檔測試夾具（不含測試；被 tpex-close-*.test.mjs 共用）：合成 openapi 檔、合成帶日期 dailyQuotes、模擬伺服器（串流／停滯／斷線）、
//   真實完整檔的尋找（不依賴 session scratchpad：env → ~/Downloads → 本機共用快取／收件匣 _done → 官方鏡像本機檔；2026-10-08 審查 LOW）。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** 2026-10-08 使用者瀏覽器下載檔＝curl 完整檔的 sha256（12,221 列／4 碼 886／00 開頭 118） */
export const KNOWN_1008_SHA = '62ef8965';
const sha = buf => createHash('sha256').update(buf).digest('hex');
const listSafe = dir => { try { return readdirSync(dir).sort(); } catch { return []; } };

/**
 * 真實完整 openapi 檔（原始位元組）→ { buf, from, sha256, known1008 } 或 null（本機都沒有＝呼叫端明示略過）。
 *   鏡像本機檔存的是解析後的 payload，重新序列化後位元組與官方原檔不同（sha 不比），內容與欄位相同。
 */
export function realFullFixture() {
  const tries = [];
  if (process.env.TPEX_FIXTURE) tries.push(() => readFileSync(process.env.TPEX_FIXTURE));
  tries.push(() => readFileSync(join(homedir(), 'Downloads', 'tpex_mainboard_daily_close_quotes.json')));
  const tc = process.env.TPEX_CLOSE_ROOT || join(REPO, 'second-brain', 'tpex-close');
  for (const n of listSafe(join(tc, '_inbox', '_done')).reverse()) tries.push(() => readFileSync(join(tc, '_inbox', '_done', n)));
  for (const n of listSafe(tc).filter(n => /\.openapi\.json\.gz$/.test(n)).reverse()) tries.push(() => gunzipSync(readFileSync(join(tc, n))));
  const mir = join(process.env.OFFICIAL_ROOT || join(REPO, 'second-brain', 'official'), 'www.tpex.org.tw', 'tpex_oa_tpex_mainboard_daily_close_quotes');
  for (const n of listSafe(mir).filter(n => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(n)).reverse()) tries.push(() => Buffer.from(JSON.stringify(JSON.parse(gunzipSync(readFileSync(join(mir, n))).toString('utf8')).payload)));
  for (const t of tries) {
    try {
      const buf = t();
      const j = JSON.parse(buf.toString('utf8'));
      if (!Array.isArray(j) || j.length < 1000) continue;
      const h = sha(buf);
      return { buf, sha256: h, known1008: h.startsWith(KNOWN_1008_SHA) };
    } catch { /* 下一個 */ }
  }
  return null;
}
/** 截斷檔：env 指定的實檔，或由完整檔切到約 1.78MB（10-08 實測 120 秒只收到 1.78MB 的情形） */
export function truncatedFixture(full) {
  if (process.env.TPEX_TRUNC_FIXTURE && existsSync(process.env.TPEX_TRUNC_FIXTURE)) return readFileSync(process.env.TPEX_TRUNC_FIXTURE);
  return full ? full.subarray(0, Math.min(1_780_000, full.length - 1000)) : null;
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason || new Error('aborted')); }, { once: true });
});

/** 小型合成 openapi 檔：n4 檔 4 碼＋006201＋00679B＋etfExtra 檔 00 開頭 6 碼 ETF＋warrants 檔權證 */
export function synthOpenapi({ roc = '1151008', n4 = 5, warrants = 3, closeBad = 0, etfExtra = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < n4; i++) rows.push({ Date: roc, SecuritiesCompanyCode: String(1100 + i), CompanyName: `股${i}`, Close: i < closeBad ? ' ---' : `${10 + i}.00`, Change: '+0.10 ', Open: '9.90', High: '10.50', Low: '9.80', Average: '10.1', TradingShares: '1000', TransactionAmount: '10000', TransactionNumber: '5', LatestBidPrice: '10', LatesAskPrice: '10.05', Capitals: `${1000000 + i}`, NextReferencePrice: '10', NextLimitUp: '11', NextLimitDown: '9' });
  rows.push({ Date: roc, SecuritiesCompanyCode: '006201', CompanyName: 'ETF', Close: '20.00', Change: '0.00', Open: '20', High: '20', Low: '20', TradingShares: '10', TransactionAmount: '200', TransactionNumber: '1', Capitals: '5000' });
  rows.push({ Date: roc, SecuritiesCompanyCode: '00679B', CompanyName: '債ETF', Close: '30.00', Change: '0.00', Open: '30', High: '30', Low: '30', TradingShares: '10', TransactionAmount: '300', TransactionNumber: '1', Capitals: '5000' });
  for (let i = 0; i < etfExtra; i++) rows.push({ Date: roc, SecuritiesCompanyCode: `00${7000 + i}`, CompanyName: `ETF${i}`, Close: '15.00', Change: '0.00', Open: '15', High: '15', Low: '15', TradingShares: '10', TransactionAmount: '150', TransactionNumber: '1', Capitals: '5000' });
  for (let i = 0; i < warrants; i++) rows.push({ Date: roc, SecuritiesCompanyCode: String(700000 + i), CompanyName: `權證${i}`, Close: ' ---' });
  return rows;
}

export const DATED_FIELDS = ['代號', '名稱', '收盤', '漲跌', '開盤', '最高', '最低', '均價', '成交股數', '成交金額(元)', '成交筆數', '最後買價', '最後買量(張數)', '最後賣價', '最後賣量(張數)', '發行股數', '次日 參考價', '次日 漲停價', '次日 跌停價'];
/** 合成帶日期 dailyQuotes（n4 檔 4 碼＋006201＋權證 1 檔；管理股票表空） */
export function datedPayload(iso, { n4 = 5 } = {}) {
  const row = c => [c, `名${c}`, '10.00', '+0.10', '9.9', '10.5', '9.8', '10.1', '1,000', '10,000', '5', '10', '1', '10.05', '1', '1,000,000', '10', '11', '9'];
  const [y, m, d] = iso.split('-');
  const data = [...Array.from({ length: n4 }, (_, i) => row(String(1100 + i))), row('006201'), row('700001')];
  return { stat: 'ok', date: `${y}${m}${d}`, tables: [{ title: '上櫃股票行情', date: `${+y - 1911}/${m}/${d}`, fields: DATED_FIELDS, data }, { title: '管理股票', fields: DATED_FIELDS, data: [] }] };
}

/**
 * 模擬伺服器：plan(url, init, i) → { status, headers, ttfb, chunks:[{delay, data}], reset, hangAfter }
 * reset：送完 chunks 後斷線（TypeError terminated）；hangAfter：送完 chunks 後永遠不再送（停滯）。f.calls 記每次請求的 url 與標頭。
 */
export function mockFetch(plan) {
  const calls = [];
  const f = async (url, init = {}) => {
    const i = calls.length; calls.push({ url, headers: { ...(init.headers || {}) } });
    const p = plan(url, init, i);
    await sleep(p.ttfb || 0, init.signal);
    const noBody = [204, 304, 416].includes(p.status) || !p.chunks;
    const body = noBody ? null : new ReadableStream({
      async start(ctl) {
        const abort = () => { try { ctl.error(init.signal.reason || new Error('aborted')); } catch { /* 已關閉 */ } };
        if (init.signal) { if (init.signal.aborted) return abort(); init.signal.addEventListener('abort', abort, { once: true }); }
        try {
          for (const c of p.chunks) { await sleep(c.delay || 0, init.signal); ctl.enqueue(new Uint8Array(Buffer.from(c.data))); }
          if (p.hangAfter) return;
          if (p.reset) ctl.error(new TypeError('terminated'));
          else ctl.close();
        } catch { /* abort 已處理 */ }
      },
    });
    return new Response(body, { status: p.status || 200, headers: p.headers || {} });
  };
  f.calls = calls;
  return f;
}
