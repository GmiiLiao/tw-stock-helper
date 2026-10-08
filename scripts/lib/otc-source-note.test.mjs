// 上櫃收盤第三方後備的「來源註記」：node --test scripts/lib/otc-source-note.test.mjs
// 依據：使用者 2026-10-09 裁定（實際頻率 a）——後備上站；只在用到後備的那一天，於上櫃相關數據旁加一行小字，
//   平常網站完全不出現該來源字樣。
// 規則：
//   ① API：只在當次回應真的用到第三方後備列（列上 _grade≠official）時，回應帶頂層 otcSource＝{ grade, dataDate }；
//      官方時連鍵都沒有（舊回應形狀不變）；混合（上市官方＋上櫃 3P）照樣帶。stock-day-all 是陣列，旗標就是列上的 _grade。
//   ② 前端：共用 src/components/shared/ThirdPartyNote.tsx 依旗標顯示；來源字樣只准出現在這個元件。
// 不連網：src/lib/otc-source.ts 與 src/lib/twse-api.ts 都是零 import，直接載入（Node 25 內建型別剝除）；
//   路由與元件以原始碼契約檢查（仿 news-website-fixes.test.mjs：註解先剝除再比對）。任何一條紅燈＝註記被改壞或被移除。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lib = await import(new URL('../../src/lib/otc-source.ts', import.meta.url).href);
const twse = await import(new URL('../../src/lib/twse-api.ts', import.meta.url).href);

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = rel => readFileSync(join(ROOT, rel), 'utf8');
/** 去掉整行註解（//、*、/*、{/* 開頭）與行尾 // 註解 */
const code = src => src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
  .map(l => l.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

// ── 列 fixture（getStockDayAllDataInternal 的輸出形狀；Date＝民國 YYYMMDD）──
const tse = code => ({ _market: 'tse', Code: code, Name: code, Date: '1151008', ClosingPrice: '100', Change: '1', OpeningPrice: '99', HighestPrice: '101', LowestPrice: '98', TradeVolume: '1000', TradeValue: '100000', Transaction: '10' });
const otcOfficial = code => ({ ...tse(code), _market: 'otc' });
const otc3P = (code, date = '1151008') => ({ ...tse(code), _market: 'otc', _grade: '3P', Date: date });

test('3P 列 ⇒ otcSource 帶 grade 與資料日（民國日期轉 YYYY-MM-DD）', () => {
  assert.deepEqual(lib.otcSourceOf([otc3P('6488')]), { grade: '3P', dataDate: '2026-10-08' });
  assert.deepEqual(lib.otcSourceField([otc3P('6488')]), { otcSource: { grade: '3P', dataDate: '2026-10-08' } });
  assert.equal(lib.shouldShowOtcNote(lib.otcSourceOf([otc3P('6488')])), true);
});

test('官方 ⇒ 沒有 otcSource（鍵都不存在，舊回應形狀不變）、不顯示註記', () => {
  const rows = [tse('2330'), otcOfficial('6488')];
  assert.equal(lib.otcSourceOf(rows), null);
  assert.deepEqual(lib.otcSourceField(rows), {});
  const body = { ratings: {}, dataDate: '1151008', ...lib.otcSourceField(rows) };
  assert.equal('otcSource' in body, false, '官方回應不可多出 otcSource 鍵');
  assert.equal(lib.shouldShowOtcNote(lib.otcSourceOf(rows)), false);
  // 明示 official、空字串、null 都不是第三方
  assert.equal(lib.otcSourceOf([{ ...otcOfficial('6488'), _grade: 'official' }]), null);
  assert.equal(lib.otcSourceOf([{ ...otcOfficial('6488'), _grade: '' }]), null);
  assert.equal(lib.otcSourceOf([{ ...otcOfficial('6488'), _grade: null }]), null);
  // 空集合、缺列
  assert.equal(lib.otcSourceOf([]), null);
  assert.equal(lib.otcSourceOf([null, undefined]), null);
});

test('混合（上市官方＋上櫃 3P／快照合成列）⇒ 有註記；資料日取第一個認得的 3P 列', () => {
  const mixed = [tse('2330'), otcOfficial('5274'), otc3P('6488')];
  assert.deepEqual(lib.otcSourceOf(mixed), { grade: '3P', dataDate: '2026-10-08' });
  assert.equal(lib.shouldShowOtcNote(lib.otcSourceOf(mixed)), true);
  // 快照出口的列 Date 可能是 ''（上櫃後備合成列）——仍有註記，資料日改取下一個認得的列；全部認不得＝null（不捏造）
  assert.deepEqual(lib.otcSourceOf([otc3P('3105', ''), otc3P('6488')]), { grade: '3P', dataDate: '2026-10-08' });
  assert.deepEqual(lib.otcSourceOf([otc3P('3105', '')]), { grade: '3P', dataDate: null });
  // ISO 日期照收；格式壞的不收
  assert.deepEqual(lib.otcSourceOf([otc3P('6488', '2026-10-07')]), { grade: '3P', dataDate: '2026-10-07' });
  assert.deepEqual(lib.otcSourceOf([otc3P('6488', '115108')]), { grade: '3P', dataDate: null });
  assert.deepEqual(lib.otcSourceOf([otc3P('6488', '1151399')]), { grade: '3P', dataDate: null });
});

test('readOtcSource：前端讀 API 回應的旗標；形狀不符回 null（不捏造）', () => {
  assert.deepEqual(lib.readOtcSource({ otcSource: { grade: '3P', dataDate: '2026-10-08' } }), { grade: '3P', dataDate: '2026-10-08' });
  assert.deepEqual(lib.readOtcSource({ otcSource: { grade: '3P' } }), { grade: '3P', dataDate: null });
  assert.deepEqual(lib.readOtcSource({ otcSource: { grade: '3P', dataDate: 'x' } }), { grade: '3P', dataDate: null });
  assert.equal(lib.readOtcSource({}), null);
  assert.equal(lib.readOtcSource(null), null);
  assert.equal(lib.readOtcSource(undefined), null);
  assert.equal(lib.readOtcSource({ otcSource: '3P' }), null);
  assert.equal(lib.readOtcSource({ otcSource: { grade: 'official' } }), null);
  assert.equal(lib.readOtcSource({ otcSource: { grade: '' } }), null);
  // 盤勢報告：meta.otc.grade
  assert.deepEqual(lib.readReportOtcSource({ meta: { otc: { included: true, dataDate: '2026-10-08', excluded: 0, grade: '3P' } } }), { grade: '3P', dataDate: '2026-10-08' });
  assert.equal(lib.readReportOtcSource({ meta: { otc: { included: true, dataDate: '2026-10-08', excluded: 0 } } }), null);
  assert.equal(lib.readReportOtcSource({ meta: { totalAnalyzed: 1 } }), null);
  assert.equal(lib.readReportOtcSource(null), null);
});

test('前端 allStocks：parseStockDayData 原樣帶 _grade（otcGrade）；官方列沒有這個鍵；otcSourceOfStocks 判斷', () => {
  const p3 = twse.parseStockDayData(otc3P('6488'));
  assert.equal(p3.otcGrade, '3P');
  assert.equal(p3.market, 'otc');
  const po = twse.parseStockDayData(otcOfficial('5274'));
  assert.equal('otcGrade' in po, false, '官方列不可多出 otcGrade 鍵');
  const pt = twse.parseStockDayData(tse('2330'));
  assert.equal('otcGrade' in pt, false);
  assert.deepEqual(lib.otcSourceOfStocks([pt, po, p3]), { grade: '3P', dataDate: null });
  assert.equal(lib.otcSourceOfStocks([pt, po]), null);
  assert.equal(lib.otcSourceOfStocks([]), null);
  assert.equal(lib.otcSourceOfStocks([{ ...po, otcGrade: 'official' }]), null);
});

test('otcSourceOfFallbackRows：只看「沒有即時價、改用 allStocks 收盤列」的代號（持股市值、決策工作台、法人表現價）', () => {
  const stocks = [
    { code: '2330', market: 'tse' },
    { code: '5274', market: 'otc' },
    { code: '6488', market: 'otc', otcGrade: '3P' },
  ];
  // 3P 那檔有即時價 ⇒ 畫面不是用後備列 ⇒ 沒有註記
  assert.equal(lib.otcSourceOfFallbackRows(['2330', '6488'], c => c === '6488', stocks), null);
  // 3P 那檔沒有即時價、改用 allStocks ⇒ 有註記
  assert.deepEqual(lib.otcSourceOfFallbackRows(['2330', '6488'], () => false, stocks), { grade: '3P', dataDate: null });
  // 混合：上市改用收盤＋上櫃 3P 改用收盤 ⇒ 有註記
  assert.deepEqual(lib.otcSourceOfFallbackRows(['2330', '5274', '6488'], c => c === '5274', stocks), { grade: '3P', dataDate: null });
  // 官方：改用的列都是官方 ⇒ 沒有註記
  assert.equal(lib.otcSourceOfFallbackRows(['2330', '5274'], () => false, stocks), null);
  // 畫面上沒有這檔（不在 codes）⇒ 不算
  assert.equal(lib.otcSourceOfFallbackRows(['2330'], () => false, stocks), null);
  assert.equal(lib.otcSourceOfFallbackRows([], () => false, stocks), null);
  assert.equal(lib.otcSourceOfFallbackRows(['6488'], () => false, []), null);
  assert.equal(lib.otcSourceOfFallbackRows(['6488'], () => false, [null, undefined]), null);
});

test('otcSourceIfShowsOtc：整份回應的旗標只套到畫面上真的有上櫃股的區塊（評分逐檔用自己那一列）', () => {
  const src = { grade: '3P', dataDate: '2026-10-08' };
  const isOtc = c => c === '6488' || c === '5274';
  assert.deepEqual(lib.otcSourceIfShowsOtc(src, ['2330', '6488'], isOtc), src, '混合：有上櫃股 ⇒ 加註');
  assert.equal(lib.otcSourceIfShowsOtc(src, ['2330', '2317'], isOtc), null, '全是上市股 ⇒ 這些數字沒用到上櫃資料');
  assert.equal(lib.otcSourceIfShowsOtc(src, [], isOtc), null);
  assert.equal(lib.otcSourceIfShowsOtc(null, ['6488'], isOtc), null, '官方回應（沒有旗標）⇒ 不加註');
  assert.equal(lib.otcSourceIfShowsOtc(undefined, ['6488'], isOtc), null);
  assert.equal(lib.otcSourceIfShowsOtc({ grade: 'official', dataDate: null }, ['6488'], isOtc), null);
});

test('shouldShowOtcNote：只認第三方後備（3P）；其他值一律不顯示', () => {
  assert.equal(lib.shouldShowOtcNote({ grade: '3P', dataDate: null }), true);
  assert.equal(lib.shouldShowOtcNote(null), false);
  assert.equal(lib.shouldShowOtcNote(undefined), false);
  assert.equal(lib.shouldShowOtcNote({ grade: 'official', dataDate: null }), false);
  assert.equal(lib.shouldShowOtcNote({ grade: 'other', dataDate: null }), false);
});

// ── 路由契約：旗標與數據同一個回應 body（同一份 CDN 快取、同一份 memoize 結果）⇒ 官方覆蓋後不會殘留 ──
test('API 路由：rating（全市場＋單檔）、ai-recommend、intraday-picks（即時＋存檔回放）、trend-analysis 都展開 otcSource', () => {
  const rating = code(read('src/app/api/rating/route.ts'));
  assert.equal((rating.match(/otcSourceField\(/g) || []).length, 2, 'rating 兩個出口（單檔、全市場）都要帶');
  assert.match(rating, /otcSourceField\(\[row\]\)/, '單檔只看這一檔的列');
  assert.match(rating, /otcSourceField\(rawData\.filter\(isRegularStock\)\)/, '全市場看評分宇宙');

  const rec = code(read('src/app/api/twse/ai-recommend/route.ts'));
  assert.match(rec, /\.\.\.otcSourceField\(regularRows\)/);
  assert.match(rec, /const stocks = regularRows\.map\(d => parseStock\(d\)\)/, '評分宇宙與旗標用同一批列');

  const ip = code(read('src/app/api/twse/intraday-picks/route.ts'));
  const setIdx = ip.indexOf(".set({ picks: JSON.stringify(picks)");
  assert.ok(setIdx > 0, '找不到盤中榜存檔（改名了？請同步本測試）');
  assert.match(ip.slice(setIdx, setIdx + 200), /\.\.\.otcField/, '存檔要連旗標一起存（回放時與榜單同源）');
  assert.match(ip, /readOtcSource\(saved\)/, '收盤後回放存檔：旗標取自存檔本身');
  assert.match(ip, /otcSourceField\(\[\.\.\.candidates, \.\.\.candidates\.map\(d => baseRowBy\[d\.Code\]\)\]\)/);

  const ta = code(read('src/app/api/twse/trend-analysis/route.ts'));
  assert.match(ta, /otcSourceField\(\[found\]\)/);
  assert.match(ta, /\.\.\.\(day\.otcSource \? \{ otcSource: day\.otcSource \} : \{\}\)/);
});

test('API 路由：Cache-Control 與 gzip 不變；stock-day-all 仍回陣列（旗標＝列上 _grade，不改形狀）', () => {
  const rating = read('src/app/api/rating/route.ts');
  assert.match(rating, /'public, s-maxage=60, stale-while-revalidate=30' : 'public, s-maxage=15'/);
  assert.match(rating, /gzipSync\(Buffer\.from\(JSON\.stringify\(payload\)\)\)/);
  const rec = read('src/app/api/twse/ai-recommend/route.ts');
  assert.match(rec, /return gzipJsonAuto\(\{/);
  assert.match(rec, /\? 'public, s-maxage=60, stale-while-revalidate=30'\s*\n\s*: 'public, s-maxage=15'/);
  const ip = read('src/app/api/twse/intraday-picks/route.ts');
  assert.match(ip, /\{ 'Cache-Control': 'public, s-maxage=300' \}/);
  assert.match(ip, /marketOpen \? 'public, s-maxage=30' : 'public, s-maxage=300'/);
  const ta = read('src/app/api/twse/trend-analysis/route.ts');
  assert.match(ta, /'public, s-maxage=300, stale-while-revalidate=60'/);
  const sda = code(read('src/app/api/twse/stock-day-all/route.ts'));
  assert.match(sda, /gzipSync\(Buffer\.from\(JSON\.stringify\(data\)\)\)/);
  assert.match(sda, /NextResponse\.json\(data, \{ headers \}\)/);
  assert.doesNotMatch(sda, /otcSource/, 'stock-day-all 是陣列，不另加包裝');
});

test('盤勢報告（daily-close）：用到 3P 的上櫃列 ⇒ meta.otc.grade；K 棒排除邏輯不動', () => {
  const dc = code(read('src/app/api/cron/daily-close/route.ts'));
  assert.match(dc, /officialBarRows\(regular, \{ iso: isoDate, otcDoc \}\)/, 'K 棒排除照舊');
  assert.match(dc, /const otcGrade = thirdPartyRows\.length \? \(thirdPartyRows\[0\]\._grade \|\| otcDoc\?\.grade \|\| null\) : null;/);
  assert.match(dc, /const otcReportMeta = otcGrade \? \{ \.\.\.otcMeta, grade: otcGrade \} : otcMeta;/);
  assert.match(dc, /otc: otcReportMeta/);
  const rs = read('src/lib/report-store.ts');
  assert.match(rs, /otc\?: \{ included: boolean; dataDate: string \| null; excluded: number; grade\?: string \}/);
});

// ── 前端契約 ──
test('ThirdPartyNote：固定文字只在這裡、依 shouldShowOtcNote 決定、否則回 null', () => {
  const src = read('src/components/shared/ThirdPartyNote.tsx');
  assert.match(src, /部分上櫃資料來源：FinMind/);
  const c = code(src);
  assert.match(c, /if \(!shouldShowOtcNote\(source\)\) return null;/);
  assert.match(c, /var\(--text-muted\)/, '樣式低調：次要色');
  assert.match(c, /calc\(12\.5px \* var\(--fz\)\)/, '全站字級下限 12.5px×--fz');
});

test('來源字樣只出現在 ThirdPartyNote（src 全掃，含註解）', () => {
  const hits = [];
  const walk = dir => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|js|jsx|mjs|css|json)$/.test(f)) continue;
      if (readFileSync(p, 'utf8').includes('FinMind')) hits.push(p.slice(ROOT.length));
    }
  };
  walk(join(ROOT, 'src'));
  assert.deepEqual(hits, ['src/components/shared/ThirdPartyNote.tsx']);
});

