# T1 分軌前向影子：前向偏差紀錄（只增不改）

登錄：`T1-TRACKS-FWD-2026-10-05` v1（JSON 正規化 sha256 `ec1a0bf87b6643bbff37b59ca346bd1746f7d500dbc402a02222343450fcae26`）。
本檔依登錄 `seal.deviation_log` 在第一筆前向偏差發生時建立，只增不改。每筆寫：日期、階段、內容、理由、當下已看過哪些前向結果、對判定的可能影響。
改動任何釘選檔（`implementation_pins`）時，另起一行 `PIN-UPDATE: <scripts/surge-lab/檔名> <新 sha256>`（`a36_tracks_fwd_rules.check_pins` 讀這種行）；本次接線**沒有改任何釘選檔**，所以沒有 PIN-UPDATE 列。

---

## FDEV-001　處置／注意的鏡像來源：改用與 v2 研究檔同一組「帶日期」的區間端點

- **日期／階段**：2026-10-05，接線（分支 `claude/tracks-fwd-shadow`），任何前向凍結之前。
- **登錄寫法**：`data_sources.disposal`＝v2 釘住檔 ∪ 鏡像 `twse_oa_announcement_punish`、`tpex_oa_tpex_disposal_information`；`data_sources.attention`＝v2 釘住檔 ∪ 鏡像 `twse_oa_announcement_notice`、`tpex_bulletin_warning`。
- **實作**：v2 釘住檔（`base/`，到 2026-10-02）∪ 鏡像**帶日期**資料集 `www.twse.com.tw/twse_punish`、`www.twse.com.tw/twse_notice`、`www.tpex.org.tw/tpex_bulletin_disposal`、`www.tpex.org.tw/tpex_bulletin_attention`（`scripts/official-mirror/adapters-dated.mjs`，起訖同日的區間查詢）。只收 manifest `status` 為 ok／empty、`echo`＝鍵、`final`≠false 的列；欄位清單必須與 v2 釘住檔逐字相同，不同就整個來源不收並記警示（`a37_tracks_sync.merge_disp_att`）；完全相同的列去重；口徑仍是 `disposal.load_intervals`／`attention.load_rows`。
- **理由**：
  1. 這四個帶日期資料集就是產生 v2 研究檔的同一組官方端點（`fetch_disposal.mjs`、`fetch_attention.mjs` 以月為區間查同一支），欄位逐字相同、能逐筆比對；openapi 快照的欄位不同（例如 TPEx 處置期間 `1151002~1151008` 沒有斜線、沒有「累計」）。
  2. `tpex_bulletin_warning` 的內容是「公布注意累計次數可能達處置標準之有價證券」，**不是注意股公告**（2026-10-02 鏡像實檔：欄位只有編號／代號／名稱／「近期達標準之情形」）；照字面使用會把非注意股算成注意股。
  3. openapi 的 notice／punish 是「當下」快照（openapi 整批落後一日；2026-10-04 週日抓到的 notice 是空表），無法判斷「某一天確定沒有公告」；帶日期資料集的定版空表可以，前向的涵蓋判斷（FDEV-002）需要這個。
- **與 v2 釘住檔的重疊比對**（登錄 `adapter_parity_before_first_freeze`）：截至 2026-10-05，這四個帶日期資料集在鏡像中**還沒有任何一天**（回補排程尚未補到），重疊期間（≤ 2026-10-02）沒有可比的列 ⇒ 接線前證明記為 `pending`（`out/tracks_fwd/tracks_fwd_prewire.json` 的 `disp_att_overlap`）。凍結閘門允許 `pending`（本偏差即「先寫前向偏差」），但 `fail` 會擋凍結。鏡像回補到重疊期間後重跑 `python3 a37_tracks_fwd.py prewire` 會自動比對；比對不同就要再寫一筆偏差並由使用者裁定。
- **當下已看過的前向結果**：無（沒有任何前向凍結、標籤或報酬）。
- **對判定的可能影響**：只影響描述欄（DK_s、dp_*、at_known5／20、處置／注意徽章、R 的 Qmax）；四份代理清單的池與名次不用這些欄位，判定量（Δprecision 對 RAND）不受影響。

