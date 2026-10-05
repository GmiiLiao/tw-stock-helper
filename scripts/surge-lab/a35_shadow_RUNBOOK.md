# a35 shadow — 影子漲停預測：指令手冊（只列做法與指令，不含結論）

**影子模式**：不取代、不修改站上預測（`scripts/ai-daemon.mjs`）；研究腳本不寫 Firestore，只有 `a35_shadow_publish.mjs` 寫 `surgeShadow/*`。新檔皆為 `scripts/surge-lab/a35_shadow_*`；輸出在 `out/` 與 `.surge-cache/a35_shadow_*`。
所有指令都在 `scripts/surge-lab/` 目錄下執行（`cd scripts/surge-lab`）。研究型 GBDT 與 a32 逐月前推的 OLD/ALL 協定相同，只把「月初」換成「打分日」。

## 檔案

| 檔案 | 用途 |
|---|---|
| `a35_shadow_lib.py` | 共用：live 特徵建構、訓練（3 seeds）、打分、凍結檔格式與 sha256 封印 |
| `a35_shadow_list.py` | **產生凍結名單** `out/shadow_{日}.json` |
| `a35_shadow_score.py` | **對答案**（下一交易日收盤後一條指令）；多檔時輸出合併統計 |
| `a35_shadow_history.py` | 歷史「若當時就用同一套」名單 `out/shadow_hist/shadow_{日}.json`（每週重訓） |
| `a35_shadow_site.mjs` | 唯讀讀站上 `limitUpForecast/pred-{日}`（憑證取自 daemon 的 launchd plist，不印出） |
| `a35_shadow_fetch.mjs` | 唯讀補抓下一交易日 `chipArchive/{日}` 收盤＋官方除權息（上市＋上櫃）→ `.surge-cache/a35_shadow_{close,exright}_{日}.json` |
| `a35_shadow_parity.py` / `a35_shadow_test.py` | 防呆：live 特徵 vs 資料集逐欄對照、重現 a32 快取分數；單元＋端對端測試 |
| `a35_shadow_daily.mjs` | **每日自動化協調器**（見下節）；決策邏輯在 `scripts/lib/surge-shadow-daily.mjs`（`node --test scripts/lib/surge-shadow-daily.test.mjs`） |
| `a35_shadow_matrix.py` | 訓練矩陣要不要重建（唯讀，印 JSON） |
| `a35_shadow_meta.mjs` | 唯讀中繼資料：Firestore 休市日曆；快取 chipArchive 某日的到齊狀態（與 daemon 定版閘門同一支判斷） |
| `launchd/com.gmii.twstock.surge-shadow.plist` | 排程（安裝屬持久設定，需使用者核可） |

## 協定（凍結名單）

- 目標：`m_y`＝隔日（s+1）收漲停；**母體不排除「s 當天已漲停」**（延續列是主要正例來源）。
- 特徵 124 欄（109 個 f_* 同日百分位＋8 個 f_mkt_* 原值＋x_lu_s／x_oneword_s／x_close_at_high／x_lu_streak／log 價／log 量／m_otc），欄序取 `a32_walkforward_meta.npz`。
- 訓練列：s′ ≤ 打分日索引 − 3 個交易日（標籤用 s′+1 ⇒ 最晚標籤日＝打分日 − 2）。
- 超參數：depth 4、600 棵、lr .05、l2 20、colsample .5、subsample .8、min_child_h 3；負例抽 15%（權重 1/.15）；seeds 1,2,3，各自對「打分日全列」z 化後平均。
- 排名母體（算同日百分位）＝打分日有收盤且已有 ≥125 日歷史的全部 4 碼個股（＝資料集母體扣掉需 s+1 資訊的兩條：s+1 有收盤、s+1 非結構斷點）。
- 可挑選名單（pool）＝`a30_live_list.py` 的 `elig_base & ~brk_past`（收盤 ≥10、20 日均量 ≥300 張、近 20 日無缺值、近 125 日無結構斷點），**不**排除已漲停、**不**套 T1 冷卻。
- 名單：整體前 30、上市前 30、上櫃前 30、新起漲前 30（打分日未漲停）、延續前 30（打分日已漲停）、研究母體前 30（不套流動性濾網）。每筆含分數、已漲停／一字鎖旗標。
- 凍結檔含：產生時間（Asia/Taipei）、訓練截止日、模型雜湊、站上同日 pred 前 30／前 120 名次／B 榜（優先 Firestore 唯讀，讀不到才用 `.surge-cache/lu_scoreboard.json`）、兩市當日漲跌停／成交值上下文、整份 canonical JSON 的 sha256。

