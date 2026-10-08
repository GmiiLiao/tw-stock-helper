// ─────────────────────────────────────────────────────────────────────────
// 上櫃收盤第三方後備：FinMind（2026-10-08；使用者：「上櫃收盤以官方優先如果失敗改由第三方來源補上，例如finmind」）
//   只在官方全部來源（記憶體／本機快取／收件匣／官方鏡像本機檔／櫃買網路）都沒有當日檔、且過了後備啟用時點時才打；只有 daemon 會打。
//
//   ■ 啟用時點 21:50、再試 23:30（每日最多 2 次 FinMind 請求，含 TaiwanStockInfo）；daemon 以獨立計時器（startTpexThirdPartyTimer，每 3 分鐘）呼叫 tick，
//     不放在循序的 dailyJobsLoop 裡——23:00 盤後新聞判別趟常跑到 00:34–01:43，放在迴圈裡 23:30 時段永遠輪不到（2026-10-08 審查 HIGH）。
//     跨日收尾：日期換了而前一天既沒取得 3P、官方也沒到、也沒發過缺漏告警（例：daemon 在時段內沒執行）⇒ 新的一天第一次 tick 補發一次。
//     daemon 日誌 2026-07-23～10-08 共 54 個交易日：上櫃併入歸檔 38 天在 16:40 前、10 天 16:41–17:00、2 天 17:01–18:00、
//     1 天 20:25（08-31）、2 天 21:01–21:45（09-24 21:37、08-06 21:45）；只有 08-20 當天整天沒到（openapi 斷線、帶日期端點逾時）。
//     ⇒ 21:50 之前啟用等於有 3 天會先發布第三方資料，違反「官方優先」；21:45 正是 canonicalGate 告警與 21:45 官方重試那一輪，
//     後備接在後面；離 FinMind 標稱的 17:30 已超過 4 小時；22:40 官方鏡像、23:10 起漲影子還來得及吃到。21:50 拿到空資料＝FinMind 也還沒有
//     （notYet，中性），23:30 再試 1 次；兩次都沒有 ⇒ 交易日缺漏告警，不捏造。
//   ■ 口徑（探針 2026-10-08，三個交易日 08-20／10-07／10-08，官方上櫃 35,100 列）：TaiwanStockPrice 單日全市場是櫃買 dailyQuotes 的逐位複本——
//     開高低收、成交股數、成交金額、成交筆數 100% 相同；量一律是「股」、含鉅額（官方晚間版）⇒ 不換算，volumeBasis='tpex-dailyQuotes'。
//     唯一要轉的：官方 '---'（無成交價）FinMind 寫 0 ⇒ 收盤為 0 的列開高低收與漲跌都寫回 '---'（含「有量無價」列；不轉會灌水收盤可解析率、種子出現 close 0）。
//     除權息日官方漲跌寫「除權／除息」、FinMind 給 0——num() 兩者都得 0，網站字串會是 0.00。
//     FinMind 沒有：均價、最後買賣價、發行股數 Capitals、次日參考／漲跌停 ⇒ 不捏造、不放進列，文件記 missingFields。
//   ■ 篩上櫃（FinMind 是上市＋上櫃＋興櫃＋指數＋上市權證全部混在一起）：前一份官方上櫃集合（Info 最新列為 twse／emerging 者剔除——已轉上市）
//     ∪ 上櫃權證碼型 ^7\d{5}$｜^7\d{4}[A-Z]$（不在 Info）∪ Info 取 date 最新列＝tpex 且代號為數字型（排除 'TPEx' 指數列）。
//     10-07、10-08 實測 0 誤入 0 漏。不可用「Info 任一列含 tpex」（10 檔已轉上市＋指數列會誤入）。Info 只反映「現在」⇒ 只在補「今天」時用；
//     沒有 Info（額度用完、請求失敗）只用前兩者——會漏當天新上櫃股（每天 0–2 檔，遠低於 3% 門檻），在文件 note 說明。
//   ■ 完整性：同一套 validateTpexClose（資料日＝期望日〔逐列 date 回聲〕、4 碼 ≥800、00 開頭 ≥60、無重複、收盤可解析、與前一份官方相比缺 ≤3%）。
//   ■ 標示與覆蓋：存本機快取 thirdParty（不進官方鏈）、文件 source='finmind'、grade='3P'；官方之後到了 ⇒ supersededBy，網站文件由官方 set() 整份覆蓋。
//     只在內部標示——網站不顯示來源字樣。「只收官方」的下游（歷史 K 棒、訓練、定版）以 grade 排除 3P（不看 volumeBasis）。
//   ■ 模式（env TPEX_CLOSE_3P）：off（預設，不打任何請求）｜local（取得、驗證、存本機、告警，不寫 Firestore）｜publish（再寫網站用的 tpexClose）。
//     ⚠ 兩種模式都要等使用者裁定：FinMind Sponsor 是「非商業用途」方案（專案評估：台股助手有付費會員＝商業用途，方案表把「公司內部系統」
//     也列為商業用途 ⇒ 從嚴解讀 local 的營運用途也不在授權內）；publish 另涉及「不得再散布原始資料」「須標示來源 FinMind」，
//     與「網站不顯示 FinMind 字樣」直接衝突。程式閘門（resolveMode）：env 之外還要 scripts/source-registry.json 的 api.finmindtrade.com
//     條目 legitimacy.status＝approved 且 legitimacy.scopes 明列 'tpex-close-3p-local'（或 publish）／'tpex-close-3p-publish'，否則強制 off。
//   ■ token：repo 外設定檔 ~/.config/tw-stock-app/finmind.env（存在就優先）→ 環境變數 FINMIND_TOKEN → repo .env.local 的 FINMIND_TOKEN 行；
//     只放 Authorization: Bearer 標頭；絕不印出、不寫日誌／檔案／錯誤訊息（FinMind 錯誤回應會回聲 token 末 8 碼 token_tail，一律抹除）。
//     錯誤文字先抹再截（全文、任何 ≥16 字的 token 片段、JWT 型字串、末 8 碼、token_tail 欄），上游回聲長前綴＋token 也不會留下前段。
//   ■ 請求：60 秒逾時；402（額度）／429（限流）＝等下一個時段（23:30），再失敗當日停用；401／403／TokenIllegal＝當日停用＋告警。
//     逐筆記錄到 second-brain/tpex-close/_thirdparty/requests.log（env FINMIND_REQUEST_LOG 可改；不含 token）。
//     每日上限不只靠狀態檔：記憶體也記當日計數（取兩者較大）；狀態檔寫不進去 ⇒ fail-closed（當日不再請求、告警一次）。
//     官方網路下載仍在進行（tpex.isFetching）⇒ busy，下一拍再判斷，不搶先打第三方或發佈 3P。
//   ■ 告警（會經 notifyDeveloper 出現在網站管理員警示）一律只寫「第三方後備／3P」與原因類別；FinMind 字樣、HTTP 細節只留 daemon 日誌、
//     state.json 與 requests.log。
//   不 import scripts/finmind/**（另一流程的回補 client）；只用 node 內建模組與 tpex-close-parse.mjs。
// 單元測試：node --test scripts/lib/tpex-close-finmind.test.mjs
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as P from './tpex-close-parse.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FINMIND_DATA_URL = 'https://api.finmindtrade.com/api/v4/data';
export const THIRD_PARTY = Object.freeze({ source: 'finmind', grade: '3P', volumeBasis: 'tpex-dailyQuotes' });
/** openapi 欄中 FinMind 沒有的（不捏造、不放進列） */
export const MISSING_FIELDS = Object.freeze(['Average', 'LatestBidPrice', 'LatesAskPrice', 'Capitals', 'NextReferencePrice', 'NextLimitUp', 'NextLimitDown']);
export const FALLBACK_POLICY = Object.freeze({
  firstMin: 21 * 60 + 50,   // 官方最晚 21:45 併入（54 交易日）；見檔頭
  retryMin: 23 * 60 + 30,
  maxRequests: 2,           // 每日 FinMind 請求上限（價格與 Info 合計）
  timeoutMs: 60_000,        // 全市場一次約 8MB，實測 1.9–5.8 秒
  throttleMs: 2 * 60_000,   // 時段未到時，官方檢查／發佈檢查的最小間隔
  timerMs: 3 * 60_000,      // daemon 獨立計時器間隔（23:30 時段最晚 23:33 輪到）
  closeOutDays: 4,          // 跨日收尾只看這麼近的前一份狀態（長假後的舊狀態直接略過，不補發陳年告警）
});
export const TOKEN_PATHS = Object.freeze({ config: join(homedir(), '.config', 'tw-stock-app', 'finmind.env'), envLocal: join(REPO, '.env.local') });

