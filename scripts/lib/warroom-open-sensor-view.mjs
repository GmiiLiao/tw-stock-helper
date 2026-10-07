// ─────────────────────────────────────────────────────────────────────────────
// 開盤感應器（openSensor-v2.1·影子）的畫面文字推導（純函式·唯一實作；戰情 v2 Z1「開盤結構」與放大層共用）
//
// 輸入＝warroom-open-sensor.mjs 正規化後的路由回應；輸出＝每一行的字串（只描述事實，不寫指令句）。
// 規格：design-v2.1.md §3.5 七種狀態對照、§3.6 量未定、§3.7 不在狀態內、§5.5 有效開盤、§6 盤型、§9.2 區塊版面。
//   · 狀態名稱照使用者原話；①–⑥ 帶「（量為估計）」；只有 ①–⑥ 用紅綠實心燈，⑦ 中性色、其餘灰
//   · 量寫萬張、值寫億元並標（估）；資料時間一律寫揭示時間（檢查點 T）
//   · 「09:02 起首判」：今天的文件尚未存在；非交易日看最後交易日並標「◆ 前交易日」
//   · 不顯示命中率、勝率、回測百分比
// 單元測試：node --test scripts/lib/warroom-open-sensor.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { taipeiMinuteOfDay, taipeiYmd } from './warroom-session.mjs';
import { hhmmss } from './warroom-freshness.mjs';
import { OS_BADGE, OS_TIMES, currentCheck, checkOf } from './warroom-open-sensor.mjs';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const MINUS = '−';
const DASH = '—';
const CIRCLED = Object.freeze(['', '①', '②', '③', '④', '⑤', '⑥', '⑦']);

// ── 名稱表（§3.5） ─────────────────────────────────────────────────────────

/** 七種命名狀態（使用者原名；lamp：red 漲、green 跌、neutral 中性） */
export const OS_STATES = Object.freeze({
  allUpHeavy: Object.freeze({ num: 1, name: '全面量大上漲', lamp: 'red' }),
  allDownLight: Object.freeze({ num: 2, name: '全面量縮下跌', lamp: 'green' }),
  wUpLight: Object.freeze({ num: 3, name: '量縮權值漲', lamp: 'red' }),
  genUpHeavy: Object.freeze({ num: 4, name: '量大一般股漲', lamp: 'red' }),
  wDownHeavy: Object.freeze({ num: 5, name: '量大權值下跌', lamp: 'green' }),
  wUpHeavy: Object.freeze({ num: 6, name: '量大權值漲', lamp: 'red' }),
  noDirection: Object.freeze({ num: 7, name: '無方向', lamp: 'neutral' }),
});

