---
name: wm-documented-solutions
description: 問題→解法知識庫（docs/solutions 98 篇含 frontmatter 分類）與共享詞彙表（CONCEPTS.md）——台股助手的 DATA-INTEGRITY-SCAN／EXPERIMENTS 同型，補分類與詞彙
---
# wm-documented-solutions｜解法文件與共享詞彙

**上游依據**（基線 v2.10.0 · 739f9ea · 2026-10-09（第二大腦 second-brain/worldmonitor/））：`docs/solutions/**`（98 篇：logic-errors 26／integration-issues 18／conventions 12／best-practices 11／design-patterns 10…）、`CONCEPTS.md`（60+ 詞條）。**適用度：部分內化**。

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

## 2026-09-27 週更增補（上游 02f2115→90dc23a）

- **解法庫要能被 grep 到，不是被讀到**（上游 `AGENTS.md`：docs/solutions 依分類目錄＋YAML frontmatter `module/component/problem_type/tags` 可 grep）。台股助手的事故文件是散在 `docs/` 的日期檔（`AI-LAB-2026-09-24.md`、`DATA-GAP-EVENTS-2026-09-17.md`、`PRICE-EVENTS-2026-09-17.md`…），CLAUDE.md「目前狀態」表只列 6 份。規則：**新事故至少做兩件事**——① 在 `docs/DATA-INTEGRITY-SCAN.md` 歸族（A–L，不夠就加族＋探針）；② 事故段落開頭寫一行可 grep 的標記，建議格式 `事故：YYYY-MM-DD｜族：X｜模組：<檔名或 collection>`。只寫在功能文件裡的事故＝下次改同區域時找不到。
- **一個詞條一個 `###` 標題，grep 詞本身**（上游 `AGENTS.md` Landmarks 最後一列）。本站 `docs/CONCEPTS.md` 已是此格式，維持。
- **詞條可附「Avoid:」別名行與「Flagged ambiguities」段**（上游 `CONCEPTS.md` 新 Brief URL 條的 `*Avoid:*`、檔尾新增 Superseded／Capability／Unknown 三條歧義）。台股助手候選歧義：「資料日」（來源自報 vs 歸檔日 vs 日曆日）、「即時」（揭示時戳 `revealAt` vs 抓取時刻 `liveAt`）、「已部署」（hosting sha vs daemon codeHash）——同一個字兩種意思時寫進歧義段，不要只靠上下文。
- **事故的教訓要落到「偵測網」的判準，而不只是修法**（上游 `CONCEPTS.md` 新 Detection Net／Superseded Failure／Live Detection：「靠錯誤缺席推論正常」是可重複的故障形）。2026-09-24 事故的可重用教訓是「一個 try 包多個不相干寫入＝一處失敗連坐全部」與「Firestore 拒收 `undefined`」，應以族的形式留在索引，而不只在 AI 實驗文件。
