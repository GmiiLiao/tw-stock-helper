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

1. 鎖（`.surge-cache/a35_shadow_daily.lock`）＋前置：研究用環境變數（`SURGE_OFFICIAL_LIMIT／SURGE_REVENUE／SURGE_PIT_STRICT／SURGE_DATASET_SUFFIX`）有設、或研究程序（cv_official／build_v2／official_features／retrain_official／save_scores／build_lu1／a32_walkforward_prep／panel.py…）正在跑 ⇒ 本輪不做。
2. 唯讀 Firestore：休市日曆、最近 chipArchive 的到齊狀態（`canonical-gate.archiveDayStatus`）、`limitUpForecast/pred-D` 是否已定版（`canonicalAt`）。D＝到齊＋定版＋還沒有名單；**現在 ≥ 下一交易日 08:45 ⇒ 記為缺口（missed），不產生**。
3. `fetch_cache.mjs`（明確指定 SURGE_CACHE）→ `panel.py` → 缺的除權息 `a35_shadow_fetch.mjs d --no-close`（每輪最多 5 天、每天 2 個請求、間隔 ≥3 秒）。
4. 每份還沒對答案、目標日收盤已到齊的事前凍結名單 ⇒ `a35_shadow_score.py`（失敗不中止）。
5. `a35_shadow_matrix.py --day D` 判斷訓練矩陣要不要重建（最晚 s < idx(D)−3、面板不是矩陣日期的延伸、沒有建置側檔、或建置時的 revenue.json 與目前不同）⇒ `build_lu1.py` → `a32_walkforward_prep.py`。
6. `a35_shadow_list.py --day D --target-day 下一交易日 --workers 3 --require-matrix-sidecar`（永不 `--force`）。
7. `a35_shadow_publish.mjs`（永不 `--allow-replace`；out/ 沒變就略過）→ 若有 `surge_lab_publish.mjs` 則 `--only mirror,pipeline`。
8. 狀態 `out/a35_shadow_daily_status.json`（lastRunAt、D、nextTD、steps[{name,ok,ms,err}]、missed[]、revenueSha256、dataBasis）。

```bash
node scripts/surge-lab/a35_shadow_daily.mjs --dry-run                          # 只印這一輪會做什麼（唯讀 Firestore；不取鎖、不寫檔）
node scripts/surge-lab/a35_shadow_daily.mjs --dry-run --now 2026-10-05T17:30   # 假設時刻（只限 dry-run）
```

凍結檔新增的資料依據欄位（封印涵蓋）：`targetDayBasis`（休市日曆來源）、`freezeDeadline`、`dataBasis`（打分日歸檔是否兩市官方、上櫃收盤是否含 Yahoo 補洞）、
`revenueSha256`、`exrightCoverage`、`featureData`（矩陣內容雜湊、建置時營收雜湊、一致性）。模型快取鍵含特徵資料簽章（矩陣內容＋revenue.json），矩陣或營收變了就不會誤用舊模型；
`modelHash` 仍只由訓練列簽章＋模型內容決定（同資料重產逐位相同，已驗 2026-10-02）。

## 手動產生下一個交易日的名單（例：2026-10-05 盤後；自動化未安裝時）

```bash
cd /Users/gmii/Documents/股票助手app/tw-stock-app/scripts/surge-lab      # 所有指令都在這個目錄跑
export SURGE_CACHE="$PWD/.surge-cache"                                    # 明確指定（fetch_cache 2026-10-04 前預設寫到 cwd/.surge-cache）
export GOOGLE_APPLICATION_CREDENTIALS="$(/usr/bin/plutil -extract EnvironmentVariables.GOOGLE_APPLICATION_CREDENTIALS raw ~/Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist)"
node fetch_cache.mjs "$SURGE_CACHE"                # Firestore → 研究快取（唯讀；chipArchive 全量，數分鐘）
python3 panel.py                                   # → panel.npz（含新的一天；兩市收盤要到齊才跑）
node a35_shadow_fetch.mjs 2026-10-05 --no-close    # 補官方除權息（上市＋上櫃；exright_delta.json 只有上市）
python3 a35_shadow_matrix.py --day 2026-10-05      # rebuild=true 就先 python3 build_lu1.py && python3 a32_walkforward_prep.py
python3 a35_shadow_list.py --day 2026-10-05        # 目標日由休市日曆推得（10-09、10-26 補假）；過了目標日 09:00 會拒寫並記缺口
```

`python3` 必須是有 numpy 的 3.14（`/Library/Frameworks/Python.framework/Versions/3.14/bin/python3`）。
`panel.py`、`build_lu1.py`、`a32_walkforward_prep.py`、`fetch_cache.mjs` 都改成原子寫入（暫存檔＋rename），但仍會改寫研究共用的 `.surge-cache`——研究重訓請用隔離的快取目錄（`SURGE_CACHE=…/.surge-cache-L`）。

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
