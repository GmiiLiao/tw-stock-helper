# 效能與安全修補 — 2026-07-30

依《台股助手全面檢視報告》第 1–4 步套用。`npx tsc --noEmit` 通過、`eslint` 0 errors。

**還原方式**：`.backup_before_opt/` 有所有被改檔案的原始版本（改動前的完整副本）。
專案沒有 git，這是唯一的還原點 —— 確認新版本沒問題之前不要刪。

---

## 1. 讓 CDN 真正生效

| 檔案 | 改動 |
|---|---|
| `src/components/Header/Header.tsx` | 移除 `?t=${Date.now()}` 與 `cache: 'no-store'` |
| `src/lib/twse-api.ts` | 同上（stock-day-all） |
| `src/app/api/twse/market-index/route.ts` | 盤中 `no-store` → `s-maxage=3, stale-if-error=60`；收盤後 `s-maxage=1800` |
| `src/app/api/twse/depth/route.ts` | `no-store` → `s-maxage=5` |

cache-buster 讓每次 URL 都不同，CDN 100% miss。上游本來就 5 秒才更新一次，
`s-maxage=3` 讓 CDN 擋掉九成以上回源，使用者最多落後一個 tick。

## 2. 請求合流與負快取

新增 `src/lib/singleflight.ts`（TTL 快取 + in-flight 合流 + 失敗負快取）。

| 位置 | 改動 |
|---|---|
| `twse-api-server.ts` `getMarketIndexDataInternal` | 包上 15 秒 memoize。原本零快取、每次觸發 7 個外部請求 |
| `twse-api-server.ts` `getStockDayAllDataInternal` | 加 in-flight 合流：後到的請求等待進行中的那一個，不再各自打上游 |
| 同上 | 加 30 秒失敗冷卻。原本 `lastRawFetchTime` 只在成功時更新，上游一掛就變成每個 request 立刻重打 |
| `scoring-server.ts` `fetchRiskStocks` | 失敗時寫入負快取，並繼續供應舊資料 |

## 3. fetch timeout

`twse-api-server.ts` 8 處 fetch 補上 `AbortSignal.timeout(8000)`。
沒有 timeout 時上游 hang 會佔住 worker 直到 120 秒的 function timeout，
是雪崩的直接機制。

## 4. 安全

| 檔案 | 問題 | 修法 |
|---|---|---|
| `api/ai-analysis/route.ts` | `email === adminEmail` 的 email 來自 request body，等於呼叫端自己宣告自己是管理員 | 移除該條件，只信任 Firestore 讀出的 `userData` |
| `api/ai-analysis/route.ts` | 在 server 端用 client SDK 讀寫 Firestore（以未登入身分） | 全部改用 `getAdminDb()` |
| `firestore.rules` | `system/monitor-agent` 允許 `request.auth == null` 寫入 | 收成 `isAdmin()`。**必須搭配上一項**，否則心跳寫入會失敗 |
| `api/cron/daily-close/route.ts` | `if (!secret) return true` fail-open；GET 也能觸發 120 秒批次；secret 可走 query string | fail-closed（production）、GET 於 production 回 405、只收 header |
| `api/ai/stock-note/route.ts` | 同樣的 fail-open | 同上 |
| `api/twse/yahoo-quote/route.ts` | 50 codes × 2 symbols = 一次呼叫放大 100 次 Yahoo；`no-store` + CORS 全開 | 上限降到 10；移除 `Access-Control-Allow-Origin: *`；改可快取 |

---

## 還沒做（需要你決定）

- **`firebase.json:31` `maxInstances: 5`** — 這是目前的容量硬牆（約 400 個同時請求，
  對應 200–400 個同時在線使用者）。調高會直接影響帳單，所以留給你決定。
  上面的修補做完之後才調才安全，否則只是把打向上游的火力放大。
- **`region: us-central1`** — 對台灣使用者每個請求 +150~200ms。
  Firebase App Hosting 的 region 通常在 backend 建立時決定，改這個欄位不一定會就地生效，
  可能需要重建 backend，請先確認再動。