test('掛載點：行情列表（選股）、大盤總覽（家數／漲跌停／排行）、個股頁、AI 推薦（榜單＋盤勢報告）', () => {
  const uses = (rel, re) => {
    const c = code(read(rel));
    assert.match(c, /import ThirdPartyNote from '@\/components\/shared\/ThirdPartyNote'/, `${rel} 要用共用元件`);
    assert.match(c, re, `${rel} 掛載點`);
  };
  uses('src/components/Screener/Screener.tsx', /<ThirdPartyNote source=\{otcSourceOfStocks\(allStocks\) \?\? ratingOtcSource\} \/>/);
  uses('src/components/Dashboard/Dashboard.tsx', /<ThirdPartyNote source=\{otcSourceOfStocks\(validStocks\)\} \/>/);
  uses('src/components/StockDetail/StockDetail.tsx', /<ThirdPartyNote source=\{otcSourceOfStocks\(\[stock\]\) \?\? readOtcSource\(trendData\)\} \/>/);
  uses('src/components/AIRecommend/AIRecommend.tsx', /<ThirdPartyNote source=\{readReportOtcSource\(report\)\} \/>/);
  const ai = code(read('src/components/AIRecommend/AIRecommend.tsx'));
  assert.match(ai, /<ThirdPartyNote source=\{activeTab === 'intraday' \? intraday\?\.otcSource \?\? null : readOtcSource\(data\)\} \/>/);
  assert.match(ai, /otcSource: readOtcSource\(d\)/, '盤中榜旗標與榜單同一次 set');
});

