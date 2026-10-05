# T1 分軌前向影子：事前登錄修訂 v1.1（封存並凍結）——保留驗證期作廢（HO-BURNED）後 S0／S_FB 改只觀察

| 項目 | 內容 |
|---|---|
| 登錄編號 | `T1-TRACKS-FWD-2026-10-05`（**version 1.1，SEALED・FROZEN**；修訂 v1，v1 兩個檔一字不改） |
| 登錄日 | 2026-10-05（任何前向決策日之前） |
| 修訂對象 v1 | `REGISTRATION_t1_tracks_forward.md`＋`registration_t1_tracks_forward.json`（正規化 sha256 `ec1a0bf87b6643bbff37b59ca346bd1746f7d500dbc402a02222343450fcae26`，檔案位元組 `6382ac00…be1a`，封存 commit `0a022ad`） |
| 母登錄 | `T1-TRACKS-PREREG-2026-10-04` v2（sha256 `065a92c6…c3e3`）；HOLDOUT 鎖檔 `tracks_t1_HO_LOCK.json`（不改） |
| 依據 | 使用者 2026-10-05 裁定（`DEVIATIONS_t1_tracks.md` **DEV-014**）：三筆鎖後 HOLDOUT 讀取全部計入兩次上限 ⇒ v2 §8.3 **HO-BURNED** |
| 前向偏差 | `DEVIATIONS_t1_tracks_forward.md` **FDEV-008** 指向本修訂（FDEV-007 保留給分支 `claude/tracks-fwd-dispatt`） |
| 分支／基底 | `claude/tracks-ho-burned`；基底 `e31c40564fb76d92b8dce77cb25c6f8984a479a9` |
| 機器可讀版 | `scripts/surge-lab/tracks/registration_t1_tracks_forward_v1_1.json`（兩份有出入時以 JSON 為準） |
| **JSON 封存雜湊（sha256）** | **`db8e088beb29804b2ae585877944c95da00f7537d16009c4447bc0147f9ca274`** |
| JSON 檔案位元組 sha256 | `54306ce532c993874ab8747d605c54fa2dde7a6178555f57c6c509e733468313` |
| 釘選 | 沿用 v1 的 17 個 `implementation_pins`（正規化 sha256 `34947ca34c47919dc0463ec981e163bd6fe4efef3bef2979e472cf131ea2cbd7`）；本修訂不改任何釘選檔 |

雜湊算法同 v1／v2。前向程式開跑前先以 `a36_tracks_fwd_rules.load_forward_registration()` 驗 v1，再以 `a37_tracks_reg.load_amendment()` 重算本 JSON 的雜湊並與上表比對（另核對 registration_id、version、修訂對象雜湊、釘選摘要與覆寫範圍），任一不符就拒跑：

```python
import json, hashlib
obj = json.load(open('scripts/surge-lab/tracks/registration_t1_tracks_forward_v1_1.json'))
hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
```

> **凍結**：這次 commit 之後本檔與 JSON 都不得再改；要再改清單、判定規則或門檻就另立新的封存版本（新檔）。偏差只能寫進前向偏差紀錄（只增不改）。
> 封存時**沒有任何前向資料**：`forward_config.json` 為 `enabled:false`、`startDay:null`；正式輸出 `out/tracks_fwd/` 只有接線前證明與狀態檔，沒有任何 core、缺口、評分或 parity 檔；2026-10-05 之後的價格、標籤、報酬都沒有讀過。v1 規定「清單、判定規則與門檻在第一個決策日之後不得更改（要改就另立登錄）」——本修訂在第一個決策日之前另立。
> 研究登錄，**非投資建議**。所有報酬比較一律未扣成本。**本登錄不產生任何可交易名單。**

---

## 0. 為什麼要修訂

v1 依 G1 決定把**判定為 KEEP 的兩份代理清單**（S0、S_FB）以「觀察／研究榜」放進前向影子。使用者 2026-10-05 裁定：鎖後三筆 HOLDOUT 讀取（DEV-008 第 1 點、DEV-012、DEV-010）全部計入 v2 §8.2 第 8 點「最多允許兩次修正重跑」的上限（合計 3 次）⇒ 依 v2 §8.3 宣告 **HO-BURNED**：HOLDOUT 不再作任何確認，判定上限 Mp＝MP-REJECT、R／S＝WATCH-ONLY（代理對 RAND 的點估計 ≤ 0 時為 REJECT）、S_FB＝SFB-WATCH-ONLY、DD＝DD-INCONCLUSIVE，之後只能靠前向 G250 升級。

