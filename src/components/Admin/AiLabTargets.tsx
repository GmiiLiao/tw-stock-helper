'use client';

// 🎯 AI 實驗目標追蹤（2026-09-26 使用者）：兩個 50 萬帳戶各自的戰績、累積戰績，
//   近 5／20／60 個交易日是否持續獲利，並對照使用者目標（5 日 ≥35%、20 日 ≥70%、60 日 ≥120%）。
//   計算在 scripts/lib/ai-lab-targets.mjs（唯一實作、有測試）；這裡只取兩帳戶的逐日總值並呈現。
import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';
import { targetBoard, SWING_CUM_TARGET, type TargetBoard, type WindowStat } from '../../../scripts/lib/ai-lab-targets.mjs';
import { MONO, upDn, pct } from './AiLabParts';

const INITIAL = 500000;

async function authedJson(url: string) {
  const token = (await auth.currentUser?.getIdToken()) ?? '';
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}

function Cell({ w }: { w: WindowStat }) {
  if (w.ret == null) return <td style={{ padding: '6px 10px', color: 'var(--text-muted)' }}>尚無資料</td>;
  return (
    <td style={{ padding: '6px 10px', verticalAlign: 'top' }}>
      <div style={{ ...MONO, fontWeight: 900, fontSize: 'calc(15px * var(--fz))', color: upDn(w.ret) }}>{pct(w.ret)}</div>
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: w.partial ? '#7dd3fc' : w.met ? '#22c55e' : '#ef4444' }}>
        {w.partial ? `已累積 ${w.days}/${w.n} 日（未滿，不判定）` : w.met ? `✅ 達標（≥${w.target}%）` : `未達（差 ${(w.target - w.ret).toFixed(1)} 個百分點）`}
      </div>
      {w.windows > 0 && <div style={{ ...MONO, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
        滾動窗 {w.windows} 個·獲利 {w.positive}（{w.hitRate}%）·達標 {w.metWindows ?? 0}·連續獲利 {w.streak}·最佳 {pct(w.best)}／最差 {pct(w.worst)}
      </div>}
    </td>
  );
}

export default function AiLabTargets() {
  // G3-16：抓取失敗（非 2xx／網路錯）要顯示「載入失敗」，不可被當成空序列顯示成「尚無資料」
  const [boards, setBoards] = useState<{ dt: TargetBoard | null; sw: TargetBoard | null; dtFail: boolean; swFail: boolean } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [dt, sw] = await Promise.all([
        authedJson('/api/admin/ai-daytrade-lab').catch(() => null),
        authedJson('/api/admin/ai-swing-lab').catch(() => null),
      ]);
      if (!alive) return;
      const dtSeries = ((dt?.daily || []) as { date: string; equity: number }[]).map(x => ({ date: x.date, total: x.equity }));
      const swSeries = ((sw?.snapshot?.history || []) as { date: string; total: number }[]).map(x => ({ date: x.date, total: x.total }));
      setBoards({
        dt: dt ? targetBoard(dtSeries, INITIAL) : null, sw: sw ? targetBoard(swSeries, INITIAL, { cumTarget: SWING_CUM_TARGET }) : null,
        dtFail: !dt, swFail: !sw,
      });
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div style={{ marginBottom: 14, padding: 12, borderRadius: 12, border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.05)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 }}>
        <b style={{ fontSize: 'calc(15px * var(--fz))' }}>🎯 目標追蹤</b>
        <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>
          兩帳戶各 50 萬、互不挪用。近 N 日報酬＝最新帳戶總值 ÷ N 個交易日前的總值 − 1。目標由使用者訂定（5 日 ≥35%、20 日 ≥70%、60 日 ≥120%；波段帳戶累積 ≥200%＝總值 150 萬），
          遠高於本站回測可見水準（波段起漲⭐ 5 日約 +1.1%、當沖規則 v1 約 −0.33R），此表只如實呈現是否達成。模擬交易，非投資建議。
        </span>
      </div>
      {!boards ? <div style={{ color: 'var(--text-muted)' }}>載入中…</div> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720, fontSize: 'calc(12.5px * var(--fz))' }}>
            <thead><tr style={{ color: 'var(--text-muted)' }}>
              {['帳戶', '帳戶總值', '累積報酬', '近 5 日（目標 ≥35%）', '近 20 日（目標 ≥70%）', '近 60 日（目標 ≥120%）'].map(h => <th key={h} style={{ padding: '4px 10px', textAlign: 'left', borderBottom: '1px solid var(--border-primary)' }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {([['⏳ 當沖', boards.dt, boards.dtFail], ['🌊 波段持有', boards.sw, boards.swFail]] as const).map(([name, b, failed]) => failed ? (
                <tr key={name} style={{ borderBottom: '1px dashed var(--border-primary)' }}>
                  <td style={{ padding: '6px 10px', fontWeight: 900, whiteSpace: 'nowrap' }}>{name}</td>
                  <td colSpan={5} style={{ padding: '6px 10px', color: '#ef4444' }}>載入失敗</td>
                </tr>
              ) : b && (
                <tr key={name} style={{ borderBottom: '1px dashed var(--border-primary)' }}>
                  <td style={{ padding: '6px 10px', fontWeight: 900, whiteSpace: 'nowrap' }}>{name}<div style={{ fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>已記錄 {b.tradingDays} 個交易日</div></td>
                  <td style={{ ...MONO, padding: '6px 10px', fontWeight: 800 }}>{Math.round(b.total).toLocaleString()} 元</td>
                  <td style={{ ...MONO, padding: '6px 10px', fontWeight: 900, color: upDn(b.cumRetPct), verticalAlign: 'top' }}>{pct(b.cumRetPct)}
                    {b.cumTarget != null && <div style={{ fontFamily: 'inherit', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 800, color: b.cumMet ? '#22c55e' : 'var(--text-muted)' }}>
                      {b.cumMet ? `✅ 達成累積目標 ≥${b.cumTarget}%` : `累積目標 ≥${b.cumTarget}%（總值 ${(b.targetTotal ?? 0).toLocaleString()} 元）·進度 ${b.cumProgress}%`}
                    </div>}
                  </td>
                  {b.windows.map(w => <Cell key={w.n} w={w} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
