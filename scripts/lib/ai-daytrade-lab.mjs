// ─────────────────────────────────────────────────────────────────────────────
// 🤖 當沖 AI 實驗（2026-09-24 使用者）：每個交易日盤中由本機 Ollama 依當沖方法挑選標的、做模擬交易，
//   盤後凍結成交易記錄檔（Firestore aiDaytradeLab/{date} ＋ second-brain/daytrade-ai-lab/），
//   並由 AI 寫檢討與改進說明，超級管理員後台查對、可留人工檢討，做為迭代依據。
//
// 本檔只放純函式（prompt、解析、記錄組裝、統計、Markdown），daemon 負責 I/O 與時機。
// 規則：
//   · 決策點＝當沖工作台（scripts/lib/daytrade-setups.mjs）某檔**通過全部否決而觸發**的那一刻；
//     AI 只能在「規則已觸發」的名單裡決定做或不做——不能自己發明進場點（避免事後諸葛）。
//   · 額度：做多、做空各最多 5 筆（含等待回覆中的），全天最多 10 筆；12:30 後不再提新單（同工作台）。
//   · 模擬成交：進場價＝AI 回覆當下的即時價（記錄與觸發價的差＝決策延遲成本）；AI 回覆超過 3 分鐘視為錯過、不成交。
//     出場沿用工作台規則（結構停損／1R 保本／2R 追蹤／3R／VWAP／時間停損／13:20 沖銷）的出場時點與價格。
//   · 放棄的觸發也記錄反事實結果（規則照做會怎樣）——才看得出 AI 的「不做」是否有判斷力。
//   · 凍結：盤後 13:40 起產生檢討，寫一次就不再改（frozenAt）；人工檢討另存欄位，不改 AI 原始記錄。
// ─────────────────────────────────────────────────────────────────────────────

import { ledgerOf, planExits, SIM_SHARES } from './sim-ledger.mjs';
import { sizeShares, accountOf, DT_MAX_PER_TRADE } from './sim-account.mjs';

export const AI_LAB_VERSION = 'ai-dt-lab-v3';   // v3（2026-09-30 使用者選 B）：角色由「紀律審核員」改為「以帳戶獲利為目標的交易員」，移除「沒有把握就不做」的引導（v1–v2 三日 37 次觸發全數放棄）；v2：每筆附交易單與防作弊時間戳
export const AI_LAB_QUOTA = Object.freeze({ long: 5, short: 5 });
export const AI_LAB_MAX_LAG_MS = 3 * 60_000;   // AI 回覆逾 3 分鐘：錯過，不成交
export const AI_LAB_COST_PCT = 0.435;           // 日誌口徑成本（與工作台同）

const f2 = v => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
const hhmm = t => (t ? new Date(t + 8 * 3600000).toISOString().slice(11, 16) : '—');
const hhmmss = t => (t ? new Date(t + 8 * 3600000).toISOString().slice(11, 19) : '—');

/** 決策 prompt：只給觸發當下凍結的事實，要求回 JSON */
export function buildDecisionPrompt({ side, code, name, row, trade, quota, taken, evidence, now, lessons = [] }) {
  const L = side === 'long';
  const sc = row.score;
  const items = [...sc.market, ...sc.stock, ...sc.entry].map(i => `- ${i.label}：${i.score == null ? '未知' : `${i.score}/${i.max}`}｜${i.evidence}`).join('\n');
  const ev = evidence?.[side]?.all;
  const lines = [
    `你是台股現股當沖交易員，管理一個 50 萬元的模擬當沖帳戶，目標是讓帳戶獲利。以下是工作台規則剛即時觸發的一個${L ? '做多（先買後賣）' : '做空（先賣後買，本站鏡像延伸、未驗證）'}進場機會（方法：tw-day-trading）。你要決定現在「做」（立即以現價進場，之後依計畫的停損／目標／時間規則出場）或「不做」。`,
    `判斷方式：像真正的交易員一樣，衡量這一筆的勝算與報酬風險比——值得做就做，不值得就不做。做與不做都會被即時記錄，並與實際走勢對照評分。`,
    `只能根據以下資料判斷，不得假設任何未提供的新聞或行情。分數是規則符合度，不是上漲機率。`,
    ``,
    `【時間】${hhmm(now)}（台北）；今日${L ? '做多' : '做空'}額度已用 ${taken}/${quota}`,
    `【標的】${code} ${name}；現價 ${row.m.c}（${f2(row.m.chg)}%），VWAP ${row.m.vwap ?? '未知'}（乖離 ${f2(row.m.vwapDev)}%）`,
    `【觸發】${trade.type}：${trade.why}`,
    `【計畫】進場 ${trade.entry}、結構停損 ${trade.stop}、每股風險 1R=${trade.d}、目標 1R/2R/3R＝${trade.targets.join('／')}；成本約 ${trade.costR}R`,
    `【警訊】${row.warnings.length ? row.warnings.join('、') : '無'}`,
    `【規則符合度】${sc.total}/${sc.knownMax}${sc.missing.length ? `（缺：${sc.missing.join('、')}）` : ''}`,
    items,
    ev ? `【歷史參考】此規則 v1 回放樣本外 n=${ev.teN}、勝率 ${ev.teWin}%、平均 ${ev.teR}R（已扣成本）。這是所有情境的整體平均，個別情境可能更好或更差，請依本筆條件判斷。` : '',
    lessons.length ? `【經驗庫】本筆條件符合本站盤後訓練、前後期一致且顯著的歷史特徵（供參考，不保證未來）：\n${lessons.map(x => `- ${x}`).join('\n')}` : '',
    ``,
    `只輸出一行 JSON，不要其他文字：`,
    `{"decision":"take 或 skip","confidence":0到100的整數,"reason":"30字內主要理由","risk":"20字內最大風險"}`,
  ];
  return lines.filter(x => x !== '').join('\n');
}

