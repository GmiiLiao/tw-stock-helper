---
name: wm-observability-degradation
description: 降級可觀測性——marker header、錯誤分級與 fingerprint、吞錯守衛、自我監控不信任部署狀態；台股助手 X-Data-Source、dataHealth 告警、daemon log 慣例的規範
---
# wm-observability-degradation｜可觀測的降級

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`api/_rate-limit.js`（`RATE_LIMIT_DEGRADED_HEADERS`、`rateLimitErrorLevel`、`rateLimitFingerprintStage`）、`api/_sentry-edge.js`、`scripts/check-sentry-coverage.mjs`、`scripts/check-analytics-collector.mjs`（「不要相信 deployment status」）。**適用度：部分**。

## 原則
- 每條降級路徑回 **marker**（header 或欄位），前端能分辨「拿到的是降級資料」。
- 錯誤分級：transient（timeout／ECONNRESET／script timeout）=warning、misconfig=error、未知=error；fingerprint 只留低基數 head＋封閉集合的失敗模式，避免一次 Redis 慢就開一百個 issue。
- catch 只 console.error 不上報＝隱形；空 catch 要附 `/* why */`。
- 監控「實際寫入」而非「部署成功」。
- 觀測點不可因重啟失效（本站硬規定）。

## 台股助手規範
- 已有 marker：`mis-quote` 回 `X-Data-Source`；`latestDoc` 錯誤分支 no-store。**正向待辦 F4**：其他走 stale/fallback 的 route 統一回 `X-Data-Mode: live|stale|fallback`。
- daemon log 慣例：❌ 資料源健康／⏱ 慢件／✓ 歸檔；16:10 告警段讀 dataHealth（含 `auditIncomplete`）；Telegram 推播是告警出口。
- 重啟前 `node scripts/can-restart-daemon.mjs`（觀察點保護）；重啟後比對 disk hash 與執行中版本。
- 空 catch：daemon 150 個皆附註解，維持。

## 修A錯B 影響面
加 header 不改 body，前端 fetch 不受影響；但 CDN 快取鍵不含 header，stale 與 live 共用同一快取條目——marker 只能反映 origin 當時狀態。

## 掃描探針
- 正向：`rg -l "X-Data-Source|X-Data-Mode" src/app/api | wc -l`；反向：`rg -n "console.error" src/app/api | wc -l` vs 有 marker 的 route 數
