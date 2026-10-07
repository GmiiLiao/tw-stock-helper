---
name: tw-ai-stoploss
description: 產生、驗證、顯示或推播「持股停損價」的程式與 AI 提示要先讀本規範——daemon 停損推播、停損紀律、崩盤防禦、投資論點、戰情 A1 距停損與 Z2 觸停損一級，以及持股分析、個股波段分析、問AI 裡的停損文字。stop-v1.1（2026-10-05 定稿）＝成本線、ATR 帶、保本線、追蹤線取高且只升不降，規則類重大利空依類別權重暫時收緊；要等 stopBooks/{uid} 的 phase 變成 live、specVersion 為 stop-v1.1 才對 daemon 與一般畫面生效。在那之前是第一階段：daemon 照戰情第 4 題沿用推播口徑（有 ATR 帶就用，否則成本 −8%），本規範的命名、觸及口徑與禁用詞不套用到舊算法；戰情 v2（超管）的 A1 已採本規範的前端暫算，Z2 觸停損一級由網頁判定並標「單一裝置·暫算」（第二輪 A7 裁定），維持到切換正式為止（「生效範圍」表）。
---
# tw-ai-stoploss｜AI 停損規範（stop-v1.1 定稿）

> **狀態**：`stop-v1.1` 定稿（2026-10-05）。以 v1 修訂版為底，落實使用者 2026-10-05 兩輪裁定：第一輪 16 項（原話「停損 3不停止觸發 7要留 8要 9好 14要 15不要 16算 其它ok」）＋新聞「識讀權重 5 標明研究期，只顯示計分但不實際使用」；第二輪 7 項（原話「a3 3／a4 做skills判定與加權重／a5 不算／a6 保留／其它都ok go」）。逐項對照見 §13 與文末「修訂紀錄」。
> **與 v1 的差別（一句話）**：ATR 帶（舊稱「AI 停損」）**繼續觸發**，改用官方還原日 K、收盤資料到齊後算一次、隔一個交易日生效、買進當天不套，與成本線、保本線、追蹤線一起取高並只升不降；新聞技能方向標「規則」的利空類別一律由**程式規則判定**，依**類別權重**（新聞技能 §4.1 baseWeight，先驗·未回測）決定收不收緊、收多緊；獲利回落線由保本／追蹤線取代；推播文字改成事實句，但停損紀律的「請面對決策」與指數急落的「隔日沖偏多策略暫停追價」保留；5～6 碼 ETF 與興櫃另建官方日 K 歸檔，驗證前沿用現行算法。
> **上線狀態**：**v1.1 尚未對使用者生效**。2026-10-05 本機已接並於 `715cd1d` commit（未部署、daemon 未重啟；daemon 是 disk 即部署，下次 KeepAlive 拉起就載入；2026-10-06 R1–R9 的落實本機已改、未 commit，§13.3）：共用函式 v1.1（§3.8）；daemon S2b 推播文字（九處，只換字串、判斷不動）；S3 影子試算（`scripts/lib/stop-shadow-runner.mjs`，只寫 `stopBooks`／`stopEventShadow`／`stopSpecAudit`，不推播）；LLM 停損文字 S3 量測（**提示詞不變**，§10.1）；新聞管線規則判定（A4，§10A.2）；戰情 v2 A1 改 v1.1 前端暫算（§3.6 最後一列）。daemon 推播與紀律仍用兩套舊算法（推播 `scripts/ai-daemon.mjs:3251`、紀律 `:9864`）。上線方式：影子試算至少 20 個交易日，再請使用者核可切換（§14）。**會改變使用者看到內容的只有兩處**：推播文字改為只描述事實（第 9 項；S2b；另 2026-10-06 R4 ⑧ 法人×大戶「疑似出貨警示」結尾）；規則類事實確認「是」時，**只有法律類 C16a** 由程式把新聞判別的 label 覆寫為利空（2026-08-29 起已是如此；A4 起 AI 原判已利空也補規則欄位），其他類別只記規則欄位、label 維持 AI 原判（使用者 2026-10-06 R1，§10A.2-3）——所以推薦排序、個股評分、做空候選、squeeze-train 等讀 `newsVerdict.label` 的地方不受其他類別影響；停損收緊與戰情 v2 讀規則欄位。
> **讀者**：任何會寫出、算出、顯示或推播「停損」數字的程式與 AI。
> **口徑**：報酬一律是**未扣成本的毛報酬**，成本另列在 `references/evidence.md` §6。處置／注意的扣分不代表走勢弱。
> **行號**：`ai-daemon.mjs` 行號以 HEAD `2fd8ce6` 為準（16,205 行；等於 v1.1 草案時的「工作樹」欄）。daemon 隨時可能被其他流程修改，實作時一律用錨點字串定位（實作計畫 §0.1、`references/evidence.md` §8）。
> **非投資建議**：本文是程式規格與研究紀錄，不是買賣建議。

## 生效範圍（先看這段）

| 階段 | 停損口徑 | 本規範哪些條文適用 |
|---|---|---|
| **第一階段·daemon 與一般畫面**（**戰情第 4 題**裁定，**現在**；「戰情第 N 題」指戰情 v2 BUILD-SPEC 的 14 題，與本規範 §13 的「第 N 項」不同） | 與 daemon 停損推播同一套：有 ATR 帶（現行叫「AI 停損」）就用，否則成本 −8%（`legacyPushStop`）；紀律與崩盤防禦是 max(帶, 成本×0.92)（`legacyDisciplineStop`） | **只有** §14 的過渡規定、`references/wording.md` 的「過渡期」列，以及 §8.6 已核可、可先行的推播文字改寫（S2b）。§1 的命名、§4.1 的觸及口徑、§9 的禁用詞**都不適用**到舊算法本身 |
| **第一階段·戰情 v2 A1（超管）** | 使用者 10-05 指示「制訂 AI 停損規範，再使用這個規範」⇒ 前端暫算。**現況（2026-10-05 本機，未部署）**：v1.1 暫算「成本線與持股分析 ATR 帶取高、帶不棘輪」（`warroom-mine.provisionalStop`＝§3.6 最後一列：`frontLinesOf`＋`resolveStop`），ATR 帶標「ATR 帶（持股分析·觸發線之一）」 | 前端暫算規則（§3.6 最後一列） |
| **第一階段·戰情 v2 Z2 觸停損一級** | **已裁定（§13.2 A7「ok」）**：由網頁依本規範判定，標「單一裝置·暫算」（現行實作：本機事件表、只認今日成交更新的 low、每事件一次），**維持到切換正式為止**；切換後停用前端判定、改讀 daemon 的 `type:'stop'` | 實作計畫 §3.2 |
| **影子期**（S3–S4） | 線上照第一階段；daemon 另算 v1.1 停損寫進 `stopBooks/{uid}`（`phase:'shadow'`），**只記錄、不推播、不寫 alerts** | §3–§8、§10A 只用於影子計算與對照紀錄 |
| **v1.1 生效**（`stopBooks/{uid}.phase === 'live'` 且 `specVersion === 'stop-v1.1'`） | 本規範全文；5～6 碼與英文字尾 ETF、興櫃在官方日 K 歸檔通過驗證前留在第一階段口徑（§2A、§13.2 A3） | 全部 |

**修改 WarRoomV2、daemon 停損相關程式之前**，先確認目前在哪個階段。不要拿 v1.1 的條文去改第一階段 daemon 的算法。

## 0. 十一條重點

1. **全站一個停損數字**：`生效停損 = max(基礎停損, 事件收緊線〔期限內；可多個類別各一層，取最高〕)`，由共用函式 `scripts/lib/ai-stoploss.mjs` 的 `resolveStop` 決定。
   - **基礎停損**＝成本線、ATR 帶、保本線、追蹤線四條「組成線」取最高，再套**只升不降**的棘輪（§3.2）。
   - daemon 推播、停損紀律、崩盤防禦、投資論點、戰情 A1、持股 AI 卡、LLM 提示詞都讀這一個值。
   - **例外**：個股頁、下單前檢查等**進場前**畫面的「參考停損」不是持股停損（§2）。
2. **ATR 帶繼續觸發**（第 3 項「不停止觸發」；落實方式第二輪 A1、A2「ok」已裁定）。
   - 它就是現在被叫成「AI 停損」的數字，**不是 AI 產生的**：支撐 max(MA20×0.98, 近 10 日低) 減 0.5×ATR14，夾在收盤價的 −3%～−15%（`src/lib/indicators.ts:177-201`）。
   - **落實（已裁定）**：改用**官方還原日 K**、每個交易日收盤資料到齊後算一次、**隔一個交易日**起判定、**買進當天不套**（A1）；**併入只升不降棘輪**，不再跟著股價往下移（A2）（§3A）。這和使用者現在看到的 `/api/rating` 那條帶（Yahoo 來源日 K）不是同一個數字（v1 時逐檔只有 71.2% 完全一致，影子期逐檔量化）。
   - 代價（合成母體 60 日、收盤進場的新部位）：觸發 83.7%→97.7%、洗出 62.1%→69.1%、平均 −0.96pp（CI [−1.81, −0.21]）；≤−15% 2.35%→0.10%（停損價成交）／2.91%→0.60%（鎖死順延）。尾端受前視選樣影響是**下界**。首次觸發時仍在獲利中 29.0%（現行同口徑 27.7%），推播與畫面一律寫明是哪一條線觸發、當下損益（§3A.6、§9）。
3. **成本線是最寬的界線**：還原成本 ×(1−8%)，向上取到合法檔位（第 1、2 項裁定）。「還原成本」是逐筆依官方係數（除權息、減資、面額變更）還原後再加權的成本（§3.2、§7）。
4. **獲利後上移停損**（第 8 項裁定）：持有期最高**收盤**曾達還原成本 +10% → 保本線；曾達 +20% → 追蹤線＝持有期最高收盤 −3×ATR14。**取代**現行獲利回落線（`type:'trailing'`），全站只剩一種獲利後口徑（§5；B2、B3 照解讀確認）。
5. **規則類重大利空依類別權重收緊停損**（第 14 項＋第二輪 A4「做skills判定與加權重」；§10A）。
   - 新聞技能 §4.1 方向標「規則」的利空類別一律做成**程式規則判定**：AI 只認定事實（主體是不是本檔、事件是不是屬實），方向與類別由程式規則決定；AI 自己判利空時也要補規則標記（修正 `ai-daemon.mjs:6415` `verdict.label !== '利空'` 的漏網）。
   - **只有法律類 C16a** 由程式把 `newsVerdict` 的 label 覆寫為利空；其他類別只記規則欄位（`ruleClass`、`ruleOverride`、`ruleSub`、`ruleHits`、`aiOriginal`、`ruleFacts`），label／信心／理由維持 AI 原判（使用者 2026-10-06 R1：label 連動推薦排序、個股評分、做空候選、squeeze-train）。停損收緊與戰情以 `ruleClassOf` 讀規則欄位辨識，不看 label（§10A.1-C）。
   - 每個類別一個**類別權重**＝新聞技能 §4.1 的 baseWeight（**先驗·未回測**）：權重 ≥0.7（C16a 法律 0.90、C22 財務危機 0.85、C13b 公開收購破局 0.80、C17 工安停工 0.70）⇒ 收到前收 −max(1×ATR14, 3%)；0.3～0.7（C16b 裁罰訴訟 0.35、C15a 內部人轉讓 0.30）⇒ 前收 −max(2×ATR14, 5%)；<0.3（C11a、C15c、C20b、C15a 贈與信託 0.05）不收緊、只記影子；C23 交易限制依新聞技能「不當成訊號」不收緊。
   - 只認 AI 讀過內文、當日（非承接）、挑戰過的判別；5 個交易日到期、期限內同代號同類別不延長、到期後冷卻 5 個交易日。命中與漏網兩份影子紀錄供日後校正。
   - ⚠ **類別權重是規則先驗，不是 AI 新聞識讀的結果權重 `w`**；`w` 研究期只顯示、不進任何判斷（第 6 點）。
6. **新聞影響權重 `w` 是研究期**：分數只顯示並標「研究期」，不進一級警示門檻、不進停損、不進名單或推薦的排序鍵（§10B）。盤後報告依 `w` 排列顯示順序**不算使用**（第二輪 A5「不算」），維持原樣。
7. **停損的作用與限制**：本站 2022-08～2026-06（偏多頭）回測中，所有停損規則的 60 日平均都低於不停損；v1.1 的組合比不停損低 4.41pp（鎖死順延 −4.47pp），是各方案中最低、尾端最薄的一個（`evidence.md` §10）。停損只在「賣得掉」的前提下壓縮左尾：同一母體 2025 年起進場、鎖死順延口徑下，v1.1 的 ≤−15% 仍有 1.37%。任何文案都不得宣稱停損能多賺，也不得宣稱停損能把虧損封頂。
8. **LLM 不得自己寫停損數字**（第 4 項裁定）：提示詞只給生效停損，LLM 只能原樣引用並在 `STOP_REF:` 照抄。「AI 提議停損」選擇題會占 Ollama，列為**第二階段**，本次不實作（§3.5）。
9. **觸及只認今日成交更新的最低價**，開盤就跳過時觸發價記開盤價；一級警示用**盤中觸及**，16:45 起的資料到齊班車用官方日低**補判**也發一級（第 5 項裁定）。每個觸及事件只推一次，要帶 `id` 與 `requireAck:true`。個人推播照常寫出停損價（第 15 項裁定）。
10. **停損紀律保留每日推播**（第 7 項裁定），「請面對決策：停損或明確寫下續抱理由」這句保留；指數急落公共訊息的後半句「隔日沖偏多策略暫停追價」保留原文（第二輪 A6「保留」）；除權息、減資、面額變更一定調整（第 12 項）；處置／注意不影響停損價、只揭露撮合方式。
11. **5～6 碼與英文字尾 ETF、興櫃**（第二輪 A3「3」）：chipArchive 只收 4 碼，另建 ETF 與興櫃的**官方日 K 歸檔**（使用者已核可為此抓官方端點），讓這類持股也能算 ATR 帶、保本線、追蹤線；**歸檔完成並驗證前，這類持股沿用現行算法**（第一階段口徑，§2A）。

---

## 1. 名詞（全站統一，不得混用；第一階段例外見「生效範圍」）

| 名詞 | 定義 | 可否觸發一級警示 |
|---|---|---|
| **生效停損** `stop` | `resolveStop` 的輸出：`max(baseStop, 事件收緊線〔期限內〕)`。全站唯一的停損數字 | 可 |
| **基礎停損** `baseStop` | 四條組成線（成本線、ATR 帶、保本線、追蹤線）取最高，再套只升不降的棘輪（§3.2） | 是生效停損的主體 |
| **組成線** `lines` | 當日各線的值：`costLine`、`bandLine`、`beLine`、`trailLine`；另有疊加層 `eventLine` | 透過生效停損 |
| **綁定來源** `stopSource` | 生效停損目前由哪一條線決定：`cost`、`atrBand`、`breakeven`、`trail`、`event`；另記 `sourceDate`（該值被設定的資料日）。畫面與推播的來源標籤只看這個欄位 | — |
| **停損依據類別** `basis` | 誰訂的停損：`'system'`（成本線、ATR 帶、保本、追蹤、事件收緊，一律這個值）、`'ai'`、`'user'`（後兩者第二階段）。v1 實作的 `'cost'` 改名為 `'system'`；**不得**用 `basis` 判斷是哪一條線 | — |
| **觸及判定價** `touchBasis` | 警示上記錄「用哪種價判到觸及」：`low`（今日成交更新的最低價）、`trade`（今日新設停損用的真成交價）、`officialLow`（收盤後補判）。警示文件用 `touchBasis`，不與上一列的 `basis` 同名 | — |
| **還原成本** `adjCost` | Σ(每筆買價 × 張數 × 該筆買進日之後各事件係數的連乘) ÷ 總張數。係數 f＝事件後參考價 ÷ 事件前收盤，來源是 `mergeFactorItems`（官方除權息＋priceEvents，§7） | — |
| **成本線** `costLine` | `ceilTick(還原成本 × (1 − 8%))` | 組成線 |
| **ATR 帶** `bandLine` | `atrBandOf(官方還原日 K)`：支撐 max(MA20×0.98, 近 10 日低) − 0.5×ATR14，夾在當日官方收盤的 −3%～−15%，向下取檔（§3A）。**舊稱「AI 停損」「結構參考價」，v1.1 生效後兩個舊稱都不再使用**。改用官方日 K、隔日生效、買進當天不套、併入棘輪已裁定（§13.2 A1、A2） | 組成線（第 3 項裁定） |
| **保本線** `beLine` | 持有期最高收盤 ≥ 還原成本 ×1.10 時，`ceilTick(還原成本)`（毛額；淨額約 −0.38%） | 組成線（第 8 項） |
| **追蹤線** `trailLine` | 持有期最高收盤 ≥ 還原成本 ×1.20 時，`ceilTick(持有期最高收盤 − 3×ATR14)` | 組成線（第 8 項） |
| **持有期最高收盤** `holdHigh` | 自最早買進日（含當日）到最近定版日，官方還原收盤的最高值。由歸檔重算，重啟不失效 | — |
| **事件收緊線** `eventLine` | 規則類重大利空成立時的暫時疊加層（每個類別一層）：`floorTick(前收 − max(k×ATR14, p%×前收))`，(k, p) 依類別權重分級＝(1, 3) 或 (2, 5)，5 個交易日到期（§10A.3）。先驗·未回測 | 透過生效停損 |
| **規則類別** `ruleClass` | 新聞技能 §4.1 方向標「規則」的利空事件類別（C16a、C22、C13b、C17、C16b、C15a、C11a、C15c、C20b、C23）。由程式規則判定：AI 只答事實，方向與類別由程式寫進 `newsVerdict`（§10A.2） | 只透過事件收緊 |
| **類別權重** | 每個規則類別的先驗權重＝新聞技能 §4.1 baseWeight（`scripts/lib/news-rule-classes.mjs`），**先驗·未回測**；只用來決定事件收緊的級別（§10A.3）。**不是** `w` | 不可（不當任何警示門檻） |
| **AI 提議** `aiProposal` | LLM 從程式算好的候選中選出的停損。**第二階段**才實作，v1.1 不產生 | 不可 |
| **AI 停損** | 只能用來稱呼「已核可生效的 AI 提議」（第二階段）。第一階段畫面沿用使用者裁定的過渡用法 | 同生效停損 |
| **成本上方停損** | 第二階段才有：使用者自訂或核可的 AI 提議高於還原成本時的停損 | 等級由第二階段裁定 |
| **獲利回落線**（舊 `type:'trailing'`） | 現行：盤中高水位 ≥ 成本 +10% 後，高水位 ×0.92。**v1.1 生效時退役**，由保本線與追蹤線取代（§5.2）；第一階段照舊 | v1.1 不存在 |
| **停損版本** `stopVersion` | 生效停損每次改變就加 1，並記下原因 `versionReason`、生效時刻 `startedAt` 與版本日 `tradeDate` | — |
| **觸及事件** `episode` | 從第一次觸及開始，到某交易日官方收盤 > 停損×1.02 或部位出清為止 | 每個事件發一次一級 |
| **洗出** | 觸發後 10 個交易日內，有任一收盤 ≥ 還原成本。分母是觸發的部位（§11-3）。回測表引用其他口徑（例如波段的 20 日）時會另外標明 | — |
| **進場前參考停損** | 個股頁、AI 推薦、下單前檢查、趨勢分析等以「假設進場」計算的停損（含 `/api/rating` 的 `stopLoss`） | 不在改接範圍（§2）；**不得推播** |
| **新聞影響權重** `w` | AI 新聞識讀的結果權重：`rankMediaVerdicts` 的強度×信心×確定性×新穎×尚未反映（0–1）。**研究期：只顯示**（§10B）；與「類別權重」是兩回事 | 不可（任何等級都不用它當門檻） |

---

## 2. 適用範圍

| 對象 | v1.1 處理 | 說明 |
|---|---|---|
| **所有持股**（`users/{uid}/data/holdings`） | 一律套 `general` 規則（§3–§10A） | `HoldingItem` 沒有模式欄位（`src/lib/store.ts:24-33`）。用「買進日＝前一交易日」推定隔日沖會誤標波段持股，所以不推定 |
| 當沖、隔日沖、波段 5 日（swing5）、存股（long） | 規則寫在 `references/modes-phase2.md`，**等 ND14**（持股模式與自訂停損欄位，第二階段；第 10 項裁定） | — |
| 當沖工作台觀察單、AI 當沖／波段實驗的模擬單 | 照用各自既有規則（`scripts/lib/daytrade-setups.mjs` 的 DESK_PARAMS 等） | 不受本規範改動；其中的 LLM 停損文字仍要遵守 §10 |
| 進場前參考停損（`PreTradeCheck.tsx:22`、`SignalPanel.tsx:46`、`BuySellPanel`、`trend-analysis/route.ts:902`、`compare-agent/route.ts:193`、`ai-daemon.mjs:1312`） | **不改算法**（`/api/rating` 的 `calculateAtrStop` 照舊） | 統一標成「參考停損（進場前）」；不得進入推播。畫面遇到使用者持有的代號時，另顯示生效停損，或不顯示參考停損 |
| 4 碼 ETF（如 `0050`、`0056`）、股價 <10 元、20 日均量 <300 張 | 照常套用 | 都不在回測母體內，畫面要標「此類未經本站回測」 |
| **不在 chipArchive 的代號**：5～6 碼與英文字尾的 ETF（如 `00878`、`00919`、`006208`、`00632R`、`00958B`、`00400A`）、興櫃 | **已裁定（§13.2 A3「3」）**：另建官方日 K 歸檔（§2A）。**歸檔通過驗證前**：影子期照算但只有成本線（標 `noOfficialBars`），S4 分開統計；S5 切換時這類代號**留在第一階段口徑**（現行推播、紀律與獲利回落線照舊，`legacyBranchActive(book, code)`），畫面標「ETF／興櫃官方日 K 歸檔驗證前·沿用現行推播口徑」。**驗證後**：與 4 碼股票同一套 v1.1 | 收盤歸檔只收 4 碼：`ai-daemon.mjs:11918`（上市）、`:11928`（上櫃）`/^\d{4}$/`；3 年回補 `backfill-chip-3y.mjs:39` 同。現行推播對它們用 `/api/rating` 的帶（Yahoo 日 K，若持股分析有算出）。ETF 檔位判定見 §15-1 |

## 2A. 裁定落實：第二輪 A3「另建 ETF 與興櫃官方日 K 歸檔」

使用者原話「a3 3」＝選第 3 案：另建 5～6 碼 ETF（含槓桿／反向等英文字尾 ETF）與興櫃的官方日 K 歸檔（使用者已核可為此抓官方端點），讓這類持股也能算 ATR 帶、保本線、追蹤線；**歸檔完成並驗證前，這類持股沿用現行算法**。

