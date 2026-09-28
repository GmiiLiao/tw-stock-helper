---
name: wm-source-legitimacy
description: 外部資料來源合法性登錄——每個上游網域都要登錄取得方式／身分／落地內容／節流，並有使用者合法性裁定才能上線；新增或更換來源、動到新聞/報價抓取、週更掃描 G4 類發現時使用。台股助手登錄檔 scripts/source-registry.json、檢查 scripts/check-source-registry.mjs（pre-commit 閘門）
---
# wm-source-legitimacy｜資料來源合法性登錄

**上游依據**（基線 v2.10.0 · 90dc23a · 2026-09-26（第二大腦 second-brain/worldmonitor/））：`docs/data-sources.mdx`（source-attribution manifest；逐來源寫明「儲存與顯示什麼」與「授權／署名要求」，例：SIPRI 只存衍生比率、不轉散布全庫）、`CHANGELOG.md` #8167／#5503（YouTube 頻道直播偵測因違反 ToS **整條退役**，端點改回明確錯誤碼而非靜默失敗）。**適用度：內化**（2026-09-28 使用者要求新增，第 23 條 wm 技能）。

## 原則
- **每個上游都是登錄過的決定，不是順手加的 fetch**：網域、提供者、取得方式（官方 API／公開頁 JSON／RSS／HTML／非公開端點）、身分（User-Agent 口徑）、落地保存什麼、節流方式，一列寫清楚。
- **合法性由人裁定、機器守門**：登錄表記錄「誰、何時、裁定了什麼」；程式碼出現未登錄或未核准的網域，閘門擋 commit。AI 不自行判定某來源合法或違法。
- **儲存與使用分開看**：上游的做法是「顯示／使用」與「落地保存／轉散布」分開登錄——同一來源可以拿來判讀，但不一定可以存全文。
- **來源退役要明說**：不能用了就移除並回明確錯誤／降級訊號，不留「還在抓但結果被丟掉」的半殘路徑（wm-observability-degradation）。

## 台股助手規範（2026-09-28 定案）
- **裁定**：使用者 2026-09-28「資料都是合法的」——`scripts/source-registry.json` 截至當日 27 個網域全部 `approved`，
  含 WM-SCAN 2026-09-27 的 G4-07（Google News `batchexecute` 解碼原始網址）、G4-08（Yahoo `query1` 非公開 chart API＋瀏覽器 UA／Referer）、G4-09（新聞內文擷取）。**維持現狀、程式不改**。
- **登錄檔**：`scripts/source-registry.json`。欄位 `host／provider／category（official・market-data・news・infra・self）／access／data／identity／stores／pacing／legitimacy{status,by,at,note}`；
  執行期才決定網址的來源（Google News 解碼後的媒體文章頁）登錄在 `dynamicHosts`，以程式內白名單 `GNEWS_BODY_DOMAINS`＋`FORUM_DENY` 為準。
- **閘門**：`node scripts/check-source-registry.mjs`（`--selftest` 自測）。掃 `src/`、`scripts/` 程式碼的 http(s) 網域：
  未登錄 ✖、`status≠approved` ✖、登錄但已不用 ⚠。pre-commit 在動到 src／scripts 時執行。
- **新增來源流程**：① 登錄一列、`legitimacy.status: "pending"`（此時 commit 會被擋——這是刻意的）② 向使用者說明取得方式與落地內容、取得裁定 ③ 改 `approved` 並填 `by／at` ④ 才寫抓取程式。
  仍須遵守 wm-source-aggregation（唯一不變式：只由 daemon 打上游）與 CLAUDE.md 新聞來源規則（逾 2000ms 不用、論壇在入口擋）。
- **落地保存的口徑（G4-09 查證結果，2026-09-28）**：
  - 媒體文章內文（`fetchArticleAt`／`mergeStoryBodies`，上限 1600 字）**只在 daemon 記憶體供 AI 判讀，不寫 Firestore、不寫第二大腦**；
  - 落地的只有：標題、連結、來源名、時間、RSS 自帶摘要、`newsVerdict` 的 AI 引文（最多 3 句 × 60 字且逐句驗證出現在原文）；
  - 公開資訊觀測站重大訊息（官方公告）內文存 `mopsNews/{日}`，上限 1200 字。
  - ⇒ **新增任何會把媒體內文寫進 Firestore／第二大腦／前端回應的程式，先回來更新登錄的 `stores` 並取得裁定。**
- **身分口徑現況**：官方來源多用 `compatible; TW-Stock-App/1.0`，新聞與 Yahoo 用瀏覽器 UA（`_NEWS_UA` 等）。已在裁定範圍內；改 UA 可能被上游擋而斷資料（修A錯B），**不要順手改**，要改先問。

## 修A錯B 影響面
- 移除或更換來源前：查 `rg -n "<host>" src scripts`、audit `CONTRACTS` 中依賴該來源的 collection、daemon 熔斷名稱（`breakerOpen('…')`），並確認降級鏈下一順位存在。
- 閘門只看**字面網域**；以變數組網址的新來源不會被抓到 ⇒ 新增 `dynamicHosts` 類來源時要人工登錄。

## 掃描探針
- 正向（該做未做）：`node scripts/check-source-registry.mjs`（未登錄／未核准）；`rg -n "fetch\(\`https?://\\$\{" src scripts`（以變數組網域、閘門看不到的抓取）。
- 反向（違規現存）：`rg -n "\.set\(|writeFileSync" scripts/ai-daemon.mjs | rg -n "content|body"` 後人工確認沒有把媒體內文落地；`rg -n "User-Agent" src scripts | rg -v "TW-Stock-App"` 與登錄 `identity` 對帳。
- 週更：上游 `docs/data-sources.mdx` 或 CHANGELOG 出現來源退役／授權變更時，對照本站同類來源（新聞聚合、非公開 API）列入 WM-SCAN 報告等使用者決定。
