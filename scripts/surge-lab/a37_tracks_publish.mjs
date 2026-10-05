#!/usr/bin/env node
// T1 分軌前向影子發佈：本機 out/tracks_fwd/ → Firestore surgeShadow/tracks-*（超級管理員後台「T1 連板起漲（分軌）」子分頁）。
// 只寫 surgeShadow 集合的 tracks-index、tracks-fwd-{日}、tracks-raw-*（客戶端規則預設拒絕，僅 /api/admin/surge-shadow 以超級管理員讀；
// API 不讀 tracks-raw-*）；不碰站上任何資料。
//
// 讀（零網路）：out/tracks_fwd/tracks_fwd_{日}.json（core 凍結）、tracks_fwd_score_{日}_{y,c5,c10}.json、tracks_fwd_parity_{日}.json、
//              tracks_fwd_gap_{日}.json、prewire/*.json、tracks_fwd_summary.json、tracks_fwd_status.json、_alerts/LATEST.json
// 防呆：①封印——同一份文字交給 python3（與 a37_tracks_fwd_io.seal_of 同參數）重算，任一不符整批中止；
//       ②演練檔（rehearsal:true）一律不發佈；③後台文件不得含任何報酬欄位（surge-tracks-report.assertNoReturns）；
//       ④已發佈的前向日文件／逐位副本內容不同或這次不見了 ⇒ 中止（前向成績不可事後改寫），除非 --allow-replace；⑤任一文件 ≥ 900,000 位元組 ⇒ 不寫。
//       ⑥kind 用 't1-tracks-forward'／'t1-tracks-index'／'t1-tracks-raw'（不可用 'frozen-forward'：a35 發佈以那個值查詢）。
// 逐位副本（登錄 freeze.seal、G60 P2「Firestore 副本與本機逐位相同」）：每份封印記錄的原檔位元組 gzip 後存成 tracks-raw-*（Bytes；
//   > 800 KB 分片），寫入後讀回、解壓、比 sha256，相符才記進本機 .published_raw_verify.json；索引帶 rawArchive（全部相符才 ok）。
//   本機目錄遺失時：--restore 從 tracks-raw-* 讀回、驗 sha256 後只補本機「不存在」的檔（不覆寫）。
// 寫入順序：日文件與逐位副本 → 讀回驗證 → 最後才寫 tracks-index（中途失敗不會指向還沒寫的日文件）。
// 只重寫內容有變的文件（本機 .published.json 記每份文件的 sha256；--full 全部重寫）；索引每次都寫。
// 用法：node scripts/surge-lab/a37_tracks_publish.mjs [--dir <out/tracks_fwd 目錄>] [--dry-run] [--allow-replace] [--full] [--restore]
// 憑證：GOOGLE_APPLICATION_CREDENTIALS；沒有就從 daemon 的 launchd plist 讀路徑（不印出內容）。影子模式·未扣成本·非投資建議。
import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync, mkdirSync, linkSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  buildTracksDayDoc, buildTracksIndexDoc, tracksDaySummary, gapSummary, assertTracksDocSizes, forwardReplaceProblems, dayDocId,
  rawDocId, rawDocWrites, rawAssemble, rawReplaceProblems, rawVerifyStatus, TRACKS_INDEX_ID, TRACKS_KIND_DAY, TRACKS_KIND_RAW, TRACKS_KIND_RAW_SHARD,
} from '../lib/surge-tracks-report.mjs';
import { TRACKS_CORE_RE, TRACKS_GAP_RE } from '../lib/surge-tracks-daily.mjs';

const COLLECTION = 'surgeShadow';
const BATCH = 200;
const PLIST = join(homedir(), 'Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist');
const PY = '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3';

function parseArgs(argv) {
  const a = { dir: join(dirname(fileURLToPath(import.meta.url)), 'out', 'tracks_fwd'), dryRun: false, allowReplace: false, full: false, restore: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--allow-replace') a.allowReplace = true;
    else if (argv[i] === '--full') a.full = true;
    else if (argv[i] === '--restore') a.restore = true;
    else if (argv[i] === '--dir') a.dir = argv[++i];
    else throw new Error(`未知參數：${argv[i]}`);
  }
  return a;
}

const readText = p => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const readObj = p => { const t = readText(p); return t === null ? null : { path: p, text: t, obj: JSON.parse(t) }; };

