#!/usr/bin/env node
// 每日 AI 分析師團隊排程入口（LaunchAgent 以 node 直接執行；與 ai-daemon 完全分開、不搶鎖、不重啟、不修改 daemon）
//   evening：23:20 起每 10 分鐘看一次資料到齊否，硬死線 00:30；產出「盤後版」（昨日／今日／明日卡＋總結初版）
//   morning：06:10 起每 10 分鐘，硬死線 07:30；產出「晨間定版」（補全球夜盤與夜間媒體判別；同資料日 morning 優先於 evening）
//   引擎 claude-cli（使用者已登入帳號）不碰 Ollama，所以 07:00 起 daemon 晨間新聞趟佔用 Ollama 不影響主引擎；
//   只有 ollama 降級層要先 ollamaFree()（produceIssue 內建）。最終 engineUsed==='template' 時不寫「AI 版定版檔」、不發佈，
//   改寫 _pending＋_alerts，頁面退回模板版。
//   node scripts/analyst-desk-run.mjs [evening|morning] [--once] [--force] [--root <second-brain>] [--date YYYY-MM-DD]
//   --once  只試一次不輪詢（手動跑）；--date  指定資料日（仍須為鏡像交易日）；--force  已定版也重產（舊檔 .r{n}／開盤後 .amend-{n}）
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pollLoop, taipeiParts } from './lib/analyst-desk/run-flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ts = () => new Date().toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 預設相依：pack／desk 動態載入（任一載入失敗＝組包失敗 → 寫 _pending，不當機）；Firestore 只 get（組包讀 newsVerdict／mopsNews／globalMarkets 等站內來源）；
 * 發佈走獨立子程序（firebase 初始化與寫入隔離）。組包的硬閘門（日曆、熱力可用、資料日不在鏡像…）由 buildPack 丟錯表達。
 */
export function defaultDeps(root) {
  let fsGetP = null;
  const getFs = () => (fsGetP ??= (async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS
      || '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
    const admin = (await import('firebase-admin')).default;
    if (!admin.apps.length) admin.initializeApp();
    const db = admin.firestore();
    return async (collection, docId) => { const snap = await db.collection(collection).doc(docId).get(); return snap.exists ? snap.data() : null; };
  })());
  return {
    async loadPack({ date, edition, nowMs }) {
      const { buildPack } = await import('./lib/analyst-desk/pack.mjs');
      return buildPack({ date, edition, root, fsGet: await getFs(), now: nowMs });
    },
    async produce(opts) { return (await import('./lib/analyst-desk/desk.mjs')).produceIssue(opts); },
    async publish({ root: r, day, edition }) {
      const code = spawnSync(process.execPath, [join('scripts', 'publish-daily-analyst.mjs'), '--root', r, '--day', day, '--edition', edition], { cwd: ROOT, stdio: 'inherit' }).status;
      return code === 0;
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const edition = argv.find(a => a === 'evening' || a === 'morning') || (taipeiParts(Date.now()).min >= 18 * 60 ? 'evening' : 'morning');
  const root = opt('--root') || join(ROOT, 'second-brain');
  const log = m => console.log(`${ts()} ${m}`);
  log(`▶ analyst-desk-run ${edition}`);
  const r = await pollLoop({ edition, root, deps: defaultDeps(root), sleep, once: argv.includes('--once'), force: argv.includes('--force'), day: opt('--date') || undefined, log });
  log(`${['final', 'already-final'].includes(r.status) ? '✓ 完成' : '✗ 結束'}：${r.status}${r.reasons?.length ? '｜' + r.reasons.join('；') : ''}`);
  process.exit(['final', 'already-final', 'non-trading'].includes(r.status) ? 0 : 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error('analyst-desk-run 失敗：', e); process.exit(1); });
