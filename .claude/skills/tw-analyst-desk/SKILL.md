---
name: tw-analyst-desk
description: 每個交易日由三位 AI 分析師＋總編輯產出「昨日股市／今日盤後／明日預期」三張卡的分析報告（數字全由程式槽位填值、機械查核＋紅隊），個股只作「資料觀察名單」且研究期僅管理員可見；含存檔、發佈、排程、事後對答案與降級規則；只描述事實與條件式觀察，不預測、不進任何模型分數
---
# tw-analyst-desk｜每日 AI 分析師團隊（存檔／發佈／排程／對答案作業手冊）

> **狀態**：v1，2026-10-05 建立（W5：存檔、發佈、排程、事後對答案、登記項）。**排程尚未安裝**、Firestore 尚未實寫、未實跑稽核；程式與測試皆在本機以臨時目錄＋假 db 驗證。
> **用途**：資料日的市場事實描述與條件式觀察，**非投資建議**；個股「資料觀察名單」不是推薦、不含價格目標／買賣／進出場。

## 0. 先讀這七條
1. **不預測、不計分。** `useRules.usedForScoring=false`；輸出任何 JSON 鍵名不得符合 `/score|signal|buy|sell|rank|target|stop|entry|exit|action|rating|recommend/i`（唯一豁免：契約自己的 `meta.check.redactions`，見 `constants.mjs` 的 `KEY_SCAN_EXEMPT`）。不得發明 `xxxAt`／`xxxDate` 新鍵（只用 `dataDate`／`generatedAt`／`canonicalAt`／`updatedAt`，其餘用 `Day`／`asOf`／`baseDay`）。⚠ 陷阱：`missTopN` 因含 `stop` 被擋過——取名先過一次 `scanKeys`。
2. **數字一律由槽位 `{{ref|fmt}}` 由程式填值**；LLM 不寫裸數字。缺值寫「來源未提供」，不推測、不補 0。
3. **個股名單僅管理員可見（研究期，對答案累積 ≥20 個交易日前）**。公開文件（`dailyAnalyst/*`）不含 `focus.stocks`、`thesisRaw` 等個股細節；管理員文件（`dailyAnalystFocus/*`）只由 `/api/admin/daily-analyst-focus` 讀。
4. **兩階段出刊**：evening（23:20 起、硬死線 00:30，盤後版）→ morning（06:10 起、硬死線 07:30，晨間定版）。同資料日 **morning 定版優先於 evening**；evening 保留不刪。
5. **寫一次**：定版檔 atomic（tmp＋rename）、`.lock`（wx）、已存在不覆寫；`--force` 開盤前舊檔改名 `.r{n}`，開盤後（下一交易日 08:30 後）只寫 `.amend-{n}`。時間戳只放 manifest／meta，檔本體鍵序固定、可重現。
6. **看資料不看時鐘**：熱力定版（P1）等硬閘門不過就不組包、寫 `_pending`、下一輪再試；非交易日不產檔。
7. **模板殼不是 AI 版**：最終 `engineUsed==='template'`（claude-cli 401／逾時、ollama 忙碌皆敗）時，**不寫 AI 版定版檔、不發佈**，改寫 `_pending`＋`_alerts`，頁面退回模板版（`AnalysisReport.tsx`）。

## 1. 資料流
```
second-brain 官方鏡像／熱力定版／備份  ─┐
Firestore（只 get：newsVerdict、mopsNews、globalMarkets…）─┴→ pack.mjs buildPack → R1 三位分析師 → R2 交叉審閱 → R3 總編輯 → R4 機械查核＋紅隊
   → desk.mjs produceIssue（claude-cli → ollama → 模板殼）→ archive.mjs writeIssue（second-brain/daily-analyst/）
   → publish-daily-analyst.mjs → Firestore dailyAnalyst/{latest,D}（公開）＋ dailyAnalystFocus/{latest,D}（管理員）
   → API /api/twse/daily-analyst、/api/admin/daily-analyst-focus → AnalystDesk.tsx
verify-daily-analyst.mjs（事後）→ second-brain/daily-analyst/_review/{D}.{edition}.json（不回流任何模型）
```
- 引擎主力 `claude -p`（使用者已登入帳號，**不使用 API 金鑰**、不碰 Ollama）；所以 daemon 23:00–01:15、01:15–06:30、07:00 占用 Ollama 的新聞判別趟不影響主引擎。只有 ollama 降級層要先 `ollamaFree()`。
- 對上游 0 請求（唯一網路＝Firestore 讀、`claude -p` 雲端呼叫）。

