#!/usr/bin/env node
// a35_shadow 發佈：把凍結名單＋對答案結果寫到 Firestore surgeShadow/*，供超級管理員後台查看（2026-10-04 使用者指示）。
// 影子模式不變：不取代、不修改站上漲停預測；只寫 surgeShadow 這個集合（客戶端規則預設拒絕，僅 admin API 讀）。
//
// 讀（研究輸出，預設本檔所在目錄的 out/）：
//   out/shadow_{日}.json                事前凍結名單（只收 kind=frozen-forward，且凍結時刻早於目標日 09:00）
//   out/shadow_score_{日}.json          該名單的對答案（以 frozenSha256 對上才採用）
//   out/shadow_hist/shadow_{日}.json    歷史回推名單（只收 kind=historical-would-have-been）
//   out/shadow_hist_score_pooled.json   歷史回推合併對答案（封印集合須與 shadow_hist/ 完全相同，否則不顯示合併統計）
// 寫：surgeShadow/{fwd|hist}-{日}（reportJson 字串＋少量查詢欄位），最後才寫 surgeShadow/index。
// 防呆：①封印——同一份位元組交給 python3（與 a35_shadow_lib.canon 同參數）重算 sha256，不符整批中止；
//       ②已發佈的事前凍結文件封印不同 ⇒ 中止（前向成績不可被事後重產的名單覆蓋），除非 --allow-replace。
//
// 用法：node scripts/surge-lab/a35_shadow_publish.mjs [--dir <surge-lab 目錄>] [--dry-run] [--allow-replace]
// 憑證：GOOGLE_APPLICATION_CREDENTIALS；沒有就從 daemon 的 launchd plist 讀路徑（不印出內容）。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { stampAfterPublish } from '../lib/writer-version.mjs';
import { buildDayDoc, buildIndexDoc, daySummary, dayDocId, forwardFreezeOk, historyConsistency } from '../lib/surge-shadow-report.mjs';

const COLLECTION = 'surgeShadow';
const MAX_DOC_BYTES = 900_000;          // Firestore 單文件上限 1 MiB（以 UTF-8 位元組計）；逼近就要改壓縮／分片
const BATCH = 400;
const FROZEN_RE = /^shadow_(\d{4}-\d{2}-\d{2})\.json$/;
const PLIST = join(homedir(), 'Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist');

function parseArgs(argv) {
  const a = { dir: dirname(fileURLToPath(import.meta.url)), dryRun: false, allowReplace: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '--allow-replace') a.allowReplace = true;
    else if (argv[i] === '--dir') a.dir = argv[++i];
    else throw new Error(`未知參數：${argv[i]}`);
  }
  if (!a.dir || !existsSync(join(a.dir, 'out'))) throw new Error(`找不到研究輸出目錄：${a.dir}/out`);
  return a;
}

/** 讀一次：同一份文字既用來驗封印、也用來產生發佈內容。 */
const loadFrozen = dir => (existsSync(dir) ? readdirSync(dir).filter(f => FROZEN_RE.test(f)).sort() : [])
  .map(f => { const path = join(dir, f); const text = readFileSync(path, 'utf8'); return { path, text, fz: JSON.parse(text) }; });

/** 一次 python3 重算所有凍結檔的封印（stdin 傳入同一份文字）；回傳不符的檔案路徑。 */
function badSeals(items) {
  if (!items.length) return [];
  const py = 'import json,hashlib,sys\nfor i,t in enumerate(json.load(sys.stdin)):\n    o=json.loads(t); s=o.pop("sha256",None)\n'
    + '    h=hashlib.sha256(json.dumps(o,sort_keys=True,ensure_ascii=False,separators=(",",":"),allow_nan=False).encode("utf-8")).hexdigest()\n'
    + '    print(("ok " if h==s else "bad ")+str(i))';
  const out = execFileSync('python3', ['-c', py], { input: JSON.stringify(items.map(x => x.text)), encoding: 'utf8', maxBuffer: 16 << 20 });
  return out.split('\n').filter(l => l.startsWith('bad ')).map(l => items[Number(l.slice(4))].path);
}

function collectForward(out) {
  const kept = []; const skipped = [];
  for (const it of loadFrozen(out)) {
    const { fz } = it;
    if (fz.kind !== 'frozen-forward') { skipped.push(`${fz.scoringDay}：kind=${fz.kind}（非事前凍結，略過）`); continue; }
    if (!forwardFreezeOk(fz)) { skipped.push(`${fz.scoringDay}：凍結時刻 ${fz.generatedAt} 不早於 ${fz.targetDay} 09:00（不算事前凍結，略過）`); continue; }
    const sp = join(out, `shadow_score_${fz.scoringDay}.json`);
    const sc = existsSync(sp) ? JSON.parse(readFileSync(sp, 'utf8')) : null;
    if (sc && sc.frozenSha256 !== fz.sha256) skipped.push(`${fz.scoringDay}：shadow_score 檔對的是另一份名單（封印不同），視為未對答案`);
    kept.push({ ...it, doc: buildDayDoc(fz, sc && sc.frozenSha256 === fz.sha256 ? sc : null) });
  }
  return { kept, skipped };
}

