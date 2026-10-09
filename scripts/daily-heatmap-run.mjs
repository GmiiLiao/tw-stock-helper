#!/usr/bin/env node
// 每日熱力排程入口（LaunchAgent 以 node 直接執行；與 ai-daemon 完全分開、不重啟、不修改 daemon）
//   poll  ：22:45 起先等「官方鏡像當晚 daily 跑完」（_runs/daily-<今天>-* 或 blocked-daily-<今天>-*），再每 10 分鐘看一次
//           資料到齊否（最多到 01:30）；定版成功＋發佈後結束。2026-10-09（WM-SCAN G4-37）：舊版 22:30 在鏡像 22:40 之前跑，
//           讀到前一交易日就當「已完成」，當日熱力要等隔天 06:50，且 10-06 整天缺檔。
//   retry ：06:50 補班（接官方鏡像 06:45 補抓）；只跑一次
// 流程：建檔（閘門全過才寫）→ 發佈 Firestore（dailyHeatmap/latest）。資料缺：先呼叫官方鏡像 retry 補漏（每次執行最多一次、
//   鏡像自己有靜默窗／鎖／封鎖即停），再重試；到下一交易日 08:30 仍缺 ⇒ daily-heatmap.mjs 自己寫 _alerts（不推播）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'second-brain', 'daily-heatmap');
const mode = process.argv[2] || 'poll';
const ts = () => new Date().toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei' });
const run = (script, args = []) => spawnSync(process.execPath, [join('scripts', script), ...args], { cwd: ROOT, stdio: 'inherit' }).status;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const taipeiMinutes = () => { const d = new Date(Date.now() + 8 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

/** 最後交易日是否已定版且已發佈（latest.json.dataDate 與鏡像最後交易日一致，且 publish 回 skip/成功）。 */
function built() {
  const f = join(OUT, 'latest.json');
  if (!existsSync(f)) return false;
  const lastTrading = (() => {
    const man = JSON.parse(readFileSync(join(ROOT, 'second-brain/official/www.twse.com.tw/twse_mi_index/_manifest.json'), 'utf8')).rows;
    return Object.keys(man).filter(d => man[d].status === 'ok').sort().pop();
  })();
  return JSON.parse(readFileSync(f, 'utf8')).dataDate === lastTrading;
}

const BACKFILL_DAYS = 5;
const POLL_DEADLINE_MIN = 90;          // 01:30（跨午夜）
const MIRROR_WAIT_MS = 5 * 60 * 1000;
const RETRY_WAIT_MS = 10 * 60 * 1000;
const taipeiDate = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const pastDeadline = () => { const m = taipeiMinutes(); return m >= POLL_DEADLINE_MIN && m < 22 * 60; };

/** 官方鏡像當晚 daily 是否已跑完（成功或被開跑閘門擋下都算「跑完」——擋下時資料缺由 attempt() 的 retry 補漏處理）。 */
function mirrorDailyDone(day) {
  const dir = join(ROOT, 'second-brain/official/_runs');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(f => (f.startsWith(`daily-${day}-`) && !f.includes('-only-')) || f.startsWith(`blocked-daily-${day}-`));
}

/** 補建近 N 個交易日缺的熱力檔（rebuilt:true、不動 latest）並發佈各自的 dailyHeatmap/{日}。
 *  發佈失敗的日子記在 _unpublished.json，下一次執行（poll 或 retry）會再發，不會因「檔已存在」而永遠漏發。 */
function backfillMissing() {
  const UNPUB = join(OUT, '_unpublished.json');
  const dayFiles = () => readdirSync(OUT).filter(f => /^\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f));
  const before = new Set(dayFiles());
  run('daily-heatmap.mjs', ['--backfill', String(BACKFILL_DAYS)]);
  let pending = [];
  try { pending = JSON.parse(readFileSync(UNPUB, 'utf8')); } catch { pending = []; }
  const added = dayFiles().filter(f => !before.has(f)).map(f => f.slice(0, 10));
  const todo = [...new Set([...pending, ...added])].sort();
  const still = [];
  for (const d of todo) {
    const p = run('publish-daily-heatmap.mjs', ['--date', d]);
    console.log(`${ts()} ${p === 0 ? '✓' : '⚠'} 回補 ${d}${p === 0 ? '' : `（發佈 exit ${p}，下次再試）`}`);
    if (p !== 0) still.push(d);
  }
  if (still.length || pending.length) writeFileSync(UNPUB, JSON.stringify(still));
}

let mirrorRetried = false;
function attempt() {
  let code = run('daily-heatmap.mjs');          // 已定版 ⇒ skip-exists、exit 0
  if (code !== 0 && !mirrorRetried) {
    mirrorRetried = true;
    console.log(`${ts()} ▶ 資料缺：請官方鏡像補漏（retry --days 5）`);
    run('official-mirror.mjs', ['retry', '--days', '5']);
    code = run('daily-heatmap.mjs');
  }
  if (code === 0 && built()) {
    const p = run('publish-daily-heatmap.mjs');
    if (p !== 0) console.log(`${ts()} ⚠ 發佈失敗（exit ${p}），下輪重試`);
    return p === 0;
  }
  return false;
}

console.log(`${ts()} ▶ daily-heatmap-run ${mode}`);
if (mode === 'retry') {
  console.log(`${ts()} ${attempt() ? '✓ 完成' : '✗ 仍未完成（已寫 _pending／_alerts）'}`);
  backfillMissing();
} else {
  // 先等鏡像當晚 daily 跑完（起跑日以排程觸發當下的台北日期為準；跨午夜以分鐘數判斷死線）
  const day = taipeiDate();
  while (!mirrorDailyDone(day)) {
    if (pastDeadline()) { console.log(`${ts()} 等不到 ${day} 官方鏡像 daily 完成（已過 01:30），仍試一次後交給 06:50 補班`); break; }
    await sleep(MIRROR_WAIT_MS);
  }
  console.log(`${ts()} 官方鏡像 ${day} daily ${mirrorDailyDone(day) ? '已跑完' : '未跑完'}，開始建檔`);
  for (;;) {
    if (attempt()) { console.log(`${ts()} ✓ 完成`); break; }
    if (pastDeadline()) { console.log(`${ts()} 已過 01:30，交給 06:50 補班`); break; }
    await sleep(RETRY_WAIT_MS);
  }
  backfillMissing();
}
