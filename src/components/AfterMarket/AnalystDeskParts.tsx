'use client';

import { Fragment, useState } from 'react';
import { Detail, PriceCell, StockCell, amStyles as s, mdOf } from './shared';
import {
  ANALYST_NAME, DIR_PLAIN, DIR_TONE, fillSlots, fmtClose, fmtRefValue,
  type Claim, type FocusBlock, type FocusStock, type RefTable, type TextRefs,
} from './analystDeskTypes';
import c from './AnalystDesk.module.css';

// ── AI 分析師團隊報告：可重用的小零件（證據晶片、逐句 claims、個股列）──────────────────────────────

const OFFICIAL_TIERS = new Set(['官方', '官方衍生']);
const UNVERIFIED_TIERS = new Set(['AI待驗', '傳聞', '先驗·未驗證']);

/** 證據列表：每個 ref 的名稱、值（含單位）、資料日、來源、等級；refTable 沒有的 ref 照實寫「不在證據表」。 */
function RefList({ ids, table, roles }: { ids: string[]; table: RefTable; roles?: Record<string, string> }) {
  return (
    <ul className={c.refList}>
      {ids.map(id => {
        const e = table[id];
        return (
          <li key={id}>
            {e ? (
              <>
                {e.label ?? id}{roles?.[id] ? `（${roles[id]}）` : ''}：<span className={c.refVal}>{fmtRefValue(e)}</span>
                ｜資料日 {e.asOf ?? '—'}｜{e.tier ?? '等級未標示'}｜來源 {e.source ?? '—'}
              </>
            ) : <>{id}：不在證據表（來源未提供）</>}
          </li>
        );
      })}
    </ul>
  );
}

