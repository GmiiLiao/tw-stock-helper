'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';

// ── 🧭 籌碼風向：當日/5日/20日 三大法人淨買賣加權（多按鈕點開說明）──────
// 用逐日 T86(含自營)累加各時間框，看法人資金往哪流、哪些股/族群被加碼減碼。

interface Leader { code: string; name: string; net: number; f: number; t: number; d: number; streak: number }
interface Sector { industry: string; net: number }
interface TF {
  label: string; days: number;
  marketNet: { foreign: number; trust: number; dealer: number; total: number };
  foreignBuy: Leader[]; foreignSell: Leader[]; trustBuy: Leader[]; instBuy: Leader[]; instSell: Leader[];
  sectorAdd: Sector[]; sectorReduce: Sector[];
}
interface WindData { updatedAt: number; latestDate: string; daysAvailable: number; timeframes: Record<string, TF> }

const isTwTradingHours = () => {
  const tw = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const d = tw.getDay(); const v = tw.getHours() * 60 + tw.getMinutes();
  return d >= 1 && d <= 5 && v >= 9 * 60 && v < 13 * 60 + 35;
};

const EXPLAIN: Record<string, { title: string; text: string }> = {
  tf: { title: '為什麼分當日/5日/20日？', text: '當日＝最新籌碼動向（法人今天怎麼佈局）；5日＝短線主力進出方向；20日＝中期趨勢的籌碼沉澱。三個一起看，能分辨是短打還是長線卡位。' },
  market: { title: '市場法人總淨額', text: '全市場三大法人買賣超加總（張）。正值＝資金淨流入台股（偏多），負值＝淨流出（偏空）。這是判斷大盤資金面最直接的指標。' },
  foreign: { title: '外資（最大主力）', text: '外國機構投資人，主導台股約4成成交量、影響力最強。外資連續買超＝強力多頭訊號；外資站在哪邊，通常決定盤勢方向。' },
  trust: { title: '投信（本土基金）', text: '台灣本土基金公司，管理散戶集中資金。特性是追強勢股、季底（3/6/9/12月）常有作帳行情，投信認養的股票短線動能強。' },
  dealer: { title: '自營商（券商自有資金）', text: '券商用自己的錢操作，靈活、常做短線與避險。自營商買超代表券商看好短線，但持股通常不長，波動較大。' },
  streak: { title: '外資連買天數', text: '外資連續淨買超的日數。天數越長＝籌碼越穩、法人越有信心，是「籌碼追蹤策略」的核心——連買＋創新高常是主力持續卡位。' },
  sector: { title: '產業籌碼傾向（加碼/減碼）', text: '把每個產業成分股的三大法人淨額加總。加碼＝法人資金正流入該族群（可留意輪動），減碼＝資金正撤出（避免逆勢）。' },
};

const fmt = (n: number) => (n > 0 ? '+' : '') + Math.round(n).toLocaleString();
const col = (n: number) => (n > 0 ? '#f03e3e' : n < 0 ? '#2f9e44' : 'var(--text-muted)');

