// ─────────────────────────────────────────────────────────────────────────────
// 🤖 當沖 AI 實驗：daemon 端執行器（I/O、時機、凍結）。純函式在 ./ai-daytrade-lab.mjs。
//   盤中：工作台觸發 → consider()（非同步排入 Ollama 佇列，**不阻塞 5 秒快線**）→ 記錄；tick() 由日誌結算出場。
//   盤中每 30 秒寫 aiDaytradeLab/live（後台可即時查看）；13:40 起 finalize()：AI 檢討 → 寫一次凍結檔
//   aiDaytradeLab/{date} ＋ second-brain/daytrade-ai-lab/{date}.md／.json（已存在就不覆寫）。
//   syncNotes()：超級管理員在後台留的人工檢討，同步成 second-brain/daytrade-ai-lab/{date}-人工檢討.md。
// ─────────────────────────────────────────────────────────────────────────────
import { dropUndefined } from './firestore-clean.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_LAB_VERSION, AI_LAB_QUOTA, AI_LAB_MAX_LAG_MS, buildDecisionPrompt, parseDecision, settle, labStats, buildReviewPrompt, parseReview, renderMarkdown, factsOf, dtAccount } from './ai-daytrade-lab.mjs';
import { sizeShares, DT_MAX_PER_TRADE } from './sim-account.mjs';

