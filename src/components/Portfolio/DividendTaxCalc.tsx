'use client';

import { useMemo, useState } from 'react';

// ── 股利稅負試算（tax-loss-harvesting 台灣化）──
// 台灣現行法規、已婚合併申報情境：
//  A. 合併課稅：股利併入綜合所得，享股利可抵減稅額 8.5%（每申報戶上限 8 萬元）
//  B. 分離課稅：股利按 28% 單一稅率分開計稅（高所得者較有利）
//  另：單筆股利給付 ≥2 萬元收 2.11% 二代健保補充保費（就源扣繳）。
// 全為法定公式計算，非報稅建議；實際請依國稅局核定。

const BRACKETS = [5, 12, 20, 30, 40];

export default function DividendTaxCalc() {
  const [divIncome, setDivIncome] = useState('');
  const [bracket, setBracket] = useState(20);
  const [open, setOpen] = useState(false);

  const r = useMemo(() => {
    const div = parseFloat(divIncome);
    if (isNaN(div) || div <= 0) return null;
    // A 合併：稅增 = 股利×邊際稅率 − min(股利×8.5%, 80,000)
    const credit = Math.min(div * 0.085, 80000);
    const merged = div * (bracket / 100) - credit;
    // B 分離：28%
    const separate = div * 0.28;
    // 二代健保（估算：以總額 2.11% 計；實際按「單筆給付≥2萬」逐筆認定）
    const nhi = div >= 20000 ? div * 0.0211 : 0;
    const better = merged <= separate ? 'A' : 'B';
    return { div, credit: Math.round(credit), merged: Math.round(merged), separate: Math.round(separate), nhi: Math.round(nhi), better };
  }, [divIncome, bracket]);

  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 'calc(0.95rem * var(--fz))' }}>🧾 股利稅負試算</span>
        <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>已婚合併申報 · 合併 8.5% 抵減 vs 28% 分離</span>
        <button onClick={() => setOpen(o => !o)} style={{ marginLeft: 'auto', fontSize: 'calc(12px * var(--fz))', padding: '2px 10px', borderRadius: 8, border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', cursor: 'pointer' }}>{open ? '收合' : '展開'}</button>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
            <input className="input" type="number" placeholder="全年股利所得(元)" value={divIncome} onChange={e => setDivIncome(e.target.value)} style={{ width: 160, fontSize: 'calc(13px * var(--fz))' }} />
            <select className="input" value={bracket} onChange={e => setBracket(+e.target.value)} style={{ width: 150, fontSize: 'calc(13px * var(--fz))' }}>
              {BRACKETS.map(b => <option key={b} value={b}>綜所稅率 {b}%</option>)}
            </select>
          </div>
          {r && (
            <div style={{ fontSize: 'calc(13px * var(--fz))', lineHeight: 2 }}>
              <div style={{ color: r.better === 'A' ? '#f03e3e' : 'var(--text-secondary)' }}>
                {r.better === 'A' ? '✓ ' : ''}A 合併課稅：應納 <b>{r.merged.toLocaleString()}</b> 元（抵減 {r.credit.toLocaleString()} 元{r.credit === 80000 ? '，已達 8 萬上限' : ''}）{r.merged < 0 ? ' → 可退稅' : ''}
              </div>
              <div style={{ color: r.better === 'B' ? '#f03e3e' : 'var(--text-secondary)' }}>
                {r.better === 'B' ? '✓ ' : ''}B 分離課稅 28%：應納 <b>{r.separate.toLocaleString()}</b> 元
              </div>
              <div style={{ color: 'var(--text-muted)' }}>另二代健保補充保費約 {r.nhi.toLocaleString()} 元（2.11%，按單筆≥2萬就源扣繳估算）</div>
              <div style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)', marginTop: 4 }}>※ 法定公式試算，非稅務建議；股利所得為全戶合計，實際以國稅局核定為準。</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
