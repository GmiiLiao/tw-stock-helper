'use client';

// 當沖工作台：個人風控設定（只存本機瀏覽器——技巧原文：保留使用者資料私密性）。
// ⚠ 輸入框一律**非受控**（defaultValue＋onBlur）：本頁每 5 秒輪詢重繪，受控輸入在手機 IME 會把游標打回開頭
//   （CLAUDE.md：這個錯誤已發生兩次）。
import { useEffect, useState } from 'react';
import { storageGet, storageSet } from '@/lib/safe-storage';
import type { BrokerSettings } from '@/lib/tw-fee';
import { DEFAULT_RISK, type DeskRisk } from '@/lib/daytrade-sizing';

const KEY = 'dtDeskRisk';

export function useDeskRisk(): [DeskRisk, (r: DeskRisk) => void] {
  const [risk, setRisk] = useState<DeskRisk>(DEFAULT_RISK);
  useEffect(() => {
    try { const s = JSON.parse(storageGet(KEY) || 'null'); if (s && typeof s === 'object') setRisk({ ...DEFAULT_RISK, ...s }); } catch { /* 用預設 */ }
  }, []);
  const save = (r: DeskRisk) => { setRisk(r); storageSet(KEY, JSON.stringify(r)); };
  return [risk, save];
}

const num = (v: string): number | null => { const n = Number(String(v).replace(/[,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };

export default function DeskRiskPanel({ risk, setRisk, broker }: { risk: DeskRisk; setRisk: (r: DeskRisk) => void; broker: BrokerSettings }) {
  const [open, setOpen] = useState(false);
  const missing = risk.riskCapTwd == null;
  const field = (label: string, key: keyof DeskRisk, hint: string, placeholder = '') => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'calc(12px * var(--fz))', color: 'var(--text-muted)' }}>
      <span>{label}</span>
      <input key={`${key}:${String(risk[key])}`} defaultValue={risk[key] == null ? '' : String(risk[key])} placeholder={placeholder} inputMode="numeric"
        onBlur={e => {
          const v = key === 'slipTicks' ? Math.max(0, Math.round(Number(e.target.value) || 0)) : key === 'todayLossTwd' ? Math.max(0, Number(String(e.target.value).replace(/[,\s]/g, '')) || 0) : num(e.target.value);
          setRisk({ ...risk, [key]: v });
        }}
        style={{ width: '9em', padding: '3px 6px', borderRadius: 6, border: '1px solid var(--border-primary)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 'calc(13px * var(--fz))', fontFamily: "'JetBrains Mono', monospace" }} />
      <span style={{ fontSize: 'calc(11px * var(--fz))' }}>{hint}</span>
    </label>
  );
  return (
    <div style={{ borderRadius: 10, border: `1px solid ${missing ? 'rgba(245,158,11,0.45)' : 'var(--border-primary)'}`, padding: '6px 10px', marginBottom: 8, background: missing ? 'rgba(245,158,11,0.06)' : 'transparent' }}>
      <button onClick={() => setOpen(v => !v)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-primary)', fontWeight: 800, fontSize: 'calc(13px * var(--fz))', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <span>{open ? '▾' : '▸'} 🛡 我的風控</span>
        <span style={{ fontWeight: 600, color: missing ? '#f59e0b' : 'var(--text-muted)', fontSize: 'calc(12px * var(--fz))' }}>
          {missing ? '尚未設定每筆風險上限：只列觀察名單、不算張數'
            : `每筆上限 ${risk.riskCapTwd!.toLocaleString()} 元${risk.capitalTwd ? `·資金 ${risk.capitalTwd.toLocaleString()} 元` : '·資金未設'}${risk.dailyCapTwd ? `·單日上限 ${risk.dailyCapTwd.toLocaleString()}（已虧 ${risk.todayLossTwd.toLocaleString()}）` : ''}·滑價 ${risk.slipTicks} 檔`}
          ·手續費 {broker.discount === 1 ? '無折讓' : `${+(broker.discount * 10).toFixed(2)} 折`}／低消 {broker.minFee} 元·當沖稅 0.15%
        </span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 8 }}>
          {field('每筆最大可承受損失（元）', 'riskCapTwd', '必填：沒填只列觀察', '例 3000')}
          {field('可用資金／當沖額度（元）', 'capitalTwd', '限制張數上限', '例 500000')}
          {field('單日虧損上限（元）', 'dailyCapTwd', '到達即停止提出新的觀察進場', '例 9000')}
          {field('今日已實現虧損（元）', 'todayLossTwd', '手動填，從上限扣除', '0')}
          {field('預估單邊滑價（檔）', 'slipTicks', '進出各算一次', '1')}
          <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: 'var(--text-muted)', maxWidth: '32em', lineHeight: 1.6 }}>
            這些數字只存在這台裝置的瀏覽器，不會上傳。手續費折讓與低消沿用「持倉」頁的券商設定。
            張數公式：張數 × 1000 × 每股風險 ＋ 雙邊手續費 ＋ 當沖稅 ＋ 雙邊滑價 ≤ 每筆上限，且買進金額 ≤ 可用資金。
          </div>
        </div>
      )}
    </div>
  );
}
