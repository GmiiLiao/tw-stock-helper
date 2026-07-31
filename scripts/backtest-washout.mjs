#!/usr/bin/env node
// ── 驗證「主力洗融資」圖卡主張（2020/2021/2023/2024 四段牛市洗盤）──────────
// 資料：Yahoo ^TWII 日線(2019-12→今) + 證交所 MI_MARGN 市場融資餘額(抽樣日期)。
// 驗證命題：各牛市中的洗盤 (1)指數修正幅度 (2)時長(週) (3)融資餘額降幅 (4)洗完後主升段漲幅。

// 1) 抓加權指數長歷史
const p1 = Math.floor(new Date('2019-12-01').getTime() / 1000);
const p2 = Math.floor(Date.now() / 1000);
const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ETWII?period1=${p1}&period2=${p2}&interval=1d`;
const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
const j = await r.json();
const res = j?.chart?.result?.[0];
if (!res) { console.log('Yahoo 失敗'); process.exit(1); }
const ts = res.timestamp, closes = res.indicators.quote[0].close;
const days = [];
for (let i = 0; i < ts.length; i++) if (closes[i] > 0) days.push({ d: new Date(ts[i] * 1000).toISOString().slice(0, 10), c: closes[i] });
console.log(`加權指數 ${days.length} 日：${days[0].d} → ${days[days.length - 1].d}`);

const idx = iso => days.findIndex(x => x.d >= iso);
const fmt = n => n?.toFixed(1);

// 2) 在指定牛市窗內找「最大回檔段」：局部高點→低點→收復
function analyzeWindow(tag, startIso, endIso, claim) {
  const s = idx(startIso), e = Math.min(idx(endIso) === -1 ? days.length - 1 : idx(endIso) + 130, days.length - 1); // 窗後留~6個月看主升段
  const seg = days.slice(s, e);
  // 找窗內最深回檔（peak→trough）
  let peakI = 0, best = { dd: 0 };
  for (let i = 1; i < seg.length; i++) {
    if (seg[i].c > seg[peakI].c) { peakI = i; continue; }
    const dd = (seg[peakI].c - seg[i].c) / seg[peakI].c * 100;
    if (dd > best.dd && seg[peakI].d <= endIso) best = { dd, peakI, troughI: i };
  }
  if (!best.peakI) { console.log(tag, '找不到回檔'); return null; }
  const peak = seg[best.peakI], trough = seg[best.troughI];
  const weeks = ((new Date(trough.d) - new Date(peak.d)) / 86400000 / 7);
  // 洗完後主升段：低點→其後 6 個月最高
  let hi = trough.c;
  for (let i = best.troughI; i < Math.min(best.troughI + 130, seg.length); i++) hi = Math.max(hi, seg[i].c);
  const rally = (hi - trough.c) / trough.c * 100;
  console.log(`\n【${tag}】圖卡主張：洗 ${claim.weeks}、修正 ${claim.dd}、後漲 ${claim.rally}`);
  console.log(`  實測：高點 ${peak.d}(${Math.round(peak.c)}) → 低點 ${trough.d}(${Math.round(trough.c)})`);
  console.log(`  修正 -${fmt(best.dd)}%、歷時 ${fmt(weeks)} 週、低點後6個月內最高再漲 +${fmt(rally)}%`);
  return { peakD: peak.d, troughD: trough.d, dd: best.dd, weeks, rally };
}

const episodes = [
  ['2020 疫情後電子', '2020-06-01', '2020-08-05', { weeks: '2-4週', dd: '8-12%', rally: '30-40%' }],
  ['2021 航運鋼鐵', '2021-04-01', '2021-08-31', { weeks: '3-6週', dd: '10-15%', rally: '25-35%' }],
  ['2023 AI 起漲', '2023-06-01', '2023-11-30', { weeks: '4-8週', dd: '8-10%', rally: '35-45%' }],
  ['2024 AI 擴散', '2024-03-01', '2024-06-01', { weeks: '3-5週', dd: '6-12%', rally: '20-30%' }],
  ['【反例】2024-07 高點', '2024-07-01', '2024-08-15', { weeks: '?', dd: '?', rally: '?' }],
];
const results = [];
for (const [tag, s, e, claim] of episodes) { const x = analyzeWindow(tag, s, e, claim); if (x) results.push({ tag, ...x }); }

// 3) 融資餘額驗證：各回檔段 峰/谷 的市場融資餘額（證交所 MI_MARGN）
async function marginAt(iso) {
  const ymd = iso.replace(/-/g, '');
  try {
    const r2 = await fetch(`https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?date=${ymd}&selectType=MS&response=json`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const j2 = await r2.json();
    const rows = j2?.tables?.[0]?.data || j2?.data || [];
    for (const row of rows) {
      const label = String(row[0] || '');
      if (label.includes('融資金額')) return parseFloat(String(row[5] ?? row[4]).replace(/,/g, '')) / 1e5; // 仟元→億
    }
  } catch { /* skip */ }
  return null;
}
// 交易日修正：往後找最多4天
async function marginNear(iso) {
  for (let k = 0; k < 5; k++) {
    const d = new Date(iso); d.setDate(d.getDate() + k);
    const v = await marginAt(d.toISOString().slice(0, 10));
    if (v != null) return v;
    await new Promise(res2 => setTimeout(res2, 400));
  }
  return null;
}
console.log('\n══ 融資餘額驗證（證交所 MI_MARGN，峰→谷）══');
for (const x of results) {
  const mPeak = await marginNear(x.peakD); await new Promise(r3 => setTimeout(r3, 500));
  // 融資低點常落後股價低點——谷後 3 週再看
  const t2 = new Date(x.troughD); t2.setDate(t2.getDate() + 21);
  const mTrough = await marginNear(x.troughD); await new Promise(r3 => setTimeout(r3, 500));
  const mLag = await marginNear(t2.toISOString().slice(0, 10));
  if (mPeak && mTrough) {
    const drop1 = (mPeak - mTrough) / mPeak * 100;
    const drop2 = mLag ? (mPeak - mLag) / mPeak * 100 : null;
    console.log(`  ${x.tag}: 峰 ${Math.round(mPeak)}億 → 谷 ${Math.round(mTrough)}億（${fmt(-drop1)}%）${drop2 != null ? `→ 谷後3週 ${Math.round(mLag)}億（累計 ${fmt(-drop2)}%）` : ''}`);
  } else console.log(`  ${x.tag}: 融資資料抓取失敗（峰 ${mPeak} 谷 ${mTrough}）`);
}

// 4) 現在位置：今日距 3 個月高點回檔多深？
const now = days[days.length - 1];
let hi90 = 0, hiD = '';
for (let i = Math.max(0, days.length - 66); i < days.length; i++) if (days[i].c > hi90) { hi90 = days[i].c; hiD = days[i].d; }
console.log(`\n══ 現在位置 ══\n  今日 ${now.d} 收 ${Math.round(now.c)}，距 3個月高點 ${hiD}(${Math.round(hi90)}) 回檔 -${fmt((hi90 - now.c) / hi90 * 100)}%`);
console.log('\n（歷史統計非保證，非投資建議）');
process.exit(0);
