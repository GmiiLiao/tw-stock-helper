#!/usr/bin/env node
// 每日熱力排程入口（LaunchAgent 以 node 直接執行；與 ai-daemon 完全分開、不重啟、不修改 daemon）
//   poll  ：22:30 起每 10 分鐘看一次資料到齊否（最多到 01:30）；定版成功＋發佈後結束
//   retry ：06:50 補班（接官方鏡像 06:45 補抓）；只跑一次
// 流程：建檔（閘門全過才寫）→ 發佈 Firestore（dailyHeatmap/latest）。資料缺：先呼叫官方鏡像 retry 補漏（每次執行最多一次、
//   鏡像自己有靜默窗／鎖／封鎖即停），再重試；到下一交易日 08:30 仍缺 ⇒ daily-heatmap.mjs 自己寫 _alerts（不推播）。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
} else {
  // 22:30 起輪詢到 01:30（跨午夜以分鐘數判斷「現在」，不靠迴圈起點的日期）
  for (;;) {
    if (attempt()) { console.log(`${ts()} ✓ 完成`); break; }
    const m = taipeiMinutes();
    if (m >= 90 && m < 22 * 60) { console.log(`${ts()} 已過 01:30，交給 06:50 補班`); break; }
    await sleep(10 * 60 * 1000);
  }
}
