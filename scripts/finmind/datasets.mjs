// ── FinMind 資料集目錄（2026-10-08 目錄員實測整理）────────────────────────────────
// 每個資料集：怎麼發請求（mode）、從哪天起有資料（since）、每次請求約多大（estGz，估磁碟與時間）、怎麼驗證（validator）。
// mode：
//   market-day  dataset＋start_date（不帶 data_id＝全市場單日；多數資料集給 end_date 會被忽略，HoldingSharesPer 給了回 0 列）
//   code-day    dataset＋data_id＋start_date（一檔／一商品一天；KBar 帶 end_date 回 400）
//   broker-day  專屬 endpoint＋date＋securities_trader_id（分點：一家券商一天，回該券商當天所有股票）
//   range       dataset＋start_date～end_date，一次拿區間內全市場（chunkMonths＝依月切段）
//   table       只帶 dataset（整張表，存成當天快照）
//   week        先以 data_id＝2330 查區間取得週資料日，再逐週全市場（集保持股分級）
// 研究用口徑（tw-official-data-sources）：FinMind 是第三方轉載官方 ⇒ 進第二大腦做研究，經實驗解析後才使用，不進正式訓練或計分；
//   原始資料不再散佈、即時資料不上站；本機與 Firestore 雙向備份（後端限定）。使用者 2026-10-08／10-09 裁定。

export const MAIN_START = '2023-01-01';
export const SOURCE_LABEL = '來源 FinMind・研究用';   // 使用者 2026-10-08 裁定的標示字樣（只標在內部檔案，網站不顯示）
export const DAILY_REPORT_EP = 'taiwan_stock_trading_daily_report';
export const SAMPLE_STOCKS = ['2330', '6129', '2603'];   // 上市權值／上櫃小型（目錄員抽樣用過）／上市航運

// A 段（2023-01-01～2026-10-08）回補後全面驗證的發現（2026-10-09，scratchpad/finmind/verify/verifyA.mjs、brokerday.mjs）——併入各資料集 README
const A_SEGMENT_NOTES = Object.freeze({
  TaiwanStockTradingDailyReport: ['2026-10-08 券商路線整日實測：1,044 家中 198 家 0 列（停業或當日無成交）；250 萬列、gz 16.9MB／日（A 段估 12–15GB）；每請求平均 0.38 秒',
    '同日官方比對：4 碼股 賣出合計＝官方成交股數−鉅額 1,941/1,963 檔完全相同、1,960/1,963 在 0.1% 內；ETF 355/355、其他 50/50 完全相同；上市櫃代號無缺；主力集中度自算＝FinMind（不同的 124 檔全是興櫃）'],
  TaiwanStockBrokerDailyConcentration: ['2023-01-11 只有 273 檔（約平常的 1/8，FinMind 當日分點缺）'],
  TaiwanStockBlockTradingDailyReport: ['與 FinMind 鉅額交易日成交（TaiwanStockBlockTrade）逐檔比：買進合計＝賣出合計＝鉅額股數 98.4%；不同的都是逐券商表整檔沒有列（例 2026-04-28 1316）'],
  TaiwanStockDividendResult: ['2023–2026 整段：reference_price＝官方開盤競價基準（上市 TWT84U、上櫃前一日次日參考價）9,311/9,322（不同的 11 筆都在颱風休市隔天，是比對口徑）；before_price＝官方前一日收盤 9,312/9,312',
    '「權」類（多為現金增資除權）官方開盤基準不調整、after_price 是 FinMind 的理論除權價（524 筆中 351 筆與官方基準不同）⇒ 要官方開盤基準用 reference_price，不要用 after_price'],
  TaiwanStockGovernmentBankBuySell: ['A 段實測：2023-01-11 整天 0 列；2023-03-16（2,258 列）、2023-04-06（1,872）、2023-10-25（4,249）、2025-03-26（86）部分缺——與 FinMind 公告的缺漏一致'],
  TaiwanStockActiveETFHolding: ['投信隔日才陸續揭露：2026-10-08 晚上抓 10-08 只有 10／38 檔、10-07 也只有 31 檔 ⇒ settleDays 2（抓取日晚於下一個交易日才定版，否則下次自動重抓）',
    'FinMind 歷史部分缺：2026-01-19（424 列）、2026-05-25（743 列）'],
  TaiwanStockConvertibleBondDailyOverview: ['2026-02-02 只有 42 檔（平常約 360，FinMind 當日部分缺）；最新鏡像日（10-02）對櫃買 ISSBD5 發行額 378/379、流通餘額 376/379'],
  TaiwanOptionOpenInterestLargeTraders: ['週契約（contract_type=week，2025-12-24 起的個股週選）有 366 列「前 10 大 > 全市場未平倉」且自報百分比 >100%：是期交所報表口徑（不是轉載錯誤）；另 4 列百分比四捨五入不一致'],
  TaiwanStockPriceAdj: ['A 段實測：Trading_Volume＝官方成交股數 26,695/26,695（12 日、上市櫃全部）；最新日 close＝官方收盤 2,371/2,371'],
});

