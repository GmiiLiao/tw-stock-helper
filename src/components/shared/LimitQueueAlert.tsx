'use client';

// ── 🚨 搶漲停排隊警示（全頁浮動·反底色閃爍）──────────────────────────
// 使用者需求（2026-08-27）：09:15 前偵測到「巨量買單排隊搶漲停」時即時通知，
// 並在頁面上反底色閃爍讓人一眼看到。
//
// ⚠ 用詞紀律：這是「**排隊搶漲停**」不是「已漲停」——它可能排到一半就散掉。
//   介面一律寫「尚未成交上去」，不可讓人以為已成局。
// ⚠ 無障礙：閃爍動畫對前庭功能敏感者有風險，故 prefers-reduced-motion 時
//   改為靜態高對比（仍看得見，只是不閃）。
import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { isForeground } from '@/lib/market-clock';

interface QItem {
  code: string; name: string; limitPrice: number | null;
  queueLots: number; price: number; chg: number; volume: number; market: string | null;
}
interface QData { updatedAt: number; date: string; inWindow: boolean; windowEnd: string; n: number; items: QItem[] }

export default function LimitQueueAlert() {
  const [d, setD] = useState<QData | null>(null);
  const [dismissed, setDismissed] = useState<string>('');
  const navigateTo = useAppStore(s => s.navigateTo);
  const seenRef = useRef<Set<string>>(new Set());
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      if (!isForeground()) return;
      fetch('/api/twse/limit-queue', { cache: 'no-store' })
        .then(r => (r.ok ? r.json() : null))
        .then(x => {
          if (!live || !x || x.error) return;
          setD(x);
          // 有「新出現」的個股才觸發閃爍——同一批一直閃會變成背景噪音
          const codes = (x.items || []).map((i: QItem) => i.code);
          const fresh = codes.filter((c: string) => !seenRef.current.has(c));
          if (x.inWindow && fresh.length) {
            fresh.forEach((c: string) => seenRef.current.add(c));
            setFlash(true);
            setTimeout(() => setFlash(false), 12000);   // 閃 12 秒後轉靜態，不無限閃
          }
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 15_000);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { live = false; clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  if (!d?.inWindow || !d.items?.length) return null;
  const key = `${d.date}-${d.items.map(i => i.code).join(',')}`;
  if (dismissed === key) return null;

  return (
    <>
      <style>{`
        @keyframes lqFlash {
          0%, 100% { background: rgba(239,68,68,0.16); border-color: rgba(239,68,68,0.65); }
          50%      { background: rgba(239,68,68,0.55); border-color: rgba(255,120,120,1); }
        }
        .lqBanner { animation: lqFlash 1s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          /* 前庭敏感者：不閃，但保留高對比讓訊息一樣醒目 */
          .lqBanner { animation: none; background: rgba(239,68,68,0.4); border-color: rgba(255,120,120,0.9); }
        }
      `}</style>
      <div
        className={flash ? 'lqBanner' : undefined}
        role="alert"
        aria-live="assertive"
        style={{
          position: 'fixed', left: 10, right: 10, bottom: 74, zIndex: 950,
          padding: '9px 13px', borderRadius: 12,
          border: '1px solid rgba(239,68,68,0.6)',
          background: flash ? undefined : 'rgba(239,68,68,0.18)',
          boxShadow: '0 8px 28px rgba(0,0,0,0.4)',
          fontSize: 'calc(13.5px * var(--fz))', lineHeight: 1.5,
          maxWidth: 640, marginInline: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ color: '#fff' }}>🚨 搶漲停排隊</b>
          <span style={{ color: 'rgba(255,255,255,0.85)' }}>{d.n} 檔 · {d.windowEnd} 前</span>
          <button onClick={() => setDismissed(key)}
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.75)', fontSize: 'calc(13.5px * var(--fz))' }}>
            ✕
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          {d.items.slice(0, 6).map(it => (
            <button key={it.code} onClick={() => navigateTo('stock', it.code)}
              style={{
                padding: '3px 9px', borderRadius: 999, cursor: 'pointer',
                background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(255,255,255,0.3)',
                color: '#fff', fontWeight: 700, fontSize: 'calc(13.5px * var(--fz))',
              }}>
              {it.code} {it.name}
              <span style={{ marginLeft: 4, fontWeight: 400, opacity: 0.9 }}>
                委買 {it.queueLots.toLocaleString()} 張＠{it.limitPrice}
              </span>
            </button>
          ))}
        </div>
        <div style={{ color: 'rgba(255,255,255,0.8)', marginTop: 3 }}>
          買單排隊掛在漲停價、<b>尚未成交上去</b>——此刻理論上仍追得到，一旦真的鎖上就買不到了。
          <b>排隊也可能中途散掉</b>，不是已漲停。非投資建議。
        </div>
      </div>
    </>
  );
}
