# 反向糾錯掃描（資料完整性）

**這份文件的用途**：本專案的資料事故有一個共同長相 —— **程式不會壞、畫面看起來正常、錯誤安靜地累積**，而且**每一次都是使用者先發現的**。
這裡把「怎麼主動去找」寫成可重跑的流程，而不是等下一次被發現。

方法：**從症狀反推特徵，用特徵掃全站**。2026-08-29 第一次系統化執行，六族掃完，兩族有貨。

**事故標記**（2026-10-04·WM-SCAN G4-26 起）：每件已修的事故在所屬族下留一行 `事故：<commit> <日期> <一句話>`，
`grep -n "事故：" docs/DATA-INTEGRITY-SCAN.md` 即得全部事故索引；新 fix commit 歸族時照同格式補一行（找不到合適的族就開新族，寫特徵＋判準＋grep）。

| 事故 | 族 |
|---|---|
| 19a2c2d 即時走勢單欄位破 1MB，寫入失敗、讀端只驗日期⇒停在舊資料 | Q |
| d061734 通知去重只存記憶體，重啟後重發當日推播 | R |
| d0d5b1d 上市收盤單次抓取無逾時無重試⇒宇宙缺上櫃；連續鎖漲停天數用日曆日 | S／B |
| 74cfd6c instSameDay 比歸檔末日而非價格日⇒盤中恆標「含今日 T86」 | L |
| 507ca71 快照模式寬度前日取 arch[L-1]⇒盤中拿即時價比前天 | C |
| a916af4 讀未進版控的 scripts/data 檔⇒乾淨 checkout build 失敗 | T |

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

**2026-09-01 追加：`|| Date.now()` 是 A 族的時間版**。新聞抓取的
`at: a.at || Date.now()` 把「日期解析不到」冒充成「剛剛發布」——實測 3086/3540
的 **4 月**面額變更公告被標成 0 日前混進「2 日內」判別。旁邊的 `bodyGeneric: !a.at`
有誠實標記，但 `at` 本身在說謊，任何用 `at` 算鮮度的下游全被騙。
掃描指令：`grep -rnE "\|\|\s*Date\.now\(\)" src/ scripts/*.mjs`——逐一問：
這個 fallback 是「事件此刻發生」（合法，如 log 時戳）還是「資料缺值」（捏造）。

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

- 事故：d0d5b1d 2026-10-02 策略選股「連續鎖漲停天數」以日曆日判斷是否同一天 ⇒ 週末／假日開機也 +1；改依收盤資料日 `lockDataDate`（同 commit 的抓取重試見 S 族）。

### C. 空殼文件導致整體位移一格

```bash
grep -rn "chipArchive').orderBy" scripts/ src/     # 應只有 readArchive 內部那一處
```

**2026-08-29 結果：乾淨。** daemon 33 處全走 `readArchive`；網站端兩處無法 import 它，
但都有過濾（`if (!raw) continue`、`.filter(a => a && a.closeJson)`）。

**同形變體：快照模式的「前一日」索引沒跟著位移**——歸檔還沒有今天時，`arch[L]` 已經是前一交易日，
仍取 `arch[L-1]` 當「前日」＝拿今天的即時價比前天。
- 事故：507ca71 2026-10-03 波段起漲空頭日 gate 的市場寬度在盤中（快照模式）比到前天 ⇒ 10-01 盤中 61.7–66.8%「多頭日」、收盤 38.7%「空頭日」，⭐⭐⭐ 盤中全被壓掉；改 `scripts/lib/swing-breadth.mjs`（前日＝`arch[liveDay ? L : L-1]`）。

```bash
# 快照／歸檔兩種模式共用索引的地方：「前一日」是否隨 liveDay 位移
grep -nE "arch\[L ?- ?1\]|arch\[arch\.length ?- ?2\]" scripts/ai-daemon.mjs
```

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

**2026-08-29 補充（非空的 catch 也會出事）**：`catch` 有 log 不代表安全。
分段存檔的 `flush` 因 TDZ（`const` 宣告在使用它的迴圈之後）每次呼叫都拋錯，
catch 把它吞成一行「分段存檔失敗（續跑）」——**功能看似存在、實際從未執行**，
而它正是為了避免 40 分鐘的工作被中斷而加的。是 grep log 才發現的。

```bash
# const/let 宣告在使用它的迴圈或 callback 之後（tsc 抓不到 callback 內的 TDZ）
grep -nE "^\s+(const|let) [a-zA-Z]+ = (async )?\(" scripts/*.mjs src/**/*.ts
```

