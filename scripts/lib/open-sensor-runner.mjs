// ─────────────────────────────────────────────────────────────────────────
// 開盤感應器 v2.1 排程器（影子）：盤前名單 → 09:02 首判（備援 09:03／09:04，牆鐘 09:05 必寫）→
//   09:10…10:00 每 10 分鐘複判（每次留存、有變才補記、10:00 定格）→ 09:20／09:30 盤型 → 10:03:30 indexRing（O7 保護窗 10:05 結束前落地）
//   → 10:05 逾時定格（r1000 缺席才用）→ 盤後 post。
//   規格 design-v2.1 §5、§6、§7、§8。依賴全部注入（db、時鐘、休市表、本機檔讀取），可用假 db＋假時鐘整日模擬。
//   不變式：
//   · 0 上游請求：只吃 daemon 已拿到的報價與 t00／o00（feedQuotes／feedIndex），盤前只讀 Firestore 與本機檔。
//   · 寫一次、重啟不可覆蓋（交易內看文件欄位）；重啟後過去的檢查點只能 late 或 nodata，不補。
//   · 影子：不寫 aiMessages、不推播、不發 B2／Z2；熱路徑（feed*）例外一律吞掉，不可拖垮快線或主迴圈。
// ─────────────────────────────────────────────────────────────────────────
import { FIRST_KEYS, RECHECK_KEYS, PATTERN_KEYS, P, SUB_BASIS, tpeMs, tpeIsoOf, keyMs, isTradingIso, prevTradingIso, tradingDaysBefore, tradingDaysBetween } from './open-sensor-params.mjs';
import { createCapture, feedQuotes, feedIndex, freeze, buildIndexRing, ticksJsonAround, RING_END_HMS } from './open-sensor-capture.mjs';
import { buildUniverse, universeSummary, universeDoc } from './open-sensor-universe.mjs';
import { cBaseOf, replayThreshold } from './open-sensor-volume.mjs';
import { eStart, eCorrAt, genReturns, eTsePctOf } from './open-sensor-eopen.mjs';
import { patternAt } from './open-sensor-pattern.mjs';
import { composeCheck, nodataCheck, docBase, decideFirst, decideRecheck, decideTimeoutFinal, decideIndexRing, decidePost, computePost, indexMarksFromRing, checkLine } from './open-sensor-check.mjs';
import { createOpenSensorStore } from './open-sensor-store.mjs';

const C_KEYS = Object.freeze(['0902', '0903', '0904', '0910', '0920', '0930', '0940', '0950', '1000']);
const HIST_DAYS = 200;   // H 區段表重放的歷史長度（交易日）
const PREP_MAX_TRIES = 5;   // 盤前準備缺項最多重試次數（每次間隔 ≥ 60 秒）
const MORNING_END = '11:00:00';   // 晨間步驟（首判／複判／定格／indexRing）的牆鐘上限：較晚開機也要補寫 nodata 與定格
// indexRing 寫入的牆鐘：環收到揭示 RING_END_HMS（10:03:00），留 30 秒揭示落後；必須早於 O7 重啟保護窗結束（10:05，restart-windows.mjs）
const RING_WRITE_HMS = '10:03:30';

/**
 * @param deps.db、deps.log、deps.nowMs()、deps.holidays()→Set、deps.bootMs
 * @param deps.marketOf()→{code:'tse'|'otc'}|null（主迴圈代碼表，只用來認上市 ETF）
 * @param deps.loadShares()→{ tse:{map,asOf,src}|null, otc:{map,asOf}|null }（本機，0 請求）
 * @param deps.loadExclusions(date)→{ full, periodic, split, src }
 * @param deps.loadAHistory(fromIso, toIso)→{date: A億元}；deps.loadOpenMarks(days)→{date: openMarks|null}
 * @param deps.restoredLive()→number|null；deps.orderFlowDone(date)→bool；deps.readJobMarks()、deps.markJobDone(key, day)
 * @param deps.readIndexClose(date)→{t,v}|null（marketIndex/latest 當日 13:30 後收盤）
 */
