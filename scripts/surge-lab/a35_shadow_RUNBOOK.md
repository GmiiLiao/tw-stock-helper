# a35 shadow — 影子漲停預測：指令手冊（只列做法與指令，不含結論）

**影子模式**：不取代、不修改站上預測（`scripts/ai-daemon.mjs`）、不寫 Firestore。新檔皆為 `scripts/surge-lab/a35_shadow_*`；輸出在 `out/` 與 `.surge-cache/a35_shadow_*`。
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

## 下一個交易日再產生新名單（例：2026-10-05 盤後）

```bash
cd /Users/gmii/Documents/股票助手app/tw-stock-app
export GOOGLE_APPLICATION_CREDENTIALS="$(python3 - <<'PY'
import plistlib, os
print(plistlib.load(open(os.path.expanduser('~/Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist'),'rb'))['EnvironmentVariables']['GOOGLE_APPLICATION_CREDENTIALS'])
PY
)"
node scripts/surge-lab/fetch_cache.mjs            # Firestore → .surge-cache（唯讀；chipArchive 全量，數分鐘）
cd scripts/surge-lab && python3 panel.py          # → panel.npz（含新的一天；兩市收盤要到齊才跑）
for d in 2026-10-05; do node a35_shadow_fetch.mjs $d --no-close; done    # 補官方除權息（上市＋上櫃；exright_delta.json 只有上市）
python3 a35_shadow_list.py --day 2026-10-05          # 訓練資料矩陣不必重建：最晚訓練列 s′＝10-05 − 3 個交易日＝09-30，現有矩陣已到 s=10-01
```

訓練矩陣（`a32_walkforward_X.npy`）只在需要比目前矩陣更新的訓練日時才要重建：`python3 build_lu1.py && python3 a32_walkforward_prep.py`（腳本會檢查日期序列是否為面板的前綴、並在涵蓋不足時中止）。
`panel.py` 會覆寫共用的 `.surge-cache/panel.npz`，其他研究腳本也讀它——日期只往後增加所以索引不變。

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