**判準**：① 失敗次數要進**最終摘要**，不能只留在 catch 裡的單行 log；
② 同型錯誤同日發生兩次（`newsAdjOf`、`flush`）⇒ 宣告順序要當成檢查項，
不能倚賴 tsc。

### F. 同名不同口徑（毛/淨、含費/不含費）

```bash
for l in 未實現損益 已實現損益 報酬率 勝率; do grep -rl "$l" src/components/ src/lib/; done
```

**2026-08-29 結果：乾淨。** 之前的修法不只修好，還把口徑寫進標籤本身
——「已實現損益（**重算**）」「未實現損益（**推算持倉·扣費稅**）」。這是值得沿用的做法。

### G. 字串處理順序寫反（解碼 vs 去標籤 / 過濾 vs 正規化）

不會拋錯、型別正確、**只有畫面上看得出來**——所以只會由使用者回報。

```bash
# 解碼與去標籤同時出現，且解碼包在外層 ⇒ 標籤會在解碼後長回來
grep -rnE "decode[A-Za-z]*\(.*replace\(/<\[\^>\]\*>/" src/ scripts/*.mjs
# 實體表是否漏了 &nbsp; 與數值實體
grep -rn "&amp;/g" src/ scripts/*.mjs | grep -v "nbsp"
```

**2026-08-29 實績**：`news-server.ts` 與 daemon 的 `unesc` 都是
「先去標籤 → 再解碼」，Google News RSS 的 description 本來就是逃脫過的，
去標籤時沒有真正的 `<` 所以毫無作用，解碼後 `<a href=…>` 整串印在畫面上。
兩處實體表也都漏了 `&nbsp;`。

**判準**：**先正規化到同一種表示法，再做過濾**。解碼→去標籤→再解一次（防雙重編碼）。

### H. 上游查詢把來源併在一起，導致優先來源被吃掉

比 G 更隱蔽：**資料是對的、程式是對的，只是想要的東西從未進入結果集**，
於是任何結果端的排序、加權、優先序都是空轉。

```bash
# 多站併成一個 OR 查詢的地方，都要單獨驗證每一站是否真的有回應
grep -rnE "site:.*(OR|join\(' OR '\))" src/ scripts/*.mjs
```

**2026-08-29 實績**：個股新聞把六站併成 `site:A OR site:B OR …`，
實測「台積電 2330」工商時報 0 則、經濟日報 0 則（全被自由財經／MoneyDJ 吃掉），
但**單獨問**各自都有 6 則。使用者要的「工商／經濟優先」若只改排序永遠做不到。

**判準**：**優先來源必須單獨查**。驗證方式是逐站單獨打一次，比對合併查詢的結果——
兩者差距就是被吃掉的量。

### I. 同一份內容佔兩個欄位（重複顯示）

不是資料錯，是**同一句話被當成兩種資訊呈現**，畫面上多一列雜訊，
還會讓使用者以為摘要提供了額外內容。

```bash
# 標題與摘要/說明成對渲染的地方，都要問「來源會不會給一樣的東西」
grep -rnE "\{[a-z]+\.(title|name)\}" src/components/ -A3 | grep -E "snippet|description|summary|subtitle"
```

**2026-08-29 實績**：個股產業新聞的 `snippet` 直接吃 Google News RSS 的
`description`，而該欄位多半就是「標題＋來源名」再印一次
（實測 6526 達發 25 則**全部**重複），畫面變成同一句話上下兩行。

**判準**：成對欄位在**資料端**就要判斷是否真的多出內容
（正規化後互相包含即視為重複），不要留給元件各自處理——
修在資料端，所有消費者一起生效。

### J. 規則只寫在提示／註解裡，沒有寫進程式

最貴的一族：規則寫得很清楚、大家都同意，**但沒有任何東西阻止它被違反**，
於是它會安靜地失效，而且通常是在某個無關的改動之後。

```bash
# 「應該只用 X」的規則，去看資料結構有沒有 X 這個欄位
grep -rn "內文\|full.text\|body" src/lib/news-sentiment.ts   # 沒有 body 欄位＝不可能讀內文
# 找「有實權卻無驗證」的槓桿：直接改分數/訊號的地方
grep -rnE "stock\.(score|signal|grade) = " src/lib/
```

**2026-08-29 實績**：規則是「新聞判別必須讀完內文」，但 `news-sentiment.ts`
的輸入型別 `NewsLite` **根本沒有內文欄位**——純標題關鍵字比對，
卻握有 ±20 分實權、還能把 `STRONG_BUY` 降成 `WATCH`。
實測線上 2454 吃滿 +20 → 100 分、2330 +18 → 100 分。
同時讀完內文的 AI 判別因為還在累積 `newsLift` 而**刻意不加權**
⇒ 最粗糙的方法拿到最大實權，紀律完全顛倒。