## 指令

```bash
cd scripts/surge-lab

# 0. 防呆（只需偶爾跑）
python3 a35_shadow_test.py                         # 單元＋端對端（約 1 分鐘）
python3 a35_shadow_parity.py                       # live 特徵 vs 資料集（6 個日期）
python3 a35_shadow_parity.py --selftest            # 另外重現 a32 快取分數（約 3 分鐘）

# 1. 產生凍結名單（已存在不覆蓋；快取模型在 .surge-cache/a35_models，重現性檢查加 --no-reuse --out 另一路徑）
python3 a35_shadow_list.py --day 2026-10-02 --target-day 2026-10-05 --workers 3

# 2. 週一（2026-10-05）收盤後對答案——只要這一條（面板沒有 10-05 時會唯讀補抓收盤＋除權息）
python3 a35_shadow_score.py out/shadow_2026-10-02.json --fetch
#    → 終端表格＋ out/shadow_score_2026-10-02.json；收盤檔數不足（上櫃延遲）會拒絕，--allow-incomplete 才放行

# 3. 歷史 would-have-been（2026-07-16～10-01，每 ISO 週重訓一次；--retrain daily 為精確協定、約 4～5 倍時間）
python3 a35_shadow_history.py --from 2026-07-16 --to 2026-10-01 --workers 6 --retrain weekly
python3 a35_shadow_score.py 'out/shadow_hist/shadow_*.json' --quiet-days --out out/shadow_hist_score_pooled.json

# 4. 演練（舊日期對，面板已有隔日）
python3 a35_shadow_score.py out/shadow_hist/shadow_2026-10-01.json
```

## 每日自動化（2026-10-04 起：`a35_shadow_daily.mjs`＋LaunchAgent）

協調器每個時段跑一次（平日 17:30／19:30／21:00／22:40／23:50，週二～週六 07:05 補跑），可重入、冪等：

