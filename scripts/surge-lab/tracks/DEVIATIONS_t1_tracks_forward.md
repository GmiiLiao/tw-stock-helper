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

---

## FDEV-005　接線審查後的修正（任何前向凍結之前；不改清單、判定規則或門檻，也沒有改任何釘選檔）

- **日期／階段**：2026-10-05，接線審查（分支 `claude/tracks-fwd-shadow`），總開關仍是 `enabled:false`，沒有任何前向凍結。
- **內容**（程式 `a37_tracks_{fwd,core,score}.py`、`scripts/lib/surge-tracks-{daily,report}.mjs`、`a37_tracks_publish.mjs`、協調器 ⑦b、`scripts/check-tracks-pins.mjs`）：
  1. **接線前證明閘門改回登錄原文**（`data_sources.adapter_parity_before_first_freeze`、`execution_order` 第 2 步）：處置／注意重疊比對**只接受 pass**；
     每一輪 daily 都重算一次（鏡像回補到 ≤ 2026-10-02 就自動落定，第一次落定 pass／fail 另寫封印記錄 `prewire/tracks_fwd_dispatt_overlap_{pass,fail}.json`），
     四個資料集各自至少比到 5 個重疊日才算有證明（否則 pending）；fail 一律擋凍結。pending 只有在 `forward_config.allowDispAttPending`
     帶使用者核可字串（格式 `FDEV-001 … 使用者核可 … YYYY-MM-DD`）時放行，該字串寫進每份 core。
     證明另綁定正式環境：`cache`、`official_root`（realpath）要等於本次執行的前向快取與鏡像，`code_sha256`（`a37_tracks_fwd_io／sync／core.py`）要等於現在的程式；
     不符就要在主 checkout 重跑 `python3 a37_tracks_fwd.py prewire`（演練只記 `rehearsal_binding`，不擋）。證明與全部前向紀錄不進版控（重跑不弄髒主 checkout）。
  2. **C1b**（補上 FDEV-003 第 5 點寫了但沒做的檢查）：凍結所用的面板第 s 列，上市有收盤 ≥ 800 檔、上櫃 ≥ 500 檔（市場別以上市快照為先），不到就等待、期限後成缺口。
  3. **C2b**：官方漲停價在 s 日有收盤的列中，兩市覆蓋率各自 ≥ 95%（2025-08～2026-10 實測最低 99.65%），擋住「鏡像格式漂移、解析出 0 列、整天無聲退回檔位推算」；
     core 記 `official_limit_coverage`（分市場 n_official／n_tick_fallback），y 評分檔記 t、t＋1 的同一組數字（登錄 missing_data「逐日揭露件數」）；y 到期也要過同一道覆蓋率。
  4. **C6**：分區 assertion 失敗當日直接寫缺口（理由「分區 assertion 失敗」），不再當成等待重試（登錄 `daily_assertion`）。
  5. **t 日起處置（m_disp_t_exec）不再捏造 0**：DISP[t] 取決於公告日在 [s−20, s] 的處置公告（實測起日＝公告次一交易日、處置期最長 12 個交易日）；
     其中 2026-10-02 之後的交易日，該市場鏡像帶日期處置資料集沒有定版列 ⇒ 該市場（含市場別不明）記 null＋旗標 `DTNA`
     （「t 日起處置狀態未知（鏡像處置公告缺漏；不當成未處置）」；釘選的 `FR.pick_flag_codes` 沒有這一碼，前向在它的 DISP_T 位置插入）。
     摘要拿掉 `fillna(0)`，逐日揭露另加 `n_disp_t_unknown`；後台卡片顯示「t 日起處置未知」。
  6. **記錄欄位補齊登錄 `records_outputs`**：core 另凍結 domain 列的四個代理特徵、DK_s、at_known5；y 評分的每個 T1 事件列帶凍結的池內分數、
     四個特徵、DK_s、旗標、m_has_open_t、m_disp_t_exec、m_c1；c5／c10 評分另記每個事件的 m_c5／m_c10（events_outcome；只在本機與逐位副本，後台文件不帶）；
     選股 CSV 加 flags／flags_text、四個特徵，`days_since_lu`／`dp_since` 前向 core 不計算（with_features=False，四份代理清單不使用）⇒ 依 `pick_columns_new` 寫 NaN＋`*_state＝unknown`＋說明，不省略。
  7. **G 判定機械化對齊登錄**：每個 G 用自己固定的窗（前 60／250／500 個評分日；舊版在 ≥ 250 日時把 G60 也算成 250 日窗）；
     G60 結果 CONTINUE／HALT-FOR-REVIEW（P1～P8 任一沒過或無法判定、或 S0／S_FB 崩壞 ⇒ HALT）；HALT 時 G250 輸出 null＋「G250 暫停」，
     直到前向偏差紀錄有使用者裁定列 `G60-RULING: CONTINUE …`；G500 只對 G250 判 EXTEND 的清單（R0 的 CONFIRM＝UPGRADE、DROP＝維持灰底）。
     P1 由日曆機械計算：[startDay, 今天] 中期限已過的交易日，沒有 core 也沒有缺口的逐日列出、缺口比例 ≤ 20%；
     「整天沒歸檔、之後有歸檔」的疑似臨時休市超過 5 個交易日仍未被日曆確認 ⇒ 寫缺口（不再永遠停在 suspected）。P4 另算 C6 缺口、P7 另算 C7 缺口。
  8. **07:05 不再為「今天」抓除權息**：到期評分只在到期日 < 今天、或到期日當天收盤＋法人已到齊時才觸發面板刷新與除權息補抓（`pendingScores` 的 actionable）；
     除權息補抓上限日不含尚未到齊的日子（`tracksUptoDays`）。
  9. **封印記錄的逐位副本（G60 P2）**：發佈時把每份封印記錄（core、評分、parity、缺口、接線前證明與重疊比對記錄）的原檔位元組 gzip 後寫成
     `surgeShadow/tracks-raw-*`（Firestore Bytes；> 800 KB 分片；kind `t1-tracks-raw`，後台 API 不讀），寫入後讀回、解壓、比 sha256，相符才記進
     `.published_raw_verify.json`；索引帶 `rawArchive`（全部相符才 ok）；已發佈的副本內容不同或本機消失 ⇒ 中止。本機目錄遺失時
     `node a37_tracks_publish.mjs --restore` 從副本補回（驗 sha256、只補不存在的檔、不覆寫）。副本含評分檔的 m_ 報酬欄，只是不透明的 gzip 位元組、介面不顯示。
  10. **釘選檔防呆**：pre-commit 新增 `scripts/check-tracks-pins.mjs`——commit 觸及 `implementation_pins` 任一檔時，staged 內容 sha256 必須等於登錄值或本檔有對應
      `PIN-UPDATE` 列，否則擋下；協調器在分軌步驟後依狀態檔寫 `out/tracks_fwd/_alerts/LATEST.json`，釘選不符（C7）、接線前證明不成立、新缺口、C6、程式失敗
      都記成 `tracks-health` 步驟失敗（a35 狀態檔與後台管線頁可見），鏡像落後記 warn；後台分軌頁頂端顯示告警。`CLAUDE.md` 寫明這 17 個檔被釘選到約 2027-10。
