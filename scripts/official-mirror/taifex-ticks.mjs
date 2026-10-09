// ── 第二大腦·官方鏡像：期交所「前30個交易日期貨每筆成交資料（不含鉅額）」CSV zip 每日歸檔（2026-10-09）──────────
// 依據：使用者 2026-10-08 裁定「依建議進行」（sara 型態回測要台指期盤中分 K；官方只有 30 日逐筆檔、沒有更早歷史，
//       不每天歸檔約 29 個交易日後就每天永久少一天）。全量存檔合法性 2026-10-08 使用者核可：原始檔只存本機、不上 Firestore、不再散佈。
// 端點：清單頁 GET dlFutPrevious30DaysSalesData（解析 DailydownloadCSV/Daily_YYYY_MM_DD.zip 連結）；
//       檔案 GET /file/taifex/Dailydownload/DailydownloadCSV/Daily_YYYY_MM_DD.zip（1.3–2.3MB；cp950 CSV 約 30–45MB）。
//       欄位：成交日期,商品代號,到期月份(週別),成交時間,成交價格,成交數量(B+S),近月價格,遠月價格,開盤集合競價。
// 檔名日＝交易日 s：含 s−1 日 15:00 起的夜盤（成交日期記「日曆日」：s−1 日與跨午夜的隔天）＋ s 日 08:45 起的日盤。
// 陷阱（2026-10-09 補假實測）：休市日清單會先出現「下一交易日」的檔（Daily_2026_10_12.zip），內容只有休市前一晚的夜盤；
//   30 個位置被它佔走，最舊的一天（08-26）因此提前滾出、日盤永久缺 ⇒ 不可用「下一交易日 16:40」這種時鐘算死線，要看清單。
// 規則：
//   ① 只抓「交易日表已收盤歸檔」的日子（≤ 鏡像交易日表最後確認日；今天是候選交易日且過 16:50 也算，見 official-mirror.mjs ticksClosed）；
//      清單上更晚的日檔一律略過（只有夜盤）。清單每列有「時間」欄＝官方上架時刻（實測與 zip 內時間差 ≤4 秒；10-12 夜盤檔是 10-09 05:11）：
//      早於檔名日 13:45 的版本＝只有夜盤 ⇒ 不請求，等重新上架。
//   ② 回聲＝zip 完整（中央目錄、CRC32、長度）＋檔內最晚成交日＝檔名日＋檔名日有 08:45 以後（日盤）的成交；不符不寫檔。
//      第三條擋「跨午夜夜盤成交日恰好＝檔名日」的只有夜盤版本（最晚成交日相符、但沒有日盤）。
//   ③ 同名更新：已歸檔的日子清單時間變新（重新上架）才重抓（0 個額外清單請求）；sha256 相同只記再確認；不同且變大 ⇒ 新版覆蓋、
//      舊版改名保留（versions）；不同但沒變大 ⇒ 保留舊版、記 lastTry、寫 _alerts。轉存進來的舊檔沒有清單時間：zip 內時間與清單差 ≤10 分 ⇒ 認定同版、
//      直接記上；差更多 ⇒ 重抓比對一次。同一上架版本判定不符／只有夜盤後，清單時間沒變就不重抓（listSeen）。
//   ④ 交易日不在清單上：早於清單首檔 ⇒ status=lost（永久缺）；其餘 ⇒ 未歸檔。缺日由 official-mirror 的 _alerts 揭露（ticksGapAlerts）。
// 存放：second-brain/official/www.taifex.com.tw/taifex_ticks_30d/{YYYY-MM-DD}.zip.gz（zip 原始位元組 gzip，sha256 算在 zip 上）；
//       清單頁每次抓取另存 _list/{台北日}.html.gz；_manifest.json 的 list 欄記最近一次清單（首末日、檔數）。
import { inflateRawSync, crc32, gzipSync } from 'node:zlib';
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import * as C from '../lib/official-mirror.mjs';

export const TICKS = Object.freeze({
  id: 'taifex_ticks_30d', host: 'www.taifex.com.tw', ext: 'zip',
  from: '2026-08-27',                // 歸檔起點＝第一個收到的交易日；08-26 在 10-09 一次性回補時已滾出（migrate 記 lost、不列警示），更早的從未收過
  listUrl: 'https://www.taifex.com.tw/cht/3/dlFutPrevious30DaysSalesData',
  minListDays: 20,                   // 清單少於這個數 ⇒ 多半是錯誤頁或改版，整輪不抓
  dayOpen: '084500',                 // 日盤開盤；檔名日要有這之後的成交才算完整
  dayClose: '13:45:00',              // 清單時間早於檔名日這個時刻 ⇒ 只有夜盤的版本（日盤 13:45 收盤；完整檔實測 16:35–16:46 上架）
  sameVersionMs: 10 * 60e3,          // 轉存檔沒有清單時間：zip 內時間與清單時間差在這之內 ⇒ 同一版
  publishedMin: 16 * 60 + 50,        // 今天是候選交易日且過 16:50（日檔 16:37–16:46 上架）⇒ 今天也算已收盤
  maxBadRows: 3, maxBadRatio: 1e-4,  // CSV 認不得的列：≤ max(3 列, 0.01%) 容忍（檔尾 EOF 字元、零星註記）並記 badRows；更多 ⇒ 拒收
  maxZipRetries: 3,                  // 同一上架版本 zip 壞（截斷／CRC）重抓上限；之後等重新上架
  maxFilesPerRun: 5,                 // 平常每輪 1 檔；漏跑後補件的單輪上限（逐請求 ≥3 秒）
  alertHorizon: 30,                  // 警示只看最近 30 個確認交易日（與 30 日窗同量級）
  listTimeoutMs: 45000, fileTimeoutMs: 180000,
});
const pad = s => String(s).padStart(6, '0');
const pad2 = s => String(s).padStart(2, '0');
export const ticksFileUrl = day => `https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_${day.replaceAll('-', '_')}.zip`;

