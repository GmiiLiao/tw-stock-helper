#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 欄位命名契約檢查 —— 防「兩套命名相撞」再犯的閘門
//
// 事故史（這個檔案存在的理由，2026-08-12）：
//   bookDepthArchive 寫入端蓋 `archivedAt`，稽核契約的別名清單只認
//   ['updatedAt','at','generatedAt','fetchedAt','topupAt'] ——
//   資料明明是好的（1,461 檔），健康稽核卻紅了一整天「缺 fetchedAt」。
//   同一類病：saveBank 只寫 bankAt 不寫 updatedAt（daemon 漂移監看盲區）、
//   trades 文件本來根本沒有 updatedAt（記交易後再平衡卡數小時不更新）。
//   共同根因：**取名是自由的，讀取端卻只認特定名字**——每發明一個新名字，
//   就埋一顆「寫入端自以為蓋了章、讀取端看不見」的雷。
//
// 機制：白名單註冊制。
//   ① 全站掃描所有 `xxxAt:` 與資料日欄位鍵名 → 不在白名單＝檢查失敗。
//     想用新名字？來這裡登記——登記時你被迫回答「讀取端（稽核別名清單／
//     監看程式）認得它嗎」，相撞就在這一步被擋下。
//   ② 交叉檢查：稽核 audit-data-sources.mjs 的別名清單必須包含
//     REQUIRED_AUDIT_ALIASES 的每一項——單方面改任一邊都會在這裡爆。
//   ③ --selftest：對合成樣本驗證「新名字必被抓到」，證明閘門活著。
//
// 執行：node scripts/check-field-conventions.mjs [--selftest]
// 掛載：audit-data-sources.mjs 每日 16:10 順跑（見該檔）；CLAUDE.md 驗證節。
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── 白名單（2026-08-12 全站盤點的完整現況；新名字必須在此登記）──────────
// 分類只是給人看的；檢查本身只看「在不在名單」。
export const AT_ALLOWLIST = new Set([
  // 文件級新鮮度戳（canonical：updatedAt；抓取類可另附 fetchedAt）
  'updatedAt', 'fetchedAt', 'generatedAt', 'createdAt', 'archivedAt', 'topupAt',
  // verdictAt：AI 新聞判別**產出的時間**。與被判別新聞的發佈時間分開——
  // 時效衰減必須用它，用新聞時間會讓舊判別搭上新新聞的新鮮度。
  'verdictAt',
  // pxAt：判別時點價（px）所取自的快照時刻（newsVerdict 各筆，2026-09-17 M1-b）。
  //   與 at（判別產出時刻）、verdictAt 分開——它記的是「這個價格是何時的」，對答案用。
  'pxAt',
  // startedAt：daemon 行程的啟動時刻（system/daemonBuild），
  // 與資料的 updatedAt 分開——它記的是「程式何時被載入」而非「資料何時更新」。
  'startedAt',
  // stoppedAtDeadline：因死線提前停止時未處理的檔數（不是時間戳，是計數）
  'stoppedAtDeadline',
  // intradayAt：盤中即時新聞判別的上次執行時刻（與 updatedAt 分開，
  // 因為同一份 doc 會被盤後/晨間/盤中三趟寫入，需要分辨最後是哪一趟）
  'intradayAt',
  // 語意戳（事件時刻，不作為文件新鮮度依據）
  'addedAt', 'answeredAt', 'liveAt', 'bankAt', 'firstAt', 'finishedAt', 'savedAt',
  'linkedAt', 'sweepAt', 'stressAt', 'tradingModeAt', 'privacyAckAt',
  // 一次性修復標記（repair markers）
  'tpexMarginAt', 'marginRepairAt', 'marginBackfillAt', 'otcInstFixedAt', 'otcFixedAt',
  'ohlcFixedAt', 'gapFixedAt', 'closeFixedAt', 'closeClearedAt', 'backfilledAt',
]);
// 語意戳補登記（2026-08-12 首掃）：皆為欄位級/項目級時刻，非文件新鮮度
for (const n of ['quoteAt', 'newestAt', 'auditedAt', 'priceAt', 'swingAt', 'lastAt']) AT_ALLOWLIST.add(n);
// docUpdatedAt：ai-analysis route 的區域變數，暫存 aiMessages/latest 讀出的 updatedAt。
// 非 Firestore 欄位（寫入端仍是 updatedAt），故不需進稽核別名清單。
AT_ALLOWLIST.add('docUpdatedAt');
AT_ALLOWLIST.add('builtAt');
AT_ALLOWLIST.add('hotAt');   // 快線文件寫入時刻（reader 帶出）
AT_ALLOWLIST.add('snapshotAt');   // daemon 最近寫快照/指數的時刻（F13 伺服器停更警告）
AT_ALLOWLIST.add('revealAt');   // MIS 揭示時戳 tlong（資料本身的時間；與 liveAt 抓取時刻分開，R7 口徑）   // /api/system/version：build 時注入的建置時刻（部署身分，非資料日）

