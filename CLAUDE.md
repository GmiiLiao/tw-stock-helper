@AGENTS.md

# 台股助手 tw-stock-app

Next.js 15 App Router + React 19 + zustand + Firebase（Auth / Firestore / App Hosting）。
80 支 API route、33k 行 TS/TSX。

> **版控歸屬（進場先看）**：本專案的 git 根是 `tw-stock-app/` 本身，不是家目錄。
> 先跑 `git rev-parse --show-toplevel` 確認輸出是 `.../股票助手app/tw-stock-app`。
> 若輸出是 `/Users/gmii` 代表 `.git` 不見了 —— **先問人，不要 git init**。
> 2026-07-31 之前的歷史在家目錄那份 repo，查法與規則見 [`docs/REPO-LAYOUT.md`](docs/REPO-LAYOUT.md)。

## 三層架構 —— 先理解這個，否則會改錯地方

```
本機 daemon（台灣 IP）          scripts/ai-daemon.mjs，LaunchAgent 常駐
  │  打 TWSE MIS / Yahoo / openapi，有 pacing
  ▼
Firestore（marketSnapshot / marketIntraday / bookDepth / chipDaily / 各 latest doc）
  ▼
Next.js on Firebase App Hosting（us-central1）
  │  只讀 Firestore 快照
  ▼
瀏覽器
```

**Cloud Function 在 us-central1，美國 IP 已被 mis.twse.com.tw 封鎖**
（`src/lib/twse-api-server.ts:929-931`、`src/app/api/twse/market-index/route.ts:10-11` 都有註解）。
所以 web 層直打 MIS 的路徑只是 fallback，實際上必然失敗 —— 但它們還在，而且沒有開關。
新增功能時**不要**再從 route 直接打上游，一律走 daemon → Firestore。

## 唯一不變式

> 對上游的請求數，必須與線上人數**脫鉤**。

1 人在線和 10,000 人在線，打給 TWSE / Yahoo 的請求數應該一模一樣。
任何讓「使用者多一個，上游請求就多一次」的改動都是 bug，不論它看起來多合理。

判斷方式：新增一條路徑時問自己「1000 個使用者同時觸發這個，會打幾次上游？」
答案不是常數就要重做。

## 硬約束

| 項目 | 數值 | 後果 |
|---|---|---|
| TWSE MIS rate limit | 每 5 秒 3 個 request | 超過鎖 IP，**封鎖時長無人證實** |
| MIS 更新節奏 | 5 秒 | 輪詢快過 5 秒沒有資訊增益 |
| 交易時段 | 09:00–13:30（盤前試撮 08:30） | 其餘 81% 的時間資料不會變 |
| `firebase.json` `maxInstances` | 5 × 併發 80 = 約 400 in-flight | 破口約 200–400 個同時在線使用者 |
| function timeout | 120 秒 | 上游 hang 會佔滿 worker → 全站 503 |
| serving region | `asia-east1`（台灣彰化，2026-07-31 由 us-central1 改） | 台灣使用者每請求少 150~200ms |
| `ALLOW_DIRECT_MIS` | 預設關閉 | **不要打開**，理由見下 |

### ⚠ 為什麼 region 改台灣之後反而更要小心

`twse-api-server.ts` 有幾條**直打 `mis.twse.com.tw` 且沒有 memoize、沒有合流**的路徑
（`callMIS()`、指數的 Strategy 1）。過去在 us-central1 是「安全地壞著」——
美國 IP 被 TWSE 封鎖，每次都失敗、落到 Firestore 快照，所以沒人發現它們違反唯一不變式。

搬到台灣之後這些路徑會**開始成功**：1000 個使用者＝1000 次直打，
而 MIS 限制是每 5 秒 3 個 request → 伺服器 IP 被封，且封鎖時長無人證實。

所以它們現在由 `ALLOW_DIRECT_MIS` 總開關擋著，預設 `false`。
即時報價的唯一合法來源仍是常駐 daemon（台灣 IP、有 pacing）寫進 Firestore 的 `marketSnapshot`。

## 寫程式時的規矩

**快取一律走 helper，不要手寫 `let cached; let cachedAt;`**

```ts
import { memoize } from '@/lib/singleflight';
const getFoo = memoize('foo', 15_000, async () => { ... });
```
`singleflight` 同時處理三件事：TTL 快取、in-flight 合流（N 個併發只打 1 次上游）、
失敗負快取（上游掛掉時不會變成每個 request 都重打）。手寫的版本這三項都會漏。

**Cache-Control 走層級表，不要自己寫字串**

```ts
import { cacheHeader, json, latestDoc } from '@/lib/api-cache';
export const GET = () => latestDoc('adrPremium', 'daily');   // 讀 daemon latest doc 用這個
```
層級：`tick`(3s) / `quote`(10s) / `intraday`(2m) / `daily`(1h) / `static` / `private`。
`no-store` 只給真正 per-user 的資料。**daemon 每日寫一次的資料回 `no-store` 是純浪費。**

**交易時段只有一個真相來源**

```ts
import { getSession, isMarketOpen, pollInterval } from '@/lib/market-clock';
```
不要再寫 `h >= 9 && h < 14`。舊 codebase 有 6 份互相不一致的實作，其中 5 份不查假日。

