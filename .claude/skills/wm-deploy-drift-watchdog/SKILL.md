---
name: wm-deploy-drift-watchdog
description: 部署漂移看門狗——「線上跑的是不是 main 的 head」與所有 repo 閘門獨立、lag 要量測、post-merge 監控；台股助手 daemon 版本 hash 比對與 App Hosting 部署驗證的規範
---
# wm-deploy-drift-watchdog｜部署漂移

**上游依據**（基線 v2.10.0 · 02f2115 · 2026-09-12（第二大腦 second-brain/worldmonitor/））：`scripts/check-railway-deploy-drift.mjs`（每服務問一題：跑的是 head 嗎？非肯定即回報；lag p50 0h／p90 19h／max 62.6h 實測）、`scripts/check-postmerge-deploys.mjs`、workflows `railway-deploy-drift／trigger-watchdog／reconcile-manual-recovery／postmerge-deploy-monitor`。**適用度：部分（單機 daemon＋App Hosting）**。

## 原則
- 所有 repo 閘門綠燈時服務仍可能跑舊 image（watch-path 拒推、整合掉訊息、合併後 build 失敗）；舊碼上的容器會發布「看起來很新」的資料，健康檢查看不出來。
- 檢查刻意**與原因無關**：只問「執行中的 source ＝ head？」。
- 延遲是尾巴不是遺失，但修 crash loop 的 commit 被延遲＝事故，repo 內部分不出兩者 → 必須量測 lag。
- 恢復路徑要可手動觸發且有紀錄。

## 台股助手規範
- daemon：`can-restart-daemon.mjs` 比對 disk 檔案 hash 與執行中 hash（09-03 曾用）；launchd KeepAlive 會在 crash 時撿起 disk 上的**半成品碼**——所以 disk 狀態＝下次執行狀態，改檔即部署。
- web：Firebase App Hosting 由 `firebase deploy`（XDG_CONFIG_HOME 乾淨設定＋SA 憑證）；✅ 已做（2026-09-04 F10）：`/api/system/version` 回 `sha`（next.config build 時 `git rev-parse` 注入）／`builtAt`；部署後 `curl …/api/system/version` 比對 sha＝HEAD 才可宣稱「已部署」。
- F3-b 告警分支已在 disk、daemon 未重啟＝典型「repo 有、線上沒有」的漂移，要在報告裡明寫。

## 修A錯B 影響面
加 version route 屬純新增；daemon 重啟窗規則不變（避開 08:30–09:10、13:20–13:40）。

## 掃描探針
- 正向：`ls src/app/api/system`（無 version 即未做）；`node scripts/can-restart-daemon.mjs` 的 hash 一致與否
