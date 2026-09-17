# 資料缺漏事件機制（2026-09-17）

使用者硬規定：**有交易日就不應該有缺漏；先補足（官方帶日期→第三方）再繼續，不捏造；補不到要出警示文件提醒開發者。**
記憶：`feedback_no_gaps_on_trading_days`。

## 1. 為什麼要做

08-20 chipArchive 缺上櫃 1,091 檔，沒有任何一處報錯：四檔上櫃股變成「兩日 +20%」假事件、波段持有 20／60 日榜整月沒有上櫃股、
跳空漲停 21 日窗同樣排除、漲停預測兩天沒有上櫃漲停集合。另外每個交易日 15:10 班車只跑一次、16:45 上櫃併入後不重跑 ⇒
推薦修正量／反轉訊號／洗盤監測**每天**都只有上市（09-17 實證 15:27 推薦修正量 571 檔全上市，靠 daemon 重啟才補到 952）。
共同特徵：缺的那半市場只讓榜單「變短」，使用者先發現。

## 2. 機制（`scanArchiveGaps`，16:45 班車；`--run gapScan`）

| 步驟 | 做法 |
|---|---|
| 偵測 | 每份歸檔依快照市場別數上市／上櫃檔數，低於 `GAP_MIN`（上市 900／上櫃 700）即缺漏。當日 17:00 前上櫃未併入是正常時序，不算。快照市場別本身不完整時不掃（避免誤判）。 |
| 補正 | 上櫃：TPEx 帶日期端點（回聲驗證）→ Yahoo 逐檔 `.TWO`；上市：Yahoo 逐檔 `.TW`（TWSE STOCK_DAY_ALL 實測不吃 date 參數）。每根 bar 的日期必須等於目標日才收，缺的檔就缺。 |
| 紀錄 | `dataGapEvents/{日期}`：before／after／tried／fixed／fixPlan；`dataGapEvents/latest.open`＝仍未補足的日子。 |
| 警示文件 | `second-brain/data-gaps/{日期}.md`（gitignored，本機） |
| 通知 | daemon log ⚠／✖；WebPush＋Telegram 推給管理員（`NEXT_PUBLIC_ADMIN_EMAIL` 對應的使用者；Telegram 需先綁定） |
| 稽核 | `dataGapEvents` 契約 `alertField: 'open'`：open 非空 ⇒ 狀態 ALERT，進 `system/dataHealth` |

補正方案寫在事件文件裡：已補足 ⇒ latest 類文件每日重算自癒、dated 文件不回寫；補不到 ⇒ 隔日再掃、手動 `--run gapScan`（`GAP_SCAN_DAYS`）、
再不行找第三個來源（TWSE 逐檔 `STOCK_DAY?date=&stockNo=`），不可用預設值填。

## 3. 同日修正的缺漏

- 15:10 只跑一次的三個工作（推薦修正量、反轉訊號、洗盤監測）加進 16:45 重跑（冪等）。
- 08-20 上櫃洞已補（867 檔）；最近 120 份歸檔無其他洞。
- 已定版、不回寫：08-20～09-16 的跳空漲停與漲停預測 pred／review（事前存檔不可事後污染）。

## 4. 驗證

- `GAP_DRY=1 GAP_SCAN_DAYS=40 --run gapScan`：最近 40 份皆完整。
- `GAP_DRY=1 GAP_MIN_OTC=2000`：門檻拉高後每一天都被標出（偵測邏輯有效）；只列印不寫不推。
- 正式跑一次寫 `dataGapEvents/latest`（open 為空），稽核 OK。
- **未證明**：真正缺漏發生時的補正與通知（Yahoo 後備路徑、WebPush 送達）尚未在真實事件上觸發。

非投資建議。
