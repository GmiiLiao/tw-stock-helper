'use client';

import { useState } from 'react';

// ── 📖 台股交易規則與稅務（新手必讀參考）──────────────────────────
// 教育整理，以主管機關(證交所/財政部)最新公告為準，非投資/稅務/法律建議。

interface Row { k: string; v: string; note?: string }
interface Section { id: string; icon: string; title: string; rows?: Row[]; body?: React.ReactNode }

const SECTIONS: Section[] = [
  {
    id: 'time', icon: '📅', title: '交易時間與單位',
    rows: [
      { k: '開盤前競價', v: '08:30–09:00', note: '撮合決定開盤價' },
      { k: '正常交易', v: '09:00–13:30', note: '每日主要時段（無午休）' },
      { k: '盤中零股', v: '09:00–13:30', note: '1–999 股，2020 年起（流動性較差）' },
      { k: '盤後零股', v: '13:40–14:30', note: '1–999 股' },
      { k: '盤後定價', v: '14:00–14:30', note: '以收盤價成交的補充交易' },
      { k: '整張單位', v: '1 張 = 1,000 股', note: '正常交易最小單位' },
    ],
    body: <div style={{ marginTop: 8, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.6 }}>週六日、國定假日不交易（農曆年常連休 4–7 天）。<br />🔑 買 1 張 1,000 元的股票需 1,000×1,000＝<b>100 萬元</b>（再加手續費）。</div>,
  },
  {
    id: 'limit', icon: '📊', title: '漲跌幅限制',
    body: (
      <div style={{ fontSize: 'calc(13.5px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        每日最大漲跌幅：前一日收盤價的 <b style={{ color: 'var(--text-primary)' }}>±10%</b><br />
        · 漲 10% ＝ <b style={{ color: '#f03e3e' }}>漲停板</b>（很難買到）<br />
        · 跌 10% ＝ <b style={{ color: '#2f9e44' }}>跌停板</b>（很難賣掉）<br />
        <span style={{ color: '#f59f00' }}>⚠️ 持股遇跌停，當天可能完全無法賣出。</span>
      </div>
    ),
  },
  {
    id: 'cost', icon: '💸', title: '交易成本',
    rows: [
      { k: '手續費（買/賣各一次）', v: '0.1425%', note: '多數券商網路 6 折 ≈ 0.085%' },
      { k: '證券交易稅（賣出）', v: '0.3%', note: 'ETF 為 0.1%，券商自動代扣' },
    ],
    body: <div style={{ marginTop: 8, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.6 }}>範例（買賣各 10 萬、6 折手續費）：買 85 元 ＋ 賣 85 元 ＋ 交易稅 300 元 ＝ 約 <b>470 元（0.47%）</b>。隔日沖來回成本約 0.4–0.5%，需納入勝率評估。</div>,
  },
  {
    id: 'settle', icon: '🔄', title: '交割制度 T+2',
    body: (
      <div style={{ fontSize: 'calc(13.5px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        週一買 → <b style={{ color: 'var(--text-primary)' }}>週三</b>早上帳戶扣款；週一賣 → 週三才拿到現金。<br />
        <span style={{ color: '#f59f00' }}>💡 賣股的錢不能隔天立刻再用，需 T+2 入帳。</span>
      </div>
    ),
  },
  {
    id: 'tax', icon: '🧾', title: '獲利要繳的稅',
    rows: [
      { k: '資本利得（買低賣高）', v: '✅ 免稅', note: '2016 起停徵證所稅，截至 2026 仍未復徵' },
      { k: '證券交易稅', v: '0.3%（ETF 0.1%）', note: '賣出自動代扣，免申報' },
      { k: '現金股利', v: '需申報', note: '合併計入(可抵8.5%/上限8萬) 或 分離課稅 28%' },
      { k: '股票股利', v: '需申報', note: '以面值 10 元計' },
    ],
    body: <div style={{ marginTop: 8, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.6 }}>股利選擇：綜所稅率 &lt;28% 選合併申報較划算；&gt;28% 選分離課稅 28%。<br />🎉 <b>波段/隔日沖的買賣價差獲利，目前完全合法免稅</b>（資本利得停徵）。</div>,
  },
  {
    id: 'watch', icon: '👁', title: '觀察股（注意/處置）',
    rows: [
      { k: '第一級：注意股票', v: '標示警示', note: '交易方式暫不變；持續異常 → 升級處置' },
      { k: '第二級：處置股票', v: '限制交易', note: '約每 2 分鐘撮合、禁當沖、預收全額款券（2026-08-10 新制：原 5/20 分鐘統一改 2 分鐘）' },
      { k: '處置期間', v: '5 個營業日', note: '2026-08-10 新制：原 10 日縮短為 5 日；第 2 次以上同為 5 日' },
      { k: '＋當沖占比過高', v: '7 個營業日', note: '同期間另因當沖比過高（逾 60%）被列注意者，原 12 日縮短為 7 日' },
      { k: '高價股注意門檻', v: '放寬', note: '收盤價逾 1,000 元且 6 營業日價差 ≥300 元才算；逾 2,000 元後每 1,000 元級距 +150 元' },
    ],
    body: (
      <div style={{ marginTop: 8, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        <b style={{ color: 'var(--text-primary)' }}>觸發（擇要，以交易所公告為準）</b>：近期多日漲跌停、量暴增(60日均量數十倍)、短期累計漲幅過大、週轉率異常。<br />
        <b style={{ color: 'var(--text-primary)' }}>影響</b>：撮合變慢 → 流動性下降、價差擴大、想賣不一定賣得掉；漲跌幅<b>不變</b>（仍±10%）。<br />
        <b style={{ color: '#7dd3fc' }}>📅 2026-08-10 新制（證交所與櫃買中心同步）</b>：處置期 10→<b>5 個營業日</b>、
        合併當沖過高者 12→<b>7 個營業日</b>、撮合由 5/20 分鐘統一為<b>約 2 分鐘一次</b>，
        高價股注意門檻放寬。<b>新制當日立即適用已在處置中的個股</b>——已滿新天數者即刻解除，
        未滿者續到滿為止。此後原則上每半年檢討一次。<br />
        <span style={{ color: '#f59f00' }}>⚠️ 常見套路：炒手拉高 → 散戶追進 → 列處置 → 流動性枯竭、散戶被套，炒手早已離場。</span><br />
        <b style={{ color: '#f03e3e' }}>建議：看到「注」小心觀察暫不追高；看到「處」新手強烈建議完全迴避。</b>本系統推薦榜已自動標示 ⚠️注意股／🔴處置股。
      </div>
    ),
  },
  {
    id: 'law', icon: '📋', title: '開戶與法規紅線',
    rows: [
      { k: '開戶年齡', v: '18 歲', note: '2023 民法成年下修為 18；未成年需法定代理人同意' },
      { k: '文件', v: '身分證＋第二證件', note: '實體或網路券商皆可' },
    ],
    body: (
      <div style={{ marginTop: 8, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        🚫 <b style={{ color: '#f03e3e' }}>法律紅線（刑事責任）</b>：內線交易（最高 10 年徒刑＋罰金）、炒作股票（拉抬/放空）、借用他人帳戶交易、散布假消息。
      </div>
    ),
  },
];

export default function TradingRules({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [sec, setSec] = useState<string | null>('time');

  return (
    <div style={{ marginBottom: 14, borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', overflow: 'hidden' }}>
      <div onClick={() => setOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', cursor: 'pointer' }}>
        <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 900, fontSize: 'calc(1rem * var(--fz))' }}>📖 台股交易規則與稅務</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>新手必讀 · 時間/成本/漲跌停/交割/稅務/法規</span>
        <span style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>{open ? '收合' : '展開'}</span>
      </div>

      {open && (
        <div style={{ padding: '0 16px 14px' }}>
          {/* 分區導覽 */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {SECTIONS.map(s => (
              <span key={s.id} onClick={() => setSec(o => (o === s.id ? null : s.id))}
                style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '4px 11px', borderRadius: 20, cursor: 'pointer', color: sec === s.id ? '#fff' : 'var(--text-secondary)', background: sec === s.id ? '#3d8ef8' : 'rgba(148,163,184,0.1)' }}>
                {s.icon} {s.title}
              </span>
            ))}
          </div>

          {SECTIONS.filter(s => s.id === sec).map(s => (
            <div key={s.id}>
              {s.rows && (
                <div style={{ display: 'grid', gap: 2 }}>
                  {s.rows.map((r, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 8px', borderRadius: 6, background: i % 2 ? 'transparent' : 'rgba(148,163,184,0.04)', fontSize: 'calc(13px * var(--fz))', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, minWidth: 150 }}>{r.k}</span>
                      <b style={{ color: '#7dd3fc' }}>{r.v}</b>
                      {r.note && <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>{r.note}</span>}
                    </div>
                  ))}
                </div>
              )}
              {s.body}
            </div>
          ))}

          <div style={{ marginTop: 10, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            教育整理，以證交所／財政部最新公告為準，非投資、稅務或法律建議。
          </div>
        </div>
      )}
    </div>
  );
}
