---
name: wm-smart-polling-startup
description: 智慧輪詢與漸進式啟動——startSmartPollLoop（回傳 false 即退避 ≤4×、jitter、隱藏分頁倍率、回前景 debounce 重跑、in-flight 不重入）、兩層 bootstrap、generation counter 取消舊 boot；台股助手 market-clock 標準件的規範
---
# wm-smart-polling-startup｜智慧輪詢與啟動

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`src/services/smart-poll-loop.ts`（261 行：hiddenMultiplier 10、maxBackoff 4×、jitter 0.1、minInterval 1s、visibilityDebounce 300ms、AbortController 隨 stop/隱藏中止）、`src/app/refresh-scheduler.ts`、`src/components/Panel.ts`（150ms debounced setContent）。**適用度：深度內化（09-02 標準件）**。

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
