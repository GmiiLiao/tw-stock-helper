@AGENTS.md

# 台股助手 tw-stock-app

Next.js 15 App Router + React 19 + zustand + Firebase（Auth / Firestore / App Hosting）。
80 支 API route、33k 行 TS/TSX。

> **版控歸屬（進場先看）**：本專案的 git 根是 `tw-stock-app/` 本身，不是家目錄。
> 先跑 `git rev-parse --show-toplevel` 確認輸出是 `.../股票助手app/tw-stock-app`。
> 若輸出是 `/Users/gmii` 代表 `.git` 不見了 —— **先問人，不要 git init**。
> 2026-07-31 之前的歷史在家目錄那份 repo，查法與規則見 [`docs/REPO-LAYOUT.md`](docs/REPO-LAYOUT.md)。

## 三層架構 —— 先理解這個，否則會改錯地方

```
本機 daemon（台灣 IP）          scripts/ai-daemon.mjs，LaunchAgent 常駐
  │  打 TWSE MIS / Yahoo / openapi，有 pacing
  ▼
Firestore（marketSnapshot / marketIntraday / bookDepth / chipDaily / 各 latest doc）
  ▼
Next.js on Firebase App Hosting（us-central1）
  │  只讀 Firestore 快照
  ▼
瀏覽器
```

**Cloud Function 在 us-central1，美國 IP 已被 mis.twse.com.tw 封鎖**
（`src/lib/twse-api-server.ts:929-931`、`src/app/api/twse/market-index/route.ts:10-11` 都有註解）。
所以 web 層直打 MIS 的路徑只是 fallback，實際上必然失敗 —— 但它們還在，而且沒有開關。
新增功能時**不要**再從 route 直接打上游，一律走 daemon → Firestore。

## 唯一不變式

> 對上游的請求數，必須與線上人數**脫鉤**。

1 人在線和 10,000 人在線，打給 TWSE / Yahoo 的請求數應該一模一樣。
任何讓「使用者多一個，上游請求就多一次」的改動都是 bug，不論它看起來多合理。

判斷方式：新增一條路徑時問自己「1000 個使用者同時觸發這個，會打幾次上游？」
答案不是常數就要重做。

## 硬約束

| 項目 | 數值 | 後果 |
|---|---|---|
| TWSE MIS rate limit | 每 5 秒 3 個 request | 超過鎖 IP，**封鎖時長無人證實** |
| MIS 更新節奏 | 5 秒 | 輪詢快過 5 秒沒有資訊增益 |
| 交易時段 | 09:00–13:30（盤前試撮 08:30） | 其餘 81% 的時間資料不會變 |
| `firebase.json` `maxInstances` | 5 × 併發 80 = 約 400 in-flight | 破口約 200–400 個同時在線使用者 |
| function timeout | 120 秒 | 上游 hang 會佔滿 worker → 全站 503 |
| serving region | `asia-east1`（台灣彰化，2026-07-31 由 us-central1 遷移完成） | 實測 API TTFB 0.60s→0.18s |
| `ALLOW_DIRECT_MIS` | 預設關閉 | **不要打開**，理由見下 |
| `openapi.twse.com.tw` 鏡像 | **整批固定落後一個交易日** | 見下，這是本專案最常重演的一類 bug |

### ⚠ openapi 鏡像落後一日 —— 實測，不是猜測

2026-07-31 全站量測（`node scripts/audit-data-sources.mjs`）：

| 端點 | 用途 | 自報日期 | 落後 |
|---|---|---|---|
| `MI_INDEX` | 指數收盤 | 2026-07-30 | **1 天** |
| `STOCK_DAY_ALL` | 個股收盤 | 2026-07-30 | **1 天** |
| `BWIBBU_ALL` | 殖利率 | 2026-07-30 | **1 天** |
| `t187ap03_L` | 發行股數（週轉率用） | 2026-07-30 | **1 天** |
| `MI_MARGN`／`SBL/TWT96U` | 融資融券／借券 | — | **無日期欄位＝無法驗證** |