- 前端的 `next/dynamic` 拆包、19 處 zustand selector、`RiseFallPanel` 的 1,700 個 tile —
  屬架構級改動，風險較高，建議獨立一輪處理。

## 部署前

裝置端無法跑 `next build`（VM 沒有網路，抓不到 linux-arm64 的 swc）。
請在你的 Mac 上跑一次：

```bash
npm run build
firebase deploy --only hosting,firestore:rules
```

`firestore.rules` 有改，**deploy 時務必一起帶上 `firestore:rules`**。

---

# 第 5 步 — 關掉 24/7 輪詢（2026-07-30 續）

`npx tsc --noEmit` 通過、`eslint` 0 errors（3 個 warning 是既有的，與本次無關）。
`market-clock` 的時段判斷另跑了 11 項驗證（含國定假日、盤前試撮、跨時區），全數通過。

原始檔備份在 `.backup_before_opt/step5/`。

## 做法

刻意選**最小改動**：保留既有的 `setInterval` / 遞迴 `setTimeout`，只在 poll function
第一行加一道 gate，或把間隔計算換成 `market-clock`。
沒有改寫成 `useSharedPoll` —— 效果（省掉 81% 的無效請求）一樣，但風險低得多。
`useSharedPoll` 留給之後真的需要「多元件共用一條輪詢」時再遷移。

`src/lib/market-clock.ts` 新增兩個 helper：
- `shouldPollNow()` — 背景分頁或台股休市 → false
- `isForeground()` — 只擋背景分頁（給美股 / daemon 驅動、休市時仍會更新的資料用）

## 改動

| 檔案 | 原本 | 現在 |
|---|---|---|
| `AlertEngine.tsx` 主輪詢 | 每 30 秒抓 650KB 全市場，**24/7 不停**、無盤中判斷、無背景分頁判斷 | 加 `shouldPollNow()` gate |
| `Header.tsx` market-index | `h >= 9 && h < 14` → 5 秒。用 client 本地時區、**不查國定假日** | 台股時段改吃 `getSession()`（查假日）；美股時段 30 秒保留；背景分頁降到 5 分鐘；一般離峰 60→120 秒 |
| `Header.tsx` stock-day-all | 同上判斷 → 盤中 2 分、離峰 5 分 | 盤中 2 分不變；離峰與背景分頁一律 15 分 |
| `AiNewsTicker.tsx` NavbarIndexWidget | **還帶著 `?t=${Date.now()}` + `no-store`**（第 1 步漏掉這支） | 移除 cache-buster，與 Header 共用 CDN 快取；加背景分頁 gate |
| `AiNewsTicker.tsx` ai-analysis | 每 15 秒，無任何判斷 | 加背景分頁 gate；休市時 15→60 秒 |
| `useLiveQuotes.ts` `marketInterval()` | 只擋週末、**不查假日**；離峰 60 秒 | 改吃 `getSession()`；盤中 5 秒、盤前 15 秒、離峰與背景分頁 10 分 |

**注意 `AiNewsTicker.tsx` 那支 cache-buster** —— 第 1 步只清掉 `Header.tsx` 和 `twse-api.ts`，
漏了這支。它與 Header 打同一支 API，一個帶 cache-buster 就讓兩者都無法共用 CDN 快取。
現在 `grep -rn 't=\${Date.now()}' src/` 已無殘留。

## 預期效果

- 休市時段（佔一天 81%）的前端輪詢請求 → 接近 0
- 背景分頁的輪詢 → 0（原本 38 個輪詢點沒有一個會在分頁切走時停下來）
- 國定假日不再誤判為交易日（原本 6 份時段實作有 5 份只擋週末）

## 驗收

休市時間打開網站，DevTools Network 面板應該完全安靜。
切到別的分頁再切回來，也不該看到補打的請求爆量。

---

# 第 6 步 — daemon latest-doc route 的快取（2026-07-30 續）

`npx tsc --noEmit` 通過、`eslint` 0 errors。`latestDoc` 的四種情境另跑 mock 驗證，全過。
原始檔備份在 `.backup_before_opt/step6/`。

