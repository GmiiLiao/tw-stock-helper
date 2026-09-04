# WorldMonitor 技術全譜分析報告（2026-09-04）

來源：`github.com/koala73/worldmonitor` **v2.10.0**，快照 commit `#7623`（2026-09-04）。
方法：淺層 clone 至 scratchpad，只讀不執行；所有數字由 `git ls-files`／grep 統計，非印象。
用途：① 回答「這裡面有哪些技術」② 作為每週檢查的**基線版本**③ 對照台股助手可借鏡點。

## 一、專案身分與規模

| 項目 | 數值 |
|---|---|
| 定位 | 即時全球情報儀表板（地緣/軍事/金融/氣候/網安/海運/航空），578+ 上游 host |
| 規模 | 6,653 檔、約 110 萬行（含 proto/generated/docs）、22 個頂層目錄、49 runtime deps |
| 活躍度 | 6,349+ commits；**9/3 單日 30 個 PR**；CHANGELOG 持續維護 |
| 開發模式 | **AI 協作驅動**：`AGENTS.md`（任務模式/授權/終端狀態分離/preflight 閘門）＋ `compound-engineering` 五個 review agents（TS/安全/效能/架構/簡化） |
| 交付面 | Web SPA、PWA、Tauri 桌面、MCP server、REST/OpenAPI、CLI（npm）、SDK（Python/Ruby/Go）、24 個 Agent Skills |

## 二、技術棧分層（全譜）

### 1. 前端
- **Vanilla TypeScript（無 UI 框架）**＋Vite；`Panel` 基類體系（**123 個 panel**，`fetchData()` 回 boolean、`_hasData` 防錯誤覆蓋好資料）
- **雙地圖引擎**：deck.gl＋MapLibre GL（2D，H3/supercluster 聚合）／globe.gl＋Three.js（3D）；PMTiles/Protomaps 底圖
- Web Workers：`ml.worker.ts`（Transformers.js/ONNX）、analysis worker；8-phase App.init、兩層 bootstrap hydration
- i18n：**20+ 語系**（i18next），locales 由 `@anthropic-ai/sdk` 翻譯管線生成；Preact 僅局部
- Bundle budgets（主/pro/embed 三套預算，CI 強制）

### 2. API／Edge 層
- **Vercel Edge Functions**；`createDomainGateway` 八步管線（origin→CORS→OPTIONS→API key→rate-limit→route match→POST→GET 相容→error boundary）
- **Sebuf proto-first RPC**：**313 個 .proto**，`buf generate` 四輸出（client/server/OpenAPI/bundle）、13-pass OpenAPI injector、`api-route-exceptions.json`（888 行 allowlist）
- Cloudflare Workers：CORS preflight、railway-reconcile-control
- Cache-Control 六級表（fast 300s／medium 600／slow 1800／static 7200／daily 86400／no-store）

### 3. 資料管線
- **Railway 上 195 個 seed 腳本**（`runSeed(domain,name,key,fetchFn)`，TTL ≥ 3× interval）；AIS WebSocket relay；macro/resilience/consumer-prices 三個 seed bundle
- `atomicPublish`（lock→validate→stage→canonical→cleanup）、`seed-meta:{fetchedAt,recordCount,sourceVersion}`
- 子專案 `consumer-prices-core`（133 檔）：**Playwright 爬蟲**＋各國物價籃＋Redis publisher

### 4. 快取（四層）
Bootstrap seed（Redis）→ per-instance in-memory → **Upstash Redis（`cachedFetchJson` 合流 stampede）**→ upstream；ETag（FNV-1a）/304；cache key 規則；seed-meta sidecar

### 5. 韌性
- `src/utils/circuit-breaker.ts`（含 e2e 共 **1,166 行**）：失敗計數→冷卻狀態機、**tri-state（live/cached/unavailable）**、persistent stale ceiling、cascade fallback groups、multi-provider failover（per-key error budget）
- `withRetry`（nonRetryable 標記、Retry-After、指數退避）、Desktop sidecar→cloud fallback

### 6. 健康監控
`api/health.js` 逐 key 讀 seed-meta 比 `maxStaleMin`；階梯 OK/STALE/WARN/EMPTY；cascade group；CI `seed-freshness-monitor` 每 15 分；「不要相信 deployment status」的 analytics-collector-monitor

### 7. 安全
三個 CSP 來源同步；`_api-key.js`（829 行，三種憑證）；`_rate-limit.js`（732 行）＋**rate-limit 政策 registry（lint 強制對照 OpenAPI）**；bot filtering middleware；HMAC 內部呼叫＋replay nonce；Clerk 認證；desktop secret storage；`SECURITY.md`；contributor-trust workflow（`pull_request_target` 安全註記）

### 8. 桌面
Tauri 2（Rust）shell＋**Node.js sidecar**（`local-api-server.mjs`）、fetch patching、NSIS 打包、desktop release train CI

### 9. 後端狀態與商業
**Convex**（billing/entitlements、API keys、broadcast/email、company monitoring、向量搜尋歷史記憶）；**Dodo Payments**；business seats

### 10. AI／ML
- LLM 供應商可切換：**Ollama／Groq／OpenRouter**（`runtime-config.ts`／`settings-manager.ts`，使用者端設定）
- 瀏覽器端 **Transformers.js＋ONNX**（`ml-config.ts`、`ml.worker.ts`）：embedding、語意聚類（Jaccard 之上的 refinement）
- RAG：`brief-embedding.mjs`、IndexedDB vector store（e2e `rag-vector-store`）
- `@anthropic-ai/sdk` 僅用於 locales 翻譯與 widget builder（非核心推論）

