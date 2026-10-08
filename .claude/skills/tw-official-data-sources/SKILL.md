---
name: tw-official-data-sources
description: 台股起漲或選股模型的訓練／研究資料只用官方來源——新增、回補或稽核任何訓練資料（價量、籌碼、公告、盤中、集保、財報、期權）時使用；含官方端點總表、回補規範與現況、PIT 可用時點、已知陷阱、台股 wiki 聯動關係能否進訓練、回測命中／漏網記錄規範
---
# tw-official-data-sources｜官方資料來源與訓練資料規範

**依據**：使用者 2026-10-04 指令——起漲日研究的全部訓練資料（價量、籌碼、新聞、盤中、集保、財報）必須來自上市／上櫃官方網站；
站上現有的新聞識讀先不用、不計分；官方公告與媒體新聞是兩種來源，要分開使用。
事實來源：2026-10-04 四個領域唯讀盤點（價量與交易制度、籌碼、基本面與公告、盤中與市場層），
以及前一輪稽核 `var_audit.txt`（scratchpad）。行號以 2026-10-04 的 `tw-stock-app` 為準，程式改過要重查。
未實測的項目一律標「未驗證」。**適用度：硬規定**（研究端）。

> 檔案位置提醒：`scripts/surge-lab/a34_*`、`a35_*`（含 a35_shadow_lib.py、a35_compare_site.py、a34_market_fetch.mjs、
> a34_breadth_fetch.mjs）在主 repo 是**未追蹤檔**（`git status` 為 `??`），worktree 裡沒有；引用它們的行號以主 repo 工作目錄為準。

## 1. 原則

- **訓練資料只用官方網域**。以 `scripts/source-registry.json` 的 `sources[]` 中 `category: "official"` 且 `legitimacy.status: "approved"` 的 host 為準
  （registry 裡 `category` 為 `market-data`、`news` 的 host——Yahoo 三個網域、dramexchange、cnyes、udn、LTN、technews、moneydj、feedburner、Google News——即使已核准給站上使用，**也不得進訓練**）：
  - `www.twse.com.tw`（rwd／exchangeReport，可指定日期，PRIMARY）
  - `openapi.twse.com.tw`（整批落後一日，只當 FALLBACK）
  - `mis.twse.com.tw`（即時，無歷史；硬上限 3 req/5s，與 daemon 同一個 IP）
  - `www.tpex.org.tw`（www 帶日期端點 PRIMARY，openapi 只當 FALLBACK）
  - `mops.twse.com.tw`、`mopsov.twse.com.tw`（公開資訊觀測站）
  - `www.taifex.com.tw`（期交所）
  - `openapi.tdcc.com.tw`（集保）
  - `doc.twse.com.tw`、`ic.tpex.org.tw`（年報 PDF、產業鏈，目前是 wiki 用途）
  - 未登錄：`openapi.taifex.com.tw`、`www.tdcc.com.tw`。要用就先登錄並取得使用者裁定（wm-source-legitimacy）。
- **以下來源不得進訓練、標籤或計分**：
  - Yahoo（`query1.finance.yahoo.com`）：日 K 補洞、priceEvents 係數、intradayArchive 5 分 K、國際指數、匯率（TWD=X）、商品期貨（CL=F 等）、美股期貨。
  - 媒體新聞：cnyes、udn、ctee、Google News、Yahoo 奇摩、LTN、technews、moneydj 等，以及由它們算出的則數、熱度、極性。
  - 站上的 `newsVerdict`／`newsDaily`。
  - 由上述來源衍生的任何欄位，例如 `gapFixSource` 標記過的 closeJson 列、`factorSrc=yahoo` 的係數。
  - 「網域是官方」不等於「這份資料是官方」：要追到 Firestore 文件的**寫入端**（`fetch_cache.mjs` 只讀 Firestore，不打上游）。
- **兩種新聞來源，兩條管線**：
  - **官方公告**：MOPS 重大訊息（`mopsNews/{發言日}`）。這是**唯一可能**進訓練的「新聞」類來源，但現階段同樣**不進訓練**：
    原始事件（類型、官方發言時間）要先過三關才可放進訓練——①歷史回補可行性實測（第 7 節）②兩窗＋OOT ③使用者裁定
    （`tw-news-impact-analyst` §10 第 7 條）。裁定前只做影子記錄。
  - **媒體新聞**：`newsVerdict`／`newsDaily`。現階段**不進訓練、不進起漲研究計分**，也不當影子特徵以外的任何用途。
  - 兩條管線各自存放、各自評估（兩窗＋OOT），不可合併成一個「新聞分數」，也不可用一邊補另一邊的缺值。
  - 兩邊的方向與權重判讀（`impactPrior`、`officialEventScore`、`mediaNewsScore`）見 `tw-news-impact-analyst`；
    那份技能規定研究期只記錄、不計分，**這些分數一律不得當訓練特徵、排序鍵或門檻**。
  - 站上**線上**評分要不要停用媒體新聞，屬另案，須使用者裁定。本技能只管訓練與研究端。
- **找不到官方來源時**：把該事件或該段標成「來源非官方」並排除，或留作缺值。不可用第三方補，也不可捏造預設值（CLAUDE.md「不要給資料欄位捏造預設值」）。
- **狀態詞彙**（第 2 節使用）：
  - `in-use`：已在訓練中使用，且來源是官方
  - `backfillable`：官方端點可指定歷史日期，可以回補
  - `accumulate-only`：官方只有當期資料，只能從今天起每日或每週自建
  - `unavailable`：沒有公開官方來源
  - `not-official`：目前的訓練輸入不是官方來源，必須替換

## 2. 官方來源總表

日期格式一律照寫。**TPEx 新版 www 端點只認 `YYYY/MM/DD`（URL 編碼 `%2F`），8 碼日期會被靜默忽略、改回最新資料**（ai-daemon.mjs:1697-1700、3250-3251）。
「釋出」是台北時間；以 daemon log 推得的時刻只是上界，受排程間隔限制。

### 2.0 研究快取回補現況（2026-10-04 14:44 實測檔案）

下表各列狀態欄若寫「研究快取」，指的是這一節的本機快取；**不代表已併入主模型**，也沒有寫 Firestore。
快取實體在**主 checkout** 的 `tw-stock-app/scripts/surge-lab/.surge-cache/official/`（以 `--cache`／`SURGE_CACHE` 指過去）；worktree 裡沒有這個目錄。

- **每日官方研究快取**：`scripts/surge-lab/official_backfill.mjs`＋`official_adapters.mjs`。
  - 7 個資料集：`twse_daily`（MI_INDEX `type=ALLBUT0999`）、`twse_t86`（T86 `selectType=ALLBUT0999`）、`twse_qfiis`（MI_QFIIS）、
    `twse_limit`（`rwd/zh/variation/TWT84U`，當日官方漲停／跌停價）、
    `tpex_daily`（dailyQuotes，含發行股數、次日參考價／漲停價／跌停價）、`tpex_daytrade`（intraday/stat `tables[1]`）、`tpex_insti`（insti/dailyTrade）。
  - **範圍與進度**：目標是 `panel_dates.json` 的 **1,023 個交易日（2022-07-18～2026-10-02）**，**回補進行中，尚未完成**。
    2026-10-04 14:44 實測已落地：twse_daily／twse_t86 141 日、twse_qfiis 140 日（至 2023-02 中）；tpex_daily／tpex_insti 134 日、tpex_daytrade 135 日（至 2023-02 初）；
    `twse_limit` 剛開跑（7 日）。進度以 `.surge-cache/official/{資料集}/` 的 `.json.gz` 檔數為準，**不可把 1,023 當成已完成的天數引用**。
  - 回聲驗證（`official_adapters.mjs` 的 `check`）：`stat` 正常（上市 `OK`、上櫃 `ok`）、頂層 `date`＝請求日、含指定欄名且有資料的逐檔表存在。
    **不核對表頭或 title 的民國日期**。不通過的日子寫 `{日}.skip.json`（非交易日也走這條），之後不重抓。
  - 落地：整份原始 JSON gzip 存 `.surge-cache/official/{資料集}/{日}.json.gz`，內容只有 `day`、`source`（URL）、`raw`（整份回應，回聲值在 `raw.date`）；**沒有 `fetchedAt` 欄**（與第 4 節「落地」要求不同，抓取時間只能看檔案 mtime）。解析交給 python，改解析不必重抓。
  - TPEx insti/dailyTrade 欄序：**7 組 ×（買進、賣出、買賣超）＋三大法人買賣超合計**。欄名重複，只能按位置取；分組順序已用三道恆等式驗證（smoke 執行 `tpex_insti_bad_rows=0`）。端點改版要重驗。
  - 量對帳：官方「成交股數÷1000」與既有 panel 量欄在已落地部分的重疊格 **100% 相符**（2026-10-04 smoke：約 97 日、166,584 格）。回補完成後要重跑一次確認。
  - 腳本與第 4 節規範的差異（再跑或改腳本時要處理）：
    - `--gap` 預設 2500ms（另加 0～600ms 抖動，下限 1500），低於第 4 節「≥3 秒」。要帶 `--gap 3000` 以上（2026-10-04 這輪用 3000，`twse_limit` 用 4000）。
    - 內建靜默窗只有**平日 07:30～15:30**；第 4 節列的 daemon 晚間班次（16:10 起的稽核、補跑與資料到齊班車，20:45～21:50 借券與資券）與 wiki 夜間抓取（23:40 起）它不會避開，要人工挑時段。
    - 失敗即停的門檻是 403／429 立即停、其餘**連續 5 次**才停（ECONNRESET、DNS 失敗也會重試），比第 4 節「連續 3 次、ECONNRESET／DNS 即停」寬。
    - 上市、上櫃兩台主機並行（各自單線），符合第 4 節。
