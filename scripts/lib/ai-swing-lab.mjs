// ─────────────────────────────────────────────────────────────────────────────
// 🤖 AI 實驗·波段持有（2026-09-24 使用者）：每個交易日盤後由本機 Ollama 依網站提供的資料挑可做波段的股票，
//   模擬買進並記錄選股原因與使用的 LLM 模型；選股當下凍結，之後依 5／10／20／60／120 個交易日逐一結算獲利，
//   做為未來選股模型的參考。純函式（候選池、prompt、解析、結算、統計、Markdown）；I/O 在 ./ai-swing-runner.mjs。
//
// 口徑（寫死、全部記進檔案）：
//   · 決策時點＝資料日 D 收盤後（盤後榜單算完）；**進場＝下一個交易日 D+1 開盤價**（收盤後才決定，買不到 D 的收盤）。
//     D+1 無開盤價（例：全天鎖漲停無成交）⇒ 用 D+1 收盤並標記。
//   · 持有 h 日＝進場日算第 1 天，第 h 個交易日收盤賣出；淨報酬扣 0.4425%（本站波段口徑，手續費未折讓）。
//   · 價格以 priceEvents 係數還原（除權息／減資），與「波段持有」榜同一套；沒有係數的事件股仍可能失真，檔案內註明。
//   · 基準＝同一天丟給 AI 的整個候選池等權平均（同口徑）——AI 有沒有用，看「選中的」有沒有贏「整池」。
//   · 候選池只收網站當天的波段榜單（波段起漲＋波段持有整合榜），排除處置股（含已公告待生效）。
// ─────────────────────────────────────────────────────────────────────────────

import { ledgerOf, twAt, FEE_RATE, feeOf } from './sim-ledger.mjs';
import { portfolioState, portfolioSnapshot } from './ai-swing-portfolio.mjs';
import { sizeShares, SWING_DEFAULT_EXIT_H, SWING_MIN_POSITION } from './sim-account.mjs';

export const SWING_LAB_VERSION = 'ai-swing-lab-v3';   // v3（2026-09-28）：帳戶改由 AI 主動操作（每日檢視持股可賣出換股，./ai-swing-portfolio.mjs）；v2：結算附交易單與防作弊時間戳
export const SWING_HORIZONS = Object.freeze([5, 10, 20, 60, 120]);
export const SWING_MAX_PICKS = 5;
export const SWING_POOL_MAX = 30;
export const SWING_COST_PCT = 0.4425;

const f1 = v => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(+v).toFixed(1)}`);

/** 候選池：波段起漲（全部）＋波段持有整合榜（前段），去重、排除處置股，最多 30 檔 */
export function buildPool({ swingPicks, swingHold, disp = new Set(), attention = new Set(), news = {}, industry = {} }) {
  const out = new Map();
  for (const it of swingPicks?.items || []) {
    if (disp.has(it.code) || !/^\d{4}$/.test(it.code)) continue;
    out.set(it.code, { code: it.code, name: it.name, price: it.price, chg: it.chg, sources: [`波段起漲${'⭐'.repeat(Math.max(1, it.tier || 1))}`],
      start: { tier: it.tier, rsi5: it.rsi5, rsi10: it.rsi10, volX: it.volX, instT1: it.instT1, vol20: it.vol20, kdState: it.kdState, breakRisk: it.breakRisk, posture60: it.posture60, deepPull: !!it.deepPull } });
  }
  for (const it of swingHold?.combo?.items || []) {
    if (disp.has(it.code) || !/^\d{4}$/.test(it.code)) continue;
    const cur = out.get(it.code) || { code: it.code, name: it.name, price: it.price, chg: null, sources: [] };
    out.set(it.code, { ...cur, sources: [...cur.sources, `波段持有整合榜#${it.rank}（上榜 ${it.boards} 張）`],
      hold: { rank: it.rank, boards: it.boards, gains: it.gains, streak: it.streak, amtM: it.amtM, ma: it.ma } });
  }
  return [...out.values()].slice(0, SWING_POOL_MAX).map(c => ({ ...c, attention: attention.has(c.code), news: news[c.code]?.label || null, industry: industry[c.code] || null }));
}

