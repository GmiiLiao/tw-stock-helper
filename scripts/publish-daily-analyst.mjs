#!/usr/bin/env node
// 把本機定版的每日 AI 分析師團隊報告（second-brain/daily-analyst/latest.json 指向的那份）發佈到 Firestore：
//   dailyAnalyst/latest ＋ dailyAnalyst/{D}            公開（分析文字；不含個股名單明細）
//   dailyAnalystFocus/latest ＋ dailyAnalystFocus/{D}  管理員專用（資料觀察名單＋對應 refTable；只由管理員 API 讀）
//   同一份定版（canonicalAt 相同）不重寫；不讓舊資料日蓋掉新 latest；同日 morning 定版不被 evening 蓋；900KB 守門；
//   公開／管理員文件寫入前走鍵名掃描（不得含 score/signal/buy/sell/rank/target/stop/entry/exit/action/rating/recommend 字樣的鍵）。
//   模板殼（engineTier=template／meta.fallback）一律不發佈——頁面退回模板版。
//   node scripts/publish-daily-analyst.mjs [--dry-run] [--force] [--root <second-brain>] [--day YYYY-MM-DD --edition evening|morning]
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { archiveDir, readLatest, readManifest, rowKey } from './lib/analyst-desk/archive.mjs';
import { prepareDocs, decidePublish } from './lib/analyst-desk/publish-split.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const COL_PUBLIC = 'dailyAnalyst';
const COL_FOCUS = 'dailyAnalystFocus';

/**
 * 發佈一份定版。db＝Firestore 介面（collection().doc().get()、batch().set().commit()），測試注入假 db。
 * 回傳 { status, reason?, dataDate?, edition?, bytes? }：published｜dry-run｜skip-same｜skip-older｜skip-edition｜refused｜no-final
 */
export async function publishDaily({ root, db, force = false, dry = false, day = null, edition = null, now = Date.now(), log = () => {} }) {
  const dir = archiveDir(root);
  const latest = readLatest(root);
  const d = day || latest?.dataDate, ed = edition || latest?.edition;
  if (!d || !ed) return { status: 'no-final', reason: '無 latest.json：尚無定版，不發佈' };
  const row = readManifest(root).rows?.[rowKey(d, ed)];
  if (!row || row.status !== 'final') return { status: 'no-final', reason: `${rowKey(d, ed)} manifest 非 final，不發佈` };
  const file = join(dir, row.file);
  if (!existsSync(file)) return { status: 'no-final', reason: `定版檔不存在：${row.file}` };
  const issue = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  if (issue.meta?.fallback === 'template' || issue.meta?.engineTier === 'template') return { status: 'refused', reason: '模板殼不發佈（頁面退回模板版）' };
  if (!issue.meta?.check?.pass) return { status: 'refused', reason: '機械查核未過，不發佈' };

  const prep = prepareDocs(issue, { canonicalAt: row.canonicalAt, updatedAt: now });
  if (!prep.ok) return { status: 'refused', reason: prep.problems.join('；') };
  const { pub, focus, bytes } = prep;
  log(`${d}/${ed}：公開 ${(bytes.pub / 1024).toFixed(0)}KB、管理員名單 ${(bytes.focus / 1024).toFixed(0)}KB`);
  if (dry) return { status: 'dry-run', dataDate: d, edition: ed, bytes };

  const curSnap = await db.collection(COL_PUBLIC).doc('latest').get();
  const cur = curSnap.exists ? curSnap.data() : null;
  const decision = decidePublish({ cur, doc: pub, force });
  if (decision !== 'write') return { status: decision, dataDate: d, edition: ed };

  // 同一批原子寫入：名單與公開文件不會只寫到一半（latest 是指標，一起換）
  const batch = db.batch();
  batch.set(db.collection(COL_FOCUS).doc(d), focus);
  batch.set(db.collection(COL_FOCUS).doc('latest'), focus);
  batch.set(db.collection(COL_PUBLIC).doc(d), pub);
  batch.set(db.collection(COL_PUBLIC).doc('latest'), pub);
  await batch.commit();
  return { status: 'published', dataDate: d, edition: ed, bytes };
}

async function cli() {
  const argv = process.argv.slice(2);
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const root = opt('--root') || join(HERE, '..', 'second-brain');
  const dry = argv.includes('--dry-run');
  let db = null;
  if (!dry) {
    const { default: admin } = await import('firebase-admin');
    process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS
      || '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
    admin.initializeApp();
    db = admin.firestore();
  }
  const r = await publishDaily({ root, db, dry, force: argv.includes('--force'), day: opt('--day'), edition: opt('--edition'), log: m => console.log(m) });
  const msg = { published: `✓ 已發佈 dailyAnalyst／dailyAnalystFocus（latest＋${r.dataDate}，${r.edition}）`, 'dry-run': `dry-run：${r.dataDate}/${r.edition}（未寫入）`, 'skip-same': `skip：${r.dataDate}/${r.edition}（canonicalAt 相同）已發佈`, 'skip-older': 'latest 已是較新的資料日，不覆蓋', 'skip-edition': '同資料日 latest 已是 morning 定版，evening 不覆蓋' }[r.status];
  if (msg) { console.log(msg); process.exit(0); }
  console.error(`✗ ${r.status}：${r.reason || ''}`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli().catch(e => { console.error('發佈失敗：', e.message); process.exit(1); });