export function createOpenSensorRunner(deps) {
  const store = createOpenSensorStore(deps.db);
  const log = deps.log || (() => {});
  let day = null;            // 當日記憶體狀態
  let postDone = '';         // 盤後步驟已完成的日子（記憶體；權威在 daemonJobMarks）
  let postTryMs = 0;         // 盤後步驟上次嘗試的時刻
  let lastRound = null;      // 主迴圈最近一輪 { at, liveN }（G6）

  const newDay = date => ({
    date, cap: createCapture(date), uni: null, uniErr: null, cBase: null, rep: null, rhoMeta: null,
    sharesOk: false, sharesNote: null, prepared: false, prepMs: 0, prepTries: 0, written: new Set(), restored: false,
    e: null, eCorr: null, u: null, genRets: null, released: false,
  });
  const ensureDay = date => { if (!day || day.date !== date) day = newDay(date); return day; };

  // ── 熱路徑（快線、主迴圈）：只做記憶體推入，例外吞掉 ──────────────────
  function inWindow(now) {
    const date = tpeIsoOf(now);
    if (!isTradingIso(date, deps.holidays())) return null;
    if (now < tpeMs(date, '08:59:00') || now > tpeMs(date, '10:05:30')) return null;
    return date;
  }
  function onQuotes(mis) {
    try {
      const date = inWindow(deps.nowMs()); if (!date) return 0;
      const d = ensureDay(date); if (d.released) return 0;
      const accept = d.uni ? c => d.uni.sample.has(c) || !!d.uni.otc?.[c] : null;
      return feedQuotes(d.cap, mis, accept);
    } catch { return 0; }
  }
  function onIndex(t, o) {
    try {
      const date = inWindow(deps.nowMs()); if (!date) return;
      const d = ensureDay(date);
      if (t) feedIndex(d.cap, 't', t);
      if (o) feedIndex(d.cap, 'o', o);
    } catch { /* 熱路徑不可拋 */ }
  }
  function onRound(liveN, marketNow) { if (marketNow) lastRound = { at: deps.nowMs(), liveN }; }

  // ── 盤前準備（記憶體；Firestore＋本機檔，0 上游） ───────────────────
  async function prepare(d, now) {
    d.prepMs = now; d.prepTries++;
    const hol = deps.holidays();
    const prevYmd = prevTradingIso(d.date, hol);
    // 名單（失敗才重試；chipArchive 1 讀＋本機檔）
    if (!d.uni) {
      try {
        const snap = await deps.db.collection('chipArchive').doc(prevYmd).get();
        const closeJson = snap.exists ? snap.data()?.closeJson : null;
        if (!closeJson) throw new Error(`chipArchive ${prevYmd} 無收盤`);
        const sh = await deps.loadShares();
        if (!sh?.tse?.map) throw new Error('發行股數：正快取與本機鏡像都沒有（noIssuedShares）');
        const marketOf = deps.marketOf() || {};
        if (Object.keys(marketOf).length < 1000) throw new Error('主迴圈代碼表未載入（上市 ETF 無法辨識，價格樣本會缺 00xx）');
        const excl = await deps.loadExclusions(d.date);
        d.uni = buildUniverse({ date: d.date, prevYmd, closeMap: JSON.parse(closeJson), sharesTse: sh.tse.map, sharesOtc: sh.otc?.map ?? null, marketOf, excl, sharesAsOf: sh.tse.asOf, sharesSrc: sh.tse.src });
        const lag = sh.tse.asOf ? tradingDaysBetween(sh.tse.asOf, d.date, hol) : Infinity;
        d.sharesOk = lag <= P.g10Days;
        d.sharesNote = `${sh.tse.src} ${sh.tse.asOf ?? '日期未知'}（落後 ${Number.isFinite(lag) ? lag : '?'} 個交易日）`;
        d.uniErr = null;
      } catch (e) { d.uni = null; d.uniErr = String(e?.message || e).slice(0, 120); }
    }
    // c(T) 基準（20 讀）、H（區段表重放）、ρ
    if (!d.cBase) {
      try {
        const baseDays = tradingDaysBefore(d.date, P.cBaseDays, hol);
        d.cBase = cBaseOf(baseDays, await deps.loadOpenMarks(baseDays), C_KEYS);
      } catch (e) { d.cBase = null; log(`  ⚠ 開盤感應器 c(T) 基準讀取失敗：${String(e?.message || e).slice(0, 80)}`); }
    }
    if (!d.rep?.ok) {
      try {
        const hist = tradingDaysBefore(d.date, HIST_DAYS, hol);
        d.rep = replayThreshold({ days: hist, aMap: await deps.loadAHistory(hist[0], hist[hist.length - 1]), holidays: hol });
      } catch (e) { d.rep = null; log(`  ⚠ 開盤感應器 H 重放失敗：${String(e?.message || e).slice(0, 80)}`); }
    }
    if (!d.rhoMeta) { try { const s = await deps.db.collection('openSensorMeta').doc('rho').get(); d.rhoMeta = s.exists ? s.data() : null; } catch { d.rhoMeta = null; } }
    // 重啟接回：已寫的欄位、E 與 U
    try {
      const doc = await store.readDay(d.date);
      if (doc) restoreFromDoc(d, doc);
    } catch { /* 讀不到 ⇒ 寫入交易內仍會看文件欄位，不會覆蓋 */ }
    const complete = !!(d.uni && d.cBase && d.rep?.ok);
    d.prepared = complete || d.prepTries >= PREP_MAX_TRIES;
    log(`🧭 開盤感應器（影子）${d.date} 盤前${complete ? '' : `（第 ${d.prepTries} 次、${d.prepared ? '不再重試' : '稍後重試缺項'}）`}：名單${d.uni ? `W30＋上市流動 ${d.uni.liquid.length} 檔` : `缺（${d.uniErr}）`}｜c 基準 ${d.cBase?.n ?? 0} 日｜H ${d.rep?.H ?? '—'}${d.rep?.stale ? '（stale）' : ''}${d.rep && !d.rep.ok ? `（${d.rep.reason}）` : ''}｜發行股數 ${d.sharesNote ?? '—'}`);
  }

  function restoreFromDoc(d, doc) {
    if (doc.c0902) d.written.add('c0902');
    for (const k of Object.keys(doc.rechecks || {})) d.written.add(k);
    for (const k of Object.keys(doc.checks || {})) if (k !== 'e') d.written.add(k);
    if (doc.indexRing) d.written.add('indexRing');
    if (doc.cur?.final) d.written.add('final');
    if (doc.checks?.e && !d.e) d.e = doc.checks.e;
    if (doc.eCorr && !d.eCorr) { d.eCorr = doc.eCorr; try { d.u = JSON.parse(doc.eCorr.uJson || 'null'); } catch { d.u = null; } }
    d.restored = true;
  }

  const lateFor = (d, T) => deps.bootMs >= tpeMs(d.date, '08:30:00') && deps.bootMs <= T + P.recheckWinMs;
  const zeroLiveFor = T => !!lastRound && lastRound.liveN === 0 && lastRound.at >= T - P.bufMs;

  function baseFor(d, now) {
    const rep = d.rep;
    return docBase({
      date: d.date, dateSrc: d.cap.ringT.length ? 't00' : 'clock', now,
      params: {
        H: rep?.H ?? null, hSeg: rep?.seg ?? null, hBasis: SUB_BASIS.h, hAsOf: rep?.asOf ?? null, hStale: rep ? !!rep.stale : null,
        struct: SUB_BASIS.struct, vol: SUB_BASIS.vol, rhoBasis: SUB_BASIS.rho, rho0: P.rho0,
        cBase: d.cBase ? { n: d.cBase.n, from: d.cBase.from, to: d.cBase.to, missing: d.cBase.missing } : null,
      },
      universe: d.uni ? universeSummary(d.uni) : { error: d.uniErr },
    });
  }

  function compose(d, key, now, extra = {}) {
    if (!d.uni) return null;
    return composeCheck({
      key, cap: d.cap, uni: d.uni, cBase: d.cBase, H: d.rep?.H ?? null, rhoMeta: d.rhoMeta, now,
      env: { tradingDay: true, zeroLive: zeroLiveFor(d.cap.T[key]), sharesOk: d.sharesOk, sharesNote: d.sharesNote, late: lateFor(d, d.cap.T[key]), restoredLive: deps.restoredLive?.() ?? null, ePct: d.e?.tse?.pct ?? eTsePctOf(d.cap.ringT, d.date), ...extra },
      idx: extra.idx ?? null,
    });
  }
  const failNoUni = (d, key, now) => nodataCheck(key, [`名單：${d.uniErr || '未建立'}`], now, { status: 'undetermined' });

  // ── 09:02 首判 ────────────────────────────────────────────────────
  async function stepFirst(d, now) {
    if (d.written.has('c0902')) return;
    const T0 = keyMs(d.date, '0902'), deadline = tpeMs(d.date, '09:05:00');
    if (now < T0) return;
    let check = null;
    if (deps.bootMs > deadline) check = nodataCheck('0902', ['restart'], now);
    else if (!d.uni) { if (now >= deadline) check = failNoUni(d, '0902', now); }
    else {
      const keys = now >= tpeMs(d.date, '09:04:00') ? FIRST_KEYS : ['0902'];
      for (const k of keys) {
        if (now < keyMs(d.date, k)) continue;
        const ck = compose(d, k, now, { slid: k !== '0902' });
        if (ck?.status === 'ok') { check = ck; break; }
      }
      if (!check && now >= deadline) check = compose(d, '0902', now);   // 09:05 必寫：以當下的 B_0902 寫「未判定」並附每道閘門的原因
    }
    if (!check) return;
    let s = null;
    // 重啟逾 09:05（nodata）不算有效開盤與失真：B_0902、09:02 前後的環都不在記憶體，算出來只會是「沒看到」當「沒開出」
    if (d.uni && check.status !== 'nodata') s = eStart({ cap: d.cap, uni: d.uni, buf0902: d.cap.buf['0902'], gMedian: check.g?.median ?? null });
    const side = x => (x ? { e: x.v, pct: x.pct, revealAt: x.revealAt } : null);
    if (s) check.idx = { tse: side(s.e.tse), otc: side(s.e.otc), officialOpen: s.e.officialOpen, officialOpenPct: s.e.officialOpenPct, oStarPct: s.e.oStarPct, distortPp: s.e.distortPp, distorted: s.e.distorted };
    const r = await store.txDay(d.date, doc => decideFirst(doc, { base: baseFor(d, now), check, e: s?.e ?? null, eCorr: s?.eCorr ?? null, ticksJson: ticksJsonAround(d.cap.ringT, d.date), now }));
    d.written.add('c0902');
    for (const k of FIRST_KEYS) freeze(d.cap, k);
    if (r.wrote && s) { d.e = s.e; d.eCorr = s.eCorr; d.u = JSON.parse(s.eCorr.uJson); d.genRets = genReturns(d.cap.buf['0902'], d.uni); }
    else if (r.doc) restoreFromDoc(d, r.doc);
    if (d.uni) {
      try { await store.createUniverse(d.date, universeDoc(d.uni, now)); } catch (e) { log(`  ⚠ 開盤感應器名單存證寫入失敗：${String(e?.message || e).slice(0, 80)}`); }
    }
    log(`🧭 開盤感應器（影子）首判 ${r.wrote ? '' : '（已存在，略過）'}${checkLine(check.T, check)}`);
  }

  // ── 09:10…10:00 複判＋09:20／09:30 盤型 ─────────────────────────────
  async function stepRecheck(d, key, now) {
    const rk = `r${key}`;
    if (d.written.has(rk)) return;
    const T = keyMs(d.date, key), end = T + P.recheckWinMs;
    if (now < T) return;
    let check = null;
    if (deps.bootMs > end) check = nodataCheck(key, ['restart'], now);
    else if (!d.uni) { if (now >= end) check = nodataCheck(key, [`名單：${d.uniErr || '未建立'}`], now); }
    else {
      const ck = compose(d, key, now);
      if (ck?.status === 'ok') check = ck;
      else if (now >= end) check = nodataCheck(key, ck?.reasons?.length ? ck.reasons : ['gates'], now, { late: ck?.late ?? false });
    }
    if (!check) return;
    const eAt = d.e && d.u && d.eCorr && !d.eCorr.eFinal && d.uni ? eCorrAt({ T, e: d.e, u: d.u, uni: d.uni, firstOpen: d.cap.firstOpen, genRets0902: d.genRets }) : null;
    if (check.status === 'ok' && d.e) {
      check.idx = { tse: d.e.tse ? { e: d.e.tse.v, pct: eAt?.tse?.pct ?? d.e.tse.pct, revealAt: d.e.tse.revealAt } : null, otc: d.e.otc ? { e: d.e.otc.v, pct: eAt?.otc?.pct ?? d.e.otc.pct, revealAt: d.e.otc.revealAt } : null, officialOpen: d.e.officialOpen, officialOpenPct: d.e.officialOpenPct, oStarPct: d.e.oStarPct, distortPp: d.e.distortPp, distorted: d.e.distorted };
    }
    let pattern = null;
    if (PATTERN_KEYS.includes(key)) pattern = patternAt({ T, ringT: d.cap.ringT, ringO: d.cap.ringO, e: d.e, eCorr: eAt, gNow: check.status === 'ok' ? check.g?.median ?? null : null, writtenAt: now });
    const final = key === RECHECK_KEYS[RECHECK_KEYS.length - 1];
    const r = await store.txDay(d.date, doc => decideRecheck(doc, { base: baseFor(d, now), key, check, eAt, pattern, final, now }));
    d.written.add(rk); if (pattern) d.written.add(`c${key}`);
    freeze(d.cap, key);
    if (final) {
      d.written.add('final');
      const doc = await store.readDay(d.date);
      if (doc?.cur?.final) await store.countOutside(d.date, doc.cur, now).catch(e => log(`  ⚠ 開盤感應器計次失敗：${String(e?.message || e).slice(0, 60)}`));
    }
    log(`🧭 開盤感應器（影子）複判 ${r.wrote ? '' : '（已存在，略過）'}${checkLine(key, check)}${pattern ? `｜盤型 加權 ${pattern.lines.tse.label}·一般股 ${pattern.lines.gen.label}` : ''}`);
  }

  // ── 10:03:30 indexRing；10:05 timeout 定格；兩者都完成才釋放緩衝 ─────────
  //   indexRing 必須在 O7 重啟保護窗（08:30–10:05）結束前寫出：10:05 起可以重啟，那時環要已落地，否則環蒸發、只剩重啟後幾拍。
  async function stepClose(d, now) {
    if (!d.written.has('indexRing') && now >= tpeMs(d.date, RING_WRITE_HMS)) {
      const ring = buildIndexRing(d.cap);
      const r = ring.n > 0 ? await store.txDay(d.date, doc => (doc ? decideIndexRing(doc, { base: baseFor(d, now), indexRing: ring }) : null)) : { wrote: false };
      d.written.add('indexRing');
      log(`🧭 開盤感應器（影子）indexRing ${r.wrote ? `寫入 ${ring.n} 拍（揭示 09:00–${RING_END_HMS.slice(0, 5)}）${ring.gaps.length ? `·缺段 ${ring.gaps.join('、')}` : ''}` : '略過（已存在或無當日文件）'}`);
    }
    if (now >= tpeMs(d.date, '10:05:00') && !d.written.has('final')) {
      const r = await store.txDay(d.date, doc => decideTimeoutFinal(doc, { now }));
      d.written.add('final');
      if (r.wrote) {
        const doc = await store.readDay(d.date);
        if (doc?.cur?.final) await store.countOutside(d.date, doc.cur, now).catch(() => {});
        log('🧭 開盤感應器（影子）10:00 快照缺席，以 10:05 當時狀態定格（finalBy timeout）');
      }
    }
    if (d.written.has('indexRing') && d.written.has('final') && !d.released) { d.cap.buf = Object.fromEntries(Object.keys(d.cap.buf).map(k => [k, new Map()])); d.cap.firstOpen.clear(); d.released = true; }
  }

  // ── 盤後（15:25 子程序成功後）：post、indexMarks、threshold、ρ ─────────
  async function stepPost(date, now) {
    if (postDone === date || now < tpeMs(date, '15:25:00')) return;
    if (!deps.orderFlowDone(date)) return;
    if (now - postTryMs < 60_000) return;   // 盤後步驟每分鐘最多試一次（等 openMarks 時不連續讀 Firestore）
    postTryMs = now;
    const marks = await deps.readJobMarks();
    if (marks?.openSensorPost === date) { postDone = date; return; }
    const ofa = await deps.db.collection('orderFlowArchive').doc(date).get();
    if (!ofa.exists || !(ofa.data()?.tradeValue > 0)) return;   // 15:25 子程序尚未寫入 ⇒ 下一輪
    const of = ofa.data();
    const A = of.tradeValue / 100;
    const openMarks = of.openMarks?.basis === SUB_BASIS.marks ? of.openMarks : null;
    if (!openMarks && now < tpeMs(date, '17:30:00')) return;   // O8 的 openMarks 還沒到：等到 17:30，之後照寫並標缺
    const doc = await store.readDay(date);
    if (doc) {
      const close = await deps.readIndexClose(date).catch(() => null);
      const post = computePost({ doc, openMarks, A, H: doc.params?.H ?? null, now });
      if (!openMarks) post.missing = ['openMarks'];
      // 收盤時 MIS t00／o00 的 m 原值（§10.2 o00 m 語意核對的原料：日後對同日 TPEx 鏡像成交值／成交股數，0 請求）
      post.mClose = close ? { t: close.t ?? null, tseVolLots: close.tseVolLots ?? null, otcMRaw: close.otcMRaw ?? null } : null;
      await store.txDay(date, d0 => decidePost(d0, { post }));
      if (Object.keys(post.rhoRatio).length) await store.appendRho(date, post.rhoRatio, now);
      if (doc.indexRing) {
        const st = await store.copyIndexMarks(date, indexMarksFromRing(doc.indexRing, close));
        log(`  · 開盤感應器 indexMarks（環）→ orderFlowArchive/${date}：${st}`);
      }
    }
    const hol = deps.holidays();
    const hist = [...tradingDaysBefore(date, HIST_DAYS - 1, hol), date];
    const rep = replayThreshold({ days: hist, aMap: await deps.loadAHistory(hist[0], date), holidays: hol });
    if (rep.ok) await store.writeThreshold(rep, now);
    await deps.markJobDone('openSensorPost', date);
    postDone = date;
    log(`✓ 開盤感應器（影子）盤後 ${date}：A ${A.toFixed(0)} 億${doc ? `·post${openMarks ? '' : '（缺 openMarks）'}` : '·當日無感應器文件'}｜H 次日 ${rep.ok ? rep.H : '—'}`);
  }

  /** 由 daemon 每 ~5 秒呼叫一次（自己吞例外） */
  async function tick() {
    const now = deps.nowMs();
    const date = tpeIsoOf(now);
    if (!isTradingIso(date, deps.holidays())) return;
    try {
      if (now >= tpeMs(date, '08:40:00') && now < tpeMs(date, MORNING_END)) {
        const d = ensureDay(date);
        if (!d.prepared && now - d.prepMs > 60_000) await prepare(d, now);
        if (now >= keyMs(date, '0902')) {
          await stepFirst(d, now);
          for (const k of RECHECK_KEYS) await stepRecheck(d, k, now);
          await stepClose(d, now);
        }
      }
      await stepPost(date, now);
    } catch (e) { log(`✖ 開盤感應器（影子）：${String(e?.message || e).slice(0, 120)}`); }
  }

  return { onQuotes, onIndex, onRound, tick, status: () => ({ day: day && { date: day.date, prepared: day.prepared, uniErr: day.uniErr, written: [...day.written], ringT: day.cap.ringT.length, ringO: day.cap.ringO.length }, postDone, lastRound }) };
}
