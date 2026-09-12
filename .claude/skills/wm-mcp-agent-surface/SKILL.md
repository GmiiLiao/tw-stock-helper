---
name: wm-mcp-agent-surface
description: MCP 與 Agent 可發現面——MCP server（OAuth+HMAC grant、billing denial、proxy DoH 固定）、24 個 SKILL.md＋.well-known manifest、llms.txt、CLI 與三語 SDK；台股助手參考級（單人站不對外）
---
# wm-mcp-agent-surface｜MCP／Agent 產品面（參考·不適用）

**上游依據**（基線 v2.10.0 · 02f2115 · 2026-09-12（第二大腦 second-brain/worldmonitor/））：`api/mcp.ts`、`api/mcp-proxy`、`skills/*/SKILL.md`（frontmatter name/description/…）、`public/.well-known/agent-skills/index.json`、`agent-card.json`、`llms.txt`、`cli/`、`sdk/{python,ruby,go}`、`mcp-live-smoke.yml`。**適用度：不適用（保留作技能格式與 discovery 的參考）**。

## 原則（可借的部分）
- 公開 discovery methods 與認證 data methods 分層；discovery 有 digest 防漂移。
- 對外面向要有 live smoke CI。
- SKILL.md 格式：frontmatter 精準 description（供 agent 自動選用），正文「何時用／怎麼用／限制」。

## 台股助手規範
- 本站 `.claude/skills/wm-*` 沿用上游 SKILL.md 格式；description 要讓 Claude 能從任務判斷該載入哪條。
- 不做對外 MCP／SDK。

## 掃描探針
- 正向：每條 wm 技能 frontmatter 有 name/description 且 description 含「台股助手」對應