## 問題

14 支 route 的**成功分支**回 `no-store`，但它們讀的是 daemon 每天只寫 1–3 次的 Firestore doc
（`scripts/ai-daemon.mjs` `runDailyJobs()`，15:10 / 16:30 官方補跑 / 21:45 融資補跑）。
`no-store` 讓 CDN 完全幫不上忙，每個使用者的每次載入都是一次 document read。

同時這 14 支是 47 個複製貼上樣板的一部分 —— 重複本身不是重點，
重點是**快取策略無法統一治理**：要調整就得改 47 個檔案，所以實務上永遠不會被調整。

## 做法

`src/lib/api-cache.ts` 提供 `latestDoc(collection, tier, { request })`，14 支 route 各縮成 3 行：

```ts
import { latestDoc } from '@/lib/api-cache';
export const runtime = 'nodejs';
export const GET = (request: Request) => latestDoc('scanner', 'intraday', { request });
```

比原本多做三件事：正確的 Cache-Control、行程內 memoize + in-flight 合流
（CDN miss 時同一實例不重複讀 Firestore）、失敗負快取。帶 `request` 會啟用既有的 `gzipJson`。

## tier 選擇

daemon 實際上是日頻寫入，但**沒有用 `daily`(s-maxage=3600) 一路到底**：
那會讓 15:10 產出的今日資料最晚要到 16:10 才在部分使用者面前出現。
`intraday`(s-maxage=120) 已經收斂掉 99% 以上的回源，最多落後 2 分鐘 —— 用風險換那點邊際效益不划算。

- `daily`：`dividendCalendar` `dividendStocks` `lending` `majorHolders` `revenue`
  （除息日曆／殖利率／借券／大戶持股／月營收，本來就不會盤中變動，也沒人盯新鮮度）
- `intraday`：其餘 9 支。其中 `globalMarkets` 另由 `sectorLoop` 盤中每 3 分鐘更新，本來就該用短的

## 一個容易漏掉的正確性問題

`memoize` 內部會吞掉錯誤並回 `null`。若直接用 `null` 當回傳值，
**「Firestore 掛掉」和「doc 還沒被 daemon 寫入」會長得一模一樣** ——
前者絕不能帶著 `s-maxage` 送出去（等於把一次故障釘在 CDN 上兩分鐘），後者則是正常狀態、應該快取。

所以 fetcher 包成 `{ ok: true, data }`：
- `result === null` → 讀失敗且無舊值可降級 → `no-store`
- `result.ok` → 正常路徑，`data` 為 `null` 只代表 daemon 還沒寫
- 先成功後失敗 → memoize 回舊值，仍走正常快取路徑（stale-serve）

## 驗收

線上打 `curl -I https://<host>/api/ai/scanner`，`Cache-Control` 應為
`public, max-age=60, s-maxage=120, stale-while-revalidate=120, stale-if-error=900`。
連打兩次，第二次應由 CDN 命中（Firebase Hosting 會帶 `x-cache` 或 `age` 標頭）。

---

# 第 7 步 — 前端載入與重繪（2026-07-30 續）

`npx tsc --noEmit` 通過。`npm run lint`：**0 errors**、186 warnings（全部是既有的 `any` / unused-vars）。
原始檔備份在 `.backup_before_opt/step7/`。

⚠ **`npm run build` 沒有跑過** —— 裝置端 VM 沒有網路，抓不到 linux-arm64 的 swc。
本輪動到 `next/dynamic`，是 build 敏感的改動，**部署前務必先在 Mac 上跑一次 `npm run build`**。

## 7a. code splitting — `src/app/page.tsx`

原本 16 個頂層元件全部靜態 import，用 `{currentPage === 'x' && <X />}` 條件渲染。
**條件渲染不做 code splitting** —— 元件只是不掛載，程式碼照樣下載並解析。
首屏實測 92 個模組、1,280,457 bytes 原始碼打成單一 chunk。