function collectHistory(out) {
  const pooledPath = join(out, 'shadow_hist_score_pooled.json');
  const pooled = existsSync(pooledPath) ? JSON.parse(readFileSync(pooledPath, 'utf8')) : null;
  const bySha = new Map((pooled?.days || []).map(d => [d.frozenSha256, d]));
  const kept = []; const skipped = [];
  for (const it of loadFrozen(join(out, 'shadow_hist'))) {
    if (it.fz.kind !== 'historical-would-have-been') { skipped.push(`shadow_hist/${it.fz.scoringDay}：kind=${it.fz.kind}（略過）`); continue; }
    const d = bySha.get(it.fz.sha256);
    kept.push({ ...it, doc: buildDayDoc(it.fz, d && d.hits ? d : null) });
  }
  const consistency = historyConsistency(kept.map(x => ({ scoringDay: x.fz.scoringDay, sha256: x.fz.sha256 })), pooled);
  return { kept, skipped, pooled, consistency };
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

/**
 * 前向成績不可被事後改寫：①已發佈的事前凍結文件封印不同 ⇒ 拒絕覆蓋；
 * ②已發佈過的事前凍結日子這次不在本機名單裡（檔案被刪／搬走）⇒ 拒絕，否則該日會從索引與前向合計靜悄悄消失（2026-10-04 安全審查）。
 */
async function assertNoForwardReplace(db, dayWrites) {
  const next = new Map(dayWrites.filter(([id]) => id.startsWith('fwd-')).map(([id, w]) => [id, w.sha256]));
  const published = await db.collection(COLLECTION).where('kind', '==', 'frozen-forward').select('sha256').get();
  const clash = published.docs.filter(d => next.has(d.id) && d.get('sha256') !== next.get(d.id)).map(d => d.id);
  const missing = published.docs.filter(d => !next.has(d.id)).map(d => d.id);
  if (clash.length) throw new Error(`已發佈的事前凍結名單封印不同，拒絕覆蓋：${clash.join(', ')}（確定要取代請加 --allow-replace）`);
  if (missing.length) throw new Error(`已發佈的事前凍結日子不在這次的名單裡：${missing.join(', ')}（前向成績不可刪減；確定要移除請加 --allow-replace）`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const out = join(a.dir, 'out');
  const fwd = collectForward(out);
  const hist = collectHistory(out);
  for (const m of [...fwd.skipped, ...hist.skipped]) console.log(`  · ${m}`);
  const all = [...fwd.kept, ...hist.kept];
  const bad = badSeals(all);
  if (bad.length) throw new Error(`封印不符，整批中止：\n${bad.join('\n')}`);
  const c = hist.consistency;
  if (c.status === 'mismatch') console.log(`  ⚠ 歷史合併統計與目前名單不一致（只在合併檔：${c.onlyInPooled.join(',') || '無'}；只在名單：${c.onlyInLists.join(',') || '無'}）——後台不顯示合併統計，重跑 a35_shadow_score.py 合併後再發佈`);
  const index = buildIndexDoc(all.map(x => daySummary(x.doc)), hist.pooled, new Date().toISOString(), c.status);
  const dayWrites = all.map(({ doc }) => [dayDocId(doc.kind, doc.scoringDay), {
    schema: doc.schema, scoringDay: doc.scoringDay, targetDay: doc.targetDay, kind: doc.kind, scored: !!doc.outcome, sha256: doc.sha256, reportJson: JSON.stringify(doc),
  }]);
  const writes = [...dayWrites, ['index', { schema: index.schema, reportJson: JSON.stringify(index) }]];   // index 最後寫：中途失敗不會指向還沒寫的日文件
  const sizes = writes.map(([id, w]) => [id, Buffer.byteLength(w.reportJson, 'utf8')]);
  const big = sizes.filter(([, n]) => n > MAX_DOC_BYTES);
  if (big.length) throw new Error(`文件過大（需改壓縮／分片）：${big.map(([id, n]) => `${id} ${n}B`).join(', ')}`);
  const f = index.forward;
  console.log(`事前凍結 ${f.days} 日（已對答案 ${f.scored}）｜歷史回推 ${hist.kept.length} 日（合併統計 ${c.status}）｜共 ${writes.length} 份文件、最大 ${Math.max(...sizes.map(([, n]) => n))} 位元組`);
  if (a.dryRun) { console.log('--dry-run：不寫 Firestore'); return; }
  const { db, FieldValue } = await initDb();
  if (!a.allowReplace) await assertNoForwardReplace(db, dayWrites);
  for (let i = 0; i < writes.length; i += BATCH) {
    const batch = db.batch();
    for (const [id, w] of writes.slice(i, i + BATCH)) batch.set(db.collection(COLLECTION).doc(id), { ...w, updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }
  await stampAfterPublish(db, COLLECTION, 'a35_shadow_publish', join(dirname(fileURLToPath(import.meta.url)), '..', '..'), ['scripts/surge-lab/a35_shadow_publish.mjs', 'scripts/lib/surge-shadow-report.mjs']);
  console.log(`✓ 已寫入 ${COLLECTION}/（${writes.length} 份）`);
}

main().then(() => process.exit(0), e => { console.error('✖', e.message); process.exit(1); });
