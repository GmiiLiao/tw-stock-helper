# surge-lab — 起漲特徵實驗室（2026-10-02）

連 2 日漲停／5 日連漲 ≥30% 的個股，起漲前一天有什麼特徵？能不能事前挑出來？
完整報告：[`docs/SURGE-FEATURE-LAB-2026-10-02.md`](../../docs/SURGE-FEATURE-LAB-2026-10-02.md)。**純研究、唯讀**——不寫 Firestore、不動 daemon、未接進任何線上功能。

## 重現順序

```bash
export SURGE_CACHE=$PWD/scripts/surge-lab/.surge-cache   # 預設即此路徑；所有腳本共用
node scripts/surge-lab/fetch_cache.mjs       # 1. Firestore → 本機快取（唯讀）
cd scripts/surge-lab
python3 panel.py                             # 2. 快取 → 對齊矩陣 panel.npz
python3 build.py                             # 3. 還原、事件、母體、117 個特徵 → dataset.npz
python3 pit_check.py                         # 4. 前視偏誤檢查（必須印「不一致 0 個」）
python3 test_models.py                       # 5. 自製 GBDT／指標的正確性測試（合成資料）
python3 sanity.py                            #    事件漏斗與抽樣檢查
python3 a1_catalog.py                        # 6. 事件目錄
python3 a2_univariate.py                     #    單變量（同日百分位＋依日 bootstrap）
python3 a5_conditions.py                     #    經典條件同日調整 lift（間接標準化 O/E）
python3 a6_timing.py                         #    同股自比（時點訊號）
python3 a7_regime.py; python3 a11_calendar_price.py; python3 a14_orderflow.py   # 大盤／曆法／委託失衡
python3 tune.py                              # 7. 超參數（只用 2024Q4 折）
python3 run_cv.py                            #    滾動外樣本驗證 → oof.npz
python3 a3_eval.py; python3 a4_backtest.py; python3 a12_stoploss.py; python3 a13_robust.py
python3 run_ablation.py; python3 a8_extra.py; python3 a9_placebo_importance.py; python3 a10_checklist.py
python3 a15_blockboot.py; python3 a16_dt_universe.py     #    區塊 bootstrap CI；排除處置股近似母體重驗
python3 export_events.py                     # 8. out/*.csv
```

## 檔案

| 檔案 | 用途 |
|---|---|
| `panel.py` | chipArchive 快取 → (日期×代號) 矩陣 |
| `build.py` | 還原（除權息＋priceEvents）、漲停判定、事件／母體／標籤、特徵（全 PIT） |
| `models.py` / `evallib.py` | 純 numpy 的直方圖 GBDT、L2 邏輯迴歸；同日 AUC、每日前 K 名、實際進出場報酬、依日 bootstrap |
| `groups.py` / `conds.py` | 特徵分群、經典技術條件清單 |
| `pit_check.py` / `test_models.py` / `sanity.py` | 防呆：前視、模型正確性、事件定義 |
| `out/` | 事件清單（`surge_events_all.csv` 全市場起漲日、`surge_events_model.csv` 母體內事件含起漲前特徵、`surge_controls_sample.csv` 對照抽樣） |

環境沒有 sklearn／scipy／lightgbm，模型全為自製（`test_models.py` 驗證 GBDT 可接近合成資料的理論上限）。

## 已知偏差與待辦（2026-10-02 獨立審查）

- **母體排除用到少量未來資訊**：`build.py` 的 `Bmark`／`recent` 以 `B_start[v]`（需 v+4 日價格）排除 s−3～s 日已起漲但尚在途中的 B 型段落（2,148 列）。已量化影響很小（同日 AUC −0.0016、lift@10 −0.15），**未重跑**。修法：冷卻只用已完成標記（`B_start` 須 v ≤ s−4），改完需整條重跑並更新報告數字。
- `days_since_lu` 的「從未漲停」目前是 NaN（GBDT 分到最左箱，與「剛漲停」同側）；建議改填大值（如 999）。
- 停損成交假設見 `a12_stoploss.py`（四種，台股無交易所停損單）。

## v2（2026-10-02 使用者重新定義條件）

兩個**各自獨立**的目標，只找「起漲前日」，不含停損停利與續抱：**T1**＝連續漲停 ≥2 日；**T2**＝連 5 日收盤上漲且累計 >35%。排除 2025-04-07～04-10（急殺＋反彈；新聞識讀列為必要前置條件）；區段內日期與區段後 10 日冷卻不用。報告：[`docs/SURGE-FEATURE-LAB-v2-2026-10-02.md`](../../docs/SURGE-FEATURE-LAB-v2-2026-10-02.md)。

