// ─────────────────────────────────────────────────────────────────────────────
// AI 停損規範 stop-v1.1 共用純函式·基礎層：版本與參數、檔位與漲跌停、日期與交易日、價格格式、來源標籤、事實句。
// 對外一律經 scripts/lib/ai-stoploss.mjs（集線器）匯入；型別在 ai-stoploss.d.mts。規範 .claude/skills/tw-ai-stoploss/SKILL.md。
// 規則：純函式——不 import firebase、不碰網路與檔案、不讀時鐘（時間一律由參數傳入），回傳新物件、不改輸入。非投資建議。
// ─────────────────────────────────────────────────────────────────────────────
import { taipeiMinuteOfDay } from './warroom-session.mjs';

export const STOP_SPEC_VERSION = 'stop-v1.1';

/**
 * SKILL §3.7 參數表（改任何一個都要重跑回測並經使用者核可）。
 * eventTiers：事件收緊依「類別權重」（新聞技能 §4.1 baseWeight，先驗·未回測；scripts/lib/news-rule-classes.mjs）分級——
 *   權重 ≥0.7 ⇒ 前收 −max(1×ATR14, 3%)；0.3～0.7 ⇒ 前收 −max(2×ATR14, 5%)；<0.3 ⇒ 不收緊（只記影子）。
 *   兩級的距離都沿用站上既有常數：1×ATR＝逼近界線、3%＝ATR 帶夾值上界；2×ATR、5%＝v1 AI 結構候選的距離下限（SKILL §10A.3）。
 */
export const STOP_PARAMS = Object.freeze({
  capPct: 8,
  bandRatchet: true, bandAtrMult: 0.5, bandClampLo: 0.85, bandClampHi: 0.97, bandMinBars: 15,
  beTriggerPct: 10, trailTriggerPct: 20, trailAtr: 3,
  eventTiers: Object.freeze([
    Object.freeze({ tier: 'strong', minWeight: 0.7, atrMult: 1, minPct: 3 }),
    Object.freeze({ tier: 'mild', minWeight: 0.3, atrMult: 2, minPct: 5 }),
  ]),
  eventHoldDays: 5, eventRearmDays: 5,
  clearMult: 1.02, nearAtr: 1, nearPctFallback: 2, suspectLo: 0.25, suspectHi: 5, staleSec: 300,
  disciplineFromDay: 2, shadowMinDays: 20,
  archiveFrom: '2023-07-17',
});

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isPos = v => isNum(v) && v > 0;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

// ── 檔位與漲跌停（統一 daemon _isEtfCode／_tickOf／_onTick） ─────────────────

/** v1 起釘住 daemon 現行 /^00\d{2,4}$/；英文字尾（00632R、00958B、00400A）判為非 ETF——待核實（SKILL §15-1） */
export function isEtfCode(code) {
  return /^00\d{2,4}$/.test(String(code ?? ''));
}

/** 該價位的檔位（個股：<10 0.01、<50 0.05、<100 0.1、<500 0.5、<1000 1、≥1000 5；ETF：<50 0.01、≥50 0.05） */
export function tickOf(price, isEtf = false) {
  const p = Number(price);
  if (isEtf) return p < 50 ? 0.01 : 0.05;
  return p < 10 ? 0.01 : p < 50 ? 0.05 : p < 100 ? 0.1 : p < 500 ? 0.5 : p < 1000 ? 1 : 5;
}

const decOfTick = t => (t >= 1 ? 0 : t >= 0.1 ? 1 : 2);

/** 取到合法檔位：dir −1 向下、+1 向上（ceilTick）、0 四捨五入。容忍浮點誤差（52.35 不會被當成 52.3500001 再進一檔） */
export function roundTick(price, dir, isEtf = false) {
  if (!isPos(price)) return NaN;
  const t = tickOf(price, isEtf);
  const n = price / t;
  const k = dir > 0 ? Math.ceil(n - 1e-7) : dir < 0 ? Math.floor(n + 1e-7) : Math.round(n);
  return +(k * t).toFixed(decOfTick(t));
}

/** 向上取檔（成本線、保本、追蹤、棘輪 ×f）；非正數回 null */
export function ceilTick(price, isEtf = false) {
  const v = roundTick(price, 1, isEtf);
  return isPos(v) ? v : null;
}

