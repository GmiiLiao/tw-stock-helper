// ─────────────────────────────────────────────────────────────────────────────
// 推論連動的信心上限（程式強制）——newsVerdict 三個寫入端（夜補、盤中、盤後／晨間）共用的唯一實作
//
// 依據：新聞技能 §3.2「推論要標明、信心最高『低』」、§3B.10 第 1 點；jev-score-usage-spec 附錄 B X2；plan B2-4 h。
//   使用者 2026-10-08「其它錯誤依建議修正」。
// 為什麼要寫成程式：提示詞規則 7 曾寫「推論性的連動信心最高給中」、規則 9 寫「最高只能給低」，互相矛盾；
//   本機備份實測以「推論：」開頭的 8 筆中 5 筆信心「中」。規則只寫在提示詞裡，本機模型不一定照做（同 stale 舊聞上限的教訓）。
// 做法：判別的「連動」欄（verdict.chain）以「推論」開頭 ⇒ 信心最高「低」。
//   · 只降不升；方向（label）、強度不動。
//   · AI 原值留在 aiOriginal.confidence（與規則類的 aiOriginal.label／reason 合併，不覆寫）；confCap='inference' 標明是誰夾的。
//   · 只對新寫入生效，不回溯舊文件（技能 §10 第 13 條）。
// 讀者（2026-10-08 掃描）：/api/rating 的 confK（信心低 ⇒ 壓 WATCH 的力道變小）、ai-recommend newsAdj（只顯示）、
//   analyst-desk pack 的正向信心篩選、戰情新聞燈的信心字、squeeze-train 的 newsNextConf 特徵（凍結中）、停損 research 欄（只顯示）。
// 與規則類的先後（審查 2026-10-08）：C16a（法律事件）的方向由規則定（硬規定「涉法律事件一律利空」；事實由另一題 AI 認定），
//   不是推論 ⇒ ruleClass＝'C16a' 的列不套本上限（信心維持規則調整後的值，例如「低」升「中」），只標 inference。
//   其他規則類只記欄位、方向仍是 AI 判的 ⇒ 照常套上限。
//   AI 原值：上游（applyRuleFacts）已把 AI 原信心記進 aiOriginal.confidence 時不覆寫——不可拿規則調整後的值當 AI 原值。
// 純函式；不改動輸入。單元測試 news-inference-cap.test.mjs。
// ─────────────────────────────────────────────────────────────────────────────

import { LABEL_OVERRIDE_CLASS as LEGAL_RULE_CLASS } from './news-rule-classes.mjs';   // 方向由法律規則決定的類別（C16a）

/** 推論連動的信心上限 */
export const INFERENCE_CONF_MAX = '低';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** 「連動」欄是否為推論（以「推論」開頭；容許前導空白、引號或括號） */
export function isInferenceChain(chain) {
  return typeof chain === 'string' && /^[\s「『"'“（(【]*推論/.test(chain);
}

/**
 * 寫入端展開在原欄位（confidence、...ruleFieldsOf(v)）之後：推論且信心高於「低」⇒ 回傳覆寫欄位；否則回傳 {} 或只標 inference。
 * @param {object|null} v judgeOneStock 回傳的 verdict（含 chain、confidence、可能有規則類的 aiOriginal）
 */
export function inferenceCapFields(v) {
  if (!isObj(v) || !isInferenceChain(v.chain)) return {};
  if (v.confidence === INFERENCE_CONF_MAX || v.ruleClass === LEGAL_RULE_CLASS) return { inference: true };
  const orig = isObj(v.aiOriginal) ? v.aiOriginal : {};
  return {
    inference: true,
    confidence: INFERENCE_CONF_MAX,
    confCap: 'inference',
    aiOriginal: { ...orig, confidence: orig.confidence !== undefined ? orig.confidence : (v.confidence ?? null) },
  };
}