const MODES = ['off', 'local', 'publish'];
/** env TPEX_CLOSE_3P → off｜local｜publish（其他值一律 off）——只是「要求的模式」；實際模式要再過 resolveMode 的登錄閘門 */
export function modeOf(env = process.env) { const v = String(env?.TPEX_CLOSE_3P ?? '').trim().toLowerCase(); return MODES.includes(v) ? v : 'off'; }

/** source-registry 的核准範圍代號（legitimacy.scopes）；publish 範圍涵蓋 local */
export const REGISTRY_SCOPES = Object.freeze({ local: 'tpex-close-3p-local', publish: 'tpex-close-3p-publish' });
export const FINMIND_HOST = 'api.finmindtrade.com';
export const REGISTRY_PATH = join(REPO, 'scripts', 'source-registry.json');
/** 讀登錄檔；讀不到或格式壞回 null（＝沒有核准 ⇒ off） */
export function loadSourceRegistry(path = REGISTRY_PATH) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
/** 登錄檔 → FinMind 條目已核准的範圍（legitimacy.status 不是 approved ⇒ 空） */
export function finmindScopesOf(registry) {
  const e = (Array.isArray(registry?.sources) ? registry.sources : []).find(x => x?.host === FINMIND_HOST);
  if (!e || e.legitimacy?.status !== 'approved' || !Array.isArray(e.legitimacy?.scopes)) return [];
  return e.legitimacy.scopes.map(String);
}
/**
 * 實際模式＝env 要求的模式 ∩ 登錄檔核准範圍；沒核准一律 off（含 local）。回 { mode, requested, reason }——reason 給 daemon 開機記一次。
 */
