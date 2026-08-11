'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { auth } from '@/lib/firebase';

// ── 🎭 身分模擬面板（AdminPanel 分頁）──────────────────────────────
//
// 兩種模擬，解決兩類不同的 bug：
//   ① **等級模擬**：只換權限等級、資料仍是自己的 → 抓「該擋沒擋 / 該給沒給」的閘門錯誤
//      （例：高級功能對註冊用戶外洩、或會員看到 🔒）。
//   ② **會員模擬（唯讀）**：載入該會員的實際資料 → 抓**資料形狀**造成的錯誤。
//      2026-08-06 的整頁白畫面就是這一類：只持有 1 檔的會員必中，而管理員自己
//      持股多檔怎麼點都正常。**看不到會員實際看到的畫面，就查不出這種 bug。**
//
// 清單特別標出「持股 0/1 檔」——邊界情境最會出事，讓它一眼可選。

interface Member {
  uid: string; email: string | null; level: string;
  lastLogin: number | null; holdings: number; trades: number;
}
interface Diag { doc: string; exists: boolean; missing: string[]; keys: number }

const LEVELS = [
  { id: 'registered', label: '👤 註冊使用者' },
  { id: 'junior', label: '✨ 初級會員' },
  { id: 'premium', label: '💎 高級會員' },
  { id: 'admin', label: '🛡️ 管理員' },
];

export default function ViewAsPanel() {
  const enterViewAs = useAppStore(s => s.enterViewAs);
  const viewAs = useAppStore(s => s.viewAs);
  const navigateTo = useAppStore(s => s.navigateTo);
  const [members, setMembers] = useState<Member[]>([]);
  const [diag, setDiag] = useState<{ email: string; rows: Diag[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');

  const call = useCallback(async (qs: string) => {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error('取不到登入憑證，請重新登入');
    const r = await fetch(`/api/admin/impersonate${qs}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  }, []);

  useEffect(() => {
    call('').then(j => setMembers(j.members || [])).catch(e => setErr(e.message));
  }, [call]);

  const simulateMember = async (m: Member) => {
    setBusy(m.uid); setErr('');
    try {
      const j = await call(`?uid=${encodeURIComponent(m.uid)}`);
      setDiag({ email: m.email || m.uid, rows: j.diagnostics || [] });
      enterViewAs({ level: j.profile.level, uid: m.uid, email: j.profile.email, data: j.data });
      navigateTo('portfolio');   // 直接跳到最常出事的頁面
    } catch (e) { setErr((e as Error).message); }
    setBusy(null);
  };

  const box: React.CSSProperties = {
    padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)',
    border: '1px solid var(--border-primary)', marginBottom: 14,
  };

  return (
    <div style={{ fontSize: 'calc(13px * var(--fz))' }}>
      <div style={{ ...box, background: 'rgba(245,158,11,0.07)', borderColor: 'rgba(245,158,11,0.35)' }}>
        <div style={{ fontWeight: 900, marginBottom: 4 }}>🎭 身分模擬（唯讀）</div>
        模擬期間**所有寫入都會被封鎖**——不會動到任何人的自選、持倉或交易紀錄；
        頁面上方會有橘色警示條，30 分鐘自動結束，按「結束模擬」會重新載入以還原你自己的帳號。
        每次讀取會員資料都會寫入使用記錄。
      </div>

      {err && <div style={{ ...box, borderColor: '#ef4444', color: '#ef4444' }}>⚠ {err}</div>}
      {viewAs && (
        <div style={{ ...box, borderColor: '#f97316' }}>
          目前正在模擬：<b>{viewAs.email ?? viewAs.level}</b>　—— 請用上方橘色警示條的按鈕結束。
        </div>
      )}

      <div style={box}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>① 等級模擬（用自己的資料，只換權限）</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {LEVELS.map(l => (
            <button key={l.id}
              onClick={() => enterViewAs({ level: l.id })}
              style={{
                padding: '6px 14px', borderRadius: 999, cursor: 'pointer', fontWeight: 800, fontSize: 'calc(12.5px * var(--fz))',
                border: '1px solid var(--border-primary)', background: 'var(--bg-tertiary)', color: 'var(--text-primary)',
              }}>
              以 {l.label} 檢視
            </button>
          ))}
        </div>
        <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: '#cbd5f5', marginTop: 8 }}>
          用途：確認高級功能對非會員確實隱藏、且對會員確實開放。
        </div>
      </div>

      <div style={box}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>② 會員模擬（載入該會員的實際資料·唯讀）</div>
        <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: '#cbd5f5', marginBottom: 8 }}>
          ⚠️ 持股 <b>0 或 1 檔</b>的帳號是最容易出事的邊界情境（已標紅），排查白畫面類問題請優先選它們。
        </div>
        <div style={{ maxHeight: 340, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(12px * var(--fz))' }}>
            <thead><tr style={{ color: '#cbd5f5', textAlign: 'left' }}>
              <th style={{ padding: '4px 6px' }}>會員</th><th>等級</th><th>持股</th><th>交易</th><th>最後登入</th><th></th>
            </tr></thead>
            <tbody>
              {members.map(m => {
                const edge = m.holdings <= 1;
                return (
                  <tr key={m.uid} style={{ borderTop: '1px solid rgba(148,163,184,0.1)' }}>
                    <td style={{ padding: '5px 6px', color: '#dbe4f5' }}>{m.email ?? m.uid.slice(0, 10)}</td>
                    <td>{m.level}</td>
                    <td style={{ fontWeight: 800, color: edge ? '#ef4444' : 'var(--text-primary)' }}>
                      {m.holdings}{edge ? ' ⚠' : ''}
                    </td>
                    <td style={{ color: '#cbd5f5' }}>{m.trades}</td>
                    <td style={{ color: '#cbd5f5' }}>
                      {m.lastLogin ? new Date(m.lastLogin).toLocaleDateString('zh-TW') : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button onClick={() => simulateMember(m)} disabled={busy === m.uid}
                        style={{
                          padding: '4px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 'calc(11.5px * var(--fz))', fontWeight: 800,
                          border: '1px solid #f97316', background: 'transparent', color: '#f97316',
                        }}>
                        {busy === m.uid ? '載入中…' : '以此身分檢視'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {diag && (
        <div style={box}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>🩺 {diag.email} 的資料健檢</div>
          <div style={{ fontSize: 'calc(11.5px * var(--fz))', color: '#cbd5f5', marginBottom: 8 }}>
            「缺欄位」代表 daemon 只寫了一半——前端若沒防護就會在這裡崩潰（2026-08-06 白畫面事故的成因）。
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {diag.rows.map(r => (
              <span key={r.doc} style={{
                padding: '3px 9px', borderRadius: 999, fontSize: 'calc(11.5px * var(--fz))', fontWeight: 700,
                background: !r.exists ? 'var(--bg-tertiary)' : r.missing.length ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.13)',
                color: !r.exists ? '#cbd5f5' : r.missing.length ? '#ef4444' : '#22c55e',
                border: `1px solid ${!r.exists ? 'var(--border-primary)' : r.missing.length ? 'rgba(239,68,68,0.4)' : 'rgba(34,197,94,0.35)'}`,
              }}>
                {r.doc}{!r.exists ? '（無）' : r.missing.length ? `（缺 ${r.missing.join('/')}）` : ` ✓${r.keys}`}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
