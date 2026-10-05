// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1 共用純函式·推播與畫面文字：禁用詞掃描、紀律彙總、九處推播文字的核可改寫（第 9 項裁定）、
// 觸及類一級推播文字（S5）。只描述事實、不下指令；唯一豁免是停損紀律結尾「請面對決策：停損或明確寫下續抱理由」（第 7 項裁定），
// 以及指數急落公共訊息後半句「隔日沖偏多策略暫停追價」保留原文（第二輪 A6 裁定「保留」）。
// 文字依據 .claude/skills/tw-ai-stoploss/references/wording.md §1–§3。數字格式沿用 daemon 現行寫法（S2b 只改字、不改數字口徑）。
// 對外一律經 scripts/lib/ai-stoploss.mjs（集線器）匯入。純函式。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { STOP_SPEC_VERSION, stopFactText, stopSourceLabel } from './ai-stoploss-base.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;

/** 第 7 項裁定保留句（唯一允許的指令句）：只出現在 disciplineDigest 與舊紀律分支（S2b）的結尾，每則一次 */
export const DISCIPLINE_TAIL = '— 請面對決策：停損或明確寫下續抱理由';

/** 第二輪 A6 裁定「保留」：指數急落公共訊息後半句保留原文（附帶事實：全檔查無讀取 plunge 狀態去暫停策略的程式） */
export const PLUNGE_TAIL_KEPT = '隔日沖偏多策略暫停追價。';

/** #9 隔日沖開盤提醒的例外詞：描述站上隔日沖規則的時點（第 13 項裁定的條件句），不套禁用詞「出場」 */
export const OVERNIGHT_EXIT_PHRASE = '出場時點';

/** 禁用詞（references/wording.md §2；系統產生的停損推播、警示與畫面字樣） */
export const FORBIDDEN_WORDS = Object.freeze([
  '建議', '請', '應', '應該', '必須', '立即', '即刻', '認賠', '勿', '不要', '續抱', '賣出', '出場', '出清', '鎖利',
  '面對決策', '檢視風險', '優先決策', '確認停損', '執行停損', '掛好停損單', '未處理',
]);

/**
 * 回傳文字中出現的禁用詞（空陣列＝通過）。
 * opts.allowDisciplineTail：移除一次 DISCIPLINE_TAIL 再掃（只限 disciplineDigest 與舊紀律分支）；
 * opts.allowExitTiming：移除「出場時點」再掃（只限 #9）。其他豁免一律不給。
 */
export function scanForbidden(text, opts = {}) {
  let t = String(text ?? '');
  if (opts.allowDisciplineTail) t = t.replace(DISCIPLINE_TAIL, '');
  if (opts.allowExitTiming) t = t.split(OVERNIGHT_EXIT_PHRASE).join('');
  return FORBIDDEN_WORDS.filter(w => t.includes(w));
}

/** 停損紀律保留句出現次數（測試釘住：只有 disciplineDigest 與舊紀律分支的輸出恰好 1 次） */
export function disciplineTailCount(text) {
  return String(text ?? '').split(DISCIPLINE_TAIL).length - 1;
}

// ── 停損紀律彙總（S5；SKILL §8.4） ──────────────────────────────────────────

/**
 * 每人每日一則的紀律彙總：`⛔ 停損後收盤仍在停損下：{各檔} — 請面對決策：停損或明確寫下續抱理由`。
 * items：[{ code, name, n（事件第 N 個交易日）, prevClose, stop, stopSource（或 sourceLabel）, triggerPx（觸及時 p0）, qty（張）, isEtf }]
 * 差額＝(前一交易日收盤 − p0)×張×1000，帶正負號、一律寫出。沒有任何一檔回 null。
 */
export function disciplineDigest(items) {
  const list = (Array.isArray(items) ? items : []).filter(x => x && typeof x.code === 'string' && Number.isInteger(x.n));
  if (!list.length) return null;
  const body = stopFactText('digest', {
    items: list.map(x => ({
      code: x.code, name: x.name ?? '', n: x.n, close: x.prevClose, stop: x.stop, isEtf: !!x.isEtf,
      source: x.sourceLabel ?? (x.stopSource ? stopSourceLabel(x.stopSource) : null),
      p0: isPos(x.triggerPx) ? x.triggerPx : null,
      diff: isPos(x.triggerPx) && isPos(x.prevClose) && isPos(x.qty) ? (x.prevClose - x.triggerPx) * x.qty * 1000 : null,
    })),
  });
  return `⛔ 停損後收盤仍在停損下：${body} ${DISCIPLINE_TAIL}`;
}

// ── 觸及類一級推播（S5；wording.md §3 #1 S5 欄） ────────────────────────────

const FACT_KIND = Object.freeze({ touch: 'touch', gap: 'gap', close: 'closeTouch', late: 'lateTouch' });

/**
 * 一級推播文字：`⛔ {code} {name} {觸及／跳空／收盤時／補判事實句}（含來源標籤）·持有{仍獲利 +x%｜損益 −x%}（未含費稅）{·附加事實}`。
 * d：{ code, name, touch（evaluateTouch／evaluateLateTouch 的結果）, stop, sourceLabel, price, pnlPct, at, isEtf }
 */
export function stopTouchPushText(d) {
  const t = d?.touch ?? {};
  const kind = FACT_KIND[t.kind] ?? 'touch';
  const fact = stopFactText(kind, {
    low: t.triggerPx, open: t.triggerPx, stop: d.stop, skipPct: t.skipPct, at: d.at, price: d.price,
    source: d.sourceLabel, pnlPct: d.pnlPct, isEtf: !!d.isEtf,
  });
  const extra = Array.isArray(t.facts) && t.facts.length ? `·${t.facts.join('·')}` : '';
  return `⛔ ${d.code} ${d.name ?? ''} ${fact}${extra}`.replace(/\s{2,}/g, ' ');
}

