'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';

// ── 🔀 量價背離：法人籌碼 vs 股價方向（吸貨/出貨候選）──────────────
// 吸貨＝法人5日買超但股價跌（主力低接洗盤）；出貨＝法人賣超但股價漲（趁高減碼）。

interface Item { code: string; name: string; instNet: number; foreign: number; pricePct: number; close: number; score: number }
interface DivData { win: number; startDate: string; endDate: string; accumulate: Item[]; distribute: Item[]; counts: { accumulate: number; distribute: number } }

const EXPLAIN: Record<string, { title: string; text: string }> = {
  accumulate: { title: '吸貨（潛在轉強）', text: '法人近5日「淨買超」但股價卻「下跌」。代表主力趁散戶恐慌、股價回檔時默默低接籌碼（洗盤吸貨），常領先股價打底反彈。但需搭配基本面確認，非必然上漲。' },
  distribute: { title: '出貨（潛在轉弱）', text: '法人近5日「淨賣超」但股價卻「上漲」。代表主力趁散戶追價、股價走高時默默減碼（趁高出貨），常領先股價見頂回落。持有者宜提高警覺。' },
};

const fmt = (n: number) => (n > 0 ? '+' : '') + Math.round(n).toLocaleString();

export default function ChipDivergence({ compact = false }: { compact?: boolean }) {
  const navigateTo = useAppStore(s => s.navigateTo);
  const [d, setD] = useState<DivData | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/ai/chip-divergence').then(r => (r.ok ? r.json() : null)).then(x => { if (live && x) setD(x); }).catch(() => {});
    return () => { live = false; };
  }, []);

  if (!d) return null;
  const toggle = (k: string) => setOpen(o => (o === k ? null : k));

  const col = (side: 'acc' | 'dist') => {
    const items = side === 'acc' ? d.accumulate : d.distribute;
    const meta = side === 'acc'
      ? { title: '🟢 吸貨候選', sub: '法人買超 × 股價跌', head: '#2f9e44', ek: 'accumulate' }
      : { title: '🔴 出貨候選', sub: '法人賣超 × 股價漲', head: '#f03e3e', ek: 'distribute' };
    return (
      <div style={{ flex: '1 1 280px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: meta.head }}>{meta.title}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{meta.sub}</span>
          <button onClick={() => toggle(meta.ek)} aria-label="說明" style={{ width: 17, height: 17, borderRadius: '50%', border: '1px solid var(--border-primary)', background: open === meta.ek ? '#3d8ef8' : 'transparent', color: open === meta.ek ? '#fff' : 'var(--text-muted)', fontSize: 11, lineHeight: '15px', cursor: 'pointer', padding: 0, fontWeight: 700 }}>ⓘ</button>
        </div>
        {open === meta.ek && (
          <div style={{ margin: '2px 0 8px', padding: '8px 12px', borderRadius: 8, background: 'rgba(61,142,248,0.08)', fontSize: 12.5, lineHeight: 1.7, color: 'var(--text-secondary)' }}>
            <b style={{ color: 'var(--text-primary)' }}>{EXPLAIN[meta.ek].title}</b><br />{EXPLAIN[meta.ek].text}
          </div>
        )}
        <div style={{ display: 'grid', gap: 2 }}>
          {items.slice(0, compact ? 6 : 12).map((it, i) => (
            // ⚠ 手機實測（2026-08-10）：這一列原本是 flex 且不換行，空間不夠時
            //   flex 會去**壓縮每個 span**，於是「法人 +53,181 張」被壓成三行、
            //   「張」單獨掉到下一行，「價 -2%」也散開——數值和單位被拆開最難讀。
            //   規則：要斷就在**整段的邊界**斷，絕不在一個數值中間斷。
            //   做法＝允許整列 wrap（let 兩個指標整段換到第二行）
            //        ＋兩個指標 nowrap 且 flexShrink:0（自己絕不被壓）
            //        ＋股名 flex:1 minWidth:0（真的擠不下時由它讓位）
            <div key={it.code} onClick={() => navigateTo('stock', it.code)} style={{ display: 'flex', alignItems: 'center', gap: 8, rowGap: 2, flexWrap: 'wrap', padding: '5px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, background: i % 2 ? 'transparent' : 'rgba(148,163,184,0.04)' }}>
              <span style={{ color: 'var(--text-muted)', width: 16, fontSize: 11, flexShrink: 0 }}>{i + 1}</span>
              <b style={{ color: '#7dd3fc', flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.code} {it.name}</b>
              <span style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>法人 <b style={{ color: it.instNet >= 0 ? '#f03e3e' : '#2f9e44' }}>{fmt(it.instNet)}</b>張</span>
              <span style={{ fontSize: 12, whiteSpace: 'nowrap', flexShrink: 0 }}>價 <b style={{ color: it.pricePct >= 0 ? '#f03e3e' : '#2f9e44' }}>{fmt(it.pricePct)}%</b></span>
            </div>
          ))}
          {!items.length && <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '4px 8px' }}>今日無明顯{side === 'acc' ? '吸貨' : '出貨'}背離</div>}
        </div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8 }}>近 {d.win} 日（{d.startDate} → {d.endDate}）· 法人淨額 ≥800張、股價變動 ≥2% 才列入 · 領先反轉的預警訊號，非投資建議</div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {col('acc')}
        {col('dist')}
      </div>
    </div>
  );
}
