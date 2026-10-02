---
name: wm-mcp-agent-surface
description: MCP 與 Agent 可發現面——MCP server（OAuth+HMAC grant、billing denial、proxy DoH 固定）、24 個 SKILL.md＋.well-known manifest、llms.txt、CLI 與三語 SDK；台股助手參考級（單人站不對外）
---
# wm-mcp-agent-surface｜MCP／Agent 產品面（參考·不適用）

**上游依據**（基線 v2.10.0 · c34156d · 2026-10-02（第二大腦 second-brain/worldmonitor/））：`api/mcp.ts`、`api/mcp-proxy`、`skills/*/SKILL.md`（frontmatter name/description/…）、`public/.well-known/agent-skills/index.json`、`agent-card.json`、`llms.txt`、`cli/`、`sdk/{python,ruby,go}`、`mcp-live-smoke.yml`。**適用度：不適用（保留作技能格式與 discovery 的參考）**。

## 原則（可借的部分）
- 公開 discovery methods 與認證 data methods 分層；discovery 有 digest 防漂移。
- 對外面向要有 live smoke CI。
- SKILL.md 格式：frontmatter 精準 description（供 agent 自動選用），正文「何時用／怎麼用／限制」。

## 台股助手規範
- 本站 `.claude/skills/wm-*` 沿用上游 SKILL.md 格式；description 要讓 Claude 能從任務判斷該載入哪條。
- 不做對外 MCP／SDK。

## 掃描探針
- 正向：每條 wm 技能 frontmatter 有 name/description 且 description 含「台股助手」對應

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **技能內容一改，discovery digest 就要跟著變**（上游 `public/.well-known/agent-skills/index.json`：`fetch-news-digest` 的 sha256 digest 更新）。台股助手沒有對外 manifest，但 22 條 `wm-*` 的版本追蹤只靠檔尾「週更增補」日期；參考做法：週更時記錄每條 SKILL.md 的 `git hash-object`，下週比對以確認「宣稱未改的技能真的沒改」。
- **對外面向的 liveness 要有排程探測**（上游新 CI `mcp-preset-liveness.yml`，每週一跑 `tests/mcp-presets.test.mjs`）。本站無對外 MCP，不適用；同形原則已由 daemon 16:10 稽核承擔。
- 上游 `CONCEPTS.md` 新增 MCP OAuth 三詞條（Client Callback Allowlist：回呼位址封閉清單、全有或全無；Flow Issuer：簽發者在流程起點決定並攜帶；Connect-Time Challenge：握手即挑戰、錯誤回應須帶 request id）——台股助手無 OAuth server，**不適用**；Flow Issuer 的「身分在起點決定」原則已收進 wm-authoritative-identity 本週增補。

## 2026-10-02 週更增補（上游 90dc23a→c34156d；1ab4284→c34156d 依據檔無變更）

- **上游 agent-skills 新增 `research-stocks`、`compare-macro-history`；`fetch-country-brief` 改為優先開嵌入式 UI**（依據：`public/.well-known/agent-skills/index.json`；另有 5 條既有技能內容變更、digest 隨之更新）。兩條新技能的描述都把「**保留模型與模擬的限制**」「保留日期、來源定義與缺漏讀數」寫進觸發說明——對外暴露分析能力時，限制聲明是契約的一部分。
- 參考·不適用（本站不對外提供 MCP）；但「回測／研究輸出必附模型限制與資料日」與本站「交易相關輸出一律附非投資建議」「比對不扣成本、成本另列」同族。
