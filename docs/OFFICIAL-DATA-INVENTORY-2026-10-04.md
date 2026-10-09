# 官方網站可下載資料盤點與第二大腦鏡像計畫（2026-10-04，含審查修訂）

> 機器可讀清單：`official_inventory.json`（同目錄，297 筆，每筆含 `plan`、`priority`、`schedule`、`requestsPerRun`、`backfillRequests`、`storage`；審查新增的條目帶 `addedBy`）。
> 初稿沒有發出網路請求；審查輪發了 3 個 GET（見文末「審查修訂紀錄」），其餘根據既有實測、本機 swagger 目錄（twse 143 路徑、tpex 225 路徑，兩份目錄的路徑已全部對應到條目）和 repo 程式碼整理。文中標「未驗證」的地方都要先實測才能定案。

## 一、總覽

初稿輸入 285 筆，其中 6 筆跟其他條目是同一份資料，已經併入較完整的那筆（`mergedFrom` 欄有記錄），剩 279 筆；審查補進 18 筆缺漏，共 **297 筆**。

- `tpex_cmode` 併入 `tpex_oa_cmode`
- `twse_twt48u` 併入 `twse_oa_TWT48U_ALL`
- `twse_holiday` 併入 `twse_oa_holidaySchedule`
- `twse_bfi84u` 併入 `twse_oa_BFI84U`
- `twse_twt88u_twtbau` 併入 `twse_oa_TWT88U`（TWTBAU1、TWTBAU2 本來就各有條目）
- `mops_insider_transfer` 併入 `twse_oa_t187ap12_L`（上櫃那半是 `tpex_oa_insider_transfer`）

### 依計畫分類

| plan | 筆數 | 意思 |
|---|---:|---|
| backfill+daily | 46 | 有日期參數、查得到歷史：先回補，之後每個交易日抓一次 |
| daily-snapshot | 74 | 只有最新一期：每個交易日存一份，內容沒變就不另存 |
| weekly-snapshot | 9 | 每週六抓一次 |
| monthly | 46 | 每月抓一次（年表也歸這類，內容沒變就不存） |
| quarterly | 20 | 財報季的期限窗內抓 |
| already-covered | 11 | 已經在別處存了，條目裡有寫在哪 |
| **verify-first** | 17 | 有價值但端點、參數或身分未驗證：非交易日白天各打 1 次確認後再定 plan（審查新增分類，原本混在 skip 裡） |
| **needs-registry** | 2 | 主機不在 `source-registry.json` 的 official 清單（isin.twse、openapi.taifex）：先登錄並取得使用者裁定 |
| **not-automatable** | 1 | 有驗證碼（分點券商明細），不排程、不繞過 |
| skip | 71 | 重複、可以自己算、範圍外、官方沒有端點（記錄缺口） |

優先序：P1 52 筆、P2 84 筆、P3 161 筆。

### 依主機 × 計畫

| 主機 | 筆數 | backfill+daily | daily | weekly | monthly | quarterly | 已有 | verify-first | 其他 | skip |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| openapi.twse.com.tw | 123 | 0 | 39 | 6 | 32 | 14 | 1 | 1 | 0 | 30 |
| www.tpex.org.tw（含 openapi/v1） | 101 | 14 | 31 | 3 | 13 | 3 | 3 | 2 | 0 | 32 |
| www.twse.com.tw（rwd） | 36 | 22 | 3 | 0 | 0 | 0 | 1 | 6 | 0 | 4 |
| www.taifex.com.tw | 13 | 8 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 4 |
| mopsov.twse.com.tw | 12 | 2 | 0 | 0 | 0 | 3 | 0 | 6 | 0 | 1 |
| mops.twse.com.tw | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 0 | 0 | 0 |
| openapi.tdcc.com.tw | 2 | 0 | 0 | 0 | 0 | 0 | 1 | 1 | 0 | 0 |
| mis.twse.com.tw | 2 | 0 | 1（daemon 共用） | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| ic.tpex.org.tw | 1 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 |
| doc.twse.com.tw | 1 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 |
| isin.twse.com.tw（未登錄） | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 needs-registry | 0 |
| openapi.taifex.com.tw（未登錄） | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 needs-registry | 0 |
| bsr.twse.com.tw（未登錄） | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 1 not-automatable | 0 |

