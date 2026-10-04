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
// 執行：node scripts/check-field-conventions.mjs [--selftest] [--root <dir>]
//   --root：改掃該目錄（pre-commit 以 staged 快照目錄呼叫——未追蹤／未暫存的別人工作檔不再擋別人的 commit，
//           也不會遮住 staged 版本的問題，2026-10-04 WM-SCAN G3-30）；預設＝本 repo 工作樹（含未追蹤檔，人工全掃用）
// 掛載：audit-data-sources.mjs 每日 16:10 順跑（見該檔）；CLAUDE.md 驗證節。
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
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
  // firstAt／lastAt／dropAt：軋空當日帳（squeezePicksLedger）每檔第一次入選、最後在榜、離榜的時刻（2026-09-22）。
  'firstAt', 'lastAt', 'dropAt',
  // frozenAt：軋空候選定案名單 squeezePicks/{targetDate} 的凍結時刻（2026-09-22）。
  'frozenAt',
  // stopAt／monitorAt：當沖即時警示 daytradeAlerts/live——訊號「現象停止」的 1 分 K 時刻、監控名單重算時刻（2026-09-23）。
  'stopAt', 'monitorAt',
  // formedAt：當沖工作台開盤區間（ORB）形成的 1 分 K 時刻（2026-09-23）。
  'formedAt',
  // 當沖 AI 實驗 aiDaytradeLab（2026-09-24）：triggerAt 規則觸發 K 棒時刻、askedAt 送出 Ollama、exitAt 模擬出場、
  //   adminNotesAt 超級管理員人工檢討、notesSyncedAt 人工檢討同步到第二大腦。
  'triggerAt', 'askedAt', 'exitAt', 'adminNotesAt', 'notesSyncedAt',
  // AI 實驗·波段持有 aiSwingLab（2026-09-24）：settledAt 持有期到期結算時刻；modifiedAt＝Ollama 模型檔的修改時間（/api/tags 原欄位，ISO 字串）。
  'settledAt', 'modifiedAt',
  // AI 實驗交易單（sim-ledger，2026-09-24）：decidedAt AI 做出決定、fillAt 模擬成交、fillQuoteAt 成交所用報價的時戳、
  //   entryAt 進場、lastExitAt 最後一筆出場、ledgerBackfilledAt 交易單事後補算的時刻——查核「先決定後成交」用。
  'decidedAt', 'fillAt', 'fillQuoteAt', 'entryAt', 'lastExitAt', 'ledgerBackfilledAt', 'sellDecidedAt', 'quoteAt', 'recordedAt', 'fillRecordedAt', 'sellRecordedAt',   // 波段 AI 開盤即時成交：報價揭示時戳／成交記錄寫入時刻（2026-09-30）
 
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
// canonicalAt：定版記錄（事前存檔／當日名單／預測檔）寫入的時刻＝「已定版」標記，讀取端是 lib/canonical-gate.mjs 的
//   canonicalDecision 與 daemon recordShortTraining（2026-10-02）；文件新鮮度仍看各自的 updatedAt/at。
// warnedAt：system/canonicalGate 的「21:45 仍未到齊」警示時刻（事件戳；新鮮度看 updatedAt）。
AT_ALLOWLIST.add('canonicalAt');
AT_ALLOWLIST.add('warnedAt');
AT_ALLOWLIST.add('hotAt');   // 快線文件寫入時刻（reader 帶出）
AT_ALLOWLIST.add('snapshotAt');   // daemon 最近寫快照/指數的時刻（F13 伺服器停更警告）
// 台股 wiki 第二大腦（scripts/lib/stock-wiki，2026-10-03）：全是本地 .cache JSON（gitignored），不寫 Firestore、不進稽核契約。
//   checkedAt＝MOPS 快取「查無」時只記最後檢查時刻（不覆蓋好資料）；mopsAt＝頁面標示的 MOPS 抓取時刻；
//   extractedAt／errorAt＝年報萃取狀態檔的萃取完成／失敗時刻。
['checkedAt', 'mopsAt', 'extractedAt', 'errorAt'].forEach(n => AT_ALLOWLIST.add(n));
// writtenAt：a35 凍結檔 site.writtenAt（站上 limitUpForecast/pred 文件的寫入時刻，由研究端讀出後帶入；研究 JSON，不寫 Firestore·2026-10-04）。
//   後台 surgeShadow 文件改名 site.written；只有 surge-shadow-report 讀取端與測試夾具會出現這個鍵。
AT_ALLOWLIST.add('writtenAt');
// lastRunAt：起漲影子每日流程協調器的本機狀態檔 scripts/surge-lab/out/a35_shadow_daily_status.json（gitignored）的「這一輪開始時刻」（2026-10-04）。
//   讀取端是 surge_lab_publish.mjs 的 pipeline 發佈（另一條工作線）；不是 Firestore 文件新鮮度戳，稽核契約不看它。
AT_ALLOWLIST.add('lastRunAt');
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
  'lockDataDate',   // strategyPicks/latest：連續鎖漲停天數所依據的收盤資料日（YYYYMMDD）；與 date（產生日）分開——週末開機日曆日變、資料日不變（2026-10-02）
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
  'orderDate', 'sellOrderDate', 'lotDate',   // AI 波段主動操作：賣出委託的盤後決策日、部位買進決策日（交易事件日，非文件資料日·2026-09-28）
  'foundedDate', 'listedDate', 'startDate', 'endDate', 'pubDate',
  // goalStartDate：會員 AI 實驗「獲利期間」的起算設定日（aiSwingMembers/{uid}；目標或期間變更時改寫，期間自下一個交易日起算）。
  //   不是文件資料日，稽核契約不看它（2026-10-01）。
  'goalStartDate',
  // 上游 API 原樣欄位（TWSE openapi 的 Date、民國 rocDate；MOPS t05st02_detail 請求參數 enterDate＝民國發言日）
  'Date', 'rocDate', 'enterDate',
  // 台股 wiki 第二大腦（本地 .cache／vault，不寫 Firestore·2026-10-03）：establishDate／listDate＝公司或 ETF 成立／掛牌日（領域日期）；
  //   snapshotDate／emergingDate＝wiki 建置所讀本地備份快照的資料日（上市櫃／興櫃），只印在 vault 首頁，稽核契約不看它
  'establishDate', 'listDate', 'snapshotDate', 'emergingDate',
  // 起漲影子名單 a35 凍結檔（scripts/surge-lab/out/*.json，研究 JSON，不寫 Firestore·2026-10-04）的輸入欄位：
  //   training.cutoffDate／lastLabelDate＝訓練列截止日／最晚標籤日。只在 surge-shadow-report 的讀取端與測試夾具出現；
  //   寫上後台的 surgeShadow 文件改名 trainCutoff／lastLabel（reportJson 內），稽核契約不看它。
  'cutoffDate', 'lastLabelDate',
]);