改成 9 個 `dynamic(() => import(...))`：
`StockDetail` `StockPicker` `Portfolio` `Backtest` `WatchlistTracker` `WarRoom`
`AdminPanel` `IndexNewsPage` `HelpManual`。

留在靜態 import 的是入口必經（`Navbar` / `Header` / `Dashboard` 預設頁）
或全域常駐（`AlertEngine` / `AuthModal` / `CandidateDock` / `ConsentBanner`）。

`PrivacyPage` 沒有拆 —— 它和常駐的 `ConsentBanner` 在同一個模組，拆了也還是會被載入。

副作用：首次切換到各頁時會有一個極短的空白（chunk 下載）。
若實測覺得明顯，給 `dynamic()` 補 `loading:` 即可。

順手移除 `package.json` 的 `lightweight-charts@^5.2.0` —— 全專案零引用。

## 7b. zustand selector — 19 處

`useAppStore()` 不帶 selector 時，zustand v5 會比對整個 state 物件，
**任何一次 `set()` 都讓該元件重繪**。而 `Header.tsx` 每 2 分鐘 `setAllStocks()`，
`page.tsx` 又是整棵 App 的入口，加上全專案 `React.memo` 使用次數是 0 ——
沒有任何一層攔得住。

用 `scripts/fix-selectors.py` 機械改寫（腳本保留在 repo，之後有新的可以再跑）：
- 單一欄位 → `useAppStore((s) => s.foo)`
- 多欄位 → `useAppStore(useShallow((s) => ({ ... })))`，`useShallow` 由 `zustand/react/shallow` 提供

腳本刻意保守：遇到 rename（`{a: b}`）、rest（`...r`）、預設值一律跳過並回報。
本次 19 處全部是單純識別字，零跳過。

## 7c. RiseFallPanel — 約 1,700 個 tile

`{items.map(...)}` 沒有任何上限。一般交易日約 900 漲 + 800 跌 = 約 1,700 個 tile 同時進 DOM，
每個內含一顆 `AddCandidateButton`，各自 `useAppStore(s => s.compareCodes.includes(code))` ——
任何一次 `set()` 觸發 1,700 個 selector 跑 `Array.includes`。
搭配 30 秒輪詢每 30 秒整批 reconcile。

**檔頭註解寫著「不設上限」是刻意的產品決策，所以沒有直接截斷**：
改成預設畫 200（`INITIAL_TILES`），其餘用「顯示其餘 N 檔」一次展開。
看得到全部的能力保留，只是不再無條件付整批的渲染成本。

`limit` 刻意不隨 `items` 變動重置 —— `items` 每 30 秒換成新陣列，
重置的話使用者剛按下的「顯示全部」會在下一輪被打回去。

順帶把欄頭三個統計（原本在 render body 對 ~900 筆做 3 次全掃）改成單趟 `useMemo`。

## 7d. eslint 設定

`npm run lint` 原本回報 2,226 個 error —— **全部來自 `.firebase/`**（deploy 產物，
內含打包過的 app 與 node_modules 副本），與原始碼無關，使這個指令完全失去訊號價值。
`eslint.config.mjs` 的 `ignores` 補上 `.firebase/**` `second-brain/**`
`_to_delete/**` `.backup_before_opt/**`。現在 `npm run lint` 是 0 errors。

## 沒做的（留給下一輪）

- `Header.tsx:152-160` 每秒 `setInterval` 讓 17KB 的大元件完整重繪 → 時鐘拆成葉節點
- `StockDetail.tsx:220` deps 含 `allStocks` → 每 2 分鐘重打 3–12 次 stock-history + recharts 全圖重建
- `Header.tsx:163-186`、`Screener.tsx:414-422` 對 1,700 檔做 `includes()`，每個按鍵一次、無 debounce
- 虛擬滾動（真正的解，`.slice()` 只是止血）

## 驗收

Mac 上 `npm run build` 之後看 route 的 First Load JS；
再用 Lighthouse 量 TTI，預期從 5–8 秒進到 3 秒內。

---

# 第 7d 步 — 三個重繪／重抓熱點（2026-07-30 續）

