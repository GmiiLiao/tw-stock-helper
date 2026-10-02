---
name: wm-ci-guardrails
description: CI 防護網與抗漂移——分層 pre-push（狀態依賴／樹依賴）、green-tree cache、可執行的架構邊界 lint、Vacuous Guard／Mutation Proof／Wiring Guard／Closed-World Gate／Ratchet Inventory、第三方 rot 分流；台股助手 git hooks 與 lint 擴充依據
---
# wm-ci-guardrails｜CI 防護網

**上游依據**（基線 v2.10.0 · c34156d · 2026-10-02（第二大腦 second-brain/worldmonitor/））：`.husky/pre-commit`（合併/關閉 PR 分支拒 commit＋unicode 安全）、`.husky/pre-push`＋`scripts/prepush-attest.sh`（tiered gate、green-tree cache、identity gate）、`scripts/lint-boundaries.mjs`（types→config→services→components→app 單向）、`scripts/enforce-*.mjs`（rate-limit-policies／panel-content-writes／safe-html／api-contract／premium-fetch）、`scripts/check-sentry-coverage.mjs`、`check-inventory-count-contracts.mjs`、`CONCEPTS.md` Test & Guard Verification、43 條 workflow。**適用度：部分內化（09-04 起有 hooks）**。

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

## 2026-09-12 週更增補（上游 d902d0d→02f2115）