// ── 清單頁 ─────────────────────────────────────────────
const LINK_RE = /DailydownloadCSV\/Daily_(\d{4})_(\d{2})_(\d{2})\.zip/;
const TIME_RE = /(\d{4})\/(\d{1,2})\/(\d{1,2})\s*(AM|PM|上午|下午)\s*(\d{1,2}):(\d{2}):(\d{2})/;
/**
 * 清單頁 HTML → 檔名日（升冪、去重）＋每列「時間」欄（上架時刻，台北 YYYY-MM-DDTHH:MM:SS；認不得的列沒有時間）。
 * 少於 minListDays ⇒ bad。
 */
export function parseTicksList(html, minDays = TICKS.minListDays) {
  const days = new Set(); const times = {}; const text = String(html ?? '');
  const dayOf = m => (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 ? `${m[1]}-${m[2]}-${m[3]}` : null);
  for (const m of text.matchAll(new RegExp(LINK_RE.source, 'g'))) { const d = dayOf(m); if (d) days.add(d); }
  for (const seg of text.split(/<tr[\s>]/i)) {   // 時間欄與連結同一列（表格改版認不得時間 ⇒ 只是沒有時間，不影響日子）
    const day = dayOf(seg.match(LINK_RE)); if (!day) continue;
    const t = seg.match(TIME_RE); if (!t) continue;
    const h = (+t[5] % 12) + (/PM|下午/.test(t[4]) ? 12 : 0);
    times[day] = `${t[1]}-${pad2(t[2])}-${pad2(t[3])}T${pad2(h)}:${t[6]}:${t[7]}`;
  }
  const list = [...days].sort();
  if (list.length < minDays) return { status: 'bad', days: list, times, note: `清單只有 ${list.length} 個 CSV 檔連結（< ${minDays}，錯誤頁或改版？）` };
  return { status: 'ok', days: list, times, first: list[0], last: list.at(-1) };
}

// ── zip 完整性（只用 node:zlib；不支援 zip64／加密，遇到就判 bad）──────────────────
const u16 = (b, o) => b.readUInt16LE(o);
const u32 = (b, o) => b.readUInt32LE(o);
const dosTime = (date, time) => `${((date >> 9) & 0x7f) + 1980}-${String((date >> 5) & 0xf).padStart(2, '0')}-${String(date & 0x1f).padStart(2, '0')}`
  + `T${String(time >> 11).padStart(2, '0')}:${String((time >> 5) & 0x3f).padStart(2, '0')}:${String((time & 0x1f) * 2).padStart(2, '0')}`;

/** 讀只含一個 CSV 的 zip：中央目錄結尾、中央目錄、本地檔頭、解壓長度、CRC32 全部對得上才 ok。回傳 { ok, name, data, zipTime } 或 { ok:false, note }。 */
export function readSingleZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, note: '不是 zip（過短）' };
  if (u32(buf, 0) !== 0x04034b50) return { ok: false, note: '不是 zip（開頭不是 PK\\x03\\x04）' };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return { ok: false, note: 'zip 不完整（找不到中央目錄結尾，下載被截斷？）' };
  const total = u16(buf, eocd + 10); const cdSize = u32(buf, eocd + 12); const cdOff = u32(buf, eocd + 16);
  if (cdOff + cdSize > eocd) return { ok: false, note: 'zip 不完整（中央目錄越界）' };
  const entries = [];
  for (let p = cdOff, k = 0; k < total; k++) {
    if (p + 46 > eocd || u32(buf, p) !== 0x02014b50) return { ok: false, note: `zip 中央目錄第 ${k + 1} 筆損壞` };
    const nameLen = u16(buf, p + 28);
    entries.push({ flags: u16(buf, p + 8), method: u16(buf, p + 10), time: u16(buf, p + 12), date: u16(buf, p + 14), crc: u32(buf, p + 16),
      csize: u32(buf, p + 20), usize: u32(buf, p + 24), local: u32(buf, p + 42), name: buf.toString('latin1', p + 46, p + 46 + nameLen) });
    p += 46 + nameLen + u16(buf, p + 30) + u16(buf, p + 32);
  }
  const csv = entries.filter(e => /\.csv$/i.test(e.name));
  if (csv.length !== 1) return { ok: false, note: `zip 內 CSV 檔數 ${csv.length}（預期 1；全部：${entries.map(e => e.name).join('、') || '無'}）` };
  const e = csv[0];
  if (e.flags & 1) return { ok: false, note: 'zip 加密' };
  if ([e.csize, e.usize, e.local].includes(0xffffffff)) return { ok: false, note: 'zip64 不支援' };
  if (e.local + 30 > cdOff || u32(buf, e.local) !== 0x04034b50) return { ok: false, note: 'zip 本地檔頭損壞' };
  const start = e.local + 30 + u16(buf, e.local + 26) + u16(buf, e.local + 28);
  if (start + e.csize > cdOff) return { ok: false, note: 'zip 不完整（壓縮資料越界）' };
  const raw = buf.subarray(start, start + e.csize);
  let data;
  try { data = e.method === 0 ? Buffer.from(raw) : e.method === 8 ? inflateRawSync(raw) : null; } catch (err) { return { ok: false, note: `zip 解壓失敗（${err.message.slice(0, 60)}）` }; }
  if (!data) return { ok: false, note: `zip 壓縮法 ${e.method} 不支援` };
  if (data.length !== e.usize) return { ok: false, note: `zip 解壓長度 ${data.length} ≠ 目錄記載 ${e.usize}` };
  if ((crc32(data) >>> 0) !== (e.crc >>> 0)) return { ok: false, note: 'zip CRC32 不符（內容損壞）' };
  return { ok: true, name: e.name, data, zipTime: dosTime(e.date, e.time) };
}

