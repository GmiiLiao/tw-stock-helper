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
//         候選池各帳戶相同，通常不增加樣本）。樣本與輸出不帶會員身分，只記筆數。
//   輸出：Firestore aiLabLearn/latest＋aiLabLearn/{資料日}；第二大腦 second-brain/ai-lab-learn/{資料日}.md／.json、latest.json。
//   用法：node scripts/ai-lab-learn.mjs [--dry]（--dry 只印摘要不寫入）
// ─────────────────────────────────────────────────────────────────────────────
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailyFeatures, dtFeatures, learn, renderLearnMarkdown, decisionSamples, replicateLearned, ruleStability, LEARN_VERSION } from './lib/ai-lab-learn.mjs';
import { horizonOutcome, grossOf } from './lib/ai-swing-lab.mjs';
import { applyPriceFactors, factorsFromItems } from './lib/price-factors.mjs';
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
// 收盤歸檔（只取需要的欄位）；殘缺日（<1500 檔）不進訓練集（同 squeeze-train 的教訓：上櫃整批缺會被誤讀成訊號）
const snap = await db.collection('chipArchive').orderBy('date', 'desc').limit(LEARN_DAYS + 10).select('date', 'closeJson').get();
const raw = snap.docs.map(d => d.data()).filter(a => a?.closeJson).map(a => ({ date: a.date, m: JSON.parse(a.closeJson) }))
  .filter(d => Object.keys(d.m).length >= 1500).reverse();
const factors = factorsFromItems((await db.collection('priceEvents').doc('latest').get()).data()?.items);
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
// 會員 AI 帳戶（listDocuments：含只有子集合的會員；取消開通者的歷史決策照樣是經驗）
const memberRefs = await db.collection('aiSwingMembers').listDocuments();
const memberDocs = [];
for (const ref of memberRefs) {
  const ds = (await ref.collection('days').orderBy('date', 'desc').limit(400).get()).docs.map(d => d.data());
  if (ds.length) memberDocs.push(ds);
}
const idx = new Map(days.map((d, i) => [d.date, i]));
for (const d of labDocs) { const t = idx.get(d.date); if (t == null) continue; for (const c of d.pool || []) addSwing(t, c.code, 'AI候選池'); }
for (const ds of memberDocs) for (const d of ds) { const t = idx.get(d.date); if (t == null) continue; for (const c of d.pool || []) addSwing(t, c.code, '會員帳戶候選池'); }
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
const dec = decisionSamples([{ src: '實驗帳戶', docs: labDocs }, ...memberDocs.map(docs => ({ src: '會員帳戶', docs }))], days, y5,
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
// 取樣實驗（不提供給 AI；matchLessons 只查 swing／swing-buy／swing-sell）
{
  const ex = learn(expSamples, { minN: { 'swing-x-all': 60, 'swing-x-cal': 60, 'swing-x-rep-a': 60, 'swing-x-rep-b': 60 } });
  if (ex['swing-x-rep-a'] && ex['swing-x-rep-b']) learned['swing-x-rep'] = replicateLearned(ex['swing-x-rep-a'], ex['swing-x-rep-b']);
  if (ex['swing-x-cal']) learned['swing-x-cal'] = ex['swing-x-cal'];
  if (ex['swing-x-all']) learned['swing-x-all'] = ex['swing-x-all'];
  // 與前一次訓練的已驗證規則重疊度（後續比對哪種取樣最穩定）
  let prev = null; try { prev = (await db.collection('aiLabLearn').doc('latest').get()).data() || null; } catch { /* 首次或讀不到：不算穩定度 */ }
  if (prev?.learned) for (const k of ['swing', 'swing-x-rep', 'swing-x-cal', 'swing-x-all']) if (learned[k]) learned[k].stability = { prevDate: prev.date || null, ...ruleStability(prev.learned[k], learned[k]) };
}
const doc = { date: dataDate, version: LEARN_VERSION, at: Date.now(), sources, learned, accounts: { lab: 1, members: memberDocs.length },
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
await db.collection('aiLabLearn').doc('latest').set(dropUndefined(doc));
await db.collection('aiLabLearn').doc(dataDate).set(dropUndefined(doc));
try {
  mkdirSync(BRAIN, { recursive: true });
  writeFileSync(join(BRAIN, `${dataDate}.md`), renderLearnMarkdown(doc));
  writeFileSync(join(BRAIN, `${dataDate}.json`), JSON.stringify(doc, null, 1));
  writeFileSync(join(BRAIN, 'latest.json'), JSON.stringify(doc, null, 1));
} catch (e) { console.log('⚠ 第二大腦寫入失敗:', (e.message || '').slice(0, 80)); }
console.log(`✓ 經驗庫 ${dataDate}：樣本 ${samples.length}（${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join('、')}）`);
process.exit(0);
