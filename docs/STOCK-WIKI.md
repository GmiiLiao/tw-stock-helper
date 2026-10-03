# 台股資料 wiki（第二大腦）— 2026-10-03

全部個股（上市／上櫃／興櫃 2,335 檔）與 ETF（286 檔）的關聯式知識庫：產業、產業鏈上中下游、同業、集團（持股關聯群）、
產品／原料／客戶／供應商／設備／生產據點（國內外）／競爭者／銷售市場、財務摘要、重大訊息、新聞。
產出在 `second-brain/wiki/`（gitignored），Obsidian 直接開資料夾即可看關聯圖；`_graph/*.json` 給本地 AI／daemon 讀。

## 架構

```
官方慢變數（月更、30 天快取）          本地備份（每日由 backup-brain 同步）
  openapi.twse  t187ap03/02/11/47_L      second-brain/backup：快照、peerComps、themeMap、
  mops.twse     t05st03（上市櫃興櫃）     etfInfluence、finSummary、mopsNews、stockAI、news
        │                                       │
        └──────────────┬────────────────────────┘
                       ▼
          scripts/lib/stock-wiki/model.mjs（實體圖：純組裝、零上游請求）
                       ▲
經營輪廓兩層：.cache/profiles/annual（年報萃取，優先）＋ .cache/profiles/ai（AI 鋪底，補缺）
                       ▼
          render-*.mjs → second-brain/wiki/*.md ＋ _graph/graph.json、stocks.json
                       ▼
          daemon 新聞判讀（judgeOneStock）讀 stocks.json 當事實錨點（scripts/lib/wiki-facts.mjs）
```

## 指令

```bash
node scripts/build-stock-wiki.mjs crawl            # 官方慢變數（MOPS 逐檔 2.5s 間隔，可中斷續跑）
node scripts/build-stock-wiki.mjs build            # 零上游請求重建（約 2 秒）
node scripts/build-stock-wiki.mjs ai-batches       # 產生 AI 鋪底批次輸入（.cache/ai/batches，提示詞 .cache/ai/PROMPT.md）
node scripts/build-stock-wiki.mjs ai-ingest        # AI 輸出驗證入庫
node scripts/build-stock-wiki.mjs annual-fetch     # 年報下載＋抽「營運概況」段落（不用 LLM）
node scripts/build-stock-wiki.mjs annual-extract   # 本機 Ollama 萃取（只在 02:00–06:30）
bash scripts/install-stock-wiki-schedule.sh        # 排程：每晚 23:40（MOPS 續抓→年報→萃取→重建）、每月 1 日 20:30 月更
```
日誌：`~/Library/Logs/twstock-stock-wiki/`。排程入口 `scripts/stock-wiki-nightly.mjs`（LaunchAgent 以 node 直接執行，同 daemon；`--test` 可經 launchd 試跑一次 build）。測試：`node --test scripts/lib/stock-wiki/*.test.mjs scripts/lib/wiki-facts.test.mjs`。

## 產品連動：產品族／跨產業／產品×國家（2026-10-03 使用者：「一家公司多種產品分佈在不同產業與國家」要能連動）

```
產品／原料名稱（約 3,200 個，寫法不一）
  ① families  子代理訂產品族詞彙表（每族 0–2 個官方產業）  .cache/taxonomy/families.json
  ② assign    名稱 → 產品族（切批）                         .cache/taxonomy/assign-out/
  ③ canon     同族內同義詞 → 標準名（依族切批，同族必同批） .cache/taxonomy/canon-out/
        ▼ loadTaxonomy（build 時讀；族不在詞彙表、產業不在官方清單一律丟掉）
產品實體頁以標準名為鍵（「CCL」「高速銅箔基板」併入「銅箔基板(CCL)」）→ 推導上下游跨寫法接上
個股頁「產品分布：產業×國家」表；產業頁「依產品跨入的公司」；產品族頁（生產者／以此為原料者）
生產據點／銷售市場（國家）頁「在此生產／銷往此地的產品」
```
- 指令：`taxonomy families|assign [--skip-done]|canon|status`（出題，子代理寫輸出）；`geo-batches [--skip-done]` → 子代理 → `geo-ingest`。
  提示詞版控在 `scripts/lib/stock-wiki/prompts/`（出題時複製到 `.cache`）。
- **產品×國家**：AI 層 `.cache/profiles/ai-geo/{code}.json`（只補既有產品／廠區的屬性，名稱對不上就丟；只收高／中信心），
  `readProfile` 掛到 AI 層；年報層由「廠區 products」推出生產地。生產地＝產品 madeIn ∪ 標明生產該產品的廠區所在國。
- **新式年報沒有生產量值表／銷售量值表**（2026-10-03 以 1717、6488 的 2025 年度年報實測：客戶名單後直接接「從業員工資訊」）。
  萃取提示詞仍保留「若有銷售量值表就抓內外銷」，但多數公司拿不到各產品內外銷的官方數字；銷售地區比重（markets）仍在。
