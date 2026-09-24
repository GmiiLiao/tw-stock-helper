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

import { ledgerOf, twAt } from './sim-ledger.mjs';
import { sizeShares, accountOf, SWING_PER_PICK, SWING_DEFAULT_EXIT_H, SWING_MIN_POSITION } from './sim-account.mjs';

export const SWING_LAB_VERSION = 'ai-swing-lab-v2';   // v2（2026-09-24）：結算附交易單（買賣時間／金額／費稅／淨損益）與防作弊時間戳
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

/** 選股 prompt */
export function buildPickPrompt({ date, pool, market, swingPicksMeta }) {
  return [
    `你是台股波段交易的選股研究員。以下是本站 ${date} 盤後的波段候選池（只能從中挑選），請挑出最適合「波段持有」的股票，最多 ${SWING_MAX_PICKS} 檔；沒有好標的可以少挑或不挑。`,
    `模擬規則：隔一個交易日開盤買進，之後分別看持有 5、10、20、60、120 個交易日的報酬（扣費稅 ${SWING_COST_PCT}%），並與整個候選池的平均比較。`,
    `只能根據提供的資料，不得編造新聞或數字。`,
    ``,
    `【大盤】${market || '未知'}${swingPicksMeta?.bearDay ? '；今日為空頭日（波段起漲訊號在空頭日較可靠）' : ''}${swingPicksMeta?.crowded ? '；⚠ 起漲訊號擁擠（崩盤型），母體已偏離回測' : ''}${swingPicksMeta?.observe ? `；⚠ 起漲訊號目前為觀察閘：${swingPicksMeta.observeWhy || ''}` : ''}`,
    `【本站實證提醒】波段起漲⭐訊號的優勢在第 5 日（持有 5 日淨均約 +1.1%）；追高（RSI5>85）對買方是較差的進場點；20日波動 ≥1.5% 才進場較好；KD 死叉破底風險高。`,
    `【候選池 ${pool.length} 檔】`,
    pool.map(line).join('\n'),
    ``,
    `只輸出 JSON，不要其他文字：`,
    `{"picks":[{"code":"四位數代號","confidence":0到100,"horizon":"你認為最適合的持有期（5/10/20/60/120 擇一）","reason":"50字內選股原因，引用上面的數據","risk":"30字內最大風險"}],"note":"30字內整體看法或不挑的理由"}`,
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

/** 波段帳戶（由記錄重算）：每檔以 position.exitH（AI 指定持有期）為帳戶出場；未到期＝未平倉 */
export function swingAccount(docs, beforeDate = null) {
  const trades = [];
  for (const d of docs) {
    if (beforeDate && !(d.date < beforeDate)) continue;
    for (const p of d.picks || []) {
      const pos = p.position; if (!pos?.shares) continue;
      const o = d.outcomes?.[pos.exitH]?.picks?.find(x => x.code === p.code);
      if (o?.ledger) trades.push({ pnlTwd: o.ledger.pnlTwd });
      else if (o) trades.push({ pnlTwd: 0 });   // 到期但資料缺：以 0 計並在明細註明
      else { const e = d.outcomes?.[5]?.picks?.find(x => x.code === p.code); trades.push({ open: true, cost: Math.round((e?.entryPx || p.priceAtDecision || 0) * pos.shares) }); }
    }
  }
  return accountOf(trades);
}

/** 依可用現金為當天的選股定股數（單筆上限 10 萬、可零股）；以 AI 決定當下的價格計，凍結寫入 */
export function sizePicks(picks, cash) {
  let left = cash;
  return picks.map(p => {
    const budget = Math.max(0, Math.min(left, SWING_PER_PICK));
    const shares = budget >= SWING_MIN_POSITION ? sizeShares(p.priceAtDecision, budget, true) : 0;
    const est = Math.round(shares * (p.priceAtDecision || 0));
    left -= est;
    return { ...p, position: { shares, budget: Math.round(budget), estCost: est, exitH: p.horizon || SWING_DEFAULT_EXIT_H, lots: Math.floor(shares / 1000), oddShares: shares % 1000, ...(shares ? {} : { reason: `資金不足（可用 ${Math.round(budget).toLocaleString()} 元）` }) } };
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
    `- 版本：${doc.version}｜凍結：${doc.frozenAt ? new Date(doc.frozenAt + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) : '—'}｜候選池 ${doc.pool.length} 檔`,
    `- 口徑：D+1 開盤買；持有 ${SWING_HORIZONS.join('／')} 個交易日收盤賣；扣 ${SWING_COST_PCT}%；價格以 priceEvents 還原；基準＝整池等權平均`,
    `- 大盤：${doc.market || '—'}`,
    ``,
    `## 選股（${doc.picks.length} 檔）${doc.note ? `——${doc.note}` : ''}`,
    ``,
    `| 代號 | 名稱 | 信心 | 預期持有 | 選股原因 | 風險 | 來源 |`,
    `|---|---|---|---|---|---|---|`,
    ...doc.picks.map(p => `| ${p.code} | ${p.name} | ${p.confidence} | ${p.horizon ? `${p.horizon} 日` : '—'} | ${p.reason.replace(/\|/g, '／')} | ${p.risk.replace(/\|/g, '／')} | ${(p.sources || []).join('、')} |`),
    ``,
    `## 結算（到期才填，已填不改）`,
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