> **補充實證（2026-08-11）——「落後一日」不等於「沒有當日來源」**：
> `BWIBBU_ALL` 的 **rwd 端點給的是當日資料**，只是它有兩個怪癖：
> ① **完全忽略 `date` 參數**（帶明天或三週後都照樣 `stat=OK` 回同一份）→ 不能拿來查歷史；
> ② **`date` 欄是「今天的日曆日」（服務日），`title` 開頭的民國日期才是資料日。**
>
> ⚠ ② 這條在 2026-08-11 被我寫反過（原文寫「date 欄才是真正的資料日」），2026-08-12 更正。
> 錯的原因值得記：那次是**收盤後**測的，當天收盤已發布 ⇒ 服務日恰好等於資料日，
> 兩個欄位看起來都對，我挑了錯的那個。盤中再測就露餡：
> `date=20260812`、`title=115/08/11`，而內容經數值反推是 08-11 的。
> 佐證：req 帶 20260805／20260701／20261231，回傳 `date` 一律 20260812、
> `title` 一律 115/08/11、PBR 一字不差 ⇒ `date` 與請求和內容都無關，純粹是服務日。
> **教訓：驗「日期欄位」要挑資料日≠今天的時段測（盤中或休市日），
> 收盤後測會讓兩個欄位重合，等於沒驗。**
>
> 我一度據此判定「rwd 與 openapi 是同一份」——**是錯的**。
> 驗證方法值得記住：**用數值反推，不要看欄位名**。PBR ∝ 價格，故
> `PBR(rwd)/PBR(openapi)` 應等於 `收盤(今日)/收盤(昨日)`，實測 9 檔全部吻合到小數第三位。
> 站上的本益比/殖利率/股價淨值比原本打 openapi ⇒ **一直顯示昨天的**，已改 rwd PRIMARY。
> 同批查證：`MI_MARGN` 的 openapi **沒有落後**（與自家歸檔相符 1,016 檔）。

> **另一類同源事故（2026-08-11）——端點身分沒驗證**：
> `exchangeReport/TWT48U_ALL` 是**除權息預告表**，卻被當成「注意股」用了數月
> （線上 133 檔注意股裡 105 檔是假的）；`opendata/t187ap10_L` 是**月營收連續不足名單**
> （出表日期停在 2021），卻被當成「處置股」⇒ 解析恆為空，**真正的上市處置股完全沒被偵測**。
> 兩者能存活的共同原因是 `reason` 有寫死的 fallback `|| '列為注意股票'`：
> 欄位對不上時程式不會壞，只會安靜地印出一句像模像樣的話。
> ⇒ **不要給資料欄位捏造預設值**；缺關鍵欄位就跳過或明說「來源未提供」。
> 注意股／處置股的抓取解析已統一到 `src/lib/risk-stocks-source.ts`，不要再複製第三份。

**規矩**：新增任何 openapi 消費端時
1. **一律假設它是舊的**。要當日資料就用 `www.twse.com.tw/rwd/...?date=YYYYMMDD`（可指定日期且即時）當 PRIMARY，openapi 只當 FALLBACK。
2. **一定要讀它自報的日期欄位並比對**（回音驗證）。`STOCK_DAY_ALL` 有做，`MI_INDEX` 沒做 → 2026-07-31 站上顯示的加權指數整整慢一天、差 3,186 點。
3. 寫進 Firestore 時，`date` 欄位一律填**來源自報的資料日**，不是 `Date.now()`。填錯的話健康稽核會失明。

### ⚠ 為什麼 region 改台灣之後反而更要小心

`twse-api-server.ts` 有幾條**直打 `mis.twse.com.tw` 且沒有 memoize、沒有合流**的路徑
（`callMIS()`、指數的 Strategy 1）。過去在 us-central1 是「安全地壞著」——
美國 IP 被 TWSE 封鎖，每次都失敗、落到 Firestore 快照，所以沒人發現它們違反唯一不變式。

搬到台灣之後這些路徑會**開始成功**：1000 個使用者＝1000 次直打，
而 MIS 限制是每 5 秒 3 個 request → 伺服器 IP 被封，且封鎖時長無人證實。

所以它們現在由 `ALLOW_DIRECT_MIS` 總開關擋著，預設 `false`。
即時報價的唯一合法來源仍是常駐 daemon（台灣 IP、有 pacing）寫進 Firestore 的 `marketSnapshot`。

## 寫程式時的規矩

**快取一律走 helper，不要手寫 `let cached; let cachedAt;`**

```ts
import { memoize } from '@/lib/singleflight';
const getFoo = memoize('foo', 15_000, async () => { ... });
```
`singleflight` 同時處理三件事：TTL 快取、in-flight 合流（N 個併發只打 1 次上游）、
失敗負快取（上游掛掉時不會變成每個 request 都重打）。手寫的版本這三項都會漏。

**Cache-Control 走層級表，不要自己寫字串**

```ts
import { cacheHeader, json, latestDoc } from '@/lib/api-cache';
export const GET = () => latestDoc('adrPremium', 'daily');   // 讀 daemon latest doc 用這個
```
層級：`tick`(3s) / `quote`(10s) / `intraday`(2m) / `daily`(1h) / `static` / `private`。
`no-store` 只給真正 per-user 的資料。**daemon 每日寫一次的資料回 `no-store` 是純浪費。**

