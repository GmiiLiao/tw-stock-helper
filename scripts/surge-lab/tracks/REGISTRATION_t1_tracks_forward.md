# T1 分軌前向影子：事前登錄（v1，封存並凍結）

| 項目 | 內容 |
|---|---|
| 登錄編號 | `T1-TRACKS-FWD-2026-10-05`（**version 1，SEALED・FROZEN**） |
| 登錄日 | 2026-10-05 |
| 母登錄 | `T1-TRACKS-PREREG-2026-10-04` v2（sha256 `065a92c6b063ccfb0bcb5a8facc99734e4f7d769f7af66198953cd7f5592c3e3`，main 封存 commit `1fa118e`）；HOLDOUT 鎖檔 `tracks_t1_HO_LOCK.json`（sha256 `97d596b33752b8fac1dac6aabab15d5a1fe83cd29545a1c1ebfcad6e5eaa6ef0`，main commit `0173abc`） |
| v2 判定（不受本登錄影響） | M-UNCHANGED、MP-REJECT、R-WATCH-ONLY、S-KEEP-AS-SHADOW、SFB-KEEP-AS-SHADOW、DD-INCONCLUSIVE、W-WATCH-ONLY |
| 依據 | 使用者 2026-10-05 的 G1 決定（報告 `docs/SURGE-TRACKS-T1-2026-10-05.md` 第 11 節） |
| 分支／基底 | `claude/tracks-fwd-prep`；基底 `3480e2f105bf761df01dbecbf69dc48fa4192f9b` |
| 機器可讀版 | `scripts/surge-lab/tracks/registration_t1_tracks_forward.json`（前向程式的參數一律從這份讀；兩份有出入時以 JSON 為準） |
| **JSON 封存雜湊（sha256）** | **`ec1a0bf87b6643bbff37b59ca346bd1746f7d500dbc402a02222343450fcae26`** |
| JSON 檔案位元組 sha256 | `6382ac004d6022ed2ae5070a70db7739573481a786caeee2c660ab376880be1a` |
| 前向偏差紀錄 | `scripts/surge-lab/tracks/DEVIATIONS_t1_tracks_forward.md`（第一筆前向偏差發生時建立，只增不改；改釘選檔另寫 `PIN-UPDATE:` 列） |
| 接線前修正與驗證 | `DEVIATIONS_t1_tracks.md` DEV-009（修正）、DEV-010（鎖後驗證）、DEV-011（與 v2 FORWARD 節的差異） |

雜湊算法同 v2；前向程式開跑前以 `a36_tracks_fwd_rules.load_forward_registration()` 重算並與上表比對，不符就拒跑：

```python
import json, hashlib
obj = json.load(open('scripts/surge-lab/tracks/registration_t1_tracks_forward.json'))
hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
```

> **凍結**：這次 commit 之後本檔與 JSON 都不得再改。清單、判定規則與門檻在第一個決策日之後不能改（要改就另立登錄）；實作錯誤可以修，但要先寫前向偏差並更新釘選。
> 封存時**沒有任何前向資料**：沒有決策日、凍結檔或前向標籤；2026-10-05 之後的價格、標籤、報酬都沒有讀過。
> 研究登錄，**非投資建議**。所有報酬比較一律未扣成本（成本只另列參考，不當門檻）。**本登錄不產生任何可交易名單。**

---

## 0. 這份登錄做什麼、研究期多久

v2 在 HOLDOUT 上的結論是：各軌都排得出高於隨機數倍的命中密度，但沒有任何清單的報酬 CI 下界 > 0（卡在命中轉報酬）。G1 決定把**判定為 KEEP 的兩份代理清單**（S0、S_FB）放進前向影子，看它們的同日 lift 在封存之後的新資料上是否仍然成立；R0、W 只做灰底觀察；M0 只當參照。

