'use client';

import { Fragment, useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { AsOfContext, PriceCell, StockCell, dayLabel, useAsOf } from '@/components/AfterMarket/shared';
import styles from './DailyHeatmap.module.css';

// ── 📊 每日熱力：最後交易日報告頁（技能 tw-daily-heatmap）────────────────
// 描述「資料日收盤」的事實：族群熱力、個股榜、權值股對加權指數的貢獻。
// 不預測、不計分、不進任何推薦排序；熱度只是當日統計量（硬規定，見 SKILL §0）。

interface Industry {
  key: string; n: number; ew: number | null; exMkt: number | null; med: number | null; z: number | null;
  upRatio: number | null; luN: number; capW: number | null; shape: string | null; singleStockDriven: boolean;
  listable: boolean; heat: number | null; heatPct: number | null; members?: Member[];
}
interface Weighted { code: string; name: string; wPrev: number; wClose: number; ret: number; pts: number; sens1pctPts: number }
interface Split { n: number; weight: number; pts: number; restPts: number; shareOfChange: number | null }
interface Member { code: string; name: string; ret: number | null; valM: number | null; flags: number; resonance: string | null }
interface Layer { key: string; tier: string; n: number; lowN: boolean; ew: number; exMkt: number; z: number | null; up: number; dn: number; luN: number; members?: Member[] }
interface Link { chains?: { name: string }[]; group?: { name: string } | null }
interface BoardRow { code: string; name: string; industry: string | null; ret: number; valM: number | null; resonanceName: string; links: Link | null }
interface WatchItem { list: string; kind: 'group' | 'stock'; key: string; name?: string; ret?: number; reason?: string; trigger: { rule: string; values: Record<string, unknown> }; evidence: { level: string; caveat: string } }
interface Doc {
  dataDate: string; canonicalAt: string; degraded?: string[];
  useRules: { disclaimer: string };
  market: { n: number; tse: number; otc: number; ew: number; capW: number | null; up: number; dn: number; flat: number; luN: number; ldN: number; lockU: number };
  universe: { noTrade: number; noRef: number; unlimited: { code: string; ret: number }[] };
  industries: Industry[];
  index: null | {
    prevIndex: number; officialPts: number; predPts: number; residualPts: number; residualBp: number; grade: string;
    exDivMechanicalPts: number; exDivBp: number; exDivFlag: boolean; top: Weighted[]; splits: Split[];
    contributors: Weighted[]; draggers: Weighted[]; nextBasis: Weighted[]; conc10: number | null; w1: number; w10: number;
    instTop10Ntd: number | null; instRestNtd: number | null;
  };
  breadth: { up: number; dn: number; adr: number | null; net: number; indexRetPct: number | null; tseEwPct: number | null; gapPp: number | null };
  layers: { chains: Layer[]; segments: Layer[]; groups: Layer[]; families: Layer[] };
  board: { gainers: BoardRow[]; losers: BoardRow[]; byValue: BoardRow[] };
  watch: { continue: WatchItem[]; catchup: WatchItem[]; risk: WatchItem[] };
}

const sg = (x: number | null | undefined, d = 2) => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(d)}`);
// 台股慣例：紅漲綠跌
const tone = (x: number | null | undefined) => (x == null || x === 0 ? '' : x > 0 ? styles.up : styles.dn);
const ntd = (x: number | null) => (x == null ? '—（來源未提供）' : `${sg(x / 1e8, 1)} 億（估）`);
const GRADE: Record<string, string> = { 綠: '可信', 黃: '近似', 紅: '歸因不可靠' };

type Tab = 'industry' | 'index' | 'board' | 'wiki' | 'watch';
const TABS: { id: Tab; label: string }[] = [
  { id: 'industry', label: '產業熱力' }, { id: 'index', label: '權值股貢獻' }, { id: 'board', label: '個股榜' },
  { id: 'wiki', label: 'wiki 連動' }, { id: 'watch', label: '次日觀察' },
];

// 旗標位元（scripts/lib/daily-heatmap/compute.mjs flagsOf）：1 漲停、2 跌停、4 鎖死(一字)、32 除權息日、64 無漲跌幅限制
const FLAG_TEXT: [number, string][] = [[1, '漲停'], [2, '跌停'], [4, '鎖死'], [32, '除權息'], [64, '無漲跌幅限制']];
const flagText = (f: number) => FLAG_TEXT.filter(([b]) => f & b).map(([, t]) => t).join('・');
const RES: Record<string, string> = { A: '族群共振', B: '產業共振', C: '個股獨行', D: '無緊密群連結' };

/** 展開集合：點 ▸ 切換單列、全部展開／全部收合。 */
function useOpenSet() {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return {
    has: (k: string) => open.has(k),
    toggle: (k: string) => setOpen(o => { const n = new Set(o); if (!n.delete(k)) n.add(k); return n; }),
    all: (keys: string[]) => setOpen(new Set(keys)),
    none: () => setOpen(new Set()),
  };
}

function BulkButtons({ keys, o }: { keys: string[]; o: ReturnType<typeof useOpenSet> }) {
  return <div className={styles.bulk}><button type="button" onClick={() => o.all(keys)}>全部展開</button><button type="button" onClick={o.none}>全部收合</button></div>;
}

function Toggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return <button type="button" className={styles.toggle} aria-expanded={open} aria-label={open ? '收合' : '展開'} onClick={onClick}>{open ? '▾' : '▸'}</button>;
}

/** 成分個股：代號＋名稱，點「分析」進入該股詳細分析頁（navigateTo('stock')）。 */
function MemberList({ members, showResonance }: { members?: Member[]; showResonance?: boolean }) {
  const asOf = useAsOf();
  const navigateTo = useAppStore(s => s.navigateTo);
  if (!members || members.length === 0) return <p className={styles.note}>此資料日尚無成分個股明細（舊版定版檔）。</p>;
  return (
    <div className={styles.memberBox}>
      <table className={styles.tbl}>
        <thead><tr><th>個股</th><th>現價／昨收</th><th>{asOf}<br />漲跌%</th><th>{asOf}<br />成交(百萬)</th><th>{asOf}<br />標記</th>{showResonance && <th>共振</th>}<th>詳細分析</th></tr></thead>
        <tbody>{members.map(m => (
          <tr key={m.code}>
            <td><StockCell code={m.code} name={m.name} /></td><td><PriceCell code={m.code} showChange={false} /></td>
            <td className={tone(m.ret)}>{sg(m.ret)}</td><td>{m.valM?.toLocaleString() ?? '—'}</td><td>{flagText(m.flags) || '—'}</td>
            {showResonance && <td>{m.resonance ? RES[m.resonance] : '—'}</td>}
            <td><button className={styles.link} onClick={() => navigateTo('stock', m.code)}>分析 ›</button></td>
          </tr>
        ))}</tbody>
      </table>
      <p className={styles.note}>共 {members.length} 檔，依 {asOf} 漲跌由高到低（以官方參考價計）；現價為目前價。</p>
    </div>
  );
}

function LayerTable({ title, rows, note }: { title: string; rows: Layer[]; note: string }) {
  const asOf = useAsOf();
  const o = useOpenSet();
  if (!rows.length) return null;
  return (
    <section className={styles.block}>
      <h3>{title} <span className={styles.tier}>{note}</span><span className={styles.tier}>{asOf}</span></h3>
      <BulkButtons keys={rows.slice(0, 15).map(x => x.key)} o={o} />
      <table className={styles.tbl}>
        <thead><tr><th></th><th>名稱</th><th>n</th><th>等權%</th><th>超額pp</th><th>z</th><th>漲/跌</th><th>漲停</th></tr></thead>
        <tbody>{rows.slice(0, 15).map(x => (
          <Fragment key={x.key}>
            <tr><td><Toggle open={o.has(x.key)} onClick={() => o.toggle(x.key)} /></td>
              <td>{x.key}{x.lowN && <span className={styles.tier}> 僅觀察</span>}</td><td>{x.n}</td>
              <td className={tone(x.ew)}>{sg(x.ew)}</td><td className={tone(x.exMkt)}>{sg(x.exMkt)}</td><td>{x.z ?? '—'}</td><td>{x.up}/{x.dn}</td><td>{x.luN}</td></tr>
            {o.has(x.key) && <tr className={styles.detailRow}><td colSpan={8}><MemberList members={x.members} showResonance />{(x.members?.length ?? 0) < x.n && x.members && <p className={styles.note}>成員 {x.n} 檔，此處列前 {x.members.length} 檔。</p>}</td></tr>}
          </Fragment>
        ))}</tbody>
      </table>
    </section>
  );
}

function BoardTable({ title, rows }: { title: string; rows: BoardRow[] }) {
  const asOf = useAsOf();
  return (
    <section className={styles.block}>
      <h3>{title} <span className={styles.tier}>{asOf}</span></h3>
      <table className={styles.tbl}>
        <thead><tr><th>個股</th><th>現價／昨收</th><th>產業</th><th>{asOf}<br />漲跌%</th><th>{asOf}<br />成交(百萬)</th><th>共振</th><th>wiki 連動（站內整理）</th></tr></thead>
        <tbody>{rows.slice(0, 15).map(s => (
          <tr key={s.code}>
            <td><StockCell code={s.code} name={s.name} /></td><td><PriceCell code={s.code} showChange={false} /></td>
            <td>{s.industry ?? '—'}</td><td className={tone(s.ret)}>{sg(s.ret)}</td><td>{s.valM?.toLocaleString() ?? '—'}</td><td>{s.resonanceName}</td>
            <td>{[...(s.links?.chains?.map(c => c.name) ?? []), s.links?.group?.name].filter(Boolean).join('；') || '—'}</td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

export default function DailyHeatmap() {
  const [d, setD] = useState<Doc | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'empty' | 'error'>('loading');
  const [tab, setTab] = useState<Tab>('industry');
  const ind = useOpenSet();

  useEffect(() => {
    let live = true;
    fetch('/api/twse/daily-heatmap')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(j => { if (!live) return; if (j?.dataDate) { setD(j); setState('ok'); } else setState('empty'); })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, []);

  if (state === 'loading') return <div className={styles.msg}>載入每日熱力…</div>;
  if (state === 'error') return <div className={styles.msg}>每日熱力暫時讀取失敗，稍後再試（不影響其他功能）。</div>;
  if (state === 'empty' || !d) return <div className={styles.msg}>尚無已定版的每日熱力（收盤後官方資料到齊才會產出）。</div>;

  const ix = d.index;
  const hot = d.industries.filter(x => x.listable);
  const asOf = dayLabel(d.dataDate);
  return (
    <AsOfContext.Provider value={asOf}>
    <div className={styles.wrap}>
      <header className={styles.head}>
        <h2>📊 每日熱力分析 · {asOf}</h2>
        <p className={styles.note}>
          <b>{asOf}</b> 收盤事實的描述，<b>非投資建議</b>；熱度是該日統計量，不是動能或買賣訊號，不進任何推薦排序。
          報酬以官方參考價計、未扣成本。官方產業別為事實；站內整理／AI 待驗關聯只供標註。
        </p>
        <p className={styles.note}>報價名稱：<b>現價</b>＝目前價（盤中為即時價、收盤後即收盤價），<b>昨收</b>＝前一交易日收盤價；<b>{asOf}</b>＝該日收盤資料，其餘數字都標註日期。</p>
        {d.degraded && d.degraded.length > 0 && <p className={styles.warn}>⚠ {d.degraded.join('；')}</p>}
      </header>

      <div className={styles.cards}>
        <div className={styles.card}><span>等權</span><b className={tone(d.market.ew)}>{sg(d.market.ew)}%</b><i>市值權 {sg(d.market.capW)}%</i></div>
        <div className={styles.card}><span>漲／跌／平</span><b><em className={styles.up}>{d.market.up}</em>／<em className={styles.dn}>{d.market.dn}</em>／{d.market.flat}</b><i>兩市 {d.market.n} 檔</i></div>
        <div className={styles.card}><span>漲停／跌停</span><b><em className={styles.up}>{d.market.luN}</em>／<em className={styles.dn}>{d.market.ldN}</em></b><i>鎖死漲停 {d.market.lockU}</i></div>
        {ix && <div className={styles.card}><span>加權指數</span><b className={tone(ix.officialPts)}>{sg(ix.officialPts)} 點</b><i>貢獻重建殘差 {ix.residualBp}bp（{ix.grade}）</i></div>}
      </div>

      <div className={styles.tabs} role="tablist">
        {TABS.map(t => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? styles.tabOn : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>

      {tab === 'industry' && (
        <section className={styles.block}>
          <h3>官方產業別熱力 <span className={styles.tier}>官方</span><span className={styles.tier}>{asOf}</span></h3>
          <p className={styles.note}>heat＝0.5·Z(超額等權)＋0.5·Z(漲停占比)，僅 n≥8 排序。歷史統計約 40% 預測力來自今日漲停連板（買不到），僅供描述。</p>
          <BulkButtons keys={d.industries.map(x => x.key)} o={ind} />
          <table className={styles.tbl}>
            <thead><tr><th></th><th>產業</th><th>n</th><th>等權%</th><th>超額pp</th><th>中位%</th><th>z</th><th>上漲比</th><th>漲停</th><th>市值權%</th><th>形態</th><th>heat</th></tr></thead>
            <tbody>{d.industries.map(x => (
              <Fragment key={x.key}>
              <tr className={x.listable ? '' : styles.dim}>
                <td><Toggle open={ind.has(x.key)} onClick={() => ind.toggle(x.key)} /></td>
                <td>{x.key}{!x.listable && <span className={styles.tier}> n&lt;8</span>}</td><td>{x.n}</td>
                <td className={tone(x.ew)}>{sg(x.ew)}</td><td className={tone(x.exMkt)}>{sg(x.exMkt)}</td><td className={tone(x.med)}>{sg(x.med)}</td>
                <td>{x.z ?? '—'}</td><td>{x.upRatio ?? '—'}</td><td>{x.luN}</td><td className={tone(x.capW)}>{sg(x.capW)}</td>
                <td>{x.shape ?? '—'}{x.singleStockDriven ? '・單檔帶動' : ''}</td><td>{x.heat ?? '—'}</td>
              </tr>
              {ind.has(x.key) && <tr className={styles.detailRow}><td colSpan={12}><MemberList members={x.members} /></td></tr>}
              </Fragment>
            ))}</tbody>
          </table>
          <p className={styles.note}>熱度前 5：{hot.slice(0, 5).map(x => `${x.key} ${sg(x.ew)}%`).join('、')}；後 5：{hot.slice(-5).reverse().map(x => `${x.key} ${sg(x.ew)}%`).join('、')}</p>
        </section>
      )}

      {tab === 'index' && ix && (
        <>
          <section className={styles.block}>
            <h3>權值股對加權指數的漲跌貢獻（上市）<span className={styles.tier}>{asOf}</span></h3>
            <p className={styles.note}>
              官方沒有逐檔權重，權重由「收盤價×發行股數」自算；價格指數不調整現金股利，貢獻以前一日實際收盤為基期。
              指數 {sg(ix.officialPts)} 點，重建 {sg(ix.predPts)} 點，殘差 {sg(ix.residualPts)} 點（{ix.residualBp}bp，{ix.grade}＝{GRADE[ix.grade]}）。
              {ix.exDivFlag && <> ⚠ 除權息機械影響 {sg(ix.exDivMechanicalPts, 1)} 點，指數下跌不等於賣壓。</>}
              {ix.grade === '紅' && <> ⛔ 歸因不可靠，以下僅供對照、不作結論。</>}
            </p>
            <table className={styles.tbl}>
              <thead><tr><th>#</th><th>個股</th><th>現價／昨收</th><th>{asOf}<br />開盤前權重%</th><th>{asOf}<br />收盤後權重%</th><th>{asOf}<br />漲跌%</th><th>{asOf}<br />貢獻(點)</th><th>隔日 1% 敏感度(點)</th></tr></thead>
              <tbody>{ix.top.slice(0, 10).map((x, i) => (
                <tr key={x.code}><td>{i + 1}</td><td><StockCell code={x.code} name={x.name} /></td><td><PriceCell code={x.code} showChange={false} /></td>
                  <td>{x.wPrev}</td><td>{x.wClose}</td><td className={tone(x.ret)}>{sg(x.ret)}</td><td className={tone(x.pts)}>{sg(x.pts, 1)}</td><td>{x.sens1pctPts}</td></tr>
              ))}</tbody>
            </table>
            <table className={styles.tbl}>
              <thead><tr><th>前 N 大</th><th>權重%</th><th>貢獻(點)</th><th>其餘(點)</th><th>占指數漲跌</th></tr></thead>
              <tbody>{ix.splits.map(s => (
                <tr key={s.n}><td>{s.n}</td><td>{s.weight}</td><td className={tone(s.pts)}>{sg(s.pts, 1)}</td><td className={tone(s.restPts)}>{sg(s.restPts, 1)}</td>
                  <td>{s.shareOfChange == null ? '（|漲跌|<0.3% 不輸出）' : `${s.shareOfChange}%`}</td></tr>
              ))}</tbody>
            </table>
            <p className={styles.note}>
              拉抬最多：{ix.contributors.slice(0, 5).map(x => `${x.name} ${sg(x.pts, 1)}`).join('、')}　拖累最多：{ix.draggers.slice(0, 5).map(x => `${x.name} ${sg(x.pts, 1)}`).join('、')}
            </p>
            <p className={styles.note}>
              廣度：上漲 {d.breadth.up}／下跌 {d.breadth.dn}（adr {d.breadth.adr}）；指數 {sg(d.breadth.indexRetPct, 3)}% 對上市等權 {sg(d.breadth.tseEwPct, 3)}%，差 {sg(d.breadth.gapPp)}pp（&gt;0＝權值較強）；
              前 10 大貢獻集中度 {ix.conc10}%。法人（外資＋投信，估）：前 10 大 {ntd(ix.instTop10Ntd)}、其餘 {ntd(ix.instRestNtd)}。
            </p>
            <p className={styles.note}>隔日權重基準（算術，不是預測）：{ix.nextBasis.map(x => `${x.name} ${x.wClose}%`).join('、')}</p>
          </section>
        </>
      )}

      {tab === 'board' && (<>
        <BoardTable title="漲幅榜（成交 ≥1 億）" rows={d.board.gainers} />
        <BoardTable title="跌幅榜（成交 ≥1 億）" rows={d.board.losers} />
        <BoardTable title="成交金額榜" rows={d.board.byValue} />
      </>)}

      {tab === 'wiki' && (<>
        <p className={styles.note}>wiki 連動層逐項標等級；成員少者以 z 判讀，「僅觀察」不可解讀為其餘無關。</p>
        <LayerTable title="主題鏈" rows={d.layers.chains} note="站內整理" />
        <LayerTable title="鏈內段" rows={d.layers.segments} note="站內整理" />
        <LayerTable title="集團" rows={d.layers.groups} note="站內推導" />
        <LayerTable title="產品族" rows={d.layers.families} note="AI待驗・只標註" />
      </>)}

      {tab === 'watch' && (
        <section className={styles.block}>
          <h3>下一交易日觀察清單 <span className={styles.tier}>只描述，不計分</span></h3>
          {([
            ['continue', '延續候選（產業群）', '今天明顯強於大盤、且普遍上漲的產業；歷史上隔天這類產業平均仍略強於大盤。'],
            ['catchup', '落後補漲候選（先驗·未驗證）', '同一族群的同伴今天大漲，這檔卻沒跟上；是否補漲沒有可靠驗證，只列為觀察點。'],
            ['risk', '獨行大漲回吐風險', '今天單獨大漲、但同族群沒有一起漲的個股；歷史上隔天多半小幅回吐。'],
          ] as const).map(([k, name, what]) => (
            <div key={k}>
              <h4>{name}</h4>
              <p className={styles.note}>{what}</p>
              {d.watch[k].length === 0 ? <p className={styles.note}>（無符合觸發條件者）</p> : (
                <ul className={styles.list}>{d.watch[k].slice(0, 15).map(w => (
                  <li key={`${k}${w.key}`}>
                    {w.kind === 'stock'
                      ? <><StockCell code={w.key} name={w.name} /><span>　現價 </span><PriceCell code={w.key} />{w.ret != null && <span className={tone(w.ret)}>　{asOf} {sg(w.ret)}%</span>}</>
                      : <b>{w.key}</b>}
                    <br />
                    <span>{w.reason ?? w.trigger.rule}</span>
                    <br /><span className={styles.note}>證據等級：{w.evidence.level}｜{w.evidence.caveat}</span>
                  </li>
                ))}</ul>
              )}
            </div>
          ))}
        </section>
      )}

      <footer className={styles.note}>
        排除：無成交 {d.universe.noTrade}、無參考價 {d.universe.noRef}、|報酬|&gt;10.5% {d.universe.unlimited.length}。處置／注意股旗標：來源未提供。{d.useRules.disclaimer}
      </footer>
    </div>
    </AsOfContext.Provider>
  );
}
