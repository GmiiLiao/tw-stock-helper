// ── FinMind 落地：second-brain/finmind/<dataset>/[<YYYY>/]<group>.jsonl.gz ─────────────────
// 一個群組（一天／一段區間／一份快照）＝一個 .jsonl.gz；群組內每次請求＝一個 gzip 成員（多成員 gzip，gunzip 可整檔解開）。
// 進行中寫 <group>.part.jsonl.gz＋<group>.part.idx.tsv（每行：成員\t列數\t起\t迄 位元組）；全部成員到齊才原子改名成正式檔。
//   續抓：索引與資料檔互相驗證——截掉未登錄的尾巴、丟掉超出檔尾或解不開的成員（下次重抓），不會留下半份資料。
//   fsync 批次做（syncGroup）：不逐請求刷碟，節制磁碟 I/O（同一台機器也跑 daemon）。
// 不展開原始 JSON、不存未壓縮檔（分點原始約 130GB、逐筆超過 200GB）。
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createGunzip, createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const GROUP_RE = /^[A-Za-z0-9_.-]+$/;
const MEMBER_RE = /^[A-Za-z0-9_.*-]+$/;
const GZIP_LEVEL = 6;

export function datasetDir(root, dataset, variant = null) {
  return variant ? join(root, dataset, variant) : join(root, dataset);
}

export function groupPaths(root, dataset, group, variant = null) {
  if (!GROUP_RE.test(group) || group.includes('..')) throw new Error(`群組名稱不合法：${group}`);
  const base = datasetDir(root, dataset, variant);
  const dir = DATE_RE.test(group) ? join(base, group.slice(0, 4)) : base;
  return { dir, group, final: join(dir, `${group}.jsonl.gz`), finalIdx: join(dir, `${group}.idx.tsv`), part: join(dir, `${group}.part.jsonl.gz`), partIdx: join(dir, `${group}.part.idx.tsv`) };
}

// ── JSON 小檔 ──
export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