**放大效應**：聚合是 `sum/4` 的**累加不是平均**，餵進來的新聞越多槓桿越大。
同日修好新聞來源優先序（2330 從 11 則→25 則）等於 silently 把它加倍——
**這正是閘門必須寫在程式裡的理由**：規則不會自己抵抗無關改動。

**判準**：規則若重要到值得寫下來，就重要到值得用**型別或閘門**強制。
把合法來源做成必要欄位（此處：`verdictBasis: 'content'` 才能進 sum），
讓違反它的程式**編譯不過**，而不是靠人記得。

### K. 摘要文件混進歷史查詢（統計被重複計入）

`collection.orderBy(dateField)` 會把該 collection 裡**所有**帶那個欄位的文件撈出來，
包含 `latest` / `summary` 這類摘要文件——而它們往往是最近一筆的鏡像。
結果是最近那一天**被算兩次**：樣本數、均值、勝率全部微幅偏移，
而數字看起來完全合理，從結果**完全看不出來**。

```bash
# 找出所有對 collection 做日期排序的查詢
grep -rnE "\.collection\('[a-z]+'\)[\s\S]{0,40}\.orderBy" scripts/ src/
# 再逐一確認該 collection 有沒有非日期文件
#   node -e "...orderBy(field).limit(40).get() → 篩出 id 不符 YYYY-MM-DD 的"
```

**2026-08-30 實績**：五個 collection 掃下來，`swingCurvePicks` 與 `newsVerdict`
各有 `latest`。前者**既有程式已擋**（`doc.id === 'latest' → continue`），
後者是我當天新寫的 `computeNewsVerdictReview` 漏掉——而它正是要用來決定
新聞調分係數的統計。`chipArchive`／`intradayArchive`／`chipDaily` 乾淨。

**判準**：任何跨文件的統計查詢都要明確排除摘要文件。
寫新的歷史查詢時，先問「這個 collection 裡有沒有 latest？」

### L. 時間相關的錯誤——驗證時機造成的盲點

最難自己抓到的一族：**錯誤只有在時間過去之後才現形**，
而開發當下的驗證通常都在「資料剛產生」的那一刻做——那時衰減、過期、
承接、截斷全都還沒發生，**看起來一切正常**。

```bash
# 把時間截斷到日期再算年齡（盤後/盤前產出的東西會平白老一天）
grep -rnE "T00:00:00\+08:00'\)\.getTime\(\)" src/ scripts/
# 逐一確認：這是「年齡計算」還是「日期區間邊界」？後者用日期是對的
```

**2026-08-31 實績**：新聞判別的時效衰減把時間截斷到午夜再算天數。
判別是盤後 23:00 或盤前 07:00 **專門為當天交易日產出的**，
卻被算成「1.33 天前」，而一般新聞有效期只有 2 天
⇒ **開盤前就衰減掉三分之二**。2886 兆豐金「利多/強·信心高」、
理由有具體數字（上半年純益 213.07 億、年增 17%），調分卻只有 +2、
聚合標籤還掉成「中性」——訊號在能發揮作用之前就被自己的衰減吃光。

**我前一天所有的驗證都看不到它**：判別剛產出時權重≈1，一切正常。
是使用者隔天早上問「怎麼沒有進度」才現形。

**判準**：
- 年齡一律用**時間戳**，除非該資料本來就按日歸屬（新聞的發佈日、歸檔的資料日）
- **時間相關的行為要跨時段驗證**，不能只在產出當下看。
  同一份資料至少要在「剛產出」與「隔一個時段」各看一次
- 尚未跨時段驗證的還有：7 日承接上限、榜單的 3 日衰減、
  judgeOneStock 的 14 日視窗——**這些目前只有程式邏輯是對的，沒有實測**

**2026-09-01 追加：月界／年界是 L 族的高發時點，且上游也會翻車。**
9/1 盤前稽核抓到殖利率自報「2026-09-00」——TWSE 自己的 title 印「115/09/0」
（「日-1」顯示邏輯在月初翻車，資料日其實是 08/31）。這種 bug **每月只有
一天能觀測到**，平日怎麼測都是對的。連帶追出我方 fetchBwibbu 用服務日驗日期
的既有缺陷（每天盤前都標錯，但只在盤前跑稽核才看得到——驗證時機盲點的又一例）。
判準補充：
- 日期解析要對 **0 日／0 月／13 月**這類上游髒值有明確處置（換算或拒收，不可默吞）
- 每月首個交易日的盤前，值得把日期敏感的 probe 都掃一輪——那是全年僅 12 次的觀測窗