/** 解析 AI 回覆：抓第一個 JSON 物件；格式不對回 null（不猜） */
export function parseDecision(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const decision = /take|做/i.test(String(j.decision)) && !/skip|不做/i.test(String(j.decision)) ? 'take' : /skip|不做/i.test(String(j.decision)) ? 'skip' : null;
    if (!decision) return null;
    const conf = Math.max(0, Math.min(100, Math.round(Number(j.confidence) || 0)));
    return { decision, confidence: conf, reason: String(j.reason || '').slice(0, 80), risk: String(j.risk || '').slice(0, 60) };
  } catch { return null; }
}

/** 由工作台日誌條目（出場後）算 AI 模擬成交的結果 */
export function settle(rec, entry) {
  if (!entry?.exit) return rec;
  const s = rec.side === 'long' ? 1 : -1;
  // 出場時刻＝出場那根 1 分 K 的收盤（K 棒時間 t 是該分鐘起點）
  const exitAt = entry.exit.t + 60_000;
  const out = { ...rec, exitAt, exitPx: entry.exit.px, exitReason: entry.exit.reason, ruleNetR: entry.netR, mfeR: entry.mfeR };
  if (rec.status === 'filled') {
    const pct = s * (entry.exit.px / rec.fillPx - 1) * 100 - AI_LAB_COST_PCT;
    // 交易單照工作台出場計畫分批（1R／2R／3R 各 1/3），AI 的 R 由交易單淨損益回推——卡片上的數字彼此一致
    const sh = rec.shares || SIM_SHARES;   // 帳戶定的股數（v2 前的記錄沒有 ⇒ 以 1 張計）
    out.ledger = ledgerOf({ side: rec.side, entry: { at: rec.fillAt ?? rec.decidedAt, px: rec.fillPx }, exits: planExits({ fills: entry.fills || [], exitAt, exitPx: entry.exit.px, shares: sh }), dayTrade: true, decidedAt: rec.decidedAt ?? null, shares: sh });
    out.aiNetPct = out.ledger ? out.ledger.retPct : +pct.toFixed(2);
    out.aiNetR = out.ledger && rec.d > 0 ? +(out.ledger.pnlTwd / (rec.d * sh)).toFixed(2) : null;
  } else if (rec.status === 'skipped' || rec.status === 'missed') {
    // 反事實交易單：規則照做（觸發 K 收盤價進場、同樣分批出場）會怎樣——標明是反事實，不是 AI 的交易
    // 反事實股數＝同樣的單筆上限（25 萬、整張）；買不起 1 張就不開反事實單，寫明原因
    const csh = sizeShares(rec.triggerPx, DT_MAX_PER_TRADE, false);
    if (csh > 0) out.cfLedger = ledgerOf({ side: rec.side, entry: { at: rec.triggerAt + 60_000, px: rec.triggerPx }, exits: planExits({ fills: entry.fills || [], exitAt, exitPx: entry.exit.px, shares: csh }), dayTrade: true, shares: csh });
    else out.cfNote = `單筆上限 ${DT_MAX_PER_TRADE.toLocaleString()} 元買不起 1 張（${Math.round(rec.triggerPx * 1000).toLocaleString()} 元），不開反事實單`;
  }
  return out;
}