- **研究期**：G60（60 個已評分交易日，約 3 個月）只查流程與崩壞；**G250（約 1 年）決定去留**；S0／S_FB 若判 EXTEND，延到 G500（約 2 年）定案。若 s0 在 2026-10 中旬，G60 約 2027-01、G250 約 2027-10、G500 約 2028-10。
- 唯一的主要檢定是 **Δprecision@5(S0 − RAND_S)**；其他都是探索性或描述。
- G250 的 CONFIRM 只確認「代理的 lift 在前向也成立」，**不會把任何清單變成可交易名單**。

## 1. 範圍

| 類別 | 清單 |
|---|---|
| 進前向影子（觀察／研究榜） | **S0 atr14@5**、**S_FB atr14@5**（探索性） |
| 灰底觀察（介面不顯示報酬，研究記錄照算） | **R0 combo@5**（R-WATCH-ONLY）、**W atr14@3**（W-WATCH-ONLY） |
| 參照（只作描述） | **M0@10**（主榜模型參照）、**M0@20**（等名額對照的對照組） |
| 不進影子 | Mp1／M′（MP-REJECT）、R1／R2／S1／S2、M0\*、處置漂移的任何交易規則（另立登錄） |

主榜 M0、站上預測（computeLimitUpForecast、ai-daemon）、起漲影子（a35）都不改。本登錄**不部署、不安裝或修改 LaunchAgent、不寫 Firestore**：接線與部署另案核可。

## 2. 清單

| 清單 | 池（當日該軌的列） | K | 排名 | 區塊 | 標籤 | 進場判定 | 前向主要量 |
|---|---|---|---|---|---|---|---|
| S0_atr14@5 | S 軌 | 5 | atr14 由大到小 | S0 研究榜 | 觀察／研究榜·代理 lift 的時間外複製·容量受限·不可交易·待前向確認 | S-KEEP-AS-SHADOW | Δprecision@5(S0 − RAND_S)（**主要**） |
| SFB_atr14@5 | Mp 軌（MP-REJECT ⇒ 啟用） | 5 | atr14 | S_FB 研究榜 | 探索性·（同 S0） | SFB-KEEP-AS-SHADOW | Δprecision@5(atr14_FB − RAND_FB)（探索性） |
| R0_combo@5 | R 軌 | 5 | combo（≥3 項） | 灰底 R | 不可交易，僅觀察 | R-WATCH-ONLY | Δprecision@5(R0 − RAND_R)（升級條件） |
| W_atr14@3 | W 軌 | 3 | atr14 | 灰底 W | 不可交易，僅觀察 | W-WATCH-ONLY | 只作描述 |
| M0@10 | M 軌 | 10 | M0_fwd 分數 | M0 參照 | 主榜 M0 參照·本研究未作可交易判定 | M-UNCHANGED | 只作描述 |
| M0@20 | M 軌 | 20 | M0_fwd 分數 | 等名額對照 | 描述用 | — | 只作描述 |

- 各清單只在自己的池內排名，**不跨軌重排、不混排**（S 列不進 W 的池；S_FB 不與 S 混排）。
- 依 G1 決定，S_FB 的標籤與 S0 相同（含「容量受限」）。揭露：S_FB 的列 vol20 ≥ 300，HO 選股 Qmax(2%) 中位數 28 張、≥2 張占 100%，容量限制遠小於 S0（S0：中位數 1 張、≥2 張占 39.0%）。
- **等名額對照**（描述）：當日 M0 前 10＋R0 前 5＋S0 前 5（各在自己的池）對 M0 前 20 的 Δprecision；只用 core 與 m0ref 都有凍結的日子。

## 3. 軌道歸屬（v2 規則＋第 4 項修正）

