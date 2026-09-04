---
name: wm-documented-solutions
description: 問題→解法知識庫（docs/solutions 98 篇含 frontmatter 分類）與共享詞彙表（CONCEPTS.md）——台股助手的 DATA-INTEGRITY-SCAN／EXPERIMENTS 同型，補分類與詞彙
---
# wm-documented-solutions｜解法文件與共享詞彙

**上游依據**（基線 v2.10.0 · 96a93d4 · 2026-09-04（第二大腦 second-brain/worldmonitor/））：`docs/solutions/**`（98 篇：logic-errors 26／integration-issues 18／conventions 12／best-practices 11／design-patterns 10…）、`CONCEPTS.md`（60+ 詞條）。**適用度：部分內化**。

## 原則
- 每個修過的問題寫成一篇：frontmatter `title/date/category/module/problem_type/severity/applies_when/tags`；正文分 Context／昂貴的發現／規則。目的是**下次改同區域前可被檢索**，不是紀錄流水帳。
- 詞彙表只收「有專案特定意義」的名詞（Read Outcome、Vacuous Guard、Content Clock…），每條寫**為什麼需要這個區分**與「See also」；不是規格書。
- 文件裡的每個數字都從程式碼推導（`docs-stats.mjs`／inventory-count-contracts），避免文件漂移。

## 台股助手規範
- 既有同型：`docs/DATA-INTEGRITY-SCAN.md`（A–L 故障族＋可重跑 grep）、`docs/EXPERIMENTS.md`（含負面結果）、CLAUDE.md「絕對不要做的事」（每條附實案日期）。
- 新事故一律先歸族（A–L），族不夠就加族並附探針；不要只在 commit message 講。
- 詞彙：本站已有的專有名詞（唯一不變式、口徑隔離、修A錯B、資料日 vs 服務日、殘缺宇宙、快線/主迴圈、拍號）散在 CLAUDE.md——✅ 已做（F12）：`docs/CONCEPTS.md` 16 條（唯一不變式／快線主迴圈／拍號／資料日 vs 服務日／殘缺宇宙／空殼文件／口徑隔離／Read Outcome／Content Clock／修A錯B／終端狀態／觀察窗／disk 即部署／Vacuous Guard／雙向 Ratchet）。
- 文件數字（route 數、來源數）要由腳本產生或標「量測日」。

## 修A錯B 影響面
文件無執行面；但改 CLAUDE.md 規矩措辭時要同步 `.claude/skills/wm-*` 對應段，兩處不可互相矛盾。

## 掃描探針
- 正向：`ls docs/CONCEPTS.md`；`rg -c "^- \*\*" CLAUDE.md`（規矩條數 vs 是否歸族）
