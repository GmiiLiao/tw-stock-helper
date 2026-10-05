// 今日新聞判別精簡表的伺服器端組裝（路由：/api/warroom/board 的 news 區段）——A1 新聞燈與 KPI、Z2 持股重大利空、
// B2「我的」新聞事件、A2 盤前新聞、快看抽屜權重明細全部用這一份（同一份表給所有人，前端用自己的持股／自選過濾，網址不帶個人參數）。
// 只讀 newsVerdict/latest（daemon 已寫好的 AI 讀內文判別），不擴大判別範圍（使用者裁定第 9 題）、不呼叫 LLM、不打上游。
// 權重＝after-market-news.rankMediaVerdicts（盤後報告同名同口徑；研究期·只顯示強弱，不當警示門檻、不進任何評分或排序）。
// 解析與規範 §1 的程式強制（資訊不足、價格描述、關注度、規則類利空〔rc：daemon 程式規則判定的類別，news-rule-classes.mjs〕）
// 唯一實作在 scripts/lib/warroom-news.mjs（有單元測試）。Z2 持股重大利空只看規則類別的類別權重，不看影響權重。
import type { WarReader } from './reader';
import { errSection, guardSection, okSection, type Section } from './section';
import { newsBoardFromDoc, type NewsBoard, type NewsEntry, type NewsMeta } from '../../../scripts/lib/warroom-news.mjs';

export type { NewsBoard, NewsEntry, NewsMeta };

/** { meta, map }——map 沒出現的代號＝未判別。Section.asOf＝newsVerdict/latest.updatedAt */
export type NewsMapData = NewsBoard;

// verdictJson 可達數百 KB：同一份（updatedAt＋長度相同）只解析一次（board 與 feeds 兩個區段共用）
let memo: { key: string; value: NewsBoard | null } | null = null;

/** newsVerdict/latest 文件 → 精簡表（記憶化）；文件不存在或壞掉回 null */
export function newsBoardOf(doc: Record<string, unknown> | null | undefined): NewsBoard | null {
  if (!doc) return null;
  const json = doc.verdictJson;
  const key = `${String(doc.updatedAt ?? '')}|${String(doc.targetDate ?? '')}|${typeof json === 'string' ? json.length : -1}`;
  if (memo?.key === key) return memo.value;
  const value = newsBoardFromDoc(doc);
  memo = { key, value };
  return value;
}

export async function buildNews(reader: WarReader): Promise<Section<NewsMapData>> {
  return guardSection('news', async () => {
    const r = await reader.doc('newsVerdict', 'latest', 'slow');
    if (!r.ok) return errSection<NewsMapData>('讀取失敗');
    const board = newsBoardOf(r.data);
    if (!board) return errSection<NewsMapData>('資料尚未產生');
    return okSection<NewsMapData>(board, board.meta.updatedAt);
  });
}
