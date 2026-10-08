// ─────────────────────────────────────────────────────────────────────────
// 上櫃收盤檔共用取得層（2026-10-08；使用者：「檢查下載方式哪裡有錯? 如果現有下載不行就使用本機下載再上傳使用」）
//   舊做法的四類錯：同一天的資料重複抓（daemon 每 ~10 分鐘重抓 4.7MB）、六處各自抓同一支、固定總逾時分不出慢與停、沒有完整性驗證。
//   這裡統一成一個取得層，各讀者只問「給我 D 日的上櫃收盤」：
//     記憶體 → 本機快取 second-brain/tpex-close/ → 收件匣 _inbox/（使用者手動下載的檔）→ 官方鏡像本機檔（唯讀）→ 網路（只有 daemon 開）
//   網路：先帶日期端點（回聲不符＝notYet，中性）；只有「已過 16:00、帶日期端點是傳輸失敗、快取沒有那一天」才打 openapi 大檔，
//         而且走串流下載器（停滯偵測＋總上限＋條件請求＋Range 續傳）；失敗退避 2→5→10→20→40 分（±20%）、每日上限；
//         遇 30x／401／403／429／封鎖頁 ⇒ 當日停用櫃買網路並告警。對櫃買的請求彼此間隔 ≥3 秒（與 daemon 共用出口 IP）。
//   完整性：tpex-close-parse 的 validateTpexClose（整份 JSON、單一資料日＝期望日、4 碼 ≥800、00 開頭 ≥60、無重複、收盤可解析、與前一份相比缺 ≤3%；
//         總列數只當 5,000 的底線——九成是權證、隨季節起落，2026-06/07 有 8 天不到 10,000）。daemon、收件匣、CLI、鏡像本機檔同一套門檻。
//   當日檔時刻（2026-10-08 審查 HIGH 更正）：帶日期端點 14:49～14:54 出檔（舊版日誌 08-11～10-08 共 38 天：最後一次空表 14:47–14:54、
//         首次成功 14:51–14:57，僅 3 天晚到 15:11–15:46）；16:07 是 openapi 併入收盤歸檔的時刻，不是出檔時刻。
//         ⇒ 14:45 起才試當日檔；14:45–15:30 回聲不符／空表 2 分鐘再試（出檔前多 2～4 個小請求），其餘 10 分鐘。
//   資料日一律用來源自報（鍵＝資料日）；抓不到就是抓不到（交易日 19:00 仍沒有 ⇒ 寫 _alerts 並回告警文字），不捏造。
//   存放：{date}.{openapi|dated}.json.gz（官方原始回應位元組 gzip；sha256 算在原始位元組上，與官方鏡像同算法）＋ _manifest.json；保留 60 天。
//   實測（2026-10-08 20:00，2 個小請求，記在 WP7 requests.log）：openapi 是 nginx 靜態檔、約每小時重產一次（ETag＝mtime-size，
//     18:00→20:00 大小不變、ETag 變）⇒ Range＋If-Range（ETag 相同）回 206 已驗；跨重產時 If-Range 不符會回 200 整檔（下載器丟棄前段重收）；
//     If-None-Match 只在同一小時內可能 304（跨重產必回 200）。Last-Modified 是重產時刻、不是資料日——只拿來排除「資料日之前就沒重產過」的舊檔。
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, linkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as P from './tpex-close-parse.mjs';
import { downloadStream, reasonText } from './tpex-close-download.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_ROOT = process.env.TPEX_CLOSE_ROOT || join(REPO, 'second-brain', 'tpex-close');
export const DEFAULT_MIRROR_ROOT = process.env.OFFICIAL_ROOT || join(REPO, 'second-brain', 'official');
const MIRROR_HOST = 'www.tpex.org.tw';
export const MIRROR_IDS = Object.freeze({ dated: 'tpex_dailyquotes', openapi: 'tpex_oa_tpex_mainboard_daily_close_quotes' });
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
export const BLOCK_RE = /SECURITY REASONS|因為安全性考量|驗證碼|captcha|請求過於頻繁|Too Many Requests|系統忙碌中|Access Denied|拒絕存取/i;

export const POLICY = Object.freeze({
  retentionDays: 60,
  minGapMs: 3000,
  backoffMin: [2, 5, 10, 20, 40],
  jitter: 0.2,
  notYetMin: 10,
  datedEarliestMin: 14 * 60 + 45,   // 當日檔 14:45 前不試：帶日期端點 14:49～14:54 出檔（見檔頭；舊值 15:50 誤把 openapi 併入時刻當出檔時刻）
  notYetFastMin: 2,                 // 出檔窗內（當日檔、14:45～15:30）回聲不符／空表 2 分鐘再試——種子換成當日檔的時刻與舊版（約每分鐘試一次）相差 ≤2 分
  notYetFastUntilMin: 15 * 60 + 30,
  openapiEarliestMin: 16 * 60,      // 16:00 前打 openapi 只會拿到前一日（10-08 15:23 openapi 仍是前一日）
  openapiFullPerDay: 6,             // 304／標頭判定仍是舊檔的不算
  datedPerDay: 40,
  alertAtMin: 19 * 60,
  lockStaleMs: 10 * 60_000,
  inboxSettleMs: 60_000,            // 收件匣檔案最後修改超過 60 秒才處理（瀏覽器下載中、cp 寫入中的檔不碰）
  memoryDays: 3,                    // 一天約 12,000 列物件；今天＋昨天＋補洞掃到的一天
});

