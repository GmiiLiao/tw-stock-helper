# T1 分軌研究：偏差紀錄（只增不改）

登錄：`T1-TRACKS-PREREG-2026-10-04` v2（JSON sha256 `065a92c6b063ccfb0bcb5a8facc99734e4f7d769f7af66198953cd7f5592c3e3`）。
本檔是登錄凍結後唯一可寫處（登錄 §19）。每筆寫明：日期、階段、偏差內容、理由、當下已看過哪些結果、對判定的可能影響。
所有摘要都要把「登錄規則的結果」與「偏差後的結果」並列；判定以登錄規則為準，除非登錄規則本身無法執行。

---

## DEV-001　窗長表漏列 5 個新模型會用到的特徵（登錄規則照字面無法執行）

- **日期／階段**：2026-10-05，Phase 0 建置（`a36_tracks_build.py build`）。
- **偏差內容**：登錄 §4／`short_history_nan_rule.window_table` 沒有下列特徵，而登錄規定「不在表上的特徵：建置直接 assert 失敗」：
  - `rs20`：屬 official 特徵集；新模型（Mp1、M0\*、R1、R2、S1、S2）的特徵是「official − rk_\* + age_cap」，必含 `rs20`。
  - `log10_vol20`、`log10_close`：S1 登錄的原值特徵（log10(vol20)、log10(收盤)）。
  - `is_R`、`is_S`：R2、S2 登錄的軌道旗標。
  照字面執行，所有新模型的建置都會 assert 失敗，登錄規則本身無法成立。
- **處置**：依登錄同一節的慣例「w 取公式的最長回看（rolling 窗＋shift）」補列，其餘未列者照登錄 assert 失敗（`rk_*` 依登錄自新模型移除，不補）：

  | 特徵 | 公式 | 補列窗長 |
  |---|---|---|
  | rs20 | r20 − mkt_r20 | max(w(r20)＝21, w(mkt_\*)＝0)＝**21** |
  | log10_vol20 | log10(rolling(20, min_periods=15) 均量) | **20** |
  | log10_close | log10(s 日收盤) | **1** |
  | is_R、is_S | s 日軌道旗標（不依價量歷史） | **0** |

  實作：`a36_tracks_lib.DEV001_WINDOWS`；`out/tracks_t1/feature_windows_t1.json` 中這 5 項的 `rule` 標 `DEV-001`。
- **當下已看過的結果**：只有 Phase 0 的結構與對帳輸出（輸入雜湊、列數、listing 計數）；沒有任何模型、代理或報酬的評估數字，沒有讀 HOLDOUT 標籤或報酬。
- **可能影響**：只改變這 5 個特徵在短歷史列（rs20：hist_len < 21；log10_vol20：hist_len < 20）的 NaN 型態，只影響新模型；M0 不適用短歷史規則，不受影響。

---

## DEV-002　登錄未寫明的實作細節（不改任何登錄規則，記錄以便審查）

- **日期／階段**：2026-10-05，Phase 0 建置、事件對帳與截斷測試（`a36_tracks_build.py build／events／trunc`）。
- **當下已看過的結果**：Phase 0 輸出——SEL+HC 全部 T1 事件的逐軌件數與對帳（base 2,516、aadab48f 2,515）、資料集逐列對帳、G0.6 截斷差異、公告涵蓋計數。沒有任何模型、代理精確度或報酬的評估數字；HOLDOUT 只算了結構列數，沒有讀標籤或報酬。

