import { latestDoc } from '@/lib/api-cache';

export const runtime = 'nodejs';

// 🛢 產業現貨／原物料報價（2026-09-17 新聞判讀計畫第一段·免費來源）。
// daemon 每日 15:10 班車寫 sectorSpot/latest：Yahoo 期貨連續合約（原油/布蘭特/天然氣/銅/鋁/金/銀）
// ＋ DRAMeXchange 公開 DRAM 現貨表。只存檔不評分，供產業層判別與對答案引用。非投資建議。
export const GET = () => latestDoc('sectorSpot', 'daily');