- **MOPS 季損益表**：`scripts/surge-lab/mops_fin_backfill.mjs` 回補 `ajax_t163sb04`（逐請求 ≥5 秒，只抓已過各業最晚法定期限的季）。
  - 共 44 檔（sii／otc × 2021Q1～2026Q2），存成原始 HTML：`.surge-cache/official/mops_t163sb04/{sii|otc}_{民國年}_{季}.html.gz`。
    解析後 41,382 列（代號×季），都是**年初累計值**（2026-10-04 以 `official_features.load_fin()` 重算確認）。
  - `official_features.py` 換算成單季：Q1 用原值；Qn＝累計n − 累計n−1，任一季缺值，該單季就缺值。
    驗算結果：台積電 2022Q2 單季 EPS 9.14、2022Q4 單季 EPS 11.41，都與公開數字相符。
  - PIT：取**各產業中最晚的法定期限再加 1 日**（含金融業），即 Q1 06-01、Q2 09-01、Q3 12-01、Q4 次年 04-01（`official_features.py` 的 `FIN_DUE`）。
- **特徵與對照**：`official_features.py` 建官方特徵，`cv_official.py` 跑 base 對 official 的對照。每次都寫命中、漏網、母體外三份記錄（第 9 節）。
  併入主模型前，仍要先過兩窗＋OOT，並取得使用者裁定。
  - `official_features.py` 也讀台股 wiki `stocks.json`：`industry` → 同產業共振 `o_ind_*`（取代 peerComps 產業，併入 official）；
    `group` → `o_grp_*`，列在 `EXPERIMENTAL`，**不併入 all**，只在 `official+grp` 實驗組出現（第 8 節）。
  - 2026-10-04 已存在的 `out/official_cv_t1_*` 是在每日快取回補初期跑的：`source_has_value_rate` 顯示評估期內「官方日成交結構」「發行股數」「外資持股」「自營商」的有值率都是 0（評估期不在已回補範圍內）。
    **這批結果不能當官方日資料有沒有用的結論**，回補完成後要重跑。

### 2.1 價量與交易制度

| 資料集 | 端點（日期參數） | 歷史起點 | 釋出 | 回聲驗證 | PIT（s 日 21:45 名單） | 狀態 |
|---|---|---|---|---|---|---|
| 個股 OHLCV（上市） | `www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=ALLBUT0999&response=json`（backfill-chip-3y.mjs:92-95）；當日可用 `exchangeReport/STOCK_DAY_ALL`（不吃日期） | chipArchive 2022-07-18 起；官方最早可查日未驗證 | 收盤後；daemon 15:10 歸檔 | 頂層 `date`＋表 title；STOCK_DAY_ALL 以首欄民國日期為資料日（ai-daemon.mjs:11767-11776），closeJson 5 元素在 11789-11790 | 可用 | in-use（MI_INDEX 原表另在研究快取回補中，2.0） |
| 個股 OHLCV（上櫃） | `www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=YYYY/MM/DD&type=EW&id=&response=json`（backfill-chip-3y.mjs:126-140）；openapi `tpex_mainboard_daily_close_quotes` 只有當日 | 2022-07-18 起；2023-01-05 實測 | 16:07–16:49，偶爾晚到 21:37（CLAUDE.md） | `date`＝YYYYMMDD 且 `tables[0].date` 民國；openapi 比對 `Date`（ai-daemon.mjs:11378） | 可用，但名單要走兩市到齊閘門 `writeCanonical` | in-use（dailyQuotes 原表另在研究快取回補中，2.0） |
| ETF 日 K（5～6 碼與英文字尾：槓桿 L、反向 R、期貨 U、債券 B、主動 A…；4 碼 ETF 在 chipArchive） | 上市＝同上 MI_INDEX `ALLBUT0999` 每日收盤行情表；上櫃＝同上 dailyQuotes（2026-10-05 實測 `type=EW` 與不帶 `type` 同為 11,928 列、ETF 118 檔，含 ETF）。讀取：`scripts/lib/official-bars.mjs`（AI 停損 A3） | 鏡像 2022-07-18 起 1,023 日全數回聲相符、兩市每日都有（上市 130～232 檔、上櫃 84～119 檔，372 個代號） | 同收盤；鏡像 daily 22:40、retry 隔日 06:45 | 頂層 `date`＋表 title／`tables[0].date` 民國日期，兩者一致且＝鍵 | 可用 | in-use（停損 ATR 帶；不進 chipArchive、不進起漲訓練） |
| 興櫃當日行情（全表） | PRIMARY `www.tpex.org.tw/www/zh-tw/emerging/latest?response=json`（不吃日期；鏡像快照 `tpex_emerging_latest`）；FALLBACK openapi `tpex_esb_latest_statistics`（2026-10-05 22:38 實測已是當日、未落後）。欄：收盤＝「成交」（最後成交價）、日最高、日最低、成交量；**沒有開盤價** | 鏡像 2026-10-02（openapi）／10-05（www）起累積 | 盤中每分鐘更新；盤後定版 | www：`tables[0].date`「115年10月05日 16:33:03」；openapi：每列 `Date`（民國 7 碼）全表一致 | 當日可用、無歷史 | accumulate-only（官方沒有可指定日期的興櫃全表） |
| 興櫃個股歷史（逐檔逐月） | `www.tpex.org.tw/www/zh-tw/emerging/historical?type=Monthly&date=YYYY/MM/01&code=XXXX&response=json`（頁面 `/zh-tw/esb/trading/info/stock-pricing.html`；不帶代號回「請輸入資料日期及股票代碼」） | 頁面標 2007-01 起（未逐年驗證） | 未驗證 | 頂層 `date`＝月初 YYYYMM01、`subtitle`「115年09月 1260 富味鄉」 | — | backfillable，但**只有成交股數／金額／最高／最低／均價／筆數，沒有最後成交價與開盤價**：與每日快照的收盤口徑不同，未接（停損 A3 待裁定） |
| 成交筆數、金額、均價 | 同上兩表（上櫃有「均價／成交金額／成交筆數」欄；上市在 MI_INDEX 個股表） | 上櫃 ≥2023-01-05（實測），上市 ≥2023-03-15（舊稽核）；2022 下半年未逐日驗證 | 同收盤 | 同收盤 | 可用 | 研究快取回補中（目標 2022-07-18 起，進度見 2.0）；closeJson 仍只存 5 元素，這些欄在站上歸檔被丟棄（ai-daemon.mjs:11789-11790） |
| 上市當沖成交股數 | `www.twse.com.tw/exchangeReport/TWTB4U?response=json&date=YYYYMMDD&selectType=All` | 2022-07-18 起 1,023 日 | 首見 20:17–20:43（audit-data-sources.mjs:701-704） | `date`＝請求日；兩張表都含「證券代號」，要以欄名雙重定位（ai-daemon.mjs:11876-11886） | 可用，但時間很緊 | in-use（只有上市） |
| 上櫃逐檔當沖 | `www.tpex.org.tw/www/zh-tw/intraday/stat?date=YYYY/MM/DD&type=Daily&response=json` 的 `tables[1]`（欄位：證券代號／證券名稱／暫停現股賣出後現款買進當沖註記／當日沖銷交易成交股數／買進金額／賣出金額） | ≥2022-07-18（2026-10-04 實測 1 次 GET：710 列，含 ETF）；舊稽核 2023-01-03 亦可 | 未驗證 | 頂層 `date`＝YYYYMMDD 且 `tables[1].date`＝民國日期；`stat` 是小寫 `ok`；`tables[1]` 沒有 title，要以欄名定位 | 未驗證（推估趕得上） | 研究快取 `tpex_daytrade` 回補中（目標 1,023 日，進度見 2.0） |
| 注意股 | 上市 `rwd/zh/announcement/notice?startDate=&endDate=`（YYYYMMDD）；上櫃 `www/zh-tw/bulletin/attention?startDate=&endDate=`（斜線）（fetch_attention.mjs:4-9） | 2022-07 起已快取 | 盤後；公告日＝觸發日 | 上市 title 起迄＋筆數＝total；上櫃 `title2`（fetch_attention.mjs:43-52） | pub≤s 可用；實驗只用 pub≤s−1 | backfillable（已快取） |
| 處置股 | 上市 `rwd/zh/announcement/punish?startDate=&endDate=`；上櫃 `www/zh-tw/bulletin/disposal?startDate=&endDate=`（fetch_disposal.mjs:4-7、44-51） | 2022-07 起已快取 | s 日晚間（鐘點未驗證） | title／title2 的起迄 | 公布日≤s 可用；處置起日通常是次一營業日 | backfillable（已快取） |
| 可能達處置 | 上市 `rwd/zh/announcement/notetrans`（能否帶歷史日期未驗證）；openapi 只有當日 | 未驗證 | 盤後 | title 民國日期 | 當日可用，無歷史 | accumulate-only（研究端用 a29 規則模擬） |
| 變更交易／全額交割（上市） | `www.twse.com.tw/exchangeReport/TWT85U?response=json&date=YYYYMMDD` | ≥2022-07-18（實測 17 檔） | 未驗證；盤中可能臨時新增 | `date`＋title「111年07月18日 變更交易」 | date=s 可用；s+1 新增要到 s+1 才知道 | backfillable |
| 上櫃管理股票 | dailyQuotes 的 `tables[1]`「管理股票」 | 未驗證（2023-01-05 為 0 筆） | 同上櫃收盤 | 同 dailyQuotes | 同收盤 | backfillable（內容未驗證） |
| 除權息係數 | 上市 `rwd/zh/exRight/TWT49U?startDate=&endDate=`；上櫃 POST `www/zh-tw/bulletin/exDailyQ`（scripts/lib/exright-source.mjs:19-39） | 2022-07-01～2026-09-30 共 10,809 件 | 未驗證 | TWT49U title 含起迄；exDailyQ 只能以「資料日期落在區間內」當回聲 | 事件日當下已知 | in-use |
| 官方參考價與漲停價（上市） | `www.twse.com.tw/exchangeReport/TWT84U?response=json&date=YYYYMMDD&selectType=ALL`；研究快取用 `www.twse.com.tw/rwd/zh/variation/TWT84U?date=YYYYMMDD&selectType=ALLBUT0999&response=json`（official_adapters.mjs `twse_limit`，2024-03-04 實測 date 回聲、1,225 列）。舊稽核記錄「rwd 同名路徑回 302」；`variation/` 這條 rwd 路徑實測可用 | ≥2023-01-05（實測 23,824 列）；2022-07-18 起由研究快取回補中（2.0） | 未驗證；「本日」值開盤前已確定；date=s+1 那份最早何時上架**未驗證** | `date`＋title「股價升降幅度」；「開盤競價基準」欄名出現兩次，要用 groups 或索引區分 | date=s 可當 s 日特徵；date=s+1 在上架時刻實測前只能用在標籤 | 研究快取 `twse_limit` 回補中（2.0） |
| 次日參考價與漲停價（上櫃） | dailyQuotes 的「次日參考價／漲停價／跌停價」欄 | ≥2023-01-05（實測） | 同上櫃收盤 | 同 dailyQuotes | s 日盤後就有 s+1 值，PIT 最乾淨 | 研究快取 `tpex_daily` 回補中（目標 2022-07-18 起，進度見 2.0） |
| 減資恢復買賣參考價（上市） | `www.twse.com.tw/rwd/zh/reducation/TWTAUU?startDate=&endDate=`（ai-daemon.mjs:11570） | 2023 起（舊稽核） | 恢復買賣前公告 | 欄名定位；daemon 沒有檢查 title 回聲（ai-daemon.mjs:11564-11573） | 已知 | backfillable（上櫃對應端點未驗證） |
| 首五日無漲跌幅、暫停交易、暫停先賣後買 | openapi `exchangeReport/TWT88U`、`TWTAWU`、`TWTBAU1/2`；上櫃 openapi `tpex_securities` | 無（TWTBAU2「歷史查詢」深度未驗證） | 未驗證 | openapi 自報日期，落後一日 | 事前公告 | accumulate-only |
| 發行股數 | 上櫃 dailyQuotes「發行股數」欄（可逐日）；上市 `rwd/zh/fund/MI_QFIIS` 欄 [3]「發行股數」（見 2.2）；openapi `t187ap03_L` 只有最新 | 上櫃 ≥2023-01-05；上市經 MI_QFIIS ≥2022-07-18（實測） | 同收盤 | 同來源表 | s 日或 s−1 值可用；MI_QFIIS 的股數只在公司申報異動時更新（欄 [11]「最近一次申報異動日期」），可能落後實際股本變動 | 研究快取 `twse_qfiis`、`tpex_daily` 回補中（目標 2022-07-18 起，進度見 2.0） |
| 每日市場別 | 由當日出現在 MI_INDEX 個股表（上市）或 dailyQuotes（上櫃）推導 | 2022-07-18 起，可隨收盤一起回補 | 同收盤 | 同收盤 | 可用 | backfillable（現用靜態 `code_market.json`） |

