'use client';

import { Card, StockCell, amStyles as s, dayLabel, fmtTs, useApi } from './shared';
import type { MediaRank, OfficialRank } from '../../../scripts/lib/after-market-news.mjs';

// ── 📝 分析報告：把定版的每日熱力與當晚消息整理成文字版盤後分析 ───────────────────────────
// 文字由 scripts/lib/daily-heatmap/narrative.mjs 依模板產生（零 LLM、零預測，每個數字來自資料），發佈時寫進 dailyHeatmap 文件的 report 欄；
// 「當晚消息重點」由本頁依消息排行即時整理。描述資料日收盤事實，非投資建議。

interface Section { key: string; title: string; paras: string[]; bullets?: string[] }
interface HeatDoc { dataDate: string; canonicalAt: string; report?: Section[]; residualGrade?: string | null }
interface NewsDoc {
  media: MediaRank & { targetDate: string | null; lastPass: string | null; updatedAt: number | null };
  official: OfficialRank & { since: number };
}

function Block({ sec }: { sec: Section }) {
  return (
    <Card title={sec.title} state="ok">
      {sec.paras.map(t => <p key={t} style={{ margin: '6px 0', lineHeight: 1.85, fontSize: 'calc(14px * var(--fz))' }}>{t}</p>)}
      {sec.bullets && sec.bullets.length > 0 && <ul className={s.list}>{sec.bullets.map(t => <li key={t}>{t}</li>)}</ul>}
    </Card>
  );
}

function NewsHighlights({ news }: { news: NewsDoc }) {
  const bull = news.media.items.filter(x => x.label === '利多').slice(0, 5);
  const bear = news.media.items.filter(x => x.label === '利空').slice(0, 3);
  const off = news.official.items.slice(0, 5);
  const line = (x: MediaRank['items'][number]) => (
    <li key={x.code}><StockCell code={x.code} /> <b className={x.label === '利多' ? s.up : s.dn}>{x.label}</b>・{x.eventType ?? '—'}・強度 {x.strength ?? '—'}、{x.certainty ?? '—'}、{x.priced === '否' ? '尚未反映' : x.priced === '是' ? '已反映' : `反映${x.priced ?? '—'}`}
      <br /><span className={s.note}>{x.reason ?? '—'}</span></li>
  );
  return (
    <Card title="當晚消息重點" state="ok" tier="媒體 M／官方 O 分開" dateLabel="媒體適用" dataDate={news.media.targetDate}
      note="媒體＝AI 讀完內文的判別（依先驗影響權重排序，非分數）；官方＝公告主旨比對（未讀內文）。完整排行、判讀分析與相關新聞連結請見「當晚消息」分頁。">
      <p style={{ margin: '6px 0', lineHeight: 1.85, fontSize: 'calc(14px * var(--fz))' }}>
        媒體判讀涵蓋 {news.media.bullish + news.media.bearish + news.media.neutral + news.media.insufficient} 檔（更新 {fmtTs(news.media.updatedAt)}）：利多 {news.media.bullish}、利空 {news.media.bearish}、中性 {news.media.neutral}、資訊不足 {news.media.insufficient}。
        官方重大訊息自收盤後共 {news.official.total} 則，入排行 {news.official.rankedAnnouncements} 則（合併為 {news.official.ranked} 列），最新公告 {fmtTs(news.official.updatedAt)}。
      </p>
      <h4>媒體判讀：影響比重居前</h4>
      <ul className={s.list}>{bull.map(line)}{bear.map(line)}</ul>
      <h4>官方重大訊息：事件權重居前</h4>
      <ul className={s.list}>{off.map(x => (
        <li key={`${x.code}${x.type}`}><StockCell code={x.code} name={x.name} /> {x.typeLabel}{x.count > 1 ? `（共 ${x.count} 則）` : ''}{x.dir ? `・方向 ${x.dir}（規則）` : '・方向需讀內文'}
          <br /><span className={s.note}>{x.subject}</span></li>
      ))}</ul>
    </Card>
  );
}

export default function AnalysisReport() {
  const heat = useApi<HeatDoc>('/api/twse/daily-heatmap');
  const news = useApi<NewsDoc>('/api/twse/after-market-news');
  if (heat.state !== 'ok' || !heat.data) return <Card title="分析報告" state={heat.state} />;
  const d = heat.data;
  if (!d.report?.length) return <Card title="分析報告" state="empty" note="此資料日的分析報告尚未產生（定版後重新發佈才會有）。" />;
  const asOf = dayLabel(d.dataDate);
  const secs = d.report;
  const before = secs.filter(x => ['overview', 'index', 'sectors', 'stocks'].includes(x.key));
  const after = secs.filter(x => !['overview', 'index', 'sectors', 'stocks'].includes(x.key));
  return (
    <div className={s.stack}>
      <p className={s.note}>
        <b>{asOf}</b> 盤後分析報告（資料日 {d.dataDate}，定版 {fmtTs(d.canonicalAt)}）。依資料模板自動整理，不預測、不計分，<b>非投資建議</b>；現價與昨收為即時資料，不在報告內。
      </p>
      {before.map(x => <Block key={x.key} sec={x} />)}
      {news.state === 'ok' && news.data && <NewsHighlights news={news.data} />}
      {after.map(x => <Block key={x.key} sec={x} />)}
    </div>
  );
}
