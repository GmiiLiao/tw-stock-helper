---
name: wm-panel-data-lifecycle
description: 面板資料生命週期——錯誤絕不覆蓋既有好資料、setContent 是唯一「已恢復」的擁有者、loading 不重置退避、非權威寫入保留退避階；台股助手 React 元件 fetch/catch 的規範
---
# wm-panel-data-lifecycle｜面板資料生命週期

**上游依據**（基線 v2.10.0 · c34156d · 2026-10-02（第二大腦 second-brain/worldmonitor/））：`src/components/Panel.ts`（1,715 行：`_hasData` 防錯誤覆蓋、`clearErrorState` 單一擁有者、`withRetryBackoffPreserved`、#6557 cii/strategic-risk 生產事故）、`scripts/enforce-panel-content-writes.mjs`（lint 抓自己 replaceChildren 繞過清錯的面板）。**適用度：部分**。

## 原則
- **一次 transient 失敗不得清掉正確資料**：錯誤只加徽章，內容保留；有資料時錯誤是附註，沒資料時錯誤才是主畫面。
- 「已恢復」有單一擁有者（setContent*），清除徽章／倒數／退避三件事永遠一起清；繞過它的自畫 DOM 會讓錯誤徽章壓在正確資料上一整個 session。
- loading 渲染**不重置退避**；從快取重播（非權威）也不重置退避——只有真的成功才算恢復。
- fetchData 回 boolean，false＝本輪無新資料（退避訊號），不是 throw。

## 台股助手規範
- React 寫法：`catch` 分支**只 set error，不 set 空陣列**；`r.ok ? r.json() : null` 後 `setAll(j?.x || [])` 會把 503 變成清空——改為 `if (!j) { setError(...); return; }`。
- 首載與更新分開：`loading` 只在無資料時遮蓋；有資料時更新失敗顯示「更新失敗·顯示 HH:MM 資料」。
- R5 已修（2026-09-04 F9）：`IndexAnalysis.tsx` 失敗時保留上次資料並顯示「⚠ 更新失敗…顯示的是上次成功載入的資料」；只有切換標的（sym|iv 變）才清空；fetch 加 10s 逾時。其餘元件掃描乾淨。
- useLiveQuotes：失敗保留上一拍報價，不回退到昨收。

## 修A錯B 影響面
改 catch 行為時確認 `loading` 的結束路徑（finally）仍執行，否則卡在 loading。

## 掃描探針
- 反向：`rg -nU "catch[^{]*\{[^}]{0,160}set[A-Z]\w*\((\[\]|null)\)" src -g '*.tsx'`；`rg -n "r.ok \? r.json\(\) : null" src` 後看是否 `|| []`

## 2026-09-12 週更增補（上游 d902d0d→02f2115）

- **CONCEPTS 新詞條「Content Commit」**：面板內容寫入經短視窗合併，文件要到視窗關閉才真的換掉標記；綁在渲染列上的東西（元素 handle、寫進去的計時器、observer）必須從 commit callback 註冊，不能從發出寫入的那一行註冊。`scripts/enforce-panel-content-writes.mjs` 本週 +51 行即為此加閘。
- 台股助手對應：React 已由 reconciler 承擔 commit 語意，但 **StockTrendChart 的 canvas/ref 量測、`useEffect` 讀 DOM 尺寸** 屬同類——只能在 effect（commit 後）讀，不得在 render 期讀 ref。探針：`rg "ref\.current\.(offset|client|getBounding)" src` 逐一確認在 effect／handler 內。

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **快照要綁擁有者（principal）才准還原**（`src/components/Panel.ts`：新增 `contentPrincipal`／`snapshotPrincipal`、`bindContentPrincipal()`；`unlockPanel` 在 `snapshotPrincipal !== null && !== contentPrincipal` 時丟棄快照改畫空白；`clearSensitiveContent` 改 public 並拆出 `dropContentSnapshot()`——清快照、清擁有者、取消待寫入三件事一起做）。規則：**「之前那份好資料」屬於誰，要跟資料一起存；換了人就不是好資料，是外洩**。
  - 台股助手對應：`src/lib/store.ts:832-848` persist 把 `holdings／tradeRecords／alerts／watchlist` 寫進 localStorage，但**不存 `user`**；`src/lib/firebase-sync.ts:84-133` 登入時「該帳號文件不存在 → 把 store 現有內容上傳」只看目標帳號，不看 store 內容屬誰；`:146-151` 登出重置又以記憶體內的 `previousUser` 判斷（重新整理後恆為 null）。⇒ 規則：**本機持久化的個人資料要帶 owner uid；上傳／還原前比對 owner，不符就丟棄**（guest 內容 owner=null 才可上傳）。`exitViewAs` 用整頁重載（`store.ts:427-431`）＝已符合本原則，不動。
- **非受控輸入換資料要換實例**（同一原則的輸入框版）：`defaultValue` 只在掛載時生效；元件「換了對象但沒換實例」時，輸入框仍是上一個對象的內容，按儲存就寫到新對象上。⇒ 非受控輸入所在子樹必須以資料身分做 `key`（例 `key={doc.date}`）。這是 CLAUDE.md「輪詢樹一律非受控」的配套，不是取代。
- **Panel 內容寫入 allowlist 本週 −3 條**（`scripts/enforce-panel-content-writes.mjs`：LiveNewsPanel、LiveWebcamsPanel、TelegramIntelPanel 移出）——繞過 setContent 的面板改走單一擁有者後，豁免清單同步縮小；豁免只准降不准升（同本站 `pollNoGateBaseline` 雙向 Ratchet）。
- **可捲動內容區要可鍵盤聚焦**（`Panel.ts` #8460：`.panel-content` 固定 `tabIndex=0`＋`aria-labelledby` 指向標題，不加 `role=region` 以免每面板多一個 landmark；固定開而非量測 overflow 後才開，避免每次渲染讀版面）。本站參考級：DayTradeDesk 兩欄 `overflowY:auto` 容器同型，屬 a11y 改善，非資料正確性。
- **失敗後的 fallback 也要有年齡上限**（`src/utils/circuit-breaker.ts` `maxServeAgeMs`，見 wm-resilience-circuit-breaker 本週增補）：「錯誤不覆蓋好資料」的前提是那份資料**還算好**；保留 last-good 要附資料時刻，超過上限要標示或撤下，不能無限期假裝新鮮。
- 既有條文校正（不刪原文）：「useLiveQuotes：失敗保留上一拍報價」只對 throw／非 2xx 成立；`src/lib/useLiveQuotes.ts:46-55` 在 2xx 但 `quotes` 缺檔或為空時整張 map 覆蓋 ⇒ 缺席的代號回退顯示。是否改成逐檔合併待決定（列於 2026-09-27 週掃描）。
- 掃描探針（新增）：`rg -n "catch[^{]*\{[^}]*setData\(\{[^}]*error" src/components`（catch 以錯誤物件整片取代既有資料）；`rg -n "defaultValue=" src/components` 後逐一確認祖先有以資料身分為 key。
