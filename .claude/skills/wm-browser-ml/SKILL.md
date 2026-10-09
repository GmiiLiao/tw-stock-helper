---
name: wm-browser-ml
description: 瀏覽器端 ML 與向量記憶（ONNX 模型登記、worker 合流、embedding 正規化、IndexedDB 向量庫、RAG）與 AI 合成的機械式防幻覺閘——台股助手 AI 走本機 Ollama，取「驗證驅動重試」與「證據閘」部分
---
# wm-browser-ml｜瀏覽器端 ML 與 AI 合成防護

**上游依據**（基線 v2.10.0 · 739f9ea · 2026-10-09（第二大腦 second-brain/worldmonitor/））：`src/config/ml-config.ts`（模型登記：priority／size／required／task）、`src/workers/ml.worker.ts`、`scripts/lib/brief-embedding.mjs`、`CONCEPTS.md`（Extraction Evidence Gate）。**適用度：部分（AI 推論在 daemon 側）**。

## 原則
- 模型以**資料宣告**（id／size／priority／required），下載前做裝置能力閘門；worker 內併發載入合流＋進度串流。
- Embedding：mean-pooled、L2-normalized；語意聚類只做 Jaccard 之上的 refinement（hybrid），不取代確定性去重。
- 向量庫：content-addressed ID、FIFO 淘汰、序列化 transaction queue；worker RPC 邊界做 input clamping 與維度驗證。
- **AI 合成 pipeline：validation-driven retry ＋ 機械式 hallucination gate**——模型報的數值必須出現在同一次抓回的原文裡（Extraction Evidence Gate），否則視為未證明；把安全性放在機械檢查而非 prompt 措辭。
- 無 API key 的本地模式與 provider fallback chain（見 wm-llm-provider-routing）。

## 台股助手規範
- 新聞識讀由 daemon 呼叫本機 Ollama：**必須讀完內文**（記憶 feedback_news_full_content），抓不到內文誠實標示；verdict 落 `newsVerdict/{date}`，完成後 `pushVerdictDone` 訊號。
- 調分只能經 AI 讀內文（禁標題關鍵字動分）；涉法律事件一律利空；產業鏈連動納入。
- **證據閘**（正向待辦）：verdict 引用的數字／公司名必須在原文出現，否則降為「未證實」——上游 Extraction Evidence Gate 的移植。
- 慢件監控：`judgeOneStock` >90s 記 ⏱ 分段時間。

## 修A錯B 影響面
改 verdict JSON 形狀前，grep `verdictJson` 的所有讀端（route、AiNewsTicker、newsDump、shortCandidates）。

## 掃描探針
- 正向：verdict 是否有 evidence 欄；反向：`rg -n "title.*(利多|利空)" scripts/ai-daemon.mjs`（標題關鍵字調分殘留）