- **驗證**：`python3 a37_tracks_fwd_test.py`（19 項）、`node --test scripts/lib/surge-tracks-{daily,report}.test.mjs scripts/lib/tracks-pins.test.mjs scripts/surge-lab/a37_tracks_publish.test.mjs`；
  演練目錄重跑 2026-09-22／23／24 與 10-02（研究路徑 parity 與評分結果見 commit 訊息）。
- **當下已看過的前向結果**：無（演練用的是已污染的 2026-09 歷史日）。
- **對判定的可能影響**：無（清單、排名、RAND、判定規則與門檻都沒改；C1b／C2b／C6 與證明綁定只會讓不完整的日子變成缺口，這正是登錄的規定）。

---

## FDEV-006　前向偏差紀錄的更正（只增不改）與延後事項

- **日期／階段**：同 FDEV-005。
- **更正**：
  1. **FDEV-001 的事實描述**：原文寫四個帶日期資料集「還沒有任何一天（回補排程尚未補到）」。實況是 `second-brain/official/` 下 `www.twse.com.tw/twse_punish`、`twse_notice`、
     `www.tpex.org.tw/tpex_bulletin_disposal`、`tpex_bulletin_attention` **連目錄與 `_manifest.json` 都沒有**——`scripts/official-mirror/adapters-dated.mjs` 有這四個 adapter，
     但從未產出（已安裝的每日排程 22:15 落在 `DAEMON_BUSY_WINDOWS` 21:40–22:35 內，回補也還沒排到）。FDEV-001「凍結閘門允許 pending」是實作者自行決定的例外，
     **撤回**：改為 FDEV-005 第 1 點（只接受 pass；例外要使用者核可）。
  2. **FDEV-003 第 5 點**寫「另要 s 日收盤上市 ≥ 800、上櫃 ≥ 500 檔」，當時程式只有常數、沒有檢查；已由 FDEV-005 第 2 點補上。
  3. **FDEV-003 第 9 點**「報酬只在本機研究記錄」：FDEV-005 第 9 點起，評分檔另有 Firestore 逐位副本（不透明 gzip，後台 API 與介面都不讀）；介面仍不顯示任何報酬。
  4. **FDEV-003 的驗證段**：已 commit 的接線前證明（封印 `fc02f71e…`）是 21:25:06 在 worktree 快取上做的，早於 21:27:17 改變 `limits_parsed` 存檔格式的 commit `2e92578`，
     也不是正式環境；它只留作歷史證據（`out/tracks_fwd/prewire/tracks_fwd_prewire_20261005T212506.json`），閘門不認。啟用前必須在主 checkout 重跑。