const line = c => {
  const parts = [`${c.code} ${c.name}${c.industry ? `（${c.industry}）` : ''} 收 ${c.price}${c.chg != null ? ` ${f1(c.chg)}%` : ''}`, `來源：${c.sources.join('、')}`];
  if (c.start) parts.push(`起漲訊號：RSI5 ${c.start.rsi5}／RSI10 ${c.start.rsi10}、量比 ${c.start.volX}x、法人前日 ${c.start.instT1} 張、20日波動 ${c.start.vol20}%、KD ${c.start.kdState}、破底風險 ${c.start.breakRisk}${c.start.deepPull ? '、深回檔' : ''}`);
  if (c.hold) parts.push(`累積漲幅 5日 ${f1(c.hold.gains?.d5)}%／10日 ${f1(c.hold.gains?.d10)}%／20日 ${f1(c.hold.gains?.d20)}%／60日 ${f1(c.hold.gains?.d60)}%、連漲 ${c.hold.streak} 日、日均成交 ${c.hold.amtM} 百萬、站上均線 ${(c.hold.ma || []).filter(Boolean).length}/3`);
  if (c.news) parts.push(`新聞判讀：${c.news}`);
  if (c.attention) parts.push('⚠注意股');
  return `- ${parts.join('｜')}`;
};