---

## FDEV-002　前向更嚴的「處置／注意未知」規則（只會把值變成未知，不會改變任何池或名單）

- **日期／階段**：同 FDEV-001。
- **登錄寫法**：v2 `coverage_rule`——注意股逐交易日零筆 ⇒ NaN；處置以「月」為單位零筆 ⇒ NaN，且含面板最後一日的當月不檢查（DEV-002）。
- **問題**：前向時「當月」永遠不完整，鏡像停更或回補落後時，處置月規則抓不到 ⇒ DK_s 會被算成 0（「非處置」），等於捏造預設值。
- **實作**（`a37_tracks_core.strict_unknown`）：在 v2 規則之外再加一條——決策日 s 的 [s−20, s−1] 內，任何一個 2026-10-02（v2 釘住檔終點）之後的交易日，若該市場的鏡像帶日期資料集沒有定版列（ok 或定版空表），該市場（含市場別不明的列）的 DK_s、dp_*、at_known5／20 記 NaN，標「處置狀態未知（來源缺漏）」；R 的 Qmax 隨之未知（`L.qmax` 以修正後的 DK_s 重算）。
- **當下已看過的前向結果**：無。
- **對判定的可能影響**：無（只把值改成未知；登錄 P5「不得以 0 填補」因此在鏡像缺漏時仍成立）。

---

## FDEV-003　接線實作細節（不改變任何清單、判定規則或門檻）

- **日期／階段**：同 FDEV-001。程式：`a37_tracks_{fwd_io,sync,core,score,fwd}.py`、`a37_tracks_basis.mjs`、`a37_tracks_publish.mjs`、`scripts/lib/surge-tracks-{daily,report}.mjs`、協調器 `a35_shadow_daily.mjs` 的 ⑦b 步驟（皆不在釘選清單，登錄 `implementation_pins.not_pinned`）。
- **內容**：
  1. **截斷**：每個決策日把面板、官方漲停價、處置與注意公告截到 ≤ s，再呼叫釘選的 `a36_tracks_lib.compute_all(with_features=False)`（同 G0.6 截斷測試的 pit 變體；除權息／減資只用生效日 ≤ s）；上市日 v3 只在這次計算範圍內替換（同 `a36_tracks_fwd_verify.v3_patches`）；代理與排名用 `a36_tracks_proxy`（registered 模式）。
  2. **列範圍**：`compute_all` 在截斷面板上的列範圍＝s 日有收盤的列（池只含這些列）；登錄 D_fwd 多出的「近 250 日有收盤、s 日停牌」列只作 NE_SUSP 描述（`ne_susp_fwd`），不入任何池（DEV-002 第 4 點已記載的性質）。
  3. **官方漲停價**以參數傳入 `compute_all(limits=…)`，不設 `SURGE_OFFICIAL_LIMIT`；前向快取逐日解析、以代號字串對齊當前面板（新上市讓欄位位移也不會錯），與 `official_features.load_matrices` 全量重建**逐位相同**（接線前證明 `limits_incremental`＝pass，1024×2020）。
  4. **除權息**：`build.load_factor_events`（exright-history＋exright_delta＋priceEvents）再以 `surge_inputs.merge_extra_exright` 併入 a35 每日補抓（`a35_shadow_exright_{日}.json`，兩市）；C3 要求 (exright-history.to, s] 每個交易日都有兩市成功的補抓檔。
  5. **C1**：收盤＋法人兩市到齊、無第三方（Yahoo）補洞——以共用快取 `chipArchive.json.gz` 走 `a35_shadow_meta.basisOf`（與 daemon 定版閘門同一支）；另要 s 日收盤上市 ≥ 800、上櫃 ≥ 500 檔。**C2**：前向快取有 TWT84U(s) 與 dailyQuotes(s 的前一面板日)。協調器另以鏡像 manifest 預先判斷（`surge-tracks-daily.mirrorLimitStatus`）。
  6. **期限**：下一交易日 09:00（協調器規劃與 python 端各一道；python 計算前後各檢一次時鐘）；過期 ⇒ 缺口記錄（封印、只寫一次，含最後一次等待時未齊的條件與期限前被研究程序擋下的時段）。
  7. **到期**：以「現在的」休市日曆推 t、t＋1；面板第 s＋i 列必須正好是日曆上的那一天，否則等待；t＋1 之後再過 10 個交易日仍不齊 ⇒ `label_unavailable`（c5／c10 同理記 `unavailable`）。到期當下的出場分類只會是 OK／NOCLOSE_UNRESOLVED（之後重分類另檔、只增不改）。
  8. **parity（P3）**：y 到期時以當下輸入重算 core 並比對；輸入摘要（面板 C/V/O/H/L、官方漲停價、除權息、處置、注意、上市快照，依凍結時的代號清單對齊）不同 ⇒ `data_correction`，相同卻不同 ⇒ `fail`。
  9. **後台文件不含任何報酬**（S0／S_FB／M0 卡片也一樣，依登錄 `presentation.returns_display`）；報酬只在本機研究記錄 `out/tracks_fwd/`（CSV 與評分檔），未扣成本。
