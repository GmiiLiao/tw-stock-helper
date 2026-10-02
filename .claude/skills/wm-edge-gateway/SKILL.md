---
name: wm-edge-gateway
description: Edge 閘道請求管線——先便宜後昂貴的固定順序（origin→CORS→OPTIONS→key→rate-limit→route→POST→GET 相容→error boundary）、fail-closed CORS、trust-marker 剝除、body 上限、HMAC 內部呼叫；台股助手 route 共同前置的規範
---
# wm-edge-gateway｜閘道管線

**上游依據**（基線 v2.10.0 · c34156d · 2026-10-02（第二大腦 second-brain/worldmonitor/））：`server/gateway.ts`（2,421 行 `createDomainGateway`）、`api/_cors.js`（雙 profile allowlist）、`api/_api-key.js`、`api/_relay.js`。**適用度：部分（Next.js route 各自為政）**。

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

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **trust marker 剝除清單隨內部標頭同步擴充**（`server/gateway.ts` `stripClientTrustedHeaders`）：新增 `x-wm-rl-principal`（gateway 認證完成後才蓋章的限流身分），進場一律刪除 client 自帶的副本；之後每次重建 request 都必須從已剝除版本出發（檔內稱 Mutation invariant）。本站 server 端只讀 `accept-encoding`／`authorization`／`x-cron-secret`／`x-forwarded-for`／`host` 五種標頭，無內部信任標頭。規則：**新增任何「只有我方能設」的標頭前，先寫剝除**，並在 `audit-routes.mjs` 表格加一欄。
- **server 端扇出要在派發前向「入站呼叫者」扣額**（`server/_shared/rate-limit.ts` `resolveServerSubRequestCharge`／`chargeServerSubRequestOperation`，#8399）：同源 fetch 自家 API 時，子請求在 origin 看到的是平台出口 IP（所有使用者同一個），在子請求裡限流＝全體共用一桶、呼叫者自己的額度永遠不動；無法歸屬就 429 `unattributed-sub-request`，不落出口 IP 桶。本站 route 內自呼叫 `/api/*` 0 處（2026-09-27 grep）。規則：**route 內不 fetch 自家 API，直接 import `src/lib` 函式**；非不得已時限流在外層扣。
- **管線順序細化**（`server/gateway.ts`、`server/_shared/rate-limit.ts`）：IP 型預算的「來源證明」檢查 → 限流器可用性 → 認證解析 → principal 型預算 → handler。本站對照：`user/trading-mode:18`、`ai-analysis:104/425` 實作是「IP rateLimit → verifyIdToken」，與本技能上方「驗證 → rateLimit」文字不一致；但 `verifyIdToken(token, true)` 會打 Google 撤銷檢查，IP 限流在前＝先便宜後昂貴，反而較貼近上游。**上游順序為 IP 限流在前、principal 預算在認證後；本站規則是否改寫為「IP rateLimit → 驗證 → uid rateLimit → 邏輯」待使用者決定**（不改寫原文）。
- **「哪些標頭算憑證」只有一份清單**（`server/gateway.ts` `CREDENTIAL_BEARING_HEADERS`，#8400）：快取層（帶憑證的請求不可進共享快取）與 auth 讀取端共用同一常數，並有 divergence test 釘住。本站：帶 `Authorization` 的 route（admin/*、trading-mode、ai-analysis POST/DELETE、system/version）必須 `no-store` 或 `cacheHeader('private')`；新增 per-user route 時同規則。
- **拒絕／降級回應一律 no-store**（`server/_shared/rate-limit.ts`：503 degraded 與 403 edge-proof 本週補上 `Cache-Control: no-store`）。本站 429 已 no-store ✓；延伸為**所有 4xx/5xx 都 no-store**。
- **身分驗證服務暫時不可用 → 503，不降級成匿名或 401**（`server/gateway.ts` `sessionVerificationUnavailableResponse`）。本站 `require-admin.ts:42-44` 把 `verifyIdToken` 的所有例外（含網路逾時）都回 401「Invalid or expired token」——暫時性故障被說成憑證壞掉。規則：`auth/id-token-expired|id-token-revoked|argument-error` 才回 401，其餘回 503。
- **本地模式例外要精確到路徑**（`server/gateway.ts` `isSidecarProviderLookup`）：跳過限流的條件逐條列出 path，且以環境旗標把關，雲端請求保留原限額。本站對應：`ALLOW_DIRECT_MIS` 範本維持。

### 掃描探針（本週新增）
- 無逾時的上游呼叫（逐呼叫，不是逐檔）：`rg -n -A6 "fetch\(" src/app/api src/lib/*-server.ts | rg -v signal` 後人工確認
- 自呼叫：`rg -n "fetch\(.*(/api/|origin)" src/app/api src/lib`

## 2026-09-28 使用者定案（G1-15）

- 上方「mutating route 的順序＝驗證 → rateLimit → 邏輯」**改為：IP rateLimit（便宜）→ 驗證（verifyIdToken，會打 Google）→ principal 預算（如需要）→ 邏輯**。現有 `user/trading-mode`、`ai-analysis`、`ai/strategy-picks` 皆符合；原文保留作歷史，以本節為準。

## 2026-10-02 週更增補（上游 90dc23a→c34156d；1ab4284→c34156d 依據檔無變更）

- **快取層級依資料本質而非 route 性質**（依據：`server/gateway.ts` L303 新增 `'/api/market/v1/get-price-history': 'static'`；同檔 country-stock-index 為 `slow`）：每日收盤歷史＝過去的日子不會變 ⇒ `static`；同一個「市場」族的即時指數則是 `slow`。新 route 進場時一定要在層級表登記，不登記就落到預設層。
- 同一變更也在 rate-limit 表登記（見 [[wm-security-model]] 本週增補）——**新 route 要同時進「快取層級表」與「限流政策表」兩張表**，上游以 lint 強制。
- 台股助手對應：本站 `cacheHeader` 層級（tick/quote/intraday/daily/static/private）沒有「route→層級」的集中表，各 route 自選；`/api/twse/stock-history`、`/api/twse/candles` 這類「過去日 K 不變、只有今天那根會變」的資料應分段：歷史部分 `static`／`daily`、含今日那根時才 `intraday`。是否已如此見本週掃描。