1. 鎖（`scripts/surge-lab/.a35_shadow_daily.lock`，固定位置、與快取無關：排程與手動演練互斥）＋前置：研究用環境變數（`SURGE_OFFICIAL_LIMIT／SURGE_REVENUE／SURGE_PIT_STRICT／SURGE_DATASET_SUFFIX`）有設、或研究程序（cv_official／build_v2／official_features／retrain_official／save_scores／build_lu1／a32_walkforward_prep／panel.py…）正在跑 ⇒ 本輪不做（被擋的時刻記入狀態檔 `preflightBlocks`；若因此錯過期限，缺口原因會寫「研究程序占用共用快取」）。
2. 唯讀 Firestore：休市日曆、最近 chipArchive 的到齊狀態——收盤＋法人（`canonical-gate.archiveDayStatus`）**與模型輸入**（資券上市＋上櫃、借券上市＋上櫃、上市當沖；`surge-shadow-daily.modelInputsStatus`，樣本同 daemon 寫入端）——以及 `limitUpForecast/pred-D` 是否已定版（`canonicalAt`）。D＝三者都到齊＋還沒有名單；**現在 ≥ 下一交易日 08:45 ⇒ 記為缺口（missed），不產生**。資券／借券／當沖 19:45～21:49 才進歸檔 ⇒ 正常交易日最早 22:40 那一輪產生（17:30～21:00 只對答案）。整天沒有歸檔、之後的交易日卻有歸檔 ⇒ `suspectedClosures`（疑似颱風假等臨時休市，不算缺口；休市日曆補上後自動剔除）。
3. `fetch_cache.mjs`（明確指定 SURGE_CACHE；priceEvents 為累積檔）→ `panel.py` → 缺的除權息 `a35_shadow_fetch.mjs d --no-close`（每輪最多 5 天、每天 2 個請求、間隔 ≥3 秒）。
4. 每份還沒對答案、**有效目標日**（以現在的休市日曆重算；封印後才補進日曆的臨時休市會順延）收盤已到齊的事前凍結名單 ⇒ `a35_shadow_score.py`（失敗不中止；與封印 targetDay 不同者記 `targetShifts`）。
5. `a35_shadow_matrix.py --day D` 判斷訓練矩陣要不要重建（最晚 s < idx(D)−3、面板不是矩陣日期的延伸、沒有建置側檔、dataset 建置時帶研究用環境變數、或**任一輸入**與上線不同——`surge_inputs.input_manifest`：營收、exright-history、exright_delta、priceEvents、產業、市場別、逐日補抓除權息）⇒ `SURGE_SHADOW_EXTRA_EXRIGHT=1 build_lu1.py` → `a32_walkforward_prep.py`。逐日補抓的除權息每天新增一份 ⇒ 實務上每個交易日都會重建（約 1 分鐘；還原價是回溯調整，歷史列本來就會變）。
6. `a35_shadow_list.py --day D --target-day 下一交易日 --workers 3 --require-matrix-sidecar`（永不 `--force`；模型輸入未到齊以結束碼 5 拒絕）。
7. `a35_shadow_publish.mjs`（永不 `--allow-replace`；out/ 沒變就略過）→ 若有 `surge_lab_publish.mjs` 則 `--only mirror,pipeline`。
8. 狀態 `out/a35_shadow_daily_status.json`（lastRunAt、D、nextTD、steps[{name,ok,ms,err}]、missed[]、suspectedClosures[]、targetShifts[]、preflightBlocks[]、revenueSha256、dataBasis）。

```bash
node scripts/surge-lab/a35_shadow_daily.mjs --dry-run                          # 只印這一輪會做什麼（唯讀 Firestore；不取鎖、不寫檔）
node scripts/surge-lab/a35_shadow_daily.mjs --dry-run --now 2026-10-05T17:30   # 假設時刻（只限 dry-run）
# 演練（快取複本；不發佈；輸出寫 <快取>-out-rehearsal，正式 out/ 不動）——--cache 正式執行必須帶 --no-publish
cp -c -R scripts/surge-lab/.surge-cache /path/to/cache-copy
node scripts/surge-lab/a35_shadow_daily.mjs --cache /path/to/cache-copy --no-publish   # → /path/to/cache-copy-out-rehearsal/
```

凍結檔新增的資料依據欄位（封印涵蓋）：`targetDayBasis`（休市日曆來源）、`freezeDeadline`、`dataBasis`（打分日歸檔是否兩市官方、上櫃收盤是否含 Yahoo 補洞、模型輸入 `inputsReady／inputsMissing／inputCounts`）、
`revenueSha256`、`exrightCoverage`、`featureData`（矩陣內容雜湊、輸入清單 `inputs`、與矩陣建置時不同的輸入 `inputsDiff`、一致性）。模型快取鍵含特徵資料簽章（矩陣內容＋輸入清單），矩陣或任一輸入變了就不會誤用舊模型；
`modelHash` 仍只由訓練列簽章＋模型內容決定（同資料重產逐位相同，已驗 2026-10-02）。

## 手動產生下一個交易日的名單（例：2026-10-05 盤後；自動化未安裝時）

