---
name: wm-security-model
description: 多層安全模型——client-controlled headers 一律可偽造、三種憑證分級、匿名 session 不是身分、timing-safe 比較、rate-limit 政策登記與 fail-closed、CSP 三處同步、降級 marker；台股助手 requireAdmin/rateLimit/cron-auth 的規範來源
---
# wm-security-model｜安全模型

**上游依據**（基線 v2.10.0 · 90dc23a · 2026-09-26（第二大腦 second-brain/worldmonitor/））：`api/_api-key.js`（session／user／enterprise 三種 kind；Origin/Referer 不可信 #3541）、`api/_rate-limit.js`＋`server/_shared/rate-limit.ts`（sliding window、failClosed、IETF RateLimit headers、`X-RateLimit-Mode: degraded`）、`scripts/enforce-rate-limit-policies.mjs`（政策 key 必須對得上真 route）、`api/_cors.js`。**適用度：部分內化**。

## 原則
- **Origin／Referer／Sec-Fetch-Site／X-Forwarded-For 都是 client 可寫**：不可當「真瀏覽器」或身分證明；rate-limit 的 identifier 要取**受信 proxy 附加的那一跳**，不是最左邊。
- 憑證分級：匿名 session（誰都能鑄）≠ 使用者 key ≠ 營運 key；`forceKey` 路徑拒收匿名 session；只有營運 key 可繞過 entitlement。
- 秘密比較 timing-safe（hash-then-compare）。
- Rate-limit：每條敏感 route 有**登記的政策**且 lint 對照真實路徑（rename 漂移會讓限制變死碼——sanctions 案例）；LLM／checkout 這類「限流就是防線」的 route **fail-closed**（Redis 掛→503＋degraded marker），一般 route fail-open；限流器 `reason:'timeout'` 的假放行要當降級記錄。
- 降級要可觀測：marker header、Sentry level 分級（transient=warning、misconfig=error）、fingerprint 低基數。
- CSP 三個來源要 parity test；秘密外洩 tripwire（bundler-inlined env prefix）。
- 授權不可從 request body 讀 uid/email。

## 台股助手規範
- `src/lib/require-admin.ts`（verifyIdToken＋admin 名單）、`src/lib/cron-auth.ts`（CRON_SECRET）、`src/lib/rate-limit.ts`（per-instance 有界 Map；設 UPSTASH_* 即全域）；11 支 route 有 rateLimit。
- **R6（09-04 實測定案，使用者選 (a) 記錄殘餘風險）**：經 Hosting 時 client 的 XFF 被剝除、取第一跳正確；但 cloudfunctions.net／run.app／fh- 標籤 URL 皆可公開直連，GFE 把真實 IP 附在尾端 ⇒ 直連可偽造第一跳繞過限流；host 與 fastly-client-ip 在標籤 URL 直連時與經 Hosting 相同，**應用層無法分辨**；改取最後一跳會讓經 Hosting 的所有人共桶。限流是 per-instance 縱深防禦，授權由 token 把關。正解在基礎設施（封直連），排入下次基礎設施變更。詳記憶 project_tw_stock_xff_topology。
- R2 已收口（2026-09-04）：compare-agent 加 rateLimit 10/min；news-agent 零呼叫端下架；route 普查證實 6 支 mutating 全有 auth 或 rateLimit。
- 秘密：TELEGRAM_BOT_TOKEN／VAPID_PRIVATE_KEY／CRON_SECRET 只在 .env.local；GOOGLE_APPLICATION_CREDENTIALS 不進 .env.local（LaunchAgent plist 帶）；SA key 檔在 repo 外只引路徑。
- 不做 dev auth backdoor；不接受使用者密碼。

## 修A錯B 影響面
改 `clientIp` 取法會改變所有 11 支 route 的限流鍵——先在線上抓一次真實 XFF 樣本（含本機與行動網路），確認 proxy 跳數再改。

## 掃描探針
- 反向：`rg -n "x-forwarded-for" src/lib src/app/api`；`rg -L "requireAdmin|verifyIdToken|CRON_SECRET|rateLimit" $(rg -l "export async function (POST|DELETE|PUT|PATCH)" src/app/api)`（無防護的 mutating route）

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **IP 桶的前提是「IP 可證明」**（`server/_shared/rate-limit.ts`、`api/_rate-limit.js`，#8402）：帶 `cf-connecting-ip` 卻缺秘密標頭 `x-wm-edge-proof` 的請求（直連 origin 偽造或 CDN Transform Rule 漏設）一律 403＋`X-RateLimit-Mode: edge-proof`＋no-store，**不落進共用桶**；此檢查排在限流器可用性判斷**之前**，fail-open 的 Redis 故障也不能重新放行。已驗證的 principal（uid）預算不需此證明。
  - 本站對應 R6：上游的解法是第四種選項「CDN 注入秘密標頭、origin 驗證」。`firebase.json` 的 `headers` 只作用於**回應**，Hosting 能否對 rewrite 到 Cloud Run 的**請求**注入標頭 **待確認**。R6 目前決議 (a) 記錄殘餘風險——**上游已改為「無證明即拒收」；本站規則是否跟進待使用者決定**。
