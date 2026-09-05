'use client';

// 軋空候選 —— 條件經 240 日 / 16.9 萬筆事件回測校準（見 daemon SQUEEZE_SKILL）。
// 這一頁的設計原則：**把邊際效益講清楚**。券資比的貢獻只有約 +1.5pp，
// 若做成「軋空預測神器」的口吻，使用者會照著重押，那是我們造成的傷害。
import { Fragment, useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';

interface Item {
  code: string; name: string; price: number; chg: number;
  mgn: number; shrt: number; ratio: number; volX: number; tier: number; live: boolean;
  setup: number | null; band: string; weakBand?: boolean; brk20?: boolean; hi20?: number | null;
  shrtChg?: number | null; lend?: number | null; lendChg?: number | null; trueRatio?: number | null;
  fgn?: number | null; trust?: number | null; instNet?: number | null;
  fgn5?: number | null; trust5?: number | null; inst5?: number | null; trustStreak?: number;
}
interface Pulse {
  updatedAt: number; marketNow: boolean;
  twii: { chg: number; value: number | null; prevValue: number | null; valueVsPrevFullDay: number | null };
  otc: { chg: number | null };
  counts: { limitUp: number; limitDown: number; up: number; down: number; counted: number; live: number };
  countsBasis?: string;
  level: { key: string; label: string; luExp: number; ldExp: number; note: string; luActualVsExp?: number | null };
  warns: Array<{ level: string; text: string }>;
  evidence?: { days: number; avgLimitUp: number; table: Array<{ label: string; min: number; luExp: number; ldExp: number }> };
  volNote?: string;
}
interface Verdict { label: string; bullish: boolean; confidence?: string; reason: string; risk?: string | null; chain?: string | null; basis: string; n?: number; nMaterial?: number; stale?: boolean; ageDays?: number | null }
interface RecItem extends Item { verdict?: Verdict; primary?: boolean; events?: Array<{ date: string; title: string; type?: string; impact?: string }>; news?: { checked: number; material: number; priceOnly: number; basis: string; top: Array<{ title: string; link: string; at: number }> } }
interface Rec {
  updatedAt: number; targetDate: string | null; archDate: string | null; mode: string | null;
  modelMain: string | null; modelSqueeze: string | null; modelRunId: string | null;
  items: RecItem[]; primaryCount: number; newsSource?: string;
  intlRegime?: 'ok' | 'bear' | null; intlRegimeNote?: string;
  global?: Record<string, { chg?: number | null; date?: string }>;
}
interface Data {
  updatedAt: number; priceDate: string; marginDate: string; rule: string;
  mode?: string; targetDate?: string | null; archDate?: string | null; instDate?: string | null;
  items: Item[]; count: number;
  recent?: { n: number; days: number; avgNextDay: number; winRate: number } | null;
  evidence?: { days: number; oosBase: number; oosBaseWin: number; t3: number; t3Win: number; t3n: number; t2: number; t2Win: number; t2n: number; t1: number; t1Win: number; t1n: number; t0: number; t0Win: number; t0n: number; shUp: number; shUpWin: number; shDown: number; shDownWin: number; sblTrue50: number; sblTrue100: number; sblUp: number };
}

// 台股顏色慣例：增加＝紅、減少＝綠（與國際相反，使用者 2026-08-26 指正）。
// 全站損益/漲跌已是此慣例，籌碼增減沒有理由用另一套。
const numColor = (v?: number | null) =>
  v == null || v === 0 ? 'var(--text-muted)' : v > 0 ? 'var(--color-up)' : 'var(--color-down)';
const fmtSigned = (v?: number | null) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString()}`;

export default function SqueezePanel() {
  const dt = useDayTradeCodes();   // 當沖資格：必須在任何 early return 之前
  const [d, setD] = useState<Data | null>(null);
  const [openCode, setOpenCode] = useState<string | null>(null);   // 點名稱就地展開/收合即時走勢（同漲停預測頁·使用者 2026-09-05）
  const [rec, setRec] = useState<Rec | null>(null);
  const [pulse, setPulse] = useState<Pulse | null>(null);
  const [loading, setLoading] = useState(true);
  const navigateTo = useAppStore(s => s.navigateTo);

  useEffect(() => {
    let live = true;
    const load = () => {
      fetch('/api/ai/squeeze-picks').then(r => (r.ok ? r.json() : null))
        .then(x => { if (live && x && !x.error) setD(x); }).catch(() => {})
        .finally(() => { if (live) setLoading(false); });
      fetch('/api/ai/squeeze-recommend').then(r => (r.ok ? r.json() : null))
        .then(x => { if (live && x && !x.error && x.items) setRec(x); }).catch(() => {});
      fetch('/api/twse/market-pulse').then(r => (r.ok ? r.json() : null))
        .then(x => { if (live && x && !x.error && x.level) setPulse(x); }).catch(() => {});
    };
    load();
    const id = setInterval(load, 180_000);
    // 大盤脈動 30 秒一次（daemon 也是 30 秒節流，對齊即可）
    const idPulse = setInterval(() => {
      fetch('/api/twse/market-pulse').then(r => (r.ok ? r.json() : null))
        .then(x => { if (live && x && !x.error && x.level) setPulse(x); }).catch(() => {});
    }, 30_000);
    return () => { live = false; clearInterval(id); clearInterval(idPulse); };
  }, []);

  const ev = d?.evidence;
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <h2 style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 800, margin: 0 }}>🩳 軋空候選</h2>
        {d && (
          <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
            {d.count} 檔 · 分析資料日 {d.archDate ?? d.priceDate}
            {d.mode === 'nextday'
              ? <> · <b style={{ color: '#22c55e' }}>適用交易日 {d.targetDate}</b>（TWSE 盤後全資料到齊）{d.instDate ? <> · 法人資料日 {d.instDate}（T86 收盤後才出，非即時）</> : null}</>
              : <> · <b style={{ color: '#f59e0b' }}>盤中即時版（券資比為 {d.marginDate}，t-1）</b>——今晚 21:45 資券公布後才會更新為次交易日清單</>}
          </span>
        )}
      </div>

      {/* 大盤脈動：環境決定要不要出手，所以放最上面 */}
      {pulse && (() => {
        const p = pulse;
        const c = p.level.key === 'bad' ? '#ef4444' : p.level.key === 'weak' ? '#f59e0b'
          : p.level.key === 'strong' ? '#22c55e' : p.level.key === 'good' ? '#4ade80' : 'var(--text-muted)';
        const danger = p.warns.some(w => w.level === 'danger');
        return (
          <div style={{
            padding: '8px 12px', borderRadius: 8, marginBottom: 8,
            background: danger ? 'rgba(239,68,68,0.09)' : 'var(--bg-elevated)',
            border: `1px solid ${danger ? 'rgba(239,68,68,0.5)' : 'var(--border-primary)'}`,
            fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.6,
          }}>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <b>📊 大盤脈動</b>
              <span>加權 <b style={{ color: p.twii.chg >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                {p.twii.chg >= 0 ? '+' : ''}{p.twii.chg}%</b></span>
              {p.otc.chg != null && <span style={{ color: 'var(--text-muted)' }}>櫃買 {p.otc.chg >= 0 ? '+' : ''}{p.otc.chg}%</span>}
              {p.twii.value != null && <span style={{ color: 'var(--text-muted)' }}>
                成交值 {p.twii.value.toLocaleString()} 億
                {p.twii.valueVsPrevFullDay != null && <>（昨日全日 {p.twii.valueVsPrevFullDay}x）</>}
              </span>}
              <span>漲停 <b style={{ color: 'var(--color-up)' }}>{p.counts.limitUp}</b>
                ／跌停 <b style={{ color: 'var(--color-down)' }}>{p.counts.limitDown}</b>
                <span style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))', marginLeft: 3 }}>
                  {p.countsBasis === 'live' ? '即時' : '已收盤'}
                </span>
              </span>
              <span style={{ padding: '1px 9px', borderRadius: 999, background: `${c}22`, color: c, fontWeight: 700 }}>
                軋空環境：{p.level.label}
              </span>
            </div>
            <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
              此漲跌區間實測漲停期望 <b>{p.level.luExp}</b> 檔／跌停 {p.level.ldExp}（長期均 {p.evidence?.avgLimitUp ?? 45} 檔）·
              {p.level.note}
              {p.level.luActualVsExp != null && <>　實際/期望 <b style={{ color: p.level.luActualVsExp >= 1 ? 'var(--color-up)' : '#f59e0b' }}>{p.level.luActualVsExp}x</b></>}
            </div>
            {p.warns.map((w, i) => (
              <div key={i} style={{ marginTop: 2, fontWeight: 600, color: w.level === 'danger' ? '#ef4444' : w.level === 'good' ? '#22c55e' : '#f59e0b' }}>
                {w.level === 'danger' ? '🚨' : w.level === 'good' ? '🚀' : '⚠️'} {w.text}
              </div>
            ))}
            {p.volNote && <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))', marginTop: 2 }}>{p.volNote}</div>}
          </div>
        );
      })()}

      {/* 近期實際戰績——擺在回測數字之前。使用者是隔日沖，會照著明天下單，
          只掛長期期望值而不講當下正在回檔，是不誠實的。 */}
      {d?.recent && (
        <div style={{
          padding: '8px 12px', borderRadius: 8, marginBottom: 8,
          background: d.recent.avgNextDay >= 0 ? 'rgba(34,197,94,0.07)' : 'rgba(239,68,68,0.07)',
          border: `1px solid ${d.recent.avgNextDay >= 0 ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.4)'}`,
          fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.65,
        }}>
          <div style={{ fontWeight: 700, marginBottom: 2, color: d.recent.avgNextDay >= 0 ? '#22c55e' : '#ef4444' }}>
            近 30 個交易日實際戰績（同一條規則回放）
          </div>
          <div>
            共選出 <b>{d.recent.n}</b> 檔次（{d.recent.days} 個有訊號日）·
            隔日平均 <b style={{ color: d.recent.avgNextDay >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
              {d.recent.avgNextDay >= 0 ? '+' : ''}{d.recent.avgNextDay}%
            </b> · 勝率 <b>{d.recent.winRate}%</b>
          </div>
          {d.recent.avgNextDay < 0 && (
            <div style={{ color: '#ef4444', fontWeight: 600 }}>
              ⚠ 訊號目前處於回檔期：近期隔日報酬為負，與長期期望值（+1.62%／勝率55%）背離。單日離散度很大（實測區間 −8.4% ~ +7.6%），請勿因為看到榜單就加大部位。
            </div>
          )}
        </div>
      )}

      {/* 實證揭露：邊際效益多小，講在最前面 */}
      {ev && (
        <div style={{ padding: '8px 12px', borderRadius: 8, marginBottom: 10, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.3)', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.65 }}>
          <div style={{ fontWeight: 700, color: '#f59e0b', marginBottom: 3 }}>
            實測校準（{ev.days} 日 · <b>隔日開盤·可買口徑</b>·樣本外）
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto auto', gap: '1px 10px', marginBottom: 3 }}>
            <span style={{ color: 'var(--text-muted)' }}>基準（漲≥5%）</span><span>+{ev.oosBase}%</span><span style={{ color: 'var(--text-muted)' }}>勝率 {ev.oosBaseWin}%</span><span />
            <span style={{ fontWeight: 700, color: '#22c55e' }}>⭐⭐⭐ 券資比 ≥20%</span><span style={{ fontWeight: 700, color: 'var(--color-up)' }}>+{ev.t3}%</span><span style={{ fontWeight: 700 }}>{ev.t3Win}%</span><span style={{ color: 'var(--text-muted)' }}>n={ev.t3n}</span>
            <span>⭐⭐ 券資比 10~15%</span><span>+{ev.t2}%</span><span>{ev.t2Win}%</span><span style={{ color: 'var(--text-muted)' }}>n={ev.t2n}</span>
            <span>⭐ 券資比 5~10%</span><span>+{ev.t1}%</span><span>{ev.t1Win}%</span><span style={{ color: 'var(--text-muted)' }}>n={ev.t1n}</span>
            <span style={{ color: '#f59e0b' }}>⚠ 券資比 15~20%</span><span style={{ color: '#f59e0b' }}>+{ev.t0}%</span><span style={{ color: '#f59e0b' }}>{ev.t0Win}%</span><span style={{ color: 'var(--text-muted)' }}>n={ev.t0n}·未過基準</span>
          </div>
          <div style={{ color: 'var(--text-muted)' }}>
            全部條件皆已疊「融券日增&gt;0」——實測融券日增&gt;0 為 +{ev.shUp}%/{ev.shUpWin}%，
            日增&lt;0 只有 +{ev.shDown}%/{ev.shDownWin}%（空單已在回補＝燃料燒完）。
          </div>
          <div style={{ color: 'var(--text-muted)' }}>
            <b>借券賣出刻意不併入券資比</b>：它常是融券的 3~19 倍，直覺以為「加進來才是真空單」，
            但實測併入後反而變差（真空單比 50~100% 僅 +{ev.sblTrue50}%、100%+ 僅 +{ev.sblTrue100}%、借券增加 +{ev.sblUp}%，皆輸基準）。
            原因：借券賣出多為法人避險/套利部位，不是方向性看空，不會被軋而恐慌回補。表格仍列出借券供你參考。
          </div>
        </div>
      )}

      {loading && !d && <div style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>載入中…</div>}
      {d && d.items.length === 0 && (
        <div style={{ padding: '18px 4px', color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>
          今日無符合條件的個股。條件嚴格是刻意的——放寬到「券資比越高越好」實測反而更差。
        </div>
      )}

      {/* AI 新聞判別（開盤前 1 小時產出）——每一檔都有判別提示，含中性與資訊不足 */}
      {rec && rec.items.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 5 }}>
            <b style={{ fontSize: 'calc(13px * var(--fz))' }}>🤖 開盤前新聞判別</b>
            <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
              {/* 市況揭露（2026-08-31 實驗結論）：偏空日本策略樣本外勝率僅 49.6%。
                  刻意做成**揭露**而非濾網——試過的濾網全部沒通過安慰劑檢定，
                  但這個勝率是 41 天／397 筆的大樣本觀察，使用者有權知道。 */}
              {rec.intlRegime === 'bear' && (
                <div style={{
                  margin: '6px 0', padding: '6px 10px', borderRadius: 6,
                  background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.35)',
                  color: '#fbbf24', fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.5,
                }}>
                  ⚠ <b>今日國際盤偏空</b>——本策略在此市況的樣本外勝率僅 <b>49.6%</b>
                  （41 個交易日、397 筆），與擲硬幣相當。建議減碼或觀望。
                </div>
              )}
              適用 <b>{rec.targetDate ?? '—'}</b> · 主力推薦 {rec.primaryCount} 檔 · 來源 {rec.newsSource ?? '—'} ·
              {rec.modelMain ? <> 模型 <code>{rec.modelMain}</code></> : ' 尚無模型'}
            </span>
          </div>
          {rec.global && Object.keys(rec.global).length > 0 && (
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 6 }}>
              昨夜國際盤：{['sox', 'nasdaq', 'sp500', 'n225', 'kospi', 'vix']
                .filter(k => rec.global?.[k]).map(k => {
                  const v = rec.global![k].chg;
                  return <span key={k} style={{ marginRight: 8, color: (v ?? 0) >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                    {k} {(v ?? 0) >= 0 ? '+' : ''}{v}%
                  </span>;
                })}
            </div>
          )}
          <div style={{ display: 'grid', gap: 6 }}>
            {rec.items.map(it => {
              const v = it.verdict;
              const c = v?.label === '利多' ? '#22c55e' : v?.label === '利空' ? '#ef4444' : v?.label === '中性' ? '#94a3b8' : '#64748b';
              return (
                <div key={it.code} style={{
                  padding: '7px 11px', borderRadius: 8,
                  background: it.primary ? 'rgba(34,197,94,0.08)' : 'var(--bg-elevated)',
                  border: `1px solid ${it.primary ? 'rgba(34,197,94,0.45)' : 'var(--border-primary)'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    {it.primary && <span style={{ fontWeight: 800, color: '#22c55e' }}>★ 主力推薦</span>}
                    <button onClick={() => setOpenCode(c => c === it.code ? null : it.code)} title="點擊展開／收合即時走勢"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 700, textDecoration: 'underline dotted' }}>
                      {it.code} {it.name} {openCode === it.code ? '▴' : '▾'}
                    </button>
                    <button onClick={() => navigateTo('stock', it.code)} title="開啟個股分析" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#60a5fa', fontSize: 'calc(12px * var(--fz))' }}>↗</button>
                    {(() => { const st = statusOf(dt, it.code); return st == null ? null : <span style={{ marginLeft: 4 }}><DayTradeMark status={st} size="xs" /></span>; })()}
                    <span style={{ color: 'var(--color-up)' }}>+{it.chg}%</span>
                    <span style={{ color: 'var(--text-muted)' }}>券資比 {it.ratio}%</span>
                    <span style={{ padding: '1px 8px', borderRadius: 999, background: `${c}22`, color: c, fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))' }}>
                      {v?.label ?? '—'}{v?.confidence ? `·信心${v.confidence}` : ''}
                    </span>
                    <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                      依據{v?.basis === 'content' ? '內文' : v?.basis === 'title' ? '僅標題' : v?.basis === 'event' ? '排定事件' : '無資料'}
                      {v?.stale && <span style={{ color: '#f59e0b', marginLeft: 3 }}>⏳{v.ageDays}天前舊聞</span>}
                      {it.news ? `｜2日內 ${it.news.checked} 則（實質 ${it.news.material}／純行情 ${it.news.priceOnly} 不計）` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)', marginTop: 2 }}>
                    {v?.reason}
                  </div>
                  {(it.events?.length ?? 0) > 0 && (
                    <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#38bdf8', marginTop: 1 }}>
                      📅 已排定事件：{it.events!.map(e => `${e.date.slice(5)} ${e.title}`).join('；')}
                    </div>
                  )}
                  {v?.chain && (
                    <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#a78bfa', marginTop: 1 }}>
                      🔗 連動：{v.chain}
                    </div>
                  )}
                  {v?.risk && v.risk !== '無' && (
                    <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#f59e0b', marginTop: 1 }}>
                      ⚠ 風險：{v.risk}
                    </div>
                  )}
                  {it.news?.top?.slice(0, 2).map((n, i) => (
                    <div key={i} style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 1 }}>
                      · {n.link ? <a href={n.link} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>{n.title}</a> : n.title}
                    </div>
                  ))}
                  {openCode === it.code && <div style={{ marginTop: 8 }}><StockTrendChart code={it.code} name={it.name} closePrice={0} changePercent={it.chg} /></div>}
                </div>
              );
            })}
          </div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 5 }}>
            判別依據＝新聞（鉅亨有內文＋Google News 標題）<b>＋交易所事件行事曆</b>（法說會/除權息/股東會）。
            事件是已排定的事實而非傳聞，但<b>法說內容未知時不預設為利多</b>——AI 會判中性並註明。
            近 2 日查無新聞時<b>自動回退到最近 14 日內的最新報導</b>並標示「⏳N天前舊聞」；
            舊消息多半已被股價反映，信心上限為「低」且<b>不會升為主力推薦</b>。
            程式端<b>只剔除機器自動生成的盤中速報</b>——含「漲停」字眼的題材文若硬剔會連真催化劑一起丟掉
            （實案：今周刊〈台虹…原來和輝達也有關！看懂 PTFE 題材〉標題同時有兩者）。
            價格描述不算利多這條規則交由 AI 執行；抓不到內文會標「僅標題」，不假裝讀過；不確定一律判中性。
          </div>
        </div>
      )}

      {d && d.items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(12.5px * var(--fz))', minWidth: 620 }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                <th style={{ padding: '4px 4px', textAlign: 'left' }}>分級</th>
                <th style={{ padding: '4px 4px', textAlign: 'left' }}>代號/名稱</th>
                <th style={{ padding: '4px 4px' }}>現價</th>
                <th style={{ padding: '4px 4px' }}>漲幅</th>
                <th style={{ padding: '4px 4px' }}>券資比</th>
                <th style={{ padding: '4px 4px' }}>融券日增</th>
                <th style={{ padding: '4px 4px' }}>借券賣出(增減)</th>
                <th style={{ padding: '4px 4px' }}>外資</th>
                <th style={{ padding: '4px 4px' }}>投信</th>
                <th style={{ padding: '4px 4px' }}>法人5日</th>
                <th style={{ padding: '4px 4px' }}>融資/融券(張)</th>
                <th style={{ padding: '4px 4px' }}>量增</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map(it => (
                <Fragment key={it.code}>
                <tr style={{ borderTop: '1px solid var(--border-primary)', textAlign: 'right' }}>
                  <td style={{ padding: '4px 4px', textAlign: 'left', whiteSpace: 'nowrap' }}>
                    {it.tier === 4 ? '⭐⭐⭐⭐' : it.tier === 3 ? '⭐⭐⭐' : it.tier === 2 ? '⭐⭐' : it.tier === 1 ? '⭐' : '⚠'}
                    <span style={{ marginLeft: 4, fontSize: 'calc(12.5px * var(--fz))', color: it.tier === 4 ? '#22c55e' : it.weakBand ? '#f59e0b' : 'var(--text-muted)' }}>
                      {it.tier === 4 ? '精選·破高' : it.band}
                    </span>
                  </td>
                  <td style={{ padding: '4px 4px', textAlign: 'left' }}>
                    <button onClick={() => setOpenCode(c => c === it.code ? null : it.code)} title="點擊展開／收合即時走勢"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 700, textDecoration: 'underline dotted' }}>
                      {it.code} {it.name} {openCode === it.code ? '▴' : '▾'}
                    </button>
                    <button onClick={() => navigateTo('stock', it.code)} title="開啟個股分析" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#60a5fa', fontSize: 'calc(12px * var(--fz))' }}>↗</button>
                    {(() => { const st = statusOf(dt, it.code); return st == null ? null : <span style={{ marginLeft: 4 }}><DayTradeMark status={st} size="xs" /></span>; })()}
                  </td>
                  <td style={{ padding: '4px 4px', fontFamily: "'JetBrains Mono',monospace" }}>{it.price}</td>
                  <td style={{ padding: '4px 4px', color: 'var(--color-up)', fontWeight: 700 }}>+{it.chg}%</td>
                  <td style={{ padding: '4px 4px', fontWeight: 700, color: it.tier === 3 ? '#22c55e' : it.weakBand ? '#f59e0b' : 'var(--text-primary)' }}>
                    {it.ratio}%
                  </td>
                  <td style={{ padding: '4px 4px', color: numColor(it.shrtChg), fontWeight: 600 }}>
                    {fmtSigned(it.shrtChg)}
                  </td>
                  <td style={{ padding: '4px 4px', color: 'var(--text-muted)' }}>
                    {it.lend != null ? it.lend.toLocaleString() : '—'}
                    {it.lendChg != null && <span style={{ color: numColor(it.lendChg), marginLeft: 3, fontSize: 'calc(12.5px * var(--fz))' }}>
                      ({fmtSigned(it.lendChg)})
                    </span>}
                  </td>
                  <td style={{ padding: '4px 4px', color: numColor(it.fgn) }}>{fmtSigned(it.fgn)}</td>
                  <td style={{ padding: '4px 4px', color: numColor(it.trust) }}>
                    {fmtSigned(it.trust)}
                    {(it.trustStreak ?? 0) >= 3 && <span style={{ marginLeft: 3, fontSize: 'calc(12.5px * var(--fz))', color: '#f59e0b' }}>連{it.trustStreak}</span>}
                  </td>
                  <td style={{ padding: '4px 4px', color: numColor(it.inst5), fontWeight: 600 }}>{fmtSigned(it.inst5)}</td>
                  <td style={{ padding: '4px 4px', color: 'var(--text-muted)' }}>{it.mgn.toLocaleString()} / {it.shrt.toLocaleString()}</td>
                  <td style={{ padding: '4px 4px' }}>{it.volX}x</td>
                </tr>
                {openCode === it.code && (
                  <tr><td colSpan={12} style={{ padding: '6px 4px 10px' }}>
                    <StockTrendChart code={it.code} name={it.name} closePrice={it.price} changePercent={it.chg} />
                  </td></tr>
                )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        規則：{d?.rule || '漲≥5% × 券資比10~20% × 20日均量≥500張 × 價>10'}。
        「軋空啟動(A)」沿用站上撿尾盤既有的同名訊號（昨日融券增≥昨量0.5%，2 年稽核），不另立第二套定義。
        券資比＝融券餘額÷融資餘額，取<b>最近已公布</b>的交易日（t-1）；漲幅為當日。
        台股不適用美股常用的 days-to-cover（融券量相對成交量過小，回測樣本近乎 0）。
        <b>非投資建議。</b>
      </div>
    </div>
  );
}
