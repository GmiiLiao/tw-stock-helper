'use client';

import { useState } from 'react';
import type { MediaRank, OfficialRank } from '../../../scripts/lib/after-market-news.mjs';
import { Card, StockLink, amStyles as s, tone, useApi, useNameOf } from './shared';

// ── 📰 當晚消息：媒體判別（AI 讀完內文）與官方重大訊息，各自依影響比重排行 ─────────────
// 排序＝顯示用先驗權重（tw-news-impact-analyst §0：沒有一個經過量測），不是分數、不進任何模型；
// 媒體（M）與官方（O）兩條管線分開排、分開算占比，不加總。

interface NewsDoc {
  dataDate: string | null;
  media: MediaRank & { targetDate: string | null; lastPass: string | null; updatedAt: number | null; covered: number | null };
  official: OfficialRank & { since: number };
  digest: { date: string | null; updatedAt: number | null; cats: { key: string; label: string; brief: string | null; items: { title: string; link: string }[] }[] } | null;
  dailyPost: { dataDate: string | null; post: string | null } | null;
  note: string;
}

const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const hhmm = (ms: number | null) => (ms == null ? '—' : new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
// 台股慣例：利多紅、利空綠
const dirTone = (label: string) => (label === '利多' || label === '+' ? s.up : s.dn);

function ShareBar({ share }: { share: number | null }) {
  return <div className={s.bar}><div className={s.barFill} style={{ width: `${Math.min(100, (share ?? 0) * 100 * 4)}%` }} /></div>;
}

function Media({ d }: { d: NewsDoc['media'] }) {
  const nameOf = useNameOf();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card title="媒體消息判別（AI 讀完內文）· 依影響比重排行" state="ok" tier="媒體 M" dateLabel="適用交易日" dataDate={d.targetDate}
      note="影響權重＝強度×信心×確定性×新穎性×尚未反映（皆為先驗，未經量測）；占比＝該則占本晚利多／利空合計權重。顯示排序，不是分數、不是買賣訊號。資訊不足者不排名。">
      <p className={s.note}>
        涵蓋 {d.covered ?? '—'} 檔（{d.lastPass === 'evening' ? '盤後趟' : d.lastPass === 'night' ? '夜間補判' : d.lastPass ?? '—'}，更新 {hhmm(d.updatedAt)}）：
        利多 <b className={s.up}>{d.bullish}</b>／利空 <b className={s.dn}>{d.bearish}</b>／中性 {d.neutral}／資訊不足 {d.insufficient}
      </p>
      <table className={s.tbl}>
        <thead><tr><th>#</th><th>個股</th><th>方向</th><th>影響比重</th><th>權重</th><th>強度</th><th>信心</th><th>確定性</th><th>新穎</th><th>已反映</th><th>事件</th></tr></thead>
        <tbody>{d.items.map(x => (
          <FragmentRow key={x.code} x={x} open={open === x.code} onToggle={() => setOpen(open === x.code ? null : x.code)} name={nameOf(x.code)} />
        ))}</tbody>
      </table>
    </Card>
  );
}

function FragmentRow({ x, open, onToggle, name }: { x: MediaRank['items'][number]; open: boolean; onToggle: () => void; name: string }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td>{x.order}</td><td><StockLink code={x.code} name={name} /></td>
        <td className={dirTone(x.label)}><b>{x.label}</b></td>
        <td><span className={tone(x.label === '利多' ? 1 : -1)}>{pct(x.share)}</span><ShareBar share={x.share} /></td>
        <td>{x.weight.toFixed(3)}</td><td>{x.strength ?? '—'}</td><td>{x.confidence ?? '—'}</td><td>{x.certainty ?? '—'}</td><td>{x.novelty ?? '—'}</td><td>{x.priced ?? '—'}</td><td>{x.eventType ?? '—'}</td>
      </tr>
      {open && (
        <tr><td colSpan={11} style={{ textAlign: 'left', whiteSpace: 'normal' }}>
          <p className={s.note}><b>判斷理由：</b>{x.reason ?? '—'}</p>
          {x.impactPath && <p className={s.note}><b>影響路徑：</b>{x.impactPath}</p>}
          {x.keyQuote && <p className={s.note}><b>原文關鍵句：</b>「{x.keyQuote}」</p>}
        </td></tr>
      )}
    </>
  );
}

function Official({ d }: { d: NewsDoc['official'] }) {
  return (
    <Card title="官方重大訊息 · 依事件基礎權重排行" state="ok" tier="官方 O" dateLabel="公告時間" dataDate={d.since ? hhmm(d.since) + ' 起' : null}
      note="事件類型僅依公告主旨比對（未讀內文），權重為 tw-news-impact-analyst §4.1 的先驗；方向只有規則強制類型才標示，其餘需讀內文。例行公告（股東會、更名、背書保證等）與未分類只計數、不入排行。">
      <p className={s.note}>收盤後公告共 {d.total} 則：入排行 {d.ranked}／例行 {d.routine}／未分類 {d.unclassified}</p>
      {d.items.length === 0 ? <p className={s.note}>（無可排名的事件）</p> : (
        <table className={s.tbl}>
          <thead><tr><th>#</th><th>個股</th><th>事件類型</th><th>方向(規則)</th><th>影響比重</th><th>權重</th><th>公告主旨</th></tr></thead>
          <tbody>{d.items.map(x => (
            <tr key={`${x.code}${x.at}${x.order}`}>
              <td>{x.order}</td><td><StockLink code={x.code} name={x.name} /></td><td style={{ textAlign: 'left' }}>{x.typeLabel}</td>
              <td className={x.dir ? dirTone(x.dir) : ''}>{x.dir ?? '需讀內文'}</td><td>{pct(x.share)}</td><td>{x.weight.toFixed(2)}</td>
              <td style={{ textAlign: 'left', whiteSpace: 'normal', minWidth: 220 }}>{x.subject}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

export default function AfterMarketNews() {
  const { data, state } = useApi<NewsDoc>('/api/twse/after-market-news');
  return (
    <div className={s.stack}>
      <Card title="當晚消息" state={state} tier="媒體與官方分開排行" note={data?.note}>
        {data?.dailyPost?.post && (
          <>
            <h4>📝 盤後回顧（模板整理，資料日 {data.dailyPost.dataDate}）</h4>
            <p className={s.note} style={{ whiteSpace: 'pre-wrap' }}>{data.dailyPost.post}</p>
          </>
        )}
      </Card>
      {data && <Media d={data.media} />}
      {data && <Official d={data.official} />}
      {data?.digest && (
        <Card title="要聞導讀（AI 歸納標題，不排名）" state="ok" tier="媒體標題" dataDate={data.digest.date}
          note="來源：各媒體標題，連結導回原媒體；導讀僅歸納標題，未讀內文，不作影響判斷。">
          {data.digest.cats.map(c => (
            <div key={c.key}>
              <h4>{c.label}</h4>
              {c.brief && <p className={s.note}>{c.brief}</p>}
              <ul className={s.list}>{c.items.map(i => <li key={i.link}><a href={i.link} target="_blank" rel="noreferrer noopener" className={s.link}>{i.title}</a></li>)}</ul>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