- **延後事項**（G60 評估之前要補，在那之前不影響任何凍結或評分）：
  1. 登錄 `maturity_and_scoring.write_once` 的「上游官方資料事後修正 ⇒ 另附更正記錄（舊值、新值、來源、時間），指標用第一次記錄並揭露更正件數」：目前只有 core 層級的 parity
     （`data_correction` 歸因），評分記錄層級的更正記錄尚未實作。
  2. 登錄 `exit_flags`：G60／G250 評估時以評估日為記錄時點另附出場重分類（NOCLOSE_HALT／ILLIQ／UNRESOLVED，只增不改）尚未實作；到期當下的分類照常寫。
  3. m0ref（FDEV-004）照舊未接線。
  4. 官方鏡像每日排程若照範本重裝到 22:40，會與起漲影子 22:40 那一班同時打 TWSE（同一出口 IP），而 TWT84U(s) 只能靠鏡像那一輪產生——分軌凍結實際只剩 23:50 與 07:05 兩次機會。
     LaunchAgent 排程屬持久設定、要使用者核可，本次不改；建議擇一：鏡像改 22:50 之後（例如 23:05，仍在 23:20 回補之前），或起漲影子 22:40 改 23:10。
- **當下已看過的前向結果**：無。**對判定的可能影響**：無。

*影子模式·未扣成本·非投資建議。*

---

## FDEV-007　處置／注意重疊比對是比對程式錯誤（不是資料不同）；前向處置未知規則補 s／t 當天；封印決定的取代規則

- **日期／階段**：2026-10-05 夜間，主 checkout 22:47 那一輪接線前證明之後（分支 `claude/tracks-fwd-dispatt`）；總開關仍是 `enabled:false`，沒有任何前向凍結、標籤或報酬。
- **觸發**：正式環境的接線前證明 `out/tracks_fwd/prewire/tracks_fwd_prewire_20261005T224747.json`（封印 `fa0da7c505e01ead98737c579876ac7c29b2d564c0cdfb18a733449b10d780e4`，
  檔案 sha256 `0a111a1fe086decb3158d0056f57d97f478c972ea24d5073eff585c360ab5428`，寫一次）記 `disp_att_overlap＝fail`：四個資料集各比 29 個鏡像日（2026-08-21～10-02），
  不同的天數 處置上市 29、處置上櫃 29、注意上市 29、注意上櫃 26，共同欄位相同、只是列集合不同。