- **驗證**：接線前證明（`out/tracks_fwd/tracks_fwd_prewire.json`，封印 `fc02f71e3ade243849d69f8225b860e2f928437d12a9b814f166f6837cefe425`；listing／limits_incremental／research_path＝pass，disp_att_overlap＝pending（FDEV-001），m0_fingerprint＝pending（FDEV-004））研究路徑 parity 7 個歷史交易日（2026-09-17、09-18、09-21、09-22、09-23、2026-03-16、2025-06-16）對 T2（G1 第 4 項修正後）軌道檔與 `fwdprep` 前向四份代理清單選股：軌道歸屬（s 日有收盤的列）、四個池的列數、各清單成員與名次**全部相同**；分數差只來自研究 CSV 的 6 位小數捨入（最大相對差 1.6e-5）。另在演練目錄把 2026-09-22、09-23、09-24 以「當時時刻」凍結再評分：y、可買、開盤鎖死、t 日起處置、c5、出場分類與 `fwdprep` 研究記錄逐列相同（S_FB 一筆不可買選股的出場分類，研究 CSV 記空值、前向記 NA，同義）。
- **當下已看過的前向結果**：無（演練用的是 2026-09 的歷史日，屬 v2 HC 視窗，已污染、只作流程驗證）。
- **對判定的可能影響**：無。

---

## FDEV-004　M0@10／M0@20 參照（m0ref）本次不接線（第二期）

- **日期／階段**：同 FDEV-001。
- **內容**：本次接線只產生 core（S0、S_FB、R0、W＋RAND）。m0ref 需要：凍結模型（指紋 `80ec0f8e…`）在接線環境重擬並重現指紋（M2）、M0 的 162 個 official 特徵每日全面板計算（約 51 秒、峰值約 4.2 GB）、7 個官方日資料集＋MOPS 財報＋月營收（`revenue_official` 前向重建與另外兩個營收背景任務有衝突風險）到齊（M1）。這些都還沒做，所以每個前向決策日的 m0ref 一律是缺口：core 凍結檔內記 `m0ref.status＝not-wired、gap＝true`，摘要記 `n_m0ref_gaps`；後台 M0 區顯示「尚未接線」。等名額對照（M0@10＋R0＋S0 對 M0@20）在 m0ref 接線前無法計算（登錄：只用 core 與 m0ref 都有凍結的日子）。
- **理由**：登錄 `missing_data`：「m0ref 條件不成立 ⇒ m0ref 記缺口；core 照常」；`m0_forward.frozen`：指紋未核對不得凍結 m0ref。
- **當下已看過的前向結果**：無。
- **對判定的可能影響**：無（M0 只作參照與描述，不參與任何判定；S0 的主要檢定與 S_FB、R0 的判定都不依賴 M0）。

*影子模式·未扣成本·非投資建議。*
