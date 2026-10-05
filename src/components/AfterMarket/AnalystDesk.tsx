'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { auth } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import AnalysisReport from './AnalysisReport';
import { Card, amStyles as s, fmtTs, useApi } from './shared';
import { ClaimList, EvidenceChip, FocusList, SectionBlock } from './AnalystDeskParts';
import {
  ADMIN_ONLY_NOTE, ANALYST_NAME, DISCLAIMER_LONG, DISCLAIMER_SHORT, EDITION_NAME, ENGINE_NAME, FALLBACK_NOTE,
  cutCount, degradedName, fillSlots, focusByCard, stockAppearances,
  type DeskCard, type FocusBlock, type FocusDoc, type Issue, type RefTable,
} from './analystDeskTypes';
import c from './AnalystDesk.module.css';

// ── 📝 分析報告：AI 分析師團隊版（盤面動能／產業與本土消息／全球與總經＋總編輯）──────────────────────────
// 資料：公開 /api/twse/daily-analyst（分析文字，不含個股名單）；個股「資料觀察名單」研究期僅管理員可見，
// 管理員另以 idToken 讀 /api/admin/daily-analyst-focus。文件格式見 docs/analyst-desk-2026-10-05/CONTRACT.md §3。
// 數字都由程式把槽位渲染進 claim.text，本元件只顯示、不重算、不補值；證據晶片點開看該句引用的資料值、資料日與來源。
// 不預測、不計分；列示個股僅為資料整理的觀察名單，非投資建議。issue 缺漏或 fallback＝template 時退回資料模板版（AnalysisReport）。
// 不輪詢（一天最多變兩次）；公開文件走 useApi 的 60 秒共用 fetch。

const ADMIN_EMAIL = process.env.NEXT_PUBLIC_ADMIN_EMAIL;
const FOCUS_URL = '/api/admin/daily-analyst-focus';
const FOCUS_TIMEOUT_MS = 15_000;
type FocusState = 'off' | 'loading' | 'ok' | 'empty' | 'error';

/** 管理員專用：以 Bearer idToken 讀名單（同 SurgeShadow 的作法）；掛載時讀一次、不輪詢。 */
function useAdminFocus(enabled: boolean): { doc: FocusDoc | null; state: FocusState } {
  const [res, setRes] = useState<{ doc: FocusDoc | null; state: FocusState }>({ doc: null, state: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    (async () => {
      try {
        const token = (await auth.currentUser?.getIdToken()) ?? '';
        const r = await fetch(FOCUS_URL, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FOCUS_TIMEOUT_MS) });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as (FocusDoc & { found?: boolean }) | null;
        if (!live) return;
        setRes(!j || j.found === false || !Object.keys(j).length ? { doc: null, state: 'empty' } : { doc: j, state: 'ok' });
      } catch {
        if (live) setRes({ doc: null, state: 'error' });
      }
    })();
    return () => { live = false; };
  }, [enabled]);
  return enabled ? res : { doc: null, state: 'off' };
}

/** 放行前（公開 API 回 gated）管理員審閱用：以 Bearer idToken 讀同一份分析文字（/api/admin/daily-analyst-focus?doc=analysis）。 */
function useAdminAnalysis(enabled: boolean): { issue: Issue | null; state: FocusState } {
  const [res, setRes] = useState<{ issue: Issue | null; state: FocusState }>({ issue: null, state: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    (async () => {
      try {
        const token = (await auth.currentUser?.getIdToken()) ?? '';
        const r = await fetch(`${FOCUS_URL}?doc=analysis`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FOCUS_TIMEOUT_MS) });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as (Issue & { found?: boolean }) | null;
        if (!live) return;
        setRes(!j || j.found === false || !Object.keys(j).length ? { issue: null, state: 'empty' } : { issue: j, state: 'ok' });
      } catch {
        if (live) setRes({ issue: null, state: 'error' });
      }
    })();
    return () => { live = false; };
  }, [enabled]);
  return enabled ? res : { issue: null, state: 'off' };
}

function useIsAdmin(): boolean {
  const user = useAppStore(st => st.user);
  return !!user && (user.level === 'superadmin' || user.level === 'admin' || (!!ADMIN_EMAIL && user.email === ADMIN_EMAIL));
}

function Fallback({ note = FALLBACK_NOTE }: { note?: string }) {
  return (
    <div className={s.stack}>
      <p className={s.note}><b>{note}</b>（每日由系統整理，來源未提供時不補值）。</p>
      <AnalysisReport />
    </div>
  );
}

function checkText(m: Issue['meta']): string {
  const ck = m?.check;
  if (!ck) return '查核：未提供';
  const rules = Object.values(ck.rules ?? {});
  const nPass = rules.filter(v => v === 'pass').length;
  const cut = cutCount(ck);
  return `${ck.pass ? `查核 ✔ ${nPass} 項通過` : `查核未全數通過（待處理 ${ck.blockers ?? '—'}）`}${cut > 0 ? `，程式刪除 ${cut} 句` : ''}`;
}

