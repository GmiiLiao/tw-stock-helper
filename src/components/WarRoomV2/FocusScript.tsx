'use client';

// A2 盤前「開盤劇本」（08:30–08:55）與「試撮中」（08:55–09:00）。
// 「標籤｜內容」緊湊列：搶漲停排隊、今日不能做、國際亞洲、盤前新聞（只列持股與自選）。
// 試撮中只保留不含價格的兩列（今日不能做、盤前新聞）。持股試撮指示價＝2 期，本次不出現。
// 資料：pulse.focus.script（limitQueue／asiaPremarket）＋匯流排指數的 usMarket（那指期、台積電 ADR）
//       ＋useRiskCodes（處置／注意，站上既有來源，模組層級快取）
//       ＋board.news 精簡表（盤前新聞：AI 新聞識讀·媒體 M，與 A1 燈、Z2、B2 同一份；影響權重研究期·只顯示，只表強弱，不當排序鍵）。
import type { ReactNode } from 'react';
import { useRiskCodes, type RiskInfo } from '@/lib/useRiskCodes';
import { focusPartActive, FOCUS_WINDOW } from '../../../scripts/lib/warroom-focus-codec.mjs';
import type { Section } from '@/lib/warroom/types';
import type { FocusData, FocusScript as ScriptData } from '@/lib/warroom/build-focus';
import {
  newsLampView, newsShortText, premarketNewsRows, NEWS_WEIGHT_NOTE,
} from '../../../scripts/lib/warroom-news.mjs';
import { useWarData } from './WarRoomContext';
import { Badge } from './parts/Badge';
import { fmtInt, fmtPct, toneClass, hhmm, mmdd } from './parts/fmt';
import { NewsLamp } from './NewsLamp';
import { useNewsBoard } from './NewsModel';
import { FocusFrame, FocusMsg, CodeLink, type FocusShell } from './FocusFrame';
import { useFocusUniverse, type FocusUniverse } from './useFocusUniverse';
import styles from './WarRoomV2.module.css';
import css from './ZoneFocus.module.css';

const NEWS_LINE_TITLE = `只列持股與自選的盤後／夜補／晨間判別；AI 讀過內文才算判別，沒涵蓋的標「未判別」。`
  + `排序依類別與時間（規則類利空→利空→利多→中性→關注度→◆非今日適用），不依權重；強弱依影響權重（${NEWS_WEIGHT_NOTE}）。`
  + `承接、前一交易日或沒走四角色挑戰（可能是舊聞回退）的標 ◆、不列強弱。非投資建議`;
const QUEUE_TITLE = '買一貼漲停×賣一全空×當日最高尚未觸及漲停＝排隊搶漲停（尚未成交上去，不是已漲停）；張數＝買一委買張數';

