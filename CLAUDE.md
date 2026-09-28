@AGENTS.md

# 台股助手 tw-stock-app

Next.js 15 App Router + React 19 + zustand + Firebase（Auth / Firestore / App Hosting）。
116 支 API route（`find src/app/api -name route.ts | wc -l`，2026-09-28 量測；舊值 80 已過時）、33k 行 TS/TSX。

> **版控歸屬（進場先看）**：本專案的 git 根是 `tw-stock-app/` 本身，不是家目錄。
> 先跑 `git rev-parse --show-toplevel` 確認輸出是 `.../股票助手app/tw-stock-app`。
> 若輸出是 `/Users/gmii` 代表 `.git` 不見了 —— **先問人，不要 git init**。
> 2026-07-31 之前的歷史在家目錄那份 repo，查法與規則見 [`docs/REPO-LAYOUT.md`](docs/REPO-LAYOUT.md)。

## 任務模式與終端狀態（wm-agent-task-mode·2026-09-04）

- **模式由使用者的動詞決定**：「查看／分析／列出／為什麼／等我決定」＝**唯讀**——不改檔、不 commit、
  不重啟 daemon、不部署；「開工／go／修正／補上」才是實作模式。報告模式下發現問題只列不修。
- **動碼前先跑 preflight**：影響面掃描（呼叫端／回傳值消費端／時序：盤中、daemon 重啟窗、每日任務時段），
  daemon 重啟前 `node scripts/can-restart-daemon.mjs`。這是「不要修A錯B」的機械化步驟，不是可選項。
- **終端狀態分開宣稱**，六個是不同的主張，不可混用：本機驗證通過 → 已 commit → 已部署 → **線上實測**
  （附標頭／數字）→ 線上觀測到（daemon log／dataHealth）→ 使用者驗收。commit 成功或 tsc 綠燈**不證明**
  線上行為；沒實測的一律寫「未驗」。
- **驗證分級**：先跑最小聚焦證明，再跑該面向要求的閘門；中斷或逾時的檢查不得宣稱通過；要分清產品失敗／
  既有基線失敗／缺憑證／沙箱限制並附證據；交付時列「改了什麼、驗了什麼、**什麼還沒證明**」。
- disk 即部署：launchd KeepAlive 會在 daemon 死亡時拉起**磁碟上的版本**，半成品碼不可落地（pre-commit 擋語法）。
- 交易相關輸出一律附「非投資建議」。技能全文：`.claude/skills/wm-agent-task-mode/SKILL.md`。

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
| MIS 更新節奏 | 5 秒揭示；`z` 只在該 5 秒窗內**有成交**才有值 | 輪詢快過 5 秒沒有資訊增益；冷門股 z 長期 '-' 是市場現實不是故障 |
| daemon MIS 頻寬分配 | 快線(120檔優先股/5s=1req)＋主迴圈(1req/3s) ≈ 2.7 req/5s | 動任何一邊前先重算總和；**除錯時自己手打 MIS 也算在同一個 IP 額度內** |
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

**即時報價的雙軌（2026-08-14 起）**

- **5 秒快線** `hotQuoteLoop`：自選/持股/瀏覽中/策略榜前 120 檔（`buildPriorityCodes`），
  每 5 秒單一 MIS 請求 → 寫小型 `marketSnapshot/hot`（~20KB）。
- **主迴圈**：全市場輪掃（批 120、1req/3s），~1 分鐘覆蓋一輪 → 寫 `marketSnapshot/latest`。
- web 端 `getMisQuoteDataInternal` 把 hot 蓋在 latest 上（只取 liveAt 較新者）。
  端對端實測：被看的股票成交後 3~10 秒可見。`/api/twse/mis-quote` 盤中回
  `s-maxage=2`（不再 no-store 打穿 CDN）。

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
盤中才變、但收盤價 13:30 後才揭示的即時資料（報價、雷達、五檔）用 `shouldPollThroughClose()`
（= shouldPollNow ＋ 13:30–13:45 收盤定價窗；getSession 把 13:30–14:00 算休市，只用 shouldPollNow 會停在收盤前最後一拍到 14:00）。