1. **處置的月涵蓋檢查只判「完整月」**：含面板最後一日的月份（全面板＝2026-10；截斷到 s 時＝s 所在月）資料尚未齊，不判零筆，以免截斷測試把「月份還沒過完」誤判成缺漏。全面板 2026-10 實際有 TWSE 3 筆、TPEx 6 筆；其他月份都沒有零筆；套用 NaN 的格數為 0。**影響：無。**
2. **R 軌 DK_s 未知時 Qmax 記 NaN**：登錄只寫「R 在處置中 q 減半」，沒寫 DK_s 未知的情況；依「不捏造預設值」記未知。目前沒有 DK_s 未知的列。**影響：無。**
3. **R 專用特徵的細部定義**（登錄只有一句描述）：
   - 段＝連續 ≥2 日收漲停的最長區間；「已結束」要求段尾 e 的下一日已知不是漲停（e+1 ≤ s）；搜尋窗＝段尾 e ∈ [s−250, s−1]。
   - `r_seg_gain`＝段尾還原收盤 ÷ 段首前一日還原收盤（前值補齊）− 1；找不到段時記 NaN（登錄只寫了 r_seg_len 與 r_days_since_seg_end 找不到時的值）。
   - `r_n_seg_250`＝起點 t′ ∈ [s−250, s−1] 且 t′+1 也漲停的段數，面板第一天不計（同 `official_features.lu_traits`）。實測在全部列範圍內與 `o_lu2_starts250` **逐格相同**（差異 0 格）。
   - `r_dd_high20`＝還原收盤 ÷ 近 20 日還原最高價（min_periods 18）− 1。實測與 `dist_hi20` **逐格相同**（差異 0 格）。
   - 因此這兩個 R 特徵與既有 official 特徵重複，R1／R2 的實際新增資訊只有 r_seg_len、r_days_since_seg_end、r_seg_gain 與處置／注意欄位。
4. **G0.6 截斷測試的範圍**：
   - **登錄所列變體（fixedadj）**：面板、官方漲跌停價、處置與注意公告，以及 official_features 的官方原始矩陣都截到 ≤ s；還原因子沿用全面板（登錄沒有把除權息／減資因子列為截斷對象；未來因子只讓 ≤ s 的價格整欄同乘一個常數）。12 天全部 **0 差異**（軌道、多標籤濾網、Qmax、R 特徵、DK_s、dp_\*、at_known\*、age_off、age_cap、hist_len、162 個 official 特徵＋15 個額外特徵、短歷史 NaN 後的值、M 錨定百分位、各軌 atr14 與 combo）。
   - **加嚴變體（pit）**：再把除權息／減資因子也截到 ≤ s。離散量 0 差異；連續量只有浮點捨入差（最大絕對差 ≤ 3.6e-12；唯一例外是 2025-07-16 一格 vol10 為 8.3e-10、連帶 vol_ratio_10_60 為 8.5e-08，屬平盤股報酬標準差的捨入殘值）。這些捨入差只會在「剛好同值」的格子改變錨定百分位與名次（例如 c_ma5 恰為 0 與 1e-16 之別），不代表用到未來資訊。只作描述。
   - **D 的列範圍**：s 日停牌、之後才復牌的列，在全面板屬於 D（s ≤ last_close_idx），截斷後不屬於 D。這是登錄 `definitions.row_domain` 自己寫明的性質（last_close_idx 只決定停牌列算不算在 D、停牌列一律不評估）。每天 7～33 列，全部是 s 日無收盤的列；不列入「差異必須為 0」的比對。
5. **注意／處置公告落在非面板交易日**：注意股 242 則（TWSE 120、TPEx 122）、處置 18 筆，全部早於面板起點 2022-07-18；注意股依登錄指定的 `attention.build_matrices` 被略過，處置依 `disposal.py` 對到面板第一天（KNOWN 自第二天起）。只影響 s ≤ 21 的列（不在任何評估視窗，也在新模型的 s < 125 排除範圍內）。**影響：無。**

---

## DEV-003　Phase 1 CV 的實作細節（登錄未寫明處；不改任何登錄規則）

