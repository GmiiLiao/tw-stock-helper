---
name: wm-authoritative-identity
description: 權威身分解析、拒絕啟發式猜測、三態解析結果——對應台股助手「不捏造預設值」與端點身分驗證規矩
---
# wm-authoritative-identity｜權威身分解析

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`CHANGELOG.md` #5695（SEC CIK 解析取代 domain-slug 啟發式）、`CONCEPTS.md`（Filer／Filer Resolution）。**適用度：內化（同源規矩）**。

## 原則
- 只接受能唯一指認的 key（登記在案的代號；名稱唯一時才收）；**歧義時解析為「無」，不做 tie-break**——按標題長度排序之類的代理指標是猜測不是解析。
- 「唯一」不等於「身分」：低精度 key（網域、slug）只有在登記簿本身能證實配對時才可用，且證據缺失時 fail-closed；無法證實的 key 乾脆不提供（永遠過不了的守衛只是安全的外觀）。
- 解析結果**三態**：解析成功／查無此公司（真答案，可快取）／登記簿讀不到（基礎設施故障，**絕不可快取為權威的否定**）。
- 解析錯一個 filer ＝ 下游所有欄位同時錯，且安靜。

## 台股助手規範
- 股票代號→名稱／市場：唯一權威是 daemon 從 TWSE/TPEx 清單寫的 `marketSnapshot` nameMap；前端 `allStocks`。禁止用名稱模糊比對反查代號。
- 注意股／處置股解析統一在 `src/lib/risk-stocks-source.ts`，端點身分（表名、欄位）要驗證，不再複製第三份。
- 新聞歸戶到個股：以代號＋全名精確匹配；只憑簡稱或關鍵字命中的要標 `matchKind` 並降權，不得直接調分（見記憶 feedback_news_score_requires_ai_content）。
- 「查無」與「抓失敗」在 API 回應與 Firestore 文件都要能分辨（例：`emptyReason` 欄，bookDepth 已採用）。

## 修A錯B 影響面
改名稱／代號對照表的來源前，先 grep 所有讀 nameMap 的消費端（WarRoom、ShortPanel、AiNewsTicker chips、newsDump）。

## 掃描探針
- 反向：`rg -n "\|\| '[^']{2,}'" src/lib src/app/api scripts/ai-daemon.mjs`（資料欄位的字串預設值）
- 正向：新的「查無」回應是否與「失敗」用不同欄位表達
