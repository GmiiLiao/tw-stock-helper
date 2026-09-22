import { latestDoc } from '@/lib/api-cache';
export const runtime = 'nodejs';
// 新聞判別對答案（daemon computeNewsVerdictReview 每日寫 newsVerdictReview/summary）：
// 口徑＝前一交易日收盤→適用日開盤；含利多×信心、理由類型、色調分組。戰情室軋空判讀面板頂部常駐顯示。
export const GET = () => latestDoc('newsVerdictReview', 'daily', { docId: 'summary' });
