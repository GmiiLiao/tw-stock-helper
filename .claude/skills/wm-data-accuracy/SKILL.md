---
name: wm-data-accuracy
description: 資料清洗、去重、驗證與時戳誠實——WorldMonitor 工程規範轉為台股助手技術規範；含 Read Outcome 三態、Content Clock、確定性去重
---
# wm-data-accuracy｜資料正確性

**上游依據**（基線 v2.10.0 · 02f2115 · 2026-09-12（第二大腦 second-brain/worldmonitor/））：`scripts/_pipeline-dedup.mjs`、`scripts/_seed-utils.mjs`（atomicPublish）、`CONCEPTS.md`（Read Outcome／Content Clock／Content-Age Contract）。**適用度：深度內化**。

## 原則（上游提煉）
- **Read Outcome 三態**：讀取結果必須區分 hit／miss／failure。「讀不到」與「真的沒有」是相反的行動：miss 可回空、failure 必須棄權（跳過本輪、保留 last-good、回報未完成），絕不把 outage 變成自信的空答案。
- **Content Clock**：時戳的語意是「資料在此刻對過來源」，不是「寫入發生過」；任何改內容的寫入必須同一筆寫入更新時戳；只有無變化的寫入可省略。
- **Content-Age Contract**：健康度要看**資料裡的觀測日**，不是 seeder 跑過的時刻；多來源合併的 payload 要各自算時鐘並回報**最舊**者；無法定日期就回報「無」而非預設值。
- **確定性去重**：零 Date.now()／Math.random()／Set 順序依賴；Jaccard 門檻＋地理錨（雙條件），既有列勝出，回傳 skippedDuplicates 供稽核。
- **atomicPublish**：lock → validate → staging → canonical 覆寫 → cleanup；驗證失敗不得動 canonical。

## 台股助手規範
- `readArchive(limit, field)` 取「最近一個有該欄位的日子」；**沒有實料就不建文件**（空殼比沒有更難察覺）。
- Firestore `date` 一律填**來源自報資料日**（回音驗證），`at` 才是寫入時刻；`|| Date.now()` 是 A 族捏造（見 docs/DATA-INTEGRITY-SCAN.md）。
- 多來源清單（上市＋上櫃）快取閘門要檢查**每個來源都有貢獻**，缺一邊保留舊快取（stale-if-error）。
- 新聞去重：canonical URL 剝 tracker 參數＋標題 key 三層 fallback；來源禁用論壇。
- 端點身分要驗（TWT48U 事故）：欄位對不上就跳過或標「來源未提供」，禁 `|| '預設字串'`。

## 修A錯B 影響面
改任何寫入端的 date/at 語意前，先 grep 讀取端（`readArchive`、audit CONTRACTS 的 dateField、前端 boardDataDate）；欄位名一律登記 `scripts/check-field-conventions.mjs`。

## 掃描探針
- 反向：`rg -n "\|\| Date.now\(\)" scripts src`（時間捏造）；`rg -nU "catch[^{]*\{[^}]{0,200}items: \[\]" src/app/api`（outage 包成空答案）
- 正向：新資料源是否有 dateField 進 audit CONTRACTS

## 2026-09-12 週更增補（上游 d902d0d→02f2115）

- **Failure-Opaque Dependency**（見 wm-freshness 增補）是 Read Outcome 的「上一層」變體：三態在讀取層做對了，卻在回傳邊界被壓成兩態。規範：**任何包了 try/catch 的資料函式，其 catch 分支的回傳型別必須與「空結果」可區分**（`null`／throw／`{ ok:false }`），禁止 `catch { return [] }`。
- 本站符合處：`fetchDaemonIntraday` catch 回 `null`（stock-intraday route）、`readArchive` 找「最近一個有該欄位的日子」。探針：`rg "catch \{[^}]*return \[\]" src scripts`。
