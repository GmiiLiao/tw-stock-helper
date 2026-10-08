// ── FinMind HTTP 用戶端 ─────────────────────────────────────────────────────────
// token 只放 Authorization: Bearer 標頭，絕不進 URL、日誌、錯誤訊息（錯誤回應的 token_tail 一律抹除）。
// 每次嘗試前先過限速器（令牌桶＋滾動一小時＋每秒上限）；逾時用 AbortSignal.timeout。
// 錯誤分類與處理：
//   param(400/404/422) 不重試｜quota(402) 不重試、交給 runner 等額度｜auth(401/403) 不重試、runner 停
//   rate(429) 依退避表等 30 秒→2 分→10 分｜server(5xx)／network／timeout／truncated 依退避表等 5→20→60 秒
//   local（本機寫入失敗，例如磁碟滿）不重試、runner 停
// 回應串流切列（jsonstream），每批列交給 sink 寫 gzip；重試時 sink 重建，不殘留上一次的半份。
import { maskSecrets, scrubBody } from './secrets.mjs';
import { createRowSplitter } from './jsonstream.mjs';

export const API_BASE = 'https://api.finmindtrade.com/api/v4';
export const USER_INFO_URL = 'https://api.web.finmindtrade.com/v2/user_info';
export const USER_AGENT = 'Mozilla/5.0 (compatible; TW-Stock-App-research/1.0)';
export const RETRY = Object.freeze({ server: [5e3, 20e3, 60e3], rate: [30e3, 120e3, 600e3] });
const RETRY_CLASS = { server: 'server', network: 'server', timeout: 'server', truncated: 'server', rate: 'rate' };
const USER_INFO_TIMEOUT_MS = 30e3;
const MSG_MAX = 300;

export class FinMindError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'FinMindError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function classifyHttp(code) {
  if (code === 402) return 'quota';
  if (code === 401 || code === 403) return 'auth';
  if (code === 429) return 'rate';
  if (code >= 500) return 'server';
  if (code >= 400) return 'param';
  return 'other';
}

export function buildUrl(endpoint, params) {
  if (!/^[a-z0-9_]+$/i.test(String(endpoint))) throw new Error(`endpoint 不合法：${endpoint}`);
  for (const k of Object.keys(params)) if (/token/i.test(k)) throw new Error('token 不可放在 URL 參數（只放 Authorization 標頭）');
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])).toString();
  return `${API_BASE}/${endpoint}?${qs}`;
}

function abortError() { return new FinMindError('aborted', '已收到停止訊號'); }

/** 本機寫入（磁碟滿、權限）失敗不是網路問題：標成 local、不重試，runner 直接停。 */
function localGuard(sink) {
  const wrap = fn => async (...a) => { try { return await fn(...a); } catch (e) { throw e instanceof FinMindError ? e : new FinMindError('local', `本機寫入失敗：${e?.code || ''} ${e?.message || e}`); } };
  return { write: wrap(sink.write.bind(sink)), end: wrap(sink.end.bind(sink)), abort: () => sink.abort?.() };
}

export function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(t); reject(abortError()); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function pickInfo(j) {
  if (!j || typeof j !== 'object') return null;
  const level = j.level ?? j.user_level ?? null;
  return { level: level == null ? null : Number(level), level_title: j.level_title ?? null, user_count: j.user_count ?? null,
    api_request_limit: j.api_request_limit ?? null, api_request_limit_hour: j.api_request_limit_hour ?? null, api_request_limit_day: j.api_request_limit_day ?? null };
}