// ── CSV 回聲 ─────────────────────────────────────────────
/**
 * 逐筆 CSV（cp950）→ 每個成交日的筆數與最早／最晚成交時間。只看前四欄（ASCII），不轉碼內容。
 * 表頭不是逐筆成交 ⇒ ok:false；認不得的列 ≤ max(maxBadRows, rows×maxBadRatio) 容忍（badRows 記下），超過 ⇒ ok:false
 * （一列怪字就整檔拒收、滾出窗後永久缺，代價太大；2026-10-09 審查 M2）。
 */
export function scanTicksCsv(buf) {
  const nl = buf.indexOf(0x0a);
  const header = new TextDecoder('big5').decode(buf.subarray(0, nl < 0 ? buf.length : nl));
  if (!header.includes('成交日期') || !header.includes('成交時間')) return { ok: false, note: '表頭不是逐筆成交（缺 成交日期／成交時間）' };
  const dates = {}; let rows = 0; let badRows = 0; let badSample = null;
  for (let i = nl < 0 ? buf.length : nl + 1; i < buf.length;) {
    let j = buf.indexOf(0x0a, i); if (j < 0) j = buf.length;
    const line = buf.subarray(i, j); i = j + 1;
    if (line.length < 3 && !line.toString('latin1').replace(/\x1a/g, '').trim()) continue;   // 空行／結尾 \r／DOS EOF
    const c1 = line.indexOf(0x2c); const c2 = c1 < 0 ? -1 : line.indexOf(0x2c, c1 + 1);
    const c3 = c2 < 0 ? -1 : line.indexOf(0x2c, c2 + 1); const c4 = c3 < 0 ? -1 : line.indexOf(0x2c, c3 + 1);
    const d = c1 < 0 ? '' : line.toString('latin1', 0, c1).trim();
    const t = c4 < 0 ? '' : line.toString('latin1', c3 + 1, c4).trim();
    if (!/^\d{8}$/.test(d) || !/^\d{1,6}$/.test(t)) { badRows++; badSample ??= line.toString('latin1').slice(0, 60); continue; }
    const tt = pad(t); const s = dates[d] ||= { n: 0, first: tt, last: tt };
    s.n++; rows++; if (tt < s.first) s.first = tt; if (tt > s.last) s.last = tt;
  }
  const sample = badSample ? `（例：${badSample}）` : '';
  if (badRows > Math.max(TICKS.maxBadRows, rows * TICKS.maxBadRatio)) return { ok: false, note: `有 ${badRows} 列認不得${sample}`, rows, dates, badRows };
  return { ok: true, rows, dates, ...(badRows ? { badRows, badNote: `容忍 ${badRows} 列認不得${sample}` } : {}) };
}

/**
 * 一個日檔的回聲驗證：status ok｜bad（zip／表頭壞）｜mismatch（最晚成交日≠檔名日：多半是只有夜盤的未來交易日檔）｜
 * partial（最晚成交日＝檔名日但沒有日盤：只有跨午夜夜盤）。只有 ok 會寫檔。
 */
