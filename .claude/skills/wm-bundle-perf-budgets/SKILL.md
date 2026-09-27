---
name: wm-bundle-perf-budgets
description: 前端效能預算——三套 bundle budget（main/pro/embed）CI 強制、style/layout budget、web-vitals、視窗條件 priming；台股助手參考級（Next.js 自動切分）
---
# wm-bundle-perf-budgets｜效能預算（參考）

**上游依據**（基線 v2.10.0 · 90dc23a · 2026-09-26（第二大腦 second-brain/worldmonitor/））：`package.json` `bundle:budgets|check|*pro|*embed`、`scripts/check-style-layout-budget.mjs`、`perf-style-layout-budget` workflow、`CONCEPTS.md` Panel Mounting（Immediate/Deferred tier、Shift Victim/Mover、Late-Mount Window）。**適用度：參考**。

## 原則
- 預算是數字且 CI 紅燈，不是建議；每個變體一套。
- 版面穩定：延後掛載的面板要有 deferred-shell 契約（先占位再填內容，避免 shift）；viewport 條件 priming 用兩種 margin。
- 每份文件的數字從程式碼推導（docs-stats）。

## 台股助手規範
- Next.js 自動 code-split；手機端規矩：**全市場清單先 `.slice()`**（1,700 tile 捲不動）；zustand 一律帶 selector。
- 若要導入：`next build` 的 route size 表存成基線 JSON，pre-push 比對超過 +10% 即紅（小工作量，價值中）。

## 掃描探針
- 反向：`rg -n "useAppStore\(\)" src`（無 selector）；`rg -n "\.map\(" src/components/Screener*` 看有無 slice
