# 反向糾錯掃描（資料完整性）

**這份文件的用途**：本專案的資料事故有一個共同長相 —— **程式不會壞、畫面看起來正常、錯誤安靜地累積**，而且**每一次都是使用者先發現的**。
這裡把「怎麼主動去找」寫成可重跑的流程，而不是等下一次被發現。

方法：**從症狀反推特徵，用特徵掃全站**。2026-08-29 第一次系統化執行，六族掃完，兩族有貨。

---

## 掃描族譜與指令

### A. 捏造預設值（缺資料時用**另一個不同意義的值**頂替）

最危險，因為結果看起來完全合理。

```bash
# 跨欄位頂替
grep -rnE "\b(open|high|low|prevClose|avg|cost)\s*(\|\||\?\?)\s*[a-z_]+\.(price|close)" src/ scripts/*.mjs
# 比率/分數的「中間值」
grep -rnE ":\s*0\.5\s*[;,)]|\?\?\s*0\.5" src/ scripts/*.mjs | grep -viE "opacity|width|scale|rgba|border"
# 資料欄位的字串預設值
grep -rnE "\|\|\s*'[^']{4,}'" src/lib/*.ts scripts/ai-daemon.mjs | grep -viE "className|style|color|label:|'unknown'|'—'|未提供"
```

**2026-08-29 實績**：評分引擎 `closePosition` 恆為 0.5（一組規則永遠不成立、trendScore 一律 14 分）、
處置股/注意股事由被捏造（**CLAUDE.md 記載事故的第 5、6 處漏網**，`'已被列為注意股票'` 一直還活著，
還有一句 `'交易受限，需預收款券'` 是**編造具體交易限制**）、興櫃**拿均價當開盤價**、
同一個 `: 0.5` 全站六處各自實作。

**判準**：缺資料就顯示「—」或整句略過；需要中性值時可以給，但**必須在畫面上說出來**。

### B. 資料日漂移（拿日曆今天當資料日）

```bash
# 寫入端
grep -rnE "date:\s*isoDate\((taipei\(\)|tw)\)" scripts/ai-daemon.mjs
# 最快的判準：休市日跑一次稽核，任何自稱「今天」的都是錯的
node scripts/audit-data-sources.mjs
```

**2026-08-29 實績**：8 個 daily 契約來源在週六自稱資料日 `2026-08-29`。
稽核抓不到有兩個獨立原因：① `pickDataDate` 的欄位優先序把通用的 `date` 排在專用的 `dataDate` 前面；
② 閘門只擋「太舊」，**資料日晚於最近交易日反而通過**。兩者都已修。

**判準**：`date` 可以是產生日，但**資料日一律另存 `dataDate`**（走 `currentDataDate()` / `boardDataDate()`）。

### C. 空殼文件導致整體位移一格

```bash
grep -rn "chipArchive').orderBy" scripts/ src/     # 應只有 readArchive 內部那一處
```

**2026-08-29 結果：乾淨。** daemon 33 處全走 `readArchive`；網站端兩處無法 import 它，
但都有過濾（`if (!raw) continue`、`.filter(a => a && a.closeJson)`）。

### D. 張→股 ×1000 漏掉

比值會自己相消所以看不出來，**只有顯示成絕對金額時才會少 1000 倍**。

```bash
grep -rnE "(quantity|qty|lots)\s*\*\s*[a-z]*(price|close)" src/ scripts/*.mjs | grep -v 1000
```

**2026-08-29 結果：乾淨**（29 處 ×1000 慣例一致）。

### E. 靜默 catch

```bash
grep -nE "catch \{\s*\}|catch \(\w*\) \{\s*\}" scripts/ai-daemon.mjs
```

**2026-08-29 結果：乾淨**（341 個 catch 沒有一個是空的，全都有註解或 log）。

### F. 同名不同口徑（毛/淨、含費/不含費）

```bash
for l in 未實現損益 已實現損益 報酬率 勝率; do grep -rl "$l" src/components/ src/lib/; done
```

**2026-08-29 結果：乾淨。** 之前的修法不只修好，還把口徑寫進標籤本身
——「已實現損益（**重算**）」「未實現損益（**推算持倉·扣費稅**）」。這是值得沿用的做法。

---

## 執行時的紀律

- **不要為了有產出而製造發現**。C/D/E/F 四族是乾淨的，就報乾淨，並把「查過且沒問題」寫下來
  （否則下次有人會重掃一遍）。
- **每個「疑似」都要驗證再下結論**。實例：`t.high || t.close` 看起來像 A 族，
  但追下去 `byCode` 來自有正確讀 OHLC 的 CSV，屬良性降級。
- **改型別讓 tsc 幫你做影響分析**。把 `closePosition` 改成 `number | null` 之後，
  tsc 逼出 8 個使用點——比 grep 找到的多。這是最可靠的「還有誰在用假值」偵測法。
- **修好根因後要反向再掃一次「假值餵給了誰」**。OHLC 那次，根因修完才發現個股頁的
  振幅與收盤位置一直是捏出來的。
- **順手訂正自己**。這輪我把 `newsDaily` 一起改，後來發現錯了——新聞是按**日曆日**歸檔的，
  拿交易日的尺去量它是我的判斷錯誤，已撤回並在契約旁寫明理由。
