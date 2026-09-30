// ─────────────────────────────────────────────────────────────────────────────
// 🤖 AI 實驗·波段持有：daemon 端執行器（純函式在 ./ai-swing-lab.mjs）
//   pick()：交易日盤後（波段起漲與波段持有兩榜皆為同一資料日時）請 Ollama 檢視持股（可賣出換股）並選股 → 寫一次凍結檔
//           aiSwingLab/{資料日} ＋ second-brain/swing-ai-lab/{資料日}.md／.json（已存在不覆寫）。
//           Ollama 回覆格式錯會重試，當日第 3 次仍失敗才以「失敗」凍結（不讓一次抖動吃掉一天樣本）。
//   settle()：每日對未完成的記錄逐一結算 5／10／20／60／120 日；**每個持有期到期算一次就寫死**，之後不重算。
//   syncNotes()：超級管理員人工檢討 → second-brain/swing-ai-lab/{日}-人工檢討.md。
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropUndefined } from './firestore-clean.mjs';
import { SWING_LAB_VERSION, SWING_HORIZONS, buildPool, buildPickPrompt, horizonOutcome, poolBaseline, renderSwingMarkdown, swingLedger, sizePicks, swingAccountSnapshot, upsertHistory } from './ai-swing-lab.mjs';
import { portfolioState, reviewHoldings, parseDecision, settleFills, estSellProceeds } from './ai-swing-portfolio.mjs';

const MAX_ATTEMPTS = 3;