**2026-10-04 追加：判定「是不是同一天」要比對資料的日子，不是歸檔末日**（盤中歸檔末日恆為昨天，判斷式整個盤中恆真；收盤後才變對——只在盤中看得到）。
- 事故：74cfd6c 2026-10-03 `instSameDay` 寫成 `instDate === 歸檔末日` ⇒ 盤中恆為 true，話題榜／波段起漲榜盤中誤標「含今日 T86 → 明日買進」（自 07-27 上線即如此）；改 `scripts/lib/inst-same-day.mjs`（價格日＝`liveDay ? 今天 : 歸檔末日`）。

### M. Firestore 拒收 undefined＋同一 try 區塊連坐（2026-09-28 補入·WM-SCAN G4-12）

**特徵**：寫入 payload 裡**任何一層**出現 `undefined`（常見於 `{...obj, x: undefined}`、
`{ a: src.a }` 而 `src` 缺那個鍵、陣列元素物件缺欄位），daemon 端 admin SDK
**沒有**設 `ignoreUndefinedProperties`（前端 `src/lib/firebase.ts` 有設，兩端行為不同）⇒ `set()`/`update()` 直接丟錯。
單獨看只是一次寫入失敗；致命的是**好幾個互不相干的寫入包在同一個 try** 裡——
第一個丟錯，後面的全部被跳過，而 catch 只記一行 log，畫面上是「那一頁沒資料」，不是錯誤。
測試抓不到的原因：假 Firestore 的 `set(v){ store[id]=v }` 什麼都收 ⇒ 測試綠、線上紅。

```bash
# ① 物件鍵位置明寫 undefined（逐一看是否流進 Firestore 寫入；JSX／函式參數位置是良性）
grep -rnE ':\s*undefined\b' scripts/ src/ --include='*.mjs' --include='*.ts' | grep -v '\.test\.'
# ② 把別的物件整包展開進寫入——被展開的物件只要有一個欄位是 undefined 就中
grep -rnE '\.(set|update)\(\{ *\.\.\.' scripts/ src/ --include='*.mjs' --include='*.ts' | grep -v '\.test\.'
# ③ 哪一端的 SDK 會吞 undefined（沒列到的都是嚴格端）
grep -rn 'ignoreUndefinedProperties' scripts/ src/
# ④ 同一個 try 之後 12 行內有兩個以上寫入（啟發式只能縮範圍，命中要人工看；2026-09-28 跑出 2 處：:897、:1284）
awk '/try \{/{t=NR} t && NR-t<=12 && /\.(set|update)\(/{c[t]++} END{for(k in c) if(c[k]>1) print FILENAME":"k" 同一 try 內 "c[k]" 個寫入"}' scripts/ai-daemon.mjs
# ⑤ 測試的假 Firestore 是否照真的拒收 undefined
grep -rnE 'async set\(v\)' scripts/lib/*.test.mjs
```

**2026-09-24 實案**：`daytradeAlerts/live` 從 08:55 到收盤寫入失敗 **956 次**（`{...params, split: undefined}`），
同一個 try 裡的 AI 實驗結算與交易日誌一併被跳過 ⇒ 當沖工作台整天無資料、
當日 `daytradeJournal` 永久缺（PIT 檔，事後無法重建）。詳見 [`AI-LAB-2026-09-24.md`](AI-LAB-2026-09-24.md)「事故」節。
稽核當時也看不到：`daytradeJournal` 不在 CONTRACTS 表裡（2026-09-28 已補契約）。

**2026-09-28 追加**：把 `ai-daytrade-lab.test.mjs`／`ai-swing-lab.test.mjs` 的假 Firestore 改嚴格（照真的拒收 undefined）後，
立刻有 4 個既有測試轉紅——`settle()` 寫出 `mfeR: undefined`、`buildPool()` 寫出 `pool[].price／chg: undefined`
（上游榜單缺欄位時就會在線上重演）。**假物件寬鬆＝這一族的保護傘**。

**修法（三件缺一不可）**：
- **每個獨立寫入各自一個 try**（或 `dtStep(name, fn)` 這種逐步包裝），一步失敗不連坐其他步；連續失敗要推播，不可只記 log。
- **寫入前正規化**：可缺的欄位一律 `?? null`（null 是合法值、undefined 不是）；不要展開來源不明的物件，要逐欄挑。
- **測試的假 Firestore 要跟真的一樣嚴格**：`set`／`update` 遞迴檢查 undefined 就丟錯（見上述兩個 test 檔的 `assertNoUndefined`）。
  另外對「引擎產出的文件」加一條逐欄不含 undefined 的斷言（`daytrade-desk.test.mjs` 已有）。