// ── 九處推播文字（第 9 項裁定；S2b＝第一階段只改字，舊算法照舊） ─────────────

const raw = v => (isNum(v) ? String(v) : String(v ?? '—'));
const fix1 = v => (isNum(v) ? v.toFixed(1) : '—');
/** S2b 金額：與同一則訊息的 toFixed 百分比同一種負號（ASCII），千分位逗號 */
function asciiSignedAmount(n) {
  if (!isNum(n)) return '—';
  const r = Math.round(n);
  const abs = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return r > 0 ? `+${abs}` : r < 0 ? `-${abs}` : '0';
}

/** #1 停損推播（S2b）：舊算法（快照現價 ≤ 停損）⇒ 寫「現價已低於停損」，不寫「今日最低觸及」。source：'ai'＝持股分析 ATR 帶（過渡期名稱 AI 停損）｜'cost' */
export function stopPushTextS2b({ code, name, price, stop, legacySource, pnlPct }) {
  return `⛔ ${code} ${name ?? ''} 現價 ${raw(price)} 已低於停損 ${raw(stop)}（${legacySource === 'ai' ? 'AI 停損' : '成本 −8%'}）·持有損益 ${fix1(pnlPct)}%（未含費稅）`;
}

/** #2 移動停利（S2b）：_hwm 是 daemon 記錄的 60 秒快照高點（從均價起算、存在記憶體、重啟歸零），不是盤中高點也不是持有期最高 */
export function trailPushTextS2b({ code, name, price, line, hwm, pnlPct }) {
  return `📈 ${code} ${name ?? ''} 現價 ${raw(price)} 跌破獲利回落線 ${raw(line)}（daemon 記錄的快照高點 ${isNum(hwm) ? hwm.toFixed(2) : '—'} −8%；重啟後重新起算）·持有仍獲利 +${fix1(pnlPct)}%`;
}

/** #3 停損紀律（S2b）：差額＝(現價 − p0)×張×1000，帶正負號、一律寫出；結尾逐字保留第 7 項保留句 */
export function disciplinePushTextS2b({ code, name, stopPrice, days, price, lossPct, p0, qty }) {
  const diff = isPos(price) && isPos(p0) && isPos(qty) ? (price - p0) * qty * 1000 : null;
  const p0Text = isPos(p0) ? `；觸及時 ${raw(p0)}，現價與觸及時差額約 ${asciiSignedAmount(diff)} 元` : '';
  return `⛔ ${code} ${name ?? ''} 停損 ${raw(stopPrice)} 觸發後第 ${days} 天，持股紀錄仍在（現價 ${raw(price)}，${isNum(lossPct) ? lossPct.toFixed(1) : raw(lossPct)}%${p0Text}）${DISCIPLINE_TAIL}`;
}

/**
 * #4 崩盤防禦清單的分級列。phase 's2b'：第一階段崩盤防禦用 max(ATR 帶, 成本×0.92)，**不得**寫「與停損推播同口徑」（推播是「有帶用帶」）；
 * 's5'：v1.1 生效後停損依系統規範。
 */
export function defenseListText({ red, amber, green, phase = 's2b' }) {
  const basis = phase === 's5' ? `停損依系統規範 ${STOP_SPEC_VERSION}` : '停損＝ATR 帶與成本 −8% 取高，與停損紀律同口徑';
  return `🔴 距停損 ≤3%：${red} 檔；🟡 3–8%：${amber} 檔；🟢 >8%：${green} 檔（${basis}）`;
}

/** #5 崩盤防禦推播 */
export function defensePushText({ median, n, m }) {
  return `🛡 大盤急跌（跌幅中位 ${fix1(median)}%）：持股 ${n} 檔，距停損 ≤3% 者 ${m} 檔（防禦清單在投組頁）`;
}

/** #6 指數急落（公共）：只刪「持股請確認停損價位；」，後半句依 A6 裁定保留原文。pct、from、to 同 daemon 現行算法 */
export function plungePushText({ pct, from, to }) {
  const n = v => (isNum(v) ? Math.round(v).toLocaleString('zh-TW') : '—');
  return `加權指數 10 分鐘內回落 ${isNum(pct) ? pct.toFixed(2) : '—'}%（${n(from)} → ${n(to)}）。${PLUNGE_TAIL_KEPT}`;
}

/** #7 追蹤股急跌（公共；不寫任何個人停損價） */
export function watchDropPushText({ name, code, mv, price, chg }) {
  const c = isNum(chg) ? `${chg >= 0 ? '+' : ''}${chg}` : '—';
  return `${name ?? ''}(${code}) 5分鐘急跌 ${fix1(mv)}%（現價 ${raw(price)}，今日 ${c}%）。自選／持股池標的。`;
}

/** #8 追蹤股急跌摘要（公共） */
export function watchDropSummaryText({ name, code, mv, price }) {
  return `🔻 ${name ?? ''}(${code}) 5分鐘 ${fix1(mv)}%（${raw(price)}）`;
}

/** #9 隔日沖開盤提醒（第 13 項裁定條件句；「出場時點」是 #9 唯一的禁用詞例外） */
export function overnightOpenPushText({ list }) {
  return `⏰ 若為隔日沖計畫：昨日進場 ${list}；站上隔日沖規則的${OVERNIGHT_EXIT_PHRASE}是 09:00–09:05（實測開盤賣 73%／+1.48%，抱到收盤 40%／−0.44%）`;
}
