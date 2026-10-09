// ─────────────────────────────────────────────────────────────────────────────
// 🤖 AI 實驗·波段持有：daemon 端執行器（純函式在 ./ai-swing-lab.mjs）
//   pick()：交易日盤後（波段起漲與波段持有兩榜皆為同一資料日時）請 Ollama 檢視持股（可賣出換股）並選股 → 寫一次凍結檔
//           aiSwingLab/{資料日} ＋ second-brain/swing-ai-lab/{資料日}.md／.json（已存在不覆寫）。
//           Ollama 回覆格式錯會重試，當日第 3 次仍失敗才以「失敗」凍結（不讓一次抖動吃掉一天樣本）。
//   settle()：每日對未完成的記錄逐一結算 5／10／20／60／120 日；**每個持有期到期算一次就寫死**，之後不重算。
//   syncNotes()：超級管理員人工檢討 → second-brain/swing-ai-lab/{日}-人工檢討.md。
//   account（2026-10-01 會員專屬 AI 交易員）：不給＝超級管理員 50 萬實驗帳戶（路徑、第二大腦、研究結算皆同舊版）；
//     會員：colPath／snapPath 指向 aiSwingMembers/{uid}/…、getSettings() 給 { initial: 0, flows: 入金／提領, goal: 獲利成長目標 % }，
//     files=false（不寫第二大腦）、research=false（不做各持有期研究結算，只補記成交與帳戶快照）。
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropUndefined } from './firestore-clean.mjs';
import { SWING_LAB_VERSION, SWING_HORIZONS, buildPool, buildPickPrompt, buildRepickPrompt, horizonOutcome, poolBaseline, renderSwingMarkdown, swingLedger, sizePicks, swingAccountSnapshot } from './ai-swing-lab.mjs';
import { accountSummary, rebuildHistory } from './ai-swing-history.mjs';
import { portfolioState, reviewHoldings, parseDecision, settleFills, estSellProceeds, lockedAtLimit } from './ai-swing-portfolio.mjs';
import { limitUpPrice } from './tw-limit-price.mjs';
import { twAt } from './sim-ledger.mjs';
import { SWING_MIN_POSITION } from './sim-account.mjs';
import { dailyFeatures, holdingFeatures, matchLessons, lessonText, sumDailyRet } from './ai-lab-learn.mjs';
import { riskTiersOf } from './attention-risk.mjs';
import { validDiscount } from './sim-ledger.mjs';
import { goalProgress } from './ai-lab-member.mjs';
import { verdictJsonOf } from './news-verdict-codec.mjs';   // newsVerdict 新舊格式（明文 verdictJson／壓縮 verdictGz，2026-10-08）
import { askWithOutcome, llmNextStep, isInfraFailure, OLLAMA_KIND_LABEL, isFailureFreeze, twClock, addMinutes } from './ai-lab-guard.mjs';

const MAX_ATTEMPTS = 3;
// G2-24（2026-10-04）：新聞判讀／市況／產業對照「讀取失敗」（丟錯）時稍後重試，最多再試 2 輪；之後照常決策並在凍結檔標記缺哪些輸入。
//   文件不存在（來源本身沒有資料）不重試，只標記。
const INPUT_RETRIES = 2;
// v4：注意／可能達處置名單於盤後傍晚才公布（2026-10-02 的 17:04 選股用到的是前一日名單）。名單日期還沒到資料日、
//   且仍在資料日當晚 19:30 以前 ⇒ 稍後重試；過了就用現有名單並記下哪幾份是舊的（不無限期等，也不假裝是新的）。
const RISK_LIST_DEADLINE_MIN = 19 * 60 + 30;
const RISK_LIST_KEYS = Object.freeze(['twseAttention', 'tpexAttention', 'twseNear', 'tpexNear']);

const twDay = ts => new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
/** 今日即時報價：須有開盤價、且 liveAt 是該日（跨日殘留不算） */
const liveQuoteOf = (getLive, code, date) => { const q = getLive?.(code); return q && q.open > 0 && q.liveAt && twDay(q.liveAt) === date ? q : null; };
/**
 * 盤中暫定日（日線尚未歸檔的那一天）：只放「該日真的有即時報價」的個股——缺報價的不補、不沿用昨收，
 * 以免替尚未記錄的委託捏造成交；收盤歸檔後由正式日線取代（provisional 日不進每日戰績）。
 */
function liveDay(lots, date, getLive) {
  const m = {}; let liveAt = null;
  for (const l of lots) {
    if (l.status === 'void' || l.status === 'closed') continue;
    const q = liveQuoteOf(getLive, l.code, date); if (!q) continue;
    // 第 6 欄＝昨收（現價－漲跌；判斷開盤是否鎖漲跌停用，2026-10-09）；推不出來就不給，改用前一交易日收盤
    const prev = q.price > 0 && Number.isFinite(q.change) ? +(q.price - q.change).toFixed(2) : null;
    m[l.code] = [q.price > 0 ? q.price : q.open, Math.round((q.volume || 0) / 1000), q.open, q.high > 0 ? q.high : q.open, q.low > 0 ? q.low : q.open, ...(prev > 0 ? [prev] : [])];
    liveAt = Math.max(liveAt ?? 0, q.liveAt);
  }
  return { date, m, provisional: true, liveAt };
}
/** 已寫入成交記錄（含作廢）中、成交日晚於 lastDate 者（＝日線尚未歸檔的成交日），舊→新 */
function fillDatesAfter(docs, lastDate) {
  const s = new Set();
  for (const d of docs) for (const k of ['buyFills', 'sellFills']) for (const v of Object.values(d[k] || {})) if (v?.date > lastDate) s.add(v.date);
  return [...s].sort();
}

