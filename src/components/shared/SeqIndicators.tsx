'use client';

import { useDailySeq, dailySeqMa, dailySeqPairs } from '@/lib/useDailySeq';

// ── 列上的兩個小提示（2026-09-16 波段持有先用，09-17 使用者要求自選各子分頁也要）──
//   MaChip：收盤 vs 5／20／60 日線（▲3＝三線之上、▲2／▲1＝部分、▽＝三線之下）
//   SeqBars：近 N 日逐日「漲跌×成交量」縮圖（柱高＝量、紅漲綠跌），辨識起漲／回落
// 兩者都是純展示；資料由呼叫端傳入，或用 *For 版本依代號自取（走 useDailySeq 合批）。

export type MaFlags = (boolean | null)[];
export type Seq = number[];   // 攤平 [chg, vol, chg, vol, …]（Firestore 不接受巢狀陣列）

const UP = '#f03e3e', DOWN = '#2f9e44', MUTED = 'var(--text-muted)';

export function MaChip({ ma }: { ma?: MaFlags }) {
  if (!ma || ma.every(v => v == null)) return null;
  const names = ['5日', '20日', '60日'];
  const above = ma.filter(v => v === true).length, known = ma.filter(v => v != null).length;
  const title = `收盤 vs 均線：${ma.map((v, i) => `${names[i]}${v == null ? '？' : v ? '上' : '下'}`).join('・')}`;
  const all = above === known && known === 3;
  const style: React.CSSProperties = { padding: '0 5px', borderRadius: 5, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, marginLeft: 4, whiteSpace: 'nowrap',
    background: all ? 'rgba(240,62,62,0.16)' : above === 0 ? 'rgba(47,158,68,0.16)' : 'rgba(251,191,36,0.16)', color: all ? UP : above === 0 ? DOWN : '#fbbf24' };
  return <span title={title} style={style}>{above === 0 ? '▽' : `▲${above}`}</span>;
}

export function SeqBars({ seq, win, width }: { seq?: Seq | null; win?: number; width?: number }) {
  if (!seq?.length) return <span style={{ color: MUTED }}>—</span>;
  const pairs: [number, number][] = []; for (let i = 0; i + 1 < seq.length; i += 2) pairs.push([seq[i], seq[i + 1]]);
  const W = width ?? Math.min(96, Math.max(40, pairs.length * 3)), H = 18, vmax = Math.max(1, ...pairs.map(d => d[1])), bw = W / pairs.length;
  const title = `${win ? win + '日' : ''}逐日（舊→新）：` + pairs.map(d => `${d[0] >= 0 ? '+' : ''}${d[0]}%/${d[1].toLocaleString()}張`).join('，');
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'inline-block', verticalAlign: 'middle' }}><title>{title}</title>
      {pairs.map((d, i) => { const h = Math.max(1, (d[1] / vmax) * H); return <rect key={i} x={i * bw + 0.2} y={H - h} width={Math.max(0.8, bw - 0.4)} height={h} fill={d[0] > 0 ? UP : d[0] < 0 ? DOWN : '#94a3b8'} opacity={0.9} />; })}
    </svg>
  );
}

/** 依代號自取（合批）：三線位置小提示 */
export function MaChipFor({ code }: { code: string }) {
  const s = useDailySeq(code);
  return <MaChip ma={dailySeqMa(s)} />;
}

/** 依代號自取（合批）：近 10 日漲跌×量縮圖。資料未回或無此檔時不佔位（回 null），列高不跳。 */
export function SeqBarsFor({ code, width = 60 }: { code: string; width?: number }) {
  const s = useDailySeq(code);
  const pairs = dailySeqPairs(s);
  if (!pairs?.length) return null;
  return <span title="近 10 日逐日漲跌×成交量（紅漲綠跌、柱高＝量）" style={{ display: 'inline-flex', alignItems: 'center' }}><SeqBars seq={pairs} win={10} width={width} /></span>;
}
