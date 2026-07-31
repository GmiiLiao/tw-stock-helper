import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 風向 2.0：強勢股統計→題材供應鏈→驅動力歸因。daemon 盤中每 3 分更新、收盤定案。
// 2026-08-01：改用 latestDoc。原本手寫的版本**已經有 s-maxage**（先前誤報為 no-store，
// 那個字串只出現在錯誤分支），真正缺的是這三項：
//   ① 行程內 memoize＋in-flight 合流 —— CDN 快取到期那一瞬間的 thundering herd，
//      原本是 N 個併發各讀一次 Firestore，現在同一實例只讀 1 次
//   ② 失敗負快取 —— Firestore 抖動時不會被重打放大
//   ③ stale-if-error —— 上游掛掉時供應舊資料而不是空白（31 支裡 30 支都沒有）
export const GET = (request: Request) => latestDoc('marketWind', 'intraday', { request });