/** 一次 python3 重算所有封印（stdin 傳同一份文字）；回傳不符的檔案路徑。 */
function badSeals(items) {
  if (!items.length) return [];
  const py = 'import json,hashlib,sys\nfor i,t in enumerate(json.load(sys.stdin)):\n    o=json.loads(t); s=o.pop("seal",None)\n'
    + '    h=hashlib.sha256(json.dumps(o,sort_keys=True,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode("utf-8")).hexdigest()\n'
    + '    print(("ok " if h==s else "bad ")+str(i))';
  const out = execFileSync(existsSync(PY) ? PY : 'python3', ['-c', py], { input: JSON.stringify(items.map(x => x.text)), encoding: 'utf8', maxBuffer: 64 << 20 });
  return out.split('\n').filter(l => l.startsWith('bad ')).map(l => items[Number(l.slice(4))].path);
}

export function collect(dir) {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const cores = files.filter(f => TRACKS_CORE_RE.test(f)).sort().map(f => readObj(join(dir, f)));
  const gaps = files.filter(f => TRACKS_GAP_RE.test(f)).sort().map(f => readObj(join(dir, f)));
  const skipped = [];
  const days = [];
  const sealed = [];
  for (const c of cores) {
    if (c.obj.rehearsal) { skipped.push(`${c.obj.date_s}：演練凍結檔（不發佈）`); continue; }
    const d = c.obj.date_s;
    const sc = Object.fromEntries(['y', 'c5', 'c10'].map(st => [st, readObj(join(dir, `tracks_fwd_score_${d}_${st}.json`))]));
    const par = readObj(join(dir, `tracks_fwd_parity_${d}.json`));
    sealed.push(c, ...Object.values(sc).filter(Boolean), ...(par ? [par] : []));
    days.push({ day: d, core: c.obj, y: sc.y?.obj ?? null, c5: sc.c5?.obj ?? null, c10: sc.c10?.obj ?? null, parity: par?.obj ?? null });
  }
  const gapRows = [];
  for (const g of gaps) {
    if (g.obj.rehearsal) { skipped.push(`${g.obj.date_s}：演練缺口記錄（不發佈）`); continue; }
    sealed.push(g);
    gapRows.push(g.obj);
  }
  const pw = join(dir, 'prewire');
  const proofs = (existsSync(pw) ? readdirSync(pw) : []).filter(f => rawDocId(`prewire/${f}`)).sort().map(f => readObj(join(pw, f)));
  sealed.push(...proofs);
  const raw = sealed.map(x => {
    const rel = x.path.slice(dir.replace(/\/+$/, '').length + 1);
    const bytes = readFileSync(x.path);
    return { id: rawDocId(rel), file: rel, seal: x.obj.seal ?? null, sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
  }).filter(r => r.id);
  return { days, gapRows, sealed, raw, skipped, summary: readObj(join(dir, 'tracks_fwd_summary.json'))?.obj ?? null,
    status: readObj(join(dir, 'tracks_fwd_status.json'))?.obj ?? null, alerts: readObj(join(dir, '_alerts', 'LATEST.json'))?.obj ?? null };
}

/** 本機紀錄 → 逐位副本的寫入清單（gzip level 9、固定 mtime；gzip 位元組只用來存，比對一律用解壓後原檔的 sha256）。 */
export function rawWrites(raw) {
  return raw.flatMap(r => rawDocWrites({ id: r.id, file: r.file, seal: r.seal, sha256: r.sha256, bytes: r.bytes.length, gz: gzipSync(r.bytes, { level: 9 }) }));
}

/** 讀回的主文件與分片 → 每個 id 的原檔 sha256（解壓後重算）。get(id) → data|null。 */
export async function readBackShas(get, ids) {
  const out = {};
  for (const id of ids) {
    const head = await get(id);
    if (!head) { out[id] = null; continue; }
    const shards = [];
    for (let i = 1; i < (head.nShards || 1); i++) shards.push(await get(`${id}~${i}`));
    try { out[id] = createHash('sha256').update(gunzipSync(rawAssemble(head, shards))).digest('hex'); } catch (e) { out[id] = `error: ${e.message}`; }
  }
  return out;
}

async function initDb() {
  let cred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!cred && existsSync(PLIST)) cred = execFileSync('plutil', ['-extract', 'EnvironmentVariables.GOOGLE_APPLICATION_CREDENTIALS', 'raw', PLIST], { encoding: 'utf8' }).trim();
  if (!cred || !existsSync(cred)) throw new Error('缺 Firestore 憑證（GOOGLE_APPLICATION_CREDENTIALS 或 daemon plist）');
  const { initializeApp, cert } = await import('firebase-admin/app');
  initializeApp({ credential: cert(JSON.parse(readFileSync(cred, 'utf8'))) });
  const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
  return { db: getFirestore(), FieldValue };
}

function writeAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1));
  renameSync(tmp, path);
}

