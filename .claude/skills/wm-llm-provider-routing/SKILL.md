---
name: wm-llm-provider-routing
description: LLM 供應商路由——每個 provider 宣告 fallback 鏈、無 key 本地模式、只有 401/403 才判 key 失效、使用者端可切換；台股助手 daemon 本機 Ollama 單供應商的降級規範
---
# wm-llm-provider-routing｜LLM 供應商路由

**上游依據**（基線 v2.10.0 · 739f9ea · 2026-10-09（第二大腦 second-brain/worldmonitor/））：`src/services/runtime-config.ts`（Ollama/LM Studio → Groq → OpenRouter → 瀏覽器本地模型；每項寫 `fallback` 文字；「只有 provider 明確回 401/403 才算 key 失效」）、`src/services/settings-manager.ts`。**適用度：部分**。

## 原則
- 供應商鏈以資料宣告，每層寫明失敗降到哪；UI 顯示 disabled/limited state 而非假結果。
- 網路錯誤／逾時不等於 key 失效；不因 transient 把 provider 標死。
- 本地（Ollama）優先於雲端是桌面模式的預設；無任何 key 也要有可用的本地路徑。

## 台股助手規範
- daemon 只有本機 Ollama（6 處引用，無第二供應商）：Ollama 不可用時**不得靜默**——`pushVerdictDone` 帶 stopped/failed 計數；09-01 實案「Ollama 來不及處理由我先處理」是人工降級。
- web 層 `ai/compare-agent` 直打 localhost:11434（生產必死）已加 rateLimit；`news-agent` 已下架（2026-09-04 R2）。
- ✅ 已做（F11）：`probeOllama()` 打 `/api/tags`（5s 逾時）開機＋每小時，連同熔斷器狀態寫 `system/daemonHealth`（獨立文件，不與 audit 覆寫的 dataHealth 互踩）；模型不在列或不可達即 ❌ log。
- 判定結果落地要標 provider/model 版本（verdict 的可追溯性）。

## 修A錯B 影響面
改 Ollama 呼叫的逾時或重試前，先看 `judgeOneStock` 的慢件計時與 evening/morning pass 的總時限（08:30 前完成的硬要求）。

## 掃描探針
- 反向：`rg -n "11434" src/app/api`（web 層直打本機）；正向：`rg -n "ollama.*health|/api/tags" scripts/ai-daemon.mjs`

## 2026-10-09 週更增補（上游 c34156d→739f9ea）

- **移除一個供應商要整條鏈一起改**（依據：`src/services/runtime-config.ts` 移除 Groq：秘密鍵型別、功能開關、預設值、自己那一項，以及**上一項的 fallback 說明文字**「Falls back to Groq, then OpenRouter…」改成「Falls back to OpenRouter…」；OpenRouter 的描述從「Secondary」改為主要；`_seed-utils.mjs` 註解裡的供應商名也改成泛稱）：只刪設定、不改其他項目的 fallback 文字，設定頁就會描述一條不存在的備援路徑。
- 台股助手對應規則：本站 AI 鏈（daemon Ollama、分析師團隊 claude -p、Jev／typesafe 影子）更換或移除任何一個引擎時，同一個 commit 要一併改：呼叫端的備援順序、失敗時顯示給使用者的文字（如「改用 xxx」）、技能與 CLAUDE.md 排程表的描述、source-registry 登錄；改完 grep 舊引擎名確認沒有殘留的說明文字。