| 項目 | 規定 |
|---|---|
| 網域 | 只用已登錄核准的 `www.twse.com.tw`、`www.tpex.org.tw`（`scripts/source-registry.json`，2026-09-28 核准）；不新增網域。新增資料集時在 registry 的資料集清單登記（端點、用途、回聲欄位） |
| 上市 ETF | **實作（2026-10-05）**：讀第二大腦官方鏡像的 `twse_mi_index`（`MI_INDEX?date=…&type=ALLBUT0999` 每日收盤行情表；可指定日期的 www 端點、每份有回聲日期），`scripts/lib/official-bars.mjs` 解析成 chipArchive 同格式日 K（0 請求）。不走 daemon 收盤歸檔的 `STOCK_DAY_ALL`（原規劃；不吃日期、無法回補）。鏡像 daily 平日 22:40 抓、retry 隔日 06:45 補 ⇒ 收盤當晚 16:45 班車時通常還沒有當日資料，整合端以**隔日 08:46 盤前刷新**讀取（ATR 帶本來就是隔一個交易日才生效，A1）。**已接（2026-10-06 R8）**：daemon 盤前直接讀本機鏡像（見「程式」列） |
| 上櫃 ETF | 讀鏡像 `tpex_dailyquotes`（`afterTrading/dailyQuotes?date=…`）。**已實測**（2026-10-05）：`type=EW` 與不帶 `type` 同為 11,928 列、ETF 118 檔——`type=EW` 含 ETF。時點同上市 ETF |
| 興櫃 | 沒有 MIS 即時報價、沒有漲跌幅限制、官方日資料沒有開盤價（收盤以「最後成交價」）。持股紀錄沒有市場別 ⇒ 身分以官方表為準：chipArchive 沒有它的日 K（停損簿上一版 `noOfficialBars`）**而且**官方興櫃表在視窗內有它，才當興櫃（不以代號猜；R8）。**已實測**（2026-10-05）：官方**沒有**可指定日期的興櫃全表（`emerging/historical` 必須帶個股代號，而且只有最高／最低／均價、沒有最後成交價）⇒ 只能每日快照累積：PRIMARY `www.tpex.org.tw/www/zh-tw/emerging/latest`（鏡像 `tpex_emerging_latest`）、FALLBACK openapi `tpex_esb_latest_statistics`，都以官方回聲日為鍵。鏡像 daily 22:40 抓；retry 隔日 06:45 在兩個來源都缺時補抓最後一個已確認交易日、更早的缺日寫進 `_alerts`（只能揭露，無法回補） |
| 回補 | 上市、上櫃 ETF：本地官方鏡像 `second-brain/official/www.twse.com.tw/twse_mi_index`、`www.tpex.org.tw/tpex_dailyquotes`（2022-07-18 起，每份有回聲日期）**離線回補，不打上游**。興櫃：無法回補，從鏡像開始抓的那天起累積（ATR14 要 15 根、MA20 要 20 根，約 4 週；`node scripts/official-bars.mjs status` 看連續天數）。**R6（2026-10-06 裁定維持）**：興櫃日 K 從 10/02 起自行累積、不回補；閘門 ② 要連續 20 個交易日，約 10 月底前興櫃一律 fail-closed |
| 儲存 | **R8（使用者 2026-10-06「ok 如建議」）：不建 Firestore 歸檔**——daemon 盤前直接讀本機官方鏡像 `second-brain/official`（0 次 Firestore 讀寫、0 上游請求），原規劃的 `etfDailyArchive`／`emergingDailyArchive`（`BAR_ARCHIVES`、`archiveDocsOf`）保留名稱與格式但不寫。**不併入 chipArchive**：現有消費端假設 4 碼，稽核的市場組成閘門也以 chipArchive 為準。日 K 的 `date` 一律是官方回聲日 |
| 驗證閘門（全部過、經使用者核可，才把該歸檔列入 `verifiedArchives`＝daemon `STOP_VERIFIED_ARCHIVES`，目前空） | ① 每份回聲日期＝文件日；② 連續 ≥20 個交易日（MA20、ATR14 都有值）；③ 市場組成：上市 ETF、上櫃 ETF 各有貢獻（興櫃單獨一個閘門）；④ 抽樣比對：會員持有的這類代號，歸檔收盤與 daemon 快照當日收盤一致；⑤ 補進 `audit-data-sources.mjs` 的 `CONTRACTS`（maxStale／minRecords／資料日漂移／市場組成）連續 5 個交易日綠；⑥ 影子期照 v1.1 算這類代號並分開統計；⑦ **結構斷點都有官方係數**（2026-10-05 審查新增）：`official-bars.structuralBreaks` 找到的停止買賣後斷點（分割／反分割候選；2024-12～2026-07 ETF 有 9 件，例 00631L 2026-03-31、00685L 2026-07-07，都不在 `exright-history.json`）每一件都要有官方分割係數進 §7 係數表。`lineInputsOf` 另以同一組門檻（`STRUCT_BREAK`）逐檔查：ETF 視窗內有沒有係數的斷點 ⇒ 斷點之前的根數記進 `exGapBars`（fail-closed，當日不採用日 K 算出的值，§3.4），所以缺係數不會把偏高的帶值鎖進棘輪；英文字尾 ETF 的 `isEtfCode` 為 false（§15-1），影子以 `checkBreaks:true` 照查（實測 00685L 2026-07-07 斷點在 80 根視窗內 ⇒ `exGapBars` 14）。驗證完成後由使用者核可，與 S5 同一批或之後單獨切換 |
| 驗證前 | **影子期（R8 起）**：本機鏡像可用（`officialBarsVerdict`：閘門 ①②③ 過、最後一天＝前一交易日且抓齊）⇒ 照 v1.1 算這類持股（組成線標 `lineInputs.archive`；閘門 ⑥），公開計數分開統計（`bookAuditCounts.officialArchive`、`stopSpecAudit.shadow.officialBars`）。鏡像不可用 ⇒ **fail-closed**：從未供給過的持股 `noOfficialBars`（只有成本線）；停損簿已有上一份鏡像組成線的不覆蓋（`linesStale`、沿用棘輪值，同 chipArchive 資料延遲 §3.6），並記 log。**S5 後**：`legacyBranchActive(book, code, { verifiedArchives })` 為真（`noOfficialBars` 或歸檔種類不在 `verifiedArchives`）⇒ 舊分支照跑；v1.1 照算、照寫停損簿，但 `plan*` 不發任何推播或二級文件（`unverifiedArchiveOf`）。畫面標「ETF／興櫃官方日 K 歸檔驗證前·沿用現行推播口徑」（`stopFactText('noOfficialBars')`）。**前端同口徑**（2026-10-06 審查）：戰情 `warroom-stopbook.bookStopOf` 與 daemon 共用 `legacyCodeActive(bp, { verifiedArchives })`，`verifiedArchives` 讀停損簿文件裡 daemon 每次寫入的同一份（`stopBooks/{uid}.verifiedArchives`＝`STOP_VERIFIED_ARCHIVES`；缺＝空＝fail-closed），不會出現畫面一個停損、推播另一個的情況 |
| 驗證後 | 與 4 碼股票同一套 v1.1。興櫃另有兩點：盤中不判定（沒有 MIS 報價），只有 16:45 收盤後補判（官方日低，`noLimit`）；沒有開盤價 ⇒ 不判跳空 |
| 程式 | `barArchiveOf(code, market)`（4 碼→`chip`、5～6 碼與英文字尾 ETF→`etf`、呼叫端告知 `market:'emerging'`→`emerging`；興櫃也有 4 碼代號，不能用代號猜）、`hasOfficialBars(code, { market, verifiedArchives })`、`uncoveredBreakBars`（閘門 ⑦）。鏡像讀取與閘門 ①②③：`scripts/lib/official-bars.mjs`、CLI `node scripts/official-bars.mjs status|factors`（0 請求）。**已接（2026-10-06 R8）**：daemon `stopShadowLoop` 以動態 import 載入 `readOfficialBarsAsync`（只讀本機檔；分段讀、段間讓出事件迴圈，ETF 80 個交易日約 0.8 秒、單段最長約 0.12 秒）注入 `stop-shadow-runner`（`loadOfficialBars`、`mirrorInputsOf`）；**盤前刷新**每個資料日每種讀一次（全域，與會員數無關），盤中與非交易日只用已讀快取、不讀檔；**收盤結算排除這類持股**（鏡像 22:40 才有當日資料；`planCloseSettle` 的 `codes`），不以 chipArchive／`noBarsStub` 覆蓋，改在**下一交易日盤前讀到鏡像（資料日＝前一交易日）時補跑同一支 `planCloseSettle`**（`mirrorSettle`：補判 `evaluateLateTouch`〔興櫃 `noLimit`、沒有開盤價不判跳空〕、`settleEpisode`、組成線換版、延後的事件收緊；版本日＝前一交易日，同 chipArchive 口徑；2026-10-06 審查——原本這類持股的觸及事件永遠不結算、收盤後不補判）。只補前一交易日已由同種鏡像組成線判定過的持股；鏡像缺該日 ⇒ 該日不補（fail-closed）。補記寫進前一交易日的 `shadowDays`（`wouldPush` sub `late`、重算 `compare`、合併 `missedLive`）；`stopSpecAudit/{前一交易日}` 的公開計數收盤時已寫、不含這些補記，S4 以 `shadowDays` 重算。紀律彙總的前一交易日收盤對這類持股用盤前已讀的鏡像收盤（chipArchive 沒有）。**興櫃轉上市櫃**：收盤結算時 chipArchive 當日已有這檔 ⇒ 改走 chipArchive（新組成線不標 `archive`，之後盤前也不再當興櫃；原本會永遠沿用興櫃舊日 K）。讀取模組載入失敗只停用供給（fail-closed）、影子其他部分照跑。**尚未做**：閘門 ④（抽樣比對 daemon 快照收盤）、⑤（`audit-data-sources` CONTRACTS）；`STOP_VERIFIED_ARCHIVES` 維持空，等閘門全過並經使用者核可 |
| 唯一不變式 | 上市、上櫃 ETF 讀鏡像既有檔案，請求數不變；興櫃每日 2 個快照請求（全市場一份、retry 只在兩個來源都缺時補），與人數無關。daemon 端（R8）0 個上游請求、0 次 Firestore 讀寫 |

---

## 3. 停損價的決定規則（`resolveStop`）

### 3.1 輸入

| 欄位 | 意義 | daemon 端來源 | 前端端來源 |
|---|---|---|---|
| `position` | 由 `aggregatePositions(lots)` 彙總：`qty`、`avgCost`、`firstDate`、`lastBuyDate`、逐筆 `lots[]`（`id`、`buyPrice`、`qty`、`buyDate`）。略過買價或張數不是正數的列 | `users/{uid}/data/holdings` | store `holdings`（同一份文件） |
| `ex` | 該代號的事件係數表 `{ events, coverFrom, coverTo }`，由 `mergeFactorItems` 組成。`coverFrom` 取 **min(日 K 視窗第一根日期, 最早買進日)**，`coverTo` ≥ `dataDate` | `stopBooks/{uid}.positions[code].ex`；初值見 §7 | **讀 `stopBooks`** |
| `prev` | 上一版：`stop`、`baseStop`、`floorStop`、`bandHold`、`stopSource`、`sourceDate`、`floorSource`、`floorSourceDate`、`bandSourceDate`、`stopVersion`、`lots` 快照、`exApplied`、`selfAdjusted`、`startedAt`、`tradeDate`、`holdHigh`（增量維護，§5.1）、`eventKeys`（上一版納入的事件收緊層）。v1 形狀（只有 `stop`）視同 `floorStop＝stop` | `stopBooks/{uid}`（`prevStateOf`） | 讀 `stopBooks`；停損簿上線前＝戰情本機事件表 |
| `lines` | 最近一個已定版收盤日 `dataDate` 的組成線原料（`lineInputsOf`）：`atrBand`（`atrBandOf` 的結果）、`atr14`、`holdHigh`、`close`、`barsFrom`（日 K 視窗第一根日期）、`exGapBars`、`noOfficialBars`。價格口徑＝`dataDate` 當天；之後才生效的除權息由 `resolveStop` 再乘係數 | 16:45 起的資料到齊班車：Firestore `chipArchive`（ETF／興櫃驗證後另讀 §2A 的歸檔）近 80 份的 closeJson［收,量,開,高,低］（daemon 全域讀一次、全體會員共用），以 §7 係數表還原後計算 | 讀 `stopBooks`；停損簿上線前見 §3.6（`frontLinesOf`） |
| `events` | 期限內的事件收緊疊加層（§10A；每個類別一層，`activeOverlays` 過濾後傳入）；沒有則空陣列 | `stopBooks.positions[code].events` | 讀 `stopBooks` |
| `aiActive`、`userStop` | 核可的 AI 提議、使用者自訂停損：**第二階段**，v1.1 一律 null | — | — |
| `capPct` | 上限 8（第 1 項裁定） | `STOP_PARAMS.capPct` | 同一常數 |
| `bandRatchet` | ATR 帶是否併入棘輪，預設 true（§3A.3；第二輪 A2 已裁定併入） | `STOP_PARAMS.bandRatchet` | 停損簿上線前的前端暫算傳 false（§3.6） |
| `lastPrice` | 現價，只用於成本可疑檢查 | 快照 | 報價 |
| `latestCanonicalYmd` | 最近定版的收盤資料日（daemon 必傳；`lines.dataDate` 不等於它 ⇒ `linesStale`） | `writeCanonical` 同一個觸發點 | **不傳**（不判 `linesStale`） |
| `nowMs`、`tradeDate` | 計算時刻與版本日（非交易日記為最後交易日） | 呼叫端注入 | 同左 |

### 3.2 步驟（純函式，回傳新物件，不改輸入）

1. **逐筆還原**：`adjPx_i = buyPrice_i × Π f`（事件日 > 該筆 `buyDate`；`selfAdjusted` 的事件不再乘）。
2. `adjCost = Σ adjPx_i × qty_i ÷ Σ qty_i`。
3. **判斷持股變動**（`classifyLotChange`，以每筆 `id` 比對上一版快照；同 v1，第 6 項裁定）：

   | 變動 | 怎麼認 | 停損怎麼動 | `versionReason` |
   |---|---|---|---|
   | 新部位 | 沒有上一版 | 以當日組成線起算（ATR 帶只認 `dataDate ≥ firstDate` 的值） | `init` |
   | 除權息／減資／面額變更 | 係數表出現新的事件日 | 所有棘輪值（`floorStop`、`bandHold`、事件收緊線）× f 後向上取檔，再與當日組成線取高；進行中的觸及事件**延續** | `exAdjust` |
   | 使用者自行調整 | 事件日之後，同一 `id` 的買價比 ≈ f（±1 檔）且張數比 ≈ 1/f | 記入 `selfAdjusted`，不再重乘 f；停損不變 | 無 |
   | 加碼且均價上升 | 新 `id`；或同一 `id`、買價不變、張數增加 | 棘輪照舊，成本線上升時跟著上升 | 數值變了才記 `ratchet` |
   | 攤平且均價下降 | 同上 | **不下移**（第 6 項裁定）。保本、追蹤的觸發條件改用新的還原成本計算 | 無 |
   | 部分賣出（FIFO） | 某些 `id` 消失，或同一 `id` 買價不變、張數減少 | 用剩下的批次重算成本線、持有期起點；停損**不下移**（第 6 項裁定） | 值上升才記 `ratchet` |
   | 成本更正 | **同一 `id`** 的買價或買進日被改，而且不符合事件係數 | 所有棘輪歸零，以當日組成線重新起算 | `costCorrection` |
   | 刪除後重建 | 舊 `id` 消失、新 `id` 出現 | 視為賣出再買進，棘輪照舊、**不歸零**（第 6 項裁定：成本更正只認編輯原筆） | 依上列 |
   | 部位出清 | 代號從持股消失 | 刪除該檔狀態；之後再買就是新部位 | — |

4. **當日組成線**（daemon：`lines.dataDate` 必須等於呼叫端傳入的 `latestCanonicalYmd`，否則沿用上一版的組成線並標 `linesStale`。**前端暫算**——`latestCanonicalYmd` 沒傳、或 `lines.close` 為 null——**不做 `linesStale` 判定**，見 §3.6 最後一列）：
   - `costLine = ceilTick(adjCost × (1 − capPct/100))`。
   - `bandLine = lines.atrBand.price`，條件：`dataDate ≥ firstDate`（部位在那天收盤時已持有）、通過 §3.4 的帶值檢查；否則 null。
   - `beLine = ceilTick(adjCost)`，條件：`holdHigh ≥ adjCost × 1.10`；否則 null。
   - `trailLine = ceilTick(holdHigh − 3 × atr14)`，條件：`holdHigh ≥ adjCost × 1.20` 而且有 `atr14`；否則 null。
5. **基礎停損**（兩段棘輪，方便切換 §3A.3 的兩種模式）：
   - `floorStop`（成本線、保本線、追蹤線的棘輪）：`init`／`costCorrection` ⇒ 當日三線取高；`exAdjust` ⇒ `max(當日三線, ceilTick(prev.floorStop × f))`；其他 ⇒ `max(當日三線, prev.floorStop)`。
   - `bandHold`（ATR 帶）：`bandRatchet` 為 true 時同上式棘輪（只取 `bandLine`）；為 false 時就是當日 `bandLine`。
   - `baseStop = max(floorStop, bandHold)`。
6. **事件收緊疊加**：`stop = max(baseStop, 各層事件收緊線)`，只納入期限內、狀態 `active` 的層（§10A.4）；層的價格口徑日（`refYmd`）之後若有除權息，該層線 `ceilTick(×f)`（不改存檔、每次重算，結果相同）。
7. **綁定來源**：`stopSource` 取等於 `stop` 的那條線；同值時依「事件收緊 > 追蹤線 > 保本線 > ATR 帶 > 成本線」標示；棘輪保留下來的值，來源與 `sourceDate` 沿用當初設定它的那條線與資料日。
8. **分類** `line`：系統產生的線一律是 `'stop'`（依來源分類，不看數值；即使高於還原成本也可發一級）。`'aboveCost'` 只保留給第二階段的使用者自訂與核可的 AI 提議。`basis` 一律 `'system'`（§1）。
9. **自檢**（§3.4）：不通過就保留上一版，並記錄原因。
10. **版本**：數值改變時 `stopVersion+1`，記 `versionReason`：`init`、`ratchet`（持股變動抬高）、`lineRaise`（組成線每日抬高）、`exAdjust`、`costCorrection`、`eventTighten`、`eventExpire`；`bandRatchet=false` 時另有 `bandDown`；第二階段另有 `userSet`、`aiActivate`。

### 3.3 組成線與優先序

1. **使用者自訂停損**（第二階段 ND14）：只要是合法檔位就採用；寬於成本線照樣採用並標示，系統不覆寫。
2. **已核可的 AI 提議**：第二階段。
3. **系統線**：成本線、ATR 帶、保本線、追蹤線取最高（基礎停損），再與期限內的事件收緊線取最高。

- v1 曾廢除「拿浮動 ATR 帶與成本線取嚴」的做法；**v1.1 依使用者第 3 項裁定恢復**，落實方式「官方還原日 K＋棘輪」已裁定（§3A；§13.2 A1、A2），所以不再是 v1 批評的那個 Yahoo 資料源、會跟著股價往下移的值。
- 棘輪、事件調整、事件收緊在最後套用。

### 3.4 自檢界線（每次算完都要檢查）

| 檢查 | 規則 | 例外 | 不通過時 |
|---|---|---|---|
| 數值 | 有限值、>0、在合法檔位上（含 ETF 檔位） | — | 拒絕，保留上一版，記錄 `invalid` |
| 上一版合法 | `prev.stop`、`prev.baseStop` 是有限值、>0、在合法檔位上，版本號遞增 | — | 不採用上一版，從當日組成線重新起算（`init`），記錄 `prevInvalid` |
| 帶值 | `bandLine` 有限、>0、在檔位上、< 該日官方收盤、≥ 該日官方收盤 ×0.85 − 1 檔；`dataDate` 是最近定版日 | 前端暫算（`close` 為 null）只驗數值與檔位 | 當日不採用帶值（`bandInvalid`），`bandHold` 沿用上一版 |
| 係數涵蓋 | `ex.coverFrom ≤ lines.barsFrom`（日 K 視窗第一根）而且 `ex.coverTo ≥ dataDate`。缺一筆視窗內的除息係數時，除息前未還原的收盤會讓 MA20×0.98 與帶值偏高，而夾值保證帶值 ≤ 收盤×0.97，上一列擋不到，棘輪會把錯值鎖住 | 前端暫算（不用還原日 K） | 當日不採用由日 K 算出的值（ATR 帶記 `bandInvalid`；保本、追蹤不新增），`bandHold`、`floorStop` 沿用上一版，記 `exGapBars`（視窗中落在涵蓋外的根數）；成本線照算 |
| 不寬於上限 | `stop ≥ costLine` | `userSet`（第二階段） | 拒絕，記錄 `tooWide` |
| 只升不降 | `stop ≥ ceilTick(prev.stop × 本期新增 Πf)` | `exAdjust`（已含在式中）、`costCorrection`、`init`、`eventExpire`；`bandRatchet=false` 時的 `bandDown`；第二階段的 `userSet` | 拒絕，記錄 `loosen` |
| 成本可疑 | 現價 ÷ 還原成本 < 0.25 或 > 5（第 11 項裁定） | — | 停損照算，但**抑制該檔一級警示**，改發二級「成本資料可疑」，每日一次。「本檔停損警示暫停」**也涵蓋**「已在停損下」彙總（`seeded`）與停損紀律彙總（§8.4）——這兩則都不列該檔（2026-10-07 線上查核 4746：均價 1562、收盤 48.30，停損是用可疑成本算的；`planUserStopTick`、`planDisciplineDigest`） |

- 「上一版合法」**不比較現價**：觸及事件進行中，現價本來就在停損下。
- `stopBooks/{uid}` 由 daemon 以 Admin SDK 寫入，Firestore 規則只開放本人讀取（§14），上面的檢查是防資料錯誤，不是防竄改。

### 3.5 AI 提議（選擇題）：第二階段，本次不實作

- 使用者第 4 項裁定：LLM 只能照抄系統停損；AI 提議停損只做影子紀錄。影子選擇題每個錨定事件要呼叫一次 Ollama，**列為第二階段**，v1.1 不跑、不寫 `positions[code].ai`。
- 規則保留在 `references/llm-contract.md` §1.3、§3（標「第二階段」），包括錨定日（加碼的錨定日＝該次加碼日，第 6 項裁定）、候選 S1～S4、硬界線 B1–B6、驗證 V1–V10。
- 既有證據不變：合格候選只在約 28.5% 的部位存在，效果是「多洗出換薄尾端」（`evidence.md` §2.5）。

### 3.6 缺資料時的退回規則（不捏造）

| 缺什麼 | 處理 |
|---|---|
| `avgCost` 不是正數 | 不算停損；顯示「—」與「成本資料缺」，不發任何停損警示 |
| 某筆的買進日早於係數表的涵蓋起點（`exUnknown`） | 停損照算，但該檔觸及**最高二級**，標「除權息資料不足（買進日早於 YYYY-MM-DD）」 |
| 今天是除權息日（依預告），但係數未知（`exPending`） | **當日暫停判定該檔**，顯示「除權息日·停損待調整」（§7） |
| 沒有預告來源，而且今日官方結果還沒取得（`exUnconfirmed`） | 觸及只發二級「除權息狀態未確認」；確認無事件後補發一級（§7、第 12 項裁定） |
| 歸檔少於 15 根（上市未滿、資料斷） | `bandLine`、`trailLine`、`atr14` 都是 null；成本線照算；保本線在有 `holdHigh`（買進日起有官方收盤）時照算；逼近改用 ≤2% |
| 沒有可用的官方日 K（5～6 碼與英文字尾 ETF、興櫃在 §2A 歸檔驗證前；或歸檔沒有這檔） | `lineInputsOf` 回 `noOfficialBars`：`bandLine`、`beLine`、`trailLine`、`atr14`、`holdHigh` 都是 null，不做補判與事件收緊。**不是** `linesStale`（不會隨時間補齊）。影子期只算成本線並分開統計；切換後該檔留在第一階段口徑（`legacyBranchActive(book, code)`，§2A）。R8 起 ETF／興櫃由本機鏡像供給時不再是 `noOfficialBars`（見 §2A「驗證前」列） |
| 係數表涵蓋不到日 K 視窗（`exGapBars > 0`） | 依 §3.4「係數涵蓋」列：當日不採用由日 K 算出的值，沿用上一版；S3 前回補 `exright-history.json` 並每日累加（硬閘門，§15-5） |
| 資料到齊班車到隔日 08:46 仍未完成（`linesStale`） | 組成線沿用上一版，畫面標「組成線資料日 MM/DD」，不做 `lineRaise` |
| 今日沒有真成交（未開盤、分盤處置股尚未撮合、停牌） | 不判定觸及；距停損以最後交易日收盤計算，標「◆ 前交易日」 |
| **前端**：`stopBooks` 存在但過期（`dataDate` 落後 >1 個交易日）或與目前持股的逐筆快照不符 | 用同一支 `resolveStop`、帶 `stopBooks` 裡的 `prev`、`ex`、`lines` 暫算（棘輪一樣生效），標「暫算·待 daemon 確認」 |
| **前端**：完全沒有 `stopBooks`（停損簿上線前，含戰情 v2 超管版） | 暫算＝`max(成本線〔買進均價，未還原〕, ATR 帶〔持股分析 analyses[code].stopLoss，向下取檔〕)`。ATR 帶**不棘輪**（`bandRatchet:false`）；成本線沿用戰情本機事件表記住的上一版只升不降（v1 暫算已有，維持第 6 項「攤平、部分賣出不下移」），沒有上一版就從當日算起；不含保本／追蹤／事件收緊，標「暫算·未含除權息調整；ATR 帶未棘輪」。**不得**自編數字。呼叫規則（兩個工程師要算出同一個值）：①不傳 `latestCanonicalYmd`，所以不做 `linesStale` 判定；②`lines.close` 傳 null，帶值檢查只驗數值與檔位；③`lines.dataDate`、`atrBand.dataDate` 一律傳**今日之前最後一個交易日**（`analyses[code].stopLoss` 以最近一個完整交易日的官方收盤夾值；與 daemon 一樣，今天收盤算出的帶隔一個交易日起才用）。⚠ 持股分析全天每 30 分鐘重算：交易日收盤歸檔後，帶值換成**當日**收盤版（資料日＝當日、隔一個交易日起才適用），前端仍標前一交易日——所以戰情本機事件表另記「該交易日 13:30 前最後看到的停損」（`sess`），隔天結算前一交易日的觸及事件一律用它（§8.2「當天適用的停損」），不用收盤後換過的最後一版（2026-10-05 審查：否則事件會被提前結束、隔天再發一次一級）；本裝置當日盤中沒看過該檔時才退回最後一版；④因此 `firstDate` 是今天的部位不套 ATR 帶、只有成本線（與 §3A.4 一致；第二輪 A1 已裁定買進當天不套）。程式：`resolveStop({ position, ex: EMPTY_EX_TABLE, prev, lines: frontLinesOf({ ratingBand, prevTradingYmd, isEtf }), bandRatchet: false, nowMs, tradeDate })` |

### 3.7 參數表 `STOP_PARAMS`（`stop-v1.1`；改任何一個都要重跑回測並經使用者核可）

```
SPEC_VERSION        = 'stop-v1.1'
CAP_PCT             = 8        // 成本線上限（使用者第 1 項裁定）
BAND_RATCHET        = true     // ATR 帶併入棘輪（第二輪 A2 已裁定；false 是回退開關，數字見 §3A.6）
BAND_ATR_MULT       = 0.5      // ATR 帶＝支撐 − 0.5×ATR14（沿用 calculateAtrStop）
BAND_CLAMP          = [0.85, 0.97]  // 夾在官方收盤的 −15%～−3%（沿用）
BAND_MIN_BARS       = 15       // 少於 15 根不算 ATR14、ATR 帶（沿用 calculateAtrStop）
BE_TRIGGER_PCT      = 10       // 持有期最高收盤 ≥ 還原成本 +10% ⇒ 保本線（第 8 項裁定）
TRAIL_TRIGGER_PCT   = 20       // ≥ +20% ⇒ 追蹤線
TRAIL_ATR           = 3        // 追蹤線＝持有期最高收盤 − 3×ATR14
EVENT_TIERS         = [        // 事件收緊依類別權重分級（第二輪 A4；類別權重＝新聞技能 §4.1 baseWeight，先驗·未回測）
  { tier:'strong', minWeight:0.7, atrMult:1, minPct:3 },   // 前收 − max(1×ATR14, 3%)
  { tier:'mild',   minWeight:0.3, atrMult:2, minPct:5 },   // 前收 − max(2×ATR14, 5%)
]                              // 權重 <0.3 ⇒ 不收緊（只記影子）；類別表在 scripts/lib/news-rule-classes.mjs
EVENT_HOLD_DAYS     = 5        // 事件收緊期限（交易日，生效日算第 1 天）
EVENT_REARM_DAYS    = 5        // 到期後同代號同類別再隔幾個交易日才可再收緊（先驗·未回測；§10A.4）
CLEAR_MULT          = 1.02     // 某交易日官方收盤 > 停損×1.02 ⇒ 觸及事件結束
NEAR_ATR            = 1.0      // 逼近（二級）：現價 − 停損 ≤ 1×ATR14
NEAR_PCT_FALLBACK   = 2        // 沒有 ATR 時：距停損 ≤2%
SUSPECT_LO / _HI    = 0.25 / 5 // 成本可疑門檻（使用者第 11 項裁定）
STALE_SEC           = 300      // 報價揭示超過 300 秒：畫面標「舊」（不抑制觸及判定）
DISCIPLINE_FROM_DAY = 2        // 紀律提醒從觸及事件的第 2 個交易日起
SHADOW_MIN_DAYS     = 20       // 影子期最少交易日數
ARCHIVE_FROM        = '2023-07-17'  // chipArchive 起點；買進日更早 ⇒ 持有期最高收盤 complete=false
```