const f2 = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}`);
const holdLine = h => `- ${h.code} ${h.name}｜${h.shares.toLocaleString()} 股、${h.buyDate} 以 ${h.buyPx} 買進、最新收盤 ${h.lastPx ?? '—'}（${f2(h.pnlPct)}%）、已持有 ${h.heldDays ?? '—'} 個交易日、持有期間最高 ${f2(h.maxUp)}%／最低 ${f2(h.maxDD)}%`
  + `｜${h.onList ? '今天仍在波段榜上' : '已不在今天的波段榜'}${h.news ? `｜新聞判讀：${h.news}` : ''}${h.disposition ? '｜⚠已列處置股' : ''}｜當初買進理由：${h.reason || '—'}`;

/** 每日決策 prompt：檢視持股（可賣出換股）＋從候選池買進。holdings 空＝只選股 */
export function buildPickPrompt({ date, pool, market, swingPicksMeta, holdings = [], cash = null, equity = null }) {
  return [
    `你是台股波段交易員，管理一個模擬帳戶（起始 50 萬元）。現在是 ${date} 盤後。你的任務是主動操作讓帳戶獲利：檢視現有持股決定續抱或賣出，並從本站今天的波段候選池挑選要買進的股票（最多 ${SWING_MAX_PICKS} 檔，沒有好標的可以不買）。`,
    `交易規則：今天盤後決定，下一個交易日 09:00 開盤成交（買賣都是）。買進手續費 0.1425%，賣出手續費 0.1425%＋證交稅 0.3%——一買一賣約 0.59%，頻繁換股會被成本吃掉，換股要有明確理由（停損、趨勢轉弱、題材消失、有更好的機會）。資金池只有 50 萬＋已實現損益，現金不可為負：可用資金依買進檔數平均分配；成交後 T+2 交割，今天賣出的回收款可抵同一交割日的買進；處置股須以已交割現金預收款；成交時資金不足會自動減量或作廢。`,
    `只能根據提供的資料，不得編造新聞或數字。`,
    ``,
    `【帳戶】${equity != null ? `總值約 ${Math.round(equity).toLocaleString()} 元、` : ''}${cash != null ? `可用現金 ${Math.round(cash).toLocaleString()} 元（不含今天賣出的回收款）` : ''}`,
    `【大盤】${market || '未知'}${swingPicksMeta?.bearDay ? '；今日為空頭日（波段起漲訊號在空頭日較可靠）' : ''}${swingPicksMeta?.crowded ? '；⚠ 起漲訊號擁擠（崩盤型），母體已偏離回測' : ''}${swingPicksMeta?.observe ? `；⚠ 起漲訊號目前為觀察閘：${swingPicksMeta.observeWhy || ''}` : ''}`,
    `【本站實證提醒】波段起漲⭐訊號的優勢在第 5 日（持有 5 日淨均約 +1.1%）；追高（RSI5>85）對買方是較差的進場點；20日波動 ≥1.5% 才進場較好；KD 死叉破底風險高。`,
    `【現有持股 ${holdings.length} 檔】`,
    holdings.length ? holdings.map(holdLine).join('\n') : '（無）',
    `【候選池 ${pool.length} 檔】（已持有的不能重複買）`,
    pool.length ? pool.map(line).join('\n') : '（今天沒有候選）',
    ``,
    `只輸出 JSON，不要其他文字（sells 只能填現有持股，沒要賣就給空陣列）：`,
    `{"sells":[{"code":"四位數代號","reason":"50字內賣出理由，引用上面的數據"}],"picks":[{"code":"四位數代號","confidence":0到100,"horizon":"預期持有期（5/10/20/60/120 擇一）","reason":"50字內買進原因，引用上面的數據","risk":"30字內最大風險"}],"note":"30字內今天的操作思路"}`,
  ].join('\n');
}

/** 解析選股：代號必須在池內、去重、最多 5 檔；格式錯回 null（不猜） */
export function parsePicks(text, poolCodes) {
  const m = text?.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!Array.isArray(j.picks)) return null;
    const seen = new Set(); const picks = [];
    for (const p of j.picks) {
      const code = String(p?.code || '').match(/\d{4}/)?.[0];
      if (!code || !poolCodes.has(code) || seen.has(code)) continue;
      seen.add(code);
      const h = Number(String(p.horizon || '').match(/\d+/)?.[0]);
      picks.push({ code, confidence: Math.max(0, Math.min(100, Math.round(Number(p.confidence) || 0))), horizon: SWING_HORIZONS.includes(h) ? h : null, reason: String(p.reason || '').slice(0, 120), risk: String(p.risk || '').slice(0, 80) });
      if (picks.length >= SWING_MAX_PICKS) break;
    }
    return { picks, note: String(j.note || '').slice(0, 120), rejected: j.picks.length - picks.length };
  } catch { return null; }
}

/**
 * 結算一檔在 h 日的結果。days：還原後「舊→新」[{date, m:{code:[收,量,開,高,低]}}]。
 * 回傳 null＝尚未到期或資料不足（不猜）。
 */
export function horizonOutcome(days, decisionDate, code, h) {
  const d0 = days.findIndex(d => d.date > decisionDate);    // 進場日＝D 之後第一個交易日
  if (d0 < 0 || d0 + h - 1 >= days.length) return null;
  const e = days[d0].m[code]; if (!e) return null;
  let entry = e[2] > 0 ? e[2] : e[0]; const openMissing = !(e[2] > 0);
  if (!(entry > 0)) return null;
  const x = days[d0 + h - 1].m[code]; if (!(x?.[0] > 0)) return null;
  let low = entry, high = entry;
  for (let k = d0; k <= d0 + h - 1; k++) { const r = days[k].m[code]; if (r?.[0] > 0) { low = Math.min(low, r[4] > 0 ? r[4] : r[0]); high = Math.max(high, r[3] > 0 ? r[3] : r[0]); } }
  const net = (x[0] / entry - 1) * 100 - SWING_COST_PCT;
  // 買賣時刻：開盤 09:00（無開盤價改用收盤 13:30）；賣在第 h 日收盤 13:30
  const entryAt = twAt(days[d0].date, openMissing ? '13:30' : '09:00'), exitAt = twAt(days[d0 + h - 1].date, '13:30');
  return { entryDate: days[d0].date, entryAt, entryPx: entry, openMissing, exitDate: days[d0 + h - 1].date, exitAt, exitPx: x[0], net: +net.toFixed(2), maxDD: +((low / entry - 1) * 100).toFixed(2), maxUp: +((high / entry - 1) * 100).toFixed(2) };
}

/** 整池等權基準（同口徑）；池內有結果的檔數也回傳 */
export function poolBaseline(days, decisionDate, codes, h) {
  const xs = codes.map(c => horizonOutcome(days, decisionDate, c, h)).filter(Boolean);
  if (!xs.length) return null;
  return { n: xs.length, avg: +(xs.reduce((a, o) => a + o.net, 0) / xs.length).toFixed(2), win: Math.round(xs.filter(o => o.net > 0).length / xs.length * 100) };
}

/** 跨日統計：每個持有期的 AI 選股 vs 整池 */
/** 交易單（1 張、一般交易稅 0.3%）；decidedAt＝選股凍結時刻，必須早於進場（盤後決定、隔日開盤買） */
export function swingLedger(o, decidedAt, shares = 1000) {
  if (!o?.entryPx || !(shares > 0)) return null;
  return ledgerOf({ side: 'long', entry: { at: o.entryAt, px: o.entryPx }, exit: { at: o.exitAt, px: o.exitPx }, dayTrade: false, decidedAt, shares });
}

/** 波段帳戶（由記錄重算）：自 v3 起由 AI 主動操作——部位在 AI 下賣單後的下一交易日開盤出場（見 ./ai-swing-portfolio.mjs）。
 *  未給日線時只用已寫入的成交記錄（buyFills／sellFills），待 daemon 結算補記。 */
export function swingAccount(docs, beforeDate = null, days = null) {
  return portfolioState(docs, days, beforeDate).account;
}

export const SWING_SIZING_RULE = 'equal-split-no-cap';   // 2026-09-28 起：可用現金依當天選股數平均分配、不設單檔上限

/** 依可用現金為當天的選股定股數（不設單檔上限：剩餘現金÷剩餘檔數、可零股）；以 AI 決定當下的價格計，凍結寫入 */
export function sizePicks(picks, cash, { prefundCash = null } = {}) {
  // prefundCash：處置股（p.prefund）只能用已交割現金（預收款）；其餘可用含同日交割賣出款的資金（T+2 淨額）
  let left = cash, pfLeft = prefundCash ?? cash;
  return picks.map((p, i) => {
    const split = Math.max(0, left / (picks.length - i));
    const budget = p.prefund ? Math.max(0, Math.min(split, pfLeft)) : split;
    // 預算要含買進手續費：以 budget÷(1+費率) 定股數，估計成本＝金額＋手續費
    const shares = budget >= SWING_MIN_POSITION ? sizeShares(p.priceAtDecision, budget / (1 + FEE_RATE), true) : 0;
    const amt = Math.round(shares * (p.priceAtDecision || 0));
    const est = shares ? amt + feeOf(amt, shares) : 0;
    left -= est; if (p.prefund) pfLeft -= est;
    return { ...p, position: { shares, budget: Math.round(budget), estCost: est, sizing: SWING_SIZING_RULE, ...(p.prefund ? { prefund: true } : {}), exitH: p.horizon || SWING_DEFAULT_EXIT_H, lots: Math.floor(shares / 1000), oddShares: shares % 1000, ...(shares ? {} : { reason: `資金不足（可用 ${Math.round(budget).toLocaleString()} 元）` }) } };
  });
}

export function swingStats(docs) {
  const out = {};
  for (const h of SWING_HORIZONS) {
    const picks = [], excess = []; let poolSum = 0, poolN = 0, days = 0, pnlTwd = 0, pnlN = 0;
    for (const d of docs) {
      const o = d.outcomes?.[h]; if (!o) continue;
      days++;
      for (const p of o.picks || []) if (p.net != null) { picks.push(p.net); if (o.pool) excess.push(p.net - o.pool.avg); if (p.ledger) { pnlTwd += p.ledger.pnlTwd; pnlN++; } }
      if (o.pool) { poolSum += o.pool.avg; poolN++; }
    }
    const mean = a => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null);
    out[h] = { pnlTwd: pnlN ? pnlTwd : null, days, n: picks.length, avg: mean(picks), win: picks.length ? Math.round(picks.filter(v => v > 0).length / picks.length * 100) : null, poolAvg: poolN ? +(poolSum / poolN).toFixed(2) : null, excess: mean(excess), beatPool: excess.length ? Math.round(excess.filter(v => v > 0).length / excess.length * 100) : null };
  }
  return out;
}

export function renderSwingMarkdown(doc) {
  const m = doc.model || {};
  const L = [
    `# 🤖 AI 實驗·波段持有 ${doc.date}`,
    ``,
    `- LLM 模型：**${m.name || '未知'}**（${m.family || '—'}·${m.parameterSize || '—'}·${m.quantization || '—'}·digest ${m.digest ? m.digest.slice(0, 12) : '—'}）`,
    `- 版本：${doc.version}｜凍結：${doc.frozenAt ? new Date(doc.frozenAt + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) : '—'}｜候選池 ${(doc.pool || []).length} 檔`,
    `- 口徑：帳戶由 AI 主動操作——盤後決定、下一交易日開盤買賣；研究結算為 D+1 開盤買、持有 ${SWING_HORIZONS.join('／')} 個交易日收盤賣、扣 ${SWING_COST_PCT}%；價格以 priceEvents 還原；基準＝整池等權平均`,
    `- 大盤：${doc.market || '—'}`,
    ``,
    `## 選股（${(doc.picks || []).length} 檔）${doc.note ? `——${doc.note}` : ''}`,
    ``,
    `| 代號 | 名稱 | 信心 | 預期持有 | 選股原因 | 風險 | 來源 |`,
    `|---|---|---|---|---|---|---|`,
    ...(doc.picks || []).map(p => `| ${p.code} | ${p.name} | ${p.confidence} | ${p.horizon ? `${p.horizon} 日` : '—'} | ${(p.reason || "").replace(/\|/g, "／")} | ${(p.risk || "").replace(/\|/g, "／")} | ${(p.sources || []).join('、')} |`),
    ``,
    `## 持股檢視（檢視 ${doc.review?.holdings?.length ?? 0} 檔·賣出 ${doc.review?.sells?.length ?? 0} 檔，下一交易日 09:00 開盤成交）`,
    ``,
    ...(doc.review?.sells?.length ? doc.review.sells.map(x => `- 賣出 ${x.code} ${x.name || ''}（${x.key}）：${x.reason}`) : ['- 全部續抱（或無持股）']),
    ``,
    `## 選股研究結算（同一檔若持有 h 日的結果，量選股眼光；帳戶實際出場以 AI 賣單為準。到期才填，已填不改）`,
    ``,
    `| 持有 | 狀態 | 選股平均 | 整池平均 | 超額 | 明細 |`,
    `|---|---|---|---|---|---|`,
    ...SWING_HORIZONS.map(h => {
      const o = doc.outcomes?.[h];
      if (!o) return `| ${h} 日 | 未到期 | — | — | — | — |`;
      const ps = (o.picks || []).filter(p => p.net != null);
      const avg = ps.length ? ps.reduce((a, p) => a + p.net, 0) / ps.length : null;
      return `| ${h} 日 | ${o.exitDate || '—'} 結算 | ${f1(avg)}% | ${f1(o.pool?.avg)}% | ${avg != null && o.pool ? f1(avg - o.pool.avg) : '—'}pp | ${(o.picks || []).map(p => p.ledger ? `${p.code} 買 ${p.entryDate} ${p.openMissing ? '13:30' : '09:00'} @${p.ledger.buy.px}×1000=${p.ledger.buy.amount.toLocaleString()}元 → 賣 ${p.exitDate} 13:30 @${p.ledger.sell.px}=${p.ledger.sell.amount.toLocaleString()}元·費稅 ${p.ledger.costTwd} 元·淨 ${p.ledger.pnlTwd.toLocaleString()} 元（${f1(p.ledger.retPct)}%）${p.ledger.noLookahead ? '·✓先選後買' : '·⚠時序異常'}` : `${p.code} ${p.note || '—'}`).join('<br>')} |`;
    }),
    ``,
    `> 模擬交易，非實際下單；非投資建議。`,
  ];
  return L.join('\n');
}