### 2.2 籌碼

| 資料集 | 端點（日期參數） | 歷史起點 | 釋出 | 回聲驗證 | PIT | 狀態 |
|---|---|---|---|---|---|---|
| 上市三大法人 | `www.twse.com.tw/rwd/zh/fund/T86?date=YYYYMMDD&selectType=ALL&response=json` | 2022-07-18 起 1,023 日 | 16:11–16:37 | `date`＋`stat=OK`（ai-daemon.mjs:11752-11755）；以欄名「外陸資買賣超股數(不含外資自營商)」定位 | 可用 | in-use（原表另在研究快取 `twse_t86` 回補中，2.0） |
| 上櫃三大法人 | `www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=YYYY/MM/DD&id=&response=json`；openapi `tpex_3insti_daily_trading` 只有當日 | ≥2022-07-18（實測 737 列） | 約 15:15 前 | 頂層 `date`＋表頭民國日期；fields 是重複的買／賣／超，只能按位置取：7 組 ×（買、賣、超）＋合計，欄序已用三道恆等式驗證（2.0） | 可用 | in-use（原表另在研究快取 `tpex_insti` 回補中，2.0） |
| 自營商（自行／避險） | 同 T86 與 dailyTrade（上櫃 [14-22]，已驗算；上市 [12-17] 位置未驗證，用欄名定位） | ≥2022-07-18（上櫃實測，上市推定） | 同法人 | 同法人 | 可用 | backfillable（未歸檔） |
| 融資融券（上市） | `www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=YYYYMMDD&selectType=ALL&response=json` | 2022-07-18 起 | 21:30 後（ai-daemon.mjs:11807）；寫入在 21:45–21:49 | `date`；取超過 100 列的那張表；錯日也可能回 OK，所以必須比對日期（repair-margin-thin.mjs:61-63） | 要等 21:45 班車寫入後才建 panel | in-use |
| 融資融券（上櫃） | `www.tpex.org.tw/www/zh-tw/margin/balance?date=YYYY/MM/DD&response=json` | ≥2022-07-18（實測 764 列） | 21:30 後 | 頂層 `date`＋表頭民國日期 | 同上市 | in-use（**daemon 期欄位錯誤，見第 6 節**） |
| 借券賣出餘額 | 上市 `rwd/zh/marginTrading/TWT93U?date=YYYYMMDD`；上櫃 `www/zh-tw/margin/sbl?date=YYYY/MM/DD`；openapi `tpex_margin_sbl` 落後一日 | 兩市 ≥2022-07-18（由歸檔推定） | 約 20:45–21:00 起 | `date`＋`fields[12]=='當日餘額'`、`fields[9]=='當日賣出'`（ai-daemon.mjs:11707、11718） | 21:00 後、兩市都到齊才算數 | in-use |
| 借券當日賣出／還券／調整 | 同 TWT93U 與 sbl 的 [9][10][11] | ≥2022-07-18（推定） | 同上 | 同上；自我檢查：前日餘額＋賣出−還券±調整＝當日餘額 | 21:00 後 | backfillable |
| 外資持股（上市，附發行股數） | `www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date=YYYYMMDD&selectType=ALLBUT0999&response=json`（2026-10-04 實測 1 次 GET，樣板可用） | ≥2022-07-18（實測：1,144 列＝`total`，含 ETF） | 未驗證 | 頂層 `date`＝請求日、`title`「111年07月18日 外資及陸資投資持股統計」、筆數＝`total`；12 欄：[3] 發行股數、[5] 外陸資持有股數、[7] 持股比率、[6] 尚可投資比率；是否含當日成交要用 T86 對帳（未驗證） | 上架時刻未驗證，接入前要先測 | 研究快取 `twse_qfiis` 回補中（目標 1,023 日，進度見 2.0） |
| 外資持股（上櫃，附發行股數） | `www.tpex.org.tw/www/zh-tw/insti/qfii?date=YYYY/MM/DD&response=json` | ≥2022-07-18（實測 801 列全表） | 未驗證 | 頂層 `date`＋表頭；依排行排序，代號在 [1]；比率是帶 % 的字串 | 推定可用 | backfillable |
| 集保股權分散 | `openapi.tdcc.com.tw/v1/opendata/1-5` | tdccArchive 2026-08-07 起 9 週 | 每週；資料日是週五，週六或週日才上架 | 「資料日期」欄，可能黏 BOM（archive-tdcc-weekly.mjs:43）；分級 16、17 不計入 | 見第 5 節週頻規則 | accumulate-only（不吃 date） |

### 2.3 基本面與公告

| 資料集 | 端點（日期參數） | 歷史起點 | 釋出 | 回聲驗證 | PIT | 狀態 |
|---|---|---|---|---|---|---|
| 月營收彙總表 | `mopsov.twse.com.tw/nas/t21/{sii\|otc}/t21sc03_{民國年}_{月不補零}_0.html`（big5，backfill-mops-revenue.mjs:9-12） | ≥2022-07（實測 111_7，937 列）；revenueArchive 只有 2023-08～2026-08 | 次月 10 日前申報；表重產時刻未驗證 | 標題「上市公司111年7月份…」核對年月與市場 | 保守口徑：次月 11 日起（build.py:164-167） | backfillable（缺 2022-06～2023-07） |
| 月營收 openapi | `openapi.twse.com.tw/v1/opendata/t187ap05_L`／`_P` | 無歷史 | 落後約一個月 | 「資料年月」；出表日期全表同一天 | 不適合當 s 日來源；數值照次月 11 日口徑使用，出表日期不可當申報日 | in-use（revenue.json 的後備，只准加厚 t21sc03 沒有的列；見第 3 節） |
| 逐公司營收申報日 | 無官方歷史；只能每日快照 t21sc03、比對新增代號自建「首見日」 | 從開始快照那天起 | — | 記錄抓取時間＋表內年月 | 21:45 前快照即符合 PIT | accumulate-only |
| 季損益表彙總 | `mopsov.twse.com.tw/mops/web/ajax_t163sb04`，`TYPEK={sii\|otc}&year={民國}&season=0{1-4}`（GET 實測可用） | 已回補 2021Q1～2026Q2（sii／otc 共 44 檔、41,382 列累計值，`mops_fin_backfill.mjs`）；finReports 每檔只留 9 季 | 法定期限：Q1 5/15、Q2 8/14、Q3 11/14、年報 3/31（一般業；金融業較晚） | 頁首「上市公司第二季資料」＋年份 | 各業最晚期限翌日：Q1 06-01、Q2 09-01、Q3 12-01、Q4 次年 04-01；Q2～Q4 先換算單季（2.0） | 已入研究快取，44 檔完成（2.0） |
| 資產負債表／營益分析 | `ajax_t163sb05`／`ajax_t163sb06`，參數同上 | 未驗證（推估同 sb04） | 同上 | 同上；sb06 營收單位是百萬元 | 同上 | backfillable |
| 重大訊息（官方公告） | POST `mops.twse.com.tw/mops/api/t05st02`（body 帶民國 year／month／day）；內文 POST `/mops/api/t05st02_detail`（ai-daemon.mjs:3565-3623） | mopsNews 2026-09-16 起；新 API 能否查歷史未驗證；舊站 GET 帶 2022-07-18 回「查無」，結論不明 | 逐則即時；89% 在 13:30 後，1.4% 在 21:45 後 | `r[0]` 民國發言日、`r[1]` 發言時間；依發言日分桶 | 用官方發言日期＋時間：≤s 日 21:45 進 s 日名單，其餘（含非交易日發布）進下一個交易日的名單 | accumulate-only（官方公告管線；進訓練前須過第 1 節三關） |
| 法說會日程 | `mopsov.twse.com.tw/mops/web/ajax_t100sb02_1`，`TYPEK&year={民國}&month={MM}` | ≥2022-07（實測 95 列） | 事前公告；公告時點不在表內 | 列內「召開法人說明會日期」 | 回補的表含事後公告的列，「距法說 N 日」有前視；「法說後首日」沒有前視問題 | backfillable（有條件） |
| 股東會日程 | openapi `t187ap41_L`（只有上市） | 無歷史 | 落後 1 天 | 開會日期 | 事前已知，但無歷史可回測 | accumulate-only |
| 停券預告 | openapi `exchangeReport/TWTBAU1`、`TWTBAU2` | 無歷史；除權息造成的停券可由 TWT49U 歷史按規則反推（推論，規則未驗證） | 事前 | StartDate 民國 | 事前已知 | accumulate-only |
| 官方產業別（逐月、兩市） | t21sc03 月營收表的「產業別：」分段 | ≥2022-07（上市實測；上櫃未驗證） | 同月營收 | 分段標題要帶到其後的公司列 | 逐月版本沒有靜態快照的前視 | backfillable（現行解析器丟掉了分段） |
| 官方產業別（現行） | openapi `t187ap03_L`；上櫃 `www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O`（未驗證） | 無歷史 | 落後一日 | 出表日期 | 慢變數 | accumulate-only |
| 官方產業別（MOPS 公司基本資料） | `mops.twse.com.tw` t05st03（上市、上櫃、興櫃；由台股 wiki 抓取，存在主 checkout `second-brain/wiki/_graph/stocks.json` 的 `industry`，2026-10-03 版 2,335/2,335 檔有值） | 無歷史（現行快照） | 官方慢變數每月 1 日 20:30 強制重抓（30 天快取；每晚 23:40 只續抓缺的或過期的）；stocks.json 每晚重建 | 產生器的重建完整性閘門（docs/STOCK-WIKI.md） | 慢變數；能否進訓練見第 8 節 | accumulate-only（每月快照） |

