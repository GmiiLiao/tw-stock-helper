#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 🧠 AI 交易員經驗庫·盤後訓練（2026-09-30 使用者要求；純計算、不呼叫 LLM、不打上游）
//   daemon 每個交易日 18:30 後以獨立行程執行（execScript），成功才寫完成記錄 system/daemonJobMarks.labLearn。
//   樣本：
//     · 波段（key=swing，y＝5 日報酬%：D+1 開盤買、第 5 個交易日收盤賣、**未扣成本**，同 AI 波段研究口徑；2026-09-30 起）
//         歷史母體＝收盤歸檔近 LEARN_DAYS 個交易日、每 2 日取樣、近似波段候選池（20 日均成交額≥0.5 億、近 20 日上漲、站上≥2 條均線）
//         ＋AI 實際候選池（aiSwingLab.pool，同一日同一檔去重）。
//     · 當沖（key=dt-long／dt-short，y＝規則淨 R）：當沖工作台每一筆觸發（daytradeJournal，含 AI 沒做的）。
//     · AI 決策層（2026-10-01 使用者：會員開啟的 AI 實驗所取得的經驗也列為訓練來源）：
//         swing-buy／swing-sell＝實驗帳戶＋所有會員 AI 帳戶（aiSwingMembers/*/days）實際成交的買進／賣出；
//         同一（決策日, 代號, 買/賣）跨帳戶只算一筆（y 相同，重複計入只會假性顯著）。會員候選池同時併入 swing 母體（去重；
//         候選池各帳戶相同，通常不增加樣本）。對外產物（aiLabLearn）不帶會員身分，只記筆數。
//     · 會員樣本的保留（2026-10-04 使用者：「保留會員身分到會員自主取消或帳號刪除」；G4-21）：每次訓練比對 aiLabAccess 現況——
//         仍開通（swing＝true）且帳號存在才納入；取消開通或帳號已刪除者的決策不讀（樣本每次重算，剔除即移除）。體驗期到期＝停用但未取消，保留。
//         樣本的來源會員記在不公開的台帳 aiLabLearnPrivate/samples（firestore.rules 無對應規則＝前端不可讀；只存 key／日期／代號／uid）。
//   資料對齊（G2-28·v2）：歸檔每一份文件＝一個交易日，殘缺日（例：只有上市）保留一格、缺的檔就是缺值——不再整天濾掉讓「5 日」跨 6 個交易日。
//   輸出：Firestore aiLabLearn/latest＋aiLabLearn/{資料日}；第二大腦 second-brain/ai-lab-learn/{資料日}.md／.json、latest.json。
//   用法：node scripts/ai-lab-learn.mjs [--dry]（--dry 只印摘要不寫入）
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailyFeatures, dtFeatures, learn, renderLearnMarkdown, decisionSamples, replicateLearned, ruleStability, LEARN_VERSION, learnMethodId } from './lib/ai-lab-learn.mjs';
import { horizonOutcome, grossOf } from './lib/ai-swing-lab.mjs';
import { applyPriceFactors } from './lib/price-factors.mjs';
import { alignArchiveDays, priceFactorsFromDoc } from './lib/ai-lab-guard.mjs';
import { learnMemberEligibility } from './lib/ai-lab-member.mjs';
import { dropUndefined } from './lib/firestore-clean.mjs';

const LEARN_DAYS = +(process.env.LEARN_DAYS || 320);
const DRY = process.argv.includes('--dry');
const BRAIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'second-brain', 'ai-lab-learn');

function initDb() {
  if (!getApps().length) {
    const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    initializeApp(p ? { credential: cert(JSON.parse(readFileSync(p, 'utf8'))) } : {});
  }
  return getFirestore();
}