function DeskHead({ issue }: { issue: Issue }) {
  const [open, setOpen] = useState(false);
  const m = issue.meta;
  const stamp = m?.canonicalAt ?? issue.canonicalAt ?? m?.generatedAt;
  const sha = m?.pack?.sha256 ? ` ｜資料包 ${m.pack.sha256.slice(0, 8)}` : '';
  const engine = ENGINE_NAME[m?.engineTier ?? ''] ?? m?.engineTier ?? '—';
  const notes = [...(m?.degraded ?? []).map(degradedName), ...((m?.pack?.absent ?? []).length ? [`來源未提供：${m?.pack?.absent?.join('、')}`] : [])];
  return (
    <header className={c.head}>
      <p className={c.metaLine}>
        🕒 <b>分析定版</b> {fmtTs(stamp)}｜資料日 {issue.dataDate}（{EDITION_NAME[issue.edition ?? ''] ?? issue.edition ?? '—'}）｜撰寫引擎 <b>{engine}</b>｜{checkText(m)}{sha}
      </p>
      {notes.length > 0 && <p className={c.srcNote}>資料來源說明：{notes.join('；')}。缺的來源寫「來源未提供」，不推測補值。</p>}
      <button type="button" className={c.discBtn} aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'} 免責聲明（完整）</button>
      {open && <p className={c.discLong}>{issue.useRules?.disclaimer || DISCLAIMER_LONG}</p>}
    </header>
  );
}

function ShortDisclaimer({ issue }: { issue: Issue }) {
  return <p className={c.foot}>{issue.useRules?.disclaimerShort || DISCLAIMER_SHORT}</p>;
}

function SummaryCard({ issue, table }: { issue: Issue; table: RefTable }) {
  const sm = issue.summary;
  if (!sm) return null;
  const who = (sm.byline?.contributors ?? []).map(k => ANALYST_NAME[k] ?? k).join('、');
  const part = (title: string, claims: typeof sm.points): ReactNode => (claims?.length ? <><h4>{title}</h4><ClaimList claims={claims} table={table} /></> : null);
  return (
    <div className={c.summary}>
      <Card title="每日總結" state="ok" tier={EDITION_NAME[issue.edition ?? ''] ?? undefined} dateLabel="資料日" dataDate={issue.dataDate}>
        {sm.headline && <p className={c.headline}>{fillSlots(sm.headline, table)}</p>}
        {part('要點', sm.points)}
        {part('明日觀察重點（條件式）', sm.nextFocus)}
        {part('風險與反證', sm.risks)}
        <p className={c.byline}>{who ? `撰稿：${who}；` : ''}{sm.byline?.editor ?? '總編輯'}整合；{checkText(issue.meta)}</p>
        <ShortDisclaimer issue={issue} />
      </Card>
    </div>
  );
}

const focusTitle = (card: DeskCard, kind: string) =>
  kind === 'watch' ? '資料觀察名單（明日卡）' : `回顧名單（${card.id === 'prev' ? '昨日' : '今日'}卡）`;

interface FocusCtx { isAdmin: boolean; state: FocusState; blocks: Record<string, FocusBlock>; table: RefTable; appearances: Record<string, string[]>; mismatch: boolean }

function FocusSide({ card, ctx }: { card: DeskCard; ctx: FocusCtx }) {
  const pub = card.focus;
  const kind = pub?.kind ?? (card.id === 'next' ? 'watch' : 'recap');
  const block: FocusBlock | undefined = ctx.blocks[card.id] ? { ...pub, ...ctx.blocks[card.id] } : undefined;
  let body: ReactNode;
  if (ctx.state === 'loading') body = <p className={c.focusMeta}>名單載入中…</p>;
  else if (ctx.state === 'error') body = <p className={c.focusMeta}>名單暫時讀取失敗，稍後再試（不影響分析文字）。</p>;
  else if (ctx.mismatch) body = <p className={c.focusMeta}>名單與目前報告的資料日／版次不一致，暫不顯示（兩者發佈間隔中，稍後重新整理）。</p>;
  else if (!block) body = <p className={c.focusMeta}>尚無名單資料（收盤後由系統整理，來源未提供時不補列）。</p>;
  else body = <FocusList block={block} table={ctx.table} cardId={card.id} cardTitle={card.title} appearances={ctx.appearances} />;
  return <aside className={c.side}><h4>{focusTitle(card, kind)}</h4>{body}</aside>;
}

