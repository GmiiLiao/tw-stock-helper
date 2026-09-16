#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 全站資料源稽核 —— 依 wm-freshness-health-monitoring 的新鮮度契約
//
// 契約：每個資料源都要能回答三件事
//   ① fetchedAt   —— 最後一次成功更新是什麼時候
//   ② recordCount —— 這次更新涵蓋了多少筆
//   ③ dataDate    —— 這批資料**代表哪一天**（不是「什麼時候抓的」）
//
// 兩道獨立閘門，缺一不可：
//   • maxStaleMin  = 更新節奏的 2~3 倍。只看這個會漏掉「很新但幾乎全空」。
//   • minRecords   = 覆蓋率下限。只看這個會漏掉「很完整但是上週的」。
//
// ⚠ 第三道：**dataDate 漂移**。這是本專案踩過最多次的坑 ——
//   上櫃日期位移、加權指數落後一日、stockHistory 只寫一次、chipDaily PIT 漂移。
//   共同特徵都是「有值、很新、筆數也夠」，但代表的是**別天**的資料。
//   所以有 dataDate 的來源一律比對「最近一個交易日」。
//
// 用法：node scripts/audit-data-sources.mjs [--json] [--only=collection]
// ─────────────────────────────────────────────────────────────────────────

import admin from 'firebase-admin';
import { runCheck as checkFieldConventions } from './check-field-conventions.mjs';

process.env.GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
  '/Users/gmii/Documents/GCP_憑證檔案/tw-stock-helper-firebase-adminsdk-fbsvc-1dd050d371.json';
admin.initializeApp();
const db = admin.firestore();

const AS_JSON = process.argv.includes('--json');
const ONLY = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7) || null;
const WRITE = process.argv.includes('--write');   // 寫入 system/dataHealth 供 daemon 告警與 API 讀取
const NO_EXT = process.argv.includes('--no-external');

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