- **上游新增 `scripts/enforce-safe-local-storage.mjs`（`npm run lint:safe-local-storage`）**：原生 `localStorage.getItem/setItem` 一律被禁，必須走 `safeLocalStorage` 包裝（私密視窗／Safari ITP／被封鎖的站點資料都會讓 accessor 本身丟例外）。這是「屬性集合軸」的封閉世界：不是掃有沒有 try，而是掃「有沒有直接呼叫」。
- **`.husky/pre-push` 的 `PROTO_INPUTS` 從 8 個目錄改成逐檔列舉**（含 package.json／.nvmrc／各產生器腳本）：把「哪些輸入會影響產出」寫成明示清單，才能做 Mutation Proof（改一個不在清單裡的檔就該被抓到）。
- **工作流更名 `lint.yml`→`lint-code.yml`；新增 `sentry-resolve-pin-audit.yml`、`github-stars-refresh.yml`**（各自對應 `npm run audit:sentry-resolve-pins` 與 README 星數快取）。
- 台股助手對應：本站 10 檔 24 處原生 `localStorage` 呼叫，其中 **Portfolio.tsx（2）、MarketPatternBanner.tsx（4）、Navbar.tsx（2，讀那處）未包 try**；其餘 7 檔各自手寫 try。本站沒有共用 helper（`src/lib` 無 safeStorage）。⇒ 掃描結果列為 R9（見 docs/WM-SCAN-2026-09-12.md），修法是新增 `src/lib/safe-storage.ts` 並把「原生呼叫 = 紅」接進 pre-commit，**不是**逐檔補 try。

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **新 lint `lint:overlay-reload-policy`**（`scripts/enforce-overlay-reload-policy.mjs`，494 行；`.husky/pre-push` 碰 `src/` 或該腳本／`scripts/lib/source-scan.mjs` 才跑）：①SITES——寫法表逐條對應 `MODAL_SELECTORS` 的每個子句，self-test 以 deep-equal 釘住兩邊鍵集合（表與真相來源一起動，否則紅）；每條 pattern 附 `probe`（必中樣本）與 `negativeProbe`（必不中樣本）；②LOCKSTEP——每個 `reload()` 消費端都必須查同一道 guard；③檔頭寫明「綠燈證明什麼、不證明什麼」，表外寫法以執行期回報補表。放 lint 而非 test 的理由同 panel-content-writes：要抓的編輯不碰 tests/。
- **新 pre-push 項 `sync-sentry-convex-probe-filters.mjs --check`**（`.husky/pre-push` convex 分支；`package.json` `check:sentry-convex-probe-filters`）：**清單由原始碼機械推導、已提交的清單與推導結果不同即紅**（`--write` 重產、`--check` 比對、`--apply` 遠端合併且「絕不清掉受保護行」並讀回確認）。取代手寫名稱 allowlist 的「跑步機」。
- **CONCEPTS Vacuous Guard 新增第 10～12 型、Mutation Proof 新增盲點**：⑩**替身比真實函式庫更寬**——手寫 double 回應了真實函式庫沒有／會拒絕的東西，守衛驗的契約是虛構的；「比真實更寬」比「更窄」危險（窄的會大聲失敗）；正解是從已安裝的函式庫推導允許面、雙向斷言；對未安裝依賴的 double，Mutation Proof 也要突變替身本身（把幻影方法加回去，要求有東西紅）。⑪斷言在**錯的分支**上成立（fixture 缺前置條件、走了 fallback）；⑫fixture 用了生產永遠不用的環境值。正解：路徑旁邊同時斷言「沒走的那條」、環境值至少以兩個真實值參數化。
- **Detection Net／Superseded Run／Superseded Failure**（CONCEPTS 新詞條）與本週 5 條新 workflow 的共同工程作法：
  - 外部活性探測**與 PR／部署閘門分離**（`openrouter-free-models-live.yml`、`mcp-preset-liveness.yml`、`live-video-source-audit.yml`：schedule＋dispatch，明言 NOT pull_request，因為第三方壞掉不是 PR 造成的）；發現→開／更新**同一張 issue**，只有「監控基礎設施自己壞了」才讓 job 紅。
  - **`node --test` 在 describe 被 skip 時 exit 0**，且套件含常駐 fixture case，通過數證明不了 live case 有跑 ⇒ 以 TAP reporter 逐一要求**指名的 live case 為 `ok` 且未 skip**（`openrouter-free-models-live.yml` run 區塊）。
  - **監控別的排程工作**（`pulse-freshness-monitor.yml`：被監控的 workflow 09-02～09-14 連敗 4 次無人知；GitHub 只寄信給最後改 cron 那行的人）：同時看「最後一次結論」與「產物本身的年齡」——後者才抓得到根本沒觸發的排程；被後來的手動產物超越的失敗＝Superseded，不再重複告警；沒有時戳的一律不算超越（fail closed）。
  - **缺憑證＝待辦前置條件，不是失敗**（`seo-gsc-weekly.yml` guard job：secret 缺時綠燈並註明跳過了什麼）——即既有 Third-Party Rot 分流原則的 workflow 實作。
  - 探測預算：逐步 `timeout-minutes`，總和＋餘裕由測試對 job 上限驗證（`live-video-source-audit.yml` 註解）。
- `deploy-gate.yml`：24h 內的 pending／**failure／error** 狀態都會被 sweep 重評（先前只重評 pending），修復「成功重跑的事件讀到舊 check 而卡住」；base-drift 比對改 `fetch-depth: 0`＋`filter: blob:none`。本站無 GitHub Actions，參考級。
- 台股助手對應規則：
  1. **Wiring Guard 缺口**：`scripts/lib/*.test.mjs`（4 檔 32 例，2026-09-27 本機全過）**沒有接進任何 hook**（`scripts/git-hooks/pre-commit`、`pre-push` 皆無 `node --test`）⇒ 碰 `scripts/lib/` 時應跑對應測試；並要求「測試數 ≥ 基線」防縮水。
  2. **替身比 Firestore 寬（第 10 型實例）**：`scripts/lib/ai-daytrade-lab.test.mjs:49-56`、`ai-swing-lab.test.mjs:53-60` 的 `fakeDb.set()` 接受 `undefined`、`orderBy()` 不看欄位也不排除缺欄位文件；真實 Admin SDK 會拒收 undefined——2026-09-24 當沖警示正因 `split: undefined` 整天被拒 956 次（`daytrade-desk.test.mjs:80` 事後補了專測）。⇒ 共用一個 fake，`set/update` 深掃 undefined 即 throw。
  3. **Ratchet 寫法表要列舉＋自測**：仿 SITES 的 probe／negativeProbe，`audit-ratchets.mjs` 的 GATE／輪詢寫法各附必中與必不中樣本；以呼叫點計數（理由與實例見 wm-smart-polling-startup 本週增補）。
  4. 既有條文校正（不刪原文）：「setInterval 未接 gate 24 檔」→ 現基線 22（`route-policy.json` 註記 09-18 QuoteGrid、09-22 LimitUpPanel；後者屬寫法逃逸，非真修）。