/** --restore：從 tracks-raw-* 讀回、驗 sha256 後只補本機不存在的檔（link 原子「不存在才建立」；不覆寫）。 */
export async function restoreFromRaw(dir, docs, get) {
  const res = { restored: [], same: [], conflict: [], bad: [] };
  for (const d of docs) {
    const shards = [];
    for (let i = 1; i < (d.data.nShards || 1); i++) shards.push(await get(`${d.id}~${i}`));
    let bytes;
    try { bytes = gunzipSync(rawAssemble(d.data, shards)); } catch (e) { res.bad.push(`${d.id}：${e.message}`); continue; }
    if (createHash('sha256').update(bytes).digest('hex') !== d.data.sha256) { res.bad.push(`${d.id}：sha256 不符`); continue; }
    if (typeof d.data.file !== 'string' || d.data.file.includes('..') || rawDocId(d.data.file) !== d.id) { res.bad.push(`${d.id}：檔名不合規 ${d.data.file}`); continue; }
    const path = join(dir, d.data.file);
    if (existsSync(path)) { (createHash('sha256').update(readFileSync(path)).digest('hex') === d.data.sha256 ? res.same : res.conflict).push(d.data.file); continue; }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp${process.pid}`;
    writeFileSync(tmp, bytes);
    try { linkSync(tmp, path); res.restored.push(d.data.file); } catch { res.conflict.push(d.data.file); } finally { unlinkSync(tmp); }
  }
  return res;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.restore) {
    const { db } = await initDb();
    const snap = await db.collection(COLLECTION).where('kind', '==', TRACKS_KIND_RAW).get();
    const docs = snap.docs.map(d => ({ id: d.id, data: d.data() }));
    const get = async id => { const x = await db.collection(COLLECTION).doc(id).get(); return x.exists ? x.data() : null; };
    const r = await restoreFromRaw(a.dir, docs, get);
    console.log(`還原：補回 ${r.restored.length}、本機已同 ${r.same.length}、本機不同（不覆寫）${r.conflict.length}、副本壞 ${r.bad.length}`);
    for (const x of [...r.conflict.map(f => `不同：${f}`), ...r.bad]) console.log(`  ✖ ${x}`);
    if (r.conflict.length || r.bad.length) process.exitCode = 1;
    return;
  }
  const c = collect(a.dir);
  for (const m of c.skipped) console.log(`  · ${m}`);
  const bad = badSeals(c.sealed);
  if (bad.length) throw new Error(`封印不符，整批中止：\n${bad.join('\n')}`);
  if (c.summary?.rehearsal) throw new Error('摘要是演練版（rehearsal:true），不發佈');
  const dayDocs = c.days.map(d => buildTracksDayDoc(d));
  const rows = [...dayDocs.map(tracksDaySummary), ...c.gapRows.map(gapSummary)];
  const dayWrites = dayDocs.map(d => [dayDocId(d.day), { schema: d.schema, kind: TRACKS_KIND_DAY, day: d.day, seal: d.seal, reportJson: JSON.stringify(d) }]);
  const raws = rawWrites(c.raw);
  const rawSizes = raws.map(([id, w]) => [id, w.gz.length + 2_000]);
  const tooBig = rawSizes.filter(([, n]) => n > 900_000);
  if (tooBig.length) throw new Error(`逐位副本分片過大：${tooBig.map(([id, n]) => `${id} ${n}B`).join(', ')}`);
  const verifyPath = join(a.dir, '.published_raw_verify.json');
  const verified = readObj(verifyPath)?.obj?.verified || {};
  const localRaw = c.raw.map(r => ({ id: r.id, sha256: r.sha256 }));
  const indexOf = rawStatus => buildTracksIndexDoc({ days: rows, summary: c.summary, status: c.status, alerts: c.alerts, rawArchive: rawStatus, generatedAt: new Date().toISOString() });
  const preIndex = indexOf(rawVerifyStatus(localRaw, verified, null));
  const sizes = assertTracksDocSizes([...dayWrites, [TRACKS_INDEX_ID, { reportJson: JSON.stringify(preIndex) }]]);
  console.log(`凍結 ${dayDocs.length} 日、缺口 ${c.gapRows.length} 日｜日文件 ${dayWrites.length} 份（最大 ${Math.max(0, ...sizes.map(([, n]) => n))} 位元組）｜逐位副本 ${c.raw.length} 份 ${raws.length} 片`);
  if (a.dryRun) {
    const back = await readBackShas(async id => raws.find(([x]) => x === id)?.[1] ?? null, c.raw.map(r => r.id));   // 本機往返：gzip→分片→組回→解壓
    const bad2 = c.raw.filter(r => back[r.id] !== r.sha256).map(r => r.id);
    console.log(`--dry-run：不寫 Firestore｜逐位副本本機往返 ${bad2.length ? `不符 ${bad2.join(', ')}` : '全部逐位相同'}`);
    if (bad2.length) process.exitCode = 1;
    return;
  }
  const { db, FieldValue } = await initDb();
  if (!a.allowReplace) {
    const published = (await db.collection(COLLECTION).where('kind', '==', TRACKS_KIND_DAY).select('seal').get()).docs.map(d => ({ id: d.id, seal: d.get('seal') }));
    const p = forwardReplaceProblems(published, dayWrites.map(([id, w]) => ({ id, seal: w.seal })));
    if (p.clash.length) throw new Error(`已發佈的前向日文件封印不同，拒絕覆蓋：${p.clash.join(', ')}（確定要取代請加 --allow-replace）`);
    if (p.missing.length) throw new Error(`已發佈的前向日文件不在這次的本機紀錄裡：${p.missing.join(', ')}（前向紀錄不可刪減；本機遺失請先 --restore）`);
    const pubRaw = (await db.collection(COLLECTION).where('kind', '==', TRACKS_KIND_RAW).select('sha256').get()).docs.map(d => ({ id: d.id, sha256: d.get('sha256') }));
    const q = rawReplaceProblems(pubRaw, localRaw);
    if (q.clash.length) throw new Error(`已發佈的逐位副本內容不同，拒絕覆蓋：${q.clash.join(', ')}`);
    if (q.missing.length) throw new Error(`已發佈的逐位副本不在本機：${q.missing.join(', ')}（本機遺失請先 --restore）`);
  }
  const pubPath = join(a.dir, '.published.json');
  const prev = a.full ? {} : (readObj(pubPath)?.obj || {});
  const sha = w => createHash('sha256').update(w.reportJson ?? Buffer.from(w.gz)).digest('hex');
  const changed = new Set([...dayWrites, ...raws].filter(([id, w]) => prev[id] !== sha(w) || (w.kind === TRACKS_KIND_RAW && !verified[id])).map(([id]) => id));
  for (const [id, w] of raws) if (w.kind === TRACKS_KIND_RAW_SHARD && changed.has(w.parent)) changed.add(id);   // 主文件要重寫 ⇒ 分片一起寫
  const todo = [...dayWrites, ...raws].filter(([id]) => changed.has(id));
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = db.batch();
    for (const [id, w] of todo.slice(i, i + BATCH)) batch.set(db.collection(COLLECTION).doc(id), { ...w, updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }
  // 讀回驗證（這次寫的主文件＋還沒驗過的）：解壓後 sha256＝本機原檔才記進驗證帳
  const toVerify = [...new Set([...todo.filter(([, w]) => w.kind === TRACKS_KIND_RAW).map(([id]) => id), ...localRaw.filter(x => verified[x.id]?.sha256 !== x.sha256).map(x => x.id)])];
  const back = await readBackShas(async id => { const x = await db.collection(COLLECTION).doc(id).get(); return x.exists ? x.data() : null; }, toVerify);
  const now = new Date().toISOString();
  const nextVerified = { ...verified };
  const failed = [];
  for (const r of localRaw.filter(x => toVerify.includes(x.id))) {
    if (back[r.id] === r.sha256) nextVerified[r.id] = { sha256: r.sha256, time: now };
    else { failed.push(`${r.id}（讀回 ${back[r.id]}）`); delete nextVerified[r.id]; }
  }
  const rawStatus = rawVerifyStatus(localRaw, nextVerified, now);
  writeAtomic(verifyPath, { schema: 't1-tracks-raw-verify/v1', ...rawStatus, verified: nextVerified, failed });
  const index = indexOf(rawStatus);
  await db.collection(COLLECTION).doc(TRACKS_INDEX_ID).set({ schema: index.schema, kind: index.kind, reportJson: JSON.stringify(index), updatedAt: FieldValue.serverTimestamp() });
  const next = Object.fromEntries([...dayWrites, ...raws].map(([id, w]) => [id, sha(w)]));
  writeAtomic(pubPath, next);
  console.log(`✓ 已寫入 ${COLLECTION}/（${todo.length} 份＋索引；內容沒變而略過 ${dayWrites.length + raws.length - todo.length} 份）｜逐位副本讀回 ${toVerify.length} 份、相符 ${toVerify.length - failed.length}${failed.length ? `｜✖ 不符：${failed.join(', ')}` : ''}`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => process.exit(process.exitCode ?? 0), e => { console.error('✖', e.message); process.exit(1); });
}
