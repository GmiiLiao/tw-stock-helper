# 第二大腦（Second Brain）— 本地知識庫

由本地腳本生成，供本地 AI（Ollama）快速調用，**不進版控**（內容大且會變動）。

## 結構
- `reports/{YYYY-MM-DD}.md`、`reports/latest.md` — 收盤盤勢分析（由 `scripts/sync-second-brain.mjs` 從 `/api/market-report` 同步）。
- `stocks/{code}.md` — 個股本地 AI 分析（由 `scripts/local-analyze.mjs` 用 Ollama 產生）。
- `news/{code}.json`、`news/{code}.md` — 個股+產業新聞本地快取（daemon 每 15–30 分鐘更新，供本地 AI 取用、免每次上網）。
- `news/index.json` — 新聞快取索引。
- `index.json` — 同步索引。

## 流程（本機，需 app 與 ollama 運行）
```bash
# 1) 同步盤勢報告到本地
node scripts/sync-second-brain.mjs
# 2) 用本地 Ollama 分析個股，寫入 wiki 並回推 Firestore(aiNotes)
node scripts/local-analyze.mjs --codes 2330,2317
#    或不帶 --codes：分析最新盤勢報告的精選標的
```
