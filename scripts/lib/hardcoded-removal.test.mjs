// 寫死值移除的原始碼掃描 ratchet：node --test scripts/lib/hardcoded-removal.test.mjs
// 2026-10-08 使用者裁定「不使用原來的寫死值，使用判讀結果真實表示」「依判讀方向給出正確提示」（hardcoded-to-real-spec §8 T7）。
// 只讀檔案文字、不連網；註解先剝除再比對（仿 company-list.test.mjs 的 code()，另含 JSX 註解 {/* … */}）。
// 任何一條紅燈＝有人把寫死值、無據推論或推薦語放回去了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
/** 去掉整行註解（//、*、/*、{/* 開頭）與行尾 // 註解 */
const code = src => src.split('\n')
  .filter(l => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(l))
  .map(l => l.replace(/\s\/\/\s.*$/, ''))
  .join('\n');

const FILES = {
  route: 'src/app/api/twse/trend-analysis/route.ts',
  stockDetail: 'src/components/StockDetail/StockDetail.tsx',
  trendPanel: 'src/components/AIRecommend/TrendPanel.tsx',
  aiRecommend: 'src/components/AIRecommend/AIRecommend.tsx',
  buySell: 'src/components/AIRecommend/BuySellPanel.tsx',
  signalAnalysis: 'src/components/StockDetail/SignalAnalysis.tsx',
  preTrade: 'src/components/StockDetail/PreTradeCheck.tsx',
  scoring: 'src/lib/scoring-server.ts',
  enrich: 'src/lib/analysis-enrich.ts',
  screener: 'src/components/Screener/Screener.tsx',
  watchlist: 'src/components/WatchlistTracker/WatchlistTracker.tsx',
  localAnalyze: 'scripts/local-analyze.mjs',
  readings: 'src/lib/stock-readings.ts',
};
const RAW = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, read(f)]));
const SRC = Object.fromEntries(Object.entries(RAW).map(([k, s]) => [k, code(s)]));

/** 逐條斷言「不得出現」；字串＝子字串比對，RegExp＝正規式 */
function assertAbsent(key, banned) {
  for (const b of banned) {
    const hit = typeof b === 'string' ? SRC[key].includes(b) : b.test(SRC[key]);
    assert.ok(!hit, `${FILES[key]} 不得出現：${b}`);
  }
}

test('trend-analysis route：寫死值、無據推論、推薦語、捏造新聞與業務描述都已移除', () => {
  assertAbsent('route', [
    /\?\s*72\s*:\s*58/, /consensusRating:\s*'(BUY|HOLD)/, /avgTargetUpside:\s*'\+/, /institutionalSentiment:\s*\d/,
    '62%', '今日溫和上漲', 'AI 供應鏈受惠', '後市看多', '今日雖上漲', '主力', '法人資金',
    '建議買價', '理想低接價', 'AI 模型推算', '停損設昨收 -5%',
    'industryNewsMap', '穩健上攻', '外資買超訊號值得追蹤', 'AI 技術分析',
    'BUSINESS_DB', '受惠 AI 換機潮', '助企業 AI 化轉型', '代表性廠商', '全球第三大晶圓代工',
    'prevClose * 1.1', 'prevClose * 0.9', "recommendation = 'strong_buy'", "rec = 'strong_buy'",
  ]);
});

test('trend-analysis route：legacy companyScale 預設只准一處且標 legacy L20', () => {
  const lines = RAW.route.split('\n').filter(l => /companyScale: 'mid',/.test(l));
  assert.equal(lines.length, 1, 'companyScale: \'mid\' 只准出現在 legacy 預設物件一處');
  assert.match(lines[0], /legacy L20/);
});