### 2.4 盤中與市場層

| 資料集 | 端點（日期參數） | 歷史起點 | 釋出 | 回聲驗證 | PIT | 狀態 |
|---|---|---|---|---|---|---|
| MIS 即時報價、五檔 | `mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=…&json=1&delay=0`（無日期） | 無官方歷史 | 每 5 秒揭示 | `d`＝日期、`t`＝時間（跌停是 `w`） | 只能從今天起自建 | accumulate-only |
| 尾盤五檔 bookDepthArchive | daemon 13:20–13:35 窗口，13:36 歸檔（ai-daemon.mjs:15532-15598） | 2026-07-20 起，可用約從 08-04 起 | 13:36 | 時間戳要落在窗內 | 可用 | accumulate-only（已測無效） |
| 開盤 30 分快照 snap0930Archive | daemon 09:31–09:59（ai-daemon.mjs:15490-15510） | 2026-07-20 起約 52 日 | 09:31 後 | 沒有比對 MIS `d` | 屬於 s+1 的資料，只能用來驗證或標籤 | accumulate-only |
| 官方逐檔盤中歷史（逐筆、分 K） | 無公開端點（逐筆是付費訂閱） | — | — | — | — | unavailable |
| 上市每 5 秒委託成交統計 | `www.twse.com.tw/rwd/zh/afterTrading/MI_5MINS?date=YYYYMMDD&response=json` | ≥2022-07-18（實測 3,241 列）；orderFlowArchive 從 2023-07-31 起 | daemon 15:25 抓 | `stat`、`date`、title 民國日期（backfill-orderflow.mjs:52-56）；遇 307 退避重試 | 可用 | backfillable（市場層，已測無效） |
| 上市每 5 秒指數 | `rwd/zh/TAIEX/MI_5MINS_INDEX?date=YYYYMMDD`（路徑未驗證） | 未驗證 | 未驗證 | 未驗證 | 未驗證 | backfillable（未驗證） |
| 加權指數日 OHLC | `rwd/zh/TAIEX/MI_5MINS_HIST?date=YYYYMM01`（以月為單位） | ≥2022-07（已快取 52 個月） | 盤後 | `stat`、`date`、title 年月、每列日期在月內（a34_market_fetch.mjs:37-52） | 可用 | backfillable（已快取） |
| 上市成交量值 | `rwd/zh/afterTrading/FMTQIK?date=YYYYMM01` | ≥2022-07 | 盤後 | 同上 | 可用 | backfillable（含 ETF、權證） |
| 上市漲跌家數 | `rwd/zh/afterTrading/MI_INDEX?date=YYYYMMDD&type=MS` | 已快取 2023-01-11 起；更早未驗證 | 盤後 | `stat`、`date`、「大盤統計資訊」title（a34_breadth_fetch.mjs:44-53） | 可用 | backfillable |
| 櫃買指數 | `www.tpex.org.tw/web/stock/aftertrading/daily_trading_index/st41_result.php?l=zh-tw&d=YYY/MM` | ≥2022-07 | 盤後 | `stat=='ok'`、`tables[0].date`、每列在月內 | 可用 | backfillable |
| 上櫃市場概況（漲跌停家數） | `…/market_highlight/highlight_result.php?l=zh-tw&d=YYY/MM/DD` | 已快取 2023-01-11 起 | 盤後 | `date` 與 `tables[0].date` 兩層都要驗 | 可用 | backfillable |
| 臺指選擇權 P/C 比 | `www.taifex.com.tw/cht/3/pcRatio?queryStartDate=YYYY/MM/DD&queryEndDate=YYYY/MM/DD`（GET） | ≥2022-07-18（實測） | 盤後；daemon 15:10／16:30 | 每列第一欄日期（YYYY/M/D 不補零） | 是否含夜盤未驗證，含的話有前視風險 | backfillable |
| 期貨三大法人（外資 TXF） | `www.taifex.com.tw/cht/3/futContractsDate`（GET 只回頁框；POST 歷史未驗證） | 未驗證 | 盤後 | 無 JSON 日期；daemon 用本機日曆當日期（違反回聲） | 未驗證 | in-use（站上 latest；研究未用） |
| 選擇權三大法人 | `www.taifex.com.tw/cht/3/callsAndPutsDate`（GET 不可行，POST 未驗證） | 未驗證 | 未驗證 | 未驗證 | 未驗證 | backfillable（推測） |
| 期貨每日行情（日盤／夜盤） | `www.taifex.com.tw/cht/3/futDailyMarketReport`（參數未驗證） | 未驗證 | 夜盤到 s+1 05:00 才收 | 未驗證 | 只有日盤值能用；夜盤歸屬交易日要先查清 | backfillable（未驗證） |

## 3. 現行訓練輸入的官方性稽核（2026-10-04）

資料流：Firestore → `fetch_cache.mjs` → `panel.py` → `build.py`（T1/T2）、`build_lu1.py`（隔日漲停）、`a35_shadow_lib.py`（影子名單，透過 `B.compute_features` 共用特徵）。

