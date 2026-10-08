// ─────────────────────────────────────────────────────────────────────────
// 串流下載器（2026-10-08）：分得出「慢但在傳」與「停住」——固定總逾時在慢速時必敗、沒逾時會掛到對方斷線。
//   實測櫃買 openapi（4.78MB 未壓縮、nginx、只回 HTTP/1.1）同一支端點 15–240KB/s 不等，Node 曾 42 秒 ECONNRESET。
//   規則：等不到回應標頭超過 ttfbMs ⇒ ttfb；收到標頭後連續 stallMs 沒有新位元組 ⇒ stall；整體超過 capMs ⇒ cap；
//         中途斷線 ⇒ reset；標頭前就丟錯（DNS／連線）⇒ connect；完成時位元組數≠Content-Length（未壓縮才比）⇒ length。
//   條件請求：conditional.etag／lastModified ⇒ If-None-Match／If-Modified-Since；304＝notModified（0 bytes）。
//   續傳：resume.offset＋resume.etag ⇒ Range: bytes=N-＋If-Range；只接受起點吻合的 206；回 200＝檔案已改版、整檔重收；416／起點不符＝range。
//   不解析內容、不寫檔；回傳 { ok, reason, buf|partial, bytes, total, http, etag, lastModified, acceptRanges, contentEncoding, resumable, resumed, notModified, ms }。
// ─────────────────────────────────────────────────────────────────────────

export const DOWNLOAD_DEFAULTS = Object.freeze({ ttfbMs: 30_000, stallMs: 30_000, capMs: 6 * 60_000, tickMs: 1000 });

const headerMeta = res => {
  const h = k => res.headers.get(k);
  const cl = Number(h('content-length'));
  return {
    http: res.status, etag: h('etag'), lastModified: h('last-modified'), acceptRanges: h('accept-ranges'),
    contentEncoding: (h('content-encoding') || '').toLowerCase() || null, contentLength: Number.isFinite(cl) && h('content-length') != null ? cl : null,
    contentRange: h('content-range'),
  };
};
const identity = enc => !enc || enc === 'identity';
const cancelBody = res => { try { res.body?.cancel?.().catch(() => {}); } catch { /* 已關閉 */ } };

/**
 * @param {string} url
 * @param {{fetchImpl?:Function, headers?:object, ttfbMs?:number, stallMs?:number, capMs?:number, tickMs?:number,
 *          conditional?:{etag?:string|null,lastModified?:string|null}|null, resume?:{offset:number, etag:string, prefix:Buffer}|null,
 *          onHeaders?:(meta:object)=>string|null, now?:()=>number}} opts
 */
export async function downloadStream(url, opts = {}) {
  const { fetchImpl = fetch, headers = {}, conditional = null, resume = null, onHeaders = null, now = Date.now } = opts;
  const { ttfbMs, stallMs, capMs, tickMs } = { ...DOWNLOAD_DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([k, v]) => k in DOWNLOAD_DEFAULTS && v != null)) };
  const ac = new AbortController();
  let why = null;
  const abort = r => { if (!why) { why = r; ac.abort(new Error(`download ${r}`)); } };
  const t0 = now();
  const h = { ...headers };
  const resuming = !!(resume && resume.offset > 0 && resume.etag && resume.prefix?.length === resume.offset);
  if (resuming) { h.Range = `bytes=${resume.offset}-`; h['If-Range'] = resume.etag; }
  else if (conditional) {
    if (conditional.etag) h['If-None-Match'] = conditional.etag;
    if (conditional.lastModified) h['If-Modified-Since'] = conditional.lastModified;
  }
  let gotHeaders = false; let lastByte = t0; let meta = {}; let body = []; let bodyBytes = 0; let total = null; let resumed = false;
  const timer = setInterval(() => {
    const t = now();
    if (!gotHeaders && t - t0 > ttfbMs) abort('ttfb');
    else if (gotHeaders && t - lastByte > stallMs) abort('stall');
    if (t - t0 > capMs) abort('cap');
  }, tickMs);
  const result = (ok, extra = {}) => {
    const buf = Buffer.concat(body);
    const resumable = !!(meta.etag && /bytes/i.test(meta.acceptRanges || (meta.http === 206 ? 'bytes' : '')) && identity(meta.contentEncoding));
    return { ok, ...meta, bytes: bodyBytes, total, resumed, resumable, ms: now() - t0, ...(ok ? { buf } : { partial: buf }), ...extra };
  };
  try {
    const res = await fetchImpl(url, { headers: h, signal: ac.signal, redirect: 'manual' });
    gotHeaders = true; lastByte = now();
    meta = headerMeta(res);
    if (onHeaders) {
      const stop = onHeaders(meta);
      if (stop) { abort(stop); cancelBody(res); return result(false, { reason: stop }); }
    }
    if (res.status === 304) { cancelBody(res); return result(true, { notModified: true }); }
    if (res.status === 416) { cancelBody(res); return result(false, { reason: 'range' }); }
    if (res.status !== 200 && res.status !== 206) { cancelBody(res); return result(false, { reason: 'http' }); }
    if (res.status === 206) {
      const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(meta.contentRange || '');
      if (!resuming || !m || Number(m[1]) !== resume.offset) { cancelBody(res); return result(false, { reason: 'range' }); }
      total = m[3] === '*' ? null : Number(m[3]);
      body = [Buffer.from(resume.prefix)]; resumed = true;
    } else {
      total = identity(meta.contentEncoding) ? meta.contentLength : null;
    }
    if (!res.body) return result(total == null || total === 0, total ? { reason: 'length' } : {});
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) { body.push(Buffer.from(value)); bodyBytes += value.length; lastByte = now(); }
    }
    if (why) return result(false, { reason: why });
    const got = (resumed ? resume.offset : 0) + bodyBytes;
    if (total != null && got !== total) return result(false, { reason: 'length' });
    return result(true);
  } catch (e) {
    const reason = why || (gotHeaders ? 'reset' : 'connect');
    return result(false, { reason, error: String(e?.cause?.code || e?.message || e).slice(0, 120) });
  } finally {
    clearInterval(timer);
  }
}

/** 失敗原因 → 中文說明（日誌用；刻意不含 outage-scan 的 OUTAGE_RE 字樣：單純傳輸失敗不該擋 daemon 重啟） */
export function reasonText(r) {
  const kb = n => `${Math.round((n || 0) / 1024).toLocaleString()}KB`;
  const got = r?.partial ? `已收 ${kb(r.partial.length)}${r.total ? `／${kb(r.total)}` : ''}` : '';
  switch (r?.reason) {
    case 'ttfb': return '等不到回應標頭';
    case 'stall': return `下載停滯（${got}）`;
    case 'cap': return `超過下載總上限（${got}）`;
    case 'reset': return `傳輸中途被切斷（${got}${r.error ? `·${r.error}` : ''}）`;
    case 'connect': return `連線失敗（${r.error || ''}）`;
    case 'length': return `位元組數與 Content-Length 不符（${got || kb(r.bytes)}）`;
    case 'range': return '續傳區段不符';
    case 'http': return `HTTP ${r.http}`;
    default: return r?.reason || '未知';
  }
}
