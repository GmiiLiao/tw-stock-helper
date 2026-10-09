// ── 第二大腦·官方鏡像：帶日期（可回補歷史）的資料集 ───────────────────────────
// 來源：docs/OFFICIAL-DATA-INVENTORY-2026-10-04.md（plan＝backfill+daily 的 46 筆）。unit：day＝每交易日一檔、month＝每月一檔。
// verified：2026-10-04 前已實測過端點與回聲（研究回補或盤點探針）；false 的要先跑 `official-mirror verify` 通過才會排進每日與回補。
// 請求樣板變數見 scripts/lib/official-mirror.mjs ctxOf()。
import { t21Codes, t21CsvCodes } from '../lib/mops-revenue.mjs';

const TWSE = 'www.twse.com.tw', TPEX = 'www.tpex.org.tw', MOPS = 'mopsov.twse.com.tw', TAIFEX = 'www.taifex.com.tw';
const get = url => ctx => ({ url: url.replace(/\{(\w+)\}/g, (_, k) => ctx[k]) });
const post = (url, body) => ctx => ({ url, method: 'POST', body: body.replace(/\{(\w+)\}/g, (_, k) => ctx[k]) });
const twse = (id, path, priority, extra = {}) => ({ id, host: TWSE, unit: 'day', kind: 'json', validator: 'twseDate', priority, from: '2022-07-18', verified: true, request: get(`https://www.twse.com.tw${path}`), ...extra });
const tpex = (id, path, priority, extra = {}) => ({ id, host: TPEX, unit: 'day', kind: 'json', validator: 'tpexDate', priority, from: '2022-07-18', verified: true, request: get(`https://www.tpex.org.tw${path}`), ...extra });
// 月營收 t21sc03 的定版：看資料不看時鐘（2026-10-04）。舊規則「次月 11 日的隔天起定版」會在晚申報者（金控／保險）上表前就定版。
//   改為（lib stableDecision）：次月 11 日（含）起、相隔 ≥3 個日曆日的兩次觀測，去掉產生時戳後內容雜湊相同；
//   且名冊完整——上一期同鍵頁面列出的代號這一頁缺 ≤3 個（晚申報者上月有申報、本月還沒上表會被擋）。
//   觀測時刻＝頁面「出表日期」（genRe：民國年/月/日<!--時:分:秒-->；MOPS 回快取頁，實測舊 3 天以上）。
//   頁面每次產生都帶「出表日期：115/10/04<!--20:00:18-->」，雜湊前要去掉（strip），否則永遠不會定版。
//   legacyTrustBefore：2026-10-04 用舊時鐘規則回補的 2022-06~2026-08 頁（皆在申報期限後 ≥24 日抓取、已含晚申報者）維持定版，
//   不重抓、不降級——MOPS 歷史頁依現行名冊重產（新上市櫃帶上市前月份、下市者消失），重新取得定版資格可能永遠收斂不了。
const T21_STABLE = Object.freeze({
  afterDay: 11, minGapDays: 3, maxMissing: 3, legacyTrustBefore: '2026-09', roster: t21Codes,
  strip: '出表日期[：:][^<]*(?:<!--[^>]*-->)?',
  genRe: '出表日期[：:]\\s*(\\d{2,3})/(\\d{1,2})/(\\d{1,2})\\s*(?:<!--\\s*(\\d{1,2}):(\\d{2}):(\\d{2})\\s*-->)?',
});
// 同一份月營收的官方「另存CSV」：定版規則同上（看資料）。出表日期是每列第 1 欄（只有日期；伺服器快取檔的產生日），雜湊前去掉；
//   觀測時刻取第一列的出表日期。名冊＝CSV 全部 4 碼代號——一檔含本國＋外國 ⇒ 容許缺 6（_0／_1 兩頁各 3）。
const T21_CSV_STABLE = Object.freeze({
  afterDay: 11, minGapDays: 3, maxMissing: 6, roster: t21CsvCodes,
  strip: '(?<=^|\\n)"\\d{2,3}/\\d{1,2}/\\d{1,2}",',
  genRe: '\\n"(\\d{2,3})/(\\d{1,2})/(\\d{1,2})",',
});

