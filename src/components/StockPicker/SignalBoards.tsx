'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { MODES } from '@/lib/trading-mode';

// ── 📋 訊號榜單：所有選股清單的唯一入口（2026-08-03 頁面整理）────────
//
// 為什麼要有這個檔案：整理前，選股清單散在四個地方——市場總覽 6 張、
//   指數新聞 2 張、選股頁、盤中戰情、即時追蹤。使用者要選股得先想「這張在哪一頁」，
//   而且市場總覽那 6 張是「有資料才顯示」＋grid auto-fit，缺一張後面整排位移，
//   永遠記不住位置。全部收攏到這裡，並依操作模式過濾。
//
// ⚠**模式歸屬是照口徑判定的，不是照直覺分的**：
//   · 隔日沖：⚡隔日沖候選／🩳軋空候選（軋空 +2 本來就是隔日沖權重項）／🔍技術選股掃描
//   · 波段  ：🌊起漲榜／🚀追強榜（兩者都有 5 日持有的口徑聲明）
//   · 當沖  ：⚡當沖候選——但本模式**無評分模型**，只當觀察清單
//   · **不分模式**：💪RS選股／📈月營收成長／🏦高股息存股
//     這三張**不屬於任何交易模式**（通用觀察與基本面/長期），硬塞進某個模式
//     等於宣稱它有那個持有期的實證——本站沒有測過，所以獨立成一區並明說。

