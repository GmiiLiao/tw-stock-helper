---
name: wm-panel-data-lifecycle
description: 面板資料生命週期——錯誤絕不覆蓋既有好資料、setContent 是唯一「已恢復」的擁有者、loading 不重置退避、非權威寫入保留退避階；台股助手 React 元件 fetch/catch 的規範
---
# wm-panel-data-lifecycle｜面板資料生命週期

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`src/components/Panel.ts`（1,715 行：`_hasData` 防錯誤覆蓋、`clearErrorState` 單一擁有者、`withRetryBackoffPreserved`、#6557 cii/strategic-risk 生產事故）、`scripts/enforce-panel-content-writes.mjs`（lint 抓自己 replaceChildren 繞過清錯的面板）。**適用度：部分**。

## 原則
- **一次 transient 失敗不得清掉正確資料**：錯誤只加徽章，內容保留；有資料時錯誤是附註，沒資料時錯誤才是主畫面。
- 「已恢復」有單一擁有者（setContent*），清除徽章／倒數／退避三件事永遠一起清；繞過它的自畫 DOM 會讓錯誤徽章壓在正確資料上一整個 session。
- loading 渲染**不重置退避**；從快取重播（非權威）也不重置退避——只有真的成功才算恢復。
- fetchData 回 boolean，false＝本輪無新資料（退避訊號），不是 throw。

## 台股助手規範
- React 寫法：`catch` 分支**只 set error，不 set 空陣列**；`r.ok ? r.json() : null` 後 `setAll(j?.x || [])` 會把 503 變成清空——改為 `if (!j) { setError(...); return; }`。
- 首載與更新分開：`loading` 只在無資料時遮蓋；有資料時更新失敗顯示「更新失敗·顯示 HH:MM 資料」。
- **反向發現（09-04）**：`src/components/IndexNews/IndexAnalysis.tsx:467` `catch { setAll([]) }` 且非 2xx 也清空——指數 K 線在暫時性失敗時整張消失。其餘元件掃描乾淨（StockDetail 只 log）。
- useLiveQuotes：失敗保留上一拍報價，不回退到昨收。

## 修A錯B 影響面
改 catch 行為時確認 `loading` 的結束路徑（finally）仍執行，否則卡在 loading。

## 掃描探針
- 反向：`rg -nU "catch[^{]*\{[^}]{0,160}set[A-Z]\w*\((\[\]|null)\)" src -g '*.tsx'`；`rg -n "r.ok \? r.json\(\) : null" src` 後看是否 `|| []`