- **診斷（逐筆讀鏡像原檔與 `base/` 釘住檔，四個資料集都查過）**：
  1. **處置端點的 startDate／endDate 是「處置期間」的重疊查詢，不是公布日**：鏡像 `twse_punish` 鍵 2026-09-15（10-05 抓）回 4 列，公布日 09-04／09-08／09-11／09-14，
     處置期間全部含 09-15，沒有一列是 09-15 公布；上櫃回應標題直寫「處置期間為 115/08/28 ~ 115/08/28」；釘住檔第一列（2022-07 那個月的查詢）是 111/06/28 公布、
     處置 06/29～07/12，同一語意。⇒ 鏡像鍵 D 的處置列＝處置期間含 D 的處置；**D 當天公布、次一交易日起處置的那筆不在 D，要到起日才出現**。
     注意端點才是「公告日期」落在查詢區間。第一版比對把釘住列依「公布日期」分組去對鏡像鍵——處置兩個資料集即使排除下列欄位也是 0／29 天相同。
  2. **查詢區間相依的欄位**：「編號」＝本次結果內的序號；上市處置「累計」與上市注意「累計次數」＝本次結果內該代號的列數（鏡像 155／155、516／516 列吻合）；
     上櫃處置「累計」也隨查詢區間變（同一筆 3362 先進光處置：逐日查 2、逐月查 7）；上櫃注意「累計」與查詢區間無關（只排除「編號」就 29／29 天相同，所以照比）。
     研究口徑都不讀這幾欄（`disposal.load_intervals` 的區間與 KNOWN、`attention.pit_features` 的 at_cnt5／at_cnt20）。
  3. **正確對日＋排除上列欄位後，四個資料集 29／29 天逐列完全相同**（處置上市 146 列、上櫃 482 列、注意上市 483 列、上櫃 611 列）。⇒ 是比對錯誤，資料一致。
  4. **推導層**（前向實際用的值）：把釘住檔截到 2026-08-20 當 base，鏡像 08-21 起依前向合併規則（`a37_tracks_sync.merge_disp_att`）逐日加入、決策日 s 只收 ≤ s 的鏡像日
     （t 日起處置收到 t＋1），套前向截斷與未知規則：DK_s、at_known5、at_known20 共 29 個決策日、t 日起處置 28 個決策日（面板 2,020 檔）與釘住檔推出的值逐檔相同，0 個未知格。
- **同時發現的前向實作錯誤（不只是比對）**：FDEV-002 的處置未知規則只看 [s−20, s−1]、FDEV-005 的 t 日起處置只看 [s−20, s]，前提是「鏡像鍵＝公布日」。
  實際鏡像鍵是處置期間 ⇒ s 起處置（s−1 公布）的那筆只出現在 s 以後的鏡像日；凍結時鏡像若缺 s 當天（例如 22:40 那輪失敗、23:10 照常凍結），DK_s 會被算成 0——捏造「非處置」。
  以上面的模擬做「鏡像自 X 日起落後」28 種情境：舊規則有 26 種出現 DK_s 捏造 0（共 67 格，例：X＝2026-08-24 時 2455、5314、5321），t 日起處置同樣 26 種、67 格；新規則 0。
  **修正**（`a37_tracks_core.strict_unknown`／`disp_t_unknown`）：處置看 [s−20, s]（補 s 當天）；t 日起處置另要 t 當天（面板沒有 t 列也記未知）；注意仍看 [s−20, s−1]（實際需要的窗）。
  FDEV-002／FDEV-005 原本的窗照留作保守條件。只會把值變成未知（DKNA／DTNA），不改任何池、名單或排名。
