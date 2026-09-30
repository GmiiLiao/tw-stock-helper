'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDataUid, canWriteUserData } from '@/lib/view-as';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';
import { settleDate, isSettled, todayTaipeiIso, rollBankToToday } from '@/lib/tw-settlement';
import { useBrokerSettings } from '@/lib/useBrokerSettings';
import { buildLedger } from '@/lib/portfolio-calc';

// ── 資金總覽（現金流水帳）──
// 使用者只記三種事件：入金/出金/股利。買入扣款、賣出入帳從交易紀錄的
// totalAmount 自動帶入（已含手續費/證交稅）。
// 現金餘額 = 入金 − 出金 + 股利 + 賣出入帳 − 買入扣款
// 帳戶總報酬 = 持股現值 + 現金餘額 − 淨投入本金（涵蓋已實現+未實現+股利）

interface Entry { id: string; type: 'deposit' | 'withdraw' | 'dividend'; amount: number; date: string; at: number }

const TYPES: Record<Entry['type'], { t: string; sign: number; c: string }> = {
  deposit: { t: '入金', sign: 1, c: '#38bdf8' },
  withdraw: { t: '出金', sign: -1, c: '#f59e0b' },
  dividend: { t: '股利', sign: 1, c: '#f03e3e' },
};
const wan = (v: number) => `${(v / 10000).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} 萬`;

