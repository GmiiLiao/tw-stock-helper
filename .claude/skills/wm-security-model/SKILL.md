---
name: wm-security-model
description: 多層安全模型——client-controlled headers 一律可偽造、三種憑證分級、匿名 session 不是身分、timing-safe 比較、rate-limit 政策登記與 fail-closed、CSP 三處同步、降級 marker；台股助手 requireAdmin/rateLimit/cron-auth 的規範來源
---
# wm-security-model｜安全模型

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`api/_api-key.js`（session／user／enterprise 三種 kind；Origin/Referer 不可信 #3541）、`api/_rate-limit.js`＋`server/_shared/rate-limit.ts`（sliding window、failClosed、IETF RateLimit headers、`X-RateLimit-Mode: degraded`）、`scripts/enforce-rate-limit-policies.mjs`（政策 key 必須對得上真 route）、`api/_cors.js`。**適用度：部分內化**。

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
- **反向發現（09-04）**：`rate-limit.ts clientIp()` 取 XFF **第一跳**（`split(',')[0]`）——第一跳是 client 可預置的；正確是取 Firebase Hosting/Cloud Run 附加的那一跳（需線上實測 XFF 形狀後改，屬 L 族觀測）。
- R2 未裁決：`ai/compare-agent`、`ai/news-agent` 無驗證無限流（生產打不到 Ollama，安全地壞著）。
- 秘密：TELEGRAM_BOT_TOKEN／VAPID_PRIVATE_KEY／CRON_SECRET 只在 .env.local；GOOGLE_APPLICATION_CREDENTIALS 不進 .env.local（LaunchAgent plist 帶）；SA key 檔在 repo 外只引路徑。
- 不做 dev auth backdoor；不接受使用者密碼。

## 修A錯B 影響面
改 `clientIp` 取法會改變所有 11 支 route 的限流鍵——先在線上抓一次真實 XFF 樣本（含本機與行動網路），確認 proxy 跳數再改。

## 掃描探針
- 反向：`rg -n "x-forwarded-for" src/lib src/app/api`；`rg -L "requireAdmin|verifyIdToken|CRON_SECRET|rateLimit" $(rg -l "export async function (POST|DELETE|PUT|PATCH)" src/app/api)`（無防護的 mutating route）