const db = initDb();
// 收盤歸檔（只取需要的欄位）→ 交易日序列（G2-28）：殘缺日保留一格、缺的檔＝缺值（特徵／報酬窗跨過缺值就不產生樣本，不會被誤讀成訊號，
//   也不再因整天濾掉而讓「5 日」跨 6 個交易日）；只丟尾端沒有收盤的空殼
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(LEARN_DAYS + 10).select('date', 'closeJson').get();
// 休市日曆（讀不到 ⇒ 沒有收盤的空殼一律視為非交易日丟掉，與日曆「臨時休市由歸檔空洞反推」同口徑）
let isTd = null;
try { const cal = (await db.collection('system').doc('tradingCalendar').get()).data(); if (Array.isArray(cal?.holidays) && cal.holidays.length) { const H = new Set(cal.holidays); isTd = iso => { const g = new Date(`${iso}T12:00:00Z`).getUTCDay(); return g !== 0 && g !== 6 && !H.has(iso); }; } }
catch (e) { console.log(`⚠ 經驗庫：休市日曆讀不到（${(e.message || '').slice(0, 60)}），空殼歸檔一律視為非交易日`); }
const aligned = alignArchiveDays(snap.docs.map(d => d.data()), { isTradingDayIso: isTd });
const raw = aligned.days.map(({ date, m }) => ({ date, m }));
if (aligned.partialDates.length) console.log(`⚠ 經驗庫：視窗內 ${aligned.partialDates.length} 個殘缺交易日（保留為缺值、不位移）：${aligned.partialDates.slice(-10).join('、')}`);
// 還原係數（G2-26）：priceEvents/latest 不存在或沒有 items＝讀取失敗 ⇒ 不訓練（未還原的減資／除權跳空會被當成報酬）
let factors;
try { factors = priceFactorsFromDoc((await db.collection('priceEvents').doc('latest').get()).data()); }
catch (e) { console.log(`✖ 經驗庫：價格結構事件讀取失敗（${(e.message || '').slice(0, 80)}），不訓練`); process.exit(1); }
const days = applyPriceFactors(raw, factors);
if (days.length < 80) { console.log(`✖ 經驗庫：歸檔只有 ${days.length} 日，不訓練`); process.exit(1); }
const dataDate = days[days.length - 1].date;

// ── 波段樣本 ──
const samples = []; const seen = new Set(); const sources = {};
const addSwing = (t, code, src) => {
  const k = `${days[t].date}:${code}`; if (seen.has(k)) return;
  const F = dailyFeatures(days, t, code); if (!F) return;
  const o = horizonOutcome(days, days[t].date, code, 5); const y = grossOf(o); if (y == null) return;
  seen.add(k); samples.push({ key: 'swing', date: days[t].date, f: F.f, y, src }); sources[src] = (sources[src] || 0) + 1;
};
// AI 實際候選池（先加，去重時優先保留此來源）
const labDocs = (await db.collection('aiSwingLab').orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data());
// 會員 AI 帳戶（listDocuments：含只有子集合的會員）——G4-21：只納入仍開通且帳號存在者（取消開通／帳號刪除＝剔除其樣本）
const memberRefs = await db.collection('aiSwingMembers').listDocuments();
const mUids = memberRefs.map(r => r.id);
const [accSnaps, userSnaps] = mUids.length
  ? await Promise.all([db.getAll(...mUids.map(u => db.collection('aiLabAccess').doc(u))), db.getAll(...mUids.map(u => db.collection('users').doc(u)))])
  : [[], []];
const accOf = new Map(accSnaps.map(s => [s.id, s.exists ? s.data() : null])), userOk = new Set(userSnaps.filter(s => s.exists).map(s => s.id));
const elig = learnMemberEligibility(mUids, u => accOf.get(u) ?? null, u => userOk.has(u));
if (elig.exclude.length) console.log(`· 經驗庫：剔除 ${elig.exclude.length} 位會員的樣本（${[...new Set(elig.exclude.map(x => x.reason))].join('、')}）`);
const memberDocs = [];   // [{ uid, docs }]
for (const uid of elig.include) {
  const ds = (await db.collection('aiSwingMembers').doc(uid).collection('days').orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data());
  if (ds.length) memberDocs.push({ uid, docs: ds });
}
const idx = new Map(days.map((d, i) => [d.date, i]));
for (const d of labDocs) { const t = idx.get(d.date); if (t == null) continue; for (const c of d.pool || []) addSwing(t, c.code, 'AI候選池'); }
for (const { docs: ds } of memberDocs) for (const d of ds) { const t = idx.get(d.date); if (t == null) continue; for (const c of d.pool || []) addSwing(t, c.code, '會員帳戶候選池'); }
// 歷史母體：現行 swing（AI 交易員使用）＝從視窗起點每 2 日——不變。
// 波段取樣實驗（2026-10-02 使用者：「1 2 3 都使用並分成 3 種實驗資源，後續比對哪種方式更為精準或是混合運用來驗證」）：
//   量測：視窗每天移一格時「每 2 日」那一半整批換成另一半，A／B 兩半各驗證 10 條、共同只有 2 條 ⇒ 規則逐日翻轉。
//   ① swing-x-rep 兩半複驗（A＝現行那一半、B＝另一半，都驗證且同向）② swing-x-cal 固定日曆錨點（日曆日偶數）③ swing-x-all 每個交易日。
//   實驗只用歷史母體（AI 候選池另計入現行 swing），只記錄比對、不提供給 AI。
const expSamples = [];
for (let t = 60; t < days.length - 5; t++) {
  const date = days[t].date, onGrid = (t - 60) % 2 === 0, calEven = Math.floor(Date.parse(date) / 864e5) % 2 === 0;
  for (const code in days[t].m) {
    if (!/^\d{4}$/.test(code) || code.startsWith('00')) continue;
    const F = dailyFeatures(days, t, code);
    if (!F || !(F.raw.amtM >= 50) || !(F.raw.gain20 > 0) || !(F.raw.maAbove >= 2)) continue;
    if (onGrid) addSwing(t, code, '歷史母體');
    const y = grossOf(horizonOutcome(days, date, code, 5)); if (y == null) continue;
    const s = { date, f: F.f, y, src: '歷史母體' };
    expSamples.push({ ...s, key: 'swing-x-all' }, { ...s, key: onGrid ? 'swing-x-rep-a' : 'swing-x-rep-b' });
    if (calEven) expSamples.push({ ...s, key: 'swing-x-cal' });
  }
}

