#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 「現在可以重啟 daemon 嗎？」——重啟前的硬性檢查
//
// 起因（2026-08-28 使用者下的禁令）：**已設定的觀察點絕對不可以因為重啟而失效。**
// daemon 有多個**記憶體常駐、事後無法補算**的累積窗，重啟＝那一窗直接蒸發，
// 而且當天不會再有第二次機會（尾盤五檔已經被這樣毀掉三次）。
//
// 用法：
//   node scripts/can-restart-daemon.mjs          # 人看的報告；安全 exit 0、不安全 exit 1
//   node scripts/can-restart-daemon.mjs --quiet   # 只回 exit code，給 shell 串接用
//   node scripts/can-restart-daemon.mjs --ack-outage   # 已知上游故障、確認接受快取蒸發的代價時才用
//
// 建議串接（不安全就不會執行重啟）：
//   node scripts/can-restart-daemon.mjs --quiet && launchctl kickstart -k gui/$UID/com.gmii.twstock.ai-daemon
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { recentOutageLines } from './lib/outage-scan.mjs';
import { restartVerdict, earliestRestart, hhmm } from './lib/restart-windows.mjs';

const QUIET = process.argv.includes('--quiet');
const say = (...a) => { if (!QUIET) console.log(...a); };

const taipei = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 保護窗與判定在 scripts/lib/restart-windows.mjs（2026-10-07 抽出＋單元測試；同日依 O7 新增開盤感應器窗 08:30–10:05）。
// 每一條都要寫清楚「重啟會失去什麼」——沒有代價說明的保護窗會被下一個人拿掉。

const tw = taipei();
const mins = tw.getHours() * 60 + tw.getMinutes();
const today = isoOf(tw);

// 交易日判定：優先讀 Firestore 的休市日曆，讀不到就只擋週末（fail-open）
let holidays = new Set();
let calOk = false;
try {
  process.env.GOOGLE_APPLICATION_CREDENTIALS =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
  admin.initializeApp();
  const d = (await admin.firestore().collection('system').doc('tradingCalendar').get()).data();
  if (Array.isArray(d?.holidays)) { holidays = new Set(d.holidays); calOk = true; }
} catch { /* fail-open：只擋週末 */ }

const dow = tw.getDay();
const isTradingDay = dow !== 0 && dow !== 6 && !holidays.has(today);

say(`\n現在：${today}（週${'日一二三四五六'[dow]}）${hhmm(mins)} 台北`);
say(`交易日：${isTradingDay ? '是' : '否'}${calOk ? '' : '（⚠ 讀不到休市日曆，只擋週末）'}`);

// 上游故障中（不分交易日）：daemon 正靠記憶體的 stale-if-error 快取撐著時，重啟會讓快取蒸發
//   （2026-10-03 實案：櫃買 DNS 故障中重啟 ⇒ 全站上櫃消失。之後已加本地備份後備，但其他記憶體快取同理）
{
  const LOG = join(homedir(), 'Library', 'Logs', 'twstock-ai-daemon', 'ai-daemon.out.log');
  let tail = '';
  try {
    const size = statSync(LOG).size; const n = Math.min(size, 400000); const buf = Buffer.alloc(n);
    const fd = openSync(LOG, 'r'); readSync(fd, buf, 0, n, size - n); closeSync(fd); tail = buf.toString('utf8');
  } catch { /* 讀不到日誌就不擋 */ }
  const hits = recentOutageLines(tail, Date.now());
  if (hits.length && !process.argv.includes('--ack-outage')) {
    say('\n🚫 **不建議重啟** —— 近 15 分鐘上游故障中，daemon 正靠快取／後備撐著：');
    for (const l of hits.slice(-4)) say(`   · ${l.slice(0, 140)}`);
    say('   重啟會失去：記憶體裡的 stale-if-error 快取（站上可能整個市場消失）。先修上游；確定要重啟加 --ack-outage。\n');
    process.exit(1);
  }
}

if (!isTradingDay) {
  say('\n✅ 非交易日，沒有任何累積窗在跑 —— 可以重啟。\n');
  process.exit(0);
}

const verdict = restartVerdict({ mins, isTradingDay });
const earliest = earliestRestart({ mins, isTradingDay });   // 窗與窗首尾相接時，報真正可重啟的時刻（不只本窗結束）
const earliestTxt = earliest == null ? '今日交易時段內沒有（明日再試）' : hhmm(earliest);

if (verdict.reason === 'active') {
  say('\n🚫 **不可重啟** —— 正在以下觀察窗內：');
  for (const w of verdict.active) {
    say(`   · ${w.name}（${hhmm(w.from)}–${hhmm(w.to)}）`);
    say(`     重啟會失去：${w.cost}`);
  }
  say(`\n   最早可重啟：${earliestTxt}`);
  say('   ⚠ 開發期間不必急著重啟：CLI 的 --run <job> 讀的是磁碟上的最新程式碼，可以先驗證。\n');
  process.exit(1);
}

// 距離下一個窗太近也要擋——重啟到穩定需要一兩分鐘
if (verdict.reason === 'near') {
  const near = verdict.near;
  say(`\n🚫 **不可重啟** —— ${near.name} 再 ${near.from - mins} 分鐘就開始（${hhmm(near.from)}）。`);
  say(`   重啟會失去：${near.cost}`);
  say(`   請等到 ${earliestTxt} 之後。\n`);
  process.exit(1);
}

say('\n✅ 目前不在任何觀察窗內 —— 可以重啟。');
if (verdict.upcoming.length) {
  const n = verdict.upcoming[0];
  say(`   下一個窗：${n.name} ${hhmm(n.from)}–${hhmm(n.to)}（還有 ${n.from - mins} 分鐘）`);
}
say('');
process.exit(0);