## 2. 存檔（`second-brain/daily-analyst/`，gitignore）
| 檔 | 內容 |
|---|---|
| `{D}.{edition}.json.gz` | 定版 issue（契約 §3；meta 不含 generatedAt／canonicalAt） |
| `{D}.{edition}.pack.json.gz` | 資料包（任何人可用 pack＋issue 重跑 `check.mjs` 重驗） |
| `{D}.{edition}.transcript.jsonl.gz` | 各輪原稿、R2 討論、查核 findings、退回與修補（稽核用，不上 Firestore） |
| `reports/{D}.{edition}.md` | 人讀 Markdown（由 issue 的 `text` 欄渲染，頁尾免責） |
| `_manifest.json` | `rows["{D}.{edition}"]`：status／file／sha256／bytes／canonicalAt／engineTier／packSha256／check{pass,blockers,cut,warnings,repairRounds}／degraded／inputs／lateBuilt／revisions／amends |
| `latest.json` | `{dataDate, edition, canonicalAt}`：morning 優先於 evening、舊資料日不蓋新的 |
| `_pending/{D}.{edition}.json` | 資料未到齊、組包失敗或 AI 版未成的原因（定版後自動清掉） |
| `_alerts/LATEST.json` | 過下一交易日 08:30 仍未定版（或模板降級／晨間硬死線已到）；盤前簡報顯示「昨日分析未產出」；該日定版後自動清掉 |
| `_review/{D}.{edition}.json` | 事後對答案（§6），與 issue 檔分開 |
`archive.mjs` 的 `root`＝second-brain 根目錄（同 `daily-heatmap` 的 `--root`）。拒絕定版的情形：模板殼、`meta.check.pass=false`、issue 資料日／版次與參數不符。

## 3. 排程與閘門（`analyst-desk-run.mjs`，LaunchAgent 兩個）
- `bash scripts/install-daily-analyst-schedule.sh`（`--print` 只印 plist、`--uninstall` 移除）：`com.gmii.twstock.daily-analyst-evening` 週一～五 23:20、`…-morning` 週二～六 06:10。**只設一個起跑時刻、腳本內每 10 分鐘輪詢到硬死線**（與 daily-heatmap-run 同型；避免多實例重疊）。plist 的 `PATH` 含 `claude` 所在目錄（本機 `~/.local/bin`）。
- 時窗不落在鏡像／daemon 禁跑窗（平日 07:30–15:30、16:25–16:55、21:40–22:35）。同刻已有：鏡像 backfill 23:20、wiki-nightly 23:40、鏡像 retry 06:45、熱力 retry 06:50、surge-shadow 07:05（皆不碰引擎）。
- 資料日解析（`run-flow.mjs resolveSession`）：evening＝台北場次日（12:00 後＝今天、前＝昨天）；morning＝今天之前最後一個交易日。鏡像交易日清單沒有、但表訂日曆預期是交易日 → `waiting-mirror`（等鏡像）；週末／表訂休市 → `non-trading`，什麼都不寫。
- 本機可驗閘門（`evaluateRunGates`）：**P1** 熱力 `latest.json.dataDate==D` 且 manifest `final`、檔在（硬）；**P2** 前一交易日熱力檔（軟，prev 卡降級）；**P3** 本機 chipArchive 備份收盤＋法人（`archiveDayStatus`，軟、僅提示）。P4–P8（公告／媒體／全球夜盤／日曆／風險旗標）由 `buildPack` 自己驗：硬失敗＝丟錯 → 寫 `_pending`。
- 流程：已定版 → 只補確認發佈後結束；閘門不過 → `_pending`；組包 → `produceIssue({engines:['claude-cli','ollama']})` → 模板殼則寫 `_pending`＋`_alerts` 結束；否則 `writeIssue` → `publish-daily-analyst.mjs`（子程序）。到硬死線仍未定版：morning 寫 `_alerts`；evening 只留 `_pending`（晨間版接手）。
- **不得**與 ai-daemon 搶任何鎖、不改／不重啟 daemon、不寫 `chipArchive`／`sectorWind`／`canonical-gate`。