/** 向下取檔（ATR 帶、事件收緊線：留在結構外側、保住最小距離）；非正數回 null */
export function floorTick(price, isEtf = false) {
  const v = roundTick(price, -1, isEtf);
  return isPos(v) ? v : null;
}

/** 是否在合法檔位上（容忍浮點誤差、不容忍半檔；同 daemon _onTick） */
export function onTick(price, isEtf = false) {
  if (!isPos(price)) return false;
  const t = tickOf(price, isEtf);
  return Math.abs(price / t - Math.round(price / t)) < 0.02;
}

/** 漲跌停價（參考價×1.1 向下取檔／×0.9 向上取檔）。參考價未知、≤0，或無漲跌幅限制的標的 ⇒ null（不寫跌停事實句） */
export function limitPrices(refPrice, isEtf = false, noLimit = false) {
  if (noLimit || !isPos(refPrice)) return null;
  return { up: roundTick(refPrice * 1.1, -1, isEtf), down: roundTick(refPrice * 0.9, 1, isEtf) };
}

// ── 日期與交易日（休市日曆一律由呼叫端注入 isTradingDay(ymd)） ─────────────

/** 'YYYY-MM-DD'／'YYYY/MM/DD'／ISO → 'YYYY-MM-DD'；認不得回 '' */
export function normYmd(s) {
  const m = String(s ?? '').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

const DAY_MS = 86_400_000;
const ymdToMs = ymd => Date.parse(`${ymd}T00:00:00Z`);
const msToYmd = ms => new Date(ms).toISOString().slice(0, 10);
const shiftYmd = (ymd, days) => msToYmd(ymdToMs(ymd) + days * DAY_MS);
/** 最多往前／往後找 40 個日曆日（足以跨過春節連假）；找不到回 null（不猜） */
const SCAN_LIMIT = 40;
const tradingOk = (fn, ymd) => (typeof fn === 'function' ? fn(ymd) === true : true);

/** ymd 之後（不含）的第一個交易日 */
export function nextTradingYmd(ymd, isTradingDay) {
  if (!YMD_RE.test(String(ymd))) return null;
  for (let i = 1; i <= SCAN_LIMIT; i++) {
    const d = shiftYmd(ymd, i);
    if (tradingOk(isTradingDay, d)) return d;
  }
  return null;
}

/** ymd 之前（不含）的最後一個交易日 */
export function prevTradingYmd(ymd, isTradingDay) {
  if (!YMD_RE.test(String(ymd))) return null;
  for (let i = 1; i <= SCAN_LIMIT; i++) {
    const d = shiftYmd(ymd, -i);
    if (tradingOk(isTradingDay, d)) return d;
  }
  return null;
}

/** 從 ymd 起往後數 n 個交易日（n=0 回 ymd 本身）；第 n 個找不到回 null */
export function addTradingDays(ymd, n, isTradingDay) {
  if (!YMD_RE.test(String(ymd)) || !Number.isInteger(n) || n < 0) return null;
  let d = ymd;
  for (let i = 0; i < n; i++) {
    d = nextTradingYmd(d, isTradingDay);
    if (!d) return null;
  }
  return d;
}

/** [fromYmd, toYmd] 兩端都含的交易日數；from > to 回 0 */
export function countTradingDays(fromYmd, toYmd, isTradingDay) {
  if (!YMD_RE.test(String(fromYmd)) || !YMD_RE.test(String(toYmd)) || fromYmd > toYmd) return 0;
  let n = 0;
  for (let d = fromYmd; d <= toYmd; d = shiftYmd(d, 1)) if (tradingOk(isTradingDay, d)) n += 1;
  return n;
}

// ── 價格與文字格式 ─────────────────────────────────────────────────────────

function pxText(p, isEtf = false, cost = false) {
  if (!isNum(p)) return '—';
  const d = isEtf || cost ? 2 : decOfTick(tickOf(p, isEtf));
  const [i, f] = p.toFixed(d).split('.');
  return `${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}

/** 停損相關價格的顯示：依檔位定小數位（ETF 一律 2 位），千分位逗號——與站上 fmtPrice 同 */
export function stopPxText(p, isEtf = false) {
  return pxText(p, isEtf);
}

/** 成本類價格（還原成本、買進均價）：一律 2 位小數 */
export function costPxText(p) {
  return pxText(p, false, true);
}

const pctText = (n, digits = 1) => (isNum(n) ? `${n.toFixed(digits)}%` : '—');
const pad2 = n => String(n).padStart(2, '0');

/** 台北 hh:mm */
export function hhmmText(ms) {
  if (!isNum(ms)) return '—';
  const m = Math.floor(taipeiMinuteOfDay(ms));
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** 'YYYY-MM-DD' → 'MM/DD' */
export function mmddText(ymd) {
  return typeof ymd === 'string' && ymd.length >= 10 ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}` : '—';
}

/** 帶正負號的百分比（負號用 U+2212，與規範範本同）：+6.2%／−8.1%／0.0% */
export function signedPctText(n, digits = 1) {
  if (!isNum(n)) return '—';
  const r = +n.toFixed(digits);
  if (r > 0) return `+${r.toFixed(digits)}%`;
  if (r < 0) return `−${Math.abs(r).toFixed(digits)}%`;
  return `${(0).toFixed(digits)}%`;
}

/** 帶正負號的金額（元，千分位；負號 U+2212）：+1,800／−1,800／0 */
export function signedAmountText(n) {
  if (!isNum(n)) return '—';
  const r = Math.round(n);
  const abs = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return r > 0 ? `+${abs}` : r < 0 ? `−${abs}` : '0';
}

/**
 * 持有損益句（SKILL §9；觸及類句子一律接在結尾）：>0 ⇒「持有仍獲利 +x%（未含費稅）」；≤0 ⇒「持有損益 −x%（未含費稅）」。
 * 損益＝(判定當下的價 − 還原成本) ÷ 還原成本（呼叫端算好傳 pnlPct）。
 */
export function pnlClauseText(pnlPct) {
  if (!isNum(pnlPct)) return '';
  const r = +pnlPct.toFixed(1);
  return r > 0 ? `持有仍獲利 ${signedPctText(r)}（未含費稅）` : `持有損益 ${signedPctText(r)}（未含費稅）`;
}

// ── 來源標籤（SKILL §9：唯一格式，只由這支產生） ──────────────────────────

/** 保本線淨額註記（費稅約 0.38%＝手續費 0.1425% 雙邊依使用者券商 2.8 折＋證交稅 0.3%；evidence §6） */
export const BREAKEVEN_NET_NOTE = '未含費稅；淨額約 −0.38%';

/**
 * 綁定來源的畫面標籤。src：'cost'｜'atrBand'｜'breakeven'｜'trail'｜'event'。
 * ctx.form：'short'（預設；觸及類句子用）｜'row'（一般列與 basisText 用，帶依據）｜'prompt'（LLM 提示詞用，llm-contract §1.1 表）。
 * ctx 其他欄位：adjCost、hasExTable、capPct（成本線）；sourceDate、ratchet（ATR 帶）；holdHighPct（保本）；
 *   holdHigh、fresh（追蹤線：fresh＝今天由最高收盤算出）；effectiveFrom、expiresAfter、label（事件收緊）。
 * 全庫只有這支組「保本線·持有期最高收盤曾達…」「事件收緊·MM/DD 類別名」兩種字串（測試掃描釘住）。
 */
export function stopSourceLabel(src, ctx = {}) {
  const form = ctx.form === 'row' || ctx.form === 'prompt' ? ctx.form : 'short';
  if (form === 'short') {
    if (src === 'event') return `事件收緊·${mmddText(ctx.effectiveFrom)} ${ctx.label ?? '規則類利空'}`;
    return SHORT_LABEL[src] ?? '';
  }
  switch (src) {
    case 'cost': {
      const cap = isPos(ctx.capPct) ? ctx.capPct : STOP_PARAMS.capPct;
      return ctx.hasExTable === false
        ? `成本線·買進均價 ${costPxText(ctx.adjCost)} −${cap}%·未含除權息調整`
        : `成本線·還原成本 ${costPxText(ctx.adjCost)} −${cap}%`;
    }
    case 'atrBand':
      if (form === 'prompt') return `ATR 帶·${mmddText(ctx.sourceDate)} 收盤設定`;
      return `ATR 帶·${mmddText(ctx.sourceDate)} 設定${ctx.ratchet === false ? '' : '·只升不降'}`;
    case 'breakeven': {
      const hh = isNum(ctx.holdHighPct) ? `·持有期最高收盤曾達 ${signedPctText(ctx.holdHighPct)}` : '';
      return form === 'prompt' ? `保本線${hh}` : `保本線${hh}·${BREAKEVEN_NET_NOTE}`;
    }
    case 'trail':
      if (form === 'prompt') return `追蹤線${isPos(ctx.holdHigh) ? `·持有期最高收盤 ${stopPxText(ctx.holdHigh, ctx.isEtf)} −${STOP_PARAMS.trailAtr} ATR` : ''}`;
      return ctx.fresh && isPos(ctx.holdHigh)
        ? `追蹤線·持有期最高收盤 ${stopPxText(ctx.holdHigh, ctx.isEtf)} −${STOP_PARAMS.trailAtr} ATR`
        : `追蹤線·${mmddText(ctx.sourceDate)} 設定·只升不降`;
    case 'event': {
      const head = `事件收緊·${mmddText(ctx.effectiveFrom)} ${ctx.label ?? '規則類利空'}`;
      return form === 'prompt' ? `${head}，至 ${mmddText(ctx.expiresAfter)}` : `${head}·至 ${mmddText(ctx.expiresAfter)}`;
    }
    default:
      return '';
  }
}
const SHORT_LABEL = Object.freeze({ cost: '成本線', atrBand: 'ATR 帶', breakeven: '保本線', trail: '追蹤線' });

// ── 事實句（SKILL §9、references/wording.md；只描述事實，不下指令） ─────────────

const srcPrefix = d => (typeof d.source === 'string' && d.source ? `${d.source}·` : '');
const pnlTail = d => (isNum(d.pnlPct) ? `·${pnlClauseText(d.pnlPct)}` : '');

const FACT = Object.freeze({
  row: d => {
    const atr = isNum(d.atrMultiple) ? `（${d.atrMultiple.toFixed(1)} ATR）` : '';
    const band = isPos(d.bandToday) && !(isPos(d.stop) && Math.abs(d.bandToday - d.stop) < 1e-9)
      ? `｜ATR 帶今日 ${pxText(d.bandToday, d.isEtf)}` : '';
    const dist = isNum(d.distPct) ? `｜距 ${pctText(d.distPct)}${atr}` : '';
    return `停損 ${pxText(d.stop, d.isEtf)}（${d.basisText ?? '成本線'}）${band}${dist}`;
  },
  touch: d => {
    const parts = [typeof d.source === 'string' && d.source ? d.source : null, isNum(d.at) ? `${hhmmText(d.at)} 揭示` : null].filter(Boolean);
    const paren = parts.length ? `（${parts.join('·')}）` : '';
    return `今日最低 ${pxText(d.low, d.isEtf)} 觸及停損 ${pxText(d.stop, d.isEtf)}${paren}${isPos(d.price) ? `·現價 ${pxText(d.price, d.isEtf)}` : ''}${pnlTail(d)}`;
  },
  gap: d => `開盤 ${pxText(d.open, d.isEtf)}，已低於停損 ${pxText(d.stop, d.isEtf)}（${d.source ? `${d.source}，` : ''}差 ${pctText(d.skipPct)}）${pnlTail(d)}`,
  closeTouch: d => `收盤時判定：今日最低 ${pxText(d.low, d.isEtf)} 低於停損 ${pxText(d.stop, d.isEtf)}${d.source ? `（${d.source}）` : ''}${pnlTail(d)}`,
  lateTouch: d => `收盤後補判：今日最低 ${pxText(d.low, d.isEtf)} 低於停損 ${pxText(d.stop, d.isEtf)}（${srcPrefix(d)}盤中未即時判到）${pnlTail(d)}`,
  digest: d => (Array.isArray(d.items) ? d.items : []).map(x => {
    const who = x.name ? `${x.code} ${x.name}` : x.code;
    const src = x.source ? `·${x.source}` : '';
    const diff = isPos(x.p0) && isNum(x.diff) ? `；觸及時 ${pxText(x.p0, x.isEtf)}，與前一交易日收盤差額約 ${signedAmountText(x.diff)} 元` : '';
    return `${who} 事件第 ${x.n} 個交易日（前一交易日收盤 ${pxText(x.close, x.isEtf)}／停損 ${pxText(x.stop, x.isEtf)}${src}${diff}）`;
  }).join('、'),
  exAdjust: d => `停損已依 ${mmddText(d.date)} ${d.label ?? '除權息'}調整（係數 ${isNum(d.factor) ? d.factor.toFixed(3) : '—'}）：${pxText(d.from, d.isEtf)} → ${pxText(d.to, d.isEtf)}${isPos(d.costTo) ? `；成本同步調整為 ${costPxText(d.costTo)}` : ''}`,
  exPending: () => '除權息日·停損待調整（係數未公布，今日不判定）',
  exUnconfirmed: d => `今日最低 ${pxText(d.low, d.isEtf)} 已低於停損 ${pxText(d.stop, d.isEtf)}·除權息狀態未確認（官方今日結果未公布），確認後再發一級`,
  exUnknown: d => `除權息資料不足（買進日早於 ${d.coverFrom ?? '係數表起點'}）·停損警示最高二級`,
  suspect: d => `成本資料可疑（現價為成本的 ${isNum(d.ratio) ? (d.ratio < 1 ? d.ratio.toFixed(2) : d.ratio.toFixed(1)) : '—'} 倍）·本檔停損警示暫停`,
  // 第一階段（S2b）獲利回落線：_hwm 是 daemon 記錄的 60 秒快照最高價（從均價起算、存在記憶體），不是持有期最高收盤
  trailBreak: d => `跌破獲利回落線 ${pxText(d.line, d.isEtf)}（daemon 記錄的快照高點 ${pxText(d.hwm, d.isEtf)} −8%；重啟後重新起算）·持有仍獲利 +${pctText(d.gainPct)}`,
  auction: () => '收盤競價中·不判定',
  preOpen: () => '開盤前·不判定',
  stale: d => `報價延遲 ${d.minutes ?? '—'} 分（最後揭示 ${hhmmText(d.at)}）`,
  limitDown: d => (d.locked ? '今日未曾高於跌停價' : `今日在跌停價 ${pxText(d.price, d.isEtf)} 有成交`),
  disposition: d => (d.measures
    ? `處置中（撮合方式：${d.measures}）：觸價以成交價判定，實際成交可能低於停損價`
    : '處置中：觸價以成交價判定，實際成交可能低於停損價'),
  seededDigest: d => `已在停損下（前一交易日收盤低於停損）：${(d.codes ?? []).join('、')}·本次不逐檔發一級`,
  provisional: d => (d.withBand
    ? `停損 ${pxText(d.stop, d.isEtf)}（暫算·成本線與 ATR 帶取高·未含除權息調整；ATR 帶未棘輪）`
    : `停損 ${pxText(d.stop, d.isEtf)}（暫算·${d.hasBook ? '待 daemon 確認' : '未含除權息調整'}）`),
  tradeBasis: () => '依成交價判定（今日新設停損）',
  eventTighten: d => `停損收緊：${pxText(d.line, d.isEtf)}（${d.label ?? '事件收緊'}；AI 讀內文認定主體、方向依規則）；基礎停損 ${pxText(d.baseStop, d.isEtf)}（${d.baseSource ?? '—'}）`,
  eventDeferred: d => `事件收緊未生效：成交價 ${pxText(d.price, d.isEtf)} 已低於收緊線 ${pxText(d.line, d.isEtf)}，改於今日收盤後依官方收盤重算`,
  eventNoBite: d => `事件收緊未改變停損：現行停損 ${pxText(d.stop, d.isEtf)}（${d.source ?? '—'}）已高於收緊線 ${pxText(d.line, d.isEtf)}`,
  eventExpire: d => `事件收緊期滿（${mmddText(d.effectiveFrom)} 起 ${d.days ?? STOP_PARAMS.eventHoldDays} 個交易日）：停損回到 ${pxText(d.stop, d.isEtf)}（${d.source ?? '—'}）`,
  linesStale: d => `組成線資料日 ${mmddText(d.dataDate)}（今日收盤資料未到齊）`,
  pnl: d => pnlClauseText(d.pnlPct) || '持有損益 —',
  noOfficialBars: d => `停損 ${pxText(d.stop, d.isEtf)}（ETF／興櫃官方日 K 歸檔驗證前·沿用現行推播口徑：ATR 帶，否則成本 −8%）`,
});

/** 事實句範本（kind 見 FACT；未知 kind 回空字串） */
export function stopFactText(kind, data) {
  const f = FACT[kind];
  return f ? f(data ?? {}) : '';
}

/** 測試與文件用：所有範本 kind */
export const STOP_FACT_KINDS = Object.freeze(Object.keys(FACT));