test('trend-analysis route：讀取失敗走短快取＋X-Data-Status: partial，正常 300 秒，皆經 gzip', () => {
  assert.match(SRC.route, /'X-Data-Status': 'partial'/);
  assert.match(SRC.route, /'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=15'/);
  assert.match(SRC.route, /'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60'/);
  assert.match(SRC.route, /gzipJsonAuto\(body,/);
  assert.doesNotMatch(SRC.route, /cacheHeader\('quote'\)/);
  // GET 內不得直接打上游（company-list.test.mjs 也有同條；這裡再護一次新增的判讀讀取）
  const getBody = RAW.route.slice(RAW.route.indexOf('export async function GET'), RAW.route.indexOf('// ─── Types'));
  assert.doesNotMatch(getBody, /fetch\(/);
  assert.match(getBody, /getInstFlowTable\(\)/);
  assert.match(getBody, /readMarketSnapshot\(\)/);
});

test('StockDetail：信心度、AI 計算、目標區間、ATR 波動率、±9.5% 近似、看好度等都不再渲染', () => {
  assertAbsent('stockDetail', [
    '信心度', 'AI 計算', '目標區間', 'ATR 波動率', '技術面支撐', '明日有機會延續漲勢', '短線不宜搶反彈',
    '?? 0) > 0.7', 'changePct >= 9.5', 'changePct <= -9.5', '鎖板', 'signal.strength.toFixed(0)}%',
    'ind.sector', 'ind.description', 'io.institutionalSentiment', '法人看好度', '明日開盤建議', 'REC_CONFIG',
    '買進訊號', '賣出警示', '建議停損價',
  ]);
});

test('TrendPanel：平均目標漲幅、共識評等、短中長期寫死判斷、動能儀表、產業說明已移除', () => {
  assertAbsent('trendPanel', [
    '平均目標漲幅', '市場共識評等', '短期（1個月）', "includes('多')", '統計模型推算', 'AI 正在分析',
    'industry.sector', 'industry.description', 'MomentumGauge', 'SentimentBar', '法人看好度', '上漲催化劑',
    'recConfig', 'pm.stopLossPrice', '委買掛單策略', '開盤前委買建議',
  ]);
});

test('AIRecommend：信心度格、建議買點、第一目標、買賣點預測已移除', () => {
  assertAbsent('aiRecommend', ['view.confidence', '建議買點', '第一目標', '買賣點預測']);
});

test('BuySellPanel：達到率數字、強度 %、動作提示、常數交易設定、推薦／首選、AI 量化模型預測已移除', () => {
  assertAbsent('buySell', [
    '{zone.probability}%', '{z.probability}%', '{target.probability}%', 'p.actionHint', '{p.strength}%',
    'setup.maxRisk', 'setup.expectedGain', 'setup.positionSizing', 'setup.entryTiming',
    'AI 量化模型預測', '>推薦<', '>首選<',
  ]);
});

test('SignalAnalysis：R 倍數不再依陣列索引寫死', () => {
  assertAbsent('signalAnalysis', ['[1.5, 2.5, 4][i]']);
});

test('PreTradeCheck：不再以 −8% 冒充停損、不寫建議停損與 AI 出場計畫', () => {
  assertAbsent('preTrade', ['0.92', '建議停損', 'AI 出場計畫']);
});

test('四個停損顯示檔都標「參考停損（進場前）」（tw-ai-stoploss §2）', () => {
  for (const k of ['buySell', 'aiRecommend', 'signalAnalysis', 'preTrade']) {
    assert.ok(RAW[k].includes('參考停損（進場前）'), `${FILES[k]} 缺「參考停損（進場前）」`);
  }
});

test('scoring-server：達到率不寫死、型態與理由不含無據因果與推薦語、稽核只寫方向', () => {
  assertAbsent('scoring', [
    /probability:\s*\d/, '明日有機會挑戰漲停', '主力', '法人認同', '法人資金', '護盤', '籌碼鎖定', '多頭確認', '絕佳',
    '淨勝 33%', '淨勝 39.8%',
  ]);
});

test('analysis-enrich：不再推算未校準的達到率', () => {
  assertAbsent('enrich', ['? 85 :', 'targetTouchProbability(', /probability:\s*\d/]);
});

test('Screener／WatchlistTracker：評級加成目標價不再顯示', () => {
  assertAbsent('screener', ['sort-targetPrice', "handleSort('targetPrice')", 'ratingFor(stock.code).targetPrice']);
  assertAbsent('watchlist', ['getTargetPrice']);
});

test('local-analyze：達成率必須在 null 判斷內，不印 null%', () => {
  const lines = SRC.localAnalyze.split('\n').filter(l => l.includes('達成率${t.probability}'));
  assert.ok(lines.length > 0, '找不到達成率輸出（被改名請更新本測試）');
  for (const l of lines) assert.match(l, /typeof t\.probability === 'number'/, `達成率未經 null 判斷：${l.trim()}`);
});

test('stock-readings 公開文字：不含你核可、內部模型代號、集合名、看好', () => {
  const text = RAW.readings.match(/export const READING_TEXT = \{[\s\S]*?\n\} as const;/)?.[0];
  assert.ok(text, '找不到 READING_TEXT');
  for (const b of ['你核可', 'v3 S', 'v3 W', '波段公式 D', 'M0-b', 'chipCharacter', 'volAvg20', 'chipDaily', '看好']) {
    assert.ok(!text.includes(b), `READING_TEXT 不得出現：${b}`);
  }
  assert.doesNotMatch(SRC.readings, /^import /m, 'stock-readings.ts 必須零 import（node --test 直接載入、用戶端共用）');
});

test('2026-10-08 審查修正：資料日閘門、ETF 檔位、稽核母體、文案不再退回', () => {
  // route：漲跌停與數值事實一律走純函式（有單元測試），不再用個股檔位的 isLimitUp／isLimitDown，也不靠「_source 為空」判斷成交值
  assertAbsent('route', ['isLimitUp(', 'isLimitDown(', '!stock._source', '漲停 0.99～1.05', "'明日漲停價（檔位）'"]);
  assert.match(SRC.route, /quoteFactsOf\(code, quoteRowOf\(stockData\)/);
  assert.match(SRC.route, /loadStockDay\(code\)\.then\(async d => \(\{ \.\.\.d, snap: await readMarketSnapshot\(\) \}\)\)/);
  assertAbsent('readings', ['當日籌碼判讀見頁首']);
  assertAbsent('stockDetail', ['isLimitUpExact', 'isLimitDownExact', "tradeValue: stock.value > 0 ? stock.value : null", "stopRef.price.toFixed(2) : '公式不適用'"]);
  assertAbsent('trendPanel', ["stopRef.price.toFixed(2) : '公式不適用'"]);
  assertAbsent('buySell', ['本站不提供倉位比例建議']);
  assertAbsent('signalAnalysis', ['部位大小建議', '建議張數']);
  assertAbsent('preTrade', ['跌破停損將啟動每日紀律追蹤', 'AI 技術評分']);
  assertAbsent('scoring', ['移動停利建議', '可將停損調整至成本+2%']);
  assertAbsent('enrich', ['風險報酬比 ${mult}:1']);
  assertAbsent('aiRecommend', ['股價層級／形態']);
});