- 旗標、軌道、優先序（NE_TDR → NE_SUSP → NE_LU_S → M → Mp → R → S → W）、多標籤失敗條件與分區 assertion 都照 v2（`definitions.*`）。brk_future 在前向不可得，也從不使用。
- **前向列範圍** D_fwd(s)＝{first_trade_idx ≤ s，且 [s−249, s] 內至少有一筆收盤}。v2 用 last_close_idx（看未來），前向不能用；這只影響 NE_SUSP 的列數，不影響任何池、清單或 RAND。
- **決策日**：s0 起每個交易日（Firestore `system/tradingCalendar`）。v2 的衝擊窗與「面板最後 5 日」排除不適用於前向。面板起點必須是 2022-07-18，不是就當日記缺口。
- **上市日（v3，DEV-009）**：v2 四條規則外加「快照上市日 ≥ 面板起點、但面板第一筆收盤就在面板第一天 ⇒ −∞（`transfer_prepanel`）」。上市快照取官方鏡像中檔名日期 ≤ s 的最新一份，疊在 v2 釘住的 2026-10-02 快照上。age_off、age_cap、hist_len 同 v2。
- **處置／注意**：照 v2（DK_s＝公告日 ≤ s−1 的 KNOWN；at_known5／20；coverage_rule 缺漏記 NaN）；s 當晚公告只記事後欄 m_disp_t_exec。
- **每日分區 assertion**：當日列上 v2 §2.1 結構 assertion 必須成立，不成立當日 core 記缺口。

## 4. 特徵、排名與 M0

- **代理**：v2 的 atr14、n_lu_250、r20、c_ma120、combo（池內同日百分位、至少 3 項，否則 NaN），組成項套 v2 短歷史 NaN（`feature_windows_t1.json`，sha256 `3dcf0e0a…d459`）；只用 s 日為止的還原面板。
- **排名**：由大到小，NaN 排最後；同值以 u(s, code)＝sha256(`{date}|{code}|t1tracks`)/2^256 大者優先（v2 tie_noise）。
- **「距上次」特徵（DEV-009）**：days_since_lu、dp_since 不再用 999；近 250 日內觀察到 ⇒ 原值；未觀察到或 > 250 且 hist_len ≥ 250 ⇒ 251（censored）；其餘 NaN（unknown）；記錄附 state 欄。前向清單都是代理，不用這兩個特徵。
- **M0_fwd（凍結參照模型）**：v2 M0 協定（official 欄位、run_cv、種子 0／1／2），ts＝1022（2026-10-02），最後訓練日 s＝1011（2026-09-15），資料＝`.surge-cache-T/dataset_t1L_off.npz`（只讀）。模型指紋 `80ec0f8e2c892d6ef61190525fa6c8a469404ba9bea368a993c9bc0dd09d5b2b`（兩次擬合逐位相同）。**整個前向期間不重擬**；接線在第一份 m0ref 之前以同一函式重擬，指紋不同就不得凍結。
  - 推論：s 日的 official 162 特徵用與 G0.4 相同的函式（`a36_tracks_lib.compute_all`）在實盤面板計算，編碼與訓練相同（days_since_lu 仍是 999，否則等於換模型）；**同日百分位母體＝當日 M 軌全部列**（不含 TDR；DEV-009 第 3 點）；三種子平均轉 float32、排名加 u×1e-9。
  - 任一官方來源整天缺 ⇒ 當日 m0ref 記缺口，core 不受影響。

## 5. 資料來源

| 用途 | 來源 |
|---|---|
| 收盤、開高低、量 | 研究面板 `.surge-cache/panel.npz`（Firestore chipArchive 唯讀匯出 → panel.py）；s 日兩市收盤必須官方且到齊（同 canonical-gate：收盤＋法人兩市到齊、無 Yahoo 補洞） |
| 官方漲停價 | 上市 TWT84U(s)、上櫃 dailyquotes(s−1) 的次日漲停價（鏡像 `www.twse.com.tw/twse_twt84u`、`www.tpex.org.tw/tpex_dailyquotes`）；9995＝無漲跌幅；單格缺值沿用 v2 檔位推算並逐日揭露 |
| 還原事件 | 同面板建置；只用生效日 ≤ s |
| 處置 | v2 釘住的 disposal_twse／tpex.json ∪ 鏡像 ≤ s（`twse_oa_announcement_punish`、`tpex_oa_tpex_disposal_information`），disposal.py 口徑 |
| 注意 | v2 釘住的 attention_twse／tpex.json ∪ 鏡像 ≤ s（`twse_oa_announcement_notice`、`tpex_bulletin_warning`），attention.py 口徑 |
| 上市日 | 鏡像 t187ap03_L／t187ap03_O ≤ s 的最新快照＋2026-10-02 釘住快照 |
| 交易日曆 | Firestore `system/tradingCalendar`（唯讀） |
| M0 特徵 | official_features 讀的官方原始檔（SURGE_CACHE/official） |