/** 句末證據晶片：顯示等級小標籤；點開用 Detail 區塊列出該句引用的 refs。tier 缺值時由 refs 的證據表等級帶出。 */
export function EvidenceChip({ tier, refs, table, roles }: { tier?: string; refs?: string[]; table: RefTable; roles?: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const ids = [...new Set(refs ?? [])];
  const label = tier || '等級未標示';
  const cls = `${c.chip} ${OFFICIAL_TIERS.has(label) ? c.chipOfficial : UNVERIFIED_TIERS.has(label) ? c.chipUnverified : ''}`;
  return (
    <>
      <button type="button" className={cls} aria-expanded={open} title="點開看這句引用的資料、資料日與來源" onClick={() => setOpen(o => !o)}>{label}</button>
      {open && <Detail title="證據">{ids.length ? <RefList ids={ids} table={table} roles={roles} /> : <p>此句沒有引用資料（只是結構性敘述）。</p>}</Detail>}
    </>
  );
}

/** 方向詞：拉抬／偏強＝紅、拖累／偏弱＝綠（描述，不是看多看空）；利多／利空／需讀內文只用中性小標籤。 */
function DirTag({ dir }: { dir?: string }) {
  if (!dir) return null;
  const tone = DIR_TONE[dir];
  if (tone) return <b className={`${c.dir} ${tone === 'up' ? s.up : s.dn}`}>{dir}</b>;
  return DIR_PLAIN.has(dir) ? <span className={c.dirPlain}>{dir}</span> : null;
}

/** 逐句 claims：句末接方向詞與證據晶片。 */
export function ClaimList({ claims, table }: { claims?: Claim[]; table: RefTable }) {
  if (!claims?.length) return null;
  return (
    <ul className={c.claims}>
      {claims.map(cl => (
        <li key={cl.id}>
          {fillSlots(cl.text, table)}<DirTag dir={cl.direction} /><EvidenceChip tier={cl.tier ?? tierOfRefs(cl.refs, table)} refs={cl.refs} table={table} />
        </li>
      ))}
    </ul>
  );
}

/** 分析師分段：小標題＋撰稿分析師標籤＋claims。 */
export function SectionBlock({ title, analyst, claims, table }: { title: string; analyst?: string; claims: Claim[]; table: RefTable }) {
  if (!claims?.length) return null;
  return (
    <div>
      <h4 className={c.secTitle}>{title}{analyst && <span className={c.analystTag}>{ANALYST_NAME[analyst] ?? analyst}</span>}</h4>
      <ClaimList claims={claims} table={table} />
    </div>
  );
}

function TextRefList({ items, table }: { items?: TextRefs[]; table: RefTable }) {
  if (!items?.length) return null;
  return <ul className={c.watchList}>{items.map(it => <li key={it.text}>{fillSlots(it.text, table)}<EvidenceChip tier={tierOfRefs(it.refs, table)} refs={it.refs} table={table} /></li>)}</ul>;
}

/** 一組 refs 的最低等級（只用於沒有自帶 tier 的 watchConditions／risks 晶片；排序依來源可信度由高到低）。 */
const TIER_ORDER = ['官方', '官方衍生', '媒體', '站內整理', 'AI待驗', '傳聞', '先驗·未驗證'];
function tierOfRefs(refs: string[] | undefined, table: RefTable): string | undefined {
  let worst = -1;
  for (const id of refs ?? []) {
    const i = TIER_ORDER.indexOf(table[id]?.tier ?? '');
    if (i > worst) worst = i;
  }
  return worst >= 0 ? TIER_ORDER[worst] : undefined;
}

/** 資料觀察名單的一列（僅管理員）：即時價（PriceCell）＋靜態資料日收＋thesis＋證據＋觀察條件＋風險（預設收合；有反向資料固定顯示）。 */
function FocusRow({ stock, table, also }: { stock: FocusStock; table: RefTable; also?: string[] }) {
  const [riskOpen, setRiskOpen] = useState(false);
  const [evOpen, setEvOpen] = useState(false);
  const closeRef = stock.asOf?.closeRef;
  const close = closeRef ? table[closeRef] : undefined;
  const closeDay = close?.asOf ?? stock.asOf?.day;
  const evidence = stock.evidence ?? [];
  const evTier = tierOfRefs(evidence.map(e => e.ref), table);
  const roles = Object.fromEntries(evidence.filter(e => e.role).map(e => [e.ref, e.role as string]));
  const nRisk = stock.risks?.length ?? 0;
  const hasAdverse = (stock.adverse?.length ?? 0) > 0;
  return (
    <li className={c.focusRow}>
      <div className={c.focusHead}>
        <StockCell code={stock.code} name={stock.name} />
        <PriceCell code={stock.code} />
        <span className={c.closeStatic} title="靜態資料日收盤價（證據表）；左側現價為即時／收盤後即收盤價">資料日 {mdOf(closeDay)} 收 {fmtClose(close)}</span>
      </div>
      {stock.thesis && <p className={c.thesis}>{fillSlots(stock.thesis, table)}</p>}
      {evidence.length > 0 && (
        <button type="button" className={`${c.chip} ${evTier && OFFICIAL_TIERS.has(evTier) ? c.chipOfficial : evTier && UNVERIFIED_TIERS.has(evTier) ? c.chipUnverified : ''}`} aria-expanded={evOpen} onClick={() => setEvOpen(o => !o)} style={{ marginLeft: 0 }}>
          證據 {evidence.length}｜{evTier ?? '等級未標示'}
        </button>
      )}
      {evOpen && <Detail title="證據"><RefList ids={evidence.map(e => e.ref)} table={table} roles={roles} /></Detail>}
      {stock.watchConditions && stock.watchConditions.length > 0 && <><h4 style={{ margin: '8px 0 0' }}>觀察條件</h4><TextRefList items={stock.watchConditions} table={table} /></>}
      <div className={c.rowEnd}>
        {nRisk > 0 && <button type="button" className={c.subBtn} aria-expanded={riskOpen} onClick={() => setRiskOpen(o => !o)}>{riskOpen ? '▾' : '▸'} 風險（{nRisk}）</button>}
        {hasAdverse && <span className={c.adv} title="資料包內有與這檔列入理由相反或屬風險的資料（點開風險看明細）">有反向資料</span>}
      </div>
      {riskOpen && <TextRefList items={stock.risks} table={table} />}
      {also && also.length > 0 && <p className={c.also}>亦見於 {also.join('、')}</p>}
    </li>
  );
}

/** 名單區：池大小與排除檔數（來源已程式統計）＋各列；不足就少列並寫原因（note）。 */
export function FocusList({ block, table, cardId, cardTitle, appearances }: { block: FocusBlock; table: RefTable; cardId: string; cardTitle: string; appearances: Record<string, string[]> }) {
  const stocks = block.stocks ?? [];
  return (
    <Fragment>
      {(block.poolSize != null || block.excludedCount != null) && (
        <p className={c.focusMeta}>候選池 {block.poolSize ?? '—'} 檔（規則 {block.poolRule ?? '—'}），排除 {block.excludedCount ?? '—'} 檔；列示 {stocks.length} 檔。</p>
      )}
      {block.note && <p className={c.focusMeta}>{block.note}</p>}
      {stocks.length === 0
        ? <p className={c.focusMeta}>本卡沒有列示個股（候選不足或來源未提供時不補列）。</p>
        : <ul className={c.focusList}>{stocks.map(st => <FocusRow key={`${cardId}${st.code}`} stock={st} table={table} also={(appearances[st.code] ?? []).filter(t => t !== cardTitle)} />)}</ul>}
    </Fragment>
  );
}
