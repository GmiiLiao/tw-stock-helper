// ── 投資論點：草稿支柱選取＋月營收口徑切換的一次性重測（2026-10-09 使用者裁定）──────────────────────────
// 背景：論點支柱「月營收年增為正」原本讀 openapi t187ap05_L＋_P——沒有上櫃、混入未上市 _P、留白讀成 0%。
//   改用 MOPS 月營收歸檔（lib/revenue-source.mjs）後，2026-10-04 線上模擬全宇宙 ✗→✓ 638 檔。
//   論點的「支柱組合」是建立當天由數據選出來的（成立者＝買進依據、不成立者＝風險），口徑錯的那天選錯的組合
//   不會因為之後數據正確而自己修好 ⇒ 使用者裁定：刪除原論點（系統算的部分）、用修正後資料重測，
//   再對每位使用者推一則彙總通知（不是每檔翻轉各推一則）。
//
// 資料歸屬（users/{uid}/data/theses 的 theses[code]）：
//   使用者資料（前端 ThesisCards.save 只會寫這兩欄，並把 status 設為 'edited'）：
//     thesis（論點文字，status==='edited' 時才算使用者的）、conviction（信心度）。
//   系統計算（daemon 寫、前端唯讀）：pillars、risks、intact、refs、support、tech、risk、name、
//     以及 status==='draft' 時的 thesis 文字（由支柱組合生成）。
//   系統預填但與營收口徑無關、重測時沿用：targetPrice、stopLoss（停損另有規範 tw-ai-stoploss，不在這裡重定）、createdAt。
// ⇒ 重測只重置系統計算的部分；使用者寫過的論點文字與信心度一律保留。持股資料（holdings）完全不碰。

/** 本次口徑代號：寫在 theses 文件頂層 basis，與重建內容同一次寫入（逐使用者原子、重啟不重做）。 */
export const THESIS_BASIS = 'rev-mops-2026-10';

/**
 * 草稿論點的支柱選取（建立論點與口徑重測共用同一把尺）。
 * results：[{ key, label, ok }]（THESIS_PILLARS 依序的檢核結果）。
 * 成立的支柱＝買進依據；一個都不成立時取前三根（全 ✗）當支柱；不成立的前三根列為風險。
 */
export function draftPillars(results = []) {
  const okOnes = results.filter(r => r.ok);
  const pillars = (okOnes.length ? okOnes : results.slice(0, 3)).map(r => ({ key: r.key, label: r.label, ok: r.ok }));
  const risks = results.filter(r => !r.ok).slice(0, 3).map(r => `${r.label}：目前不成立`);
  return { pillars, risks, aiText: okOnes.length ? `（AI 依據）${okOnes.map(p => p.label).join('、')}。` : '（草稿）目前無明確多方數據依據，請補充你的買進理由。' };
}

/** 草稿論點文字：持股備註＋支柱生成文字（與建立時同一格式）。 */
export const draftThesisText = (note, aiText) => (note ? `${note}｜` : '') + aiText;

/** 多數支柱成立才算論點成立（與每日檢核同一條式子）。 */
export const isIntact = pillars => !pillars?.length || pillars.filter(p => p.ok).length >= Math.ceil(pillars.length / 2);

/** 論點文件需要重測：有既有論點、且還不是本口徑。空文件只需蓋上口徑章（沒有舊判斷可重測、不通知）。 */
export function needsRebase(docData, basis = THESIS_BASIS) {
  const n = Object.keys(docData?.theses || {}).length;
  return n > 0 && docData?.basis !== basis;
}

/**
 * 重測的資料閘門：月營收必須來自 MOPS 歸檔、且該月名冊完整（pickArchiveMonth 的 complete）。
 *   openapi 後備（上市限定）或申報期內的殘缺月份都不能拿來重測——否則等於用另一份錯口徑重選支柱、而且只做一次。
 */
export function rebaseReady(revMeta) {
  return typeof revMeta?.source === 'string' && revMeta.source.startsWith('archive:') && revMeta.complete === true;
}

/**
 * 以修正後的檢核結果重建一則既有論點（只重置系統計算的部分）。
 * old：既有 theses[code]；results：本次檢核結果；note：持股備註（草稿文字用）；name：持股名稱（後備 old.name）。
 * 回傳新物件（不改 old）。refs／support／tech／risk 由呼叫端的每日補強段落照常重算。
 */
export function rebuildThesis(old = {}, results = [], { note = null, name = null, now = Date.now() } = {}) {
  const { pillars, risks, aiText } = draftPillars(results);
  const edited = old.status === 'edited';
  return {
    ...old,
    name: old.name || name || '',
    status: edited ? 'edited' : 'draft',
    conviction: old.conviction || 'medium',
    thesis: edited ? (old.thesis ?? '') : draftThesisText(note, aiText),
    pillars, risks,
    intact: isIntact(pillars),
    updatedAt: now,
  };
}

/** 每位使用者一則的彙總通知文字。rows：[{ code, name, intact }]（重測後）。 */
export function rebaseSummaryMessage(rows = [], { maxList = 10 } = {}) {
  const weak = rows.filter(r => r.intact === false);
  const head = `🧩 月營收口徑修正後重新評估投資論點（改用 MOPS 月營收歸檔：補上櫃與 KY、未公布不再當 0%）：共 ${rows.length} 檔`;
  if (!weak.length) return `${head}，目前沒有轉弱的論點。非投資建議`;
  const list = weak.slice(0, maxList).map(r => `${r.code} ${r.name || ''}`.trim()).join('、');
  return `${head}，目前轉弱 ${weak.length} 檔：${list}${weak.length > maxList ? ' 等' : ''} — 建議檢視持有理由。非投資建議`;
}