```bash
cd /Users/gmii/Documents/股票助手app/tw-stock-app/scripts/surge-lab      # 所有指令都在這個目錄跑
export SURGE_CACHE="$PWD/.surge-cache"                                    # 明確指定（fetch_cache 2026-10-04 前預設寫到 cwd/.surge-cache）
export GOOGLE_APPLICATION_CREDENTIALS="$(/usr/bin/plutil -extract EnvironmentVariables.GOOGLE_APPLICATION_CREDENTIALS raw ~/Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist)"
node fetch_cache.mjs "$SURGE_CACHE"                # Firestore → 研究快取（唯讀；chipArchive 全量，數分鐘）
python3 panel.py                                   # → panel.npz（含新的一天；兩市收盤要到齊才跑）
node a35_shadow_fetch.mjs 2026-10-05 --no-close    # 補官方除權息（上市＋上櫃；exright_delta.json 只有上市）
python3 a35_shadow_matrix.py --day 2026-10-05      # rebuild=true 就先 SURGE_SHADOW_EXTRA_EXRIGHT=1 python3 build_lu1.py && python3 a32_walkforward_prep.py
python3 a35_shadow_list.py --day 2026-10-05        # 目標日由休市日曆推得（10-09、10-26 補假）；過了目標日 09:00 會拒寫並記缺口
```

`python3` 必須是有 numpy 的 3.14（`/Library/Frameworks/Python.framework/Versions/3.14/bin/python3`）。
`panel.py`、`build_lu1.py`、`a32_walkforward_prep.py`、`fetch_cache.mjs` 都改成原子寫入（暫存檔＋rename），但仍會改寫研究共用的 `.surge-cache`——研究重訓請用隔離的快取目錄（`SURGE_CACHE=…/.surge-cache-L`）。
`SURGE_SHADOW_EXTRA_EXRIGHT=1` 只給起漲影子的矩陣重建用：研究 build 不設，資料集與 main 逐位相同（2026-10-04 起不再寫進 build.load_factor_events）。
手動產生的名單要 `dataBasis.inputsReady=true`（資券／借券／當沖已進歸檔，通常 21:49 後），否則 frozen-forward 以結束碼 5 拒絕。

## 產物（2026-10-04 產生）

- `out/shadow_2026-10-02.json`：週一（10-05）要對答案的**凍結名單**（訓練截止 2026-09-29；以最終程式碼產生）。`out/shadow_2026-10-02.v1-before-tpex-exright-fix.json` 是 03:44 的第一版（當時研究快取缺上櫃 09-30～10-02 的除權息，3 檔上櫃股特徵略有不同；整體前 30 的成員與順序相同），保留供稽核，**不要拿來對答案**。
  兩份都可用 `python3 -c "import json,a35_shadow_lib as L; print(L.verify_seal(json.load(open('out/shadow_2026-10-02.json'))))"` 驗封印。
- `out/shadow_hist/shadow_{2026-07-16..2026-10-01}.json`（54 份，kind=historical-would-have-been，每週重訓：12 個截止日 × 3 seeds）、`out/shadow_hist_score_pooled.json`＋`_days.csv`（合併對答案）、`out/shadow_score_2026-10-01.json`（單日演練）。
- 模型快取 `.surge-cache/a35_models/*.pkl`（39 個，同截止日＋同訓練列簽章才會重用；`--no-reuse` 重訓結果逐位相同——已驗證）。

## 已知限制

- 研究快取的除權息表（`exright_delta.json`）只有上市；上櫃 2026-09-30～10-02 的除權息已由 `a35_shadow_fetch.mjs` 補進 `.surge-cache/a35_shadow_exright_*.json`，`build_ctx` 會自動合併（同檔同日不重複套用）。對答案日的除權息若沒補，scorer 會警告。
- 漲停真值＝`build.build_events`（除權息參考價＋檔位）；站上 daemon 規則（前收×1.1 以前收檔位取整）另列交叉檢查，不一致的檔列在輸出 JSON 的 `truth.disagreeWithDaemonRule`。
- 站上 `pred-2026-10-02` 於 17:39 寫入（當時上櫃收盤尚未到齊，候選池僅上市）；影子名單含上櫃。比較兩者時以「上市單獨」「整體」兩種口徑並列。
- 單日樣本很小（每日 10／30 檔）：單日結果只當紀錄，判斷用多日合併（Wilson／5 日區塊 bootstrap）。非投資建議。

