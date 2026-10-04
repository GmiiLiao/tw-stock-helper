// ─────────────────────────────────────────────────────────────────────────────
// 🤖 當沖 AI 實驗：daemon 端執行器（I/O、時機、凍結）。純函式在 ./ai-daytrade-lab.mjs。
//   盤中：工作台觸發 → consider()（非同步排入 Ollama 佇列，**不阻塞 5 秒快線**）→ 記錄；tick() 由日誌結算出場。
//   盤中每 30 秒寫 aiDaytradeLab/live（後台可即時查看）；13:40 起 finalize()：AI 檢討 → 寫一次凍結檔
//   aiDaytradeLab/{date} ＋ second-brain/daytrade-ai-lab/{date}.md／.json（已存在就不覆寫）。
//   syncNotes()：超級管理員在後台留的人工檢討，同步成 second-brain/daytrade-ai-lab/{date}-人工檢討.md。
//   v4（2026-10-01 使用者）：每日交易額度（aiLabAccounts/daytradeLimit.limit，預設 100 萬）、AI 決定張數、不限筆數；
//   getRules(code)＝{ disposition, elig }（處置／當沖資格，取不到＝null ⇒ 不交易）；現金超過額度 ⇒ notifyOwner 申請提高，後台核准才生效。
// ─────────────────────────────────────────────────────────────────────────────
import { dtFeatures, matchLessons, lessonText } from './ai-lab-learn.mjs';
import { dropUndefined } from './firestore-clean.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AI_LAB_VERSION, AI_LAB_MAX_LAG_MS, buildDecisionPrompt, parseDecision, settle, labStats, buildReviewPrompt, parseReview, renderMarkdown, factsOf, dtAccount } from './ai-daytrade-lab.mjs';
import { DT_DAILY_LIMIT, limitUsed, limitLeft, maxLots, tradeBlock, limitRequestOf } from './dt-trading-limit.mjs';
import { askWithOutcome, llmNextStep, isInfraFailure, OLLAMA_KIND_LABEL, mergeRecordsById } from './ai-lab-guard.mjs';

