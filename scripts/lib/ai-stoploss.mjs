// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1 共用純函式（唯一實作）——集線器：前端、daemon、測試一律從這裡匯入，路徑不變；型別在 ai-stoploss.d.mts。
// 規範：.claude/skills/tw-ai-stoploss/SKILL.md（stop-v1.1，2026-10-05 使用者兩輪裁定定稿）；簽章：warroom/stoploss/v1.1/impl-plan.md §1.2。
//
// 檔案分工（v1 的 494 行單檔超過 800 行上限前拆開；各子模組只互相 import 下層，不 import 本檔，沒有循環）：
//   ai-stoploss-base.mjs   版本與參數、檔位與漲跌停、日期與交易日、價格格式、來源標籤 stopSourceLabel、事實句 stopFactText
//   ai-stoploss-lines.mjs  官方日 K 還原、ATR14、ATR 帶、持有期最高收盤、保本／追蹤線、係數涵蓋、lineInputsOf、歸檔歸屬（A3）、前端暫算組成線
//   ai-stoploss-core.mjs   部位彙總、還原成本、持股變動、resolveStop（四線取高＋兩段棘輪＋事件收緊）、觸及判定、補判、觸及事件、紀律天數
//   ai-stoploss-event.mjs  規則類利空事件（A4：類別權重分級）、收緊線、疊加層狀態機、命中與漏網影子紀錄
//   ai-stoploss-text.mjs   禁用詞掃描、紀律彙總、九處推播文字（第 9 項）、一級推播文字
//   ai-stoploss-llm.mjs    LLM 停損提示詞、STOP_REF 解析、文字一致性驗證 T1–T5
//   ai-stoploss-plan.mjs   daemon 整合：legacyBranchActive、legacyCodeActive、planBookRefresh、planUserStopTick、planCloseSettle、planDisciplineDigest、mergeAlertsKeepUnacked
//   news-rule-classes.mjs  規則類利空事件類別與類別權重（新聞技能 §4.1；新聞管線與停損共用）
//
// 規則：純函式——不 import firebase、不碰網路與檔案、不讀時鐘（時間一律由參數傳入），回傳新物件、不改輸入。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
export * from './ai-stoploss-base.mjs';
export * from './ai-stoploss-lines.mjs';
export * from './ai-stoploss-core.mjs';
export * from './ai-stoploss-event.mjs';
export * from './ai-stoploss-text.mjs';
export * from './ai-stoploss-llm.mjs';
export * from './ai-stoploss-plan.mjs';
export {
  RULE_BEAR_CLASSES, RULE_CLASS_BY_CODE, RULE_CLASS_BY_KEY, RULE_CLASS_CODES, CLASS_WEIGHT_NOTE,
  ruleClassOf, ruleSubOf, classWeightOf, ruleReasonPrefix,
} from './news-rule-classes.mjs';