**判準**：凡是「把好幾件事放進同一個 try」的地方，先問「第一件丟錯時，後面幾件該不該一起不做？」答案是否就拆開。

### N. 以時鐘代替資料完整性寫「定版記錄」＋重跑覆蓋（2026-10-02 補入）

**特徵**：「寫一次、之後拿來對答案」的記錄（事前存檔、當日名單、預測檔、到期評估）在**排程時刻**寫入，
或「第一個寫的贏」——但那一刻資料其實還沒到齊；反過來，開機重跑／盤中刷新又會**再寫一次**，把定版蓋成較晚或殘缺的版本。
兩種都不報錯：數字照樣產生、日期也對，只是代表的不是該代表的那批資料。

**實測官方資料開放時間**（daemon log 2026-09-11～10-02，輪詢解析度 10 分鐘）：上市收盤 STOCK_DAY_ALL 13:46–13:58；
上櫃收盤經回聲驗證併入歸檔（`otcPending=false`）16:07–16:49，**09-24 晚到 21:37**；上市法人 T86 16:11–16:37；資券 21:30 後。
⇒ 15:10 排程時 `chipArchive/{今天}` 只有上市。

```bash
# ① 日期文件／事前存檔的寫入點，逐一問「這一刻資料到齊了嗎？之後還有誰會再寫？」
grep -nE "\.doc\((today|date|latest\.date|targetDate|dataDate)\)\.set\(" scripts/ai-daemon.mjs
# ② 「第一個寫的贏」：先 get().exists 再 set——第一個寫的是誰？
grep -nE "\.exists\)\s*\{|!\(await [a-zA-Z]+\.get\(\)\)\.exists" scripts/ai-daemon.mjs
# ③ 只擋手動、沒擋開機重跑的防護
grep -nE "!ONESHOT" scripts/ai-daemon.mjs
# ④ 定版記錄的實際內容：預測檔／評估基準裡有沒有上櫃（用快照 market 欄分市場）
node scripts/ai-daemon.mjs --run canonicalStatus     # 最近 8 份歸檔是否兩市到齊（唯讀）
```

**2026-10-02 實案（全部由資料驗證）**：
- `limitUpForecast/pred-{日}`：6 月起 54 份只有 10 份含上櫃；**9 月起每份前 120 名都沒有任何上櫃股**（15:2x 第一個寫的贏）；
  同時畫面上的定案榜 30 檔有 13 檔上櫃——記分板一直只評上市，評的不是使用者看到的那份。
- `picksHistory/{日}.eval{5,10,20}.base`：同期基準由 15:1x「只有上市」的出場日收盤算出——記錄 547／518／575 檔，
  兩市完整應為 780／714／816 檔，與「只算上市」547／518／576 吻合；而名單約 22% 是上櫃 ⇒ 超額＝含上櫃的名單 − 只有上市的基準。
- `shortCandidates/{D-1}`：盤中每 10 分鐘以 D 日盤中資訊改寫前一日事前存檔，D 日 15:10 對答案＝偷看答案。
- 開機重跑：15:53 重啟遇上游中斷，宇宙缺上櫃 11 分鐘，開機輪把做空候選（通過 52→24 檔）連同事前存檔一起蓋掉；
  `picksHistory/{今天}` 每次執行都 merge 覆蓋。

**修法**（`scripts/lib/canonical-gate.mjs`＋daemon「資料到齊班車」）：
- 定版條件看**資料**不看時鐘：`chipArchive/{日}` 上市＋上櫃收盤、上市＋上櫃法人都在（`otcPending=false`；日期由寫入端回聲驗證），且宇宙兩市都在。
- 16:45 起每 10 分鐘檢查，到齊才重算依賴收盤的榜單並寫定版記錄；21:45 仍缺記 `system/canonicalGate` 警示。
- 定版記錄寫一次（`canonicalAt`），開機／盤中／排程重跑只更新 latest；修補用 `--run X --force`（仍須到齊、且在下一個交易日 08:30 前）。
- **失敗不可被定版、也不可當成完成**：上游 API 無資料（推薦 API 回空、處置名單／當沖資格缺）時不定版；
  每個定版步驟成功（或早已定版）才記入，班車只在全部完成時標記 `otcFix`，未完成者每 10 分鐘只重試它。
- 到期評估：持有天數以收盤歸檔的交易日計、出場價取「確切出場日」兩市收盤（判定與取價用同一份文件），
  漏評者在出場日後 5 個交易日內補評。日期存檔（產業現貨、逐日籌碼庫）不可被較薄的一輪覆蓋；
  盤前晨報日期檔開盤前可更新、開盤後不覆蓋。
- 開機首次載入宇宙殘缺時，宇宙恢復後（避開保護窗）重跑一次開機輪，讓 latest 自行修復。