## 4. 發佈（`publish-daily-analyst.mjs`）
- 同一批原子寫入四份：`dailyAnalyst/latest`＋`/{D}`、`dailyAnalystFocus/latest`＋`/{D}`（`/{D}` 同日 evening／morning 共用，後者覆蓋前者）。`updatedAt`（ms）供稽核新鮮度；`canonicalAt` 同一份不重寫（`--force` 重發）。
- 公開文件：`cards[].focus` 只留 `kind/poolRule/poolSize/excludedCount/count/note`；`refTable` 剔除 `st./nv./mo./wk.{code}` 開頭且僅被個股名單引用的項目（總結與各卡 claims／連動用到的保留）。管理員文件形狀 `{dataDate, edition, canonicalAt, updatedAt, cards:[{id, focus:{…,stocks}}], refTable}`（對齊前端 `focusByCard()`）。
- 寫入前：鍵名掃描（`scanKeys`；`DYNAMIC_KEY_PATHS` 的 refTable／rules／inputs 不掃鍵只掃值）、公開文件不得含個股明細鍵、不得巢狀陣列、單文件 ≤900KB。舊資料日不蓋新 latest；同日 morning 不被 evening 蓋。模板殼／查核未過一律不發佈。
- `node scripts/publish-daily-analyst.mjs --dry-run` 只檢查不連線。登記：`audit-data-sources.mjs` CONTRACTS `dailyAnalyst`（latest／36h／daily／`dataDate`）、`MIN_SOURCES` 94→95；`backup-brain.mjs` DATED 含 `dailyAnalyst`、`dailyAnalystFocus`。

## 5. 降級階梯（寧缺勿空，不出現假結果）
`claude`（完整三角色）→ `ollama`（單人精簡版；ollama 忙碌就讓路）→ `template`（頁面退回現有 narrative 模板版）。每層寫 `meta.engineTier`／`meta.degraded[]`；任何一層都不半成品上線。claude-cli 401（`EngineAuthError`）＝使用者需重新登入 → `_alerts`。單位降級：某分析師連續失敗＝該段「本日未產出」；focus 不足 5 檔＝少列並於 `focus.note` 寫原因，不為湊數降門檻；`next` 卡未過查核＝退成純事實卡。

## 6. 事後對答案（`verify-daily-analyst.mjs`，只記錄、不得進模型）
- 只評明日卡 `kind:'watch'`；資料日 +1／+5 個交易日**收盤都到齊**（熱力定版檔＝官方參考價）才評該期；口徑寫死在 `verify-review.mjs REVIEW_SPEC`：報酬＝官方參考價日報酬連乘（熱力 `stocks[1]`，除權息日正確）、**未扣成本**、基準＝同批日子的同日等權（`market.ew` 連乘）。
- `_review/{D}.{edition}.json`：每期一份**命中表**（逐檔報酬／超額／命中、分析師提名、證據 refs）＋ +1 期**漏網表**（D+1 `board.gainers` 前 10 未入名單者：在池內？排除原因？有無相關消息 refs）。停牌／無成交日不補 0（該檔不計命中）。已 ready 的期不重算。
- 跨日命中率彙總只在**有效樣本 ≥20 個交易日**才輸出（`--summary`）；之前只列逐日。`recap` 卡只記錄不統計。統計一律標「事後挑選，不代表可交易績效」。
- 不寫 Firestore、不寫 `picksHistory`／`picksScoreboard`；`verify-review.test.mjs` 掃描：沒有任何 daemon／計分模組 import 它。

## 7. 檔案地圖
`scripts/lib/analyst-desk/`：`pack*.mjs`（資料包）、`slots/words/numbers/check*.mjs`（槽位與查核）、`constants.mjs`（單一常數來源）、`engine/prompts/desk.mjs`（引擎與流程）、**`archive.mjs`**（存檔）、**`publish-split.mjs`**（拆分／鍵名掃描／守門／決策）、**`run-flow.mjs`**（排程流程）、**`verify-review.mjs`**（對答案純函式）、`w5-fixtures.mjs`（W5 測試夾具）。
`scripts/`：`analyst-desk.mjs`（手動／乾跑 CLI）、`build-analyst-pack.mjs`、**`analyst-desk-run.mjs`**、**`publish-daily-analyst.mjs`**、**`verify-daily-analyst.mjs`**、**`install-daily-analyst-schedule.sh`**。
前端：`src/components/AfterMarket/AnalystDesk*.tsx`、`analystDeskTypes.ts`；API：`src/app/api/twse/daily-analyst`、`src/app/api/admin/daily-analyst-focus`。

## 8. 驗證
```bash
node --test scripts/lib/analyst-desk/*.test.mjs
node scripts/check-test-count.mjs          # 新增測試後 --update
node scripts/check-field-conventions.mjs && node scripts/check-source-registry.mjs
node scripts/publish-daily-analyst.mjs --dry-run
bash scripts/install-daily-analyst-schedule.sh --print   # 檢查 plist（不安裝）
```
未驗：真實 Firestore 寫入、`claude -p` 實跑、LaunchAgent 實際觸發、`audit-data-sources.mjs` 實跑（`MIN_SOURCES` 95 為推算）。