export function validateTicksZip(buf, day) {
  const z = readSingleZip(buf);
  if (!z.ok) return { status: 'bad', note: z.note, zipOk: false };
  const d8 = day.replaceAll('-', '');
  const named = z.name.match(/Daily_(\d{4})_(\d{2})_(\d{2})/);
  if (named && named.slice(1).join('') !== d8) return { status: 'mismatch', note: `zip 內檔名 ${z.name} ≠ 檔名日 ${day}`, entry: z.name, zipOk: true };
  const s = scanTicksCsv(z.data);
  const base = { entry: z.name, zipTime: z.zipTime, csvBytes: z.data.length, rows: s.rows ?? null, dates: s.dates || null, zipOk: true, ...(s.badRows ? { badRows: s.badRows } : {}) };
  if (!s.ok) return { status: 'bad', note: s.note, ...base };
  const ds = Object.keys(s.dates).sort();
  if (!ds.length) return { status: 'bad', note: '0 筆成交', ...base };
  const last = ds.at(-1);
  if (last !== d8) return { status: 'mismatch', echo: C.normDate(last), note: `檔內最晚成交日 ${last} ≠ 檔名日 ${d8}（只有夜盤的未來交易日檔？）`, ...base };
  if (s.dates[d8].last < TICKS.dayOpen) return { status: 'partial', echo: day, note: `檔名日只有 ${s.dates[d8].first}–${s.dates[d8].last} 的成交（跨午夜夜盤），日盤尚未入檔`, ...base };
  return { status: 'ok', echo: day, ...base, ...(s.badNote ? { note: s.badNote } : {}) };
}

// ── 存檔（同名更新）──────────────────────────────────────
const isDone = (man, d) => C.isFinal(man, d);

/** 拒收但 zip 完整的原樣檔隔離存放 _rejected/{日}.{sha12}.zip.gz（同 sha 不重寫）：格式改版或只有夜盤的版本，滾出窗後至少還有證據。 */
function quarantine(root, day, buf, hash) {
  const rel = `_rejected/${day}.${hash.slice(0, 12)}.${TICKS.ext}.gz`; const p = join(C.datasetDir(root, TICKS.host, TICKS.id), rel);
  if (!existsSync(p)) { mkdirSync(join(C.datasetDir(root, TICKS.host, TICKS.id), '_rejected'), { recursive: true }); writeFileSync(`${p}.tmp`, gzipSync(buf)); renameSync(`${p}.tmp`, p); }
  return rel;
}

/**
 * 把下載到的日檔併進清單（mutates man.rows[day]，呼叫端負責 saveManifest）。回傳 { action: new｜same｜replace｜keep｜reject }。
 *   reject：驗證沒過，不寫正式檔（zip 完整的原樣隔離到 _rejected/；已有好資料的只記 lastTry）；same：sha256 相同；
 *   replace：不同且變大 ⇒ 新版覆蓋、舊檔改名留存；keep：不同但沒變大 ⇒ 保留舊版、lastTry.status='differs'（ticksGapAlerts 會列警示）。
 */
export function storeTicksDay(root, man, day, buf, v, { at, url, http = 200, listTime = null }) {
  const hash = C.sha256(buf); const prev = man.rows[day]; const good = C.hasGood(man, day);
  const info = { echo: v.echo ?? null, rows: v.rows ?? null, entry: v.entry ?? null, zipTime: v.zipTime ?? null, csvBytes: v.csvBytes ?? null, dates: v.dates ?? null, ...(v.badRows ? { badRows: v.badRows } : {}) };
  // listSeen＝已下載檢查過的清單時間：zip 完整時的內容判定（不符／只有夜盤／CSV 壞／沒變大）重抓也不會變，同一上架版本不再重抓；
  //   zip 本身壞（截斷、CRC）可能是傳輸問題 ⇒ 同一上架版本最多重抓 maxZipRetries 次（zipRetry 記次數），之後等重新上架（審查 M3）
  const intact = v.status === 'ok' || v.zipOk !== false;
  const seen = listTime && intact ? { listSeen: listTime } : {};
  const zipRetry = !intact && listTime ? { zipRetry: { listTime, n: (prev?.zipRetry?.listTime === listTime ? prev.zipRetry.n : 0) + 1 } } : {};
  if (v.status !== 'ok') {
    const rejected = intact ? { rejectedFile: quarantine(root, day, buf, hash) } : {};
    const lastTry = { status: v.status, note: v.note || null, sha256: hash, bytes: buf.length, at, listTime, ...rejected };
    man.rows[day] = good ? { ...prev, lastTry, ...seen, ...zipRetry }
      : { status: v.status, note: v.note || null, at, attempts: prev?.attempts, url, ...info, listTime, ...seen, ...zipRetry, sha256: hash, bytes: buf.length, ...rejected };
    return { action: 'reject', status: v.status };
  }
  if (good && prev.sha256 === hash) { man.rows[day] = { ...prev, recheck: at, ...(listTime ? { listTime, listSeen: listTime } : {}) }; return { action: 'same' }; }
  if (good && !(buf.length > (prev.bytes ?? Infinity))) {
    man.rows[day] = { ...prev, ...seen, lastTry: { status: 'differs', note: `同名檔內容不同但沒有變大（${buf.length} ≤ ${prev.bytes} bytes），保留舊版待人工判斷`, sha256: hash, bytes: buf.length, at, listTime } };
    return { action: 'keep' };
  }
  let versions = prev?.versions || [];
  let file;
  if (good) {   // 舊版不刪：改名保留（原始檔只存本機，留證據）。先寫新版暫名、成功後才動舊檔（中途失敗不會讓清單指向不存在的檔，審查 L5）
    const dir = C.datasetDir(root, TICKS.host, TICKS.id); const old = `${day}.v-${String(prev.sha256).slice(0, 12)}.${TICKS.ext}.gz`;
    const incoming = C.writeEntry(root, TICKS.host, TICKS.id, `${day}.incoming`, { kind: 'text', ext: TICKS.ext, buffer: buf });
    if (prev.file && existsSync(join(dir, prev.file))) renameSync(join(dir, prev.file), join(dir, old));
    file = `${day}.${TICKS.ext}.gz`; renameSync(join(dir, incoming), join(dir, file));
    versions = [...versions, { sha256: prev.sha256, bytes: prev.bytes ?? null, at: prev.at ?? null, zipTime: prev.zipTime ?? null, file: old, archivedAt: at }];
  } else file = C.writeEntry(root, TICKS.host, TICKS.id, day, { kind: 'text', ext: TICKS.ext, buffer: buf });
  man.rows[day] = { status: 'ok', file, sha256: hash, bytes: buf.length, url, http, at, final: true, ...info, listTime, listSeen: listTime, ...(versions.length ? { versions } : {}) };
  return { action: good ? 'replace' : 'new' };
}