- **日期／階段**：2026-10-05，Phase 1（`a36_tracks_fit.py`、`a36_tracks_cv.py` 等）寫完、第一次執行 `select` 之前。
- **當下已看過的結果**：只有 G0.5 與 G0.9 兩道閘門（`out/tracks_t1/tracks_t1_G0_gate.json`：M0 重擬逐位相同、122／4,150；review_years 的 R|、B| 共 200 欄在 aadab48f 版逐數重現、基底版 26 欄不同且全在 2026 鍵），以及新模型擬合的訓練列數。**沒有任何清單的精確度、lift、報酬或配對 Δ**；沒有讀 HOLDOUT 標籤或報酬。
- **細節（全部在看到任何 SELECTION 數字之前決定）**：
  1. **R 專用特徵哪些「不轉百分位」**：登錄只寫「0／1 旗標與計數不轉換」。整數型的 r_seg_len、r_days_since_seg_end、r_n_seg_250、dk_s、dp_cnt20、dp_cnt60、dp_since、dp_n250、at_known5、at_known20 一律視為計數、保留原值；只有連續值 r_seg_gain、r_dd_high20 做 M 錨定百分位。理由：R 列都在冷卻期（距上段結束 1～10 日），M 列依定義全部 ≥ 11 日或 251（窗外），若以 M 分布錨定，R 列的 r_days_since_seg_end 會全部擠到 0，等於把這個特徵抹掉。
  2. **S1 的「原值 o_log_mcap」**：official 特徵本來就含 o_log_mcap（錨定百分位版）；S1 另加一欄原值（欄名 raw_o_log_mcap，窗長沿用 o_log_mcap 的 1），兩欄並存。
  3. **代理組成項的數值型別**：atr14、n_lu_250、r20、c_ma120 由面板以 quant.proxies 原式重算（float64），不用軌道檔存的 float32 特徵。理由：G0.9 要逐數重現 quant 的排名，float32 會把相近值併成同分、改變破同分結果；重現模式與登錄模式用同一組數值，只差登錄的三處（短歷史 NaN、combo ≥3 項、雜湊破同分）。
  4. **破同分方向**：值相同時 u 較大者名次較前（模型分數是「分數＋u×1e-9」由大到小，代理比照同一方向）。
  5. **c5／c10「逐日等權」的 median／win**：主口徑是逐日平均（附區塊 CI）；另報逐日平均的中位數與「逐日平均 > 0 的日數占比」；逐筆平均／中位數／勝率只作描述並標「逐筆」。
  6. **市值三分位**：以當日 M 列 o_log_mcap 的 1/3、2/3 分位數（numpy 線性內插）定界；o_log_mcap 缺值記 unknown。
  7. **記錄檔的清單對應**：M 軌事件對 M0@10、M0\*@10、Mp1@10（M′）各記一行；Mp 軌事件對 M′（Mp1@10）與 S_FB（atr14@5）；選股檔另含 DD2 的 M 軌 atr14@5、combo@5 與 Mp1 只排 M 列（C1 用）。等名額對照另算「最終清單版」（W_R、W_S）與「代理版」（R0、S0）兩種，皆只作描述。
  8. **CI 的計算範圍**：HALF-CONFIRM 與 HOLDOUT 子期（HO-2023、HO-2024、HO-model-a／b、排除 2024Q4）也各自重抽並報 CI，只作描述；判定只用登錄指定的窗與量。
  9. **HOLDOUT 乾跑的「同一條程式路徑」**：乾跑以同一個 `evaluate()` 從已存的各折分數檢查點重算 SEL+HC 全部摘要與記錄並逐位比對；擬合路徑另以「每個模型重擬 SEL1 折、種子 0，與檢查點逐位比對」抽驗，不重擬全部折（全部重擬約需 1 小時，且擬合是逐折獨立的確定性計算）。
  10. **HOLDOUT 的新模型**：Mp1／M0\*（若 Mp1 通過閘）與選定的挑戰者在 HO 六折都擬合；登錄只准在 HO-model（第 4～6 折）判定，第 1～3 折的結果標「面板起點限制，不作判定」只作描述。M0 的 HO 折沿用 run_cv 協定，第一折起點為登錄的 2023-08-01（非季初）。
  11. **輸出目錄**：依登錄 `outputs.dir`＝`scripts/surge-lab/out/tracks_t1/`（任務文字寫的 out/tracks/ 與登錄不同，以登錄為準）。
- **可能影響**：第 1 點只影響 R1、R2 的輸入表示；第 3 點已由 G0.9 逐數重現驗證；其餘不改變任何數值或只影響描述欄。

---

## DEV-004　HOLDOUT 哨兵之後、ho-eval 之前修正一個實作錯誤（不改規則）