依資料型態（family）：openapi-snapshot 212、dated-report 46、event 20、monthly 9、static 6、quarterly 4。

> 上櫃 openapi 有不少條目把好幾支路徑併成一筆（例如 ESG 16 支、財報 12 支），所以實際端點數比 297 多，請求數以 `requestsPerRun` 為準。
> 初稿對 `mis.twse.com.tw`（registry 核准的官方主機）沒有任何條目，審查補上：即時報價不鏡像（daemon 已自建歸檔），ETF iNAV 由 daemon 共用回應另存。

## 二、價值高但還沒收的資料（P1，依急迫度排序）

標「累積型」的資料官方沒有歷史，**漏抓一天就永久缺**；標「滾動窗」的官方只留近期，**每天往外掉一天**。這兩類要最先上線。

| # | 條目 id | 內容 | 計畫 | 為什麼急 |
|---|---|---|---|---|
| 1 | **taifex_vix**（審查新增） | 臺指選擇權波動率指數（分鐘檔＋每日收盤） | backfill+daily（約 85） | 2026-10-04 實測：線上只有當月＋前 3 個月，滾動窗最短；初稿誤列 skip（「路徑未取得」），路徑已取得：`/cht/7/getVixData?filesname=YYYYMMDD` |
| 2 | taifex_fut_contracts | 期交所三大法人各期貨契約（含股票期貨） | backfill+daily | 線上只留近三年（頁面 JS 限 2023-10-02 起）；「每天往後滾」是推定（未做兩日比對）；daemon 只存一個數字，日期還是用本機日曆 |
| 3 | tpex_oa_broker_hot | 上櫃熱門股券商進出（前 N 檔 × 前 N 大券商） | daily-snapshot | 唯一不用驗證碼的官方分點資料；累積型 |
| 4 | tpex_oa_ceil_non_trading | 上櫃漲停價委買未成交量 | daily-snapshot | 漲停鎖單強度，別處沒有；累積型 |
| 5 | tpex_oa_short_flow ＋ **twse_twtasu**（審查新增，verify-first） | 每日融券賣出與借券賣出的量（兩市） | daily-snapshot／先驗證 | 放空流量（不是餘額）；上櫃累積型。上市 `rwd/zh/marginTrading/TWTASU` 實測 404，正確路徑要先找 |
| 6 | tpex_oa_margin_events（3 支） | 上櫃停券預告、調整成數、標借 | daily-snapshot | 軋空反查需要；累積型。上市對應表未找到（`twse_margin_events_www`，verify-first） |
| 7 | twse_oa_BFI84U | 上市停資停券預告 | daily-snapshot | 停券前的融券強制回補；累積型 |
| 8 | twse_oa_t187ap38_L | 股東會公告（停止過戶起訖、擬配息） | daily-snapshot | 軋空事件與除權息研究；記首見日 |
| 9 | twse_oa_t187ap12_L ＋ tpex_oa_insider_transfer | 內部人轉讓事前申報（上市＋上櫃） | daily-snapshot | 事前賣壓訊號；累積型 |
| 10 | tpex_oa_attention_count、twse_notetrans | 注意累計次數可能達處置（兩市） | daily-snapshot | 可以拿來校驗 a29 規則模擬；累積型 |
| 11 | twse_oa_TWT88U、tpex_oa_ipo_nolimit | 首五日無漲跌幅（兩市） | daily-snapshot | 當沖與隔日沖的排除條件；累積型 |
| 12 | twse_oa_TWTBAU1、tpex_oa_daytrade_suspend | 暫停先賣後買當沖（預告＋歷史） | daily-snapshot | daemon 只寫 latest |
| 13 | tpex_oa_cmode、twse_oa_TWTAWU、tpex_oa_suspend | 變更交易旗標、暫停交易（兩市） | daily-snapshot | 用來分辨「真缺漏」還是停牌（交易日不得缺漏的規定要靠它）；上櫃 history 版的歷史深度**未驗證**，首抓前不可當成已回補 |
| 14 | twse_oa_TWT48U_ALL | 除權息預告全表 | daily-snapshot | daemon 只存前 40 筆 |
| 15 | twse_oa_t187ap45_L、tpex_oa_dividend_board | 股利分派決議（兩市） | daily-snapshot | 股利史與 PIT 首見日 |
| 16 | twse_twt96u | 當日可借券賣出股數 | daily-snapshot | 空方供給；daemon 只存最新 |
| 17 | twse_bwibbu_d | 上市 PE／殖利率／PB（依日期全市場） | backfill+daily（1,023） | 一次請求拿全市場；可以取代 stockPeBand 的逐檔請求 |
| 18 | tpex_pe_qrydate | 上櫃 PE／殖利率／PB（依日期） | backfill+daily（1,023） | 上櫃估值目前完全沒有 |
| 19 | twse_mi_margn、twse_twt93u、tpex_margin_balance、tpex_margin_sbl | 資券與借券**原表全欄** | backfill+daily（各 1,023） | 現在只存 1–2 欄；重抓原表還能修正上櫃 2026-08-11～10-02 的欄位錯置 |
| 20 | twse_twtauu | 減資恢復買賣參考價 | backfill+daily（51） | 讓 priceEvents 改成純官方來源，不再混 Yahoo；事件端另有上市減資預告 `twse_twtavu`（審查新增，verify-first） |
| 21 | twse_twt84u | 上市漲跌停價與參考價 | 由研究快取轉存（0） | **初稿誤記**「2022-07～2024-03 約 400 日能否取得未驗證、另需 400 請求」：exchangeReport 版 2023-01-05 已實測，研究快取 `twse_limit` 正從 2022-07-18 回補，不另開請求 |
| 22 | twse_oa_t187ap11_L、tpex_oa_director_holding | 董監持股與設質明細（兩市） | monthly（16 日後） | wiki 只留現行版；上櫃部分是缺口 |
| 23 | twse_oa_t187ap07_L_ci、mops_t163sb05 | 資產負債表（當期首見日＋歷史 44 請求） | 財報季／quarterly | 研究只有損益表，資產負債表完全空白（sb05 歷史深度未驗證） |
| 24 | mops_t21sc03 | 月營收彙總 | backfill+daily（28） | 補 2022-06～2023-07 的缺口 |
| 25 | ic_tpex_value_chain | 櫃買產業價值鏈 41 條 | monthly（41 頁） | wiki 上下游聯動的骨架；registry 已核准（SKILL 仍記 DNS 待修，接線前再測） |
| 26 | twse_oa_suspendListing | 終止上市清單 | weekly | 修正存活者偏差 |