// 審查 MEDIUM（2026-10-09）：同一份含後備的評分／榜單／收盤價在即時追蹤、決策工作台（盤前備課）、投資組合也顯示，要一起加註
test('掛載點（補）：即時追蹤——自選分組（報價＋評分）、AI 推薦分組、法人買賣超表（現價取自 allStocks）', () => {
  const src = read('src/components/WatchlistTracker/WatchlistTracker.tsx');
  const c = code(src);
  assert.match(c, /import ThirdPartyNote from '@\/components\/shared\/ThirdPartyNote'/);
  // 旗標與數據同一次 set（同一個回應）
  assert.match(c, /setRatingsMap\(m\);\s*setRatingOtc\(readOtcSource\(d\)\);/, '評分旗標與 ratingsMap 同一次 set');
  assert.match(c, /setAiStocks\(parsed\);\s*setAiOtc\(readOtcSource\(data\)\);/, 'AI 推薦旗標與榜單同一次 set');
  // 收盤後備（stock-day-all）報價：列上 _grade 原樣帶進報價（只有後備列有這個鍵）
  assert.match(c, /\.\.\.\(isThirdPartyGrade\(item\._grade\) \? \{ otcGrade: String\(item\._grade\) \} : \{\}\)/);
  // 分組：報價（逐列）或評分（只在分組有上櫃股時）
  assert.match(c, /<ThirdPartyNote source=\{otcSourceOfStocks\(group\.stocks\.map\(s => quotes\[s\.code\]\)\) \?\? otcSourceIfShowsOtc\(ratingOtc, group\.stocks\.map\(s => s\.code\)\.filter\(code => ratingsMap\[code\]\), isOtc\)\} \/>/);
  // AI 推薦分組：榜單旗標（評分宇宙）或報價（逐列）
  assert.match(c, /<ThirdPartyNote source=\{aiOtc \?\? otcSourceOfStocks\(aiStocks\.map\(a => quotes\[a\.code\]\)\)\} \/>/);
  // 法人表：現價欄改用 allStocks 的那些列
  assert.match(c, /<ThirdPartyNote source=\{otcSourceOfFallbackRows\(stocks\.map\(s => s\.code\), code => ownPrice\.has\(code\), allStocks\)\} \/>/);
});

