---
name: wm-source-aggregation
description: 海量資料源治理——來源可信度分級、SSRF allowlist、付費預算與新鮮度閘門解耦、供應商降級鏈、User-Agent 禮儀；台股助手上游只有 TWSE/TPEx/Yahoo/新聞源但同規則
---
# wm-source-aggregation｜資料源聚合治理

**上游依據**（基線 v2.10.0 · 90dc23a · 2026-09-26（第二大腦 second-brain/worldmonitor/））：`src/services/runtime-config.ts`（每個供應商寫明 fallback 行為）、`docs/data-sources.mdx`、feed catalog／validation CI。**適用度：部分內化**。

## 原則
- 每個來源有**可信度分級**（預設最低），分級表跨部署要 byte-identical 測試鎖定。
- 每個供應商都寫明「缺 key／失敗時降到什麼」（runtime-config 的 `fallback` 欄），UI 顯示 disabled state 而非假資料。
- 付費 API：雙層月預算＋Freshness Gate（cron 頻率與付費頻率解耦，MIN_REFRESH_MIN）。
- RSS／抓取的 domain allowlist 當 SSRF 防線，redirect 逐跳重驗。
- User-Agent：能表明身分就表明；被封才偽裝。伺服器端 fetch 一律帶 UA；對同一上游錯開請求（Yahoo 150ms）。
- 部分成功要保留（降級鏈不是全有全無）。

## 台股助手規範
- 唯一不變式：上游請求數與線上人數脫鉤——**所有上游只由 daemon 打**，web 只讀 Firestore。
- 來源優先序寫死在程式且可稽核：報價 MIS 快線→主迴圈；日線 Yahoo→自家 chipArchive 補尾；BWIBBU rwd PRIMARY→openapi FALLBACK（openapi 整批落後一日）。
- 新聞來源分級：官方／財經媒體／Yahoo 聚合；**論壇一律禁用**；每則帶 `source`／`at`（缺就 null 不捏造）。
- MIS 配額（3/5s，同 IP）是全站共享預算，除錯手打也算；Yahoo 整條斷線（09-02）證明需要熔斷（見 wm-resilience-circuit-breaker F1）。
- 供應商降級要有**可觀測訊號**（daemon log ❌／dataHealth 欄位），不能靜默。

## 修A錯B 影響面
改任一來源的優先序前，先重算 daemon 頻寬帳（快線＋主迴圈 ≈ 2.7 req/5s）與 audit CONTRACTS 的來源期望。

## 掃描探針
- 反向：`rg -n "fetch\(" src/app/api | rg -v "firestore|admin|localhost"`（web 層直打上游）；`rg -n "User-Agent" scripts/ai-daemon.mjs | wc -l`
