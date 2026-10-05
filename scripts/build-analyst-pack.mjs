#!/usr/bin/env node
// 分析師團隊·資料包 CLI（W1）：組出某資料日的 pack（refs 表＋候選池＋排除＋adverse），純讀、不寫 Firestore。
//   node scripts/build-analyst-pack.mjs [--date YYYY-MM-DD] [--edition evening|morning] [--out <檔(.json|.json.gz)>]
//                                       [--no-firestore] [--risk-policy strict|lenient] [--now <ISO 時刻>] [--root <second-brain>]
//   · --date 省略＝second-brain/daily-heatmap/latest.json 的 dataDate
//   · --no-firestore：只用本機檔（Firestore 來源全進 absent）
//   · --risk-policy：strict（預設，處置＋當日注意名單都可驗證才入池）｜lenient（只要處置名單可得；注意名單缺會在 degraded／adverse 揭露）
//   · --now：重播用，模擬版次當下時刻（預設現在）；cutoff＝min(now, 版次名義時刻)
//   Firestore 接線（只 get）：GOOGLE_APPLICATION_CREDENTIALS 預設為專案服務帳號（參考 publish-daily-heatmap.mjs）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPack } from './lib/analyst-desk/pack.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const has = name => argv.includes(name);

const date = arg('--date');
const edition = arg('--edition', 'evening');
const out = arg('--out');
const root = arg('--root', join(HERE, '..', 'second-brain'));
const riskPolicy = arg('--risk-policy', 'strict');
const nowArg = arg('--now');
const now = nowArg ? Date.parse(nowArg) : Date.now();
if (!Number.isFinite(now)) { console.error(`--now 無法解析：${nowArg}`); process.exit(2); }
if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('--date 格式需為 YYYY-MM-DD'); process.exit(2); }

let fsGet = null;
if (!has('--no-firestore')) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
  const admin = (await import('firebase-admin')).default;
  admin.initializeApp();
  const db = admin.firestore();
  fsGet = async (collection, docId) => {
    const snap = await db.collection(collection).doc(docId).get(); // 只 get，不 set
    return snap.exists ? snap.data() : null;
  };
}

let pack;
try {
  pack = await buildPack({ date, edition, root, fsGet, now, riskPolicy });
} catch (e) {
  console.error(`✗ 組包失敗：${e.message}`);
  process.exit(1);
}

if (out) {
  mkdirSync(dirname(out), { recursive: true });
  const json = JSON.stringify(pack);
  writeFileSync(out, out.endsWith('.gz') ? gzipSync(Buffer.from(json)) : json);
}
const sizes = Object.fromEntries(['prev', 'data', 'next'].map(k => [k, `${pack.pools[k].length} 入池／${pack.excluded[k].length} 排除`]));
console.log(`✓ pack ${pack.dataDate} ${pack.edition}｜refs ${pack.meta.refCount}｜${pack.meta.bytes} bytes｜cutoff ${pack.meta.cutoff}｜risk=${pack.meta.riskPolicy}`);
console.log(`  dates ${JSON.stringify(pack.dates)}｜池 ${JSON.stringify(sizes)}`);
console.log(`  absent ${pack.absent.length}：${pack.absent.join('；') || '無'}`);
console.log(`  degraded ${pack.degraded.length}：${pack.degraded.join('；') || '無'}`);
if (out) console.log(`  → ${out}`);
// firebase-admin 會讓行程不退出
process.exit(0);
