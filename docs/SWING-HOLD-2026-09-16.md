# 📈 波段持有：5／10／20／60 日連續成長榜＋整合榜（2026-09-16）

使用者需求：把 09-16 對談中「近 N 日連續成長%數最多」的即席計算做成選股功能，每交易日更新、可回看歷史、供其他功能引用。

## 資料
- Firestore `swingHold/{dataDate}`（歷史，每交易日一份）與 `swingHold/latest`（只前進不倒退）。
- 產出時機：daemon 16:45 上櫃補跑匯流排（`computeSwingPicks` 之後）；開機補跑 `OFFICIAL_CATCHUP` 含 `swingHold`，以 `latest.dataDate === 最新歸檔日` 冪等略過。
- 單次執行：`node --env-file=.env.local scripts/ai-daemon.mjs --run swingHold`（`SWING_HOLD_FORCE=1` 強制重算）。
- 健康稽核：`CONTRACTS` 已登記（daily·publishHour 17·dateField dataDate）。

## 口徑（與 09-16 對談即席計算一致）
- 宇宙：最新歸檔有收盤、20 日均成交額 ≥ 5,000 萬（09-16：610 檔）。
- 漲幅：N 個交易日前收盤 → 最新收盤；N 日內任一天缺收盤不算。
- 連續：上漲日／N、最長連漲、目前連漲（平盤不算漲也不中斷）；期間最大回檔（自區間高點）。
- 型態：穩健＝上漲日 ≥60% 且回檔 ≤8%；劇烈＝回檔 >12%；其餘一般。
- 各窗取漲幅前 25；整合榜＝四榜聯集，分數 Σ(26−名次)，先比上榜數再比分數，取 25。

## 介面
- 選股頁新分頁「📈 波段持有」（`SwingHoldBoard.tsx`）：整合／5／10／20／60 五個子榜、即時價（共用快線）、點代號展開即時走勢、＋候選、右上角回看歷史日期。
- API：`/api/ai/swing-hold`（latest）、`?date=YYYY-MM-DD`（歷史）、`?list=1`（可用日期）。`cacheHeader('daily')`。

## 未做／誠實揭露
- 未對「連續成長」做持有期回測，勝率與期望值未知——頁面 caveats 明示，與 🌊波段起漲榜（有回測）分開。
- 減資／除權息參考價未還原（chipArchive 既有限制）。
- 首次線上 16:45 自動產出要到下一個交易日才能觀測。

非投資建議。
