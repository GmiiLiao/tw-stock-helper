# 第二大腦（Second Brain）— 本地知識庫

由本地腳本生成，供本地 AI（Ollama）快速調用，**不進版控**（內容大且會變動）。

## 結構
- `wiki/` — **台股資料 wiki**（全部個股＋ETF 的產業／產業鏈／集團／產品原料客戶廠房／新聞，Obsidian vault）。由 `scripts/build-stock-wiki.mjs` 產生，首頁 `wiki/README.md`，說明見 `docs/STOCK-WIKI.md`。
- `reports/{YYYY-MM-DD}.md`、`reports/latest.md` — 收盤盤勢分析（由 `scripts/sync-second-brain.mjs` 從 `/api/market-report` 同步）。
- `stocks/{code}.md` — 個股本地 AI 分析（由 `scripts/local-analyze.mjs` 用 Ollama 產生）。
- `news/{code}.json`、`news/{code}.md` — 個股+產業新聞本地快取（daemon 每 15–30 分鐘更新，供本地 AI 取用、免每次上網）。
- `news/index.json` — 新聞快取索引。
- `news-scores/` — **新聞識讀權重分快取**（AI 讀內文的利多/利空判別，2025-01 起；讀過不重讀，說明見其 README）。
- `index.json` — 同步索引。

## 流程（本機，需 app 與 ollama 運行）
```bash
# 1) 同步盤勢報告到本地
node scripts/sync-second-brain.mjs
# 2) 用本地 Ollama 分析個股，寫入 wiki 並回推 Firestore(aiNotes)
node scripts/local-analyze.mjs --codes 2330,2317
#    或不帶 --codes：分析最新盤勢報告的精選標的
```