**交易時段只有一個真相來源**

```ts
import { getSession, isMarketOpen, pollInterval } from '@/lib/market-clock';
```
不要再寫 `h >= 9 && h < 14`。舊 codebase 有 6 份互相不一致的實作，其中 5 份不查假日。

**休市日曆（2026-07-31 接上）**：`market-clock` 的 `holidays` 表預設是空的（fail-open 只擋週末），
由 `page.tsx` 開機時打 `/api/market-clock` 填入。權威來源是 Firestore `system/tradingCalendar`，
由 `scripts/sync-trading-calendar.mjs` 產生（daemon 每日 06:40 跑一次）。

它合併兩個來源，**缺一不可**：
- 證交所官方休市日程表 —— 前瞻性，但只有表訂休市
- 自家 `chipArchive` 空洞反推 —— 颱風假等**臨時休市**，官方表不會有
  （2026 上半年就有 5 天：03-10、03-13、03-25、05-20、07-10）

⚠ 官方表裡「國曆新年開始交易日」「農曆春節前/後最後/開始交易日」是**交易日標記不是休市**；
而「市場無交易，僅辦理結算交割作業」字面有「交易」兩字卻**是休市**。
分類規則是 `/開始交易|最後交易/` 才排除 —— 已用自家歸檔全量對帳，2026 年 27 筆 100% 相符。

**前端輪詢：現況是「加 gate」，不是「換 hook」**

現行做法 —— 在既有的 poll function 第一行加一道 gate，計時器照跑但不發請求：

```ts
import { shouldPollNow } from '@/lib/market-clock';

const poll = async () => {
  if (!shouldPollNow()) return;   // 休市 or 分頁在背景 → 跳過
  ...
};
```

只擋背景分頁、休市仍要更新的資料（美股、daemon 產出）用 `isForeground()`。

**進度：26 個含 `setInterval` 的檔案裡，目前只有 3 個接上 gate**
（`AlertEngine` / `Header` / `AiNewsTicker`，加上 `lib/useLiveQuotes.ts` 用遞迴 setTimeout）。
其餘 23 個清單在 `docs/OPTIMIZATION-TODO.md`。新增輪詢時請直接加 gate。

`src/hooks/useSharedPoll.ts` 是**已寫好但尚未採用**的替代方案（目前零呼叫點）。
它多做的是：多元件共用一條輪詢、間隔每次重算、失敗指數退避、jitter。
當你遇到「同一支 API 被多個元件各自輪詢」時才值得換過去 —— 單純為了統一而重寫不划算。
換的時候路徑是 `@/hooks/useSharedPoll`（不是 `@/lib/`）。

## 絕對不要做的事

- **`?t=${Date.now()}` 或 `cache: 'no-store'`** 加在 GET API 上 —— CDN 會 100% miss。
  這是本專案歷史上最貴的單一錯誤。
- **`setInterval(load, isTradingHours() ? A : B)`** —— 三元判斷只在掛載時算一次，之後永不重算。
- **`useAppStore()` 不帶 selector** —— zustand v5 會比對整個 state，任何 `set()` 都重繪整棵樹。
  一律 `useAppStore(s => s.xxx)`。
- **`fetch()` 不設 timeout** —— 上游 hang 會佔住 worker 到 120 秒。一律 `AbortSignal.timeout(8000)`。
- **在 server 端 import `@/lib/firebase`（client SDK）** —— 用 `getAdminDb()`。
- **`{items.map(...)}` 直接渲染全市場清單** —— 1,700 個 tile 會讓低階手機捲不動。先 `.slice()`。
- **搜尋/輸入框寫成受控（`value={state}`）而父層又會頻繁重渲染** —— 手機 IME 下
  React 每次回寫 `value` 都會把**游標打回開頭**，後續字元插在最前面：
  輸入 `3008` 變成 `8003`（2026-08-11 使用者回報）、`2527` 變 `7252`（更早一次）。
  **這個錯誤已經發生兩次**：第一次只修了 Header，沒推廣到其他輸入框。
  ⇒ 規則：**任何文字輸入框，只要它所在的元件樹會被輪詢/計時器驅動重渲染，
    一律用非受控**（`defaultValue` + `ref`），state 只餵搜尋邏輯；
    需要程式化顯示值（例如選取後填入「3008 大立光」）時用 `ref.current.value = ...`。
  目前已改為非受控：Header、Portfolio（記錄持倉）、WatchlistTracker（即時追蹤）、AdminPanel。
