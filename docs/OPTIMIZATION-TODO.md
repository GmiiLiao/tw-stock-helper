# 剩餘最佳化工作 — 依順序執行

第 1–4 步已完成，見專案根目錄 `OPTIMIZATION-2026-07-30.md`。
以下每一項都是獨立可驗證的一輪，**建議一項一個 commit**，方便回滾。

依據：《台股助手全面檢視報告》（桌面 artifact `twstock-app-architecture-review`）。
所有 file:line 皆經實地核對。

---

## 第 5 步 — 關掉 24/7 輪詢 <span>影響最大、風險最低</span>

13:30–09:00 加上週末假日佔一天的 81%，這段時間資料完全不會變。

| 檔案:行號 | 現況 | 改法 |
|---|---|---|
| `src/components/AlertEngine/AlertEngine.tsx:314` | 每 30 秒抓 650KB 全市場，**24/7 不停**，且 effect deps 含 `alerts`（加一檔自選股就立刻再抓一次） | 改用 `useSharedPoll`，deps 收斂 |
| `src/components/WatchlistTracker/WatchlistTracker.tsx:2130` | `marketOpen` 算出來後**全檔案零引用** | 刪掉，改用 `market-clock` |
| `src/components/WatchlistTracker/WatchlistTracker.tsx:2259` | 5 秒輪詢硬寫死 | 改用 `useSharedPoll` |
| `src/components/Header/Header.tsx:114-122` | `h >= 9 && h < 14`，用 client 本地時區、不查假日 | 改用 `headerInterval()` |
| `src/components/AiNewsTicker/AiNewsTicker.tsx:238` | 15 秒輪詢，無盤中判斷 | 改用 `useSharedPoll` |

另外 **18 個輪詢點**是 `setInterval(load, isTwTradingHours() ? A : B)` 這種寫法 ——
三元判斷只在掛載時算一次。早上 8:50 開頁的人整天卡在慢速，13:00 開頁掛整夜的人整夜高頻。
`useSharedPoll` 用遞迴 `setTimeout`，每次都重算。

`src/lib/market-clock.ts` 的假日表目前是空的（fail-open 只擋週末）。
上線前讓 daemon 每年 12 月抓 TWSE `holidaySchedule` 寫進 Firestore `system/tradingCalendar`，
web 端啟動時 `setHolidays()`。**不要用政府行政機關辦公日曆代替** —— 證交所休市 ≠ 政府放假。

**驗收**：休市時間打開網站，DevTools Network 應該完全安靜。

---

## 第 6 步 — 15 支 daemon route 的 `no-store`

這些讀的是 daemon **每日只寫一次**的 Firestore doc，卻回 `no-store`：

```
ai/taifex ai/lending ai/revenue ai/scanner ai/rs-ranking ai/trade-signals
ai/global-markets ai/major-holders ai/margin-short ai/multi-timeframe
ai/dividend-stocks ai/dividend-calendar ai/daily-post ai/institutional-streaks
ai/sector-rotation
```

每支都改成：
```ts
import { latestDoc } from '@/lib/api-cache';
export const runtime = 'nodejs';
export const GET = () => latestDoc('taifex', 'daily');
```

順帶解決 47 個檔案複製同一份 12 行樣板的問題 —— 重點不是程式碼量，是**快取策略無法統一治理**：
要調整就得改 47 個檔案，所以實務上永遠不會被調整。

**驗收**：Firestore reads 從約 30 萬/10 分鐘（1000 人）降到 2 萬量級。

---

## 第 7 步 — 前端載入 <span>架構級，獨立一輪</span>

三個數字：`next/dynamic` 0 次、`React.memo` 0 次、虛擬滾動 0 次。

### 7a. code splitting
`src/app/page.tsx:6-21` 靜態 import 16 個頂層元件，用 `{currentPage === 'x' && <X/>}` 條件渲染 ——
**條件渲染不做 code splitting，程式碼照樣下載並解析**。
首屏實測 92 個模組、1,280,457 bytes 原始碼，加 vendor 約 1.6–1.8 MB minified 單一 chunk。

先拆這三個（互不相依、風險最低）：
```ts
const Portfolio  = dynamic(() => import('@/components/Portfolio/Portfolio'));
const Backtest   = dynamic(() => import('@/components/Backtest/Backtest'));
const AdminPanel = dynamic(() => import('@/components/Admin/AdminPanel'));  // 31KB，只有你用得到
```
順手：`package.json:14` 的 `lightweight-charts` **全專案零引用**，直接移除。

### 7b. zustand selector
19 處 `useAppStore()` 沒帶 selector。最急的三個都是全域常駐：
`page.tsx:25`、`Navbar.tsx:37`、`Header.tsx:19`。
`page.tsx:25` 訂閱整個 store，代表 `Header.tsx:95` 每 2 分鐘的 `setAllStocks()` 會重繪整棵 App 樹。

### 7c. RiseFallPanel
`src/components/WarRoom/RiseFallPanel.tsx:78` 的 `{items.map(...)}` **沒有 `.slice()`**，
一次渲染約 1,700 個 tile，每個內含一顆 `AddCandidateButton`，
各自 `useAppStore(s => s.compareCodes.includes(code))` ——
任何一次 `set()` 觸發 1,700 個 selector 跑 `Array.includes`。
最小修法 `.slice(0, 100)` + 「顯示更多」；正解是虛擬滾動。

### 7d. 其他
- `Header.tsx:152-160` 每秒 `setInterval` 讓 17KB 的大元件完整重繪，背景分頁照跑 → 時鐘拆成葉節點
- `StockDetail.tsx:220` deps 含 `allStocks` → 每 2 分鐘重打 3–12 次 stock-history + recharts 全圖重建
- `Header.tsx:163-186`、`Screener.tsx:414-422` 對 1,700 檔做 `includes()`，每個按鍵一次、無 debounce

**驗收**：Lighthouse TTI 從 5–8 秒進到 3 秒內。

---

## 第 0 步 — 容量牆 <span>放最後</span>

`firebase.json:31`
```jsonc
"maxInstances": 5,        // → 50。目前是 400 in-flight 的硬牆
"region": "us-central1"   // → asia-east1，台灣使用者每請求 −150~200ms
```

**故意放最後**：前面的修補沒做完就調高，只是把打向上游的火力放大 10 倍。

兩個注意事項：
- `maxInstances` 直接影響帳單，數字自己決定
- App Hosting 的 region 通常在 backend 建立時決定，改欄位不一定就地生效，**可能需要重建 backend**

---

## 未定案 —— 需要產品決策

把即時報價轉發給終端使用者，依《交易資訊使用管理辦法》屬「傳輸（播）」行為，須與證交所簽約付費：

| 型態 | 費用 |
|---|---|
| 網際網路・**自動更新** 0–5,000 人 | NT$100,000 / 月 |
| 網際網路・自動更新 5,001 人以上 | NT$12 / 人 / 月 |
| 網際網路・**非自動更新** | NT$50,000 / 月 |

「自動更新 vs 手動刷新」是 2 倍以上的費率斷崖，而它是純粹的產品設計決策。
如果核心價值是選股邏輯而非秒級跳動，設計成手動刷新，成本結構完全不同。
**這個決定要在做第 7 步之前定案**，因為它會改變前端輪詢架構的形狀。
