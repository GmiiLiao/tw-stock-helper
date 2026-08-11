'use client';

// ── 📰 每日新聞（2026-08-05 由「指數·新聞」獨立頁改為「市場總覽」分頁）──
// daemon 每日 07:00 聚合四類（全球AI產業／全球局勢／美國建廠·NVIDIA 供應鏈／
// 台灣產業），日間每 3 小時刷新。標題連結導回原媒體，AI 導讀僅歸納標題。
// 非投資建議。

import { useEffect, useState } from 'react';

interface NewsItem { title: string; link: string; src: string; at: number }
interface NewsCat { key: string; label: string; brief: string; items: NewsItem[] }
interface Digest { found: boolean; date?: string; updatedAt?: number; newestAt?: number | null; cats?: NewsCat[]; note?: string }

// 相對時間（讓新鮮度看得見；使用者定案：每日新聞必須是當日最新）
const ago = (ms?: number) => {
  if (!ms) return '';
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return '剛剛';
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
};

export default function DailyNews() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [sel, setSel] = useState<string>('');

  useEffect(() => {
    fetch('/api/ai/news-digest?list=1').then(r => (r.ok ? r.json() : null)).then(j => setDates(j?.dates || [])).catch(() => {});
  }, []);
  useEffect(() => {
    const q = sel ? `?date=${sel}` : '';
    setDigest(null);
    fetch(`/api/ai/news-digest${q}`).then(r => (r.ok ? r.json() : null)).then(j => setDigest(j)).catch(() => setDigest({ found: false }));
  }, [sel]);

  const chip = (on: boolean) => ({ padding: '4px 10px', borderRadius: 12, fontSize: 'calc(11.5px * var(--fz))', fontWeight: 800 as const, cursor: 'pointer', border: `1px solid ${on ? 'rgba(125,211,252,0.6)' : 'var(--border-primary)'}`, background: on ? 'rgba(125,211,252,0.14)' : 'transparent', color: on ? 'var(--text-primary)' : 'var(--text-muted)' });

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>日期：</span>
        <button onClick={() => setSel('')} style={chip(!sel)}>最新</button>
        {dates.slice(0, 10).map(d => <button key={d} onClick={() => setSel(d)} style={chip(sel === d)}>{d.slice(5)}</button>)}
      </div>
      {!digest && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: 16 }}>載入新聞…</div>}
      {digest && !digest.found && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: 16 }}>尚無新聞資料（每日上午 7:00 自動發布）。</div>}
      {digest?.found && (
        <>
          <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.8 }}>
            📅 {digest.date} · 最後更新 <b style={{ color: (Date.now() - (digest.updatedAt || 0)) > 6 * 3600000 ? '#ff8787' : 'var(--text-secondary)' }}>{ago(digest.updatedAt)}</b>
            {' '}· 每日 07:00 首發、日間每 3 小時自動刷新<br />{digest.note}
          </div>
          {(digest.cats || []).map(cat => (
            <div key={cat.key} style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
              <div style={{ fontWeight: 900, fontSize: 'calc(13.5px * var(--fz))', marginBottom: 6 }}>{cat.label}</div>
              {cat.brief && (
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.8, color: 'var(--text-secondary)', padding: '8px 10px', borderRadius: 8, background: 'rgba(125,211,252,0.06)', border: '1px solid rgba(125,211,252,0.2)', marginBottom: 8 }}>
                  🧠 {cat.brief}
                </div>
              )}
              <div style={{ display: 'grid', gap: 4 }}>
                {cat.items.map((it, i) => (
                  <a key={i} href={it.link} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize: 'calc(12.5px * var(--fz))', lineHeight: 1.7, color: 'var(--text-primary)', textDecoration: 'none', display: 'flex', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>·</span>
                    <span style={{ flex: 1 }}>{it.title} <span style={{ fontSize: 'calc(11px * var(--fz))', color: 'var(--text-muted)' }}>{it.src}{it.at ? ` · ${ago(it.at)}` : ''}</span></span>
                  </a>
                ))}
                {cat.items.length === 0 && <div style={{ fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>本日此類無新聞。</div>}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