**判準**：寫任何「之後要拿來對答案」的記錄前問三件事——① 這一刻**資料**到齊了嗎（用資料判斷，不用時刻）？
② 之後還有誰會再寫它（開機、盤中迴圈、補跑）？③ 寫入時間是否早於它要預測的那個交易日開盤？

**跨午夜補跑的前提（2026-10-03 掃描）**——班車目前刻意只跑到午夜。要讓它午夜後補跑，下列「日曆今天」用法要先改看資料日：
- ✅ 已修：波段起漲／話題×5日線／持股 RSI 高檔警示的 `liveDay` 改走 `boardLiveBar`（交易日∧≥09:00∧歸檔無今天）。
  舊版平日 00:00–09:00 也接快照偽 K ⇒ 波段起漲榜開盤前被清成 0（log 2026-09 起 36 夜有 33 夜），
  10-02 01:25 兩位會員的 10-01 AI 決策就是用清空的榜（池 18 檔、少了 8084 ⭐⭐⭐／8472 ⭐⭐，凍結記錄未改）。
  AI 波段選股另拒收 `swingPicks.priceBasis='snapshot'`。
- 未改：`archiveChipDaily` 以日曆今天決定 T86／資券等端點的日期參數；`computeRecommendAdj`／`computeReversalSignals`
  在非交易日直接 return（輸出已標資料日 `D.date`、不會寫錯，只是不補跑；反轉訊號會推播，補跑前要先有以資料日為鍵的去重）；
  `checkRsiHot` 的去重範圍是日曆日；班車本身的 `_canonDone`／`markJobDone('otcFix', today)` 以日曆日為鍵；
  `swingPicks`／`topicPicks` 的 `date` 是產生日（日曆）——依 2026-10-03 規定「非交易日的資料以最後一個交易日為記錄時間」，改前先掃消費端。

```bash
# 「交易日 ∧ 歸檔末日 ≠ 日曆今天」這種沒看時刻的偽 K 判定（應為 0 筆；要接偽 K 走 boardLiveBar）
grep -nE "isTradingDay\(tw\) && arch\[arch\.length - 1\]\.date !==" scripts/ai-daemon.mjs
```

### O. 官方彙總表分成多張子表，只抓到其中一張（2026-10-04 補入）

**特徵**：同一份官方報表依身分拆成幾個檔（本國／外國、上市／上櫃），程式只抓了其中一張；筆數看起來很完整（1,800+），
稽核的 minN 全綠，缺的是**某一類公司整批**。共同點：網址只差一個尾碼、欄位完全相同，所以「解析成功」不代表「抓齊了」。

**2026-10-04 實案**：MOPS 月營收彙總表 `t21sc03_{民國年}_{月}_0.html` 只有**本國**公司，外國公司（-KY／DR）在 `_1.html`。
`backfill-mops-revenue.mjs` 只抓 `_0` ⇒ `revenueArchive` 每月缺上市 KY 78~93 檔、上櫃 KY 27~30 檔（研究測試期 73 檔 KY 月營收 100% 缺值，
被 centeredRank 當中性 0）；同時站上排行在同月改走 openapi（`archId > apiId`），而 openapi `t187ap05_L＋_P` 沒有上櫃、還混入 `_P` 的 273 家未上市公司。
**修法**：`scripts/lib/mops-revenue.mjs` 的 `T21_PAGES`（上市／上櫃 × `_0`／`_1`）＋每頁回音（標題的市場年月＋表尾「全部國內／國外…公司合計」）；
歸檔帶 `bySrc`（上市／上櫃／上市KY／上櫃KY／留存）與 `kyN`；稽核 `PERIODIC_ARCHIVES.revenueArchive.composition` 對每份 v2 月份要求上市 KY ≥60、上櫃 KY ≥20；
排行同月以歸檔為準（`>=`）。舊月份由 `scripts/backfill-revenue-from-mirror.mjs` 從第二大腦鏡像零網路補。

```bash
# 官方來源網址裡寫死的子表尾碼（_0、type=、selectType=、TYPEK=）：逐一問「同一張報表還有哪幾個尾碼？」
grep -nE "_0\.html|selectType=|TYPEK=|type=ALL" scripts/*.mjs scripts/lib/*.mjs src/lib/*.ts | grep -v test
# 依市場／身分分組的歸檔，寫入端有沒有帶組成（bySrc／market）讓稽核能分組計數
grep -nE "collection\('(revenueArchive|chipArchive|tdccArchive)'\)\.doc\([^)]*\)\.(set|update|create)\(" scripts/*.mjs
```