- **從 request body 讀 `uid`/`email` 拿來做授權判斷** —— 等於呼叫端自己宣告自己是管理員。
- **以為「重啟 daemon 沒有副作用」** —— `_lastLive`（今日已掃到的即時價）是純記憶體的，
  重啟即清空，於是**全市場安靜地退回昨日收盤**，每檔都要等 MIS 再回一筆真成交才復活
  （misBatch 刻意不拿掛單價充數，冷門股可能數十分鐘）。
  2026-07-17 出過一次（當時只延長掃描窗，沒解決失憶本身），2026-08-12 再度發生：
  我在開盤前 10 分鐘重啟，使用者立刻回報「友達的價格怎麼沒有即時更新」，2409 到 09:23 才復活。
  ⇒ 已加 `restoreLastLive()`（開機從快照接回今日 live 價，實測還原 868 檔、live 數無下探）。
  ⇒ 仍請**避免在 08:30~09:10 之間重啟**；本輪重啟造成的資料代價已經是第三次
    （bookDepthArchive 當日資料、chipArchive 空殼、即時價失憶）。
- **直接 `chipArchive.orderBy('date','desc')` 然後用 `arch[0]`** —— 當日文件是**分批**長出來的
  （15:10 收盤、15:00 後法人、21:45 資券），而且 daemon 一重啟就會在盤前跑一次歸檔，
  所以整個交易日的 00:00~15:10 之間第一筆很可能是**空殼**（只有 date/at/market）。
  後果有兩種，都不會讓程式壞掉：① `arch[0].instJson` → undefined → 法人整片變 0；
  ② `arch.map(a => a.closeJson ? … : {})` → `maps[0]` 變空物件，**之後每一天往後位移一格**
  ——「5 日均量」變成 4 天＋1 空白、「昨收」指到前天。
  **這個錯誤已經發生兩次**（2026-07-20 實案 n=0 只修了一處，2026-08-12 又在三處出現）。
  ⇒ 一律走 `readArchive(limit, field)`，並按需要的欄位取「最近一個有該欄位的日子」。
  ⇒ 寫入端同理：**沒有任何實料就不要建文件**，空殼比沒有文件更難察覺。
- **把 `isoDate(taipei())`（日曆今天）當成「資料日」印給使用者** —— 盤前與盤後未歸檔時
  兩者差一天，畫面就會寫「資料日 今天」而內容是昨天的收盤。
  ⇒ 資料日一律走 `boardDataDate(tw, marketOpen)`，它分三段：盤中＝今天、
    13:30~15:10 已收盤未歸檔＝**今天**（這格退回昨天就是回歸性錯誤）、其餘＝最近歸檔日。
  ⇒ 也**不要拿 `liveDay` 當「是否盤中」的標籤**：它的定義是「歸檔還沒有今天」，
    在 00:00~09:00 同樣成立，於是深夜的榜單會自稱「盤中即時」。判斷盤中請用
    快照的 `marketOpen`。
- **持股金額運算漏掉「張→股」的 ×1000** —— `h.quantity` 單位是**張**。
  比值（權重、報酬率、均價）會自己相消所以看不出來，但只要顯示成絕對金額就少 1000 倍：
  月報「市值約 115 萬」印成「0.1 萬」、停損提醒「可少虧約 50,000 元」印成「50 元」
  （兩例皆 2026-08-12 修）。⇒ 任何要顯示成元/萬的金額，回頭確認 ×1000 在不在。
- **顯示損益時讀交易紀錄上「存死」的 `t.realizedPnL`** —— 這個欄位是**記錄當下**用手動持倉
  成本算的快照，且使用者一編輯該筆交易，`store.updateTradeRecord` 就會 `delete` 掉它。
  於是 `t.realizedPnL != null` 這種過濾會把**所有被訂正過的交易整筆丟掉**——
  越認真修正資料，報表錯得越多，而畫面上永遠是一個看起來很合理的數字。
  2026-08-12 實測：同一批紀錄，存死欄位 96,000 vs 帳本重算 380,679（一筆被編輯就差 28 萬），
  而「持倉總覽」頭條與同一頁上方的對帳卡各用一種，兩個「已實現」在同一畫面互相打架。
  ⇒ **一律 `buildLedger`（前端）/ `replayLedger`（daemon）重放交易紀錄**，
    存死值只能當「與重算值不符 → 提醒使用者核對」的參考。
- **期間報表（週報/月報）只把該期間的交易餵進帳本重放** —— 上月買、本月賣的部位會因為
  找不到買進而被判成**超賣**，該筆損益直接歸 0（實測整份月報變成 0 元）。
  ⇒ 成本基礎一定要用**全量歷史**重放，之後再依 `closed[].date` 篩期間。
