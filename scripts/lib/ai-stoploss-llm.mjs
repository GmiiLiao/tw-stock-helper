// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1 共用純函式·LLM 停損文字（第 4 項裁定：LLM 只能照抄系統停損）：
//   提示詞片段 stopPromptLines／STOP_PROMPT_RULE／hypotheticalStopLine、輸出解析 parseStopRef／stripStopRef、
//   文字一致性驗證 extractStopPrices／validateLlmStopText（T1–T5；T5＝bandAsStop）。
// 依據 .claude/skills/tw-ai-stoploss/references/llm-contract.md。S3 影子期不改提示詞，只用 measure 量測。
// 對外一律經 scripts/lib/ai-stoploss.mjs（集線器）匯入。純函式。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { STOP_SPEC_VERSION, ceilTick, tickOf, stopPxText, mmddText, stopSourceLabel } from './ai-stoploss-base.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** 規則句（每個會提到停損的提示詞都要附在 STRICT_RULE 之後） */
export const STOP_PROMPT_RULE = '【停損規則】停損數字只能原樣引用上面的「停損」，不得自訂、調寬或調緊；不得把支撐買點、ATR 帶當日值或目標價稱為停損；'
  + '處置／注意是交易限制，不是走勢強弱，不得作為停損理由；新聞不得作為自行調整停損的理由（系統已依規則處理）。';

/** 輸出格式要求（加在原有格式最後一行之後） */
export const STOP_REF_FORMAT = 'STOP_REF: <照抄上面的停損數字>';

/** 提示詞用的來源標籤（llm-contract §1.1 表；字串一律由 stopSourceLabel 產生） */
function promptSourceLabel(res, ev) {
  const src = res?.stopSource ?? 'cost';
  const holdHighPct = isObj(res?.holdHigh) && isPos(res?.adjCost) ? (res.holdHigh.price / res.adjCost - 1) * 100 : null;
  return stopSourceLabel(src, {
    form: 'prompt', adjCost: res?.adjCost, sourceDate: res?.sourceDate, holdHighPct, holdHigh: res?.holdHigh?.price, isEtf: !!res?.isEtf,
    effectiveFrom: ev?.effectiveFrom ?? res?.sourceDate, expiresAfter: ev?.expiresAfter, label: ev?.label,
  });
}

/**
 * 持股分析（S5 起）的停損提示詞片段：一行「停損（系統規範 stop-v1.1·{來源}·只升不降）：X」，
 * 有事件收緊再加一行「（因 MM/DD {類別} 暫時收緊，至 MM/DD）」，做過除權息調整加「（已依除權息／減資調整）」，最後接規則句。
 * **不給** ATR 帶當日值、基礎停損、新聞影響權重（llm-contract §0-5）。extra.event＝生效中最高的那一層。
 */
export function stopPromptLines(res, extra = {}) {
  if (!isObj(res) || !isPos(res.stop)) return ['停損：成本資料缺，不提供停損數字', STOP_PROMPT_RULE];
  const ev = isObj(extra.event) ? extra.event : null;
  const lines = [`停損（系統規範 ${STOP_SPEC_VERSION}·${promptSourceLabel(res, ev)}·只升不降）：${stopPxText(res.stop, !!res.isEtf)}`];
  if (ev) lines.push(`（因 ${mmddText(ev.effectiveFrom)} ${ev.label ?? '規則類利空'} 暫時收緊，至 ${mmddText(ev.expiresAfter)}）`);
  if (extra.exAdjusted) lines.push('（已依除權息／減資調整）');
  lines.push(STOP_PROMPT_RULE);
  return lines;
}

/** 未持有時的系統停損：max(ceilTick(B×0.92), ATR 帶〔只在 band < B 時計入〕)；B 缺回 null */
export function hypotheticalStop(buyPoint, band, isEtf = false) {
  if (!isPos(buyPoint)) return null;
  const cost = ceilTick(buyPoint * 0.92, isEtf);
  const b = isPos(band) && band < buyPoint ? band : null;
  return b != null && (cost == null || b > cost) ? b : cost;
}