// 稽核別名清單必須涵蓋的「文件級新鮮度戳」全集——寫入端用了其中任何一個，
// 健康稽核都必須認得，否則就是 bookDepthArchive 事故重演。
// frozenAt（2026-09-28）：AI 實驗 PIT 凍結檔 aiDaytradeLab／aiSwingLab/{date} 唯一的文件級時間戳。
export const REQUIRED_AUDIT_ALIASES = ['updatedAt', 'at', 'generatedAt', 'fetchedAt', 'topupAt', 'archivedAt', 'frozenAt'];

const SCAN_DIRS = ['scripts', 'src'];
const EXT = /\.(mjs|ts|tsx)$/;
// .surge-cache：起漲特徵研究的本機快取／暫存（scripts/surge-lab/.surge-cache，已 gitignore，研究 agent 會在裡面放一次性腳本）——
//   不是產品程式，沒登記的 …Date 名字不該擋住別人的提交（2026-10-03 主 checkout pre-commit 被 verify_lu_1002.mjs 擋下）
const SKIP = /node_modules|_tmp-|\.surge-cache|\.d\.ts$|check-field-conventions/;

// SKIP 以「相對於掃描根」的路徑比對（--root 指向暫存目錄時，暫存目錄自己的路徑不可誤中 SKIP）
function* walk(dir, root = ROOT) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (SKIP.test(p.slice(root.length))) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p, root);
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

/** root：要掃的樹（預設本 repo）。audit-data-sources.mjs 以無參數呼叫＝工作樹，行為不變。 */
export function runCheck(root = ROOT) {
  const problems = [];
  for (const dir of SCAN_DIRS) for (const f of walk(join(root, dir), root)) {
    problems.push(...scanSource(readFileSync(f, 'utf8'), f.slice(root.length + 1)));
  }
  // 交叉檢查：稽核的別名清單必須含 REQUIRED_AUDIT_ALIASES 每一項
  const audit = readFileSync(join(root, 'scripts/audit-data-sources.mjs'), 'utf8');
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

// 直接執行才跑主程式（被 audit-data-sources import 時不跑）。⚠ 兩邊都取 realpath 再比（2026-10-04）：
//   macOS 的 /var → /private/var 符號連結、或路徑含 `//` 時，舊的字串相等判斷會不成立 ⇒ 主程式不執行、exit 0＝靜默通過
//   （pre-commit 以暫存目錄呼叫時實際發生，Vacuous Guard）。
const _isMain = (() => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (_isMain) {
  if (process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
  const ri = process.argv.indexOf('--root');
  const problems = runCheck(ri > 0 ? resolve(process.argv[ri + 1]) : ROOT);
  if (problems.length) { console.log(`❌ 欄位命名契約 ${problems.length} 項違規：`); for (const p of problems) console.log('  ' + p); process.exit(1); }
  console.log(`✓ 欄位命名契約：全站掃描通過（時間戳 ${AT_ALLOWLIST.size} 個已登記名·資料日 ${DATE_ALLOWLIST.size} 個·稽核別名交叉檢查通過）`);
}