export default function ChipWind({ compact = false, bare = false }: { compact?: boolean; bare?: boolean }) {
  const navigateTo = useAppStore(s => s.navigateTo);
  const [data, setData] = useState<WindData | null>(null);
  const [tf, setTf] = useState<'d1' | 'd5' | 'd20'>('d5');
  const [listTab, setListTab] = useState<'foreignBuy' | 'foreignSell' | 'trustBuy' | 'instBuy'>('foreignBuy');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/chip-wind').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setData(x); }).catch(() => {});
    load();
    const t = setInterval(load, isTwTradingHours() ? 120000 : 600000);
    return () => { live = false; clearInterval(t); };
  }, []);

  if (!data?.timeframes) return null;
  const cur = data.timeframes[tf];
  if (!cur) return null;

  const toggle = (k: string) => setOpen(o => (o === k ? null : k));

  // ⓘ 說明按鈕
  const info = (k: string) => (
    <button onClick={() => toggle(k)} aria-label="說明" style={{ marginLeft: 6, width: 17, height: 17, borderRadius: '50%', border: '1px solid var(--border-primary)', background: open === k ? '#3d8ef8' : 'transparent', color: open === k ? '#fff' : 'var(--text-muted)', fontSize: 11, lineHeight: '15px', cursor: 'pointer', padding: 0, fontWeight: 700 }}>ⓘ</button>
  );
  const explainBox = (k: string) => open === k && EXPLAIN[k] ? (
    <div style={{ margin: '6px 0 8px', padding: '8px 12px', borderRadius: 8, background: 'rgba(61,142,248,0.08)', fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
      <b style={{ color: 'var(--text-primary)' }}>{EXPLAIN[k].title}</b><br />{EXPLAIN[k].text}
    </div>
  ) : null;

  const TF_META: Record<string, { label: string }> = { d1: { label: '當日' }, d5: { label: '5日' }, d20: { label: '20日' } };
  const LIST_META: { key: typeof listTab; label: string; ex: string; color: string }[] = [
    { key: 'foreignBuy', label: '外資買超', ex: 'foreign', color: '#f03e3e' },
    { key: 'foreignSell', label: '外資賣超', ex: 'foreign', color: '#2f9e44' },
    { key: 'trustBuy', label: '投信買超', ex: 'trust', color: '#e8590c' },
    { key: 'instBuy', label: '三大法人買超', ex: 'market', color: '#f03e3e' },
  ];
  const list = cur[listTab] || [];
  const listMeta = LIST_META.find(l => l.key === listTab)!;

  const pill = (active: boolean, color = '#3d8ef8') => ({
    fontSize: 12.5, fontWeight: 700, padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
    color: active ? '#fff' : 'var(--text-secondary)', background: active ? color : 'rgba(148,163,184,0.1)',
  });

  const mn = cur.marketNet;

  return (
    <div style={bare ? {} : { marginBottom: 14, padding: '12px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: bare ? 'none' : 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontWeight: 900, fontSize: '1rem' }}>🧭 籌碼風向</span>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>三大法人淨買賣加權 · 資料日 {data.latestDate}（{data.daysAvailable}日庫）</span>
      </div>

      {/* 時間框切換 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
        {(['d1', 'd5', 'd20'] as const).map(k => (
          <span key={k} onClick={() => setTf(k)} style={pill(tf === k)}>{TF_META[k].label}</span>
        ))}
        {info('tf')}
      </div>
      {explainBox('tf')}

      {/* 市場法人總淨額 */}
      <div style={{ marginTop: 6, marginBottom: 4, display: 'flex', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>市場法人總淨額（{cur.label}）</span>{info('market')}
      </div>
      {explainBox('market')}
      {/* ⚠ 原本寫死 repeat(4,1fr)：手機 335px 塞四欄，每欄只剩 78px，
          但「+369,828」這種數字最少要 ~95px → 軌道撐開、整頁橫向溢出。
          改 auto-fit：手機自然變 2×2，桌機仍是一排四欄。
          min(150px,100%) 而不是 150px，是為了容器比 150 還窄時仍能收斂。 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 8, marginBottom: 10 }}>
        {([['外資', mn.foreign, 'foreign'], ['投信', mn.trust, 'trust'], ['自營', mn.dealer, 'dealer'], ['合計', mn.total, 'market']] as const).map(([lb, v, ex]) => (
          <div key={lb} style={{ padding: '8px 6px', borderRadius: 8, background: 'rgba(148,163,184,0.06)', textAlign: 'center' }}>
            <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{lb}{lb !== '合計' ? info(ex) : ''}</div>
            <div style={{ fontSize: 15, fontWeight: 800, color: col(v) }}>{fmt(v)}</div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>張</div>
          </div>
        ))}
      </div>
      {['foreign', 'trust', 'dealer'].map(k => explainBox(k))}

      {/* 產業籌碼傾向 */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>產業籌碼傾向</span>{info('sector')}
      </div>
      {explainBox('sector')}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ flex: '1 1 240px', padding: '7px 10px', borderRadius: 8, background: 'rgba(240,62,62,0.08)' }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#f03e3e', marginBottom: 3 }}>🔺 法人加碼族群</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            {cur.sectorAdd.length ? cur.sectorAdd.map(s => <span key={s.industry} style={{ marginRight: 10 }}>{s.industry} <b style={{ color: '#f03e3e' }}>+{Math.round(s.net).toLocaleString()}</b></span>) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
          </div>
        </div>
        <div style={{ flex: '1 1 240px', padding: '7px 10px', borderRadius: 8, background: 'rgba(47,158,68,0.08)' }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: '#2f9e44', marginBottom: 3 }}>🔻 法人減碼族群</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.9 }}>
            {cur.sectorReduce.length ? cur.sectorReduce.map(s => <span key={s.industry} style={{ marginRight: 10 }}>{s.industry} <b style={{ color: '#2f9e44' }}>{Math.round(s.net).toLocaleString()}</b></span>) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
          </div>
        </div>
      </div>

      {/* 個股買賣超榜 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {LIST_META.map(l => <span key={l.key} onClick={() => setListTab(l.key)} style={pill(listTab === l.key, l.color)}>{l.label}</span>)}
        {info(listMeta.ex)}
      </div>
      {explainBox(listMeta.ex)}
      <div style={{ display: 'grid', gap: 2 }}>
        {list.slice(0, compact ? 8 : 12).map((it, i) => (
          <div key={it.code} onClick={() => navigateTo('stock', it.code)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 13, background: i % 2 ? 'transparent' : 'rgba(148,163,184,0.04)' }}>
            <span style={{ color: 'var(--text-muted)', width: 18, fontSize: 11 }}>{i + 1}</span>
            <b style={{ color: '#7dd3fc', minWidth: 104 }}>{it.code} {it.name}</b>
            <b style={{ color: col(it.net), minWidth: 78, textAlign: 'right' }}>{fmt(it.net)}</b>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>張</span>
            {listTab !== 'foreignBuy' && listTab !== 'foreignSell' && <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>外{fmt(it.f)}/投{fmt(it.t)}/自{fmt(it.d)}</span>}
            {(listTab === 'foreignBuy') && it.streak >= 2 && <span style={{ fontSize: 11, color: '#e8590c', fontWeight: 700 }}>連買{it.streak}日</span>}
          </div>
        ))}
        {!list.length && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px' }}>此時間框無資料</div>}
      </div>

      <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
        單位：張（1張=1000股）。T86 約 15:00 公布，當日框為最近已公布交易日。確定性統計，非投資建議。
      </div>
    </div>
  );
}
