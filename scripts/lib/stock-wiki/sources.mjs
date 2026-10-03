// ─────────────────────────────────────────────────────────────────────────────
// 台股 wiki 第二大腦：官方來源抓取＋本地快取（2026-10-03）
//
// 只打 scripts/source-registry.json 已核准的網域：
//   openapi.twse.com.tw  上市公司基本資料 t187ap03_L、10% 大股東 t187ap02_L、董監持股 t187ap11_L、基金(ETF)基本資料 t187ap47_L
//   mops.twse.com.tw     公司基本資料 t05st03（上市＋上櫃都有，含「主要經營業務」）
//
// 這些都是**慢變數**（公司基本資料、董監名單），快取到 second-brain/wiki/.cache，預設 30 天才重抓——
// wiki 重建不會打上游，上游請求數與重建次數脫鉤。
// MOPS 逐檔查詢：單一出口、固定間隔、連續失敗斷路（不重試 4xx），避免同 IP 的 daemon 重大訊息抓取被連坐。
// 抓不到就留缺，不捏造（頁面會寫「來源未提供」）。
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' };
const DAY_MS = 86400000;

export const TWSE_OPENDATA = 'https://openapi.twse.com.tw/v1/opendata/';
export const MOPS_API = 'https://mops.twse.com.tw/mops/api/';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
const isFresh = (cached, maxAgeDays, now) => cached?.fetchedAt && now - cached.fetchedAt < maxAgeDays * DAY_MS;

/** 證交所 openapi 整批端點（一次一個請求）。回 { fetchedAt, rows, from: 'cache'|'net'|'stale' } */
export async function loadTwseOpenData(cacheDir, ep, { maxAgeDays = 7, refresh = false, now = Date.now(), fetchImpl = fetch } = {}) {
  const file = path.join(cacheDir, 'twse', `${ep}.json`);
  const cached = readJsonSafe(file);
  if (!refresh && isFresh(cached, maxAgeDays, now)) return { ...cached, from: 'cache' };
  try {
    const r = await fetchImpl(TWSE_OPENDATA + ep, { headers: UA, signal: AbortSignal.timeout(60000), redirect: 'manual' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);   // 不存在的端點會 302 到 404.html，redirect:manual 讓它直接失敗
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('空回應');
    const out = { fetchedAt: now, rows };
    writeJsonAtomic(file, out);
    return { ...out, from: 'net' };
  } catch (e) {
    if (cached?.rows) return { ...cached, from: 'stale', error: e.message };   // stale-if-error
    return { fetchedAt: null, rows: [], from: 'none', error: e.message };
  }
}

/** MOPS t05st03 單檔：把 {key:{value,isHidden}} 攤平成只含可見欄位的物件 */
export function flattenMops(result) {
  const out = {};
  for (const [k, v] of Object.entries(result || {})) {
    if (!v || v.isHidden) continue;
    const val = typeof v.value === 'string' ? v.value.trim() : v.value;
    if (val === '' || val === '-' || val == null) continue;
    out[k] = val;
  }
  return out;
}

async function mopsPost(api, body, fetchImpl) {
  const r = await fetchImpl(MOPS_API + api, {
    method: 'POST',
    headers: { ...UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  const j = await r.json();
  if (j?.code !== 200) { const e = new Error(`MOPS ${j?.code ?? '?'} ${j?.message || ''}`.trim()); e.mopsCode = j?.code; throw e; }
  return j.result;
}

const NOT_FOUND_RE = /查無|格式錯誤|不存在|無此/;
export const mopsCacheFile = (cacheDir, code) => path.join(cacheDir, 'mops-t05st03', `${code}.json`);
export const readMopsCompany = (cacheDir, code) => readJsonSafe(mopsCacheFile(cacheDir, code));

/**
 * MOPS 公司基本資料逐檔抓（可中斷續跑：已有新鮮快取的跳過）。
 * 斷路：連續 3 次失敗 → 暫停 pauseMs；暫停 3 次仍失敗 → 整批中止（多半是被限流，硬撐只會延長封鎖）。
 * 查無資料（下市、代號不是公司）記成 { notFound:true }，30 天內不再問。
 */
export async function crawlMopsCompanies(cacheDir, codes, {
  paceMs = 2500, maxAgeDays = 30, pauseMs = 5 * 60000, now = () => Date.now(),
  fetchImpl = fetch, sleepImpl = sleep, log = () => {},
} = {}) {
  const stat = { fetched: 0, cached: 0, notFound: 0, failed: 0, aborted: false };
  let consecutive = 0; let pauses = 0;
  // 查無：已有好資料就**不覆蓋**，只記 checkedAt（2026-10-03 審查：一次 MOPS 抖動曾把台積電的好資料改寫成 notFound 並鎖 30 天）
  const markMiss = (code, cached, reason) => {
    if (cached?.data) writeJsonAtomic(mopsCacheFile(cacheDir, code), { ...cached, checkedAt: now(), lastMiss: reason });
    else writeJsonAtomic(mopsCacheFile(cacheDir, code), { fetchedAt: now(), notFound: true, reason });
    stat.notFound++;
  };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const cached = readMopsCompany(cacheDir, code);
    if (isFresh(cached, maxAgeDays, now())) { stat.cached++; continue; }
    try {
      const result = await mopsPost('t05st03', { companyId: code }, fetchImpl);
      const flat = flattenMops(result);
      if (flat.companyName) { writeJsonAtomic(mopsCacheFile(cacheDir, code), { fetchedAt: now(), data: flat }); stat.fetched++; }
      else markMiss(code, cached, '回應無公司名稱');
      consecutive = 0;
    } catch (e) {
      // 「查無／格式錯誤」才是真的不存在；其他業務碼（系統忙碌、查詢過量…）與 HTTP 錯誤一律當故障計入斷路器
      if (e.mopsCode != null && !e.status && NOT_FOUND_RE.test(e.message)) {
        markMiss(code, cached, e.message); consecutive = 0;
      } else {
        stat.failed++; consecutive++;
        log(`  ✗ ${code} ${e.message}`);
        if (consecutive >= 3) {
          pauses++;
          if (pauses > 3) { stat.aborted = true; log('  ⛔ MOPS 連續失敗，中止（保留已抓的快取，下次續跑）'); break; }
          log(`  ⏸ 連續 ${consecutive} 次失敗，暫停 ${Math.round(pauseMs / 60000)} 分鐘`);
          await sleepImpl(pauseMs); consecutive = 0;
        }
      }
    }
    if ((i + 1) % 50 === 0) log(`  · MOPS ${i + 1}/${codes.length}（新抓 ${stat.fetched}、快取 ${stat.cached}、查無 ${stat.notFound}、失敗 ${stat.failed}）`);
    await sleepImpl(paceMs);
  }
  return stat;
}
