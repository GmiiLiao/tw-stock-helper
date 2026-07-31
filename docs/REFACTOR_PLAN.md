# 台股助手 — 重構與分析強化計畫

> 狀態：**計畫待核准**（尚未動工）。本文件依 2026-06 的設計問答結論撰寫。
> 已完成的 UX / RWD / 資料正確性修正不在本計畫範圍（見 git 紀錄）。

## 設計決策（已拍板）

| 主題 | 決策 |
|------|------|
| 評分邏輯位置 | **只留後端**，新增 `/api/rating` 端點；前端不再重複計算 |
| 分析深度 | 統一現有 + 多時間框架均線支撐 + 估值/籌碼面（全做） |
| 頁面定位 | **AIRecommend + Screener 合併為單一「選股」頁**（StockDetail 個股深度頁維持獨立） |
| 歷史資料 | **近 3 年日線** |
| 雲端儲存 | **Firestore**（結構化、雲端持久、多 instance 共享）→ 盤中即時分析調用 |
| 本地第二大腦 | 另建本地儲存，供「本地 AI（Ollama）+ 第二大腦」分析後回給使用者、快速調用 |
| 盤勢分析觸發 | **排程任務**：每日收盤後自動（抓增量 → 算分 → 生報告 → 寫入） |

## 領域事實（務必遵守）
- 台股 09:00–13:30 **連續交易、無午休**；13:25–13:30 集合競價定收盤。
- `TW_MARKET_HOLIDAYS` 假期表需每年更新。

---

## Phase 0 — 評分統一 + 頁面合併（無新資料相依，先做）✅ 已完成
**目標**：消除前後端評分重複與不一致；兩頁合一。
**實際做法**：
- 純評分基元抽到 `src/lib/scoring.ts`（client-safe：grade 門檻、目標價 markup、輕量 5 因子評分）。
- 伺服器端 `src/lib/scoring-server.ts`（風險疊加、型態、買賣點、`rateStock`、`fetchRiskStocks`）建構於 scoring.ts 之上，數學單一來源。
- `ai-recommend/route.ts` 改為薄路由；新增 `GET /api/rating`（無參數=全市場對照表、帶 code=單檔完整分析）。
- `Screener` 刪除 `getAiRating`/`getTargetPrice`，改抓 `/api/rating` 查表（與推薦頁同源）。
- `WatchlistTracker` 的 `getTargetPrice` 改 import 自 `@/lib/scoring`（保留逐列即時計算行為）。
- 新增 `StockPicker`（tabs：AI 推薦 / 進階篩選）合併兩頁；Navbar 改單一「選股」入口；`currentPage` 'ai'+'screener' → 'picker'。
- 驗收：`tsc --noEmit` 全綠；client/server import 邊界乾淨。

1. 抽出 `src/lib/scoring-server.ts`（server-only 純函式）：評分、K 線型態、買賣點、停損 — 來源為現 `ai-recommend/route.ts`。
2. 新增 `GET /api/rating?code=` 與 `/api/rating/batch`：回 `{ score, grade, signal, factors[], reasons[], risks[], buyZones, sellTargets }`。
3. `Screener.tsx` 刪除 `getAiRating()` / `getTargetPrice()`，改呼叫 `/api/rating`。
4. `ai-recommend/route.ts` 與 `trend-analysis/route.ts` 改 import `scoring-server`，刪重複的漲幅/成交值門檻、停損計算。
5. 新元件 `src/components/StockPicker/StockPicker.tsx`（tabs：`推薦榜` / `進階篩選`），取代 `AIRecommend` 與 `Screener`；更新 `Navbar` NAV_ITEMS 與 `page.tsx` 路由。
- **驗收**：同股在推薦榜與篩選結果分數一致；tsc 通過；兩頁功能不遺漏。

