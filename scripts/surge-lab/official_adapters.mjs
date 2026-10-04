// ── 官方資料回補的端點定義（上市 www.twse.com.tw rwd、上櫃 www.tpex.org.tw；皆帶日期、回應回聲資料日）──
// 2026-10-04 逐支以 2024-03-04 實測：http 200、stat OK、date 回聲＝請求日、欄位如各註解。
// validate 只做「是不是這一天、有沒有逐檔表」；解析留給 python（原樣保存整份 JSON，之後改解析不必重抓）。

const d8 = day => day.replace(/-/g, '');
const slash = day => encodeURIComponent(day.replace(/-/g, '/'));
const hasTable = (j, mustField) => (j.tables || (j.fields ? [{ fields: j.fields, data: j.data }] : []))
  .some(t => Array.isArray(t.fields) && t.fields.includes(mustField) && Array.isArray(t.data) && t.data.length > 0);

/** 共同驗證：stat 正常（上市 'OK'、上櫃 'ok'）、date 回聲＝請求日、逐檔表存在。 */
function check(j, day, mustField) {
  if (!j || typeof j !== 'object') return { ok: false, reason: '回應不是物件' };
  if (String(j.stat || '').toLowerCase() !== 'ok') return { ok: false, reason: `stat=${j.stat}` };
  if (String(j.date || '') !== d8(day)) return { ok: false, reason: `資料日回聲 ${j.date} ≠ ${d8(day)}` };
  if (!hasTable(j, mustField)) return { ok: false, reason: `沒有含「${mustField}」的逐檔表（非交易日或無資料）` };
  return { ok: true, tables: j };
}

export const ADAPTERS = [
  {
    // 每日收盤行情（不含權證）：證券代號|成交股數|成交筆數|成交金額|開高低收|最後揭示買賣價量|本益比；另含大盤統計與指數表
    name: 'twse_daily', host: 'www.twse.com.tw', from: '2022-07-18',
    url: day => `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d8(day)}&type=ALLBUT0999&response=json`,
    validate: (j, day) => check(j, day, '成交筆數'),
  },
  {
    // 三大法人：外陸資／外資自營商／投信／自營商（自行買賣、避險）買進賣出與買賣超股數
    name: 'twse_t86', host: 'www.twse.com.tw', from: '2022-07-18',
    url: day => `https://www.twse.com.tw/rwd/zh/fund/T86?date=${d8(day)}&selectType=ALLBUT0999&response=json`,
    validate: (j, day) => check(j, day, '自營商買賣超股數(避險)'),
  },
  {
    // 外資及陸資持股：發行股數|全體外資及陸資持股比率|尚可投資比率|投資上限比率（發行股數＝上市股本的逐日官方來源）
    name: 'twse_qfiis', host: 'www.twse.com.tw', from: '2022-07-18',
    url: day => `https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date=${d8(day)}&selectType=ALLBUT0999&response=json`,
    validate: (j, day) => check(j, day, '發行股數'),
  },
  {
    // 股價升降幅度（當日官方漲跌停價）：證券代號|漲停價|開盤競價基準|跌停價|開盤競價基準|收盤價(前一成交日)|買賣揭示價|最近成交日
    // 2026-10-04 以 2024-03-04 實測：date 回聲、1,225 列；用途＝官方逐檔漲停／跌停判定（取代以檔位推算）、觸及漲停未鎖、跌停歷史
    name: 'twse_limit', host: 'www.twse.com.tw', from: '2022-07-18',
    url: day => `https://www.twse.com.tw/rwd/zh/variation/TWT84U?date=${d8(day)}&selectType=ALLBUT0999&response=json`,
    validate: (j, day) => check(j, day, '漲停價'),
  },
  {
    // 上櫃股票行情：代號|收盤|開高低|均價|成交股數|成交金額(元)|成交筆數|發行股數|次日參考價／漲停價／跌停價
    name: 'tpex_daily', host: 'www.tpex.org.tw', from: '2022-07-18',
    url: day => `https://www.tpex.org.tw/www/zh-tw/afterTrading/dailyQuotes?date=${slash(day)}&id=&response=json`,
    validate: (j, day) => check(j, day, '成交筆數'),
  },
  {
    // 上櫃現股當沖：tables[1] 逐檔「當日沖銷交易成交股數／買進金額／賣出金額」（daemon 只讀 tables[0] 的市場總計）
    name: 'tpex_daytrade', host: 'www.tpex.org.tw', from: '2022-07-18',
    url: day => `https://www.tpex.org.tw/www/zh-tw/intraday/stat?date=${slash(day)}&type=Daily&response=json`,
    validate: (j, day) => check(j, day, '當日沖銷交易成交股數'),
  },
  {
    // 上櫃三大法人明細：欄名重複，分組見回應的 template／columnNum（外資及陸資、外資自營商、投信、自營商自行買賣、自營商避險…）
    name: 'tpex_insti', host: 'www.tpex.org.tw', from: '2022-07-18',
    url: day => `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${slash(day)}&response=json`,
    validate: (j, day) => check(j, day, '三大法人買賣超股數合計'),
  },
];