export function resolveMode({ env = process.env, registry = null } = {}) {
  const requested = modeOf(env);
  if (requested === 'off') return { mode: 'off', requested, reason: null };
  const scopes = finmindScopesOf(registry);
  const allowed = requested === 'local' ? [REGISTRY_SCOPES.local, REGISTRY_SCOPES.publish] : [REGISTRY_SCOPES.publish];
  if (!allowed.some(x => scopes.includes(x))) {
    return { mode: 'off', requested, reason: `source-registry 的 ${FINMIND_HOST} 未核准 ${REGISTRY_SCOPES[requested]}（legitimacy.scopes）——強制 off，待使用者裁定 Sponsor 授權範圍` };
  }
  return { mode: requested, requested, reason: null };
}

// ── token ──
/** .env 文字 → 第一個非空的 FINMIND_TOKEN 值（容許 export、引號；註解行與空值行略過） */
export function tokenFromEnvText(txt) {
  for (const line of String(txt ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?FINMIND_TOKEN\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const v = m[1].replace(/^(['"])(.*)\1$/, '$2').trim();
    if (v && !v.startsWith('#')) return v;
  }
  return null;
}
/**
 * token 讀取：repo 外設定檔（存在且有值就優先）→ 環境變數 → .env.local。回 { token, from: 'config'|'env'|'env-local'|null }——from 只是類別，不含路徑或內容。
 * 執行時才讀（每次請求前），不快取在模組層。
 */
export function readFinmindToken({ env = process.env, configPath = TOKEN_PATHS.config, envLocalPath = TOKEN_PATHS.envLocal, readFile = p => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const fromFile = p => { try { return p && exists(p) ? tokenFromEnvText(readFile(p)) : null; } catch { return null; } };
  const c = fromFile(configPath); if (c) return { token: c, from: 'config' };
  const e = String(env?.FINMIND_TOKEN ?? '').trim(); if (e) return { token: e, from: 'env' };
  const l = fromFile(envLocalPath); if (l) return { token: l, from: 'env-local' };
  return { token: null, from: null };
}
/** 呼叫端先截到這麼長再抹（token 181 字；落在截斷邊界的片段由「≥16 字片段」規則抹掉，最後輸出再截到 160 字） */
export const REDACT_SCAN_MAX = 4096;
const TOKEN_FRAG = 16;
const JWT_RE = /eyJ[\w-]+\.[\w-]+(?:\.[\w-]*)?/g;
/** 抹掉 token 全文、任何 ≥16 字的 token 片段（上游截斷回聲）、JWT 型字串、末 8 碼與 token_tail 欄值——一律在截斷之前呼叫 */
export function redactToken(text, token) {
  let s = String(text ?? '');
  if (token) {
    s = s.split(token).join('[token]');
    if (token.length >= TOKEN_FRAG) {
      const frags = new Set();
      for (let i = 0; i + TOKEN_FRAG <= token.length; i++) frags.add(token.slice(i, i + TOKEN_FRAG));
      const cover = new Uint8Array(s.length); let hit = false;
      for (let p = 0; p + TOKEN_FRAG <= s.length; p++) if (frags.has(s.slice(p, p + TOKEN_FRAG))) { cover.fill(1, p, p + TOKEN_FRAG); hit = true; }
      if (hit) {
        let out = '';
        for (let i = 0; i < s.length;) {
          if (!cover[i]) { out += s[i++]; continue; }
          while (i < s.length && cover[i]) i++;
          out += '[token]';
        }
        s = out;
      }
    }
    const tail = token.slice(-8);
    if (tail.length === 8) s = s.split(tail).join('[token-tail]');
  }
  return s.replace(JWT_RE, '[jwt]').replace(/("?token_tail"?\s*[:=]\s*"?)[^",}\s]*/gi, '$1[redacted]');
}

// ── 請求 ──
const isoNow = ms => new Date(ms + 8 * 3600e3).toISOString().replace('Z', '+08:00').slice(0, 25);
/**
 * @param {{tokenReader?:Function, fetchImpl?:Function, timeoutMs?:number, logPath?:string|null, logTag?:string, now?:()=>number}} opts
 * request(dataset, params) → { status: ok|notYet|quota|auth|rate|failed|noToken, http, rows, reason, bytes, ms }
 */
export function createFinmindRequester({ tokenReader = readFinmindToken, fetchImpl = fetch, timeoutMs = FALLBACK_POLICY.timeoutMs, logPath = null, logTag = '[otc-3p]', now = Date.now } = {}) {
  const writeLog = (entry, token) => {
    if (!logPath) return;
    try { mkdirSync(dirname(logPath), { recursive: true }); appendFileSync(logPath, `${logTag} ${isoNow(now())} ${redactToken(JSON.stringify(entry), token)}\n`); } catch { /* 記錄失敗不擋 */ }
  };
  async function request(dataset, params = {}) {
    for (const k of Object.keys(params)) if (/token/i.test(k)) throw new Error('token 不可放在 URL 參數（只放 Authorization 標頭）');
    const { token } = tokenReader() || {};
    const qs = new URLSearchParams({ dataset, ...params }).toString();
    const label = `/data?${qs}`;
    if (!token) { writeLog({ dataset, url: label, skipped: 'noToken' }, null); return { status: 'noToken', http: null, rows: null, reason: 'FinMind token 未設定', bytes: 0, ms: 0 }; }
    const t0 = now(); let http = null; let bytes = 0;
    const done = (status, extra = {}) => {
      const out = { status, http, rows: null, reason: null, bytes, ms: now() - t0, ...extra };
      out.reason = out.reason == null ? null : redactToken(String(out.reason).slice(0, REDACT_SCAN_MAX), token).slice(0, 160);   // 先抹再截
      writeLog({ dataset, url: label, http, status, rows: Array.isArray(out.rows) ? out.rows.length : 0, bytes, ms: out.ms, ...(out.reason ? { reason: out.reason } : {}) }, token);
      return out;
    };
    let text;
    try {
      const res = await fetchImpl(`${FINMIND_DATA_URL}?${qs}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; TW-Stock-App/1.0)' }, signal: AbortSignal.timeout(timeoutMs) });
      http = res.status;
      text = await res.text(); bytes = Buffer.byteLength(text);
    } catch (e) {
      const why = e?.name === 'TimeoutError' || /timeout/i.test(String(e?.message)) ? `逾時 ${Math.round(timeoutMs / 1000)} 秒` : String(e?.cause?.code || e?.message || e);
      return done('failed', { reason: why });
    }
    let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
    const msg = String(j?.msg ?? text ?? '').slice(0, REDACT_SCAN_MAX);   // 只粗截（避免 8MB 本文），抹 token 在 done() 裡、最後才截到 160 字
    if (http === 402) return done('quota', { reason: `HTTP 402 ${msg}` });
    if (http === 401 || http === 403) return done('auth', { reason: `HTTP ${http} ${msg}` });
    if (http === 429) return done('rate', { reason: 'HTTP 429' });
    if (http !== 200) return done('failed', { reason: `HTTP ${http} ${msg}` });
    if (!j || typeof j !== 'object') return done('failed', { reason: '回應不是 JSON' });
    if (String(j.msg).toLowerCase() !== 'success') return done(/token/i.test(String(j.msg)) ? 'auth' : 'failed', { reason: `msg=${msg}` });
    if (!Array.isArray(j.data)) return done('failed', { reason: '缺 data 陣列' });
    if (!j.data.length) return done('notYet', { rows: [], reason: '空資料（FinMind 尚未有這一天）' });
    return done('ok', { rows: j.data });
  }
  return { request };
}

// ── 篩選與轉換 ──
const WARRANT_RE = /^7\d{5}$|^7\d{4}[A-Z]$/;
const NUMERIC_CODE_RE = /^\d{4,6}[A-Z]?$/;
const codeOf = r => String(r?.stock_id ?? r?.SecuritiesCompanyCode ?? '').trim();
/** Info → 代號 → { types:Set（date 最新那幾列的 type）, name } */
function infoLatest(infoRows) {
  const m = new Map();
  for (const r of infoRows || []) {
    const id = codeOf(r); const d = String(r?.date ?? ''); const type = String(r?.type ?? '').trim();
    const cur = m.get(id);
    if (!cur || d > cur.date) m.set(id, { date: d, types: new Set([type]), name: String(r?.stock_name ?? '').trim() });
    else if (d === cur.date) cur.types.add(type);
  }
  return m;
}

/**
 * FinMind 全市場 → 上櫃列（代號集合規則見檔頭）
 * @returns {{rows:object[], excluded:string[], method:string, note:string|null}}
 */
export function selectOtcRows({ priceRows, prevOfficialRows, infoRows = null }) {
  const prev = new Set((prevOfficialRows || []).map(codeOf));
  const info = infoRows && infoRows.length ? infoLatest(infoRows) : null;
  const rows = []; const excluded = [];
  for (const r of priceRows || []) {
    const c = codeOf(r);
    const li = info?.get(c);
    const listedElsewhere = li && (li.types.has('twse') || li.types.has('emerging'));
    const keep = (prev.has(c) && !listedElsewhere)
      || (WARRANT_RE.test(c) && !li)
      || (!!li && li.types.size === 1 && li.types.has('tpex') && NUMERIC_CODE_RE.test(c));
    (keep ? rows : excluded).push(keep ? r : c);
  }
  return {
    rows, excluded, method: info ? 'prev+warrant+info' : 'prev+warrant',
    note: info ? null : '沒有 TaiwanStockInfo：只用前一份官方集合＋權證碼型，當天新上櫃股（每天約 0–2 檔）可能漏列',
  };
}

const px = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '---'; };
const signed = v => { const n = Number(v) || 0; return n > 0 ? `+${n.toFixed(2)}` : n < 0 ? `-${Math.abs(n).toFixed(2)}` : '0.00'; };
const intStr = v => { const n = Number(v); return Number.isFinite(n) ? String(Math.round(n)) : '0'; };
/** FinMind 列 → openapi 形狀（欄名同櫃買 openapi；FinMind 沒有的欄不放） */
export function toOpenapiRows(rows, { iso, nameOf = () => '' }) {
  const roc = P.rocOf(iso);
  return (rows || []).map(r => {
    const c = codeOf(r);
    const hasPx = Number(r.close) > 0;
    return {
      Date: roc, SecuritiesCompanyCode: c, CompanyName: String(nameOf(c) ?? ''),
      Close: hasPx ? px(r.close) : '---', Change: hasPx ? signed(r.spread) : '---',
      Open: hasPx ? px(r.open) : '---', High: hasPx ? px(r.max) : '---', Low: hasPx ? px(r.min) : '---',
      TradingShares: intStr(r.Trading_Volume), TransactionAmount: intStr(r.Trading_money), TransactionNumber: intStr(r.Trading_turnover),
    };
  });
}

/**
 * 組裝＋驗證：FinMind 當日全市場 → { status: ok|notYet|invalid, rows(openapi 形狀), stats, reason, meta }
 *   prevOfficial：前一份已驗證官方檔 { dataDate, rows }（名稱來源、集合篩選、缺漏比對）；infoRows：只在補「今天」時給。
 */
export function buildThirdPartyClose({ iso, priceRows, infoRows = null, prevOfficial = null, limits = P.LIMITS }) {
  if (!Array.isArray(priceRows) || !priceRows.length) return { status: 'notYet', rows: null, stats: null, reason: '空資料', meta: null };
  const badDate = priceRows.find(r => String(r?.date ?? '') !== iso);
  if (badDate) return { status: 'invalid', rows: null, stats: null, reason: `date 不一致（${codeOf(badDate)} ${badDate?.date}≠${iso}）`, meta: null };
  const sel = selectOtcRows({ priceRows, prevOfficialRows: prevOfficial?.rows || [], infoRows });
  const prevName = new Map((prevOfficial?.rows || []).map(r => [codeOf(r), String(r.CompanyName ?? '').trim()]));
  const info = infoRows && infoRows.length ? infoLatest(infoRows) : null;
  const nameOf = c => prevName.get(c) || info?.get(c)?.name || '';
  const rows = toOpenapiRows(sel.rows, { iso, nameOf });
  const v = P.validateTpexClose({ format: 'finmind', echo: iso, rows }, { expect: iso, prevCodes4: prevOfficial?.rows ? P.codes4Of(prevOfficial.rows) : null, limits: { ...P.LIMITS, ...(limits || {}) } });
  const meta = {
    ...THIRD_PARTY, missingFields: [...MISSING_FIELDS], otcFilter: sel.method, prevOfficial: prevOfficial?.dataDate || null,
    note: sel.note, excluded: sel.excluded.length,
  };
  if (v.status !== 'ok') return { status: v.status === 'notYet' ? 'notYet' : 'invalid', rows: null, stats: v.stats, reason: v.reason, meta };
  return { status: 'ok', rows, stats: v.stats, reason: null, meta };
}

// ── 排程控制器（daemon 獨立計時器呼叫 tick(今天)；狀態落地＋記憶體，重啟不重打）──
const pad2 = n => String(n).padStart(2, '0');
const twOf = ms => { const d = new Date(ms + 8 * 3600e3); return { iso: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes() }; };
const hhmmOf = mins => `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
const weekday = iso => { const dow = new Date(`${iso}T12:00:00Z`).getUTCDay(); return dow >= 1 && dow <= 5; };
const dayBefore = iso => new Date(Date.parse(`${iso}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function writeAtomic(p, s) { mkdirSync(dirname(p), { recursive: true }); const tmp = `${p}.tmp-${process.pid}`; writeFileSync(tmp, s); renameSync(tmp, p); }

/** 告警用的原因類別（告警會出現在網站管理員警示：不寫來源名稱、不帶 HTTP 細節；細節只進日誌／state.json／requests.log） */
const ALERT_WHY = Object.freeze({
  noToken: '憑證（token）未設定', auth: '來源拒絕：憑證無效或權限不足', quota: '額度用完，兩個時段都失敗', rate: '限流，兩個時段都失敗',
  notYet: '第三方也尚未有這一天', failed: '請求失敗', invalid: '第三方資料驗證不過（不存、不發佈）', state: '狀態檔寫不進去（fail-closed：無法記錄請求次數，今日不再請求）',
  closeOut: '日期已過，當日第三方後備未完成（時段內未取得，或 daemon 當時未執行）',
});

/**
 * @param {{tpex:object, mode?:string, requester?:object, now?:()=>number, log?:Function, onAlert?:Function, onPublish?:Function|null,
 *          isTradingDay?:(iso:string)=>boolean, policy?:object, limits?:object|null, statePath?:string}} opts
 *   tpex：createTpexClose 的實例（getTpexClose／getLatestTpexClose／storeThirdParty／getThirdParty／markThirdPartySuperseded／isFetching）。
 *   onPublish(res)：publish 模式才呼叫（daemon 寫 Firestore tpexClose；res.grade='3P'）；回 false＝沒寫成（下一輪再試），其他值＝完成。
 *   mode：daemon 傳 resolveMode() 的結果（已過登錄閘門）。
 */
export function createTpexThirdParty({ tpex, mode = 'off', requester = null, now = Date.now, log = () => {}, onAlert = () => {}, onPublish = null,
  isTradingDay = weekday, policy = {}, limits = null, statePath = null } = {}) {
  const pol = { ...FALLBACK_POLICY, ...policy };
  const root = tpex?.root || join(REPO, 'second-brain', 'tpex-close');
  const sp = statePath || join(root, '_thirdparty', 'state.json');
  const rq = requester || createFinmindRequester({ now, timeoutMs: pol.timeoutMs, logPath: process.env.FINMIND_REQUEST_LOG || join(root, '_thirdparty', 'requests.log') });
  let inflight = null; let lastLight = 0; let published = null; let closedOutFor = null;
  // 記憶體當日狀態（2026-10-08 審查 MEDIUM）：每日上限不只靠狀態檔——狀態檔寫不進去、被刪、讀回壞掉時，記憶體仍記得今天打過幾次（取兩者較大）
  let mem = null;

  const fresh = iso => ({ v: 1, date: iso, requests: 0, info: 0, slots: { first: null, retry: null }, disabled: null, alerted: { final: false, ok: false }, closedOut: false });
  const norm = (s, iso) => ({ ...fresh(iso), ...s, slots: { ...fresh(iso).slots, ...(s.slots || {}) }, alerted: { ...fresh(iso).alerted, ...(s.alerted || {}) } });
  const later = (a, b) => (!a ? b : !b ? a : ((b.at || 0) > (a.at || 0) ? b : a));
  const load = iso => {
    const raw = readJson(sp); const d = raw?.date === iso ? norm(raw, iso) : null;
    const m = mem?.date === iso ? norm(structuredClone(mem), iso) : null;
    if (!d || !m) return d || m || fresh(iso);
    return {
      ...d, requests: Math.max(d.requests || 0, m.requests || 0), info: Math.max(d.info || 0, m.info || 0),
      slots: { first: later(d.slots.first, m.slots.first), retry: later(d.slots.retry, m.slots.retry) },
      disabled: d.disabled || m.disabled, closedOut: !!(d.closedOut || m.closedOut),
      alerted: { final: !!(d.alerted.final || m.alerted.final), ok: !!(d.alerted.ok || m.alerted.ok) },
    };
  };
  /** 先記記憶體、再落地；回 false＝狀態檔寫不進去（呼叫端據此 fail-closed） */
  const save = st => {
    mem = structuredClone(st);
    try { writeAtomic(sp, JSON.stringify(st, null, 1)); return true; }
    catch (e) { log(`  ⚠ 上櫃第三方後備狀態寫入失敗：${String(e?.message || '').slice(0, 60)}`); return false; }
  };
  const slotDone = (st, slot) => !!st.slots[slot];
  const slotOk = st => st.slots.first?.status === 'ok' || st.slots.retry?.status === 'ok';

  const finalAlert = (st, iso, why) => {
    if (st.alerted.final) return;
    st.alerted.final = true; save(st);
    const t = twOf(now());
    onAlert(`🚨 上櫃收盤 ${iso} 交易日缺漏：官方到 ${t.iso === iso ? '' : `${t.iso} `}${hhmmOf(t.mins)} 仍未取得，第三方後備也未取得（${why}）。全站上櫃沿用前一份；不捏造。官方仍會持續重試，也可手動下載放進 second-brain/tpex-close/_inbox/`, `tpex-3p-final-${iso}`);
  };
  /** 當日停用：logReason 進日誌（可含來源名稱與 HTTP 細節），alertWhy 進告警（只寫類別） */
  const disable = (st, iso, logReason, alertWhy) => {
    st.disabled = { reason: logReason, at: now() }; save(st);
    log(`  ⚠ 上櫃第三方後備 ${iso} 今日停用：${logReason}`);
    finalAlert(st, iso, `今日停用：${alertWhy}`);
    return { status: 'disabled', reason: logReason };
  };

  async function publishIfNeeded(res) {
    if (mode !== 'publish' || !onPublish || !res || res.supersededBy) return false;
    if (published?.iso === res.dataDate && published.sha === res.sha256) return false;
    const ok = await onPublish(res);
    if (ok === false) { log(`  ⚠ 上櫃第三方後備 ${res.dataDate} 發佈未完成（寫入進行中或失敗），下一輪再試`); return false; }   // 只有明確失敗才重試；其餘（已寫／已有同一份／網站已有更新或同日官方）都算完成
    published = { iso: res.dataDate, sha: res.sha256 };
    return true;
  }

  async function attempt(iso, slot, st) {
    st.requests++; st.slots[slot] = { status: 'pending', at: now() };
    if (!save(st)) {   // 記不住請求次數就不請求（fail-closed）——否則每一拍都會再打一次
      st.requests--; st.slots[slot] = { status: 'stateUnwritable', at: now() };
      return disable(st, iso, `狀態檔 ${sp} 寫不進去（fail-closed：無法記錄請求次數，今日不再請求）`, ALERT_WHY.state);
    }
    const r = await rq.request('TaiwanStockPrice', { start_date: iso, end_date: iso });
    if (r.status === 'noToken') { st.requests--; st.slots[slot] = { status: 'noToken', at: now() }; return disable(st, iso, 'FinMind token 未設定（~/.config/tw-stock-app/finmind.env、環境變數 FINMIND_TOKEN 或 .env.local）', ALERT_WHY.noToken); }
    if (r.status === 'auth') { st.slots[slot] = { status: 'auth', reason: r.reason, at: now() }; return disable(st, iso, `FinMind 拒絕（${r.reason}；token 無效或權限不足）`, ALERT_WHY.auth); }
    const isLast = slot === 'retry' || st.requests >= pol.maxRequests;
    if (r.status !== 'ok') {
      st.slots[slot] = { status: r.status, reason: r.reason, at: now() }; save(st);
      log(`  ⚠ 上櫃第三方後備 ${iso}（${slot === 'first' ? hhmmOf(pol.firstMin) : hhmmOf(pol.retryMin)} 時段）未取得：${r.status}（${r.reason || ''}）${isLast ? '' : `，${hhmmOf(pol.retryMin)} 再試`}`);
      if (!isLast) return { status: 'tried', reason: r.reason };
      if (r.status === 'quota' || r.status === 'rate') return disable(st, iso, `FinMind ${r.status === 'quota' ? '額度用完（402）' : '限流（429）'}，兩個時段都失敗`, ALERT_WHY[r.status]);
      finalAlert(st, iso, ALERT_WHY[r.status] || ALERT_WHY.failed);
      return { status: 'tried', reason: r.reason };
    }
    // 前一份官方（名稱、集合、缺漏比對）；Info 只在補「今天」且還有額度時抓
    let prev = null;
    try { prev = await tpex.getLatestTpexClose({ maxAgeDays: 14, before: dayBefore(iso) }); } catch { prev = null; }
    let infoRows = null;
    if (iso === twOf(now()).iso && st.requests < pol.maxRequests) {
      st.requests++; st.info++;
      if (!save(st)) {   // 記不住第 2 次就不打 Info（fail-closed），價格照用前一份官方集合＋權證碼型篩；今日不再請求
        st.disabled = { reason: '狀態檔寫不進去（fail-closed）', at: now() }; mem = structuredClone(st);
        log(`  ⚠ 上櫃第三方後備 ${iso}：狀態檔寫不進去，不請求 TaiwanStockInfo、今日不再請求`);
      } else {
        const ir = await rq.request('TaiwanStockInfo', {});
        if (ir.status === 'ok') infoRows = ir.rows;
        else log(`  ⚠ 上櫃第三方後備 ${iso}：TaiwanStockInfo 未取得（${ir.status}），只用前一份官方集合＋權證碼型篩選`);
      }
    }
    const b = buildThirdPartyClose({ iso, priceRows: r.rows, infoRows, prevOfficial: prev ? { dataDate: prev.dataDate, rows: prev.rows } : null, limits: limits || P.LIMITS });
    if (b.status !== 'ok') {
      st.slots[slot] = { status: b.status === 'notYet' ? 'notYet' : 'invalid', reason: b.reason, at: now() }; save(st);
      const noMore = slot === 'retry' || st.requests >= pol.maxRequests || !!st.disabled;   // Info 可能已用掉第 2 次額度 ⇒ 沒有下一個時段
      log(`  ⚠ 上櫃第三方後備 ${iso} 驗證不過：${b.reason}（不存、不發佈）${noMore ? '' : `，${hhmmOf(pol.retryMin)} 再試`}`);
      if (noMore) finalAlert(st, iso, b.status === 'notYet' ? ALERT_WHY.notYet : `${ALERT_WHY.invalid}：${String(b.reason || '').slice(0, 60)}`);
      return { status: 'tried', reason: b.reason };
    }
    const stored = await tpex.storeThirdParty({ iso, rows: b.rows, meta: b.meta });
    if (!stored.stored && !stored.same) { st.slots[slot] = { status: 'official', reason: stored.reason, at: now() }; save(st); return { status: 'official', reason: stored.reason }; }
    st.slots[slot] = { status: 'ok', at: now(), rows: b.stats?.rows ?? null, stocks4: b.stats?.stocks4 ?? null, otcFilter: b.meta.otcFilter }; save(st);
    const res = tpex.getThirdParty(iso);
    log(`  ✓ 上櫃第三方後備 ${iso}：${b.stats.rows} 列／4 碼 ${b.stats.stocks4}／00 開頭 ${b.stats.etf00}（篩選 ${b.meta.otcFilter}；前一份官方 ${b.meta.prevOfficial || '無'}；模式 ${mode}）`);
    await publishIfNeeded(res);
    if (!st.alerted.ok) {
      st.alerted.ok = true; save(st);
      onAlert(`⚠ 上櫃收盤 ${iso} 官方到 ${hhmmOf(twOf(now()).mins)} 仍未取得，已改用第三方後備（3P·內部標示；${b.stats.stocks4} 檔 4 碼股，量為股、口徑同官方）${mode === 'publish' ? '並更新網站上櫃收盤' : '，僅存本機（未上站）'}；官方到了會自動覆蓋。`, `tpex-3p-ok-${iso}`);
    }
    return { status: '3P', reason: null };
  }

  /**
   * 跨日收尾（2026-10-08 審查 HIGH）：前一天（closeOutDays 內）有嘗試過、但沒取得 3P、官方也沒到、也沒發過缺漏告警 ⇒ 補發一次。
   *   0 請求（只讀本機）；每個日期每個程序最多檢查一次。
   */
  async function closeOutPrevious(todayIso) {
    const disk = readJson(sp);
    const iso = [mem?.date, disk?.date].filter(d => P.toIso(d) === d && d < todayIso).sort().at(-1);
    if (!iso || closedOutFor === iso) return;
    closedOutFor = iso;
    if (daysBetween(iso, todayIso) > pol.closeOutDays) return;
    const st = load(iso);
    if (st.alerted.final || st.closedOut || slotOk(st) || (!st.requests && !st.slots.first && !st.slots.retry)) return;
    const off = await tpex.getTpexClose(iso, { network: 'never' }).catch(() => null);
    if (off?.status === 'ok' || tpex.getThirdParty(iso)) { st.closedOut = true; save(st); return; }
    log(`  ⚠ 上櫃第三方後備 ${iso}：日期已過、當日未完成（最後狀態 first=${st.slots.first?.status || '-'}／retry=${st.slots.retry?.status || '-'}），補發交易日缺漏告警`);
    st.closedOut = true;
    finalAlert(st, iso, ALERT_WHY.closeOut);
  }

  /** daemon 計時器呼叫（今天的資料日）；回 { status: off|skip|wait|official|3P|3P-cached|waiting|tried|disabled|cap|busy|throttled, reason } */
  async function tick(iso) {
    if (mode === 'off') return { status: 'off', reason: '模式 off（TPEX_CLOSE_3P 未設或登錄未核准）' };
    const t = twOf(now());
    try { await closeOutPrevious(t.iso); } catch (e) { log(`  ⚠ 上櫃第三方後備跨日收尾例外：${String(e?.message || e).slice(0, 80)}`); }
    if (!P.toIso(iso) || !isTradingDay(iso)) return { status: 'skip', reason: '非交易日' };
    if (iso !== t.iso) return { status: 'skip', reason: '只補今天' };
    if (t.mins < pol.firstMin) return { status: 'wait', reason: `${hhmmOf(pol.firstMin)} 前不啟用` };
    if (inflight) return { status: 'busy', reason: '上一輪還在跑' };
    const st0 = load(iso);
    const slot = t.mins >= pol.retryMin ? 'retry' : 'first';
    const due = !st0.disabled && !slotDone(st0, slot) && !(slot === 'retry' && st0.slots.first?.status === 'ok') && st0.requests < pol.maxRequests;
    if (!due && now() - lastLight < pol.throttleMs) return { status: 'throttled', reason: null };
    lastLight = now();
    inflight = (async () => {
      const off = await tpex.getTpexClose(iso, { network: 'never' });
      const cached = tpex.getThirdParty(iso);
      if (off?.status === 'ok') {
        if (cached && !cached.supersededBy) await tpex.markThirdPartySuperseded(iso, { source: off.source, format: off.format, sha256: off.sha256 });
        return { status: 'official', reason: null };
      }
      // 官方網路下載還在進行（daemon 的 _tpexWithin 逾時後讓下載在背景繼續）⇒ 這一拍不打第三方、也不先發佈 3P（2026-10-08 審查 LOW）
      if (typeof tpex.isFetching === 'function' && tpex.isFetching(iso)) return { status: 'busy', reason: '官方下載進行中' };
      if (cached) { await publishIfNeeded(cached); return { status: '3P-cached', reason: null }; }
      const st = load(iso);
      if (st.disabled) return { status: 'disabled', reason: st.disabled.reason };
      if (st.requests >= pol.maxRequests) return { status: 'cap', reason: `今日已用 ${st.requests} 次` };
      if (slotDone(st, slot)) return { status: 'waiting', reason: slot === 'first' ? `${hhmmOf(pol.retryMin)} 再試` : '今日兩個時段都已試過' };
      return attempt(iso, slot, st);
    })();
    try { return await inflight; }
    catch (e) { log(`  ⚠ 上櫃第三方後備 ${iso} 例外：${String(e?.message || e).slice(0, 80)}`); return { status: 'tried', reason: String(e?.message || e).slice(0, 80) }; }
    finally { inflight = null; }
  }

  return { tick, mode, state: () => readJson(sp) || (mem ? structuredClone(mem) : null) };
}

/**
 * daemon 的獨立計時器（2026-10-08 審查 HIGH）：每 timerMs 以「現在」的台北日期呼叫 ctl.tick——不放在循序的 dailyJobsLoop 裡
 *   （23:00 盤後新聞判別趟實測跑到 00:34–01:43，迴圈裡的 23:30 時段永遠輪不到，跨午夜後又變成「只補今天」而略過）。
 *   前一拍未完不重入；模式 off 不啟動（回 null）；unref 不擋程序結束。
 */
export function startTpexThirdPartyTimer({ ctl, now = Date.now, intervalMs = FALLBACK_POLICY.timerMs, setIntervalImpl = setInterval, log = () => {} } = {}) {
  if (!ctl || ctl.mode === 'off') return null;
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    let p;
    try { p = Promise.resolve(ctl.tick(twOf(now()).iso)); } catch (e) { p = Promise.reject(e); }
    p.catch(e => log(`  ⚠ 上櫃第三方後備例外：${String(e?.message || e).slice(0, 80)}`)).finally(() => { running = false; });
  };
  const handle = setIntervalImpl(run, intervalMs);
  handle?.unref?.();
  return { run, handle };
}
