---
name: wm-realtime-seed-pipeline
description: 即時資料種子管線——runSeed 生命週期（lock→fetch→validate→publish→seed-meta→release）、TTL≥3×interval、失敗延長 TTL 絕不寫空、合併進行中的刷新、WebSocket relay 背壓；台股助手 daemon 迴圈的規範
---
# wm-realtime-seed-pipeline｜種子管線

**上游依據**（基線 v2.10.0 · 90dc23a · 2026-09-26（第二大腦 second-brain/worldmonitor/））：`scripts/_seed-utils.mjs`（2,886 行：acquireLock SET NX PX、atomicPublish、writeFreshnessMetadataSafely、PERMANENT_4XX、allSettledWithConcurrency）、195 個 `seed-*.mjs`、`scripts/ais-relay.cjs`、`CONCEPTS.md` Seed Bundle Orchestration（wall budget／section deferral／graceful skip／starved tick／chunked sweep）。**適用度：深度內化**。

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

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **Fetch Phase Budget：重試用牆鐘預算，不用次數**（`scripts/_seed-utils.mjs` `fetchCoinGeckoWithRetryBudget`；`CONCEPTS.md` 新詞條）：每次退避前把「下一次請求的完整逾時」一起算進預算，放不下就放棄；以次數計的重試會睡過外層逾時，被殺在重試中，寫好的後備來源在它唯一該上場的情境裡永遠跑不到（上游 2026-04-14、09-20 兩次實案）。台股助手：daemon 內任何「失敗→sleep→重試」迴圈都要以截止時刻判斷，不以次數；外層逾時與內層預算寫在不同檔時要有一處同時讀兩者。
- **子程序截止時刻要往下傳，並留寫入預留**（`_seed-utils.mjs` `resolveFetchDeadlineMs`、`FETCH_PHASE_PUBLISH_RESERVE_MS=40s`、`BUNDLE_SECTION_TIMEOUT_MS` #8479）：runner 的 section 逾時會 SIGTERM 子程序，子程序自己的抓取截止必須夾在 `section 逾時 − 40s` 內，讓「寫入」或「優雅放棄（保留 last-good）」有時間完成。台股助手：`execScript(name, args, tag, timeoutMin)` 以 `execFile` timeout 直接殺子程序，子腳本不知道截止時刻；規則：新子腳本若會寫 Firestore，應由環境變數接收截止時刻並在截止前停止抓取。
- **釋放／清理失敗要留痕**（`_seed-utils.mjs` `releaseLock` #8490、共用 `shared/compare-and-delete-script.cjs`）：空 catch 把腳本不相符藏到 TTL 到期；compare-and-delete 腳本只保留一份，seeder 與 server 共用。台股助手：`_xxxDate` 標記、forward-only guard 等「釋放／標記」路徑的 catch 必須 log；同一判斷邏輯不可在 daemon 與 route 各寫一份。
- **記錄鍵不可等於資料鍵，設定期就擋**（`_seed-utils.mjs` `resolveSeedMetaKey`、runSeed 設定期檢查 extraKeys #8424）：上游有 seeder 把 meta 寫到自己的資料鍵，每跑一次就用 44 bytes 心跳蓋掉資料，健康端點卻讀 OK 六個月。台股助手對應：**不同寫者不可用非 merge 的 `.set()` 寫同一份 doc**（心跳／帳戶快照／資料各自一份），衝突要在任何抓取前報錯，而不是寫完才發現。
- **發布要驗所有權（fenced publish）**（`api/health.js` owner publish script、`CONCEPTS.md` Verdict Snapshot）：暫停後醒來的舊 owner 不得用較舊的結果覆寫繼任者已發布的較新結果。台股助手已有 forward-only guard（09-05）擋 latest 被舊資料覆蓋；同理適用於非 await 的並行寫入（例：`_aiSwing.writeAccount()` 每小時一次與 `pick()` 後各呼叫一次，兩者都是讀舊 history→整份 `.set()`）。
- **大 key 讀取逾時要可調**（`_seed-utils.mjs` `readSeedSnapshot({ timeoutMs })`）：固定 5s 對多 MB payload 不夠，逾時會被當成讀失敗。本站大 doc（`marketSnapshot/latest` quotesJson）讀取端同理。