- 接線在第一份凍結前要證明：鏡像轉接器在重疊期間（≤ 2026-10-02）解析出的處置、注意、上市資料與 v2 釘住檔逐筆相同；不同就先寫前向偏差。
- 前向建置本身不發任何新的上游請求，只讀既有排程已落地的資料。

## 6. 凍結（看資料、不看時鐘）

- 每個決策日 s 兩份凍結檔：**core**（S0、S_FB、R0、W＋各池當日列＋RAND 抽樣名單）與 **m0ref**（M0@10、M0@20）。
- core 條件：C1 兩市官方收盤到齊；C2 官方漲停價檔齊；C3 還原事件 ≤ s；C4 處置／注意依 coverage_rule 建好（不擋凍結）；C5 上市快照可讀；C6 分區 assertion 成立；C7 登錄雜湊與釘選核對通過。m0ref 另要 M1 官方來源齊、M2 M0_fwd 指紋已核對。
- 條件成立後的第一個協調器時段凍結，**必須在 t 日 09:00（Asia/Taipei）之前**；過了期限 ⇒ 寫缺口記錄（理由、缺哪些條件、被研究程序擋下的時段），**永不補產、不回補**。
- **寫一次**：不存在才建立，不覆寫；重跑內容要逐位相同，不同記 parity 失敗、原檔不動。seal＝canonical JSON（不含 seal 欄）的 sha256；Firestore 副本（< 900 KB，超過就壓縮／分片）帶同一個 seal。
- 內容：登錄編號與雜湊、釘選檔實際雜湊、date_s、t、期限、dataBasis（各來源檔名與 sha256）、各清單（名次、代號、名稱與 name_src、軌道、分數、combo 項數、vol20、Qmax、DK_s、disposal_status、list_verdict、當下已知旗標）、各池列數與池列、RAND 抽樣名單與種子；m0ref 另含 M0_fwd 指紋與 M 軌母體列數。
- 記錄日期一律是交易日；非交易日產生的記錄記為最後一個交易日。

## 7. 到期與評分

| 量 | 到期 | 規則 |
|---|---|---|
| T1 標籤 y | **s＋2**（t 與 t＋1 的官方收盤與漲停價到齊） | v2 定義（t 起連續 ≥2 日收漲停）；RAND 事件數＝凍結池列的 y 加總 |
| 可買 buyable | t | t 日有開盤且未鎖在官方漲停價（9995 不鎖） |
| c1／c5／c10 | t／s＋5／s＋10 | close(t)、close(t+4)、close(t+9) ÷ open(t) − 1，到期當時的還原面板；只算一次 |
| t 日起處置 | t | 公布日＝s、處置起日＝t 的公告 ⇒ 旗標 DISP_T（不改 DK_s） |

- 每個 (s, 期數) 的評分只寫一次；上游事後修正另附更正記錄，指標用第一次的記錄並揭露更正件數。
- s＋2 之後再過 10 個交易日仍無 t／t＋1 官方資料 ⇒ `label_unavailable`，不進指標、逐日揭露；不補值。
- 出場日分類（統一旗標，DEV-009 第 2 點）：到期時 OK／NOCLOSE_UNRESOLVED；G 評估時以評估日為記錄時點另附重分類（NOCLOSE_HALT／ILLIQ／UNRESOLVED），只增不改；報酬一律 NaN＋旗標，不補 0。

## 8. 指標與統計