export function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, `${JSON.stringify(obj, null, 1)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

function writeTextAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text); renameSync(tmp, path);
}

// ── 索引 ──
const parseIdx = text => String(text || '').split('\n').filter(Boolean).map(l => {
  const [member, rows, start, end] = l.split('\t');
  return { member, rows: Number(rows), start: Number(start), end: Number(end) };
});
const fmtIdx = e => `${e.member}\t${e.rows}\t${e.start}\t${e.end}\n`;

/** 收尾途中斷電：資料已改名、索引還沒 ⇒ 補完改名。 */
function normalize(p) {
  if (existsSync(p.final) && !existsSync(p.part) && !existsSync(p.finalIdx) && existsSync(p.partIdx)) renameSync(p.partIdx, p.finalIdx);
}

function readSlice(path, start, end) {
  const fd = openSync(path, 'r');
  try { const buf = Buffer.alloc(end - start); readSync(fd, buf, 0, buf.length, start); return buf; } finally { closeSync(fd); }
}

/** 規劃用：讀索引得知哪些成員已完成（不改任何檔）。 */
export function readDone(p) {
  normalize(p);
  const final = existsSync(p.final) && !existsSync(p.part);
  const entries = parseIdx(existsSync(final ? p.finalIdx : p.partIdx) ? readFileSync(final ? p.finalIdx : p.partIdx, 'utf8') : '');
  const rows = entries.reduce((n, e) => n + (Number.isFinite(e.rows) ? e.rows : 0), 0);
  // fetchedOn：正式檔修改時間的台北日期（判定「暫定群組」用，jobs.isProvisional）
  const fetchedOn = final ? new Date(statSync(p.final).mtimeMs + 8 * 3600e3).toISOString().slice(0, 10) : null;
  return { done: new Set(entries.map(e => e.member)), rowsBy: new Map(entries.map(e => [e.member, e.rows])), final, fetchedOn, rows, members: entries.length, status: final ? (rows ? 'complete' : 'empty') : entries.length ? 'partial' : null };
}

/** 驗證進行中檔案：回傳有效索引，並把資料檔截到最後一個有效成員。 */
function recover(p) {
  const size = existsSync(p.part) ? statSync(p.part).size : 0;
  const all = parseIdx(existsSync(p.partIdx) ? readFileSync(p.partIdx, 'utf8') : '');
  const valid = [];
  let end = 0;
  for (const e of all) {
    if (!MEMBER_RE.test(e.member || '') || !Number.isInteger(e.start) || !Number.isInteger(e.end) || e.start !== end || e.end < e.start || e.end > size) break;
    valid.push(e); end = e.end;
  }
  while (valid.length) {
    const last = valid[valid.length - 1];
    if (last.end === last.start) break;
    try { gunzipSync(readSlice(p.part, last.start, last.end)); break; } catch { valid.pop(); end = valid.length ? valid[valid.length - 1].end : 0; }
  }
  if (existsSync(p.part) && size !== end) truncateSync(p.part, end);
  if (valid.length !== all.length) writeTextAtomic(p.partIdx, valid.map(fmtIdx).join(''));
  return { valid, end };
}

/** 開啟群組以追加（已收尾的會重開）。 */
export function openGroup(p) {
  mkdirSync(p.dir, { recursive: true });
  normalize(p);
  if (existsSync(p.final) && !existsSync(p.part)) {
    renameSync(p.final, p.part);
    if (existsSync(p.finalIdx)) renameSync(p.finalIdx, p.partIdx);
  }
  const { valid, end } = recover(p);
  const g = { paths: p, done: new Map(valid.map(e => [e.member, e.rows])), bytes: end, rows: valid.reduce((n, e) => n + e.rows, 0), unsynced: 0 };
  g.fd = openSync(p.part, 'a');
  g.fdIdx = openSync(p.partIdx, 'a');
  return g;
}

/** 追加一個成員（gz 為該次請求的 gzip 位元組；0 列可傳 null）。 */
export function appendMember(g, member, gz, rows) {
  if (!MEMBER_RE.test(String(member))) throw new Error(`成員代號不合法：${JSON.stringify(member)}`);
  const start = g.bytes;
  if (gz?.length) { writeSync(g.fd, gz); g.bytes += gz.length; }
  writeSync(g.fdIdx, fmtIdx({ member, rows, start, end: g.bytes }));
  g.done.set(member, rows); g.rows += rows; g.unsynced += 1;
}

export function syncGroup(g) {
  if (!g.unsynced) return;
  fsyncSync(g.fd); fsyncSync(g.fdIdx); g.unsynced = 0;
}

/** 關閉但保留進行中檔（下次續抓）。 */
export function closeGroup(g) {
  if (g.fd == null) return;
  fsyncSync(g.fd); fsyncSync(g.fdIdx);
  closeSync(g.fd); closeSync(g.fdIdx); g.fd = null; g.fdIdx = null; g.unsynced = 0;
}

/** 收尾：刷碟、改名成正式檔。全空群組寫一個空 gzip 成員，讓檔案仍是合法 gzip。 */
export function finalizeGroup(g) {
  if (g.bytes === 0) { writeSync(g.fd, gzipSync('')); }
  closeGroup(g);
  renameSync(g.paths.part, g.paths.final);
  // 兩次改名之間若有另一個程序（--status／dry-run 的 readDone→normalize）先補完了索引改名，這裡的 ENOENT 不是錯
  try { renameSync(g.paths.partIdx, g.paths.finalIdx); } catch (e) { if (!(e.code === 'ENOENT' && existsSync(g.paths.finalIdx))) throw e; }
}

/** 刪掉一個群組的所有檔（--retry-empty 重抓空群組用；只動本目錄自己的資料）。 */
export function removeGroup(p) {
  for (const f of [p.final, p.finalIdx, p.part, p.partIdx]) if (existsSync(f)) unlinkSync(f);
}

/** 取代前先把舊版搬到同目錄的 _superseded/（不刪）：<group>.superseded-<stamp>.<原副檔名>。暫定群組重抓、--retry-empty 用。 */
export function supersedeGroup(p, stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)) {
  const files = [[p.final, '.jsonl.gz'], [p.finalIdx, '.idx.tsv'], [p.part, '.part.jsonl.gz'], [p.partIdx, '.part.idx.tsv']].filter(([f]) => existsSync(f));
  if (!files.length) return [];
  const dir = join(p.dir, '_superseded'); mkdirSync(dir, { recursive: true });
  return files.map(([f, ext]) => { const to = join(dir, `${p.group}.superseded-${stamp}${ext}`); renameSync(f, to); return to; });
}

// ── 讀取（validate 用）──
const parseLines = buf => buf.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

export function readGroupRows(p) {
  normalize(p);
  const f = existsSync(p.final) ? p.final : existsSync(p.part) ? p.part : null;
  return f ? parseLines(gunzipSync(readFileSync(f))) : [];
}

export function readMemberRows(p, member) {
  normalize(p);
  const [f, idx] = existsSync(p.final) ? [p.final, p.finalIdx] : [p.part, p.partIdx];
  if (!existsSync(f) || !existsSync(idx)) return [];
  const e = parseIdx(readFileSync(idx, 'utf8')).find(x => x.member === member);
  if (!e || e.end === e.start) return [];
  return parseLines(gunzipSync(readSlice(f, e.start, e.end)));
}

/** 逐批寫入 gzip 串流（遵守背壓），end() 回傳壓縮後 Buffer。 */
export function gzipLines() {
  const z = createGzip({ level: GZIP_LEVEL });
  const chunks = [];
  z.on('data', c => chunks.push(c));
  const done = once(z, 'end');
  return {
    async write(lines) {
      for (const l of lines) if (!z.write(`${l}\n`)) await once(z, 'drain');
    },
    async end() { z.end(); await done; return Buffer.concat(chunks); },
    abort() { z.destroy(); },
  };
}

// ── 單程序鎖 ──
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function acquireLock(root, { pid = process.pid } = {}) {
  mkdirSync(root, { recursive: true });
  const path = join(root, '_lock.json');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      return { path, pid };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const cur = readJson(path, null);
      if (cur?.pid && cur.pid !== pid && alive(cur.pid)) throw new Error(`另一個 FinMind 下載程序正在執行（pid ${cur.pid}，${cur.startedAt || '?'} 起）——單程序規則，請等它結束或以 SIGTERM 停止`);
      unlinkSync(path);   // 死掉的程序留下的鎖
    }
  }
  throw new Error('取得鎖失敗');
}

export function releaseLock(lock) {
  if (!lock) return;
  const cur = readJson(lock.path, null);
  if (cur?.pid === lock.pid) { try { unlinkSync(lock.path); } catch { /* 已不存在 */ } }
}

/** 逐列讀取（串流解壓，不把整個群組載入記憶體；分點一天約百萬列）。 */
export async function forEachRow(p, fn) {
  normalize(p);
  const f = existsSync(p.final) ? p.final : existsSync(p.part) ? p.part : null;
  if (!f) return 0;
  const rl = createInterface({ input: createReadStream(f).pipe(createGunzip()), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) { if (line) { fn(JSON.parse(line)); n += 1; } }
  return n;
}
