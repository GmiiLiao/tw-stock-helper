#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 上櫃收盤檔「本機下載後交給系統使用」（2026-10-08；使用者：「如果現有下載不行就使用本機下載再上傳使用」）
//   櫃買 openapi 大檔常在傳輸中途被切斷，但瀏覽器多半下載得完。把下載的檔交給這支（或丟進收件匣）就會：
//   驗證（整份 JSON、單一資料日、4 碼 ≥800、00 開頭 ≥60、無重複、收盤可解析、與前一份相比缺 ≤3%；總列數只當 5,000 底線）→ 存進共用快取 second-brain/tpex-close/。
//   daemon、手動腳本、官方鏡像收養都從共用快取讀；不打任何網路。
//
// 用法：
//   node scripts/tpex-close-import.mjs <檔案...>     驗證並匯入（原檔不動；.json／.json.gz；openapi 陣列或 dailyQuotes 物件都收）
//   node scripts/tpex-close-import.mjs --inbox        處理收件匣 second-brain/tpex-close/_inbox/（daemon 也會在需要時自動處理；
//                                                     下載中的 .crdownload／.part 與 0 位元組檔一律略過，列為「等待中」）
//   node scripts/tpex-close-import.mjs --status       快取與網路狀態摘要
//   加 --publish：同時把該資料日寫進 Firestore tpexClose/{latest,日期}（網站讀這份；與 daemon 同一個寫入格式，sha 相同就略過）
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { createTpexClose, manualHelp } from './lib/tpex-close-quotes.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const files = argv.filter(a => !a.startsWith('--'));
// onAlert：拒收當場印在終端機（使用者已看到 ⇒ 清單記為已告警，daemon 不再補發）
const svc = createTpexClose({ network: 'never', log: m => console.log(m.trim()), onAlert: text => console.log(text) });

async function publish(res) {
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||= '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
  initializeApp({ credential: applicationDefault() });
  const db = getFirestore();
  const cur = (await db.collection('tpexClose').doc('latest').get()).data();
  const doc = svc.firestoreDocOf(res);
  if (cur?.sha256 && cur.sha256 === doc.sha256) { console.log(`Firestore tpexClose/latest 已是同一份（sha ${doc.sha256.slice(0, 8)}），略過`); return; }
  await db.collection('tpexClose').doc(res.dataDate).set(doc);
  if (!cur?.dataDate || cur.dataDate <= res.dataDate) await db.collection('tpexClose').doc('latest').set(doc);
  else console.log(`⚠ Firestore latest 已是較新的 ${cur.dataDate}，只寫 tpexClose/${res.dataDate}`);
  console.log(`✓ Firestore tpexClose/${res.dataDate}${!cur?.dataDate || cur.dataDate <= res.dataDate ? '＋latest' : ''}：${doc.rows} 列（4 碼 ${doc.stocks4}）`);
}

async function main() {
  if (flags.has('--status')) { console.log(JSON.stringify(svc.status(), null, 1)); return 0; }
  const results = [];
  if (flags.has('--inbox')) {
    const r = await svc.ingestInbox({ settleMs: 0 });   // 手動執行＝使用者確定下載完了，不等 60 秒；暫存副檔名與 0 位元組檔仍略過
    console.log(`收件匣：採用 ${r.accepted.length}、拒收 ${r.rejected.length}${r.waiting.length ? `、等待中 ${r.waiting.length}（下載未完成？${r.waiting.join('、')}）` : ''}`);
    for (const x of r.accepted) results.push(await svc.getTpexClose(x.dataDate));
    if (r.rejected.length) process.exitCode = 1;
  }
  for (const f of files) {
    let res;
    try { res = await svc.importBuffer(readFileSync(f), { source: 'import' }); } catch (e) { res = { status: 'invalid', reason: e.message }; }
    if (res.status === 'ok') {
      console.log(`✓ ${f}：資料日 ${res.dataDate}、${res.stats.rows} 列／4 碼 ${res.stats.stocks4}／00 開頭 ${res.stats.etf00}；sha256 ${String(res.sha256).slice(0, 12)}…${res.stored ? '（已存入快取）' : '（快取已有同一份）'}`);
      results.push(res);
    } else {
      console.log(`✖ ${f}：${res.reason || res.status}${res.dataDate ? `（檔案自報資料日 ${res.dataDate}）` : ''}`);
      process.exitCode = 1;
    }
  }
  if (!files.length && !flags.has('--inbox')) { console.log(`用法見檔頭。手動下載說明：\n${manualHelp()}`); return 2; }
  if (flags.has('--publish')) for (const r of results.filter(x => x?.status === 'ok')) await publish(r);
  return process.exitCode || 0;
}

main().then(code => process.exit(code), e => { console.error('✖', e.stack || e.message); process.exit(1); });