- **日期／階段**：2026-10-05，哨兵 `tracks_t1_HO_STARTED.json` 已 commit（94cebd4）、HO 各折擬合進行中、**ho-eval 尚未執行**。
- **發現方式**：以 SELECTION 資料冒充 HO 視窗跑一次 HO 程式路徑（`EV.WIN_ID['HO']→SEL`、擬合檢查點名稱改讀 SEL 折，不讀任何 HO 標籤、報酬或 HO 檢查點），在寫 `tracks_t1_HO_outside.csv` 時崩潰。
- **錯誤**：`a36_tracks_cv.records()` 以 `df.ne` 取「NE 列」欄，但 `ne` 是 pandas DataFrame 的方法名（不等於比較），屬性存取拿到方法而非欄位 ⇒ AssertionError。SEL+HC 路徑不寫 outside 檔，所以乾跑沒有走到這行。
- **修正**：改用 `df['ne']`。只影響 HO 的 outside 記錄檔；不改任何規則、指標或判定程式。修正後同一冒充路徑全程跑完，判定樹的「經確認／未經確認」兩支、挑戰者（R1，HO-model）與代理（S0）兩種窗都走過一次。
- **當下已看過的結果**：沒有任何 HOLDOUT 數字（擬合只在背景寫檢查點，未讀其分數）；冒充路徑輸出的是 SELECTION 資料的數字，不作任何用途。
- **對判定的可能影響**：無。哨兵記的程式雜湊與 ho-eval 時的雜湊會不同（只差 a36_tracks_cv.py），鎖檔記錄 ho-eval 當下的雜湊。

*未扣成本·非投資建議。*

---

## DEV-005　登錄產出有 12 份沒有隨結果 commit（自訂的 2 MB 門檻）：補 commit 與來源核對

- **日期／階段**：2026-10-05，HOLDOUT 鎖檔（5fda1c7）之後的審查補救。
- **偏差內容**：登錄 §14／`outputs` 與 §17 執行順序第 4 步要求「commit 鎖檔與產出」，實際有 12 份檔案沒有 commit（untracked）：
  - **Phase 0**：`tracks_t1_G0.json`（登錄列名；G0.3 那 19 列逐列落軌、G0.6 截斷差異、G0.8 上市日、G0.10 缺漏清單、G0.11 存活者比對的唯一明細）、`tracks_t1_outside.csv`（SEL+HC 的 NE_SUSP／NE_TDR 事件 29 件；由 Phase 0 的 `a36_tracks_build.py events`〔`a36_tracks_stages.stage_events`〕寫出，`select` 階段不寫這個檔），以及登錄沒有列名的 `tracks_t1_events_SELHC.csv`、`tracks_t1_events_limit_rule_diff.csv`。
  - **SEL+HC**：`tracks_t1_{M_misses, M_picks, Mp_picks, R_picks, S_picks}.csv`。
  - **HOLDOUT**：`tracks_t1_HO_{M,Mp}_picks.csv`（登錄 `outputs.holdout_separate` 明列；HO_Mp_picks 是重算 H_Mp、C1、C2 唯一的逐筆依據）。
  - 其中 G0.json 與 outside.csv 的 sha256 沒有寫進任何已 commit 的檔案；`a36_tracks_cv.g0_status()` 的 G0 通過布林值是從這份未 commit 的 G0.json 讀進已 commit 的摘要。
  - 「≥ 2 MB 的檔不 commit」是該次執行自訂的規則（repo 的 pre-commit 沒有大小限制），只寫在 commit 5fda1c7 的訊息裡，沒有記進本檔；CV 報告「超過 2 MB 的記錄檔沒有 commit」也與事實不符（G0.json 58 KB、outside.csv 9 KB 同樣未 commit）。