/** 主導·方向 × 量 → 命名狀態（null＝不在狀態內） */
const CELL_STATE = Object.freeze({
  'all|up': { big: 'allUpHeavy', small: null },
  'all|down': { big: null, small: 'allDownLight' },
  'w|up': { big: 'wUpHeavy', small: 'wUpLight' },
  'w|down': { big: 'wDownHeavy', small: null },
  'gen|up': { big: 'genUpHeavy', small: null },
  'gen|down': { big: null, small: null },
});
const VOL_WORD = Object.freeze({ big: '量大', small: '量縮' });
const VOL_WORD_EST = Object.freeze({ big: '量大（估）', small: '量縮（估）', pending: '量能未定' });
const DOM_WORD = Object.freeze({ all: '全面', w: '權值', gen: '一般股' });
const DIR_WORD = Object.freeze({ up: '漲', down: '跌' });
const SUB_WORD = Object.freeze({
  tsmcSolo: '台積電獨撐', tsmcUpSolo: '台積電獨撐', tsmcWeak: '台積電獨弱', tsmcDownSolo: '台積電獨弱', tsmcSoloWeak: '台積電獨弱',
  split: '權值分歧', wSplit: '權值分歧', divergent: '權值分歧', mixed: '權值分歧',
});
const VOL_REASON_WORD = Object.freeze({
  cBase: '時間累計基準不足 5 日', pxSample: '價格樣本未過閘門（放寬到 120 秒）', q: '上市累積成交量缺拍', noQ: '上市累積成交量缺拍',
  qMissing: '上市累積成交量缺拍', rho: 'ρ 缺值', noRho: 'ρ 缺值',
});
const GATE_WORD = Object.freeze({
  G1: '權值 30 夠新不足', G2: '上市一般股夠新不足', G3: '揭示時間中位數落後', G4: '指數拍子未夾住檢查點',
  G5: '資料日不是今天', G6: '該輪 0 筆即時報價', G9: '延後開盤', G10: '發行股數缺或過舊', noIssuedShares: '發行股數缺',
  restart: '重啟後超過檢查窗',
});
/** 盤型（§6；照 v2 §5.2） */
export const PATTERN3_LABEL = Object.freeze({
  fadeDown: '開高走低', upUp: '開高走高', upHold: '開高持穩', reversalUp: '開低走高', downDown: '開低走低',
  downHold: '開低持穩', flatDown: '開平殺盤', flatUp: '開平走高', range: '平盤震盪',
});
/** 量的樣本內誤差事實（calibration 表 C；回補 40 日、官方值、不含 ρ 誤差）——只當事實列在放大層 */
export const OS_SAMPLE_ERROR_NOTE = '09:02 預估全日誤差（回補 40 日，官方值）中位 11%、最差 42%（不含 ρ 與價格樣本誤差）';
/** ρ 先驗說明（§4.1：用 ρ0 期間放大層要寫） */
export const OS_RHO_PRIOR_NOTE = 'ρ 用收盤口徑先驗 0.53（近 20 日 0.49–0.58）';

// ── 格式（站上規範：漲跌% 2 位、缺值「—」不當 0） ─────────────────────────

