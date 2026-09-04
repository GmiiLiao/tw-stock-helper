---
name: wm-ci-guardrails
description: CI 防護網與抗漂移——分層 pre-push（狀態依賴／樹依賴）、green-tree cache、可執行的架構邊界 lint、Vacuous Guard／Mutation Proof／Wiring Guard／Closed-World Gate／Ratchet Inventory、第三方 rot 分流；台股助手 git hooks 與 lint 擴充依據
---
# wm-ci-guardrails｜CI 防護網

**上游依據**（基線 v2.10.0 · d902d0d · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`.husky/pre-commit`（合併/關閉 PR 分支拒 commit＋unicode 安全）、`.husky/pre-push`＋`scripts/prepush-attest.sh`（tiered gate、green-tree cache、identity gate）、`scripts/lint-boundaries.mjs`（types→config→services→components→app 單向）、`scripts/enforce-*.mjs`（rate-limit-policies／panel-content-writes／safe-html／api-contract／premium-fetch）、`scripts/check-sentry-coverage.mjs`、`check-inventory-count-contracts.mjs`、`CONCEPTS.md` Test & Guard Verification、43 條 workflow。**適用度：部分內化（09-04 起有 hooks）**。

## 原則
- **架構不變式要可執行**：邊界 lint 是「executable authority」，文件只是說明。
- **分層閘門**：狀態依賴檢查（秘密、PR 狀態、lockfile）每次都跑；樹依賴檢查（tsc、lint、bundle、範圍測試）只跑 diff 觸及的面向；設定檔變更或 diff 無法解析就全跑。同一棵樹通過過就快取（green-tree cache，依樹內容鍵）。
- **Vacuous Guard**：斷言「違規清單為空」的守衛，輸入縮水就假綠——要有「0 assertions 即 fail」「--require-live」「最低檢查數」。
- **Mutation Proof**：故意弄壞被保護的東西、看守衛變紅、再 byte-identical 還原；讀守衛只能知道它想做什麼，突變才證明它涵蓋什麼；守衛的守衛也要。
- **Wiring Guard**：守衛存在且通過但從未被任何 workflow 呼叫＝與綠燈無異；要有清單斷言每個守衛被接上。
- **Closed-World Gate**：宇宙從真相來源機械列舉，每個成員必須被分類（必檢／排除＋理由），新成員未分類即失敗——allowlist 的反面。
- **Closed-World 的第二軸（上游 d902d0d 新增）**：宇宙不只是「成員集合」也可能是「**屬性集合**」——只針對 bug 報告裡點名的欄位寫斷言＝枚舉已發生的失敗（保證不再發生的那一組），同物件的其餘欄位仍可在綠燈下漂移。正解：對**每個屬性**斷言不變式，另列短而封閉的豁免清單（消費端真的做 union 合併的欄位）；警訊是「守衛名稱宣稱的不變式，斷言沒有真的執行」。
- **Ratchet Inventory**：已知壞 idiom 的 (file, idiom, count) 普查，雙向強制（多了是漂移、少了是過期紀錄）；有 floor 的要寫明。
- **Third-Party Rot**：exit code 依「誰能修」分流——外部服務不可用時大聲警告但通過，且註明跳過了什麼；只有在外部完全沒回結果時才可軟過。
- lint 而非只寫 test 的理由：要抓的編輯「碰的是 src 不是 tests」（panel-content-writes 註解）。
- 吞錯守衛：catch 只 log 不上報、或空 catch 無註解 → 紅（sentry-coverage）。

## 台股助手規範
- `scripts/git-hooks/pre-commit`（node --check staged .mjs＋欄位契約）、`pre-push`（tsc）；`core.hooksPath` 指向。**半成品碼進 disk 會被 launchd KeepAlive 撿起 crash loop**——這是 pre-commit 存在的理由。
- audit MIN_SOURCES=60 是本站第一個反 Vacuous Guard。已做（2026-09-04 F7/F8/F15）：(1) Mutation Proof：pre-commit 放壞 .mjs → exit 1；audit `--only` 縮到 2 源 → ❌ 稽核範圍異常（記錄於 docs/WM-SCAN-2026-09-04.md）；(2) `scripts/audit-routes.mjs`＋`route-policy.json`：102 route 封閉世界普查（mutating 無 auth/rateLimit 即紅、GET 無 cache 雙向基線）；(3) `scripts/audit-ratchets.mjs`：setInterval 未接 gate 24 檔雙向 Ratchet；兩者接進 pre-commit（碰 src/ 才跑）。**待辦**：(4) hook 依「誰能修」分流 exit code；(5) `check-field-conventions` 改為所有 *At/*Date 未登記即紅（屬性集合軸）。
- daemon 空 catch 現況：0 個裸空、150 個有註解——維持「空 catch 必附理由」。

## 修A錯B 影響面
加新守衛前先跑一次全量看基線紅燈數，紅的先登 Ratchet 而不是放寬規則。

## 掃描探針
- 反向：`rg -c "catch\s*(\(\w*\))?\s*\{\s*\}" src scripts`（裸空 catch）；正向：`git config core.hooksPath`；`rg -l "setInterval\(" src | wc -l` vs 接 gate 數