const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const pad2 = n => String(n).padStart(2, '0');
/** 台北時間（UTC+8，無日光節約）：{ iso, mins, dow } */
export function twOf(ms) {
  const d = new Date(ms + 8 * 3600e3);
  return { iso: d.toISOString().slice(0, 10), mins: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}
const twMs = (iso, mins) => Date.parse(`${iso}T${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}:00+08:00`);
const hhmm = ms => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5);
const weekday = iso => { const dow = new Date(`${iso}T12:00:00Z`).getUTCDay(); return dow >= 1 && dow <= 5; };
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

function readJson(p, fallback) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeAtomic(p, data) { mkdirSync(dirname(p), { recursive: true }); const tmp = `${p}.tmp-${process.pid}`; writeFileSync(tmp, data); renameSync(tmp, p); }
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** 手動下載說明（告警與收件匣拒收檔的說明都附上） */
export function manualHelp(root = DEFAULT_ROOT) {
  return [
    `① 用瀏覽器開 ${P.OPENAPI_URL} 存檔（或帶日期：${P.datedUrl('YYYY-MM-DD')}）`,
    `② 下載完成後放進 ${join(root, '_inbox')}（任何檔名都可以，.json 或 .json.gz；下載中的 .crdownload／.part、0 位元組、1 分鐘內剛寫入的檔會先略過）——daemon 下次需要時自動驗證採用`,
    `③ 要立即生效：node scripts/tpex-close-import.mjs <檔案>（加 --publish 同時更新網站用的 Firestore tpexClose）`,
  ].join('\n');
}

/**
 * @param {{root?:string, mirrorRoot?:string, fetchImpl?:Function, now?:()=>number, log?:Function, onAlert?:Function,
 *          isTradingDay?:(iso:string)=>boolean, network?:'auto'|'never', policy?:object, sleep?:Function, download?:object, limits?:object}} opts
 */