**進度：以 `node scripts/audit-ratchets.mjs` 的輸出為準**（它是 pre-commit 閘門、逐檔計數未接 gate 的輪詢；
不要再在這裡寫死數字——舊文「26 個裡只有 3 個接上 gate」早已過時，2026-09-28 量測）。
早期清單在 `docs/OPTIMIZATION-TODO.md`（歷史，可能過時）。新增輪詢時請直接加 gate。

`src/hooks/useSharedPoll.ts` 是**已寫好但尚未採用**的替代方案（目前零呼叫點）。
它多做的是：多元件共用一條輪詢、間隔每次重算、失敗指數退避、jitter。
當你遇到「同一支 API 被多個元件各自輪詢」時才值得換過去 —— 單純為了統一而重寫不划算。
換的時候路徑是 `@/hooks/useSharedPoll`（不是 `@/lib/`）。

## 絕對不要做的事

- **讓 GET API 打穿 CDN** —— 這是本專案歷史上最貴的單一錯誤。
  2026-08-12 用 `x-cache` 標頭實測，把三件常被混為一談的事分清楚：

  | 做法 | CDN 結果 | 判斷 |
  |---|---|---|
  | URL 加 `?t=${Date.now()}` 之類的變動參數 | **MISS（每次）** | ❌ 每次都是新 URL，必定打穿 |
  | **回應**標頭 `Cache-Control: no-store` | **MISS（每次）** | ❌ 等於宣告不可快取 |
  | 前端 `fetch(url, { cache: 'no-store' })` | **HIT** | ✅ 只跳過瀏覽器自己的快取，動不到 CDN |

  （第三列連 `Cache-Control: no-cache`、`Pragma: no-cache` 送出去也一樣是 HIT。）
  ⇒ 要抓這類問題，看的是 **URL 是否穩定** 與 **回應標頭**，不是前端的 `cache` 選項。
  我一度打算把前端那些 `cache: 'no-store'` 全部拿掉，量完才發現那是白工。
  真正的破口是回應標頭：`stock-day-all`（646KB、盤中高頻輪詢）原本盤中回 `no-store`
  ⇒ 實測連續三次 `x-cache: MISS`，每個使用者每次輪詢都打穿 origin，
  已改 `s-maxage=2, stale-while-revalidate=20`（資料本身就有 5 秒 instance 快取、
  daemon 掃描週期 25~32 秒、MIS 也是 5 秒才更新 ⇒ 2 秒的落後量遠小於資料自身的更新週期）。
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
  ⇒ 仍請**避免在 08:30~09:10 之間重啟**，也**避免在 13:20~13:40 之間重啟**——
    後者是尾盤五檔累積窗（13:20~13:35 收集在記憶體 `_depthWin`，13:36 才歸檔），
    重啟＝整窗直接蒸發，fallback 只能寫殘缺版。要重啟就等日誌出現
    「✓ 尾盤五檔歸檔」再動手；本輪重啟造成的資料代價已經是第三次
    （bookDepthArchive 當日資料、chipArchive 空殼、即時價失憶）。
- **把 MIS 的 pz（試撮指示價）盤中當成真成交** —— pz 只在收盤集合競價窗
  13:24–13:35 收斂到真收盤；其餘時段（分盤處置股的盤中集合競價尤甚）是**可能永不
  成交的指示價**。實案 2026-08-13 1435 中福（分盤、全日僅 66 張）：13:00 試撮 25.75
  從未成交（官方當日最高 25.50），被標 hasLive 寫入 `_lastLive`，daemon 跨夜長跑
  沒人清記憶體，隔天以「+8.65%」掛在即時漲幅榜。三道修正都在：pz 僅收盤窗可信、
  成交價須落在 [跌停w, 漲停u] 且不超出當日高低（注意 **MIS 的 d 是日期欄，跌停是 w**）、
  `marketSnapshotLoop` 逐輪清掉 `_lastLive` 非今日的殘留。
  同場加映：**種子帶的是昨日漲跌**，盤中沒有今日真成交的檔一律歸零顯示平盤，
  否則昨天的漲幅會頂著今天的日期上榜。
  **續集（2026-08-18）——z 缺席≠沒成交**：MIS 對個股常「v 前進但 z='-'」
  （2330 連 6 次揭示無成交價、累積量卻在漲）；指數的 z 每揭示必有、個股沒有。
  故盤中連續時段（09:00–13:30·試撮窗除外）z/pz 皆缺時以**買一/賣一中點**當
  即時價（漲跌停界內、雙邊掛單、今日有量三條件），個股才能跟上 5 秒節奏。
  東訊規則不變：收盤後/試撮窗仍禁用掛單價；內外盤取樣只吃真成交。
