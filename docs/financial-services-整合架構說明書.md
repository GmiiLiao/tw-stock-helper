# 台股助手 × anthropics/financial-services 整合架構說明書

> 版本：v2（已定案）· 2026-07-02
> 狀態：**已討論定案，P1 開發中**

## 0. 定案決議（2026-07-02）

1. 分期 P1→P2→P3 照案通過。
2. 論點追蹤（P2）：AI 依當時數據**預填草稿**，使用者再修改。
3. 再平衡預設（P2）：單一個股 ≤25%、單一產業 ≤40%、現金 ≥10%；**每 2 週檢視投資成果後由 AI 提出調整建議**。
4. 晨報：生成後**寫入第二大腦按日期保存**（morningNote/{date}），做成可回溯的歷史參考資料。
5. 稅務試算（P3）：依台灣現行法規、**已婚合併申報**情境設計。
6. LLM 邊界：數字全 deterministic；**2026-08-02 已依此條款換回 `gemma4:latest`**
   （qwythos-9b 自 2026-06-25 試用）。換模型當日同機同提示實測：
   NL選股 JSON 解析 gemma4 5/5、21.2s；qwythos 3/5、25.2s，且錯得危險——
   把「rsi10 超過 60」寫成 `rsi10Min:61`（憑空改數字）、「回檔超過三成」
   把上界寫成下界 `offHigh60Min:-30`（語意相反）。長文分析兩者皆無編造數字。

---

## 1. 來源庫是什麼

