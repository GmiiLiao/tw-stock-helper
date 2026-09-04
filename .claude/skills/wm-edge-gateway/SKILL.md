---
name: wm-edge-gateway
description: Edge 閘道請求管線——先便宜後昂貴的固定順序（origin→CORS→OPTIONS→key→rate-limit→route→POST→GET 相容→error boundary）、fail-closed CORS、trust-marker 剝除、body 上限、HMAC 內部呼叫；台股助手 route 共同前置的規範
---
# wm-edge-gateway｜閘道管線

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`server/gateway.ts`（2,421 行 `createDomainGateway`）、`api/_cors.js`（雙 profile allowlist）、`api/_api-key.js`、`api/_relay.js`。**適用度：部分（Next.js route 各自為政）**。

## 原則
- 管線順序固定且**先便宜後昂貴**：拒絕的 origin 不帶 CORS header；CORS 產生失敗即 fail-closed。
- 進入時剝除 client 送來的 trust marker（defense in depth）；body 大小上限；POST→GET 相容轉換每個維度有硬界限。
- 內部呼叫用 HMAC＋replay nonce 原子宣告。
- Route matching：static Map 先、dynamic 線性掃描後。
- Error boundary 統一組裝回應、drain 語意。
- Edge 自足性：不 import server/src（lint＋bundle 測試強制）。

## 台股助手規範
- 本站無中央 gateway；共同前置散在 `require-admin`／`cron-auth`／`rate-limit`／`api-cache` 四個 helper。**規矩**：mutating route 的順序＝驗證（cron/admin/idToken）→ rateLimit → 邏輯；GET＝cacheHeader 必有。
- 服務區域 asia-east1；`fetch` 一律 `AbortSignal.timeout(8000)`（function timeout 120s，hang 會佔滿 worker→全站 503）。
- server 端禁 import client SDK `@/lib/firebase`，用 `getAdminDb()`。
- **正向待辦**：`withRoute({auth, rateLimit, cache})` 包裝器把順序固定下來（呼應 wm-contract-first-api 的 route 清單稽核）。

## 修A錯B 影響面
包裝器導入必須逐 route、保留原回應形狀與標頭；先做 Closed-World 清單再遷移。

## 掃描探針
- 反向：`rg -L "AbortSignal.timeout" $(rg -l "fetch\(" src/app/api)`（無逾時）；`rg -n "from '@/lib/firebase'" src/app/api`