- **兩級距離都沿用站上既有常數，不新造門檻**：1×ATR＝逼近界線（`NEAR_ATR`）、3%＝ATR 帶夾值上界；2×ATR、5%＝v1 AI 結構候選的距離下限（v1 的 `AI_MIN_ATR`、`AI_MIN_PCT`）。`evidence.md` §11 有兩條線的無條件診斷。
- **移除**（v1 有、v1.1 沒有）：`TRAIL_FROM_PCT`、`TRAIL_GIVEBACK`（獲利回落線退役，§5.2）；`AI_MIN_ATR`、`AI_MIN_PCT` 移到第二階段的 AI 選擇題參數（`llm-contract.md` §1.3）；草案的 `EVENT_TIGHT_ATR`、`EVENT_TIGHT_MIN_PCT`、`EVENT_CLASSES` 由 `EVENT_TIERS`＋類別表取代（關閉事件收緊的回退：`ruleBearEvents` 的 `classes` 傳空陣列）。

### 3.8 共用函式一覽（2026-10-05 已實作；簽章以 `scripts/lib/ai-stoploss.d.mts` 為準，實作計畫 §1.2 同步）

對外一律從集線器 `scripts/lib/ai-stoploss.mjs` 匯入（前端、daemon、測試路徑不變）；實作分在子模組，子模組只 import 下層、不 import 集線器（沒有循環）。

| 模組 | 函式／常數 | 用途 |
|---|---|---|
| `ai-stoploss-base.mjs` | `STOP_SPEC_VERSION`、`STOP_PARAMS`、`isEtfCode`、`tickOf`、`roundTick`、`ceilTick`、`floorTick`、`onTick`、`limitPrices`、`normYmd`、`nextTradingYmd`、`prevTradingYmd`、`addTradingDays`、`countTradingDays`、`stopPxText`、`costPxText`、`hhmmText`、`mmddText`、`signedPctText`、`signedAmountText`、`pnlClauseText`、`BREAKEVEN_NET_NOTE`、`stopSourceLabel`、`stopFactText`、`STOP_FACT_KINDS` | 版本與參數、檔位、交易日（休市日曆由呼叫端注入）、格式、來源標籤（唯一格式）、事實句 |
| `ai-stoploss-lines.mjs` | `BAR_ARCHIVES`、`barArchiveOf`、`hasOfficialBars`、`adjustBars`、`atr14Of`、`atrBandOf`、`holdHighClose`、`stepHoldHigh`、`profitLines`、`exCoverageOf`、`lineInputsOf`、`frontLinesOf` | 官方日 K 歸檔歸屬（§2A）、還原、ATR14、ATR 帶、持有期最高收盤（重算與增量）、保本與追蹤、係數涵蓋、組成線原料、前端暫算組成線 |
| `ai-stoploss-core.mjs` | `aggregatePositions`、`exTableFor`、`EMPTY_EX_TABLE`、`adjustedCost`、`classifyLotChange`、`legacyPushStop`、`legacyDisciplineStop`、`resolveStop`、`EPISODE_CONTINUE_REASONS`、`judgeSegment`、`segmentJudges`、`isTodayTrade`、`isSetToday`、`stopDistance`、`evaluateTouch`、`evaluateLateTouch`、`advanceEpisode`、`settleEpisode`、`carryEpisode`、`disciplineDay` | 彙總、還原成本、持股變動、決定停損、觸及判定與補判、觸及事件與延續、紀律天數 |
| `ai-stoploss-event.mjs` | `eventTierOf`、`eventLineOf`、`ruleBearEvents`、`stepEventOverlay`、`activeOverlays`、`eventShadowRows`、`missShadowRows` | 規則類利空、類別權重分級、收緊線、疊加層狀態機、命中與漏網影子紀錄（§10A） |
| `ai-stoploss-text.mjs` | `DISCIPLINE_TAIL`、`PLUNGE_TAIL_KEPT`、`OVERNIGHT_EXIT_PHRASE`、`FORBIDDEN_WORDS`、`scanForbidden`、`disciplineTailCount`、`disciplineDigest`、`stopTouchPushText`、`stopPushTextS2b`、`trailPushTextS2b`、`disciplinePushTextS2b`、`defenseListText`、`defensePushText`、`plungePushText`、`watchDropPushText`、`watchDropSummaryText`、`overnightOpenPushText` | 禁用詞掃描（兩個豁免）、紀律彙總、一級推播文字、九處推播文字（§8.6） |
| `ai-stoploss-llm.mjs` | `STOP_PROMPT_RULE`、`STOP_REF_FORMAT`、`stopPromptLines`、`hypotheticalStop`、`hypotheticalStopLine`、`parseStopRef`、`stripStopRef`、`extractStopPrices`、`validateLlmStopText` | LLM 停損文字（§10、`llm-contract.md`） |
| `ai-stoploss-plan.mjs` | `legacyBranchActive`、`unverifiedArchiveOf`、`mergeAlertsKeepUnacked`、`prevStateOf`、`planBookRefresh`、`planUserStopTick`、`planCloseSettle`、`planDisciplineDigest` | daemon 整合（只產生要寫什麼；phase 'shadow' 時呼叫端只寫 `stopBooks`）；`plan*` 收 `verifiedArchives`：live 時組成線來自未驗證官方鏡像歸檔的代號不發 v1.1 警示（R8） |
| `news-rule-classes.mjs`（集線器另轉出常用的幾個） | `RULE_BEAR_CLASSES`、`RULE_CLASS_BY_CODE`、`RULE_CLASS_BY_KEY`、`RULE_CLASS_CODES`、`RULE_LEGAL_PREFIX`、`LABEL_OVERRIDE_CLASS`、`CLASS_WEIGHT_NOTE`、`ruleClassOf`、`ruleSubOf`、`ruleClassesHit`、`classWeightOf`、`ruleReasonPrefix`、`ruleFactQuestion`、`parseRuleFactAnswer` | 規則類利空類別與類別權重的唯一來源（新聞管線與停損共用；§10A.2） |
| 刪除／不實作 | ~~`trailLine`~~（獲利回落線退役，§5.2）；~~`buildAiCandidates`、`aiProposalPrompt`、`parseStopChoice`、`validateStopChoice`~~（第二階段，§3.5） | — |

- 測試：`ai-stoploss.test.mjs`（v1 起的 A–E、I）、`ai-stoploss-core.test.mjs`、`-lines`、`-event`、`-text`、`-plan`、`news-rule-classes.test.mjs`（實作計畫 §5）。
- 影子流程（不在集線器）：`stop-shadow-core.mjs`（`officialBarsVerdict`、`bookAuditCounts.officialArchive`…）、`stop-shadow-runner.mjs`（`loadOfficialBars`、`verifiedArchives` 注入）、`official-bars.mjs`（`readOfficialBarsAsync`）；測試 `stop-shadow-*.test.mjs`、`official-bars.test.mjs`、`stop-daemon-pin.test.mjs`。
- 戰情前端（2026-10-05 本機）已改 v1.1 暫算：`resolveStop` 帶 `frontLinesOf` 的組成線、`bandRatchet:false`、空係數表（§3.6 最後一列）。v1 呼叫方式（不帶 `lines`／`events`）結果仍與 v1 相同（回歸測試）。

---

## 3A. 裁定落實：第 3 項「ATR 帶不停止觸發」

### 3A.1 規則

> **已裁定（第二輪 A1、A2「ok」，2026-10-05）**：使用者第一輪裁定「現行 ATR 浮動帶不停止觸發」，第二輪確認落實方式：同一個算法、改用**官方日 K**（還原）、**收盤資料到齊後算一次**、**隔一個交易日生效**、**買進當天不套**（A1），並**併入只升不降棘輪**（A2）。這和使用者現在看到、現行推播在用的 `/api/rating` 那條帶不是同一個數字（下面最後一點），差異在影子期逐檔量化。

- **算法**：`atrBandOf(bars)`，`bars` 是官方還原日 K（最後一根＝`dataDate`），照搬 `calculateAtrStop`（`src/lib/indicators.ts:177-201`）：
  - `atr = ATR14`（14 個 TR 的簡單平均）；`recentLow = 近 10 日最低`；`supportHint = MA20 × 0.98`（＝`/api/rating` 的標準買點，`analysis-enrich.ts:96-104`）。
  - 支撐＝低於收盤的候選（`supportHint`、`recentLow`）中最高者；沒有候選時＝收盤 − ATR。
  - 帶＝支撐 − 0.5×ATR，夾在 [收盤×0.85, 收盤×0.97]，**向下取到合法檔位**（留在結構外側，D17）。
  - 少於 15 根 ⇒ null。
- **算的時點**：每個交易日由 16:45 起的資料到齊班車（兩市收盤到齊，`writeCanonical` 同一個觸發點）算一次，版本日＝該資料日，**隔一個交易日起**用來判定（不是 `setToday`）。不在盤中重算。
- **哪些部位適用**：只用 `dataDate ≥ firstDate` 的帶值（部位在那天收盤時已持有）。今天才買的部位，當天只有成本線；當天收盤資料到齊後才有 ATR 帶。
- **觸發**：ATR 帶是組成線之一，透過生效停損觸發，判定口徑與其他線完全相同（§4：只認今日成交更新的最低價）。
- **和 `/api/rating` 的 `stopLoss` 是兩個數字**：後者的日 K 來自 `stockHistory`（Yahoo 寫入；過期時改抓 Yahoo 即時日 K），以**最近一個完整交易日的官方收盤**夾值（`src/app/api/rating/route.ts:41-56`、`:68-75`；`analysis-enrich.ts:100` `calculateAtrStop(bars, stock.price, standard.price)`），盤中現價只影響 `swingSignal`（`:76`、`:80`），所以盤中整天是同一個值，收盤資料更新後才變；持股分析約 30 分鐘重抓一次（`ANALYZE_MS`）。它繼續給進場前畫面用；持股停損用 `stopBooks` 的官方版。兩者的差異主要來自**日 K 來源**（Yahoo 對官方還原），v1 時逐檔只有 71.2% 完全一致；S3 起逐檔量化（§15-6）。

### 3A.2 與其他線的優先序

- ATR 帶與成本線、保本線、追蹤線**取最高**，再套棘輪；與事件收緊線再取最高（§3.3）。
- 合成母體 60 日中，v1.1 第一次觸發時的綁定來源：ATR 帶 84.2%、成本線 8.3%、追蹤線 4.6%、保本線 3.0%（`evidence.md` §10.2）。也就是說，**大部分時候生效停損就是 ATR 帶**；成本線只在 ATR 帶低於成本 −8%（高波動股帶被夾在 −15%、或深套時）才起作用。

### 3A.3 「跟著股價往下移」與棘輪的互動

1. **棘輪後不再往下移**：`bandHold = max(今日帶, 上一版 bandHold)`。股價下跌讓今日帶變低時，生效停損停在最高的那一次。
   - 持有日中，有 76.2% 的日子生效停損高於「當日 ATR 帶與成本線取高」，高出幅度中位為成本的 3.73%、p90 9.51%（`evidence.md` §10.3）。這就是棘輪改變的地方：ATR 帶實質上變成一條追蹤線。
   - 畫面同時顯示兩個數字，讓使用者看得到差異：`停損 106.0（ATR 帶·10/02 設定·只升不降）｜ATR 帶今日 98.5`。
2. **防止一次錯值永久鎖住**（棘輪的副作用）：
   - 只用**已定版的官方還原日 K**、每日只算一次。盤中高點、Yahoo 資料、單筆異常成交都不會進棘輪。
   - 帶值必須通過 §3.4 的帶值檢查與**係數涵蓋檢查**；不通過的那天不採用，`bandHold` 沿用上一版。係數表缺一筆視窗內的除息係數，是最可能把偏高帶值鎖進棘輪的情況（夾值擋不到），所以 S3 前要完成 `exright-history.json` 回補與每日累加（硬閘門）。
   - 除權息時 `bandHold` 與其他棘輪值一起 ×f（§7）。
   - 成本更正時所有棘輪歸零（§3.2）。
3. **另一種做法（未採用；A2 已裁定併入棘輪，保留為回退開關）**：`BAND_RATCHET=false`，ATR 帶取當日值、不棘輪，只有成本線／保本線／追蹤線棘輪。這保留了現行「帶會往下移」的行為，但生效停損會下降（版本原因 `bandDown`，自檢列為例外）；資料延遲或帶值不通過的那天沿用上一版帶值，不會掉成只有成本線。兩者的數字對照在 §3A.6。停損簿上線前的前端暫算用的是這個模式（§3.6）。

### 3A.4 邊界情況

| 情況 | 處理 |
|---|---|
| 今天買進的部位 | 當天只有成本線（與 v1 相同）；ATR 帶從當天收盤資料到齊後才加入，隔天起判定。**與現行不同**：現行推播買進當天就用 `/api/rating` 的帶。第二輪 A1 已裁定照此（買進當天不套） |
| 帶值高於收盤（理論上不會，夾值保證 ≤ 收盤×0.97） | 帶值檢查不通過，當日不採用 |
| ATR 帶抬高停損時，觸及事件正在進行 | 事件延續、不重發一級（§8.2 版本延續表：`lineRaise` 延續） |
| 部位在獲利中觸發 | 照發一級；推播與畫面寫明「ATR 帶」與「仍獲利 +x%」（§9）。首次觸發時獲利中的比例 29.0%（現行同口徑 27.7%；v1 的 27.9% 是未套跌停收盤成交的口徑） |
| 處置股、注意股 | 不影響帶值（處置不調整停損，§4.5） |
| 除權息日、係數未知 | 當日暫停判定（§7），帶值照常在收盤後計算 |
| 前端暫算（停損簿上線前） | 用持股分析的 `analyses[code].stopLoss` 當 ATR 帶（Yahoo 來源日 K、以前一完整交易日官方收盤夾值、持股分析約 30 分鐘重抓一次），向下取檔、ATR 帶**不棘輪**、今天買進的部位不套，標「暫算」（§3.6 最後一列） |
| 資料到齊班車延遲（例如上櫃 21:37 才到） | 照延遲時刻計算，隔日 08:46 前沒算完就 `linesStale`，沿用上一版 |
| 5～6 碼與英文字尾 ETF、興櫃 | 用 §2A 另建的官方日 K 歸檔算；歸檔通過驗證前沒有官方日 K，算不出 ATR 帶，切換後留在第一階段口徑（現行帶照舊觸發） |

### 3A.5 要新增的測試（實作計畫 §5 的 L 組）

- `atrBandOf` 與 `calculateAtrStop` 的金樣本比對（同一組 bars、price＝最後收盤），差異只能來自向下取檔（≤1 檔）。少於 15 根 ⇒ null；沒有支撐候選 ⇒ 收盤 − ATR；夾值上下界各一例。
- 帶值只認 `dataDate ≥ firstDate`；今天買進 ⇒ 只有成本線。
- 係數涵蓋：日 K 視窗內有一筆除息事件、但係數表 `coverFrom` 晚於視窗起點 ⇒ `bandInvalid`、`exGapBars > 0`、`bandHold` 不被抬高（與有係數時的結果比對）。
- 沒有可用官方日 K 的代號（ETF／興櫃歸檔驗證前）⇒ `noOfficialBars`、只有成本線、`legacyBranchActive(book, code)` 為真；`hasOfficialBars(code, { verifiedArchives })` 驗證後為真。
- 棘輪：帶由 105 降到 98.5 ⇒ 生效停損維持 105、`stopSource='atrBand'`、`sourceDate` 是設定 105 的那天；`BAND_RATCHET=false` ⇒ 降到 max(98.5, floorStop)、`versionReason='bandDown'`、自檢不記 `loosen`。
- 帶值檢查：NaN、≤0、不在檔位、≥ 收盤、`dataDate` 不是最近定版日 ⇒ `bandInvalid`、沿用上一版。
- 除權息 f＝0.962 ⇒ `bandHold` 帶下來 ceilTick(×f)、事件延續。
- 成本更正 ⇒ 所有棘輪歸零。
- 觸及事實句含來源標籤與損益正負（獲利中寫「仍獲利」）。
- 原始碼釘住：daemon 的觸及判定只讀 `stopBooks` 的 `stop`，不讀 `analyses[code].stopLoss`（S5 起）。

### 3A.6 對推播數量的預估影響（合成母體 n=142,564，持有到 60 日不賣）

> **適用範圍與限制**：①只適用**收盤進場的新部位**（回測成本＝進場日收盤、棘輪從進場日起算）；盤中進場（買進當日收盤可能已 ≥ 成本×1.10，或當天帶值已高於成本）與 S3／S5 開始時**已經持有的部位**（ATR 帶棘輪從 init 當天才起算，保本與追蹤卻用整段持有期最高收盤）都沒有回測，S4 影子報告要把「切換前既有部位」與「切換後新建部位」分開統計。②現行推播那一欄以官方還原日 K、日低重建，是上界；線上用 Yahoo 來源的帶與 60 秒快照價。③母體有前視選樣（排除日後停牌、下市、大跳空的部位，`evidence.md` §9-3），**尾端數字是下界**。

| | 現行推播 A（浮動帶、每日去重） | v1（成本線） | **v1.1（本規範）** | 替代：帶不棘輪 |
|---|---|---|---|---|
| 60 日內觸發 | 83.7% | 58.1% | **97.7%** | 89.2% |
| 洗出（20 日內回到成本／10 日內） | 62.1%／52.9% | 35.6%／22.3% | **69.1%／60.0%** | 64.1%／54.9% |
| 與不停損差（停損價成交／鎖死順延） | −3.49／−3.57pp | −2.61／−2.74pp | **−4.41／−4.47pp** | −4.08／−4.15pp |
| P5（停損價成交／鎖死順延） | −12.46／−12.88% | −10.22／−10.89% | **−8.00／−8.00%** | −8.11／−8.15% |
| ≤−15%（停損價／日低成交） | 2.35%／3.26% | 0.61%／1.05% | **0.10%／0.18%** | 0.15%／0.27% |
| ≤−15%（鎖死順延） | 2.91% | 1.93% | **0.60%** | 0.72% |
| ≤−15%，2025 年起進場（停損價／鎖死順延；不停損 18.91%） | 2.82%／4.26% | 0.81%／4.27% | **0.07%／1.37%** | 0.12%／1.59% |
| 首次觸發時在獲利中 | 27.7% | 0% | **29.0%** | 26.7% |
| 首次觸發在持有第幾日（中位） | 16 | 14 | **9** | 13 |
| 一級則數／部位·60 日 | 2.69（每日去重） | 1.21 | **2.42**（事件去重） | 2.33 |
| 紀律日／部位·60 日（第 2 個交易日起） | 15.14（現行第 1 天起、每檔每日） | 11.93 | **25.74**（≥20 天 59.2%） | 16.72 |

- 鎖死順延：觸發日一字跌停（開＝高＝低＝收，且收 ≤ 前收×0.905）就順延到下一個非鎖死日開盤出場（`evidence.md` §10.1）。這比「收在跌停以收盤成交」更貼近賣不掉的實況；v1.1 的 ≤−15% 由 0.10% 變成 0.60%（約 6 倍），2025 年起進場的部位更到 1.37%。排序不變，絕對值以鎖死順延為準。
- **部位層遷移**（60 日內有沒有收到一級停損）：回測中 v1.1 的停損**逐日不低於**重建的現行帶（v1.1 是包含那條帶的逐日最大值再加棘輪，構造使然），所以重建口徑下不會出現「只有現行會響」或「v1.1 較晚觸發」——這是定義的結果，不是證據。線上現行推播用 Yahoo 來源的帶與快照價，實際的遷移（新收到、不再收到、早晚）要在 S4 影子期，以同一份報價、線上帶與官方帶並行量出。v1 那張「28.2% 不再收到」的遷移表，在 v1.1 不適用。
- **兩兩成對差**（以進場日區塊 bootstrap）：v1.1 減現行 −0.96pp［−1.81, −0.21］；替代減 v1.1 +0.37pp［−0.03, +0.76］；棘輪本身（帶棘輪減不棘輪、都不含保本追蹤）−0.61pp［−1.17, −0.06］。
- **紀律推播**：v1.1 的停損停在高處，收盤留在停損下的日子變多；但每位使用者每天最多一則彙總（§8.4），所以推播則數的上限是「交易日數」，不是「檔數 × 日數」。
- 讀法：v1.1 是各方案中**觸發最多、洗出最多、平均最低、尾端最薄**的一個。這是保護與讓利之間的取捨，不是改善。

---

## 4. 觸發判定（`evaluateTouch`；同 v1，只列差異）

### 4.1 用什麼價

- **觸及**：今日最低價 `low ≤ stop`（`stop` 是生效停損，已含 ATR 帶、保本、追蹤、事件收緊）。
  - MIS 的 `l` 只會被成交更新（`ai-daemon.mjs:1538-1545` 的註解），不怕 60 秒輪詢漏掉短暫觸價，也不受試撮價、五檔中價影響。
- **報價必須同時滿足**：有 `liveAt` 且台北日期是今天；`volume > 0`；`low > 0`、`onTick(low)`；已知跌停價時 `low ≥ 跌停價`。種子價沒有 `liveAt`，一律不用。
- **不得用來判定觸及的價**：試撮 `pz`、五檔中價或買一（`quoteLive`）、昨收種子價、前一日殘留的 `_lastLive`。
- `price ≤ stop` 只能拿來**顯示**「現價在停損下」，不能拿來發觸及警示，唯一例外是下一條。
- **今日盤中才生效的停損版本**（`setToday`：版本日是今天、`startedAt` 晚於今天 09:00）：盤中新買、盤中加碼、盤中成本更正，以及**盤中判出的事件收緊**（§10A.4）。
  - 改用 daemon 快照中「`liveAt > startedAt` 的真成交價」`price ≤ stop` 判定，並標「依成交價判定（今日新設停損）」。
  - 「真成交價」的條件：`realTrade === true`、不是處置股、不在 13:24–13:35。不符條件 ⇒ 當日不判定；處置股的今日新設停損也不做收盤後補判，隔天起用 `low`。
  - 開盤前生效的版本（08:46 的除權息調整、盤前判出的事件收緊、16:45 的組成線抬高、前一晚或週末改的持股）**不算** `setToday`，當天一律用 `low`。
  - 「設定後最低成交」要由 daemon 新增狀態才能做到，屬第二階段（第 16 項裁定）。

### 4.2 時段表（直接對應 `scripts/lib/warroom-session.mjs` 的 `WAR_SEGMENTS`）

| `WAR_SEGMENTS` | 台北時間 | 判定 |
|---|---|---|
| `pre`、`preclear` | 08:30–09:00 | **不判定**；顯示「開盤前·不判定」 |
| `open` | 09:00–09:30 | 判定（`low`）；開盤第一筆 `open ≤ stop` 記為**跳空**（§4.3） |
| `mid`、`tail` | 09:30–13:25 | 判定（`low`） |
| `auction` | 13:25–13:30 | **不以價格判定**；顯示「收盤競價中」 |
| `closing` | 13:30–13:45 | 判定（`low` 已含收盤那筆），`sub:'close'` |
| `after` | 13:45 之後、08:30 之前 | 不即時判定；**16:45 起的資料到齊班車補判**（`evaluateLateTouch`），`sub:'late'`，**發一級**（第 5 項裁定） |
| `nontrading` | 非交易日 | 不判定；紀錄的資料日記為最後交易日 |

- 收盤後補判：官方日低 ≤ 停損、該檔今天沒有觸及事件、而且不是 `setToday` 的版本，就開事件 `kind:'late'`，標「收盤後補判」。補判用的停損是**當天盤中適用的那一版**（16:45 之後才算的組成線抬高，不回頭套到當天）。漏判原因若是 daemon 當機或讀取失敗，依「交易日不得有資料缺漏」另寫警示文件。

### 4.3 跳空、4.4 跌停鎖死、4.5 處置股、4.6 資料新鮮度

與 v1 相同（v1 §4.3–§4.6 原文照用）：

- 跳空：事件類型 `gap`，觸發價＝開盤價，記錄 `skipPct`；只寫事實，不規定之後怎麼處理。成本線第一次觸發中開盤即跳過的占 15.8%；v1.1 的組合為 12.7%（`evidence.md` §10.1）。
- 跌停：`low` 等於今日跌停價就加註「今日在跌停價 X 有成交」，開＝高＝低＝跌停加註「今日未曾高於跌停價」。跌停價以「官方歸檔前收 × 今日係數」當參考價；拿不到或無漲跌幅限制就不寫。
- 處置股：停損價**不調整**；觸及照一般規則；今日新設停損不用盤中成交價判定；揭露「處置中（撮合方式：{公告原文}）：觸價以成交價判定，實際成交可能低於停損價」。
- 新鮮度：觸及判定**不因報價舊而暫停**（`low` 單調、只由成交更新）；超過 120 秒空心點、超過 300 秒標「舊」並附「報價延遲 N 分」。從成交到一級推播一般約 2 分鐘，最壞約 4 分鐘以上（alertLoop 每輪 p50 77 秒、p90 85 秒）。

---

## 5. 裁定落實：第 8 項「獲利後要上移停損」

### 5.1 規則

- **持有期最高收盤** `holdHigh`：自最早買進日（**含**買進當日收盤）到 `dataDate` 的**官方還原收盤**最高值。
  - **增量維護、存在 `stopBooks`**（`{ price, dataDate, complete }`）：每個資料到齊班車只拿當日那一根官方收盤 `stepHoldHigh` 更新 `holdHigh = max(prev.holdHigh × Πf, 當日收盤)`（遇除權息 ×f）；只有「持有期起點改變」（FIFO 賣掉最早一筆、成本更正、新部位）時才用 `holdHighClose(bars, firstDate)` 從 Firestore `chipArchive` 重算一次。這樣每天只讀當日一份歸檔，不必每天把長期持股的數百份文件讀回來；`stopBooks` 持久化，**重啟不會失效**，取代記憶體 `_hwm`（HEAD `ai-daemon.mjs:3201`，工作樹 `:3209`）。
  - 歸檔從 2023-07-17 起（`backfill-chip-3y.mjs:35`）：買進日更早的部位 `complete=false`，用可得的收盤，畫面標「最高收盤資料不完整（歸檔自 2023-07-17）」；不捏造。
  - 用**收盤**不用盤中日高：回測口徑是最高收盤（波段 §6、`evidence.md` §5.1），盤中日高會被單筆成交拉動。落實要求原文寫「高水位用官方日高」，本規範解讀為「用官方歸檔資料、不用記憶體」，量的是收盤；第二輪「其它都ok」已確認此解讀（§13.2 B2）。
