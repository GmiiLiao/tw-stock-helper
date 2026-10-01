'use client';

// 當沖工作台：交易日誌與迭代（tw-day-trading 技巧 journal-schema／iteration）。
// 所有候選與觸發都記（含否決、未交易）；統計每格都附 n。開發集 ≥100、驗證集 ≥30 筆前只報描述統計、不調參。
import { useEffect, useState } from 'react';
import { startLiveLoop, isForeground, getSession } from '@/lib/market-clock';
import { hhmm } from './DeskRow';

interface Stat { side: string; type: string; bucket: string; n: number; win: number | null; avgR: number | null; medR: number | null; maxLoss: number }
interface Entry { code: string; name: string; side: 'long' | 'short'; type: string; t: number; traded: boolean; veto: string[]; entry: number; stop: number; netR: number | null; exit: { reason: string; px: number } | null; score?: { total: number; knownMax: number; tier: string | null } }
interface JournalResp { found: boolean; days?: string[]; versions?: string[]; stats?: Stat[]; vetoed?: Record<string, number>; falseBreaks?: Record<string, number>; latest?: { date: string; entries: Entry[]; candidates: number } | null }

const NUM: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontVariantNumeric: 'tabular-nums', textAlign: 'right' };
const rC = (v: number | null) => (v == null ? 'var(--text-muted)' : v > 0 ? 'var(--color-up)' : v < 0 ? 'var(--color-down)' : 'var(--text-muted)');

export default function DeskJournal() {
  const [j, setJ] = useState<JournalResp | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => { if (!isForeground()) return; fetch('/api/ai/daytrade-journal').then(r => (r.ok ? r.json() : null)).then(d => { if (alive && d) setJ(d); }).catch(() => {}); };
    load();
    const stop = startLiveLoop(load, () => (getSession() === 'regular' ? 120_000 : 900_000));   // 每拍重算
    return () => { alive = false; stop(); };
  }, []);
  if (!j) return <div style={{ padding: 12, color: 'var(--text-muted)' }}>載入日誌…</div>;
  if (!j.found) return <div style={{ padding: 12, color: 'var(--text-muted)' }}>尚無日誌：常駐服務從下一個交易日 09:05 起記錄每一筆候選與觸發（含否決、未交易）。</div>;
  const stats = j.stats || [];
  return (
    <div style={{ fontSize: 'calc(12.5px * var(--fz))' }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 6, fontSize: 'calc(13px * var(--fz))', lineHeight: 1.6 }}>
        日誌期間 {j.days?.[0]}～{j.days?.at(-1)}（{j.days?.length} 個交易日）·規則版本 {j.versions?.join('、')}·否決 多 {j.vetoed?.long ?? 0}／空 {j.vetoed?.short ?? 0}·假突破 多 {j.falseBreaks?.long ?? 0}／空 {j.falseBreaks?.short ?? 0}。
        <b style={{ color: '#f59e0b' }}> 升版門檻：開發集有效成交 ≥100、之後的驗證集 ≥30，且樣本外淨期望改善；不足前只看、不調參。</b>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: 560 }}>
          <thead><tr style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>
            {['方向', 'Setup', '時段', 'n', '勝率', '平均淨R', '中位淨R', '最大連敗'].map(h => <th key={h} style={{ padding: '3px 8px', textAlign: h === '方向' || h === 'Setup' || h === '時段' ? 'left' : 'right', borderBottom: '1px solid var(--border-primary)' }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {stats.map((s, i) => (
              <tr key={i} style={{ opacity: s.n ? 1 : 0.5, fontWeight: s.type === '全部' ? 800 : 400 }}>
                <td style={{ padding: '2px 8px', color: s.side === 'long' ? 'var(--color-up)' : 'var(--color-down)' }}>{s.side === 'long' ? '多' : '空'}</td>
                <td style={{ padding: '2px 8px' }}>{s.bucket === '全部' ? s.type : ''}</td>
                <td style={{ padding: '2px 8px', color: 'var(--text-muted)' }}>{s.bucket === '全部' ? '全部' : s.bucket}</td>
                <td style={{ ...NUM, padding: '2px 8px' }}>{s.n}{s.n < 30 ? <span title="樣本不足：只作假設" style={{ color: '#f59e0b' }}>*</span> : null}</td>
                <td style={{ ...NUM, padding: '2px 8px' }}>{s.win == null ? '—' : `${s.win}%`}</td>
                <td style={{ ...NUM, padding: '2px 8px', color: rC(s.avgR) }}>{s.avgR == null ? '—' : s.avgR.toFixed(2)}</td>
                <td style={{ ...NUM, padding: '2px 8px', color: rC(s.medR) }}>{s.medR == null ? '—' : s.medR.toFixed(2)}</td>
                <td style={{ ...NUM, padding: '2px 8px' }}>{s.maxLoss}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {j.latest && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>{j.latest.date} 逐筆（候選 {j.latest.candidates} 檔·觸發與否決 {j.latest.entries.length} 筆）</div>
          {j.latest.entries.slice(0, 80).map((e, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '3.2em 1.6em 3.6em minmax(4em, 7em) 5.5em minmax(0, 1fr) 4.2em', columnGap: 8, padding: '2px 0', borderBottom: '1px dashed var(--border-primary)', alignItems: 'baseline' }}>
              <span style={NUM}>{hhmm(e.t)}</span>
              <span style={{ color: e.side === 'long' ? 'var(--color-up)' : 'var(--color-down)' }}>{e.side === 'long' ? '多' : '空'}</span>
              <span style={{ ...NUM, textAlign: 'left' }}>{e.code}</span>
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.name}</span>
              <span>{e.type}</span>
              <span style={{ color: e.traded ? 'var(--text-muted)' : '#f59e0b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.veto.join('；')}>
                {e.traded ? `假設進場 ${e.entry}·停 ${e.stop}${e.exit ? `→${e.exit.reason} @${e.exit.px}` : '·成立中'}${e.score ? `·${e.score.total}/${e.score.knownMax}` : ''}` : `⛔ ${e.veto.join('；')}`}
              </span>
              <span style={{ ...NUM, color: rC(e.netR), fontWeight: 800 }}>{e.netR == null ? '—' : `${e.netR >= 0 ? '+' : ''}${e.netR}R`}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