## Phase 1 — 歷史資料庫（Firestore，近 3 年日線）✅ 程式完成（待跑回填）
1. Schema：`stockHistory/{code}` → `{ code, name, market, bars:[{d,o,h,l,c,v}], firstDate, lastDate, updatedAt }`（`d`=ISO 日期；3 年 ≈ 730 筆，遠低於 1MB）。
2. **寫入授權＝firebase-admin（ADC）**：`src/lib/firebase-admin.ts`（`getAdminDb()`，ADC 或 `FIREBASE_SERVICE_ACCOUNT`/`GOOGLE_APPLICATION_CREDENTIALS`），繞過 Firestore 規則、不開放公開寫入；App Hosting 線上自帶 ADC。
3. `src/lib/history-store.ts`：server-only，改用 Admin SDK：`readHistory`/`writeHistory`/`appendBars`(冪等去重)/`listStoredCodes`。無憑證時讀回 null、寫入丟錯（route 已 best-effort 接住）。
4. `src/lib/history-fetch.ts`：Yahoo 一次抓 3 年日 K（.TW→.TWO），已實測 2330 回 726 筆。
5. `src/app/api/history/route.ts`：`?code=&days=&refresh=` 讀庫、缺則 Yahoo 補抓並（admin 可用時）寫回；已實測回傳成功。
6. `scripts/backfill-history.mjs`：Admin SDK 自包含節流回填。
- **待使用者執行**：① `gcloud auth application-default login`（本機一次）；② `node --env-file=.env.local scripts/backfill-history.mjs`（先 `--codes 2330,2317` 試，再全跑，約 1367+ 檔 ~13 分）。
- 已通過 `next build`；firebase-admin 僅在伺服器端（未進 client bundle）。

## Phase 2 — 指標強化（提升「精準選股 + 買賣點」上限）
1. ✅ `src/lib/indicators.ts`（純函式，建構於 twse-api 基元）：MA 5/10/20/60/120/240、RSI/MACD/KD/Bollinger、支撐壓力（均線+近 120 日 swing+52 週高低）、52 週區間、趨勢分類、`maSupportBuyZones`。`GET /api/indicators?code=` 已建並實測（2330：trend up、支撐 [2416,2349.5,2250,2185]、買點 20MA−2%/60MA−3%/120MA−5%）。
2. ✅ 買點改**均線支撐位**：`maSupportBuyZones`（標準20MA−2%/保守60MA−3%/逢低120MA−5%），經 `analysis-enrich.ts` 接入單檔分析，回測機率由波動度觸及模型估。
3. ✅ 估值/籌碼面：`src/lib/fundamentals-server.ts`（BWIBBU_ALL=PER/殖利率/PBR；MI_MARGN=融資餘額/使用率；T86=三大法人買賣超，含交易日回退）→ `deriveFundamentalSignals` 產出 bonus(±10)+reasons+riskFlags。
4. ✅ 賣點機率改**波動度推估**：`dailyVolatilityPct` + `targetTouchProbability`（無漂移觸及機率），取代硬編 68/45/28。
- **整合點**：`src/lib/analysis-enrich.ts` `enrichScoredStock(base, bars, fund)` 合併步驟 2-4；接入 `GET /api/rating?code=`（單檔）。已實測 2330：買點 20/60/120MA、外資+15,305 張、bonus+5→97 分、全 enriched=true。
- **邊界/註**：強化僅套用於**單檔**路徑（盤中即時抓 Yahoo+fundamentals）。全市場 `/api/rating` 對照表與 ai-recommend 榜單仍用基礎技術評分——批量強化待回填建庫後由 Phase 3 排程預算。賣點機率為保守無漂移基準（未計動能），日後可加漂移項。
5. ✅ **UI 串接**：AIRecommend 推薦卡展開時抓 `/api/rating?code=`，以強化版 `view` 顯示——均線支撐買點、波動度達成率、分數含基本面加成、新增「基本面/籌碼面」區塊（PER/殖利率/PBR、三大法人、融資使用率）。已 preview 實測（2337 展開顯示均線買點+達成率、分數升至 100、無 console error）、build 通過。