| 輸入 | 用在 | 上游（寫入端） | 判定 | 官方替代或處置 |
|---|---|---|---|---|
| closeJson [收,量,開,高,低] | panel.py:41 → 全部價量特徵、LU 標籤、mkt_* | 回補期用 MI_INDEX＋dailyQuotes；daemon 期用 STOCK_DAY_ALL＋TPEx openapi | 官方，但有破口：`scanArchiveGaps` 補不到時會用 Yahoo 逐檔補，並標 `gapFixSource`（ai-daemon.mjs:11390-11404、11487-11503） | 本機快取 0 份帶 `gapFixSource`。訓練前要斷言排除帶此標記的列，或改用官方帶日期端點重抓 |
| dayTradeJson | dt_ratio、dt_ratio20（build.py:314-315） | TWTB4U | 官方，只有上市 | 上櫃 intraday/stat `tables[1]` 另存新欄（例如 `dayTradeOtcJson`），重跑兩窗＋OOT |
| instJson [外資,投信] | fgn_*、trust_*、inst_pct_v1（build.py:298-304） | T86＋TPEx dailyTrade | 官方，但**口徑漂移**（見第 6 節） | 統一用「不含外資自營商」：上市 T86 [4]，上櫃 dailyTrade [4] |
| marginJson [資餘,券餘] | ml_*、ms_*（build.py:305-310） | MI_MARGN＋TPEx margin/balance | 官方，但**daemon 期上櫃欄位錯誤**（見第 6 節） | 修好前，2026-08-11～10-02 上櫃 ML／MS 設為缺值，或用 repair 腳本重抓（需核可） |
| lendingJson | lend_*（build.py:311-313） | TWT93U [12]＋TPEx sbl [12] | 官方。現行每日流程與回補腳本都取 TWT93U／sbl 欄 [12] 借券賣出**餘額**（ai-daemon.mjs:11855-11868、backfill-margin-tpex.mjs:54）；ai-daemon.mjs:11693 註解說站上「原本」歸檔的是 TWT96U 可借額度——哪一段歷史曾是 TWT96U 口徑**未驗證** | 進訓練前逐年抽查數值量級（可借額度遠大於借券餘額）確認口徑一致；補 2026-08-12、09-17 上市半邊（需核可） |
| 除權息係數 exright-history.json＋exright_delta.json | build.py:51-63 | TWT49U＋exDailyQ | 官方；delta 缺上櫃 09-30～10-02（ECONNRESET） | 補抓上櫃 delta |
| priceEvents（減資、面額變更、分割） | build.py:54-64 → 還原價、漲停參考價、結構斷點 | daemon `computePriceEvents`：TWTAUU＋Yahoo＋MOPS 主旨 | **not-official**：快取 24 個係數中 19 個來自 Yahoo；而且只涵蓋約 90 交易日（2026-05-20 起），更早的事件被 ±10.5% 斷點規則整段排除 | 上市用 TWT84U「本日開盤競價基準÷前日收盤價」，上櫃用 dailyQuotes「次日參考價÷收盤」，可逐日得到**全部**事件的官方係數；TWTAUU 補減資原因 |
| 漲停判定（LU 標籤、x_lu_s、locked_open） | build.py:30-40 依檔位規則自算 | 由參考價推算 | 規則正確：2023-01-05 上市 972/972、上櫃 807/807 與官方漲停價一致；誤差只來自參考價（即 priceEvents） | 直接改讀 TWT84U 本日漲停價、TPEx 次日漲停價 |
| peerComps_industries.json | ind_*（build.py:188-197、338-355） | openapi t187ap05_L/P 的產業別 | 官方，但**只有上市**（37 群、1,358 檔，覆蓋 67%，上櫃 0%），而且是 2026-10 的靜態快照（有前視） | t21sc03 月營收表的逐月「產業別」分段（兩市、PIT）；或 MOPS t05st03 官方產業別（兩市，慢變數，條件見第 8 節） |
| code_market.json | build_lu1.py:77、a35_shadow_lib.py:108 | finReports.market 靜態快照 | 官方，但靜態，轉市場的股票會整段標錯 | 依當日出現在 MI_INDEX 或 dailyQuotes 逐日推導 |
| revenue.json | rev_yoy、rev_mom、rev_yoy_acc（build.py:155-186、317-318） | MOPS t21sc03（主）＋openapi t187ap05（後備，只准加厚） | 官方 | 回補 2022-06～2023-07（28 個請求） |
| mkt_*（8 欄） | build.py:320-336 | closeJson 全市場中位數自算 | 同 closeJson | 可改用或交叉驗證 a34 已快取的官方序列 |
| 注意股、處置股快取 | 只在實驗 a18～a29 | TWSE rwd＋TPEx www | 官方 | — |
| 尾盤五檔 x_bd_* | build_lu1.py:11-12 | MIS 自建歸檔 | 官方，只能累積 | — |
| intradayArchive | 起漲研究目前沒用 | Yahoo 5 分 K | not-official | **禁止**進訓練；官方只能從 MIS 自建 |
| newsVerdict／newsDaily／mopsNews | 訓練與研究都沒讀（rg 確認）；只有 a35_compare_site.py:38、96 為了重現舊公式把 news 設為 0 | 媒體新聞／MOPS | 媒體新聞不得使用 | 現狀已符合（2026-10-04 grep surge-lab 的 .py／.mjs 只命中 a35_compare_site.py 與 a35_compare_test.py 的說明字串）；以後加入 mopsNews 要另開管線，並先過第 1 節三關 |
| 官方研究快取（`.surge-cache/official/`）＋ t163sb04 季損益 | official_features.py → cv_official.py（對照組，未併入主模型） | MI_INDEX、T86、MI_QFIIS、TWT84U（variation）、dailyQuotes、intraday/stat、dailyTrade、ajax_t163sb04，都是帶日期端點，逐請求回聲（只比對頂層 `date`） | 官方 | 每日資料**回補中**（2.0）；已落地部分量欄與 panel 對帳 100% 相符；併入主模型前先過兩窗＋OOT 與使用者裁定 |
| 台股 wiki 聯動關係（產業、集團、產業鏈、推導上下游、AI 輪廓） | 主模型（build.py、panel.py、build_lu1.py、a35_shadow_lib.py）沒有讀；`official_features.py`（對照組）讀 `industry`→`o_ind_*`、`group`→`o_grp_*`（實驗組，不併入 all） | `second-brain/wiki/_graph/stocks.json`（2026-10-03 版，現行快照） | 分層：見第 8 節 | 依第 8 節逐項判定；AI 層一律不得進回測 |
| panel.py:31 母體過濾 | 全部模型 | — | 4 碼、非 00 開頭，會讓 91xx TDR（9103、9105、9110、9136）進母體 | 用官方產業別 91（存託憑證）或 TWT85U 名單排除 |

**新增任何訓練輸入前**：把它加進上表，寫明寫入端與判定。判定不是官方的，不准合併進訓練。

## 4. 回補規範

- **先登錄、先問**：
  - 新端點先確認網域已在 `source-registry.json` 核准。
  - 大量回補（例如三年 × 兩市）先向使用者說明請求數、時段、落地位置，取得同意後才跑（var_audit：「實際回補三年要先跟使用者確認」）。
- **節流**：
  - 每台主機單線、逐請求間隔 **≥3 秒**。現有腳本用 1.2 秒或 500ms，研究回補一律放寬到 ≥3 秒。
  - **主機輪替**：同一輪要抓多個主機（twse／tpex／mopsov／taifex）時，用交錯排程攤開單一主機的負載，但每台主機仍要各自守 ≥3 秒。不要用多執行緒並行打同一台主機。
  - **MIS 不回補**（沒有歷史），研究也不手動打 MIS：會佔用 daemon 同一個 IP 的 3 req/5s 額度。
- **時段**：研究回補和 daemon 在同一個家用 IP。上游一封鎖，站上即時資料、收盤歸檔、法人、資券都會中斷。避開以下時段：
  - 交易日 08:20–13:45（盤前試撮、盤中、尾盤五檔窗）。
  - daemon 抓官方資料的班次：15:10 收盤歸檔、15:25 MI_5MINS、16:10 健康稽核、16:30 官方補跑、16:45 起資料到齊班車、20:45–21:50 借券與資券班車。
  - MOPS 重訊在 07:00–23:30、非交易日也跑，每輪間隔 30 分鐘，但**以上一輪的時間起算，不對齊整點或半點**；
    一輪是 1 次列表加最多 150 次內文（ai-daemon.mjs:3566、15277-15281）。打 mops 或 mopsov 前先看 daemon 日誌最近一輪 MOPS 的時刻，
    排在兩輪之間，不要靠「避開整點」。
  - 建議窗口：非交易日白天，或交易日 22:15～23:40。
  - **台股 wiki 排程也用同一個 IP**（`scripts/stock-wiki-nightly.mjs`）：每晚 23:40 起續抓 MOPS t05st03（mops.twse，逐檔 2.5 秒）並下載 doc.twse 年報（每晚 ≤180 檔），直到跑完；
    每月 1 日 20:30 強制重抓官方慢變數（openapi.twse t187ap*、mops t05st03）。這兩段不要疊上去，跑完與否看 `~/Library/Logs/twstock-stock-wiki/`。
    02:00–06:30 的年報萃取是本機 Ollama，**不打上游**；ic.tpex 價值鏈尚未接（DNS 待修）。
  - 開跑前看 daemon 日誌近 15 分鐘有沒有上游故障字樣（`scripts/lib/outage-scan.mjs` 同一套判斷）。有就不跑。
- **回聲驗證**（逐請求）：
  - 回應自報的資料日必須等於請求日：頂層 `date`、表頭或 title 的民國日期、或資料列的日期欄。
  - 區間查詢還要核對起迄與筆數＝total。
  - 驗證失敗就丟棄，不寫快取。**`stat=OK` 不等於日期對**（MI_MARGN、BWIBBU 都有前例）。
- **落地**：
  - 只寫本機研究快取 `scripts/surge-lab/.surge-cache/`（已在 .gitignore）。**不寫 Firestore**。
  - 要修 chipArchive 等線上文件，屬另案，需使用者核可。
  - 新資料另開檔案或欄位，**不改 closeJson 的 5 元素格式**，也不併入已回測過的欄位，例如 dayTradeJson、instJson。
  - 每份快取記錄 `source`（端點）、`fetchedAt`、`echo`（回聲值）。
- **斷點續傳**：
  - 一日或一月一檔，外加 `_fetch_log.json`（照 a34_market_fetch.mjs 的做法）。
  - 重跑時跳過已通過回聲的檔案。缺口要明列，不靜默補值。
- **失敗即停**：
  - 下列情況整批停下並回報，**不換來源補洞**（禁止退回 Yahoo）：連續 3 次 HTTP 錯誤、ECONNRESET、DNS 失敗、307／403、回應變成 HTML 錯誤頁、出現驗證碼。
  - 遇到驗證碼頁，記為「不可自動化」，不嘗試繞過。
  - 非交易日回 `stat≠OK` 屬正常，要以官方交易日曆（`system/tradingCalendar` 或 MI_5MINS_HIST 推得的日曆）判斷，不算失敗。
- **市場完整性**：
  - 合併兩市的日表，要檢查**每個市場各自的檔數**，不能只看總數。
  - 例：2026-03-10 上市資券只有 220 檔（repair-margin-thin.mjs:15-17），合計數看不出來。
- **4 碼過濾**：T86、TWT84U、TPEx 各表都混有 ETF、權證、債券 ETF。用 4 碼且非 00 開頭過濾，再另外排除 91xx TDR。

## 5. PIT 規則（避免前視）

名單在 s 日 21:45 後產生，訓練特徵只能用「s 日 21:45 時已公開、且回聲驗證過」的資料。

- **通則**：每筆資料存兩個時間——資料日（來源自報）與**首次公開時間**（官方發言時間、或首次被歸檔的時間取上界）。
  可用於 s 日名單的條件是「首次公開時間 ≤ s 日 21:45（台北）」，s 必須是交易日；非交易日公開的資料歸到下一個交易日的名單。
  不知道首次公開時間的，用下表的保守可用日，不可用資料日代替。
  注意：站上規定「非交易日的資料記為最後一個交易日」（記錄口徑）。若某筆週末公開的資料被記在週五的文件或桶裡，
  訓練端仍要用它的官方公開時間判定，它只能進下週一（下一交易日）的名單；**不可因為記錄日是週五就併入週五名單**。
- **回補資料天生沒有公開時間**：帶日期端點今天回補的 s 日資料，只證明「資料日是 s」，不證明 s 日 21:45 前已上架。
  上架時刻只能由 daemon 日誌、audit 紀錄或今後每日快照證明；下表標「未驗證」的釋出時刻，在證明前一律往後推一個交易日使用。