- **把含手續費的成本價寫進 `holdings[].buyPrice`** —— 那個欄位的定義是「成交均價」，
  下游 `netRealizedPnL()` 會自己再估一次買進手續費 ⇒ **同一筆買進費被扣兩次**
  （實測 3008 一張多扣 3,568 元，畫面上只是「淨利少一點」，看不出異常）。
  ⇒ 寫入手動持倉用 `OpenPosition.avgPrice`（不含費），做損益比較才用 `avgCost`（含費）。
- **同一個名稱的指標在不同分頁一個是毛額、一個是淨額** —— 兩張卡都叫「未實現損益」，
  數字差一整筆賣出費稅（實測差 20,696 元），使用者只會覺得「這頁不準」卻說不出哪裡不準。
  ⇒ 同名必同口徑；毛/淨並列時毛額只能當附註，且必須寫明。

## 目前狀態

| 文件 | 內容 |
|---|---|
| `OPTIMIZATION-2026-07-30.md` | Cowork 第 1–7 步最佳化完整紀錄（CDN／合流／timeout／安全／輪詢／快取層／前端） |
| `docs/OPTIMIZATION-TODO.md` | 剩餘最佳化工作與順序 |
| `docs/SECURITY-2026-07-31.md` | 第二輪安全稽核：uid 仍可偽造、DELETE 零授權、推送零授權、timing-safe |
| `docs/REPO-LAYOUT.md` | 兩個 git repo 的歸屬與規則 |

`.backup_before_opt/` 是 Cowork 最佳化前的檔案快照；**現在專案已有 git，回滾請用 git**，
那個目錄留著只是保險，確認穩定後可刪。

已知未做：`maxInstances` 仍為 5（容量牆，牽涉帳單，依指示不動）。
rate limiting 與 CSP 已於 2026-08-01 補上（見 docs/SECURITY-2026-07-31.md 後續補齊節）；
rate limit 目前是 per-instance in-memory，要全域一致需自行申請 Upstash 並設
`UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`（程式已支援，填了就生效）。

> ⚠ 更正（2026-08-01）：先前這裡寫「32 支 route 仍回 `no-store`」是**錯的** ——
> 那是 grep 字串 `no-store` 的誤判，它只出現在**錯誤分支**（失敗不快取，本來就對）。
> 實測那些 route 早就有 `s-maxage`。真正缺的是 memoize／in-flight 合流／
> 失敗負快取／`stale-if-error`，已於 2026-08-01 統一到 `latestDoc` 與 `cacheHeader`。
> **教訓：grep 到字串不等於查到行為，要打線上標頭確認。**

## 驗證

```bash
npx tsc --noEmit && npx eslint .
npm run build          # 只能在 Mac 上跑
node scripts/audit-data-sources.mjs     # 全站資料源健康稽核（52 內部 + 6 外部）
```

### 資料源健康稽核（wm-freshness-health-monitoring）

`scripts/audit-data-sources.mjs` 對每個資料源套**三道獨立閘門**，缺一不可：

| 閘門 | 抓什麼 | 只有這道會漏掉 |
|---|---|---|
| `maxStale` | 多久沒更新 | 「很新但幾乎全空」 |
| `minRecords` | 涵蓋幾筆 | 「很完整但是上週的」 |
| **資料日漂移** | 這批**代表哪一天** | ← **本專案栽了四次的就是這道** |

第三道最重要：上櫃日期位移、加權指數落後一日、stockHistory 只寫一次、
chipDaily PIT 漂移 —— 共同特徵都是「有值、很新、筆數也夠」，
前兩道全綠，但代表的是**別天**的資料。四次都是使用者先發現的。

daemon 每日 16:10 自動執行並寫入 `system/dataHealth`，
對外由 `/api/system/data-health` 提供。**新增資料源時記得補進 `CONTRACTS` 表**，
否則它不在稽核範圍內，等於沒有保護。

改完會影響流量的東西之後，盤中觀察三個數字：
- **origin RPS** —— 應該與線上人數次線性成長
- **外部請求數/分鐘** —— 必須是常數，與人數無關
- **Firestore reads/10min** —— 1000 人時應該在 2 萬量級，不是 30 萬

## 部署

```bash
npm run build
firebase deploy --only hosting,firestore:rules
```
`firestore.rules` 動過就**務必帶上 `firestore:rules`**，否則 `system/monitor-agent`
的權限修正不會生效，daemon 心跳會寫入失敗。