P1 裡另有 11 筆的歷史在研究快取，回補記 0 請求（T86、MI_QFIIS、MI_INDEX、TWT84U、dailyQuotes、上櫃法人、上櫃當沖，以及兩市注意、處置 4 筆）。**其中 7 個每日資料集的研究回補還沒做完**（初稿寫「已經有歷史」是高估）：2026-10-04 14:44 實測只到 twse_daily／twse_t86 141 日、twse_qfiis 140 日、tpex_daily／tpex_insti 134 日、tpex_daytrade 135 日、twse_limit 7 日（目標都是 1,023 日）。轉存只搬已通過回聲的日子，其餘交給研究回補，**不要把 1,023 當成已有的天數**；注意與處置的 `.surge-cache/attention_*`、`disposal_*` 是 2022-07 起的區間快取（最後日期本輪沒核對）。這些回補不另發請求，只要接上每日更新。

### 審查補進的缺漏（P2／P3 與待驗證）

| 條目 id | 內容 | 計畫 | 說明 |
|---|---|---|---|
| twse_bfiamu | 各類指數日成交量值（類股成交金額） | backfill+daily P2（1,023） | 2026-10-04 實測 `rwd/zh/afterTrading/BFIAMU?date=20230105` 回聲正確；類股資金輪動 |
| tpex_sector_volume | 上櫃類股成交量值 | verify-first P3 | 端點未找到；找不到就自算並標明 |
| twse_twtavu | 上市減資預告 | verify-first P2 | `docs/PRICE-EVENTS-2026-09-17.md:38` 記載存在，參數未驗證 |
| twse_margin_events_www | 上市成數調整／標借／平盤下名單 | verify-first P2 | 上櫃有、上市沒有，兩市不對稱 |
| twse_sbl_trades | 借券系統成交（量、費率） | verify-first P2 | 空方成本；端點未知 |
| twse_announcement | 證交所最新公告 | daily-snapshot P3 | 線上 route 已在讀（trend-analysis/route.ts:29），沒有存檔 |
| twse_ipo_announcements | 公開申購／競價拍賣公告 | verify-first P3 | 新股與現增供給事件；路徑憑記憶 |
| twse_tpex_investor_stats | 投資人類別交易比重、開戶統計 | verify-first P3 | 月度 regime；格式可能是 xls 或 pdf |
| taifex_stock_lists | 股票期貨／選擇權標的清單 | verify-first P3 | 個股期貨代碼對照 |
| mops_xbrl_bulk | 財報 XBRL 整批下載 | verify-first P2 | 唯一可能的**現金流量表**官方彙總來源；路徑與檔案大小未驗證 |
| mis_all_etf | ETF iNAV 與市價 | daily-snapshot P2（0 請求） | daemon 已在抓（ai-daemon.mjs:10836），只存前 10 名；改由 daemon 另存原始回應 |
| mis_realtime | MIS 即時報價、五檔 | already-covered | 從 backup 的 bookDepthArchive／snap0930Archive 轉存，不打 MIS |
| price_event_ref_unavailable | 上櫃減資／面額變更、上市面額變更參考價 | skip（記錄缺口） | 官方端點不存在，用 TWT84U／dailyQuotes 係數法 |
| isin_twse | ISIN 代碼表（含上市日） | needs-registry P2 | 宇宙與上市日；主機未登錄 |
| openapi_taifex | 期交所 OpenAPI | needs-registry P3 | 只當 www 下載頁的後備 |
| broker_branch_detail | 分點券商買賣明細 | not-automatable | 驗證碼；替代是上櫃熱門股券商進出 |

