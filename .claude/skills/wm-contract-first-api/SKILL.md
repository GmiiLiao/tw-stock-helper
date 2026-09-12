---
name: wm-contract-first-api
description: 契約優先 API——proto/OpenAPI 生成、allowlist 例外要有型別與移除紀律、路由與實作雙向比對；台股助手以欄位契約與 route 清單稽核替代
---
# wm-contract-first-api｜契約優先 API

**上游依據**（基線 v2.10.0 · 02f2115 · 2026-09-12（第二大腦 second-brain/worldmonitor/））：`proto/**`（313 檔）、`api/api-route-exceptions.json`（888 行 allowlist）、`scripts/enforce-sebuf-api-contract.mjs`、`docs/adding-endpoints.mdx`。**適用度：部分（無 proto，取契約精神）**。

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