// ── 計畫與缺口（只讀本機，0 請求）────────────────────────────
/**
 * 「該日已收盤歸檔」的日子與最後收盤日：交易日表確認日（≤ today）；今天若是候選交易日（平日、不在官方休市表、未確認休市）
 * 且台北時間已過 publishedMin 也算（今天的 MI_INDEX 要到 22:40 daily 才確認）。confirmed／candidates 來自 official-mirror dayInfo。
 */
export function ticksClosedFrom({ confirmed, candidates = [], today, now = new Date() }) {
  const tw = C.taipeiNow(now); const closed = new Set([...confirmed].filter(d => d <= today));
  if ([...candidates].includes(today) && tw.getUTCHours() * 60 + tw.getUTCMinutes() >= TICKS.publishedMin) closed.add(today);
  return { closed, lastClosed: [...closed].sort().at(-1) || null };
}

const closedDays = (confirmed, lastClosed, from) => [...confirmed].filter(d => d >= from && d <= lastClosed).sort();

/** 交易日表已收盤、還沒歸檔也還沒判定永久缺的日子（空 ⇒ 本輪不必抓清單）。 */
export function ticksPending({ man, confirmed, lastClosed, from = TICKS.from }) {
  if (!lastClosed) return [];
  return closedDays(confirmed, lastClosed, from).filter(d => !isDone(man, d) && man.rows?.[d]?.status !== 'lost');
}

const tMs = t => Date.parse(`${t}Z`);   // 台北本地時間字串彼此相減用（同一時區，當 UTC 解析即可）
/**
 * 依清單決定本輪（舊的先，越舊越快滾出）：
 *   fetch＝清單上、≤ lastClosed、未歸檔（或 refetch 指定）、或已歸檔但清單時間變新（updated：同名檔重新上架）的日子；
 *   future＝清單上 > lastClosed（該日尚未收盤歸檔：只有夜盤，略過）；notReady＝清單時間早於檔名日 13:45（只有夜盤的版本，略過）；
 *   stale＝上次下載這個上架版本已判定不符／只有夜盤，清單時間沒變就不重抓；adopt＝轉存檔沒有清單時間、zip 內時間與清單相符 ⇒ 直接記上（0 請求）；
 *   lost＝已確認交易日早於清單首檔（滾出窗）；unlisted＝窗內卻不在清單上。
 */
export function planTicks({ listDays, times = {}, man, confirmed, lastClosed, from = TICKS.from, refetch = [] }) {
  const listed = new Set(listDays); const first = listDays[0];
  const fetch = []; const future = []; const notReady = []; const stale = []; const updated = []; const adopt = [];
  for (const d of listDays) {
    if (d < from) continue;
    if (!lastClosed || d > lastClosed) { future.push(d); continue; }
    const t = times[d] || null; const r = man.rows?.[d];
    if (t && t < `${d}T${TICKS.dayClose}`) { notReady.push(d); continue; }
    if (!isDone(man, d)) {
      const judged = t && r?.listSeen && t <= r.listSeen && /^(mismatch|partial|bad)$/.test(r.status);                 // 這個上架版本已判定過內容
      const retried = t && r?.zipRetry?.listTime === t && r.zipRetry.n >= TICKS.maxZipRetries;                          // zip 壞已重抓滿
      if ((judged || retried) && !refetch.includes(d)) stale.push(d); else fetch.push(d);
      continue;
    }
    if (refetch.includes(d)) { fetch.push(d); continue; }
    if (!t) continue;
    const seen = r.listSeen || r.listTime;
    if (seen) { if (t > seen) { fetch.push(d); updated.push(d); } continue; }
    // 沒有清單時間的舊列：zip 內時間與清單相符或無從比對 ⇒ 記上（0 請求）；明顯不同（例：轉存的是較早版本）⇒ 重抓比對
    if (!r.zipTime || Math.abs(tMs(t) - tMs(r.zipTime)) <= TICKS.sameVersionMs) adopt.push(d); else { fetch.push(d); updated.push(d); }
  }
  const lost = []; const unlisted = [];
  for (const d of lastClosed ? closedDays(confirmed, lastClosed, from) : []) {
    if (listed.has(d) || isDone(man, d)) continue;
    if (d < first) { if (man.rows?.[d]?.status !== 'lost') lost.push(d); } else unlisted.push(d);
  }
  return { fetch, future, notReady, stale, updated, adopt, lost, unlisted };
}