/** 帳戶（由記錄重算）：base＝今天以前的已實現損益累計後的淨值起點 */
export function dtAccount(records, pastRealized = 0) {
  const trades = records.filter(r => r.status === 'filled').map(r => (r.ledger ? { pnlTwd: r.ledger.pnlTwd } : { open: true, cost: Math.round((r.fillPx || 0) * (r.shares || SIM_SHARES)) }));
  const a = accountOf(trades);
  return { ...a, realized: a.realized + pastRealized, equity: a.equity + pastRealized, cash: a.cash + pastRealized, retPct: +(((a.realized + pastRealized) / a.initial) * 100).toFixed(2), pastRealized };
}

/** 統計（每日與累積共用）：AI 做的 vs 不做的（反事實）vs 規則全做 */
export function labStats(records) {
  const grp = xs => {
    const r = xs.map(x => x.ruleNetR).filter(v => v != null);
    const a = xs.map(x => x.aiNetR).filter(v => v != null);
    const mean = v => (v.length ? +(v.reduce((p, q) => p + q, 0) / v.length).toFixed(2) : null);
    const sum = v => (v.length ? v.reduce((p, q) => p + q, 0) : null);
    return { n: xs.length, settled: r.length, ruleAvgR: mean(r), ruleWin: r.length ? Math.round(r.filter(v => v > 0).length / r.length * 100) : null, aiAvgR: mean(a), aiWin: a.length ? Math.round(a.filter(v => v > 0).length / a.length * 100) : null,
      pnlTwd: sum(xs.map(x => x.ledger?.pnlTwd).filter(v => v != null)), cfPnlTwd: sum(xs.map(x => x.cfLedger?.pnlTwd).filter(v => v != null)) };
  };
  const out = {};
  for (const side of ['long', 'short', 'all']) {
    const xs = side === 'all' ? records : records.filter(r => r.side === side);
    out[side] = { taken: grp(xs.filter(r => r.status === 'filled')), skipped: grp(xs.filter(r => r.decision === 'skip')), missed: xs.filter(r => r.status === 'missed' || r.status === 'error').length, allRule: grp(xs) };
  }
  return out;
}

/** 每筆的對錯判定（程式算，AI 不參與）。good=true 做對、false 做錯、null 無法判定 */
export function verdictOf(r) {
  const x = r.ruleNetR;
  if (r.status === 'filled') return r.aiNetR == null ? { good: null, text: 'AI 做·尚未出場' } : r.aiNetR > 0 ? { good: true, text: `AI 做·賺 ${r.aiNetR}R` } : { good: false, text: `AI 做·賠 ${r.aiNetR}R` };
  if (r.status === 'skipped') return x == null ? { good: null, text: 'AI 不做·反事實未知' } : x > 0 ? { good: false, text: `AI 不做·錯失獲利（規則做會 +${x}R）` } : { good: true, text: `AI 不做·避開虧損（規則做會 ${x}R）` };
  if (r.status === 'missed') return { good: x == null ? null : x <= 0, text: `AI 想做但回覆太慢錯過（規則結果 ${x ?? '—'}R）` };
  return { good: null, text: `未決策（${r.status}）` };
}

/** 做對／做錯清單（程式產生；2026-09-24 實測 gemma4 在明確標示下仍把「錯失獲利」寫進「做對」，故對錯不交給 AI） */
export function factsOf(records) {
  const line = r => `${hhmm(r.triggerAt)} ${r.side === 'long' ? '多' : '空'} ${r.code}${r.name} ${r.type}：${verdictOf(r).text}`;
  return { worked: records.filter(r => verdictOf(r).good === true).map(line), failed: records.filter(r => verdictOf(r).good === false).map(line) };
}

/** 盤後檢討 prompt：AI 只寫總評與改進（對錯判定已由程式給定） */
export function buildReviewPrompt(date, records, stats) {
  const verdict = r => verdictOf(r).text;
  const row = r => `- ${hhmm(r.triggerAt)} ${r.side === 'long' ? '多' : '空'} ${r.code}${r.name} ${r.type}｜信心 ${r.confidence ?? '—'}「${r.reason ?? ''}」｜出場 ${r.exitReason ?? '未出場'}｜**判定：${verdict(r)}**`;
  return [
    `你是台股當沖交易的教練。以下是 ${date} 由規則觸發、再由 AI 決定做或不做的模擬交易全紀錄（R＝每股風險，已扣成本）。`,
    `請寫檢討與改進說明，只根據紀錄，不得編造。每筆的「判定」已由程式算好，**不得改寫或反向解讀**（錯失獲利就是判斷錯、避開虧損才是判斷對）。重點：AI 做的是否比不做的好？哪些條件（setup、時段、警訊、分數缺項）反覆出現在虧損？下一個交易日的具體改進（最多 3 條，可檢驗）。`,
    ``,
    records.map(row).join('\n') || '（今日無觸發）',
    ``,
    `統計：AI 做 ${stats.all.taken.n} 筆（平均 ${stats.all.taken.aiAvgR ?? '—'}R）、不做 ${stats.all.skipped.n} 筆（反事實平均 ${stats.all.skipped.ruleAvgR ?? '—'}R）、錯過 ${stats.all.missed} 筆；規則全做平均 ${stats.all.allRule.ruleAvgR ?? '—'}R。`,
    ``,
    `只輸出 JSON，不要其他文字：`,
    `{"summary":"80字內總評（引用上面的判定，不得改寫）","improvements":["下一日可檢驗的改進，最多3條，要寫出可量測的條件"]}`,
  ].join('\n');
}

