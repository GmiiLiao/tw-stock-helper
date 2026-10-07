// Z1 大盤脈動列＋Z2 盤勢危險條件＋Z0 資料健康 的伺服器端組裝（路由：/api/warroom/pulse 的 top 區段）。
// 口徑：漲跌家數／漲跌停家數只用 marketPulse/latest（檔位口徑、4 碼非 00、不含 ETF 與興櫃）；
// 本頁不用 marketHealth 的 ±9.5% 與快照 ≥9.9% 近似（使用者裁定第 3 題）。只讀 Firestore（reader），不打上游。
//
// 讀哪些文件（欄位以 daemon 寫入端為準，見 scripts/lib/warroom-top.mjs 檔頭；缺欄位回 null，不補預設值）：
//   marketPulse/latest（quote）· marketPattern/latest（quote，與 A2 撿尾盤共用快取鍵）· system/ai-daemon（quote，心跳）
//   system/daemonHealth（slow，快線揭示落後統計，每小時寫一次）· taifexPositions/latest（daily，外資台指淨未平倉◆前交易日）
// 持股重大利空（Z2）不在這裡：改由慢層 board.news（build-news.ts）精簡表＋前端依使用者持股判定（warroom-news.mjs），
//   這支中層路由不再讀 newsVerdict（每 30 秒省掉數百 KB 的解析）。
// 不讀的：marketIndex（前端快層已每 5 秒抓 market-index，Z1 指數與上市成交量直接用匯流排）、那指期（market-index 路由在伺服器
//   端打 Yahoo——不可進聚合路由；前端從匯流排已拿到的 market-index 回應讀 usMarket，不多打任何請求）、
//   openSensor（開盤感應器影子資料不可進這支不需登入、CDN 共享的路由——改走超管專用 /api/admin/open-sensor，見 build-open-sensor.ts）。
// 各來源各自成敗：讀取故障的記進 failed（給健康燈），其餘照常回；marketPulse 讀不到時整段 ok:false（前端沿用上一份）。
import type { WarReader, DocRead } from './reader';
import { guardSection, okSection, errSection, type Section } from './section';
import { taipeiYmd } from './session';
import {
  normalizePulse, normalizePattern, normalizeHeartbeat, normalizeHotLag, normalizeTaifex,
  type TopPulse, type TopPattern, type TopHeartbeat, type TopHotLag, type TopTaifex,
} from '../../../scripts/lib/warroom-top.mjs';

export type {
  TopPulse, TopPattern, TopHeartbeat, TopHotLag, TopTaifex, TopCounts, TopLevel,
} from '../../../scripts/lib/warroom-top.mjs';

/** 讀取故障的來源（畫面文字） */
export type TopSourceLabel = '家數' | '盤型' | 'daemon 心跳' | '快線統計' | '外資台指';

export interface TopData {
  /** marketPulse/latest：家數、漲跌停、盤勢級距、上市成交量對昨日全日量（張；非同時刻） */
  pulse: TopPulse | null;
  /** 今日盤型（marketPattern.live；不是今天的為 null） */
  pattern: TopPattern | null;
  heartbeat: TopHeartbeat | null;
  hotLag: TopHotLag | null;
  taifex: TopTaifex | null;
  /** 這次讀取故障的來源（文件不存在不算故障） */
  failed: TopSourceLabel[];
}

function dataOf(r: DocRead): Record<string, unknown> | null {
  return r.ok ? r.data : null;
}

export async function buildTop(reader: WarReader): Promise<Section<TopData>> {
  return guardSection('top', async () => {
    const [pulseR, patternR, hbR, healthR, taifexR] = await Promise.all([
      reader.doc('marketPulse', 'latest', 'quote'),
      reader.doc('marketPattern', 'latest', 'quote'),
      reader.doc('system', 'ai-daemon', 'quote'),
      reader.doc('system', 'daemonHealth', 'slow'),
      reader.doc('taifexPositions', 'latest', 'daily'),
    ]);
    const failed: TopSourceLabel[] = [];
    const track = (r: DocRead, label: TopSourceLabel) => { if (!r.ok) failed.push(label); };
    track(pulseR, '家數');
    track(patternR, '盤型');
    track(hbR, 'daemon 心跳');
    track(healthR, '快線統計');
    track(taifexR, '外資台指');

    // 家數是本區段的主資料：讀不到（且 reader 無可降級舊值）就整段 ok:false——前端匯流排會沿用上一份好的區段，
    // 資料章自然轉延遲／過期（不清空畫面）。其他來源故障只記進 failed。
    if (!pulseR.ok) return errSection<TopData>('讀取失敗');

    const pulse = normalizePulse(dataOf(pulseR));
    const data: TopData = {
      pulse,
      pattern: normalizePattern(dataOf(patternR), taipeiYmd(reader.now)),
      heartbeat: normalizeHeartbeat(dataOf(hbR)),
      hotLag: normalizeHotLag(dataOf(healthR)),
      taifex: normalizeTaifex(dataOf(taifexR)),
      failed,
    };
    // 區段資料章＝家數文件本身的時間（Z1 家數／漲跌停用）；其他來源各自帶時間
    return okSection(data, pulse?.asOf ?? null);
  });
}