/**
 * _alerts 用的缺口（0 請求）：最近 horizon 個確認交易日裡沒歸檔的。最後一個確認日寬限一輪不算缺（官方晚上架時當晚 17:10 抓不到，下一個平日補）。
 * 永久缺（lost）照列（此來源已無法補，只能揭露）；同名檔出現沒變大的不同版本（lastTry differs）也列。
 */
export function ticksGapAlerts({ man, confirmed, lastClosed, from = TICKS.from, horizon = TICKS.alertHorizon }) {
  if (!lastClosed) return [];
  const out = []; const id = TICKS.id;
  for (const d of closedDays(confirmed, lastClosed, from).slice(-horizon)) {
    const r = man.rows?.[d];
    if (isDone(man, d)) {
      if (r.lastTry?.status === 'differs') out.push({ id, key: d, status: `期交所同名日檔出現不同版本（${r.lastTry.note}）` });
      continue;
    }
    if (r?.status === 'lost') { out.push({ id, key: d, status: `30 日逐筆已滾出清單、永久缺（${r.note || '此來源無法再補'}）` }); continue; }
    if (d === lastClosed) continue;
    out.push({ id, key: d, status: r?.status ? `30 日逐筆未歸檔（最近一次：${r.status}${r.note ? `·${r.note}` : ''}；仍在清單上才補得到）` : '30 日逐筆未歸檔（ticks 未執行或失敗；仍在清單上才補得到）' });
  }
  return out;
}

// ── 請求（共用家族佇列：≥3 秒、禁跑窗、封鎖即停、5xx 退避一次）──────────────────
const FATAL = [401, 403, 429, 301, 302, 303, 307, 308];
async function ticksRequest(q, url, { fetchImpl, timeoutMs, expectZip = false }) {
  let res = null;
  const out = await q.run(async () => {
    const r = await C.httpFetch({ url }, { fetchImpl, timeoutMs });
    if (FATAL.includes(r.status)) return { fatal: true, failed: true, note: `HTTP ${r.status}` };
    if (r.status >= 500) return { retryable: true, failed: true, note: `HTTP ${r.status}` };
    if (r.status !== 200) return { failed: true, note: `HTTP ${r.status}` };
    const isZip = r.buf.length >= 4 && u32(r.buf, 0) === 0x04034b50;
    if (!isZip && C.BLOCK_RE.test(C.decodeBody(r.buf.subarray(0, 20000), 'utf-8'))) return { fatal: true, failed: true, note: '封鎖／安全頁' };
    // 日檔回 200 卻不是 zip（錯誤頁）：算失敗，連續 3 次停整個機構（審查 M3：舊版當成功、佇列不停）
    if (expectZip && !isZip) return { failed: true, note: `HTTP 200 但不是 zip（${r.contentType || '無 content-type'}，${r.buf.length} bytes）` };
    res = r; return {};
  });
  return res ? { res } : { ...out, note: out?.note || out?.skipped || '失敗' };
}

/** 抓清單頁並記在 man.list（原始 HTML 存 _list/{台北日}.html.gz）。回傳 { ok, list, note, skipped }。 */
async function fetchList({ root, man, q, fetchImpl, now }) {
  const r = await ticksRequest(q, TICKS.listUrl, { fetchImpl, timeoutMs: TICKS.listTimeoutMs });
  const at = now().toISOString();
  if (!r.res) { man.listTry = { status: r.skipped ? 'skipped' : 'fail', note: r.note, at }; return { ok: false, note: r.note, skipped: !!r.skipped }; }
  const L = parseTicksList(C.decodeBody(r.res.buf, 'utf-8'));
  const dir = join(C.datasetDir(root, TICKS.host, TICKS.id), '_list'); mkdirSync(dir, { recursive: true });
  // 好清單一天一份（上架時間的唯一證據）；壞頁另存帶時刻的檔名，不蓋掉同日的好版本（審查 L4）
  const file = L.status === 'ok' ? `_list/${C.taipeiDate(new Date(at))}.html.gz` : `_list/${C.taipeiDate(new Date(at))}.bad-${at.slice(11, 19).replaceAll(':', '')}.html.gz`;
  writeFileSync(join(C.datasetDir(root, TICKS.host, TICKS.id), file), gzipSync(r.res.buf));
  const rec = { status: L.status, at, n: L.days.length, first: L.first ?? null, last: L.last ?? null, days: L.days, times: L.times, sha256: C.sha256(r.res.buf), file, note: L.note ?? null };
  if (L.status !== 'ok') { man.listTry = rec; return { ok: false, note: L.note }; }
  man.list = rec; delete man.listTry;
  return { ok: true, list: L };
}

