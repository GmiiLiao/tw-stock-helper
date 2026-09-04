---
name: wm-resilience-circuit-breaker
description: 熔斷器與降級存活——失敗計數→冷卻狀態機、tri-state 資料模式、持久快取 stale ceiling、半開探測逾時、withRetry 尊重 Retry-After；台股助手 daemon 外部源熔斷（F1）的設計依據
---
# wm-resilience-circuit-breaker｜熔斷與降級

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`src/utils/circuit-breaker.ts`（697 行；預設 maxFailures 2、cooldown 5 分、cacheTtl 10 分、persistent stale ceiling 24h、recovery probe 30s）、`src/services/smart-poll-loop.ts`。**適用度：部分（F1 進行中）**。

## 原則
- 狀態機：`failures` 達 maxFailures → `cooldownUntil`；冷卻期內直接回快取（mode=cached）或 unavailable，不打上游。
- **tri-state**：live／cached／unavailable＋timestamp＋offline，消費端據此標示，不把 cached 當 live。
- 半開探測：冷卻到期只放**一個**探測，有逾時（30s）；逾時重開冷卻並忽略遲到的結果。
- 持久快取有 **stale ceiling**（預設 24h，時間敏感資料可縮到 1h），過期即丟，不 hydrate。
- 背景刷新合流（同 key 只一個 refresh promise）；刷新失敗保留 last-good 但**不重置退避**。
- withRetry：nonRetryable 短路、尊重 Retry-After、指數退避；4xx 永久錯誤集合 {400,401,403,404,410,413,422,451} 不重試。

## 台股助手規範
- web 層：`memoize`（singleflight）已有 8s 硬逾時＋in-flight 毒化防護＋失敗負快取；`cacheHeader` 各層級有 stale-if-error（tick 60s … daily 86400s）。
- daemon：**尚無失敗計數器**（09-02 Yahoo 整條斷線每輪空打一整天）。F1 設計：`withBreaker(key, fn, {threshold 3, cooldown 5min→30min})`，v1 只包 Yahoo 族（hoisted wrapper `fetchYahoo1m/_fetchYahoo1mRaw`），**絕不包 MIS**（MIS 的失敗多為 z 缺席之類的市場現實）。
- 冷卻中要有可觀測訊號（log ❌＋dataHealth）；恢復探測一次一個。
- 前端：`useLiveQuotes`／`startLiveLoop` 為 fire-and-forget，錯誤不清空既有報價（見 wm-panel-data-lifecycle）。
- **finite stale grace**（上游 9/3 新增）：降級資料要有存活上限——本站 daily 層 stale-if-error=86400 是上限，但 daemon 產出的 latest doc 沒有「太舊就不顯示」的天花板 → 正向待辦 F4 延伸。

## 修A錯B 影響面
包裝抓取函式前，列出所有呼叫端與其對 null/throw 的處理（backfill 的 retry-at 機制依賴 throw）；熔斷不得改變回傳形狀。

## 掃描探針
- 反向：`rg -n "failures|cooldown" scripts/ai-daemon.mjs | wc -l`（0＝無熔斷）；`rg -n "fetch\(" scripts/ai-daemon.mjs | rg -v "timeout|AbortSignal" | head`（無逾時的抓取）