- 新增的產品名稱（年報萃取、新上市）不會自動歸族：跑 `taxonomy assign --skip-done` → 子代理 → `taxonomy canon`（會重出全部同族題）。
  沒歸族的名稱照原名顯示，不影響其他功能。
- 判讀提示詞：跨產業與產品×國家只放「參考·未完全驗證」區（`wiki-facts.mjs`）；**daemon 要重啟才會載入新版 wiki-facts**。

## 規則與為什麼

- **每筆事實帶來源與等級**（官方 > 官方衍生 > 站內推導／整理 > 近似 > 媒體 > AI 待驗）。缺就寫「來源未提供」，不捏造。
- **經營輪廓分層**：年報有的面向整個用年報，沒有才用 AI；AI 項目在頁面標「AI待驗」，在判讀提示詞放「參考·未完全驗證」區、不可單獨當連動依據。
- **集團＝單一最大法人股東樹**：每家公司只連到持股比例最高且 ≥5%（或 10% 大股東）的法人。
  舊版把所有法人董監關係遞移串連，合資與策略投資把不同集團橋接成 114 家一坨（2026-10-03 實測）。
  公股（國發基金、財政部、耀華玻璃管委會…）與創投不當上層。這是推導標籤，不等於公司法的關係企業。
- **推導上下游**：A 的原料名稱＝B 的產品名稱 ⇒ B 是 A 的上游。名稱必須一致，所以輸入端統一正規化
  （`normEntityName`：中英交界空白、全形括號、台／臺、中國大陸／中國）。
- **生產據點依國家彙總**：廠名是各公司自己的（14 家的「高雄廠」是 14 座不同的廠），實體頁用國家當鍵。
- **年報萃取與 daemon 協調**：daemon 共用同一個 Ollama、一次只推論一個；插隊會讓 daemon 判讀撞 240s 逾時並被存成假「中性」。
  ⚠ 原本以為 02:00 後閒置是錯的——daemon 的夜間補判 01:15 起跑、死線 06:30（審查抓到）。現在：daemon 寫
  `second-brain/.signals/llm.json`（佇列忙碌）與 `night-backfill.json`（今晚補判跑完），萃取等補判完成（daemon 沒跑則 03:30 起）、
  每筆送出前確認不忙、不覆寫 num_ctx（避免模型重載）、單次 120 秒逾時。單檔約 90 秒。
- **AI 層不信任 AI 給的股票代號**：一律由名稱重新解析（實測「大毅」被標成久正 6167）；來源強制 `ai-knowledge`。
- **推導上下游分級**：兩端都來自年報才進判讀「事實」區；含 AI 輪廓的邊只放「參考·待驗」。
- **重建完整性閘門**：備份缺檔、快照缺上市或上櫃、個股數比上一輪少 >5% ⇒ 整批不寫不刪（保留上一版 vault 與 stocks.json）。
- **MOPS 查無不覆蓋好資料**：只有「查無／格式錯誤」才算不存在，其他業務碼（系統忙碌）計入斷路器；既有好資料只記 checkedAt。
- **年報章節定位**：「營運概況」可能是第肆或第伍章，下一章「財務概況」章號跟著變；目錄頁用引導線密度判斷。
  擷取改用「錨點各自配額」——原本關鍵字取窗會被前面的產業概況吃光預算、漏掉原料表與客戶名單。
- **重建保留個人筆記**：每頁「✍ 個人筆記」標記以下的內容重建時保留；舊頁有筆記就不刪。

## 已知限制／待辦

- `www.tpex.org.tw` 本機 DNS 解析失敗（2026-10-03 07:00 起，Google DNS 正常）：上櫃 ETF 基本資料、上櫃董監明細暫缺。
  daemon 的上櫃抓取同樣受影響（stale-if-error 沿用舊快取）。**修 DNS 後**：補 `ic.tpex.org.tw` 產業價值鏈（已核准，
  全市場上中下游分段）與櫃買 openapi（上櫃董監、ETF）。
- 另發現：daemon `getIndustryMap` 打 `openapi.twse.com.tw/v1/opendata/t187ap03_O`，該端點 302 到 404 頁——上櫃產業別從未由此取得
  （上市有 >300 檔，所以 peerComps 後備不會啟動）。未修，待確認影響面。
- 主題產業鏈（themeMap）只有 36 條、代表股 177 檔；全市場上下游靠推導（名稱比對）與待補的櫃買價值鏈。
- 2026-10-03 首輪：MOPS 2,335/2,335、AI 鋪底 59 批全數入庫（2,335 檔，全為 ai-knowledge；興櫃小公司多為低信心）。
  年報層從第一次夜間萃取起才開始覆蓋。同日做了產品分類樹：3,176 個產品／原料名稱歸入 254 個產品族（3,132 個有族）、
  同義合併成 2,449 個標準名；推導上下游由 131／84 檔增為 167／122 檔，依產品跨入其他產業的公司 840 檔，
  有產品×國家的 798 檔（AI 層 24 批）。名稱比對仍只接得上「完全同一物」，族層級的供需關係看產品族頁。
- ETF 成分股只有 0050／006208 的市值近似。