- **標籤期的資料不得回流成特徵**：s+1 以後的價量、參考價、試撮、開盤快照，只能出現在標籤或兩段式第二段。

| 類別 | s 日可用時點 | 規則 |
|---|---|---|
| 上市收盤、當沖 | 收盤後；當沖 20:17–20:45 | 用資料日等於 s 的那份 |
| 上櫃收盤 | 16:07–16:49，偶爾 21:37 | 名單要等兩市到齊（`writeCanonical`），不可用時鐘判定到齊 |
| 法人 | 上櫃約 15:15，上市 16:11–16:37 | 分市場確認到齊；15:00–16:30 之間 instJson 可能只有上櫃（ai-daemon.mjs:11240-11248） |
| 借券 | 20:45–21:00 起 | 兩市都到齊才用 |
| 資券 | 21:45–21:49 班車寫入 | panel 要在這筆寫入後才建；`canonical-gate` 目前只檢查收盤與法人，不檢查資券 |
| 官方參考價、漲停價 | TWT84U date=s 開盤前已確定；TPEx 次日參考價在 s 日盤後給 s+1 | s+1 的值只能用在標籤，不能當 s 日特徵（上櫃次日參考價本身在 s 日已公告，可當特徵） |
| 注意、處置 | 盤後公告 | pub≤s 可用；保守做法（實驗現行）用 pub≤s−1 |
| 月營收 | 次月 10 日前逐公司申報 | 沒有逐公司申報日，就一律用**次月 11 日起**（build.py:164-167）。**不可用 openapi 出表日期當申報日**（revenueDates 全表同一天） |
| 季財報 | 法定期限 | 一律用**各產業中最晚的法定期限再加 1 日**：Q1 06-01、Q2 09-01、Q3 12-01、Q4 次年 04-01。**金融業期限比一般業晚**，用一般業期限會讓金融股提前可用。Q2～Q4 是年初累計值，要先差分成單季（2.0） |
| 彙總表的事後重編 | — | t21sc03、t163sb04 反映最新值（出表日是重產日），有輕微前視；要嚴格 PIT 就從今天起每日快照 |
| 集保（週頻） | 資料日週五，週六或週日才上架 | 從**首次被歸檔之後的下一個交易日**起使用（實務上是下週一的名單）。對齊要用首次歸檔時間，不能用資料日。**不可把週五的值回貼到同週一～五** |
| 重大訊息 | 逐則即時 | PIT 鍵用官方發言日期加時間，不用抓取時間。21:45 前發布的（約 98.6%）進 s 日名單，之後的與非交易日發布的進下一個交易日。列表混有前一日晚間補登，要依發言日分桶。現階段只做影子記錄，不進訓練（第 1 節） |
| 媒體新聞（newsVerdict／newsDaily） | — | **不進訓練、不進計分**。即使做影子對答案，也要注意它的判讀在 s 日 23:00 後才跑、目標日是 s+1（var_audit：ai-daemon.mjs:6649、6950），對 s 日名單本身就是前視 |
| 法說會日程 | 事前公告，但公告時點不在表內 | 回補表裡「s 日之後才公告」的法說不可拿來算「距法說 N 日」；只有「法說已發生」類特徵可以直接用 |
| 產業別、市場別 | 慢變數 | 用逐月或逐日官方版本；不要拿今天的快照套回歷史 |
| 發行股數 | 逐日 | 用 s 或 s−1 的官方值；用今天快照套回會有減資或增資前視 |
| 期權 | 日盤盤後 | 夜盤屬於哪個交易日先查清（未驗證）；P/C 比是否含夜盤未驗證 |
| 盤中（MIS、試撮、開盤快照） | — | s+1 08:30 以後的資料只能用在兩段式的第二段或標籤，不能當 s 日特徵 |
| 事件類（除權息、減資、停券） | 事前公告 | 只用 s 日當時已公告的事件。預告表 TWT48U 帶歷史日期仍回當前名單，**不可回查**（var_audit.txt:339） |

## 6. 已知陷阱

- **openapi 整批落後一日**：MI_INDEX、STOCK_DAY_ALL、BWIBBU_ALL、t187ap03_L、tpex_margin_sbl 都是。當日或歷史資料一律用 www／rwd 帶日期端點，openapi 只當後備（CLAUDE.md）。
  `MI_MARGN` 的 openapi 實測沒有落後，但沒有日期欄位、無法回聲驗證（CLAUDE.md 鏡像表），所以同樣**不可當訓練來源**。
- **BWIBBU rwd 的 `date` 欄是服務日（今天），`title` 開頭的民國日期才是資料日**；而且完全忽略 `date` 參數，不能查歷史。驗日期欄要挑資料日不等於今天的時段（盤中或休市日）。
- **TPEx 8 碼日期被靜默忽略、回最新**：dailyQuotes、dailyTrade、margin、sbl、qfii、intraday/stat 一律用 `YYYY/MM/DD`。上櫃 `disposal_information_result.php` 變體忽略日期，不可用（fetch_disposal.mjs:7）。
- **TPEx intraday/stat 有逐檔當沖 `tables[1]`**。daemon 註解「TPEx 沒有逐檔當沖」（ai-daemon.mjs:11904-11909）是錯的；daemon 只讀了 `tables[0]` 市場總計。
  2026-10-04 實測 date=2022/07/18：`tables[1]` 710 列、欄位含「當日沖銷交易成交股數」。daemon 11893-11898 的註解要求「上櫃另存、不併入 dayTradeJson、重跑兩窗＋OOT」，這條照舊遵守。
- **TWTB4U 回兩張都含「證券代號」的表，順序會變**：要同時用「證券代號」與「當日沖銷…成交股數」定位。只有 lots>0 才寫，所以 0 張和缺資料分不出來（ai-daemon.mjs:11891）。
- **revenueDates 不可用**：t187ap05 的出表日期全表同一天（1150717／1150817／1150917），不是逐公司申報日。
- **91xx TDR 漏網**：panel.py:31 只排除 00 開頭，9103、9105、9110、9136 會進母體（9110 還在變更交易名單）。用官方產業別 91 或名單排除。
- **全額交割／變更交易沒有旗標**：<10 元與冷門股裡很多（2024-01-03 變更交易 14 檔中 13 檔均量 <300 或股價 <10）。用 TWT85U 與上櫃管理股票當**排除或警示**，不當預測特徵。
- **daemon 漲停判定用前收盤價取檔位，會漏判**：
  - 位置：`luLimitPrice = floor(pc*1.1/tick(pc))*tick(pc)`（ai-daemon.mjs:12943-12945），`_teIsLimitUp` 同樣寫法（12113-12114）。
  - 正確做法是**用漲停價本身所在的檔位**：`tick(raw)`，raw＝參考價×1.1。build.py:36-39 與 src/lib/twse-api.ts:70-76 都是這樣寫。
  - 例：前收 9.6，raw＝10.56。daemon 用前收的檔位 0.01 算出 10.56；正確是用 raw 所在檔位 0.05，漲停價 10.55。所以收在 10.55 鎖漲停也判否。
    （前收 9.5 不是反例：raw＝10.45 剛好落在 0.05 檔位上，兩種算法都是 10.45。）
  - daemon 還用前收而不是除權息參考價，`floor` 也沒有加 1e-9 的浮點容差。
  - 漏判比例（任務摘要稱 5.1%）**未驗證**。
  - 研究端標籤不受影響，但站上名單和訓練口徑因此不一致。修 daemon 屬另案，需核可。
- **上櫃資券 daemon 用錯欄**：
  - 位置：ai-daemon.mjs:11830 取 `r[2]`、`r[3]`，那兩欄是前資餘額與資買；正確是 `[6]` 資餘額、`[14]` 券餘額。
  - 影響：2026-08-11～10-02 約 37 個交易日的上櫃 ML 晚一天、MS 其實是融資買進，正好是 a35 影子名單的打分期。
  - 證據：08-11 上櫃 ML 與前一日相同的比例 99.2%；MS/ML 中位數從 0.001 跳到 0.004～0.009。
- **外資口徑漂移**：
  - 上市一律「不含外資自營商」，但 backfill-missing-days.mjs:108 寫入的 4 日是 [4]+[7]（含）。
  - 上櫃 2026-02-20 前用 [4]（不含）；之後 backfill-otc-inst.mjs:31 與 daemon fetchTpexInst（ai-daemon.mjs:3262）改用 [10]（含）。
  - fetchTpexInst 的回聲是弱檢查：回應缺 `date` 會放行（ai-daemon.mjs:3255）。
- **借券上市半邊缺漏**：2026-08-12、09-17 只有上櫃。成因是借券區塊沒有 21:30 時間閘，而且只檢查上櫃樣本（ai-daemon.mjs:11847-11852）。
- **回聲沒做的腳本**：
  - backfill-chip-3y.mjs 的上市 MI_INDEX 與 T86 沒有比對 date。
  - backfill-margin-tpex.mjs:54 的上市 TWT93U 只看 `stat=OK`。
  - TWTAUU 沒有比對 title。
  - snap0930Archive 沒有比對 MIS `d`。
  - taifexPositions 的 date 來自本機日曆（ai-daemon.mjs:3433、3456）。
  - 這些資料進訓練前要重新驗證，或用有回聲的端點重抓。
- **TAIFEX 外資台指期欄位疑似錯**：註解寫未平倉淨額是第 11 個數字，程式卻取 `nums[4]`（ai-daemon.mjs:3438 對 3445-3446），可能存的是當日成交淨口數。regex 也會丟掉一位數的值（從程式推斷，未用線上頁面驗證）。
- **端點身分要驗**：`TWT48U_ALL` 是除權息預告表，不是注意股；`t187ap10_L` 是月營收不足名單，不是處置股（CLAUDE.md）。
- **daemon `getIndustryMap` 對 openapi.twse.com.tw 打 `t187ap03_O`**（ai-daemon.mjs:14730-14739），但本機 TWSE swagger 沒有這條路徑，可能一直靜默失敗（未實打驗證）。
- **MOPS 重訊**：
  - marketKind 含 rotc（興櫃）與 pub（公發），訓練母體要排除。
  - apiName 不是 t05st02_detail 的列沒有內文。
  - 內文上限 1,200 字；單日超過 900KB 時只保留最新 300 則內文。