### 11. 資料正確性
`_pipeline-dedup.mjs`（Jaccard＋canonical URL＋三層 headline key）；**公司身分改走 SEC CIK 權威解析，明文拒絕 domain-slug 啟發式**（CHANGELOG #5695：「不猜，回空信封 `sources: []`」）；TPS open data adapters；`identity_unresolved` 覆蓋狀態

### 12. 可程式化／Agent 生態
MCP server（`api/mcp.ts`、OAuth＋HMAC grant、billing denial、`mcp-proxy` Edge、DoH 固定上游）；**24 個 Agent Skills**（`skills/*/SKILL.md` frontmatter＋`.well-known/agent-skills/index.json`＋`agent-card.json`）；`llms.txt`／`llms-full.txt`；CLI＋三語 SDK 自動發布 CI

### 13. 觀測性／SEO
Sentry（分級、`_sentry-common`）；**Umami self-hosted**（Docker＋retention）；IndexNow 提交 CI；crawlable dataset identity；web-vitals；perf-style-layout-budget CI

### 14. 品質閘門（本 repo 最值得學的部分）
- **43 條 CI workflow**：test（40K）、proto-check（24K）、deploy-gate（19K）、build-desktop（25K）、contributor-trust、stacked-merge-guard、orphaned-stacked-merge-monitor、railway deploy drift／trigger／watchdog／manual-recovery、seed-freshness-monitor、live-api-cache-auth、mcp-live-smoke、security-audit、feed-validation、e2e-visual、umami-storage-monitor…
- **pre-commit／pre-push**（`prepush-attest.sh` 19K、`prepush-admission.mjs`）：tsc×2、CJS 語法、edge bundle、import guardrail、md/mdx lint、version sync
- **11 條自製 lint**：`lint:boundaries`（模組邊界）、`lint:api-contract`（sebuf 契約）、`lint:safe-html`、`lint:panel-content-writes`、`lint:rate-limit-policies`、`lint:premium-fetch`、`lint:unicode`…
- 測試：**tests/ 1,949 檔**＋e2e 146（Playwright 視覺快照）＋convex 65＋server 24＋sidecar；vitest＋node:test；「0 assertions 即 fail」、`--require-live`

## 三、對照 2026-07-30 starmap 的 12 技能

12 個技能的實體**全部存在且持續擴張**（circuit-breaker 1,166 行、rate-limit 732、api-key 829、cors 560、dedup 592、embedding 540、route-exceptions 888）。**starmap 未涵蓋的新技術族**（本次新提煉）：

| # | 新技術族 | 證據 |
|---|---|---|
| N1 | **AI 協作工程**：AGENTS.md 任務模式／授權／終端狀態分離／`agent:preflight` 閘門／PR 視覺證據／contributor-trust | AGENTS.md 124 行、compound-engineering.local.md、agent:* scripts |
| N2 | MCP／Agent Skills 產品化（skills manifest、OAuth grant、billing denial、live smoke CI） | api/mcp*、skills/、.well-known |
| N3 | Convex 即時後端＋Dodo 計費＋entitlements | convex/ 141 檔 |
| N4 | Railway 部署自動化（drift／watchdog／reconcile／manual-recovery 四條 CI） | .github/workflows |
| N5 | 權威身分解析拒絕啟發式（SEC CIK） | CHANGELOG #5695 |
| N6 | 多語系工程（20+ locale、AI 翻譯管線、zh-tw 專用腳本） | locales/、translate-locales.mjs |
| N7 | Bundle budgets 三套＋perf layout budget CI | bundle:* scripts |
| N8 | 桌面 Tauri sidecar＋release train | src-tauri/ 69 檔 |

## 四、近週更新動態（9/3 30 PR 主題歸納）
MCP 硬化（proxy DoH 固定上游、Pro-token verdict 降級為 warning、nested schema）；健康階梯細分（China incidents vs stale grace、**finite stale-content grace**）；**cache publication race 修復**；shard budget guard；transient 上游重試（WHO／WPP／HAPI）；company `identity_unresolved` 狀態；schema crawlable identity；CI 併發隔離（IndexNow）；Redis 鎖前綴；X 平台 spend caps。

## 五、對台股助手的借鏡評估（依價值排序）

| 優先 | 借鏡 | 台股助手現況 | 動作 |
|---|---|---|---|
| ★★★ | **AGENTS.md 式「任務模式＋終端狀態分離」**：review/explain 唯讀、implement 才改；「本機驗證／PR 就緒／已部署／已觀測」是不同的宣稱 | CLAUDE.md 有大量規矩但無此結構；使用者反覆強調「不要修A錯B」正是同一訴求 | 零程式碼：把此結構寫進 CLAUDE.md 任務模式段 |
| ★★★ | **自製 lint 閘門**（rate-limit-policies／boundaries／safe-html） | 剛建 pre-commit（語法＋欄位契約） | 加「mutating route 必有 rateLimit」lint → 直接回應 R2 |
| ★★ | circuit-breaker 的 **tri-state＋stale ceiling** | F1 進行中（v1 只包 Yahoo） | F1 設計參考其狀態機 |
| ★★ | **finite stale grace**（9/3 新增） | 我們 stale-if-error 無上限 | 列 F4 延伸 |
| ★★ | 權威身分解析拒絕啟發式 | 已有「不捏造預設值」規矩（同源） | 已內化 |
| ★ | compact-health 1KB 投影 | data-health 回全量 | 低優先 |
| — | MCP 產品化／Convex／Tauri／i18n／SDK／計費 | 單人使用站 | 不適用 |

**每週檢查基線**：v2.10.0 · #7623 · 2026-09-04。下次比對 `CHANGELOG.md` Unreleased 段＋`git log --since`。