## T1 分軌前向影子（2026-10-05 接線；協調器 ⑦b 步驟；登錄 `tracks/REGISTRATION_t1_tracks_forward.md`）

- 總開關 `tracks/forward_config.json`：`enabled` 為布林 `true` 且 `startDay`（第一個決策日）有值才會凍結；預設停用（磁碟即部署）。
- 前向專用快取 `.surge-cache-F`（第一次從 `.surge-cache-T` 以 cp -c 播種；之後只增不改）；本機紀錄 `out/tracks_fwd/`；後台 `surgeShadow/tracks-*`。
- 凍結條件（看資料、不看時鐘；期限＝下一交易日 09:00）：兩市收盤＋法人官方到齊且無第三方補洞（C1）、凍結面板上市 ≥ 800／上櫃 ≥ 500 檔有收盤（C1b）、
  官方漲停價檔 TWT84U(s)／dailyQuotes(前一交易日)（C2）且兩市覆蓋率 ≥ 95%（C2b）、除權息補抓涵蓋、上市快照、登錄雜湊與釘選（C7）、
  接線前證明（`out/tracks_fwd/tracks_fwd_prewire.json`：**必須在主 checkout 跑**，綁定前向快取路徑、鏡像根目錄與程式 sha256；
  處置／注意重疊比對只接受 pass，每輪自動重算）。分區 assertion 失敗（C6）當日直接寫缺口。過期就寫缺口，永不補產。
- 告警：`out/tracks_fwd/_alerts/LATEST.json`（每輪覆寫）；釘選不符、接線前證明不成立、新缺口、C6、程式失敗記成 `tracks-health` 步驟失敗（a35 狀態檔與後台可見）。
- 本機紀錄全部不進版控；逐位副本在 `surgeShadow/tracks-raw-*`（發佈時讀回比對 sha256）。本機目錄遺失：`node a37_tracks_publish.mjs --restore`（只補不存在的檔）。
- 偏差紀錄：`tracks/DEVIATIONS_t1_tracks_forward.md`（FDEV-001～006）。G60 HALT 的使用者裁定寫成一行 `G60-RULING: CONTINUE <日期> …`。
- 釘選的 17 個檔（`implementation_pins`）不可隨意改：pre-commit `scripts/check-tracks-pins.mjs` 會擋；要改先寫前向偏差＋`PIN-UPDATE` 列。

```bash
cd scripts/surge-lab
# 接線前證明（上市快照、漲跌停增量＝全量、處置／注意鏡像重疊比對、≥5 個歷史日研究路徑 parity）；手動執行會取協調器同一把鎖
SURGE_CACHE=$PWD/.surge-cache-F SURGE_TRACKS_SHARED=$PWD/.surge-cache SURGE_TRACKS_OUT=$PWD/out/tracks_fwd \
  /Library/Frameworks/Python.framework/Versions/3.14/bin/python3 a37_tracks_fwd.py prewire
# 測試
/Library/Frameworks/Python.framework/Versions/3.14/bin/python3 a37_tracks_fwd_test.py
node --test ../lib/surge-tracks-daily.test.mjs ../lib/surge-tracks-report.test.mjs ../lib/tracks-pins.test.mjs a37_tracks_publish.test.mjs
# 協調器乾跑（會印出分軌的凍結／缺口／等待／到期評分）
node a35_shadow_daily.mjs --dry-run
# 發佈乾跑（只印文件數與大小、逐位副本本機往返，不寫 Firestore）
node a37_tracks_publish.mjs --dry-run
```