### P. 以筆數門檻當「已完整」而永久凍結（晚到的資料永遠補不進來，2026-10-04 補入）

**特徵**：回補器用「既有 ≥N 筆就跳過」防重抓；門檻是當時量到的「一個完整月的筆數」。但申報期後才上表的資料（晚申報、更正）
讓真正完整的筆數比門檻多，第一次寫入時只要已過門檻，這個月就**永遠不再抓**。不報錯、筆數也正常，只是少了晚到的那幾檔。

**2026-10-04 實案**：`backfill-mops-revenue.mjs` 的 `prevN >= 1700` 凍結：2026-07 在 08-10 20:14 寫入、2026-08 在 09-11 15:14 寫入，
當時金控／保險（2880~2892、5880、2816、2832、2850~2852、2905 等）還沒上表 ⇒ 晚申報者 2026-07 漏 16 檔上市＋1 檔上櫃（2073）、
2026-08 漏 15 檔上市，之後永不補（鏡像 10-04 版對照；另有數檔是下面「依現行名冊重產」的新上市櫃代號，不是晚申報）。
同一個凍結也讓「事後補 KY」無從進行。**修法**：略過條件改為「v2 且依資料定版」（`shouldSkipMonth`）；定版（`isMonthFinal`）三條件皆成立：
① 4 頁皆成功；② **名冊完整**——上月文件的代號（扣掉上月自己的 `retained`）在本月 4 頁名冊（`t21Codes`，含營收 ≤0 的列）缺 ≤5 檔，
缺檔寫進文件 `missingVsPrev`；③ 次月 11 日（含）起相隔 ≥3 個日曆日的兩次觀測合併筆數沒有增加（`revenueFinal`＋`fetchLog`）。
觀測時刻用頁面自報的「出表日期」（`gen`），不是抓取時鐘：MOPS 回快取頁（實測抓到時已舊 3 天以上），同一份頁抓兩次不算兩次觀測。
（審查補強：只看「筆數 3 天沒增加」擋不住「11 日後隔幾天才整批上表」的金融業；②是資料面的完整性證明，下市 8 週 3 檔、晚申報一批 15~17 檔。）
合併依代號聯集、永不變薄；已有申報期後觀測的月份只補缺（`hasSettledObservation`）——事後更正值不回寫歷史（研究以次月 11 日可得使用，回寫＝前視；
審查實測歸檔與鏡像現行頁同代號 52 列金額不同）。
鏡像（`official-mirror` 的 `mops_t21sc03{,_ky}`）同樣把「次月 11 日的隔天」時鐘定版改為資料定版（去掉「出表日期」後雜湊相同、出表日期相隔 ≥3 日、
名冊較上一期同鍵缺 ≤3）；2026-09 之前用舊規則回補的頁維持定版（`legacyTrustBefore`）、不重抓不降級——歷史頁依現行名冊重產、
內容永遠會小變，重新取得定版資格會卡在 final:false，研究端 `revenue_official.py` 會把它當缺頁中止。

**附帶發現（判讀要知道）**：MOPS 的歷史月份頁是**依現行名冊重新產生**的——2026-08~09 才上市櫃的 2237、7812、7855、2938、7825、7856
會出現在 2023~2026 年各月的頁面上（上市櫃前的營收），已下市的 2867、5371、8183 則從舊頁消失。歸檔是「各次抓取的聯集」，所以兩者都在；
`bySrc.留存` 就是「歸檔有、這次頁面沒有」的檔數。研究端以代號對面板，上市前沒有價量，影響限於「當時上市家數」這類統計。

```bash
# 「≥N 就跳過／已完整」的筆數門檻：逐一問「完整的定義是資料說的，還是當時量到的數字？之後還會不會再長？」
grep -nE "(prevN|exist\w*|\.n) >= ?[0-9]{3,}|>= ?[0-9]{3,}\) \{ ?skip" scripts/*.mjs
# 歸檔文件有沒有「定版」依據（final＋觀測紀錄），還是只有筆數；月營收的組成與定版看稽核的 [週期歸檔] 行
node scripts/audit-data-sources.mjs --no-external | grep -E "週期歸檔"
# v2 但 final:false 的月份：daemon 只管最近 2 個月（未定版就每輪 4 頁×2 月）；更舊月份的 final 沒有消費端，不必為了定版重抓。
#   要看某月為何未定版：文件的 missingVsPrev（名冊缺檔）與 fetchLog（觀測時刻 gen／筆數 n）
```

### Q. 隨規模長大的單一文件撞 Firestore 1MB 上限，寫入失敗而讀端只驗日期（2026-10-04 補入·G4-26）

