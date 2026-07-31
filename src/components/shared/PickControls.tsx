'use client';

// ── 撿尾盤 / 盤中戰情 共用的「分類排序」控制列 ──
// 排序可多選：綜合強度(預設·空選＝保留來源排名)／外資買超／量比／漲幅／評分。
//   多選＝分層排序，點選順序＝優先序(第1個為主鍵、其餘為同分次鍵)。
// 價格區間：全部／<50／50–100／100–300／300–500／≥500
// 顯示筆數：預設 30、可點「顯示更多」+30

import { useState } from 'react';

export type PickSort = 'foreign' | 'vol' | 'chg' | 'score';

export interface PickCtl {
  sorts: PickSort[]; // 空陣列＝綜合強度(保留來源排名)；有值＝依序分層排序
  band: number;      // index into PRICE_BANDS，0 = 全部
  limit: number;
}

export const PICK_LIMIT_STEP = 30;
export const PICK_DEFAULT: PickCtl = { sorts: [], band: 0, limit: PICK_LIMIT_STEP };

export const PRICE_BANDS: { label: string; min: number; max: number }[] = [
  { label: '全部', min: 0, max: Infinity },
  { label: '<50', min: 0, max: 50 },
  { label: '50–100', min: 50, max: 100 },
  { label: '100–300', min: 100, max: 300 },
  { label: '300–500', min: 300, max: 500 },
  { label: '≥500', min: 500, max: Infinity },
];

const SORTS: { key: PickSort; label: string }[] = [
  { key: 'foreign', label: '外資買超' },
  { key: 'vol', label: '量比' },
  { key: 'chg', label: '漲幅' },
  { key: 'score', label: '評分' },
];

export interface PickAccess<T> {
  price: (x: T) => number;
  chg: (x: T) => number;
  vol: (x: T) => number;
  foreign: (x: T) => number;
  score: (x: T) => number;
}

export function usePickControls(initial?: Partial<PickCtl>) {
  return useState<PickCtl>({ ...PICK_DEFAULT, ...initial });
}

const accessorFor = <T,>(k: PickSort, a: PickAccess<T>): ((x: T) => number) =>
  k === 'foreign' ? a.foreign : k === 'vol' ? a.vol : k === 'chg' ? a.chg : a.score;

// 篩選(價格區間)＋分層排序＋截斷。sorts 空＝保留來源既有排名(不再排序)。
export function applyPick<T>(items: T[], ctl: PickCtl, a: PickAccess<T>): { rows: T[]; filteredTotal: number } {
  const band = PRICE_BANDS[ctl.band] ?? PRICE_BANDS[0];
  const filtered = items.filter(x => { const p = a.price(x); return p >= band.min && p < band.max; });
  let sorted = filtered;
  if (ctl.sorts.length > 0) {
    const fns = ctl.sorts.map(k => accessorFor(k, a));
    sorted = [...filtered].sort((x, y) => { for (const f of fns) { const d = f(y) - f(x); if (d) return d; } return 0; });
  }
  return { rows: sorted.slice(0, ctl.limit), filteredTotal: filtered.length };
}

const chip = (on: boolean): React.CSSProperties => ({
  padding: '3px 10px', borderRadius: 14, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
  border: `1px solid ${on ? 'rgba(125,211,252,0.55)' : 'var(--border-primary)'}`,
  background: on ? 'rgba(125,211,252,0.14)' : 'transparent',
  color: on ? 'var(--text-primary)' : 'var(--text-muted)',
});

export function PickBar({ ctl, setCtl, showScore = true, priceOnly = false }: {
  ctl: PickCtl; setCtl: React.Dispatch<React.SetStateAction<PickCtl>>; showScore?: boolean; priceOnly?: boolean;
}) {
  const set = (patch: Partial<PickCtl>) => setCtl(c => ({ ...c, ...patch, limit: PICK_LIMIT_STEP }));
  const toggleSort = (k: PickSort) => setCtl(c => {
    const sorts = c.sorts.includes(k) ? c.sorts.filter(s => s !== k) : [...c.sorts, k];
    return { ...c, sorts, limit: PICK_LIMIT_STEP };
  });
  const sorts = showScore ? SORTS : SORTS.filter(s => s.key !== 'score');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 8 }}>
      {!priceOnly && (
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 30 }}>排序</span>
        <button onClick={() => set({ sorts: [] })} style={chip(ctl.sorts.length === 0)}>綜合強度</button>
        {sorts.map(s => {
          const idx = ctl.sorts.indexOf(s.key);
          const on = idx >= 0;
          return (
            <button key={s.key} onClick={() => toggleSort(s.key)} style={chip(on)}>
              {s.label}{on && ctl.sorts.length > 1 ? <sup style={{ fontSize: 8.5, marginLeft: 2, color: '#7dd3fc' }}>{idx + 1}</sup> : null}
            </button>
          );
        })}
        {ctl.sorts.length > 1 && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>（數字＝優先序）</span>}
      </div>
      )}
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 30 }}>價格</span>
        {PRICE_BANDS.map((b, i) => (
          <button key={b.label} onClick={() => set({ band: i })} style={chip(ctl.band === i)}>{b.label}</button>
        ))}
      </div>
    </div>
  );
}

// 「顯示更多」列：顯示 shown/filteredTotal，未顯示完時可 +30
export function PickMore({ ctl, setCtl, filteredTotal }: {
  ctl: PickCtl; setCtl: React.Dispatch<React.SetStateAction<PickCtl>>; filteredTotal: number;
}) {
  const shown = Math.min(ctl.limit, filteredTotal);
  const more = filteredTotal - shown;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>顯示 {shown} / {filteredTotal} 檔</span>
      {more > 0 && (
        <button onClick={() => setCtl(c => ({ ...c, limit: c.limit + PICK_LIMIT_STEP }))}
          style={{ padding: '3px 12px', borderRadius: 14, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
            border: '1px solid rgba(125,211,252,0.45)', background: 'rgba(125,211,252,0.10)', color: '#7dd3fc' }}>
          顯示更多 +{Math.min(PICK_LIMIT_STEP, more)}
        </button>
      )}
      {ctl.limit > PICK_LIMIT_STEP && (
        <button onClick={() => setCtl(c => ({ ...c, limit: PICK_LIMIT_STEP }))}
          style={{ padding: '3px 10px', borderRadius: 14, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
            border: '1px solid var(--border-primary)', background: 'transparent', color: 'var(--text-muted)' }}>
          收合
        </button>
      )}
    </div>
  );
}