// 重資料集：每請求 gz ≥ 200KB（原始 JSON 約 MB 級：期貨／選擇權逐筆、5 秒指數、集保、八大行庫）⇒ heavy，
//   降速時段（平日 08:30–13:45、daemon 重任務窗）整段暫停（timewin.windowState；2026-10-09 審查：次數上限擋不住頻寬與 CPU）
export const HEAVY_GZ_BYTES = 200e3;
const D = (name, zh, o) => Object.freeze({
  name, zh, endpoint: 'data', dateParam: 'start_date', since: null, emptyOk: false, validator: 'structural',
  rank: 50, enabled: true, cheap: false, timeoutMs: 120e3, estGz: 10e3, cols: [], ...o,
  heavy: o.heavy ?? (o.estGz ?? 10e3) >= HEAVY_GZ_BYTES,
  notes: [...(o.notes || []), ...(A_SEGMENT_NOTES[name] || [])],
});

export const DATASETS = Object.freeze([
  // ── 輔助清單 ──
  D('TaiwanSecuritiesTraderInfo', '證券商資訊表（分點券商路線的清單）', { tier: 'Free', mode: 'table', rank: 1, cheap: true, estGz: 35e3,
    cols: ['securities_trader_id', 'securities_trader', 'date'], notes: ['含已不存在的歷史券商與興櫃推薦證券商（代碼結尾 T）；date 欄是設立日'] }),
  D('TaiwanStockTradingDate', '台股交易日（2022-07-18 以前的空閒佇列用來排日期）', { tier: 'Free', mode: 'range', rank: 2, cheap: true, since: '1990-01-01', estGz: 5e3, cols: ['date'] }),
  // ── 真正的缺口：分點 ──
  D('TaiwanStockTradingDailyReport', '台股分點資料表（每家券商、每檔股票、每個成交價的買進／賣出股數）', { tier: 'Sponsor', mode: 'broker-day',
    endpoint: DAILY_REPORT_EP, dateParam: 'date', since: '2021-06-30', rank: 20, estGz: 14e3, estGzStock: 5e3, timeoutMs: 120e3, validator: 'broker',
    cols: ['securities_trader', 'price', 'buy', 'sell', 'securities_trader_id', 'stock_id', 'date'],
    notes: ['單位：股', '同股同日的買進合計和賣出合計可能不相等；不含鉅額交易；興櫃推薦券商（代碼結尾 T）的 price 為 0',
      'FinMind 缺 2022-10-31～11-03、2023-01-11～17（回 0 列屬正常）',
      '2026-10-08 實測：買進合計≈chipArchive 張數×1000（2330 2026-10-07：15,549,183 股 vs 15,562 張），比 MI_INDEX 成交股數少約 2–8%（不含鉅額）', '預設走券商路線（一家券商一天）；--route stock 走股票路線（抽樣驗證用，另存 by-stock/）'] }),
  D('TaiwanStockTradingDailyReportSecIdAgg', '當日券商分點統計表', { tier: 'Sponsor', mode: 'code-day', enabled: false,
    disabledReason: '內容和分點資料表重複（可自行彙總），且 data_id＋securities_trader_id 都必填，全市場要數十萬組；本輪不抓' }),
  D('TaiwanStockWarrantTradingDailyReport', '權證分點資料表', { tier: 'Sponsor', mode: 'broker-day', enabled: false,
    disabledReason: '不在缺口清單，權證上萬檔；延後' }),
  D('TaiwanStockBrokerDailyConcentration', '每日個股主力集中度（FinMind 由分點算出的衍生值）', { tier: 'Sponsor', mode: 'market-day', since: '2021-06-30', rank: 10, cheap: true, estGz: 31e3,
    cols: ['date', 'stock_id', 'top_k', 'top_buy_volume', 'top_sell_volume'], notes: ['衍生值，有分點原始資料就能自己算；當對照組'] }),
  D('TaiwanStockBlockTradingDailyReport', '鉅額交易買賣日報表（逐券商）', { tier: 'Sponsor', mode: 'market-day', since: '2026-04-28', rank: 10, cheap: true, emptyOk: true, estGz: 1.5e3,
    cols: ['securities_trader', 'price', 'buy', 'sell', 'trade_type', 'securities_trader_id', 'stock_id', 'date'], notes: ['分點資料不含鉅額交易，這份補上'] }),
  // ── 真正的缺口：分 K／逐筆 ──
  D('TaiwanStockKBar', '台股個股 1 分 K', { tier: 'Sponsor', mode: 'code-day', members: 'stocks', since: '2019-01-01', rank: 30, estGz: 2e3, timeoutMs: 60e3, validator: 'kbar',
    cols: ['date', 'minute', 'stock_id', 'open', 'high', 'low', 'close', 'volume'],
    notes: ['成交量單位：上市櫃是張，興櫃是股', '第三方資料，只能做研究（不得進正式訓練）', 'FinMind 缺 2019-02-20～22',
      '2026-10-08 以目錄員樣本實測：開高低收與官方完全相同；量加總約為官方張數的 92%（2330：14,381 vs 15,562 張），口徑不同，量不可當官方成交量'] }),
  D('TaiwanStockPriceTick', '台股歷史逐筆成交（含內外盤 TickType）', { tier: 'Backer', mode: 'code-day', members: 'stocks', since: '2018-12-07', rank: 60, estGz: 12e3, timeoutMs: 90e3, validator: 'tick',
    cols: ['date', 'stock_id', 'deal_price', 'volume', 'Time', 'TickType'],
    notes: ['全量放不下本期額度：建議只抓近 120 個交易日或觀察名單', 'TickType 2018-12-07～2023-03-10 已由 FinMind 重算；2021-06-22 以前約 8–10% 為 0（無法判定）',
      '含 14:30 盤後定價；2026-10-08 實測：最後成交價＝官方收盤，量加總約官方張數 93%（2330：14,406 vs 15,562）'] }),
  // 期權三個 rank 25–27（原 40／45／46）：2026-10-08 回補規劃——三者 A 段合計約 5.4k 請求、10 小時，排在分 K（rank 30，169 萬請求）之前，
  //   同一條指令「分點→期權→分 K」時，訂閱到期前若跑不完，被截掉的只會是分 K 最舊的尾段，不會是期權。
  D('TaiwanFuturesKBar', '期貨 1 分 K', { tier: 'Sponsor', mode: 'code-day', members: 'futures', defaultMembers: ['TX', 'MTX', 'TMF'], since: '2011-01-03', rank: 25, estGz: 21e3,
    cols: ['date', 'futures_id', 'contract_date', 'minute', 'open', 'high', 'low', 'close', 'volume'], notes: ['含所有月份、價差與夜盤；夜盤記在日曆日，與日成交表的交易日歸屬不同'] }),
  D('TaiwanFuturesTick', '期貨交易明細（逐筆）', { tier: 'Backer', mode: 'code-day', members: 'futures', defaultMembers: ['TX', 'MTX'], since: '2011-01-03', rank: 26, estGz: 265e3, timeoutMs: 180e3,
    cols: ['contract_date', 'date', 'futures_id', 'price', 'volume'], notes: ['成交量是雙邊計（約日成交口數 2 倍），不含議價鉅額；date 是時間戳，涵蓋日曆日 00:00–24:00'] }),
  D('TaiwanOptionTick', '選擇權交易明細（逐筆）', { tier: 'Backer', mode: 'code-day', members: 'options', defaultMembers: ['TXO'], since: '2011-01-03', rank: 27, estGz: 2.9e6, timeoutMs: 300e3,
    cols: ['ExercisePrice', 'PutCall', 'contract_date', 'date', 'option_id', 'price', 'volume'], notes: ['TXO 一天約 77.5 萬列、107MB JSON（串流切列、只存 gz）', '2019-01-16～06-30 不完整'] }),
  // ── 可轉債 ──
  D('TaiwanStockConvertibleBondInfo', '可轉債總覽', { tier: 'Backer', mode: 'table', rank: 5, cheap: true, estGz: 35e3, cols: ['cb_id', 'cb_name'] }),
  D('TaiwanStockConvertibleBondDaily', '可轉債日成交資訊', { tier: 'Backer', mode: 'market-day', rank: 12, cheap: true, emptyOk: true, estGz: 16e3, cols: ['cb_id', 'close', 'date'] }),
  D('TaiwanStockConvertibleBondDailyOverview', '可轉債每日總覽（轉換價、餘額、標的股價）', { tier: 'Backer', mode: 'market-day', rank: 11, cheap: true, estGz: 17e3,
    cols: ['cb_id', 'date', 'ConversionPrice', 'OutstandingAmount'], notes: ['每天抓就能拼出轉換價與流通餘額的日序列'] }),
  D('TaiwanStockConvertibleBondInstitutionalInvestors', '可轉債三大法人日交易', { tier: 'Backer', mode: 'market-day', rank: 12, cheap: true, emptyOk: true, estGz: 4.2e3, cols: ['cb_id', 'date', 'Total_Overbuy'] }),
  D('TaiwanStockConvertibleBondMonthlyAnalysis', '可轉換公司債月份分析表（月保管餘額）', { tier: 'Backer', mode: 'range', since: '2026-05-01', rank: 5, cheap: true, estGz: 27e3, cols: ['cb_id', 'custody_balance', 'date'] }),
  D('TaiwanStockConvertibleBondPutProvision', '可轉債賣回權時程（含未來場次）', { tier: 'Backer', mode: 'range', since: '2011-06-22', rangeTo: 'next-year-end', rank: 5, cheap: true, estGz: 5e3,
    cols: ['date', 'cb_id', 'PutPrice'] }),
  // ── 還原股價與參考價 ──
  D('TaiwanStockPriceAdj', '還原股價', { tier: 'Backer', mode: 'market-day', since: '1994-10-01', rank: 15, cheap: true, estGz: 110e3,
    cols: ['date', 'stock_id', 'open', 'max', 'min', 'close', 'Trading_Volume'],
    notes: ['不能當 PIT：FinMind 從最新交易日往回推算，每有新事件就改寫整段歷史 ⇒ 同一時段一次抓完、留一份快照當對照（_manifest 記錄抓取期間）'] }),
  D('TaiwanStockDividendResult', '除權除息結果', { tier: 'Backer', mode: 'market-day', since: '2003-05-01', rank: 13, cheap: true, emptyOk: true, estGz: 0.5e3, validator: 'dividend',
    cols: ['date', 'stock_id', 'before_price', 'after_price'] }),
  D('TaiwanStockCapitalReductionReferencePrice', '減資恢復買賣參考價', { tier: 'Backer', mode: 'range', since: '2011-01-01', rank: 5, cheap: true, estGz: 3.5e3,
    cols: ['date', 'stock_id', 'PostReductionReferencePrice'] }),
  D('TaiwanStockSplitPrice', '分割後參考價', { tier: 'Free', mode: 'range', startOnly: true, rank: 5, cheap: true, estGz: 1e3, cols: ['date', 'stock_id', 'before_price', 'after_price'] }),
  D('TaiwanStockParValueChange', '變更面額恢復買賣參考價', { tier: 'Free', mode: 'range', startOnly: true, since: '2020-01-01', rank: 5, cheap: true, estGz: 0.5e3, cols: ['date', 'stock_id'] }),
  // ── 期權法人與大額交易人 ──
  D('TaiwanFuturesInstitutionalInvestors', '期貨三大法人', { tier: 'Backer', mode: 'market-day', since: '2018-06-05', rank: 14, cheap: true, estGz: 2e3, cols: ['futures_id', 'date', 'institutional_investors'] }),
  D('TaiwanOptionInstitutionalInvestors', '選擇權三大法人', { tier: 'Backer', mode: 'market-day', since: '2018-06-05', rank: 14, cheap: true, estGz: 0.8e3, cols: ['option_id', 'date', 'call_put'] }),
  D('TaiwanFuturesInstitutionalInvestorsAfterHours', '期貨夜盤三大法人', { tier: 'Backer', mode: 'market-day', since: '2021-10-12', rank: 11, cheap: true, emptyOk: true, estGz: 0.9e3, cols: ['futures_id', 'date'] }),
  D('TaiwanOptionInstitutionalInvestorsAfterHours', '選擇權夜盤三大法人', { tier: 'Backer', mode: 'market-day', since: '2021-10-12', rank: 11, cheap: true, emptyOk: true, estGz: 0.3e3, cols: ['option_id', 'date'] }),
  D('TaiwanFuturesOpenInterestLargeTraders', '期貨大額交易人未沖銷部位', { tier: 'Backer', mode: 'market-day', since: '1998-07-01', rank: 12, cheap: true, estGz: 45e3, cols: ['futures_id', 'date', 'market_open_interest'] }),
  D('TaiwanOptionOpenInterestLargeTraders', '選擇權大額交易人未沖銷部位', { tier: 'Backer', mode: 'market-day', since: '1998-07-01', rank: 12, cheap: true, estGz: 5e3, cols: ['option_id', 'date', 'market_open_interest'] }),
  // ── 籌碼補充 ──
  D('TaiwanStockGovernmentBankBuySell', '八大行庫買賣', { tier: 'Sponsor', mode: 'market-day', since: '2021-06-30', rank: 11, cheap: true, estGz: 241e3,
    cols: ['date', 'stock_id', 'buy', 'sell', 'bank_name'], notes: ['FinMind 缺 2023-01-11 整天；2023-03-16、2023-04-06、2023-10-25、2025-03-26 部分缺'] }),
  // settleDays 2：投信隔日才陸續揭露（2026-10-08 當晚抓 10-08 只有 10／38 檔），抓取日晚於下一個交易日才算定版
  D('TaiwanStockActiveETFHolding', '主動式 ETF 每日持股明細', { tier: 'Sponsor', mode: 'market-day', since: '2025-05-05', rank: 11, cheap: true, estGz: 59e3, settleDays: 2,
    cols: ['date', 'stock_id', 'component_stock_id', 'shares', 'weight'] }),
  D('TaiwanStockActiveETFHoldingChange', '主動式 ETF 每日持股異動', { tier: 'Sponsor', mode: 'market-day', since: '2025-05-05', rank: 12, cheap: true, emptyOk: true, estGz: 4.9e3, settleDays: 2,
    cols: ['date', 'stock_id', 'component_stock_id', 'buy', 'sell'], notes: ['申購買回造成的增減也算在內'] }),
  D('TaiwanStockBlockTrade', '鉅額交易日成交資訊', { tier: 'Sponsor', mode: 'market-day', since: '2005-04-04', rank: 13, cheap: true, emptyOk: true, estGz: 2e3, cols: ['date', 'stock_id', 'price', 'volume'] }),
  D('TaiwanStockMarginMaintenance', '個股融資維持率（FinMind 估算值）', { tier: 'Sponsor', mode: 'market-day', since: '2001-01-05', rank: 12, cheap: true, estGz: 29e3,
    cols: ['date', 'stock_id', 'margin_maintenance'], notes: ['估算值，官方沒有真值，只能當相對的融資壓力指標'] }),
  D('TaiwanTotalExchangeMarginMaintenance', '大盤融資維持率', { tier: 'Backer', mode: 'range', since: '2001-01-05', rank: 5, cheap: true, estGz: 6.5e3, cols: ['date', 'TotalExchangeMarginMaintenance'] }),
  D('TaiwanStockHoldingSharesPer', '股權持股分級（集保週資料）', { tier: 'Backer', mode: 'week', since: '2010-01-29', discoverId: '2330', rank: 16, cheap: true, estGz: 806e3, timeoutMs: 180e3,
    cols: ['date', 'stock_id', 'HoldingSharesLevel', 'people', 'percent', 'unit'], notes: ['全市場只能給 start_date（同時帶 end_date 回 0 列）；週資料日由 data_id=2330 的區間查詢取得'] }),
  D('TaiwanStockDispositionSecuritiesPeriod', '公布處置有價證券', { tier: 'Backer', mode: 'range', since: '2001-01-01', rank: 5, cheap: true, estGz: 120e3,
    cols: ['date', 'stock_id', 'period_start', 'period_end'] }),
  D('TaiwanStockIndustryChain', '個股所屬產業鏈（現行分類）', { tier: 'Backer', mode: 'table', rank: 5, cheap: true, estGz: 74e3, cols: ['stock_id', 'industry', 'sub_industry'],
    notes: ['只有目前的分類，date 欄是最後更新日'] }),
  D('TaiwanStockIndustryChainMoneyFlow', '台股產業鏈資金流向（FinMind 衍生值）', { tier: 'Sponsor', mode: 'market-day', since: '1992-01-04', rank: 13, cheap: true, estGz: 18e3,
    cols: ['date', 'industry', 'trading_money'], notes: ['歷史一律套用現行產業鏈分類，有前視偏誤，研究時要另外標記'] }),
  D('TaiwanStockEvery5SecondsIndex', '每 5 秒指數統計（上市＋上櫃）', { tier: 'Backer', mode: 'market-day', since: '2005-01-03', rank: 17, cheap: true, estGz: 865e3, timeoutMs: 180e3,
    cols: ['date', 'time', 'stock_id', 'price'] }),
  D('TaiwanOptionVix', '臺指選擇權波動率指數（盤中分鐘序列）', { tier: 'Backer', mode: 'range', since: '2026-03-01', chunkMonths: 1, rank: 6, cheap: true, estGz: 90e3, cols: ['date', 'time', 'vix'] }),
  D('TaiwanStockPriceLimit', '每日漲跌停價', { tier: 'Backer', mode: 'market-day', since: '2000-01-01', rank: 13, cheap: true, estGz: 35e3, validator: 'price-limit',
    cols: ['date', 'stock_id', 'reference_price', 'limit_up', 'limit_down'], notes: ['limit=0 代表無漲跌幅限制（興櫃、槓桿 ETF 等）',
      '2026-10-08 實測（2026-10-06）：4 碼股 1,962/1,980 與官方相同；ETF 用錯檔位（上市 ETF 只對 9/83）、REITs／ETN 也不對 ⇒ ETF 漲跌停一律以官方 TWT84U 為準'] }),
  D('TaiwanStockMarketValue', '個股市值', { tier: 'Backer', mode: 'market-day', since: '2004-01-01', rank: 13, cheap: true, estGz: 27e3, validator: 'market-value', cols: ['date', 'stock_id', 'market_value'] }),
  D('TaiwanStockMarketValueWeight', '市值比重（排名）', { tier: 'Backer', mode: 'market-day', since: '2024-10-30', rank: 13, cheap: true, emptyOk: true, estGz: 15e3, cols: ['rank', 'stock_id', 'weight_per', 'date', 'type'],
    notes: ['2026-10-08 試抓實測：不是每天都有。上市（type=twse）只有月底（每月最後交易日，2024-10-30 起，2330 查得 20 個月、2024-11～2025-01 等月份缺）；上櫃（type=tpex）2024-11-15 起近乎逐日但有缺日（6488 查得 142 天）⇒ 非月底日只回上櫃、有些日子回 0 列（例 2025-10-17）屬正常',
      '兩市場各自排名，weight_per 各自加總約 100（2026-09-30：上市 1,071 檔、上櫃 890 檔）'] }),
  D('TaiwanBusinessIndicator', '景氣對策信號（月）', { tier: 'Backer', mode: 'range', since: '1982-01-01', rank: 5, cheap: true, estGz: 1.5e3, cols: ['date', 'monitoring', 'monitoring_color'],
    notes: ['官方國發會有開放資料，正式用途優先改走官方'] }),
]);

const BY_NAME = new Map(DATASETS.map(d => [d.name, d]));

export function getSpec(name) {
  const s = BY_NAME.get(name);
  if (!s) throw new Error(`未知的資料集：${name}`);
  return s;
}

/** --dataset 參數：逗號分隔；cheap＝所有便宜的全市場資料集。停用的資料集直接拒絕（附理由）。 */
export function resolveDatasets(arg) {
  const names = String(arg || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!names.length) throw new Error('要指定 --dataset（逗號分隔，或 cheap）');
  const out = [];
  for (const n of names) {
    const list = n === 'cheap' ? DATASETS.filter(d => d.cheap && d.enabled) : [getSpec(n)];
    for (const s of list) {
      if (!s.enabled) throw new Error(`${s.name} 本輪不抓：${s.disabledReason}`);
      if (!out.includes(s)) out.push(s);
    }
  }
  return out.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}