- **理由（為何發生）**：執行者以檔案大小決定 commit 範圍，沒有逐項對照登錄的 outputs 清單。
- **補救（`a36_tracks_t1_audit.py pack`）**：
  1. **先確認現檔就是當初那一版**：G0.json——`g0_status()` 以現檔重算＝SEL 摘要的 G0 欄位；Phase 0 `report` 在記憶體內重算（攔截寫檔，不覆寫），除 `output_sha256`（輸出目錄已多出檔案）與 `git`（HEAD 已前進）外逐欄相同，檔內 `output_sha256` 的 11 筆逐筆與現檔相同；檔內 `git.head`＝64b60f6、a36 無未 commit 修改；檔案時間 00:43:42 早於 select（摘要 commit 2df3c67，01:15:01）。其餘檔案的 sha256 與 SEL 摘要 `record_files`、HO_LOCK `outputs_sha256`、HO 摘要 `record_files`、G0.json `output_sha256` 逐一相符（manifest `all_refs_equal`＝true）。
  2. ≤ 500,000 bytes 的原檔直接 commit（G0.json、outside.csv、limit_rule_diff.csv）；較大的 8 份以 gzip（-9、mtime＝0，可重現）存在 `out/tracks_t1/gz/`，壓縮後都 < 1 MB，不需分片（專案「大文件壓縮＋分片」規則）；原檔列入 `scripts/surge-lab/.gitignore`，不重複進版控；每份 gunzip 還原後 sha256 與原檔相同。
  3. 產出清單 `out/tracks_t1/tracks_t1_ARTIFACT_MANIFEST.json`：每份登錄產出的原檔與 .gz 的 sha256、位元組、列數、版控方式、與各參照的比對結果、還原指令。**鎖檔不動。**
  4. 原本 `ho-eval --verify-identical` 只印到 stdout、沒有留下產物 ⇒ 補 `out/tracks_t1/tracks_t1_HO_VERIFY.json`（逐檔 lock／now／磁碟 sha256、HEAD、時間、判定是否相同）。結果：17 份 HO 產出嚴格逐位相同、判定相同、程式雜湊與鎖檔相同（在本筆偏差寫入之前執行）。
  5. `tracks_t1_HO_ATTEMPTS.jsonl` 只增不改：鎖後的每次 HO 讀取（verify、補遺）都加一列 `post-lock:*`。
  6. VERIFY 檔記的 `a36_tracks_t1_audit.py` 雜湊（8f2f45e0…）與 commit 版（53a7e55a…）不同：VERIFY 之後只改了 `pack` 階段（`g0_provenance` 的摘要 commit 查詢路徑與附註、ATTEMPTS 的行數欄位），`verify-ho` 與 HO 路徑沒有改；補遺與產出清單已用 commit 版重跑（補遺 CSV 兩次逐位相同）。不以 commit 版重跑 verify-ho，是因為本筆偏差寫入後 HO 摘要的 deviations 欄必然不同，嚴格逐位的證據只能保留增列前那一次。
- **附註（往後的 verify-identical）**：HO 摘要內嵌本檔的標題清單（`a36_tracks_cv.deviations()`）。本筆起本檔增列 ⇒ 之後再跑 `ho-eval --verify-identical`，HO 摘要必然只在 `deviations` 欄不同；VERIFY 檔記了增列前的嚴格結果，並提供「除 deviations 欄外相同」的比對（`a36_tracks_t1_audit.py verify-ho`）。
- **當下已看過的結果**：全部 SEL+HC 與 HOLDOUT 結果（判定已鎖）。
- **對判定的可能影響**：無。沒有重跑 HO 判定、沒有改任何鎖定產出。

---

## DEV-006　登錄兩處規定互相衝突：HOLDOUT 只算選定模型，落選挑戰者的 HO 記錄從缺（並補齊其他缺漏記錄）

- **日期／階段**：2026-10-05，鎖後審查。
- **衝突**：`outputs.hits_misses_rule` 寫「每一軌的每個事件，對該軌每份登錄清單（**含落選的挑戰者**與對照組 M0\*）各記一行」；`windows.HOLDOUT.role` 與 §8.1 卻只列「代理與選定模型」。HO 實際只擬合並記錄 M0、Mp1、M0\*、選定的 R1；R2、S1、S2 在 HO 沒有擬合、也沒有記錄。DEV-003 第 10 點只寫「選定的挑戰者在 HO 六折都擬合」，沒有承認這個衝突；CV 報告「登錄只要求算選定的模型」一句不精確。
- **本次採用**：「HO 只算選定模型」，以維持 HOLDOUT 只算一次、且只對會進判定樹的清單看 HO。落選挑戰者的 HO 記錄因此從缺。
- **若之後要補**：只能另存成鎖後描述檔（例如 `addendum/` 下另一組檔名），標明不參與任何判定、不得用於重新選模；需要在 HO 六折重擬三個模型，屬於額外讀 HO 的行為，**本次不補，留給使用者決定**。
- **其他缺漏記錄（本次以鎖後描述補齊，`a36_tracks_t1_audit.py addendum`）**：從已存的分數檢查點以同一個 `evaluate` 重算（先核對 SEL+HC 15 份、HO 16 份記錄檔的 sha256 與摘要／鎖檔逐位相同，所有清單指標相同），輸出到 `out/tracks_t1/addendum/`：
  - M0@20 的選股（含第 11～20 名）；M 軌事件對 M0@20、M_atr14@5、M_combo@5、Mp1_Monly@10 的命中／漏網（原本 Mp1_Monly@10 只有選股、M_atr14@5／M_combo@5 只有選股）。
  - 等名額組合清單（final_lists、proxy_lists）的選股與命中／漏網。HO 組合實際 6,939 筆選股對 M0@20 的 6,940 筆（有一天 R 池只有 4 列）；SEL 4,777 對 4,780。
  - 每份補遺檔的 sha256 記在補遺摘要與 manifest；HO 的補遺不覆寫任何鎖定產出。
