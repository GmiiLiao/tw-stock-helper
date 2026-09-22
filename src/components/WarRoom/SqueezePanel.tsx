'use client';

// 軋空候選 —— 條件經 240 日 / 16.9 萬筆事件回測校準（見 daemon SQUEEZE_SKILL）。
// 這一頁的設計原則：**把邊際效益講清楚**。券資比的貢獻只有約 +1.5pp，
// 若做成「軋空預測神器」的口吻，使用者會照著重押，那是我們造成的傷害。
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import { Fragment, useEffect, useState } from 'react';
import { isMarketOpen } from '@/lib/market-clock';
import { useAppStore } from '@/lib/store';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import { storageGet, storageSet } from '@/lib/safe-storage';
import RiskBadge from '@/components/shared/RiskBadge';
import StockTrendChart from '@/components/WatchlistTracker/StockTrendChart';

interface Item {
  code: string; name: string; price: number; chg: number;
  mgn: number; shrt: number; ratio: number; volX: number; tier: number; live: boolean;
  macd?: { dif: number; hist: number; histPrev: number; above0: boolean; up: boolean; turn: boolean; ok: boolean; label: string } | null;   // 2026-09-22 揭露＋可選過濾
  ret5?: number | null;
  prevChg?: number | null;     // 昨日漲幅（前一交易日收盤對再前一日；2026-09-22 使用者）
  prev?: number;               // 前日收盤（daemon 09-17 起提供；舊文件缺時由 price/chg 反推，四捨五入到 0.01）
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
interface ReasonType { types: string[]; tone: 'green' | 'grey' | 'none' }
interface ChainLink { anchor?: string | null; anchorText?: string; n?: number; corr?: number | null; upRate?: number | null; upDays?: number; score: number | null; note?: string }
interface ReviewStat { n: number; mean: number | null; win: number | null }
interface Review { updatedAt: number; basis: string; days: number; bull: ReviewStat; neutral: ReviewStat; bear: ReviewStat; newsLift: number | null; byConf?: Record<string, ReviewStat>; byReasonType?: Record<string, ReviewStat>; byTone?: Record<string, ReviewStat>; conclusive?: boolean }
interface RecItem extends Item { reasonType?: ReasonType; chainLink?: ChainLink | null; newsScore?: number; verdict?: Verdict; primary?: boolean; events?: Array<{ date: string; title: string; type?: string; impact?: string }>; news?: { stale?: boolean; ageDays?: number | null; checked: number; material: number; priceOnly: number; basis: string; top: Array<{ title: string; link: string; at: number; from?: string; generic?: boolean }> } }
interface Rec {
  ranking?: string;
  updatedAt: number; targetDate: string | null; archDate: string | null; mode: string | null;
  modelMain: string | null; modelSqueeze: string | null; modelRunId: string | null;
  items: RecItem[]; primaryCount: number; newsSource?: string;
  intlRegime?: 'ok' | 'bear' | null; intlRegimeNote?: string;
  global?: Record<string, { chg?: number | null; date?: string }>;
}
interface LedgerEntry { code: string; name: string; firstAt: number; entryPrice: number; entryChg: number; entryTier: number; lastAt: number; lastPrice: number; lastChg: number; lastTier: number; dropped: boolean; dropAt: number | null; dropPrice: number | null; dropChg: number | null; dropReason: string | null; reentries: number }
interface Ledger { date: string; mode?: string; updatedAt: number; count: number; droppedCount: number; onBoard: number; entries: Record<string, LedgerEntry>; note?: string }
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
  // 可選過濾（2026-09-22 使用者）：預設關。兩條都只是「揭露＋你自己選」，沒有通過 v2 尺，不是模型的一部分。
  //   MACD：DIF>0 且柱>0 且柱上升；錯誤學習：排除 5 日漲幅≥15%、量比≥3x、漲 7～9%（250 日可買口徑：成功率 55.4%→60.7%，樣本外 53.1%→63.2%，n=155，同批資料挖出、前瞻未驗）
  const [fMacd, setFMacd] = useState<boolean>(() => storageGet('sqzFilterMacd') === '1');
  const [fLearn, setFLearn] = useState<boolean>(() => storageGet('sqzFilterLearn') === '1');
  const passLearn = (it: Item) => !((it.ret5 != null && it.ret5 >= 15) || (it.volX >= 3) || (it.chg >= 7 && it.chg < 9));
  const passMacd = (it: Item) => !!it.macd?.ok;
  const [ledger, setLedger] = useState<Ledger | null>(null);   // 🚪 當日入選／離榜帳（2026-09-22）
  const [review, setReview] = useState<Review | null>(null);   // 新聞判別對答案（今收→明開口徑）常駐頂部
  const [openCode, setOpenCode] = useState<string | null>(null);   // 點名稱就地展開/收合即時走勢（同漲停預測頁·使用者 2026-09-05）
  const marketOpenNow = isMarketOpen();   // 盤中：表格多「前日價」欄、現價改標「即時」（09-17）
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
      fetch('/api/ai/squeeze-ledger').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x && x.entries) setLedger(x); }).catch(() => {});
      fetch('/api/ai/news-verdict-review').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x && x.bull) setReview(x); }).catch(() => {});
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
              適用 <b>{rec.targetDate ?? '—'}</b> · 排序＝<b>籌碼分級</b> → 新聞加權（理由類型＋連動量化）· 新聞只當註解，信心等級不進規則 · 來源 {rec.newsSource ?? '—'} ·
              {rec.modelMain ? <> 模型 <code>{rec.modelMain}</code></> : ' 尚無模型'}
            </span>
          </div>
          {review && (() => {
            const f = (st?: ReviewStat) => (st && st.n ? `${st.mean != null && st.mean >= 0 ? '+' : ''}${st.mean}%／勝率 ${st.win}%／n=${st.n}` : '—');
            const rt = review.byReasonType || {}; const bc = review.byConf || {}; const bt = review.byTone || {};
            return (
              <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', marginBottom: 6, border: '1px solid var(--border-primary)', borderRadius: 8, padding: '6px 10px', lineHeight: 1.6 }}>
                <div><b style={{ color: 'var(--text-primary)' }}>📊 對答案（{review.days} 個交易日，今收→明開）</b>：利多 {f(review.bull)}｜中性 {f(review.neutral)}｜利空 {f(review.bear)}｜newsLift <b style={{ color: (review.newsLift ?? 0) > 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{review.newsLift ?? '—'}</b>{review.conclusive ? '' : '（樣本未達門檻）'}</div>
                <div>利多×信心：{['高', '中', '低'].map(c => `${c} ${f(bc['利多·' + c])}`).join('｜')}　中性×信心：{['高', '中', '低'].map(c => `${c} ${f(bc['中性·' + c])}`).join('｜')}</div>
                <div>利多理由類型：{['本業事實', '技術產品', '題材', '法人動作', '價格描述'].map(t => `${t} ${f(rt[t])}`).join('｜')}　色調：<span style={{ color: '#22c55e' }}>綠 {f(bt.green)}</span>｜灰 {f(bt.grey)}</div>
              </div>
            );
          })()}
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
                <div key={it.code} data-anchor={it.code} style={{
                  padding: '7px 11px', borderRadius: 8,
                  background: 'var(--bg-elevated)',
                  border: `1px solid ${it.reasonType?.tone === 'green' && v?.bullish ? 'rgba(34,197,94,0.35)' : 'var(--border-primary)'}`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <button onClick={() => setOpenCode(c => c === it.code ? null : it.code)} title="點擊展開／收合即時走勢"
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 700, textDecoration: 'underline dotted' }}>
                      {it.code} {it.name} {openCode === it.code ? '▴' : '▾'}
                    </button>
                    <button onClick={() => navigateTo('stock', it.code)} title="開啟個股分析" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#60a5fa', fontSize: 'calc(12px * var(--fz))' }}>↗</button>
                    {(() => { const st = statusOf(dt, it.code); return st == null ? null : <span style={{ marginLeft: 4 }}><DayTradeMark status={st} size="xs" /></span>; })()}
                    <AddCandidateButton code={it.code} variant="icon" />
                    <span style={{ color: 'var(--color-up)' }}>+{it.chg}%</span>
                    <span style={{ color: 'var(--text-muted)' }}>券資比 {it.ratio}%</span>
                    <span style={{ padding: '1px 8px', borderRadius: 999, background: `${c}22`, color: c, fontWeight: 700, fontSize: 'calc(12.5px * var(--fz))' }}>
                      {v?.label ?? '—'}
                    </span>
                    {v?.confidence && <span title="AI 自報信心，對答案顯示無分辨力（信心高反而比信心低差），已不進任何規則，僅供參考" style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>信心{v.confidence}（不進規則）</span>}
                    {it.reasonType?.types?.length ? it.reasonType.types.map(t => {
                      const green = t === '本業事實' || t === '技術產品';
                      return <span key={t} title={green ? '歷史：本業事實 +1.03%、技術產品 +2.95%（收盤均）' : '歷史為負：題材 −0.73%、法人動作 −0.56%、價格描述 −3.19%（收盤均）'} style={{ padding: '1px 7px', borderRadius: 6, fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700, background: green ? 'rgba(34,197,94,0.16)' : 'rgba(148,163,184,0.16)', color: green ? '#22c55e' : '#94a3b8' }}>{t}{green ? '' : '·歷史為負'}</span>;
                    }) : null}
                    {it.newsScore != null && <span title="新聞加權＝理由類型（綠 +1／灰 −0.5）＋連動量化（0～1）；只在同一籌碼分級內排序" style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)' }}>加權 {it.newsScore >= 0 ? '+' : ''}{it.newsScore}</span>}
                    <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                      依據{v?.basis === 'content' ? '內文' : v?.basis === 'title' ? '僅標題' : v?.basis === 'event' ? '排定事件' : '無資料'}
                      {v?.stale && <span style={{ color: '#f59e0b', marginLeft: 3 }}>⏳{v.ageDays}天前舊聞</span>}
                      {it.news ? `｜${it.news.stale ? '回溯' : '2日內'} ${it.news.checked} 則（實質 ${it.news.material}／純行情 ${it.news.priceOnly} 不計）` : ''}
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
                      {it.chainLink ? (
                        it.chainLink.score != null
                          ? <span style={{ marginLeft: 6, color: 'var(--text-muted)' }} title="60 日日報酬相關係數（截到 0～1 當加權分）與「來源漲≥1.5% 時本檔同漲率」，由收盤資料算，不是 AI 猜">｜來源 {it.chainLink.anchor}：60 日相關 <b style={{ color: (it.chainLink.corr ?? 0) >= 0.4 ? '#22c55e' : 'var(--text-muted)' }}>{it.chainLink.corr}</b>{it.chainLink.upRate != null ? `，來源漲≥1.5% 時同漲 ${it.chainLink.upRate}%（${it.chainLink.upDays} 日）` : ''} → 加權 +{it.chainLink.score}</span>
                          : <span style={{ marginLeft: 6, color: '#f59e0b' }}>｜{it.chainLink.note}{it.chainLink.anchorText ? `（AI 給的來源：${it.chainLink.anchorText}）` : ''}</span>
                      ) : null}
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', margin: '6px 0' }}>
          <span>可選過濾（預設關，未過 v2 尺，僅揭露）：</span>
          <label style={{ cursor: 'pointer' }}><input type="checkbox" checked={fMacd} onChange={e => { setFMacd(e.target.checked); storageSet('sqzFilterMacd', e.target.checked ? '1' : '0'); }} /> MACD 0 線上且柱上升（稽核：成功率 54.5% vs 全體 55.4%，無分辨力）</label>
          <label style={{ cursor: 'pointer' }}><input type="checkbox" checked={fLearn} onChange={e => { setFLearn(e.target.checked); storageSet('sqzFilterLearn', e.target.checked ? '1' : '0'); }} /> 錯誤學習：排除已漲多(5日≥15%)／爆量(量比≥3x)／漲7～9%（稽核：55.4%→60.7%，樣本外 63.2%，n=155，同批資料挖出、前瞻未驗）</label>
          <span>顯示 {d.items.filter(it => (!fMacd || passMacd(it)) && (!fLearn || passLearn(it))).length}/{d.items.length}</span>
        </div>
      )}
      {d && d.items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(12.5px * var(--fz))', minWidth: 620 }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                <th style={{ padding: '4px 4px', textAlign: 'left' }}>分級</th>
                <th style={{ padding: '4px 4px', textAlign: 'left' }}>代號/名稱</th>
                {/* 盤中（2026-09-17 使用者指定）：現價欄改名「即時」並多一欄「前日價」對照；盤後維持原樣。以 market-clock 判定，不看文件 mode。 */}
                <th style={{ padding: '4px 4px' }}>{marketOpenNow ? '即時' : '現價'}</th>
                {marketOpenNow && <th style={{ padding: '4px 4px' }} title="前一交易日收盤價（daemon 提供；舊文件缺時由即時價÷(1+漲幅) 反推）">前日價</th>}
                <th style={{ padding: '4px 4px' }}>漲幅</th>
                <th style={{ padding: '4px 4px' }} title="前一交易日的漲幅（收盤對再前一日收盤）：連兩天大漲＝已漲多的訊號之一">昨日漲幅</th>
                <th style={{ padding: '4px 4px' }}>券資比</th>
                <th style={{ padding: '4px 4px' }}>融券日增</th>
                <th style={{ padding: '4px 4px' }}>借券賣出(增減)</th>
                <th style={{ padding: '4px 4px' }}>外資</th>
                <th style={{ padding: '4px 4px' }}>投信</th>
                <th style={{ padding: '4px 4px' }}>法人5日</th>
                <th style={{ padding: '4px 4px' }}>融資/融券(張)</th>
                <th style={{ padding: '4px 4px' }}>量增</th>
                <th style={{ padding: '4px 4px' }} title="MACD(12,26,9) 以最近歸檔收盤計：0上/0下＝DIF 是否在 0 線上；翻紅＝柱由負轉正；紅升/紅降＝柱>0 且上升/下降；綠縮/綠增＝柱<0。稽核：可買口徑成功率 55.4%，DIF>0 且柱升 54.5%，DIF>0 且翻紅 64.6%（n=79）；v2 尺樣本外皆未通過">MACD</th>
              </tr>
            </thead>
            <tbody>
              {d.items.filter(it => (!fMacd || passMacd(it)) && (!fLearn || passLearn(it))).map(it => (
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
                    <AddCandidateButton code={it.code} variant="icon" />
                  </td>
                  <td style={{ padding: '4px 4px', fontFamily: "'JetBrains Mono',monospace" }}>{it.price}</td>
                  {marketOpenNow && <td style={{ padding: '4px 4px', fontFamily: "'JetBrains Mono',monospace", color: 'var(--text-muted)' }}>{(it.prev ?? +(it.price / (1 + it.chg / 100)).toFixed(2)).toFixed(2)}</td>}
                  <td style={{ padding: '4px 4px', color: 'var(--color-up)', fontWeight: 700 }}>+{it.chg}%</td>
                  <td style={{ padding: '4px 4px', color: numColor(it.prevChg) }}>{it.prevChg == null ? '—' : `${it.prevChg > 0 ? '+' : ''}${it.prevChg}%`}</td>
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
                  <td style={{ padding: '4px 4px', whiteSpace: 'nowrap', color: it.macd ? (it.macd.ok ? '#22c55e' : !it.macd.above0 ? 'var(--color-down)' : 'var(--text-muted)') : 'var(--text-muted)' }}>{it.macd?.label ?? '—'}</td>
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

      {(() => {
        if (!ledger) return null;
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
        if (ledger.date !== today) return null;   // 只顯示當日帳；隔天沒新帳前不拿昨天的充數
        const dropped = Object.values(ledger.entries).filter(e => e.dropped).sort((a, b) => (b.dropAt ?? 0) - (a.dropAt ?? 0));
        const hhmm = (t: number | null) => (t ? new Date(t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' }) : '—');
        const pct = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
        return (
          <div style={{ marginTop: 12, border: '1px solid rgba(245,158,11,0.35)', background: 'rgba(245,158,11,0.05)', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, marginBottom: 4 }}>🚪 當日離榜（入選 → 離榜對照）｜{ledger.date} 累計入選 {ledger.count} 檔，在榜 {ledger.onBoard}，離榜 {ledger.droppedCount}</div>
            {!dropped.length ? <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>今日尚無離榜股。</div> : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(12.5px * var(--fz))', minWidth: 620 }}>
                  <thead><tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                    <th style={{ padding: '4px 4px', textAlign: 'left' }}>代號/名稱</th><th style={{ padding: '4px 4px' }}>入選</th><th style={{ padding: '4px 4px' }}>入選價／漲幅</th><th style={{ padding: '4px 4px' }}>離榜</th><th style={{ padding: '4px 4px' }}>離榜價／漲幅</th><th style={{ padding: '4px 4px' }} title="離榜價相對入選價">入選→離榜</th><th style={{ padding: '4px 4px' }}>再入選</th><th style={{ padding: '4px 4px', textAlign: 'left' }}>原因</th>
                  </tr></thead>
                  <tbody>
                    {dropped.map(e => { const mv = e.dropPrice && e.entryPrice ? (e.dropPrice / e.entryPrice - 1) * 100 : null; return (
                      <tr key={e.code} style={{ borderTop: '1px solid var(--border-primary)', textAlign: 'right' }}>
                        <td style={{ padding: '4px 4px', textAlign: 'left', whiteSpace: 'nowrap' }}><span style={{ fontWeight: 700, cursor: 'pointer' }} onClick={() => navigateTo('stock', e.code)}>{e.code}</span> {e.name} {(() => { const st = statusOf(dt, e.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()} <RiskBadge code={e.code} size="xs" /></td>
                        <td style={{ padding: '4px 4px' }}>{hhmm(e.firstAt)} {e.entryTier === 4 ? '⭐⭐⭐⭐' : e.entryTier === 3 ? '⭐⭐⭐' : e.entryTier === 2 ? '⭐⭐' : e.entryTier === 1 ? '⭐' : '⚠'}</td>
                        <td style={{ padding: '4px 4px' }}>{e.entryPrice} <span style={{ color: numColor(e.entryChg) }}>{pct(e.entryChg)}</span></td>
                        <td style={{ padding: '4px 4px' }}>{hhmm(e.dropAt)}</td>
                        <td style={{ padding: '4px 4px' }}>{e.dropPrice ?? '—'} <span style={{ color: numColor(e.dropChg) }}>{pct(e.dropChg)}</span></td>
                        <td style={{ padding: '4px 4px', fontWeight: 700, color: numColor(mv) }}>{pct(mv)}</td>
                        <td style={{ padding: '4px 4px' }}>{e.reentries || 0}</td>
                        <td style={{ padding: '4px 4px', textAlign: 'left', color: 'var(--text-muted)' }}>{e.dropReason || '—'}</td>
                      </tr>); })}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 4 }}>{ledger.note}</div>
          </div>
        );
      })()}
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