/** 個股波段分析／問AI（未持有）的停損句（llm-contract §1.2） */
export function hypotheticalStopLine(buyPoint, band, isEtf = false) {
  const y = hypotheticalStop(buyPoint, band, isEtf);
  if (!isPos(buyPoint) || y == null) return '停損：未持有，依進場價 −8% 與 ATR 帶取高計';
  return `若以標準買點 ${stopPxText(buyPoint, isEtf)} 進場，系統停損＝${stopPxText(y, isEtf)}（成本 −8% 與 ATR 帶取高）`;
}

const STOP_REF_LINE_RE = /^\s*STOP_REF\s*[:：]\s*([\d,]+(?:\.\d+)?)\s*$/m;

/** STOP_REF 行 → 數字；沒有或格式不對回 null */
export function parseStopRef(text) {
  const m = String(text ?? '').match(STOP_REF_LINE_RE);
  if (!m) return null;
  const v = Number(m[1].replace(/,/g, ''));
  return isPos(v) ? v : null;
}

/** 移除 STOP_REF（整行、全形冒號、出現在行中間的都移除），之後才跑 parseRationale／parseSwing／parseTrigger */
export function stripStopRef(text) {
  const kept = [];
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/STOP_REF\s*[:：]/);
    if (!m) { kept.push(line); continue; }
    const head = line.slice(0, m.index).replace(/\s+$/, '');
    if (head) kept.push(head);   // 出現在行中間：保留前半
  }
  return kept.join('\n').replace(/\s+$/, '');
}

const STOP_CTX_RE = /停損|止損/;
const BREAK_RE = /跌破/;
const NUM_RE = /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/g;
const UNIT_AFTER_RE = /^\s*(?:日|週|周|月|季|年|%|％|MA|均線|線|根|檔|張|倍)/;
// 子句分隔：全形逗號；半形逗號後面不接數字（後接數字的是千分位，例 1,234.5）
const CLAUSE_SEP_RE = /，|,(?!\d)/g;
// 子句內的標籤字：數字前最近的標籤是「目標／目標價／目標區間／評分／分數」就不是停損價（2026-10-07 線上查核的誤報）。
//   不含「買點／進場」：T4（買點當停損）要靠它們跟停損數字同子句才抓得到。
const LABEL_RE = /停損|止損|目標(?:價|區間)?|評分|分數/g;

function clausesOf(body) {
  const out = [];
  let start = 0;
  for (const m of body.matchAll(CLAUSE_SEP_RE)) { out.push({ text: body.slice(start, m.index), start }); start = m.index + m[0].length; }
  out.push({ text: body.slice(start), start });
  return out;
}
function lastLabel(text) {
  let last = null;
  for (const m of text.matchAll(LABEL_RE)) last = m[0];
  return last;
}

/**
 * 停損語境的價格擷取（llm-contract §2）：先以「。；\n」切句，句中有「停損／止損」才看；再以「，」切子句（2026-10-07 起），
 *   只取「子句內有停損／止損」或「子句內有跌破、而且同一句有停損」的子句；子句內數字前最近的標籤是目標／評分類的不算。
 *   排除後接單位詞、−8% 類、參考價 0.5～1.5 倍以外的數字。回傳的 sentence 仍是整句（enforce 的整句移除口徑不變）。
 */
export function extractStopPrices(text, ctx = {}) {
  const ref = isPos(ctx.refPrice) ? ctx.refPrice : null;
  const src = String(text ?? '').replace(/[<>＜＞]/g, '');
  const out = [];
  let offset = 0;
  for (const sentence of src.split(/(?<=[。；;\n])/)) {
    const body = sentence.replace(/[。；;\n]$/, '');
    if (STOP_CTX_RE.test(body)) {
      for (const cl of clausesOf(body)) {
        if (!STOP_CTX_RE.test(cl.text) && !BREAK_RE.test(cl.text)) continue;
        for (const m of cl.text.matchAll(NUM_RE)) {
          const after = cl.text.slice(m.index + m[0].length);
          const before = cl.text.slice(0, m.index);
          if (UNIT_AFTER_RE.test(after)) continue;
          if (/[−\-－]\s*$/.test(before) && /^\s*[%％]/.test(after)) continue;
          const label = lastLabel(before);
          if (label && !STOP_CTX_RE.test(label)) continue;
          const v = Number(m[0].replace(/,/g, ''));
          if (!isPos(v)) continue;
          if (ref != null && (v < ref * 0.5 || v > ref * 1.5)) continue;
          out.push({ value: v, raw: m[0], sentence: body.trim(), index: offset + cl.start + m.index });
        }
      }
    }
    offset += sentence.length;
  }
  return out;
}