- precision@K＝Σhits／Σpicks（含開盤鎖死的選股）；**Δprecision(清單 − RAND)**＝(Σhits − ΣE_RAND)／Σpicks；lift＝Σhits／ΣE_RAND。
- **RAND**：判定只用 **RAND_E**（v2 的期望值，不抽樣：picks＝min(K, n_s)、E＝events_s × picks ÷ n_s）。另以 `default_rng(int(sha256('{date_s}|{list_id}|t1fwd-rand')[:16], 16))` 對升冪排序的池代號不放回抽 min(K, n_s) 檔，與名單一起封印（**RAND_draw**，可逐位重現），只作稽核與介面基準。
- **Bootstrap**：v2 原樣（20 日循環區塊、B＝2000、seed＝11）；日序列＝已評分的前向日依時間排序（缺口日略過不補）；配對比較共用同一組重抽日；百分位 2.5%／97.5%。
- 只計已評分日（core 凍結且 T1 到期）；缺口日與 label_unavailable 日不計、逐日揭露。
- 報酬（研究記錄，描述）：逐日等權 c5、c10（全部可買、DK_s＝0 子集）與同軌超額，未扣成本；登錄口徑排除出場日無收盤者，另報兩種出場價與排除 t 日起處置的敏感度。
- 逐日揭露（每日 × 清單）：選股數、DK_s＝0／1／未知、t 日起處置、可買、t 日無開盤、開盤鎖死、c5／c10 各出場狀態件數。

## 9. G60（流程與崩壞）

約 s0 起 3 個月（第 60 個已評分日）。

| 檢查 | 內容 |
|---|---|
| P1 | 每個前向交易日都有 core 凍結檔或缺口記錄（沒有無聲缺日）；core 缺口占交易日 ≤ 20% |
| P2 | 凍結檔與評分記錄的封印都能重算相符；沒有覆寫；Firestore 副本與本機逐位相同 |
| P3 | parity：以研究路徑（`a36_tracks_lib.compute_all`＋v3 上市日、`a36_tracks_proxy`）在截到 ≤ s 的面板重算，軌道、池列數、清單成員與名次 0 差異；上游事後修正另記「資料修正」並附證據 |
| P4 | 每個決策日的分區 assertion 成立 |
| P5 | 缺料都記錄、沒有補假值（出現任何 0 填補即失敗） |
| P6 | T1 標籤恰寫一次，且在 t＋1 資料到齊之後 |
| P7 | 登錄雜湊與釘選每天核對通過（或有 PIN-UPDATE） |
| P8 | 介面：灰底清單沒有任何報酬；各區沒有混排 |

- **崩壞**：S0 或 S_FB 前 60 日的 Δprecision@5(清單 − RAND_E) 95% CI 上界 < 0。
- **CONTINUE**＝P1～P8 全過且沒有崩壞；**HALT-FOR-REVIEW**＝其餘。HALT 時凍結照常、記錄保留，但 G250 暫停到使用者裁定（裁定寫進前向偏差紀錄）。

## 10. G250 與 G500（機械判定）

約 s0 起 1 年（第 250 個已評分日）；評估窗＝前 250 個已評分日。各清單依下列順序判定，結果互斥且窮盡：

| 清單 | 規則（點估計、95% 區塊 CI 下界） | 結果 |
|---|---|---|
| **S0**（主要） | 點估計 ≤ 0 或無法計算 ⇒ **DROP**；否則 CI 下界 > 0 ⇒ **CONFIRM**；否則 **EXTEND** | CONFIRM：維持 S-KEEP-AS-SHADOW，標籤改「觀察／研究榜·代理 lift 前向確認·容量受限·不可交易」；EXTEND：延到 500 日；DROP：降為 S-WATCH-ONLY（灰底、不顯示報酬） |
| S_FB（探索性） | 同 S0 | CONFIRM：維持（保留「探索性」）；EXTEND：延到 500 日；DROP：降為 SFB-WATCH-ONLY（灰底） |
| R0（灰底） | 點估計 > 0 且 CI 下界 > 0 ⇒ **UPGRADE**；點估計 > 0 ⇒ **EXTEND**；其餘 **STAY-WATCH** | UPGRADE：升為 R-KEEP-AS-SHADOW，撤除灰底，標「觀察／研究榜·代理 lift 前向確認·不可交易」；EXTEND：維持灰底到 500 日；STAY-WATCH：維持灰底 |
| W | 只作描述 | 永遠 W-WATCH-ONLY |
| M0@10、M0@20、等名額 | 只作描述 | — |

