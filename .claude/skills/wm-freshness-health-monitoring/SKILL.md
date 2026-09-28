---
name: wm-freshness-health-monitoring
description: 資料新鮮度與健康監控——seed-meta 契約、maxStale 2–3× 節奏、minRecordCount、STALE_SEED vs STALE_CONTENT 雙時鐘、有限 grace、Activation Marker、worst-wins；台股助手 audit 四道閘門的上游依據
---
# wm-freshness-health-monitoring｜新鮮度與健康

**上游依據**（基線 v2.10.0 · 90dc23a · 2026-09-26（第二大腦 second-brain/worldmonitor/））：`api/health.js`（3,919 行；每 key `maxStaleMin`＝cron 2–3×、`minRecordCount`、STALE_CONTENT_GRACE 3h）、`scripts/check-seed-freshness.mjs`、`CONCEPTS.md`（Content-Age Contract／Activation Marker／Read Outcome）、`.github/workflows/seed-freshness-monitor.yml`（每 15 分）。**適用度：深度內化**。

## 原則
- 每次資料寫入同時寫 `seed-meta:{fetchedAt, recordCount, sourceVersion}`；健康端點只讀 meta，不讀大 payload。
- `maxStaleMin` ＝ 節奏的 2–3 倍（1.33× 曾造成例行 jitter 假警報）；每條門檻附註解說明倍數來源。
- **雙時鐘**：seed clock（seeder 有沒有在跑→STALE_SEED）與 content clock（資料有沒有前進→STALE_CONTENT）分開判；來源凍結只有後者抓得到。
- **有限 grace**：STALE_CONTENT 有 3h grace 且用無 TTL 的狀態鍵記錄，grace 過就算數；未配置的生產者不得重新進入 grace。
- **Activation Marker**：新 key 在首次成功發布前寬鬆、之後永遠嚴格；marker 讀失敗不等於不存在（不能給 grace）。
- 覆蓋率下限 `minRecordCount`（抓「很新但缺 95%」）；狀態階梯 OK／STALE／WARN／EMPTY＝crit；聚合 worst-wins。
- 「不要相信 deployment status」：另設收集器監控實際寫入。

## 台股助手規範
- `scripts/audit-data-sources.mjs` 四道閘門：maxStale／minRecords／**資料日漂移**／**市場組成**（後兩道是本站栽過四次的）；72 來源，MIN_SOURCES=60 防 vacuous pass（`auditIncomplete` 標記，exit code 刻意不變因 daemon 失敗會 5 分鐘重跑）。
- daemon 16:10 跑並寫 `system/dataHealth`，`/api/system/data-health` 對外；新資料源**必須**登記 CONTRACTS，否則等於沒保護。
- 資料日一律來源自報（回音驗證）；`boardDataDate(tw, marketOpen)` 三段語意；`liveDay` 不是「盤中」標籤。
- ✅ R7 已做（09-04）：`revealAt`＝MIS tlong（資料時鐘）與 `liveAt`（抓取時鐘）分開儲存與回傳，`tradeTime` 改揭示優先；缺 tlong 為 null 不冒充。
- ✅ F13 已做（09-04，使用者定義）：**盤中超時未更新→警告不隱藏；非交易日顯示交易所最終資料**——mis-quote／market-index 回 `snapshotAt`，Header 在盤中快照 >90s 未前進時顯示 ⚠。「太舊不顯示」構想作廢。
- **正向待辦**：dataHealth 加 seed 時鐘 vs content 時鐘雙欄。

## 修A錯B 影響面
改任一 latest doc 的 date/at 欄位前先查 CONTRACTS 的 dateField；改 audit 判定前先查 daemon 呼叫端的成功/失敗語意。

## 掃描探針
- 正向：`node scripts/audit-data-sources.mjs`（全綠＋sourceCount≥60）；反向：`rg -n "liveAt: Date.now" scripts/ai-daemon.mjs`

## 2026-09-12 週更增補（上游 d902d0d→02f2115）

