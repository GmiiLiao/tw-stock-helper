---
name: wm-multi-tier-cache
description: 多層快取——四層瀑布、single-flight 合流、leader/follower、fetcher 硬逾時、負快取、cache key 必含 request-varying 參數、內容感知 no-store、ETag/304、Lever Test；台股助手 singleflight/api-cache 的規範
---
# wm-multi-tier-cache｜多層快取

**上游依據**（基線 v2.10.0 · 02f2115 · 2026-09-12（第二大腦 second-brain/worldmonitor/））：`ARCHITECTURE.md` §9（Bootstrap seed→in-memory→Upstash Redis `cachedFetchJson`→upstream）、`server/_shared/redis.ts`、`server/gateway.ts`（FNV-1a ETag）、`CONCEPTS.md`（Seed-Owned Key／One-Shot Hydration／The Lever Test／Bootstrap View Key）。**適用度：深度內化**。

## 原則
- 讀取順序固定；miss 合流（N 併發只打 1 次），leader 做副作用、follower 只等；fetcher 硬逾時防 in-flight map 永久毒化。
- 負快取 sentinel：錯誤的 TTL 比空結果更短；**絕不 positive-cache 降級 payload**（錯誤分支 no-store）。
- **Cache key 必含所有 request-varying 參數**，否則跨請求洩漏。
- Seed-owned key：edge 只讀不回寫，miss 用短 TTL 計算後備；purge 不會即時再生。
- **Lever Test**：egress ≈ origin-miss 數 × payload 大小；人數與請求量被 CDN 吸收——優化只有降 miss 率或降每 miss 位元組才算數。
- Bootstrap View Key：快取「顯示的」不是「來源的」（切片、投影、去掉 UI 不用的欄）。
- ETag／304、CDN-Cache-Control 雙層表。

## 台股助手規範
- `src/lib/singleflight.ts` `memoize(key, ttl, fn)`：TTL＋in-flight 合流＋失敗負快取＋8s 逾時；**禁手寫 `let cached; let cachedAt`**。
- `src/lib/api-cache.ts` 層級表：hot(s-maxage 2)／tick(3)／quote(10)／intraday(120)／daily(3600)／static(14400)／private(no-store)；每層有 stale-while-revalidate 與 stale-if-error；`latestDoc('coll','tier')` 讀 daemon latest doc。
- **GET 打穿 CDN 是本專案最貴的錯**：URL 加時間參數＝MISS、回應 no-store＝MISS、前端 `cache:'no-store'`＝仍 HIT（無害）。看 URL 穩定性與回應標頭，不看前端選項。
- 拍號快取鍵 `revealTick()`（5 秒）＝「request-varying 參數進 key」的正解；`market-snapshot-store` 熱快取 1s。
- 09-04 掃描：讀 searchParams 且 memoize 靜態 key 的 route 只有 chip-series／stock-strategy，兩者 memoize 的是 code 無關索引，乾淨。
- hot 層 646KB payload → Bootstrap View Key 思路：`marketSnapshot/hot` 20KB 已是投影。

## 修A錯B 影響面
改層級表數值前查該層所有 route（`rg "cacheHeader\('tier'"`）與資料自身更新週期（快取落後量必須 < 資料週期）。

## 掃描探針
- 反向：`rg -n "let cached|cachedAt" src/app/api src/lib`；`rg -n "\?t=\$\{Date.now" src`；正向：新 route 有 `cacheHeader`

## 2026-09-12 週更增補（上游 d902d0d→02f2115）

- **CONCEPTS 新詞條「Deployment Key Prefix」**：非正式環境的 app 自有快取鍵一律加 `<env>:<sha8>:` 前綴，preview／dev 共用同一個 Upstash 也不會讀到或覆蓋正式列；seeder 寫的是裸鍵，所以每個讀取都要明示「讀哪個族群」，`raw=true` 是唯一 opt-out。這是**寫入所有權邊界**，不是快取細節。
- 台股助手對應：本站只有一個 Firestore 專案、無 preview 部署，**目前不適用**；但 `GAPLU_DATE`／`--only` 這類「人工回補」寫入與 daemon 正式寫入共用同一批 doc，已用 forward-only guard 擋 latest 被舊資料覆蓋（09-05）。若未來出現 staging 專案，鍵前綴優先於再加 guard。