- **季財報**：Q2～Q4 損益是年初累計；金融業沒有「營業收入」欄；營益分析 sb06 的營收單位是百萬元，損益表是千元。
- **法說會日期欄可能是區間**（「111/05/22 至 111/07/22」），daemon 的 rocDate 正規式只吃單日，會把這類列丟掉（ai-daemon.mjs:8262、8277）。
- **exDailyQ 曾連不上**（2026-10-03 ECONNRESET）。任一市場失敗就 throw，不可當作「沒有除權息」。factor 只收 0.3～1.2（exright-source.mjs:7）。
- **MIS `pz` 兩種語義**：連續交易時段是上一筆成交的回聲，集合競價時段是試撮指示價（可能永遠不成交）。收盤後殘留掛單不可當現價。
- **本機 DNS 曾解析不到 www.tpex.org.tw**（2026-10-03）。回補遇到 DNS 失敗就停，不要退回別的來源。
- **ETF 沒有成交的日子，TWT84U「本日開盤競價基準」跟淨值走**（實測 00625K 無成交仍每天變）：用參考價推除權息係數只能取「前一交易日有成交」的列（`official-bars.mjs` `twt84uFactors`）。
- **ETF 分割／反分割不在 `exright-history.json`**（TWT49U／exDailyQ 只有除權息）：2024-12～2026-07 鏡像日 K 找到 9 件停止買賣後的結構斷點
  （00632R、00676R、00663L、00673R、00706L、00715L、00631L 2026-03-31、00674R、00685L 2026-07-07；`node scripts/official-bars.mjs factors`）。
  跨斷點的日 K 不可直接算還原價或 ATR，要先有官方分割係數。

## 7. 無法取得或只能累積的資料與因應

| 資料 | 原因 | 因應 |
|---|---|---|
| 集保股權分散 | openapi 不吃 date；官網 qryStock 只留 51 週、要逐檔查約 10 萬次，而且 `www.tdcc.com.tw` 沒有登錄，有沒有驗證碼未驗證 | 從 2026-08-07 起每週歸檔，**斷一週就永久缺那一週**。要做外樣本檢定需累積 12～18 個月；在那之前不進主模型 |
| 官方逐檔盤中歷史（逐筆、分 K） | 公開端點沒有，逐筆是付費訂閱 | 禁用 Yahoo intradayArchive。日內型態先用日線近似（收盤位置、上影線）。真要用，就由 MIS 自建分段快照，先算 MIS 頻寬（快線＋主迴圈已約 2.7 req/5s） |
| 盤前試撮 08:30–09:00 | MIS 只有即時值 | 只輪詢影子名單、自建歸檔；只能用在兩段式的第二段 |
| 分點券商進出 | 上市買賣日報表查詢頁一般有驗證碼（未實測）；上櫃未驗證；第三方付費資料未核准 | **不可自動化**，不繞過。注意股第 5 款（券商集中）只能當間接指標 |
| 可能達處置名單歷史 | openapi 只有當日；rwd 能否查歷史未驗證 | 研究用 a29 官方規則模擬，同時從今天起每日歸檔，用來校驗模擬結果 |
| 首五日無漲跌幅、暫停交易、暫停先賣後買 | 只有 openapi 當期 | 每日歸檔；目前新上市以 125 日歷史門檻排除（build.py:27） |
| 股東會日程、停券預告 | 只有當期 | 每日歸檔；除權息停券可由 TWT49U 歷史按規則反推（規則未驗證）；股東會停券沒有歷史 |
| 逐公司營收／財報申報日 | 官方歷史來源未找到 | 每日 21:45 前快照 t21sc03 與 t163sb04，記首見日；在那之前用保守可用日 |
| 重大訊息歷史 | 新 API（POST）能否帶歷史日期未驗證；舊站 GET 回「查無」 | 先用 1 次 POST 帶 2022 日期實測。不行就只從 2026-09-16 起累積，進訓練前要累積足夠樣本 |
| 上櫃減資／面額變更參考價 | TPEx 專屬端點未找到 | 用 dailyQuotes「次日參考價÷收盤」直接得到官方係數，不需要事件表 |
| 期交所法人歷史（POST） | GET 只回頁框；POST 未驗證 | 先各做 1 次 POST 實測（含回聲日期）再定案 |
| MI_5MINS_INDEX、futDailyMarketReport | 端點與參數未驗證 | 各做 1 次實測並登記到 CONTRACTS 再用 |

## 8. 台股 wiki 聯動關係能不能進訓練

**依據**：`docs/STOCK-WIKI.md`、`second-brain/wiki/_graph/stocks.json`、`scripts/lib/wiki-facts.mjs`，以及記憶 project-tw-stock-wiki 與 feedback-news-macro-supply-chain。
wiki 每筆事實都帶來源等級，由高到低是：官方 > 官方衍生 > 站內推導／整理 > 近似 > 媒體 > AI 待驗。
**wiki 幾乎全是 2026 年建的「現行快照」，沒有歷史版本**。所以一個關係能不能當訓練特徵，看的不只是「來源是不是官方」，
還要看「回測的 s 日當時，這份資訊存不存在、長不長這樣」。

覆蓋數是 2026-10-04 對 `generatedAt=2026-10-03` 版 stocks.json（主 checkout `tw-stock-app/second-brain/wiki/_graph/`，2,335 檔）的實測值；等級取自產生器 `scripts/lib/stock-wiki/model.mjs` 的 `SOURCES` 與 graph.json 邊的 `src`。wiki 每晚重建，引用時以當版為準。

| 關係（stocks.json 欄位） | 來源等級 | 覆蓋 | 能否當訓練特徵 | PIT 條件與用法 |
|---|---|---|---|---|
| 官方產業別 `industry`（MOPS t05st03） | 官方 | 2,335 | **可以（有條件）** | 慢變數，前視風險低。用來取代 `peerComps_industries.json` 的產業別（那份只有上市，而且是 2026-10 靜態快照，見第 3 節）；`official_features.py` 的 `o_ind_*` 即用此欄。它仍是現行快照：回測期內換過產業或轉市場的股票要排除或標記；要嚴格 PIT，就改用 t21sc03 的逐月「產業別」分段（2.3）。回測報告要註明用的是現行快照 |
| 集團 `group`（單一最大法人股東樹：每家公司只連到持股最高、且 ≥5% 或屬 10% 大股東的法人；公股與創投不當上層；**不是公司法上的關係企業**） | 站內推導（由官方 t187ap11 董監、t187ap02 大股東推導） | 387 | **只能進實驗組** | 現行董監與持股推出的快照，回測有前視（入主、改選、處分持股都會改變樹）。只放實驗組（`official_features.py` 的 `EXPERIMENTAL['grp']`，不併入 all）、**分開報告、不進主模型**。等有逐期董監與持股歷史、能做 point-in-time 版本再議 |
| 法人董監／大股東 `corporateHolders`、`holdsBoardSeatIn` | 官方（t187ap11、t187ap02 的現行名單；不含持股比例） | 902／227 | **只能進實驗組** | 同上，是現行名單快照。上櫃董監明細目前暫缺（tpex DNS），覆蓋偏向上市，上櫃沒有值不代表沒有法人股東 |
| 主題產業鏈 `chains`、`upstream`、`downstream`（themeMap 人工維護 seed；upstream／downstream 由同一條鏈的 role 先後推出） | 站內整理 | 177 檔、36 條鏈；upstream／downstream 43／32 | **不可進回測** | 2026 年人工整理，有事後挑選偏差（挑的多半是已經漲過的題材）。不得當回測特徵、母體或標籤 |
| 推導上下游 `derivedUpstream`、`derivedDownstream`（年報原料↔產品名稱比對，兩端都是年報，邊的 `tier` 是 `annual`） | 站內推導（兩端年報；wiki-facts 列入事實區） | **0／0**（年報層還沒覆蓋） | **原則上不用；真要用有條件** | 要綁定所依據的年報年度，以**該年報的公告日**當 PIT，s 日只能用當時已公告的那一版。目前沒有逐年版本，所以現階段不進回測 |
| 同業與規模：`peers`（同官方產業別中市值最近的 12 檔）、`mktCap`（站內收盤快照×股數）、`etfsApprox`（0050／006208 成分市值近似） | 站內推導／官方衍生／近似 | 2,314／2,314／50 | **不可進回測** | 都以 2026 年的現行市值排序或近似，套回歷史有前視。規模特徵改用 PIT 的官方發行股數×當日收盤（`official_features.py` 的 `o_log_mcap`） |
| AI 層：`profile`（`src` 含 ai-knowledge）、`productGeo`、`crossIndustries`、`derivedUpstreamAi`、`derivedDownstreamAi` | AI 待驗 | profile 2,335（**全部** `src=ai-knowledge`，年報層 0 檔）；productGeo 798；crossIndustries 840；derived*Ai 167／122 | **永遠不進回測** | 內容編碼的是 2026 年的知識（模型知道哪些公司後來成了題材股），放進回測等於偷看答案。只可用於往後的前瞻或影子記錄，以及新聞判讀的參考 |

- 年報與 AI 混合的輪廓（`profile.src` 同時含 annual-report 與 ai-knowledge；wiki-facts 標「年報＋AI待驗」）訓練端一律比照 AI 層處理。
  純年報輪廓、以及由年報廠區推出的生產地（`productGeo` 中年報來源的部分），比照推導上下游：要綁年報年度與公告日當 PIT，現階段年報層 0 檔，不進回測。