| 軌 | 鎖檔判定 | HO-BURNED 後 |
|---|---|---|
| M | M-UNCHANGED | M-UNCHANGED |
| Mp | MP-REJECT | MP-REJECT |
| R | R-WATCH-ONLY | R-WATCH-ONLY |
| **S** | S-KEEP-AS-SHADOW | **S-WATCH-ONLY** |
| **S_FB** | SFB-KEEP-AS-SHADOW | **SFB-WATCH-ONLY** |
| DD | DD-INCONCLUSIVE | DD-INCONCLUSIVE |
| W | W-WATCH-ONLY | W-WATCH-ONLY |

「點估計 ≤ 0 時為 REJECT」指的是 v2 決策樹 R-REJECT／S-REJECT 列的同一個量：**HO 上** Δprecision@5(代理 − RAND)，代理類用 HOLDOUT 全部 347 日（v2 §8.1）。R0 +0.934pp、S0 +1.114pp 都 > 0 ⇒ WATCH-ONLY，不是 REJECT；SEL（+0.589、+0.930）、HC（+0.586、+1.519）與 HO 兩個年段也都 > 0，結論不受視窗解讀影響（DEV-014）。

**時間外證據的現況**：除了前向資料，沒有任何乾淨的時間外證據——SELECTION（2025）用於選模，HALF-CONFIRM（2026-01～09）已污染，HOLDOUT（2023-08～2024-12）已燒掉。三個視窗的數字都只作描述；前向 G250（EXTEND 者 G500）是唯一能讓任何清單升級的證據。

## 1. 改了什麼（其餘全部沿用 v1）

| 項目 | v1 | v1.1 |
|---|---|---|
| S0_atr14@5 判定 | S-KEEP-AS-SHADOW（研究榜） | **S-WATCH-ONLY**（灰底只觀察） |
| S0 標籤 | 觀察／研究榜·代理 lift 的時間外複製·容量受限·不可交易·待前向確認 | **只觀察（保留驗證期作廢·待前向 G250）**·容量受限·不可交易（灰底；介面不顯示報酬，研究記錄照算） |
| S0 區塊標題 | S 小量軌・觀察／研究榜（S0 atr14 前 5） | 灰底・S0 小量軌 atr14 前 5（只觀察） |
| SFB_atr14@5 判定 | SFB-KEEP-AS-SHADOW（探索性研究榜） | **SFB-WATCH-ONLY**（探索性、灰底只觀察） |
| S_FB 標籤 | 探索性·（同 S0） | 探索性·只觀察（保留驗證期作廢·待前向 G250）·容量受限·不可交易（灰底；…） |
| S_FB 區塊標題 | S_FB・觀察／研究榜（探索性；Mp 列 atr14 前 5） | 灰底・S_FB Mp 列 atr14 前 5（探索性；只觀察） |
| S0／S_FB 的 G250 | 維持檢定：CONFIRM／EXTEND／DROP（DROP＝降為 WATCH-ONLY） | **升級檢定**：UPGRADE／EXTEND／STAY-WATCH（UPGRADE＝升為 KEEP-AS-SHADOW） |
| 進前向影子的研究榜 | S0、S_FB | **無**；四份代理清單（S0、S_FB、R0、W）全部灰底只觀察 |

**不變**：範圍（不部署、不改 LaunchAgent、不寫 Firestore）、軌道歸屬與前向列範圍、特徵與排名、M0_fwd、資料來源、凍結條件 C1～C7 與 t 日 09:00 期限、只寫一次與封印、到期與評分、RAND（判定只用期望值）、bootstrap、G60（流程 P1～P8，**S0／S_FB 照樣檢查崩壞**）、G250／G500 的量、評估窗與門檻、缺料規則、記錄欄位、section 代碼與不混排、`implementation_pins`。S0 仍是本登錄唯一的主要檢定。

## 2. G250 與 G500（機械判定）

評估窗＝前 250 個評分日（G500 為前 500 個），G60 HALT 且沒有使用者裁定時 G250 暫停——都同 v1。