- **保本線**：`holdHigh ≥ adjCost × 1.10` ⇒ `beLine = ceilTick(adjCost)`（毛額保本；費稅約 0.38%，所以淨額約 −0.38%）。
- **追蹤線**：`holdHigh ≥ adjCost × 1.20` ⇒ `trailLine = ceilTick(holdHigh − 3 × atr14)`，`atr14` 用 `dataDate` 的值。
- 兩條線都是組成線，進 `floorStop` 的棘輪：ATR14 變大使追蹤線算出較低的值時，停損不下移。
- 計算時點同 ATR 帶：資料到齊班車每日一次，隔一個交易日起判定。

### 5.2 與現行「獲利回落線」的關係：**取代**，不並存

| | 現行獲利回落線（`type:'trailing'`） | v1.1 保本線＋追蹤線 |
|---|---|---|
| 啟動 | 盤中高水位 ≥ 成本 +10% | 最高收盤 ≥ 還原成本 +10%（保本）／+20%（追蹤） |
| 線 | 高水位 ×0.92 | 還原成本／最高收盤 −3×ATR14 |
| 高水位 | 記憶體 `_hwm`：從平均成本起算，取 60 秒快照現價（可能是五檔中價或 `pz`）的最大值，daemon 重啟就歸零 | Firestore `chipArchive` 官方還原收盤，存在 `stopBooks` 增量維護 |
| 等級 | 二級，每日去重，**照現行推播**（「建議鎖利出場」） | 屬生效停損，觸及發**一級**，每事件一次 |
| 判定價 | 快照 `price`（可能是五檔中價或 `pz`） | 今日成交更新的 `low` |

- **v1.1 生效時（`phase==='live'`）**：daemon `checkAlerts` 的 `trailing` 分支停用，`_hwm` 不再更新；`PortfolioAlerts` 的 `'trailing'` 型別保留（顯示舊紀錄）。全站只剩一種獲利後口徑。例外：ETF／興櫃官方日 K 歸檔驗證前，這類代號留在第一階段口徑（§2A），它們的 `trailing` 照舊。
- 「取代」是對第 8 項的解讀（v1 第 8 題問「維持現行獲利回落線，或改用 +10% 保本／+20% 追蹤」，另問「獲利回落線要不要繼續推播」）；第二輪「其它都ok」已確認（§13.2 B3）。
- **第一階段與影子期**：舊 `trailing` 分支照跑（`legacyBranchActive`），文字先改成事實句（§8.6 #2）。
- v1 原本規劃的 S6（獲利回落線高水位改官方資料、分開上線）**併入 S5**：回落線退役，沒有東西要分開上線。

### 5.3 優先序

- 保本、追蹤與成本線、ATR 帶取最高（§3.3）。合成母體中，v1.1 第一次觸發由追蹤線決定的占 4.6%（觸發時損益中位 +15.3%、99.6% 在獲利中）、由保本線決定的占 3.0%（觸發時損益約 0）。其餘多半已被棘輪後的 ATR 帶蓋過。
- 若選 §3A.3 的替代方案（帶不棘輪），保本與追蹤的角色變大：首次觸發由保本 6.5%、追蹤 10.7% 決定。

### 5.4 邊界情況

| 情況 | 處理 |
|---|---|
| 攤平使還原成本下降 | 保本、追蹤的觸發門檻用新成本算（較容易達到）；已上移的停損不下移 |
| FIFO 部分賣出、最早一筆被賣掉 | 持有期起點改為剩餘批次最早買進日，`holdHigh` 重算；已上移的停損不下移 |
| 加碼使還原成本上升 | 門檻用新成本算；已啟動的保本線依新成本重算（較高）；棘輪保留 |
| 除權息 | 存著的 `holdHigh` ×f（與還原日 K 同口徑）；已啟動的線 ×f |
| 成本更正 | 棘輪歸零，`holdHigh` 從更正後的最早買進日重算，依更正後成本重新判斷是否已達 +10%／+20% |
| 歸檔有缺日、或買進日早於 2023-07-17 | `holdHigh` 用可得的收盤，`complete=false`，標「最高收盤資料不完整」；不捏造 |
| ETF／興櫃歸檔驗證前 | 沒有 `holdHigh`，保本與追蹤都不算；驗證後照常（§2A） |
| 今天買進 | 當天沒有保本、追蹤；收盤後才開始累計 |

### 5.5 要新增的測試（實作計畫 §5 的 M 組）

- `holdHighClose` 含買進當日收盤、不含買進前；缺日標記；買進日早於歸檔起點 ⇒ `complete=false`。
- 增量維護：連續 N 天每天只餵當日一根，結果與一次重算相同；除權息 ×f 後也相同。
- 保本邊界：最高收盤 ＝ 還原成本×1.10（含）啟動、×1.0999 不啟動；`beLine = ceilTick(adjCost)`。
- 追蹤邊界：×1.20；`trailLine = ceilTick(holdHigh − 3×ATR14)`；ATR 變大使追蹤線下降 ⇒ 停損不動。
- 攤平、部分賣出、加碼、成本更正各一例，與 §5.4 一致。
- 原始碼釘住：`phase==='live'` 時 `checkAlerts` 不再產生 `type:'trailing'`，也不讀寫 `_hwm`；`phase!=='live'` 時舊分支照跑（回滾測試）。

### 5.6 對推播數量的預估影響

- **消失**：現行 `trailing` 推播。**實數**（daemon 日誌 `ai-daemon.out.log`，2026-06-29 起；推播事件落在 07-14～09-30）：「移動停利觸發」28 則（2 位會員）、「觸及停損」24 則（3 位會員），約 1.2：1。合成母體的每部位 60 日 16.09 則（約為停損推播的 6 倍）只是理論上界（以日低近似快照價、未計 `_hwm` 重啟歸零與 `take` 優先；`evidence.md` §10.4），不當量級用。退役後實際少掉多少，由 S4 影子期「`trailing` 消失量」實測。
- **出現**：保本線、追蹤線觸及時的一級，已含在 §3A.6 的 v1.1 一級則數（2.42）裡；它們是第一次觸發來源的 7.6%。
- 淨效果：獲利後的提醒由「每日可能重複的二級」變成「每事件一次的一級」。

## 6. 時間停損

- `general` **不設**（同 v1）。隔日沖、當沖、swing5 的時間出場在 `references/modes-phase2.md`，等 ND14。

## 7. 除權息與結構事件（同 v1，加組成線）

- **係數表只有一張**：`mergeFactorItems(官方除權息 items, priceEvents)`（`scripts/lib/exright-source.mjs:54-58`）。還原成本、ATR14、ATR 帶、持有期最高收盤、跌停參考價都用它。不得只用 `getExFactorOf` 或只用 `applyPriceFactors(…, loadPriceFactors())`。
- **調整**：成本逐筆乘 f；所有棘輪值（`floorStop`、`bandHold`、事件收緊線）`ceilTick(prev × f)`。這是停損允許下移的情況之一（另兩種是成本更正與事件收緊到期）。
  - `versionReason='exAdjust'`，進行中的觸及事件**延續**，不重發一級。
  - 使用者自己把張數與買價改成新口徑時，依 §3.2 判成「使用者自行調整」，不重複乘。
- **今天是不是事件日**、**處理**（`exPending` 暫停判定、`exUnconfirmed` 只發二級並在確認後補發一級、`exUnknown` 最高二級）、**時點**（08:46 之後、09:00 之前抓今日官方結果，最多重試 3 次）、**涵蓋缺口**（`exright-history.json` 只到 2026-09-30；S3 前回補並設定每日累加，列為**硬閘門**，因為 ATR 帶進棘輪後，缺係數會把偏高的帶值鎖住，§3.4「係數涵蓋」）、**請求數**（每日約 2 次官方請求，與人數無關）：全部同 v1 §7，使用者第 12 項裁定照預設。
- 上市預告 TWT48U 改存**全表**（不篩 4 碼、不截 40 筆）；上櫃與 ETF 沒有預告來源。
- **依據**：60 日持有中 23.0% 跨過除權息日；不調整時其中 9.17% 被誤觸，係數 ≤0.97 時 15.88%（波段 §10.8）。

---

## 8. 警示分級、去重與停損紀律

### 8.1 一級（推播＋戰情 Z2 打斷＋要按「收到」）

一級只限 `line==='stop'`、成本不可疑、沒有 `exUnknown`／`exUnconfirmed` 降級的使用者持股。每個觸及事件只推一次。

| `type` | `sub` | 條件 |
|---|---|---|
| `stop` | `touch` | 盤中 `low ≤ stop`，本事件第一次 |
| `stop` | `gap` | 開盤成交價 ≤ stop（與 `touch` 互斥） |
| `stop` | `close` | `closing` 時段才第一次判到 |
| `stop` | `late` | 資料到齊班車的收盤後補判（第 5 項裁定：一級） |

- **必帶欄位**：`id: 'stop:<code>:v<stopVersion>:e<episodeId>'`、`requireAck: true`；另帶 `sub`、`stopVersion`、`episodeId`、`touchBasis`（觸及判定價：`low`／`trade`／`officialLow`，§1）、`skipPct`、**`stopSource`、`sourceDate`、`pnlPct`**（讓獲利中觸發可辨識）。
- `type` 沿用 `'stop'`，`PortfolioAlerts.tsx`、推播標籤（`tag: stop-<code>`）不必改。
- **寫入**：`alerts` 文件用 transaction；超過 40 則時優先保留「尚未收到的一級」（`mergeAlertsKeepUnacked`）。前置條件：`alerts-split` 已上線（critique H3）。

### 8.2 去重與版本延續

- 觸及事件存在 `stopBooks/{uid}.positions[code].episode`，跨日、重啟都不會遺失；當日重啟保護用 `alertDedup('alerts')`，鍵 `${uid}:${code}:stop:v${stopVersion}:e${episodeId}`。
- **事件結束**：某交易日官方收盤 > stop×1.02，或部位出清。
- **停損換版時，事件延續還是結束**（v1.1 因每日組成線抬高而換版次數變多：合成母體每部位 60 日平均上調 11.6 次）：

  | `versionReason` | 進行中的事件 | 理由 |
  |---|---|---|
  | `exAdjust` | 延續 | 同一價格事實換口徑（v1） |
  | `lineRaise` | 延續 | 每日組成線抬高；收盤 > 停損×1.02 時事件已先在同一班車結束 |
  | `eventTighten` | 延續 | 新聞一級另有類別，不重複打斷（§10A.6） |
  | `eventExpire`、`bandDown` | 延續 | 停損下降，事件依收盤 > 新停損×1.02 自然結束 |
  | `ratchet`（持股變動）、`costCorrection`、`init`、`userSet` | 結束；之後再觸及是新事件 | 部位本身變了（v1） |

- **為什麼不沿用每日去重**：v1.1 的停損多半停在高處，若每日去重，同一部位 60 日會收到 29.76 則（`evidence.md` §10.1）；事件去重是 2.42 則。

### 8.3 二級（Z2 不打斷；只寫進 `alerts` 文件；**不新增推播**）

- 新的二級一律 `type:'stopInfo'`，只寫文件、不推播。`planUserStopTick` 分開回傳 `pushAlerts`（一級）與 `docOnlyAlerts`（二級）。
- `stopInfo` 包含：除權息調整、除權息日暫停判定、除權息狀態未確認、除權息資料不足（含除權息資料不足時的觸及 `touchHeld`）；成本資料可疑；切換當天已在停損下的彙總（`seeded`）；**事件收緊生效、未生效（成交價已低於收緊線）、未改變停損（`noBite`）、到期**（§10A）；**組成線資料延遲**（`linesStale`）。id 一律 `stopInfo:{代號}:{sub}:{日期或事件}`，同一件事寫一次。
- **逼近**：`現價 − stop ≤ 1×ATR14`；沒有 ATR 時距停損 ≤2%。前端自己算，A1 顯示琥珀色；daemon 不推播、也不寫文件。
- 現行的**獲利回落線**推播：第一階段照舊（文字依 §8.6 #2 改），v1.1 生效時退役（§5.2）。

### 8.4 停損紀律（第 7 項裁定：保留每日推播與「請面對決策」）

- 使用**同一個生效停損**（含 ATR 帶棘輪、保本、追蹤、事件收緊）。現行紀律 `max(浮動帶, 成本×0.92)` 的獨立算法廢除。
- 觸發第一天只發一級 `stop`，不再同時發紀律。
- 從事件的**第 2 個交易日**起：前一交易日的官方收盤 ≤ stop、而且事件仍在進行中，就算一天。天數用交易日計算。
- **每日推播保留**（第 7 項裁定「要留」）：每位使用者每天最多一則**彙總**，`type:'discipline'`，照現行推播（不改成一級、不改成只寫文件）。
- **「請面對決策：停損或明確寫下續抱理由」保留**，附在彙總最後一次，不受第 9 項改寫影響。這是本規範唯一允許的指令句，禁用詞掃描對這一句豁免（§9）；豁免範圍是 `disciplineDigest` 的輸出，以及舊紀律分支（S2b 文字，回滾時仍在用）的結尾，兩者都只含一次。
- 範例：`⛔ 停損後收盤仍在停損下：2330 台積電 事件第 3 個交易日（前一交易日收盤 50.10／停損 52.35·ATR 帶；觸及時 51.90，與前一交易日收盤差額約 −1,800 元）、2317 鴻海 事件第 2 個交易日（…）— 請面對決策：停損或明確寫下續抱理由`
  - 現行「若觸發當日執行，可少虧約 X 元」改寫成事實「觸及時 p0，與前一交易日收盤差額約 X 元」。
  - **差額的定義（S2b 與 S5 同一個）**：差額＝(比較價 − 觸及價 p0) × 張 × 1000，**帶正負號、一律寫出**；比較價在 S5 是前一交易日官方收盤，在 S2b 是現價。負數表示比較價低於觸及價。現行只在「現價低於觸及價」時寫，v1 核可的改寫是一律寫出，照核可版。
- 「維持現行」的解讀：保留的是**每日推播**與**那一句話**；v1 的其他紀律改動（同一停損、第 2 個交易日起、交易日計數、每人每日彙總）照 v1 預設。第二輪「其它都ok」已確認此解讀（§13.2 B1）。
- 預估：v1.1 每部位 60 日紀律日 25.74（≥20 天 59.2%），高於 v1 的 11.93 與現行的 15.14；但每位使用者每天最多一則。

### 8.5 其他使用同一停損的地方與隱私

- 崩盤防禦（HEAD `:11142`）的距停損、投資論點卡（`:9324` 建立時寫入的值），都改讀生效停損。
- 大盤危險是另外的一級類別，不改動個股停損價。新聞的規則類重大利空會**暫時收緊**停損（§10A），但它在 Z2 的一級是新聞類別，與停損一級分開。
- **隱私**（第 15 項裁定：個人推播**不隱藏**停損價）：
  - 個人警示（自己的 `alerts` 文件、Web Push、Telegram）照常寫出停損價（現行行為）。
  - 公共訊息（`pushAgentMsg`，`:2904` 隱私線）與戰情 Z2 的畫面文字不寫個人停損價（`events.ts:7`）。

### 8.6 現行推播文字改寫（第 9 項裁定；全文與逐處改法在 `wording.md` §3、實作計畫 §2.8）

- 9 處全部改成只描述事實的句子；**例外**：#3 停損紀律保留「請面對決策：停損或明確寫下續抱理由」（第 7 項）。
- #6 指數急落的後半句「隔日沖偏多策略暫停追價」：**已裁定保留**（第二輪 A6「保留」）。S2b 只刪前半句「持股請確認停損價位；」，後半句**保留原文**（`PLUNGE_TAIL_KEPT`；禁用詞掃描本來就掃不到它，但它是「只描述事實」原則的唯一公共訊息例外）。附帶事實：全檔查無讀取 `plunge` 狀態去暫停策略的程式。
- #9 隔日沖開盤提醒改成「若為隔日沖計畫」的條件句（第 13 項裁定）。句中「出場時點」是在描述站上隔日沖規則的時點（v1 核可文字），**#9 不套禁用詞「出場」**，其餘禁用詞照掃（`wording.md` §2）。
- 九處的文字都由共用函式產生（`stopPushTextS2b`、`trailPushTextS2b`、`disciplinePushTextS2b`、`defenseListText`、`defensePushText`、`plungePushText`、`watchDropPushText`、`watchDropSummaryText`、`overnightOpenPushText`；O 組測試釘住），daemon 只換字串、不動判斷。
- 9 處都可在 S2b（第一階段）先改字：#3–#9 的 S2b 版就是定稿（#3 的天數在 S5 才改成交易日、改成每人每日彙總）；#1、#2 的 S2b 版是「舊算法下的事實句」（拿掉指令尾句、移動停利改稱獲利回落線），完整事實句（今日最低、來源標籤）要等 S5 才有資料，#2 在 S5 退役。

---

## 9. 畫面用語（只描述事實，不下指令）

範本全集見 `references/wording.md`。

| 情境 | 範本 |
|---|---|
| 一般（成本線） | `停損 52.35（成本線·還原成本 56.90 −8%）｜距 3.4%（1.2 ATR）` |
| 一般（ATR 帶） | `停損 106.0（ATR 帶·10/02 設定·只升不降）｜ATR 帶今日 98.5｜距 2.1%（0.8 ATR）` |
| 一般（保本／追蹤） | `停損 56.95（保本線·持有期最高收盤曾達 +10.4%·未含費稅；淨額約 −0.38%）`；`停損 118.0（追蹤線·持有期最高收盤 131.0 −3 ATR）` |
| 事件收緊 | `停損 98.0（事件收緊·10/05 法律事件·至 10/12）｜基礎停損 92.5（ATR 帶）` |
| 觸及 | `今日最低 105.5 觸及停損 106.0（ATR 帶·10:42 揭示）·現價 106.5·持有仍獲利 +6.2%（未含費稅）` |
| 觸及（虧損中） | `今日最低 51.90 觸及停損 52.35（成本線·10:42 揭示）·現價 52.80·持有損益 −8.1%（未含費稅）` |
| 跳空 | `開盤 50.40，已低於停損 52.35（ATR 帶，差 3.7%）·持有損益 −11.4%（未含費稅）` |
| 收盤時段才判到 | `收盤時判定：今日最低 52.10 低於停損 52.35（ATR 帶）·持有損益 −7.9%（未含費稅）` |
| 收盤後補判 | `收盤後補判：今日最低 52.10 低於停損 52.35（ATR 帶·盤中未即時判到）·持有損益 −7.9%（未含費稅）` |
| 紀律彙總 | `事件第 3 個交易日（前一交易日收盤 50.10／停損 52.35·ATR 帶）` ＋ 結尾「— 請面對決策：停損或明確寫下續抱理由」（保留句） |
| 除權息 | `停損已依 07/15 除息調整（係數 0.962）：54.40 → 52.35` |
| 試撮 | `開盤前·不判定`／`收盤競價中·不判定` |

- **禁用詞**（系統產生的停損推播、警示與畫面字樣）：建議、請、應、必須、立即、認賠、勿、不要、續抱、賣出、出場、鎖利、面對決策、檢視風險。完整清單在 `wording.md` §2。
  - **唯一豁免**：停損紀律彙總結尾的「請面對決策：停損或明確寫下續抱理由」（第 7 項裁定）。測試要釘住：只有 `disciplineDigest` 的輸出與舊紀律分支（S2b 文字）的結尾可以含這一句，而且各只含一次；其他任何文字都不得含。
  - **#9 的「出場時點」**：描述站上隔日沖規則的時點，不套「出場」這個禁用詞（§8.6）。
- **LLM 欄位豁免**：持股分析的 `ACTION`、`TRIGGER`、`分析`，個股波段分析與問AI 的回答，語氣屬於既有功能，只校正停損數字（§10.3）。系統加註另起一行附在欄位末尾。
- **來源標籤一律寫出**，而且只由 `stopSourceLabel` 產生（唯一格式）：`成本線`、`ATR 帶`、`保本線`、`追蹤線`、`事件收緊·{MM/DD} {類別名}`（例 `事件收緊·10/05 法律事件`）。觸及類句子（觸及、跳空、收盤時、補判）一律在結尾附 `·持有{仍獲利 +x%｜損益 −x%}（未含費稅）`，正數寫「仍獲利」，讓獲利中觸發可辨識（第 3 項落實）。損益＝(判定當下的價 − 還原成本) ÷ 還原成本；判定當下的價：盤中觸及用現價、跳空用開盤價、收盤時用收盤價、補判用今日官方收盤（範例的收盤為 52.40）。
- 保本線只用一種寫法：一般列 `停損 X（保本線·持有期最高收盤曾達 +y%·未含費稅；淨額約 −0.38%）`；觸及類的來源標籤就寫 `保本線`。不寫「不會虧」。
- 新聞影響權重若出現在停損相關畫面（例如事件收緊的抽屜），一律寫「影響權重 0.18（研究期·只顯示，未用於停損與警示）」。
- 類別權重若出現在畫面，一律寫「類別權重 0.90（新聞技能 §4.1 先驗·未回測）」（`CLASS_WEIGHT_NOTE`），而且和影響權重分開寫，不得並成一個數字。
- 配色：紅漲綠跌；停損與虧損用綠色系；一級觸停損標籤與二級逼近用琥珀 `#f59e0b`；危險用紫 `#c026d3`。
- 每個停損區塊的頁尾都要有「非投資建議」。

---

## 10. 對 LLM 的提示詞約束與輸出格式（摘要；全文見 `references/llm-contract.md`）

### 10.1 提示詞要給什麼（S5 起；S3 影子期**不改提示詞**）

| 情境 | 給什麼 | 不給什麼 |
|---|---|---|
| 持股分析（`buildPrompt`，HEAD `:726-756`；停損字樣 `:734`，輸出格式 `:746`） | `停損（系統規範 stop-v1.1·{來源標籤}·只升不降）：{stop}`；做過事件收緊時加一行「（因 {MM/DD} {類別名} 暫時收緊，至 {MM/DD}）」（`stopPromptLines`） | 不給「停損 {st.stopLoss}」；**不另外給 ATR 帶的當日值**（它可能低於生效停損，LLM 會拿去當停損）；不給含處置扣分的 score；不給新聞影響權重 `w`，也不給類別權重 |
| 個股波段分析（`swingForCode`，`:959`、`:966`） | `若以標準買點 B 進場，系統停損＝Y（成本 −8% 與 ATR 帶取高）` | 不再要求 LLM「給出停損」，只能引用 Y |
| 問AI（`buildQAContext`，`:4293`） | 提問者持有該檔時，給他的生效停損與來源；沒有持有時同個股波段分析。**R5（使用者 2026-10-06「ok 如建議」已裁定）**：這一列在正式切換（S5）時才做，影子期 `buildQAContext` 一行不改 | 不給其他使用者的資料 |
| AI 提議 | **第二階段**（§3.5） | — |

固定規則句（每個會提到停損的提示詞都要附）：

> 停損數字只能原樣引用上面的「停損」，不得自訂、調寬或調緊；不得把買點、ATR 帶當日值或目標價稱為停損；處置／注意是交易限制，不是走勢強弱，不得作為停損理由。

### 10.2 輸出格式與解析順序

- 持股分析：`ACTION`／`TRIGGER`／`分析` 之外，新增一行 `STOP_REF: <照抄停損數字>`。
- 個股波段分析、問AI：結尾加一行 `STOP_REF: <Y 或生效停損>`。
- **三種來源都一樣**：先 `parseStopRef`、再 `stripStopRef`，之後才跑 `parseRationale`／`parseSwing` 或存檔。

### 10.3 驗證（`validateLlmStopText`；同 v1，T5 改為 ATR 帶）

1. `STOP_REF` 必須等於停損（差距不到半檔），不符記 `stopLlmViolation`。
2. `extractStopPrices` 從停損語境擷取價格，排除規則同 v1，另加子句口徑（2026-10-07：目標價、評分不再被當成停損價；`llm-contract.md` §2 第 2a 項）。跟停損差超過 1 檔：記 `textMismatch`；`enforce` 時才把數字換成停損並在欄位末尾另起一行加註。
3. T5 由「結構參考價當停損」改為 `bandAsStop`：停損語境的數字等於 ATR 帶當日值（±1 檔）但不等於生效停損。
4. **上線三段**：S3 量測（提示詞不變）→ S5 換提示詞仍量測 → `enforce`（≥200 句擷取、抽 ≥100 句人工標注、誤判率 95% 上界 ≤3%、再經使用者核可）。基線：stockAI 58 檔中 53% 不符（量化 §3.12）。

### 10.4 事件型風險

- 新聞的規則類重大利空**會暫時收緊停損數字**（第 14 項裁定；第二輪 A4 依類別權重分級）：規則在 §10A。這取代 v1「新聞不改停損數字」的寫法。
- 新聞影響權重 `w` 不參與（§10B）；LLM 也不得以新聞為由自行調整停損數字，它只能引用收緊後的生效停損。
- 規則類利空的方向一律由程式規則決定（新聞技能 §1.5、§1.7）：AI 只認定事實（主體是不是本檔、事件是不是屬實），程式記下類別（`ruleClass`、`ruleFacts` 等規則欄位）。**只有法律事件（C16a）**由程式把 `newsVerdict` 的 label 覆寫為利空，沿用既有的 `ruleOverride:'legal-event'` 與「【規則】」前綴；其他類別**不改** label／信心／理由（使用者 2026-10-06 R1），停損收緊與戰情以規則欄位辨識（`ruleClassOf` 不看 label）。`ruleReasonPrefix` 的「【規則·{類別名}】」只留給顯示，戰情的 `isRuleLegal` 不會把它們誤認成法律。
- **C16a 只認新聞視窗內的新進展**（使用者 2026-10-07 N1(b)，§13.4）：AI 逐字引用的法律事實句要能在內文找到、AI 說是新進展、事件日期落在本次新聞視窗內，才記 `ruleFacts.C16a='yes'` 並覆寫利空；舊案（日期在視窗外、只在背景句出現）記 `'old'`＝「涉訟中」事實標籤，**不改 label、不推播、不收緊停損**。工安事故後的檢察官相驗、勞檢、事故調查、業務過失偵查記 `'acc'`、歸 C17（N2）。同一檔同類別在有效期內重複觸發記 `ruleCont`（延續）：方向照規則，但不當新事件、不重複推播、`ruleBearEvents` 不再收；延續只從「被當成新事件」的那次判別起算（§10A.2-12）；有效期內事件日期較晚的新進展（例：先搜索、兩天後羈押）算新事件，停損收緊重新起算（使用者 2026-10-07 N4，§10A.4、§13.5）。舊案判定連引用句所在子句一起看（§10A.2-8）。

## 10A. 裁定落實：第 14 項「重大利空收緊停損」＋第二輪 A4「做skills判定與加權重」