const ymdShort = (ymd: string | null | undefined) => (ymd && /^\d{4}-\d{2}-\d{2}$/.test(ymd) ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}` : '—');

function Line({ label, title, mobile, children }: { label: string; title?: string; mobile: boolean; children: ReactNode }) {
  return (
    <div className={css.line} title={title}>
      <span className={css.lineLab}>{label}</span>
      <span className={mobile ? css.lineBodyM : css.lineBody}>{children}</span>
    </div>
  );
}

/** 盤前資料章：○ 未開盤·hh:mm（資料時間）；資料是前幾天的 ⇒ ◆ 前交易日 mm/dd */
function PreStamp({ asOf, ymd }: { asOf: number | null; ymd: string }) {
  const sameDay = asOf != null && new Date(asOf + 8 * 3_600_000).toISOString().slice(0, 10) === ymd;
  const glyph = asOf != null && !sameDay ? '◆' : '○';
  const text = asOf == null ? '未開盤' : sameDay ? `未開盤·${hhmm(asOf)}` : `前交易日 ${mmdd(asOf)}`;
  return (
    <span className={styles.stamp} data-state={glyph === '◆' ? 'prev' : 'preopen'} title="資料本身的時間（產出時刻），不是抓取時間">
      <i className={styles.stampGlyph} aria-hidden="true">{glyph}</i>{text}
    </span>
  );
}

function Stock({ code, u, mobile }: { code: string; u: FocusUniverse; mobile: boolean }) {
  const nm = u.nameOf(code);
  return <><CodeLink code={code} mobile={mobile} />{nm && <span className={styles.name}>{nm}</span>}</>;
}

function QueueLine({ part, ymd, u, mobile }: { part: ScriptData['queue']; ymd: string; u: FocusUniverse; mobile: boolean }) {
  let body: ReactNode;
  if (!part.ok) body = <span className={styles.muted}>{part.error}</span>;
  else if (!part.data) body = <span className={styles.muted}>資料尚未產生</span>;
  else if (part.data.date !== ymd) body = <span className={styles.muted}>今日尚無（最近資料 {ymdShort(part.data.date)}）</span>;
  else if (!part.data.items.length) body = <span className={styles.muted}>目前沒有排隊搶漲停的個股</span>;
  else {
    const shown = part.data.items.slice(0, mobile ? 3 : 4);
    body = (
      <>
        {shown.map((x) => (
          <span key={x.code} className={css.item}>
            <CodeLink code={x.code} mobile={mobile} /><span className={styles.name}>{x.name || u.nameOf(x.code)}</span>
            <span className={styles.mono}>{x.lots != null ? `${fmtInt(x.lots)} 張` : '—'}</span>
          </span>
        ))}
        {part.data.total > shown.length && <span className={styles.muted}>共 {part.data.total} 檔</span>}
      </>
    );
  }
  return <Line label="搶漲停排隊" title={QUEUE_TITLE} mobile={mobile}>{body}</Line>;
}

type RiskTag = { tag: '處' | '注'; text: string };
function riskOf(r: RiskInfo, code: string, ymd: string): RiskTag | null {
  if (r.disposition.has(code)) {
    const end = r.dispEnd.get(code);
    const start = r.dispStart.get(code);
    if (!end || end >= ymd) return { tag: '處', text: start && start > ymd ? `處置 ${ymdShort(start)} 起` : '處置中' };
  }
  if (r.attention.has(code)) {
    const end = r.attEnd.get(code);
    if (!end || end >= ymd) return { tag: '注', text: '注意' };
  }
  return null;
}

function BanLine({ ymd, u, mobile }: { ymd: string; u: FocusUniverse; mobile: boolean }) {
  const risk = useRiskCodes();
  let body: ReactNode;
  if (!risk.loaded) body = <span className={styles.muted}>處置／注意名單讀取中</span>;
  else {
    const mine = [...u.holdings.map((c) => ({ c, src: '持股' })), ...u.pinned.map((c) => ({ c, src: '釘選' }))]
      .map((x) => ({ ...x, r: riskOf(risk, x.c, ymd) }))
      .filter((x): x is { c: string; src: string; r: RiskTag } => !!x.r);
    const fresh = [...risk.disposition].filter((c) => risk.dispStart.get(c) === ymd).sort();
    body = (
      <>
        {mine.slice(0, 4).map((x) => (
          <span key={x.c} className={css.item} title={x.r.text}>
            <Badge tone="risk">{x.r.tag}</Badge><Stock code={x.c} u={u} mobile={mobile} />
            <span className={styles.muted}>（{x.src}）</span>
          </span>
        ))}
        {mine.length > 4 && <span className={styles.muted}>另 {mine.length - 4} 檔</span>}
        {fresh.length > 0 && (
          <span className={css.item} title="今日起生效的處置（全市場）">
            <span className={styles.muted}>新增處置</span>
            {fresh.slice(0, 2).map((c) => <span key={c} className={css.item}><Stock code={c} u={u} mobile={mobile} /></span>)}
            {fresh.length > 2 && <span className={styles.muted}>等 {fresh.length} 檔</span>}
          </span>
        )}
        {!mine.length && !fresh.length && <span className={styles.muted}>持股與釘選無處置／注意·今日無新增處置</span>}
        {!risk.complete && <span className={styles.muted}>（處置名單不完整）</span>}
      </>
    );
  }
  return <Line label="今日不能做" title="持股與當日釘選中的處置／注意股，以及全市場今日起生效的處置" mobile={mobile}>{body}</Line>;
}

function Pct({ label, v, prev, title }: { label: string; v: number | null | undefined; prev?: boolean; title?: string }) {
  return (
    <span className={css.item} title={title}>
      <span>{label}</span>
      <span className={`${styles.mono} ${toneClass(v ?? null)}`}>{prev ? '◆' : ''}{fmtPct(v ?? null)}</span>
    </span>
  );
}

function IntlLine({ part, ymd, mobile }: { part: ScriptData['asia']; ymd: string; mobile: boolean }) {
  const { index } = useWarData();
  const us = index?.usMarket;
  const nq = us && us.nasdaqFuturesPrice && us.nasdaqFuturesPrice > 0 ? us.nasdaqFuturesChangePercent : null;
  const adr = us && us.tsmcAdrPrice > 0 ? us.tsmcAdrChangePercent : null;
  const asia = part.ok ? part.data : null;
  const asiaToday = asia && asia.date === ymd;
  const delay = asia?.delayMin != null ? `報價約落後 ${asia.delayMin} 分（免費源）` : undefined;
  return (
    <Line label="國際亞洲" mobile={mobile}>
      {nq != null ? <Pct label="那指期" v={nq} title="那斯達克期貨（無時間欄位，延遲未驗證）" /> : <span className={css.item}><span>那指期</span><span className={styles.muted}>—</span></span>}
      {asia?.sox != null && <Pct label="費半" v={asia.sox} prev title="前一晚美股收盤" />}
      {adr != null && <Pct label="台積電 ADR" v={adr} prev title="前一晚美股收盤" />}
      {asiaToday ? (
        <>
          {asia.jp != null && <Pct label="日經" v={asia.jp} title={delay} />}
          {asia.kr != null && <Pct label="韓國" v={asia.kr} title={delay} />}
          {asia.split && <span className={styles.muted}>日韓分歧</span>}
          {asia.late && <span className={styles.muted}>（補跑·非盤前觀測）</span>}
        </>
      ) : (
        <span className={styles.muted}>{part.ok ? '日韓：今日尚未更新' : '日韓：讀取失敗'}</span>
      )}
    </Line>
  );
}

function NewsLine({ u, mobile }: { u: FocusUniverse; mobile: boolean }) {
  const news = useNewsBoard();
  const { ctx } = news;
  let body: ReactNode;
  if (news.status === 'loading') body = <span className={styles.muted}>載入中…</span>;
  else if (!news.board) body = <span className={styles.muted}>{news.error ?? '讀取失敗'}</span>;
  else if (!u.holdings.length && !u.watchlist.length) body = <span className={styles.muted}>尚無持股與自選</span>;
  else {
    const r = premarketNewsRows(news.board, { holdings: u.holdings, watch: u.watchlist, ctx, minAtMs: news.minAtMs });
    const shown = r.rows.slice(0, mobile ? 3 : 4);
    body = (
      <>
        {ctx.fresh === 'today' && <span className={styles.muted}>適用 {ymdShort(ctx.targetDate)}</span>}
        {ctx.fresh === 'prev' && <span className={styles.muted}>◆ 前交易日 {ymdShort(ctx.targetDate)} 判別（今日盤後／晨間尚未更新）</span>}
        {ctx.fresh === 'next' && <span className={styles.muted}>◆ 下一交易日 {ymdShort(ctx.targetDate)} 的判別</span>}
        {shown.map((x) => {
          const view = newsLampView(x.entry, ctx);
          const ev = x.entry.ev ? `·${x.entry.ev}` : '';
          return (
            <span key={x.code} className={css.item} title={`${view.title}${ev}`}>
              <NewsLamp view={view} major={x.mb?.level === 1} />
              <Stock code={x.code} u={u} mobile={mobile} />
              <span>{newsShortText(x.entry, ctx)}</span>
            </span>
          );
        })}
        {r.rows.length > shown.length && <span className={styles.muted}>另 {r.rows.length - shown.length} 檔已判別</span>}
        {r.missing.length > 0 && (
          <span className={css.item} title={`未判別／資訊不足：${r.missing.slice(0, 12).join('、')}${r.missing.length > 12 ? '…' : ''}（判別範圍未擴大）`}>
            <NewsLamp view={newsLampView(null, ctx)} />
            <span className={styles.muted}>未判別 {r.missing.length} 檔</span>
          </span>
        )}
        {!r.rows.length && !r.missing.length && <span className={styles.muted}>持股與自選沒有盤前判別</span>}
      </>
    );
  }
  return <Line label="盤前新聞" title={NEWS_LINE_TITLE} mobile={mobile}>{body}</Line>;
}

export interface FocusScriptProps {
  shell: FocusShell;
  kind: 'script' | 'preclear';
  focus: Section<FocusData> | null | undefined;
}

export default function FocusScript({ shell, kind, focus }: FocusScriptProps) {
  const { clock, segment } = useWarData();
  const u = useFocusUniverse();
  const mobile = shell.variant === 'mobile';
  const ymd = clock.ymd;
  const preclear = kind === 'preclear';
  const part = focus?.ok ? focus.data.script : undefined;
  const foot = preclear ? '試撮指示價可能不成交·09:00 起依揭示更新' : '08:55 起只清空價格欄（持股清單保留）·09:00 切換為開盤三關';

  let body: ReactNode;
  if (!focus) body = <FocusMsg big="載入中…" />;
  else if (!focus.ok) body = <FocusMsg big={focus.error} />;
  else if (!part) {
    const active = focusPartActive('script', clock.minute, segment !== 'nontrading');
    body = active
      ? <FocusMsg big="資料更新中">每 30 秒更新一次</FocusMsg>
      : <FocusMsg big={`開盤劇本於${FOCUS_WINDOW.script.label}提供`}>目前不在提供時段</FocusMsg>;
  } else if (!part.ok) body = <FocusMsg big={part.error} />;
  else {
    const d = part.data;
    body = (
      <>
        {preclear && <div className={css.notice} role="status">試撮中·09:00 起更新</div>}
        {!preclear && <QueueLine part={d.queue} ymd={ymd} u={u} mobile={mobile} />}
        <BanLine ymd={ymd} u={u} mobile={mobile} />
        {!preclear && <IntlLine part={d.asia} ymd={ymd} mobile={mobile} />}
        <NewsLine u={u} mobile={mobile} />
      </>
    );
  }
  return (
    <FocusFrame shell={shell} kind={kind} stamp={part && part.ok ? <PreStamp asOf={part.asOf} ymd={ymd} /> : null} foot={part ? foot : undefined}>
      {body}
    </FocusFrame>
  );
}
