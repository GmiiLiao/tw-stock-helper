---
name: wm-contract-first-api
description: 契約優先 API——proto/OpenAPI 生成、allowlist 例外要有型別與移除紀律、路由與實作雙向比對；台股助手以欄位契約與 route 清單稽核替代
---
# wm-contract-first-api｜契約優先 API

**上游依據**（基線 v2.10.0 · c34156d · 2026-10-02（第二大腦 second-brain/worldmonitor/））：`proto/**`（313 檔）、`api/api-route-exceptions.json`（888 行 allowlist）、`scripts/enforce-sebuf-api-contract.mjs`、`docs/adding-endpoints.mdx`。**適用度：部分（無 proto，取契約精神）**。

## 原則
- 契約是唯一真相：路徑／動詞／驗證約束寫在 proto，四輸出（client／server／OpenAPI／bundle）由 `make generate` 生成；**不得手改生成物**。
- 例外清單要**型別化分類＋removal issue**，不是無限期豁免。
- 雙向比對：gateway 有的 route 必在 generated service 裡、反之亦然，錯誤附 remedy。
- `unimplemented` 誠實旗標：沒做的 RPC 明說，不回假成功。
- AST 驗證 query-param 契約（anti-vaporware）：文件宣稱的參數必須真的被讀。

## 台股助手規範
- 本站契約層＝`scripts/check-field-conventions.mjs`（xxxAt／xxxDate 欄位登記，pre-commit 強制）＋ `audit-data-sources.mjs` CONTRACTS 表（每資料源的 maxStale／minRecords／dateField／市場組成）。
- 新增 API route 必做三件事：cacheHeader 層級、rateLimit（mutating）、若讀 daemon latest doc 用 `latestDoc()`；回應形狀變更要同步前端型別（TS 會擋）。
- 例外（直打上游的 fallback 路徑）必須有總開關與註解說明為何存在（`ALLOW_DIRECT_MIS` 是範本）。
- ✅ 已做（F7）：`scripts/audit-routes.mjs --table` 列 102 route 四欄；政策在 `scripts/route-policy.json`。

## 修A錯B 影響面
改回應欄位名 ＝ 改契約：先 grep 前端所有消費端與 daemon 寫入端；欄位改名走登記表。

## 掃描探針
- 反向：`node scripts/check-field-conventions.mjs`；`rg -L "cacheHeader|latestDoc|no-store" src/app/api --glob route.ts`（無快取宣告的 route）

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **例外條目四欄齊全、行為變就重分類**（`api/api-route-exceptions.json`）：本週新增的 `api/mcp/structured-content.ts`、`api/notification-suppressions.js` 都帶 `category`／`reason`／`owner`／`removal_issue`；`api/youtube/live.js` 行為改變（頻道直播偵測退役、改 oEmbed 代理）時在同一變更裡把 category 由 `non-json` 改為 `upstream-proxy` 並重寫 reason。本站對應：`scripts/route-policy.json` 的 `exemptMutating`（目前空）與 `_getNoCacheKnown`——route 行為改變時同一 commit 更新理由，過期理由視同違規。
- **退役功能回明確錯誤碼，不回空**（`CHANGELOG.md` #8167）：`/api/youtube/live?channel=` 改回 **410**＋`{"error":"channel_live_detection_retired"}`（可快取一天）；已棄用欄位為 wire 相容保留但恆為固定值；CHANGELOG 寫遷移路徑與「沒有替代品」。本站：下架或「生產環境安全地壞著」的路徑，要回可辨識的錯誤碼（例：410＋`{error:'retired'}`），前端才不會把「功能已退役」當成「今天沒資料」。
- **政策登記表每條附 reason，且對得上真路徑**（`server/_shared/rate-limit.ts` `ENDPOINT_RATE_POLICIES`＋`FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED`；本週新增 12 條，全屬「呼叫端可控參數→cache miss→打外部供應商」）。本站 `rateLimit(request, name, n)` 散在 14 支 route、name 是自由字串。規則：`audit-routes.mjs --table` 應增印 name／limit，並把「外打上游且參數可控」列為**必須**有 rateLimit 的類別（Closed-World，缺即紅）——目前只檢查 mutating。

## 2026-10-02 週更增補（上游 90dc23a→c34156d；1ab4284→c34156d 依據檔無變更）

- **`api/api-route-exceptions.json`**（依據：該檔新增 7 條 `api/mcp/registry/*.ts`、1 條 `api/mcp/ui/news-dashboard-app.ts`）：**不匯出 HTTP route 的模組只要放在 `api/` 底下也要登記例外**（四欄：category／reason／owner／removal_issue），reason 寫明「不是 route、讀哪些既有 RPC」。即「目錄＝契約範圍」，不靠「它其實不是 route」的口頭豁免。同時清掉了檔內空行（格式由工具維持）。
- 台股助手對應：`scripts/audit-routes.mjs` 以 `src/app/api/**/route.ts` 為普查單位；`src/app/api` 底下若有非 route 的輔助檔（`_*.ts`、`lib.ts`），應明列在普查的「非 route 清單」而非被略過。實況見本週掃描。
