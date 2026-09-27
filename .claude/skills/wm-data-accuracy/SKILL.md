---
name: wm-data-accuracy
description: 資料清洗、去重、驗證與時戳誠實——WorldMonitor 工程規範轉為台股助手技術規範；含 Read Outcome 三態、Content Clock、確定性去重
---
# wm-data-accuracy｜資料正確性

**上游依據**（基線 v2.10.0 · 90dc23a · 2026-09-26（第二大腦 second-brain/worldmonitor/））：`scripts/_pipeline-dedup.mjs`、`scripts/_seed-utils.mjs`（atomicPublish）、`CONCEPTS.md`（Read Outcome／Content Clock／Content-Age Contract）。**適用度：深度內化**。

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

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **Seed-Owned Key 讀取端改寫**（`CONCEPTS.md`）：miss 時讀取端可回短 TTL 計算後備，**或在「捏造的空值會被當成資料」時回明確的 unavailable**；上游 gateway 的做法是 miss 回 `unavailable:true` 並排除在共享快取外（`server/gateway.ts` get-us-cpi-monthly 等註解）。台股助手現況：`latestDoc()`（`src/lib/api-cache.ts`）文件不存在→200 `null`＋層級快取；Firestore 讀失敗且無舊值→200 `null`＋no-store（:141）——前端只看 body 分不出「還沒產出」與「讀取故障」。**上游已改為明確 unavailable；本站是否跟進（503＋Retry-After 或 `{unavailable:true}`）待使用者決定**。此點與 wm-freshness 09-12 增補「latestDoc 找不到回 404」的敘述衝突，已在該技能記錄更正。
- **寬鬆包裝要留痕、需要三態的呼叫端用 Strict 版**（`server/_shared/redis.ts` `geoSearchByBoxStrict`／`getHashFieldsBatchStrict`，寬鬆版改為 `logCacheReadError` 後回空）：同一讀取提供兩種出口，吞錯版本也必須 log；形狀不對（`error` 欄、長度不符）一律視為失敗而非空。台股助手：`fetchJSON`（`src/lib/risk-stocks-source.ts`）失敗回 `null`、`rows(null)` 再變 `[]`——多來源清單（TWSE／TPEx 注意＋處置）某一源掛掉時整批當成「真的沒有」並被 memoize 當成功快取。規則：**多來源合併要帶每源 ok 旗標；任一源失敗走 `isDegraded`（保留 last-good），不得以空陣列成功發布**（本站既有「每個來源都有貢獻」規則的延伸）。
- **`.catch(() => ({}))` 是 Failure-Opaque 的另一寫法**：讀失敗被換成「沒有任何事件」。規則同 09-12 的 `catch { return [] }`：只有「文件不存在」可回空，讀取例外要 throw 或讓呼叫端棄權；**尤其當下游是「冪等以資料日判斷」或「寫一次就不再重算」的寫入**（降級結果會被永久保存）。
- **Candidate Release：截斷會先砍掉最重的列**（`CONCEPTS.md` 新詞條）：來源除了逐筆事件還夾帶整期彙總列，依新近度裁切會先刪彙總列；payload 的期總量必須等於來源自己的總量，做不到就是資料遺失不是瘦身。台股助手：任何 `.slice(0, N)` 前先算總數／合計，並與來源自報的筆數或合計比對。
- **Reference Period：最新期可能倒退、分類可能重疊**（`CONCEPTS.md` 新詞條）：偏好來源掛掉、後備來源缺最新一期時，「最新期」會退回上一期而本輪看起來很新；各分類若非互斥，期總量不是分類加總。台股助手：月營收（openapi 落後一個月）與注意股名單日（`twseAttentionDate`／`tpexAttentionDate` 各自為政）都屬此類——跨源比較只能在同一資料期上做，最新期不可倒退（forward-only）。
- **Stale Class Claim：修正分類器也要修正持久化快照**（`CONCEPTS.md` 新詞條）：快照活得比部署久，只改計算端，重啟還原的使用者仍看到舊判定。本站 `restoreLastLive` 還原時先驗檔位（CLAUDE.md）是正例；`restoreVwap`、AI 實驗 `restore()` 等還原路徑新增時同樣要過當前版本的驗證。