function DeskCardView({ card, table, ctx, defaultOpen, issue }: { card: DeskCard; table: RefTable; ctx: FocusCtx; defaultOpen: boolean; issue: Issue }) {
  return (
    <Card title={card.title} state="ok" dateLabel={card.asOf?.label ?? '資料日'} dataDate={card.asOf?.day} defaultOpen={defaultOpen}>
      <div className={ctx.isAdmin ? c.cols : c.col1}>
        <div className={c.main}>
          {(card.sections ?? []).map(sec => <SectionBlock key={sec.id} title={sec.title} analyst={sec.analyst} claims={sec.claims} table={table} />)}
        </div>
        {ctx.isAdmin ? <FocusSide card={card} ctx={ctx} /> : <p className={s.note}>{ADMIN_ONLY_NOTE}</p>}
      </div>
      <ShortDisclaimer issue={issue} />
    </Card>
  );
}

function Linkages({ issue, table }: { issue: Issue; table: RefTable }) {
  const items = issue.linkages ?? [];
  if (!items.length) return null;
  const name = (ref?: string) => (ref ? table[ref]?.label ?? ref : '—');
  return (
    <Card title="連動分析（全球與本土）" state="ok" tier="站內整理" dateLabel="資料日" dataDate={issue.dataDate}>
      <ul className={c.claims}>
        {items.map(l => (
          <li key={l.id} className={c.linkage}>
            <span className={c.linkHead}>{name(l.from?.ref)} → {name(l.to?.ref)}{l.mechanism && <span className={c.mech}>{l.mechanism}</span>}</span>
            <span>{fillSlots(l.text, table)}<EvidenceChip tier={l.tier} refs={[l.from?.ref, l.to?.ref, ...(l.refs ?? [])].filter((x): x is string => !!x)} table={table} /></span>
            {l.authors && l.authors.length > 0 && <span className={c.by}>共同署名：{l.authors.map(a => ANALYST_NAME[a] ?? a).join('、')}</span>}
          </li>
        ))}
      </ul>
      <ShortDisclaimer issue={issue} />
    </Card>
  );
}

function Desk({ issue }: { issue: Issue }) {
  const isAdmin = useIsAdmin();
  const focus = useAdminFocus(isAdmin);
  // 昨日卡手機預設收合（只在資料載入後才掛載本元件，讀 matchMedia 不會造成 hydration 差異）
  const [mobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches);
  const cards = issue.cards ?? [];
  const ctx = useMemo<FocusCtx>(() => {
    const blocks = focusByCard(focus.doc);
    const titles = Object.fromEntries((issue.cards ?? []).map(cd => [cd.id, cd.title]));
    const doc = focus.doc;
    const mismatch = !!doc && ((doc.dataDate != null && doc.dataDate !== issue.dataDate) || (doc.edition != null && issue.edition != null && doc.edition !== issue.edition));
    return {
      isAdmin, state: focus.state, blocks: mismatch ? {} : blocks, mismatch,
      table: { ...(issue.refTable ?? {}), ...(mismatch ? {} : doc?.refTable ?? {}) },
      appearances: stockAppearances(mismatch ? {} : blocks, titles),
    };
  }, [isAdmin, focus.doc, focus.state, issue.cards, issue.dataDate, issue.edition, issue.refTable]);
  const table = ctx.table;
  return (
    <div className={s.stack}>
      <DeskHead issue={issue} />
      <SummaryCard issue={issue} table={table} />
      {cards.map(cd => <DeskCardView key={cd.id} card={cd} table={table} ctx={ctx} issue={issue} defaultOpen={!(cd.id === 'prev' && mobile)} />)}
      <Linkages issue={issue} table={table} />
    </div>
  );
}

const GATED_NOTE = 'AI 分析師版研究期審閱中，暫顯示資料模板版';
const GATED_ADMIN_NOTE = '研究期審閱中：此版本尚未對一般使用者放行（僅管理員可見）';

export default function AnalystDesk() {
  const pub = useApi<Issue & { gated?: boolean }>('/api/twse/daily-analyst');
  const isAdmin = useIsAdmin();
  const gated = pub.state === 'ok' && pub.data?.gated === true;
  const adminPub = useAdminAnalysis(isAdmin && gated);
  if (pub.state === 'loading') return <p className={s.note}>載入中…</p>;
  if (gated) {
    if (!isAdmin) return <Fallback note={GATED_NOTE} />;
    if (adminPub.state === 'loading') return <p className={s.note}>載入中…</p>;
    const a = adminPub.issue;
    if (adminPub.state !== 'ok' || !a || a.meta?.fallback === 'template' || !a.cards?.length) return <Fallback note={GATED_NOTE} />;
    return (<><p className={s.note}><b>{GATED_ADMIN_NOTE}</b></p><Desk issue={a} /></>);
  }
  const issue = pub.data;
  if (pub.state !== 'ok' || !issue || issue.meta?.fallback === 'template' || !issue.cards?.length) return <Fallback />;
  return <Desk issue={issue} />;
}
