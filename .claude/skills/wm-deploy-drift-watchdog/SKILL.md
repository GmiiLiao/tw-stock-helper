---
name: wm-deploy-drift-watchdog
description: 部署漂移看門狗——「線上跑的是不是 main 的 head」與所有 repo 閘門獨立、lag 要量測、post-merge 監控；台股助手 daemon 版本 hash 比對與 App Hosting 部署驗證的規範
---
# wm-deploy-drift-watchdog｜部署漂移

**上游依據**（基線 v2.10.0 · c34156d · 2026-10-02（第二大腦 second-brain/worldmonitor/））：`scripts/check-railway-deploy-drift.mjs`（每服務問一題：跑的是 head 嗎？非肯定即回報；lag p50 0h／p90 19h／max 62.6h 實測）、`scripts/check-postmerge-deploys.mjs`、workflows `railway-deploy-drift／trigger-watchdog／reconcile-manual-recovery／postmerge-deploy-monitor`。**適用度：部分（單機 daemon＋App Hosting）**。

## 原則
- 所有 repo 閘門綠燈時服務仍可能跑舊 image（watch-path 拒推、整合掉訊息、合併後 build 失敗）；舊碼上的容器會發布「看起來很新」的資料，健康檢查看不出來。
- 檢查刻意**與原因無關**：只問「執行中的 source ＝ head？」。
- 延遲是尾巴不是遺失，但修 crash loop 的 commit 被延遲＝事故，repo 內部分不出兩者 → 必須量測 lag。
- 恢復路徑要可手動觸發且有紀錄。

## 台股助手規範
- daemon：~~`can-restart-daemon.mjs` 比對 disk 檔案 hash 與執行中 hash（09-03 曾用）~~
  **更正（2026-09-28·WM-SCAN G4-01）**：`scripts/can-restart-daemon.mjs` **只判重啟保護窗**（`WINDOWS`：盤前判別、開盤即時價還原、尾盤五檔等時段），全檔沒有 hash。
  版本比對實際在兩處：寫入端 daemon 啟動時 `_recordDaemonBuild()`（`scripts/ai-daemon.mjs`）把 `codeHash` 寫進 `system/daemonBuild`；
  比對端 `scripts/audit-data-sources.mjs` 的「daemon 是否落後於程式碼」段以磁碟版重算並比對，不一致印「⚠ daemon 落後於程式碼」。
  兩端共用 `scripts/lib/daemon-code-hash.mjs`（ai-daemon.mjs＋遞迴 import 的 scripts/lib，2026-09-28 G4-02 起）。
  重啟流程＝先看稽核的漂移結果、再 `can-restart-daemon.mjs` 判時窗、再 kickstart。launchd KeepAlive 會在 crash 時撿起 disk 上的**半成品碼**——所以 disk 狀態＝下次執行狀態，改檔即部署。
- web：Firebase App Hosting 由 `firebase deploy`（XDG_CONFIG_HOME 乾淨設定＋SA 憑證）；✅ 已做（2026-09-04 F10）：`/api/system/version` 回 `sha`（next.config build 時 `git rev-parse` 注入）／`builtAt`；部署後 `curl …/api/system/version` 比對 sha＝HEAD 才可宣稱「已部署」。
- F3-b 告警分支已在 disk、daemon 未重啟＝典型「repo 有、線上沒有」的漂移，要在報告裡明寫。

## 修A錯B 影響面
加 version route 屬純新增；daemon 重啟窗規則不變（避開 08:30–09:10、13:20–13:40）。

