---
name: wm-resilience-circuit-breaker
description: 熔斷器與降級存活——失敗計數→冷卻狀態機、tri-state 資料模式、持久快取 stale ceiling、半開探測逾時、withRetry 尊重 Retry-After；台股助手 daemon 外部源熔斷（F1）的設計依據
---
# wm-resilience-circuit-breaker｜熔斷與降級

**上游依據**（基線 v2.10.0 · 90dc23a · 2026-09-26（第二大腦 second-brain/worldmonitor/））：`src/utils/circuit-breaker.ts`（697 行；預設 maxFailures 2、cooldown 5 分、cacheTtl 10 分、persistent stale ceiling 24h、recovery probe 30s）、`src/services/smart-poll-loop.ts`。**適用度：部分（F1 進行中）**。

## 原則
- 狀態機：`failures` 達 maxFailures → `cooldownUntil`；冷卻期內直接回快取（mode=cached）或 unavailable，不打上游。
- **tri-state**：live／cached／unavailable＋timestamp＋offline，消費端據此標示，不把 cached 當 live。
- 半開探測：冷卻到期只放**一個**探測，有逾時（30s）；逾時重開冷卻並忽略遲到的結果。
- 持久快取有 **stale ceiling**（預設 24h，時間敏感資料可縮到 1h），過期即丟，不 hydrate。
- 背景刷新合流（同 key 只一個 refresh promise）；刷新失敗保留 last-good 但**不重置退避**。
- withRetry：nonRetryable 短路、尊重 Retry-After、指數退避；4xx 永久錯誤集合 {400,401,403,404,410,413,422,451} 不重試。

## 台股助手規範
- web 層：`memoize`（singleflight）已有 8s 硬逾時＋in-flight 毒化防護＋失敗負快取；`cacheHeader` 各層級有 stale-if-error（tick 60s … daily 86400s）。
- daemon ✅ 已做（2026-09-04 F1）：`breakerOpen/breakerOk/breakerFail` 三個小函式包 Yahoo 族兩個 key（`yahoo-chart`：1m＋日線；`yahoo-news`：內文），閾值 3、冷卻 5 分起每次跳閘加倍上限 30 分；**只有 throw 算失敗**（200 無資料是 miss）；冷卻中回 null 與「無資料」同形狀，呼叫端退避邏輯不變；狀態寫 `system/daemonHealth.breakers`。**絕不包 MIS**。
- 冷卻中要有可觀測訊號（log ❌＋dataHealth）；恢復探測一次一個。
- 前端：`useLiveQuotes`／`startLiveLoop` 為 fire-and-forget，錯誤不清空既有報價（見 wm-panel-data-lifecycle）。
- **finite stale grace**（上游 9/3 新增）：降級資料要有存活上限——本站 daily 層 stale-if-error=86400 是上限，但 daemon 產出的 latest doc 沒有「太舊就不顯示」的天花板 → 正向待辦 F4 延伸。

## 修A錯B 影響面
包裝抓取函式前，列出所有呼叫端與其對 null/throw 的處理（backfill 的 retry-at 機制依賴 throw）；熔斷不得改變回傳形狀。

## 掃描探針
- 反向：`rg -n "failures|cooldown" scripts/ai-daemon.mjs | wc -l`（0＝無熔斷）；`rg -n "fetch\(" scripts/ai-daemon.mjs | rg -v "timeout|AbortSignal" | head`（無逾時的抓取）

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **`maxServeAgeMs`：每條供應路徑都有年齡上限**（`src/utils/circuit-breaker.ts` +24 行：fresh hit、stale-while-revalidate、cooldown、recovery-probe fallback 全部過 `isServable()`；超齡或 **timestamp 非有限數（例：持久化信封缺 `updatedAt`）** 的項目一律從記憶體與持久層逐出，當作沒有快取；消費端 `src/services/gdelt-intel.ts:207,340` 帶 `STALE_MAX`）。這是 finite stale grace 從「持久層 24h 天花板」擴到「**失敗後的 fallback 也要驗年齡**」。
  - 台股助手對應：`src/lib/singleflight.ts:57-58,69,78` 冷卻期／降級／失敗三條路徑都回 `hit.value`，**不看 `hit.at` 距今多久**——instance 活多久，舊值就能被供應多久，且呼叫端分不出 live 或 stale。前端 `src/lib/useDayTradeCodes.ts:28-49`、`src/lib/useRiskCodes.ts:25-46` 的模組級快取與 promise **永不過期**（跨日掛著的分頁用昨天的當沖資格／處置名單），失敗結果也被永久記住（一次失敗＝整個分頁生命期不再重試）。
  - 規則：①任何「給舊值」的分支都要比對資料時刻與該層上限；②沒有時間戳的快取項目＝不可供應；③負快取必須有 TTL，不得以模組級 promise 永久記住失敗。
- **Fetch Phase Budget**（CONCEPTS 新詞條）：以「次數」限制重試、而外層以「牆鐘」殺行程時，重試迴圈可能吃光時間，迴圈**之後**的 fallback（正是為這種失敗寫的）永遠跑不到。上限要在「決定發動下一次嘗試之前」先扣掉那一次自己的逾時；兩個數字寫在不同檔時，要有檢查同時讀兩邊。本站對應：route timeout 120s（`firebase.json`）與 memoize 8s、daemon backfill 重試＋每日任務時段；新增重試迴圈時列出「最壞總時長 ≤ 外層上限 − fallback 所需」。上游實例：`.github/workflows/live-video-source-audit.yml` 逐步 `timeout-minutes` 且由 `tests/report-live-video-audit.test.mjs` 驗總和＋5 分餘裕 ≤ job 上限。
- **Seed-Owned Key 讀取端改寫**（CONCEPTS）：讀取端遇 miss 時，可推導者回短 TTL 計算值，**必要鍵則回明確 unavailable——捏造的空值會被當成資料讀**。本站實例：`useRiskCodes.ts:31-40` 非 2xx 時組出空名單並寫入 `_riskCache`，消費端 `WarRoom/daytrade/useDeskData.ts:62,46-47` 以「處置名單為空」判定全部可當沖 ⇒ **fail-open**。
- ⚠ **與既有本地規則的張力（記錄，不改）**：本技能 daemon 條「冷卻中回 null 與『無資料』同形狀，呼叫端退避邏輯不變」（2026-09-04 F1）是刻意選擇，理由是不改呼叫端。上游本週在 Seed-Owned Key 明確區分「可推導的 fallback」與「必要鍵的 unavailable」。上游已改為「必要鍵 miss 回明確 unavailable」；本站 daemon 熔斷是否跟進（改三態回傳、逐一改呼叫端）待使用者決定。影響面：`rg -n "breakerOpen\(" scripts/ai-daemon.mjs` 的所有呼叫端。
