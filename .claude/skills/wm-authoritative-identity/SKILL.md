---
name: wm-authoritative-identity
description: 權威身分解析、拒絕啟發式猜測、三態解析結果——對應台股助手「不捏造預設值」與端點身分驗證規矩
---
# wm-authoritative-identity｜權威身分解析

**上游依據**（基線 v2.10.0 · c34156d · 2026-10-02（第二大腦 second-brain/worldmonitor/））：`CHANGELOG.md` #5695（SEC CIK 解析取代 domain-slug 啟發式）、`CONCEPTS.md`（Filer／Filer Resolution）。**適用度：內化（同源規矩）**。

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

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **「狀態」要有正面訊號，不能由錯誤缺席推論**（上游 `CHANGELOG.md` #8167 與 `CONCEPTS.md` Live Detection：偵測壞掉時的空答案與「此頻道目前沒在直播」無法區分，於是所有頻道同時落到備援）。台股助手對應：「今日無觸發」「今日無選股」「查無新聞」必須與「daemon 沒跑／來源抓失敗」分開表達——例：`scripts/lib/ai-daytrade-runner.mjs:119` 的 `reviewNote` 目前把兩者寫成同一句「今日無規則觸發（或常駐服務未在盤中運行）」，應以心跳或 `system/daemonBuild.startedAt` 判定是哪一種再寫。
- **自我宣告 ≠ 身分；權威登記優先，推導值只補空缺**（上游 `CONCEPTS.md` Declared Military Activity／Known-Vessel Override／AIS-Only Contact）。台股助手：市場別、產業別、ETF 與否、注意／處置身分一律以 TWSE/TPEx 登記清單（`risk-stocks-source.ts`、daemon nameMap）為準；由代號長度、名稱關鍵字、價格檔位反推的只能在查無登記時補，且要標出是推導。
- **持久化快照會重播舊的身分判定**（上游 `CONCEPTS.md` Stale Class Claim：修了分類器，回訪者的快照仍帶舊值）。台股助手：`restoreLastLive` 接回的快照、前端 localStorage 快取、各 `latest` doc 都會在修正後繼續帶舊判定（同 CLAUDE.md「24.02 永遠落在界內」自我延續案）。修分類／身分規則時，**還原路徑也要用新規則正規化一次**。
- **身分在流程起點決定並隨流程攜帶，不在終點重算**（上游 `CONCEPTS.md` Flow Issuer）。台股助手：AI 實驗每筆記錄在決策時凍結 `model`／`modelInfo`（digest）已符合；結算時不得以「現在的模型」回填。
- **生成文字中的身分限定詞是事實主張**（上游 `CONCEPTS.md` Status Qualifier：「前／代理／已故」須由來源同一則報導授權）。台股助手：AI 新聞識讀輸出「前董事長」「代理總經理」「已下市」等限定詞時，須在同一則來源內文出現，否則屬捏造（與記憶 feedback_news_full_content 同向）。
