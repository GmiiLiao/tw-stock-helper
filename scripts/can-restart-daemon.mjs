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
//
// 建議串接（不安全就不會執行重啟）：
//   node scripts/can-restart-daemon.mjs --quiet && launchctl kickstart -k gui/$UID/com.gmii.twstock.ai-daemon
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';

const QUIET = process.argv.includes('--quiet');
const say = (...a) => { if (!QUIET) console.log(...a); };

const taipei = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// 保護窗（台北時間，分鐘）。只在**交易日**生效。
// 每一條都要寫清楚「重啟會失去什麼」——沒有代價說明的保護窗會被下一個人拿掉。
const WINDOWS = [
  // 盤前判別窗（2026-08-31 補）：07:00 晨間新聞判別、08:00 軋空與漲停判別。
  // 這段重啟會讓已完成的判別**整個重跑**——守衛旗標存在記憶體裡，重啟即歸零。
  // 實測今天 08:20 重啟，軋空判別在 08:11 已完成卻於 08:31 又跑一次，
  // 白白吃掉 11 分鐘；而盤前判別本來就要跑到 08:46 才就緒（距開盤 14 分鐘）。
  // 再吃掉一次就會壓到開盤，使用者盤前拿不到當沖資格與判別。
  { from: 7 * 60, to: 9 * 60, name: '盤前判別窗（晨間新聞＋軋空/漲停判別）',
    lose: '已完成的判別整個重跑；實測單趟需 46 分鐘，重跑會壓到 09:00 開盤' },
  { from: 7 * 60 + 20, to: 7 * 60 + 50, name: '當沖資格盤前抓取',
    cost: '站上整個交易日掛昨天的當沖名單（合規風險：使用者可能對不可當沖的股票下當沖單）' },
  { from: 8 * 60, to: 9 * 60 + 5, name: '開盤前新聞判別',
    cost: '該窗外不再執行，當日沒有任何事前判別' },
  { from: 8 * 60 + 30, to: 9 * 60 + 10, name: '即時價還原敏感窗',
    cost: '_lastLive 清空，冷門股可能數十分鐘沒有即時價（CLAUDE.md 記載已發生兩次）' },
  { from: 9 * 60, to: 9 * 60 + 20, name: '搶漲停排隊警示',
    cost: '該日唯一的偵測窗，錯過就沒有第二次' },
  { from: 13 * 60 + 20, to: 13 * 60 + 40, name: '尾盤五檔累積窗',
    cost: '_depthWin 整窗蒸發，只能寫殘缺版（CLAUDE.md 記載已發生三次）' },
  { from: 15 * 60 + 5, to: 15 * 60 + 25, name: '每日收盤歸檔',
    cost: '當日 chipArchive 可能只寫一半，下游榜單整批位移' },
  { from: 16 * 60 + 25, to: 16 * 60 + 55, name: '官方補抓＋上櫃併入',
    cost: '上櫃資料整天缺席（CLAUDE.md 記載的痛點）' },
  { from: 21 * 60 + 40, to: 22 * 60 + 35, name: '資券歸檔＋訓練資料＋檢討報表',
    cost: '次交易日候選、軋空訓練樣本、檢討報表三者全部缺當日' },
];

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

if (!isTradingDay) {
  say('\n✅ 非交易日，沒有任何累積窗在跑 —— 可以重啟。\n');
  process.exit(0);
}

const active = WINDOWS.filter(w => mins >= w.from && mins < w.to);
const upcoming = WINDOWS.filter(w => w.from > mins).sort((a, b) => a.from - b.from);

if (active.length) {
  say('\n🚫 **不可重啟** —— 正在以下觀察窗內：');
  for (const w of active) {
    say(`   · ${w.name}（${hhmm(w.from)}–${hhmm(w.to)}）`);
    say(`     重啟會失去：${w.cost}`);
  }
  const end = Math.max(...active.map(w => w.to));
  say(`\n   最早可重啟：${hhmm(end)}（本窗結束）`);
  say('   ⚠ 開發期間不必急著重啟：CLI 的 --run <job> 讀的是磁碟上的最新程式碼，可以先驗證。\n');
  process.exit(1);
}

// 距離下一個窗太近也要擋——重啟到穩定需要一兩分鐘
const GAP = 3;
const near = upcoming.find(w => w.from - mins <= GAP);
if (near) {
  say(`\n🚫 **不可重啟** —— ${near.name} 再 ${near.from - mins} 分鐘就開始（${hhmm(near.from)}）。`);
  say(`   重啟會失去：${near.cost}`);
  say(`   請等到 ${hhmm(near.to)} 之後。\n`);
  process.exit(1);
}

say('\n✅ 目前不在任何觀察窗內 —— 可以重啟。');
if (upcoming.length) {
  const n = upcoming[0];
  say(`   下一個窗：${n.name} ${hhmm(n.from)}–${hhmm(n.to)}（還有 ${n.from - mins} 分鐘）`);
}
say('');
process.exit(0);
