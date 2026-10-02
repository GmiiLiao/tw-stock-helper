---
name: wm-smart-polling-startup
description: 智慧輪詢與漸進式啟動——startSmartPollLoop（回傳 false 即退避 ≤4×、jitter、隱藏分頁倍率、回前景 debounce 重跑、in-flight 不重入）、兩層 bootstrap、generation counter 取消舊 boot；台股助手 market-clock 標準件的規範
---
# wm-smart-polling-startup｜智慧輪詢與啟動

**上游依據**（基線 v2.10.0 · c34156d · 2026-10-02（第二大腦 second-brain/worldmonitor/））：`src/services/smart-poll-loop.ts`（261 行：hiddenMultiplier 10、maxBackoff 4×、jitter 0.1、minInterval 1s、visibilityDebounce 300ms、AbortController 隨 stop/隱藏中止）、`src/app/refresh-scheduler.ts`、`src/components/Panel.ts`（150ms debounced setContent）。**適用度：深度內化（09-02 標準件）**。

## 原則
- 間隔每次重算（setTimeout 遞迴），**不用 setInterval＋一次性三元**。
- poll 回傳 false／throw → 退避 ×2 上限 4×；成功歸 1；AbortError 不算失敗。
- 隱藏分頁：倍率或暫停；回前景 debounce 後立刻跑一次（reason='resume'）。
- in-flight 不重入；stop 時 abort 進行中的請求。
- 啟動：LCP 元素 Phase 1 就畫；fast tier await、slow tier 首繪後；generation counter 讓被取代的 boot 不寫入。

## 台股助手規範
- 標準件在 `src/lib/market-clock.ts`：`liveQuoteInterval()`（regular→`msToNextReveal(3000)`、pre-open 15s、其餘 10 分）、`startLiveLoop(fn, intervalFn)`（setTimeout 迴圈＋visibilitychange 回前景重跑）、`revealTick()`（CDN 快取鍵拍號）、`shouldPollNow()`／`isForeground()` gate。
- 消費端：useLiveQuotes、WarRoom、WatchlistTracker、AiNewsTicker（NavbarIndexWidget 自有 intervalFn）、Header。
- 規矩：新增輪詢一律接 gate 或標準件；`setInterval(load, cond ? A : B)` 禁用；**盤中 3 秒**是規格（記憶 project_tw_stock_realtime_3s）。
- 現況：36 個含 setInterval 的檔案中 12 個已接（F5 待分批補齊，逐檔慢做）。
- **正向待辦**：標準件加「回傳 false 即退避」語意（現在是 fire-and-forget 無退避）。

## 修A錯B 影響面
「報價凍結」曾因背景 600s 無 visibilitychange 回復而發生——改 interval 邏輯前先查 onVis 路徑；輸入框所在元件樹被輪詢驅動重渲染 → 一律非受控輸入。

## 掃描探針
- 反向：`rg -n "setInterval\([^,]+, *[^)]*\?" src`（三元一次性）；`rg -l "setInterval\(" src | xargs rg -L "shouldPollNow|isForeground|startLiveLoop"`

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

上游 `src/services/smart-poll-loop.ts` 本週**無異動**；以下取自同週新增的相鄰閘門與詞條，因為它們解的是本技能在本站最常漏的那一類。

- **Lockstep：每個消費端都要問同一道閘，漏問即紅**（`scripts/enforce-overlay-reload-policy.mjs` 規則 2：`src/bootstrap/` 下每個 `reload()` 都必須位於會查 `findReloadBlockingModal` 的安裝器內；起因 #8577「一個消費端有 guard、一個沒有」，同型在下一個面板一小時內重演）。本站對應：**每個輪詢點**（不是每個檔案）都要過 `shouldPollNow()`／`isForeground()`／`startLiveLoop`。
- **以身分為鍵，不以寫法為鍵；寫法表外的一律視為逃逸**（同檔規則 1：site 依角色屬性／class／dialog 元素辨識，不看「怎麼打開」；檔頭明言「綠燈不代表不可能有未宣告 overlay——表外寫法會逃逸」，執行期再以 `policy:'undeclared'` 回報補表）。本站對應的兩個逃逸口（實測）：
  1. **遞迴 `setTimeout` 不在 Ratchet 的寫法表內**：`LimitUpPanel.tsx:86-88` 改寫成遞迴 setTimeout 後，`scripts/route-policy.json` 的 `pollNoGateBaseline` 以「已修」從 23 降為 22，但該迴圈**仍無任何 gate**（休市每 5 分、背景分頁照打）。
  2. **Ratchet 以檔案為單位**：檔內任一處出現 gate 字樣整檔就算接上（`scripts/audit-ratchets.mjs:14,26`），於是 `WarRoom.tsx:152`（`isTwTradingHours() ? 30000 : 300000` 掛載時算死、無 gate）、`WatchlistTracker.tsx:2128/2300/2335`、`AiNewsTicker.tsx:282` 都被同檔的 `startLiveLoop`／`isForeground` 遮蔽。
  ⇒ 規則：輪詢普查以「呼叫點」計數，寫法表至少含 `setInterval(`、遞迴 `setTimeout(tick…)`、`setInterval(…, cond ? A : B)`（三元一次性另列一條 Ratchet）。
- **Stale Bundle／Modal-Open Guard**（CONCEPTS 新詞條）：分頁持有的前端碼早於線上版本時，形狀變了的請求可能永遠重試；上游見 mismatch 即強制重載，但**有使用者正在輸入的對話框時延後**（以「是否真的渲染」判斷，不以「是否存在於 DOM」）。本站參考級：`/api/system/version` 已回 sha；盤中看盤頁常掛一整天，若日後加版本比對重載，必須避開未儲存的非受控輸入（DeskRiskPanel、NotesBox）。
- **Idle Pause**（CONCEPTS 新詞條：無輸入一段時間即停直播、需使用者按鍵才恢復）：本站**不跟進**——盤中看盤頁本來就是無人操作的監看用途；休市與背景分頁已由 gate 涵蓋。
- 既有條文校正（不刪原文）：「36 個含 setInterval 的檔案中 12 個已接」→ 2026-09-27 實測 **33 檔、22 檔無任何 gate 字樣（Ratchet 基線 22）、11 檔有**；但依上面第 2 點，11 檔中至少 3 檔仍有未過閘的呼叫點。CLAUDE.md「26 個…只有 3 個接上」同屬過期數字（CLAUDE.md 非本技能可改，記錄於此）。
- 掃描探針（新增）：`rg -n "setTimeout\(tick, *[^)]*\?" src`（遞迴但三元）；`rg -n "function isTwTradingHours|const isTwTradingHours|const inHours" src/components`（自寫交易時段、不查假日，違反 market-clock 單一真相）。