test('掛載點（補）：決策工作台（盤前備課）、投資組合（持倉總覽＋損益分析）——只看沒有即時價、改用 allStocks 的列', () => {
  const dd = code(read('src/components/Candidates/DecisionDesk.tsx'));
  assert.match(dd, /import ThirdPartyNote from '@\/components\/shared\/ThirdPartyNote'/);
  assert.match(dd, /<ThirdPartyNote source=\{otcSourceOfFallbackRows\(codes, code => !!liveQ\[code\], allStocks\)\} \/>/);
  const pf = code(read('src/components/Portfolio/Portfolio.tsx'));
  assert.match(pf, /import ThirdPartyNote from '@\/components\/shared\/ThirdPartyNote'/);
  assert.match(pf, /<ThirdPartyNote source=\{otcSourceOfFallbackRows\(holdingCodes, code => liveQuotes\[code\]\?\.price != null, allStocks\)\} \/>/);
  assert.match(pf, /<ThirdPartyNote source=\{otcSourceOfFallbackRows\(openCodes, code => liveQuotes\[code\]\?\.price != null, allStocks\)\} \/>/);
  // 判斷條件要與實際取價一致：live?.price ?? allStocks 的 price
  assert.match(pf, /const currentPrice = live\?\.price \?\? stock\?\.price \?\? h\.buyPrice;/);
  assert.match(pf, /const px = liveQuotes\[p\.code\]\?\.price \?\? allStocks\.find\(s => s\.code === p\.code\)\?\.price \?\? p\.avgCost;/);
  assert.match(dd, /const price = lq\?\.price \?\? s\?\.price \?\? 0;/);
});