- **修正後的比對**（新檔 `a37_tracks_dispatt.py`，`a37_tracks_fwd.disp_att_overlap` 改呼叫它；加進 `PREWIRE_CODE`，改了就要重跑接線前證明）：
  A 列層——每個鏡像日 D ≤ 2026-10-02，鏡像列（排除查詢區間相依欄）＝釘住檔依上述語意對到 D 的列，欄位清單逐字相同；
  B 推導層——同上第 4 點的模擬：前向有值的格子必須等於釘住值，前向記未知的格子另計；每個欄位至少 5 個決策日全部格子已知才算有證明。
  兩層都過才 pass；任何一層不同＝fail；四個資料集任一不足 5 個鏡像日、或推導層證明不足＝pending（沒有面板時推導層不跑，最多 pending）。
- **封印決定的取代規則**（本筆起生效；取代 FDEV-005 第 1 點「第一次落定另寫 `prewire/tracks_fwd_dispatt_overlap_{pass,fail}.json`」的檔名）：
  1. 重疊比對的封印決定以**比對程式版本**為單位：每版（`a37_tracks_dispatt.py` 的 sha256）第一次落定 pass／fail 寫一次 `prewire/tracks_fwd_dispatt_overlap_<sha256>_<狀態>.json`，
     同版之後不再寫、不覆寫；**本版已封印 fail ⇒ 凍結閘門擋**（改判要另寫前向偏差並換新版比對）。逐位副本 id `tracks-raw-overlap-<sha256>-<狀態>`。
  2. 每一版比對程式都要在本檔登錄一行「OVERLAP-CHECK: a37_tracks_dispatt.py <sha256>」；沒登錄 ⇒ 閘門擋（換版本身就是前向偏差）。測試 `a37_tracks_dispatt_test.py` 也會擋沒登錄的版本。
  3. **舊版比對封印的 fail**（決定檔，或接線前證明 `prewire/tracks_fwd_prewire_*.json` 內的 `disp_att_overlap`），只有在「能證明是比對程式的錯」且本檔有
     「OVERLAP-SUPERSEDE: <out/tracks_fwd 內相對路徑> <封印> <FDEV-編號>」列時，才由新版比對的新決定檔取代；路徑或封印對不上＝沒有取代 ⇒ 閘門擋。
     **舊檔永不刪改**；閘門與狀態檔列出被取代的記錄（`prewire_gate.overlap_decision.superseded`）。
  4. 取代只限比對程式本身的錯誤。資料真的不同時，不得以換版比對規避——照 FDEV-005 寫偏差並由使用者裁定。
- **本筆登錄的列**（閘門讀這兩種行；行首就是關鍵字）：

OVERLAP-CHECK: a37_tracks_dispatt.py 26ad77f5433b1545c06d4609b730a212a936a8549a38e2cf481bf06a9c99cde4
OVERLAP-SUPERSEDE: prewire/tracks_fwd_prewire_20261005T224747.json fa0da7c505e01ead98737c579876ac7c29b2d564c0cdfb18a733449b10d780e4 FDEV-007

- **當下已看過的前向結果**：無（沒有任何前向凍結、標籤或報酬；只讀了 2026-08-21～10-02 的處置／注意公告列，屬 v2 釘住檔已涵蓋的歷史期間）。
- **對判定的可能影響**：無（清單、排名、RAND、判定規則與門檻都沒改；新的未知規則只在鏡像缺 s／t 當天時把 DK_s／t 日起處置記未知）。
- **啟用前仍要做**：本分支合併後在主 checkout 重跑 `python3 a37_tracks_fwd.py prewire`（`a37_tracks_core.py` 改了、`PREWIRE_CODE` 多了 `a37_tracks_dispatt.py`，舊證明閘門不認），
  確認 `disp_att_overlap＝pass` 並寫出本版決定檔；22:47 那份證明保留、由上面的 OVERLAP-SUPERSEDE 列取代。

*影子模式·未扣成本·非投資建議。*

---