const up = 'var(--color-up)', down = 'var(--color-down)';
const col = (v: number) => (v >= 0 ? up : down);
const sign = (v: number) => (v >= 0 ? '+' : '');
const card: React.CSSProperties = {
  background: 'var(--bg-card, rgba(148,163,184,0.04))', border: '1px solid var(--border-primary, rgba(148,163,184,0.18))',
  borderRadius: 10, padding: '14px 16px',
};
const title: React.CSSProperties = { fontWeight: 700, fontSize: '0.95rem', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const sub: React.CSSProperties = { fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 14 };

interface DivStock { code: string; name: string; yield: number; pe: number; pb: number }
interface RsItem { code: string; name: string; rs: number; ret60: number }
interface TradeItem { code: string; name: string; close: number; changePct: number; amplitude: number; closePos: number }
interface ScanItem { code: string; name: string; close: number; changePct: number; volX?: number }
interface RevItem { code: string; name: string; yoy: number; mom: number }
interface MarginItem { code: string; name: string; shortRatio: number; marginChg: number }
interface SwingItem { code: string; name: string; price: number; chg: number | null; rsi5: number; rsi10: number; volX: number | null; instT1: number; vol: number; posture60: number | null; deepPull: boolean; bigVol: boolean; vol20: number | null; breakRisk: 'low' | 'mid' | 'high' | null; tier: number }
interface StrengthItem { code: string; name: string; price: number; chg: number; rsi5: number; rsi10: number; inst5: number; inst5Ratio: number; vol: number; vol20: number | null; lowVol: boolean; kdDead: boolean }

/** 一律走 daemon 寫好的 latest doc，前端不直接打上游（唯一不變式） */
const get = <T,>(url: string, set: (d: T) => void, alive: () => boolean) =>
  fetch(url).then(r => (r.ok ? r.json() : null)).then(d => { if (alive() && d) set(d as T); }).catch(() => {});

/** 缺資料時保留區塊、說明原因——不要整張消失，否則後面卡片位置會跳 */
function Empty({ what }: { what: string }) {
  return <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', padding: '6px 0' }}>今日無{what}——空榜是常態，不是故障。</div>;
}

export default function SignalBoards() {
  const mode = useAppStore(s => s.tradingMode);
  const navigateTo = useAppStore(s => s.navigateTo);
  const M = MODES[mode];

  const [rs, setRs] = useState<RsItem[]>([]);
  const [trade, setTrade] = useState<{ dayTrade: TradeItem[]; overnight: TradeItem[] } | null>(null);
  const [scanner, setScanner] = useState<{ newHigh52: ScanItem[]; volBreakout: ScanItem[]; maBull: ScanItem[]; strong: ScanItem[] } | null>(null);
  const [margin, setMargin] = useState<{ squeeze: MarginItem[] } | null>(null);
  const [rev, setRev] = useState<{ month: string; topYoY: RevItem[] } | null>(null);
  const [divStocks, setDivStocks] = useState<DivStock[]>([]);
  const [swing, setSwing] = useState<{ items?: SwingItem[]; gate?: string; caveats?: string[]; evidence?: Record<string, string>; total?: number } | null>(null);
  const [strength, setStrength] = useState<{ items?: StrengthItem[]; caveats?: (string | null)[]; evidence?: Record<string, string>; total?: number } | null>(null);

  useEffect(() => {
    let live = true; const alive = () => live;
    get<{ top: RsItem[] }>('/api/ai/rs-ranking', d => setRs(d.top || []), alive);
    get<{ dayTrade: TradeItem[]; overnight: TradeItem[] }>('/api/ai/trade-signals', d => setTrade({ dayTrade: d.dayTrade || [], overnight: d.overnight || [] }), alive);
    get<typeof scanner>('/api/ai/scanner', d => setScanner(d), alive);
    get<{ squeeze: MarginItem[] }>('/api/ai/margin-short', d => setMargin({ squeeze: d.squeeze || [] }), alive);
    get<{ month: string; topYoY: RevItem[] }>('/api/ai/revenue', d => setRev({ month: d.month, topYoY: d.topYoY || [] }), alive);
    get<{ top: DivStock[] }>('/api/ai/dividend-stocks', d => setDivStocks(d.top || []), alive);
    get<typeof swing>('/api/ai/swing-picks', d => setSwing(d), alive);
    get<typeof strength>('/api/ai/strength-picks', d => setStrength(d), alive);
    return () => { live = false; };
  }, []);

  const Row = ({ code, name, right }: { code: string; name: string; right: React.ReactNode }) => (
    <div onClick={() => navigateTo('stock', code)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.8rem', padding: '4px 0', cursor: 'pointer' }}>
      <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <b style={{ color: 'var(--text-primary)' }}>{code}</b> {name}
      </span>
      <span style={{ whiteSpace: 'nowrap', marginLeft: 6 }}>{right}</span>
    </div>
  );

  // ── 各模式的榜單 ────────────────────────────────────────────────
  const nextdayBoards = (
    <div style={grid}>
      <div style={card}>
        <div style={title}>⚡ 隔日沖候選 <span style={sub}>今收買→明開賣</span></div>
        {trade?.overnight?.length
          ? trade.overnight.slice(0, 8).map(x => (
            <Row key={x.code} code={x.code} name={x.name}
              right={<span style={{ color: col(x.changePct), fontFamily: "'JetBrains Mono',monospace" }}>{sign(x.changePct)}{x.changePct}%</span>} />
          ))
          : <Empty what="隔日沖候選" />}
      </div>
      <div style={card}>
        <div style={title}>🩳 軋空候選 <span style={sub}>高券資比·⚡軋空 +2 為隔日沖權重項</span></div>
        {margin?.squeeze?.length
          ? margin.squeeze.slice(0, 8).map(x => (
            <Row key={x.code} code={x.code} name={x.name}
              right={<b style={{ color: up }}>券資比 {x.shortRatio}%</b>} />
          ))
          : <Empty what="軋空候選" />}
      </div>
      <div style={card}>
        <div style={title}>🔍 技術選股掃描 <span style={sub}>創新高·爆量·均線多頭</span></div>
        {scanner
          ? ([['🔺 創新高', scanner.newHigh52], ['💥 爆量突破', scanner.volBreakout], ['📶 均線多頭', scanner.maBull], ['🚀 飆股', scanner.strong]] as Array<[string, ScanItem[]]>)
            .filter(([, arr]) => arr?.length)
            .map(([label, arr]) => (
              <div key={label} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginBottom: 2 }}>{label}</div>
                {arr.slice(0, 4).map(x => (
                  <Row key={x.code} code={x.code} name={x.name}
                    right={<span style={{ color: col(x.changePct), fontFamily: "'JetBrains Mono',monospace" }}>{sign(x.changePct)}{x.changePct}%</span>} />
                ))}
              </div>
            ))
          : <Empty what="技術掃描結果" />}
      </div>
    </div>
  );

  const swingBoards = (
    <div style={grid}>
      <div style={card}>
        <div style={title}>🌊 波段起漲 <span style={sub}>持有 5 個交易日·空頭日限定</span></div>
        {swing?.gate && <div style={{ fontSize: '0.74rem', color: swing.gate.startsWith('✅') ? up : '#fbbf24', marginBottom: 6, lineHeight: 1.6 }}>{swing.gate}</div>}
        {swing?.items?.length
          ? swing.items.slice(0, 10).map(x => (
            <Row key={x.code} code={x.code} name={x.name}
              right={<span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                <span style={{ color: '#fbbf24', fontSize: '0.72rem' }}>{'⭐'.repeat(x.tier)}</span>
                {x.vol20 != null && <span style={{ fontSize: '0.7rem', color: x.vol20 >= 3 ? '#fb923c' : 'var(--text-muted)' }}>波動{x.vol20}%</span>}
                {x.breakRisk && <span style={{ fontSize: '0.7rem', color: x.breakRisk === 'low' ? up : x.breakRisk === 'high' ? down : 'var(--text-muted)' }}>破底{x.breakRisk === 'low' ? '低' : x.breakRisk === 'high' ? '高' : '中'}</span>}
                <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{x.price}</span>
              </span>} />
          ))
          : <Empty what="起漲訊號" />}
        {swing?.evidence?.t1 && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6 }}>📐 {swing.evidence.t1}</div>}
        {swing?.caveats?.map((c, i) => <div key={i} style={{ fontSize: '0.68rem', color: '#fbbf24', marginTop: 4, lineHeight: 1.6 }}>{c}</div>)}
      </div>
      <div style={card}>
        <div style={title}>🚀 波段追強 <span style={sub}>強勢整理·持有 5 個交易日</span></div>
        {strength?.items?.length
          ? strength.items.slice(0, 10).map(x => (
            <Row key={x.code} code={x.code} name={x.name}
              right={<span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                {x.lowVol && <span style={{ fontSize: '0.7rem', color: '#2f9e44' }}>😴低波動</span>}
                {x.kdDead && <span style={{ fontSize: '0.7rem', color: down }}>⚔KD死叉</span>}
                <span style={{ fontSize: '0.7rem', color: '#c084fc' }}>法人{(x.inst5Ratio * 100).toFixed(0)}%</span>
                <span style={{ fontFamily: "'JetBrains Mono',monospace" }}>{x.price}</span>
              </span>} />
          ))
          : <Empty what="追強訊號" />}
        {strength?.evidence?.main && <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6 }}>📐 {strength.evidence.main}</div>}
        {strength?.caveats?.filter(Boolean).map((c, i) => <div key={i} style={{ fontSize: '0.68rem', color: '#fbbf24', marginTop: 4, lineHeight: 1.6 }}>{c}</div>)}
      </div>
    </div>
  );

  const daytradeBoards = (
    <div style={grid}>
      <div style={card}>
        <div style={title}>⚡ 當沖候選 <span style={sub}>觀察用·本模式無評分模型</span></div>
        <div style={{ fontSize: '0.74rem', color: '#fbbf24', marginBottom: 6, lineHeight: 1.6 }}>
          ⚠當沖尚無經驗證的評分模型（原料不足·見模式切換器的進度）。以下只是高振幅候選，**不是訊號**，請自行用三關法逐關檢核。
        </div>
        {trade?.dayTrade?.length
          ? trade.dayTrade.slice(0, 10).map(x => (
            <Row key={x.code} code={x.code} name={x.name}
              right={<span style={{ display: 'flex', gap: 8 }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>振幅{x.amplitude}%</span>
                <span style={{ color: col(x.changePct), fontFamily: "'JetBrains Mono',monospace" }}>{sign(x.changePct)}{x.changePct}%</span>
              </span>} />
          ))
          : <Empty what="當沖候選" />}
      </div>
    </div>
  );

  return (
    <div>
      {/* 目前模式與口徑——使用者必須隨時知道自己在看哪個持有期的清單 */}
      <div style={{ ...card, marginBottom: 14, borderColor: 'rgba(167,139,250,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 900, fontSize: '0.95rem' }}>{M.icon} {M.label}模式的訊號榜單</span>
          <span style={sub}>{M.horizon}｜{M.exit.replace(/\*\*/g, '').split('——')[0]}</span>
          {!M.hasScoreModel && <span style={{ marginLeft: 'auto', fontSize: '0.72rem', fontWeight: 800, color: '#fbbf24' }}>本模式無評分模型</span>}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.6 }}>
          切換左上角的模式即可換一整組榜單。**各模式的權重各自回測、絕不互借**——同一檔股票在不同模式的意義可以完全相反。
        </div>
      </div>

      {mode === 'nextday' && nextdayBoards}
      {mode === 'swing' && swingBoards}
      {mode === 'daytrade' && daytradeBoards}

      {/* 不分模式：這三張沒有任何持有期的實證，硬塞進某個模式等於宣稱它有那個口徑的驗證 */}
      <div style={{ marginTop: 18 }}>
        <div style={{ fontWeight: 800, fontSize: '0.9rem', marginBottom: 4 }}>📎 不分模式（基本面與通用觀察）</div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
          以下三張**不屬於任何交易模式**——本站沒有測過它們在隔日沖/波段/當沖任一持有期的表現，
          所以不放進模式榜單，避免讓人以為它們有對應口徑的實證。當作背景資訊看。
        </div>
        <div style={grid}>
          <div style={card}>
            <div style={title}>💪 相對強弱 RS <span style={sub}>近 60 日</span></div>
            {rs.length
              ? rs.slice(0, 8).map(x => (
                <Row key={x.code} code={x.code} name={x.name}
                  right={<span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <b style={{ color: up }}>RS {x.rs}</b>
                    <span style={{ color: col(x.ret60), fontFamily: "'JetBrains Mono',monospace" }}>{sign(x.ret60)}{x.ret60}%</span>
                  </span>} />
              ))
              : <Empty what="RS 排名" />}
          </div>
          <div style={card}>
            <div style={title}>📈 月營收成長 <span style={sub}>{rev?.month || ''} · 年增率</span></div>
            {rev?.topYoY?.length
              ? rev.topYoY.slice(0, 8).map(x => (
                <Row key={x.code} code={x.code} name={x.name}
                  right={<b style={{ color: col(x.yoy) }}>YoY {sign(x.yoy)}{x.yoy}%</b>} />
              ))
              : <Empty what="月營收資料" />}
          </div>
          <div style={card}>
            <div style={title}>🏦 高股息存股 <span style={sub}>殖利率≥4%·低估值</span></div>
            {divStocks.length
              ? divStocks.slice(0, 8).map(x => (
                <Row key={x.code} code={x.code} name={x.name}
                  right={<span><b style={{ color: up }}>{x.yield}%</b><span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginLeft: 6 }}>PER {x.pe}</span></span>} />
              ))
              : <Empty what="高股息名單" />}
          </div>
        </div>
      </div>

      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 14 }}>非投資建議。</div>
    </div>
  );
}
