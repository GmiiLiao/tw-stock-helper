import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 休市日曆給前端：`market-clock` 的 holidays 表預設是空的（fail-open 只擋週末），
// 沒有這支 route 就永遠不會被填上，國定假日會被當成交易日照常輪詢。
// 資料由 scripts/sync-trading-calendar.mjs 寫入 system/tradingCalendar。
// 一天只變一次 → daily tier（s-maxage=3600）。
export const GET = (request: Request) => latestDoc('system', 'daily', { request, docId: 'tradingCalendar' });