// 資料日／日期欄位全名冊。⚠ 這不是「只准用 date」——buyDate、pubDate 這類
// **領域日期**本來就該叫自己的名字。名冊的作用是攔「新名字」：
// 新日期欄位登記時，作者被迫回答一題——「它是不是**文件的資料日**？
// 是的話，稽核契約的 dateField 與 dataDate 判定認得它嗎？」
// （2026-08-12 首掃 25 名全數收錄，實掃歸零＝之後任何新名字都是訊號不是噪音）
export const DATE_ALLOWLIST = new Set([
  // 文件資料日（稽核契約在看的那類）
  'date', 'dataDate', 'tradeDate', 'lastDate', 'dataMonth', 'weekOf', 'ym',
  // 序列端點／衍生日
  'firstDate', 'latestDate', 'prevDate', 'weekDate', 'evalDate', 'predDate',
  'flowDate', 'feedDate', 'adjDate', 'instDate', 'marginDate', 'latestReportDate',
  'archDate',   // 記憶體快取鍵：持股策略 ctx 以最新歸檔日為代（非 Firestore 欄位）
  'anchorDate', // 銀行餘額錨點日（tw-settlement rollBankToToday 回傳值，非 Firestore 欄位）
  // newsDump CLI 匯出檔（scratch JSON，非 Firestore）：把兩個來源榜的資料日
  // 原樣帶給外部判別者——squeeze 的適用日/歸檔日與 limitUp 的資料日**本來就
  // 不同天**，壓成同名反而重演「口徑混同」。前綴標明出處。
  'squeezeTargetDate', 'squeezeArchDate', 'limitUpDataDate',
  'boardDate',   // shortReview：這筆成績對的是哪一天的榜（榜日）——與結果日(date)本來就差一個交易日，壓同名會混口徑
  // squeezePicks/latest 的兩個資料日：軋空榜刻意把「漲幅的日子」與「券資比的
  // 日子」分開標——融資券當日 21:45 才公布，混為一談就會把 t-1 的券資比說成今日。
  'priceDate',   // 漲幅資料日（當日/盤中即時）
  'marginDate',  // 券資比資料日（最近已公布交易日，t-1）
  'priceDate',   // （已登記於上）軋空推薦沿用
  'oosFrom',     // 樣本外起始日（squeezeModel：此日之後完全未參與選模）
  // targetDate：這份清單「適用於哪一個交易日」。刻意與 archDate（分析所根據的
  // 收盤資料日）分開命名——盤後產出的次交易日清單，兩者必然差一天，
  // 混用就會把「8/26 的資料」講成「8/26 的推薦」。
  'targetDate',
  // twseAttentionDate／tpexAttentionDate：注意股名單的「公布日」（API 回應欄位，非 Firestore 文件資料日）。
  //   注意股是公布日隔天生效的狀態，畫面標的是最近一次已公布的名單日期（2026-09-17 上市名單整批消失事故）。
  'twseAttentionDate', 'tpexAttentionDate',
  // 領域日期（交易/公司/新聞/處置）
  'buyDate', 'sellDate', 'entryDate', 'exitDate', 'lastBuyDate',
  'foundedDate', 'listedDate', 'startDate', 'endDate', 'pubDate',
  // 上游 API 原樣欄位（TWSE openapi 的 Date、民國 rocDate；MOPS t05st02_detail 請求參數 enterDate＝民國發言日）
  'Date', 'rocDate', 'enterDate',
]);