## FDEV-007 補記一　重疊比對窗固定、daily 沿用封印決定＋時間預算、取代封印 fail 必須有使用者核可、凍結時缺 s 當天處置鏡像要告警

- **日期／階段**：2026-10-05 深夜（FDEV-007 審查之後、分支 `claude/tracks-fwd-dispatt` 合併前）；總開關仍是 `enabled:false`，沒有任何前向凍結、標籤或報酬；正式 `out/tracks_fwd/` 沒有被寫。
- **為什麼是補記、不是新編號**：FDEV-007 尚未合併進 main，也沒有任何正式封印記錄引用它的文字；FDEV-008 已在另一分支佔用編號並被 commit 雜湊引用。本段只往後追加，修的是 FDEV-007 本身的實作與規則；使用者對 FDEV-007 的裁定一併涵蓋本段。
- **審查發現與修正**：
  1. **比對窗沒有下限（HIGH）**：官方鏡像回補（twse_punish／twse_notice／tpex_bulletin_* 的 from＝2022-07-18，10-05 回補紀錄 pending 27,176）會把列層與推導層的窗一路擴大到 2022。推導層每個決策日都重讀、重合併 (cut, d] 的全部鏡像檔，成本隨天數平方成長，而 daily 在凍結之前跑 ⇒ 會超過協調器 10 分鐘逾時（被終止，不會記成 error），凍結整步做不成、前向日變成永不補產的缺口；而且 2022～2025 任一天的列層差異都會讓 status＝fail 擋凍結。
     **修正**：比對窗固定為 `[OVERLAP_FROM＝2026-08-21, BASE_TO＝2026-10-02]`（FDEV-007 驗過的 29 個交易日），窗外的鏡像日一律不讀；同一次比對內每個鏡像檔只讀一次（`_payload_cache`）；推導層處置區間為空時拒絕比對（`disposal.build_matrices` 對空串列會改讀預設研究快取，不可默默換資料）。
  2. **daily 每輪重算（HIGH）**：封印決定檔另記窗內輸入指紋 `window.fingerprint`（四個資料集窗內 manifest 列、釘住檔 sha256、面板日期／代號／市場別）。daily 若本版比對已封印決定且指紋相同 ⇒ 直接沿用封印結果、不重算；指紋不同才在固定窗內重算，時間預算 240 秒（`DAILY_BUDGET_S`），超過丟 `BudgetExceeded` ⇒ 記 `disp_att_overlap=error`、閘門照擋，評分與摘要照跑。完整重算只在 prewire 或窗內輸入變動時發生。
  3. **取代封印 fail 沒有使用者裁定（MEDIUM）**：FDEV-001 寫明「比對不同就要再寫一筆偏差並由使用者裁定」。取代列改為必須帶合法日期的「使用者核可 YYYY-MM-DD」才算數（與 `allowDispAttPending` 的 APPROVAL_RE、`G60-RULING` 一致），格式：
     `OVERLAP-SUPERSEDE: <out/tracks_fwd 內相對路徑> <封印> <FDEV-編號> 使用者核可 YYYY-MM-DD（說明）`
     **FDEV-007 原本登錄的取代列（沒有核可）從本版起不算數**：使用者裁定前，正式環境重跑 prewire 閘門照擋（訊息「…OVERLAP-SUPERSEDE 列缺『使用者核可 YYYY-MM-DD』」）。使用者核可後，由執行者在本檔末尾**追加**一行（上面任何一行都不改）：
     `OVERLAP-SUPERSEDE: prewire/tracks_fwd_prewire_20261005T224747.json fa0da7c505e01ead98737c579876ac7c29b2d564c0cdfb18a733449b10d780e4 FDEV-007 使用者核可 <日期>`
  4. **凍結時缺 s 當天的處置鏡像沒有告警（MEDIUM）**：DK_s 要 s 當天的鏡像列（FDEV-007），但鏡像落後告警只要求到前一交易日、C4 恆為 ok ⇒ 22:40 那輪若沒抓到 s 當天，23:10 會照常凍結、該市場 DK_s 整個記未知（寫一次）而沒有任何告警。
     **修正**：凍結結果與狀態檔記 `disp_s_missing`（市場與缺的日子），協調器告警 `DISP_S_MISSING`（error 級，tracks-health 步驟失敗）。**C4 語意不改**（要不要等下一輪再凍結屬判定語意，另需前向偏差與使用者核可）。
  5. 閘門對 `disp_att_overlap=error` 改說「重疊比對程式出錯或超過時間預算」（原本誤寫成「比對不同」）。