const NOTE = stop => `（停損以系統規範 ${STOP_SPEC_VERSION} 為準：${stop}）`;

/**
 * 文字一致性驗證 T1–T5（llm-contract §4）。mode 'measure'＝只記錄；'enforce'＝T2 改數字並在欄位末尾另起一行加註（每欄一次）、
 * T3／T4 整句移除。ctx：{ stop, refPrice, band（ATR 帶當日值，含 /api/rating stopLoss）, buyPoints, lastPrice, stopRef, isEtf, mode }。
 * 回 { fields（enforce 時改過的新物件；measure 原樣複製）, violations:[{ rule, code, field, found, fixed, sentence }] }
 */
export function validateLlmStopText(fields, ctx = {}) {
  const stop = ctx.stop;
  const isEtf = !!ctx.isEtf;
  const enforce = ctx.mode === 'enforce';
  const tick = isPos(stop) ? tickOf(stop, isEtf) : 0;
  const stopText = isPos(stop) ? stopPxText(stop, isEtf) : '—';
  const violations = [];
  const out = { ...(isObj(fields) ? fields : {}) };
  if (ctx.stopRef == null) violations.push({ rule: 'T1', code: 'refMissing', field: 'STOP_REF' });
  else if (isPos(stop) && Math.abs(ctx.stopRef - stop) >= tick / 2) violations.push({ rule: 'T1', code: 'refMismatch', field: 'STOP_REF', found: ctx.stopRef });
  const buys = (Array.isArray(ctx.buyPoints) ? ctx.buyPoints : []).filter(isPos);
  for (const [field, value] of Object.entries(out)) {
    if (typeof value !== 'string' || !isPos(stop)) continue;
    const found = extractStopPrices(value, { refPrice: ctx.refPrice });
    const drop = new Set();
    const fix = [];
    for (const f of found) {
      const off = Math.abs(f.value - stop);
      if (isPos(ctx.lastPrice) && f.value >= ctx.lastPrice) {
        violations.push({ rule: 'T3', code: 'stopAbovePrice', field, found: f.value, sentence: f.sentence });
        drop.add(f.sentence);
        continue;
      }
      if (/買點|進場/.test(f.sentence) && buys.some(b => Math.abs(b - f.value) < tick / 2 + 1e-9) && off > tick + 1e-9) {
        violations.push({ rule: 'T4', code: 'buyAsStop', field, found: f.value, sentence: f.sentence });
        drop.add(f.sentence);
        continue;
      }
      if (isPos(ctx.band) && Math.abs(f.value - ctx.band) <= tick + 1e-9 && off >= tick / 2) {
        violations.push({ rule: 'T5', code: 'bandAsStop', field, found: f.value, sentence: f.sentence });
      }
      if (off > tick + 1e-9) {
        violations.push({ rule: 'T2', code: 'textMismatch', field, found: f.value, fixed: enforce ? stop : undefined, sentence: f.sentence });
        fix.push(f);
      }
    }
    if (!enforce || (!drop.size && !fix.length)) continue;
    let text = value;
    for (const s of drop) text = text.split(s).join('');
    const bySentence = new Map();
    for (const f of fix) {
      if (drop.has(f.sentence)) continue;
      if (!bySentence.has(f.sentence)) bySentence.set(f.sentence, []);
      bySentence.get(f.sentence).push(f);
    }
    for (const [sentence, fs] of bySentence) {
      let fixed = sentence;
      for (const f of fs) {
        const at = fixed.indexOf(f.raw);
        if (at >= 0) fixed = `${fixed.slice(0, at)}${stopText}${fixed.slice(at + f.raw.length)}`;
      }
      text = text.split(sentence).join(fixed);
    }
    text = text.replace(/[。；;]\s*[。；;]/g, '。').replace(/^[。；;\s]+/, '').trim();
    out[field] = bySentence.size ? `${text}\n${NOTE(stopText)}` : text;
  }
  return { fields: out, violations };
}