export default function CashLedger() {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const tradeRecords = useAppStore(st => st.tradeRecords);
  const holdings = useAppStore(st => st.holdings);
  const allStocks = useAppStore(st => st.allStocks);
  const [broker, saveBroker] = useBrokerSettings();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [bankBalance, setBankBalance] = useState<number | null>(null);
  const [bankAt, setBankAt] = useState<number | null>(null);
  const [bankInput, setBankInput] = useState('');
  const [open, setOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState({ type: 'deposit' as Entry['type'], amount: '', date: new Date().toISOString().slice(0, 10) });

  useEffect(() => {
    if (!dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(doc(db, 'users', dataUid, 'data', 'cashLedger'), snap => {
      const data = snap.exists() ? snap.data() : null;
      setEntries(data?.entries || []);
      const bb = typeof data?.bankBalance === 'number' ? data.bankBalance : null;
      setBankBalance(bb); setBankInput(bb != null ? String(bb) : '');
      setBankAt(typeof data?.bankAt === 'number' ? data.bankAt : null);
    }, () => {});
    return () => unsub();
  }, [dataUid]);

  const save = async (next: Entry[], bank?: number | null) => {
    if (!dataUid || !canWriteUserData()) return;   // 🎭模擬中禁止寫入（畫面上的是別人的資料）
    if (!user?.uid) return;
    const payload: { entries: Entry[]; updatedAt: number; bankBalance?: number | null } = { entries: next, updatedAt: Date.now() };
    if (bank !== undefined) payload.bankBalance = bank;
    else if (bankBalance != null) payload.bankBalance = bankBalance;
    await setDoc(doc(db, 'users', dataUid, 'data', 'cashLedger'), payload, { merge: true });
  };
  const saveBank = async () => {
    if (!dataUid || !canWriteUserData()) return;   // 🎭模擬中禁止寫入
    const v = bankInput.trim() === '' ? null : parseFloat(bankInput);
    if (v != null && isNaN(v)) return;
    setBankBalance(v);
    // updatedAt 一定要一起寫：daemon 的配置漂移監看是拿 cashLedger.updatedAt 與
    // rebalance.updatedAt 比大小——原本這裡只寫 bankBalance/bankAt，
    // 使用者按「更新」後右下的再平衡卡永遠不會重算，兩邊現金對不上。
    await setDoc(doc(db, 'users', dataUid, 'data', 'cashLedger'), { bankBalance: v, bankAt: Date.now(), updatedAt: Date.now() }, { merge: true });
  };
  const add = async () => {
    const v = parseFloat(form.amount);
    if (isNaN(v) || v <= 0) return;
    await save([{ id: `c-${Date.now()}`, type: form.type, amount: v, date: form.date, at: Date.now() }, ...entries]);
    setForm(f => ({ ...f, amount: '' })); setOpen(false);
  };

  const calc = useMemo(() => {
    const sum = (t: Entry['type']) => entries.filter(e => e.type === t).reduce((s, e) => s + e.amount, 0);
    const deposits = sum('deposit'), withdraws = sum('withdraw'), dividends = sum('dividend');
    const buys = tradeRecords.filter(t => t.type === 'buy').reduce((s, t) => s + (t.totalAmount || 0), 0);
    const sells = tradeRecords.filter(t => t.type === 'sell').reduce((s, t) => s + (t.totalAmount || 0), 0);
    const cash = deposits - withdraws + dividends + sells - buys;
    const netDeposits = deposits - withdraws;
    const mv = holdings.reduce((s, h) => {
      const px = allStocks.find(st => st.code === h.code)?.price || 0;
      return s + px * h.quantity * 1000;
    }, 0);
    const totalReturn = mv + cash - netDeposits;
    const retPct = netDeposits > 0 ? (totalReturn / netDeposits) * 100 : null;

    // ── T+2 交割：未交割的買進(待扣款)/賣出(待入帳)明細 ──
    const today = todayTaipeiIso();
    const pendBuy = tradeRecords.filter(t => t.type === 'buy' && t.date && !isSettled(t.date, today));
    const pendSell = tradeRecords.filter(t => t.type === 'sell' && t.date && !isSettled(t.date, today));
    const pendingDeduct = pendBuy.reduce((s, t) => s + (t.totalAmount || 0), 0);  // 未交割買進 → 交割日扣款
    const pendingCredit = pendSell.reduce((s, t) => s + (t.totalAmount || 0), 0);  // 未交割賣出 → 交割日入帳
    // 依交割日彙總排程
    const sched: Record<string, { deduct: number; credit: number; pnl: number; sells: number; unmatched: number }> = {};
    const slot = (d: string) => (sched[d] ||= { deduct: 0, credit: 0, pnl: 0, sells: 0, unmatched: 0 });
    for (const t of pendBuy) slot(settleDate(t.date)).deduct += t.totalAmount || 0;
    for (const t of pendSell) slot(settleDate(t.date)).credit += t.totalAmount || 0;
    // 已實現損益（2026-09-30 使用者：排程加上獲利金額）：以**全量交易紀錄**重放帳本（buildLedger，成本含買進費、收入已扣賣出費稅），
    //   依賣出交割日彙總；不讀交易紀錄上存死的 realizedPnL（編輯過會被刪、且可能用過期成本）。無買進可對應的張數另計、不捏造損益。
    for (const c of buildLedger(tradeRecords).closed) {
      if (!c.date || isSettled(c.date, today)) continue;
      const x = slot(settleDate(c.date));
      if (c.matchedLots > 0) { x.pnl += c.pnl; x.sells++; }
      if (c.oversoldLots > 0) x.unmatched += c.oversoldLots;
    }
    const schedule = Object.entries(sched).map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date));

    return { deposits, withdraws, dividends, buys, sells, cash, netDeposits, mv, totalReturn, retPct, pendingDeduct, pendingCredit, schedule };
  }, [entries, tradeRecords, holdings, allStocks]);

  // 銀行對帳（需使用者填餘額一次，之後逐日自動滾動）
  const bank = useMemo(() => {
    if (bankBalance == null) return null;
    // ── 自動逐日滾動（2026-08-14 使用者指正）：輸入的餘額是「錨點」，之後每天
    //    的交割款進出（交易紀錄＋T+2）與新記的入出金，系統自動滾上去。
    //    實案：8/12 輸入 837,959 → 8/13/8/14 交割後實際 342,751，
    //    畫面卻仍拿舊錨點算剩餘籌碼（虛胖 49 萬）。
    // ⚠ 錨點時刻缺失（只會是舊版存檔）時**不捏造**：以今天當錨點＝不滾動任何交割，數字不變，
    //   但要在畫面標示「錨點日未知」而不是印出今天的日期當錨點（A 族捏造預設值；daemon 同一分支同一做法）。
    const anchorUnknown = bankAt == null;
    const roll = rollBankToToday(bankBalance, bankAt ?? Date.now(), tradeRecords, entries);
    const estBank = roll.estBank;
    // 交割後實際可動用 = 推算今日餘額 − 未交割買進待扣 + 未交割賣出待入
    const investable = estBank - calc.pendingDeduct + calc.pendingCredit;
    // 對帳基準在「錨點日」：預期錨點日餘額 = 錨點日已交割現金 ± 錨點日前的流水
    const sumTo = (ty: Entry['type']) => entries.filter(e => e.type === ty && e.date <= roll.anchorDate).reduce((s, e) => s + e.amount, 0);
    const settledByAnchor = (ty: 'buy' | 'sell') => tradeRecords
      .filter(t => t.type === ty && t.date && settleDate(t.date) <= roll.anchorDate)
      .reduce((s, t) => s + (t.totalAmount || 0), 0);
    const expectedAnchor = sumTo('deposit') - sumTo('withdraw') + sumTo('dividend') + settledByAnchor('sell') - settledByAnchor('buy');
    const diff = bankBalance - expectedAnchor;
    return { investable, estBank, rolledNet: roll.rolledNet, rolledCount: roll.rolledCount, anchorDate: roll.anchorDate, anchorUnknown, expectedToday: expectedAnchor, diff };
  }, [bankBalance, bankAt, calc, tradeRecords, entries]);

  // ── 現金的唯一真相（2026-08-12 使用者對帳指正）───────────────────────
  // 有銀行餘額時：現金＝銀行實際餘額經交割調整（bank.investable）。
  // 帳本推算的 calc.cash 只在「沒有銀行餘額可對」時退而用之——
  // 它是全部交易+流水的重放，任何未記的出入金/利息/折讓差都會讓它漂
  // （實測與銀行差 −29.1 萬，對帳橫幅有揭露），但原本下游的
  // 持股現值＋現金／帳戶總報酬仍拿它來算＝把已知的漂移假裝不存在。
  // 口徑證明：淨值 = 持股現值 + 銀行 − 待扣 + 待入。
  //   買進未交割：股票已計入持股現值、款還在銀行 → 減待扣款才不重複計；
  //   賣出未交割：股票已不在持股、款未入帳 → 加待入帳才不漏計。
  const cashUsed = bank ? bank.investable : calc.cash;
  const totalReturnUsed = calc.mv + cashUsed - calc.netDeposits;
  const retPctUsed = calc.netDeposits > 0 ? (totalReturnUsed / calc.netDeposits) * 100 : null;

  if (!user?.uid) return null;
  const hasLedger = entries.length > 0;

  return (
    <div style={{ marginBottom: 16, padding: '14px 16px', borderRadius: 12, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: hasLedger || open ? 10 : 0, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 'calc(0.95rem * var(--fz))' }}>💰 資金總覽</span>
        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>只需記入金/出金/股利，買賣現金流自動帶入</span>
        <button onClick={() => setShowSettings(s => !s)} title="券商手續費設定" style={{ marginLeft: 'auto', fontSize: 'calc(12.5px * var(--fz))', padding: '4px 10px', borderRadius: 8, background: 'var(--bg-tertiary)', color: 'var(--text-secondary)', border: '1px solid var(--border-primary)', cursor: 'pointer' }}>⚙ 費率</button>
        <button onClick={() => setOpen(o => !o)} style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '4px 12px', borderRadius: 8, background: 'var(--accent-purple,#6366f1)', color: '#fff', border: 'none', cursor: 'pointer' }}>{open ? '取消' : '＋記一筆'}</button>
      </div>

      {showSettings && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', marginBottom: 10, padding: 10, background: 'var(--bg-tertiary)', borderRadius: 8, fontSize: 'calc(13px * var(--fz))' }}>
          <span style={{ color: 'var(--text-secondary)' }}>手續費折讓</span>
          <input className="input" type="number" step="0.01" min="0.01" max="1" value={broker.discount}
            onChange={e => saveBroker({ ...broker, discount: Math.max(0.01, Math.min(1, parseFloat(e.target.value) || 1)) })} style={{ width: 80 }} />
          <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>1=無折、0.6=6折、0.28=28折</span>
          <span style={{ color: 'var(--text-secondary)' }}>最低手續費</span>
          <input className="input" type="number" min="0" value={broker.minFee}
            onChange={e => saveBroker({ ...broker, minFee: Math.max(0, parseInt(e.target.value) || 0) })} style={{ width: 70 }} />
          <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>元（常見 20；設定後套用到新交易試算）</span>
        </div>
      )}

      {/* 銀行對帳 + T+2 剩餘籌碼 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 10, padding: 10, background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)', borderRadius: 8 }}>
        <span style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 600, color: '#38bdf8' }}>🏦 銀行餘額（錨點）</span>
        <input className="input" type="number" placeholder="填入交割銀行餘額" value={bankInput}
          onChange={e => setBankInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') saveBank(); }} style={{ width: 150 }} />
        <button onClick={saveBank} className="btn" style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '4px 12px', background: '#38bdf8', color: '#062', border: 'none', borderRadius: 8, fontWeight: 700 }}>更新</button>
        {(calc.pendingDeduct > 0 || calc.pendingCredit > 0) && (
          <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
            未交割：待扣款 −{wan(calc.pendingDeduct)} · 待入帳 +{wan(calc.pendingCredit)}
          </span>
        )}
      </div>

      {bank && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 8, marginBottom: 10 }}>
          <div style={{ padding: '8px 10px', background: 'rgba(34,197,94,0.08)', borderRadius: 8, border: '1px solid rgba(34,197,94,0.25)' }}>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>💵 剩餘籌碼（交割後可動用）</div>
            <div style={{ fontWeight: 800, fontSize: 'calc(1rem * var(--fz))', color: bank.investable >= 0 ? '#f03e3e' : '#2f9e44', fontFamily: "'JetBrains Mono',monospace" }}>{wan(bank.investable)}</div>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>推算今日餘額 − 待扣 + 待入</div>
          </div>
          <div style={{ padding: '8px 10px', background: 'rgba(56,189,248,0.06)', borderRadius: 8, border: '1px solid rgba(56,189,248,0.2)' }}>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>🏦 銀行餘額（自動滾動至今日）</div>
            <div style={{ fontWeight: 800, fontSize: 'calc(1rem * var(--fz))', color: '#38bdf8', fontFamily: "'JetBrains Mono',monospace" }}>{bank.estBank.toLocaleString()}</div>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
              {bank.anchorUnknown
                ? `錨點日未知（舊版儲存未記時刻），未滾動任何交割；請重新輸入銀行餘額以建立錨點`
                : bank.rolledCount > 0
                ? `錨點 ${bank.anchorDate} 輸入 ${bankBalance?.toLocaleString()}，已滾動 ${bank.rolledCount} 筆交割/流水（${bank.rolledNet >= 0 ? '+' : ''}${bank.rolledNet.toLocaleString()}）`
                : `錨點 ${bank.anchorDate} 輸入，尚無後續交割`}
            </div>
          </div>
          <div style={{ padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>對帳差異</div>
            <div style={{ fontWeight: 800, fontSize: 'calc(1rem * var(--fz))', color: Math.abs(bank.diff) < 100 ? '#22c55e' : '#f59e0b', fontFamily: "'JetBrains Mono',monospace" }}>
              {Math.abs(bank.diff) < 100 ? '✓ 相符' : `${bank.diff >= 0 ? '+' : ''}${bank.diff.toLocaleString()} 元`}
            </div>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>預期錨點日（{bank.anchorUnknown ? '未知·暫以今日計' : bank.anchorDate}）{wan(bank.expectedToday)}</div>
          </div>
        </div>
      )}
      {bank && Math.abs(bank.diff) >= 100 && (
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#f59e0b', marginBottom: 8 }}>⚠ 銀行餘額與紀錄推算差 {bank.diff >= 0 ? '多' : '少'} {Math.abs(bank.diff).toLocaleString()} 元——可能有未記的入金/出金/股利、手續費折讓設定不符、或利息/借券費。</div>
      )}
      {calc.schedule.length > 0 && (
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)', marginBottom: 10, padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--text-muted)' }}>📅 未交割排程（T+2）</div>
          {calc.schedule.map(s => (
            <div key={s.date} style={{ display: 'flex', gap: 10, fontFamily: "'JetBrains Mono',monospace", fontSize: 'calc(12.5px * var(--fz))' }}>
              <span>{s.date}</span>
              {s.deduct > 0 && <span style={{ color: '#ef4444' }}>扣款 −{s.deduct.toLocaleString()}</span>}
              {s.credit > 0 && <span style={{ color: '#f03e3e' }}>入帳 +{s.credit.toLocaleString()}</span>}
              {s.deduct > 0 && s.credit > 0 && <span style={{ color: 'var(--text-muted)' }}>淨額 {s.credit - s.deduct >= 0 ? '+' : '−'}{Math.abs(Math.round(s.credit - s.deduct)).toLocaleString()}</span>}
              {s.sells > 0 && <span title="以全部交易紀錄重放帳本計算（成本含買進手續費、賣出已扣手續費與證交稅）" style={{ fontWeight: 700, color: s.pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>實現損益 {s.pnl >= 0 ? '+' : '−'}{Math.abs(Math.round(s.pnl)).toLocaleString()}（{s.sells} 筆賣出）</span>}
              {s.unmatched > 0 && <span style={{ color: '#f59e0b' }}>⚠ {s.unmatched} 張無買進紀錄可對應（未計損益）</span>}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10, padding: 10, background: 'var(--bg-tertiary)', borderRadius: 8 }}>
          <select className="input" value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as Entry['type'] }))} style={{ width: 90 }}>
            {Object.entries(TYPES).map(([v, x]) => <option key={v} value={v}>{x.t}</option>)}
          </select>
          <input className="input" type="number" min="1" placeholder="金額(元)" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') add(); }} style={{ width: 130 }} />
          <input className="input" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={{ width: 150 }} />
          <button onClick={add} disabled={!form.amount} className="btn btn-buy" style={{ fontSize: 'calc(12.5px * var(--fz))' }}>加入</button>
          {!hasLedger && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', flexBasis: '100%' }}>首次使用：先記一筆「入金」= 你投入這個帳戶的初始資金總額，之後有入金/出金/股利再各記一筆。</span>}
        </div>
      )}

      {hasLedger && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: 8, marginBottom: 10 }}>
            {[
              bank
                ? { l: '現金（銀行為準·交割後）', v: wan(cashUsed), c: cashUsed < 0 ? '#ef4444' : 'var(--text-primary)' }
                : { l: '現金餘額(帳本推算)', v: wan(calc.cash), c: calc.cash < 0 ? '#ef4444' : 'var(--text-primary)' },
              { l: '淨投入本金', v: wan(calc.netDeposits), c: 'var(--text-primary)' },
              { l: '持股現值＋現金', v: wan(calc.mv + cashUsed), c: 'var(--text-primary)' },
              { l: '帳戶總報酬', v: `${totalReturnUsed >= 0 ? '+' : ''}${wan(totalReturnUsed)}${retPctUsed != null ? `（${retPctUsed >= 0 ? '+' : ''}${retPctUsed.toFixed(1)}%）` : ''}`, c: totalReturnUsed >= 0 ? 'var(--color-up)' : 'var(--color-down)' },
            ].map(x => (
              <div key={x.l} style={{ padding: '8px 10px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{x.l}</div>
                <div style={{ fontWeight: 800, fontSize: 'calc(0.95rem * var(--fz))', color: x.c, fontFamily: "'JetBrains Mono',monospace" }}>{x.v}</div>
              </div>
            ))}
          </div>
          {calc.cash < 0 && <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#ef4444', marginBottom: 8 }}>⚠ 現金餘額為負：入金紀錄少於實際（請補記初始入金）。</div>}
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: 6 }}>
            自動帶入：買入扣款 −{wan(calc.buys)} · 賣出入帳 +{wan(calc.sells)}｜手動：入金 +{wan(calc.deposits)} · 出金 −{wan(calc.withdraws)} · 股利 +{wan(calc.dividends)}
            {bank && <>｜帳本推算現金 {wan(calc.cash)}（與銀行差 {bank.diff >= 0 ? '+' : ''}{wan(bank.diff)}，上方數字以銀行為準）</>}
          </div>
          <div style={{ maxHeight: 150, overflowY: 'auto' }}>
            {entries.map(e => (
              <div key={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'calc(13px * var(--fz))', padding: '4px 0', borderBottom: '1px solid var(--border-primary)' }}>
                <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{e.date}</span>
                <span style={{ fontWeight: 700, color: TYPES[e.type].c }}>{TYPES[e.type].t}</span>
                <span style={{ marginLeft: 'auto', fontFamily: "'JetBrains Mono',monospace" }}>{TYPES[e.type].sign > 0 ? '+' : '−'}{e.amount.toLocaleString()}</span>
                <button onClick={() => save(entries.filter(x => x.id !== e.id))} style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 7px', borderRadius: 6, background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)', cursor: 'pointer' }}>🗑</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
