#!/usr/bin/env node
// T1 分軌前向影子發佈：本機 out/tracks_fwd/ → Firestore surgeShadow/tracks-*（超級管理員後台「T1 連板起漲（分軌）」子分頁）。
// 只寫 surgeShadow 集合的 tracks-index 與 tracks-fwd-{日}（客戶端規則預設拒絕，僅 /api/admin/surge-shadow 以超級管理員讀）；不碰站上任何資料。
//
// 讀（零網路）：out/tracks_fwd/tracks_fwd_{日}.json（core 凍結）、tracks_fwd_score_{日}_{y,c5,c10}.json、tracks_fwd_parity_{日}.json、
//              tracks_fwd_gap_{日}.json、tracks_fwd_summary.json、tracks_fwd_status.json
// 防呆：①封印——同一份文字交給 python3（與 a37_tracks_fwd_io.seal_of 同參數）重算，任一不符整批中止；
//       ②演練檔（rehearsal:true）一律不發佈；③後台文件不得含任何報酬欄位（surge-tracks-report.assertNoReturns）；
//       ④已發佈的前向日文件封印不同或這次不見了 ⇒ 中止（前向成績不可事後改寫），除非 --allow-replace；⑤任一文件 ≥ 900,000 位元組 ⇒ 不寫。
//       ⑥kind 用 't1-tracks-forward'／'t1-tracks-index'（不可用 'frozen-forward'：a35 發佈以那個值查詢）。
// 寫入順序：日文件 → 最後才寫 tracks-index（中途失敗不會指向還沒寫的日文件）。
// 只重寫內容有變的日文件（本機 .published.json 記每份文件 reportJson 的 sha256；--full 全部重寫）；索引每次都寫。
// 用法：node scripts/surge-lab/a37_tracks_publish.mjs [--dir <out/tracks_fwd 目錄>] [--dry-run] [--allow-replace] [--full]
// 憑證：GOOGLE_APPLICATION_CREDENTIALS；沒有就從 daemon 的 launchd plist 讀路徑（不印出內容）。影子模式·未扣成本·非投資建議。
import { readFileSync, readdirSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import {
  buildTracksDayDoc, buildTracksIndexDoc, tracksDaySummary, gapSummary, assertTracksDocSizes, forwardReplaceProblems, dayDocId,
  TRACKS_INDEX_ID, TRACKS_KIND_DAY,
} from '../lib/surge-tracks-report.mjs';
import { TRACKS_CORE_RE, TRACKS_GAP_RE } from '../lib/surge-tracks-daily.mjs';

const COLLECTION = 'surgeShadow';
const BATCH = 200;
const PLIST = join(homedir(), 'Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist');
const PY = '/Library/Frameworks/Python.framework/Versions/3.14/bin/python3';

function parseArgs(argv) {
  const a = { dir: join(dirname(fileURLToPath(import.meta.url)), 'out', 'tracks_fwd'), dryRun: false, allowReplace: false, full: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--allow-replace') a.allowReplace = true;
    else if (argv[i] === '--full') a.full = true;
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
  return { days, gapRows, sealed, skipped, summary: readObj(join(dir, 'tracks_fwd_summary.json'))?.obj ?? null, status: readObj(join(dir, 'tracks_fwd_status.json'))?.obj ?? null };
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

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const c = collect(a.dir);
  for (const m of c.skipped) console.log(`  · ${m}`);
  const bad = badSeals(c.sealed);
  if (bad.length) throw new Error(`封印不符，整批中止：\n${bad.join('\n')}`);
  if (c.summary?.rehearsal) throw new Error('摘要是演練版（rehearsal:true），不發佈');
  const dayDocs = c.days.map(d => buildTracksDayDoc(d));
  const rows = [...dayDocs.map(tracksDaySummary), ...c.gapRows.map(gapSummary)];
  const index = buildTracksIndexDoc({ days: rows, summary: c.summary, status: c.status, generatedAt: new Date().toISOString() });
  const dayWrites = dayDocs.map(d => [dayDocId(d.day), { schema: d.schema, kind: TRACKS_KIND_DAY, day: d.day, seal: d.seal, reportJson: JSON.stringify(d) }]);
  const writes = [...dayWrites, [TRACKS_INDEX_ID, { schema: index.schema, kind: index.kind, reportJson: JSON.stringify(index) }]];
  const sizes = assertTracksDocSizes(writes);
  console.log(`凍結 ${dayDocs.length} 日、缺口 ${c.gapRows.length} 日｜共 ${writes.length} 份文件、最大 ${Math.max(...sizes.map(([, n]) => n))} 位元組`);
  if (a.dryRun) { console.log('--dry-run：不寫 Firestore'); return; }
  const { db, FieldValue } = await initDb();
  if (!a.allowReplace) {
    const published = (await db.collection(COLLECTION).where('kind', '==', TRACKS_KIND_DAY).select('seal').get()).docs.map(d => ({ id: d.id, seal: d.get('seal') }));
    const p = forwardReplaceProblems(published, dayWrites.map(([id, w]) => ({ id, seal: w.seal })));
    if (p.clash.length) throw new Error(`已發佈的前向日文件封印不同，拒絕覆蓋：${p.clash.join(', ')}（確定要取代請加 --allow-replace）`);
    if (p.missing.length) throw new Error(`已發佈的前向日文件不在這次的本機紀錄裡：${p.missing.join(', ')}（前向紀錄不可刪減）`);
  }
  const pubPath = join(a.dir, '.published.json');
  const prev = a.full ? {} : (readObj(pubPath)?.obj || {});
  const sha = w => createHash('sha256').update(w.reportJson).digest('hex');
  const todo = writes.filter(([id, w]) => id === TRACKS_INDEX_ID || prev[id] !== sha(w));   // 索引最後、每次都寫
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = db.batch();
    for (const [id, w] of todo.slice(i, i + BATCH)) batch.set(db.collection(COLLECTION).doc(id), { ...w, updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }
  const next = Object.fromEntries(writes.map(([id, w]) => [id, sha(w)]));
  const tmp = `${pubPath}.tmp${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 1));
  renameSync(tmp, pubPath);
  console.log(`✓ 已寫入 ${COLLECTION}/（${todo.length} 份；內容沒變而略過 ${writes.length - todo.length} 份）`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => process.exit(0), e => { console.error('✖', e.message); process.exit(1); });
}