export const DATED = [
  // ── 上市（www.twse.com.tw rwd）──
  twse('twse_mi_index', '/rwd/zh/afterTrading/MI_INDEX?date={date8}&type=ALLBUT0999&response=json', 1, { migrateFrom: 'twse_daily', must: true }),
  twse('twse_t86', '/rwd/zh/fund/T86?date={date8}&selectType=ALLBUT0999&response=json', 1, { migrateFrom: 'twse_t86', must: true }),
  twse('twse_mi_qfiis', '/rwd/zh/fund/MI_QFIIS?date={date8}&selectType=ALLBUT0999&response=json', 1, { migrateFrom: 'twse_qfiis', must: true }),
  twse('twse_twt84u', '/rwd/zh/variation/TWT84U?date={date8}&selectType=ALLBUT0999&response=json', 1, { migrateFrom: 'twse_limit', must: true }),
  twse('twse_bwibbu_d', '/rwd/zh/afterTrading/BWIBBU_d?date={date8}&selectType=ALL&response=json', 1, { must: true }),
  twse('twse_mi_margn', '/rwd/zh/marginTrading/MI_MARGN?date={date8}&selectType=ALL&response=json', 1, { must: true }),
  twse('twse_twt93u', '/rwd/zh/marginTrading/TWT93U?date={date8}&response=json', 1, { must: true }),
  twse('twse_twtb4u', '/rwd/zh/dayTrading/TWTB4U?date={date8}&selectType=All&response=json', 2, { must: true }),
  twse('twse_twt85u', '/exchangeReport/TWT85U?response=json&date={date8}', 2),
  twse('twse_bft41u', '/rwd/zh/afterTrading/BFT41U?date={date8}&selectType=ALL&response=json', 2),
  twse('twse_twt53u', '/rwd/zh/afterTrading/TWT53U?date={date8}&selectType=ALL&response=json', 2),
  twse('twse_mi_5mins_index', '/rwd/zh/TAIEX/MI_5MINS_INDEX?date={date8}&response=json', 2, { must: true }),
  twse('twse_bfiauu_s', '/rwd/zh/block/BFIAUU?date={date8}&selectType=S&response=json', 2),
  twse('twse_bfiamu', '/rwd/zh/afterTrading/BFIAMU?date={date8}&response=json', 2, { must: true }),
  twse('twse_bfi82u', '/rwd/zh/fund/BFI82U?response=json&type=day&dayDate={date8}', 2, { verified: false }),
  // 區間端點（start=end=當日；當天沒有公告＝合法空表）
  twse('twse_notice', '/rwd/zh/announcement/notice?startDate={date8}&endDate={date8}&response=json', 1, { validator: 'twseRange' }),
  twse('twse_punish', '/rwd/zh/announcement/punish?startDate={date8}&endDate={date8}&response=json', 1, { validator: 'twseRange' }),
  twse('twse_twtauu', '/rwd/zh/reducation/TWTAUU?startDate={date8}&endDate={date8}&response=json', 1, { validator: 'twseRange' }),
  twse('twse_twtawu', '/rwd/zh/afterTrading/TWTAWU?startDate={date8}&endDate={date8}&response=json', 2, { validator: 'twseRange', verified: false }),
  twse('twse_twt49u', '/rwd/zh/exRight/TWT49U?startDate={date8}&endDate={date8}&response=json', 2, { validator: 'twseRange' }),
  // 月表（date 帶月初）
  twse('twse_mi_5mins_hist', '/rwd/zh/TAIEX/MI_5MINS_HIST?date={ym01}&response=json', 2, { unit: 'month', validator: 'twseMonth' }),
  twse('twse_fmtqik', '/rwd/zh/afterTrading/FMTQIK?date={ym01}&response=json', 2, { unit: 'month', validator: 'twseMonth' }),

  // ── 上櫃（www.tpex.org.tw）──
  tpex('tpex_dailyquotes', '/www/zh-tw/afterTrading/dailyQuotes?date={dateSlash}&type=EW&id=&response=json', 1, { migrateFrom: 'tpex_daily', must: true }),
  tpex('tpex_intraday_stat', '/www/zh-tw/intraday/stat?date={dateSlash}&type=Daily&response=json', 1, { migrateFrom: 'tpex_daytrade', must: true }),
  tpex('tpex_insti_dailytrade', '/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date={dateSlash}&id=&response=json', 1, { migrateFrom: 'tpex_insti', must: true }),
  tpex('tpex_pe_qrydate', '/www/zh-tw/afterTrading/peQryDate?date={dateSlash}&response=json', 1, { must: true }),
  tpex('tpex_margin_balance', '/www/zh-tw/margin/balance?date={dateSlash}&response=json', 1, { must: true }),
  tpex('tpex_margin_sbl', '/www/zh-tw/margin/sbl?date={dateSlash}&response=json', 1, { must: true }),
  tpex('tpex_insti_summary', '/www/zh-tw/insti/summary?type=Daily&date={dateSlash}&response=json', 2, { must: true }),
  tpex('tpex_insti_qfii', '/www/zh-tw/insti/qfii?date={dateSlash}&response=json', 2),
  tpex('tpex_intraday_list', '/www/zh-tw/intraday/list?date={dateSlash}&type=Daily&response=json', 2, { verified: false }),
  tpex('tpex_bulletin_attention', '/www/zh-tw/bulletin/attention?startDate={dateSlash}&endDate={dateSlash}&response=json', 1, { validator: 'tpexRange' }),
  tpex('tpex_bulletin_disposal', '/www/zh-tw/bulletin/disposal?startDate={dateSlash}&endDate={dateSlash}&response=json', 1, { validator: 'tpexRange' }),
  { id: 'tpex_bulletin_exdailyq', host: TPEX, unit: 'day', kind: 'json', validator: 'tpexRange', priority: 2, from: '2022-07-18', verified: false,
    request: post('https://www.tpex.org.tw/www/zh-tw/bulletin/exDailyQ', 'startDate={dateSlash}&endDate={dateSlash}&response=json') },
  tpex('tpex_market_highlight', '/web/stock/aftertrading/market_highlight/highlight_result.php?l=zh-tw&d={rocDate}', 2, { from: '2023-01-11', verified: false }),
  tpex('tpex_index_st41', '/web/stock/aftertrading/daily_trading_index/st41_result.php?l=zh-tw&d={rocYear}/{month2}', 2, { unit: 'month', validator: 'tpexMonth', verified: false }),

  // ── 公開資訊觀測站（mopsov，月）──
  // lagMonths:1＝最新一期是上個月（M 月營收 M+1 月才申報）⇒ daily 不抓當月：那一期還不存在，每晚必失敗，
  //   而且排在一起的失敗會湊滿家族佇列「連續 3 次失敗」，把同家族後面的 openapi 快照與補漏整批停掉。
  { id: 'mops_t21sc03', host: MOPS, unit: 'month', lagMonths: 1, variants: ['sii', 'otc'], kind: 'text', ext: 'html', encoding: 'big5', priority: 1, from: '2022-06-01', verified: true,
    request: ctx => ({ url: `https://mopsov.twse.com.tw/nas/t21/${ctx.market}/t21sc03_${ctx.rocYear}_${ctx.month}_0.html` }),
    spec: { mustContain: ['{rocYear}年{month}月'], emptyRe: '查無|無資料', minLen: 5000 }, stable: T21_STABLE },
  // 外國公司（-KY）月營收在 _1 表，_0 只有本國公司（2026-10-04 漏網分析：73 檔 KY 測試期月營收 100% 缺值）
  { id: 'mops_t21sc03_ky', host: MOPS, unit: 'month', lagMonths: 1, variants: ['sii', 'otc'], kind: 'text', ext: 'html', encoding: 'big5', priority: 1, from: '2022-06-01', verified: true,  // 2026-10-04 實抓 115/8 上市＋上櫃 _1 表通過 spec、錯月會擋
    request: ctx => ({ url: `https://mopsov.twse.com.tw/nas/t21/${ctx.market}/t21sc03_${ctx.rocYear}_${ctx.month}_1.html` }),
    spec: { mustContain: ['{rocYear}年{month}月', '-KY'], emptyRe: '查無|無資料', minLen: 2000 }, stable: T21_STABLE },
  // 同一份月營收的官方「另存CSV」（本國＋外國同一檔）：2026-03 上市 _0／_1 靜態頁 MOPS 端回 0 bytes 時的官方替代
  //   （研究端 2026-02 上市實測與兩頁逐格相同）。月份不補零；UTF-8（BOM）、CRLF、每欄雙引號。
  //   回音：開頭是表頭（含「資料年月」）＋「"{民國年}/{月}"」整欄（帶引號：1 月不會配到 10～12 月）；逐列回音與市場核對在讀取端（backfill-revenue-from-mirror）。
  //   沒有 emptyRe：「備註」欄是自由文字，可能含「無資料」字樣。
  //   2026-10-05 01:01 實抓通過（verify 115/9 上市 32 檔；探針 111/6 上市 926＋79、115/3 上市 991＋92，後者與研究端檔 sha256 相同）。
  //   出表日期是伺服器快取檔的產生日（非請求日：111/6 回 115/10/03、115/3 回 115/10/04），所以兩次觀測要等快取重產才會拉開間隔。
  { id: 'mops_t21sc03_csv', host: MOPS, unit: 'month', lagMonths: 1, variants: ['sii', 'otc'], kind: 'text', ext: 'csv', encoding: 'utf-8', priority: 1, from: '2022-06-01', verified: true,
    request: post('https://mopsov.twse.com.tw/server-java/FileDownLoad', 'step=9&functionName=show_file2&filePath=/t21/{market}/&fileName=t21sc03_{rocYear}_{month}.csv'),
    spec: { mustMatch: ['^\\uFEFF?出表日期,資料年月,公司代號,公司名稱,'], mustContain: ['資料年月', '"{rocYear}/{month}"'], minLen: 2000 }, stable: T21_CSV_STABLE },
  { id: 'mops_t100sb02_1', host: MOPS, unit: 'month', variants: ['sii', 'otc'], kind: 'text', ext: 'html', encoding: 'utf-8', priority: 2, from: '2022-07-01', verified: true,
    request: post('https://mopsov.twse.com.tw/mops/web/ajax_t100sb02_1', 'encodeURIComponent=1&step=1&firstin=1&off=1&TYPEK={market}&year={rocYear}&month={month2}'),
    spec: { mustContain: ['公司代號'], emptyRe: '查無|無資料', minLen: 500 } },

  // ── 期貨交易所（滾動窗：VIX 只留近 3 個月、三大法人近 3 年 ⇒ 第一晚先做）──
  { id: 'taifex_vix', host: TAIFEX, unit: 'day', kind: 'text', ext: 'txt', encoding: 'big5', priority: 1, from: 'rolling-90d', verified: false,
    request: get('https://www.taifex.com.tw/cht/7/getVixData?filesname={date8}'), spec: { mustContain: ['{date8}'], minLen: 200 } },
  { id: 'taifex_fut_contracts', host: TAIFEX, unit: 'day', kind: 'text', ext: 'csv', encoding: 'big5', priority: 1, from: 'rolling-3y', verified: false,
    request: post('https://www.taifex.com.tw/cht/3/futContractsDateDown', 'queryStartDate={dateSlash}&queryEndDate={dateSlash}&commodityId='),
    spec: { mustContain: ['{dateSlash}'], minLen: 200 } },
  { id: 'taifex_opt_contracts', host: TAIFEX, unit: 'day', kind: 'text', ext: 'csv', encoding: 'big5', priority: 2, from: 'rolling-3y', verified: false,
    request: post('https://www.taifex.com.tw/cht/3/optContractsDateDown', 'queryStartDate={dateSlash}&queryEndDate={dateSlash}&commodityId='),
    spec: { mustContain: ['{dateSlash}'], minLen: 200 } },
  { id: 'taifex_calls_puts', host: TAIFEX, unit: 'day', kind: 'text', ext: 'csv', encoding: 'big5', priority: 2, from: 'rolling-3y', verified: false,
    request: post('https://www.taifex.com.tw/cht/3/callsAndPutsDateDown', 'queryStartDate={dateSlash}&queryEndDate={dateSlash}&commodityId='),
    spec: { mustContain: ['{dateSlash}'], minLen: 200 } },
  { id: 'taifex_pcratio', host: TAIFEX, unit: 'day', kind: 'text', ext: 'html', encoding: 'utf-8', priority: 2, from: '2022-07-18', verified: false,
    request: get('https://www.taifex.com.tw/cht/3/pcRatio?queryStartDate={dateSlash}&queryEndDate={dateSlash}'), spec: { mustMatch: ['<td[^>]*>\\s*{dateSlashNoPad}\\s*</td>'], emptyRe: '查無資料', minLen: 1000 } },
  { id: 'taifex_fut_daily', host: TAIFEX, unit: 'day', kind: 'text', ext: 'csv', encoding: 'big5', priority: 2, from: 'rolling-3y', verified: false,
    request: post('https://www.taifex.com.tw/cht/3/futDataDown', 'down_type=1&queryStartDate={dateSlash}&queryEndDate={dateSlash}&commodity_id=all'),
    spec: { mustContain: ['{dateSlash}'], minLen: 200 } },
  { id: 'taifex_large_trader', host: TAIFEX, unit: 'day', kind: 'text', ext: 'html', encoding: 'utf-8', priority: 2, from: 'rolling-3y', verified: false, disabled: true,
    // 2026-10-04 實測：GET queryDate 回查詢頁並含「查無」——參數不對，待查正確表單後再開（verified=false 且 _verify 記未過）
    request: get('https://www.taifex.com.tw/cht/3/largeTraderFutQry?queryDate={dateSlash}'), spec: { mustContain: ['{dateSlash}'], emptyRe: '查無資料', minLen: 1000 } },
];

/** 期交所與其他滾動窗的實際起點（相對今天）。 */
export function resolveFrom(from, today) {
  if (from === 'rolling-90d') return new Date(Date.parse(today) - 92 * 864e5).toISOString().slice(0, 10);
  if (from === 'rolling-3y') return new Date(Date.parse(today) - (3 * 365 - 5) * 864e5).toISOString().slice(0, 10);
  return from;
}