/** 抓一個日檔、驗證、存檔。回傳 { action, status, note, skipped }。 */
async function fetchDay({ root, man, q, fetchImpl, now, day, listTime = null }) {
  const url = ticksFileUrl(day);
  const r = await ticksRequest(q, url, { fetchImpl, timeoutMs: TICKS.fileTimeoutMs, expectZip: true });
  const at = now().toISOString();
  if (!r.res) {
    if (r.skipped) return { skipped: true, status: 'skipped', note: r.note };
    const prev = man.rows[day];
    man.rows[day] = C.hasGood(man, day) ? { ...prev, lastTry: { status: 'fail', note: r.note, at } } : { status: 'fail', note: r.note, at, url, attempts: (prev?.attempts || 0) + 1 };
    return { action: 'fail', status: 'fail', note: r.note };
  }
  const v = validateTicksZip(r.res.buf, day);
  const out = storeTicksDay(root, man, day, r.res.buf, v, { at, url, http: r.res.status, listTime });
  if (out.action === 'reject' && !C.hasGood(man, day)) man.rows[day] = { ...man.rows[day], attempts: (man.rows[day].attempts || 0) + 1 };
  return { ...out, status: v.status, note: v.note || null };
}

/**
 * 每日歸檔一輪：沒有待抓日 ⇒ 0 請求；否則清單 1 個＋待抓日檔（≤ maxFiles）。
 * confirmed／lastClosed：鏡像交易日表（dayInfo 的確認日與 ≤ 今天的最後一個確認日）。
 */
export async function runTicks({ root, confirmed, lastClosed, q, fetchImpl, log = () => {}, now = () => new Date(), maxFiles = TICKS.maxFilesPerRun, refetch = [], forceList = false }) {
  const man = C.loadManifest(root, TICKS.host, TICKS.id); const before = q.count; const stats = {};
  const bump = k => { stats[k] = (stats[k] || 0) + 1; };
  const pending = ticksPending({ man, confirmed, lastClosed });
  if (!pending.length && !refetch.length && !forceList) { log(`${TICKS.id}：交易日表到 ${lastClosed} 都已歸檔，本輪 0 請求`); return { requests: 0, stats: { idle: 1 }, pending }; }
  const L = await fetchList({ root, man, q, fetchImpl, now });
  if (!L.ok) { C.saveManifest(root, man); log(`${TICKS.id}：清單頁${L.skipped ? '略過' : '失敗'}（${L.note}）`); return { requests: q.count - before, stats: { [L.skipped ? 'skipped' : 'listFail']: 1 }, pending }; }
  const times = L.list.times || {};
  const plan = planTicks({ listDays: L.list.days, times, man, confirmed, lastClosed, refetch });
  const at = now().toISOString();
  for (const d of plan.lost) { man.rows[d] = { ...(man.rows[d] || {}), status: 'lost', note: `清單首檔已是 ${L.list.first}（30 日窗已滾過此日）`, at, listFirst: L.list.first }; bump('lost'); }
  for (const d of plan.adopt) { man.rows[d] = { ...man.rows[d], listTime: times[d], listSeen: times[d] }; bump('adopt'); }
  if (plan.future.length) log(`${TICKS.id}：略過 ${plan.future.map(d => `${d}（上架 ${times[d] || '?'}）`).join('、')}——晚於交易日表最後收盤日 ${lastClosed}：只有夜盤，收盤歸檔後再抓`);
  if (plan.notReady.length) log(`${TICKS.id}：略過 ${plan.notReady.map(d => `${d}（上架 ${times[d]}）`).join('、')}——清單時間早於檔名日 13:45，只有夜盤版，等重新上架（--refetch 也不抓）`);
  const offList = refetch.filter(d => !L.list.days.includes(d));
  if (offList.length) log(`${TICKS.id}：--refetch ${offList.join('、')} 不在清單上，無法重抓`);
  if (plan.stale.length) log(`${TICKS.id}：${plan.stale.join('、')} 上次下載這個版本已判定不完整，清單時間沒變、本輪不重抓`);
  if (plan.updated.length) log(`${TICKS.id}：${plan.updated.join('、')} 清單時間變新（同名檔重新上架），重抓比對`);
  if (plan.unlisted.length) log(`${TICKS.id}：⚠ 交易日 ${plan.unlisted.join('、')} 不在清單上`);
  if (plan.lost.length) log(`${TICKS.id}：⚠ ${plan.lost.join('、')} 已滾出 30 日窗（永久缺）`);
  for (const d of plan.fetch.slice(0, maxFiles)) {
    const r = await fetchDay({ root, man, q, fetchImpl, now, day: d, listTime: times[d] || null });
    if (r.skipped) { bump('skipped'); log(`${TICKS.id}：佇列停止（${r.note}），其餘本輪不抓`); break; }
    bump(r.action === 'reject' ? r.status : r.action); C.saveManifest(root, man);
    log(`  ${TICKS.id} ${d}：${r.action}${r.action === 'reject' || r.action === 'fail' || r.action === 'keep' ? `（${r.note || man.rows[d]?.lastTry?.note || ''}）` : ''}`);
  }
  if (plan.fetch.length > maxFiles) { stats.overCap = plan.fetch.length - maxFiles; log(`${TICKS.id}：還有 ${stats.overCap} 檔超過單輪上限 ${maxFiles}，下一輪再抓`); }
  C.saveManifest(root, man);
  return { requests: q.count - before, stats, pending, plan, list: { first: L.list.first, last: L.list.last, n: L.list.days.length } };
}

