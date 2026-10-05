# 分析師團隊系統：模組契約（所有實作者共同遵守）

規格來源：本目錄 01–04 草案；使用者裁定（2026-10-05）：主引擎雲端 Claude；個股名單叫「資料觀察名單」、研究期**僅管理員可見**（分析文字公開）；兩階段出刊（evening 23:20 盤後版＋morning 06:10 晨間定版）；完整流程＋乾跑。
**不碰**：ai-daemon.mjs、sectorWind/*、canonical-gate.mjs、chipArchive 寫入、既有推薦榜。**欄位命名**：任何 key 不得符合 `/score|signal|buy|sell|rank|target|stop|entry|exit|action|rating|recommend/i`；不得發明以 `At`／`Date` 結尾的新鍵名（只允許 `dataDate`、`generatedAt`、`canonicalAt`、`updatedAt`；其餘日期鍵用 `Day`／`asOf`／`baseDay`）。全部 JSON 鍵序固定、輸出確定性（時間戳只放 manifest／meta）。

## 1. 目錄與模組
```
scripts/lib/analyst-desk/
  pack.mjs        buildPack(opts)            資料包＋候選池＋adverse（W1）
  pack-sources.mjs 各來源讀取器（本機檔＋Firestore 讀取，皆可注入假資料測試）（W1）
  slots.mjs       renderSlots/extractSlots/fmt  槽位語法（W2）
  check.mjs       checkIssue(issue, pack, opts)  機械查核 R01–R25（W2）
  words.mjs       禁用詞／預測句型／白名單（W2）
  constants.mjs   DISCLAIMER／DISCLAIMER_SHORT／封閉清單（W2，單一來源）
  engine.mjs      callModel(opts)            引擎轉接：claude-cli｜claude-api｜ollama｜files｜template（W3）
  prompts.mjs     各角色提示詞（W3）
  desk.mjs        runDesk(opts)              R1–R4 流程編排（W3）
  archive.mjs     writeIssue()／manifest／latest（寫一次、.lock、.r/.amend、gz）（W5）
scripts/analyst-desk.mjs          CLI（--date --edition evening|morning --engine --dry-run --force）（W3）
scripts/analyst-desk-run.mjs      LaunchAgent 入口（輪詢＋資料到齊閘門）（W5）
scripts/publish-daily-analyst.mjs 發佈 Firestore（W5）
scripts/install-daily-analyst-schedule.sh（W5）
scripts/verify-daily-analyst.mjs  事後對答案（只寫 _review）（W5）
src/app/api/twse/daily-analyst/route.ts            公開（無個股名單）（W4）
src/app/api/admin/daily-analyst-focus/route.ts     管理員（含個股名單）（W4）
src/components/AfterMarket/AnalystDesk.tsx         頁面（W4）
second-brain/daily-analyst/{D}[.evening|.morning].json.gz 等（W5；見 §6）
```

## 2. Pack 格式（pack.mjs 輸出；JSON，鍵序固定）
```jsonc
{
  "schema": 1, "kind": "analystPack",
  "dataDate": "2026-10-02",                        // D：最後交易日（與 dailyHeatmap 同源）
  "dates": { "prev": "2026-10-01", "data": "2026-10-02", "next": "2026-10-05" },  // next＝下一交易日（查 tradingCalendar，非日曆減一）
  "edition": "evening|morning",
  "refs": { "<id>": { "v": <number|string|boolean|null>, "unit": "%|pp|點|億|張|檔|文字|…", "fmt": "sg2|int|pts1|bn1|pct0|date|txt", "asOf": "YYYY-MM-DD", "tier": "官方|官方衍生|媒體|站內整理|AI待驗|傳聞|先驗·未驗證", "source": "短字串（資料來源）", "label": "人讀名稱（選填）" } },
  "pools": { "prev": [ { "code":"", "name":"", "market":"上市|上櫃", "industry":"", "from":["board.gainers","idx.contributor"] } ], "data": [..], "next": [..] },   // 每池 ≤30 檔，已套排除
  "excluded": { "prev": [ {"code":"","reason":"處置|注意|新上市|全額交割|鎖死漲停|成交值不足|旗標不可驗證|…"} ], "data": [..], "next": [..] },
  "adverse": { "<code>": ["<refId>", ...] },        // 每檔的反向／風險 refs（M 利空、O 規則方向「−」、法人連賣、priced:是、除權息日…）
  "absent": ["<來源名>", ...],                       // 缺的輸入（寫「來源未提供」，不得推測）
  "degraded": ["global:overnight-not-updated", ...],
  "calendar": { "tradingDays": ["..."], "nextTradingDay": "2026-10-05", "holidaysAhead": ["2026-10-09","2026-10-10"] },
  "meta": { "refCount": 0, "bytes": 0, "inputs": { "<來源>": { "dataDate":"", "echo":"", "sha256":"" } } }
}
```
**ref id 文法** `^[a-z]{1,3}(\.[A-Za-z0-9^=_\-一-龥]+){1,4}$`。命名空間：`m.*` 市場；`ix.*` 指數與權值股貢獻；`br.*` 廣度；`ind.{產業}.*` 官方產業別；`st.{code}.*` 候選個股事實（ret、valM、close、flags、industry、market）；`nv.{code}.*` 媒體判別（M；label/eventType/certainty/priced/strength/reason，**不含新聞內文**）；`mo.{code}.{type}.*` 官方公告（O；subject、type、dir 規則方向）；`gl.{sym}.*` 全球；`fx.*`／`adr.*`；`cal.*` 行事曆；`wk.{code}.*` wiki（強制 tier：AI待驗|站內整理|官方衍生）；`prev.*`／`diff.*` D−1 值與**程式預算差值**；`ch.*` 籌碼。
**M（nv.*）與 O（mo.*）兩個子樹分開；pack 不提供任何兩者合計欄位。** 熱力 `watch`／`layers` 進 pack 時 `tier:'先驗·未驗證'`。

## 3. Issue 格式（check.mjs 的輸入、archive 的內容、頁面的資料）
```jsonc
{
  "schema": 1, "kind": "dailyAnalyst", "dataDate": "2026-10-02", "edition": "evening|morning",
  "dates": { "prev": "...", "data": "...", "next": "..." },
  "useRules": { "usedForScoring": false, "nature": "...", "forbidden": [...], "disclaimer": "<DISCLAIMER 全文>", "disclaimerShort": "<短版>" },   // 常數由 constants.mjs 寫入，LLM 不可改
  "summary": { "headline": "", "points": [Claim], "nextFocus": [Claim], "risks": [Claim], "byline": { "editor": "總編輯", "contributors": ["momentum","industry","global"] } },
  "cards": [ { "id": "prev|data|next", "title": "（程式產生，含 M/D）", "asOf": { "day": "YYYY-MM-DD", "label": "前交易日 10/01" },
      "sections": [ { "id": "overview|momentum|diff|outlook|linkage|news|industry|global", "title": "", "analyst": "momentum|industry|global|editor", "claims": [Claim] } ],
      "focus": { "kind": "recap|watch", "poolRule": "pool-v1", "poolSize": 0, "excludedCount": 0, "stocks": [FocusStock] } } ],   // stocks 5–10 檔；不足＝少列並於 note 寫原因
  "linkages": [ { "id":"l1", "from":{"ref":""}, "to":{"ref":""}, "mechanism":"同業連動|供應鏈|匯率|利率|商品價格|政策法規|資金流向", "tier":"站內整理", "text":"", "refs":[], "authors":["global","industry"] } ],
  "refTable": { "<被引用的 refId>": { "v":..., "unit":"", "fmt":"", "asOf":"", "tier":"", "source":"", "label":"" } },   // 只含 issue 引用到的 refs，供前端證據晶片
  "meta": { "engineTier": "claude|ollama|template", "analysts": [ {"id":"momentum","engine":"","model":"","rounds":2} ], "editor": {...}, "check": { "pass": true, "rules": {"R01":"pass"}, "blockers": 0, "redactions": [], "warnings": [], "repairRounds": 0 }, "degraded": [], "fallback": null, "pack": { "sha256": "", "refCount": 0, "absent": [] } }
}
```
**Claim**：`{ "id":"c1", "raw":"含槽位的原文：上市等權平均 {{m.ew|sg2}}%", "text":"程式渲染後的文字（槽位已填值）", "refs":["m.ew"], "kind":"fact|comparison|linkage|conditional|caveat", "tier":"（由 refs 最低等級自動推出）", "direction":"偏強|偏弱|持平|拉抬|拖累|利多|利空|需讀內文|無", "authors":["momentum"], "cond": { "if": {"ref":"","op":"<=|>=|<|>|==","value":0}, "watch":"" } }`。一句一檢、≤90 字。
**FocusStock**：`{ code, name, market, industry, cardId, kind:"recap|watch", thesis, evidence:[{ref,role}], watchConditions:[{text,refs}], risks:[{text,refs}], adverse:[refId], sponsors:["momentum"], asOf:{day, closeRef} }`。
**LLM 輸出裡數字必須用槽位 `{{ref|fmt}}`**；引用但不填值用 `[ref:id]`。claim.refs 為兩者聯集。

## 4. 槽位與查核（W2）
- `extractSlots(raw) → [{ref, fmt}]`；`renderSlots(raw, pack) → {text, missing:[ref]}`；fmt 封閉：`sg2 int pts1 bn1 pct0 date txt`（sg2＝帶號兩位小數；bn1＝億元一位；pct0＝百分比整數）。
- `checkIssue(issue, pack, opts) → { pass, blockers:[{rule,claimId,msg}], redactions:[{rule,claimId|code,msg}], warnings:[], rules:{R01..R25:"pass|fail|skip"} }`，純函式、無 IO。Block＝擋稿退回；Redact＝程式刪除該 claim／該檔（不重打 LLM）；規則詳見 04 §3.2（R01–R25），數字授權 R03 以「文字中所有數值字面量必須來自槽位或白名單」實作。
- `applyRedactions(issue, redactions) → issue'`（W2 提供）。
- constants.mjs 匯出 `DISCLAIMER`、`DISCLAIMER_SHORT`（04 §4.4 全文）、封閉清單（kind/tier/direction/mechanism）、`POOL_RULE='pool-v1'`。

## 5. 流程與引擎（W3）
R0 pack（程式）→ R1 三位分析師獨立撰稿（各看自己的 pack 子樹）→ R2 交叉審閱＋連動（共同署名 linkages）→ R3 總編輯整合（單呼叫，產出完整 issue 草稿；不得新增 pack 以外事實）→ R4 機械查核＋LLM 紅隊（獨立提示詞）；blocker 退回總編輯修（≤2 輪），redaction 由程式刪；仍不過＝降級（engineTier 下一層；最後 template＝narrative.mjs 模板版，meta.fallback='template'）。
`callModel({engine, role, system, user, round?, json?, timeoutMs?, model?, filesDir?}) → {text, json|null, model, usage}`（scripts/lib/analyst-desk/engine.mjs，已實作）；engine：`claude-cli`（無頭 `claude -p`，用使用者已登入帳號，`--tools "" --setting-sources ""`，單次約 150 tokens 起跳；401 → `EngineAuthError`）｜`ollama`（呼叫前 `ollamaFree()` 檢查 `.signals/llm.json`）｜`files`（讀 `{filesDir}/{role}[.{round}].json`，開發／乾跑／人工補稿）｜`template`（不呼叫模型）。**不使用 API 金鑰**（使用者 2026-10-05 重新登入後 claude -p 已通；api.anthropic.com 不登記）。
流程編排在 `desk.mjs`：`runDesk()`／`produceIssue()`（降級階梯 claude-cli → ollama → 模板殼 meta.fallback='template'，cards=[]）；CLI `scripts/analyst-desk.mjs`（乾跑只寫 `--out`）。issue 內個股另帶 `thesisRaw`、`watchConditions[].raw`、`risks[].raw`、`summary.headlineRaw`、`linkages[].raw`（含槽位原文，供 check 與稽核）。

## 6. 存檔（W5）
`second-brain/daily-analyst/`：`{D}.{edition}.json.gz`（issue）、`{D}.{edition}.pack.json.gz`、`{D}.{edition}.transcript.jsonl.gz`、`reports/{D}.{edition}.md`、`_manifest.json`（rows[`{D}.{edition}`]：status/file/sha256/bytes/canonicalAt/engineTier/packSha256/check/degraded）、`latest.json`（指向最新定版 {dataDate, edition, canonicalAt}）、`_pending/`、`_alerts/`、`_review/`。寫一次（atomic tmp+rename、`.lock` wx）；morning 定版時 evening 版保留；`--force` 舊檔改名 `.r{n}`；非交易日不產檔。
Firestore：`dailyAnalyst/latest`＋`dailyAnalyst/{D}`（**不含 focus.stocks**，其中 `cards[].focus` 只留 `kind/poolRule/poolSize/excludedCount/count`）；`dailyAnalystFocus/latest`＋`/{D}`（含 focus.stocks 與對應 refTable，**只由管理員 API 讀**）。900KB 守門。

## 7. API 與頁面（W4）
- `GET /api/twse/daily-analyst`：`latestDoc('dailyAnalyst','daily')`（公開）。
- `GET /api/admin/daily-analyst-focus`：`requireAdmin`，`private` 快取，讀 `dailyAnalystFocus/latest`。
- `AnalystDesk.tsx`：總結卡置頂；三張可收合卡（昨日股市｜今日盤後｜明日預期，標題字面＋M/D）；每卡：分析師分段 claims（證據晶片：官方／媒體／AI待驗／傳聞等標記，點開看 refTable 值與資料日）＋「資料觀察名單」區（**僅管理員顯示**，沿用 StockCell／PriceCell；非管理員顯示「資料觀察名單研究期僅管理員可見」）＋每卡底部短版免責（程式常數）；頁首免責長版可收合、引擎／查核／降級標示；失敗時退回現有模板版 `AnalysisReport.tsx`（保留）。位置：「📝 分析報告」分頁，改為盤後報告的**預設第一個子分頁**。