> **先驗·未回測。** 類別權重、收緊距離、期限、冷卻都沒有回測依據；距離沿用站上既有常數，類別權重沿用新聞技能 §4.1 的 baseWeight。用影子紀錄（命中與漏網兩份）累積證據，校正前不得自動調參。
> **使用者原話**：第一輪「14要」（不得用權重；規則類別、AI 讀內文、當日非承接）；第二輪「a4 做skills判定與加權重」＝依 `tw-news-impact-analyst`，把所有方向標「−（規則）」的利空事件類別做成**程式規則判定**（AI 只認定事實——主體是否本檔、事件是否屬實——方向與類別由程式規則決定），修正 AI 自己判利空時不加規則標記的漏網；每個類別給一個**類別權重**（先驗，引用新聞技能 §4 的類別先驗值），停損收緊依類別權重決定是否收緊與收緊幅度。
> ⚠ **類別權重是規則先驗，不是 AI 新聞識讀的結果權重 `w`**。`w` 維持研究期只顯示、不實際使用（§10B）；兩者在程式裡是不同欄位，任何輸出都不隨 `w` 改變（不變式 I8，測試 N2）。

### 10A.1 觸發條件（`ruleBearEvents`；全部成立）

| | 條件 | 依據 |
|---|---|---|
| A | 代號在這位使用者的持股中，而且 `firstDate < 收緊生效交易日`（**嚴格小於**）。生效交易日當天才建立的部位一律不套用：盤前（08:46）生效的事件，當天的買進必然在生效之後；盤中生效的事件，持股紀錄沒有可靠的建立時刻，無法分辨買進在判別之前或之後，一律不套用（記 `boughtSameDay`）。部位已有更早的批次時，以代號為單位照套 | 收緊是針對事件發生時已持有的部位；用日期比較才可重現 |
| B | 判別屬於今日適用交易日（`newsVerdict/latest.targetDate ＝ 今日適用交易日`），沒有 `carriedFrom`，`at ≥ 上一交易日 13:30` | 當日、非承接（第 14 項裁定） |
| C | 規則類利空（`ruleClassOf`，**不看 label**——非法律類別 daemon 不覆寫 label，使用者 2026-10-06 R1）且 **AI 讀過內文**（同戰情 `isAiRead`：`basis==='content'`、不是 D 拒答、不是「AI 判別未回應」）；E 引用強制未過時，規則類別比照法律規則放行（AI 只認定事實、方向由規則定） | 使用者規則：新聞調分須經 AI 讀內文 |
| D | `challenged === true`（四角色挑戰只在非舊聞時才跑，當作「非 14 日舊聞回退」的代理） | news-weight §3.6 |
| E | 判別帶有**程式規則判定**留下的類別（`ruleClassOf`：`ruleClass` 而且該類事實題答「是」〔`ruleFacts[ruleClass]==='yes'`〕；舊資料 C16a 認 `ruleOverride:'legal-event'` 或「【規則】」前綴〔當時一定同時覆寫 label，所以這條仍要 label 利空〕），而且該類別的收緊級別不是 none（§10A.3）。**不看 `w`、強度、信心**；AI 自己的 `eventType`（'法律'、'處分'…）不算類別。**C16a 只收新聞視窗內的新進展**（`ruleFacts.C16a='yes'`；舊案 `'old'`＝涉訟中、工安事故調查 `'acc'` 都沒有 `ruleClass＝C16a`，不收；2026-10-07 前的舊資料沒有新進展欄位，照舊認、不改歷史） | 第 14 項限制＋研究期裁定＋第二輪 A4＋R1＋2026-10-07 N1(b)／N2 |
| F | **不是延續**（`ruleCont`：同一檔同類別在有效期 `RULE_CONT_TRADING_DAYS`＝5 個交易日〔＝`eventHoldDays`〕內重複觸發）。延續只從「被當成新事件」的那次判別起算（`ruleTrailEligible`：主類別、`challenged===true`、非承接、`basis==='content'`、label 利空——與 B–D 同口徑），所以首次判定那天這裡已收過；首次沒收成事件的（四角色挑戰失敗、只是 `ruleHits` 裡的次要類別、label 不是利空）不起算，隔日照新事件收（2026-10-07 審查修正）。之後的同一事件由 §10A.4 的事件身分處理。同一適用日的重判（晨間判到、盤中再判）不是延續，照收。**有效期內事件日期晚於延續軌跡事件日期的新進展不是延續**（N4：`withRuleTrail` 不標 `ruleCont`、軌跡換新），這裡照收、事件帶新的 `eventDate`，由 §10A.4 重新起算；日期相同、更早或讀不到仍是延續 | 2026-10-07「不當新事件、不重複推播」；N4「依建議進行」 |

- B–D 沿用戰情同一套（`scripts/lib/warroom-news.mjs` 的 `newsBoardFromDoc`、`newsCtxOf`、`isCurrentEntry`、`isAiRead`），不另寫第二份；C16a 的結果與戰情 `majorBearOf(...).basis==='rule-legal'` 逐檔一致（測試 N3）。
- `ruleBearEvents` 每檔最多回一件，帶 `cls`、`key=${code}:${cls}`、`eventDate`（事件日期：延續軌跡 `ruleTrail[cls].eventDate` 優先、再看稽核軌跡；非 C16a 與 10/07 前的舊資料為 null；N4 重新起算用）、`tier`、`weight`（類別權重）、`research`（`w`、強度、信心、`eventType`，只記錄）。

### 10A.2 規則類別、類別權重與程式判定方式（新聞技能 §4.1）

類別表的唯一來源是 `scripts/lib/news-rule-classes.mjs`（`RULE_BEAR_CLASSES`）；測試逐列讀新聞技能 §4.1，類別權重與方向欄不符就紅。

| 代號 | 類別（`ruleOverride` key） | 範圍（新聞技能 §4.1） | 方向 | **類別權重**（先驗·未回測） | 收緊級別 |
|---|---|---|---|---|---|
| **C16a** | 法律事件（`legal-event`） | 檢調搜索、搜查、約談、起訴、羈押、背信、掏空、主管機關調查（對象是本公司、子公司或負責人）；**只算新聞視窗內的新進展**（舊案＝涉訟中標籤；工安事故後的相驗、勞檢、事故調查、業務過失偵查歸 C17——2026-10-07） | −（規則強制，§1.5） | **0.90** | **強** |
| **C22** | 財務危機（`financial-distress`） | 退票、重整、非無保留意見、延遲申報、背書或資金貸與異常 | −（規則，§1.7） | **0.85** | **強** |
| **C13b** | 公開收購破局（`tender-failed`） | 本檔是被收購方，公開收購或併購交易破局、終止、撤回 | 破局轉 −（規則） | **0.80** | **強** |
| **C17** | 工安停工（`accident`） | 本公司工安、火災、停工、天災 | −（規則） | **0.70** | **強** |
| **C16b** | 裁罰訴訟（`penalty-lawsuit`） | 主管機關裁罰、重大訴訟（本公司為被告） | −（規則） | **0.35** | **溫和** |
| **C15a** | 內部人轉讓（`insider-transfer`） | 董監或大股東申報轉讓；贈與或信託轉讓 0.05（子類別 `giftOrTrust`） | −（規則） | **0.30**（贈與信託 0.05） | **溫和**（贈與信託不收緊） |
| C11a | 減資彌補虧損（`capital-reduction-loss`） | 減資：彌補虧損 | 0～−（規則） | 0.25 | 不收緊（只記影子） |
| C15c | 設質增加（`pledge-up`） | 董監或大股東設質比上升（月頻慢變數） | −（規則） | 0.20 | 不收緊（只記影子） |
| C20b | 信評調降（`credit-downgrade`） | 信評機構調降評等或展望 | −（規則） | 0.15 | 不收緊（只記影子） |
| C23 | 交易限制（`trading-restriction`） | 變更交易方法、全額交割、停止買賣、下市 | −（規則） | 0.90 | **不收緊**：新聞技能明定「屬可買性問題：排除或加警示，不當成訊號」；與已裁定的「處置／注意不調整停損」同類；停止買賣期間停損也無法執行。只記影子 |

- **不採用**：AI 的 `eventType='法律'` 或 `'處分'`（範圍很廣：和解金、聯貸、認證、許可證；09-21 起 30 筆非利空，news-weight §1.3、§5-3）；`w ≥ 0.6` 之類的影響權重門檻（研究期只顯示，§10B）。

**程式判定方式（新聞管線；第二輪 A4 已核可，實作計畫 §2.10）**——AI 只認定事實，方向與類別由程式決定：

1. **觸發**（只觸發提問、不動方向；新聞技能 §1.2）：與本檔同時出現、而且判別實際讀到的報導內文（`judgeOneStock` 的 `_picked`，標題＋內文前 1,200 字＝主判別看得到的範圍；`ruleTriggerScan`）命中某類別的觸發字（`ruleClassesHit`）。觸發字避開常見的非事件語意（2026-10-05 審查）：C16a 不用裸「調查」（市調、研調）、改認檢調／調查局／地檢署／檢察官／偵辦與「主管機關…調查」；C22 的「重整」只認法院公司重整、「保留意見」排除「無保留意見」；C17 的停工／停產／停機要帶事故語境、「爆炸」要帶廠區或事故語境（「爆炸性成長」、歲修、產品停產不算）；C20b 只認信用評等機構，券商或外資的投資評等、目標價（C20a，方向 0）以 veto 排除。每類的事實題也寫明不算的情形。
2. **提問**：主判別（含引用強制、中性歸零）定案之後，每個命中的類別**另問一次** `ruleFactQuestion(類別, 個股, 該類別命中的報導〔最多 3 篇、內文前 1,200 字〕)`：只回「是／否」再一句說明主體與事件是否已發生（C15a 另答是否贈與或信託）；讀不出來回「不確定」。本機模型、priority 1（同舊 C16a 聚焦提問）、溫度沿用 `NEWS_TEMP`。**主判別提示詞逐字不變**（事實題不嵌進主判別，避免主判別的 label 漂移；2026-10-05 審查）。
3. **判定**（`parseRuleFactAnswer`、`applyRuleFacts`）：開頭「是」（後接標點、空白或結尾；「是否…」「是不是…」不算）⇒ 寫規則欄位 `ruleClass`（類別代號）、`ruleOverride`（類別 key）、`ruleSub`（子類別）、`ruleHits`、`aiOriginal`（AI 原判 label＋理由前 24 字）、`ruleFacts`（每類 yes／no／none）。**只有 `ruleClass＝C16a`**（法律；類別權重 0.90 是表內最高，C16a 答「是」必為主類別）時，程式把 `label` 覆寫為利空（`bullish:false`、信心「低」升「中」、理由「【規則】涉檢調搜索，法律判定前視為利空（AI 原判…）」，與 2026-08-29 版逐字相同；`LABEL_OVERRIDE_CLASS`）。**其他類別**（C23、C22、C13b、C17、C16b、C15a、C11a、C15c、C20b）label／bullish／信心／理由一律維持 AI 原判（**使用者 2026-10-06 R1「ok 如建議」**：label 會連動推薦排序、個股評分、做空候選、squeeze-train）；停損收緊（`ruleBearEvents`）與戰情 v2（燈、Z2、B2、A2；`verdictState`）以 `ruleClassOf` 讀規則欄位辨識為規則類利空。「否」、空白、逾時 ⇒ 維持 AI 原判，**不猜**。
4. **AI 原判已是利空也要問**：修正 `ai-daemon.mjs:6415` `if (verdict && negHits.length && verdict.label !== '利空')` 的漏網——現在 AI 自己判對利空的檢調搜索永遠沒有規則標記。原判已是利空時理由文字不改，只補欄位。
5. **多類命中**：逐類提問；回答「是」的類別中取類別權重最高者寫 `ruleClass`（同權重依表內順序），其他寫 `ruleHits`（只記錄）。
6. **三個 `newsVerdict` 寫入端都要存** `ruleClass`、`ruleOverride`、`ruleSub`、`aiOriginal`、`ruleHits`、`ruleFacts`（夜補、盤中、盤後／晨間；`ruleFieldsOf` 共用一支，已實作）。非法律類別的辨識只靠這些欄位（label 不變），所以缺 `ruleFacts` 的 `ruleClass` 不算。
7. **成本與不變式**：只在觸發字命中時多問（每個命中類別一次本機呼叫，主判別之外）；Ollama 呼叫增加量在影子期量測（daemon log「規則事實」逐檔記；關鍵字代理估計每交易日約 1～2 次，`evidence.md` §11，觸發字收窄前的估計，未實測）；上游請求 0、MIS 0（唯一不變式成立）。
8. **C16a 新進展判定（使用者 2026-10-07 N1(b)；`news-rule-evidence.mjs` `resolveRuleFact`）**：C16a 的事實題**併在同一題**（不另開呼叫）多問三件事——是不是本次新聞視窗（`judgeOneStock` 的視窗，`from`～今天）內新發生或有新進展、日期（報導寫「今日」「昨日」以發布日推算；每篇附發布日）、**逐字引用**那句法律事實。程式判定：引用要能在給 AI 看的報導裡逐字找到（沿用 E 引用強制的正規化與子字串比對，正規化後 ≥6 字），比不上 ⇒ `'none'`（不算，連涉訟中也不給）；引用句有工安語境明確的字樣（`ACCIDENT_LINK_RE`：相驗、勞檢、工安、職災、火災、氣爆、爆炸事故、意外事故、業務過失、過失致死…；單獨的「事故」「爆炸」「死傷」不在這裡，見第 9 步） ⇒ `'acc'`；AI 說是新進展、日期落在視窗內、引用句自己**以及它在原文所在的子句**（`quoteClauseOf`：往前到上一個子句界、最多 30 字，往後到下一個子句界、最多 20 字）都沒寫視窗外的絕對日期（例「8 月」，有「今日、昨日」這類相對時間字樣時不看）、子句也沒有背景字樣（先前、此前、早前、日前曾、曾遭／曾被…，有相對日子字樣時不看） ⇒ `'yes'`（覆寫利空）；其他（日期在視窗外、讀不出日期、AI 說不是新進展、子句寫視窗外日期或背景字樣） ⇒ `'old'`＝「涉訟中」事實標籤（`LEGAL_ONGOING_TAG`），label、推播、停損都不動。子句只看到逗號為止：「繼 8 月遭搜索後，調查局今再度約談」的新進展不會被同一句前半的舊日期否決。
9. **N2 同一起事故**（`reconcileAccident`）：C16a 答「是」或舊案、C16a 的引用句出現在 C17 觸發的報導裡，再加上 C17 答「是」（`why 'accidentC17'`），或 C17 沒答「否」而引用句帶較寬的事故字樣（`ACCIDENT_CONTEXT_RE`：事故、爆炸、罹難、死傷、傷亡…；`why 'accident'`） ⇒ C16a 改 `'acc'`，主類別由 C17 擔任（C17 只記欄位、不改 label，R1）。沒有 C17 語境的法律事件（例：搜索金控、偵辦隱匿理專挪用事故）照一般 C16a 判——2026-10-07 審查修正，舊版單獨的「事故」字樣就記 `'acc'`，會讓這類搜索兩邊都不算、違反 2026-08-29「被搜索就是利空」。C16a 的事實題寫明這些不算。
10. **稽核軌跡 `ruleEvidence`**（每個問過的類別一份；寫入端經 `ruleFieldsOf` 共用）：`key`（同組報導鍵）、`day`（問的日子）、`trig`／`ctx`（觸發字與命中處前後各 30 字）、`title`／`src`／`pub`（第一篇的標題、來源、發布日）、`ans`（AI 回答前 60 字）；C16a 另記 `quote`、`quoteOk`、`newDev`、`dateText`、`eventDate`、`isNew`、`why`（`notNew`／`dateOut`／`dateUnknown`／`quoteDateOut`／`clauseDateOut`／`background`／`quote`／`accident`／`accidentC17`），子句否決時另記 `qctx`（引用句所在子句，80 字內；瘦身時與其他文字欄一起去掉）。答「否」的軌跡也留著（10/07 前會被之後的重判覆蓋、無從稽核）。`newsVerdict` 日文件的 `verdictJson`＋`seenJson` 逼近 1MB（`RULE_DOC_SOFT_MAX`＝900,000 位元組）時先去文字欄、仍超過就整段拿掉（`fitVerdictJson`；判別本身不動），三個寫入端共用 `newsVerdictJsonFit`。
11. **當日沿用（不重問）**：同一檔同類別同一組報導（標題＋給 AI 看的內文）、同一天、同一新聞視窗 ⇒ 沿用已問過的答案（daemon 記憶體快取，重啟後改看前一筆判別的 `ruleEvidence.key`）；呼叫失敗不快取。Ollama 呼叫只會比 10/07 前少，上限不變。
12. **延續 `ruleTrail`／`ruleCont`**：主類別在「被當成新事件」的那次判別記適用日 `since`（`ruleTrailEligible`：主類別、挑戰過、非承接、讀過內文、label 利空；`ruleHits` 裡的次要類別與沒收成事件的判別不起算——2026-10-07 審查修正，舊版每個答「是」的類別都起算，首日挑戰失敗或被 C23 蓋過的 C17 隔日會被標延續、從頭到尾沒收緊也沒發 Z2 一級；取捨：首日沒挑戰過卻已在完成訊號列過利空的，隔日會再列一次）；有效期內的舊軌跡照帶，這次沒觸發也保留；主類別的 `since` 早於這次的適用日 ⇒ `ruleCont＝since`。延續的 C16a 仍覆寫利空（規則方向不變），但 daemon 推播（`pushVerdictDone` 的利空清單、盤中「突發利空」）不列、`ruleBearEvents` 不收（§10A.1-F）、戰情 Z2 降二級「延續」。**N4（使用者 2026-10-07「依建議進行」）**：主類別已有軌跡、這筆的事件日期晚於軌跡的 `eventDate`（`eventDateLater`：整段晚於；相同、更早、區間重疊、任一邊讀不到都不算）⇒ 新事件、不標延續；這筆也被當成新事件時軌跡換成 `{ since: 適用日, eventDate: 新日期, renewOf: 舊日期 }`（有效期從新的 since 重算；`renewOf` 只留在換新的那一筆），沒被當成新事件的（挑戰失敗）軌跡不動、下一筆照新事件判。軌跡沒有 `eventDate`（相容）⇒ 延續並補上這筆的日期。daemon log「新進展（事件日 … 晚於軌跡 …）：當新事件、重新起算」。
13. **計數**：題數與答案分布依資料日（非交易日記最後交易日）累計進 `stopSpecAudit/{資料日}.newsRule`（`asked`、`reused`、`fail`、`ans.{類別}.{yes|no|none|old|acc}`、`quoteFail`、`cont`、`renew`（N4 換新）；只放計數，不放代號與句子）。
- **連動影響**（要知道，不屬本規範檔）：只有 C16a 的 label 被覆寫為利空，讀 `newsVerdict.label` 的地方（新聞判別顯示、AI 推薦 `src/app/api/twse/ai-recommend/route.ts:70` 的新聞方向加減、個股評分、做空候選、`squeeze-train.mjs:185` 的 `newsLabel`）只會因法律事件看到利空——C16a 自 2026-08-29 起即如此；**其他類別不影響這些地方**（使用者 2026-10-06 R1，取代 A4 原本「擴到全部類別」的做法）。盤後報告的 `rankMediaVerdicts` 同樣讀 AI 原判 label。戰情 `isRuleLegal` 認 `ruleOverride==='legal-event'`，補欄位後「AI 原判利空的法律事件」在戰情 Z2 會由二級（可能為法律事件）變成一級新聞警示——這是修正漏網的必然結果。戰情 v2 對其他規則類別：`verdictState` 不看 label、一律判利空（燈、Z2 依類別權重分級〔R2 已裁定維持〕、B2、A2 第 0 類），AI 原判顯示為「AI 原判…」（`ra`），而且不套 §1.4／§1.6 的價格描述、關注度改判。

### 10A.3 收到哪裡（`eventTierOf`、`eventLineOf`）

```
refClose  = 判別適用交易日之前最後一個已定版官方收盤（價格口徑日 refYmd；之後若有除權息，生效線 ceilTick(×f)）
tier      = 類別權重 ≥ 0.7         ⇒ strong：k = 1, p = 3
            0.3 ≤ 類別權重 < 0.7   ⇒ mild：  k = 2, p = 5
            類別權重 < 0.3 或不當訊號（C23）⇒ none：不收緊，只記影子
eventLine = floorTick( refClose − max(k × ATR14, p% × refClose) )
```

- **權重越高收緊越多**：強級的線離前收 max(1×ATR14, 3%)，溫和級 max(2×ATR14, 5%)（更遠、較少生效），權重 <0.3 不收緊。規則固定、可重現：同一組（類別、子類別、前收、ATR14）永遠算出同一條線。
- 距離沿用既有常數，不新造門檻：1×ATR＝逼近界線（`NEAR_ATR`）、3%＝ATR 帶夾值上界，所以強級收緊線**不會比 ATR 帶允許的最緊位置更緊**；2×ATR、5%＝v1 AI 結構候選的距離下限。
- 向下取檔，讓距離至少保持上式。ATR14 缺時只用百分比。`refClose` 缺時不收緊，記 `noRef`。
- **只收緊、不放寬**：`stop = max(baseStop, 各層 eventLine)`。`eventLine ≤ baseStop` 時不改停損，記 `noBite`（也記入事件身分，不會之後再試）。
- 合成母體診斷（無條件，不是新聞日；`evidence.md` §11）：強級（1×ATR／3%）在 33.6% 的持有日會高於 v1.1 基礎停損、5 日內觸及 36.2%；溫和級（2×ATR／5%）只在 14.6% 的持有日有效、5 日內觸及 12.5%。

### 10A.4 何時生效、何時解除（`stepEventOverlay`）

| 判別趟次 | 生效時點 | `setToday` | 判定價 |
|---|---|---|---|
| 盤後（evening）、夜補（night）、晨間（morning），`targetDate＝今日` | 今日 08:46 的停損簿刷新（開盤前；`planBookRefresh(when:'premarket')`） | 否 | 今日 `low`；開盤就低於收緊線記 `gap` |
| 盤中（intraday） | 判別寫入後的下一輪 alertLoop（`planUserStopTick` 的 `intradayEvents`） | 是 | `liveAt > startedAt` 的真成交價（§4.1）；處置股當日不判定 |

- **每個 (代號, 類別) 一層**：同一檔可以同時有不同類別的層，生效停損取最高的那條線，來源標籤寫那一層的類別（`事件收緊·10/05 工安停工`）。
- **盤中生效前檢查**（同 v1 B3 的道理：停損高於現價就是出場訊號，不是停損）：今日真成交價（沒有就用最後交易日官方收盤）≤ 收緊線 ⇒ **今天不生效**，記 `deferred`，寫二級 `stopInfo`「事件收緊未生效：成交價 X 已低於收緊線 Y，改於今日收盤後依官方收盤重算」。資料到齊班車用今日官方收盤當 `refClose` 重算（`stepEventOverlay(when:'close')`），**次一交易日**起生效，期限從那天起算。
- **期限**：`EVENT_HOLD_DAYS = 5` 個交易日，生效日算第 1 天（休市日不算）。第 6 個交易日開盤前（08:46 刷新）移除該層，生效停損回到基礎停損（版本原因 `eventExpire`，自檢例外），寫二級「事件收緊期滿：停損回到 X（{來源}）」。**到期只在 08:46 處理**；16:45 班車照舊納入當天仍在期限內的層。選 5 天的理由：突發類事件的媒體半衰期 0.5～1 個交易日（新聞技能 §5.4），5 天遠長於半衰期。
- **事件身分（確定性，不用 LLM 文字）**：鍵是 `(代號, 類別, 首次生效交易日)`。不用關鍵句或引文雜湊：盤後趟每晚重判整個宇宙（`ai-daemon.mjs:7227` 一帶的註解）、溫度 0.15 下同一批新聞每次挑出的引文與理由可能不同（`:6535` `NEWS_TEMP`）。
- **期限內不延長、不重疊**（例外：N4 期限內事件日期較晚的新進展，見下）：同代號同類別的層存在時，之後的合格判別一律不改收緊線、不延長期限，只記 `sameEvent`。
- **到期後的再武裝**：同代號同類別要再隔 `EVENT_REARM_DAYS = 5` 個交易日，新的合格判別才算新事件（記憶 `eventSeen` 保留到到期後 5 個交易日）；冷卻期內記 `sameEvent`。所以同一件持續的新聞，同一類別最多每 10 個交易日收緊一次、每次最多 5 個交易日（先驗·未回測，S10 校正）。
- **期限內的新進展（N4，使用者 2026-10-07「依建議進行」；`stepEventOverlay` 的 `eventIdentity`／`renewLine`／`settleRenewal`）**：同代號同類別的舊事件還在期限內（層還在，或事件身分記憶的最後有效日未過），而 `ruleBearEvents` 帶來的 `eventDate` 晚於已記的事件日期（層的 `eventDate`，沒有層時看身分記憶第 4 格）⇒ **新事件、重新起算**：同類別的舊層換成新的一層，生效日＝今日、期限從今日重算（5 個交易日）、`eventDate` 記新日期、`renewOf` 記舊日期，紀錄帶 `renew:true`、二級 `stopInfo` 以新生效日換新 id。收緊線依新事件的前收重算，但**舊層仍生效時取新舊較高者**（價格已跌時沿用舊線與它的口徑，不提前放寬、也不會觸發自檢 `loosen`）。**盤中成交價已不高於新算出的收緊線（B3）⇒ 比照首次事件延後**（2026-10-07 審查修正；舊版沿用舊線、只延長期限，從不以收盤價重算，收緊比首次事件少）：舊層照常生效（線與期限都不動），換新記在舊層的 `renewPending`（事件日期、被取代的日期、當時成交價與新線），記 `deferred`（`renew:true`）、寫二級「事件收緊未生效」；16:45 收盤班車（`settleRenewal`）以今日官方收盤重算，舊層在次一交易日仍有效時取新舊較高者，**次一交易日**生效、期限從那天起算（`source:'deferred'`）；沒有收盤價 ⇒ `noRef`、舊層照舊；收緊線 ≤ 基礎停損 ⇒ `noBite`、舊層照舊到期（身分記憶換成新事件）；收盤班車沒跑到而舊層先到期 ⇒ 轉成一般延後層，下一次收盤班車照首次事件處理。已記的事件日期取延後標記、層、身分記憶三者最晚的（收盤沒算成時層與身分記憶可能不同步）。沒有生效中的舊層（只有身分記憶，例如首件 `noBite`；或舊層是延後層）⇒ 照一般新事件判（條件 A、`noBite`、盤中延後都照舊）。到期後的冷卻期（`EVENT_REARM_DAYS`）**不變**：日期再晚也記 `sameEvent`（D22）。事件日期相同、更早、讀不到 ⇒ `sameEvent`；舊層或身分記憶沒有事件日期（N4 前建立）⇒ `sameEvent` 並補上這件的日期，之後更晚的才換新。抬高停損時版本原因記 `lineRaise`（同類別鍵不變；`lineRaise` 與 `eventTighten` 都在事件延續表內，不影響觸及事件）。事件身分記憶改為 `[key, 生效日, 最後有效日, 事件日期?]`（Firestore 編碼 `{k,e,x,d}`；舊的三格照認）。
- **生效日當天或之後才建立的部位**：不套用（條件 A），記 `boughtSameDay`／`boughtAfter`，也記入事件身分；沒有買進日記 `noFirstDate`。
- **不提前撤銷**：同一適用日稍後的判別改判、或規則標記消失，v1.1 不撤銷收緊（保守：不因後續改判提前放寬），只在影子紀錄記 `revisedAfter`。
- **部位出清**：該檔所有層隨部位刪除。