| 清單 | 量 | 規則（`a36_tracks_fwd_rules`） | 結果 |
|---|---|---|---|
| **S0**（主要） | Δprecision@5(S0 − RAND_S) | `g250_watch`：點估計 > 0 且 CI 下界 > 0 ⇒ **UPGRADE**；點估計 > 0 ⇒ **EXTEND**；其餘（含無法計算）⇒ **STAY-WATCH** | UPGRADE：升為 S-KEEP-AS-SHADOW，撤除灰底，標「觀察／研究榜·代理 lift 前向確認·容量受限·不可交易」；EXTEND：灰底到 500 日；STAY-WATCH：維持 S-WATCH-ONLY |
| S_FB（探索性） | Δprecision@5(atr14_FB − RAND_FB) | 同 S0 | UPGRADE：升為 SFB-KEEP-AS-SHADOW（保留「探索性」）；其餘同 S0 |
| R0 | Δprecision@5(R0 − RAND_R) | v1 原樣（`g250_watch`） | v1 原樣 |
| W、M0@10、M0@20、等名額 | — | 只作描述 | — |

- **G500**（只對 EXTEND 者）：`g500_final` 點估計 > 0 且 CI 下界 > 0 ⇒ UPGRADE（S0 → S-KEEP-AS-SHADOW、S_FB → SFB-KEEP-AS-SHADOW、R0 → R-KEEP-AS-SHADOW），否則 STAY-WATCH。最終定案，不再延長。
- **與 v1 的關係**：量、窗、bootstrap 與門檻都和 v1 相同，切分也相同（UPGRADE＝v1 CONFIRM、EXTEND＝EXTEND、STAY-WATCH＝v1 DROP）；差別只在出發點——v1 從 KEEP 出發（CONFIRM 維持、DROP 降級），v1.1 從 WATCH-ONLY 出發（UPGRADE 升級、STAY-WATCH 維持）。
- UPGRADE 之後仍然**不是可交易名單**（v1 `scope.no_tradable_list` 原樣）。
- 實作：`a37_tracks_score.gate_report(…, roles＝a37_tracks_reg.gate_roles(v1.1))`。

## 3. 介面

- S0、S_FB、R0、W 四區都是灰底；S0、S_FB 另標「**只觀察（保留驗證期作廢·待前向 G250）**」；介面不顯示任何報酬或報酬衍生數字（研究記錄照算），可顯示 T1 命中與否與累計 Δprecision 對 RAND（精確度類）。
- 頁首一行說明：保留驗證期作廢（HO-BURNED，2026-10-05 使用者裁定）：鎖後三次額外讀取 HOLDOUT 都計入「最多兩次修正重跑」上限，HOLDOUT 不再確認任何事——S0／S_FB 改為只觀察，只能靠前向 G250 升級。
- `scripts/lib/surge-tracks-report.mjs` 的 `LIST_META` 必須與本 JSON 的 `lists_override` 逐字一致（`surge-tracks-report.test.mjs` 讀本檔核對）。

## 4. 前向程式如何套用（`forward_code_contract`）

- **載入**：`a37_tracks_reg.load_amendment()`——v1 先驗（`load_forward_registration`），再驗本修訂的雜湊、registration_id、`version＝"1.1"`、`amends.sha256＝v1 封存雜湊`、釘選摘要＝v1 的 `implementation_pins`、只覆寫允許的清單（S0、S_FB）與欄位；任一不符 ⇒ `SystemExit`（daily／summary 以 exit 2 拒跑，同 v1 雜湊不符）。
- **core 凍結**：`a37_tracks_core.build_core`（不改）產生 v1 標籤 → `a37_tracks_reg.apply_to_core` 換上本修訂的 `label`、`list_verdict`、`grey_watch_only`，加 `entry_verdict`、`g250_role` 與 `registration_amendment` 區塊（id、version、sha256、v1 雜湊、FDEV-008）→ 才封印。池、名單、名次、分數、RAND 一律不動（parity 只比軌道、池列數、名單與分數）。
- **缺口記錄**加 `registration_amendment`；**摘要**的 G 判定用 `gate_roles(v1.1)`，並記 v1 與 v1.1 的雜湊。
- **接線前證明的程式綁定不變**：`PREWIRE_CODE`（`a37_tracks_fwd_io.py`、`a37_tracks_sync.py`、`a37_tracks_core.py`）與 17 個釘選檔都沒有改。

*影子模式·未扣成本·事後欄位以 m_ 標示·非投資建議。*