- **抓取失敗時仍把殘缺的宇宙寫進快取** —— `loadCodes()` 舊版上櫃清單抓取是
  `catch { /* otc */ }` 靜默吞掉且**沒有任何後備**（上市那半有 openapi 後備），
  而快取條件只看 `codes.length > 0` —— 上櫃掛掉時仍有 1,229 檔上市，條件成立，
  於是「只有上市」的殘缺宇宙被當成權威覆蓋掉上一份好的快取，之後每輪都以殘缺
  宇宙運作，不報錯也不自癒（2026-08-19 實案：全站上櫃 903 檔整批蒸發，
  漲停榜、選股、搜尋全都沒有上櫃，使用者先發現）。
  ⇒ 規則：**「總數 > 0」不是完整性條件**。任何由多個來源合併的清單，
    快取閘門要檢查**每個來源都有貢獻**；缺一邊就保留舊快取（stale-if-error）
    並記錄，寧可用舊種子也不要讓半個市場從站上消失。
- **拿買賣價中點當現價卻不驗檔位** —— `(b1+a1)/2` 幾乎必然落在檔位之間：
  台泥 24.02（檔位 0.05，市場上只有 24.00/24.05）、台積電 2347.5（檔位 5）。
  2026-08-19 實測 1,057 檔（即時報價的 56%）顯示**不可能成交的價格**。
  殺傷不只是難看：`isLimitUp` 以檔位算漲停價，鎖死股被寫成 21.48 就
  「< 漲停 21.50」判否而跌出漲停榜。
  ⇒ 正解不是把中點四捨五入，而是回到價格的定義：**上一筆真實成交價若仍落在
    買一~賣一之間，五檔並沒有推翻它 ⇒ 沿用**（本來就是真價、必然合法檔位）；
    只有書整個移開才把價格移到最近那一邊。5 秒節奏保住且不捏造價格。
  ⇒ 沿用前**必須先驗檔位**：舊快照存著上一版寫下的髒值，`restoreLastLive`
    會接回記憶體，24.02 永遠落在 [24.00,24.05] 內 ⇒ 錯價自我延續、永不痊癒。
  ⇒ **ETF 走另一套檔位表**（<50 元 0.01、≥50 元 0.05），用個股表驗 ETF 會把
    0050 的 103.55、006207 的 32.69 這種合法價誤判成髒值丟棄（實測 80 檔全中）。
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
| `docs/EXPERIMENTS.md` | **模型實驗紀錄（含負面結果）**——重跑前先看，避免重做已證偽的假設 |
| `docs/DATA-INTEGRITY-SCAN.md` | **反向糾錯掃描**——六個故障族的特徵與 grep 指令，可重跑；含「查過且乾淨」的紀錄 |

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
node scripts/check-field-conventions.mjs  # 欄位命名契約（新 xxxAt/xxxDate 名字必須登記，防止讀寫兩端相撞）
```

### 資料源健康稽核（wm-freshness-health-monitoring）

`scripts/audit-data-sources.mjs` 對每個資料源套**三道獨立閘門**，缺一不可：

| 閘門 | 抓什麼 | 只有這道會漏掉 |
|---|---|---|
| `maxStale` | 多久沒更新 | 「很新但幾乎全空」 |
| `minRecords` | 涵蓋幾筆 | 「很完整但是上週的」 |
| **資料日漂移** | 這批**代表哪一天** | ← **本專案栽了四次的就是這道** |
| **市場組成** | 每個市場**各有幾檔** | 「筆數夠多、很新、日期也對，但上櫃整批不見了」 |

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