```bash
python3 test_v2.py                                    # 區段／冷卻邏輯的合成資料測試
python3 build_v2.py                                   # → dataset_t1.npz、dataset_t2.npz（T2 含 m_extra=1 的進行中區段列，訓練不用）
for t in t1 t2; do                                    # 以 SURGE_DATASET 切換目標；輸出檔名自動加後綴 _t1／_t2
  export SURGE_DATASET=dataset_$t.npz
  python3 tune.py                                     # 2024Q4 折選超參數
  python3 run_cv.py                                   # 滾動外樣本驗證 → oof_$t.npz
  python3 eval_v2.py                                  # 指標＋區塊 CI＋敏感度＋固定持有期報酬（無停損停利）
  python3 a2_univariate.py; python3 a5_conditions.py  # 起漲前日特徵：單變量、經典條件
  python3 a9_placebo_importance.py                    # 安慰劑、2026 保留期、置換重要度
  python3 a10_checklist.py                            # 2023–24 選條件、2025–26 驗證的檢核表
  python3 a16_dt_universe.py                          # 排除疑似處置（當沖資料有值）近似母體重驗
  python3 a17_nodir.py                                # 拿掉當日方向類特徵（T2 定義產物檢查）
done
```

v2 差異：冷卻只用已完成的區段（不再用 s 之後才確定的標記）；`days_since_lu` 從未漲停填 999；`evallib.load(primary_only=True)` 排除 T2 額外列。

## 處置股官方名單驗證（2026-10-02）

驗證「當沖資料缺值＝處置」代理（結論：代理錯誤，缺值 89% 是上櫃股）。報告：[`docs/SURGE-DISPOSAL-VERIFY-2026-10-02.md`](../../docs/SURGE-DISPOSAL-VERIFY-2026-10-02.md)。

```bash
node scripts/surge-lab/fetch_disposal.mjs $SURGE_CACHE 2022-07 2026-10   # 官方處置名單（唯讀、2 秒間隔、驗證回聲；兩網域皆已登錄核准）
python3 a18_disposal_verify.py            # 處置矩陣（disposal.py）＋代理精確度／召回、區間長度
python3 a19_dt_missing_source.py          # 缺值來源（需 code_market.json＝Firestore finReports.market，唯讀）
SURGE_DATASET=dataset_t1.npz python3 a20_disposal_events.py   # 事件 × 處置狀態／市場別、前 10 名構成（T2 同理）
SURGE_DATASET=dataset_t1.npz python3 a21_disposal_models.py   # AI 候選池口徑重驗、處置歷史特徵、市場別拆分
```

## 注意股名單（2026-10-03）

報告：[`docs/SURGE-ATTENTION-2026-10-03.md`](../../docs/SURGE-ATTENTION-2026-10-03.md)。注意股第 1 款＝最近 6 日單日報酬加總（已驗證 96～97%）。

```bash
node scripts/surge-lab/fetch_attention.mjs $SURGE_CACHE 2022-07 2026-10   # 官方注意股（唯讀、2 秒間隔、驗證回聲與筆數）
python3 a22_attention_catalog.py          # 目錄、與 T1/T2 的先後、注意→處置升級（attention.py 解析）
python3 a23_attention_timeline.py         # 起漲前後時間軸、單一指標（前 5 日報酬加總）
python3 build_at.py                       # 「進入注意股」資料集（h=1/3/5/10）
for lab in "" yh3 yh5 yh10; do SURGE_DATASET=dataset_at.npz SURGE_LABEL=$lab python3 run_cv.py; done
python3 eval_at.py; python3 a26_attention_models.py   # 提前量曲線；跨目標、注意股歷史特徵增益
python3 a27_calibration.py                # S5 → 隔日進注意的校準（其中「累計次數」升級表已作廢）
python3 a28_third_target.py               # 第三目標 ATT10 與 T1/T2 交叉驗證、集成
python3 a29_pit_escalation.py             # 前視安全的注意→處置升級（官方規則模擬；2026-10-02 官方名單 9/9 吻合）
python3 export_attention_calibration.py 2026-10-03   # → scripts/data/attention-calibration.json（正式程式 scripts/lib/attention-risk.mjs 讀取）
```

⚠ 官方「累計次數」欄位不是個股累計次數（上市＝查詢區間內列數、含之後的公告；上櫃＝當日公告總股數），不要拿來做特徵或分級。

快取：預設 `scripts/surge-lab/.surge-cache/`（已 gitignore；約 1.3GB，排名快取 ranks*.npy 未保留、會自動重建），或以 `SURGE_CACHE` 指定。

## 2026-10-03 修正：priceEvents 重複還原＋實盤名單

- `panel.py` 舊版先套一次 priceEvents，`build.adjust` 又套一次 ⇒ 24 檔減資／面額變更股被乘兩次，事件日被誤判結構斷點（26 個事件日中 25 個；修正後 2 個）、8 個假漲停。現在面板只存原始價，還原只在 `build.adjust` 做一次。T1 外樣本總成績不變（同日 AUC 0.815、lift@10 8.30）。
- `exright-history.json` 止於 09-30；`.surge-cache/exright_delta.json`（`fetch_exright_delta.mjs`）補上市 09-30～10-02，上櫃端點 10-03 連不上，尚缺。
- `a30_live_list.py 日期…`：以驗證同一程序訓練到「打分日 −11 個交易日」、對指定日全母體打分，對下一交易日的實際漲停，並把前 50 名凍結到 `out/live_lists_*.json`（附 sha256）供下一交易日對答案。