## 掃描探針
- 正向：`ls src/app/api/system`（無 version 即未做）；~~`node scripts/can-restart-daemon.mjs` 的 hash 一致與否~~
  **更正（2026-09-28·G4-01）**：hash 一致與否看 `node scripts/audit-data-sources.mjs --no-external` 開頭有無「⚠ daemon 落後於程式碼」／「⚠ 無 daemon 版本紀錄」；
  `can-restart-daemon.mjs` 只回答「現在能不能重啟」（保護窗）。

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- ⚠ **本技能既有文字與程式不符（記錄衝突，不刪原文）**：上文「`can-restart-daemon.mjs` 比對 disk 檔案 hash 與執行中 hash」與掃描探針末句不成立——該腳本只判保護窗（`WINDOWS`），全檔無 hash。實際比對在 `scripts/audit-data-sources.mjs:793-810`（讀 `system/daemonBuild.codeHash` 對磁碟 `ai-daemon.mjs` 的 sha256 前 16 碼），寫入端 `scripts/ai-daemon.mjs:126-136`。同一錯誤敘述也在 `docs/外部工具追蹤.md:84`。更正方式待使用者決定（改技能措辭，或把比對搬進 can-restart）。
  → **2026-09-28 已處理：採「改措辭」**（上文「台股助手規範」與「掃描探針」兩處以刪除線保留原文並加更正；`外部工具追蹤.md` 同步）。比對未搬進 can-restart。
- **雜湊要涵蓋實際會執行的全部碼**：`codeHash` 只雜湊 `ai-daemon.mjs` 本體，但 daemon 靜態 import `scripts/lib/*.mjs`（`ai-daytrade-runner`、`ai-swing-runner`、`daytrade-engine`…，`scripts/ai-daemon.mjs:26-33`）與動態 import `squeeze-data.mjs`。只改 lib 的 commit（例 `a9db863` 2026-09-24 只動 `ai-swing-runner.mjs`）不會觸發漂移警告。規則：雜湊集合＝daemon 的本地 import 閉包。
- **偵測網的判定不可建立在單次「成功但未佐證」的讀取上**（上游 `scripts/check-postmerge-deploys.mjs`：GitHub 間歇回舊索引快照，HTTP 200、`total_count` 1366 對實際 3168，120 次中 21 次誤報；解法＝每 tick 取 3 樣本、以單調的 `total_count` 丟棄已證明過期者、警報需 2 樣本一致，否則回 UNKNOWN 而非警報；`CONCEPTS.md` Detection Net）。台股助手對應：判斷「daemon 落後」或「線上 sha≠HEAD」若只讀一次 Firestore／一次 curl（CDN 可能回舊版），結論應寫「單次讀取」；會觸發動作（重啟、重部署）的判定至少再讀一次、或以單調欄位（`startedAt`、`builtAt`）確認不是舊值。
- **看門狗本身要有牆鐘預算，且逾時＝「無法判定」而非「失敗」**（同檔 `MONITOR_WALL_BUDGET_MS`、`createDeadlineGh`：截止時間檢查放在每次嘗試前，逾時標為不可讀、不重試）。台股助手：漂移檢查 `catch { /* 取不到不擋稽核 */ }`（`audit-data-sources.mjs:810`）目前讀不到就完全靜默——應輸出「⚠ 無法判定 daemon 版本」而不是什麼都不說（Read Outcome 三態）。
- **漂移結果要寫進可被觀測的地方**：比對在 `dataHealth` 寫入（`audit-data-sources.mjs:790`）之後才執行且只 `console.log`，線上看不到。建議把 `daemonDrift: { running, disk, checkedAt }` 併入同一次寫入。
- **瀏覽器端也有部署漂移**（上游 `CONCEPTS.md` Stale Bundle／Modal-Open Guard、新 gate `lint:overlay-reload-policy`）：開著的分頁跑舊 JS 對新 API 形狀。台股助手 `/api/system/version` 目前無前端消費端；若要做，比對 `sha` 不同時提示重載，且輸入中（持倉記錄、搜尋框非受控輸入）不可自動重載。
- **web 部署身分要能分辨髒樹**：`next.config.ts:5-8` 的 `git rev-parse --short HEAD` 不標 `-dirty`，從有未提交改動的工作樹 build 時，線上 `sha` 仍等於 HEAD——「sha＝HEAD 才可宣稱已部署」這條在髒樹下會假陽性。
- 部署形態註記：`firebase.json` 為 Hosting＋`frameworksBackend`（region asia-east1），repo 無 `apphosting.yaml`；本技能與 CLAUDE.md 稱「App Hosting」，實際產品名待使用者確認後再統一措辭。
