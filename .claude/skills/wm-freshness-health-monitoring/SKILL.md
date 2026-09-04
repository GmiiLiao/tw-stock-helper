---
name: wm-freshness-health-monitoring
description: 資料新鮮度與健康監控——seed-meta 契約、maxStale 2–3× 節奏、minRecordCount、STALE_SEED vs STALE_CONTENT 雙時鐘、有限 grace、Activation Marker、worst-wins；台股助手 audit 四道閘門的上游依據
---
# wm-freshness-health-monitoring｜新鮮度與健康

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`api/health.js`（3,919 行；每 key `maxStaleMin`＝cron 2–3×、`minRecordCount`、STALE_CONTENT_GRACE 3h）、`scripts/check-seed-freshness.mjs`、`CONCEPTS.md`（Content-Age Contract／Activation Marker／Read Outcome）、`.github/workflows/seed-freshness-monitor.yml`（每 15 分）。**適用度：深度內化**。

## 原則
- 每次資料寫入同時寫 `seed-meta:{fetchedAt, recordCount, sourceVersion}`；健康端點只讀 meta，不讀大 payload。
- `maxStaleMin` ＝ 節奏的 2–3 倍（1.33× 曾造成例行 jitter 假警報）；每條門檻附註解說明倍數來源。
- **雙時鐘**：seed clock（seeder 有沒有在跑→STALE_SEED）與 content clock（資料有沒有前進→STALE_CONTENT）分開判；來源凍結只有後者抓得到。
- **有限 grace**：STALE_CONTENT 有 3h grace 且用無 TTL 的狀態鍵記錄，grace 過就算數；未配置的生產者不得重新進入 grace。
- **Activation Marker**：新 key 在首次成功發布前寬鬆、之後永遠嚴格；marker 讀失敗不等於不存在（不能給 grace）。
- 覆蓋率下限 `minRecordCount`（抓「很新但缺 95%」）；狀態階梯 OK／STALE／WARN／EMPTY＝crit；聚合 worst-wins。
- 「不要相信 deployment status」：另設收集器監控實際寫入。

## 台股助手規範
- `scripts/audit-data-sources.mjs` 四道閘門：maxStale／minRecords／**資料日漂移**／**市場組成**（後兩道是本站栽過四次的）；72 來源，MIN_SOURCES=60 防 vacuous pass（`auditIncomplete` 標記，exit code 刻意不變因 daemon 失敗會 5 分鐘重跑）。
- daemon 16:10 跑並寫 `system/dataHealth`，`/api/system/data-health` 對外；新資料源**必須**登記 CONTRACTS，否則等於沒保護。
- 資料日一律來源自報（回音驗證）；`boardDataDate(tw, marketOpen)` 三段語意；`liveDay` 不是「盤中」標籤。
- ✅ R7 已做（09-04）：`revealAt`＝MIS tlong（資料時鐘）與 `liveAt`（抓取時鐘）分開儲存與回傳，`tradeTime` 改揭示優先；缺 tlong 為 null 不冒充。
- ✅ F13 已做（09-04，使用者定義）：**盤中超時未更新→警告不隱藏；非交易日顯示交易所最終資料**——mis-quote／market-index 回 `snapshotAt`，Header 在盤中快照 >90s 未前進時顯示 ⚠。「太舊不顯示」構想作廢。
- **正向待辦**：dataHealth 加 seed 時鐘 vs content 時鐘雙欄。

## 修A錯B 影響面
改任一 latest doc 的 date/at 欄位前先查 CONTRACTS 的 dateField；改 audit 判定前先查 daemon 呼叫端的成功/失敗語意。

## 掃描探針
- 正向：`node scripts/audit-data-sources.mjs`（全綠＋sourceCount≥60）；反向：`rg -n "liveAt: Date.now" scripts/ai-daemon.mjs`