// ── AI 決策層樣本（實驗帳戶＋會員帳戶的實際買賣；y＝決策日之後 5 日報酬，未扣成本，同 swing 口徑）──
const y5 = (date, code) => grossOf(horizonOutcome(days, date, code, 5));
const rawIdx = new Map(raw.map(d => [d.date, d]));   // 未還原收盤：持有報酬與成交價同口徑
const dec = decisionSamples([{ src: '實驗帳戶', docs: labDocs }, ...memberDocs.map(({ uid, docs }) => ({ src: '會員帳戶', docs, uid }))], days, y5,
  { rawCloseOf: (date, code) => rawIdx.get(date)?.m?.[code]?.[0] });
samples.push(...dec.samples);
for (const [side, name] of [['buy', '買進'], ['sell', '賣出']]) {
  for (const [src, n] of Object.entries(dec.stats[side])) sources[`AI${name}決策·${src}`] = n;
  const distinct = side === 'buy' ? dec.stats.distinctBuy : dec.stats.distinctSell;
  if (distinct) sources[`AI${name}經驗（去重·已到期）`] = distinct;
}

// ── 當沖樣本（工作台每一筆觸發；netR＝規則照做的淨 R）──
const jSnap = await db.collection('daytradeJournal').get();
for (const d of jSnap.docs) {
  let entries = {}; try { entries = JSON.parse(d.data().entriesJson || '{}'); } catch { continue; }
  for (const e of Object.values(entries)) {
    if (!(Number.isFinite(e?.netR)) || !e.traded) continue;   // 否決的沒有出場結果
    const F = dtFeatures(e); if (!F) continue;
    samples.push({ key: `dt-${e.side}`, date: d.id, f: F.f, y: e.netR, src: '工作台觸發' }); sources['工作台觸發'] = (sources['工作台觸發'] || 0) + 1;
  }
}

const learned = learn(samples);
let prev = null, prevReadOk = true;
try { prev = (await db.collection('aiLabLearn').doc('latest').get()).data() || null; } catch { prevReadOk = false; /* 首次或讀不到：不算穩定度 */ }
// 取樣實驗（不提供給 AI；matchLessons 只查 swing／swing-buy／swing-sell）
{
  const ex = learn(expSamples, { minN: { 'swing-x-all': 60, 'swing-x-cal': 60, 'swing-x-rep-a': 60, 'swing-x-rep-b': 60 } });
  if (ex['swing-x-rep-a'] && ex['swing-x-rep-b']) learned['swing-x-rep'] = replicateLearned(ex['swing-x-rep-a'], ex['swing-x-rep-b']);
  if (ex['swing-x-cal']) learned['swing-x-cal'] = ex['swing-x-cal'];
  if (ex['swing-x-all']) learned['swing-x-all'] = ex['swing-x-all'];
  // 與前一次訓練的已驗證規則重疊度（後續比對哪種取樣最穩定）
  if (prev?.learned) for (const k of ['swing', 'swing-x-rep', 'swing-x-cal', 'swing-x-all']) if (learned[k]) learned[k].stability = { prevDate: prev.date || null, ...ruleStability(prev.learned[k], learned[k]) };
}
const methodId = learnMethodId({ learnDays: LEARN_DAYS, align: 'trading-day-seq', swingGrid: 'every-2-from-60', swingFilter: 'amtM>=50,gain20>0,maAbove>=2', horizon: 5, members: 'access-swing-true&user-exists' });
const doc = { date: dataDate, version: LEARN_VERSION, methodId, at: Date.now(), sources, learned, accounts: { lab: 1, members: memberDocs.length, membersExcluded: elig.exclude.length },
  ...(aligned.partialDates.length ? { partialDays: aligned.partialDates } : {}),
  note: '已驗證（validated）規則提供給 AI 交易員決策參考；觀察中（observing）只記錄。歷史統計不保證未來，非投資建議。' };