## Phase 3 — 收盤後排程盤勢分析 ✅ 骨架完成（待回填啟用全效）
1. ✅ `POST /api/cron/daily-close`（`?force=1` 手動、`?top=N`）：守衛 `CRON_SECRET`(未設則放行) + `isTradingDay` → 增量 append 今日 K（`appendTodayBars`，回填前 no-op）→ 全市場基礎評分 + 漲跌家數 → 強化 top-N（讀 Firestore 歷史 + 估值/法人/融資 maps + `enrichScoredStock`）→ 寫 `marketReports/{date}`＋`/latest`。已實測（force=1）：HTTP 200/57s、breadth 漲1013/跌784、append updated0/skipped1961（無回填）、enriched 12、persisted true。
2. ✅ `src/lib/report-store.ts`（`writeMarketReport`/`readLatestReport`/`readReport`）；`GET /api/market-report[?date=]` 讀取。
3. ⏳ 觸發：Cloud Scheduler（待使用者 `gcloud auth login` 後建立；指令見下）。
4. ✅ UI 串接：AIRecommend 頂部 `MarketReportBanner`。
- **基礎設施**：route `maxDuration=120`；`firebase.json` timeoutSeconds=120、memory=**1GiB**（512MiB 會 OOM→503）。`CRON_SECRET` 已設於 `.env.local`（部署時隨框架後端帶到 Cloud Run，已驗證生產回 401/200）。
- **已部署**：`firebase deploy` 成功。Hosting https://tw-stock-helper.web.app；Cloud Run 函式 https://ssrtwstockhelper-xedszdcwuq-uc.a.run.app 。firebase-admin 降為 ^13（frameworks peer 相容）。
- **排程須打「直接 Cloud Run URL」**（Firebase Hosting CDN 有 60s 上限，cron ~38s 但安全起見直打函式）。待跑指令：
```bash
gcloud auth login   # 互動式，需使用者執行
gcloud services enable cloudscheduler.googleapis.com --project=tw-stock-helper
gcloud scheduler jobs create http tw-stock-daily-close \
  --project=tw-stock-helper --location=us-central1 \
  --schedule="0 18 * * 1-5" --time-zone="Asia/Taipei" \
  --uri="https://ssrtwstockhelper-xedszdcwuq-uc.a.run.app/api/cron/daily-close?top=30" \
  --http-method=POST --headers="x-cron-secret=uc9pqDo2VqcI5wKdkSh4KHLkG0REBhZO" \
  --attempt-deadline=180s
```
- **驗收**：非交易日不執行 ✓；報告含漲跌家數、強化選股榜（買點/目標/停損/理由）、風險清單 ✓。回填建庫後 `historyCovered`/`enriched` 才會涵蓋全 top-N。

## Phase 4 — 本地第二大腦 + 本地 AI ✅ 完成（已端到端實測）
1. ✅ 本地知識庫 `second-brain/`（gitignored，留 README）：`reports/{date}.md`+`latest.md`、`stocks/{code}.md`、`index.json`。
2. ✅ `scripts/sync-second-brain.mjs`：從 `/api/market-report` 同步盤勢報告為 markdown wiki。
3. ✅ `scripts/local-analyze.mjs`：對目標股（預設=報告精選；或 `--codes`）抓 `/api/indicators`+`/api/rating`+fundamentals 組 context → 本機 Ollama（`gemma4:latest`，`OLLAMA_URL/MODEL` 可調）產分析 → 寫 `stocks/{code}.md` + POST 回 `/api/ai/stock-note`。
4. ✅ 回推與顯示：`src/lib/note-store.ts`（`aiNotes/{code}`）+ `GET/POST /api/ai/stock-note`（POST 由 CRON_SECRET 守衛）；AIRecommend 展開卡分析欄顯示「🧠 本地 AI 深度解讀」。
- **實測**：Ollama gemma4 對 2330/2337/2379 產生**數據紮實、無杜撰**的分析（引用真實 MA/RSI/外資/估值），note pushed=true，UI 正確顯示，無 console error。
- **流程（本機需 app+ollama）**：`node scripts/sync-second-brain.mjs` → `node scripts/local-analyze.mjs [--codes ...]`。

---

## 風險與順序建議
- Phase 0 風險最低、立即見效（消重複），建議**先單獨完成並驗證**。
- Phase 1 初次回填 3 年 × 約 1800 檔需節流，避免觸發 TWSE 阻擋；分批執行。
- Phase 4 因 Cloud Run 無持久本地檔，本地第二大腦定位為「本地/worker 端」執行，與雲端 Firestore 雙向同步。