- **當下已看過的結果**：全部。**對判定的可能影響**：無。

---

## DEV-007　DEV-004 的附註：冒充試跑的實際修改沒有留存，「未讀任何 HO 標籤」無法由產物驗證

- **日期／階段**：2026-10-05，鎖後審查。
- **問題**：DEV-004 說冒充試跑只改了 `EV.WIN_ID['HO']→SEL` 與檢查點名稱。但 `a36_tracks_ho.ho_label_assertion` 與 `a36_tracks_cv.day_sets` 都寫死 `res['cal']['window']==1`，不經過 `EV.WIN_ID`。只照 DEV-004 的描述去改：
  - HO 標籤 assertion 會讀到**真實 HO 的 y**；
  - `day_sets` 會給出真實 HO 日，與框架裡的 SEL 列對不上 ⇒ 所有清單指標為 0，判定樹不可能如 DEV-004 所說走過「經確認」那一支。
  因此當時一定還有至少一處沒有記錄的修改（最可能是把 `res['cal']['window']`／`fold` 重新對應）。
- **查證結果**：實際的 patch 沒有留存——repo 沒有 diff、stash 為空、reflog 只有正式 commit、`ATTEMPTS.jsonl` 只有三列（ho-fit:start、ho-eval:start、outputs-written），本次也在工作階段暫存目錄找不到冒充試跑的腳本。**本次無法重建當時打了哪些 patch，也無法驗證「未讀任何 HO 標籤」。**
- **依 §8.2 第 7 點照報最壞情況**：若當時 `ho_label_assertion` 在真實 HO 視窗上執行，它算出的只有 HO 各軌事件數（全部 1,363；NE_TDR 4、NE_SUSP 19、NE_LU_S 0、M 651、Mp 14、R 146、S 171、W 358），與鎖定 HO 摘要的 `first_assertion` 相同，已全部照報。框架以 `EV.WIN_ID` 篩列（已改成 SEL），所以這條路徑不可能算出任何 HO 清單的精確度或報酬。選模（W_R、W_S、Mp1 閘）在哨兵之前已 commit（2df3c67、94cebd4），判定樹是機械計算 ⇒ 即使最壞情況，也不影響選模與判定。
- **其他**：哨兵記的程式雜湊（a36_tracks_cv.py 8d7fdcd4…）與鎖檔（d2b19b26…）不同，只差 DEV-004 的修正，與紀錄一致。§8.2 第 2 點的乾跑只重跑 `build_selhc`，沒有走 HO 專屬路徑（`HO.run`、`decide`、`ho_label_assertion`、`day_sets(HO)`、`records` 的 outside 分支、`ho_pairs`）；DEV-003 第 9 點把範圍縮成 `evaluate()`，`df.ne` 的錯誤就是因此留到冒充試跑才被發現。
- **往後的協定（下一輪登錄）**：
  1. HO 腳本提供正式的冒充模式：在哨兵之前，把整條 `HO.run` 路徑在「改標為 HO 的 SEL 視窗」上跑一次（含 assertion、day_sets、判定樹、outside 記錄、配對），輸出雜湊寫進哨兵。
  2. 每次冒充試跑都寫進 ATTEMPTS（含所有 patch 的 diff 雜湊）；不准手動 monkeypatch 的試跑。