/**
 * verify：清單 1 個＋最新一個已收盤日檔 1 個（本機已有 ⇒ 重新下載比對 sha256）。通過＝清單 ok 且日檔回聲 ok。
 * 回傳 _verify.json 的一列。
 */
export async function verifyTicks({ root, lastClosed, q, fetchImpl, now = () => new Date() }) {
  const man = C.loadManifest(root, TICKS.host, TICKS.id); const at = now().toISOString();
  const L = await fetchList({ root, man, q, fetchImpl, now });
  if (!L.ok) { C.saveManifest(root, man); return { ok: false, status: L.skipped ? 'skipped' : 'list-fail', note: L.note, at }; }
  const times = L.list.times || {};
  const target = L.list.days.filter(d => lastClosed && d <= lastClosed && !(times[d] && times[d] < `${d}T${TICKS.dayClose}`)).at(-1);
  if (!target) { C.saveManifest(root, man); return { ok: false, status: 'no-target', note: `清單（${L.list.first}～${L.list.last}）沒有 ≤ ${lastClosed} 的日檔`, at }; }
  const hadSha = C.hasGood(man, target) ? man.rows[target].sha256 : null;
  const r = await fetchDay({ root, man, q, fetchImpl, now, day: target, listTime: times[target] || null });
  C.saveManifest(root, man);
  const row = man.rows[target] || {};
  return { ok: r.status === 'ok' && r.action !== 'fail', status: r.status, action: r.action ?? null, note: r.note ?? null, key: target, rows: row.rows ?? null, echo: row.echo ?? null,
    sameAsLocal: hadSha ? hadSha === row.sha256 && r.action === 'same' : null, listTime: times[target] || null,
    list: { n: L.list.days.length, first: L.list.first, last: L.list.last, timed: Object.keys(times).length }, at };
}

// ── 轉存（一次性回補 second-brain/sara-lab/taifex/ticks-30d → 鏡像，0 請求）────────────────
/**
 * 讀來源 _manifest.json 的 files（檔名→{bytes, sha256}）：位元組與 sha256 都相符、回聲驗證 ok 才轉存；missing（已滾出的日）記 status=lost。
 * 已有好資料的日子不重做（每次 backfill 開頭都會跑，第二次起只讀 JSON）。回傳轉存檔數。
 */
export function migrateTicks({ root, src, log = () => {} }) {
  const mp = join(src, '_manifest.json');
  if (!existsSync(mp)) return 0;
  let sm; try { sm = JSON.parse(readFileSync(mp, 'utf8')); } catch (e) { log(`${TICKS.id} 轉存：來源清單讀不到（${e.message.slice(0, 60)}）`); return 0; }
  const man = C.loadManifest(root, TICKS.host, TICKS.id); let n = 0; let dirty = false;
  for (const [name, f] of Object.entries(sm.files || {})) {
    const m = name.match(/^Daily_(\d{4})_(\d{2})_(\d{2})\.zip$/); if (!m || !f || typeof f !== 'object') continue;
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    if (C.hasGood(man, day)) continue;
    const p = join(src, name); if (!existsSync(p)) { log(`  ${TICKS.id} 轉存 ${day}：來源檔不見了`); continue; }
    const buf = readFileSync(p);
    if (buf.length !== f.bytes || C.sha256(buf) !== f.sha256) { log(`  ${TICKS.id} 轉存 ${day}：位元組／sha256 與來源清單不符，不轉存`); continue; }
    const v = validateTicksZip(buf, day);
    if (v.status !== 'ok') { log(`  ${TICKS.id} 轉存 ${day}：回聲 ${v.status}（${v.note}），不轉存`); continue; }
    const fetchedAt = statSync(p).mtime.toISOString();
    storeTicksDay(root, man, day, buf, v, { at: fetchedAt, url: ticksFileUrl(day) });
    man.rows[day] = { ...man.rows[day], migrated: true, migratedFrom: `second-brain/sara-lab/taifex/ticks-30d/${basename(p)}`, atNote: '一次性回補沒有逐檔抓取時間，取檔案 mtime' };
    n++; dirty = true;
  }
  for (const [day, note] of Object.entries(sm.missing || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || C.hasGood(man, day) || man.rows?.[day]?.status === 'lost') continue;
    man.rows[day] = { status: 'lost', note: String(note).slice(0, 200), at: new Date().toISOString(), migratedFrom: 'second-brain/sara-lab/taifex/ticks-30d/_manifest.json' };
    dirty = true;
  }
  if (dirty) C.saveManifest(root, man);
  return n;
}