另外 7 筆原本列 skip 的條目改成 verify-first（理由是「端點未驗證」而不是「不需要」）：mops_t05st01_hist、mops_treasury_stock、mops_insider_holding、mops_t05st09_dividend、mops_capital_raise、tdcc_catalog、tpex_odd_block_5min；twse_oa_t187ap10_L 因身分衝突也改 verify-first。

## 三、請求量估算

### 回補（一次性）

| 範圍 | 請求數 |
|---|---:|
| 全部 | **18,429**（含可選的 MI_5MINS 前段 290；不含 verify-first 驗證後才會出現的量，例如 TWTASU 若可帶日期再加 1,023） |
| P1 | 6,382 |
| P2 | 11,743 |
| P3 | 304 |
| www.twse.com.tw | 11,645 |
| www.tpex.org.tw | 6,258 |
| mopsov | 218 |
| taifex | 308 |

大宗是 17 張「每日一張」的表，每張 1,023 個交易日（2022-07-18～2026-10-02，與 SKILL §2.0 的 `panel_dates.json` 一致；初稿寫 1,030 是錯的）。

- 每次間隔 3 秒：純請求時間約 15.4 小時。
- 現在 www.twse／www.tpex 上還有另一個回補在跑，如果比照 ≥5 秒：約 25.6 小時。
- 建議每晚上限 2,500 個請求，大約 8 個晚上做完。順序：**第一晚先做兩個滾動窗（taifex_vix、期交所三大法人）**，再 P1 → P2。