- 任何 wiki 欄位要進訓練或實驗組，都要先加進第 3 節的表，寫明欄位、版本日期（`generatedAt`）與 PIT 鍵。
- **新聞判讀不受本節限制**：新聞分析可以使用所有等級，但要標明等級。`wiki-facts.mjs` 的分區是：
  事實區 facts＝`mainBusiness`、`chains`、`upstream`／`downstream`、兩端年報的 `derivedUpstream`／`derivedDownstream`、`group`（標「持股關聯群」）；
  參考區 reference＝`derived*Ai`、`profile`（年報、年報＋AI待驗、AI整理·待驗三種標籤都在這區）、`crossIndustries`、`productGeo`，提示詞標「參考·未完全驗證（不可單獨當作連動依據）」。
  `industry` 不經 wiki-facts（daemon 另外餵官方產業別）；`corporateHolders`、`holdsBoardSeatIn`、`peers`、`etfsApprox`、`mktCap` 不在 wiki-facts，daemon 判讀看不到。
  兩區不可混用。判讀規則見 `tw-news-impact-analyst` §3A。新聞判讀的產出本身，仍依第 1 節**不進訓練、不計分**。

## 9. 回測記錄規範

**依據**：記憶 feedback-backtest-hits-and-misses（使用者 2026-10-04 指定）。**適用度：硬規定**。

- 特徵訓練後的每一次回測都要寫逐件記錄，包括起漲 T1／T2、隔日漲停、影子名單對答案、新特徵對照。只有彙總數字（命中率、lift）不算完成。
  - **命中**：事件發生，而且在當日前 K 名。
  - **漏網**：事件發生，但不在當日前 K 名。K 要和報告口徑一致。
  - **母體外**：事件發生，但不在母體內。要註明是被哪一道濾網擋掉。
- 每列欄位：日期、代號、名稱、市場、模型分數、同日名次、關鍵特徵的同日百分位，以及**各資料來源當天有沒有值**（缺值本身就是漏網原因的候選）。
- 另附一份命中對漏網的差異摘要：各特徵組的同日百分位、各來源缺值率、漏網名次分布、分市場件數。
- 存放位置：`scripts/surge-lab/out/`，不寫 Firestore。報告要附上各份記錄的路徑。
  範例是 `cv_official.py` 的輸出：`out/official_cv_{task}_{模型}_hits.csv`、`_misses.csv`、`_outside.csv`、`_hitmiss_summary.json`。
- 用途：逐件查漏網的原因，是缺少某類要素、來源資料錯誤或缺值（錯日、非官方、未回補），還是其他變數（大盤、題材、新聞）。
  查出的原因直接決定下一輪是補變數、修資料，還是不處理，據此迭代重訓。

## 10. 第二大腦官方鏡像（second-brain/official）

**依據**：使用者 2026-10-04「官網能下載的都下載補入第二大腦，交易日盤後自動更新」。盤點 `docs/OFFICIAL-DATA-INVENTORY-2026-10-04.md`（297 項）。

- **存放**：`second-brain/official/{host}/{dataset}/{鍵}.json.gz`（`{meta, payload}`，payload＝官方原始回應不改欄位）或 `{鍵}.{html|csv|txt}.gz`（原始位元組）；
  每個資料集一份 `_manifest.json`（鍵→狀態／檔名／回聲日／列數／sha256／是否定版）；全域 `manifest.json`、`_runs/`、`_alerts/LATEST.json`、`_verify.json`。
- **鍵**：帶日期＝資料日；月表＝`YYYY-MM`；季財報＝`YYYYQn.sii|otc`；快照＝資料所屬交易日（**非交易日記為最後交易日**；同日內容變了存 `.r2`）。
- **定版**：回聲相符才寫；已確認交易日的必有表（T86、資券、漲跌停價…）回空表不定版；當月表每晚覆蓋、月底過後才定版；月營收 t21sc03 次月 12 日起定版；季財報各業最晚期限翌日定版；
  已有好資料時，之後的失敗／空表／不符**不覆蓋**（只記 lastTry）。
- **交易日**：確認＝研究面板日 ∪ MI_INDEX 回聲 ok；候選＝之後的平日扣官方休市表（「開始／最後交易日」是交易日）。漏跑的交易日由 daily 的補漏、retry、backfill 補；P1 必有表仍缺或交易日未確認 ⇒ `_alerts`。
- **指令**（主 checkout 執行）：`node scripts/official-mirror.mjs daily|retry|backfill|verify|migrate|status`。新端點先 `verify` 通過（`_verify.json`）才排進 daily／backfill。
- **排程**（`scripts/official-mirror/launchd/`）：平日 22:15＋週六 10:00 `daily`；週二～六 06:45 `retry`；每晚 23:20＋週末 11:00 `backfill --max 2500`（每個台北日合計上限）。
- **安全**：同一出口 IP 也是 daemon 的出口——證交所系（www／openapi／mops／mopsov）、櫃買系、期交所各一條佇列、逐請求 ≥3 秒；平日 07:30～15:30 不跑；
  403／401／30x／429／封鎖安全頁 ⇒ 立即停整個機構；5xx 退避重試一次；連續 3 次失敗停；研究回補程序在跑 ⇒ 不開跑；daemon 日誌近 30 分鐘有**封鎖／限流訊號**（HTTP 30x／401／403／429、封鎖頁）的機構家族本次不跑（認不出家族 ⇒ 全停），其餘故障字樣（傳輸中斷、逾時、靠快取撐著）只記「降級」照跑（2026-10-08·WP7：舊規則讓上櫃 openapi 大檔常態被切斷擋掉三個機構、停擺三天）；daily／retry 被擋或每日快照沒抓齊 ⇒ 照寫 `_alerts`（`official-mirror.daily` 停擺日列）；
  MIS 一律不打；回補時 23:00～00:59 不碰 MOPS（daemon 重訊輪次、wiki 23:40）。
- **研究快取轉存**：`migrate`（0 請求）把 `.surge-cache/official/*` 與 MOPS t163sb04 搬進鏡像；`backfill` 開頭自動先跑一次。
- **ETF／興櫃官方日 K（AI 停損 A3，2026-10-05）**：`scripts/lib/official-bars.mjs` 只讀鏡像（0 請求）組 chipArchive 同格式日 K；`node scripts/official-bars.mjs status|factors` 看覆蓋、閘門與係數涵蓋。
  2026-10-06 R8（使用者「ok 如建議」）：daemon 停損影子在**盤前刷新**直接讀本機鏡像（`readOfficialBarsAsync`，分段讀、0 次 Firestore 讀寫、0 上游請求），不建 Firestore 歸檔；讀不到或閘門 ①②③ 沒過 ⇒ fail-closed（停損規範 §2A）。
  興櫃每日快照主要在 `daily` 22:40 抓；`retry`（隔日 06:45）在最後一個已確認交易日兩個來源（www `tpex_emerging_latest`、openapi `tpex_oa_tpex_esb_latest_statistics`）都缺時補抓一次（≤2 個請求，回聲日定鍵），
  近 N 個已確認交易日兩個來源都沒有 ⇒ 寫進 `_alerts`（更早的日子已無法補抓，只能揭露；2026-10-05 審查）。`backfill` 不做快照。
  已安裝的 daily 若仍是 22:15（落在 daemon 21:40–22:35 窗，整批略過），平日的興櫃當日行情會缺——要重跑 `scripts/install-official-mirror-schedule.sh`（使用者本人執行）。

## 修A錯B 影響面

- `build.compute_features` 被 T1/T2、隔日漲停、a35 影子名單共用。改特徵來源（例如把 priceEvents 換成 TWT84U 係數）會同時改變三者的母體（斷點排除範圍）和標籤，要三者一起重跑兩窗＋OOT，並在 `docs/EXPERIMENTS.md` 記錄。
- 新欄位一律另開，不改 closeJson、instJson、dayTradeJson 的既有格式。下游很多程式依索引取值。
- 研究端改用官方來源，**不代表**站上 daemon 也跟著改。daemon 的修正（上櫃資券欄位、漲停檔位、外資口徑、借券時間閘、Yahoo 補洞）都要另案取得使用者核可。

## 掃描探針

- 非官方輸入：
  - `rg -n -i "yahoo|cnyes|udn|ctee|ltn|technews|moneydj|dramexchange|news\.google|newsVerdict|newsDaily|newsN|newsPol|intradayArchive|impactPrior|mediaNewsScore|officialEventScore" scripts/surge-lab -g '*.py' -g '*.mjs'`：期望只命中說明字串，以及 a35_compare_site.py 把 newsN／newsPol 設為 0（2026-10-04 基線：a35_compare_site.py:38、96、305、352，a35_compare_test.py:23）。
  - `rg -n "gapFixSource|factorSrc" scripts/surge-lab`：期望有排除邏輯。
- 回聲：在回補腳本裡 `rg -n "stat.*OK" <腳本>`，每一處都要有對應的 date 或 title 比對。
- 母體：`python -c` 讀 `.surge-cache/panel.npz` 的 codes，確認沒有 `^91\d\d$`。
- PIT：月營收可用日 ≥ 次月 11 日；集保可用日 > 首次歸檔日；重訊依發言時間切 21:45；任何欄位的可用日 ≥ 首次公開時間（第 5 節通則）；
  標籤期（s+1 以後）的欄位不出現在特徵矩陣。
- wiki 欄位：`rg -n "stocks\.json|second-brain|productGeo|crossIndustries|derived(Up|Down)streamAi|corporateHolders|holdsBoardSeatIn|themeMap" scripts/surge-lab -g '*.py' -g '*.mjs'`。期望主模型路徑（build.py、panel.py、build_lu1.py、a35_shadow_lib.py）零命中；集團欄只出現在實驗組，AI 層欄位在任何回測都不出現（第 8 節）。
  2026-10-04 基線：只命中 official_features.py:15、242、243（`wiki_map` 讀 `industry`、`group`）。這支的欄位名是用字串參數傳入，
  上面的 regex 抓不到，要另外 `rg -n "wiki_map\(" scripts/surge-lab` 確認只讀 `industry` 與 `group`，且 `group` 只進 `EXPERIMENTAL`。
- 回測記錄：每份回測報告都要對應 `scripts/surge-lab/out/` 下的 hits、misses、outside、summary 四份檔（第 9 節）。
- 週更：用 `node scripts/check-source-registry.mjs` 確認沒有未登錄網域；新增官方端點時同步更新第 2 節總表。