- **實測**（正式前向快取的 APFS 複本、正式鏡像唯讀、輸出在 scratch）：新版比對四個資料集各 29 天、列層 0 天不同（146／482／483／611 列）；推導層 DK_s、at_known5、at_known20 各 29 個決策日、t 日起處置 28 個決策日，0 格不同、0 格未知 ⇒ pass，耗時 33 秒；之後 daily 沿用封印結果 0.01 秒。合成 338 個鏡像日（回補一年多）、窗外一天內容不同：只讀窗內 21 天、每個鏡像檔只讀一次、判定 pass、0.7 秒；同一份資料把窗下限改到 2000 年，列層就抓到窗外那一天（證明窗外不再影響判定）。
- **本筆登錄的列**：

OVERLAP-CHECK: a37_tracks_dispatt.py 2dee18c7438493fa83b63775886df6ef7a7f991972293dbec0a3c901fdfc18f5

- **當下已看過的前向結果**：無。**對判定的可能影響**：無（清單、排名、RAND、判定規則與門檻、C4 都沒改；改的是比對窗、比對的執行方式、取代規則的核可要求與告警）。
- **啟用前仍要做**：①使用者裁定 FDEV-007（含本補記），並依第 3 點追加核可列；②在主 checkout 重跑 `python3 a37_tracks_fwd.py prewire`（`PREWIRE_CODE` 含 `a37_tracks_dispatt.py`，本版 sha256 變了），確認寫出 `prewire/tracks_fwd_dispatt_overlap_2dee18c7…_pass.json` 且 `prewire_gate.ok=true`。

*影子模式·未扣成本·非投資建議。*

---

## FDEV-008　登錄修訂 v1.1 的指標：HO-BURNED 後 S0／S_FB 改只觀察（灰底），G250 改為升級檢定

- **編號說明**：FDEV-007 保留給分支 `claude/tracks-fwd-dispatt`（處置／注意重疊比對）；本筆在另一個分支同日寫成，合併時依編號排在 FDEV-007 之後，兩筆內容互不相依。
- **日期／階段**：2026-10-05，任何前向決策日之前（`forward_config.json` `enabled:false`、`startDay:null`；正式 `out/tracks_fwd/` 沒有任何 core、缺口、評分或 parity 檔）。
- **依據**：使用者裁定 DEV-013 ⇒ `DEVIATIONS_t1_tracks.md` **DEV-014**：DEV-008 第 1 點、DEV-012、DEV-010 全部計入 v2 §8.2 第 8 點的兩次上限 ⇒ v2 §8.3 **HO-BURNED**。HOLDOUT 不再作任何確認；S 由 S-KEEP-AS-SHADOW 降為 **S-WATCH-ONLY**、S_FB 由 SFB-KEEP-AS-SHADOW 降為 **SFB-WATCH-ONLY**（R0、S0 對 RAND 的 HO 點估計 +0.934pp、+1.114pp > 0，不到 REJECT）；Mp、R、DD、M、W 不變。
- **為什麼另立版本而不是偏差**：v1 規定「清單、判定規則與門檻在第一個決策日之後不得更改（要改就另立登錄）」，v1 兩個檔封存不改。S0／S_FB 的判定、標籤與 G250 的結果名稱屬於清單與判定規則，所以在第一個決策日之前另立封存修訂：
  - `tracks/REGISTRATION_t1_tracks_forward_v1_1.md`＋`tracks/registration_t1_tracks_forward_v1_1.json`
  - **v1.1 JSON 正規化 sha256 `db8e088beb29804b2ae585877944c95da00f7537d16009c4447bc0147f9ca274`**（檔案位元組 `54306ce532c993874ab8747d605c54fa2dde7a6178555f57c6c509e733468313`）；修訂對象 v1 `ec1a0bf87b6643bbff37b59ca346bd1746f7d500dbc402a02222343450fcae26`。
  - 封存 commit `683826e5188ab2499c1e7da6eb464d045be7fa49`（分支 `claude/tracks-ho-burned`，只含這兩個檔）；裁定紀錄 DEV-014 在其前一個 commit `e8d567f`。