### 例行

| 項目 | 請求數 |
|---|---:|
| 每個交易日（平常） | **約 122**（S-main 45、S6 77） |
| 財報季窗內每日另加 | 28（兩市財報、EPS、營益 openapi） |
| 每週六 | 26 |
| 每月 | 140（其中櫃買價值鏈 41 頁、ESG 37 張） |
| 每季（期限窗內每晚） | 約 40 |

依主機分（交易日平常）：www.tpex 59、www.twse 25、openapi.twse 25、taifex 9、mopsov 4、mis 0（由 daemon 共用）。

122 個請求，各主機單線 ≥3 秒，最慢的 www.tpex 約 3 分鐘，全部在 22:15–22:45 內做完。

另外，MI_MARGN、TWT93U、TWTB4U、T86、上櫃資券、上櫃借券、上櫃日收盤、上櫃法人這 8 張 daemon 每天本來就在抓，ETF iNAV（all_etf.txt）也是。如果讓 daemon 把原始回應同時寫進 official/，每天可以再少約 8 個請求，iNAV 也不必另打 MIS。這要改 daemon，**改之前必須先跑 `can-restart-daemon.mjs`**。

## 四、盤後排程（台北時間，只在交易日跑；非交易日不抓日資料）

**審查更正**：初稿的 S2 16:55 落在 daemon「16:45 起資料到齊班車」、S4 20:50 落在「20:45–21:50 借券與資券班車」內，S3 17:40 是否與到齊班車重疊未驗證（SKILL §4 列的 daemon 班次）。帶日期的端點不需要搶時間，晚抓不影響內容，所以全部集中到 daemon 班次結束後的一個批次。

| 時段 | 內容 | 依據 |
|---|---|---|
| **S-main 22:15** | 所有帶日期端點（`schedule` 為 S-main 的 44 個條目、45 個請求）：上市 MI_INDEX、TWT84U、BWIBBU_d、BFIAMU、BFT41U、TWT53U、MI_5MINS_INDEX、BFIAUU(S)、TWT85U、FMTQIK／MI_5MINS_HIST（當月）、TWTAWU／TWTAUU（當日區間）、T86、MI_QFIIS、BFI82U、MI_MARGN、TWT93U、TWTB4U、兩市注意與處置、TWT49U；上櫃 dailyQuotes、peQryDate、highlight、st41、insti、intraday stat／list、margin balance／sbl、exDailyQ；期交所三大法人、P/C 比、大額交易人、期貨與選擇權日行情、VIX | 最晚的上櫃收盤（偶爾 21:37）、資券（21:45–21:49 寫入）都已到；daemon 借券資券班車 21:50 結束；在 wiki 23:40 MOPS 逐檔之前 |
| **S6 22:30** | 不帶日期的快照（`schedule` 為 S6 的 58 個條目、平常 77 個請求）：openapi 兩市每日快照（財報季另加 28）、TWT96U、notetrans、上櫃 warning、證交所公告；MOPS 法說會（本月）；每月 1–15 日加 t21sc03（sii＋otc） | openapi 多半落後一日，晚上抓比較穩；mopsov 請求要排在 daemon MOPS 兩輪之間（每 30 分、不對齊整點） |
| **S7 次一曆日 06:45** | 補抓失敗或晚到的、處置公告重查；寫完整性稽核 | 要在 07:30 禁跑窗之前結束 |
| 選配 S-pit 19:30 | 只給 P1 累積型事件清單再拍一次快照 | 見下方 PIT 說明；上線前先查 daemon 日誌確認 19:30 前後沒有官方班次（到齊班車何時結束未驗證） |
| 每週六 10:00 | weekly 9 筆；TDCC 1-5 原始 JSON 另存一份（資料日是週五，週六或週日上架） | |
| 每月 | M1：每月第一個非交易日 10:30，靜態與治理類、價值鏈、ESG；M16：16 日後第一個晚上 22:45，董監持股、設質、持股不足 | 董監持股次月 15 日前申報（未驗證） |
| 月營收 | t21sc03 每月 1–15 日每晚抓；**11 日起才定版**（保守口徑） | 法定 10 日前申報 |
| 財報 | t163sb04／05／06 和 openapi 財報表：在 5/1–5/25、8/1–8/25、11/1–11/25、3/1–4/10 每晚抓；在各業最晚期限翌日定版（06-01、09-01、12-01、次年 04-01） | 法定期限 Q1 5/15、Q2 8/14、Q3 11/14、年報 3/31，金融業較晚 |
| verify-first | 非交易日白天，每個端點 1 次 GET，主機間交錯、同主機 ≥5 秒；MOPS 要避開 daemon 重訊輪次 | 有驗證碼就改 not-automatable |