// ── 契約表 ───────────────────────────────────────────────────────────────
// kind: 'latest'  → 讀 doc('latest')
//       'dated'   → 讀 orderBy(date desc) 第一筆
//       'perCode' → 整個 collection 每個 doc 一檔股票
// maxStale: 允許的最大陳舊時間（ms）。intraday 類只在交易日盤中嚴格判定。
// minRecords: 覆蓋率下限。
// session: 'intraday' 盤中更新 | 'daily' 每日收盤後 | 'always' 全天
const CONTRACTS = [
  // ── 盤中即時（節奏以分鐘計）──
  { c: 'marketIndex',      kind: 'latest',  maxStale: 10 * MIN,  session: 'intraday', dateField: 'tradeDate' },
  // markets：市場組成閘門（2026-08-19 新增，第四道）。前三道全綠也擋不住
  // 「上櫃 903 檔整批消失、只剩上市 1,229 檔」——筆數夠多、很新、日期也對，
  // 但半個市場不見了。實案：一次 TPEx 抓取失敗 + 快取條件只看 length>0。
  { c: 'marketSnapshot',   kind: 'latest',  maxStale: 10 * MIN,  session: 'intraday', countField: 'quotes',
    markets: { field: 'quotesJson', min: { tse: 900, otc: 700 } } },
  // 興櫃（2026-08-19 接上）：獨立文件，只供搜尋/個股頁。興櫃交易到 15:00，
  // 盤中 3 分鐘更新一次；不進任何榜單故不設市場組成閘門。
  { c: 'marketSnapshot',   kind: 'latest',  docId: 'emerging', label: 'marketSnapshot/emerging',
    maxStale: 60 * MIN, session: 'intraday', minRecords: 200, countField: 'quotesJson' },
  { c: 'marketIntraday',   kind: 'latest',  maxStale: 15 * MIN,  session: 'intraday' },
  { c: 'intradayRadar',    kind: 'latest',  maxStale: 15 * MIN,  session: 'intraday' },
  { c: 'limitUpForecast',  kind: 'latest',  maxStale: 15 * MIN,  session: 'intraday' },
  // allowEmpty（2026-08-27）：computeVolSurge 是**盤中限定**（09:00~13:35 之外
  // 直接 return 不寫入），所以收盤後那份就停在最後一次計算的結果——當時沒有爆量
  // 就是 0 檔，於是**每天傍晚到隔天開盤都會紅**。這正是今天早上修 dayTradeRatio
  // 時記下的那類：長紅的告警等於沒有告警，會把真正的斷檔蓋掉。
  // 空榜是合法的市場狀態（盤中沒有爆量就是沒有），不該當成故障。
  { c: 'volSurge',         kind: 'latest',  maxStale: 15 * MIN,  session: 'intraday', allowEmpty: true },
  // 軋空候選（2026-08-26）：允許 0 檔——條件嚴格，沒有符合的日子是正常結果，
  // 不可因為空榜就判定資料壞掉（allowEmpty）。
  { c: 'squeezePicks',     kind: 'latest',  maxStale: 40 * MIN,  session: 'intraday', allowEmpty: true },
  // 開盤前新聞判別（每交易日 08:00 由本機 AI 產出）：盤中查它會是「今早那份」，
  // 故放寬到 20 小時；空榜正常（沒有候選就沒有判別）。
  { c: 'squeezeRecommend', kind: 'latest',  maxStale: 20 * HOUR, session: 'always', allowEmpty: true, preopen: true },
  // 漲停預測的新聞判別（2026-08-28 接上）：與 squeezeRecommend 同節奏，
  // 每交易日 08:00 由本機 AI 產出，盤中查它會是「今早那份」故放寬到 20 小時。
  { c: 'limitUpRecommend', kind: 'latest',  maxStale: 20 * HOUR, session: 'always', allowEmpty: true, preopen: true },
  // 做空風控候選（2026-09-03）：盤中每 10 分鐘＋盤後定榜。空榜是設計結果
  // （過濾嚴格·多頭日更少），doc 自帶 totalPassed/note 解釋 ⇒ allowEmpty。
  { c: 'shortCandidates',  kind: 'latest',  maxStale: 20 * HOUR, session: 'always', allowEmpty: true },
  { c: 'gapLimitUp',       kind: 'latest',  maxStale: 20 * HOUR, session: 'always', allowEmpty: true },   // 🎯 縮量跳空漲停（2026-09-05）
  { c: 'swingHold',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 17, dateField: 'dataDate' },   // 📈 波段持有 5/10/20/60 日連續成長榜（2026-09-16）
  // 訓練樣本：21:45 班車寫 dated doc。漏一天＝少一筆不可回補的樣本（特徵是
  // 當日快照，事後重建就不是 PIT）——這正是 bookDepth 壞半年教訓要防的。
  { c: 'shortTraining',    kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', minRecords: 100, countField: 'rowsJson', publishHour: 22 },   // 21:45 班車
  // 搶漲停排隊（09:00~09:15 才有意義）：盤中每分更新，其餘時間停留在早上那份，
  // 故 maxStale 放寬到 20 小時；空榜是常態（多數日子沒有這種書況）。
  // 新聞內文判別（2026-08-29 上線）：盤後 23:00 + 晨間 07:00 兩趟。
  // session:'always'——非交易日也跑（週末新聞正是週一開盤要用的），
  // 所以不吃 offHoursMs 放寬也不會誤報。26h 上限＝容忍一趟失敗。
  // minRecords=40：覆蓋率崩塌是**靜默**的——來源掃描若某天只認出 5 檔，
  // 文件照樣寫入、時間戳很新，稽核只看新鮮度就完全看不出來。
  // 實測正常覆蓋約 110 檔；40 是「明顯不對」的門檻，不是目標值。
  { c: 'newsVerdict',      kind: 'latest',  maxStale: 26 * HOUR, session: 'always',
    minRecords: 40, countField: 'verdictJson' },
  // 對答案（15:30，交易日）：這是 ±20 係數唯一的驗證來源，斷了就等於失去監督。
  { c: 'newsVerdictReview', kind: 'latest', maxStale: 26 * HOUR, session: 'daily',
    docId: 'summary', allowEmpty: true },
  { c: 'limitQueue',       kind: 'latest',  maxStale: 20 * HOUR, session: 'always', allowEmpty: true },
  { c: 'marketPulse',      kind: 'latest',  maxStale: 20 * HOUR, session: 'always', allowEmpty: true },
  // 軋空判讀模型：**每個交易日之後的凌晨 02:00** 訓練（2026-08-31 改）
  // ⇒ 最長間隔是週末的 2 天（週六訓練後到週二），設 3 天為陳舊上限。
  { c: 'squeezeModel',     kind: 'latest',  maxStale: 3 * DAY,   session: 'always', allowEmpty: true },

  // ── 每日收盤後（節奏以日計）──
  { c: 'chipArchive',      kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', minRecords: 1500, countField: 'closeJson' },
  { c: 'chipDaily',        kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', minRecords: 1500, countField: 'codesJson' },
  // 尾盤五檔歸檔（委買賣失衡原料·2026-08-02 接上稽核）：舊版 9 個交易日缺 2 天
  // 且沒有任何告警——這種「靜默不累積」的資料要靠三道閘門才抓得到。
  { c: 'bookDepthArchive', kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', minRecords: 300,  countField: 'byCodeJson' },
  // 市場委託失衡（MI_5MINS 每5秒委託成交統計·2026-08-02 回補3年並接上每日更新）
  // 個股盤中 5分K（2026-08-03 建立·當沖模式的驗證原料）。Yahoo 只保留 60 交易日，
  // 漏抓一天就永久消失，故必須納入稽核——這正是 bookDepth 壞了半年沒人發現的教訓。
  { c: 'intradayArchive', kind: 'dated', maxStale: 30 * HOUR, session: 'daily', minRecords: 300, countField: 'byCodeJson' },
  // 日韓早盤（2026-08-03 建立）：台股開盤前的領先窗口原料。
  // 只在交易日 08:00–09:05 產生，故 maxStale 放寬到 30h；minRecords 用 snapshots 陣列長度。
  { c: 'asiaPremarketArchive', kind: 'dated', maxStale: 30 * HOUR, session: 'daily', minRecords: 1, countField: 'snapshots' },
  { c: 'orderFlowArchive', kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', minRecords: 1,    countField: 'curveJson' },
  { c: 'stockHistory',     kind: 'perCode', maxStale: 30 * HOUR, session: 'daily', minRecords: 900,  dateField: 'lastDate' },
  { c: 'scanner',          kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 22 },
  { c: 'rsRanking',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 22 },
  { c: 'tradeSignals',     kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 22 },
  { c: 'multiTimeframe',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 22 },
  { c: 'chipPicks',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 22 },
  { c: 'chipCharacter',    kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 17 },   // 16:45 起跑子程序，~16:50 寫完
  { c: 'chipWind',         kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 22 },
  { c: 'chipDivergence',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 22 },
  { c: 'sectorRotation',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'sectorWind',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'marketWind',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'marketHealth',     kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'topicPicks',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'swingPicks',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  // allowEmpty：本榜回測日均僅 1.6 檔，零檔是常態（例：大反彈日後 RSI5 全面噴高）——EMPTY 不是故障
  { c: 'strengthPicks',    kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', allowEmpty: true },
  // 第2套預選（PID 斜率曲線·60 日前瞻實驗）。⚠ 這條**特別需要稽核**：
  // 它要連續記錄 60 個交易日才有結論，中間任何一天沒寫入就是永久的洞——
  // 事後無法補算（分型用的是當日橫斷面 z-score，母體無法重建）。
  { c: 'swingCurvePicks',  kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  // ⚠ 月營收要看的是**資料所屬月**，不是更新時間（2026-08-11）：
  //   openapi t187ap05 落後**整整一個月**（不是一天），而 daemon 每天都會跑一次，
  //   所以 maxStale 永遠是綠的、筆數也夠——三道閘門裡只有第三道抓得到。
  //   computeRevenue 已改為與 revenueArchive 比對取新，這裡加 dataMonth 監看實際月份。
  { c: 'revenue',          kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'strategyPicks',    kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'snipeList',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'squeezeSetup',     kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'washoutMonitor',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'institutionalStreaks', kind: 'latest', maxStale: 30 * HOUR, session: 'daily' },
  // 當沖資格名單（2026-08-27 新增·全站合規標示的唯一來源）。
  // ⚠ 這條**必須**在稽核裡：名單若沒更新，站上會拿昨天的資格標今天的股票，
  //   使用者照著標示去當沖就可能違規——而且畫面看起來完全正常。
  //   與 dayTradeRatio 不同，資格清單**盤前就發布**，所以沒有 publishHour。
  //   count 用 codesJson 的鍵數（實測 2,077 檔，含 ETF）；掉到 1,500 以下代表
  //   多半只抓到單一市場（daemon 端已有兩市場閘門，這裡是第二道）。
  { c: 'dayTradeEligible', kind: 'latest', maxStale: 30 * HOUR, session: 'daily',
    minRecords: 1500, countField: 'codesJson' },
  // publishHour：TWSE 當日「傍晚才上架」的兩支。實測首次抓到的時刻分別是
  // 20:17／20:20／20:43（當沖統計），資券依 CLAUDE.md 為 21:45；各留餘裕。
  { c: 'dayTradeRatio',    kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 21 },
  { c: 'marginShort',      kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', publishHour: 22 },
  { c: 'taifexPositions',  kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'bookDepth',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'volAvg20',         kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'premarketBrief',   kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', preopen: true },
  { c: 'morningNote',      kind: 'latest',  maxStale: 30 * HOUR, session: 'daily', preopen: true },
  { c: 'dailyPost',        kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'globalMarkets',    kind: 'latest',  maxStale: 12 * HOUR, session: 'always' },
  { c: 'adrPremium',       kind: 'latest',  maxStale: 12 * HOUR, session: 'always' },
  { c: 'etfPremium',       kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'etfInfluence',     kind: 'latest',  maxStale: 30 * HOUR, session: 'daily' },
  { c: 'newsDigest',       kind: 'latest',  maxStale: 8 * HOUR,  session: 'always' },
  // ⚠ newsDaily 是**按日曆日歸檔的新聞摘要**，不是市場資料：週六收到的就是
  //   週六的新聞，date 本來就該是日曆日。對它套「資料日 vs 最近交易日」的
  //   標準是我 2026-08-29 一度判錯的——它不該進第三道閘門，故 session:'always'。
  { c: 'newsDaily',        kind: 'dated',   maxStale: 30 * HOUR, session: 'always' },
  { c: 'marketReports',    kind: 'dated',   maxStale: 30 * HOUR, session: 'daily', publishHour: 18.5 },   // daemon 18:05 打 /api/cron/daily-close   // 收盤盤勢分析（2026-08-01 事故後納管：曾停更2日無人察覺）

  // ── 低頻（週/月/季）──
  { c: 'revenue',          kind: 'latest',  maxStale: 40 * DAY,  session: 'always' },
  { c: 'dividendCalendar', kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'dividendStocks',   kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'majorHolders',     kind: 'latest',  maxStale: 14 * DAY,  session: 'always' },
  { c: 'lending',          kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'peerComps',        kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'catalystCalendar', kind: 'latest',  maxStale: 10 * DAY,  session: 'always' },
  { c: 'modelCore',        kind: 'latest',  maxStale: 40 * DAY,  session: 'always' },
  // themeMap 用 seed/custom 兩個 doc，沒有 latest —— 先前報 MISSING 是契約寫錯，不是資料缺
  { c: 'themeMap',         kind: 'latest',  maxStale: 40 * DAY,  session: 'always', docId: 'seed' },
  { c: 'system',           kind: 'latest',  maxStale: 30 * HOUR, session: 'always', docId: 'tradingCalendar' },
];

/**
 * 外部資料源自報日期探測。
 *
 * 實測（2026-07-31）：openapi.twse.com.tw 這個鏡像**整批固定落後一個交易日** ——
 * MI_INDEX / BWIBBU_ALL / STOCK_DAY_ALL / t187ap03_L / t187ap41_L 全部差 1 天。
 * 而 MI_MARGN 與 SBL/TWT96U **連日期欄位都沒有**，無法驗證。
 * 這不是偶發抖動，是這個鏡像的固定性質 —— 任何新的消費端都必須假設它是舊的。
 */
const EXTERNAL_PROBES = [
  { name: '指數收盤',  url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',      dateKeys: ['日期'] },
  { name: '個股收盤',  url: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', dateKeys: ['日期', 'Date'] },
  // 註：TWT48U_ALL 是**除權息預告表**，它的 Date 是「未來的除權息日」不是資料日 ——
  //     先前一度把 2026-08-05 讀成「落後 -5 天」，那是誤判，已移出探測清單。
  { name: '殖利率',    url: 'https://openapi.twse.com.tw/v1/exchangeReport/BWIBBU_ALL',    dateKeys: ['日期', 'Date'] },
  { name: '公司基本',  url: 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L',          dateKeys: ['出表日期'] },
  { name: '融資融券', url: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_MARGN',       dateKeys: ['日期', 'Date'] },
  { name: '借券',      url: 'https://openapi.twse.com.tw/v1/SBL/TWT96U',                   dateKeys: ['日期', 'Date'] },
];

// 已改用的「可指定日期＋會回音」端點 —— 這些才是生產路徑，openapi 只留著當對照組，
// 證明「換掉是對的」而不是憑感覺。topLevel=true 代表日期在回應的最上層而非資料列。
const FRESH_PROBES = [
  // publishHour：**當日資料的公布時刻（台北時）**。在這之前查不到「今天」是正常現象，
  //   不是資料源壞掉。舊版一律拿最近交易日比對，於是每天 21:30 前都會誤報一次 MISMATCH——
  //   **每天都叫一次狼的警報，最後會被無視，比沒有警報更危險**（2026-08-10 實例：
  //   19:13 稽核 n=0 判 MISMATCH，但同一支 API 查前一交易日回 1,291 筆完全正常）。
  { name: '融資融券(rwd)', url: d => `https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${d}&selectType=ALL&response=json`, from: 'field', publishHour: 21.5 },
  // forward：「當日可借券」公布的是**下一個交易時段**的額度，傍晚就滾動 ——
  //          資料日 >= 最近交易日即為健康，用 === 會每晚誤報。
  { name: '借券(rwd)',     url: d => `https://www.twse.com.tw/rwd/zh/marginTrading/TWT96U?date=${d}&response=json`,                  from: 'title', mode: 'forward' },
  // publishHour 15 太緊（2026-08-28 15:00 實測仍未發布）：T86 實際落在 15:00~16:00，
  // 設在邊界等於每天有一段必紅。自家的官方補抓也是排 16:30，改 16 與之一致。
  { name: '法人T86(rwd)',  url: d => `https://www.twse.com.tw/rwd/zh/fund/T86?response=json&date=${d}&selectType=ALL`,               from: 'field', publishHour: 16 },
  { name: '指數(rwd)',     url: d => `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d}&type=IND&response=json`,        from: 'field' },
  // ⚠ BWIBBU_ALL 的 rwd：**讀 date 欄，不要讀 title**（2026-08-11 實證，過程記錄如下）。
  //   這支端點有兩個怪癖，兩個都會誤導人：
  //   ① **完全忽略 date 參數**——帶明天(20260812)或三週後(20260901)都照樣 stat=OK、
  //      回同一份 1,084 筆。所以它不能用來查歷史，只能拿到「最新一份」。
  //   ② **`date` 欄是「今天的日曆日」（服務日），`title` 開頭的民國日期才是資料日。**
  //
  //   這條翻過兩次，把兩次都留著才看得懂為什麼會錯：
  //   · 2026-08-11（收盤後測）：date=20260811、title=115/08/10。用 PBR 反推價格
  //     ——PBR ∝ 價格，故 PBR(rwd)/PBR(openapi) 應等於 收盤(08-11)/收盤(08-10)，
  //     實測 9 檔全中（2330 1.0063/1.0057、2454 1.0152/1.0154、3008 0.9898/0.9900）
  //     ⇒ 內容確實是 08-11，rwd 領先 openapi 一天。**這個結論到今天仍然成立。**
  //     但我從中推論「date 欄＝資料日」——那是**巧合**：收盤後服務日恰好等於資料日。
  //   · 2026-08-12 09:32（盤中測，當日收盤尚不存在）：date=20260812、title=115/08/11。
  //     此時 openapi 已追到 08-11，兩邊 PBR 比值**恆為 1.0000**、openapi 自報 Date=1150811
  //     ⇒ rwd 內容是 08-11 ⇒ title 對、date 錯。
  //     再以 date 參數掃描確認：req 帶 20260805／20260701／20261231，
  //     回傳 date 一律 20260812、title 一律 115/08/11、PBR 一字不差
  //     ⇒ date 與請求和內容都無關，純粹是服務日。
  //
  //   ⚠ 教訓：驗「日期欄位」要挑**資料日 ≠ 今天**的時段測（盤中或休市日）。
  //     收盤後測會讓服務日與資料日重合，兩個欄位看起來都對，等於沒驗。
  //   publishHour 22：BWIBBU 當日內容的確切發布時刻未實測；2026-08-12 17:05 PBR 反推
  //   實測內容仍為前一交易日（9/9 檔），故收盤後至 22:00 前接受前一交易日不算落後。
  { name: '殖利率(rwd)',   url: d => `https://www.twse.com.tw/rwd/zh/afterTrading/BWIBBU_ALL?date=${d}&response=json`,               from: 'title', publishHour: 22 },
];

// 民國日期出現在 title 的兩種寫法都要吃（都是實測格式）：
//   借券 TWT96U   →「115年08月11日...」
//   殖利率 BWIBBU →「115/08/11 個股日本益比、殖利率及股價淨值比」
// 只寫其中一種的話，另一支會回 null，稽核就顯示「自報 null ≠ 預期日」——
// 看起來像資料源壞了，其實是解析漏了，方向完全誤導。
function ymdFromTitle(t) {
  const m = String(t || '').match(/(\d{2,3})\s*[年/-]\s*(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*日?/);
  if (!m) return null;
  let y = +m[1] + 1911, mo = +m[2], d = +m[3];
  // ⚠ TWSE 月初 off-by-one（2026-09-01 實測）：9/1 盤前 BWIBBU title 印
  //   「115/09/0」——資料日其實是上月末 08/31，TWSE 的「日-1」顯示在月界翻車。
  //   連指定 date=20260831 查詢也回同一份 09/0。日=0 依日曆語義就是「上月第 0 天」
  //   = 上月末，用 Date.UTC 的自動借位換算（1 月 0 日會正確借位成前一年 12/31）。
  //   這是**換算上游的已知顯示錯誤**，不是猜測——數值反推內容確為前一交易日。
  if (d === 0) {
    const dt = new Date(Date.UTC(y, mo - 1, 0));
    y = dt.getUTCFullYear(); mo = dt.getUTCMonth() + 1; d = dt.getUTCDate();
  }
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

async function probeFresh(ltd) {
  const want = ltd.replace(/-/g, '');
  const out = [];
  const tpeNow = new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60000);
  for (const p of FRESH_PROBES) {
    try {
      // ⚠**查詢日期也要跟著退**，不能只退期待值：這支 API 是「指定日期查詢」，
      //   拿今天去查一個還沒公布的日子必然回空，期待值再怎麼算都對不起來。
      const beforePub = p.publishHour != null && ltd === isoDate(tpeNow)
        && (tpeNow.getHours() + tpeNow.getMinutes() / 60) < p.publishHour;
      const askDate = (beforePub ? prevTradingDay(ltd) : ltd).replace(/-/g, '');
      const r = await fetch(p.url(askDate), { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.twse.com.tw/' }, signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      if (t.trim().startsWith('<')) { out.push({ name: p.name, status: 'ERROR', note: '回傳 HTML' }); continue; }
      const j = JSON.parse(t);
      const n = (j.data || []).length || (j.tables || []).reduce((s2, x) => s2 + (x.data || []).length, 0);
      const feedDate = p.from === 'title' ? ymdFromTitle(j.title) : normDate(j.date);
      // 期待值＝實際查詢的那一天（見上方 askDate）
      const beforePublish = beforePub;
      const expect = beforePublish ? prevTradingDay(ltd) : ltd;
      const ok = p.mode === 'forward' ? (feedDate != null && feedDate >= expect) : feedDate === expect;
      const pending = beforePublish ? `（今日 ${p.publishHour}:00 後才公布，現以 ${expect} 為準）` : '';
      out.push({ name: p.name, records: n, feedDate, status: ok ? 'OK' : 'MISMATCH',
        note: ok ? (pending || (p.mode === 'forward' && feedDate > expect ? `前瞻至 ${feedDate}（正常）` : ''))
                 : `自報 ${feedDate} ${p.mode === 'forward' ? '早於' : '≠'} ${expect}${pending}` });
    } catch (e) { out.push({ name: p.name, status: 'ERROR', note: (e.message || '').slice(0, 40) }); }
  }
  return out;
}

// 前一交易日（只扣週末；臨時休市由呼叫端的 ltd 已處理過，這裡僅供「未公布」時退一格）
const isoDate = d => d.toISOString().slice(0, 10);

// 這個來源「幾點才算當日完整」。預設 16.75（2026-08-28 實測後由 15.5 上修）：
// 每日管線不是 15:10 就結束——法人 T86 15:00~16:00、官方補抓 16:30、
// **上櫃 16:45 才併入**。設 15.5 會讓依賴後段的來源在 15:30~16:45 集體報紅
// （實測 7 個）。代價是「15:10 就該完成的來源若壞了，晚 95 分鐘才被發現」，
// 但那些資料本來也要等後段補齊才會被消費，不影響任何決策。
// ⚠ 日期閘門與筆數閘門**必須共用這一份**——第一版兩處各寫一份，改了一邊
//   另一邊照樣誤報。
function publishHourOf(spec) {
  return spec.publishHour != null ? spec.publishHour : (spec.session === 'daily' ? 16.75 : null);
}

function prevTradingDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function normDate(v) {
  const s = String(v || '');
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  if (/^\d{7}$/.test(s)) return `${+s.slice(0, 3) + 1911}-${s.slice(3, 5)}-${s.slice(5)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

async function probeExternal(ltd) {
  const out = [];
  for (const p of EXTERNAL_PROBES) {
    try {
      const r = await fetch(p.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) { out.push({ ...p, status: 'ERROR', note: `HTTP ${r.status}` }); continue; }
      const j = await r.json();
      const n = Array.isArray(j) ? j.length : 0;
      const row = n ? j[0] : {};
      const key = p.dateKeys.find(k => row[k] != null);
      const feedDate = key ? normDate(row[key]) : null;
      if (!feedDate) { out.push({ name: p.name, records: n, feedDate: null, status: 'NO_DATE', note: '無日期欄位＝無法驗證' }); continue; }
      const stale = feedDate < ltd;
      out.push({ name: p.name, records: n, feedDate, status: stale ? 'LAGGING' : 'OK', note: stale ? `落後至 ${feedDate}（最近交易日 ${ltd}）` : '' });
    } catch (e) { out.push({ name: p.name, status: 'ERROR', note: (e.message || '').slice(0, 40) }); }
  }
  return out;
}

const taipeiNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));

/**
 * 盤中類的 maxStale 只在**交易時段內**適用。
 * 收盤後那些 doc 本來就不會再更新，套 10 分鐘上限等於保證誤報 ——
 * 這正是 wm-freshness 說的「狀態階梯」要分 session，否則監控自己會變成雜訊來源。
 * 收盤後改用「當日內」判定（30 小時），只要資料日對就算健康。
 */
function effectiveMaxStale(spec, marketOpen, tradingToday, offHoursMs = 0, sincePubMs = null) {
  // offHoursMs＝距上一個交易日收盤已經過了多久的「非交易時間」。
  // 為什麼要通用地把它加進上限（2026-08-29）：
  //   squeezeRecommend / limitUpRecommend / limitQueue / marketPulse 被標成
  //   session:'always'，但它們**其實只在交易日產生**。上限固定 20h ⇒
  //   每個週六下午一到就整組變紅，週日更慘。長紅的告警等於沒有告警，
  //   真的故障會被淹在裡面（這正是專案記過的教訓）。
  //   逐一改標籤治不了本：任何「只在交易日產生」的來源都會再犯。
  //   ⚠ 只在**非交易日**加寬；交易日當天 offHoursMs=0，偵測力完全不變。
  // ⚠ **盤前產出的來源不給非交易時間放寬**（2026-08-31 使用者指正後釐清）：
  //   放寬的正當理由是「收盤後才產生的資料，週一早上最新的本來就是週五的」
  //   ——chipArchive、marginShort、volAvg20 那 67 小時是正常的。
  //   但盤前產出的來源（當沖資格 07:30、軋空/漲停判別 08:00、晨間簡報）
  //   **今天早上就該更新**，給它們放寬等於把真正的斷線蓋掉：
  //   實測 limitUpRecommend 已 65 小時沒更新（今天 08:00 沒跑），
  //   卻因為放寬 67 小時而顯示 OK。
  // ⚠ 有 publishHour 的來源，陳舊要以「上一次**應該**公布的時刻」為基準，
  //   不是牆上時鐘（2026-08-31 實測）：融資融券每天 22:00 公布，
  //   週一晚上 20:20 最新的本來就是週五 22:00 的 ⇒ 71 小時是正常的，
  //   用固定 30h 上限判它陳舊等於每個交易日的白天都在誤報。
  //   公布時刻**之後**仍未更新才是真的斷線，那時 sincePub 很小、抓得出來。
  // ⚠ 這裡要用 publishHourOf（含 daily 預設 16.75），不是 spec.publishHour（2026-09-14 修）：
  //   舊寫法只認「明示」的 publishHour，於是 daily 預設值那些來源（chipCharacter／marketReports／
  //   shortTraining）在週一 16:15 被拿固定 30h 對週五的產物 ⇒ 每個週一都報 STALE、每個週一都是假的。
  //   sincePubMs 本來就是用 publishHourOf 算的——兩處必須共用同一份定義。
  if (publishHourOf(spec) != null && sincePubMs != null) return spec.maxStale + sincePubMs;
  if (spec.preopen) return spec.maxStale;
  if (spec.session === 'intraday') return (marketOpen ? spec.maxStale : 30 * HOUR) + offHoursMs;
  // daily 類在非交易日（週末/假日）放寬到 78h——週五收盤產物到週日必然超過 30h。
  if (spec.session === 'daily' && !tradingToday) return Math.max(spec.maxStale, 78 * HOUR) + offHoursMs;
  return spec.maxStale + offHoursMs;
}
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 最近一個交易日（用 system/tradingCalendar；抓不到就只擋週末） */
async function lastTradingDay() {
  let holidays = new Set();
  try {
    const d = (await db.collection('system').doc('tradingCalendar').get()).data();
    if (Array.isArray(d?.holidays)) holidays = new Set(d.holidays);
  } catch { /* fail-open */ }
  const t = taipeiNow();
  // 13:30 收盤前，「最近一個完整交易日」是前一天
  if (t.getHours() * 60 + t.getMinutes() < 13 * 60 + 30) t.setDate(t.getDate() - 1);
  for (let i = 0; i < 15; i++) {
    const iso = isoOf(t);
    if (t.getDay() !== 0 && t.getDay() !== 6 && !holidays.has(iso)) return iso;
    t.setDate(t.getDate() - 1);
  }
  return isoOf(taipeiNow());
}

function pickTimestamp(d) {
  // ⚠ 這份清單與 check-field-conventions.mjs 的 REQUIRED_AUDIT_ALIASES 互相鎖定：
  //   寫入端可用的「文件級新鮮度戳」名字都必須在這裡——少一個就是
  //   bookDepthArchive 事故重演（資料好好的、稽核紅一整天「缺 fetchedAt」）。
  //   單方面改任一邊，欄位命名契約檢查會失敗。
  for (const k of ['updatedAt', 'at', 'generatedAt', 'fetchedAt', 'topupAt', 'archivedAt']) {
    const v = d?.[k];
    if (typeof v === 'number' && v > 1e12) return v;
    if (typeof v === 'string') { const t = Date.parse(v); if (!Number.isNaN(t)) return t; }
    if (v?.toMillis) return v.toMillis();
  }
  return null;
}

function pickCount(d, countField) {
  if (countField && d?.[countField]) {
    const raw = d[countField];
    if (typeof raw === 'string') { try { return Object.keys(JSON.parse(raw)).length; } catch { return null; } }
    if (typeof raw === 'object') return Object.keys(raw).length;
  }
  for (const k of ['items', 'picks', 'rows', 'list', 'stocks', 'cats']) {
    if (Array.isArray(d?.[k])) return d[k].length;
  }
  if (typeof d?.count === 'number') return d.count;
  if (typeof d?.n === 'number') return d.n;
  return null;
}

/** 從 doc 內容找出「這批資料代表哪一天」 */
function pickDataDate(d, dateField) {
  // 別名：專案裡同一個語意用過 5 種欄位名。改稽核器認得它們，
  // 比改欄位名去破壞既有消費端划算（wm-data-accuracy「三層 fallback 身分」）。
  // ⚠ 優先序 2026-08-29 訂正：**dataDate 要排在 date 之前**。
  //   `date` 是通用名，daemon 裡有 12 個 collection 拿它當「產生日」寫成
  //   isoDate(taipei())；`dataDate` 才是專門用 boardDataDate() 算出來的資料日。
  //   舊順序讓 date 蓋過 dataDate ⇒ 那些來源的第三道閘門**永遠比對到今天、
  //   永遠通過**，等於對它們全盲（實測週六有 7 個來源自稱資料日 2026-08-29）。
  const raw = dateField ? d?.[dateField]
    : (d?.dataDate ?? d?.date ?? d?.tradeDate ?? d?.lastDate ?? d?.latestDate ?? d?.endDate);
  if (!raw) return null;
  const s = String(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;   // 20260731
  if (/^\d{7}$/.test(s)) return `${+s.slice(0, 3) + 1911}-${s.slice(3, 5)}-${s.slice(5)}`; // 民國
  return null;
}

async function auditOne(spec, ltd, marketOpen, tradingToday, offHoursMs = 0, maxDataDate = ltd) {
  const out = { collection: spec.docId && spec.docId !== 'latest' ? `${spec.c}/${spec.docId}` : spec.c, status: 'OK', notes: [] };
  try {
    let data = null, docId = null;

    if (spec.kind === 'latest') {
      docId = spec.docId || 'latest';
      data = (await db.collection(spec.c).doc(docId).get()).data() || null;
    } else if (spec.kind === 'dated') {
      const s = await db.collection(spec.c).orderBy('date', 'desc').limit(1).get();
      if (!s.empty) { data = s.docs[0].data(); docId = s.docs[0].id; }
    } else if (spec.kind === 'perCode') {
      const s = await db.collection(spec.c).get();
      const dates = {};
      s.forEach(x => { const v = x.data()?.[spec.dateField || 'lastDate']; if (v) dates[v] = (dates[v] || 0) + 1; });
      const newest = Object.keys(dates).sort().pop() || null;
      out.records = s.size;
      out.dataDate = newest;
      out.spread = Object.keys(dates).length;
      if (out.spread > 3) out.notes.push(`日期分歧 ${out.spread} 種（最新 ${newest}）`);
      data = { __perCode: true };
    }

    if (!data) { out.status = 'MISSING'; out.notes.push(`doc 不存在（${docId || 'n/a'}）`); return out; }

    if (spec.kind !== 'perCode') {
      out.docId = docId;
      const ts = pickTimestamp(data);
      out.ageMin = ts ? Math.round((Date.now() - ts) / MIN) : null;
      out.records = pickCount(data, spec.countField);
      out.dataDate = pickDataDate(data, spec.dateField);
      if (ts == null) out.notes.push('無時間戳（不符新鮮度契約：缺 fetchedAt）');
      else {
        // 距「上一次應該公布」多久：公布時刻前 ⇒ 從前一交易日的公布時刻算起
        const _ph = publishHourOf(spec);
        let sincePubMs = null;
        if (_ph != null) {
          const t3 = taipeiNow();
          const nowH = t3.getHours() + t3.getMinutes() / 60;
          const base = nowH >= _ph ? isoOf(t3) : prevTradingDay(isoOf(t3));
          sincePubMs = Math.max(0, Date.now()
            - new Date(`${base}T${String(Math.floor(_ph)).padStart(2, '0')}:00:00+08:00`).getTime());
        }
        const limit = effectiveMaxStale(spec, marketOpen, tradingToday, offHoursMs, sincePubMs);
        if (Date.now() - ts > limit) {
          out.status = 'STALE';
          const fmt = ms => (ms >= HOUR ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / MIN)}m`);
          out.notes.push(`陳舊 ${fmt(Date.now() - ts)}（上限 ${fmt(limit)}${spec.session === 'intraday' && !marketOpen ? '·收盤後放寬' : ''}）`);
        }
      }
    }

    // ⚠ 筆數閘門也要看發布時刻：dated 類的當日文件是**分批長出來的**
    //   （15:10 上市收盤、16:45 上櫃併入、21:45 資券）。14:57 去看 chipArchive
    //   只有上市那半 1,091 檔 ⇒ 每天下午都會報 THIN，又是一個常態假警報。
    //   當日文件尚未完成時只記事實、不判 THIN；隔天它還是不足才算異常。
    // ⚠ 只能有**一份** pubHour 定義：第一版在這裡又寫了一份 15.5，而日期閘門
    //   那份已改成 16.75 ⇒ 兩道閘門用不同的時刻，筆數閘門照樣誤報（實測）。
    //   共用 publishHourOf()。
    const _tN = taipeiNow();
    const _pubH = publishHourOf(spec);
    const _partialToday = _pubH != null && out.dataDate === isoOf(_tN)
      && (_tN.getHours() + _tN.getMinutes() / 60) < _pubH;
    if (spec.minRecords != null && out.records != null && out.records < spec.minRecords) {
      if (_partialToday) out.notes.push(`當日文件尚在寫入（${out.records} 筆，${_pubH}:00 後才完整）`);
      else {
        out.status = out.status === 'OK' ? 'THIN' : out.status;
        out.notes.push(`筆數 ${out.records} < 下限 ${spec.minRecords}`);
      }
    }
    // 空榜有兩種，必須分開（2026-08-29）：
    //   · **濾網成立但當日沒有標的**——doc 自己寫了原因（gate/reason），是正常結果
    //     （實例：swingPicks 的 `gate: '✅今日為空頭日…此訊號的有效市況'`）
    //   · **計算失敗或來源斷掉**——什麼都沒說，那才是故障
    // 比在契約表逐條加 allowEmpty 好：規則變成「空榜必須自己解釋」，
    // 而不是由稽核設定去猜哪些榜可以空。
    const emptyReason = data?.gate || data?.reason || data?.emptyReason || null;
    if (out.records === 0 && !spec.allowEmpty) {
      if (emptyReason) out.notes.push(`空榜（已說明）：${String(emptyReason).slice(0, 60)}`);
      else { out.status = 'EMPTY'; out.notes.push('筆數 0（且未說明原因）'); }
    }
    // ── 第四道：市場組成 ────────────────────────────────────────────────
    // 「總筆數夠」不等於「每個市場都在」。上櫃整批消失時總筆數仍有 1,229，
    // 前三道閘門全部放行，站上卻已經看不到任何上櫃股（漲停榜、選股、搜尋全缺）。
    if (spec.markets && data) {
      try {
        const raw = data[spec.markets.field];
        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (obj && typeof obj === 'object') {
          const cnt = {};
          for (const v of Object.values(obj)) { const m = v?.market || 'unknown'; cnt[m] = (cnt[m] || 0) + 1; }
          out.markets = cnt;
          for (const [mk, lo] of Object.entries(spec.markets.min)) {
            if ((cnt[mk] || 0) < lo) {
              out.status = out.status === 'OK' ? 'MARKET_GAP' : out.status;
              out.notes.push(`市場 ${mk} 只有 ${cnt[mk] || 0} 檔 < 下限 ${lo}（整個市場可能已從站上消失）`);
            }
          }
        }
      } catch { out.notes.push('市場組成無法解析'); }
    }

    // 第三道閘門：dataDate 漂移
    if (out.dataDate && spec.session !== 'always') {
      // ⚠ 傍晚才公布的來源，在公布時刻前「落後一天」是正常的，不是故障
      //   （2026-08-27）：當沖統計約 20:00、資券 21:45 才上架，而稽核固定
      //   16:10 跑 ⇒ 這兩個來源**每天下午都紅**。常態紅燈的代價是分不出
      //   「還沒公布」與「真的壞了」——dayTradeRatio 實際上從 08-17 起斷了
      //   8 天沒人察覺，正是被自己的常態紅燈蓋過去。公布時刻前把期待值退一個
      //   交易日，紅燈才重新有訊息量。同一招 probeFresh 已經在用（publishHour）。
      const tNow = taipeiNow();
      // session:'daily' 的定義就是「每日**收盤後**更新」，而自家的每日歸檔跑在
      // 15:10（官方補抓 16:30、資券 21:45）。所以 13:30 收盤到 15:10 之間，
      // 這些來源**理應**還是昨天的——那不是故障。
      // 不給預設值的話，每天這 100 分鐘手動跑稽核會看到十幾個假警報
      // （2026-08-28 14:57 實測：14 個異常，全部是「資料日昨天 < 期待今天」），
      // 而假警報會訓練人忽略紅燈——dayTradeRatio 斷 8 天就是這樣被蓋住的。
      // 晚於 15:30 才發布的來源（當沖統計 21、資券 22）自己覆寫這個預設。
      const pubHour = publishHourOf(spec);
      const beforePub = pubHour != null && ltd === isoOf(tNow)
        && (tNow.getHours() + tNow.getMinutes() / 60) < pubHour;
      const expect = beforePub ? prevTradingDay(ltd) : ltd;
      // ⚠ 閘門原本只擋「太舊」，於是**資料日晚於最近交易日反而通過**——
      //   那是不可能的日期（實測週六有 4 個來源自稱資料日 2026-08-29），
      //   而且正是「拿日曆今天當資料日」的特徵。兩個方向都要擋。
      if (out.dataDate > maxDataDate) {
        out.status = 'DATE_DRIFT';
        out.notes.push(`資料日 ${out.dataDate} **晚於**可能的最新資料日 ${maxDataDate}——不可能的日期，多半是拿日曆今天當資料日`);
      } else if (out.dataDate < expect) {
        out.status = 'DATE_DRIFT';
        out.notes.push(`資料日 ${out.dataDate} < 期待 ${expect}${beforePub ? `（${pubHour}:00 前以前一交易日為準）` : ''}`);
      } else if (beforePub) {
        out.notes.push(`今日 ${pubHour}:00 後才公布，現以 ${expect} 為準`);
      }
    }
    if (!out.dataDate && spec.session === 'daily') out.notes.push('無資料日欄位（無法偵測日期漂移）');
  } catch (e) {
    out.status = 'ERROR';
    out.notes.push((e.message || '').slice(0, 60));
  }
  return out;
}


// ── chipArchive 的**欄位級**稽核（2026-08-10 新增）────────────────
// ⚠**一份文件裝了五個資料源**（收盤/法人/資券/借券/當沖），舊契約只驗 closeJson 的筆數，
//   於是 lendingJson 與 dayTradeJson 整整缺 21 個交易日、instJson 缺了整個上市市場 14 天，
//   稽核全程顯示 ✅——**資料源在契約表裡不等於它受保護，受保護的只有你真的去數的那個欄位**。
// 每個欄位另帶 publishHour（收盤後才出）與 sample（必須存在的代表股，用來抓「只有半個市場」）。
const ARCHIVE_FIELDS = [
  // ⚠ 14.5 太早（2026-08-28 更正）：15:10 只寫上市，**上櫃要 16:45 才併入**
  //   ⇒ 14:30~16:45 之間一定只有 1,0xx 檔，每天報 THIN。改 17。
  { f: 'closeJson',    label: '收盤',  min: 1500, publishHour: 17 },
  // ⚠ 15.5 太早（2026-08-28 15:45 實測仍只有 792/1867）：T86 實際 15:00~16:00
  //   才發完，自家的官方補抓也排在 16:30。與外部探針法人T86 的 16 一致，設 16.5。
  { f: 'instJson',     label: '法人',  min: 1500, publishHour: 16.5, sample: ['2330', '6274'] },  // 上市+上櫃各一
  { f: 'marginJson',   label: '資券',  min: 1500, publishHour: 21.5, sample: ['2330', '6274'] },
  { f: 'lendingJson',  label: '借券',  min: 1000, publishHour: 21.5 },
  // ⚠ 16 是錯的（2026-08-27 更正）：TWTB4U 的**資格清單**盤前就有，但
  //   「當日沖銷交易成交股數」統計要到傍晚才上架——實測首次抓到是 20:17／
  //   20:20／20:43。設 16 等於每天 16:00~20:20 之間必報 MISSING，紅燈變常態、
  //   蓋掉真正的斷檔（dayTradeRatio 就這樣斷了 8 天沒被看見）。
  { f: 'dayTradeJson', label: '當沖',  min:  500, publishHour: 21 },
];

async function auditArchiveFields(db, tpeNow) {
  const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(6).get();
  const docs = snap.docs.map(d => ({ id: d.id, data: d.data() }));
  const out = [];
  for (const spec of ARCHIVE_FIELDS) {
    // 未到公布時刻就跳過「今天」，改看最近一個應該已完成的日子
    const hour = tpeNow.getHours() + tpeNow.getMinutes() / 60;
    const cand = docs.filter((x, i) => !(i === 0 && x.id === isoDate(tpeNow) && hour < spec.publishHour));
    const t = cand[0];
    if (!t) { out.push({ name: spec.label, status: 'SKIP', note: '尚無可驗日' }); continue; }
    let m = {};
    try { m = JSON.parse(t.data[spec.f] || '{}'); } catch { /* 壞 JSON 視為空 */ }
    const n = Object.keys(m).length;
    const missSample = (spec.sample || []).filter(c => !m[c]);
    // 連續缺漏天數（只看應已完成的日子）——抓「回補完沒接每日更新」那類慢性腐爛
    let streak = 0;
    for (const x of cand) { let k = 0; try { k = Object.keys(JSON.parse(x.data[spec.f] || '{}')).length; } catch { k = 0; } if (k >= spec.min) break; streak++; }
    const status = n === 0 ? 'MISSING' : n < spec.min ? 'THIN' : missSample.length ? 'HALF_MARKET' : 'OK';
    out.push({
      name: spec.label, status, records: n, date: t.id,
      note: status === 'HALF_MARKET' ? `缺代表股 ${missSample.join('/')}（可能只有半個市場）`
          : status === 'THIN' ? `僅 ${n} < 門檻 ${spec.min}`
          : status === 'MISSING' ? `欄位不存在或為空${streak > 1 ? `·已連續 ${streak} 日` : ''}` : '',
    });
  }
  return out;
}

// ── 非每日歸檔的新鮮度（2026-08-10 補）──────────────────────────────
// chipArchive 那組閘門全都假設「每個交易日一份」。集保是**每週**、月營收是**每月**，
// 套日頻門檻只會天天誤報，所以先前它們根本沒被納入稽核 —— 於是
// majorHolders 每週覆蓋、revenue 每月覆蓋這兩件事，稽核從頭到尾都是綠燈。
// 這裡用「最新一份的資料日離今天多久」這一道，週期資料才有對應的保護。
const PERIODIC_ARCHIVES = [
  { c: 'tdccArchive',    label: '集保股權分散(週)', maxDays: 12, minN: 800,
    note: '官方只保留 51 週且無批次歷史端點 → 斷一週就永久缺一週' },
  { c: 'revenueArchive', label: 'MOPS月營收(月)',   maxDays: 70, minN: 1700,
    note: '每月 10 日前公布上月；<1700 檔代表只有 openapi 薄版，需 MOPS 彙總表加厚' },
];

async function auditPeriodic(db) {
  const out = [];
  for (const spec of PERIODIC_ARCHIVES) {
    // ⚠ 不要用 `.orderBy('__name__','desc')` —— Firestore 對 document id 的降冪排序
    //   需要單獨建索引，會直接丟 FAILED_PRECONDITION。這兩個集合是週/月頻，
    //   總量只有幾十份，`select('n')` 全取回來在本地排序反而更省事也不需索引。
    let docs = [];
    try {
      const snap = await db.collection(spec.c).select('n').get();
      docs = snap.docs.slice().sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 1);
    } catch (e) { out.push({ name: spec.label, status: 'ERROR', note: e.message }); continue; }
    if (!docs.length) { out.push({ name: spec.label, status: 'MISSING', note: '完全沒有歸檔' }); continue; }
    const d = docs[0];
    // doc id 是 YYYY-MM-DD（週）或 YYYY-MM（月）；月份補成當月 1 日再比。
    const idDate = d.id.length === 7 ? `${d.id}-01` : d.id;
    const ageDays = Math.floor((Date.now() - new Date(`${idDate}T00:00:00+08:00`).getTime()) / 86400000);
    const n = d.data()?.n ?? 0;
    const status = ageDays > spec.maxDays ? 'STALE' : (n < spec.minN ? 'THIN' : 'OK');
    out.push({ name: spec.label, status, latest: d.id, ageDays, n, note: status === 'OK' ? '' : spec.note });
  }
  return out;
}

async function main() {
  const ltd = await lastTradingDay();
  const t = taipeiNow();
  const mins = t.getHours() * 60 + t.getMinutes();
  const marketOpen = t.getDay() !== 0 && t.getDay() !== 6
    && isoOf(t) !== null && mins >= 8 * 60 + 30 && mins <= 13 * 60 + 40
    && ltd === isoOf(t);
  const specs = ONLY ? CONTRACTS.filter(s => s.c === ONLY) : CONTRACTS;
  const results = [];
  // ⚠ ltd 是「最後一個**完成**的交易日」。盤中時它還是昨天/上週五，
  //   不能拿它當「資料日的上限」，也不能拿它判斷「今天是不是交易日」：
  //   2026-08-31（週一）盤中實測，兩個錯誤同時發生——
  //     ① dayTradeEligible / morningNote 正確帶著今天的日期，
  //        卻被「資料日晚於最近交易日」判成 DATE_DRIFT（假警報）
  //     ② offHoursMs 把盤中當成非交易時間、放寬 67 小時，
  //        於是 limitUpRecommend 已經 65 小時沒更新卻顯示 OK（**真問題被蓋掉**）
  //   改用日曆判斷「今天是不是交易日」，與「最後一個完成交易日」分開。
  const todayIso = isoOf(taipeiNow());
  const isTradingToday = await (async () => {
    const t = taipeiNow();
    if (t.getDay() === 0 || t.getDay() === 6) return false;
    try {
      const d = (await db.collection('system').doc('tradingCalendar').get()).data();
      return !(Array.isArray(d?.holidays) && d.holidays.includes(todayIso));
    } catch { return true; }   // 取不到日曆時保守視為交易日（不放寬）
  })();
  // ⚠ 兩個判準**不能共用**（2026-08-31 我先合併成一個，結果把週末放寬也關掉了）：
  //   · maxDataDate 看「今天是不是交易日」→ 是就允許資料日是今天
  //     （否則盤中產出的 dayTradeEligible／morningNote 會被誤判為未來日期）
  //   · offHoursMs 看「**今天的資料產出了沒**」→ 週一早上收盤後類的資料
  //     最新本來就是週五的，那 60~70 小時是正常的（使用者指正）
  //     ⇒ 用 ltd === 今天 判斷，而不是「今天是不是交易日」
  const tradingToday = ltd === todayIso;
  // 資料日的合理上限：交易日當天可以是今天，非交易日則以最後完成交易日為準
  const maxDataDate = isTradingToday ? todayIso : ltd;
  // 上一個交易日收盤（13:30 台北）到現在，累積了多少非交易時間。
  // 交易日當天為 0 ⇒ 不影響平日的偵測力。
  const offHoursMs = (() => {
    if (isTradingToday || !ltd) return 0;
    const [y, m, d] = ltd.split('-').map(Number);
    const closeUtc = Date.UTC(y, m - 1, d, 13 - 8, 30);   // 台北 13:30 → UTC
    return Math.max(0, Date.now() - closeUtc);
  })();
  for (const s of specs) results.push(await auditOne(s, ltd, marketOpen, tradingToday, offHoursMs, maxDataDate));

  const external = NO_EXT ? [] : await probeExternal(ltd);
  const fresh = NO_EXT ? [] : await probeFresh(ltd);

  // ── 稽核完整性防護（wm-ci-guardrails「0 assertions 即 fail」·2026-09-04）──
  // 契約表被清空、或 probe 整批異常跳過時，稽核會「全綠」——因為根本沒檢查幾個。
  // ⚠ 刻意**不改 exit code**：daemon 對本腳本是「成功才標記、失敗每 5 分鐘重試」，
  //   exit 1 會讓它整天重跑完整稽核（含外部 probe）。防護放在標記層：
  //   dataHealth 帶 auditIncomplete，daemon 告警段據此吼出來（見 ai-daemon 16:10 段）。
  const MIN_SOURCES = 60;                       // 2026-09-04 現況 72；低於此值＝範圍異常
  const auditIncomplete = results.length < MIN_SOURCES;
  if (auditIncomplete) console.log(`\n❌ 稽核範圍異常：只檢查了 ${results.length} 個資料源（下限 ${MIN_SOURCES}）——契約表或 probe 流程有問題，本次「全綠」不可信`);

  if (WRITE) {
    const badN = results.filter(r => r.status !== 'OK').length;
    const extBad = external.filter(r => r.status !== 'OK').length;
    await db.collection('system').doc('dataHealth').set({
      updatedAt: Date.now(), date: ltd,
      auditIncomplete, sourceCount: results.length, minSources: MIN_SOURCES,
      total: results.length, healthy: results.length - badN, unhealthy: badN,
      externalTotal: external.length, externalUnhealthy: extBad,
      results, external, fresh,
    });
    console.log(`[audit] ✓ 已寫入 system/dataHealth（內部異常 ${badN}、外部異常 ${extBad}）`);
  }

  // ── daemon 是否落後於程式碼 ──────────────────────────────
  // 改了 ai-daemon.mjs 卻忘了重啟，daemon 會**靜默跑舊碼**：
  // 沒有錯誤、沒有告警，只是修正沒有生效（2026-08-30 實際發生過一次）。
  // ⚠ 用**內容雜湊**而非 mtime：git checkout / touch 這類不改內容的操作
  //   也會更新 mtime ⇒ 假警報。我第一版就是 mtime，寫完當場誤報。
  try {
    const { readFileSync } = await import('node:fs');
    const { createHash } = await import('node:crypto');
    const cur = createHash('sha256')
      .update(readFileSync(new URL('./ai-daemon.mjs', import.meta.url))).digest('hex').slice(0, 16);
    const b = (await db.collection('system').doc('daemonBuild').get()).data();
    if (!b?.codeHash) {
      console.log('\n⚠ 無 daemon 版本紀錄（system/daemonBuild）——無法確認跑的是不是最新碼');
    } else if (b.codeHash !== cur) {
      console.log(`\n⚠ **daemon 落後於程式碼**：執行中 ${b.codeHash}／磁碟上 ${cur}`);
      console.log('   ⇒ 修正尚未生效。先跑 scripts/can-restart-daemon.mjs，再 launchctl kickstart -k gui/501/com.gmii.twstock.ai-daemon');
    }
  } catch { /* 取不到不擋稽核 */ }

  if (AS_JSON) { console.log(JSON.stringify({ lastTradingDay: ltd, results, external }, null, 2)); process.exit(0); }

  const RANK = { ERROR: 0, MISSING: 1, EMPTY: 2, DATE_DRIFT: 3, STALE: 4, THIN: 5, OK: 9 };
  results.sort((a, b) => (RANK[a.status] ?? 8) - (RANK[b.status] ?? 8) || a.collection.localeCompare(b.collection));

  console.log(`\n稽核基準：最近一個完整交易日 = ${ltd}｜盤中時段 = ${marketOpen ? '是' : '否（盤中類 maxStale 放寬）'}\n`);
  const bad = results.filter(r => r.status !== 'OK');
  for (const r of results) {
    const icon = r.status === 'OK' ? '✅' : r.status === 'THIN' ? '🟡' : '❌';
    const age = r.ageMin != null ? `${r.ageMin < 90 ? r.ageMin + 'm' : Math.round(r.ageMin / 60) + 'h'}` : '—';
    const rec = r.records != null ? String(r.records) : '—';
    console.log(`${icon} ${r.collection.padEnd(22)} ${r.status.padEnd(11)} age=${age.padEnd(6)} n=${rec.padEnd(6)} date=${(r.dataDate || '—').padEnd(11)} ${r.notes.join('；')}`);
  }
  {
    const tpeNow = new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60000);
    const af = await auditArchiveFields(db, tpeNow);
    const pa = await auditPeriodic(db);
    for (const r of pa) console.log(`[週期歸檔] ${r.status.padEnd(8)} ${r.name}｜最新 ${r.latest ?? '—'}｜${r.ageDays ?? '?'} 天前｜${r.n ?? 0} 筆 ${r.note || ''}`);
    console.log('\n── chipArchive 欄位級（一份文件＝五個資料源，逐欄驗）──');
    for (const e of af) {
      const icon = e.status === 'OK' ? '✅' : e.status === 'SKIP' ? '⏭' : '❌';
      console.log(`${icon} ${e.name.padEnd(6)} ${String(e.status).padEnd(12)} n=${String(e.records ?? '—').padEnd(6)} date=${(e.date || '—').padEnd(11)} ${e.note}`);
      if (!['OK', 'SKIP'].includes(e.status)) bad.push({ status: e.status, collection: `chipArchive.${e.name}` });
    }
  }
  if (fresh.length) {
    console.log('\n── 生產路徑（可指定日期＋回音驗證）──');
    for (const e of fresh) {
      const icon = e.status === 'OK' ? '✅' : '❌';
      console.log(`${icon} ${e.name.padEnd(14)} ${e.status.padEnd(9)} n=${String(e.records ?? '—').padEnd(6)} date=${(e.feedDate || '—').padEnd(11)} ${e.note}`);
    }
  }
  if (external.length) {
    console.log('\n── openapi 鏡像對照組（已知落後，不是生產路徑）──');
    for (const e of external) {
      const icon = e.status === 'OK' ? '✅' : e.status === 'NO_DATE' ? '🟡' : '❌';
      console.log(`${icon} ${e.name.padEnd(10)} ${String(e.status).padEnd(9)} n=${String(e.records ?? '—').padEnd(6)} date=${(e.feedDate || '—').padEnd(11)} ${e.note}`);
    }
  }
  // ── 欄位命名契約（防 archivedAt/fetchedAt 相撞再犯；違規不擋稽核但一定要吼出來）──
  try {
    const fieldProblems = checkFieldConventions();
    if (fieldProblems.length) { console.log(`\n❌ 欄位命名契約 ${fieldProblems.length} 項違規：`); for (const fp of fieldProblems) console.log('  ' + fp); }
    else console.log('\n✓ 欄位命名契約：無未登記欄位名');
  } catch (e) { console.log('⚠ 欄位命名契約檢查失敗：', e.message); }

  console.log(`\n總計 ${results.length} 個資料源：正常 ${results.length - bad.length}、需處理 ${bad.length}`);
  const byStatus = {};
  bad.forEach(r => { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
  if (bad.length) console.log('  ' + Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join('、'));
  process.exit(0);
}

main().catch(e => { console.error('[audit] 失敗:', e.message); process.exit(1); });