### 10A.5 與其他線的優先序

- 事件收緊是**疊加層**，不進基礎停損的棘輪：`stop = max(baseStop, 各層 eventLine)`；到期後回到當時的基礎停損（期間基礎停損仍照常每日抬高）。
- 優先序：使用者自訂（第二階段）＞系統線取高（成本線、ATR 帶、保本、追蹤）＞與事件收緊再取高。綁定來源標 `event`，`sourceDate`＝那一層的生效日。
- 大盤危險、處置、注意都**不**觸發收緊。

### 10A.6 邊界情況

| 情況 | 處理 |
|---|---|
| 收緊時觸及事件已在進行（價格已在基礎停損下） | 照收緊、事件延續（`eventTighten` 在延續表內），不重發停損一級；新聞的 Z2 一級另由新聞類別發 |
| 收緊後被觸及 | 新事件（若沒有進行中的事件），一級文字的來源標籤是 `事件收緊·MM/DD {類別名}`（`stopSourceLabel`，§9） |
| 到期時價格介於基礎停損與收緊線之間、事件進行中 | 事件延續，依「官方收盤 > 新停損×1.02」自然結束；不重發一級 |
| 生效日剛好是除權息日且係數未知 | 當日暫停判定（§7）；收緊線在係數確定後 ×f |
| 期限內遇除權息 | 收緊線 `ceilTick(×f)`（依 `refYmd` 之後的係數，每次重算），期限不變 |
| 處置股 | 收緊照常（新聞規則，不是處置）；盤中生效那天依 §4.1 不以成交價判定 |
| 期限內攤平、加碼、部分賣出、成本更正 | 疊加層照舊（不依賴成本） |
| ETF、非 4 碼代號 | 不在新聞判別範圍（news-weight §3.2），不會觸發 |
| 非交易日的盤後趟（週末判的、適用下週一） | 週一 08:46 生效 |
| daemon 重啟 | 疊加層與 `eventSeen` 存在 `stopBooks`；判別從 Firestore `newsVerdict/latest` 讀，不靠記憶體 |
| 同一判別多類命中 | 只取類別權重最高的一類（§10A.2-5）；同一檔不同天出現不同類別 ⇒ 各自一層 |
| 報導主體是別的事，只在背景句帶到本公司過去的搜索（3037 欣興 10/05–10/07 型） | C16a 記 `'old'`（涉訟中）：不改 label、不推播、不收緊（§10A.2-8）；AI 把舊案日期誤報成視窗內、而引用句自己寫視窗外日期 ⇒ 仍是 `'old'` |
| 同上，AI 從背景句挑一段沒有日期的子字串（「遭檢調搜索，公司強調營運正常」）、說是新進展、日期填發布日 | 仍是 `'old'`：引用句所在子句寫「今年8月」⇒ `clauseDateOut`；子句有「先前」「曾遭」等背景字樣而沒有今日／昨日 ⇒ `background`（`qctx` 記子句） |
| 法律新進展的引用句帶「事故」（例：搜索金控、偵辦隱匿理專挪用事故） | 沒有 C17 語境 ⇒ 照一般 C16a（`'yes'` 改判利空、收緊）；只有引用句出現在 C17 觸發的報導裡、C17 沒答否時才記 `'acc'` |
| 首日判到規則類利空但沒收成事件（四角色挑戰失敗、只是次要類別、label 不是利空），隔日同一事件挑戰過 | 首日不起算延續，隔日照新事件收（`ruleBearEvents` 收、Z2 照等級發）；首日已收成事件的，隔日才是延續 |
| 工安事故後的檢察官相驗、勞檢（2367 燿華型） | C16a 記 `'acc'`，C17 為主類別（強級收緊照 C17；label 維持 AI 原判，R1） |
| 同一事件隔日再被報導、C16a 再答新進展（事件日期相同或更早、或讀不到） | 延續（`ruleCont`）：`ruleBearEvents` 不收、不重複推播、Z2 二級；有效期 5 個交易日（自被當成新事件那次的適用日起算）過了才算新事件 |
| 有效期內出現事件日期較晚的新進展（先搜索、兩天後羈押或起訴；N4） | 新事件：C16a 照常改判利空、完成訊號與盤中突發照列、`ruleBearEvents` 收（帶新 `eventDate`）、Z2 依類別權重發級；停損同類別的層換新、期限重算，線取新舊較高者；盤中成交價已不高於新線 ⇒ 舊層照常生效、延到收盤重算、次一交易日生效（§10A.4）；戰情同一適用日先以延續發過二級的也照新事件再發一級；延續軌跡換成新的 since／eventDate |
| AI 把同一件事誤報成較晚的日期（例：報導寫「昨日搜索」卻填發布日） | 會被當成新事件、多推一次、停損期限重算（風險，未驗證；影子期以 `renew` 計數與 daemon log 抽查） |
| C16a 引用句在內文找不到 | `'none'`：不算（不改判、不給涉訟中），計數記 `quoteFail` |

### 10A.7 影子紀錄：命中與漏網兩份（使用者規則：回測要出命中與漏網）

**命中紀錄**（`eventShadowRows`；每個合格事件一列，含 tier none 的類別；全市場與會員持股分開）：

- **全市場（合成）**：每件符合 §10A.1 B–E（含 tier none，只記錄）的判別，不論有沒有人持有，都以「生效日前最後一根官方收盤」為前收建一個合成部位，算類別級別的收緊線並追蹤 20 個交易日。全市場每天約有 100～250 檔判別，會員持股太少（近 8 個適用日會員持股利空 0 筆），只看持股會累積不到樣本。可每日由日 K 整段重算（idempotent）。
- **會員持股**：實際發生的收緊結果（`applied`、`noBite`、`deferred`、`boughtSameDay`／`boughtAfter`、`sameEvent`、`belowWeight`、`notSignal`、`expired`），只寫進該使用者的 `stopBooks`，公共的 `stopSpecAudit` 只放計數。
- 每列欄位：日期、代號、類別、子類別、級別、類別權重、趟次與判讀時刻、`refYmd`、`refClose`、ATR14、收緊線、期限內是否觸及、觸及日（`touchYmd`）、類型（touch／gap）、觸發價、之後第 1／5／10／20 根收盤相對收緊線與 `refClose`、**影響權重 `w`、強度、信心、`eventType`（只記錄，研究期）**。
- **對照線**：同一事件另算 0.5／1／2／3×ATR 四條假設線各自的觸及與分類，供日後校正級別。
- **分類**（互斥，沿用 §11-3 的三類）：**洗出**＝觸及後 10 個交易日內有任一收盤 ≥ `refClose`；**命中**＝沒有洗出，而且第 10 個交易日收盤 ≤ 出場參考價（`touch` 用收緊線、`gap` 用開盤價）；**賣在相對低點**＝沒有洗出，但第 10 個交易日收盤 > 出場參考價。另記「期限內未觸及」（之後 20 日最大跌幅）與資料不足的 `pending`。

**漏網紀錄**（`missShadowRows`；每日，範圍＝會員持股 ∪ 當日判別宇宙）：

- 條件：官方收盤 ≤ 前收 −2×ATR14，或收在跌停；而且當日與前一交易日都**沒有**合格事件（`eventCodes`）。
- 每列寫出哪一條沒過（互斥）：`noDoc`／`docMismatch`（判別表不是該日的）／`noVerdict`／`notBear`（label 不是利空、也不是規則類利空——`ruleClassOf` 不看 label，R1）／`notRead`（閘門）／`carried`／`notChallenged`／`beforeMin`／`aiBearLegalNoRule`（AI 原判已是利空、有法律字樣但沒有規則標記——§10A.2-4 修正前的已知缺口）／`bearNotRule`（利空但不是規則類，附 `eventType`、`w`、強度、信心，只記錄）／`belowWeight`（規則類但不收緊）／`legalOngoing`（C16a 舊案·涉訟中，2026-10-07 N1(b) 起不改判；量「舊案不改判」漏掉幾件大跌）／`continuation`（規則類利空的延續，首次判定那天已是事件）。另記官方重訊（mopsNews）當日有無公告。
- 「AI 原判已是利空」這一類在新聞管線補存規則欄位（§10A.2-6）之前只能用字樣代理（`isPossibleLegalBear`），不能宣稱量得出覆蓋率；補欄位前後的事件**分開統計**。
- 目的：回答「類別權重的級別切點、AI 的 `eventType`、補上規則標記，各能多抓到幾件、會多誤抓幾件」。這些答案出來之前，`w` 仍然只顯示。

**校正閘門**：全市場合格事件累積 ≥30 件、且影子期 ≥20 個交易日後，產出命中與漏網報告，交使用者裁定是否調整 `EVENT_TIERS`（切點與距離）、`EVENT_HOLD_DAYS`、`EVENT_REARM_DAYS`、類別的 `tightenEligible`。**不自動調參。**
- **要多久**：只算法律類時，24 個適用日實測合格 4 件（約每交易日 0.17 件），湊滿 30 件約需 180 個交易日；新聞管線補齊各規則類別後，依關鍵字代理（法律 13、裁罰訴訟 12、工安停工 4、財務危機 0，可能重疊）可能增加到約每交易日 1 件，約 1.5 個月。補齊前後是**不同母體**，校正結果不跨母體套用。

### 10A.8 測試（實作計畫 §5 的 N 組；`scripts/lib/ai-stoploss-event.test.mjs`、`news-rule-classes.test.mjs`）

- 述詞：規則類＋挑戰過＋當日 ⇒ 成立（**不論 label**：非法律類別 label 是 AI 原判中性／利多也成立，R1）；承接、前一日、`at` 早於上一交易日 13:30、沒挑戰、D 閘門、AI 未回應、label 非利空且非規則類、`ruleClass` 但事實沒答「是」、`eventType='法律'` 但沒有規則標記、`w` 高但非規則類 ⇒ 不成立；E 引用未過的規則類 ⇒ 成立。
- **權重不變式**：同一組輸入只改 `w` 的成分（強度、信心、確定性、新穎、反映），所有輸出（事件、收緊線、期限、紀錄分類）完全相同。
- 與戰情 `majorBearOf(...).basis==='rule-legal'` 的金樣本一致。
- 類別權重逐列＝新聞技能 §4.1；級別：C16a、C22、C13b、C17 強，C16b、C15a 溫和，C11a、C15c、C20b、C15a 贈與信託 none，C23 notSignal。
- 收緊線：ATR 與百分比下限各一例、溫和級較寬、向下取檔、ETF 檔位、`refClose` 缺 ⇒ null。
- 結果分類：`applied`、`noBite`、`boughtSameDay`（盤前、盤中）、`boughtAfter`、`noFirstDate`、`noRef`、`sameEvent`、`belowWeight`、`notSignal`。
- 盤前生效 ⇒ 非 `setToday`；盤中生效 ⇒ `setToday`；盤中成交價 ≤ 收緊線 ⇒ `deferred`，收盤以今日收盤重算、次一交易日生效。
- 期限：第 5 個交易日仍有效、第 6 個交易日 08:46 到期（跨週末與注入的颱風假）；收盤班車不處理到期；`eventExpire` 下降不記 `loosen`、事件延續。
- 事件身分：同一事件隔日重判、引文與理由都不同 ⇒ `sameEvent`；到期後第 1～5 個交易日 ⇒ `sameEvent`；第 6 個交易日起 ⇒ 新事件。
- 期限內除權息 ⇒ 收緊線 ×f；兩個類別同時生效 ⇒ 取最高。
- 影子紀錄：命中與漏網兩份欄位齊全、三類互斥、`w` 有記錄但不影響分類；漏網原因與 `ruleBearEvents` 同口徑（事實沒答「是」的 `ruleClass` 兩邊都不算、記 `notBear`；事實答「是」而 label 維持 AI 原判中性的兩邊都算；規則類利空沒挑戰記 `notChallenged`）。
- 觸發字反例（不觸發）：市調「調查」、組織重整、重整旗鼓、無保留意見、歲修停機、產品停產、爆炸性成長、券商調降評等／目標價、S&P 500；事實回答「是否…」「不確定」⇒ 未答。
- 類別判定：只認 `ruleClass`＋該類事實「是」，以及舊資料 C16a 的 `ruleOverride`／「【規則】」前綴（須 label 利空）；其他類別的前綴不被戰情 `isRuleLegal` 誤認；觸發字只回類別、事實回答只看開頭「是／否」。
- **N1(b)／N2（2026-10-07；`news-rule-evidence.test.mjs`、`ai-stoploss-event.test.mjs` N1b、`warroom-news.test.mjs`、`news-rule-daemon-pin.test.mjs`）**：3037 型舊案背景句 ⇒ `'old'`、不改 label、不收、戰情只標涉訟中（燈照 AI 原判、不進 Z2、不標可能為法律事件）；AI 把舊案誤報為視窗內日期、引用句寫「8 月」⇒ 仍 `'old'`；新進展＋日期在視窗內＋引用逐字 ⇒ `'yes'`、理由與 2026-08-29 版逐字相同；引用改寫、拼接、太短 ⇒ `'none'`；2367 型相驗 ⇒ `'acc'`、C17 為主；同一起事故（引用在 C17 報導裡）⇒ `'acc'`、不同報導的法律事件照舊 C16a；延續（隔日再觸發 ⇒ `ruleCont`、同一適用日重判不是、過期 ⇒ 新事件、中間沒觸發軌跡照帶）；**N4**（`news-rule-evidence.test.mjs`「N4 …」、`ai-stoploss-event.test.mjs`「N4 …」三組、`ai-stoploss-plan.test.mjs` N4 兩組、`stop-shadow-core.test.mjs` 編碼）：搜索→兩天後羈押 ⇒ 新事件（不標延續、可推播、軌跡換新、Z2 一級——含同一適用日先以延續發過二級〔前一晚盤後趟、晨間趟〕再來換新 ⇒ 再發一級 seq 2、重新整理不重發、之後的延續條目不降回二級、延續接延續不再發；停損換新層且期限重算、價格已跌不放寬、盤中 B3 ⇒ 舊層照常生效並延到收盤重算〔收盤價較高抬線、較低沿用舊線、沒有收盤價 noRef、noBite、舊層先到期轉延後層〕、同一新進展再送 sameEvent、收盤班車與二級「事件收緊未生效」帶成交價）、同一事件重報 ⇒ 延續、讀不到日期 ⇒ 延續、舊軌跡／舊層沒有事件日期 ⇒ 延續並補上、到期後冷卻期不變；同日沿用（鍵相同沿用、換日／換視窗／內文變動重問、呼叫失敗不沿用、沿用不算題數）；`ruleBearEvents` 不收舊案、工安調查、延續；漏網原因 `legalOngoing`、`continuation`；單檔大小壓縮；daemon 原始碼釘住（沿用在送出提問之前、事實題只有一處呼叫、寫入端帶 `prevVerdict`／`targetDate`、延續不進推播）。
- R1（2026-10-06）：`applyRuleFacts` 只對 C16a 覆寫 label，其他類別 label／bullish／信心／理由逐一維持 AI 原判（`news-rule-classes.test.mjs`）；端到端「AI 判中性、C17 是 → label 維持中性 → 寫入端欄位 → `ruleBearEvents` 與戰情 `majorBearOf` 同一類別；C16a 照舊覆寫」（`news-rule-classes.test.mjs` 末例、`stop-shadow-runner.test.mjs` 盤前收緊例）。

### 10A.9 對推播數量的預估影響

- 收緊本身**不推播**（二級 `stopInfo` 只寫文件）。
- 收緊後若被觸及，發一次停損一級（已含在事件去重內）。無條件下強級收緊線 5 日內被觸及 36.2%、溫和級 12.5%；利空事件下的條件機率沒有資料，影子期量。
- 頻率（`evidence.md` §11，唯讀實數）：2026-08-31～10-05 共 24 個適用日，全市場有規則標記的法律判別合格 4 筆（約每交易日 0.17 筆）；新聞管線補齊後可能約每交易日 1 筆（代理估計）。會員持股約 10 檔、普通股約 1,900 檔，以現在的會員池，由收緊造成的停損一級**一年可能只有個位數則**；會員增加後依持股與判別涵蓋率線性增加。

## 10B. 新聞影響權重：研究期（使用者裁定）

- `rankMediaVerdicts` 的影響權重 `w` 與「強／中／弱」分級**只顯示**，凡是顯示權重的地方都標「影響權重（研究期·只顯示）」。這包括權重的原生出處**盤後報告**（news-weight §1.1 #5：`src/components/AfterMarket/AnalysisReport.tsx:36` 現寫「依先驗影響權重排序，非分數」、`AfterMarketNews.tsx:76`、`:89` 現寫「先驗，顯示排序，非分數」「皆為先驗，未經量測」）以及戰情新聞燈與抽屜。
- **不得**用於：任何等級的警示門檻（含 Z2 的一級與二級）、停損（含 §10A 的收緊）、名單或推薦的排序鍵（推薦榜、選股、名單）。
- **盤後報告依 `w` 排列顯示順序：不算使用**（第二輪 A5「不算」，2026-10-05）。盤後報告「當晚消息」「媒體消息判別」的顯示順序與分析師團隊素材包的取材順序**維持原樣**；盤後報告元件屬另一個流程的檔案，本規範不改它們。要在那兩個元件補「研究期」字樣時，由該流程依 `wording.md` §4 的字樣處理（不改排序）。
- 停損與新聞警示只用「規則類別」：§10A.1 的述詞與 §10A.2 的類別權重（規則先驗，不是 `w`）。權重相關的研究一律走 §10A.7 的影子紀錄。
- 連動影響（不屬本規範檔，列給戰情流程）：戰情 `warroom-news.mjs` 的 `majorBearOf` 目前把權重門檻類（w ≥ 0.6、法律或處分 w ≥ 0.3）降為二級；依研究期裁定（§13.2 B4 已確認）應改為**不發任何等級的警示**，只保留燈號與抽屜顯示（實作計畫 §3.4）。

---

## 11. 持續驗證

1. **影子期**（切換前，至少 20 個交易日；定版看資料，不看時鐘）：
   - daemon 每日寫 `stopBooks/{uid}`（`phase:'shadow'`），不推播。
   - 收盤資料定版後，逐檔記錄：舊推播停損、舊紀律停損、v1.1 停損與四條組成線、綁定來源、事件收緊狀態、今日真成交最低、是否觸及、觸及時間、判定價來源、新舊兩套各會發幾則（含 `trailing`）。**新舊兩套用同一份報價、同時判定**。
   - ATR 帶的官方版與持股分析的 Yahoo 版逐檔對照（差幾檔、誰高），量化 §3A.1 的口徑差；並以**同一份報價**分別用線上帶與官方帶跑觸及，量出實際的遷移（新收到、不再收到、早晚），取代回測中構造使然的「0%」。
   - **分層統計**：切換前既有部位與切換後新建部位分開；收盤進場與盤中進場分開；ETF／興櫃（`noOfficialBars`，§2A 驗證前後）分開；事件收緊依類別與級別分開。回測數字只適用「收盤進場的新部位」（§3A.6）。
2. **合成部位母體**：價 ≥10、20 日均量 ≥500 張，每天每 5 日抽一次進場，套用 v1.1，寫入 `stopSpecAudit/{YYYY-MM-DD}`。
3. **兩份逐件記錄**（命中與漏網）：
   - 停損觸發三類（洗出／命中／賣在相對低點，互斥）＋旗標（跳空穿越、鎖死、誤觸）＋**綁定來源**（成本線、ATR 帶、保本、追蹤、事件收緊分開統計）＋**觸發時是否在獲利中**。基準（成本 −8%、進場後 20 日內觸發，n=53,324）：洗出 24.6%、命中 46.6%、賣在相對低點 28.8%。
   - 沒觸發的部位：漏網＝沒觸發，但收盤虧損超過上限。
   - 事件收緊另有命中與漏網兩份（§10A.7）。
4. **健康度**：
   - **主檢查＝實作不變式**（每日；任一違反就觸發檢討並通知管理員）：
     - I1：每個觸及事件的判定價來源是今日成交更新的 `low`、`setToday` 時 `liveAt > startedAt` 的真成交價，或官方日低補判；`low > 0`、在合法檔位上。
     - I2：有除權息事件的部位，當日都有 `exAdjust` 版本，或 `exPending`／`exUnconfirmed` 標記。
     - I3：沒有任何判定用到 `liveAt` 不是今天的報價。
     - I4：每個觸及事件最多一則一級；`stopInfo` 從未進入推播。
     - I5：前端暫算與 daemon 對同一持股的停損一致（抽樣）。
     - **I6**：生效停損 ≥ 前一版 ×Πf，除非版本原因是 `exAdjust`、`costCorrection`、`init`、`eventExpire`（或 `bandDown`）。
     - **I7**：組成線的 `dataDate` 等於最近定版日；落後時有 `linesStale` 標記（`noOfficialBars` 代號不檢查）；`exGapBars > 0` 的那天沒有任何由日 K 算出的抬高。
     - **I8**：每次收緊都能對回一筆符合 §10A.1 的判別與 §10A.2 的類別、級別；任何輸出都不隨 `w` 改變。
   - **輔助＝行情統計**（只顯示，不自動觸發）：洗出率、跳空占比、觸發部位的出場報酬 p5、獲利中觸發占比。
   - **S4 閘門的證據力**：「誤觸 0 件」要附事件數 n 與 95% 上界 ≈ 3/n。
5. **AI 選擇題**：第二階段（§3.5）。v2 若要生效，須另訂事前登錄的成對比較規範。
6. **LLM 合規**：每日統計 `stopLlmViolation` 的件數與原因分布（含 `bandAsStop`）。
7. **期間偏誤**：回測期偏多頭（60 日不停損平均 +5.70%），只有 183 個進場日、約 15 段不重疊 60 日窗。v1.1 的觸發率 97.7% 在空頭期沒有驗證；要記錄空頭日分層下的命中與漏網。

---

## 12. 分歧與裁定理由

| # | 議題 | **v1.1 結果** | 理由與出處 |
|---|---|---|---|
| D1 | 一般持股的預設停損 | 成本線為最寬界線（**第 2 項裁定**），與 ATR 帶、保本、追蹤取高 | 第 2、3、8 項裁定合起來的結果。純成本線（v1）與 v1.1 的平均差 −1.95pp［−3.71, −0.18］（`evidence.md` §10.2） |
| D2 | 上限 | **8%**（第 1 項裁定） | 站上鐵律；10% 方案不再列 |
| D3 | LLM 的角色 | **只引用**（第 4 項裁定）；選擇題第二階段 | stockAI 58 檔中 53% 的停損與系統不符（量化 §3.12） |
| D4 | AI 結構候選的距離下限 | 第二階段（`llm-contract.md` §1.3） | — |
| D5 | 觸及用什麼價 | 今日最低（三方一致，同 v1） | MIS 的 `l` 只隨成交更新 |
| D6 | 收盤競價窗起點 | 13:25（同 v1） | `warroom-session` 為唯一真相來源 |
| D7 | 一級用盤中觸及還是收盤確認 | **盤中觸及**；16:45 補判發一級（第 5 項裁定） | 理由是即時資訊，不是統計（v1 D7） |
| D8 | 去重與事件結束 | 每個觸及事件一次；官方收盤 > 停損×1.02 結束；**版本延續表**（§8.2） | v1.1 每日組成線抬高造成版本頻繁更換，事件不能跟著版本重開 |
| D9 | 紀律 | 第 2 個交易日起、交易日計數、每人每日一則彙總；**每日推播與「請面對決策」保留**（第 7 項裁定） | — |
| D10 | 獲利後 | **上移**：+10% 保本、+20% 追蹤 3ATR（第 8 項裁定）；**取代**獲利回落線 | 波段 §10.10：−3.58pp、≤−15% 0.40%（成本線基礎） |
| D11 | 除權息 | 同 v1（第 12 項裁定）；擴及所有棘輪值與收緊線 | 跨除權息持股 9.17% 會被誤觸 |
| D12 | 處置／注意 | 不調整、只揭露（同 v1） | 處置中觸發 74.1% 在 20 日內回到成本 |
| D13 | 模式 | 全部 general；ND14 第二階段（第 10 項裁定） | — |
| D14 | 攤平、部分賣出、加碼錨定日、成本更正 | 不下移；不下移；該次加碼日（第二階段用）；只認編輯原筆（第 6 項裁定） | — |
| D15 | 成本可疑 | 0.25／5（第 11 項裁定） | — |
| D16 | 逼近 | ≤1 ATR，否則 ≤2%（同 v1） | — |
| D17 | 檔位取整方向 | 成本線、保本、追蹤、事件調整向上取；ATR 帶與事件收緊線向下取（留在結構外側、保住最小距離） | 成本線是虧損上限，向上取才不超過 8% |
| D18 | 資料過舊 | 不抑制觸及，只標延遲（同 v1） | — |
| D19 | 共用函式與狀態文件 | `scripts/lib/ai-stoploss.mjs`（集線器＋七個子模組，§3.8）；`scripts/lib/news-rule-classes.mjs`；`stopBooks/{uid}`；`stopSpecAudit/{date}`；新增 `stopEventShadow/{date}`（管理員唯讀）；ETF／興櫃歸檔 `etfDailyArchive`、`emergingDailyArchive` | 全市場合成事件只含公開資料，但仍不公開，避免被當成訊號 |
| D20 | 還原成本 | 逐筆還原後加權（同 v1） | — |
| **D21** | ATR 帶的角色 | **觸發線**（第 3 項裁定）。落實**已裁定**：官方還原日 K、收盤資料到齊後算一次、隔一個交易日生效、買進當天不套（A1「ok」）；併入只升不降棘輪 `BAND_RATCHET=true`（A2「ok」） | 「不停止觸發」是使用者原話；落實方式第二輪確認。不棘輪的對照數字並列（§3A.6），保留為回退開關 |
| **D22** | 規則類重大利空 | 新聞技能 §4.1 方向標「規則」的利空類別一律程式規則判定（AI 只認定事實），依**類別權重**分級：≥0.7 收到前收 −max(1ATR, 3%)、0.3～0.7 收到前收 −max(2ATR, 5%)、<0.3 與 C23 不收緊；5 個交易日到期、只收緊；事件身分＝(代號, 類別, 首次生效日)，期限內不延長、到期後冷卻 5 個交易日；期限內事件日期較晚的新進展＝新事件、重新起算（2026-10-07 N4）（第 14 項＋第二輪 A4） | 先驗·未回測；類別權重＝新聞技能 baseWeight、距離沿用既有常數；確定性鍵才可重現；影子紀錄校正 |
| **D23** | 新聞影響權重 `w` | 研究期只顯示、凡顯示處標「研究期」（使用者裁定）；盤後報告依 `w` 排列的顯示順序不算使用、維持原樣（A5「不算」） | 不進警示門檻、停損、名單排序鍵；類別權重與 `w` 分開 |
| **D24** | 推播文字 | 9 處改事實句；紀律那句保留；隔日沖改條件句（第 9、7、13 項裁定）；#6 後半句保留原文（A6「保留」） | `wording.md` §3；文字由 `ai-stoploss-text.mjs` 產生 |
| **D25** | 5～6 碼與英文字尾 ETF、興櫃 | 另建官方日 K 歸檔（A3「3」）；驗證前留在第一階段口徑 | 沒有官方日 K，第 3、8 項在這類代號上無法照 v1.1 落實；驗證前不讓它們失去現行的帶觸發 |
| **D26** | 戰情 Z2 觸停損一級 | 網頁判定、標「單一裝置·暫算」，維持到切換正式（A7「ok」）；切換後改讀 daemon | 前端判定讓 A1 與 Z2 用同一個數字；缺點是單一裝置、不同裝置可能不同，所以只到切換為止 |