規則：

- **定版看資料不看時鐘**。回聲日期等於目標交易日、兩市都到齊，才寫正式檔，而且只寫一次，重跑不能覆蓋。
- 抓失敗不能定版，交給 S7 補抓。補不到就寫警示檔（交易日不得有缺漏）。
- **非交易日**：openapi 的檔案在假日也會重新產生（t187ap45_L 實測週六出表）。這種情況檔名記成最後一個交易日；內容沒變就不存，有變就存成該交易日的修訂版（`{date}.r2.json.gz`）。
- 空表要跟抓取失敗分開記。例如 openapi notice 在假日只回一列佔位，不能寫成「今天沒有注意股」。
- **PIT（審查補充）**：累積型快照的首見時間就是抓取時間。S6 22:30 抓到的內容晚於 21:45 名單切點，研究端只能用在下一個交易日（SKILL §5 通則）。如果要讓 P1 事件清單能進 s 日名單，才需要選配的 S-pit 19:30；帶日期端點不受抓取時間影響，PIT 看的是官方上架時刻。

## 五、存放結構

```
second-brain/official/
  manifest.json                      # 全域：每個 dataset 的 plan、最後資料日、最後抓取時間、狀態、缺口數
  {host}/{dataset}/
    _manifest.json                   # 這個 dataset 的逐檔紀錄（見下）
    {YYYY-MM-DD}.json.gz             # backfill+daily／daily-snapshot／weekly（日期＝資料日，回聲驗證過）
    {YYYY-MM}.json.gz                # monthly
    {YYYY}Q{n}.json.gz               # quarterly
    {YYYY-MM-DD}.html.gz｜.csv.gz｜.txt.gz  # MOPS 是 big5 HTML、期交所是 CSV／VIX 是 txt，原樣保存不轉碼
```

- `host` 用 URL 實際的主機（例如上櫃 openapi 也放在 `www.tpex.org.tw/`）；`dataset` 用清單裡的 id。每筆的完整路徑寫在 JSON 的 `storage` 欄。
- 每個檔案都是 `{meta, payload}`：
  - `meta`：url（只放範本和參數，不放任何個人資料）、fetchedAt、httpStatus、echoDate、rows、sha256、bytes、source="official"、version
  - `payload`：官方原始回應，**不修改欄位**。
