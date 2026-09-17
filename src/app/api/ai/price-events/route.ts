import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 📐 價格結構事件表（2026-09-17）：相鄰有收盤日比值超出 ±20% 的日子（減資／面額變更／分割／大額除權或資料錯誤），
// daemon 每日 15:10 班車重算最近 90 個交易日寫 priceEvents/latest，上市減資以 TWSE 恢復買賣參考價對照標註。
// 只記錄；chipArchive 序列未調整、各榜尚未引用。只讀 Firestore。非投資建議。
export const GET = () => latestDoc('priceEvents', 'daily');