- **v1.1 的內容**（其餘全部沿用 v1）：S0、S_FB 改灰底只觀察，標「只觀察（保留驗證期作廢·待前向 G250）」；S0（主要檢定）與 S_FB（探索性）的 G250 由維持檢定改為**升級檢定**（`g250_watch`：點估計 > 0 且 CI 下界 > 0 ⇒ UPGRADE 升為 KEEP-AS-SHADOW；點估計 > 0 ⇒ EXTEND 到 G500；其餘 STAY-WATCH），量、窗、bootstrap 與門檻和 v1 相同、切分逐格相同；R0 升級規則不變；G60（含 S0／S_FB 崩壞檢查）不變。除了前向資料，沒有任何乾淨的時間外證據。
- **實作**（都不在 `implementation_pins`，也不在接線前證明綁定的 `PREWIRE_CODE`）：
  1. 新模組 `a37_tracks_reg.py`：`load_amendment`（先驗 v1，再驗 v1.1 雜湊、registration_id、version、修訂對象＝v1 封存雜湊、釘選摘要＝v1、覆寫範圍；不符 ⇒ SystemExit 拒跑）、`effective_lists`、`apply_to_core`、`gate_roles`、`ref`。
  2. `a37_tracks_fwd.py`：`run_daily` 在 `load_inputs` 之後載入 v1.1（狀態檔記 `registration`）；`freeze_core` 在 `build_core` 之後、封印之前以 `apply_to_core` 換上 v1.1 的 `label`、`list_verdict`、`grey_watch_only` 並加 `entry_verdict`、`g250_role`、`registration_amendment`；缺口記錄加 `registration_amendment`；摘要的 G 判定用 `gate_roles(v1.1)` 並記 v1／v1.1 雜湊。
  3. `a37_tracks_score.gate_report` 的 `roles` 改為必填（`G250_ROLES_V1` 只供對照與測試）。
  4. 後台：`scripts/lib/surge-tracks-report.mjs` 的 `LIST_META`（S0、S_FB 灰底、判定與標籤）與 v1.1 JSON 逐字一致（node 測試讀 JSON 核對）；`src/components/Admin/SurgeTracks.tsx` 灰底＋只觀察標籤＋頁首一行 HO-BURNED。
  - `a37_tracks_core.py`、`a37_tracks_fwd_io.py`、`a37_tracks_sync.py`（`PREWIRE_CODE`）與 17 個釘選檔**都沒有改** ⇒ 接線前證明的程式綁定照舊有效；本筆**沒有 PIN-UPDATE 列**。
- **驗證**：`python3 a37_tracks_reg_test.py`（7 項：真實登錄鏈結、竄改拒跑、覆寫不動 FR、core 套用後 parity 不變、G250／G500 升級語意與 v1 切分逐格等價、freeze_core 封印帶 v1.1 標籤、缺口帶修訂指標）、`python3 a37_tracks_fwd_test.py`、`node --test scripts/lib/surge-tracks-report.test.mjs`。
- **當下已看過的前向結果**：無（沒有任何前向凍結、標籤或報酬）。
- **對判定的可能影響**：前向的池、名單、名次、RAND 與判定量都不變；改變的只有 S0、S_FB 的出發判定（KEEP → WATCH-ONLY）、介面呈現（灰底）與 G250／G500 的結果名稱（CONFIRM／DROP → UPGRADE／STAY-WATCH）。

*影子模式·未扣成本·非投資建議。*