`npx tsc --noEmit` 通過、`npm run lint` 0 errors。備份在 `.backup_before_opt/step7d/`。
腳本保留為 `scripts/patch-7d.py`（每一步都有 assert，對不上就中止，不會改壞）。

## 1. Header 的時鐘

`setInterval(tick, 1000)` 直接 setState 在 Header 上，讓一個 17KB 的大元件
**每秒完整重繪，背景分頁也照跑**。

拆成 `<Clock />` 葉節點後，每秒重繪的範圍只剩一個 `<span>`，
並且 `document.hidden` 時停擺（回到前景會立刻補一次，不會顯示舊時間）。

順帶更新了一段**已經過時的註解**：檔內原本寫「搜尋框為非受控，因為 Header 每秒重渲染
會在手機 IME 下把游標打回開頭」。那個成因現在消失了，但非受控本身沒有壞處，
改回 controlled 只是徒增 IME 迴歸風險，所以保留實作、只把理由寫清楚。

## 2. Header 的搜尋

每一個按鍵都對 ~1,700 檔做 `toLowerCase().includes()` 全掃。
加 150ms debounce，連續輸入時只在停頓後掃一次。

## 3. StockDetail 的依賴地獄

```
}, [selectedStock, chartPeriod, allStocks]);   // ← allStocks
```
`allStocks` 只是被當「已經抓過的清單」讀一次，卻放在 deps 裡。
Header 每 2 分鐘 `setAllStocks()` 換成新陣列 → callback identity 變 → effect 重跑
→ **重打 3~12 次 `/api/twse/stock-history`（每次間隔 300ms）+ 重跑 8 組技術指標
+ recharts 全圖重建**。使用者只是打開個股頁發呆，而歷史 K 線一天只變一次。

改用 ref 讀取，`allStocks` 移出 deps。

順帶補上取消機制：那個 for 迴圈是串行 + 每輪 sleep 300ms，
1Y 週期要跑 12 輪約 4 秒。原本切換股票時舊的抓取會繼續跑完，**還會把結果寫回畫面**。
現在用 `runIdRef` 世代編號作廢上一輪：迴圈中途放棄、`setCandles` 前再確認一次。

## 驗收

- 開個股頁不要動，觀察 DevTools Network：原本每 2 分鐘會冒出一批 `stock-history`，現在應該完全安靜
- 快速連續切換三檔股票，Network 裡不該看到前兩檔還在繼續抓
- React DevTools Profiler 錄一秒：原本每秒有一次 Header 全樹 commit，現在只剩 Clock

---

# Build 驗證（2026-07-30）

**`next build` 已實際跑過並通過** —— 在雲端容器（有網路）重建整包依賴後建置，
不是只有 `tsc`。0 errors，只有既有的 lint warnings。

## 首屏 bundle 前後對照

同一份程式碼，**只切換 `src/app/page.tsx` 一個檔案**（靜態 import ↔ `next/dynamic`），
其餘完全相同，兩次 build 的結果：

| | Size | **First Load JS** |
|---|---:|---:|
| 改動前（16 個元件靜態 import） | 487 kB | **589 kB** |
| 改動後（9 個改 `next/dynamic`） | 192 kB | **295 kB** |
| 差異 | −295 kB | **−294 kB（−50%）** |

首屏 JS 砍半。這證實了「條件渲染不做 code splitting」——
原本那 9 個元件只是不掛載，但 295 kB 的程式碼每個使用者都在下載並解析。

4G 手機上這大約是 2–4 秒的 TTI 差距。

## 建置環境備註

裝置端的 VM 沒有網路，抓不到 linux-arm64 的 swc，所以 `npm run build` 在那邊跑不起來。
本次是把原始碼（不含 node_modules / .next / .env.local）搬到有網路的環境重建依賴後建置。
建置用的 `.env.local` 是臨時假值，**沒有使用任何真實密鑰**。

你在 Mac 上仍應跑一次確認（平台不同、`lightweight-charts` 已從 package.json 移除）：

```bash
npm install && npm run build
```