- **G500**（只對 EXTEND 者，前 500 個已評分日）：點估計 > 0 且 CI 下界 > 0 ⇒ CONFIRM（R0 為 UPGRADE），否則 DROP（R0 維持灰底）；最終定案，不再延長。
- S0 是唯一的主要檢定（不需多重比較校正）；S_FB、R0 未調整，報告標明。
- 每次 G 評估都輸出各清單的 **HIT 與 MISS 記錄**（該軌每個 T1 事件的名次與結果）、全部選股與逐日揭露。
- 實作：`a36_tracks_fwd_rules.g60_crash／g250_keep／g250_watch／g500_final`（單元測試涵蓋互斥窮盡）。
- 檢定力（v2 power）：S0 的 G250 約 0.74；R0 約 0.21（預期多半停在灰底）；S_FB 以 HO 效果量估約 0.37（若像 SELECTION 只有約 0.08）。

## 11. 介面文字與呈現

| 區塊 | 標題 | 呈現 |
|---|---|---|
| S0 | S 小量軌・觀察／研究榜（S0 atr14 前 5） | 標籤全文；到期後顯示 T1 命中與否、累計 Δprecision 對 RAND；**卡片不顯示報酬** |
| S_FB | S_FB・觀察／研究榜（探索性；Mp 列 atr14 前 5） | 同上，加「探索性」 |
| 灰底 R | 灰底・R0 再點火 combo 前 5（不可交易，僅觀察） | **不顯示任何報酬或報酬衍生數字** |
| 灰底 W | 灰底・W 觀察 atr14 前 3（不可交易，僅觀察） | 同上 |
| M0 參照 | M0 參照（主榜模型前 10） | 不顯示報酬 |
| 等名額對照 | 等名額對照（描述） | 只有命中數與 Δ |

- 固定標註：未扣成本（成本參考：2.8 折來回約 0.38%、全額約 0.585%；只作參考，不當門檻）；交易方法狀態未知（全額交割、變更交易方法、停止信用交易的來源未提供）；容量以 s 日 vol20 估計，未模擬開盤競價量與滑價；**非投資建議**。
- 處置：DK_s＝1「處置中（DK_s＝1）·交易規則另案登錄」；DK_s 未知「處置狀態未知（來源缺漏）」；t 日起處置另標。
- 報酬只在管理員的研究記錄分頁，附「未扣成本·不可交易·非投資建議」。只在管理員頁（super-admin）；API gzip＋no-store；Firestore 文件 < 900 KB。

## 12. 記錄欄位（第 4 項修正後）

- 選股記錄新增：`disposal_status`（取代 v2 的 `tradable_status`，值只代表處置狀態）、`list_verdict`、`section`、`grey_watch_only`、`flags`（代碼）、`flags_text`、`m_has_open_t`、`exit_c5_cat`、`exit_c10_cat`、days_since_lu／dp_since 與 `*_state`。
- 讀 v2 鎖定選股記錄一律經 `alias_legacy_tradable_status`（tradable_status → disposal_status）；**不得把 tradable_status 當成清單層級的可交易判定**。
- 每列固定寫「未扣成本·事後欄位以 m_ 標示·非投資建議」。

## 13. 缺料

缺料就記缺、不捏造：沒有任何預設 0。core 期限前不齊 ⇒ 缺口、永不補產；m0ref 不齊 ⇒ 只 m0ref 缺口；單格官方漲停價缺 ⇒ v2 檔位推算並揭露；處置／注意缺漏 ⇒ v2 coverage_rule 的 NaN；上市快照缺 ⇒ 取更早快照，連釘住快照都讀不到 ⇒ 缺口；標籤資料缺 ⇒ label_unavailable；出場日無收盤 ⇒ NaN＋旗標；研究程序占用共用快取 ⇒ 照 a35 協調器 preflight 略過，期限前仍未凍結即記缺口並註明被擋時段。

## 14. 接線前修正（G1 第 4 項）與鎖後驗證