**特徵**：把「所有被追蹤個股」之類會隨使用量長大的東西塞進單一欄位／文件；平常量小沒事，某天下午超過 1,048,487 bytes 寫入開始失敗，
讀取端只檢查「日期是今天」⇒ 畫面安靜地停在失敗前那一份，沒有任何告警。

- 事故：19a2c2d 2026-10-02 `marketIntraday/latest.seriesJson` 破 1MB：09-15 13:03 起失敗 305 次、10-02 12:31 起 257 次，即時走勢停住；改 gzip＋超過 900KB 用多個壓縮分片（`scripts/lib/intraday-codec.mjs`），讀端盤中 3 分鐘未更新視同停擺。

```bash
# 會隨追蹤檔數／天數長大的 JSON 欄位：逐一估「最大的一天」有多大
grep -nE "Json: JSON\.stringify\(" scripts/ai-daemon.mjs | head -50
# 寫入失敗的日誌有沒有被截斷到看不出原因（舊版截 80 字）
grep -nE "e\.message\|\|''\)\.slice\(0, ?(40|60|80)\)" scripts/ai-daemon.mjs | head
```

**判準**：會長大的文件先估上限（大文件壓縮＋分片，不要拆成每檔一份）；讀取端除了日期還要看「多久沒更新」。

### R. 只存在程序記憶體的狀態被重啟清空（重啟失憶，2026-10-04 補入·G4-26）

**特徵**：「今天已做過／已推過／上一份好資料」只放在 daemon 記憶體（`new Set()`、`let _xDay`、stale-if-error 快取）。
launchd 會拉起、其他工作階段會重啟 ⇒ 重啟後重做一次（重複推播）、或失去後備（退回殘缺）。同一族的前例：
`_lastLive` 失憶（07-17、08-12，CLAUDE.md「以為重啟 daemon 沒有副作用」）、10-03 上櫃 stale-if-error 快取蒸發。

- 事故：d061734 2026-10-02 通知去重只存記憶體 Set，一天被重啟三次就重發三次當日 Web Push／Telegram；改 `scripts/lib/alert-dedup.mjs`（Firestore `alertDedup/{種類}_{scope}`），每日時段成功才寫 `system/daemonJobMarks`。

```bash
# 記憶體去重／每日旗標（應走 alertDedup 或 daemonJobMarks）
grep -nE "const _\w+(Alerted|Sent|Pushed) = new Set\(\)|let _\w+Day = " scripts/ai-daemon.mjs
```

### S. 單次抓取無逾時無重試，多來源合併時一邊失敗就整批殘缺（2026-10-04 補入·G4-26）

**特徵**：同一時刻幾個上游一起抖一下（重啟當下、上游慢），只試一次又沒有逾時的抓取一失敗，後備又依賴它（例：上櫃後備要上市回的日期），
結果是「宇宙缺一整個市場」；與 CLAUDE.md「抓取失敗時仍把殘缺的宇宙寫進快取」（2026-08-19）是同一條鏈的上游端。

- 事故：d0d5b1d 2026-10-02 15:53 重啟時上市 STOCK_DAY_ALL、上櫃鏡像、上櫃帶日期端點同時 terminated，各只試一次 ⇒ 宇宙缺上櫃 11 分鐘；改 `scripts/lib/fetch-retry.mjs`（withRetry／failStreak），上市失敗時上櫃後備改用最近歸檔日，連續失敗推播管理員。

```bash
# 沒有 AbortSignal.timeout 的 fetch（daemon 內每一處都要有逾時）
grep -nE "await fetch\([^)]*\)\s*;?$" scripts/ai-daemon.mjs | grep -v "signal" | head
```

### T. 只在這個工作樹成立：依賴未進版控的檔（2026-10-04 補入·G4-26）

**特徵**：程式讀 gitignored／未追蹤的檔（`scripts/data/*.json`、本機快取），主 checkout 有那個檔所以一切正常；
乾淨 checkout、CI、另一個 worktree 才現形。同族的閘門版：pre-commit 掃工作樹而非 staged 快照（G3-30，2026-10-04 改為只掃 staged）。

- 事故：a916af4 2026-10-03 `attention-risk.mjs` 用 `new URL('../data/attention-calibration.json', import.meta.url)` 讀未進版控的校準檔，webpack 當成要打包的資源 ⇒ 乾淨 checkout 的 `npm run build` 失敗；改用路徑組合讀檔（缺檔回 null）。

```bash
# 以 new URL(…, import.meta.url) 指向 data／快取檔（會被 bundler 當資源）
grep -rnE "new URL\(['\"]\.\./data/" scripts/lib src
# 驗證法：git archive HEAD 匯出乾淨副本再跑 build／測試（WM-SCAN 10-04 G3 的方法）
```

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