for (const [k, x] of Object.entries(learned)) {
  const v = x.rules.filter(r => r.status === 'validated');
  console.log(`🧠 ${k}：n=${x.base.n}、平均 ${x.base.mean}${x.unit === '淨R' ? 'R' : '%'}｜已驗證 ${v.length}（風險 ${v.filter(r => r.kind === 'risk').length}／優勢 ${v.filter(r => r.kind === 'edge').length}）｜觀察中 ${x.rules.length - v.length}`);
}
if (DRY) {
  console.log(JSON.stringify(sources));
  for (const [k, x] of Object.entries(learned)) for (const r of x.rules) console.log(`  ${k} ${r.status === 'validated' ? '已驗證' : '觀察中'} ${r.kind === 'risk' ? '⚠' : '✓'} ${r.label}｜n=${r.n} 平均 ${r.mean} vs 其餘 ${r.restMean}｜t=${r.t}｜相對差 訓練 ${r.train.diff} 驗證 ${r.holdout.diff}`);
  process.exit(0);
}
// 永不以較舊的結果覆蓋較新的 latest（重跑／補跑舊資料日時只寫日期檔）；讀不到上一份時照寫（首次或暫時讀取失敗，下次訓練自癒）
const keepLatest = prevReadOk && prev?.date && prev.date > dataDate;
if (keepLatest) console.log(`· 經驗庫：latest 已是較新的 ${prev.date}，本次 ${dataDate} 只寫日期檔`);
else await db.collection('aiLabLearn').doc('latest').set(dropUndefined(doc));
await db.collection('aiLabLearn').doc(dataDate).set(dropUndefined(doc));
// 不公開的樣本台帳（G4-21）：每筆會員貢獻的決策樣本 → 來源 uid；每次訓練整份覆蓋（取消開通／刪除帳號者下次訓練即消失）
try {
  const ledger = dec.samples.filter(x => x.uids?.length).map(x => ({ key: x.key, date: x.date, code: x.code, uids: x.uids }));
  const perMember = {}; for (const x of ledger) for (const u of x.uids) perMember[u] = (perMember[u] || 0) + 1;
  const MAX_ROWS = 6000;   // 約 <1MB；超過只留最新的並註明
  const rows = ledger.length > MAX_ROWS ? ledger.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_ROWS) : ledger;
  await db.collection('aiLabLearnPrivate').doc('samples').set({ date: dataDate, version: LEARN_VERSION, methodId, at: Date.now(), perMember, included: elig.include.length, excluded: elig.exclude.length,   // 剔除者只記人數（不留其 uid）
    samples: rows, ...(rows.length < ledger.length ? { truncated: ledger.length - rows.length } : {}), note: '不公開：經驗庫樣本的來源會員（取消開通或帳號刪除後下次訓練即移除）' });
} catch (e) { console.log('⚠ 樣本台帳寫入失敗（不影響經驗庫）:', (e.message || '').slice(0, 80)); }
try {
  mkdirSync(BRAIN, { recursive: true });
  writeFileSync(join(BRAIN, `${dataDate}.md`), renderLearnMarkdown(doc));
  writeFileSync(join(BRAIN, `${dataDate}.json`), JSON.stringify(doc, null, 1));
  writeFileSync(join(BRAIN, 'latest.json'), JSON.stringify(doc, null, 1));
} catch (e) { console.log('⚠ 第二大腦寫入失敗:', (e.message || '').slice(0, 80)); }
console.log(`✓ 經驗庫 ${dataDate}：樣本 ${samples.length}（${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join('、')}）`);
process.exit(0);