| 項 | 修正 | 實作 |
|---|---|---|
| (i) | `tradable_status` 只代表處置狀態 ⇒ 改名 `disposal_status`；加清單層級 `list_verdict` | `a36_tracks_fwd_rules.disposal_status`、`alias_legacy_tradable_status`、`FWD_LISTS` |
| (ii) | 出場日無收盤與 t 日起處置同一套旗標＋逐日揭露 | `exit_category`、`pick_flag_codes`、`FLAG_TEXT`、`daily_disclosure` |
| (iii) | M0 前向百分位母體＝當日 M 軌全部列 | `rank_pct_by_day`、`a36_tracks_fwd_m0` |
| (iv) | 轉市場股面板起點規則（transfer_prepanel）；999 改 251／NaN＋state | `listing_info_v3`、`censor_since`、`since_from_legacy` |

**鎖後驗證**（DEV-010；`out/tracks_t1/fwdprep/tracks_t1_FWDPREP_VERIFY.json`，sha256 `468f43ac51ae8b0bab15cc71653e55ecbb81b64876e944ac9274c3ab973e403d`）：把四項修正套進 v2 的鎖定評估路徑，在 `.surge-cache-T`的 APFS 複本 `.surge-cache-T2` 上重建軌道檔、重擬受影響的模型、重跑 SEL+HC 選模與 HOLDOUT 判定（`.surge-cache-T` 未改）。

| 檢查 | 結果 |
|---|---|
| 軌道檔重建 | 只有預期欄位不同（age／listing、days_since_lu、dp_since、s < 59 的 A60）；換軌的列全在 s < 59（評估與訓練範圍外） |
| M0 訓練段 | 13 折 × 3 種子，資料集測試列分數與 v2 檢查點**逐位相同（39／39）**；百分位函式在資料集列上逐位重現 m0_ranks |
| SEL＋HC 選模 | **不變**：W_R＝R1（SEL R1−R0 ＋0.755pp [0.084, 1.430]）、W_S＝S0（S1、S2 下界仍 ≤ 0）、Mp1 帶進 HO |
| HOLDOUT 判定 | **全部相同**：MP-REJECT、R-WATCH-ONLY、S-KEEP-AS-SHADOW、SFB-KEEP-AS-SHADOW、DD-INCONCLUSIVE、M-UNCHANGED、W-WATCH-ONLY |
| Holm | H_S 0.0005、H_R 0.874 不變；H_Mp 0.185 → 0.250（仍不拒絕）；未捨入 p 重算拒絕與否相同 |
| 前向四份代理清單（S0、S_FB、R0、W）＋M 軌代理 | SEL、HC、HO 全部子窗的指標**完全相同**，選股成員、名次、命中、報酬、DK_s、Qmax **逐列相同** |
| M0@10、M0@20 | 每個視窗的命中、精確度、Δ、p 不變；少數日子成員互換（HO 可買 c5 ＋0.142% → ＋0.145%） |
| 統一旗標 | 出場日分類與鎖後補遺 exit_alternatives 在全部前向清單選股上逐列等價（SEL＋HC、HO） |
| HO 讀取紀錄 | HO_ATTEMPTS 增 10 列 post-lock:fwdprep:*（只增不改） |
| 程式版本 | 驗證時 a36_tracks_fwd_rules.py 為 `ca1e6620…`；之後只改 check_pins 的路徑基準（3480e2f），驗證用到的函式未改 |

## 15. 實作釘選

前向建置與評估必須 import 下列檔（sha256 相符）；要改任何一個，先寫前向偏差並加 `PIN-UPDATE: <檔> <新 sha256>`，只准修實作錯誤、不准改規則。`a36_tracks_fwd_verify.py`（鎖後驗證）不在前向路徑、不釘選。