export function createFinMindClient({ token, fetchImpl = globalThis.fetch, now = Date.now, sleep = defaultSleep, limiter = null,
  timeoutMs = 120e3, retry = RETRY, log = () => {}, signal = null } = {}) {
  if (!token) throw new Error('缺 FinMind token');
  const secrets = [token];
  const mask = s => maskSecrets(s, secrets);
  const headers = () => ({ Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, Accept: 'application/json' });
  const signalFor = tmo => (signal ? AbortSignal.any([AbortSignal.timeout(tmo), signal]) : AbortSignal.timeout(tmo));

  function netError(e) {
    if (e instanceof FinMindError) return e;
    if (signal?.aborted) return abortError();
    if (e?.name === 'TimeoutError') return new FinMindError('timeout', '請求逾時');
    return new FinMindError('network', `網路錯誤：${mask(e?.message || e).slice(0, MSG_MAX)}`);
  }

  function errorFromBody(http, text) {
    let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
    const body = j ? scrubBody(j, secrets) : null;
    const msg = mask(body?.msg ?? String(text ?? '')).slice(0, MSG_MAX);
    return new FinMindError(classifyHttp(http), `HTTP ${http}：${msg}`, { http, status: body?.status ?? null });
  }

  async function waitSlot() {
    if (!limiter) return;
    for (let w = limiter.waitMs(); w > 0; w = limiter.waitMs()) await sleep(w, signal);
  }

  async function readStream(res, sp, sink) {
    const dec = new TextDecoder();
    let bytes = 0, rows = 0;
    const feed = async text => { const rs = sp.push(text); if (rs.length) { rows += rs.length; await sink.write(rs); } };
    try {
      if (res.body) {
        for await (const chunk of res.body) { bytes += chunk.length; await feed(dec.decode(chunk, { stream: true })); }
      } else {
        const t = await res.text(); bytes = Buffer.byteLength(t); await feed(t);
      }
    } catch (e) { throw netError(e); }
    await feed(dec.decode());
    return { bytes, rows };
  }

  async function once(url, makeSink, tmo) {
    let res;
    try { res = await fetchImpl(url, { headers: headers(), signal: signalFor(tmo) }); } catch (e) { throw netError(e); }
    if (res.status !== 200) {
      let text = ''; try { text = await res.text(); } catch { /* 讀不到內文 */ }
      throw errorFromBody(res.status, text);
    }
    const sink = localGuard(makeSink());
    try {
      const sp = createRowSplitter();
      const { bytes, rows } = await readStream(res, sp, sink);
      let meta;
      try { meta = sp.end(); } catch (e) { throw new FinMindError('truncated', e.message, { http: 200 }); }
      if (meta.status != null && Number(meta.status) !== 200) throw errorFromBody(Number(meta.status), JSON.stringify(meta.outer));
      const result = await sink.end({ rows, bytes, meta });
      return { http: 200, rows, bytes, msg: meta.msg, result };
    } catch (e) {
      sink.abort?.();
      throw netError(e);
    }
  }

  /** 抓一個請求：job＝{ endpoint, params, timeoutMs?, label? }；makeSink()→{ write(rows), end(info), abort() }。 */
  async function fetchRows(job, makeSink) {
    const url = buildUrl(job.endpoint, job.params);
    const shown = url.slice(API_BASE.length);
    for (let attempt = 1; ; attempt++) {
      await waitSlot();
      limiter?.record();
      const t0 = now();
      try {
        const r = await once(url, makeSink, job.timeoutMs || timeoutMs);
        log({ type: 'data', label: job.label ?? null, url: shown, http: r.http, rows: r.rows, bytes: r.bytes, ms: now() - t0, attempt });
        return { ...r, ms: now() - t0, attempt };
      } catch (e0) {
        const e = netError(e0);
        log({ type: 'data', label: job.label ?? null, url: shown, http: e.http ?? null, kind: e.kind, msg: mask(e.message), ms: now() - t0, attempt });
        const delays = RETRY_CLASS[e.kind] ? retry[RETRY_CLASS[e.kind]] : null;
        if (!delays || attempt > delays.length) { e.attempts = attempt; throw e; }
        await sleep(delays[attempt - 1], signal);
      }
    }
  }

  /** 額度查詢（實測不計入 data 請求次數）。網路錯誤回 ok=false，不丟出。 */
  async function userInfo() {
    const t0 = now();
    try {
      const res = await fetchImpl(USER_INFO_URL, { headers: headers(), signal: signalFor(USER_INFO_TIMEOUT_MS) });
      const text = await res.text();
      let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
      const info = pickInfo(j ? scrubBody(j, secrets) : null);
      log({ type: 'user_info', http: res.status, level: info?.level ?? null, user_count: info?.user_count ?? null, limit_hour: info?.api_request_limit_hour ?? null, ms: now() - t0 });
      return { ok: res.status === 200 && info?.level != null, http: res.status, level: info?.level ?? null, info };
    } catch (e) {
      const err = netError(e);
      log({ type: 'user_info', http: null, kind: err.kind, msg: mask(err.message), ms: now() - t0 });
      return { ok: false, http: null, level: null, info: null, error: mask(err.message) };
    }
  }

  return { fetchRows, userInfo };
}