- `_manifest.json` 每一列記 `{date, status: ok|empty|unchanged|fail|gap-warned, sha256, rows, fetchedAt, attempts}`。快照內容沒變時只記一列 `unchanged`，指向上一個檔。
- 所有下載一律 gzip（硬規定）。本機檔案不用分片，1MB 分片的規則只適用於 Firestore 文件。
- 已經在研究快取（`.surge-cache/official/*`、`.surge-cache/attention_*`、`a34_raw`、`exright-history.json`、MOPS t163sb04）和 `second-brain/backup/`（bookDepthArchive、snap0930Archive、orderFlowArchive、tdccArchive 等）的歷史，用一支本機轉存腳本搬進來：0 網路請求，要寫 `meta.migratedFrom`。研究快取沒有 `fetchedAt` 欄（SKILL §2.0），轉存時 fetchedAt 只能填檔案 mtime 並標明。

## 六、節奏與安全

- **跟 daemon 共用同一個 IP**：所有官方主機用同一條全域佇列，請求之間 ≥3 秒；遇到 307、429、5xx 時指數退避（15s → 60s → 5min），同一晚連續 3 次失敗就停掉那個 host。
- **平日 07:30–15:30 不跑**（開盤時段即時報價最優先）；daemon 的 15:10、15:25、16:10、16:30、16:45 起、20:45–21:50 班次也不排。回補只在平日 23:15–06:30 和週末白天跑，每晚上限 2,500 個請求。現在 www.twse／www.tpex 上的回補跑完之前，新的回補不要開。
- **MIS 不打**：第二大腦排程不對 mis.twse.com.tw 發任何請求（3 req/5s 額度由 daemon 獨佔），需要的 MIS 資料一律由 daemon 共用回應或既有歸檔轉存。
- 期交所兩個滾動窗（VIX、三大法人）第一個晚上先做；MOPS 用 ≥3 秒、單執行緒，跟 wiki 23:40 的逐檔 MOPS 錯開。
- 遇到驗證碼的頁面一律不碰，記成「不可自動化」：券商分點明細（除了上櫃熱門股券商進出）、TDCC 官網 qryStock。verify-first 的端點先在非交易日白天打 1 次確認；有驗證碼就改 not-automatable。
- 未登錄主機（isin.twse.com.tw、openapi.taifex.com.tw、bsr.twse.com.tw、www.tdcc.com.tw）在登錄並取得使用者裁定前一律不打。
- 建議做成獨立腳本加 launchd 排程，不放進 daemon，這樣不會因為重啟 daemon 讓觀察點失效。如果真的要併進 daemon，先跑 `can-restart-daemon.mjs`。

## 七、這次整理順帶發現的問題（還沒處理，給後續任務參考）

1. `twse_oa_twtazu_od`（漲跌家數）前輪觀察到出表日期停在 2026-06-05，**但原始回應沒存檔，停更與否未驗證**；首次快照時確認，確認後才寫進技能陷阱清單。
2. `t187ap10_L` 身分衝突：swagger 是「董監持股不足連續 3 個月以上」；CLAUDE.md（2026-08-11 實案）與技能記為「月營收連續不足名單、出表日期停在 2021」。兩邊都沒有存檔的實打回應，首次快照時核對（未驗證）。
3. daemon 對 openapi.twse 打 `t187ap03_O`，但 swagger 裡沒有這條路徑，可能一直靜默失敗；上櫃應該改用 `www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O`。
4. daemon 的 `trackTaifex` 用本機日曆當資料日（違反回聲規則），而且疑似拿的是「當日淨口數」而不是「未平倉淨額」。
5. `backfill-margin-tpex.mjs:39` 只檢查 stat=OK，沒有比對 date。上櫃法人 dailyTrade 在 2026-02-20 前後取的欄位不一樣（口徑漂移）。存原表可以一併解決。
6. daemon 註解說「TPEx 沒有逐檔當沖」，這是錯的：`intraday/stat` 的 tables[1] 就是逐檔。
7. SKILL.md 第 155 行把 MI_5MINS_INDEX 標成「路徑未驗證」，這次已經驗證可用；第 110 行把 TWTAWU 列成 openapi-only，但 rwd 版其實接受日期區間。
8. （審查）本機 `second-brain/backup/tdccArchive` 最新一檔是 2026-09-24（2026-10-04 15:29 檢視，共 8 檔），資料日 10-02 那週還沒進 backup；Firestore 有沒有未驗證。集保斷週就永久缺，要查。
9. （審查）SKILL §4 與記憶仍記「ic.tpex 價值鏈 DNS 待修」，跟本清單 2026-10-04 實測首頁可解析不一致，技能要更新。
10. （審查）技能 §7 寫「上櫃減資／面額變更參考價：TPEx 專屬端點未找到」，但上市減資預告 `TWTAVU` 已記在 `docs/PRICE-EVENTS-2026-09-17.md`，技能 §2.1 沒列，要補。