**休市日曆（2026-07-31 接上）**：`market-clock` 的 `holidays` 表預設是空的（fail-open 只擋週末），
由 `page.tsx` 開機時打 `/api/market-clock` 填入。權威來源是 Firestore `system/tradingCalendar`，
由 `scripts/sync-trading-calendar.mjs` 產生（daemon 每日 06:40 跑一次）。

它合併兩個來源，**缺一不可**：
- 證交所官方休市日程表 —— 前瞻性，但只有表訂休市
- 自家 `chipArchive` 空洞反推 —— 颱風假等**臨時休市**，官方表不會有
  （2026 上半年就有 5 天：03-10、03-13、03-25、05-20、07-10）

⚠ 官方表裡「國曆新年開始交易日」「農曆春節前/後最後/開始交易日」是**交易日標記不是休市**；
而「市場無交易，僅辦理結算交割作業」字面有「交易」兩字卻**是休市**。
分類規則是 `/開始交易|最後交易/` 才排除 —— 已用自家歸檔全量對帳，2026 年 27 筆 100% 相符。

**前端輪詢：現況是「加 gate」，不是「換 hook」**

現行做法 —— 在既有的 poll function 第一行加一道 gate，計時器照跑但不發請求：

```ts
import { shouldPollNow } from '@/lib/market-clock';

const poll = async () => {
  if (!shouldPollNow()) return;   // 休市 or 分頁在背景 → 跳過
  ...
};
```

只擋背景分頁、休市仍要更新的資料（美股、daemon 產出）用 `isForeground()`。

**進度：26 個含 `setInterval` 的檔案裡，目前只有 3 個接上 gate**
（`AlertEngine` / `Header` / `AiNewsTicker`，加上 `lib/useLiveQuotes.ts` 用遞迴 setTimeout）。
其餘 23 個清單在 `docs/OPTIMIZATION-TODO.md`。新增輪詢時請直接加 gate。

`src/hooks/useSharedPoll.ts` 是**已寫好但尚未採用**的替代方案（目前零呼叫點）。
它多做的是：多元件共用一條輪詢、間隔每次重算、失敗指數退避、jitter。
當你遇到「同一支 API 被多個元件各自輪詢」時才值得換過去 —— 單純為了統一而重寫不划算。
換的時候路徑是 `@/hooks/useSharedPoll`（不是 `@/lib/`）。

## 絕對不要做的事

- **`?t=${Date.now()}` 或 `cache: 'no-store'`** 加在 GET API 上 —— CDN 會 100% miss。
  這是本專案歷史上最貴的單一錯誤。
- **`setInterval(load, isTradingHours() ? A : B)`** —— 三元判斷只在掛載時算一次，之後永不重算。
- **`useAppStore()` 不帶 selector** —— zustand v5 會比對整個 state，任何 `set()` 都重繪整棵樹。
  一律 `useAppStore(s => s.xxx)`。
- **`fetch()` 不設 timeout** —— 上游 hang 會佔住 worker 到 120 秒。一律 `AbortSignal.timeout(8000)`。
- **在 server 端 import `@/lib/firebase`（client SDK）** —— 用 `getAdminDb()`。
- **`{items.map(...)}` 直接渲染全市場清單** —— 1,700 個 tile 會讓低階手機捲不動。先 `.slice()`。
- **從 request body 讀 `uid`/`email` 拿來做授權判斷** —— 等於呼叫端自己宣告自己是管理員。

## 目前狀態

| 文件 | 內容 |
|---|---|
| `OPTIMIZATION-2026-07-30.md` | Cowork 第 1–7 步最佳化完整紀錄（CDN／合流／timeout／安全／輪詢／快取層／前端） |
| `docs/OPTIMIZATION-TODO.md` | 剩餘最佳化工作與順序 |
| `docs/SECURITY-2026-07-31.md` | 第二輪安全稽核：uid 仍可偽造、DELETE 零授權、推送零授權、timing-safe |
| `docs/REPO-LAYOUT.md` | 兩個 git repo 的歸屬與規則 |

`.backup_before_opt/` 是 Cowork 最佳化前的檔案快照；**現在專案已有 git，回滾請用 git**，
那個目錄留著只是保險，確認穩定後可刪。

已知未做：`maxInstances` 仍為 5（容量牆，牽涉帳單，依指示不動）；
32 支 `doc('latest')` 樣板 route 仍回 `no-store`（可再收斂 Firestore reads）；
全站無 rate limiting、無 CSP。

## 驗證

```bash
npx tsc --noEmit && npx eslint .
npm run build          # 只能在 Mac 上跑
```

改完會影響流量的東西之後，盤中觀察三個數字：
- **origin RPS** —— 應該與線上人數次線性成長
- **外部請求數/分鐘** —— 必須是常數，與人數無關
- **Firestore reads/10min** —— 1000 人時應該在 2 萬量級，不是 30 萬

## 部署

```bash
npm run build
firebase deploy --only hosting,firestore:rules
```
`firestore.rules` 動過就**務必帶上 `firestore:rules`**，否則 `system/monitor-agent`
的權限修正不會生效，daemon 心跳會寫入失敗。
