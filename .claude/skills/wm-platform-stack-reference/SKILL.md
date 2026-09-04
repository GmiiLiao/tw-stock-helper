---
name: wm-platform-stack-reference
description: 上游平台棧參考——Convex 即時後端＋Dodo 計費＋Clerk 認證、Tauri 2 桌面＋Node sidecar、i18n 20+ 語系 AI 翻譯管線、Railway/Vercel/Cloudflare 拓撲、Umami/Sentry；台股助手不適用但每週增刪比對用
---
# wm-platform-stack-reference｜平台棧參考（不適用）

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`convex/`（141 檔：billing/entitlements、API keys、broadcast、company monitoring、向量記憶）、`src-tauri/`（69 檔）＋`local-api-server.mjs` sidecar、`locales/`＋`translate-locales.mjs`（@anthropic-ai/sdk）、`deploy/`、`docker/`（Umami）、`workers/`（Cloudflare×2）、`consumer-prices-core/`（Playwright 爬蟲）、`CONCEPTS.md` Billing & Entitlements（Affirmative Denial／Covering Subscription）。**適用度：不適用（單人使用、Firebase 全家桶）**。

## 為何列在技能庫
- 使用者規則：上游**增刪技術棧本地技能也要增刪**——本條是「不適用族」的容器，每週同步腳本的 dep/dir/ci 增刪若落在此族，在此更新而不新開技能。
- 可借的抽象：Affirmative Denial（權限拒絕要是明確的否定，不是缺少肯定）、Entitlement 與 plan family 分離、翻譯來源標記（Translation Provenance／Stale Translation）。

## 台股助手對照
- 認證 Firebase Auth＋admin 名單；無計費；桌面無；中文單語；部署 App Hosting asia-east1；分析後台自建（記憶 project_tw_stock_app_analytics）。

## 每週檢查
- `bash scripts/wm-weekly-sync.sh` 的「技術棧增刪」段若出現 convex/tauri/locales/workers 之外的新頂層目錄或新 dep 族 → 判斷是否新開技能。