export function osPct(n, digits = 2) {
  if (!isNum(n)) return DASH;
  const s = n > 0 ? '+' : n < 0 ? MINUS : '';
  return `${s}${Math.abs(n).toFixed(digits)}%`;
}
export function osPp(n, digits = 2) {
  if (!isNum(n)) return DASH;
  const s = n > 0 ? '+' : n < 0 ? MINUS : '';
  return `${s}${Math.abs(n).toFixed(digits)} 百分點`;
}
export function osInt(n) {
  return isNum(n) ? Math.round(n).toLocaleString('zh-TW') : DASH;
}
/** 張 → 萬張（1 位小數，不含單位） */
export function osWan(lots) {
  return isNum(lots) ? (lots / 10_000).toLocaleString('zh-TW', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : DASH;
}
/** 比例（0–1）→ 整數百分比字串 */
export function osRatioPct(r) {
  return isNum(r) ? `${Math.round(r * 100)}%` : DASH;
}
/** 'HH:MM:SS' → 'HH:MM' */
export const hm = T => (typeof T === 'string' && T.length >= 5 ? T.slice(0, 5) : DASH);

// ── 狀態文字 ───────────────────────────────────────────────────────────────

function cellWords(cell) {
  if (!cell) return null;
  const parts = [VOL_WORD[cell.vol] ?? (cell.vol === 'pending' ? '量未定' : null), DOM_WORD[cell.dom], DIR_WORD[cell.dir]].filter(Boolean);
  return parts.length ? parts.join('·') : null;
}

/**
 * 'outside:big|all|down' / 'outside:wUnconfirmed:tsmcSolo'（cur、trail）→ { reason, cell, sub }。
 * 計次文件與 outside.cells 用 Firestore 欄位安全的格鍵（| → _、: → -，daemon cellKey）：'big_all_down'、'wUnconfirmed-tsmcSolo' 也收。
 */
function parseOutsideKey(key) {
  const rest = (key.startsWith('outside:') ? key.slice(8) : '').replace(/_/g, '|').replace(/-/g, ':');
  if (!rest) return { reason: null, cell: null, sub: null };
  if (rest.includes('|')) {
    const [vol, dom, dir] = rest.split('|');
    return { reason: 'cell', cell: { vol, dom, dir }, sub: null };
  }
  const [reason, sub] = rest.split(':');
  return { reason, cell: null, sub: sub ?? null };
}

function outsideWord(reason, cell, sub) {
  if (reason === 'wUnstated') return '權值未表態';
  if (reason === 'wUnconfirmed') {
    const s = sub ? (SUB_WORD[sub] ?? sub) : null;
    return s ? `權值未確認·${s}` : '權值未確認';
  }
  return cellWords(cell);
}

/**
 * 狀態 → 畫面文字。state 可以是快照的 state（有 cell、outsideReason）或只有 key／label 的軌跡項。
 * 回 { kind, key, num, lamp, title（第一行）, short（軌跡用）, named }
 */
export function osStateText(state) {
  const key = state?.key ?? null;
  const label = state?.label ?? null;
  if (key && OS_STATES[key]) {
    const s = OS_STATES[key];
    const name = `${CIRCLED[s.num]} ${s.name}`;
    return { kind: 'named', key, num: s.num, lamp: s.lamp, named: true, title: s.num <= 6 ? `${name}（量為估計）` : name, short: `${CIRCLED[s.num]}${s.name}` };
  }
  if (key === 'outside' || (key && key.startsWith('outside:'))) {
    const parsed = key === 'outside' ? { reason: null, cell: null, sub: null } : parseOutsideKey(key);
    const reason = state?.outsideReason ?? parsed.reason;
    const word = outsideWord(reason, state?.cell ?? parsed.cell, state?.sub ?? parsed.sub);
    const title = word ? `不在狀態內（${word}）` : (label && label.startsWith('不在狀態內') ? label : '不在狀態內');
    return { kind: 'outside', key, num: null, lamp: 'gray', named: false, title, short: title };
  }
  if (key === 'volPending') return { kind: 'volPending', key, num: null, lamp: 'gray', named: false, title: '量能未定', short: '量能未定' };
  if (key === 'undetermined') return { kind: 'undetermined', key, num: null, lamp: 'gray', named: false, title: '未判定', short: '未判定' };
  const t = label ?? key ?? DASH;
  return { kind: 'unknown', key, num: null, lamp: 'gray', named: false, title: t, short: t };
}

/** 量未定時的候選（§3.6）：「若量大＝①全面量大上漲；若量縮＝不在狀態內」 */
export function osCandidatesText(cell) {
  if (!cell || !cell.dom || !cell.dir) return null;
  const row = CELL_STATE[`${cell.dom}|${cell.dir}`];
  if (!row) return null;
  const name = k => (k ? `${CIRCLED[OS_STATES[k].num]}${OS_STATES[k].name}` : '不在狀態內');
  return `若量大＝${name(row.big)}；若量縮＝${name(row.small)}`;
}

/** 量未定原因（daemon 以逗號串多個代碼，例 'cBase,q'） */
export function osVolReasonText(reason) {
  if (!reason) return null;
  return reason.split(',').map(r => VOL_REASON_WORD[r.trim()] ?? r.trim()).filter(Boolean).join('、');
}

/** 閘門原因：只有代碼的轉成中文；daemon 的「G1:權值已成交 26/30…」去掉代碼前綴、保留涵蓋數字 */
export function osGateReasonText(r) {
  if (GATE_WORD[r]) return GATE_WORD[r];
  const m = /^G\d+[:：]\s*(.+)$/.exec(r);
  return m ? m[1] : r;
}

// ── 每一行 ─────────────────────────────────────────────────────────────────

/** 一般股上漲比例：有家數就用 上漲÷（上漲＋下跌），否則用 upRatio（0–1） */
function upRatioOf(g) {
  if (isNum(g.up) && isNum(g.down) && g.up + g.down > 0) return g.up / (g.up + g.down);
  return isNum(g.upRatio) ? (g.upRatio > 1 ? g.upRatio / 100 : g.upRatio) : null;
}

/** 第二行：權值30 與上市一般股（事實） */
export function osFactsLine(check) {
  const w = check?.w, g = check?.g;
  const wTxt = w
    ? `權值30 ${osPct(w.pct)}（台積電 ${osPct(w.tsmcPct)}·其餘29檔 ${osInt(w.restUp)}漲${osInt(w.restDown)}跌）`
    : `權值30 ${DASH}`;
  const gTxt = g
    ? `上市一般股中位 ${osPct(g.median)}·上漲 ${osRatioPct(upRatioOf(g))}（已成交 ${osInt(g.fresh)}/${osInt(g.n)}）`
    : `上市一般股 ${DASH}`;
  return `${wTxt}｜${gTxt}`;
}

/** 第三行：上市成交金額（估）與同時段門檻、量大／量縮（量未定寫原因） */
export function osVolLine(check) {
  const v = check?.vol;
  if (!v) return null;
  const T = hm(check.T);
  const parts = [];
  if (v.label === 'pending') parts.push(`量能未定（${osVolReasonText(v.reason) ?? '輸入缺漏'}）`);
  else if (v.label) parts.push(VOL_WORD_EST[v.label]);
  if (isNum(v.vHatYi)) parts.push(`上市成交金額（估）${T} 累計約 ${osInt(v.vHatYi)} 億`);
  if (isNum(v.estYi) && isNum(v.H)) {
    const cmp = v.estYi >= v.H ? '≥' : '<';
    parts.push(`全日（估）${osInt(v.estYi)} 億 ${cmp} 門檻 ${osInt(v.H)} 億${isNum(v.segThYi) ? `（同時段 ${osInt(v.segThYi)} 億）` : ''}`);
  } else if (isNum(v.H)) {
    parts.push(`門檻 ${osInt(v.H)} 億${isNum(v.segThYi) ? `（同時段 ${osInt(v.segThYi)} 億）` : ''}`);
  }
  if (v.gapDay) parts.push('大跳空日');
  return parts.length ? parts.join('｜') : null;
}

/** 第四行：上市成交量（實，張→萬張）與開盤競價量 */
export function osVolRealLine(check, aucLots = null) {
  const v = check?.vol;
  const lots = v?.q?.lots;
  const auc = isNum(v?.qAucLots) ? v.qAucLots : aucLots;
  if (!isNum(lots) && !isNum(auc)) return null;
  const parts = [];
  if (isNum(lots)) parts.push(`上市成交量（實）${hm(check.T)} 累計 ${osWan(lots)} 萬張`);
  if (isNum(auc)) parts.push(`開盤競價 ${osWan(auc)} 萬張`);
  return parts.join('｜');
}

/** 有效開盤與失真（§5.5）：「有效開盤 加權 +2.18%（09:02）→ 修正 +2.31%（09:10，09:02 後開出 3 檔）｜官方開盤 +0.20%（失真；個股開盤合成 +1.78%）」 */
export function osOpenLine(doc) {
  const e = doc?.checks?.e;
  if (!e || !e.tse || !isNum(e.tse.pct)) return null;
  const at = e.tse.revealAt != null ? hhmmss(e.tse.revealAt).slice(0, 5) : '09:02';
  let txt = `有效開盤 加權 ${osPct(e.tse.pct)}（${at}）`;
  const corr = (doc.eCorr?.tse ?? []).filter(r => r.T && isNum(r.pct));
  const last = corr[corr.length - 1];
  if (last && Math.abs(last.pct - e.tse.pct) >= 0.005) {
    txt += `→ 修正 ${osPct(last.pct)}（${hm(last.T)}${isNum(last.nOpened) ? `，09:02 後開出 ${osInt(last.nOpened)} 檔` : ''}）`;
  }
  if (isNum(e.officialOpenPct)) {
    txt += `｜官方開盤 ${osPct(e.officialOpenPct)}${e.distorted ? `（失真${isNum(e.oStarPct) ? `；個股開盤合成 ${osPct(e.oStarPct)}` : ''}）` : ''}`;
  }
  return txt;
}

function patternLineLabel(l) {
  if (!l) return DASH;
  if (l.status && l.status !== 'ok') return '資料不足';
  if (l.label) return l.label;
  const base = l.key ? (PATTERN3_LABEL[l.key] ?? l.key) : DASH;
  return isNum(l.gp) && Math.abs(l.gp) >= 1 ? `大幅${base}` : base;
}

/** 盤型（§6）：「盤型 09:20｜加權 大幅開高·持穩｜櫃買 開高持穩｜一般股中位 開高走低」；09:30 接在後面 */
export function osPatternLine(doc) {
  const out = [];
  for (const k of ['c0920', 'c0930']) {
    const p = doc?.checks?.[k];
    if (!p) continue;
    const T = p.T ? hm(p.T) : (k === 'c0920' ? '09:20' : '09:30');
    const l = p.lines;
    out.push(`盤型 ${T}｜加權 ${patternLineLabel(l.tse)}｜櫃買 ${patternLineLabel(l.otc)}｜一般股中位 ${patternLineLabel(l.gen)}${p.qualifier ? `｜${p.qualifier}` : ''}`);
  }
  return out.length ? out.join('；') : null;
}

/** 軌跡（§9.2）：「09:02 ⑥量大權值漲 → 09:40 ③量縮權值漲 → 10:00 定格」；無資料的檢查點附在後面 */
export function osTrailLine(doc) {
  if (!doc) return null;
  const steps = doc.trail.filter(t => t.kind === 'state').map(t => `${hm(t.T)} ${osStateText(t).short}`);
  if (doc.cur?.final) steps.push(doc.cur.finalBy === 'timeout' ? '10:05 逾時定格' : '10:00 定格');
  const nodata = [];
  for (const k of ['r0910', 'r0920', 'r0930', 'r0940', 'r0950', 'r1000']) {
    const c = checkOf(doc, k);
    if (c?.status === 'nodata') nodata.push(`${k.slice(1, 3)}:${k.slice(3)}`);
  }
  const anyRecheck = Object.values(doc.rechecks ?? {}).some(Boolean);
  if (!anyRecheck && steps.length <= 1 && !nodata.length) return null;   // 09:10 起才出現
  const main = steps.join(' → ');
  return nodata.length ? `${main}${main ? '｜' : ''}無資料 ${nodata.join('、')}` : main || null;
}

/** 未判定：只寫原因與涵蓋數字（§5.6 範例）。daemon 的原因字串已含涵蓋數字；沒有原因時才自己列涵蓋 */
export function osUndeterminedLine(check) {
  if (!check) return null;
  const parts = [`${hm(check.T)} 資料不足，未判定`];
  if (check.reasons.length) {
    parts.push(check.reasons.map(osGateReasonText).join('；'));
  } else {
    const cov = [];
    if (isNum(check.w?.fresh)) cov.push(`權值已成交 ${osInt(check.w.fresh)}/30`);
    if (isNum(check.g?.fresh) && isNum(check.g?.n)) cov.push(`上市一般股已成交 ${osInt(check.g.fresh)}/${osInt(check.g.n)}（門檻 ${osInt(Math.ceil(check.g.n * 0.6))}）`);
    if (isNum(check.g?.revealMed)) cov.push(`揭示中位 ${hhmmss(check.g.revealMed)}`);
    if (cov.length) parts.push(cov.join('；'));
  }
  return parts.join('｜');
}

// ── 區塊整體 ───────────────────────────────────────────────────────────────

/**
 * Z1「開盤結構」區塊的畫面模型。payload＝匯流排的 openSensor（null＝還沒抓到）。
 * phase：loading 讀取中｜wait 今天文件尚未存在、未過 09:05｜missing 該有卻沒有｜ok 有文件
 */
export function openSensorView(payload, nowMs) {
  const base = {
    badge: OS_BADGE, phase: 'loading', lamp: 'none', title: '讀取中', dataT: null, prevLabel: null,
    trail: null, facts: null, vol: null, volReal: null, open: null, pattern: null, note: null, checkKey: null,
  };
  if (!payload) return base;
  const todayNow = taipeiYmd(nowMs);
  const prev = payload.date < todayNow;
  const prevLabel = prev ? `◆ 前交易日 ${payload.date.slice(5).replace('-', '/')}` : null;
  const doc = payload.doc;
  if (!doc) {
    const isToday = payload.date === todayNow && payload.tradingToday;
    if (isToday && taipeiMinuteOfDay(nowMs) < OS_TIMES.deadline) {
      return { ...base, phase: 'wait', title: '09:02 起首判', note: thresholdNote(payload) };
    }
    return {
      ...base, phase: 'missing', prevLabel, title: isToday ? '今日尚無紀錄' : '尚無紀錄',
      note: isToday ? '首判最晚 09:05 寫出；目前沒有今日 openSensor 文件' : `openSensor/${payload.date} 文件不存在`,
    };
  }
  const cur = currentCheck(doc);
  if (!cur) {
    return { ...base, phase: 'missing', prevLabel, title: '尚無檢查點', trail: osTrailLine(doc) };
  }
  const { key, check } = cur;
  const st = osStateText(check.status === 'undetermined' ? { key: 'undetermined' } : check.state);
  const view = {
    ...base, phase: 'ok', prevLabel, checkKey: key, lamp: st.lamp, title: st.title,
    dataT: check.T, trail: osTrailLine(doc), open: osOpenLine(doc), pattern: osPatternLine(doc),
  };
  if (st.kind === 'undetermined') return { ...view, note: osUndeterminedLine(check) };
  const facts = osFactsLine(check);
  const aucLots = doc.c0902?.vol?.qAucLots ?? null;
  return {
    ...view,
    facts: st.kind === 'outside' ? `事實：${outsidePrefix(check)}${facts}` : facts,
    vol: osVolLine(check),
    volReal: osVolRealLine(check, aucLots),
    note: st.kind === 'volPending' ? osCandidatesText(check.state?.cell) : null,
  };
}

/** 不在狀態內的第二行開頭：「量大（估）·全面·跌｜」（§3.7） */
function outsidePrefix(check) {
  const cell = check.state?.cell;
  const vol = check.vol?.label ? VOL_WORD_EST[check.vol.label] : null;
  const parts = [vol, cell?.dom ? DOM_WORD[cell.dom] : null, cell?.dir ? DIR_WORD[cell.dir] : null].filter(Boolean);
  return parts.length ? `${parts.join('·')}｜` : '';
}

/** 首判前的副行：目前門檻 H（openSensorMeta/threshold，事實） */
function thresholdNote(payload) {
  const t = payload.threshold;
  if (!t || !isNum(t.H)) return null;
  return `門檻 H ${osInt(t.H)} 億${isNum(t.m60) ? `（近 60 日上市成交金額中位 ${osInt(t.m60)} 億${t.asOf ? `·至 ${t.asOf.slice(5).replace('-', '/')}` : ''}）` : ''}`;
}

/** 「不在狀態內」各格的本月次數（dates 只保留最近 10 筆 ⇒ 10 筆都在本月時寫「至少」） */
export function osOutsideMonthRows(stats, nowMs) {
  if (!stats) return [];
  const ym = taipeiYmd(nowMs).slice(0, 7);
  return stats.cells.map(c => {
    const inMonth = c.dates.filter(d => d.startsWith(ym));
    const capped = c.dates.length >= 10 && inMonth.length === c.dates.length;
    return { key: c.key, title: osStateText({ key: c.key.startsWith('outside') ? c.key : `outside:${c.key}` }).short, month: inMonth.length, capped, total: c.n, dates: inMonth };
  }).filter(r => r.month > 0 || (r.total ?? 0) > 0);
}