---

## 13. 使用者裁定（2026-10-05）

### 13.1 第一輪：十六項裁定與落實位置

使用者原話：「停損 3不停止觸發 7要留 8要 9好 14要 15不要 16算 其它ok」；新聞：「識讀權重 5 標明研究期，只顯示計分但不實際使用」。

| # | 題目（v1 §13） | 裁定 | v1.1 落實位置 |
|---|---|---|---|
| 1 | 上限 8% 或 10% | ok＝8% | §3.7 `CAP_PCT`、D2 |
| 2 | 預設停損＝成本線或方案 A | ok＝成本線 | §3.2、D1 |
| 3 | ATR 浮動帶要不要停止觸發、改名結構參考價 | **不停止觸發** | §0-2、§1、§3.2–§3.4、**§3A**、§9、D21；落實方式見第二輪 A1、A2；ETF 等見 A3 |
| 4 | LLM 角色；影子選擇題要不要跑 | ok＝只引用；選擇題列第二階段，本次不實作 | §0-8、§3.5、§10、`llm-contract.md` §1.3 |
| 5 | 一級用盤中觸及；收盤後補判的等級 | ok＝盤中觸及；補判發一級 | §4.2、§8.1 |
| 6 | 攤平、部分賣出、加碼錨定日、成本更正 | ok＝預設 | §3.2、D14 |
| 7 | 停損紀律的推播與「請面對決策」 | **要留** | **§8.4**、§9（豁免）、`wording.md` §3 #3 |
| 8 | 獲利後要不要上移停損 | **要**（+10% 保本、+20% 追蹤） | **§5**、§3.2、D10 |
| 9 | 現行推播文字改事實句 | **好**（第 7 項那句保留） | §8.6、`wording.md` §3、實作計畫 §2.8；#6 後半句見第二輪 A6 |
| 10 | ND14 | ok＝第二階段 | §2、`modes-phase2.md` |
| 11 | 成本可疑門檻 | ok＝0.25／5 | §3.4、§3.7 |
| 12 | 除權息未確認時的處理 | ok＝預設 | §3.6、§7 |
| 13 | checkOpenSell 改條件句 | ok＝「若為隔日沖計畫」 | `wording.md` §3 #9 |
| 14 | 重大利空要不要收緊停損 | **要**（不得用權重；規則類別、AI 讀內文、當日非承接） | **§10A**、§10.4、D22；類別與類別權重見第二輪 A4 |
| 15 | 個人推播要不要隱藏停損價 | **不要**（照常顯示） | §8.5 |
| 16 | 「設定後最低成交」算第二階段 | **算** | §4.1 |
| 新聞 | 識讀權重（news-weight §1.1 #5） | 研究期、只顯示不使用 | **§10B**、§10A.1-E、§9、D23；盤後報告顯示順序見第二輪 A5 |

### 13.2 第二輪：七項裁定（2026-10-05）

使用者原話：「a3 3／a4 做skills判定與加權重／a5 不算／a6 保留／其它都ok go」。A1、A2、A7 與 B1–B5 屬「其它都ok」。

| # | 題目 | 原話 | 已裁定的內容 | 落實位置 |
|---|---|---|---|---|
| **A1** | 第 3 項「現行帶繼續觸發」的落實方式 | 其它都ok | ATR 帶用**官方還原日 K**、**收盤資料到齊後算一次**、**隔一個交易日生效**、**買進當天不套** | §3A.1、§3A.4、§3.6 最後一列；`atrBandOf`、`lineInputsOf`、`frontLinesOf` |
| **A2** | ATR 帶是否併入只升不降棘輪 | 其它都ok | **併入**（`BAND_RATCHET=true`）；不棘輪保留為回退開關 | §3A.3、§3.7；`resolveStop` 的 `bandHold` |
| **A3** | 5～6 碼與英文字尾 ETF、興櫃（chipArchive 只收 4 碼） | 「3」 | 選第 3 案：**另建 ETF（含槓桿／反向英文字尾 ETF）與興櫃的官方日 K 歸檔**（使用者已核可為此抓官方端點），讓這類持股也能算 ATR 帶、保本線、追蹤線；**歸檔完成並驗證前，這類持股沿用現行算法** | **§2A**、§2、§3.6；`barArchiveOf`、`hasOfficialBars`、`legacyBranchActive(book, code)`；實作計畫 §2.11 |
| **A4** | 事件收緊的類別 | 「做skills判定與加權重」 | 依 `tw-news-impact-analyst`，把所有方向標「−（規則）」的利空類別（C16a、C22、C13b、C17、C16b、C15a、C11a、C15c、C20b、C23，逐一以新聞技能為準）做成**程式規則判定**（AI 只認定事實，方向與類別由程式決定），並修正 AI 自己判利空時不加規則標記的漏網（`ai-daemon.mjs:6415`）；每個類別一個**類別權重**＝新聞技能 §4.1 baseWeight（先驗·未回測）；收緊依類別權重分級（≥0.7 強、0.3～0.7 溫和、<0.3 不收緊；C23 依新聞技能不當訊號）。**類別權重不是 AI 識讀結果權重 `w`**（`w` 維持研究期只顯示） | **§10A**（10A.2、10A.3）、§0-5、§3.7 `EVENT_TIERS`；`news-rule-classes.mjs`、`eventTierOf`、`eventLineOf`；新聞管線改動：實作計畫 §2.10 |
| **A5** | 盤後報告依影響權重排列算不算「實際使用」 | 「不算」 | **不算使用**，盤後報告的排序與元件**維持原樣**（盤後報告元件屬另一個流程的檔案，本規範不改） | §0-6、§10B、D23 |
| **A6** | 指數急落公共訊息後半句「隔日沖偏多策略暫停追價」 | 「保留」 | **保留原文**；S2b 只刪前半句「持股請確認停損價位；」 | §8.6、`wording.md` §3 #6；`plungePushText`、`PLUNGE_TAIL_KEPT` |
| **A7** | 戰情 Z2 觸停損一級由前端判定，還是只讀 daemon | 其它都ok | **網頁判定**，標「**單一裝置·暫算**」（現行實作），**切換正式前維持**；`phase==='live'` 後停用前端判定、改讀 daemon 的 `type:'stop'` | 生效範圍、D26、實作計畫 §3.2 |

**解讀確認（B1–B5，第二輪「其它都ok」已確認，照字面落實）**：

1. **B1** 停損紀律「要留」的範圍：保留每日推播與「請面對決策」；其餘照 v1：同一停損、第 2 個交易日起、交易日計數、每人每日一則彙總（§8.4）。
2. **B2** 追蹤線的高水位：官方還原**收盤**（與回測口徑一致；§5.1）。
3. **B3** 獲利回落線推播：第 8 項「要」＝改用保本／追蹤並**取代**獲利回落線，S5 起不再推 `trailing`（§5.2）。
4. **B4** 戰情 Z2 的權重門檻類新聞警示：依研究期裁定，連二級也不發，只保留燈號與抽屜顯示（§10B；屬戰情流程，實作計畫 §3.4）。
5. **B5** 事件收緊的身分與冷卻：同代號同類別期限內不延長、到期後冷卻 5 個交易日（§10A.4）。

### 13.3 第三輪：R1–R9 裁定（2026-10-06）

使用者原話：「ok 如建議」（對 R1–R9 的建議全部照建議）。

| # | 題目 | 已裁定的內容 | 落實位置 |
|---|---|---|---|
| **R1** | 非法律規則類別事實「是」要不要改 `newsVerdict` 的 label | **不改**：C16b、C17、C22、C13b、C23、C11a、C15a、C15c、C20b 只記規則欄位（`ruleClass`、`ruleOverride`、`ruleSub`、`ruleHits`、`aiOriginal`、`ruleFacts`），label／bullish／信心／理由維持 AI 原判（label 連動推薦排序、個股評分、做空候選、squeeze-train）；**只有法律類 C16a 照舊覆寫為利空**（2026-08-29 起的既有行為與使用者規則「涉法律事件一律利空」）。停損收緊與戰情 v2 以規則欄位辨識（`ruleClassOf` 不看 label） | §0-5、§10.4、§10A.1-C／E、§10A.2-3／6、§10A.7、§10A.8；`news-rule-classes.mjs`（`applyRuleFacts`、`ruleClassOf`、`LABEL_OVERRIDE_CLASS`）、`warroom-news.mjs`（`verdictState`）、`ai-stoploss-event.mjs`（`missShadowRows`）、daemon 註解與 log。**部署先後**見 §14（web 先於或與 daemon 重啟同窗） |
| **R2** | 戰情 Z2 是否依類別權重分級（§15A-1） | 維持現行實作：≥0.7 一級（含 C23）、0.3～0.7 二級、其餘不列 Z2 | `warroom-news.majorBearOf`（不改） |
| **R3** | 除權息係數的取得（§15A-2） | 維持現行實作：每日收盤結算時抓官方區間（約 2 請求／日、固定數），取代歷史檔每日累加 | `stop-shadow-runner` `exUpTo`（不改）；§15-5 |
| **R4** | ⑧ 法人×大戶「疑似出貨警示」結尾「持有者確認停損位，未持有者勿接刀」 | 改為只描述事實（`wording.md` 原則），其餘內容不動 | daemon（錨點 `label: '疑似出貨警示'`）；`wording.md` §3；`stop-daemon-pin.test.mjs` |
| **R5** | 問AI（`buildQAContext`）的停損約束 | **正式切換（S5）時再做**，影子期不改 | §10.1 問AI 列；§14 待辦 |
| **R6** | 興櫃日 K 要不要回補 | 維持：從 10/02 起自行累積、不回補 | §2A 回補列 |
| **R7** | 9 檔 ETF 分割／反分割係數（§15-9） | **影子期內補官方係數**；本次不做 | §15-9（期限） |
| **R8** | ETF／興櫃日 K 的供給方式 | daemon **盤前讀本機官方鏡像**（0 次 Firestore 讀寫、0 上游請求）；讀不到 fail-closed 並記錄 | §2A（儲存、驗證前、程式列）；`official-bars.readOfficialBarsAsync`、`stop-shadow-runner`（`loadOfficialBars`、`mirrorInputsOf`）、`stop-shadow-core.officialBarsVerdict`、`ai-stoploss-plan.unverifiedArchiveOf`；daemon `stopShadowLoop`（`STOP_VERIFIED_ARCHIVES` 目前空）。2026-10-06 審查補：鏡像代號的收盤結算移到下一交易日盤前（`mirrorSettle`）、興櫃轉上市櫃改走 chipArchive、前端 `bookStopOf` 與 daemon 共用 `legacyCodeActive`（停損簿文件帶 `verifiedArchives`） |
| **R9** | `stopBooks` 的 Firestore 規則 | 本人只能讀自己的 `stopBooks/{uid}`（含 daemon 寫的 `shadowDays/{資料日}` 子集合），管理員可讀，任何前端都不可寫 | `firestore.rules`（未部署：要隨部署帶 `firestore:rules`）；§14 |

### 13.4 第四輪：新聞規則 N1(b)／N2／其它（2026-10-07）

使用者原話：「n1 b／n2 依建議／其它依建議」。起因是 10/05–10/07 線上查核：3037 欣興的報導都在講 ABF 載板需求，內文夾帶 8 月「遭檢調搜索」舊背景句，C16a 事實題只問主體不問時間 ⇒ 連三個目標日改判利空、10/05 盤中推了「⚠ 突發利空：3037欣興(強)」；2367 燿華工安事故同時答 C16a 與 C17，C16a 權重高勝出 ⇒ 改判利空；事實題沒留觸發字、前後文與回答，答「否」的被之後重判覆蓋，同一篇報導同日重問。

| # | 已裁定的內容 | 落實位置 |
|---|---|---|
| **N1(b)** | C16a 只有新聞視窗內有新進展（新的搜索、約談、起訴、羈押、判決、主管機關新處分，事件日期在本次視窗內）才觸發並改判利空；舊案只標「涉訟中」事實標籤，不改判、不推播、不收緊停損。事實題同時問是否新進展、日期，並要求逐字引用法律事實句（比不上就不算）。同一檔同類別在有效期內重複觸發標「延續」，不當新事件、不重複推播。這是 2026-08-29 硬規定「被搜索就是利空」的細化：新進展＝利空（規則決定方向不變），舊案＝涉訟中 | §10.4、§10A.1-E／F、§10A.2-8／12、§10A.6、§10A.7；`news-rule-evidence.mjs`（`resolveRuleFact`、`withRuleTrail`）、`news-rule-classes.mjs`（C16a 事實題、`ruleFacts` 的 `old`）、`warroom-news.mjs`（`lt`、`rf`）、`ai-stoploss-event.mjs`（`ruleBearEvents` 條件 F、漏網原因）、daemon（推播與突發清單不列延續） |
| **N2** | 工安事故後的檢察官相驗、勞檢、事故調查、業務過失偵查不算 C16a，歸 C17；同一起事故 C17 與 C16a 同時答是時主類別用 C17（C17 只記欄位、不改 label，R1）；C16a 事實題寫明不算 | §10A.2-9、§10A.6；`ACCIDENT_LINK_RE`（工安語境明確的字樣）、`ACCIDENT_CONTEXT_RE`＋`reconcileAccident`（較寬的事故字樣要有 C17 語境）、C16a `fact` |
| 其它 | 稽核軌跡 `ruleEvidence`；題數與答案分布依資料日累計（`stopSpecAudit/{資料日}.newsRule`，只放計數）；同一檔同類別同一組報導當日沿用答案（不重問）；`newsVerdict` 單檔逼近上限時壓縮證據 | §10A.2-10／11／13 |
| 已裁定（N3，§13.5） | 線上已被誤判的 3037（10/05–10/07 `newsVerdict`）**不回寫**：只在程式上線後讓之後的判別依新規則 | — |

### 13.5 第五輪：N3／N4／N5（2026-10-07）

使用者原話：「依建議進行」（對 N3／N4／N5）。

| # | 已裁定的內容 | 落實位置 |
|---|---|---|
| **N3** | 不回溯修改既有 `newsVerdict` 文件（不動歷史資料） | 不改程式 |
| **N4** | 延續有效期（5 個交易日）內，事件日期晚於延續軌跡記的事件日期的新進展（例：先搜索、兩天後羈押或起訴）＝新事件：照既有 C16a 新進展規則改判利空（引用逐字、日期在新聞視窗內）、可推播、停損收緊重新起算、戰情 Z2 依類別權重發級、軌跡更新為新的事件日期；事件日期相同或更早、或讀不到 ⇒ 仍算延續 | §10A.1-F、§10A.2-12／13、§10A.4、§10A.6、§10A.8；`news-rule-evidence.mjs`（`eventDateLater`、`withRuleTrail`、`isRuleRenewal`、`ruleEventDateOf`）、`ai-stoploss-event.mjs`（`ruleBearEvents` 的 `eventDate`、`stepEventOverlay`、盤中換新延後 `renewPending`／`settleRenewal`）、`ai-stoploss-plan.mjs`（收盤班車閘門、延後二級帶成交價）、`stop-shadow-core.mjs`（身分記憶第 4 格）、`warroom-news.mjs`（`stepMajorBear` 同日先延續後換新照新事件再發）、daemon log |
| **N5** | 讀不到日期就不改判（維持現行保守做法：`'old'`／`dateUnknown`） | 不改程式 |

## 14. 過渡期與程式位置

- **第一階段·daemon**：推播 `:3251`、紀律 `:9864`、崩盤防禦 `:11151`、論點 `:9333` 照舊算法（行號 HEAD `2fd8ce6`）。推播文字可在 S2b 先改（§8.6；文字由 `ai-stoploss-text.mjs` 的九支函式產生，只換字串、不動判斷）。
- **第一階段·戰情 v2（超管）**（2026-10-05 本機，未部署）：A1 是 v1.1 前端暫算（`scripts/lib/warroom-mine.mjs` 的 `provisionalStop`＝成本線與持股分析 ATR 帶取高、帶不棘輪；§3.6 最後一列），ATR 帶標「ATR 帶（持股分析·觸發線之一）」；Z2 觸停損一級由前端判定（`TopAlertEngine` 的本機事件表，文字標「單一裝置·暫算」），A7 已裁定維持到切換正式。
- **規範函式**：`scripts/lib/ai-stoploss.mjs`（集線器）＋`ai-stoploss-{base,lines,core,event,text,llm,plan}.mjs`＋`news-rule-classes.mjs`＋`news-rule-evidence.mjs`（2026-10-07：C16a 新進展判定、稽核軌跡、延續、當日沿用、計數、單檔大小），型別 `ai-stoploss.d.mts`、`news-rule-classes.d.mts`、`news-rule-evidence.d.mts`，測試七個 `*.test.mjs`（§3.8）。每個子模組 <800 行。
- **狀態文件** `stopBooks/{uid}`：daemon 用 Admin SDK 寫；`firestore.rules` **已加**（R9，2026-10-06，本機、未部署）：本人與管理員唯讀 `stopBooks/{uid}` 與 `stopBooks/{uid}/shadowDays/{資料日}`，任何前端不可寫。`stopEventShadow/{date}`、`stopSpecAudit/{date}` 規劃為只開放管理員讀，**尚未加**（現在預設拒絕；R9 只裁定 `stopBooks`）。規則改動要隨部署帶 `firestore:rules`。新日期欄位 `sourceDate`、`floorSourceDate`、`bandSourceDate` 已登記 `check-field-conventions`。
- **上線順序**（實作計畫 §7）：S2（共用函式，**已完成**本機驗證）→ S2b（推播文字）→ S3（影子：daemon 每日寫 `stopBooks`、只記錄不推播）→ S4（影子期 ≥20 個交易日、I1–I8 0 違反）→ **使用者核可** → S5（切換）。新聞管線的規則判定（A4，實作計畫 §2.10）與 ETF／興櫃歸檔（A3，§2.11）可與 S3 並行，各自有影子觀察與驗證閘門。
- **切換條件**：`exright-history.json` 已回補並每日累加、影子期 ≥20 個交易日、I1–I8 在全部會員持股與合成母體上 0 違反，再經使用者核可。ETF／興櫃另需 §2A 驗證閘門全過（可晚於 S5 單獨切換）。
- **切換方式**：daemon 把 `stopBooks/{uid}.phase` 改成 `'live'`、`specVersion` 為 `'stop-v1.1'`（同時 `planBookRefresh({ resetEpisodes: true })` 清掉影子期事件，第一輪 live 以 seeded 彙總處理已在停損下的部位），前端看到這兩個值才改讀 `stopBooks`。
- **回滾**：把 `phase` 改回 `'shadow'`，舊推播、舊紀律、舊 `trailing`、舊崩盤防禦立刻恢復（`legacyBranchActive`），不必重啟 daemon。前提：舊分支讀的 `portfolioAnalysis.analyses[code].stopLoss` **在舊分支移除前不改語意**（一直是 `/api/rating` 的 ATR 帶），所以回滾後的數字與切換前相同。已先行的推播文字（S2b）不隨 `phase` 回滾，要回滾就 `git revert`。事件收緊單獨關閉：`ruleBearEvents` 的 `classes` 傳空陣列。
- 步驟、介面、測試清單與遷移風險，見 `warroom/stoploss/v1.1/impl-plan.md`。
- **待辦（已裁定，2026-10-06）**：R5 問AI（`buildQAContext`）的停損約束——S5 切換時與其他提示詞一起換（§10.1），影子期不改；R7 9 檔 ETF 分割／反分割官方係數——影子期內補進 §7 係數表（§15-9 期限）；R8 閘門 ④⑤ 與 `STOP_VERIFIED_ARCHIVES` 核可（§2A）。
- **部署先後（R1；2026-10-06 審查）**：戰情 v2 的燈、Z2、B2、A2 由 Next.js **伺服器端**算（`src/lib/warroom/build-news.ts` → `newsBoardFromDoc`），要 web 帶新版 `scripts/lib/warroom-news.mjs`、`news-rule-classes.mjs` 部署後才認得 R1 的資料形狀。目前線上 web 的 `ruleClassOf` 第一行要求 label＝利空；R1 起 daemon 對非法律規則類別（C17、C22、C23…）只記規則欄位、label 維持 AI 原判 ⇒ 舊 web 會把它們顯示成 AI 原判的中性／利多、**不進 Z2**。所以 **hosting 必須先部署，或與 daemon 重啟在同一個窗口完成；web 部署前不要重啟 daemon**。daemon 是 disk 即部署，若 KeepAlive 在 web 部署前已拉起磁碟版本，web 部署前「戰情暫時看不到非法律規則類利空」列為已知缺口（停損影子在 daemon 端執行，不受影響）。反過來先部署 web 是安全的：新版 `ruleClassOf` 第 ② 條仍認舊資料的 C16a（ruleOverride／「【規則】」前綴＋label 利空）。`firestore.rules`（R9）同一次部署帶上。
- **部署先後（2026-10-07 N1(b)）**：daemon 寫的新欄位（`ruleFacts` 的 `old`／`acc`、`ruleEvidence`、`ruleTrail`、`ruleCont`）舊版 web 都不認得但也不會誤判：舊 web 的 `ruleClassOf` 只認 `ruleFacts[ruleClass]==='yes'`，舊案沒有 `ruleClass`，所以不會顯示成利空；只是**看不到「涉訟中」標籤與「延續」字樣**，而延續的 C16a 在舊 web 的 Z2 仍會發一級（新 web 降二級）。新 web 的 `warroom-news.mjs` 多 import `news-rule-evidence.mjs`，hosting 要帶這個檔一起部署（git add）。停損影子在 daemon 端執行，重啟 daemon 後即依新規則。
- **部署先後（2026-10-07 N4）**：判別軌跡 `withRuleTrail`、停損影子 `stepEventOverlay`／`ruleBearEvents`、停損簿編碼在 daemon 端，daemon 重啟（照 `can-restart-daemon` 時窗）後才生效。**戰情 Z2 要重新部署 web**（2026-10-07 審查更正；先前寫「不需重新部署 web」在下列情境不成立）：Z2 的同日去重 `stepMajorBear` 在瀏覽器端（`TopAlertEngine`，localStorage 記當日已發狀態）跑。換新的判別不帶 `ruleCont`，當日第一次出現時線上 web 本來就當新事件發一級；但同一適用日**先**以延續發過二級（前一晚盤後趟或晨間趟重報舊的搜索，帶 `rf`）、盤中才出現換新的，線上 web 只看等級上升 ⇒ 不再發、維持二級「利空持續（同一關鍵句前一適用日已判利空）」文案，隔日軌跡換新後又標延續 ⇒ 新進展從頭到尾沒有一級 Z2。修正在 `warroom-news.mjs`（本機、**未部署**；部署要使用者核可）。**部署前的已知落差**：上述情境 Z2 只有二級延續；daemon 推播（完成訊號、盤中突發）與停損影子不受影響。停損簿的層多出 `eventDate`／`renewOf`／`renewPending` 可選欄位，web 的 `activeOverlays` 與快看抽屜只讀 key、label、line、生效日、期限、權重（延後換新期間舊層照常是 active），不受影響。重啟前寫的延續軌跡已有事件日期（`8a198b7` 起，C16a）；重啟前建立的停損層與事件身分記憶沒有事件日期，走相容規則（`sameEvent` 並補上日期，之後更晚的才換新），最多影響一個收緊期限（5 個交易日）。
- 改動前要先掃影響面：所有讀 `analyses.stopLoss`、`alerts`、`stopDiscipline`、`newsVerdict`、`_hwm` 的地方。daemon 是 disk 即部署（KeepAlive 隨時拉起磁碟版本）：改完必須 `node --check` 通過、相關測試通過；只在收盤後重啟，重啟前先跑 `node scripts/can-restart-daemon.mjs`。

## 15. 待核實（事實查證，不需使用者裁定）