// 稽核別名清單必須涵蓋的「文件級新鮮度戳」全集——寫入端用了其中任何一個，
// 健康稽核都必須認得，否則就是 bookDepthArchive 事故重演。
export const REQUIRED_AUDIT_ALIASES = ['updatedAt', 'at', 'generatedAt', 'fetchedAt', 'topupAt', 'archivedAt'];

const SCAN_DIRS = ['scripts', 'src'];
const EXT = /\.(mjs|ts|tsx)$/;
const SKIP = /node_modules|_tmp-|\.d\.ts$|check-field-conventions/;

function* walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (SKIP.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXT.test(f)) yield p;
  }
}

export function scanSource(text, file) {
  const bad = [];
  // 物件鍵名位置的 xxxAt:（涵蓋寫入 payload、型別宣告——同一條約定）
  for (const m of text.matchAll(/(?<![.\w])([a-zA-Z_][a-zA-Z0-9_]*At)\s*:/g)) {
    const name = m[1];
    if (!AT_ALLOWLIST.has(name)) {
      const line = text.slice(0, m.index).split('\n').length;
      bad.push(`${file}:${line} 未登記的時間戳欄位「${name}」——先到 check-field-conventions.mjs 白名單登記，並確認讀取端（稽核別名清單/監看）認得它`);
    }
  }
  // 資料日欄名：xxxDate: / dataXxx:（date 本身在白名單）
  for (const m of text.matchAll(/(?<![.\w])([a-zA-Z_]*[Dd]ate)\s*:/g)) {
    const name = m[1];
    if (name.endsWith('Date') || name === 'date') {
      if (!DATE_ALLOWLIST.has(name)) {
        const line = text.slice(0, m.index).split('\n').length;
        bad.push(`${file}:${line} 未登記的日期欄位「${name}」——到 check-field-conventions.mjs 名冊登記；若它是文件資料日，稽核契約（dateField/dataDate 判定）必須認得它`);
      }
    }
  }
  return bad;
}

export function runCheck() {
  const problems = [];
  for (const dir of SCAN_DIRS) for (const f of walk(join(ROOT, dir))) {
    problems.push(...scanSource(readFileSync(f, 'utf8'), f.slice(ROOT.length + 1)));
  }
  // 交叉檢查：稽核的別名清單必須含 REQUIRED_AUDIT_ALIASES 每一項
  const audit = readFileSync(join(ROOT, 'scripts/audit-data-sources.mjs'), 'utf8');
  const aliasLine = audit.match(/for \(const k of \[([^\]]+)\]\)/);
  const aliases = aliasLine ? aliasLine[1].match(/'[^']+'/g).map(x => x.slice(1, -1)) : [];
  for (const req of REQUIRED_AUDIT_ALIASES) {
    if (!aliases.includes(req)) problems.push(`audit-data-sources.mjs 的時間戳別名清單缺「${req}」——寫入端用它蓋章時稽核會誤報「無時間戳」（bookDepthArchive 事故）`);
  }
  return problems;
}

function selftest() {
  // 新發明的名字必須被抓到——閘門活著的證明
  const sample = `await ref.set({ date: iso, storedAt: Date.now(), settleDate: d });`;
  const hits = scanSource(sample, 'SELFTEST');
  const okAt = hits.some(h => h.includes('storedAt'));
  const okDate = hits.some(h => h.includes('settleDate'));
  const clean = scanSource(`x = { updatedAt: Date.now(), date: iso, dataDate: dd };`, 'SELFTEST');
  console.log(okAt ? '✓ 自測：新時間戳「storedAt」被攔截' : '❌ 自測失敗：storedAt 未被攔截');
  console.log(okDate ? '✓ 自測：新資料日「settleDate」被攔截' : '❌ 自測失敗：settleDate 未被攔截');
  console.log(clean.length === 0 ? '✓ 自測：合法欄位不誤報' : `❌ 自測失敗：誤報 ${clean.join('; ')}`);
  return okAt && okDate && clean.length === 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  const problems = runCheck();
  if (problems.length) { console.log(`❌ 欄位命名契約 ${problems.length} 項違規：`); for (const p of problems) console.log('  ' + p); process.exit(1); }
  console.log(`✓ 欄位命名契約：全站掃描通過（時間戳 ${AT_ALLOWLIST.size} 個已登記名·資料日 ${DATE_ALLOWLIST.size} 個·稽核別名交叉檢查通過）`);
}