- **已驗證身分用身分當鍵，不用 IP**（`server/_shared/rate-limit.ts` `principalUserId`／`principalScope`、`readTrustedRateLimitPrincipal`）。本站 `rateLimit(request, name, n)` 只有 IP 鍵；規則：verifyIdToken 之後若需要限流，第二道以 `name:uid` 為鍵（不改 helper 簽名，把 uid 併進 name 即可）。
- **無法歸屬的身分＝拒絕，不共桶**（`isUnattributedSubRequestIdentity`：`unknown` 哨兵、RFC1918／link-local 前綴**逐段列舉**，刻意不用 `startsWith('172.2')`——會誤中公網 172.2.x／172.200.x）。本站 `clientIp()` 取不到 XFF 時回 `'unknown'` 讓所有人共用一桶；經 Hosting 恆有 XFF 故目前無實害。規則：任何新的限流鍵來源，`unknown`／私網段不可當正常鍵。
- **CORS 白名單改為列舉 host**（`api/_cors.js` `APP_ORIGIN_PATTERN`）：由 `*.worldmonitor.app` 萬用子網域收斂成明列的 app host，註解「sibling vendor hosts do not inherit browser trust」；translate.goog 解碼後套同一 pattern，且拒非預設 port。本站：5 支 route 回 `Access-Control-Allow-Origin: *`，本站前端同源不需要。規則：**不新增 `*`**；既有 5 支移除前先確認沒有外部消費端（second-brain、其他專案）。
- **憑證 cookie 一律 `__Host-` 前綴**（`api/_api-key.js`）：強制 Secure／無 Domain／Path=/，子網域無法種同名 cookie 遮蔽；多個候選憑證逐一驗、第一個有效者勝、全失效才回 Invalid。本站目前不發任何 cookie（`Set-Cookie`／`cookies()` 0 處）；規則：日後以 cookie 承載任何憑證一律 `__Host-`。
- **設定缺失不是授權**（`server/gateway.ts`）：entitlement 後端未設定時原本 fail-open（理由「misconfig 不該讓全站斷」），本週改為一律 503 retryable＋no-store——「Missing configuration and unresolved entitlements must remain retryable failures, not grants」。散落的 `validUntil >= Date.now()` 收斂為單一 `hasCurrentEntitlementCoverage()`。
  - 本站對應：`requireAdmin` 缺 Admin SDK → 503 ✓；`hasCronSecret` 在 `NODE_ENV!=='production'` 缺密鑰放行（僅本機，維持）。會員等級述詞 `['premium','admin','superadmin']` 在 daemon 有 10 份複本、前端 `lib/view-as`／`lib/access.ts` 另有含 14 天試用的版本——規則：**權限述詞只能有一份**，改動前先 grep 全部複本（不要修A錯B）。
- **所有驗證失敗回同一個拒絕**（`server/gateway.ts` `internalMcpSignatureDenial`）：缺 user、格式錯、時窗外、nonce 重放、HMAC 不符全部回同一個 401（單一建構函式，新失敗模式也必須走它），只有伺服器端 telemetry reason 可以不同——不給偽造探測 oracle。本站 `hasCronSecret` 單一 401 ✓。
- **本站延伸（由上游「trusted marker 只能由 gateway 設定」類推）**：**授權依據不可取自使用者可寫的儲存**。Firestore `users/{uid}` 中 rules 未鎖的欄位（目前只鎖 `level`）與 request body 同級，都是 client-controlled。管理員判斷一律用 `verifyIdToken` 解出的 `email`＋`email_verified`（或 custom claims），不得讀 user doc 的 `email`。
- 既有文字「11 支 route 有 rateLimit」已過時：2026-09-27 實數為 14 支 route、15 處呼叫（`node scripts/audit-routes.mjs --table`）。
- **既有規則衝突註記**：`src/lib/rate-limit.ts:18-19` 與 `docs/SECURITY-2026-07-31.md:99` 寫「限制器故障一律 fail-open」；上游本週把「呼叫端可控參數→cache miss→打外部供應商」的 route 全部列入 `FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED`（新增 12 條，每條附 reason）。本站限流器是記憶體版、幾乎不會「故障」，實際差異在「這類 route 有沒有掛限流」。**上游已改為供應商代理類 fail-closed；本站規則是否跟進待使用者決定**。

### 掃描探針（本週新增）
- `rg -n "data\.email|u\.email" src/lib/require-admin.ts scripts/ai-daemon.mjs`（授權讀 user doc email）
- `rg -n "Access-Control-Allow-Origin" src/app/api`（萬用 CORS）
- 外打上游且參數可控卻無 rateLimit：`node scripts/audit-routes.mjs --table` 對照 `rg -l "searchParams.get" src/app/api` ∩ 呼叫 `news-server`／外部 `fetch(` 的 route