export function createTpexClose(opts = {}) {
  const root = opts.root || DEFAULT_ROOT;
  const mirrorRoot = opts.mirrorRoot === null ? null : (opts.mirrorRoot || DEFAULT_MIRROR_ROOT);
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const onAlert = opts.onAlert || (() => {});
  const hasAlert = typeof opts.onAlert === 'function';   // 有告警通道（daemon、CLI）；沒有的程序（手動腳本）拒收時記在清單，交給有通道的程序補發
  const isTradingDay = opts.isTradingDay || weekday;
  const defaultNetwork = opts.network || 'never';
  const pol = { ...POLICY, ...(opts.policy || {}) };
  const sleep = opts.sleep || sleepMs;
  const dl = opts.download || {};
  const lim = { ...P.LIMITS, ...(opts.limits || {}) };
  const mem = new Map();          // iso → 結果（ok）
  const inflight = new Map();     // iso → Promise
  let lastReqAt = 0;

  const manPath = join(root, '_manifest.json');
  const loadMan = () => {
    const m = readJson(manPath, null) || {};
    return { v: 1, days: m.days || {}, net: { day: m.net?.day || null, want: m.net?.want || {}, blocked: m.net?.blocked || null, openapi: m.net?.openapi || null, log: m.net?.log || [] },
      inbox: { rejected: Array.isArray(m.inbox?.rejected) ? m.inbox.rejected : [] } };
  };
  const saveMan = m => writeAtomic(manPath, JSON.stringify(m, null, 1));

  // ── 跨程序鎖：只包「讀改寫清單＋寫檔」的短區段 ──
  //   建鎖是原子的：先把 {pid, at, token} 寫進暫存檔、再 link 成 _lock（EEXIST＝有人持有）——鎖檔一出現就有完整內容
  //   （舊版 openSync('wx') 先建空檔再寫 pid，另一程序剛好讀到空檔會判成無主而刪掉，兩邊同時改清單；2026-10-08 審查 LOW）。
  //   無主判定：pid 已死、或 at 超過 lockStaleMs；讀不到內容（舊格式／檔案系統異常）改看 mtime 是否超過 lockStaleMs，不立刻刪。
  //   清無主鎖前再讀一次、token 相同才刪；釋放時也只刪自己的 token。
  async function withLock(fn) {
    mkdirSync(root, { recursive: true });
    const p = join(root, '_lock');
    const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 200; i++) {
      const tmp = `${p}.${token}`;
      let got = false;
      try {
        writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: now(), token }));
        try { linkSync(tmp, p); got = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
      } finally { try { unlinkSync(tmp); } catch { /* 已不在 */ } }
      if (got) {
        try { return fn(); }
        finally { if (readJson(p, null)?.token === token) { try { unlinkSync(p); } catch { /* 已被清 */ } } }
      }
      const cur = readJson(p, null);
      let stale;
      if (cur?.pid) stale = !pidAlive(cur.pid) || now() - (cur.at || 0) > pol.lockStaleMs;
      else { let mt = null; try { mt = statSync(p).mtimeMs; } catch { continue; } stale = Date.now() - mt > pol.lockStaleMs; }   // 不見了＝剛被釋放，馬上再搶
      if (stale) { if ((readJson(p, null)?.token ?? null) === (cur?.token ?? null)) { try { unlinkSync(p); } catch { /* 別人清了 */ } } continue; }
      await sleep(50);
    }
    throw new Error('tpex-close 鎖取得逾時（另一個程序持有 _lock）');
  }
  const mutate = fn => withLock(() => { const m = loadMan(); const out = fn(m); saveMan(m); return out; });

  const remember = (iso, res) => {
    mem.delete(iso); mem.set(iso, res);
    while (mem.size > pol.memoryDays) mem.delete(mem.keys().next().value);
    return res;
  };
  const okResult = (iso, rows, extra) => ({ status: 'ok', dataDate: iso, rows, reason: null, ...extra });

  // ── 本機快取 ──
  function readDay(iso, m = loadMan()) {
    const d = m.days[iso];
    if (d?.status !== 'ok' || !d.file) return null;
    try {
      const p = P.parseTpexClose(gunzipSync(readFileSync(join(root, d.file))));
      if (p.error || p.echo !== iso) { log(`  ⚠ 上櫃收盤快取 ${d.file} 讀取異常：${p.error || `資料日 ${p.echo}`}`); return null; }
      return okResult(iso, p.rows, { source: d.source, format: d.format, sha256: d.sha256, fetchedAt: d.fetchedAt, stats: P.statsOf(p.rows) });
    } catch (e) { log(`  ⚠ 上櫃收盤快取 ${d.file} 讀取失敗：${e.message.slice(0, 60)}`); return null; }
  }

  // ── 官方鏡像本機檔（唯讀；鏡像由 official-mirror.mjs 單一寫入）──
  function mirrorEntries(id) {
    if (!mirrorRoot) return [];
    const man = readJson(join(mirrorRoot, MIRROR_HOST, id, '_manifest.json'), null);
    return Object.entries(man?.rows || {}).filter(([, r]) => r?.status === 'ok' && r.file).map(([k, r]) => ({ key: k, echo: r.echo || (/^\d{4}-\d{2}-\d{2}$/.test(k) ? k : null), file: r.file, sha256: r.sha256 }));
  }
  function mirrorDay(iso) {
    for (const [fmt, id] of [['dated', MIRROR_IDS.dated], ['openapi', MIRROR_IDS.openapi]]) {
      const e = mirrorEntries(id).filter(x => x.echo === iso).at(-1);
      if (!e) continue;
      try {
        const j = JSON.parse(gunzipSync(readFileSync(join(mirrorRoot, MIRROR_HOST, id, e.file))).toString('utf8'));
        const p = P.parseTpexClose(j.payload);
        const v = P.validateTpexClose(p, { expect: iso, limits: lim });   // 與 daemon／收件匣／CLI 同一套門檻（總列數門檻已降到季節低點以下，不必再另外放寬）
        if (v.status === 'ok') return okResult(iso, p.rows, { source: 'mirror', format: fmt, sha256: e.sha256 || j.meta?.sha256 || null, fetchedAt: j.meta?.fetchedAt || null, stats: v.stats });
      } catch (err) { log(`  ⚠ 官方鏡像 ${id}/${e.file} 讀取失敗：${err.message.slice(0, 60)}`); }
    }
    return null;
  }
  const mirrorLatestIso = before => {
    const keys = [...mirrorEntries(MIRROR_IDS.dated), ...mirrorEntries(MIRROR_IDS.openapi)].map(e => e.echo).filter(k => k && (!before || k <= before));
    return keys.sort().at(-1) || null;
  };

  /** 前一份已驗證檔的 4 碼集合（完整性比對用；沒有就 null） */
  function prevCodes4(iso) {
    const m = loadMan();
    const prevCache = Object.keys(m.days).filter(k => k < iso && m.days[k]?.status === 'ok').sort().at(-1) || null;
    const prevMirror = mirrorLatestIso(new Date(Date.parse(`${iso}T12:00:00Z`) - 864e5).toISOString().slice(0, 10));
    const cands = [prevCache, prevMirror].filter(Boolean).sort();
    const d = cands.at(-1); if (!d) return null;
    const r = (mem.get(d)) || (d === prevCache ? readDay(d, m) : null) || mirrorDay(d);
    return r ? P.codes4Of(r.rows) : null;
  }

  // ── 寫入快取（同日同格式不同 sha＝官方重產 ⇒ 新版本為現用、舊版列進 revisions；同日另一格式記在 alt）──
  async function storeRaw({ iso, raw, sha = sha256(raw), format, source, meta = {} }) {
    const fetchedAt = new Date(now()).toISOString();
    const out = await mutate(m => {
      const d = m.days[iso];
      const rec = { file: null, sha256: sha, source, format, bytes: raw.length, contentLength: meta.contentLength ?? null, etag: meta.etag ?? null, lastModified: meta.lastModified ?? null, fetchedAt };
      if (d?.status === 'ok' && d.sha256 === sha) return { stored: false, same: true, entry: d };
      if (d?.status === 'ok' && d.format !== format) {
        if (d.alt?.[format]?.sha256 === sha) return { stored: false, same: true, entry: d };
        rec.file = `${iso}.${format}.json.gz`;
        writeAtomic(join(root, rec.file), gzipSync(raw));
        d.alt = { ...(d.alt || {}), [format]: rec };
        return { stored: true, alt: true, entry: d };
      }
      const revisions = d?.status === 'ok' ? [...(d.revisions || []), { file: d.file, sha256: d.sha256, source: d.source, fetchedAt: d.fetchedAt }] : [];
      rec.file = revisions.length ? `${iso}.r${revisions.length + 1}.${format}.json.gz` : `${iso}.${format}.json.gz`;
      writeAtomic(join(root, rec.file), gzipSync(raw));
      m.days[iso] = { status: 'ok', ...rec, rows: meta.stats?.rows ?? null, stocks4: meta.stats?.stocks4 ?? null, etf00: meta.stats?.etf00 ?? null, revisions, ...(d?.alt ? { alt: d.alt } : {}) };
      if (revisions.length) log(`  ⓘ 上櫃收盤檔 ${iso} 官方重產（sha ${d.sha256.slice(0, 8)}→${sha.slice(0, 8)}），改用新版、舊版留存`);
      prune(m);
      return { stored: true, revision: revisions.length > 0, entry: m.days[iso] };
    });
    if (out.stored && !out.alt) mem.delete(iso);
    return out;
  }
  function prune(m) {
    const today = twOf(now()).iso;
    for (const [k, d] of Object.entries(m.days)) {
      if (dayDiff(today, k) <= pol.retentionDays) continue;
      for (const f of [d.file, ...(d.revisions || []).map(r => r.file), ...Object.values(d.alt || {}).map(r => r.file)]) { try { if (f) unlinkSync(join(root, f)); } catch { /* 已不在 */ } }
      delete m.days[k];
    }
    for (const k of Object.keys(m.net.want)) if (dayDiff(today, k) > 10) delete m.net.want[k];
  }

  /** 位元組（任一格式；gzip 也可）→ 驗證 → 存快取。expect 給定時回聲不符＝notYet（結構合格者仍存在它自己的資料日下）。 */
  async function importBuffer(buf, { source = 'import', expect = null, meta = {} } = {}) {
    let raw = Buffer.from(buf);
    if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) { try { raw = gunzipSync(raw); } catch (e) { return { status: 'invalid', reason: `gzip 解壓失敗：${e.message}` }; } }
    const p = P.parseTpexClose(raw);
    const today = twOf(now()).iso;
    const pre = p.echo ? prevCodes4(p.echo) : null;
    const v = P.validateTpexClose(p, { expect, today, isTradingDay, prevCodes4: pre, limits: lim });
    if (!v.structOk) return { status: 'invalid', dataDate: v.dataDate, reason: v.reason, stats: v.stats, empty: v.empty, echoRows: p.echo && expect && p.echo === P.toIso(expect) ? p.rows : null };
    if (!expect && (v.dataDate > today || !isTradingDay(v.dataDate))) return { status: 'invalid', dataDate: v.dataDate, reason: v.reason, stats: v.stats };
    const sha = sha256(raw);   // 這份內容的雜湊（Firestore 冪等比對用）；同日已有另一格式時清單主檔的雜湊不同，不可混用
    const st = await storeRaw({ iso: v.dataDate, raw, sha, format: p.format, source, meta: { ...meta, stats: v.stats } });
    const res = okResult(v.dataDate, p.rows, { source, format: p.format, sha256: sha, fetchedAt: st.entry?.fetchedAt, stats: v.stats, stored: st.stored, same: !!st.same });
    if (!st.alt) remember(v.dataDate, res);
    return v.status === 'notYet' ? { status: 'notYet', dataDate: v.dataDate, reason: v.reason, other: res } : res;
  }

  // ── 收件匣：使用者手動下載的檔（任何檔名；.json／.json.gz；openapi 陣列或 dailyQuotes 物件）──
  //   下載中的檔不碰（2026-10-08 審查 MEDIUM：舊版會把 Chrome 的 .crdownload、Firefox 的 .part／0 位元組佔位檔當成待處理，
  //   判截斷拒收、改名 .rejected——瀏覽器最後的改名失敗，下載顯示失敗，正好破壞「本機下載再上傳」這條路）：
  //   略過暫存副檔名（.crdownload／.part／.download／.partial／.tmp）、0 位元組檔、最後修改未滿 settleMs（預設 60 秒）的檔；不改名、不告警，下一輪再看。
  const inboxDir = join(root, '_inbox');
  const PARTIAL_RE = /\.(crdownload|part|download|partial|tmp)$/i;
  function inboxScan(settleMs = pol.inboxSettleMs) {
    const out = { ready: [], waiting: [] };
    if (!existsSync(inboxDir)) return out;
    for (const n of readdirSync(inboxDir)) {
      if (n.startsWith('.') || /\.rejected(\.txt)?$/.test(n) || /\.tmp-\d+$/.test(n)) continue;
      const pm = n.match(/\.processing-(\d+)$/); if (pm && pidAlive(+pm[1])) continue;
      let st; try { st = statSync(join(inboxDir, n)); } catch { continue; }
      if (!st.isFile()) continue;
      const orig = n.replace(/\.processing-\d+$/, '');
      if (PARTIAL_RE.test(orig) || st.size === 0 || (settleMs > 0 && Date.now() - st.mtimeMs < settleMs)) { out.waiting.push(n); continue; }
      out.ready.push(n);
    }
    return out;
  }
  const inboxPending = () => inboxScan().ready;
  async function ingestInbox({ settleMs = pol.inboxSettleMs } = {}) {
    const scan = inboxScan(settleMs);
    const out = { accepted: [], rejected: [], waiting: scan.waiting };
    for (const name of scan.ready) {
      const orig = name.replace(/\.processing-\d+$/, '');
      const claimed = join(inboxDir, `${orig}.processing-${process.pid}`);
      try { renameSync(join(inboxDir, name), claimed); } catch { continue; }   // 別的程序先認領了
      let res;
      try { res = await importBuffer(readFileSync(claimed), { source: 'inbox' }); } catch (e) { res = { status: 'invalid', reason: e.message }; }
      if (res.status === 'ok') {
        mkdirSync(join(inboxDir, '_done'), { recursive: true });
        renameSync(claimed, join(inboxDir, '_done', `${res.dataDate}-${String(res.sha256).slice(0, 8)}-${orig}`));
        out.accepted.push({ name: orig, dataDate: res.dataDate, rows: res.stats?.rows, stocks4: res.stats?.stocks4, stored: res.stored });
        log(`  ✓ 上櫃收盤收件匣採用 ${orig}：資料日 ${res.dataDate}、${res.stats?.rows} 列／4 碼 ${res.stats?.stocks4}${res.stored ? '' : '（快取已有同一份）'}`);
      } else {
        const reason = res.reason || res.status;
        renameSync(claimed, join(inboxDir, `${orig}.rejected`));
        writeFileSync(join(inboxDir, `${orig}.rejected.txt`), `${new Date(now()).toISOString()} 拒收：${reason}\n資料日（檔案自報）：${res.dataDate || '認不得'}\n\n${manualHelp(root)}\n`);
        out.rejected.push({ name: orig, reason, dataDate: res.dataDate || null });
        log(`  ⚠ 上櫃收盤收件匣拒收 ${orig}：${reason}`);
        // 拒收一律記進清單；有告警通道的程序當場發，沒有的（手動腳本）留給 daemon 下一輪 flushInboxAlerts 補發
        //   （記錄是加值：鎖搶不到也不可讓讀者整條失敗——.rejected.txt 已寫好，有告警通道的照樣當場發）
        try { await mutate(m => { m.inbox.rejected = [...m.inbox.rejected, { name: orig, reason: String(reason).slice(0, 200), at: now(), alerted: hasAlert }].slice(-20); }); }
        catch (e) { log(`  ⚠ 收件匣拒收記錄寫入失敗（${(e?.message || '').slice(0, 60)}）`); }
        if (hasAlert) onAlert(rejectText(orig, reason), `tpex-inbox-${orig}`);
      }
    }
    return out;
  }
  const rejectText = (name, reason) => `⚠ 上櫃收盤收件匣拒收 ${name}：${reason}（說明已寫在 ${join(inboxDir, `${name}.rejected.txt`)}）`;
  /** 其他程序（不帶告警通道）拒收的檔：由有告警通道的程序補發，每筆一次 */
  async function flushInboxAlerts() {
    if (!hasAlert || !loadMan().inbox.rejected.some(r => !r.alerted)) return 0;
    const pend = await mutate(m => { const p = m.inbox.rejected.filter(r => !r.alerted); m.inbox.rejected = m.inbox.rejected.map(r => ({ ...r, alerted: true })); return p; });
    for (const r of pend) onAlert(rejectText(r.name, r.reason), `tpex-inbox-${r.name}`);
    return pend.length;
  }

  // ── 網路（只有 network:'auto'）──
  // 同程序內所有櫃買請求排成一條隊：前一個請求放行後 ≥minGapMs 才放下一個（2026-10-08 審查 LOW：舊版讀寫 lastReqAt 之間有 await、
  //   兩個不同日期的 netFetch 同時進來會讀到同一個 lastReqAt 一起放行——宇宙背景抓今天、補洞同時要歷史日時就會發生）
  let gapChain = Promise.resolve();
  function gap() {
    const turn = gapChain.then(async () => { const w = lastReqAt + pol.minGapMs - now(); if (w > 0) await sleep(w); lastReqAt = now(); });
    gapChain = turn.catch(() => {});
    return turn;
  }
  const backoffMs = fails => {
    const base = pol.backoffMin[Math.min(fails - 1, pol.backoffMin.length - 1)] * 60_000;
    return Math.round(base * (1 + (Math.random() * 2 - 1) * pol.jitter));
  };
  const partialPaths = () => ({ part: join(root, '_partial', 'openapi.part'), meta: join(root, '_partial', 'openapi.json') });
  function loadPartial(today) {
    const pp = partialPaths(); const meta = readJson(pp.meta, null);
    if (!meta || meta.date !== today || !meta.etag || !existsSync(pp.part)) return null;
    const prefix = readFileSync(pp.part);
    return prefix.length === meta.offset ? { offset: meta.offset, etag: meta.etag, prefix } : null;
  }
  function savePartial(today, r) {
    const pp = partialPaths();
    try {
      if (r.resumable && r.partial?.length && r.etag) { writeAtomic(pp.part, r.partial); writeAtomic(pp.meta, JSON.stringify({ date: today, etag: r.etag, offset: r.partial.length, total: r.total })); }
      else clearPartial();
    } catch { /* 續傳只是加速，寫不進去就整檔重收 */ }
  }
  function clearPartial() { const pp = partialPaths(); for (const p of [pp.part, pp.meta]) { try { unlinkSync(p); } catch { /* 沒有 */ } } }
  const isBlockHttp = h => [301, 302, 303, 307, 308, 401, 403, 429].includes(h);
  /** 回聲不符／空表後多久再試：當日檔在出檔窗（14:45～15:30）內 2 分鐘，其餘 10 分鐘 */
  const notYetMs = iso => { const t = twOf(now()); return (iso === t.iso && t.mins < pol.notYetFastUntilMin ? pol.notYetFastMin : pol.notYetMin) * 60_000; };

  async function noteAttempt(iso, entry, { status, nextTry = null, fails = null, block = null, openapi = null, countDated = 0, countOpenapi = 0 }) {
    await mutate(m => {
      const today = twOf(now()).iso;
      if (m.net.day?.date !== today) m.net.day = { date: today, dated: 0, openapiFull: 0 };
      m.net.day.dated += countDated; m.net.day.openapiFull += countOpenapi;
      const w = m.net.want[iso] || {};
      m.net.want[iso] = { ...w, lastStatus: status, nextTry, fails: fails ?? w.fails ?? 0, last: entry };
      if (block) m.net.blocked = { date: today, reason: block, at: now() };
      if (openapi) m.net.openapi = { ...(m.net.openapi || {}), ...openapi };
      if (entry) m.net.log = [...m.net.log, { iso, ...entry }].slice(-40);
    });
  }

  async function netFetch(iso) {
    const t = twOf(now()); const m = loadMan();
    if (m.net.blocked?.date === t.iso) return { status: 'blocked', dataDate: null, rows: null, reason: `今日櫃買網路已停用：${m.net.blocked.reason}` };
    if (iso > t.iso) return { status: 'notYet', dataDate: null, rows: null, reason: '期望日在未來' };
    const w = m.net.want[iso] || {};
    if (w.nextTry && now() < w.nextTry) return { status: w.lastStatus || 'failed', dataDate: null, rows: null, reason: `退避中（下次 ${hhmm(w.nextTry)}）`, backoff: true };
    if (iso === t.iso && t.mins < pol.datedEarliestMin) {
      await noteAttempt(iso, null, { status: 'notYet', nextTry: twMs(t.iso, pol.datedEarliestMin) });
      return { status: 'notYet', dataDate: null, rows: null, reason: `櫃買當日檔約 14:50 出（${hhmm(twMs(t.iso, pol.datedEarliestMin))} 前不試）` };
    }
    const day = m.net.day?.date === t.iso ? m.net.day : { dated: 0, openapiFull: 0 };
    const fails = w.fails || 0;
    const failNext = (why, extra = {}) => ({ status: 'failed', nextTry: now() + backoffMs(fails + 1), fails: fails + 1, ...extra, why });

    // ① 帶日期端點
    let datedOutcome = null; let datedTransferFail = false;
    if (day.dated >= pol.datedPerDay) datedOutcome = { status: 'failed', reason: `帶日期端點今日已達上限 ${pol.datedPerDay} 次` };
    else {
      await gap();
      const r = await downloadStream(P.datedUrl(iso), { fetchImpl, headers: { 'User-Agent': UA, Referer: 'https://www.tpex.org.tw/', Accept: 'application/json' }, ...dl });
      const entry = { at: now(), src: 'dated', http: r.http ?? null, reason: r.ok ? 'ok' : r.reason, bytes: r.bytes };
      if (r.ok) {
        const text = r.buf.subarray(0, 20000).toString('utf8');
        if (BLOCK_RE.test(text)) {
          await noteAttempt(iso, { ...entry, reason: 'block' }, { status: 'blocked', block: '帶日期端點回封鎖頁', countDated: 1 });
          onAlert(`🚨 櫃買帶日期端點回封鎖／限流頁，今日停用櫃買網路（上櫃收盤改用快取／收件匣）\n${manualHelp(root)}`, `tpex-block-${t.iso}`);
          return { status: 'blocked', dataDate: null, rows: null, reason: '帶日期端點回封鎖頁' };
        }
        const res = await importBuffer(r.buf, { source: 'dated', expect: iso, meta: { contentLength: r.contentLength, etag: r.etag, lastModified: r.lastModified } });
        if (res.status === 'ok') { await noteAttempt(iso, entry, { status: 'ok', fails: 0, countDated: 1 }); return res; }
        if (res.status === 'notYet' || res.empty || res.stats?.rows === 0) {   // 回聲不符／查無／表還是空的＝官方還沒出（中性）
          const nt = now() + notYetMs(iso);
          await noteAttempt(iso, { ...entry, reason: `notYet:${res.reason}` }, { status: 'notYet', nextTry: nt, countDated: 1 });
          return { status: 'notYet', dataDate: null, rows: null, reason: `櫃買尚未出 ${iso}（${res.reason}）`, nextTry: nt };
        }
        datedOutcome = { status: 'failed', reason: `帶日期檔驗證不過：${res.reason}`, looseRows: res.echoRows || null };
        await noteAttempt(iso, { ...entry, reason: `invalid:${res.reason}` }, { ...failNext(), countDated: 1 });
      } else if (isBlockHttp(r.http)) {
        await noteAttempt(iso, entry, { status: 'blocked', block: `帶日期端點 HTTP ${r.http}`, countDated: 1 });
        onAlert(`🚨 櫃買帶日期端點 HTTP ${r.http}，今日停用櫃買網路（上櫃收盤改用快取／收件匣）\n${manualHelp(root)}`, `tpex-block-${t.iso}`);
        return { status: 'blocked', dataDate: null, rows: null, reason: `帶日期端點 HTTP ${r.http}` };
      } else {
        datedTransferFail = r.reason !== 'http' || r.http >= 500;   // 5xx 也算（openapi 是另一台 nginx 靜態檔）
        datedOutcome = { status: 'failed', reason: `帶日期端點${reasonText(r)}` };
        await noteAttempt(iso, entry, { ...failNext(), countDated: 1 });
      }
    }
    // ② openapi 大檔：已過 16:00（或要的是前幾天）、帶日期端點是傳輸失敗、今日額度未滿
    const t2 = twOf(now()); const m2 = loadMan(); const day2 = m2.net.day?.date === t2.iso ? m2.net.day : { openapiFull: 0 };
    const known = m2.net.openapi || {};
    // openapi 只有「最新一份」：已知它的資料日比 iso 新、或 iso 是一週前的歷史日 ⇒ 它不可能給出 iso，不打（歸檔補洞掃到舊日子時）
    const openapiCanHave = !(known.dataDate && known.dataDate > iso) && dayDiff(t2.iso, iso) <= 5;
    const openapiOk = datedTransferFail && openapiCanHave && (iso < t2.iso || t2.mins >= pol.openapiEarliestMin) && day2.openapiFull < pol.openapiFullPerDay;
    if (!openapiOk) return { status: 'failed', dataDate: null, rows: null, ...datedOutcome };
    const resume = loadPartial(t2.iso);
    const conditional = !resume && known.etag && known.dataDate && known.dataDate !== iso ? { etag: known.etag, lastModified: known.lastModified } : null;
    await gap();
    const r = await downloadStream(P.OPENAPI_URL, {
      fetchImpl, headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'identity' }, conditional, resume, ...dl,
      onHeaders: h => {
        if (h.http !== 200 && h.http !== 206) return null;
        if (known.badEtag && h.etag && h.etag === known.badEtag) return 'badEtag';
        const lm = Date.parse(h.lastModified || ''); return Number.isFinite(lm) && twOf(lm).iso < iso ? 'stale' : null;
      },
    });
    const entry = { at: now(), src: 'openapi', http: r.http ?? null, reason: r.ok ? (r.notModified ? '304' : 'ok') : r.reason, bytes: r.bytes };
    const counted = r.ok && !r.notModified ? 1 : (!r.ok && ['stall', 'cap', 'reset', 'length'].includes(r.reason) ? 1 : 0);
    const tail = `（帶日期端點：${datedOutcome.reason}）`;
    if (r.notModified || r.reason === 'stale' || r.reason === 'badEtag') {
      await noteAttempt(iso, entry, { ...failNext() });
      return { status: 'failed', dataDate: null, rows: null, reason: `openapi 仍是舊檔${r.reason === 'badEtag' ? '（同一個 ETag 先前驗證不過）' : ''}${tail}`, looseRows: datedOutcome.looseRows };
    }
    if (!r.ok && isBlockHttp(r.http)) {
      await noteAttempt(iso, entry, { status: 'blocked', block: `openapi HTTP ${r.http}` });
      onAlert(`🚨 櫃買 openapi HTTP ${r.http}，今日停用櫃買網路\n${manualHelp(root)}`, `tpex-block-${t2.iso}`);
      return { status: 'blocked', dataDate: null, rows: null, reason: `openapi HTTP ${r.http}` };
    }
    if (!r.ok) {
      savePartial(t2.iso, r);
      await noteAttempt(iso, entry, { ...failNext(), countOpenapi: counted });
      return { status: 'failed', dataDate: null, rows: null, reason: `openapi ${reasonText(r)}${tail}`, looseRows: datedOutcome.looseRows };
    }
    clearPartial();
    const res = await importBuffer(r.buf, { source: 'openapi', expect: iso, meta: { contentLength: r.contentLength ?? r.total, etag: r.etag, lastModified: r.lastModified } });
    const okRes = res.status === 'ok' ? res : res.other || null;
    const openapiState = { etag: r.etag, lastModified: r.lastModified, dataDate: okRes?.dataDate || null, ...(res.status === 'invalid' ? { badEtag: r.etag } : {}) };
    if (res.status === 'ok') { await noteAttempt(iso, entry, { status: 'ok', fails: 0, openapi: openapiState, countOpenapi: 1 }); return res; }
    if (res.status === 'notYet') {
      await noteAttempt(iso, entry, { status: 'notYet', nextTry: now() + notYetMs(iso), openapi: openapiState, countOpenapi: 1 });
      return { status: 'notYet', dataDate: null, rows: null, reason: `openapi 仍是 ${res.dataDate}${tail}` };
    }
    await noteAttempt(iso, entry, { ...failNext(), openapi: openapiState, countOpenapi: 1 });
    onAlert(`⚠ 櫃買 openapi 收盤檔驗證不過（${res.reason}），同一個 ETag 不再抓\n${manualHelp(root)}`, `tpex-invalid-${t2.iso}`);
    return { status: 'failed', dataDate: null, rows: null, reason: `openapi 驗證不過：${res.reason}${tail}`, looseRows: datedOutcome.looseRows };
  }

  /**
   * D 日上櫃收盤 → { status: ok|notYet|failed|blocked|missing|invalid, dataDate, rows(openapi 形狀全部列), source, format, sha256, reason, looseRows? }
   *   missing＝本機沒有、且這個程序不開網路（network:'never'）。looseRows＝帶日期端點回聲相符但完整性不過時的列（歷史日權證數較少；讀者自行決定要不要用）。
   */
  async function getTpexClose(ymd, { network = defaultNetwork } = {}) {
    const iso = P.toIso(ymd);
    if (!iso) return { status: 'invalid', dataDate: null, rows: null, reason: `日期認不得：${ymd}` };
    const hit = mem.get(iso); if (hit) return { ...hit, source: hit.source, cached: 'memory' };
    const key = `${iso}|${network}`;
    if (inflight.has(key)) return inflight.get(key);
    const task = (async () => {
      const d = readDay(iso); if (d) return remember(iso, d);
      if (inboxPending().length) { await ingestInbox(); const d2 = readDay(iso); if (d2) return remember(iso, d2); }
      const mr = mirrorDay(iso); if (mr) return remember(iso, mr);
      if (network !== 'auto') return { status: 'missing', dataDate: null, rows: null, reason: '本機快取、收件匣、官方鏡像都沒有這一天（此程序不開網路）' };
      return netFetch(iso);
    })().finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }

  /** 最近一份（≤ before）已驗證的上櫃收盤（快取或鏡像，0 請求）；比 maxAgeDays 舊就回 null。慢變數（名稱、發行股數）與種子後備用。 */
  async function getLatestTpexClose({ maxAgeDays = 14, before = null } = {}) {
    if (inboxPending().length) await ingestInbox();
    const m = loadMan();
    const cache = Object.keys(m.days).filter(k => m.days[k]?.status === 'ok' && (!before || k <= before)).sort().at(-1) || null;
    const mir = mirrorLatestIso(before);
    const pick = [cache, mir].filter(Boolean).sort().at(-1);
    if (!pick || dayDiff(twOf(now()).iso, pick) > maxAgeDays) return null;
    const res = mem.get(pick) || (pick === cache ? readDay(pick, m) : null) || mirrorDay(pick) || (cache ? readDay(cache, m) : null);
    return res ? remember(res.dataDate, res) : null;
  }

  /**
   * 交易日 iso 到 19:00（或之後的日子）仍沒有已驗證檔 ⇒ 寫 _alerts/{iso}.json（每日一次）並回告警文字。
   * 順帶補發其他程序（手動腳本，沒有告警通道）留下的收件匣拒收告警——daemon 每次載入宇宙都會呼叫這裡（背景、不等）。
   */
  function checkMissing(iso) {
    flushInboxAlerts().catch(e => log(`  ⚠ 收件匣拒收告警補發失敗：${(e?.message || '').slice(0, 60)}`));
    const d = P.toIso(iso); const t = twOf(now());
    if (!d || !isTradingDay(d) || d > t.iso) return { alert: false };
    if (d === t.iso && t.mins < pol.alertAtMin) return { alert: false };
    if (mem.has(d) || loadMan().days[d]?.status === 'ok' || mirrorDay(d)) return { alert: false };
    const p = join(root, '_alerts', `${d}.json`);
    if (existsSync(p)) return { alert: false, already: true };
    const w = loadMan().net.want[d];
    const text = `🚨 上櫃收盤 ${d} 到 ${hhmm(now())} 仍未取得已驗證檔（最後一次：${w?.last ? `${w.last.src} ${w.last.reason}` : '未嘗試'}）。全站上櫃種子沿用前一份；可手動下載：\n${manualHelp(root)}`;
    writeAtomic(p, JSON.stringify({ date: d, at: new Date(now()).toISOString(), text, last: w?.last || null, manualUrl: P.OPENAPI_URL, inbox: join(root, '_inbox') }, null, 1));
    return { alert: true, text };
  }

  /** 狀態摘要（CLI／除錯） */
  function status() {
    const m = loadMan();
    const scan = inboxScan();
    return { root, days: Object.fromEntries(Object.entries(m.days).sort().map(([k, d]) => [k, { source: d.source, format: d.format, rows: d.rows, stocks4: d.stocks4, sha8: d.sha256?.slice(0, 8), revisions: (d.revisions || []).length, alt: Object.keys(d.alt || {}) }])), net: { day: m.net.day, blocked: m.net.blocked, openapi: m.net.openapi, want: m.net.want },
      inboxPending: scan.ready, inboxWaiting: scan.waiting, inboxRejected: m.inbox.rejected };
  }

  /** 官方鏡像收養用：某月（YYYY-MM）最新一份 openapi 格式的原始位元組（快取主檔或 alt）；沒有回 null */
  function openapiRawFor(ym) {
    const m = loadMan();
    const cands = Object.entries(m.days).filter(([k, d]) => k.startsWith(ym) && d.status === 'ok').map(([k, d]) => [k, d.format === 'openapi' ? d : d.alt?.openapi]).filter(([, r]) => r?.file).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const last = cands.at(-1); if (!last) return null;
    const raw = gunzipSync(readFileSync(join(root, last[1].file)));
    return sha256(raw) === last[1].sha256 ? { dataDate: last[0], raw, sha256: last[1].sha256, fetchedAt: last[1].fetchedAt, source: last[1].source } : null;
  }

  return { getTpexClose, getLatestTpexClose, ingestInbox, flushInboxAlerts, importBuffer, checkMissing, status, openapiRawFor, root, firestoreDocOf: (res, ms = now()) => P.firestoreDocOf(res, ms) };
}
