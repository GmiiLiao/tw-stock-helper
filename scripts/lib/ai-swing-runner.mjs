// ─────────────────────────────────────────────────────────────────────────────
// 🤖 AI 實驗·波段持有：daemon 端執行器（純函式在 ./ai-swing-lab.mjs）
//   pick()：交易日盤後（波段起漲與波段持有兩榜皆為同一資料日時）請 Ollama 選股 → 寫一次凍結檔
//           aiSwingLab/{資料日} ＋ second-brain/swing-ai-lab/{資料日}.md／.json（已存在不覆寫）。
//           Ollama 回覆格式錯會重試，當日第 3 次仍失敗才以「失敗」凍結（不讓一次抖動吃掉一天樣本）。
//   settle()：每日對未完成的記錄逐一結算 5／10／20／60／120 日；**每個持有期到期算一次就寫死**，之後不重算。
//   syncNotes()：超級管理員人工檢討 → second-brain/swing-ai-lab/{日}-人工檢討.md。
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropUndefined } from './firestore-clean.mjs';
import { SWING_LAB_VERSION, SWING_HORIZONS, buildPool, buildPickPrompt, parsePicks, horizonOutcome, poolBaseline, renderSwingMarkdown, swingLedger, swingAccount, sizePicks, swingAccountSnapshot, upsertHistory } from './ai-swing-lab.mjs';

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
      const model = await getModelInfo();
      const base = { date, version: SWING_LAB_VERSION, model, market, swingMeta: { bearDay: !!sp.bearDay, crowded: !!sp.crowded, observe: !!sp.observe, observeWhy: sp.observeWhy || null }, pool, outcomes: {} };
      if (!pool.length) {
        const doc = { ...base, picks: [], note: '候選池為空（兩榜皆無可選或皆為處置股）', prompt: null, raw: null, frozenAt: Date.now() };
        await ref.set(dropUndefined(doc)); writeFile(`${date}.md`, renderSwingMarkdown(doc)); writeFile(`${date}.json`, JSON.stringify(doc, null, 1));
        return true;
      }
      const prompt = buildPickPrompt({ date, pool, market, swingPicksMeta: base.swingMeta });
      const raw = await askOllama(prompt, { priority: 3, temperature: 0.2 });
      const parsed = parsePicks(raw, new Set(pool.map(c => c.code)));
      attempts[date] = (attempts[date] || 0) + 1;
      if (!parsed && attempts[date] < MAX_ATTEMPTS) { log(`⚠ 波段 AI 選股：回覆無法解析（第 ${attempts[date]} 次），稍後重試`); return false; }
      const byCode = new Map(pool.map(c => [c.code, c]));
      const raw0 = (parsed?.picks || []).map(p => ({ ...p, name: byCode.get(p.code)?.name || p.code, sources: byCode.get(p.code)?.sources || [], priceAtDecision: byCode.get(p.code)?.price ?? null }));
      // 波段帳戶 50 萬（不與當沖互通）：由既有記錄重算可用現金後定股數，凍結
      const prevDocs = (await col().orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data());
      const account = swingAccount(prevDocs, date);
      const picks = sizePicks(raw0, account.cash);
      const doc = { ...base, picks, account, note: parsed ? parsed.note : `Ollama 回覆 ${MAX_ATTEMPTS} 次皆無法解析，今日無選股`, rejected: parsed?.rejected ?? null, prompt, raw: raw ? String(raw).slice(0, 3000) : null, frozenAt: Date.now() };
      await ref.set(dropUndefined(doc));
      writeFile(`${date}.md`, renderSwingMarkdown(doc)); writeFile(`${date}.json`, JSON.stringify(doc, null, 1));
      log(`✓ 波段 AI 選股 ${date}（${model?.name || '?'}）：池 ${pool.length} 檔 → 選 ${picks.map(p => p.code).join('、') || '無'}`);
      await this.writeAccount();
      return true;
    },

    /** 到期才結算；每個持有期只寫一次 */
    async settle() {
      const snap = await col().orderBy('date', 'desc').limit(200).get();
      const open = snap.docs.filter(d => !d.data().settledAll);
      if (!open.length) { await this.writeAccount(); return 0; }
      const days = await loadDays(Math.max(...SWING_HORIZONS) + 15);   // 還原後 舊→新
      if (!days.length) return 0;
      let n = 0;
      for (const d of open) {
        const x = d.data();
        if (days[0].date > x.date) { log(`⚠ 波段 AI 結算：${x.date} 早於歸檔視窗，無法結算`); continue; }
        const upd = {}; const outcomes = { ...(x.outcomes || {}) };
        for (const h of SWING_HORIZONS) {
          if (outcomes[h]) continue;
          const d0 = days.findIndex(v => v.date > x.date);
          if (d0 < 0 || d0 + h - 1 >= days.length) continue;               // 尚未到期
          // 交易單股數＝帳戶定的部位（v2 前無部位的記錄以 1 張計）；account=true 的那一期才是帳戶實際出場，其他期為研究用
          const picks = (x.picks || []).map(p => { const o = horizonOutcome(days, x.date, p.code, h); const sh = p.position ? p.position.shares : 1000; const acct = p.position ? p.position.exitH === h : false;
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