## 2026-10-02 週更增補（上游 90dc23a→c34156d；1ab4284→c34156d 依據檔無變更）

- **上游新增 `.github/workflows/codeql.yml`（技術棧訊號：新 CI workflow）**——判定**不構成新技術族**，併入本技能（理由：它是既有「閘門選擇／不讓 skip 冒充通過」原則的又一實作；本站無 GitHub Actions、無 CodeQL）。上游作法（依據：ARCHITECTURE.md workflow 表 codeql 列、CONTRIBUTING.md 交接節）：
  ①**依變更路徑選 job，但「查不到變更清單／查詢不完整」一律全跑**（不確定時往多掃的方向失敗）；rename 兩側與相依清單都算；動到掃描設定本身也全跑；
  ②被選中的 job 掃整個 repo，**路徑只決定跑哪些 job，不決定掃哪些檔**；
  ③排程與手動掃描**不會被 PR 活動取消**；只有同一 PR 的舊掃描被新 commit 取消；
  ④明文寫出**落後窗**（預設分支 JS/TS 最多落後 1 天、其他語言 1 週）——不宣稱比實際更即時；
  ⑤快取每次都存新 key、從不清 ⇒ 自帶 prune job 只留每組最新一份。
- **`deploy-gate.yml` 新增 concurrency 佇列**（依據：deploy-gate.yml L30-36、evaluate-direct job）：同一 SHA 的評估排隊（`queue: max`、`cancel-in-progress: false`），**只取代尚未開始的請求；執行中的仍持有 SHA 寫入鎖；排程失效重評與手動復原永不被擠掉**。原則：**取消／去重只能作用在還沒開始的工作**，不能打斷持鎖的寫者。
- **CONCEPTS「Reload Guard」補一句**（依據：CONCEPTS.md L215）：延後重新載入**沒有上限**，所以前提是使用者**一定關得掉**它保護的對話框——關閉鈕被遮住或失效的阻擋式對話框會讓分頁整個 session 停在舊版。
- 台股助手對應規則：
  1. **測試選擇要「不確定就全跑」**：`scripts/git-hooks/pre-commit:20` 只在 staged 檔落在 `scripts/lib/` 時跑 `scripts/lib/*.test.mjs`；若測試匯入的模組在 `scripts/lib` 之外（daemon 主檔、`src/lib/*` 共用純函式），改那些檔不會觸發測試 ⇒ 觸發集合應由 import 閉包推導（同 `scripts/lib/daemon-code-hash.mjs` 的作法），推導失敗時全跑。實況見本週掃描。
  2. 去重／合流只能吃「尚未開始」的工作：daemon 排程若以旗標略過「同時段第二次觸發」，不可讓**手動補跑**被同一旗標擋掉（對照 `system/daemonJobMarks` 機制）。
  - **更正（同日掃描實測）**：16 個 `scripts/lib/*.test.mjs` 的 import 閉包共 39 檔、**全部在 scripts/lib 內**，第 1 條「測試匯入外部模組而漏跑」目前不成立；實際缺口是未被任何測試覆蓋的模組（ledger-replay、holding-strategy 等）、`src/lib` 零測試、tech-score／risk-score 兩份實作未對拍、無測試數下限。規則本身（觸發集合由閉包推導、推導失敗全跑）保留，供未來測試跨出 scripts/lib 時使用。