- **當下已看過的結果**：全部。**對判定的可能影響**：無（依登錄決策樹逐項核對；審查者也人工核對過）。

---

## DEV-008　鎖後審查的更正與揭露（不改判定、不重跑 HO）

- **日期／階段**：2026-10-05，鎖後審查。數字出自 `out/tracks_t1/addendum/tracks_t1_{HO,SELHC}_ADDENDUM_summary.json`（鎖後描述，不參與判定）。
1. **Holm 的 p 值精度不一致**：`list_metrics` 與 `paired` 先把 p 四捨五入到 5 位，`decide` 直接拿來做 Holm（H_R 0.87406、H_S 0.0005）；H_Mp 用未捨入值。以未捨入 p 重算：H_S 0.00049975 → 調整 0.00149925（拒絕）；H_R 0.874063 → 0.874063；H_Mp 0.184908 → 0.369815。三項的拒絕與否與鎖檔相同。依 §8.2 第 8 點新舊並列，判定相同 ⇒ 較保守者即原判定。沒有重產任何 HO 產出，只重算 Holm 的算術；是否計入「修正重跑兩次上限」由使用者裁定（若計入，是第 1 次）。往後 Holm 一律用未捨入的 p，只在輸出時捨入。
2. **G0.9 差異落點的更正**：DEV-003 與 CV 報告說基底版 26 欄差異「全部在 2026 的鍵」，不精確。正確是：26 欄中 24 欄在 2026 鍵，2 欄（share_le1 53.0→52.8、med_vol20 193.05→193.35）在合併鍵 `B|combo@5|Qmax1pct`（review_years.py 以 2025＋2026 合併計算），差異來自其中的 2026 列。G0.9 照樣通過（aadab48f 版 0 差異，登錄只要求至少一版逐數重現）。
3. **`tradable_status` 欄名有誤導之虞**：值取自登錄 `outputs.tradable_status_values`，語意只代表「處置狀態」，不是清單層級的可交易判定。HO 選股記錄中標「可交易（DK_s＝0）」的列：W 825（同列 labels 卻寫「不可交易，僅觀察」）、R 2,535（R0 1,029、R1 1,506）、S 1,664，而這三份清單都沒有通過「可交易名單」通則。鎖檔不改；補遺 `*_addendum_picks_annotation.csv.gz` 逐列加上 `list_verdict` 與 `disposal_status`。影子接線或任何下游讀取時，`tradable_status` 一律當「處置狀態」，清單判定以 `list_verdict` 為準。
4. **出場日沒有收盤（c5／c10 為 NaN）直接排除，原本沒有揭露件數**：HO 可買選股中缺 c5／c10 的件數——S0 5／10、R0 2／5、R1 2／3、M0@10 2／2、S_FB 2／4、W 29／42。分類（推定，無 PIT 停牌來源）：S0、R0、M0@10 全部是「出場日無收盤、之後恢復收盤（推定停牌）」，例如 4950 在 2023-11-10～11-15 連續 4 天入選，之後約 190 個交易日沒有收盤；W 的 29 件中 13 件是 s 日 nan20>0 的冷門股無成交、10 件推定停牌、6 件之後面板內不再有收盤。HC 的 c10 另有「面板末端」（最後 5 個評估日的 t+9 超出面板）每份 K＝5 清單 25 件。描述性敏感度（出場價改用停牌前最後收盤／復牌後第一個開盤，m_ 欄，不補 0）：S0 T1 的 c5_dk0 +0.097% [−0.792, 1.008] → +0.087% [−0.802, 0.994]／+0.105% [−0.785, 1.014]；c10_dk0 +0.533% → +0.416%／+0.456%，CI 下界都 < 0；T6 超額 +0.192% [−0.468, 0.883] → +0.182% [−0.488, 0.877]／+0.178% [−0.484, 0.866]，上界都 ≥ 0。判定不變。前向影子要用同一套規則，並逐日揭露件數。
5. **t 日起處置（s 日盤後公告、t 日開盤前已知）的選股仍算進可交易口徑**：HO 中 DK_s＝0 且 m_disp_t_exec＝1 的選股：R0 51、R1 48、M0@10 16、W 10、S0 4、S_FB 2。登錄 §5 規定這個欄位只供描述、不當拆層變數，原本只存在欄位裡。補遺逐列標「t 日起處置（開盤前已公告）」，並報排除這些列的 T1 敏感度（描述）：S0 c5_dk0 +0.123% [−0.740, 1.029]、c10_dk0 +0.533% [−0.957, 2.230]；R0 c5_dk0 +0.432% [−1.237, 2.145]。T1 仍不過，判定不變。
6. **轉市場股第一筆收盤在面板第一天**：3652、4736、5236、6446、6472、6589、8476 這 7 檔（TWSE 轉入）依登錄 §3 規則 2 取 min(上市日, 第一筆收盤)＝0，而不是像規則 1、3 那樣記 −∞ ⇒ s < 249 時 age_cap < 250，等於把面板前就在交易的股票當成面板第一天新上市。這是登錄規則本身的不一致，不是前視、也不是實作錯誤。受影響的新模型訓練列（s∈[125, 248]）：M 650 列（3 件事件）、R 39 列、S 141 列、Mp 0 列。本輪不重跑；下一輪登錄改為「第一筆收盤在面板起點的轉市場股視為面板前上市（−∞，記 transfer_prepanel）」。另外市場別取自現行 code_market.json，轉市場股在轉入前的列會標錯市場；補遺另給 `market_by_date`（轉入前標「轉市場前（前市場來源未提供）」），只影響描述欄。
7. **「從未發生」用 999 當哨兵值**：`disposal.features` 的 dp_since 與沿用 build_v2 的 days_since_lu 在從未發生時填 999；R1／R2 把 dp_since 以原值餵進模型（R_RAW）。s ≥ 125 的列中 dp_since＝999 的占比：M 79.6%、R 43.9%、S 83.2%；days_since_lu＝999：M 18.5%、S 21.7%。對樹模型排序不變，但 999 是捏造的數值，實際語意是右截斷。本輪不重跑；下一輪登錄改為 hist_len 夠長時用窗長＋1 的截斷值、不夠長時用 NaN（與 r_days_since_seg_end 的 251 一致）。
8. **M0 的同日百分位母體排除只卡 brk_future 的列**：凍結 M0 為了逐位重現（G0.5），百分位母體沿用釘住資料集（排除全面板 23 列只卡 brk_future 的列；HO 視窗內 7 列，全在 HO-2024），屬可忽略的前視（母體每次至多差 1 列）。前向 M0 推論的百分位母體要用 M 軌全部列。
9. **CV 報告的文字更正**（報告不是檔案，更正寫在 `docs/SURGE-TRACKS-T1-2026-10-05.md`）：
   - 等名額對照的「134 對 128（+0.087pp）」用的是 HO 前選定的 R1（`final_lists`），不是依判定樹的最終清單；R1 在 HO-2023 屬面板起點限制。對應最終清單（R0＋S0，`proxy_lists`）的是 139 對 128，+0.159pp [−0.130, 0.433]。
   - S 的 T6 只寫「過」，沒有數字：逐日平均超額 +0.192% [−0.468, 0.883]、逐日中位數 −0.275%、勝日 47.3%。T6 是非劣性條件（上界 ≥ 0），通過只表示超額不顯著為負，**沒有超額報酬的證據**；S-KEEP 只代表代理 lift 的時間外複製。
   - 「超過 2 MB 的檔沒有 commit」見 DEV-005；「落選挑戰者…登錄只要求算選定的模型」見 DEV-006；「G0.9 全在 2026 鍵」見本筆第 2 點。
10. **名稱欄空白**：names.json 缺已下市或改名的代號（例如 5301、2358、4944、6457），鎖定記錄的 name 欄為空。補遺以官方上市（櫃）快照的現名、TWSE 終止上市名單補齊，查不到寫「來源未提供」（TPEx 終止上櫃名單來源未提供），並記 `name_src`。鎖定檔不改。
- **當下已看過的結果**：全部（判定已鎖）。**對判定的可能影響**：無（逐項如上）。

*未扣成本·非投資建議。*
