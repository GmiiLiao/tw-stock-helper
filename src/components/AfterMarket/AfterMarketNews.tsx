'use client';

import { Fragment, useState, type ReactNode } from 'react';
import type { MediaRank, OfficialRank } from '../../../scripts/lib/after-market-news.mjs';
import { Card, Detail, PriceCell, StockCell, amStyles as s, tone, useApi, useNameOf } from './shared';

// ── 📰 當晚消息：媒體判別（AI 讀完內文）與官方重大訊息，各自依影響比重排行 ─────────────
// 排序＝顯示用先驗權重（tw-news-impact-analyst §0：沒有一個經過量測），不是分數、不進任何模型；
// 媒體（M）與官方（O）兩條管線分開排、分開算占比，不加總。

interface NewsDoc {
  dataDate: string | null;
  media: MediaRank & { targetDate: string | null; lastPass: string | null; updatedAt: number | null; covered: number | null };
  official: OfficialRank & { since: number };
  note: string;
}

const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const hhmm = (ms: number | null) => (ms == null ? '—' : new Date(ms).toLocaleString('zh-TW', { hour12: false, timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
// 台股慣例：利多紅、利空綠
const dirTone = (label: string) => (label === '利多' || label === '+' ? s.up : s.dn);

function ShareBar({ share }: { share: number | null }) {
  return <div className={s.bar}><div className={s.barFill} style={{ width: `${Math.min(100, (share ?? 0) * 100 * 4)}%` }} /></div>;
}

interface RelNews { id: string; title: string; source: string; time: string; url: string }

/** 展開時才查：該股相關新聞連結（既有公開 API，含 CDN 快取與限流；失敗只顯示讀取失敗，不影響判讀明細）。 */
function RelatedLinks({ code, name, titles }: { code: string; name: string; titles: string[] }) {
  const { data, state } = useApi<{ news: RelNews[] }>(`/api/twse/stock-news?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`);
  const list = (data?.news ?? []).slice(0, 8);
  return (
    <Detail title="相關新聞連結（連結導回原媒體）">
      {state === 'loading' && <p>載入中…</p>}
      {state === 'error' && <p>連結暫時讀取失敗。</p>}
      {state === 'ok' && (list.length === 0 ? <p>近期查無相關新聞連結。</p> : (
        <ul>{list.map(n => (
          <li key={n.id || n.url}><a href={n.url} target="_blank" rel="noreferrer noopener">{n.title}</a>
            <span className={s.note}> {n.source}{n.time ? `・${n.time.slice(0, 16).replace('T', ' ')}` : ''}</span></li>
        ))}</ul>
      ))}
      {titles.length > 0 && (
        <>
          <p style={{ marginTop: 8 }}><b>AI 判讀所讀到的標題（僅標題，無連結）：</b></p>
          <ul>{titles.map(t => <li key={t}>{t}</li>)}</ul>
        </>
      )}
    </Detail>
  );
}

function Verdict({ x, name }: { x: MediaRank['items'][number]; name: string }) {
  const bar = x.quoteVerified != null ? `${x.quoteVerified}／${(x.quoteVerified ?? 0) + (x.quoteFailed ?? 0)}` : '—';
  return (
    <div className={s.detailGrid}>
      <Detail title="AI 判讀分析（讀完內文）">
        <p><b>判斷理由：</b>{x.reason ?? '—'}</p>
        {x.impactPath && <p><b>影響路徑：</b>{x.impactPath}</p>}
        {x.strengthBasis && <p><b>強度依據：</b>{x.strengthBasis}</p>}
        {x.challenge && <p><b>AI 自我挑戰（反方意見）：</b>{x.challenge}</p>}
        {x.revision && <p><b>挑戰後的修正：</b>{x.revision}</p>}
        {x.unsupported.length > 0 && (<><p><b>未被原文直接支持的說法：</b></p><ul>{x.unsupported.map(u => <li key={u}>{u}</li>)}</ul></>)}
        <div className={s.kv}>
          <span>判讀依據 <b>{x.basis === 'content' ? '讀內文' : x.basis ?? '—'}</b></span>
          <span>讀了 <b>{x.articlesRead ?? '—'}</b> 篇</span>
          <span>判別通道 <b>{x.pass === 'evening' ? '盤後趟' : x.pass === 'night' ? '夜間補判' : x.pass === 'morning' ? '晨間趟' : x.pass ?? '—'}</b></span>
          <span>判別時點價 <b>{x.px ?? '—'}</b></span>
          <span>判別時間 <b>{hhmm(x.verdictAt)}</b></span>
        </div>
      </Detail>
      <Detail title={`原文引句（逐字核對 ${bar}）`}>
        {x.keyQuote && <p>關鍵句：「{x.keyQuote}」</p>}
        {x.quotes.length > 0 && <ul>{x.quotes.map(q => <li key={q}>「{q}」</li>)}</ul>}
        {x.quotes.length === 0 && !x.keyQuote && <p>來源未提供。</p>}
        <p className={s.note}>影響權重＝強度（{x.strength ?? '—'}）×信心（{x.confidence ?? '—'}）×確定性（{x.certainty ?? '—'}）×新穎（{x.novelty ?? '—'}）×尚未反映（{x.priced ?? '—'}）＝{x.weight.toFixed(3)}（先驗，顯示排序，非分數）。</p>
      </Detail>
      <RelatedLinks code={x.code} name={name} titles={x.titles ?? []} />
    </div>
  );
}

function Media({ d }: { d: NewsDoc['media'] }) {
  const nameOf = useNameOf();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (c: string) => setOpen(o => { const n = new Set(o); if (!n.delete(c)) n.add(c); return n; });
  return (
    <Card title="媒體消息判別（AI 讀完內文）· 依影響比重排行" state="ok" tier="媒體 M" dateLabel="適用交易日" dataDate={d.targetDate}
      note="影響權重＝強度×信心×確定性×新穎性×尚未反映（皆為先驗，未經量測）；占比＝該則占本晚利多／利空合計權重。顯示排序，不是分數、不是買賣訊號。資訊不足者不排名。點每列左側 ▸ 展開 AI 判讀分析與相關新聞連結。">
      <p className={s.note}>
        涵蓋 {d.covered ?? '—'} 檔（{d.lastPass === 'evening' ? '盤後趟' : d.lastPass === 'night' ? '夜間補判' : d.lastPass ?? '—'}，更新 {hhmm(d.updatedAt)}）：
        利多 <b className={s.up}>{d.bullish}</b>／利空 <b className={s.dn}>{d.bearish}</b>／中性 {d.neutral}／資訊不足 {d.insufficient}
      </p>
      <div className={s.bulk}>
        <button type="button" onClick={() => setOpen(new Set(d.items.map(x => x.code)))}>全部展開</button>
        <button type="button" onClick={() => setOpen(new Set())}>全部收合</button>
      </div>
      <table className={s.tbl}>
        <thead><tr><th></th><th>#</th><th>個股</th><th>價格</th><th>方向</th><th>影響比重</th><th>判讀要素</th><th>事件類型</th></tr></thead>
        <tbody>{d.items.map(x => {
          const isOpen = open.has(x.code);
          const name = nameOf(x.code);
          return (
            <FragmentRow key={x.code} x={x} isOpen={isOpen} onToggle={() => toggle(x.code)}>
              {isOpen && <Verdict x={x} name={name === x.code ? '' : name} />}
            </FragmentRow>
          );
        })}</tbody>
      </table>
    </Card>
  );
}

function FragmentRow({ x, isOpen, onToggle, children }: { x: MediaRank['items'][number]; isOpen: boolean; onToggle: () => void; children: ReactNode }) {
  const nameOf = useNameOf();
  return (
    <>
      <tr>
        <td><button type="button" className={s.toggle} aria-expanded={isOpen} aria-label={isOpen ? '收合' : '展開'} onClick={onToggle}>{isOpen ? '▾' : '▸'}</button></td>
        <td>{x.order}</td><td><StockCell code={x.code} name={nameOf(x.code)} /></td><td><PriceCell code={x.code} /></td>
        <td className={dirTone(x.label)}><b>{x.label}</b></td>
        <td><span className={tone(x.label === '利多' ? 1 : -1)}>{pct(x.share)}</span><ShareBar share={x.share} /></td>
        <td>
          <div className={s.chips}>
            <span className={`${s.chip} ${x.strength === '極強' || x.strength === '強' ? s.chipStrong : ''}`}>強度 {x.strength ?? '—'}</span>
            <span className={s.chip}>信心 {x.confidence ?? '—'}</span>
            <span className={`${s.chip} ${x.certainty === '傳聞' ? s.chipWarn : ''}`}>{x.certainty ?? '—'}</span>
            <span className={s.chip}>{x.novelty ?? '—'}</span>
            <span className={`${s.chip} ${x.priced === '是' ? s.chipWarn : ''}`}>{x.priced === '否' ? '尚未反映' : x.priced === '是' ? '已反映' : `反映：${x.priced ?? '—'}`}</span>
          </div>
        </td>
        <td>{x.eventType ?? '—'}</td>
      </tr>
      {isOpen && <tr className={s.detailRow}><td colSpan={8}>{children}</td></tr>}
    </>
  );
}

const MOPS_URL = 'https://mops.twse.com.tw/mops/web/t05st02_1';

function Official({ d }: { d: NewsDoc['official'] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const keyOf = (x: NewsDoc['official']['items'][number]) => `${x.code}|${x.type}`;
  const toggle = (k: string) => setOpen(o => { const n = new Set(o); if (!n.delete(k)) n.add(k); return n; });
  return (
    <Card title="官方重大訊息 · 依事件基礎權重排行" state="ok" tier="官方 O" dateLabel="公告時間" dataDate={d.since ? hhmm(d.since) + ' 起' : null}
      note="同一家公司同一類事件的多則公告合併成一列（標「共 N 則」，展開看全部公告內文），權重不隨則數累加。事件類型僅依公告主旨比對（未讀內文），權重為 tw-news-impact-analyst §4.1 的先驗；方向只有規則強制類型才標示，其餘需讀內文。例行公告（股東會、更名、背書保證等）與未分類只計數、不入排行。">
      <p className={s.note}>收盤後公告共 {d.total} 則：入排行 {d.rankedAnnouncements ?? d.ranked} 則（合併為 {d.ranked} 列）／例行 {d.routine}／未分類 {d.unclassified}</p>
      {d.items.length === 0 ? <p className={s.note}>（無可排名的事件）</p> : (
        <>
          <div className={s.bulk}>
            <button type="button" onClick={() => setOpen(new Set(d.items.map(keyOf)))}>全部展開</button>
            <button type="button" onClick={() => setOpen(new Set())}>全部收合</button>
          </div>
          <table className={s.tbl}>
            <thead><tr><th></th><th>#</th><th>個股</th><th>價格</th><th>事件類型</th><th>方向(規則)</th><th>影響比重</th><th>公告主旨</th></tr></thead>
            <tbody>{d.items.map(x => {
              const k = keyOf(x), isOpen = open.has(k);
              return (
                <Fragment key={k}>
                  <tr>
                    <td><button type="button" className={s.toggle} aria-expanded={isOpen} aria-label={isOpen ? '收合' : '展開'} onClick={() => toggle(k)}>{isOpen ? '▾' : '▸'}</button></td>
                    <td>{x.order}</td><td><StockCell code={x.code} name={x.name} /></td><td><PriceCell code={x.code} /></td><td style={{ textAlign: 'left' }}>{x.typeLabel}</td>
                    <td className={x.dir ? dirTone(x.dir) : ''}>{x.dir ?? '需讀內文'}</td><td>{pct(x.share)}</td>
                    <td style={{ textAlign: 'left', whiteSpace: 'normal', minWidth: 220 }}>
                      {x.subject}{x.count > 1 && <span className={s.chip} style={{ marginLeft: 6 }}>共 {x.count} 則</span>}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className={s.detailRow}><td colSpan={8}>
                      <div className={s.detailGrid}>
                        <Detail title={`公告內文（公開資訊觀測站，節錄；共 ${x.count} 則，新到舊）`}>
                          {x.announcements.map(a => (
                            <div key={`${a.at}${a.subject}`} style={{ marginBottom: 10 }}>
                              <p><b>{hhmm(a.at)}</b>　{a.subject}</p>
                              {a.body ? <pre className={s.pre}>{a.body}</pre> : <p>內文來源未提供。</p>}
                            </div>
                          ))}
                        </Detail>
                        <Detail title="事件分類與連結">
                          <p>類型 <b>{x.type}</b>（{x.typeLabel}）｜基礎權重 {x.weight.toFixed(2)}（不隨則數累加）｜判斷依據：公告主旨（未讀內文）｜方向：{x.dir ?? '需讀內文，不憑主旨給方向'}。</p>
                          <p><a href={MOPS_URL} target="_blank" rel="noreferrer noopener">公開資訊觀測站・重大訊息</a></p>
                        </Detail>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}</tbody>
          </table>
        </>
      )}
    </Card>
  );
}

export default function AfterMarketNews() {
  const { data, state } = useApi<NewsDoc>('/api/twse/after-market-news');
  return (
    <div className={s.stack}>
      <Card title="當晚消息" state={state} tier="媒體與官方分開排行" note={data?.note} />
      {data && <Media d={data.media} />}
      {data && <Official d={data.official} />}
    </div>
  );
}
