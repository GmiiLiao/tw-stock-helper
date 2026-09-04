---
name: wm-realtime-seed-pipeline
description: 即時資料種子管線——runSeed 生命週期（lock→fetch→validate→publish→seed-meta→release）、TTL≥3×interval、失敗延長 TTL 絕不寫空、合併進行中的刷新、WebSocket relay 背壓；台股助手 daemon 迴圈的規範
---
# wm-realtime-seed-pipeline｜種子管線

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`scripts/_seed-utils.mjs`（2,886 行：acquireLock SET NX PX、atomicPublish、writeFreshnessMetadataSafely、PERMANENT_4XX、allSettledWithConcurrency）、195 個 `seed-*.mjs`、`scripts/ais-relay.cjs`、`CONCEPTS.md` Seed Bundle Orchestration（wall budget／section deferral／graceful skip／starved tick／chunked sweep）。**適用度：深度內化**。

## 原則
- 完整生命週期：lock → fetch → validate → publish（staging→canonical）→ seed-meta → release；每步失敗有明確語意。
- **失敗時 extend-TTL-and-retry，絕不寫空資料**；seed-meta 寫失敗只警告、讓舊 meta 自然老化觸發 STALE_SEED。
- TTL ≥ 3× interval（1.33× 會在 jitter 時假 EMPTY）。
- 重疊的 refresh 合併（加入進行中的那一次）；exactly-once 啟動。
- Bundle 有 wall budget：各段最壞時間加總要有 headroom，超時段延後而非整批餓死（starved tick 要記錄）。
- WebSocket relay：high/low water mark 背壓、reconnect＋stale-socket identity guard。

## 台股助手規範
- daemon 雙軌：快線 `hotQuoteLoop`（120 檔優先集，1 req/5s→`marketSnapshot/hot`）＋主迴圈（全市場批 120、1 req/3s→`marketSnapshot/latest`）；總和 ≈ 2.7 req/5s，動任一邊先重算。
- **失敗不寫空**：`loadCodes` 上市＋上櫃缺一邊保留舊快取；`_lastLive` 重啟由 `restoreLastLive()` 接回；尾盤五檔窗（13:20–13:35）記憶體累積，13:36 歸檔前不可重啟。
- 早盤回補 `backfillIntradayMorning`：成功才標 done，失敗 90s 退避重試（等同 extend-and-retry）。
- 快照 TTL 5 分 vs 寫入 40 秒＝7.5×，過規則。
- 每日任務匯流排（21:45 資券、16:10 稽核、06:40 休市日曆）＝ bundle；✅ 已做（F14）：`timedJob()` 逐段計時，>60s 記 ⏱，每輪結束 log 總耗時＋最慢 5 段，寫入 `system/daemonHealth.jobTimings`；wall budget 門檻待累積一週數據再定。
- 非交易時段 daemon 不掃（81% 時間資料不變）。

## 修A錯B 影響面
改任一迴圈節奏 → 重算 MIS 頻寬帳＋檢查 audit 的 maxStale（TTL≥3× 規則）＋前端 `liveQuoteInterval` 的假設。

## 掃描探針
- 反向：`rg -n "set\(\{\}\)|\.set\(\{ *at:" scripts/ai-daemon.mjs`（寫空殼）；正向：daily jobs 有無耗時記錄