| 檔案 | sha256 |
|---|---|
| `scripts/surge-lab/a36_tracks_lib.py` | `e1ec6280d58dd3219a180a84438b8b80685141378725d1d4a67a4558f97a5ce0` |
| `scripts/surge-lab/a36_tracks_proxy.py` | `0e69e1d7a3dfca407c0609e11f9d9773adbb7874850afe3b7147301342b52247` |
| `scripts/surge-lab/a36_tracks_fwd_rules.py` | `6bec88ea1d25600396c1f94b6c112f5a771fe26ae99d3f5fe0c780829a2e4c92` |
| `scripts/surge-lab/a36_tracks_fwd_m0.py` | `675f9b26aff66cc8de5fb5bf102dcb759f226da5a69dc0a4dcfa682e475b6856` |
| `scripts/surge-lab/a36_tracks_fit.py` | `1716bb9559cb54cf91e797885e93b06891ae9c3c15e845a2fcaceb09dca8eea9` |
| `scripts/surge-lab/a36_tracks_eval.py` | `7ea10156c1cadfba8437b3f1869e510386562dd4877cd432c78c8b301d968a54` |
| `scripts/surge-lab/a36_tracks_build.py` | `fb393a36f07f4b375e9afb3f3993234e18709fcb42cf5af5bfdb37ab04f48810` |
| `scripts/surge-lab/build.py` | `7678087713aabd21caa2c8881a4a396fe3015c1ad0e133164af18ae778811a9b` |
| `scripts/surge-lab/build_v2.py` | `6c7e289c852aefb8b6ce31cd7abe8dfd0b4bd8a3a1b0665ad1a6a86ac333df14` |
| `scripts/surge-lab/official_features.py` | `7eef67f18206828ddd8ee9b56b31df59f59371799bf2020653f01d6159e4c67b` |
| `scripts/surge-lab/official_limits.py` | `b6ea8f7aae4c696cd42f17356fe92cac002062a0cbf78da5bd6b0e4ba9a137c0` |
| `scripts/surge-lab/disposal.py` | `742d80be9d75174d002b2d659c33952fa5bcda1a3488495b09e32d9bf62a5fab` |
| `scripts/surge-lab/attention.py` | `2ec18d1de227c781c22cb7f7cd41a5a96be6e426dbaf534de93701b6ea0b17c5` |
| `scripts/surge-lab/models.py` | `d55e859b8dbfa490dbe7edb9aa689d20c1ed253d729d00f86c9ede5619c910e7` |
| `scripts/surge-lab/run_cv.py` | `fb3b80c15a83b474d3cced96c5611355a1153a2a3c6530778b10becda9078bdf` |
| `scripts/surge-lab/cv_official.py` | `2973e2f95ed76bcc41e486fd778ddfbcb6c1e8fba000484052d8e28cd9b81270` |
| `scripts/surge-lab/fingerprint.py` | `798b409fb7d2af4cd2aa28eb94302ab764cd730c7b9b97b3f97e307655575d85` |

## 16. 成本參考（不當門檻）

| 項目 | 數值 |
|---|---|
| 手續費（2.8 折），單邊 | 0.0399% |
| 證交稅 | 0.3%（當沖 0.15%） |
| 來回成本 | 2.8 折約 0.38%；全額約 0.585% |
| 每持有日攤提 | c5 約 0.076%／日；c10 約 0.038%／日 |

沒有模擬：小型股價差與滑價（1 檔約占股價 0.1～0.2%）、開盤競價量、處置股分盤撮合與預收款券。

## 17. 執行順序與修訂規則

1. 本登錄（md＋JSON）單獨一個 commit 封存。
2. 接線（另案，需使用者核可接線與部署）：import 釘選模組；第一份凍結前完成 M0_fwd 指紋重現、鏡像轉接 parity、至少 5 個歷史交易日的研究路徑 parity（逐位相同），結果寫檔並記 sha256。
3. **s0**＝接線上線後第一個產出 core 凍結檔的交易日（記在該檔）；s0 之前的日子不回補。
4. G60 → 報告給使用者。
5. G250（EXTEND 者到 G500）→ 依本 JSON 機械判定 → 交使用者。

封存後本檔與 JSON 不改；實作錯誤可修（前向偏差＋PIN-UPDATE），規則不可改；凍結檔與第一次評分記錄永不修改；G60 的 HALT 裁定、資料修正與任何例外都寫進前向偏差紀錄並在所有報告並列揭露。

*未扣成本·事後欄位以 m_ 標示·非投資建議。*
