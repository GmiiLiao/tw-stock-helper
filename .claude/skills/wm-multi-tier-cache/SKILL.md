---
name: wm-multi-tier-cache
description: 多層快取——四層瀑布、single-flight 合流、leader/follower、fetcher 硬逾時、負快取、cache key 必含 request-varying 參數、內容感知 no-store、ETag/304、Lever Test；台股助手 singleflight/api-cache 的規範
---
# wm-multi-tier-cache｜多層快取

**上游依據**（基線 v2.10.0 · 90dc23a · 2026-09-26（第二大腦 second-brain/worldmonitor/））：`ARCHITECTURE.md` §9（Bootstrap seed→in-memory→Upstash Redis `cachedFetchJson`→upstream）、`server/_shared/redis.ts`、`server/gateway.ts`（FNV-1a ETag）、`CONCEPTS.md`（Seed-Owned Key／One-Shot Hydration／The Lever Test／Bootstrap View Key）。**適用度：深度內化**。

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

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **非同步准入後要重查 in-flight**（`server/_shared/redis.ts` `cachedFetchJsonWithMeta`：`shouldFetch` 可回 Promise，await 之後 `continue` 重查 in-flight map）：檢查與登記 leader 之間只要有一個 await，同時到達的呼叫就會各自成為 leader。台股助手 `memoize` 目前在「查 inflight」與「`inflight.set`」之間沒有 await ✓；規則：日後若在 memoize 加任何非同步前置（權限、配額、休市判斷），必須在 await 後重查 `inflight`。
- **miss／降級回應要能被辨識，且不進共享快取**（`server/gateway.ts`：日頻 macro route 的 miss 回 `unavailable:true`，gateway 排除於共享快取）：本站錯誤分支 no-store ✓，但 `latestDoc` 故障時回 200 `null`，body 與「文件不存在」相同（見 wm-data-accuracy 本週增補，是否改待使用者決定）。
- **快取壽命不得超過它所攜帶的「寬限」**（`CONCEPTS.md` Verdict Snapshot／Softening Deadline；`api/health.js` snapshotTtlSeconds 夾到最近期限）：本站 `longTtlSafe()`（交易日 08:00 後不發長 TTL）即此原則的正例 ✓。延伸：memoize 失敗時回舊值（stale-serve）後，`latestDoc` 仍以整層 TTL 發出（daily 層 s-maxage 3600＋stale-if-error 86400），且無標記——上游做法是回 200 但帶 `stale:true`／checkedAt 讓讀者知道（`api/health.js` last-known verdict）。
- **Refresh lock 只削峰不序列化**（`CONCEPTS.md` Verdict Snapshot）：搶不到鎖的呼叫短暫等待贏家，逾時就自己做，不可把「可達的儲存」當成不可達。本站 memoize follower 直接共用 leader promise（8s 硬逾時）同義 ✓。
- **帶憑證的請求一律不進共享層，憑證標頭清單只有一份並有測試釘住**（`server/gateway.ts` `CREDENTIAL_BEARING_HEADERS` #8400）：本站 09-27 掃描：讀 `Authorization`／`requireAdmin`／`verifyIdToken` 的 route 中，只有 `ai-analysis` 帶 public 層級，而它的 GET 本身不驗身分 ✓。可把「讀憑證標頭的 handler 不得發 public 層」接進 `scripts/audit-routes.mjs`。
- **compare-and-delete 腳本全站只留一份**（`shared/compare-and-delete-script.cjs`，redis.ts 與 _seed-utils 共用）：同一段並發控制邏輯複製兩份就會分岔——本站同理，手寫 `let cachedX; let cachedAt`（例：`src/app/api/twse/risk-stocks/route.ts:34`、`src/lib/scoring-server.ts:777`）疊在已 memoize 的來源上，等於第二份快取策略。

## 2026-09-28 使用者定案（G2-08／G1-05）

- **讀取故障≠尚未寫入**：`latestDoc` 與 25 支手寫 route 的故障分支改走 `unavailable(where, err)`（`src/lib/api-cache.ts`）：**503＋no-store＋`X-Data-Status: unavailable`＋console.error**，body 仍為 `null`（既有前端 `r.ok ? json : null` 與直接 `r.json()` 行為不變）。
- 文件不存在（daemon 尚未寫入）、參數不合法仍回 200 null／原樣——那是正常狀態，不是故障。