## 審查修訂紀錄（2026-10-04）

- 本輪網路：3 個 GET，間隔 7 秒（另有 4 次因本機 Python 憑證錯誤在 TLS 階段就失敗、沒有送出 HTTP 請求）。
  - `www.twse.com.tw/rwd/zh/marginTrading/TWTASU?date=20230105` → HTTP 404
  - `www.twse.com.tw/rwd/zh/afterTrading/BFIAMU?date=20230105` → 200，stat=OK，date 與 title 回聲正確
  - `www.taifex.com.tw/cht/7/vixMinNew` → 200，取得 `getVixData?filesname=` 與「前 3 個月」選單
- 初稿備份：`inv_probe/official_inventory.before.json`、`.before.md`；修訂腳本 `inv_probe/apply_review.py`。

## 後續變更（2026-10-09）：期交所 30 日逐筆 `taifex_ticks_30d` 由 skip 改為每日歸檔

> 上方「一、總覽」各表的計數是 2026-10-04 版（skip 71 筆含這一筆），未重算；機器可讀清單的這一筆已改 `plan: rolling-daily`（`changedBy` 有記），`build-registry.mjs` 不讀這個值、快照註冊表不受影響。

- **緣由**：使用者 2026-10-08 裁定「依建議進行」——sara 型態回測要台指期盤中分 K；官方只有前 30 個交易日逐筆檔、沒有更早歷史。原 skip 理由「每日數百 MB」實測不成立：每檔 zip 1.3–2.3MB（CSV 解壓 30–45MB、55–87 萬筆）。
- **端點**：清單 `GET https://www.taifex.com.tw/cht/3/dlFutPrevious30DaysSalesData`（解析 `DailydownloadCSV/Daily_YYYY_MM_DD.zip`）；檔 `GET https://www.taifex.com.tw/file/taifex/Dailydownload/DailydownloadCSV/Daily_YYYY_MM_DD.zip`。選擇權清單（dlOpt…）沒有收。
- **上架與滾動**：交易日 16:37–16:46 上架（zip 內時間戳）。休市日清單會先出現「下一交易日」的檔、只有休市前一晚夜盤（10-09 補假時已有 `Daily_2026_10_12.zip`），佔掉一個位置，最舊的一天提前滾出（08-26 在 10-09 滾出、日盤永久缺）。
- **排程與請求量**：`official-mirror.mjs ticks` 平日 17:10（排程窗 17:00–21:30，避開 daemon 窗、17:30 起漲影子與 18:10 Yahoo 分K）。交易日表到最後收盤日都已歸檔 ⇒ 0 請求；平常清單 1＋日檔 1＝**每日 2 個**；漏跑後補件單輪最多清單 1＋日檔 5。`verify` 2 個（清單＋最新收盤日檔，本機已有就比對 sha256）。不進 `backfill`（沒有歷史可回補）。
- **回聲與同名更新、缺口、存放**：見技能 `tw-official-data-sources` §10。
- **一次性回補**：2026-10-09 已抓 08-27～10-08 共 29 檔到 `second-brain/sara-lab/taifex/ticks-30d/`（sha256 在 `_manifest.json`），`migrate` 0 請求轉入鏡像。
