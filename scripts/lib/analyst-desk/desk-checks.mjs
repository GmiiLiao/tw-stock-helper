// ─────────────────────────────────────────────────────────────────────────────
// desk 層補充查核（check.mjs 管不到的「語意」啟發式）。純函式、零 IO。回傳 blocker 形狀同 checkIssue：{rule, claimId, msg}。
//   D01  引用 df.*（較前一交易日的變化量）的句子，必須以變化語氣描述；把「變化量」寫成「當日水準」是實測中 LLM 最常犯、
//        且 R03／R04 等機械規則抓不到的錯（例：外資買賣超較前日 −195.6 億，被寫成「外資買賣超 −195.6 億」）。
// ─────────────────────────────────────────────────────────────────────────────
const CHANGE_WORDS = /較前|前一交易日|前一日|前日|前交易日|相較|相比|差|由.*(?:轉|至|升|降|縮|增|減)|轉|升溫|降溫|翻|擴大|縮小|收斂|改善|惡化|變化|增加|減少|上升|下降|減少|增減/;

function* claimsOf(issue) {
  const s = issue.summary || {};
  for (const c of [...(s.points || []), ...(s.nextFocus || []), ...(s.risks || [])]) yield c;
  for (const card of issue.cards || []) for (const sec of card.sections || []) for (const c of sec.claims || []) yield c;
}

export function deskChecks(issue) {
  const out = [];
  for (const c of claimsOf(issue)) {
    const usesDiff = (c.refs || []).some(r => r.startsWith('df.'));
    if (usesDiff && !CHANGE_WORDS.test(String(c.text || '').replace(/\{\{[^}]*\}\}/g, ''))) {
      out.push({ rule: 'D01', claimId: c.id, msg: '引用 df.*（較前一交易日的變化量）但文字沒有以「較前一交易日」的變化語氣描述，疑把差值當成當日水準' });
    }
  }
  return out;
}
