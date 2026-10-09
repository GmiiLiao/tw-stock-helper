---
name: wm-observability-degradation
description: 降級可觀測性——marker header、錯誤分級與 fingerprint、吞錯守衛、自我監控不信任部署狀態；台股助手 X-Data-Source、dataHealth 告警、daemon log 慣例的規範
---
# wm-observability-degradation｜可觀測的降級

**上游依據**（基線 v2.10.0 · 739f9ea · 2026-10-09（第二大腦 second-brain/worldmonitor/））：`api/_rate-limit.js`（`RATE_LIMIT_DEGRADED_HEADERS`、`rateLimitErrorLevel`、`rateLimitFingerprintStage`）、`api/_sentry-edge.js`、`scripts/check-sentry-coverage.mjs`、`scripts/check-analytics-collector.mjs`（「不要相信 deployment status」）。**適用度：部分**。

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

## 2026-09-12 週更增補（上游 d902d0d→02f2115）

- 新增 `scripts/audit-sentry-resolve-pins.mjs` + 工作流 `sentry-resolve-pin-audit.yml`：定期稽核「被標成 resolved 但 pin 住的 issue」是否又冒出來，避免「解決」變成靜音。依賴新增 `@sentry/vite-plugin`（source map 上傳）。
- 台股助手對應：本站無 Sentry；同類風險是 `docs/DATA-INTEGRITY-SCAN.md` 的「查過且乾淨」清單——它是 pin，不是 resolve。規範：**每週掃描必須重跑那份 grep，不得沿用上週結論**。

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **可被外部任意觸發的拒絕，回報要 latch**（`api/_rate-limit.js`、`server/_shared/rate-limit.ts` `reportEdgeProofRequiredOnce`，#8402）：偽造標頭造成的 403 每個 isolate 只上報一次（`Symbol.for` 全域 latch），否則「回報」本身就成為放大攻擊面。本站：daemon 的 `notifyDeveloper`／Telegram 目前只由 daemon 內部事件觸發 ✓；規則：日後若有 API 端事件會推 Telegram，必須加 latch／冷卻。
- **固定 stage、可變內容進 message**（`server/_shared/rate-limit.ts` `chargeServerSubRequestOperation`）：攻擊者可控的 pathname 放在錯誤訊息，不放在 stage／fingerprint，Sentry 分組與每分鐘去重 map 維持低基數。本站：`[singleflight] ${key} failed` 的 key 可能含使用者參數；目前只寫 log 無害，日後接告警聚合時 key 不可直接當分組鍵。
- **不同故障不同 marker**（`server/_shared/rate-limit.ts`）：Redis 故障＝503＋`X-RateLimit-Mode: degraded`；來源證明失敗＝403＋`X-RateLimit-Mode: edge-proof`；子請求無歸屬＝429 body `reason: 'unattributed-sub-request'`（可 grep，與真 429 區分）。本站 F4（`X-Data-Mode`）仍 0 覆蓋，本條是 F4 的設計依據：stale-serve、negative-cache 回舊值、讀失敗三者要分得開。
- **對外一致、對內細分**（`server/gateway.ts` `internalMcpReasonFor`）：拒絕回應對 client 完全相同，telemetry reason 細分為 `internal_mcp_ts_window`／`_bad_nonce`／`_replay`…只留伺服器端。本站對應：route 錯誤回應不要夾帶 `String(e)`（會外洩內部訊息），細節寫 log。
- **呼叫端提供穩定分組鍵**（`api/_sentry-edge.js` `captureEdgeException(err, ctx, vctx, fingerprint)`）。本站無 Sentry，對應物是 `notifyDeveloper(text, id)` 的 `id`；規則：id 必須真的成為去重／分組鍵（WebPush `tag`），否則不同告警在裝置上互相覆蓋或同一告警重複轟炸。
- **告警出口本身失敗要看得見**：本站延伸——Telegram 是告警出口，`tgApi` 失敗（`.catch(() => null)`）或 `ok:false` 若不記 log，就是「監控在、但沒人收到」。
- CONCEPTS 新詞條 **Ownership Tag／Stack Backfill／Engine-Split Wording**（`CONCEPTS.md`）：以訊息字串比對的抑制清單看不到 frame／tag，同一故障會依執行環境措辭被切成兩半，看得見的一半像「只有某環境才壞」。本站對應：新增任何「依錯誤字串忽略」的 log 抑制前，先查另一種措辭（Node 版本／undici 的 `fetch failed` vs `AbortError` vs `TimeoutError`）。

### 掃描探針（本週新增）
- 無註解的 promise 吞錯（舊探針只查 `catch {` 區塊，漏掉這一型）：`rg -n "\.catch\(\(\) => \{\}\)" scripts/ai-daemon.mjs src | rg -v "//"`
- 讀失敗包成 200：`rg -n "NextResponse.json\((null|\{ *news: *\[\])" src/app/api src/lib`
