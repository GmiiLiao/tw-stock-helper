'use client';

// 快看抽屜的新聞判別（AI 新聞識讀·媒體 M；資料＝匯流排 board.news，不另抓）：
//   DrawerNewsLine   標頭一行：燈＋方向·強弱·權重＋判讀趟次時間
//   DrawerNewsBlock  權重明細：影響權重＝強度×信心×確定性×新穎×已被預期（盤後報告同一支 rankMediaVerdicts；研究期·只顯示，
//                    不是分數、不當警示門檻）、事件類型、理由、引文（daemon 逐字核對通過的才當引文；AI 摘句另標
//                    「未逐字核對」，規範 §1.8）、數字未查證、四角色挑戰修正、規則類利空說明（類別＋類別權重，先驗·未回測，
//                    不是影響權重）、可能為法律事件（未經規則確認）；
//                    官方重訊（O）另列一行，不併入權重（tw-news-impact-analyst §2）。
import { useMemo } from 'react';
import {
  newsLampView, newsShortText, newsWeightText, majorBearOf, majorBearNote, ruleClassNote, isNewsUniverse, isUnchallengedEntry, ymdShort,
  tpeHhmm, PASS_LABEL, NEWS_WEIGHT_NOTE, UNCHALLENGED_NOTE, POSSIBLE_LEGAL_NOTE,
  type NewsCtx, type NewsEntry, type NewsLampView, type MajorBear,
} from '../../../scripts/lib/warroom-news.mjs';
import { useMopsIndex, useNewsBoard, useNewsPool } from './NewsModel';
import { NewsLamp } from './NewsLamp';
import { hhmm } from './parts/fmt';
import drawer from './QuickDrawer.module.css';

type DrawerNews =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ok'; entry: NewsEntry | null; view: NewsLampView; mb: MajorBear | null; ctx: NewsCtx; stale: boolean };

function useDrawerNews(code: string): DrawerNews {
  const news = useNewsBoard();
  const pool = useNewsPool();
  return useMemo(() => {
    if (news.status === 'loading') return { status: 'loading' };
    if (!news.board) return { status: 'error' };
    const entry = news.board.map[code] ?? null;
    const view = newsLampView(entry, news.ctx, { universe: isNewsUniverse(code) });
    const scope = pool.holdings.has(code) ? 'holding' : pool.watch.has(code) ? 'watch' : null;
    const mb = entry && scope ? majorBearOf(entry, { scope, ctx: news.ctx, minAtMs: news.minAtMs }) : null;
    return { status: 'ok', entry, view, mb, ctx: news.ctx, stale: news.stale };
  }, [news, pool, code]);
}

const passText = (e: NewsEntry) => `${e.p ? `${PASS_LABEL[e.p]} ` : ''}${tpeHhmm(e.at)}`;

/** 標頭一行 */
export function DrawerNewsLine({ code }: { code: string }) {
  const d = useDrawerNews(code);
  if (d.status === 'loading') return null;
  if (d.status === 'error') return <div className={drawer.newsLine}><span>新聞判別暫時讀不到</span></div>;
  const { entry, view, mb, ctx } = d;
  let text: string;
  if (view.tone === 'na') text = '新聞：不做個股新聞識讀（ETF、權證等）';
  else if (!entry || view.tone === 'none') text = `新聞：${view.label}`;
  else text = `新聞 ${newsShortText(entry, ctx)}·${passText(entry)}`;
  return (
    <div className={drawer.newsLine} title={view.title}>
      <NewsLamp view={view} major={mb?.level === 1} />
      <span>{text}</span>
    </div>
  );
}

function challengeText(e: NewsEntry): string {
  if (!e.ch) return '未執行（可能是舊聞回退或挑戰失敗）';
  return e.rv ?? (e.st === 'bear' ? '已執行，無修正說明' : '已執行（修正說明只列利空；完整判讀見個股頁）');
}

function EntryLines({ e, view, mb, ctx }: { e: NewsEntry; view: NewsLampView; mb: MajorBear | null; ctx: NewsCtx }) {
  const weight = newsWeightText(e);
  const rule = ruleClassNote(e);
  const directional = e.st === 'bull' || e.st === 'bear';
  const quoteTotal = (e.qv ?? 0) + (e.qf ?? 0);
  return (
    <>
      <div className={drawer.line}>
        方向與強弱：<b>{newsShortText(e, ctx)}</b>
        {mb && <span className={drawer.stopAmber}>　{majorBearNote(mb)}</span>}
      </div>
      {!view.current && view.old && (directional || e.st === 'neutral') && (
        <div className={drawer.line}>
          <span className={drawer.muted}>
            ◆ {isUnchallengedEntry(e, ctx) ? UNCHALLENGED_NOTE : `${view.old}：已過適用交易日（媒體時效 ≤1 交易日），不列強弱、不進警示`}
          </span>
        </div>
      )}
      {rule && <div className={drawer.line}>{rule}</div>}
      {e.pl && <div className={drawer.line}>{POSSIBLE_LEGAL_NOTE}</div>}
      {(e.st === 'attention' || e.st === 'excluded' || e.st === 'insufficient' || e.st === 'unjudged') && (
        <div className={drawer.line}><span className={drawer.muted}>{view.title}</span></div>
      )}
      {weight && directional && <div className={drawer.line}><span className={drawer.muted}>{weight}</span></div>}
      {e.ev && <div className={drawer.line}>事件類型：{e.ev}（AI 分類；「法律」不等於規則類別）</div>}
      {e.r && <div className={drawer.line}>理由：{e.r}</div>}
      {e.vq && <div className={drawer.line}>引文（逐字核對通過）：「{e.vq}」</div>}
      {e.kq && <div className={drawer.line}><span className={drawer.muted}>AI 摘句（未逐字核對）：{e.kq}</span></div>}
      {(directional || e.st === 'neutral') && (
        <div className={drawer.line}>
          <span className={drawer.muted}>
            {e.qv != null ? `引文逐字核對 ${e.qv}/${quoteTotal || e.qv} 條通過` : '引文核對：來源未提供'}
            {e.un > 0 ? `·數字未查證 ${e.un} 處` : ''}
            ·四角色挑戰：{challengeText(e)}
          </span>
        </div>
      )}
      {e.at != null && (
        <div className={drawer.line}>
          <span className={drawer.muted}>
            判讀：{passText(e)}{e.n != null ? `·讀 ${e.n} 篇` : ''}{ctx.targetDate ? `·適用 ${ymdShort(ctx.targetDate)}` : ''}
          </span>
        </div>
      )}
    </>
  );
}

/** 權重明細區塊（有判別或有今日重訊才顯示） */
export function DrawerNewsBlock({ code }: { code: string }) {
  const d = useDrawerNews(code);
  const mops = useMopsIndex()[code];
  const entry = d.status === 'ok' ? d.entry : null;
  if (!entry && !mops) return null;
  return (
    <div className={drawer.block}>
      <div className={drawer.caption}>新聞判別（AI 讀內文·媒體 M）·影響權重（{NEWS_WEIGHT_NOTE}）·非投資建議</div>
      {d.status === 'ok' && entry && <EntryLines e={entry} view={d.view} mb={d.mb} ctx={d.ctx} />}
      {d.status === 'ok' && d.stale && <div className={drawer.note}>新聞判別這次讀取失敗，顯示上一份</div>}
      {mops && (
        <div className={drawer.line}>
          官方重訊 {hhmm(mops[0])}：{mops[1]}
          <span className={drawer.muted}>（O·公開資訊觀測站·未經 AI 判讀，不併入新聞權重）</span>
        </div>
      )}
    </div>
  );
}