// getExFactorOf(date)：除權息係數查表（./exright-source.mjs exFactorLookup），持股「近 5 日漲跌合計」用；回 null＝取不到 ⇒ 不顯示 sum5
// askOllamaEx（daemon 提供）：回 { text, kind:'ok'|'connect'|'http'|'timeout'|'empty', detail }——分清「Ollama 連不上」與「回覆看不懂」（G4-19）
// getFreezeGate(date, swingHold, swingPicks)（daemon 提供）：凍結前的兩市到齊閘門 → { ready, missing[] }（G2-30；lib/ai-lab-guard swingFreezeGate）
export function createAiSwingLab({ db, askOllama, askOllamaEx = null, log, dir, getModelInfo, loadDays, getRisk, getIndustry, getLearned = () => null, getExFactorOf = async () => null, getFreezeGate = null, onFreezeFailure = null, account = {}, clock = () => Date.now() }) {
  const { colPath = 'aiSwingLab', snapPath = 'aiLabAccounts/swing', files = true, research = true, label = '', getSettings = null, priority = 3 } = account;
  const attempts = {};      // 資料日 → 「回覆無法解析」次數（計入 MAX_ATTEMPTS）
  const infraFails = {};    // 資料日 → Ollama 連不上／HTTP 錯／逾時次數（不計入額度，只供記錄）
  const inputTries = {};    // 資料日 → 輸入讀取失敗而延後的次數（INPUT_RETRIES）
  const taipeiToday = () => new Date(clock() + 8 * 3600_000).toISOString().slice(0, 10);   // clock：測試可注入
  const taipeiMins = () => { const t = new Date(clock() + 8 * 3600_000); return t.getUTCHours() * 60 + t.getUTCMinutes(); };
  // 同一帳戶的快照依序寫（2026-10-01 審查 LOW：開盤成交、盤後結算、定時重算三個排程各有忙碌旗標，擋不住同帳戶並行——
  //   較舊的計算結果可能蓋掉較新的快照，短暫高估可提領現金）
  let acctLock = Promise.resolve();
  const col = () => db.collection(colPath);
  const snapRef = () => { const i = snapPath.lastIndexOf('/'); return db.collection(snapPath.slice(0, i)).doc(snapPath.slice(i + 1)); };
  const tag = label ? `〔${label}〕` : '';
  /**
   * 帳戶口徑：會員＝起始資金＋資金異動（只計 asOf 當日以前生效的）；實驗帳戶＝{}（50 萬、無異動，與舊版相同）。
   * asOf 早於今天（例：隔日 07:30 以前一交易日收盤決策）時，截止日放寬到今天——決策當下已入金的錢在下一個開盤可用
   * （2026-10-01 審查 MEDIUM：00:00–08:30 首次入金原本被 f.date ≤ 資料日濾掉，當天早上不決策，第一筆交易延後一天）。
   */
  const acctOf = async (asOf = null) => {
    if (!getSettings) return { opts: {}, member: null };
    const st = (await getSettings()) || {};
    const today = taipeiToday(), cutoff = asOf && asOf < today ? today : asOf;
    const flows = (st.flows || []).filter(f => !cutoff || f.date <= cutoff);
    const initial = st.initial ?? 0;
    // feeDiscount：會員自己的券商手續費折讓（2026-10-01 使用者「手續費為使用者的折扣非統一使用2.8折」）；沒設＝無折讓
    const fd = validDiscount(st.feeDiscount);
    return { opts: { initial, flows, ...(fd !== 1 ? { feeDiscount: fd } : {}) },
      member: { capital: initial + flows.reduce((a, f) => a + f.amount, 0), goal: st.goal ?? null, goalDays: st.goalDays ?? null, goalStartDate: st.goalStartDate ?? null, feeDiscount: fd } };
  };
  const writeFile = (name, body, overwrite = false) => {
    if (!files || !dir) return;
    try { mkdirSync(dir, { recursive: true }); const p = join(dir, name); if (overwrite || !existsSync(p)) writeFileSync(p, body); }
    catch (e) { log('✖ 波段 AI 實驗寫第二大腦:', (e.message || '').slice(0, 80)); }
  };

  return {
    /**
     * 回傳 true＝這個資料日已完成（含已存在）；'skip'＝會員尚未投入資金、不必決策（視同完成）；
     *   'expired'＝已過決策時窗仍無決策；'data-not-ready'＝時窗最後一輪資料仍未到齊、已寫失敗凍結（兩者呼叫端記為缺漏，不算決策完成）；
     *   'kept'＝重新決策時已有成功決策（或期間被寫入），未覆蓋；
     * false＝資料未齊或本次失敗、稍後重試。
     * opts（daemon 提供；不給＝舊行為）：
     *   forDay：這一輪應處理的資料日（G2-31：冪等鍵＝資料日）。榜單資料日不等於它就不動作。
     *   deadline：決策時窗終點 'YYYY-MM-DDTHH:MM'（台北；資料日之後下一個交易日 08:30）。Ollama 連不上時撐到最後一次（retryMin 內）才以「Ollama 未回應」凍結。
     *   redecide：手動重新決策——只覆蓋「失敗凍結」（Ollama 未回應／回覆無法解析），成功的決策永不覆蓋；新結果也必須成功才寫。
     */
    async pick({ forDay = null, deadline = null, retryMin = 20, redecide = false } = {}) {
      const sp = (await db.collection('swingPicks').doc('latest').get()).data();
      const sh = (await db.collection('swingHold').doc('latest').get()).data();
      const date = sh?.dataDate;
      if (!date || sp?.dataDate !== date || sp?.mode !== 'close') return false;   // 兩榜要是同一個收盤資料日
      if (forDay && date !== forDay) {
        log(`⏳ 波段 AI 選股${tag}：榜單資料日 ${date} ≠ 本輪應處理的 ${forDay}${date < forDay ? '（今日收盤版尚未產出）' : ''}，稍後重試`);
        return false;
      }
      const ref = col().doc(date);
      const existing = (await ref.get()).data();
      if (existing) {
        if (!redecide) return true;
        if (!isFailureFreeze(existing)) { log(`· 波段 AI 重新決策${tag}：${date} 已有成功的決策（${(existing.note || '').slice(0, 30)}），未覆蓋`); return 'kept'; }
      } else if (redecide) { log(`· 波段 AI 重新決策${tag}：${date} 尚無凍結檔，改走一般決策`); }
      /**
       * 寫凍結檔（審查 L3：daemon 與手動 oneshot 同時跑時，檢查與寫入之間不可被對方插隊）：
       *   一般決策＝ref.create()（已存在就失敗、不覆蓋——不論對方寫的是成功或失敗版）；
       *   重新決策＝transaction 內再讀一次：仍是失敗凍結（或不存在）才覆蓋，並記下被取代者；成功版永不覆蓋。
       *   假物件沒有 create／runTransaction 時退回讀後寫（只供測試）。回傳 true＝已寫；false＝對方已先寫（未覆蓋）。
       */
      const freeze = async doc0 => {
        let doc = doc0;
        if (redecide && existing) {
          const decide = cur => (cur && !isFailureFreeze(cur)) ? null
            : { ...doc0, redecided: { at: Date.now(), replaced: { frozenAt: cur?.frozenAt ?? null, note: cur?.note ?? null, failure: cur?.failure ?? null } } };
          if (typeof db.runTransaction === 'function') {
            doc = await db.runTransaction(async tx => { const d = decide((await tx.get(ref)).data()); if (d) tx.set(ref, dropUndefined(d)); return d; });
          } else { doc = decide((await ref.get()).data()); if (doc) await ref.set(dropUndefined(doc)); }
          if (!doc) { log(`· 波段 AI 重新決策${tag}：${date} 期間已有成功決策，未覆蓋`); return false; }
        } else if (typeof ref.create === 'function') {
          try { await ref.create(dropUndefined(doc)); }
          catch (e) {
            if (e?.code === 6 || /ALREADY_EXISTS|already exists/i.test(String(e?.message || ''))) { log(`· 波段 AI 決策${tag}：${date} 期間已有凍結檔（另一個行程先寫），不覆蓋`); return false; }
            throw e;
          }
        } else await ref.set(dropUndefined(doc));
        writeFile(`${date}.md`, renderSwingMarkdown(doc), redecide); writeFile(`${date}.json`, JSON.stringify(doc, null, 1), redecide);
        return true;
      };
      const nowTw = twClock(clock());
      if (deadline && nowTw >= deadline) {
        log(`⚠ 波段 AI 選股${tag}：${date} 已過決策時窗（${deadline}，下一交易日開盤前），${existing ? '不重新決策' : '當日無決策（不補，避免開盤後才下單）'}`);
        return 'expired';   // 走到這裡＝沒有凍結檔，或重新決策的對象（失敗凍結）——都不覆蓋、不補
      }
      const lastChance = !!deadline && addMinutes(nowTw, retryMin) >= deadline;   // 下一輪就過時窗了 ⇒ 這是最後一次
      // 波段起漲榜須以歸檔收盤算出：priceBasis='snapshot'＝序列末端接了快照偽 K（2026-10-03：平日午夜後曾誤接、量比≈1 整榜清空）
      if (sp?.priceBasis === 'snapshot') { log(`⏳ 波段 AI 選股${tag}：${date} 波段起漲榜仍是快照偽 K 版（歸檔未併入），稍後重試`); return false; }
      // G2-30：凍結檔寫一次不改——收盤歸檔兩市到齊、兩張榜也都是到齊後重算的版本才凍結（上櫃晚到的日子不可只用上市候選池）
      if (getFreezeGate) {
        let g;
        try { g = await getFreezeGate(date, sh, sp); } catch (e) { g = { ready: false, missing: [`閘門讀取失敗 ${(e?.message || '').slice(0, 40)}`] }; }
        if (!g?.ready) {
          const missing = g?.missing?.length ? g.missing : ['未知'];
          if (!lastChance || redecide) { log(`⏳ 波段 AI 選股${tag}：${date} 資料未到齊（${missing.join('、')}），稍後重試、不凍結`); return false; }
          // 審查 M2：決策時窗最後一輪仍未到齊（例：TPEx 整晚連不上）⇒ 寫持久的「資料未到齊」失敗凍結（不以殘缺候選池決策、沒有委託、持股續抱），
          //   之後資料到齊仍可在時窗內以 aiSwingRedecide 取代（isFailureFreeze 涵蓋 failure.kind）
          log(`⚠ 波段 AI 選股${tag}：${date} 至決策時窗結束（${deadline}）資料仍未到齊（${missing.join('、')}），以「資料未到齊」凍結、當日不操作`);
          const doc = { date, version: SWING_LAB_VERSION, model: null, market: null, pool: [], picks: [], review: { holdings: [], sells: [] }, outcomes: {},
            note: `資料未到齊（${missing.join('、')}），至決策時窗結束仍未到齊，今日不操作（持股全部續抱）`,
            failure: { kind: 'data-not-ready', missing, deadline, at: Date.now() }, prompt: null, raw: null, frozenAt: Date.now() };
          const wrote = await freeze(doc);
          if (wrote) { try { await onFreezeFailure?.({ date, kind: 'data-not-ready', missing, label }); } catch { /* 通知失敗不影響凍結 */ } }
          return 'data-not-ready';
        }
      }
      const risk = await getRisk();
      if (!risk) { log('⚠ 波段 AI 選股：處置名單取不到或殘缺，稍後重試（不以空名單選股）'); return false; }
      const asOf = risk.asOf || null;   // 舊介面（測試／其他呼叫端）沒有 asOf ⇒ 不等
      const staleLists = asOf ? RISK_LIST_KEYS.filter(k => !(asOf[k] >= date)) : [];
      if (staleLists.length && taipeiToday() === date && taipeiMins() < RISK_LIST_DEADLINE_MIN) {
        log(`⏳ 波段 AI 選股${tag}：等 ${date} 的注意／可能達處置名單（尚未更新：${staleLists.join('、')}），19:30 前稍後重試`);
        return false;
      }
      const riskTiers = risk.attentionInfo || risk.nearMap ? riskTiersOf({ nearMap: risk.nearMap || null, attentionInfo: risk.attentionInfo || null }) : null;
      // G2-24：輸入讀取失敗不可靜默變成 {}／null——讀取丟錯 ⇒ 稍後重試（最多 INPUT_RETRIES 輪）；文件不存在 ⇒ 只標記
      const inputsMissing = [], readErrors = [];
      let news = {};
      try {
        const nd = await db.collection('newsVerdict').doc('latest').get();
        if (!nd.exists) inputsMissing.push('新聞判讀（newsVerdict/latest 不存在）');
        else { const j = verdictJsonOf(nd.data()); const v = j ? JSON.parse(j) : null; if (!v) inputsMissing.push('新聞判讀（無判讀內容）'); else for (const c in v) if (v[c]?.label) news[c] = { label: v[c].label }; }
      } catch (e) { news = {}; readErrors.push(`新聞判讀（${(e?.message || '讀取失敗').slice(0, 40)}）`); }
      let market = null;
      try {
        const wd = await db.collection('marketWind').doc('latest').get();
        const w = wd.exists ? wd.data() : null;
        market = w?.direction ? `${w.direction.label}（上漲 ${w.direction.up}／下跌 ${w.direction.down}）` : null;
        if (!market) inputsMissing.push(wd.exists ? '市況（無方向資料）' : '市況（marketWind/latest 不存在）');
      } catch (e) { market = null; readErrors.push(`市況（${(e?.message || '讀取失敗').slice(0, 40)}）`); }
      let industry = {};
      try { industry = (await getIndustry()) || {}; if (!Object.keys(industry).length) inputsMissing.push('產業對照（空）'); }
      catch (e) { industry = {}; readErrors.push(`產業對照（${(e?.message || '讀取失敗').slice(0, 40)}）`); }
      if (readErrors.length) {
        inputTries[date] = (inputTries[date] || 0) + 1;
        if (inputTries[date] <= INPUT_RETRIES && !lastChance) { log(`⚠ 波段 AI 選股${tag}：輸入讀取失敗（${readErrors.join('、')}），第 ${inputTries[date]} 次，稍後重試`); return false; }
        log(`⚠ 波段 AI 選股${tag}：輸入讀取仍失敗（${readErrors.join('、')}），照常決策並在凍結檔標記缺漏`);
        inputsMissing.push(...readErrors);
      }
      const pool0 = buildPool({ swingPicks: sp, swingHold: sh, disp: risk.disp, attention: risk.attention, news, industry, riskTiers });
      // v3（2026-09-28）：帳戶由 AI 主動操作——先由記錄＋日線重建持股，交給 AI 檢視續抱／賣出，再決定買進
      //   重新決策時排除被取代的那份失敗凍結檔（它沒有委託，但不讓它參與重建）
      const prevDocs = (await col().orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data()).filter(d => d?.date !== date);
      const days = await loadDays(Math.max(...SWING_HORIZONS) + 15);   // 價格事件讀失敗會拋出 ⇒ 呼叫端稍後重試
      const { opts, member } = await acctOf(date);
      const state = portfolioState(prevDocs, days.length ? days : null, date, opts);
      const openLots = state.lots.filter(l => l.status === 'pending' || l.status === 'held' || l.status === 'selling');
      if (member && !(member.capital > 0) && !openLots.length) return 'skip';   // 會員尚未投入資金、也沒有持股 ⇒ 今天不必決策（入金後 daemon 會重新排入）
      if (!days.length && openLots.length) { log('⚠ 波段 AI：日線讀不到、無法檢視持股，稍後重試'); return false; }
      // 🧠 經驗庫（盤後訓練·已驗證）：以決策日日線特徵比對，候選與持股各自標出符合的歷史風險／優勢（口徑同訓練）
      const learned = getLearned(); const tDec = days.findIndex(d => d.date === date);
      // 候選：波段母體經驗＋AI 買進經驗（swing-buy）；持股：波段母體經驗＋AI 賣出經驗（swing-sell，持股特徵＝已持有天數＋持有報酬）
      //   決策層經驗的來源＝實驗帳戶＋所有會員 AI 帳戶的實際買賣（2026-10-01 使用者；訓練見 scripts/ai-lab-learn.mjs）
      const lessonsOf = (code, hold = null) => {
        if (!learned || tDec < 0) return [];
        try {
          const F = dailyFeatures(days, tDec, code); if (!F) return [];
          const out = matchLessons(learned, 'swing', F.f).map(r => ({ r, key: 'swing' }));
          if (!hold) for (const r of matchLessons(learned, 'swing-buy', F.f)) out.push({ r, key: 'swing-buy' });
          else {
            const H = holdingFeatures(days, tDec, code, { heldDays: hold.heldDays, pnlPct: hold.lastPx > 0 && hold.buyPx > 0 ? (hold.lastPx / hold.buyPx - 1) * 100 : NaN, sum5: hold.sum5 ?? null });
            if (H) for (const r of matchLessons(learned, 'swing-sell', H.f)) out.push({ r, key: 'swing-sell' });
          }
          return out;
        } catch { return []; }
      };
      const withL = (x, hold = null) => { const L = lessonsOf(x.code, hold); return L.length ? { ...x, lessons: L.map(({ r, key }) => lessonText(r, '5日淨%', key)), lessonIds: L.map(({ r, key }) => (key === 'swing' ? r.id : `${key}:${r.id}`)) } : x; };
      const pool = pool0.map(x => withL(x));
      // v4 持股狀態：近 5 日單日漲跌加總（注意股第一款的算法）與處置風險分級——只給 AI 參考，不自動賣出
      //   sum5 以除權息參考價還原（官方口徑）；除權息係數取不到 ⇒ null（不顯示、不進經驗比對）
      const exOf = openLots.length && tDec >= 0 ? await getExFactorOf(date).catch(() => null) : null;
      const holdState = h => ({ ...h, sum5: exOf ? sumDailyRet(days, tDec, h.code, 5, exOf) : null, ...(riskTiers ? { attnRisk: riskTiers[h.code]?.tier ?? null } : {}) });
      const holdings = days.length ? reviewHoldings(state.lots, days, { pool, news, disp: risk.disp, feeDiscount: opts.feeDiscount }).map(h => { const x = holdState(h); return withL(x, x); }) : [];
      const heldCodes = new Set(openLots.map(l => l.code));
      const lastPxOf = c => days[days.length - 1]?.m[c]?.[0] ?? null;
      const equity = state.account.freeCash + openLots.reduce((a, l) => a + (l.buy && lastPxOf(l.code) ? lastPxOf(l.code) * l.shares : (l.buy?.px ?? l.priceAtDecision ?? 0) * l.shares), 0);
      const model = await getModelInfo();
      // attentionAsOf：這次分級用的四份名單各是哪一天的（stale＝過了 19:30 仍未更新、以舊名單決策）
      const base = { date, version: SWING_LAB_VERSION, model, market, swingMeta: { bearDay: !!sp.bearDay, crowded: !!sp.crowded, observe: !!sp.observe, observeWhy: sp.observeWhy || null }, pool, outcomes: {},
        ...(asOf ? { attentionAsOf: { ...Object.fromEntries(RISK_LIST_KEYS.map(k => [k, asOf[k] ?? null])), stale: staleLists } } : {}),
        ...(inputsMissing.length ? { inputsMissing } : {}),
        // G4-25：會員決策當下的設定快照（結構化；事後可查「AI 是依哪一組資金／目標／折讓做的決定」）
        ...(member ? { settings: { asOf: date, capital: member.capital, flowsN: (opts.flows || []).length, goal: member.goal, goalDays: member.goalDays, goalStartDate: member.goalStartDate, feeDiscount: member.feeDiscount } } : {}) };
      const reviewList = holdings.map(h => ({ key: h.key, code: h.code, name: h.name, shares: h.shares, buyPx: h.buyPx, lastPx: h.lastPx, pnlPct: h.pnlPct, heldDays: h.heldDays, onList: h.onList, lessonIds: h.lessonIds,
        sum5: h.sum5 ?? null, ...(riskTiers ? { attnRisk: h.attnRisk ?? null } : {}) }));   // lessonIds：持股套用了哪些經驗（含賣出經驗；無則由 dropUndefined 略去）
      if (!pool.length && !holdings.length) {
        const doc = { ...base, picks: [], review: { holdings: [], sells: [] }, account: state.account, note: '候選池為空（兩榜皆無可選或皆為處置股）且無持股', prompt: null, raw: null, frozenAt: Date.now() };
        return (await freeze(doc)) ? true : (redecide ? 'kept' : true);
      }
      const hist = member ? ((await snapRef().get()).data()?.history || []) : [];
      const cumRetPct = member ? (hist.at(-1)?.cumRetPct ?? null) : null;
      const progress = member?.goal ? goalProgress(hist, { growthTarget: member.goal, goalDays: member.goalDays, goalStartDate: member.goalStartDate }) : null;
      const prompt = buildPickPrompt({ date, pool, market, swingPicksMeta: base.swingMeta, holdings, cash: state.account.freeCash, equity, member: member ? { ...member, cumRetPct, progress } : null });
      const { text: raw, kind, detail } = await askWithOutcome({ askOllama, askOllamaEx }, prompt, { priority, temperature: 0.2 });   // 會員帳戶排在實驗帳戶之後
      const infra = isInfraFailure(kind);
      const parsed = infra ? null : parseDecision(raw, new Set(pool.map(c => c.code)), new Set(holdings.map(h => h.code)), heldCodes);
      if (infra) infraFails[date] = (infraFails[date] || 0) + 1;
      else if (!parsed) attempts[date] = (attempts[date] || 0) + 1;
      const step = llmNextStep({ kind, parsedOk: !!parsed, attempts: attempts[date] || 0, maxAttempts: MAX_ATTEMPTS, lastChance });
      const why = infra ? `Ollama 未回應（${OLLAMA_KIND_LABEL[kind] || kind}${detail ? `：${String(detail).slice(0, 60)}` : ''}）` : '回覆無法解析';
      if (redecide && step !== 'ok') { log(`✖ 波段 AI 重新決策${tag} ${date}：${why}，保留原凍結檔`); return false; }
      if (step === 'retry-infra') { log(`⚠ 波段 AI 決策${tag}：${why}，第 ${infraFails[date]} 次，不計入重試次數；決策時窗至 ${deadline || '下一交易日開盤前'}，稍後重試`); return false; }
      if (step === 'retry-parse') { log(`⚠ 波段 AI 決策${tag}：回覆無法解析（第 ${attempts[date]} 次），稍後重試`); return false; }
      // 失敗凍結：原因分清（連不上 vs 看不懂），可在時窗內以手動重新決策取代
      const failure = step === 'freeze-infra' ? { kind: 'ollama-unreachable', cause: kind, detail: detail ? String(detail).slice(0, 120) : null, infraFails: infraFails[date], parseAttempts: attempts[date] || 0, deadline, at: Date.now() }
        : step === 'freeze-parse' ? { kind: 'unparseable', attempts: attempts[date] || 0, infraFails: infraFails[date] || 0, at: Date.now() } : null;
      const byCode = new Map(pool.map(c => [c.code, c]));
      const sells = (parsed?.sells || []).map(x => { const h = holdings.find(y => y.code === x.code); return { code: x.code, name: h.name, key: h.key, shares: h.shares, reason: x.reason, estPx: h.lastPx, estProceeds: h.lastPx ? estSellProceeds(h.lastPx, h.shares, opts.feeDiscount) : 0 }; });
      // 資金池規則（2026-09-29 使用者：現金不可為負、T+2 交割、處置股需預收款）：
      //   一般買進＝可用現金（扣委託保留）＋今天賣單估計回收款×0.9（同一 T+2 交割日淨額；0.9＝跌停開盤的保守估計）
      //   處置股＝只用已交割現金；成交時 portfolioState 再依實際資金池裁減，現金永不為負
      const cashForBuys = Math.max(0, state.account.freeCash + sells.reduce((a, x) => a + x.estProceeds * 0.9, 0));
      const prefundCash = Math.max(0, state.account.settledCash - state.account.payable - state.account.reservedBuys);   // 處置股：不含任何未交割／未成交的賣出款
      const raw0 = (parsed?.picks || []).map(p => ({ ...p, name: byCode.get(p.code)?.name || p.code, sources: byCode.get(p.code)?.sources || [], priceAtDecision: byCode.get(p.code)?.price ?? null, prefund: risk.disp.has(p.code) }));
      const picks = sizePicks(raw0, cashForBuys, { prefundCash, feeDiscount: opts.feeDiscount });
      const doc = { ...base, picks, review: { holdings: reviewList, sells }, account: state.account, equityAtDecision: Math.round(equity), cashForBuys: Math.round(cashForBuys),
        note: parsed ? parsed.note
          : failure?.kind === 'ollama-unreachable' ? `${why}，重試至決策時窗結束仍無回應，今日不操作（持股全部續抱）`
          : `Ollama 回覆 ${attempts[date] || MAX_ATTEMPTS} 次皆無法解析，今日不操作（持股全部續抱）`,
        ...(failure ? { failure } : {}), rejected: parsed?.rejected ?? null, prompt, raw: raw ? String(raw).slice(0, 3000) : null, frozenAt: Date.now() };
      if (!(await freeze(doc))) return redecide ? 'kept' : true;
      log(`✓ 波段 AI 決策${tag} ${date}（${model?.name || '?'}）：持股 ${holdings.length} 檔 → 賣 ${sells.map(x => x.code).join('、') || '無'}；池 ${pool.length} 檔 → 買 ${picks.filter(p => p.position?.shares).map(p => p.code).join('、') || '無'}`);
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
      const { opts } = await acctOf();
      const state = portfolioState(docs, days.length ? days : null, null, opts);
      const need = state.lots.filter(l => l.status === 'pending' || l.status === 'selling');
      if (!need.length) return true;
      const missing = need.filter(l => !liveQuoteOf(getLive, l.code, today));
      if (missing.length && !deadline) return false;
      const daysPlus = [...days, liveDay(state.lots, today, getLive)];
      // 開盤鎖漲停（2026-10-09 使用者：一字漲停買不到時委託日不可設為已買到，並讓 AI 當天重新選買）：
      //   09:30 前仍鎖在漲停的買單＝排隊中，先不寫（之後打開就以漲停價成交）；09:30 仍鎖住 ⇒ 記未成交、取消委託，並觸發 AI 當天重選。
      //   賣單遇開盤鎖跌停：nextFill 視同當日無法成交、不寫，排隊到收盤（盤後 settle 依官方日線：打開過就以跌停價成交，一字跌停順延隔日）。
      const dLive = daysPlus.length - 1;
      const stillLocked = need.filter(l => l.status === 'pending' && lockedAtLimit(daysPlus, dLive, l.code, 'buy'));
      let n = 0; const lockedFailed = [];
      for (const u of settleFills(docs, daysPlus, opts)) {
        const upd = {};
        for (const [k, v] of Object.entries(u.upd)) {
          if (v?.date !== today) { upd[k] = v; continue; }
          if (v.locked === 'limit-up' && !deadline) continue;   // 09:30 前：排隊中，下一分鐘再看
          const q = getLive(v.code || k.split('.')[1]);
          upd[k] = { ...v, source: 'live-open', quoteAt: q?.revealAt ?? q?.liveAt ?? null, recordedAt: now,
            ...(v.failed ? { reason: v.locked === 'limit-up' ? '開盤即鎖漲停、至 09:30 仍未打開：委託未成交並取消（AI 當天重選）' : '開盤至 09:30 未取得即時開盤價（未成交）' } : {}) };
          if (v.locked === 'limit-up') lockedFailed.push({ date: u.date, code: k.split('.')[1] });
          n++;
        }
        if (!Object.keys(upd).length) continue;
        const d = snap.docs.find(x => x.data().date === u.date); if (d) await d.ref.update(dropUndefined(upd));
      }
      const waiting = deadline ? [] : stillLocked;
      log(`✓ 波段 AI 開盤即時成交${tag} ${today}：${n} 筆（委託 ${need.length}${missing.length ? `，無開盤價 ${missing.length}` : ''}${waiting.length ? `，鎖漲停排隊中 ${waiting.map(l => l.code).join('、')}` : ''}${lockedFailed.length ? `，鎖漲停未成交 ${lockedFailed.map(x => x.code).join('、')}` : ''}）`);
      // 帳戶快照：今天只執行已寫入的成交（recordedOnly）——排隊中的鎖漲停委託不提前顯示成作廢
      await this.writeAccount([...days, { ...liveDay(state.lots, today, getLive), recordedOnly: true }]);
      if (lockedFailed.length) {
        try { await this.repickLocked(today, lockedFailed, getLive, { now }); }
        catch (e) { log(`✖ 波段 AI 鎖漲停重選${tag}:`, (e.message || '').slice(0, 80)); }
      }
      return waiting.length === 0;   // 還有排隊中的鎖漲停 ⇒ 回 false，daemon 下一分鐘再試（09:30 起以 deadline 收尾）
    },

    /**
     * 開盤鎖漲停買不到 → AI 當天重選（2026-10-09 使用者裁定：盤中 09:30 確認後當天重選）。
     * failedList＝[{ date: 決策日, code }]。每份決策文件只重選一次（寫 d.repick；已存在就跳過）。
     * 候選＝該決策文件的候選池，排除：持有／委託中、該決策原本選過的、現在鎖在漲停、沒有今日即時報價者。
     * 資金＝原委託預算合計，上限為現金扣除委託保留；以重選當下的即時價成交並寫入 buyFills（source:'live-repick'）。
     * Ollama 連不上或回覆看不懂 ⇒ 記下原因、今天不重選（資金留到盤後決策）；不重試到盤後、不捏造選股。
     */
    async repickLocked(today, failedList, getLive, { now = Date.now() } = {}) {
      const byDate = new Map();
      for (const x of failedList) { if (!byDate.has(x.date)) byDate.set(x.date, []); byDate.get(x.date).push(x.code); }
      for (const [dDate, codes] of byDate) {
        const ref = col().doc(dDate); const dDoc = (await ref.get()).data();
        if (!dDoc || dDoc.repick) continue;
        const docs = (await col().orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data());
        const days = await loadDays(30);
        const { opts } = await acctOf();
        const lots0 = portfolioState(docs, days.length ? days : null, null, opts).lots;
        const state = portfolioState(docs, [...days, { ...liveDay(lots0, today, getLive), recordedOnly: true }], null, opts);
        const failedLots = state.lots.filter(l => l.date === dDate && codes.includes(l.code) && l.status === 'void');
        const budget = failedLots.reduce((a, l) => a + (l.budget ?? l.estCost ?? 0), 0);
        const cash = Math.max(0, Math.min(budget, state.account.cash - state.account.reservedBuys));
        const busy = new Set([...state.lots.filter(l => l.status === 'pending' || l.status === 'held' || l.status === 'selling').map(l => l.code), ...(dDoc.picks || []).map(p => p.code)]);
        const cands = (dDoc.pool || []).filter(c => !busy.has(c.code)).map(c => {
          const q = liveQuoteOf(getLive, c.code, today); if (!(q?.price > 0)) return null;
          const prev = Number.isFinite(q.change) ? q.price - q.change : null;
          if (prev > 0 && q.price >= limitUpPrice(prev, /^00/.test(c.code)) - 1e-9) return null;   // 現在在漲停＝買不到
          return { ...c, live: { price: q.price, chgPct: prev > 0 ? (q.price / prev - 1) * 100 : null } };
        }).filter(Boolean);
        const rec = { date: today, at: now, trigger: codes, budget: Math.round(budget), cash: Math.round(cash), candidates: cands.length };
        if (cash < SWING_MIN_POSITION || !cands.length) {
          await ref.update(dropUndefined({ repick: { ...rec, picks: [], note: cash < SWING_MIN_POSITION ? `可用資金 ${Math.round(cash).toLocaleString()} 元不足，不重選` : '候選池沒有可買的股票（已持有／委託中、現在鎖漲停或無即時報價）' } }));
          log(`· 波段 AI 鎖漲停重選${tag} ${today}：${codes.join('、')} 未成交，${cash < SWING_MIN_POSITION ? '資金不足' : '無可買候選'}，不重選`);
          continue;
        }
        const maxPicks = Math.max(1, codes.length);
        const prompt = buildRepickPrompt({ date: today, timeTxt: '09:30', failed: failedLots.map(l => ({ code: l.code, name: l.name })), pool: cands, cash, maxPicks });
        let parsed = null, raw = null, kind = null;
        for (let a = 0; a < 2 && !parsed; a++) {
          const r = await askWithOutcome({ askOllama, askOllamaEx }, prompt, { priority, temperature: 0.2 });
          raw = r.text; kind = r.kind;
          if (isInfraFailure(kind)) break;
          parsed = parseDecision(raw, new Set(cands.map(c => c.code)), new Set(), busy, maxPicks);
        }
        const model = await getModelInfo().catch(() => null);
        if (!parsed) {
          const why = isInfraFailure(kind) ? `Ollama 未回應（${OLLAMA_KIND_LABEL[kind] || kind}）` : '回覆無法解析';
          await ref.update(dropUndefined({ repick: { ...rec, model, picks: [], failure: why, note: `${why}，今天不重選（資金留到盤後決策）`, prompt, raw: raw ? String(raw).slice(0, 3000) : null } }));
          log(`⚠ 波段 AI 鎖漲停重選${tag} ${today}：${why}，不重選`);
          continue;
        }
        const byCode = new Map(cands.map(c => [c.code, c]));
        const picks = sizePicks(parsed.picks.map(p => ({ ...p, name: byCode.get(p.code)?.name || p.code, sources: byCode.get(p.code)?.sources || [], priceAtDecision: byCode.get(p.code).live.price, prefund: false })), cash, { feeDiscount: opts.feeDiscount });
        const hhmm = new Date(now + 8 * 3600e3).toISOString().slice(11, 16);
        const upd = { repick: { ...rec, model, picks, note: parsed.note, rejected: parsed.rejected, prompt, raw: raw ? String(raw).slice(0, 3000) : null } };
        for (const p of picks) {
          if (!(p.position?.shares > 0)) continue;
          const q = liveQuoteOf(getLive, p.code, today);
          upd[`buyFills.${p.code}`] = { date: today, at: twAt(today, hhmm), px: p.priceAtDecision, openMissing: false, shares: p.position.shares, source: 'live-repick', quoteAt: q?.revealAt ?? q?.liveAt ?? null, recordedAt: now };
        }
        await ref.update(dropUndefined(upd));
        log(`✓ 波段 AI 鎖漲停重選${tag} ${today}：${codes.join('、')} 未成交 → 改買 ${picks.filter(p => p.position?.shares).map(p => `${p.code}@${p.priceAtDecision}`).join('、') || '不買'}（${(parsed.note || '').slice(0, 30)}）`);
        await this.writeAccount([...days, { ...liveDay(portfolioState((await col().orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data()), days.length ? days : null, null, opts).lots, today, getLive), recordedOnly: true }]);
      }
    },

    /** 到期才結算；每個持有期只寫一次 */
    async settle() {
      const snap = await col().orderBy('date', 'desc').limit(400).get();
      if (!snap.docs.length) return 0;
      const days = await loadDays(Math.max(...SWING_HORIZONS) + 15);   // 還原後 舊→新
      if (!days.length) return 0;
      // 帳戶成交記錄（v3 主動操作）：買進／AI 賣單在下一交易日開盤成交後寫回決策文件，寫一次不改
      let fills = 0;
      const { opts } = await acctOf();
      for (const u of settleFills(snap.docs.map(d => d.data()), days, opts)) {
        const d = snap.docs.find(x => x.data().date === u.date); if (!d) continue;
        // 走到這裡＝開盤時沒有即時成交記錄（常駐服務未運行等）：依官方開盤價補記，並明確標示，不冒充即時
        const upd = Object.fromEntries(Object.entries(u.upd).map(([k, v]) => [k, v?.source ? v : { ...v, source: 'archive-open', recordedAt: Date.now(), note: '開盤時未即時記錄（常駐服務未運行），盤後依官方開盤價補記' }]));
        await d.ref.update(dropUndefined(upd)); fills += Object.keys(upd).length;
        log(`⚠ 波段 AI${tag}：${u.date} 決策有 ${Object.keys(upd).length} 筆成交於盤後補記（開盤時未即時記錄）`);
      }
      if (fills) log(`✓ 波段 AI 帳戶${tag}：補記 ${fills} 筆成交`);
      if (!research) { await this.writeAccount(days); return 0; }   // 會員帳戶：不做各持有期研究結算
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

    /**
     * 帳戶快照（持有清單 marked-to-market＋結算清單）→ aiLabAccounts/swing；後台讀這一份。
     * getLive：盤中即時報價（daemon 傳 _lastLive）。已記錄、但日線尚未歸檔的成交（開盤即時成交當天）會補一個盤中暫定日——
     * 2026-10-01 實例：09:21 即時成交 5 筆，10:11 起每小時重算只讀歸檔（到 09-30），畫面倒回「待進場／賣出委託」。
     */
    async writeAccount(daysIn = null, { getLive = null } = {}) {
      const prev = acctLock; let release; acctLock = new Promise(r => { release = r; });
      await prev;
      try {
        const docs = (await col().orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data());
        const { opts } = await acctOf();
        // 會員尚未入金（沒有資金異動也沒有決策）：不建 0 元帳戶快照（2026-10-01 實測：開通即被寫入 0 元快照，
        //   會員頁誤判為已開始、顯示 0 元卡片；報酬率 0÷0＝NaN）。實驗帳戶不受影響（沒有 getSettings）。
        if (getSettings && !(opts.flows || []).length && !docs.length) return;
        let days = daysIn || await loadDays(Math.max(...SWING_HORIZONS) + 15);
        let liveFilled = [];
        // 今日歸檔已寫、但缺部分持股（上櫃 16:25–16:55 才併入·2026-10-01 使用者「怎麼沒有使用更新價格」）：
        //   以「該日」即時收盤補上市值用的價格；沒有即時報價就不補（不捏造、照舊標未知）
        if (!daysIn && days.length && getLive) {
          const last = days[days.length - 1];
          const { lots } = portfolioState(docs, days, null, opts);
          const add = {};
          for (const l of lots) {
            if (l.status === 'void' || l.status === 'closed' || last.m[l.code] || add[l.code]) continue;
            const q = liveQuoteOf(getLive, l.code, last.date); if (!q) continue;
            add[l.code] = [q.price > 0 ? q.price : q.open, Math.round((q.volume || 0) / 1000), q.open, q.high > 0 ? q.high : q.open, q.low > 0 ? q.low : q.open];
          }
          liveFilled = Object.keys(add);
          if (liveFilled.length) days = [...days.slice(0, -1), { ...last, m: { ...last.m, ...add } }];
        }
        if (!daysIn && days.length) {
          const pend = fillDatesAfter(docs, days[days.length - 1].date);
          // recordedOnly：暫定日只執行已記錄的成交（不推算、不作廢未記錄的委託）——歸檔落後多日時尤其重要
          if (pend.length) { const { lots } = portfolioState(docs, days, null, opts); days = [...days, ...pend.map(dt => ({ ...liveDay(lots, dt, getLive), recordedOnly: true }))]; }
        }
        const ref = snapRef();
        const prevHist = (await ref.get()).data()?.history || [];
        const snap = swingAccountSnapshot(docs, days, opts);
        const last = days[days.length - 1];
        // 每日戰績：由記錄逐日重算整段（2026-09-30：舊版只 upsert 當天，舊列沿用寫入時的算法而前後口徑不一）；只收官方收盤日
        // flowsIncluded（會員）：本次快照已計入幾筆資金異動——API 用它判斷快照之後的入金／提領（異動只會附加，不會改寫）
        await ref.set(dropUndefined({ ...snap, ...(last?.provisional ? { provisional: true, liveAt: last.liveAt ?? null } : {}), ...(liveFilled.length ? { liveFilled } : {}),
          ...(getSettings ? { flowsIncluded: (opts.flows || []).length } : {}),
          summary: accountSummary(snap), history: rebuildHistory(docs, days.filter(d => !d.provisional), prevHist, opts) }));
      } catch (e) { log(`✖ 波段帳戶快照${tag}:`, (e.message || '').slice(0, 80)); } finally { release(); }
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