1. **ETF 檔位**：`R`、`B`、`A`、`L`、`U` 等字尾代號不符 daemon `_isEtfCode = /^00\d{2,4}$/`（`isEtfCode` 照釘 daemon）；國外成分 ETF 沒有漲跌幅限制。§2A 歸檔驗證時一併核實檔位表。
2. **除權息日的時點**：MIS 的 `y` 是不是參考價；TWT49U、exDailyQ 在開盤前是否已公布。
3. **TWT48U 的當日端點**：www 端點身分與日期回聲，要先驗證並登錄 `scripts/source-registry.json`。
4. **處置分盤的滑價**：沒有量測。
5. **係數表回補與每日累加**：`exright-history.json` 補到 S3 開始日並設定每日累加（需使用者核可執行）。ATR 帶進棘輪後這是**硬閘門**：係數涵蓋不到日 K 視窗時當日不採用帶值（§3.4），長期缺就等於沒有 ATR 帶。
6. **ATR 帶兩個版本的差距**：官方還原日 K 版與 `/api/rating` 的 Yahoo 版（日 K 來源不同；兩者都以前一完整交易日官方收盤夾值），逐檔差幾檔（v1 時只有 71.2% 完全一致），S3 量化；同時以同一份報價量出觸及的遷移（§11-1）。
7. **法律與其他規則類別的覆蓋率**：新聞管線補存規則欄位（§10A.2-6）前，AI 原判已是利空的規則事件只能用字樣代理（24 個適用日：法律有標記且合格 4 筆、代理 13 筆）；補欄位後重新量，前後分開統計。
8. ~~**§2A 的三個端點**~~（2026-10-05 已核實，§2A 已改寫）：上市 ETF 改讀鏡像 `MI_INDEX ALLBUT0999`（不用 `STOCK_DAY_ALL`）；TPEx dailyQuotes `type=EW` 含 ETF（與不帶 `type` 同為 11,928 列、ETF 118 檔）；興櫃**沒有**可指定日期的全表端點，改為 www `emerging/latest` 每日快照（PRIMARY）＋openapi（FALLBACK），只能累積。
9. **ETF 分割／反分割係數**：2024-12～2026-07 鏡像日 K 有 9 件停止買賣後的結構斷點不在 `exright-history.json`（§2A 閘門 ⑦）。官方分割係數的來源與回補待查；在那之前 `lineInputsOf` 對 ETF 斷點 fail-closed（`exGapBars`；R8 起影子對英文字尾 ETF 也以 `checkBreaks` 照查）。**R7（使用者 2026-10-06「ok 如建議」已裁定）**：在影子期內補官方係數，本次不做；**期限＝影子期結束**（S4 報告、請使用者核可 S5 之前），補不到的 ETF 在 S5 時維持 fail-closed（`exGapBars`）並在 S4 報告列出。

### 15A. 待使用者裁定（2026-10-05 實作審查）——**兩題都已裁定**（2026-10-06 R2、R3「ok 如建議」，§13.3）

> 1 ⇒ (a) 維持現行：類別權重決定 Z2 級別（≥0.7 一級含 C23、0.3～0.7 二級、其餘不列）。2 ⇒ (a) 每日收盤結算時抓官方區間（約 2 請求／日、固定數）。下列原文保留作紀錄。

1. **戰情 Z2 的級別是否依類別權重**：`warroom-news.majorBearOf` 現行以類別權重分級（≥0.7 一級、0.3～0.7 二級、<0.3 不列 Z2），但 §1「類別權重」列寫「不可（不當任何警示門檻）」，第二輪 A4 只明示「停損收緊依類別權重」。二擇一：(a) 認可類別權重決定 Z2 級別（改 §1 該列為「停損收緊級別＋戰情 Z2 級別」）；(b) Z2 不看類別權重（例如規則類一律二級、只有 C16a 一級，同 2026-08-29 以來的法律事件）。裁定前程式維持 (a) 的現行實作（戰情 v2 僅超管、未部署）。
2. **係數表硬閘門（§15-5）與影子期起算**：S3 影子已先以「每資料日抓歷史檔之後到資料日的官方區間（不寫檔）」上線，`exright-history.json` 尚未回補與每日累加；除權息預告仍只有上市行事曆前 40 筆（`exPendingSource:'twse-calendar-top40'`），上櫃除權息日在影子中可能誤觸。二擇一：(a) 認可每日區間抓取取代歷史檔累加（改 §3A.3、§7、§15-5）；(b) 先執行回補並設定每日累加（需核可），影子期 20 個交易日從那天起算。在那之前 S4 報告把除權息日分開統計。

## 參考檔

- `references/evidence.md`：回測數字與成交假設、合成者與審查者補量、**v1.1 補量（§10 組成線、§11 事件收緊診斷與規則類別頻率）**、程式行號、成本參考、樣本限制。
- `references/llm-contract.md`：提示詞片段、輸出格式與解析順序、驗證規則 T1–T5；AI 選擇題（第二階段）。
- `references/modes-phase2.md`：當沖、隔日沖、swing5、存股的模式規則（等 ND14）。
- `references/wording.md`：用語範本、禁用詞與兩個豁免（紀律保留句、#9 出場時點）、9 處推播文字的核可改寫（#6 後半句依 A6 保留）。
- 新聞識讀規範：`.claude/skills/tw-news-impact-analyst/SKILL.md`（類別權重與規則方向的出處，§1.5、§1.7、§4.1）。

> **非投資建議。** 本規範中的數字都是歷史統計與程式事實，不代表未來報酬。報酬為未扣成本的毛報酬。

---

## 修訂紀錄

**2026-10-05（v1）**：三方提案（短線、波段風控、量化回測）→ 合成 → 三視角審查（統計、可行性、規則一致性，共 59 項意見）→ 修訂。主要修訂：

- **適用階段**：新增「生效範圍」。第一階段畫面與 daemon 照使用者戰情第 4 題裁定，不套用 v1 的命名、觸及口徑與禁用詞。
- **尾端與證據措辭**：「停損封住左尾」改成「在可成交前提下壓縮左尾」，補上鎖死順延口徑；「停損不提高平均」限定為本站偏多頭回測期；揭露量化事前登錄限制被違反與合成母體的前視選樣。
- **裁定改提案**：D1、D3、D7 由「裁定」改為「提案」；D4 改寫為距離百分比效果；§13 新增「浮動帶是否停止觸發」「LLM 角色」兩題。
- **AI 選擇題**：S1 改為「維持現行生效停損」；v1 移除生效路徑，改列 v2 需要的事前登錄條件。
- **還原成本**：逐筆還原、係數表改用 `mergeFactorItems`；新增持股變動分類；`line` 改依來源分類。
- **除權息**：ETF 與上櫃改為 `exUnconfirmed`；TWT48U 改存全表；補係數表回補、多格快取、08:46 時點。
- **觸及判定**：加上 `low>0`、檔位；`setToday` 依版本生效時刻；時段對應 `WAR_SEGMENTS`；新增 16:45 收盤後補判；延遲改用實測分位數。
- **警示**：一級帶 `id`＋`requireAck`；`alerts` 用 transaction；二級 `stopInfo` 只寫文件；事件結束改看官方收盤。
- **狀態文件**：`stopBooks/{uid}`（本人唯讀）；前端退回統一為「同一支函式＋prev 暫算」。
- **LLM**：三種來源先剝除 `STOP_REF`；停損語境排除均線天數與百分比；S3 不改提示詞；`enforce` 要有標注樣本與使用者核可。
- **驗證**：統一「洗出」；命中與漏網改為互斥三類；健康度以實作不變式為主。

**2026-10-05（v1.1 草案）**：落實使用者對 §13 十六項與新聞權重的裁定。逐項對照（裁定 → 段落）：

| 項 | 裁定 | 改了哪裡 |
|---|---|---|
| 1 | 上限 8% | §3.7 刪除 10% 待裁定註記；D2 |
| 2 | 成本線為預設 | §0-3、§3.2；D1 改寫為「最寬界線」 |
| 3 | ATR 帶不停止觸發 | 新增 **§3A**（規則、優先序、與棘輪的互動、邊界、測試、推播影響）；§1 新增「ATR 帶」「基礎停損」「組成線」「綁定來源」，刪除「結構參考價」；§3.1–§3.4 加入組成線、兩段棘輪、帶值檢查與 `bandDown`／`lineRaise`；§3.6 前端暫算改為成本線與 ATR 帶取高；§9 觸及句寫出來源與損益；D21；待確認 §13.2 A2 |
| 4 | LLM 只引用；選擇題第二階段 | §0-8、§3.5 改為「第二階段，本次不實作」；§3.7 移出 AI 參數；§3.8 移出四支函式；§10.1 刪除 AI 提議列；`llm-contract.md` §1.3、§3 標第二階段 |
| 5 | 盤中觸及；補判一級 | §4.2、§8.1 由「待確認」改為定案 |
| 6 | 持股變動預設 | §3.2 表格標註裁定；D14 |
| 7 | 停損紀律要留 | §8.4 改寫：每日推播保留、「請面對決策」保留並列為禁用詞唯一豁免；§9；`wording.md` §2、§3 #3；待確認 §13.2 B1 |
| 8 | 獲利後上移 | 新增 **§5**（保本、追蹤、與獲利回落線的關係＝取代、優先序、邊界、測試、推播影響）；§1 刪除獲利回落線的現行定義、標退役；§3.7 改參數；§3.8 刪 `trailLine`；v1 的 S6 併入 S5；待確認 §13.2 B2 |
| 9 | 推播改事實句 | 新增 §8.6；`wording.md` §3 由「待核可」改為核可版全文；實作計畫 §2.8 逐處改法 |
| 10 | ND14 第二階段 | §2 |
| 11 | 成本可疑 0.25／5 | §3.4、§3.7 |
| 12 | 除權息未確認 | §3.6、§7 |
| 13 | 隔日沖條件句 | `wording.md` §3 #9 |
| 14 | 重大利空收緊 | 新增 **§10A**（觸發條件、事件類別、收到哪裡、生效與解除、優先序、邊界、命中與漏網影子紀錄、測試、推播影響）；§10.4 改寫；§8.2 版本延續表；§8.3 新增收緊相關 `stopInfo`；§11 新增 I8；D22；待確認 §13.2 A4 |
| 15 | 不隱藏停損價 | §8.5 由「待裁定」改為定案 |
| 16 | 設定後最低成交第二階段 | §4.1 |
| 新聞 | 權重研究期只顯示 | 新增 **§10B**；§1 新增名詞；§9 顯示用語；§10A.1-E 明定不看權重；D23；待確認 §13.2 B4 |

其他：

- 規格版本改為 `stop-v1.1`；行號基準更新為 HEAD `ec89fbe`（daemon 與 `561117f` 相同），並列出工作樹位移。
- 「生效範圍」新增戰情 v2（超管）已改用 v1 前端暫算的現況，以及 v1.1 換入時的改法。
- 新增 v1.1 量化（`references/evidence.md` §10、§11；腳本 `scratchpad/sl_v11/bt_v11.py`）：先重現 v1 四個基準（83.7%、86.3%、58.1%、78.7%；2.69、15.14、1.21 則）再算新組合。
- §8.2 新增「停損換版時事件延續或結束」表，因應每日組成線抬高造成的版本頻繁更換。
- §11 新增不變式 I6（只升不降）、I7（組成線資料日）、I8（收緊可追溯、與權重無關）。
- §15 新增兩項待核實：ATR 帶兩版本差距、法律規則標記的覆蓋率。

**2026-10-05（v1.1 草案審查修訂）**：依審查意見（規則一致性 14 項、可行性 12 項）逐項核實後修訂：

- **把解讀與裁定分開**：§13.2 改為 A（待裁定 7 題，各附暫行做法）與 B（解讀確認 5 題）。ATR 帶改用官方日 K、併入棘輪、買進當天不套，從「定案」改為「依裁定解讀」；盤後報告依權重排序、指數急落後半句、戰情 Z2 前端判一級，由草案自行決定改為待裁定。
- **5～6 碼 ETF 與興櫃**：chipArchive 只收 4 碼代號，v1.1 對它們只剩成本線；暫行留在第一階段口徑（§2、§3.6、§13.2 A3）。
- **事件收緊**：類別逐一列出新聞技能所有規則類利空（§10A.2）；事件身分改為 (代號, 類別, 首次生效日)、期限內不延長、到期後冷卻 5 日（不再用 LLM 引文雜湊）；條件 A 改為 `firstDate < 生效日`；頻率改用 24 個適用日的唯讀實數（合格 4 筆），校正閘門約需 8～9 個月；「AI 已判利空的法律事件」在 S9a 前量不出來。
- **數字**：§3A.6 補鎖死順延（v1.1 ≤−15% 0.10%→0.60%）與 2025 年起分層、適用範圍（只適用收盤進場的新部位）；部位層遷移「0%」改為「構造使然、由 S4 量」；獲利回落線推播量改用日誌實數（28：24）。
- **規格**：§3.4 新增係數涵蓋自檢；`holdHigh` 改為存在 `stopBooks` 增量維護；`basis` 一律 `'system'`、警示上的觸及判定價改名 `touchBasis`；前端暫算的呼叫規則（不判 `linesStale`、今天買進不套帶）；來源標籤與觸及類句子的損益格式統一；紀律保留句的豁免範圍含舊分支；差額帶正負號一律寫出；`/api/rating` 帶的描述更正（以前一完整交易日官方收盤夾值，盤中不變）。

**2026-10-05（v1.1 定稿）**：落實使用者第二輪 7 項裁定（原話「a3 3／a4 做skills判定與加權重／a5 不算／a6 保留／其它都ok go」），並把共用函式升到 v1.1：

| 項 | 裁定 | 改了哪裡 |
|---|---|---|
| A1 | ok＝官方日 K、收盤後算一次、隔日生效、買進當天不套 | §0-2、§1、§3A.1、§3A.4、§3.6 由「待確認」改為已裁定；D21 |
| A2 | ok＝ATR 帶併入棘輪 | §3A.3、§3.7（不棘輪改稱回退開關）；D21 |
| A3 | 「3」＝另建 ETF 與興櫃官方日 K 歸檔，驗證前沿用現行算法 | 新增 **§2A**（來源、回補、儲存、驗證閘門、驗證前後）；§2、§3.6、§3A.4、§5.2、§5.4；D25；§15-1、§15-8 |
| A4 | 「做skills判定與加權重」 | **§10A 改寫**：類別逐一以新聞技能為準（10 類）、程式判定方式（觸發字→AI 只答事實→程式寫 `ruleClass`；AI 原判已利空也要問）、類別權重（新聞技能 §4.1 baseWeight，先驗·未回測）、依權重分級的收緊線（強 1ATR／3%、溫和 2ATR／5%、不收緊）、每類一層疊加；§0-5、§1 新增「規則類別」「類別權重」、§3.7 `EVENT_TIERS` 取代 `EVENT_TIGHT_*`／`EVENT_CLASSES`；D22 |
| A5 | 「不算」 | §0-6、§10B：盤後報告排序與元件維持原樣；D23 |
| A6 | 「保留」 | §8.6、`wording.md` §3 #6：後半句保留原文；D24 |
| A7 | ok＝Z2 網頁判定、單一裝置·暫算，切換前維持 | 生效範圍、新增 D26 |
| B1–B5 | 其它都ok | §13.2 改為「已確認」；§5.1、§5.2、§8.4 的「若使用者要…」改為已確認 |

其他：

- frontmatter 版本改 `stop-v1.1`、description 與「生效範圍」表一致（戰情 v2 A1 已採規範前端暫算、Z2 依 A7）。
- **共用函式 v1.1 已實作**（§3.8）：`ai-stoploss.mjs` 拆成集線器＋七個子模組、新增 `news-rule-classes.mjs`；`resolveStop` 四線取高＋兩段棘輪＋多層事件收緊＋自檢；ATR 帶、保本、追蹤、係數涵蓋、ETF／興櫃歸屬、前端暫算組成線；事件收緊狀態機與影子紀錄；九處推播文字與禁用詞掃描（兩個豁免）；LLM 文字驗證；daemon 整合純函式。測試 260 例通過（含 v1 的 185 例回歸），v1 呼叫方式（戰情前端）結果不變。
- 行號基準改為 HEAD `2fd8ce6`（v1 實作已於 `ceacbcf` 進版控）。
- 新增日期欄位登記：`sourceDate`、`floorSourceDate`、`bandSourceDate`（`check-field-conventions`）。

**2026-10-05（實作同步·審查修正）**：多視角審查（規範一致性、daemon、新聞來源）後的修正與回寫：

- **LLM 提示詞（第 4 項）回到時程**：S3 影子期持股分析與個股波段的提示詞還原為 HEAD 原文（§10.1、`llm-contract.md` 時程），只用 `measureLlmStop(expectRef:false)` 量測現有輸出；提示詞片段（`stop-phase1.mjs`）留到 S5。
- **A4 新聞管線照 §10A.2 落實**：事實題由「嵌在主判別」改為主判別定案後每類另問一次（主判別提示詞逐字不變）；事實「是」⇒ label 由程式覆寫為利空、理由以 `ruleReasonPrefix` 開頭（C16a 與 2026-08-29 版逐字相同），原判已利空只補欄位；`ruleClassOf` 回到 §10A.1-C（label 必須是利空）。觸發字收窄並加 veto、事實題寫明不算的情形、「是否…」不當成「是」。
- **漏網紀錄**原因與 `ruleBearEvents` 同口徑（測試 N10b）。
- **戰情本機事件表**另記當日盤中適用的停損（`sess`），隔日結算用它（§3.6 最後一列 ③）。
- **§2A 閘門 ⑦**：ETF 結構斷點要有官方分割係數；`lineInputsOf` 對 ETF 未涵蓋斷點 fail-closed（`uncoveredBreakBars`→`exGapBars`）。§2A 來源依實測改寫（上市 ETF 讀鏡像 MI_INDEX、`type=EW` 含 ETF、興櫃只能每日快照累積；retry 補抓缺的興櫃快照並寫 `_alerts`）。
- **影子收盤結算重試**改為只重試失敗的會員、沿用同日歸檔視窗、退避 10／30／60／60 分鐘、最多 5 次，全域紀錄只寫一次（`stopSpecAudit.shadowRetry`）。
- 新增 **§15A 待使用者裁定**兩題：戰情 Z2 是否依類別權重分級；係數表硬閘門與影子期起算。

**2026-10-06（R1–R9 裁定落實）**：使用者對 R1–R9「ok 如建議」（§13.3）。

- **R1**：非法律規則類別事實「是」不再改 `newsVerdict` 的 label／bullish／信心／理由，只記規則欄位；只有 C16a 照舊覆寫（`LABEL_OVERRIDE_CLASS`）。`ruleClassOf` 改為不看 label：`ruleClass`＋`ruleFacts[ruleClass]==='yes'`，舊資料 C16a 認 `ruleOverride`／前綴（須 label 利空）；戰情 `verdictState` 規則類利空先判（不看 label）；漏網 `notBear` 改為「非利空且非規則類」。§0-5、§10.4、§10A.1／10A.2／10A.7／10A.8 改寫；測試含端到端（新聞管線判定 → 寫入端 → 停損收緊與戰情）。
- **R4**：⑧「疑似出貨警示」結尾改事實句（`wording.md` §3）。
- **R8**：ETF／興櫃日 K 由 daemon 盤前讀本機官方鏡像供給（§2A 改寫：不建 Firestore 歸檔、影子照算並分開統計、fail-closed、live 時未驗證歸檔不發 v1.1 警示）；`lineInputsOf` 加 `checkBreaks`（英文字尾 ETF 照查結構斷點）。
- **R9**：`firestore.rules` 加 `stopBooks/{uid}`（含 `shadowDays`）本人與管理員唯讀、前端不可寫（未部署）。
- **R2、R3、R6**：維持現行實作（§15A 標已裁定、§2A 回補列）；**R5、R7**：已裁定、本次不做（§10.1、§14 待辦、§15-9 期限）。
- **審查修正（2026-10-06）**：① R1 部署先後寫進 §14（web 先部署或與 daemon 重啟同窗；未部署前 daemon 被拉起＝戰情暫時看不到非法律規則類利空）；② 興櫃轉上市櫃：收盤結算見 chipArchive 當日有這檔就改走 chipArchive（原本永遠沿用興櫃舊日 K）；③ 鏡像代號的收盤補判與事件結算移到下一交易日盤前（`mirrorSettle`，原本觸及事件永遠不結算、不補判；紀律彙總補鏡像前收）；④ 戰情 `bookStopOf` 與 daemon 共用 `legacyCodeActive`，停損簿文件帶 `verifiedArchives`（§2A）。

**2026-10-07（新聞規則 N1(b)／N2／其它依建議落實）**：使用者原話「n1 b／n2 依建議／其它依建議」（§13.4）。

- **C16a 只認新進展**：事實題併問新進展、日期、逐字引用（同一題、不另開呼叫）；`ruleFacts.C16a` 新增 `'old'`（舊案·涉訟中：不改 label、不推播、不收緊）與 `'acc'`（工安事故調查，歸 C17）；引用比不上 ⇒ `'none'`。§10.4、§10A.1-E、§10A.2（C16a 列、第 8～9 步）、§10A.6。
- **延續**：`ruleTrail`／`ruleCont`（有效期 5 個交易日＝`eventHoldDays`）；`ruleBearEvents` 新增條件 F（延續不收）；daemon 推播利空清單與盤中「突發利空」不列延續；戰情 Z2 延續降二級。§10A.1-F、§10A.2-12。
- **稽核與成本**：`ruleEvidence`、當日沿用、`stopSpecAudit/{資料日}.newsRule` 計數、`newsVerdict` 單檔逼近 1MB 時壓縮證據。§10A.2-10／11／13。新日期欄位 `eventDate` 已登記 `check-field-conventions`。
- **漏網原因**新增 `legalOngoing`、`continuation`（§10A.7）；測試見 §10A.8；部署先後見 §14。
- 線上 3037（10/05–10/07）既有判別**不回寫**（待使用者裁定，§13.4）。非投資建議。

**2026-10-07（審查修正）**：三視角審查（裁定一致性、安全）指出的三項，逐項以實際函式驗證屬實後修正（`news-rule-evidence.mjs`；測試 `news-rule-evidence.test.mjs`「審查修正·…」三組、`ai-stoploss-event.test.mjs` N1c）：

- **延續起算點**（HIGH）：舊版 `withRuleTrail` 只要 `ruleFacts` 答「是」就起算 `since`，不管那筆有沒有收成事件 ⇒ 首日四角色挑戰失敗、只是 `ruleHits` 的次要類別（被 C23 蓋過的 C17）時，隔日真的收成事件反被標延續，條件 F 擋掉、Z2 只列二級，停損從頭到尾沒收緊。改為只有「被當成新事件」的主類別才起算（`ruleTrailEligible`）。§10A.1-F、§10A.2-12、§10A.6。
- **舊案否決只看 AI 挑的引用句**（MEDIUM）：AI 從舊案背景句挑一段沒有日期的子字串就能過關（3037 型的殘留路徑）。改為連引用句在原文所在的子句（`quoteClauseOf`）一起看視窗外日期與背景字樣（`clauseDateOut`／`background`，`qctx` 記子句）。§10A.2-8／10、§10A.6。
- **N2 事故字樣太寬**（MEDIUM）：單獨的「事故」「爆炸」「死傷」讓理專挪用事故、資安事故的搜索記 `'acc'`、兩邊都不算。`ACCIDENT_LINK_RE` 只留工安語境明確的字樣，較寬的字樣改由 `reconcileAccident` 在 C17 語境下才認（`ACCIDENT_CONTEXT_RE`）。§10A.2-9、§10A.6、§13.4。
- Ollama 呼叫數不變（都是程式判定）；`newsVerdict` 多一個可選欄位 `ruleEvidence[類別].qctx`（≤80 字，只在子句否決時記，瘦身時去掉）。非投資建議。

**2026-10-07（N3／N4／N5，使用者「依建議進行」）**（§13.5）：

- **N4 延續期內的新進展＝新事件**：`withRuleTrail` 比較這筆的事件日期與延續軌跡的 `eventDate`（`eventDateLater`：整段晚於才算），較晚 ⇒ 不標 `ruleCont`、軌跡換成新的 `since`／`eventDate`、`renewOf` 記舊日期；相同、更早、區間重疊、讀不到 ⇒ 延續；舊軌跡沒有日期 ⇒ 延續並補上。§10A.1-F、§10A.2-12、§10A.6。
- **停損重新起算**：`ruleBearEvents` 帶 `eventDate`；`stepEventOverlay` 在舊事件期限內遇到較晚日期 ⇒ 同類別的層換新（生效日今日、期限重算、`renewOf`），線取新舊較高者（價格已跌不提前放寬；盤中 B3 不抬到成交價之上——同日「N4 審查修正」改為比照首次事件延到收盤重算）；冷卻期不變（D22）；事件身分記憶加第 4 格事件日期（`{k,e,x,d}`）。§10A.4。
- **計數與觀察**：`stopSpecAudit/{資料日}.newsRule.renew`；daemon log「新進展（事件日 … 晚於軌跡 …）」。§10A.2-13。
- **N3** 不回寫歷史 `newsVerdict`；**N5** 讀不到日期不改判（不改程式）。不增加 Ollama 呼叫。~~web 不需重新部署（§14）~~——同日「N4 審查修正」更正：戰情 Z2 要部署 web。非投資建議。

**2026-10-07（N4 審查修正）**：審查指出兩處 N4「新事件」沒有完全照新事件處理，逐項以實際函式驗證屬實後修正（本機、未 commit、未部署）：

- **戰情 Z2 同日先延續、後換新**（HIGH；`warroom-news.mjs` `stepMajorBear`）：同日再發只看警示等級上升，延續記的等級與換新同級 ⇒ 同一適用日先以延續發過二級、盤中才出現新進展的，不再發、文案仍是「利空持續」，隔日又標延續 ⇒ 從頭到尾沒有一級。改為先前記為延續、這筆判讀較新而且不是延續（沒有 `rf`、關鍵句也不是前一適用日判過的）⇒ 照新事件再發（seq+1、`cont:false`、依類別權重）。等級上升的再發照舊。測試：`news-rule-evidence.test.mjs`「N4 端到端」補兩種前一筆（盤後趟、晨間趟）。web 端執行 ⇒ §14 改寫為要部署 web（待使用者核可）。
- **停損盤中換新不能抬線**（MEDIUM；`ai-stoploss-event.mjs`）：舊版 `renewLine` 在成交價不高於新線時沿用舊線、跳過延後，整段新期限停在舊線（只延長期限），收緊比首次事件少，與 N4「停損收緊重新起算」不一致。依 N4「視為新事件」比照首次事件延後：舊層照常生效、掛 `renewPending`，收盤班車 `settleRenewal` 以收盤價重算、取新舊較高者、次一交易日生效、期限從那天起算；`ai-stoploss-plan.mjs` 收盤班車閘門認 `renewPending`、延後二級帶成交價。§10A.4、§10A.6、§10A.8。測試：`ai-stoploss-event.test.mjs`「N4 停損重新起算」改寫盤中段、`ai-stoploss-plan.test.mjs`「N4 盤中換新而成交價已不高於新線」。
- 「舊層仍生效時取新舊較高者」（不提前放寬）沿用 N4 實作時的取捨，收盤重算也照這條。不增加 Ollama 呼叫。非投資建議。