export function parseReview(text) {
  const m = text?.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const arr = v => (Array.isArray(v) ? v.map(x => String(x).slice(0, 120)).slice(0, 5) : []);
    return { summary: String(j.summary || '').slice(0, 200), improvements: arr(j.improvements).slice(0, 3) };
  } catch { return null; }
}

/** 第二大腦 Markdown（凍結檔） */
export function renderMarkdown(doc) {
  const s = doc.stats?.all;
  const L = [
    `# 🤖 當沖 AI 實驗 ${doc.date}`,
    ``,
    `- 版本：${doc.version}｜模型：${doc.model}｜規則：${doc.deskVersion}｜凍結：${doc.frozenAt ? new Date(doc.frozenAt + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16) : '—'}`,
    `- 額度：做多 ${doc.quota.long}／做空 ${doc.quota.short}；進場價＝AI 回覆當下即時價；回覆逾 3 分鐘不成交；成本 ${AI_LAB_COST_PCT}%`,
    `- AI 做 ${s?.taken.n ?? 0} 筆（平均 ${s?.taken.aiAvgR ?? '—'}R、勝率 ${s?.taken.aiWin ?? '—'}%）｜不做 ${s?.skipped.n ?? 0} 筆（反事實 ${s?.skipped.ruleAvgR ?? '—'}R）｜錯過 ${s?.missed ?? 0}｜規則全做 ${s?.allRule.ruleAvgR ?? '—'}R`,
    ``,
    `## 交易記錄`,
    ``,
    `| 觸發 | 方向 | 代號 | Setup | AI 決定 | 信心 | 理由 | 交易單（1 張·買／賣時間·價·金額·費稅·淨損益） | 規則R | AI R |`,
    `|---|---|---|---|---|---|---|---|---|---|`,
    ...doc.records.map(r => { const L = r.ledger || r.cfLedger; const tag = r.ledger ? 'AI 成交' : r.cfLedger ? '反事實（AI 未做）' : ''; const slip = L ? `${tag}：買 ${hhmmss(L.buy.at)} @${L.buy.px}＝${L.buy.amount.toLocaleString()}元／賣 ${hhmmss(L.sell.at)} @${L.sell.px}＝${L.sell.amount.toLocaleString()}元·費稅 ${L.costTwd} 元·淨 ${L.pnlTwd.toLocaleString()} 元${r.decidedAt ? `·決定 ${hhmmss(r.decidedAt)}` : ''}${L.noLookahead === true ? '·✓先決定後成交' : L.noLookahead === false ? '·⚠時序異常' : ''}` : '—';
      return `| ${hhmm(r.triggerAt)} | ${r.side === 'long' ? '多' : '空'} | ${r.code} ${r.name} | ${r.type} | ${r.decision ?? r.status} | ${r.confidence ?? '—'} | ${(r.reason || '').replace(/\|/g, '／')} | ${slip} | ${r.ruleNetR ?? '—'} | ${r.aiNetR ?? '—'} |`; }),
    ``,
    `## AI 檢討`,
    ``,
    `**做對（程式判定）**`, ...(doc.facts?.worked.length ? doc.facts.worked.map(x => `- ${x}`) : ['- 無']), ``,
    `**做錯（程式判定）**`, ...(doc.facts?.failed.length ? doc.facts.failed.map(x => `- ${x}`) : ['- 無']), ``,
    doc.review ? [`**AI 總評**（AI 撰寫，未經驗證）：${doc.review.summary}`, ``, `**AI 改進建議（下一日檢驗）**`, ...doc.review.improvements.map(x => `- ${x}`)].join('\n') : '（AI 總評產生失敗：Ollama 未回覆或格式錯誤）',
    ``,
    `> 模擬交易，非實際下單；非投資建議。`,
  ];
  return L.join('\n');
}