/** 波段帳戶快照（持有清單 marked-to-market＋已賣出清單）：委派 ./ai-swing-portfolio.mjs */
export function swingAccountSnapshot(docs, days) {
  return portfolioSnapshot(docs, days);
}

/**
 * 每日戰績：以快照的資料日為鍵 upsert 一列（同一資料日重算就覆蓋，不重複）。
 * 帳戶總值＝現金＋持倉市值（待進場／無價者以成本計）；當日損益＝總值較前一列的變化。
 */
export function upsertHistory(history = [], snap) {
  if (!snap?.dataDate) return history;
  const hs = snap.holdings || [];
  // 只計已進場部位：待進場（委託中）買單的錢還在現金裡（2026-09-29 起不預扣），再加一次會重複計算
  const held = hs.filter(h => h.entryPx);
  const mkt = held.reduce((a, h) => a + (h.mktValue ?? h.cost), 0);
  // 帳戶總值以淨市值計（扣若賣出的手續費＋證交稅；2026-09-29 使用者：金額結算應計入費稅）
  const net = held.reduce((a, h) => a + (h.netValue ?? h.mktValue ?? h.cost), 0);
  const unreal = hs.reduce((a, h) => a + (h.unrealized ?? 0), 0);
  const total = Math.round(snap.account.cash + net);
  const prev = [...history].filter(r => r.date < snap.dataDate).sort((a, b) => a.date.localeCompare(b.date)).pop();
  const row = {
    date: snap.dataDate, holdings: hs.filter(h => h.entryPx).length, pending: hs.filter(h => !h.entryPx).length,
    opened: hs.filter(h => h.entryDate === snap.dataDate && h.entryPx).length + (snap.closed || []).filter(c => c.buy?.at && new Date(c.buy.at + 8 * 3600000).toISOString().slice(0, 10) === snap.dataDate).length,
    closed: (snap.closed || []).filter(c => c.exitDate === snap.dataDate).length,
    closedPnl: (snap.closed || []).filter(c => c.exitDate === snap.dataDate).reduce((a, c) => a + c.pnlTwd, 0),
    realized: snap.account.realized, unrealized: unreal, cash: Math.round(snap.account.cash), mktValue: Math.round(mkt), estSellCost: Math.round(mkt - net), total,
    dayPnl: prev ? total - prev.total : total - snap.account.initial,
    cumRetPct: +((total / snap.account.initial - 1) * 100).toFixed(2),
  };
  return [...history.filter(r => r.date !== snap.dataDate), row].sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
}