const twMin = t => { const d = new Date(t + 8 * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

const LIMIT_TTL_MS = 5 * 60_000;   // 額度設定（後台核准後）5 分鐘內生效
const RESTORE_RETRY_MS = 60_000;   // 接回 live 失敗後，至少隔 1 分鐘再試（writeLive 每 30 秒呼叫）
const REVIEW_MAX_ATTEMPTS = 3;     // 檢討「回覆無法解析」的次數上限（Ollama 連不上不計次，撐到時窗最後一次）

// askOllamaEx（daemon 提供）：回 { text, kind, detail }，分清 Ollama 連不上與回覆看不懂（G4-19）；不給＝舊行為（null 視同看不懂）
export function createAiDaytradeLab({ db, askOllama, askOllamaEx = null, log, getQuote, dir, model, deskVersion, evidence, getModelInfo = async () => null, getLearned = () => null,
  getRules = () => null, notifyOwner = async () => false }) {
  let date = '';
  let records = [];
  // G2-20：live 是否已確認接回（以日期為鍵）。讀 live 失敗時不可從零開始覆寫 live、也不可以殘缺記錄凍結——重試接回，並留 log
  let restoredFor = '', restoreFailAt = 0;
  const reviewTry = {};   // 日期 → { parse, infra }（檢討重試次數）
  let dirty = false, lastWrite = 0;
  let past = { date: '', realized: 0 };   // 今天以前（已凍結各日）AI 成交的已實現損益合計——帳戶淨值起點
  let lim = { value: DT_DAILY_LIMIT, at: 0 };   // 每日交易額度（讀不到沿用上一個值；從未讀到＝預設 100 萬）
  const reset = today => { date = today; records = []; dirty = true; };
  const limitRef = () => db.collection('aiLabAccounts').doc('daytradeLimit');
  const limitDoc = () => ({ limit: lim.value, used: limitUsed(records), left: limitLeft(lim.value, records) });

  return {
    /** 每日開盤前（或重啟後）由凍結記錄重算帳戶起點；當沖帳戶 50 萬、不與波段帳戶互通 */
    /** 回傳 true＝帳戶起點已是今天的；false＝讀取失敗（past 仍是舊值，凍結要放棄、稍後重試·G2-19） */
    async prepareDay(today) {
      await this.refreshLimit();
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

    /** 讀每日交易額度（後台核准提高後寫入）；5 分鐘內不重讀，讀失敗沿用上一個值 */
    async refreshLimit(force = false) {
      if (!force && Date.now() - lim.at < LIMIT_TTL_MS) return lim.value;
      try { const v = (await limitRef().get()).data()?.limit; lim = { value: v > 0 ? v : DT_DAILY_LIMIT, at: Date.now() }; }
      catch (e) { log('✖ 當沖 AI 交易額度讀取:', (e.message || '').slice(0, 60)); }
      return lim.value;
    },

    /** 現金超過交易額度 ⇒ AI 交易員發訊息申請提高（建議額度＝現金×2）；使用者在後台核准後才生效。回傳申請內容或 null */
    async requestLimitIfNeeded(cash) {
      try {
        const cur = (await limitRef().get()).data() || {};
        const limit = cur.limit > 0 ? cur.limit : DT_DAILY_LIMIT;
        const req = limitRequestOf({ cash, limit, last: cur.request || null });
        if (!req) return null;
        const request = { ...req, status: 'pending', at: Date.now() };
        await limitRef().set(dropUndefined({ ...cur, limit, request }));
        const msg = `🤖 當沖 AI 交易員：帳戶現金 ${req.cash.toLocaleString()} 元已超過目前每日交易額度 ${limit.toLocaleString()} 元，申請將額度提高到 ${req.proposed.toLocaleString()} 元（現金×2）。請到後台「AI 實驗 → 當沖」核准或不核准，核准前維持現有額度。`;
        const sent = await notifyOwner(msg).catch(() => false);
        log(`🤖 當沖 AI：申請提高交易額度 ${limit.toLocaleString()} → ${req.proposed.toLocaleString()}（現金 ${req.cash.toLocaleString()}）${sent ? '·已通知' : '·通知未送達（後台仍可核准）'}`);
        return request;
      } catch (e) { log('✖ 當沖 AI 額度申請:', (e.message || '').slice(0, 60)); return null; }
    },

    /**
     * daemon 重啟：接回今日的盤中記錄（等待中的決策已隨行程中斷，標為 error 並寫明）。
     * 回傳 true＝已確認（live 讀到了：是今天就接回、不是今天＝今天尚無記錄）；false＝讀取失敗（不從零開始，稍後由 writeLive／finalize 重試）。
     * 已有記憶體記錄（讀取失敗期間仍有觸發）時與 live 以 id 合併，同一筆取進度較多者——不以較殘缺的版本覆蓋。
     */
    async restore(today) {
      try {
        const d = (await db.collection('aiDaytradeLab').doc('live').get()).data();
        if (d?.date === today && Array.isArray(d.records)) {
          const persisted = d.records.map(r => (r.status === 'pending' && !records.some(x => x.id === r.id) ? { ...r, status: 'error', reason: '常駐服務重啟，決策中斷' } : r));
          const mine = date === today ? records : [];
          date = today;
          records = mergeRecordsById(persisted, mine);
          dirty = true;
          log(`✓ 當沖 AI 實驗：接回今日 ${persisted.length} 筆${mine.length ? `（與記憶體 ${mine.length} 筆合併 → ${records.length} 筆）` : ''}`);
        }
        restoredFor = today; restoreFailAt = 0;
        return true;
      } catch (e) {
        restoreFailAt = Date.now();
        log(`✖ 當沖 AI 實驗：接回今日記錄失敗（${(e?.message || '').slice(0, 60)}）——不從零開始覆寫 live，稍後重試`);
        return false;
      }
    },
    /** 今天的 live 是否已確認接回；未確認且距上次失敗超過 1 分鐘（或 force）就再試一次 */
    async ensureRestored(today, force = false) {
      if (restoredFor === today) return true;
      if (!force && restoreFailAt && Date.now() - restoreFailAt < RESTORE_RETRY_MS) return false;
      return this.restore(today);
    },

    /** 工作台觸發（不 await：Ollama 回覆後自行更新記錄） */
    consider({ side, code, name, row, trade, id, ctxInfo = {} }, today, now = Date.now()) {
      if (date !== today) reset(today);
      if (records.some(r => r.id === id)) return;
      const m = twMin(now);
      const base = {
        id, side, code, name, type: trade.type, why: trade.why, triggerAt: trade.t, triggerPx: trade.entry, stop: trade.stop, d: trade.d, targets: trade.targets,
        score: { total: row.score.total, knownMax: row.score.knownMax, tier: row.score.tier, parts: row.score.parts, missing: row.score.missing }, warnings: row.warnings,
        askedAt: now, decision: null, confidence: null, reason: null, risk: null, status: 'pending', fillPx: null, lagMs: null,
      };
      // 不送 AI 的觸發也寫一行日誌（2026-10-02 使用者：額度用完後日誌整段無聲，看起來像停機）
      const skipNoAi = (status, reason) => { records.push({ ...base, status, reason }); dirty = true; log(`🤖 當沖 AI：${side === 'long' ? '多' : '空'} ${code}${name} ${trade.type} → ${status}（${reason}；未送 AI）`); };
      if (m < 9 * 60 + 5 || m > 12 * 60 + 30) return skipNoAi('out-of-window', '09:05–12:30 以外不提新單');
      // 交易所規則：處置股與非現股當沖標的不交易（做空需可先賣後買）；名單取不到一律不交易——不送 AI
      const block = tradeBlock({ side, ...(getRules(code) || { disposition: null, elig: null }) });
      if (block) return skipNoAi('ineligible', block);
      // 每日交易額度：剩餘額度連 1 張都不夠 ⇒ 當天不再交易（不送 AI；額度累計當天買進金額、平倉不回補——2026-10-02 使用者確認）
      const left = limitLeft(lim.value, records), maxN = maxLots(trade.entry, left);
      if (maxN < 1) return skipNoAi('no-limit', `今日交易額度已用完：剩 ${left.toLocaleString()} 元，1 張約 ${Math.round(trade.entry * 1000).toLocaleString()} 元`);
      records.push({ ...base, limitLeftAtAsk: left, maxLotsAtAsk: maxN }); dirty = true;
      // 🧠 經驗庫（盤後訓練·已驗證）：本筆觸發條件符合哪些歷史風險／優勢特徵（特徵口徑＝訓練用 daytradeJournal 條目）
      let lessons = [];
      try {
        const F = dtFeatures({ side, type: trade.type, minute: trade.minute, entry: trade.entry, d: trade.d, costR: trade.costR, score: row.score, warnings: row.warnings, ...ctxInfo });
        lessons = F ? matchLessons(getLearned(), `dt-${side}`, F.f) : [];
      } catch { lessons = []; }
      if (lessons.length) records[records.length - 1] = { ...records[records.length - 1], lessons: lessons.map(r => r.id) };
      const prompt = buildDecisionPrompt({ side, code, name, row, trade, limit: lim.value, used: lim.value - left, left, maxN, cash: dtAccount(records, past.realized).cash, evidence, now, lessons: lessons.map(r => lessonText(r, '淨R')) });
      askOllama(prompt, { priority: 5, temperature: 0.2 }).then(text => {
        const at = Date.now(); const i = records.findIndex(r => r.id === id); if (i < 0 || date !== today) return;
        const p = parseDecision(text);
        const lag = at - (trade.t + 60_000);   // 自觸發那根 K 收完起算
        let next;
        // decidedAt＝AI 回覆（做出決定）的時刻；成交時刻＝同一刻，成交價＝該刻快線報價並記報價時戳——兩者可查核「先決定、後成交」
        if (!p) next = { ...records[i], status: 'error', reason: text ? `回覆格式錯誤：${String(text).slice(0, 40)}` : 'Ollama 無回覆', lagMs: lag, decidedAt: at };
        else if (p.decision === 'skip') next = { ...records[i], ...p, status: 'skipped', lagMs: lag, decidedAt: at };
        else if (lag > AI_LAB_MAX_LAG_MS) next = { ...records[i], ...p, status: 'missed', lagMs: lag, decidedAt: at, reason: `${p.reason}（回覆延遲 ${Math.round(lag / 1000)} 秒，錯過不成交）` };
        else if (!p.lots) next = { ...records[i], ...p, status: 'error', lagMs: lag, decidedAt: at, reason: `${p.reason}（回覆缺張數 lots，不成交）` };
        else {
          const q = getQuote(code); const px = q?.price > 0 ? q.price : trade.entry;
          const leftNow = limitLeft(lim.value, records);   // 成交當下的剩餘額度（期間其他成交已占用）
          const lots = Math.min(p.lots, maxLots(px, leftNow));
          next = lots > 0
            ? { ...records[i], ...p, status: 'filled', lagMs: lag, decidedAt: at, fillAt: at, fillQuoteAt: q?.revealAt || q?.liveAt || null, fillPx: px, fillSource: q?.price > 0 ? '快線即時價' : '無即時價·用觸發價',
              shares: lots * 1000, lotsAsked: p.lots, limitLeft: leftNow, limitAfter: leftNow - Math.round(px * lots * 1000), cashBefore: Math.round(dtAccount(records, past.realized).cash),
              ...(lots < p.lots ? { sizeNote: `AI 要 ${p.lots} 張、剩餘額度只夠 ${lots} 張` } : {}) }
            : { ...records[i], ...p, status: 'no-limit', lagMs: lag, decidedAt: at, reason: `${p.reason}（額度不足：1 張 ${Math.round(px * 1000).toLocaleString()} 元 > 剩餘 ${leftNow.toLocaleString()} 元，未成交）` };
        }
        records = records.map((r, k) => (k === i ? next : r)); dirty = true;
        log(`🤖 當沖 AI：${side === 'long' ? '多' : '空'} ${code}${name} ${trade.type} → ${next.status}${next.confidence != null ? `(${next.confidence})` : ''}${next.shares ? ` ${next.shares / 1000} 張` : ''}`);
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
      // G2-20：live 尚未確認接回（重啟時讀取失敗）⇒ 先接回並合併；仍失敗就不寫（寫了＝以殘缺記錄蓋掉今天已有的 live）
      if (!(await this.ensureRestored(date))) return;
      dirty = false; lastWrite = Date.now();
      await db.collection('aiDaytradeLab').doc('live').set(dropUndefined({ date, version: AI_LAB_VERSION, model, modelInfo: await getModelInfo(), deskVersion, limit: limitDoc(), updatedAt: Date.now(), records, stats: labStats(records), account: dtAccount(records, past.realized) }));
    },

    /**
     * 盤後凍結（寫一次）。回傳 true＝已完成（含今天本來就凍結過）；false＝稍後重試。
     * lastChance（daemon 給：凍結時窗的最後一輪）：Ollama 連不上時撐到這一輪才以「Ollama 未回應」凍結（G4-19 比照波段）；
     *   live 一直接不回（G2-20）時也只在這一輪才凍結，並明確標記記錄可能殘缺。
     */
    async finalize(today, engine, { lastChance = false } = {}) {
      const ref = db.collection('aiDaytradeLab').doc(today);
      if ((await ref.get()).exists) return true;
      // 帳戶起點讀不到就不凍結（凍結檔寫一次不改，舊起點會永久化）；呼叫端下一輪重試
      if (!(await this.prepareDay(today))) return false;
      // G2-20：今天的 live 沒有確認接回 ⇒ 記憶體記錄可能只是重啟後的一部分，不凍結（最後一輪才以「可能殘缺」凍結）
      const restored = await this.ensureRestored(today, true);
      if (!restored && !lastChance) { log(`⏳ 當沖 AI 實驗凍結 ${today}：今日盤中記錄尚未接回，稍後重試（不以殘缺記錄凍結）`); return false; }
      if (date === today && engine) this.tick(today, engine);
      const recs = date === today ? records : [];
      const stats = labStats(recs);
      let review = null, reviewFailure = null;
      if (recs.length) {
        const t = (reviewTry[today] ||= { parse: 0, infra: 0 });
        const { text, kind, detail } = await askWithOutcome({ askOllama, askOllamaEx }, buildReviewPrompt(today, recs, stats), { priority: 3, temperature: 0.3 });
        const infra = isInfraFailure(kind);
        review = infra ? null : parseReview(text);
        if (infra) t.infra++; else if (!review) t.parse++;
        const step = llmNextStep({ kind, parsedOk: !!review, attempts: t.parse, maxAttempts: REVIEW_MAX_ATTEMPTS, lastChance });
        const why = infra ? `Ollama 未回應（${OLLAMA_KIND_LABEL[kind] || kind}${detail ? `：${String(detail).slice(0, 60)}` : ''}）` : '回覆無法解析';
        if (step === 'retry-infra') { log(`⚠ 當沖 AI 檢討 ${today}：${why}，第 ${t.infra} 次，不計入重試次數，稍後重試`); return false; }
        if (step === 'retry-parse') { log(`⚠ 當沖 AI 檢討 ${today}：回覆無法解析（第 ${t.parse} 次），稍後重試`); return false; }
        if (step !== 'ok') {
          reviewFailure = step === 'freeze-infra' ? { kind: 'ollama-unreachable', cause: kind, detail: detail ? String(detail).slice(0, 120) : null, infraFails: t.infra, parseAttempts: t.parse, at: Date.now() }
            : { kind: 'unparseable', attempts: t.parse, infraFails: t.infra, at: Date.now() };
          log(`⚠ 當沖 AI 檢討 ${today}：${why}${step === 'freeze-infra' ? '，重試至凍結時窗結束仍無回應' : `（${t.parse} 次）`}，凍結檔檢討記為缺`);
        }
      }
      // 無記錄時分清三態（G4-11／G4-23）：工作台有跑但沒觸發／工作台今天沒有盤中紀錄／讀不到工作台記錄＝無法判定
      let reviewNote = reviewFailure ? (reviewFailure.kind === 'ollama-unreachable' ? 'Ollama 未回應（重試至凍結時窗結束），本日檢討缺' : `Ollama 回覆 ${reviewFailure.attempts} 次皆無法解析，本日檢討缺`) : null;
      if (!recs.length) {
        let ran = null;
        try { ran = (await db.collection('daytradeAlerts').doc('live').get()).data()?.date === today; }
        catch (e) { ran = null; log(`⚠ 當沖 AI 凍結 ${today}：讀工作台記錄失敗（${(e?.message || '').slice(0, 60)}），無記錄原因無法判定`); }
        reviewNote = ran === true ? '今日工作台盤中有運行，但沒有規則觸發，無交易可檢討'
          : ran === false ? '今日工作台無盤中紀錄（常駐服務可能未在盤中運行），無交易可檢討'
          : '無法判定今日工作台是否運行（讀取工作台記錄失敗），無交易可檢討';
      }
      const incomplete = restored ? null : { reason: '常駐服務重啟後無法讀回今日盤中記錄（live），凍結檔只含重啟後的記錄，可能殘缺', at: Date.now() };
      if (incomplete) log(`⚠ 當沖 AI 實驗凍結 ${today}：凍結時窗最後一輪仍讀不回 live，以可能殘缺的記錄凍結並標記`);
      const account = dtAccount(recs, past.realized);
      const doc = { date: today, version: AI_LAB_VERSION, model, modelInfo: await getModelInfo(), deskVersion, limit: { limit: lim.value, used: limitUsed(recs), left: limitLeft(lim.value, recs) }, records: recs, stats, account, facts: factsOf(recs), review, reviewNote,
        ...(reviewFailure ? { reviewFailure } : {}), ...(incomplete ? { incomplete } : {}), frozenAt: Date.now() };
      await ref.set(dropUndefined(doc));
      await this.requestLimitIfNeeded(account.cash);   // 收盤結算後：現金超過額度 ⇒ 申請提高（一天最多一次；待審中不重複）
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