export function createAiSwingLab({ db, askOllama, log, dir, getModelInfo, loadDays, getRisk, getIndustry }) {
  const attempts = {};
  const col = () => db.collection('aiSwingLab');
  const writeFile = (name, body, overwrite = false) => {
    try { mkdirSync(dir, { recursive: true }); const p = join(dir, name); if (overwrite || !existsSync(p)) writeFileSync(p, body); }
    catch (e) { log('✖ 波段 AI 實驗寫第二大腦:', (e.message || '').slice(0, 80)); }
  };

  return {
    /** 回傳 true＝今天這一格已完成（含已存在）；false＝資料未齊或本次失敗、稍後重試 */
    async pick() {
      const sp = (await db.collection('swingPicks').doc('latest').get()).data();
      const sh = (await db.collection('swingHold').doc('latest').get()).data();
      const date = sh?.dataDate;
      if (!date || sp?.dataDate !== date || sp?.mode !== 'close') return false;   // 兩榜要是同一個收盤資料日
      const ref = col().doc(date);
      if ((await ref.get()).exists) return true;
      const risk = await getRisk();
      if (!risk) { log('⚠ 波段 AI 選股：處置名單取不到或殘缺，稍後重試（不以空名單選股）'); return false; }
      let news = {}; try { const nv = (await db.collection('newsVerdict').doc('latest').get()).data(); const v = nv?.verdictJson ? JSON.parse(nv.verdictJson) : {}; for (const c in v) if (v[c]?.label) news[c] = { label: v[c].label }; } catch { news = {}; }
      let market = null; try { const w = (await db.collection('marketWind').doc('latest').get()).data(); market = w?.direction ? `${w.direction.label}（上漲 ${w.direction.up}／下跌 ${w.direction.down}）` : null; } catch { market = null; }
      const industry = await getIndustry().catch(() => ({}));
      const pool = buildPool({ swingPicks: sp, swingHold: sh, disp: risk.disp, attention: risk.attention, news, industry });
      // v3（2026-09-28）：帳戶由 AI 主動操作——先由記錄＋日線重建持股，交給 AI 檢視續抱／賣出，再決定買進
      const prevDocs = (await col().orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data());
      const days = await loadDays(Math.max(...SWING_HORIZONS) + 15);   // 價格事件讀失敗會拋出 ⇒ 呼叫端稍後重試
      const state = portfolioState(prevDocs, days.length ? days : null, date);
      const openLots = state.lots.filter(l => l.status === 'pending' || l.status === 'held' || l.status === 'selling');
      if (!days.length && openLots.length) { log('⚠ 波段 AI：日線讀不到、無法檢視持股，稍後重試'); return false; }
      const holdings = days.length ? reviewHoldings(state.lots, days, { pool, news, disp: risk.disp }) : [];
      const heldCodes = new Set(openLots.map(l => l.code));
      const lastPxOf = c => days[days.length - 1]?.m[c]?.[0] ?? null;
      const equity = state.account.freeCash + openLots.reduce((a, l) => a + (l.buy && lastPxOf(l.code) ? lastPxOf(l.code) * l.shares : (l.buy?.px ?? l.priceAtDecision ?? 0) * l.shares), 0);
      const model = await getModelInfo();
      const base = { date, version: SWING_LAB_VERSION, model, market, swingMeta: { bearDay: !!sp.bearDay, crowded: !!sp.crowded, observe: !!sp.observe, observeWhy: sp.observeWhy || null }, pool, outcomes: {} };
      const reviewList = holdings.map(h => ({ key: h.key, code: h.code, name: h.name, shares: h.shares, buyPx: h.buyPx, lastPx: h.lastPx, pnlPct: h.pnlPct, heldDays: h.heldDays, onList: h.onList }));
      if (!pool.length && !holdings.length) {
        const doc = { ...base, picks: [], review: { holdings: [], sells: [] }, account: state.account, note: '候選池為空（兩榜皆無可選或皆為處置股）且無持股', prompt: null, raw: null, frozenAt: Date.now() };
        await ref.set(dropUndefined(doc)); writeFile(`${date}.md`, renderSwingMarkdown(doc)); writeFile(`${date}.json`, JSON.stringify(doc, null, 1));
        return true;
      }
      const prompt = buildPickPrompt({ date, pool, market, swingPicksMeta: base.swingMeta, holdings, cash: state.account.freeCash, equity });
      const raw = await askOllama(prompt, { priority: 3, temperature: 0.2 });
      const parsed = parseDecision(raw, new Set(pool.map(c => c.code)), new Set(holdings.map(h => h.code)), heldCodes);
      attempts[date] = (attempts[date] || 0) + 1;
      if (!parsed && attempts[date] < MAX_ATTEMPTS) { log(`⚠ 波段 AI 決策：回覆無法解析（第 ${attempts[date]} 次），稍後重試`); return false; }
      const byCode = new Map(pool.map(c => [c.code, c]));
      const sells = (parsed?.sells || []).map(x => { const h = holdings.find(y => y.code === x.code); return { code: x.code, name: h.name, key: h.key, shares: h.shares, reason: x.reason, estPx: h.lastPx, estProceeds: h.lastPx ? estSellProceeds(h.lastPx, h.shares) : 0 }; });
      // 資金池規則（2026-09-29 使用者：現金不可為負、T+2 交割、處置股需預收款）：
      //   一般買進＝可用現金（扣委託保留）＋今天賣單估計回收款×0.9（同一 T+2 交割日淨額；0.9＝跌停開盤的保守估計）
      //   處置股＝只用已交割現金；成交時 portfolioState 再依實際資金池裁減，現金永不為負
      const cashForBuys = Math.max(0, state.account.freeCash + sells.reduce((a, x) => a + x.estProceeds * 0.9, 0));
      const prefundCash = Math.max(0, state.account.settledCash - state.account.payable - state.account.reservedBuys);   // 處置股：不含任何未交割／未成交的賣出款
      const raw0 = (parsed?.picks || []).map(p => ({ ...p, name: byCode.get(p.code)?.name || p.code, sources: byCode.get(p.code)?.sources || [], priceAtDecision: byCode.get(p.code)?.price ?? null, prefund: risk.disp.has(p.code) }));
      const picks = sizePicks(raw0, cashForBuys, { prefundCash });
      const doc = { ...base, picks, review: { holdings: reviewList, sells }, account: state.account, equityAtDecision: Math.round(equity), cashForBuys: Math.round(cashForBuys),
        note: parsed ? parsed.note : `Ollama 回覆 ${MAX_ATTEMPTS} 次皆無法解析，今日不操作（持股全部續抱）`, rejected: parsed?.rejected ?? null, prompt, raw: raw ? String(raw).slice(0, 3000) : null, frozenAt: Date.now() };
      await ref.set(dropUndefined(doc));
      writeFile(`${date}.md`, renderSwingMarkdown(doc)); writeFile(`${date}.json`, JSON.stringify(doc, null, 1));
      log(`✓ 波段 AI 決策 ${date}（${model?.name || '?'}）：持股 ${holdings.length} 檔 → 賣 ${sells.map(x => x.code).join('、') || '無'}；池 ${pool.length} 檔 → 買 ${picks.filter(p => p.position?.shares).map(p => p.code).join('、') || '無'}`);
      await this.writeAccount(days);
      return true;
    },

    /**
     * 開盤即時成交（2026-09-30 使用者：模擬交易要即時記錄 AI 交易行為，不是盤後再補，要跟真正交易一樣）。
     * 交易日 09:00 後由 daemon 每分鐘呼叫：前一晚凍結的賣單／買單，以**即時報價的今日開盤價**成交並當下寫入
     * buyFills／sellFills（source:'live-open'、quoteAt＝揭示時戳、recordedAt＝記錄時刻）。先賣後買、依資金池裁減（portfolioState）。
     * 報價未齊：09:30 前不動作（回 false，下一分鐘再試）；09:30（deadline）後仍無開盤價 ⇒ 買單作廢、賣單留待下一交易日。
     * 回 true＝今天已處理完（含無委託）。今日已歸檔（盤後）才呼叫則不處理，交給 settle 並標「補記」。
     */
    async executeOpen(today, getLive, { now = Date.now(), deadline = false } = {}) {
      const snap = await col().orderBy('date', 'desc').limit(400).get();
      const docs = snap.docs.map(d => d.data());
      // 只讀 30 日（盤中執行，控制解析量）；未記錄成交的部位若早於視窗 ⇒ 不在這裡猜，交給盤後 settle
      const days = await loadDays(30);
      if (days.length && days[days.length - 1].date >= today) return true;
      const unrec = docs.flatMap(d => (d.picks || []).filter(p => p.position?.shares > 0 && !d.buyFills?.[p.code]).map(() => d.date));
      if (days.length && unrec.some(dt => dt < days[0].date)) { log('⚠ 波段 AI 開盤成交：有未記錄成交的部位早於 30 日視窗，改由盤後結算處理'); return true; }
      const state = portfolioState(docs, days.length ? days : null);
      const need = state.lots.filter(l => l.status === 'pending' || l.status === 'selling');
      if (!need.length) return true;
      const twDay = ts => new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
      const quoteOf = c => { const q = getLive(c); return q && q.open > 0 && q.liveAt && twDay(q.liveAt) === today ? q : null; };
      const missing = need.filter(l => !quoteOf(l.code));
      if (missing.length && !deadline) return false;
      const m = {};
      for (const l of state.lots) {
        if (l.status === 'void' || l.status === 'closed') continue;
        const q = quoteOf(l.code); if (!q) continue;
        m[l.code] = [q.price > 0 ? q.price : q.open, Math.round((q.volume || 0) / 1000), q.open, q.high > 0 ? q.high : q.open, q.low > 0 ? q.low : q.open];
      }
      const daysPlus = [...days, { date: today, m }];
      let n = 0;
      for (const u of settleFills(docs, daysPlus)) {
        const upd = {};
        for (const [k, v] of Object.entries(u.upd)) {
          if (v?.date !== today) { upd[k] = v; continue; }
          const q = getLive(v.code || k.split('.')[1]);
          upd[k] = { ...v, source: 'live-open', quoteAt: q?.revealAt ?? q?.liveAt ?? null, recordedAt: now,
            ...(v.failed ? { reason: '開盤至 09:30 未取得即時開盤價（未成交）' } : {}) };
          n++;
        }
        const d = snap.docs.find(x => x.data().date === u.date); if (d) await d.ref.update(dropUndefined(upd));
      }
      log(`✓ 波段 AI 開盤即時成交 ${today}：${n} 筆（委託 ${need.length}${missing.length ? `，無開盤價 ${missing.length}` : ''}）`);
      await this.writeAccount(daysPlus);
      return true;
    },

    /** 到期才結算；每個持有期只寫一次 */
    async settle() {
      const snap = await col().orderBy('date', 'desc').limit(400).get();
      if (!snap.docs.length) return 0;
      const days = await loadDays(Math.max(...SWING_HORIZONS) + 15);   // 還原後 舊→新
      if (!days.length) return 0;
      // 帳戶成交記錄（v3 主動操作）：買進／AI 賣單在下一交易日開盤成交後寫回決策文件，寫一次不改
      let fills = 0;
      for (const u of settleFills(snap.docs.map(d => d.data()), days)) {
        const d = snap.docs.find(x => x.data().date === u.date); if (!d) continue;
        // 走到這裡＝開盤時沒有即時成交記錄（常駐服務未運行等）：依官方開盤價補記，並明確標示，不冒充即時
        const upd = Object.fromEntries(Object.entries(u.upd).map(([k, v]) => [k, v?.source ? v : { ...v, source: 'archive-open', recordedAt: Date.now(), note: '開盤時未即時記錄（常駐服務未運行），盤後依官方開盤價補記' }]));
        await d.ref.update(dropUndefined(upd)); fills += Object.keys(upd).length;
        log(`⚠ 波段 AI：${u.date} 決策有 ${Object.keys(upd).length} 筆成交於盤後補記（開盤時未即時記錄）`);
      }
      if (fills) log(`✓ 波段 AI 帳戶：補記 ${fills} 筆成交`);
      const open = snap.docs.filter(d => !d.data().settledAll);
      let n = 0;
      for (const d of open) {
        const x = d.data();
        if (days[0].date > x.date) { log(`⚠ 波段 AI 結算：${x.date} 早於歸檔視窗，無法結算`); continue; }
        const upd = {}; const outcomes = { ...(x.outcomes || {}) };
        for (const h of SWING_HORIZONS) {
          if (outcomes[h]) continue;
          const d0 = days.findIndex(v => v.date > x.date);
          if (d0 < 0 || d0 + h - 1 >= days.length) continue;               // 尚未到期
          // 研究用：同部位若持有 h 日的結果（量選股眼光）。v3 起帳戶實際出場＝AI 賣單（account 一律 false）
          const picks = (x.picks || []).map(p => { const o = horizonOutcome(days, x.date, p.code, h); const sh = p.position ? p.position.shares : 1000; const acct = false;
            return o ? { code: p.code, ...o, account: acct, ledger: sh > 0 ? swingLedger(o, p.position?.sizedAt ?? x.frozenAt, sh) : null, ...(sh > 0 ? {} : { note: '資金不足未進場（研究數字仍照算報酬率）' }) } : { code: p.code, net: null, account: acct, note: '該期間資料缺（停牌／下市等）' }; });
          const o = { h, exitDate: days[d0 + h - 1].date, settledAt: Date.now(), picks, pool: poolBaseline(days, x.date, (x.pool || []).map(c => c.code), h) };
          outcomes[h] = o; upd[`outcomes.${h}`] = o; n++;
        }
        if (Object.keys(upd).length) {
          if (SWING_HORIZONS.every(h => outcomes[h])) upd.settledAll = true;
          await d.ref.update(dropUndefined(upd));
          writeFile(`${x.date}-結算.md`, renderSwingMarkdown({ ...x, outcomes }), true);
        }
      }
      if (n) log(`✓ 波段 AI 結算：新增 ${n} 個持有期結果`);
      await this.writeAccount(days);
      return n;
    },

    /** 帳戶快照（持有清單 marked-to-market＋結算清單）→ aiLabAccounts/swing；後台讀這一份 */
    async writeAccount(daysIn = null) {
      try {
        const days = daysIn || await loadDays(Math.max(...SWING_HORIZONS) + 15);
        const docs = (await col().orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data());
        const ref = db.collection('aiLabAccounts').doc('swing');
        const prevHist = (await ref.get()).data()?.history || [];
        const snap = swingAccountSnapshot(docs, days);
        await ref.set(dropUndefined({ ...snap, history: upsertHistory(prevHist, snap) }));   // 每日戰績：每個資料日一列
      } catch (e) { log('✖ 波段帳戶快照:', (e.message || '').slice(0, 80)); }
    },

    async syncNotes() {
      const snap = await col().orderBy('date', 'desc').limit(60).get();
      for (const d of snap.docs) {
        const x = d.data();
        if (!x.adminNotesAt || (x.notesSyncedAt && x.notesSyncedAt >= x.adminNotesAt)) continue;
        writeFile(`${x.date}-人工檢討.md`, `# AI 實驗·波段持有 ${x.date}｜人工檢討\n\n- 更新：${new Date(x.adminNotesAt + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16)}（${x.adminBy || '超級管理員'}）\n- 模型：${x.model?.name || '—'}\n\n${x.adminNotes || ''}\n`, true);
        await d.ref.update({ notesSyncedAt: Date.now() });
      }
    },
  };
}