- **CONCEPTS 新詞條「Constant Health Flag」**：健康布林若把「結構上永遠為真」的狀態（此面向永遠不會有的能力、永遠無法自證的依賴）納入定義，就會每次都報警，消費端學會忽略它＝學對了。修法是把定義**縮**到「下一次請求可能清掉」的狀態。台股助手探針：`system/dataHealth` 與 Header 的 ⚠ 只能由「會變」的條件觸發（stale／缺筆／日期漂移）；**任何 `always true` 的 flag 先刪再說**。
- **CONCEPTS 新詞條「Failure-Opaque Dependency」**：handler 自己把故障吞掉、回一個格式正確的空成功 ⇒ 在它的邊界上「outage」與「真的沒有」同值——Read Outcome 三態被往上搬了一層後崩塌。台股助手探針：`latestDoc()` 找不到文件回 404 是對的；但任何 route 在 `catch` 裡回 `{ items: [] }` 200 就是本病（本週 web route 0 例；daemon `catch { return [] }` 8 處，分級見 docs/WM-SCAN-2026-09-12.md R10）。
- `api/health.js` 本週 966 行變動：改用 `readExistsFlags` 批次讀存在旗標、每 key `maxStaleMin` 重新按「cron 節奏 ×3、能吞一次漏跑」校準（30／180／300／360／540／720 分）。台股助手 `CONTRACTS` 的 `maxStale` 校準原則相同，週更時對照。

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **內容年齡預警（80% 門檻，只提示不擋）**（`api/health.js` CONTENT_AGE_PREWARNING、`scripts/check-seed-freshness.mjs` `isContentAgePreWarningProblem`）：年齡到預算 80% 時進「pending」欄，**不改總體健康、不計入 problems**；格式不對的預警直接丟棄，不能升級成擋人的假警報。比例常數只定義一份，監控端從同一模組讀。台股助手：`audit-data-sources.mjs` 可加 `PREWARN` 註記（`Date.now()-ts ≥ 0.8×limit`），**不得**計入 `unhealthy`；0.8 定義一份，`effectiveMaxStale` 與預警共用。
- **Softening Deadline**（`CONCEPTS.md` 新詞條）：任何「放寬」都要在結果裡寫出**到期時刻**（不是只寫在文字註記），且在發布當下重新推導，不可沿用舊紀錄。台股助手：`effectiveMaxStale` 的 publishHour／offHours 放寬目前只出現在 `notes` 字串，建議 results 另帶 `limitMin`／`graceUntil` 欄，讓 dataHealth 讀者能核對放寬何時失效。
- **監控者本身也要被監控**（`ARCHITECTURE.md` 新增 `pulse-freshness-monitor.yml`；`CONCEPTS.md` Superseded Failure）：看「產物本身的年齡」才抓得到「排程根本沒跑」；上一次失敗若已被更新的產物蓋過，不再告警。台股助手：`system/dataHealth` 只由 16:10 那一趟寫，本身不在 CONTRACTS、`/api/system/data-health` 也不回報自身年齡；daemon 死掉或稽核連日失敗時沒人知道。規則：**dataHealth.updatedAt 超過 30h 必須由另一條路徑（daemonHealth 寫入端、Header 或後台）發出警示**。
- **Detection Net 要跑完才算數**（`CONCEPTS.md` Detection Net）：沒跑到的檢查與通過無法分辨。台股助手：`session:'intraday'` 的 10–15 分鐘門檻只有在稽核於盤中執行時才會被套用；每日只跑 16:10 一趟時 `marketOpen=false`，一律退回 30h（`effectiveMaxStale` intraday 分支），盤中門檻實際上從未被執行。新增盤中來源時要一併確認「誰在盤中跑這道閘」。
- **Seed-Meta Record 只替自己那個 key 背書**（`CONCEPTS.md` 新詞條；`scripts/_seed-utils.mjs` `resolveSeedMetaKey` #8424）：canonical 的新鮮不代表旁邊的 per-item／live key 也新鮮，沒有自己一列的 key 就是沒被監控。台股助手：同一 collection 內的 `live` 與 `{date}` 凍結檔（如 `aiDaytradeLab`）要**各自**登記契約；`kind:'dated'` 以 `orderBy('date').limit(1)` 取最新，collection 內若有同帶 `date` 的 `live` doc 會被誤取，登記前要排除。
- **健康讀取只讀 meta**（`api/health.js` #8538 CPI／殖利率曲線改 meta-only probe）：payload 大到讓健康 GET 逾時就改讀記錄。台股助手：`perCode`（stockHistory）目前整個 collection 全文讀取，應改 `select('lastDate')`。
- **天窗預算照來源行事曆量**（`api/health.js`：日頻 4320 分＝72h 涵蓋週五→週一＋一次漏跑）：與本站 publishHour＋offHoursMs 做法方向一致，不衝突。
- **監控碼與被監控的 API 同版**（`.github/workflows/seed-freshness-monitor.yml` 改為 probe 永遠跑 workflow revision）：本站 audit 由 daemon `execScript` 從磁碟執行＝永遠是最新碼 ✓；daemon 本身落後由 `system/daemonBuild` 雜湊比對負責。
- **更正紀錄（不改上文，待使用者確認）**：上方 2026-09-12 增補寫「`latestDoc()` 找不到文件回 404 是對的」——**與現行程式不符**：`src/lib/api-cache.ts` 找不到文件回 200 `null`（帶層級快取），Firestore 讀失敗且無舊值時回 200 `null`＋no-store（:141），兩者只差在標頭。詳見 wm-data-accuracy 本週增補；是否改為 503／`{unavailable:true}` 待使用者決定。

## 2026-09-28 使用者定案

- 上方更正紀錄的待確認事項已定：latestDoc **找不到文件回 200 null（正常、可快取）；讀取故障回 503 unavailable（no-store、有 log）**。見 wm-multi-tier-cache 同日定案。