const twMin = t => { const d = new Date(t + 8 * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

export function createAiDaytradeLab({ db, askOllama, log, getQuote, dir, model, deskVersion, evidence, getModelInfo = async () => null }) {
  let date = '';
  let records = [];
  let dirty = false, lastWrite = 0;
  let past = { date: '', realized: 0 };   // 今天以前（已凍結各日）AI 成交的已實現損益合計——帳戶淨值起點
  const reset = today => { date = today; records = []; dirty = true; };

  const used = side => records.filter(r => r.side === side && (r.status === 'pending' || r.status === 'filled')).length;

  return {
    /** 每日開盤前（或重啟後）由凍結記錄重算帳戶起點；當沖帳戶 50 萬、不與波段帳戶互通 */
    /** 回傳 true＝帳戶起點已是今天的；false＝讀取失敗（past 仍是舊值，凍結要放棄、稍後重試·G2-19） */
    async prepareDay(today) {
      if (past.date === today) return true;
      let realized = 0;
      try {
        const snap = await db.collection('aiDaytradeLab').orderBy('date', 'desc').limit(400).get();
        for (const d of snap.docs) { if (d.id === 'live') continue; const x = d.data(); if (!(x.date < today)) continue; for (const r of x.records || []) if (r.status === 'filled' && r.ledger) realized += r.ledger.pnlTwd; }
        past = { date: today, realized };
        return true;
      } catch (e) { log('✖ 當沖 AI 帳戶起點:', (e.message || '').slice(0, 60)); return false; }
    },
    account() { return dtAccount(records, past.realized); },

    /** daemon 重啟：接回今日的盤中記錄（等待中的決策已隨行程中斷，標為 error 並寫明） */
    async restore(today) {
      try {
        const d = (await db.collection('aiDaytradeLab').doc('live').get()).data();
        if (d?.date === today && Array.isArray(d.records)) {
          date = today;
          records = d.records.map(r => (r.status === 'pending' ? { ...r, status: 'error', reason: '常駐服務重啟，決策中斷' } : r));
          log(`✓ 當沖 AI 實驗：接回今日 ${records.length} 筆`);
        }
      } catch { /* 無則從零開始 */ }
    },

    /** 工作台觸發（不 await：Ollama 回覆後自行更新記錄） */
    consider({ side, code, name, row, trade, id }, today, now = Date.now()) {
      if (date !== today) reset(today);
      if (records.some(r => r.id === id)) return;
      const m = twMin(now);
      const base = {
        id, side, code, name, type: trade.type, why: trade.why, triggerAt: trade.t, triggerPx: trade.entry, stop: trade.stop, d: trade.d, targets: trade.targets,
        score: { total: row.score.total, knownMax: row.score.knownMax, tier: row.score.tier, parts: row.score.parts, missing: row.score.missing }, warnings: row.warnings,
        askedAt: now, decision: null, confidence: null, reason: null, risk: null, status: 'pending', fillPx: null, lagMs: null,
      };
      if (m < 9 * 60 + 5 || m > 12 * 60 + 30) { records.push({ ...base, status: 'out-of-window', reason: '09:05–12:30 以外不提新單' }); dirty = true; return; }
      if (used(side) >= AI_LAB_QUOTA[side]) { records.push({ ...base, status: 'quota', reason: `今日${side === 'long' ? '做多' : '做空'}額度 ${AI_LAB_QUOTA[side]} 已滿` }); dirty = true; return; }
      records.push(base); dirty = true;
      const prompt = buildDecisionPrompt({ side, code, name, row, trade, quota: AI_LAB_QUOTA[side], taken: used(side) - 1, evidence, now });
      askOllama(prompt, { priority: 5, temperature: 0.2 }).then(text => {
        const at = Date.now(); const i = records.findIndex(r => r.id === id); if (i < 0 || date !== today) return;
        const p = parseDecision(text);
        const lag = at - (trade.t + 60_000);   // 自觸發那根 K 收完起算
        let next;
        // decidedAt＝AI 回覆（做出決定）的時刻；成交時刻＝同一刻，成交價＝該刻快線報價並記報價時戳——兩者可查核「先決定、後成交」
        if (!p) next = { ...records[i], status: 'error', reason: text ? `回覆格式錯誤：${String(text).slice(0, 40)}` : 'Ollama 無回覆', lagMs: lag, decidedAt: at };
        else if (p.decision === 'skip') next = { ...records[i], ...p, status: 'skipped', lagMs: lag, decidedAt: at };
        else if (lag > AI_LAB_MAX_LAG_MS) next = { ...records[i], ...p, status: 'missed', lagMs: lag, decidedAt: at, reason: `${p.reason}（回覆延遲 ${Math.round(lag / 1000)} 秒，錯過不成交）` };
        else {
          const q = getQuote(code); const px = q?.price > 0 ? q.price : trade.entry;
          const acct = dtAccount(records, past.realized);   // 成交前的可用現金（淨值－未平倉成本）
          const budget = Math.max(0, Math.min(acct.cash, DT_MAX_PER_TRADE));
          const shares = sizeShares(px, budget, false);
          next = shares > 0
            ? { ...records[i], ...p, status: 'filled', lagMs: lag, decidedAt: at, fillAt: at, fillQuoteAt: q?.revealAt || q?.liveAt || null, fillPx: px, fillSource: q?.price > 0 ? '快線即時價' : '無即時價·用觸發價', shares, budget: Math.round(budget), cashBefore: Math.round(acct.cash) }
            : { ...records[i], ...p, status: 'no-cash', lagMs: lag, decidedAt: at, reason: `${p.reason}（資金不足：1 張 ${Math.round(px * 1000).toLocaleString()} 元 > 可用 ${Math.round(budget).toLocaleString()} 元，未成交）` };
        }
        records = records.map((r, k) => (k === i ? next : r)); dirty = true;
        log(`🤖 當沖 AI：${side === 'long' ? '多' : '空'} ${code}${name} ${trade.type} → ${next.status}${next.confidence != null ? `(${next.confidence})` : ''}`);
      }).catch(() => {});
    },

    /** 每輪快線：由工作台日誌結算已出場者 */
    tick(today, engine) {
      if (date !== today) return;
      let changed = false;
      records = records.map(r => {
        if (r.exitAt || r.status === 'pending') return r;
        const e = engine.journalEntry(r.id);
        if (!e?.exit) return r;
        changed = true; return settle(r, e);
      });
      if (changed) dirty = true;
    },

    async writeLive(force = false) {
      if (!date || (!dirty && !force) || (!force && Date.now() - lastWrite < 30_000)) return;
      dirty = false; lastWrite = Date.now();
      await db.collection('aiDaytradeLab').doc('live').set(dropUndefined({ date, version: AI_LAB_VERSION, model, modelInfo: await getModelInfo(), deskVersion, quota: AI_LAB_QUOTA, updatedAt: Date.now(), records, stats: labStats(records), account: dtAccount(records, past.realized) }));
    },

    /** 盤後凍結（寫一次）。回傳 true＝已完成（含今天本來就凍結過） */
    async finalize(today, engine) {
      const ref = db.collection('aiDaytradeLab').doc(today);
      if ((await ref.get()).exists) return true;
      // 帳戶起點讀不到就不凍結（凍結檔寫一次不改，舊起點會永久化）；呼叫端下一輪重試
      if (!(await this.prepareDay(today))) return false;
      if (date === today && engine) this.tick(today, engine);
      const recs = date === today ? records : [];
      const stats = labStats(recs);
      let review = null;
      if (recs.length) {
        const text = await askOllama(buildReviewPrompt(today, recs, stats), { priority: 3, temperature: 0.3 });
        review = parseReview(text);
        if (!review) log('⚠ 當沖 AI 檢討：Ollama 未回覆或格式錯誤，凍結檔記為缺');
      }
      // 無記錄時分清「工作台有跑但沒觸發」與「工作台今天沒有盤中紀錄」（G4-11）：看 daytradeAlerts/live 是否為今天
      let reviewNote = null;
      if (!recs.length) {
        let ran = false;
        try { ran = (await db.collection('daytradeAlerts').doc('live').get()).data()?.date === today; } catch { ran = false; }
        reviewNote = ran ? '今日工作台盤中有運行，但沒有規則觸發，無交易可檢討' : '今日工作台無盤中紀錄（常駐服務可能未在盤中運行），無交易可檢討';
      }
      const doc = { date: today, version: AI_LAB_VERSION, model, modelInfo: await getModelInfo(), deskVersion, quota: AI_LAB_QUOTA, records: recs, stats, account: dtAccount(recs, past.realized), facts: factsOf(recs), review, reviewNote, frozenAt: Date.now() };
      await ref.set(dropUndefined(doc));
      try {
        mkdirSync(dir, { recursive: true });
        const md = join(dir, `${today}.md`), js = join(dir, `${today}.json`);
        if (!existsSync(md)) writeFileSync(md, renderMarkdown(doc));
        if (!existsSync(js)) writeFileSync(js, JSON.stringify(doc, null, 1));
      } catch (e) { log('✖ 當沖 AI 實驗寫第二大腦:', (e.message || '').slice(0, 80)); }
      log(`✓ 當沖 AI 實驗凍結 ${today}：${recs.length} 筆（做 ${stats.all.taken.n}、不做 ${stats.all.skipped.n}）`);
      return true;
    },

    /** 人工檢討 → 第二大腦（後台寫 adminNotes，這裡同步成檔） */
    async syncNotes() {
      const snap = await db.collection('aiDaytradeLab').orderBy('date', 'desc').limit(30).get();
      for (const d of snap.docs) {
        const x = d.data();
        if (!x.adminNotesAt || (x.notesSyncedAt && x.notesSyncedAt >= x.adminNotesAt)) continue;
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${x.date}-人工檢討.md`), `# 當沖 AI 實驗 ${x.date}｜人工檢討\n\n- 更新：${new Date(x.adminNotesAt + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16)}（${x.adminBy || '超級管理員'}）\n\n${x.adminNotes || ''}\n`);
          await d.ref.update({ notesSyncedAt: Date.now() });
        } catch (e) { log('✖ 人工檢討同步:', (e.message || '').slice(0, 60)); }
      }
    },
  };
}