## 9. 不可碰
`ai-daemon.mjs`、`sectorWind/*`、`canonical-gate.mjs`、`chipArchive` 寫入、既有推薦榜（`picksHistory`／`picksScoreboard`）、`scripts/lib/analyst-desk/{constants,slots,engine,prompts,desk}.mjs`（W5 不改）。新增外部網域須先登錄 `source-registry.json`（本功能沒有新網域；`api.anthropic.com` 不登記）。

## 10. 已知資料問題（只報告、未修）
- **`taifexPositions.foreignTxfNetOI` 實為交易口數淨額，不是未平倉**：pack 讀取器不暴露、`constants.FORBIDDEN_REF_RES` 擋 `foreignTxfNetOI`；站內 `putCallRatio` 是「買賣權未平倉量比率」。台指期未平倉用官方鏡像 `taifex_*`。
- **`marketReports.topPicks` 含買進／目標／停損價**：desk 不得引用（違反「不含價格目標、買賣或進出場指示」與鍵名契約）；pack 不收這個來源。
- **官方 O 管線誤判例**（`scripts/lib/after-market-news.mjs` 的 `OFFICIAL_RULES`，類型只憑公告主旨）：光寶科 2301 10-02 15:50「董事會通過高雄分公司資本支出 88.5 億」被 C24（例行，正則含「董事會通過」且排在 C03 擴產之前）吞掉、權重 0；「達公布注意交易資訊標準」類（南電、騰輝、晶心科、無敵）全歸未分類；「初次上櫃前現金增資」被歸 C09。⇒ O 的 `mo.{code}.{type}.*` 類型只是主旨類型，**不等於讀內文後的判斷**；`dir` 只有規則強制類才有方向，其餘「需讀內文」。O 與 M（`nv.*` 媒體判別）**分開、不加總**。涉法律事件（檢調搜索／調查）在判定前一律利空（AI 認定事實、規則定方向）。
- 熱力 `wiki` 分組為現行快照有前視（`wk.*` 一律 tier `AI待驗`／`站內整理`／`先驗·未驗證`）；歷史處置／注意旗標鏡像只有 2026-10-02 一天，無法驗證旗標＝不入候選池（P8，寧缺勿濫）。

## 實測成本與時間（2026-10-05，10-02 重播，晨間版＋lenient 資料包，約 2.6k refs／655KB）
- 完整流程 10–11 次呼叫、約 15–20 分鐘（run6/run7）。成本（CLI 回報的名目美元）：全 opus 預設 effort 約 $10.5；`--model opus --draft-effort low --editor-effort high` 約 $5.4–5.7；草稿改 sonnet 反而慢（兩份草稿 15 分鐘逾時）、不建議。
- 推薦組態：`node scripts/analyst-desk.mjs --pack … --engine claude-cli --model opus --draft-effort low --editor-effort high`（desk.mjs 預設分工已是 draft=opus/low、editor=opus/high，排程入口直接沿用）。
- 查核迴圈實測：首稿 45–184 個 blocker → 修稿 2 輪 → 0–1 個；剩下的由程式依 claimId／代號刪除；終稿再過一次紅隊（只刪不修）。
- desk 層補充查核 D01（`desk-checks.mjs`）：引用 df.*（變化量）卻沒有變化語氣＝疑把差值當水準（實測 LLM 最常犯、機械規則抓不到的錯）。
- LLM 無權決定、程式重算：claim.refs／tier／text、槽位 fmt（一律改成 pack 預設）、個股 name／market／industry／adverse／asOf／sponsors、linkage 等級、卡片標題與 useRules。程式保底補：自身官方證據（prev 卡用 st.{code}.prevClose）、反證涵蓋風險句、明日卡觀察條件（延續前一交易日成交值，只引用不填數）。
- 名單檔數：分析師提名少時總編輯從池內補仍可能 <5 檔（明日卡實測 3 檔）；依「不湊數」原則少列並寫原因。strict 風險政策下無 D−1／當日注意名單的日子候選池為空（重播請用 `--risk-policy lenient`）。
- 已知弱點：語意錯誤（把相關寫成因果、把變化量寫成水準）只能靠 D01＋紅隊＋prompt 降低，不可能機械清零——分析文字公開前請抽樣人工讀。