[anthropics/financial-services](https://github.com/anthropics/financial-services) 不是可以直接呼叫的程式庫，而是 **Claude 外掛（plugin）形式的「金融分析方法論」集合**：

| 分類 | 內容 | 形式 |
|---|---|---|
| Agents（10 個） | Pitch Agent、Earnings Reviewer、Market Researcher… | 系統提示詞 + 綁定技能 |
| 垂直外掛（7 個） | equity-research、wealth-management、financial-analysis、investment-banking、fund-admin、private-equity、operations | SKILL.md（分析步驟/表格框架）+ 斜線指令 |
| 連接器 | LSEG、S&P Global 等 MCP 資料源 | .mcp.json |

**核心價值**：每個 SKILL.md 是一份「專業分析師怎麼做這件事」的工作流程規範——晨報怎麼寫、投資論點怎麼追蹤、同業比較看哪些欄位、再平衡怎麼算漂移。這些方法論與模型無關，可以移植。

## 2. 整合原則（關鍵架構決策）

台股助手的運行環境與該庫假設完全不同，整合必須轉譯而非照搬：

| | financial-services 假設 | 台股助手現實 |
|---|---|---|
| 模型 | Claude（雲端、可信賴數字推理） | 本地 gemma4:latest（2026-08-02 起；仍**會幻想數字**，故數字一律 deterministic） |
| 執行 | Claude Code / Cowork 對話中 | 常駐 daemon 排程 + Next.js 網頁 |
| 資料 | LSEG/S&P 付費終端 | TWSE/TPEx/期交所/TDCC 免費公開資料 |
| 使用者 | 機構分析師/銀行家 | 台股散戶（實際金錢交易） |

因此的三條鐵律（延續本專案既有决策）：

1. **所有數字一律程式計算（deterministic）**，本地 LLM 只做選擇性的文字潤飾，或完全不用（模板）。零幻覺原則不變。
2. **方法論移植，不是外掛安裝**：把 SKILL.md 的分析框架轉成 daemon 技能（計算+模板）＋前端面板。
3. **台灣化**：美國稅制（wash sale、tax-loss harvesting）不適用，換成台股規則（證交稅 0.3%、股利所得稅 8.5% 抵減/28% 分離、二代健保 2.11%、除權息棄息）。

## 3. 技能對照表——哪些值得移植

### 3.1 高價值、資料已就緒（建議第一批）

| 來源技能 | 台股化後 | 做法 | 資料源 |
|---|---|---|---|
| `comps-analysis` 同業比較 | **同業比較表**：個股頁新分頁，同產業股比 PE/PB/殖利率/月營收YoY/評分/RS/法人動向，標示相對貴/便宜 | daemon 每日算，存 `peerComps` | 已有：BWIBBU_ALL、月營收、產業別、評分 |
| `catalyst-calendar` 催化劑日曆 | **事件日曆**：未來 2–4 週每檔持股/自選的催化劑——除權息日、月營收公布(每月10日)、季報截止(5/14、8/14、11/14、3/31)、法說會、股東會、FOMC/CPI | daemon 每日彙整，存 `catalystCalendar`；持股事件前 N 日推警報 | 已有：除權息日曆；新增：TWSE 法說會 API(t187ap38_L)、股東會(t187ap41_L)、FOMC/CPI 靜態日程表 |
| `morning-note` 晨報 | **盤前晨報 08:00**：隔夜美股/SOX/台指期夜盤 → 對台股影響、今日事件(來自事件日曆)、持股/自選焦點、今日觀察重點 | 模板生成（同 dailyPost 零幻覺路線），08:00 排程寫 `morningNote`，市場總覽置頂 | 已有：globalMarkets、快照、新聞;新增：台指期夜盤 |
| `earnings-preview/analysis` 財報預覽+回顧 | **月營收預覽/回顧**：公布前提示「X 檔持股即將公布」+上月/去年基期；公布後自動比對「優於/低於」趨勢並更新評分 | 併入事件日曆 + revenue 技能強化 | 已有：月營收；新增：季 EPS(t187ap06_L 綜合損益表) |

### 3.2 高價值、需要新 UI（建議第二批）

| 來源技能 | 台股化後 | 做法 |
|---|---|---|
| `thesis-tracker` 論點追蹤 | **投資論點卡**：每檔持股記「為什麼買」——論點一句話、3-5 支柱、風險、目標價、停損。daemon 每日自動比對數據（法人流向、營收YoY、評分、RS）給每支柱 ✓/⚠/✗，論點瓦解時警報「你買它的理由已不成立」 | UI：持股卡展開編輯；daemon：`checkTheses` 每日跑，寫 users/{uid}/data/theses |
| `portfolio-rebalance` 再平衡 | **配置漂移檢查**：使用者設定目標配置（個股權重上限、產業曝險上限、現金比），daemon 算漂移，超過 ±5% 帶出「賣X股/買X股」試算（含證交稅+手續費成本） | 擴充現有 portfolioRisk；新 UI 設定目標 |
| `sector-overview` 產業總覽 | **產業深頁**：點產業輪動的產業 → 該產業所有成分股表現、法人買賣、營收趨勢、龍頭 vs 落後者 | 前端為主，資料都有 |

### 3.3 有價值、後續再議（第三批）

| 來源技能 | 台股化後 | 備註 |
|---|---|---|
| `initiating-coverage` 深度報告 | **個股一頁研究報告**：基本面+籌碼+技術+估值+風險，全模板 | 匯出/分享用 |
| `client-review` 客戶檢視 | **月度投資報告**：月績效 vs 大盤、勝率、最佳/最差決策、下月事件 | 擴充現有 tradeReview 成月報 |
| `dcf-model` 估值 | **本益比河流圖（PE Band）**：近5年 EPS × 歷史 PE 區間畫河流，顯示目前貴/便宜——比 DCF 適合台股散戶 | 需季 EPS 歷史，計算純 deterministic |
| `tax-loss-harvesting` 稅務 | **台版：股利稅負試算**——參加除權息 vs 棄息的稅後比較（8.5% 抵減 vs 28% 分離 vs 二代健保 2.11%） | 台灣化改寫，非直接移植 |

### 3.4 不移植（明確排除）

- `investment-banking` 全部（pitch deck、LBO、CIM、買家名單——投行交易流程，散戶無用）
- `fund-admin`/`private-equity`/`operations`（GL 對帳、LP 報表、KYC——基金後台）
- `3-statement-model`、`xlsx/pptx-author`（Excel/PPT 文件生產不是本 app 核心）
- MCP 連接器（LSEG/S&P 付費終端，我們用 TWSE 公開資料）

## 4. 系統架構（整合後）

```
                     ┌─ 新增資料源 ──────────────────┐
TWSE openapi ────────┤ t187ap06_L 季損益(EPS)        │
                     │ t187ap38_L 法說會日程          │
                     │ t187ap41_L 股東會日程          │
                     │ 台指期夜盤(期交所)             │
                     │ FOMC/CPI 靜態日程表            │
                     └───────────────┬───────────────┘
                                     ▼
┌─ ai-daemon (本機常駐, 現有) ────────────────────────────┐
│ 新增每日技能:                                            │
│  computePeerComps      → peerComps/latest        (P1)   │
│  buildCatalystCalendar → catalystCalendar/latest (P1)   │
│  publishMorningNote    → morningNote/latest 08:00(P1)   │
│  checkTheses           → users/*/data/theses     (P2)   │
│  checkAllocationDrift  → users/*/data/rebalance  (P2)   │
│  quarterlyEps 快取     → stockFinancials/*       (P2)   │
│ 全部 deterministic 計算+模板，LLM 僅晨報選擇性潤飾       │
└──────────────────────┬──────────────────────────────────┘
                       ▼ Firestore(第二大腦)
┌─ Next.js on Cloud Run (現有) ───────────────────────────┐
│ 新 API: /api/ai/peer-comps · catalyst-calendar ·        │
│         morning-note                                     │
│ 新 UI:                                                   │
│  個股頁 +「同業比較」分頁 (P1)                           │
│  市場總覽 + 晨報卡(置頂) + 事件日曆卡 (P1)               │
│  投組頁 + 論點卡 + 配置漂移 (P2)                         │
│  產業深頁 (P2) · PE河流圖/月報/稅務試算 (P3)             │
└──────────────────────────────────────────────────────────┘
```

沿用既有模式：daemon 算 → Firestore 存 → API 讀 → 前端訂閱。無新基礎設施。

## 5. 分期計畫與工作量

| 期 | 內容 | 預估 |
|---|---|---|
| **P1** | 同業比較、事件日曆(含法說會/股東會/FOMC資料源)、盤前晨報、月營收預覽/回顧 | daemon 4 技能 + 3 API + 3 UI |
| **P2** | 論點追蹤、配置漂移再平衡、季EPS快取、產業深頁 | daemon 3 技能 + 較重 UI |
| **P3** | PE河流圖、個股一頁報告、月度投資報告、股利稅負試算 | 視 P1/P2 回饋 |

## 6. 待討論問題（請逐項給意見）

1. **分期認可**：P1→P2→P3 的切法與內容 OK 嗎？有沒有你想提前/剔除的？
2. **論點追蹤的輸入方式**：買入理由要你手動填（精準但麻煩），還是 AI 依當時數據預填草稿你再改（方便但要審）？
3. **再平衡目標配置**：預設規則（單一個股 ≤25%、單一產業 ≤40%、現金 ≥10%）你要不要調？
4. **晨報**：08:00 產生一份放市場總覽即可，還是也要推播（Firestore alert）？
5. **稅務試算**（P3）：你的股利所得適用哪種？需要知道你大概的綜所稅率級距才能算 8.5% 抵減 vs 28% 分離哪個划算——或是做成輸入級距的計算器？
6. **LLM 邊界確認**：維持「數字全 deterministic、LLM 最多潤飾晨報文字」——同意？（我強烈建議晨報也先用純模板，穩定後再考慮潤飾）
