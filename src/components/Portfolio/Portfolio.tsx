'use client';

import { useMemo, useRef, useState, useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import type { TradeRecord } from '@/lib/store';
import { useLiveQuotes } from '@/lib/useLiveQuotes';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import PortfolioAI from './PortfolioAI';
import PortfolioAlerts from './PortfolioAlerts';
import PortfolioSummary from './PortfolioSummary';
import PortfolioTradeReview from './PortfolioTradeReview';
import PortfolioRisk from './PortfolioRisk';
import PortfolioAlertRules from './PortfolioAlertRules';
import ThesisCards from './ThesisCards';
import RebalancePanel from './RebalancePanel';
import MonthlyReport from './MonthlyReport';
import RotationAdvice from './RotationAdvice';
import PushSetup from './PushSetup';
import ShadowAccount from './ShadowAccount';
import CashLedger from './CashLedger';
import { tradeCost, netRealizedPnL, taxRateLabel, isEtf , fmtQty, calcFee, calcTax } from '@/lib/tw-fee';
import { buildLedger, periodReturns, type Ledger } from '@/lib/portfolio-calc';
import { useBrokerSettings } from '@/lib/useBrokerSettings';
import { settleDate, isSettled, tradingDaysUntilSettle } from '@/lib/tw-settlement';
import { useChipVerdicts, VerdictBadge, VerdictStrip } from '@/components/shared/ChipVerdict';
import WeeklyReport from './WeeklyReport';
import DefenseBanner from './DefenseBanner';
import DividendTaxCalc from './DividendTaxCalc';
import RiskBadge from '@/components/shared/RiskBadge';
import { useDataUid } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import styles from './Portfolio.module.css';
import PageHelp from '@/components/Help/PageHelp';
import CardBoundary from '@/components/shared/CardBoundary';
import { useShallow } from 'zustand/react/shallow';
import { useDayTradeCodes, statusOf } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';

const COLORS = ['#3d8ef8', '#22c55e', '#f59e0b', '#a78bfa', '#ec4899', '#06b6d4', '#84cc16', '#f97316'];

// Centered ±報酬率 gauge: middle = 0%, right = 獲利(紅), left = 虧損(綠).
// Bar length grows with |報酬率| (clamped to ±30% for display).
function ProfitGauge({ pct, range = 30 }: { pct: number; range?: number }) {
  const clamped = Math.max(-range, Math.min(range, pct));
  const pos = ((clamped + range) / (2 * range)) * 100; // 0..100, 50 = 0%
  const up = pct >= 0;
  const left = Math.min(pos, 50);
  const width = Math.abs(pos - 50);
  return (
    <div style={{ position: 'relative', height: 10, borderRadius: 5, background: 'var(--bg-tertiary)' }}>
      <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: 'var(--border-primary)' }} />
      <div style={{
        position: 'absolute', top: 0, bottom: 0, left: `${left}%`, width: `${Math.max(width, 0.5)}%`,
        borderRadius: 5, background: up ? 'var(--color-up)' : 'var(--color-down)', transition: 'all 0.3s ease',
      }} />
    </div>
  );
}

// ─── Add Trade Modal ─────────────────────────────────────────────────────

function AddTradeModal({ onClose }: { onClose: () => void }) {
  const { addTradeRecord, allStocks, holdings, tradeRecords } = useAppStore(useShallow((s) => ({ addTradeRecord: s.addTradeRecord, allStocks: s.allStocks, holdings: s.holdings, tradeRecords: s.tradeRecords })));
  const [broker] = useBrokerSettings();
  const [form, setForm] = useState({
    type: 'buy' as 'buy' | 'sell' | 'dividend',
    code: '',
    name: '',
    price: '',
    quantity: '',
    unit: (typeof window !== 'undefined' && localStorage.getItem('tradeUnit') === 'share' ? 'share' : 'lot') as 'lot' | 'share',   // 張/股·記住上次選擇（零股使用者不必每次重切）
    date: new Date().toISOString().split('T')[0],
    note: '',
    dayTrade: false,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const codeInputRef = useRef<HTMLInputElement>(null);
  const [showSearch, setShowSearch] = useState(false);

  const matchedStocks = useMemo(() => {
    if (!searchQuery || searchQuery.length < 1) return [];
    return allStocks
      .filter(s => /^\d{4,5}$/.test(s.code) && (s.code.includes(searchQuery) || s.name.includes(searchQuery)))
      .slice(0, 8);
  }, [searchQuery, allStocks]);

  // 賣出成本基準：**交易紀錄帳本優先**（加權平均、含買進手續費），手動持倉只當備援。
  // 2026-08-01 教訓：舊版只看手動持倉的 buyPrice，與交易紀錄脫鉤時
  // 存出 costBasis 4985 vs 帳上 4585（大立光）、226 vs 26（華邦電）這種鬼數字。
  const ledger = useMemo(() => buildLedger(tradeRecords), [tradeRecords]);
  const basisFromLedger = form.type === 'sell' && form.code
    ? (ledger.byCode[form.code]?.openLots ?? 0) > 0.0005 : false;
  const avgCostBasis = useMemo(() => {
    if (!form.code || form.type !== 'sell') return 0;
    const led = ledger.byCode[form.code];
    if (led && led.openLots > 0.0005) return led.avgCost;
    const stockHoldings = holdings.filter(h => h.code === form.code);
    let totalShares = 0, totalCost = 0;
    stockHoldings.forEach(h => { totalShares += h.quantity * 1000; totalCost += h.buyPrice * h.quantity * 1000; });
    return totalShares > 0 ? totalCost / totalShares : 0;
  }, [form.code, form.type, holdings, ledger]);

  const price = parseFloat(form.price) || 0;
  const qtyRaw = parseFloat(form.quantity) || 0;
  const qty = form.unit === 'share' ? qtyRaw / 1000 : qtyRaw;   // 內部一律以「張」(可小數，0.35=350股)
  const taxOpts = { dayTrade: form.dayTrade, code: form.code };
  const cost = form.type === 'dividend'
    ? { gross: price * qty * 1000, fee: 0, tax: 0, net: price * qty * 1000 }
    : tradeCost(form.type, price, qty, broker, taxOpts);
  const fee = cost.fee, tax = cost.tax, grossAmount = cost.gross, totalAmount = cost.net;
  // 已實現淨損益（含買賣雙邊成本）。帳本基準已含買進費 → buyFee 傳 0 避免重複扣。
  const realized = form.type === 'sell' && avgCostBasis > 0
    ? netRealizedPnL(price, avgCostBasis, qty, broker, basisFromLedger ? { ...taxOpts, buyFee: 0 } : taxOpts)
    : undefined;
  const realizedPnL = realized?.pnl;

  const handleSubmit = () => {
    if (!form.code || price <= 0 || qty <= 0) {
      alert('請填入完整的交易資料！');
      return;
    }
    addTradeRecord({
      code: form.code,
      name: form.name,
      type: form.type,
      price,
      quantity: qty,
      fee,
      tax,
      totalAmount,
      date: form.date,
      note: form.note || undefined,
      realizedPnL,
      costBasis: avgCostBasis || undefined,
      dayTrade: form.dayTrade || undefined,
      unit: form.unit,          // 只影響顯示：'share' 一律寫成「N 股」不進位成張
    });
    onClose();
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        <div className={styles.modalHeader}>
          <h3>📝 新增交易紀錄</h3>
          <button className={styles.modalClose} onClick={onClose}>×</button>
        </div>
        <div className={styles.modalBody}>
          {/* Type selector */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
            {(['buy', 'sell', 'dividend'] as const).map(t => {
              const labels = { buy: '🔴 買入', sell: '🟢 賣出', dividend: '💰 股利' };  // 台股語意：買進=多方=紅、賣出=綠
              const colors = { buy: '#f03e3e', sell: '#2f9e44', dividend: '#f59e0b' };
              return (
                <button
                  key={t}
                  onClick={() => setForm(f => ({ ...f, type: t }))}
                  style={{
                    flex: 1, padding: '10px', borderRadius: '8px', fontSize: 'calc(14px * var(--fz))', fontWeight: 600,
                    background: form.type === t ? `${colors[t]}20` : 'var(--bg-tertiary)',
                    border: `2px solid ${form.type === t ? colors[t] : 'transparent'}`,
                    color: form.type === t ? colors[t] : 'var(--text-secondary)',
                    cursor: 'pointer', transition: 'all 0.15s',
                  }}
                >{labels[t]}</button>
              );
            })}
          </div>

          {/* 當沖選項（買/賣才顯示；證交稅減半 0.15%） */}
          {form.type !== 'dividend' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.dayTrade} onChange={e => setForm(f => ({ ...f, dayTrade: e.target.checked }))} />
              現股當沖（證交稅減半 0.15%）
            </label>
          )}

          {/* Stock search */}
          <div className={styles.formGroup}>
            <label>股票代號</label>
            <div style={{ position: 'relative' }}>
              {/* ⚠ 這個搜尋框**必須是非受控（uncontrolled）**——不要改回 value={...}。
                     成因（Header.tsx:41 已記錄過同一件事，這次是漏推廣）：
                     父元件每次重渲染，React 就把 controlled value 回寫進 DOM；
                     手機 IME 下這個回寫會把**游標打回開頭**，於是後續字元插在最前面：
                     輸入 3008 變成 8003（Header 那次是 2527 變 7252）。
                     本元件的父層有即時報價輪詢（useLiveQuotes / setInterval），
                     重渲染比 Header 當年的時鐘更頻繁，所以更容易中。
                     ⇒ 顯示用 defaultValue + ref 手動寫入；state 只餵搜尋邏輯。 */}
              <input
                className="input"
                ref={codeInputRef}
                placeholder="輸入代號或名稱搜尋"
                defaultValue=""
                onChange={e => {
                  setSearchQuery(e.target.value);
                  setForm(f => ({ ...f, code: '', name: '' }));
                  setShowSearch(true);
                }}
                onFocus={() => setShowSearch(true)}
              />
              {showSearch && matchedStocks.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
                  borderRadius: '8px', maxHeight: '200px', overflowY: 'auto', marginTop: '4px',
                  boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                }}>
                  {matchedStocks.map(s => (
                    <div
                      key={s.code}
                      onClick={() => {
                        setForm(f => ({ ...f, code: s.code, name: s.name }));
                        setShowSearch(false);
                        setSearchQuery('');
                        // 非受控：選取後由我們自己把顯示值寫進 DOM
                        if (codeInputRef.current) codeInputRef.current.value = `${s.code} ${s.name}`;
                      }}
                      style={{
                        padding: '10px 14px', cursor: 'pointer', fontSize: 'calc(13px * var(--fz))',
                        display: 'flex', justifyContent: 'space-between',
                        borderBottom: '1px solid var(--border-primary)',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-tertiary)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <span style={{ fontWeight: 600 }}>{s.code}</span>
                      <span style={{ color: 'var(--text-muted)' }}>{s.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Price / Quantity */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px' }}>
            <div className={styles.formGroup}>
              <label>{form.type === 'dividend' ? '每股股利' : '成交價（每股）'}</label>
              <input
                className="input" type="number" step="0.01"
                value={form.price}
                onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
              />
            </div>
            <div className={styles.formGroup}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{form.type === 'dividend' ? '持有數量' : '數量'}</span>
                <span style={{ display: 'inline-flex', border: '1px solid var(--border-primary)', borderRadius: 6, overflow: 'hidden' }}>
                  {(['lot', 'share'] as const).map(u => (
                    <button key={u} type="button" onClick={() => { localStorage.setItem('tradeUnit', u); setForm(f => ({ ...f, unit: u })); }}
                      style={{ padding: '2px 10px', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, border: 'none', cursor: 'pointer',
                        background: form.unit === u ? 'var(--accent-primary, #3d8ef8)' : 'var(--bg-tertiary)',
                        color: form.unit === u ? '#fff' : 'var(--text-secondary)' }}>
                      {u === 'lot' ? '張' : '股(零股)'}
                    </button>
                  ))}
                </span>
              </label>
              <input
                className="input" type="number" min="1" step={form.unit === 'share' ? 1 : 'any'}
                placeholder={form.unit === 'share' ? '股數（例 1313）' : '張數（可小數，0.35=350股）'}
                value={form.quantity}
                onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
              />
              {form.unit === 'share' && qtyRaw > 0 && (
                <span className={styles.inputHelper}>
                  {/* 零股模式不進位成張：1313 股就寫 1313 股（2026-08-12 使用者指定） */}
                  ＝ {fmtQty(qtyRaw / 1000, 'share')}
                  {qtyRaw >= 1000 && <span style={{ color: 'var(--text-muted)' }}>（＝ {fmtQty(qtyRaw / 1000)}）</span>}
                  （零股費率同 0.1425%，低消以 1 元計）
                </span>
              )}
            </div>
          </div>

          {/* Date */}
          <div className={styles.formGroup}>
            <label>交易日期</label>
            <input
              className="input" type="date"
              value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
            />
          </div>

          {/* Note */}
          <div className={styles.formGroup}>
            <label>備注</label>
            <input
              className="input" type="text" placeholder="可選填"
              value={form.note}
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
            />
          </div>

          {/* Cost Preview */}
          {price > 0 && qty > 0 && (
            <div className={styles.costPreview} style={{ marginTop: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '8px', fontSize: 'calc(12.5px * var(--fz))' }}>
                <div>成交金額：<strong>{grossAmount.toLocaleString()} 元</strong></div>
                <div>手續費(0.1425%{broker.discount < 1 ? `×${broker.discount}折讓` : ''})：<strong>{fee.toLocaleString()} 元</strong>{fee === broker.minFee && grossAmount > 0 ? <span style={{ color: 'var(--text-muted)' }}> 最低</span> : null}</div>
                {form.type === 'sell' && <div>交易稅({taxRateLabel({ dayTrade: form.dayTrade, code: form.code })})：<strong>{tax.toLocaleString()} 元</strong></div>}
                {form.type !== 'dividend' && <div>交割日(T+2)：<strong>{settleDate(form.date)}</strong></div>}
                <div style={{ gridColumn: '1/-1', borderTop: '1px solid var(--border-primary)', paddingTop: '8px' }}>
                  {form.type === 'buy' ? '💰 實際支出' : form.type === 'sell' ? '💰 實際收入' : '💰 股利收入'}：
                  <strong style={{ fontSize: 'calc(14.5px * var(--fz))', color: form.type === 'sell' ? 'var(--color-up)' : 'var(--text-primary)' }}>
                    {' '}{Math.abs(totalAmount).toLocaleString()} 元
                  </strong>
                </div>
                {realized && (
                  <div style={{
                    gridColumn: '1/-1', padding: '8px 12px', borderRadius: '6px',
                    background: realized.pnl >= 0 ? 'rgba(240,62,62,0.1)' : 'rgba(47,158,68,0.1)',
                    color: realized.pnl >= 0 ? '#f03e3e' : '#2f9e44', fontWeight: 600,
                  }}>
                    實際獲利（扣雙邊費稅）：{realized.pnl >= 0 ? '+' : ''}{realized.pnl.toLocaleString()} 元
                    <span style={{ fontWeight: 700 }}>（{realized.roi >= 0 ? '+' : ''}{realized.roi}%）</span>
                    <div style={{ fontSize: 'calc(12.5px * var(--fz))', marginTop: 4, opacity: 0.85, fontWeight: 400 }}>
                      成本均價 {avgCostBasis.toFixed(2)}{basisFromLedger ? '（依交易紀錄加權·含買進費）' : '（依手動持倉·另估買進費）'}｜賣出手續費 −{realized.sellFee.toLocaleString()}｜證交稅 −{realized.tax.toLocaleString()}{!basisFromLedger ? `｜買進手續費 −${realized.buyFee.toLocaleString()}` : ''}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        <div className={styles.modalFooter}>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button
            className="btn btn-buy"
            style={{
              background: form.type === 'sell' ? '#ef4444' : form.type === 'dividend' ? '#f59e0b' : undefined,
            }}
            onClick={handleSubmit}
          >
            記錄{form.type === 'buy' ? '買入' : form.type === 'sell' ? '賣出' : '股利'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Trade Modal ────────────────────────────────────────────────────
// 修錯價/錯量的入口（實例：華邦電買價記成 26，帳本重算後才浮出）。
// 儲存時依新值重算費/稅/淨額；存死的 realizedPnL 由 store 清除，顯示一律走帳本。

function EditTradeModal({ trade, onClose }: { trade: TradeRecord; onClose: () => void }) {
  const updateTradeRecord = useAppStore(s => s.updateTradeRecord);
  const [broker] = useBrokerSettings();
  const [form, setForm] = useState({
    price: String(trade.price),
    quantity: String(trade.quantity),
    date: trade.date,
    note: trade.note || '',
    dayTrade: !!trade.dayTrade,
  });
  const price = parseFloat(form.price) || 0;
  const qty = parseFloat(form.quantity) || 0;
  const cost = trade.type === 'dividend'
    ? { gross: Math.round(price * qty * 1000), fee: 0, tax: 0, net: Math.round(price * qty * 1000) }
    : tradeCost(trade.type, price, qty, broker, { dayTrade: form.dayTrade, code: trade.code });
  const save = () => {
    if (price <= 0 || qty <= 0 || !form.date) { alert('請輸入正確的價格、張數與日期！'); return; }
    updateTradeRecord(trade.id, {
      price, quantity: qty, date: form.date, note: form.note || undefined,
      dayTrade: form.dayTrade || undefined,
      fee: cost.fee, tax: cost.tax, totalAmount: cost.net,
    });
    onClose();
  };
  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <div className={styles.modalHeader}>
          <h3>✏️ 修改交易 — {trade.code} {trade.name}（{trade.type === 'buy' ? '買入' : trade.type === 'sell' ? '賣出' : '股利'}）</h3>
          <button className={styles.modalClose} onClick={onClose}>×</button>
        </div>
        <div className={styles.modalBody}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <div className={styles.formGroup}>
              <label>{trade.type === 'dividend' ? '每股股利' : '成交價（每股）'}</label>
              <input className="input" type="number" step="0.01" value={form.price}
                onChange={e => setForm(f => ({ ...f, price: e.target.value }))} />
            </div>
            <div className={styles.formGroup}>
              <label>張數（0.35 = 350 股）</label>
              <input className="input" type="number" min="0.001" step="0.001" value={form.quantity}
                onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} />
            </div>
          </div>
          <div className={styles.formGroup}>
            <label>交易日期</label>
            <input className="input" type="date" value={form.date}
              onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
          </div>
          {trade.type !== 'dividend' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 'calc(13px * var(--fz))', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.dayTrade} onChange={e => setForm(f => ({ ...f, dayTrade: e.target.checked }))} />
              現股當沖（證交稅減半 0.15%）
            </label>
          )}
          <div className={styles.formGroup}>
            <label>備注</label>
            <input className="input" type="text" value={form.note}
              onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
          </div>
          {price > 0 && qty > 0 && (
            <div className={styles.costPreview}>
              重算後：{fmtQty(qty)} × {price.toLocaleString()} 元
              {trade.type !== 'dividend' && <>｜手續費 {cost.fee.toLocaleString()}{cost.tax > 0 ? `｜稅 ${cost.tax.toLocaleString()}` : ''}</>}
              ｜{trade.type === 'buy' ? '實際支出' : trade.type === 'sell' ? '實際收入' : '入帳'} <strong>{Math.abs(cost.net).toLocaleString()} 元</strong>
              <div style={{ fontSize: 'calc(12.5px * var(--fz))', marginTop: 4, opacity: 0.8 }}>儲存後，此筆與相關賣出的已實現損益會依交易紀錄整體重算。</div>
            </div>
          )}
        </div>
        <div className={styles.modalFooter}>
          <button className="btn btn-ghost" onClick={onClose}>取消</button>
          <button className="btn btn-buy" onClick={save}>儲存修改</button>
        </div>
      </div>
    </div>
  );
}

// ─── Trade History Panel ─────────────────────────────────────────────────

function TradeHistoryPanel({ ledger }: { ledger: Ledger }) {
  const { tradeRecords, removeTradeRecord, navigateTo } = useAppStore(useShallow((s) => ({ tradeRecords: s.tradeRecords, removeTradeRecord: s.removeTradeRecord, navigateTo: s.navigateTo })));
  const [filter, setFilter] = useState<'all' | 'buy' | 'sell' | 'dividend'>('all');
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingTrade, setEditingTrade] = useState<TradeRecord | null>(null);
  // 帳本重算的平倉結果（以交易紀錄為唯一真相；存死的 realizedPnL 只當核對參考）
  const closedById = useMemo(() => new Map(ledger.closed.map(c => [c.id, c])), [ledger]);
  const monthRealized = useMemo(() => {
    const m: Record<string, number> = {};
    ledger.monthly.forEach(x => { m[x.month] = x.realized; });
    return m;
  }, [ledger]);

  const filtered = useMemo(() => {
    const records = filter === 'all' ? tradeRecords : tradeRecords.filter(t => t.type === filter);
    return [...records].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [tradeRecords, filter]);

  // Group by month
  const grouped = useMemo(() => {
    const groups: Record<string, TradeRecord[]> = {};
    filtered.forEach(t => {
      const month = t.date.slice(0, 7); // YYYY-MM
      if (!groups[month]) groups[month] = [];
      groups[month].push(t);
    });
    return Object.entries(groups);
  }, [filtered]);

  const typeConfig = {
    buy: { label: '買入', icon: '🔴', color: '#f03e3e', bg: 'rgba(240,62,62,0.08)' },
    sell: { label: '賣出', icon: '🟢', color: '#2f9e44', bg: 'rgba(47,158,68,0.08)' },
    dividend: { label: '股利', icon: '💰', color: '#f59e0b', bg: 'rgba(245,158,11,0.08)' },
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px',
      }}>
        {/* ⚠ 內層也要 wrap（2026-08-11 手機回報）：外層 flexWrap 只讓「篩選列」與
            「＋新增交易」互相換行，管不到這裡面。四顆鈕合計 ~358px > 手機 335px，
            不換行就會被壓縮，「🔴 買入(24)」被切成「入(24)」。 */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {(['all', 'buy', 'sell', 'dividend'] as const).map(f => {
            {/* 台股語意：買進=紅、賣出=綠（與新增視窗、列表徽章一致；先前這裡顛倒） */}
            const labels = { all: '全部', buy: '🔴 買入', sell: '🟢 賣出', dividend: '💰 股利' };
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '6px 14px', borderRadius: '20px', fontSize: 'calc(12.5px * var(--fz))', fontWeight: 600,
                  background: filter === f ? 'var(--accent-purple, #7c3aed)' : 'var(--bg-tertiary)',
                  color: filter === f ? '#fff' : 'var(--text-secondary)',
                  border: 'none', cursor: 'pointer', transition: 'all 0.15s',
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >{labels[f]} {f === 'all' ? `(${tradeRecords.length})` : `(${tradeRecords.filter(t => t.type === f).length})`}</button>
            );
          })}
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          style={{
            padding: '8px 18px', borderRadius: '8px', fontSize: 'calc(13px * var(--fz))', fontWeight: 600,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: '#fff', border: 'none', cursor: 'pointer',
            boxShadow: '0 2px 12px rgba(99,102,241,0.3)',
          }}
        >+ 新增交易</button>
      </div>

      {/* Trade List */}
      {filtered.length === 0 ? (
        <div style={{ padding: '60px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 'calc(48px * var(--fz))', marginBottom: '12px' }}>📝</div>
          <div style={{ fontSize: 'calc(14.5px * var(--fz))', marginBottom: '6px' }}>尚未記錄任何交易</div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', opacity: 0.7 }}>點擊「新增交易」開始記錄你的買賣紀錄</div>
        </div>
      ) : (
        grouped.map(([month, records]) => (
          <div key={month}>
            <div style={{
              fontSize: 'calc(12.5px * var(--fz))', fontWeight: 600, color: 'var(--text-muted)',
              padding: '8px 0', borderBottom: '1px solid var(--border-primary)',
              letterSpacing: '0.05em', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6,
            }}>
              <span>📅 {month.replace('-', ' 年 ')} 月 · {records.length} 筆</span>
              {monthRealized[month] != null && monthRealized[month] !== 0 && (
                <span style={{ fontFamily: "'JetBrains Mono', monospace", color: monthRealized[month] >= 0 ? '#f03e3e' : '#2f9e44' }}>
                  本月已實現 {monthRealized[month] >= 0 ? '+' : ''}{Math.round(monthRealized[month]).toLocaleString()} 元
                </span>
              )}
            </div>
            {records.map(t => {
              const cfg = typeConfig[t.type];
              return (
                <div key={t.id} className={styles.txRow}>
                  {/* Stock + Type */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        onClick={() => navigateTo('stock', t.code)}
                        style={{ fontWeight: 700, fontSize: 'calc(14px * var(--fz))', color: 'var(--text-primary)', cursor: 'pointer' }}
                      >{t.code}</span>
                      <span style={{
                        fontSize: 'calc(12.5px * var(--fz))', padding: '2px 8px', borderRadius: '4px',
                        background: cfg.bg, color: cfg.color, fontWeight: 600,
                      }}>{cfg.label}</span>
                    </div>
                    <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{t.name}</span>
                    <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>{t.date}</span>
                  </div>

                  {/* Price + Qty */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {t.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{fmtQty(t.quantity, t.unit)}</span>
                  </div>

                  {/* Amount + PnL */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {/* 現金流以「支出/收入」中性呈現——紅綠語意保留給損益（獲利紅/虧損綠），
                        避免買入成本的負號被誤讀為虧損 */}
                    <span style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {t.type === 'buy' ? '支出 ' : t.type === 'sell' ? '收入 ' : '入帳 '}{Math.abs(t.totalAmount).toLocaleString()} 元
                    </span>
                    {t.fee > 0 && (
                      <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                        手續費 {t.fee.toLocaleString()}{t.tax > 0 ? ` + 稅 ${t.tax.toLocaleString()}` : ''}{t.dayTrade ? ' · 當沖' : ''}
                      </span>
                    )}
                    {(() => {
                      // 損益一律顯示帳本重算值；與紀錄當下存的值不符 → ⚠ 提醒核對
                      const c = closedById.get(t.id);
                      if (!c) return null;
                      return (
                        <span style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 600, color: c.pnl >= 0 ? '#f03e3e' : '#2f9e44' }}
                          title={`依交易紀錄重算：賣價 ${c.sellPrice} − 成本均價 ${c.avgCost.toFixed(2)}（含買進費）× ${fmtQty(c.lots, c.unit)}${c.mismatch ? `\n⚠ 紀錄當下存的是 ${c.storedPnL?.toLocaleString()}（用了過期的手動持倉成本）——以重算為準` : ''}`}>
                          實際獲利 {c.pnl >= 0 ? '+' : ''}{c.pnl.toLocaleString()}（{c.roi >= 0 ? '+' : ''}{c.roi}%）
                          {c.mismatch && <span style={{ color: '#f59e0b', marginLeft: 4 }}>⚠核對</span>}
                          {c.oversoldLots > 0 && <span style={{ color: '#f59e0b', marginLeft: 4 }}>⚠超賣{fmtQty(c.oversoldLots, c.unit)}</span>}
                        </span>
                      );
                    })()}
                    {/* 交割狀態（T+2） */}
                    {t.type !== 'dividend' && (() => {
                      const settled = isSettled(t.date);
                      const dleft = tradingDaysUntilSettle(t.date);
                      return (
                        <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 600, color: settled ? 'var(--text-muted)' : '#f59e0b' }}>
                          {settled ? `✓ 已交割 ${settleDate(t.date)}` : `⏳ ${settleDate(t.date)} 交割${dleft === 0 ? '(今日)' : `(還 ${dleft} 交易日)`}`}
                        </span>
                      );
                    })()}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => setEditingTrade(t)}
                      title="修改此筆交易（修錯價/錯量）"
                      style={{
                        padding: '4px 8px', borderRadius: '6px', fontSize: 'calc(12.5px * var(--fz))',
                        background: 'var(--bg-tertiary)', color: 'var(--text-secondary)',
                        border: '1px solid var(--border-primary)', cursor: 'pointer',
                      }}
                    >✏️</button>
                    <button
                      onClick={() => {
                        if (confirm(`確定要刪除 ${t.date} ${typeConfig[t.type].label} ${t.code} 的紀錄嗎？`))
                          removeTradeRecord(t.id);
                      }}
                      style={{
                        padding: '4px 8px', borderRadius: '6px', fontSize: 'calc(12.5px * var(--fz))',
                        background: 'rgba(239,68,68,0.08)', color: '#ef4444',
                        border: '1px solid rgba(239,68,68,0.2)', cursor: 'pointer',
                      }}
                    >🗑️</button>
                  </div>
                </div>
              );
            })}
          </div>
        ))
      )}

      {showAddModal && <AddTradeModal onClose={() => setShowAddModal(false)} />}
      {editingTrade && <EditTradeModal trade={editingTrade} onClose={() => setEditingTrade(null)} />}
    </div>
  );
}

// ─── Analytics Panel ─────────────────────────────────────────────────────

function AnalyticsPanel({ ledger }: { ledger: Ledger }) {
  const { tradeRecords, allStocks } = useAppStore(useShallow((s) => ({ tradeRecords: s.tradeRecords, allStocks: s.allStocks })));
  const [broker] = useBrokerSettings();
  // 現價來源：與持倉總覽**同一個** hook（原本這裡是自己 fetch 一次就不再更新，
  // 於是總覽每 5 秒跳動、這一頁停在剛進頁面那一刻的價格——同一個未實現損益兩個數字）。
  const openCodes = useMemo(() => ledger.openPositions.map(p => p.code), [ledger]);
  const liveQuotes = useLiveQuotes(openCodes);

  // 未實現：帳本現存部位，**扣費稅後**（與總覽頭條同口徑）。
  // 原本這裡是毛額 (px − avgCost)×股數，總覽卻是淨額，
  // 兩張卡都叫「未實現損益」但差一整筆賣出費稅（合成資料實測差 20,696 元）。
  const unreal = useMemo(() => {
    let net = 0, gross = 0, feeTax = 0;
    for (const p of ledger.openPositions) {
      const px = liveQuotes[p.code]?.price ?? allStocks.find(s => s.code === p.code)?.price ?? p.avgCost;
      const shares = p.lots * 1000;
      // avgCost 已含買進費 ⇒ 這裡只要再扣賣出手續費與證交稅
      const sellFee = calcFee(px, p.lots, broker);
      const tax = calcTax(px, p.lots, { code: p.code });
      gross += (px - p.avgCost) * shares;
      feeTax += sellFee + tax;
      net += (px - p.avgCost) * shares - sellFee - tax;
    }
    return { net, gross, feeTax };
  }, [ledger, liveQuotes, allStocks, broker]);
  const unrealizedPnL = unreal.net;

  const monthlyData = useMemo(() => ledger.monthly.slice(-12).map(m => ({ month: m.month, pnl: m.realized, dividend: m.dividend })), [ledger]);

  // 個股彙總（已實現＋股利＋現存部位）
  const stockRanking = useMemo(() =>
    Object.values(ledger.byCode)
      .filter(l => l.closed.length > 0 || l.dividend > 0)
      .map(l => ({ code: l.code, name: l.name, pnl: Math.round(l.realized), dividend: Math.round(l.dividend), trades: l.closed.length, openLots: l.openLots }))
      .sort((a, b) => (b.pnl + b.dividend) - (a.pnl + a.dividend)),
  [ledger]);

  if (tradeRecords.length === 0) {
    return (
      <div style={{ padding: '60px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: 'calc(48px * var(--fz))', marginBottom: '12px' }}>📈</div>
        <div style={{ fontSize: 'calc(14.5px * var(--fz))', marginBottom: '6px' }}>尚無交易紀錄可供分析</div>
        <div style={{ fontSize: 'calc(12.5px * var(--fz))', opacity: 0.7 }}>新增交易紀錄後即可查看損益分析</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* AI 交易覆盤 (常駐 daemon LLM)——傳帳本進去比對，過期會自我標示 */}
      <PortfolioTradeReview ledger={ledger} />

      {/* 口徑說明：全部由交易紀錄重算（單位：元／張） */}
      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8 }}>
        📐 本頁全部數字由「交易紀錄」按時間重放重算（加權平均成本·含買進手續費），金額單位＝元、數量單位＝張。
        與紀錄當下存的值不符的筆數會列在下方「資料核對」。
      </div>

      {/* Summary Stats */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(200px, 100%), 1fr))', gap: '12px',
      }}>
        {[
          { label: '已實現損益（重算）', value: ledger.totalRealized, isMoney: true, color: ledger.totalRealized >= 0 ? '#f03e3e' : '#2f9e44',
            sub: `${ledger.closedCount} 筆平倉` },
          { label: '未實現損益（推算持倉·扣費稅）', value: unrealizedPnL, isMoney: true, color: unrealizedPnL >= 0 ? '#f03e3e' : '#2f9e44',
            sub: ledger.openPositions.length
              ? `${ledger.openPositions.length} 檔在倉｜毛 ${unreal.gross >= 0 ? '+' : ''}${Math.round(unreal.gross).toLocaleString()}·費稅 −${Math.round(unreal.feeTax).toLocaleString()}`
              : '目前空手' },
          { label: '累計股利', value: ledger.totalDividend, isMoney: true, color: '#f59e0b' },
          { label: '手續費累計', value: -ledger.totalFee, isMoney: true, color: '#94a3b8', sub: '買賣雙邊' },
          { label: '證交稅累計', value: -ledger.totalTax, isMoney: true, color: '#94a3b8', sub: '賣出時課徵' },
          { label: '勝率', value: ledger.winRate, isPct: true, color: ledger.winRate >= 50 ? '#f03e3e' : '#2f9e44',
            sub: `${ledger.winCount} 勝 / ${ledger.lossCount} 負 / ${ledger.closedCount} 筆` },
          { label: '每筆平倉期望值', value: ledger.expectancy, isMoney: true, color: ledger.expectancy >= 0 ? '#f03e3e' : '#2f9e44',
            sub: '已實現 ÷ 平倉筆數' },
          { label: '總交易筆數', value: tradeRecords.length, color: 'var(--text-primary)',
            sub: `買 ${tradeRecords.filter(t => t.type === 'buy').length} / 賣 ${tradeRecords.filter(t => t.type === 'sell').length} / 股利 ${tradeRecords.filter(t => t.type === 'dividend').length}` },
        ].map((card, i) => (
          <div key={i} style={{
            padding: '16px', borderRadius: '12px',
            background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
          }}>
            <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.04em' }}>{card.label}</div>
            {/* ⚠ 單位「元」必須貼在數字後面（2026-08-11 手機回報）：
                原本它是**獨立的 <div>**，所以永遠自己佔一行，而且被排在說明文字之下——
                畫面讀起來是「+12,817 / 已實現÷平倉筆數 / 元」，
                單位跟它要修飾的數字隔了一行，看起來像多出來的贅字。
                同一行 + nowrap，數字與單位就不會被拆開。 */}
            <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: card.color, fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
              {card.isMoney
                ? `${(card.value as number) >= 0 ? '+' : ''}${(card.value as number).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`
                : card.isPct
                ? `${(card.value as number).toFixed(1)}%`
                : card.value.toLocaleString()}
              {card.isMoney && <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 600, color: 'var(--text-muted)', marginLeft: 4 }}>元</span>}
            </div>
            {card.sub && <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.5 }}>{card.sub}</div>}
          </div>
        ))}
      </div>

      {/* Profit Gauge */}
      {ledger.closedCount > 0 && (
        <div style={{
          padding: '16px', borderRadius: '12px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        }}>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: '12px' }}>📊 平均獲利 vs 平均虧損（每筆平倉）</div>
          {/* ⚠ 這三欄必須可換行（2026-08-11 手機回報）：
              原本 flex 不換行、每欄 flex:1，手機上每欄只剩 ~89px，
              但「+276,766 元」要 ~110px → 欄位撐開、「盈虧比」被擠出卡片外被切掉，
              而且「元」被推到下一行。
              改成 flex-basis 120px 可換行：窄螢幕自然變成兩行三欄，數值不再被拆。 */}
          <div style={{ display: 'flex', gap: '12px', rowGap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ flex: '1 1 120px', minWidth: 0 }}>
              <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#f03e3e', marginBottom: '4px' }}>平均獲利</div>
              <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: '#f03e3e', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                +{ledger.avgWin.toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元
              </div>
            </div>
            <div style={{ width: '1px', height: '40px', background: 'var(--border-primary)', flexShrink: 0 }} />
            <div style={{ flex: '1 1 120px', minWidth: 0 }}>
              <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#2f9e44', marginBottom: '4px' }}>平均虧損</div>
              <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: '#2f9e44', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>
                {ledger.avgLoss.toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元
              </div>
            </div>
            <div style={{ width: '1px', height: '40px', background: 'var(--border-primary)', flexShrink: 0 }} />
            <div style={{ flex: '1 1 120px', minWidth: 0 }}>
              <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginBottom: '4px' }}>盈虧比</div>
              <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>
                {ledger.avgLoss !== 0 ? Math.abs(ledger.avgWin / ledger.avgLoss).toFixed(2) : '∞'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 資料核對：帳本重算 vs 紀錄當下存的值 */}
      {(ledger.mismatchCount > 0 || ledger.warnings.length > 0) && (
        <div style={{
          padding: '16px', borderRadius: '12px',
          background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.35)',
        }}>
          <div style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 700, color: '#f59e0b', marginBottom: '8px' }}>
            🔎 資料核對（{ledger.mismatchCount} 筆損益不一致{ledger.warnings.length ? `、${ledger.warnings.length} 項帳務警示` : ''}）
          </div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)', marginBottom: 10 }}>
            下列賣出「紀錄當下存的損益」與「依交易紀錄重算」不符——多半是當時手動持倉的成本價與交易紀錄脫鉤。
            全站顯示一律以重算為準；若是交易紀錄本身記錯價，請到「交易紀錄」分頁用 ✏️ 修正該筆。
          </div>
          {ledger.closed.filter(c => c.mismatch).map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '6px 0', borderBottom: '1px solid rgba(245,158,11,0.15)', fontSize: 'calc(12.5px * var(--fz))', flexWrap: 'wrap' }}>
              <span>{c.date} 賣出 <strong>{c.code} {c.name}</strong> {fmtQty(c.lots, c.unit)} @ {c.sellPrice}</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                存檔 {c.storedPnL != null ? (c.storedPnL >= 0 ? '+' : '') + Math.round(c.storedPnL).toLocaleString() : '—'}
                <span style={{ margin: '0 6px', color: 'var(--text-muted)' }}>→</span>
                重算 <strong style={{ color: c.pnl >= 0 ? '#f03e3e' : '#2f9e44' }}>{c.pnl >= 0 ? '+' : ''}{c.pnl.toLocaleString()}</strong>
                <span style={{ color: 'var(--text-muted)' }}>（成本均價 {c.avgCost.toFixed(2)}）</span>
              </span>
            </div>
          ))}
          {ledger.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#f59e0b', padding: '6px 0' }}>⚠ {w}</div>
          ))}
        </div>
      )}

      {/* 平倉明細（逐筆：日期/標的/張數/賣價/成本/損益/持有天數） */}
      {ledger.closed.length > 0 && (
        <div style={{
          padding: '16px', borderRadius: '12px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        }}>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: '10px' }}>🧾 平倉明細（新→舊·損益含買賣雙邊費稅）</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'calc(12.5px * var(--fz))', minWidth: 560 }}>
              <thead>
                <tr style={{ color: 'var(--text-muted)', textAlign: 'right' }}>
                  <th style={{ textAlign: 'left', padding: '4px 4px' }}>日期</th>
                  <th style={{ textAlign: 'left', padding: '4px 4px' }}>標的</th>
                  <th style={{ padding: '4px 4px' }}>張數</th>
                  <th style={{ padding: '4px 4px' }}>賣價</th>
                  <th style={{ padding: '4px 4px' }}>成本均價</th>
                  <th style={{ padding: '4px 4px' }}>損益(元)</th>
                  <th style={{ padding: '4px 4px' }}>報酬率</th>
                  <th style={{ padding: '4px 4px' }}>持有</th>
                </tr>
              </thead>
              <tbody>
                {ledger.closed.map(c => (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--border-primary)', textAlign: 'right' }}>
                    <td style={{ textAlign: 'left', padding: '4px 4px', whiteSpace: 'nowrap' }}>{c.date}</td>
                    <td style={{ textAlign: 'left', padding: '4px 4px', whiteSpace: 'nowrap' }}>
                      <strong>{c.code}</strong> <span style={{ color: 'var(--text-muted)' }}>{c.name}</span>
                      {c.dayTrade ? <span style={{ color: '#f59e0b' }}> 沖</span> : ''}
                      {(c.mismatch || c.oversoldLots > 0) && <span style={{ color: '#f59e0b' }}> ⚠</span>}
                    </td>
                    <td style={{ padding: '4px 4px', whiteSpace: 'nowrap' }}>{fmtQty(c.lots, c.unit)}</td>
                    <td style={{ padding: '4px 4px', fontFamily: "'JetBrains Mono', monospace" }}>{c.sellPrice.toLocaleString()}</td>
                    <td style={{ padding: '4px 4px', fontFamily: "'JetBrains Mono', monospace" }}>{c.avgCost > 0 ? c.avgCost.toFixed(2) : '—'}</td>
                    <td style={{ padding: '4px 4px', fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: c.pnl >= 0 ? '#f03e3e' : '#2f9e44' }}>
                      {c.pnl >= 0 ? '+' : ''}{c.pnl.toLocaleString()}
                    </td>
                    <td style={{ padding: '4px 4px', fontFamily: "'JetBrains Mono', monospace", color: c.pnl >= 0 ? '#f03e3e' : '#2f9e44' }}>
                      {c.avgCost > 0 ? `${c.roi >= 0 ? '+' : ''}${c.roi}%` : '—'}
                    </td>
                    <td style={{ padding: '4px 4px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                      {c.holdingDays != null ? `${c.holdingDays} 天` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Monthly PnL Chart */}
      {monthlyData.length > 0 && (
        <div style={{
          padding: '16px', borderRadius: '12px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        }}>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: '12px' }}>📊 月度損益走勢</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-primary)" />
              <XAxis
                dataKey="month"
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                tickFormatter={(v: string) => v.slice(5)} // Show MM only
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                // 單位一致：先前是 `v>=1000 ? k : 原值`，負值走不到 k 分支 →
                // 同一條軸上出現「1100k」與「-1100000」兩種寫法。改為依絕對值
                // 統一縮放，並用台股慣用的「萬」（220萬 比 2200k 好讀）。
                tickFormatter={(v: number) => {
                  const a = Math.abs(v);
                  if (a >= 10000) return `${(v / 10000).toFixed(0)}萬`;
                  return v.toLocaleString();
                }}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
                  borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))',
                }}
                labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 2 }}
                formatter={(v: any, name: any) => [
                  `${Number(v) >= 0 ? '+' : ''}${Number(v).toLocaleString()} 元`,
                  name === 'pnl' ? '已實現損益' : '股利收入'
                ]}
              />
              <Bar dataKey="pnl" name="pnl" fill="#6366f1" radius={[4, 4, 0, 0]}>
                {monthlyData.map((entry, i) => (
                  <Cell key={i} fill={entry.pnl >= 0 ? '#f03e3e' : '#2f9e44'} />
                ))}
              </Bar>
              <Bar dataKey="dividend" name="dividend" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Stock PnL Ranking */}
      {stockRanking.length > 0 && (
        <div style={{
          padding: '16px', borderRadius: '12px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        }}>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: '12px' }}>🏆 個股損益排行（已實現＋股利；不含在倉未實現）</div>
          {stockRanking.map((s, i) => (
            <div key={s.code} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', columnGap: 8, rowGap: 2, minWidth: 0,
              padding: '10px 8px', borderBottom: i < stockRanking.length - 1 ? '1px solid var(--border-primary)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  width: '24px', height: '24px', borderRadius: '50%', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', fontSize: 'calc(13px * var(--fz))', fontWeight: 700,
                  background: i < 3 ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'var(--bg-tertiary)',
                  color: i < 3 ? '#fff' : 'var(--text-muted)',
                }}>{i + 1}</span>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 'calc(13px * var(--fz))' }}>{s.code}</span>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginLeft: '6px' }}>{s.name}</span>
                  {s.openLots > 0.0005 && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#3d8ef8', marginLeft: '6px' }}>在倉 {fmtQty(s.openLots)}</span>}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontSize: 'calc(14px * var(--fz))', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                  color: (s.pnl + s.dividend) >= 0 ? '#f03e3e' : '#2f9e44',
                }}>
                  {(s.pnl + s.dividend) >= 0 ? '+' : ''}{(s.pnl + s.dividend).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                </div>
                <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                  {s.trades} 筆平倉{s.dividend > 0 ? `｜股利 +${s.dividend.toLocaleString()}` : ''}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Overview ↔ Ledger 橋接（三分頁連動的樞紐） ──────────────────────────
// 總覽永遠顯示交易紀錄彙總（空手也看得到已實現/股利/費稅），
// 並對帳「手動持倉 vs 交易紀錄推算持倉」——不一致給差異表＋一鍵重建。

function OverviewLedgerBridge({ ledger, onGoTab }: { ledger: Ledger; onGoTab: (t: 'trades' | 'analytics') => void }) {
  const { holdings, replaceHoldings, tradeRecords } = useAppStore(useShallow((s) => ({ holdings: s.holdings, replaceHoldings: s.replaceHoldings, tradeRecords: s.tradeRecords })));

  // 期間報酬率：已實現淨損益 ÷ 對應平倉成本（含費稅）。口徑見 portfolio-calc。
  const rets = useMemo(() => periodReturns(ledger.closed), [ledger]);

  // 對帳：手動持倉張數 vs 帳本推算張數（逐 code）
  const diffs = useMemo(() => {
    const manual: Record<string, { lots: number; name: string }> = {};
    holdings.forEach(h => {
      (manual[h.code] ||= { lots: 0, name: h.name }).lots += h.quantity;
    });
    const codes = new Set([...Object.keys(manual), ...ledger.openPositions.map(p => p.code)]);
    const rows: Array<{ code: string; name: string; manualLots: number; ledgerLots: number }> = [];
    for (const code of codes) {
      const m = manual[code]?.lots ?? 0;
      const l = ledger.openPositions.find(p => p.code === code)?.lots ?? 0;
      if (Math.abs(m - l) > 0.0005) rows.push({ code, name: manual[code]?.name || ledger.byCode[code]?.name || code, manualLots: m, ledgerLots: l });
    }
    return rows.sort((a, b) => a.code.localeCompare(b.code));
  }, [holdings, ledger]);

  const rebuild = () => {
    const today = new Date().toISOString().split('T')[0];
    // ⚠ 必須寫 avgPrice（成交均價）而**不是** avgCost（含買進費）：
    //   總覽算「扣費稅後淨利」時會用 buyPrice 再估一次買進手續費，
    //   若這裡塞含費價，同一筆買進費就被扣兩次
    //   （實測：3008 一張多扣 3,568、2330 一張多扣 1,427，畫面只是「淨利少一點」）。
    const items = ledger.openPositions.map(p => ({
      code: p.code, name: p.name,
      buyPrice: +p.avgPrice.toFixed(2),      // 每股加權成交均價（不含買進費）
      quantity: p.lots,
      buyDate: p.lastBuyDate || today,
      note: '依交易紀錄重建',
    }));
    const summary = items.length
      ? items.map(i => `${i.code} ${i.name} ${fmtQty(i.quantity)} @ ${i.buyPrice}`).join('\n')
      : '（交易紀錄推算為空手——手動持倉將被清空）';
    if (confirm(`以交易紀錄推算結果覆蓋手動持倉？\n\n${summary}\n\n（成本價＝加權平均成交價，不含手續費；買進費在損益計算時另計，原手動持倉會被取代）`)) {
      replaceHoldings(items);
    }
  };

  if (tradeRecords.length === 0) return null;
  return (
    <>
      {/* 交易紀錄彙總：空手也看得到的總覽 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(160px, 100%), 1fr))', gap: 10, marginBottom: 16 }}>
        {[
          { label: '已實現損益', v: ledger.totalRealized, c: ledger.totalRealized >= 0 ? 'var(--color-up)' : 'var(--color-down)', sub: `${ledger.closedCount} 筆平倉` },
          { label: '累計股利', v: ledger.totalDividend, c: '#f59e0b', sub: '現金股利' },
          { label: '費稅合計', v: -(ledger.totalFee + ledger.totalTax), c: '#94a3b8', sub: `手續費 ${Math.round(ledger.totalFee).toLocaleString()}｜稅 ${Math.round(ledger.totalTax).toLocaleString()}` },
          { label: '平倉勝率', v: null, c: ledger.winRate >= 50 ? 'var(--color-up)' : 'var(--color-down)', txt: `${ledger.winRate}%`, sub: `${ledger.winCount} 勝 / ${ledger.lossCount} 負` },
        ].map((k, i) => (
          <div key={i} onClick={() => onGoTab('analytics')} title="點擊查看損益分析"
            style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', cursor: 'pointer' }}>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{k.label}</div>
            <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: k.c, fontFamily: "'JetBrains Mono', monospace" }}>
              {k.txt ?? `${(k.v as number) >= 0 ? '+' : ''}${Math.round(k.v as number).toLocaleString()}`}
            </div>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* 期間報酬率：月/季/年化/全期間（2026-08-19 使用者需求） */}
      {ledger.closedCount > 0 && (() => {
        const fmtPct = (v: number | null) => v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
        const clr = (v: number | null) => v == null ? 'var(--text-muted)' : v >= 0 ? 'var(--color-up)' : 'var(--color-down)';
        const cells = [
          { label: '本月報酬率', v: rets.month.pct, sub: `${rets.month.count} 筆平倉 · ${rets.month.pnl >= 0 ? '+' : ''}${rets.month.pnl.toLocaleString()} 元` },
          { label: '本季報酬率', v: rets.quarter.pct, sub: `${rets.quarter.count} 筆平倉 · ${rets.quarter.pnl >= 0 ? '+' : ''}${rets.quarter.pnl.toLocaleString()} 元` },
          { label: '全期間報酬率', v: rets.all.pct, sub: `${rets.spanDays} 天 · ${rets.all.count} 筆平倉` },
          { label: '年化報酬率', v: rets.annualizedPct, sub: rets.annualizedPct == null ? '期間未滿 30 天' : '全期間單利換算' },
        ];
        return (
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(160px, 100%), 1fr))', gap: 10 }}>
              {cells.map((k, i) => (
                <div key={i} onClick={() => onGoTab('analytics')} title="點擊查看損益分析"
                  style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', cursor: 'pointer' }}>
                  <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{k.label}</div>
                  <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: clr(k.v), fontFamily: "'JetBrains Mono', monospace" }}>{fmtPct(k.v)}</div>
                  <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{k.sub}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 6 }}>
              口徑：期間內平倉的已實現淨損益（含費稅）÷ 該批平倉的對應成本；未實現損益不計入。年化為全期間單利換算。非投資建議。
            </div>
          </div>
        );
      })()}

      {/* 對帳卡：手動持倉 vs 交易紀錄推算 */}
      {diffs.length > 0 && (
        <div style={{ padding: '14px 16px', borderRadius: 12, marginBottom: 16, background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.35)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <div style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 700, color: '#f59e0b' }}>⚖️ 持倉對帳：手動持倉與交易紀錄不一致（{diffs.length} 檔）</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '4px 10px' }} onClick={() => onGoTab('trades')}>檢查交易紀錄</button>
              <button className="btn btn-buy" style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '4px 10px' }} onClick={rebuild}>依交易紀錄重建持倉</button>
            </div>
          </div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)', marginBottom: 8 }}>
            持倉頁顯示的是「手動持倉」；損益分析以「交易紀錄」為準。兩邊不一致時（漏記/重複記/超賣），下表列出差異。
          </div>
          {diffs.map(d => (
            <div key={d.code} style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 8, rowGap: 2, minWidth: 0, fontSize: 'calc(12.5px * var(--fz))', padding: '5px 0', borderBottom: '1px solid rgba(245,158,11,0.15)' }}>
              <span><strong>{d.code}</strong> {d.name}</span>
              <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>
                手動 {fmtQty(d.manualLots)} <span style={{ color: 'var(--text-muted)' }}>vs</span> 交易推算 <strong>{fmtQty(d.ledgerLots)}</strong>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ─── Main Portfolio Component ────────────────────────────────────────────

export default function Portfolio() {
  const dt = useDayTradeCodes();   // 當沖資格：必須在任何 early return 之前
  const { holdings, allStocks, tradeRecords, removeHolding, updateHolding, navigateTo } = useAppStore(useShallow((s) => ({ holdings: s.holdings, allStocks: s.allStocks, tradeRecords: s.tradeRecords, removeHolding: s.removeHolding, updateHolding: s.updateHolding, navigateTo: s.navigateTo })));
  const [broker] = useBrokerSettings();
  const [activeTab, setActiveTab] = useState<'overview' | 'trades' | 'analytics'>('overview');
  // 三分頁共用同一份帳本（交易紀錄＝唯一真相），確保口徑連動一致
  const ledger = useMemo(() => buildLedger(tradeRecords), [tradeRecords]);

  const [editingHolding, setEditingHolding] = useState<any | null>(null);
  const [editForm, setEditForm] = useState({
    buyPrice: '',
    quantity: '',
    buyDate: '',
    note: '',
  });

  // ── Live MIS quotes for held stocks (shared hook: 5s intraday / Taipei-time) ──
  const holdingCodes = useMemo(() => [...new Set(holdings.map(h => h.code))], [holdings]);
  const liveQuotes = useLiveQuotes(holdingCodes);
  // Honest data-source state: 即時 only when MIS is actually live this cycle.
  const isLive = useMemo(
    () => Object.values(liveQuotes).some(q => q.source === 'mis_realtime'),
    [liveQuotes],
  );

  const startEdit = (item: any) => {
    setEditingHolding(item);
    setEditForm({
      buyPrice: item.buyPrice.toString(),
      quantity: item.quantity.toString(),
      buyDate: item.buyDate,
      note: item.note || '',
    });
  };

  // Use MIS real-time prices as primary, fallback to allStocks, then buyPrice.
  // Recomputes instantly when holdings are edited/removed (reactive on holdings).
  const enriched = useMemo(() => {
    return holdings.map(h => {
      const live = liveQuotes[h.code];
      const stock = allStocks.find(s => s.code === h.code);
      const currentPrice = live?.price ?? stock?.price ?? h.buyPrice;
      const cost = h.buyPrice * h.quantity * 1000;
      const value = currentPrice * h.quantity * 1000;
      const pnl = value - cost;
      const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
      // 若現價賣出：扣買進手續費＋賣出手續費＋證交稅後的實際利潤
      const nr = netRealizedPnL(currentPrice, h.buyPrice, h.quantity, broker, { code: h.code });
      const feeTax = nr.buyFee + nr.sellFee + nr.tax;
      return { ...h, currentPrice, cost, value, pnl, pnlPct, netPnl: nr.pnl, netPnlPct: nr.roi, feeTax, stockName: live?.name ?? stock?.name ?? h.name };
    });
  }, [holdings, liveQuotes, allStocks, broker]);

  const totalCost = enriched.reduce((s, h) => s + h.cost, 0);
  const totalValue = enriched.reduce((s, h) => s + h.value, 0);
  const totalPnL = totalValue - totalCost;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;
  // 扣費稅後的未實現實際利潤（現價全數賣出）
  const totalNetPnL = enriched.reduce((s, h) => s + h.netPnl, 0);
  const totalFeeTax = enriched.reduce((s, h) => s + h.feeTax, 0);
  const totalNetPnLPct = totalCost > 0 ? (totalNetPnL / totalCost) * 100 : 0;

  // Per-stock aggregation across lots → 平均持有價格 (weighted) + 水位.
  const aggByCode = useMemo(() => {
    const m: Record<string, { code: string; name: string; shares: number; cost: number; value: number; currentPrice: number; lots: number }> = {};
    for (const h of enriched) {
      if (!m[h.code]) m[h.code] = { code: h.code, name: h.stockName || h.name, shares: 0, cost: 0, value: 0, currentPrice: h.currentPrice, lots: 0 };
      m[h.code].shares += h.quantity * 1000;
      m[h.code].cost += h.cost;
      m[h.code].value += h.value;
      m[h.code].currentPrice = h.currentPrice;
      m[h.code].lots += h.quantity;
    }
    return Object.values(m).map(g => ({
      ...g,
      avgCost: g.shares > 0 ? g.cost / g.shares : 0,   // 平均持有價格 (每股)
      pnl: g.value - g.cost,
      pnlPct: g.cost > 0 ? ((g.value - g.cost) / g.cost) * 100 : 0,
    })).sort((a, b) => b.value - a.value);
  }, [enriched]);

  // 累計獲利 = 未實現(持倉·扣費稅) + 已實現(帳本重算) + 累計股利
  //
  // ⚠ 這裡曾經是 `tradeRecords.filter(sell).reduce(+ (t.realizedPnL ?? 0))`，
  //   也就是**存死的 realizedPnL** —— 整個 buildLedger 引擎存在的理由就是這個欄位不可信：
  //   ① 它是用「記錄當下的手動持倉 buyPrice」算的，持倉沒同步就是垃圾
  //      （portfolio-calc.ts 開頭記了實例：大立光多算 39 萬、華邦電差 80 萬）；
  //   ② 使用者一旦用編輯交易修正錯價，store 會 `delete next.realizedPnL`，
  //      於是那筆賣出對累計獲利的貢獻直接變 **0**——
  //      **越認真訂正資料，頭條數字錯得越多**，而畫面上完全看不出來。
  //   ③ 同一個「持倉總覽」分頁上方的對帳卡顯示的是 ledger.totalRealized，
  //      兩個「已實現」在同一畫面互相打架，這正是使用者說的「不精準/不連動」。
  //   合成資料實測差額：存死 96,000 vs 帳本 380,679（一筆被編輯過就少 28 萬）。
  //   ⇒ 三個分頁一律吃同一份 ledger，不要再從 tradeRecords 自己加總損益。
  const cumulativePnL = totalNetPnL + ledger.totalRealized + ledger.totalDividend;

  // ── 佔比的分母只能有一個定義（2026-08-20 使用者實報）───────────────────
  // 圓餅圖問的是「股票部位怎麼分配」→ 分母＝持股市值；
  // 再平衡面板問的是「單一個股佔總資產多少」（≤25% 風控線）→ 分母＝持股＋現金。
  // 兩者都對，但同一頁上同一檔股票出現 42.4% 與 14.4% 兩個「佔比」，
  // 使用者只會覺得數字不準（實測本帳戶現金佔 66%，兩個分母差 ~3 倍）。
  // ⇒ 沿用 CLAUDE.md 的「同名必同口徑」：不改任一方的定義，而是**把分母寫在臉上**，
  //   並在圓餅圖同時給出兩個百分比，讓兩張卡對得起來。
  const dataUidForCash = useDataUid();
  const [assetCash, setAssetCash] = useState<number | null>(null);
  useEffect(() => {
    if (!dataUidForCash || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(
      doc(db, 'users', dataUidForCash, 'data', 'rebalance'),
      snap => setAssetCash(snap.exists() ? ((snap.data() as { cash?: number | null }).cash ?? null) : null),
      () => {},
    );
    return () => unsub();
  }, [dataUidForCash]);

  // Pie chart data (by stock position value)
  const pieData = Object.values(
    enriched.reduce((acc, h) => {
      if (!acc[h.code]) acc[h.code] = { name: `${h.code} ${h.name}`, value: 0 };
      acc[h.code].value += h.value;
      return acc;
    }, {} as Record<string, { name: string; value: number }>)
  );

  const byCode = Object.values(
    enriched.reduce((acc, h) => {
      if (!acc[h.code]) acc[h.code] = { code: h.code, name: h.name, items: [] };
      (acc[h.code] as { items: typeof enriched }).items.push(h);
      return acc;
    }, {} as Record<string, { code: string; name: string; items: typeof enriched }>)
  );
  // 持倉即時籌碼判讀（清倉/優先減碼/觀望/可加碼…，回測背書規則，2分鐘更新）
  const verdicts = useChipVerdicts(byCode.map(g => g.code));

  return (
    <div className={styles.portfolio}>
      <PageHelp id="portfolio" />
      <div className={styles.header}>
        <h1 className={styles.title}>💼 投資組合管理</h1>
        <p className={styles.subtitle}>
          記錄持倉、交易紀錄與損益分析
          {holdings.length > 0 && (
            <span style={{
              marginLeft: 10, fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '2px 10px', borderRadius: 12,
              color: isLive ? '#22c55e' : '#94a3b8',
              background: isLive ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.1)',
              border: `1px solid ${isLive ? 'rgba(34,197,94,0.3)' : 'var(--border-primary)'}`,
            }}>
              {isLive ? '● 即時報價' : '📅 收盤價（即時來源暫不可用）'}
            </span>
          )}
        </p>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', gap: '4px', padding: '4px',
        background: 'var(--bg-tertiary)', borderRadius: '12px', marginBottom: '20px',
      }}>
        {([
          { id: 'overview', label: '📊 持倉總覽', icon: '📊' },
          { id: 'trades', label: '📝 交易紀錄', icon: '📝' },
          { id: 'analytics', label: '📈 損益分析', icon: '📈' },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1, padding: '10px 16px', borderRadius: '10px', fontSize: 'calc(13px * var(--fz))', fontWeight: 600,
              background: activeTab === tab.id ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
              border: 'none', cursor: 'pointer', transition: 'all 0.2s',
              boxShadow: activeTab === tab.id ? '0 2px 8px rgba(0,0,0,0.15)' : 'none',
            }}
          >{tab.label}</button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'trades' ? (
        <TradeHistoryPanel ledger={ledger} />
      ) : activeTab === 'analytics' ? (
        <AnalyticsPanel ledger={ledger} />
      ) : holdings.length === 0 ? (
        <>
          {/* 空手也要有總覽：交易彙總＋對帳卡（先前只剩一張空狀態，什麼都看不到） */}
          <OverviewLedgerBridge ledger={ledger} onGoTab={setActiveTab} />

          {/* 最近平倉：空手時總覽的主內容 */}
          {ledger.closed.length > 0 && (
            <div style={{ padding: '16px', borderRadius: 12, marginBottom: 16, background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)' }}>
              <div className={styles.cardTitle} style={{ marginBottom: 8 }}>🧾 最近平倉（目前空手）</div>
              {ledger.closed.slice(0, 8).map(c => (
                <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border-primary)', fontSize: 'calc(13px * var(--fz))', flexWrap: 'wrap' }}>
                  <span>
                    <span style={{ color: 'var(--text-muted)', marginRight: 8 }}>{c.date}</span>
                    <strong style={{ cursor: 'pointer' }} onClick={() => navigateTo('stock', c.code)}>{c.code} {c.name}</strong>
                    <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>{fmtQty(c.lots, c.unit)} @ {c.sellPrice}</span>
                  </span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, color: c.pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                    {c.pnl >= 0 ? '+' : ''}{c.pnl.toLocaleString()}（{c.roi >= 0 ? '+' : ''}{c.roi}%）
                  </span>
                </div>
              ))}
              <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginTop: 8, cursor: 'pointer' }} onClick={() => setActiveTab('analytics')}>
                完整平倉明細與統計 → 損益分析分頁
              </div>
            </div>
          )}

          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>💼</div>
            <div className={styles.emptyText}>目前沒有在倉部位</div>
            <div className={styles.emptySub}>搜尋股票後點擊「記錄持倉」、或在交易紀錄新增買入即自動建倉</div>
          </div>
        </>
      ) : (
        <>
          {/* 交易彙總＋持倉對帳（三分頁連動樞紐） */}
          <OverviewLedgerBridge ledger={ledger} onGoTab={setActiveTab} />
          {/* 崩盤防禦清單（大跌日自動生成，48h 內顯示） */}
          <CardBoundary name="崩盤防禦清單"><DefenseBanner /></CardBoundary>

          {/* 警報推播設定（Web Push） */}
          <CardBoundary name="警報推播設定"><PushSetup /></CardBoundary>

          {/* 個人化每日摘要 (常駐 daemon LLM) */}
          <CardBoundary name="每日摘要"><PortfolioSummary /></CardBoundary>

          {/* 投組相關性/分散度 (常駐 daemon) */}
          <CardBoundary name="投組相關性/分散度"><PortfolioRisk /></CardBoundary>

          {/* 汰弱留強輪動建議（持股評分 vs 全市場） */}
          <CardBoundary name="汰弱留強輪動"><RotationAdvice /></CardBoundary>

          {/* 投資論點追蹤 (P2：AI 依數據預填草稿，每日檢核) */}
          <CardBoundary name="投資論點追蹤"><ThesisCards /></CardBoundary>

          {/* 資金總覽（現金流水帳：入金/出金/股利，買賣自動帶入） */}
          <CardBoundary name="資金總覽"><CashLedger /></CardBoundary>

          {/* 配置漂移再平衡 (P2：個股≤25%/產業≤40%/現金≥10%) */}
          <CardBoundary name="配置漂移再平衡"><RebalancePanel /></CardBoundary>

          {/* 影子帳戶：從交易紀錄學實際規則、抓破戒（Vibe-Trading 概念） */}
          <CardBoundary name="影子帳戶"><ShadowAccount /></CardBoundary>

          {/* 週末復盤週報（每週六） */}
          <CardBoundary name="週報"><WeeklyReport /></CardBoundary>

          {/* 月度投資報告 (P3：daemon 每月純模板) */}
          <CardBoundary name="月報"><MonthlyReport /></CardBoundary>

          {/* 股利稅負試算 (P3：已婚合併申報，純前端法定公式) */}
          <CardBoundary name="股利稅負試算"><DividendTaxCalc /></CardBoundary>

          {/* 自動停損/停利提醒 (常駐 daemon 觸價寫入) */}
          <CardBoundary name="停損停利提醒"><PortfolioAlerts /></CardBoundary>

          {/* 自訂條件警報 */}
          <CardBoundary name="自訂條件警報"><PortfolioAlertRules /></CardBoundary>

          {/* Summary Cards */}
          <div className={styles.summaryGrid}>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>總成本</div>
              <div className={styles.summaryValue}>
                {totalCost.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
              </div>
              <div className={styles.summarySub}>元</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>市值</div>
              <div className={styles.summaryValue}>
                {totalValue.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
              </div>
              <div className={styles.summarySub}>元</div>
            </div>
            <div className={styles.summaryCard} style={{ borderColor: totalNetPnL >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}
              title={`扣除費稅後未實現實際利潤（現價全數賣出）。毛利 ${totalPnL >= 0 ? '+' : ''}${Math.round(totalPnL).toLocaleString()}、費稅 −${Math.round(totalFeeTax).toLocaleString()}`}>
              <div className={styles.summaryLabel}>未實現損益(扣費稅)</div>
              <div
                className={styles.summaryValue}
                style={{ color: totalNetPnL >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}
              >
                {totalNetPnL >= 0 ? '+' : ''}{totalNetPnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
              </div>
              <div className={styles.summarySub} style={{ color: totalNetPnL >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                {totalNetPnLPct >= 0 ? '+' : ''}{totalNetPnLPct.toFixed(2)}%　<span style={{ color: 'var(--text-muted)' }}>毛 {totalPnL >= 0 ? '+' : ''}{Math.round(totalPnL).toLocaleString()}</span>
              </div>
            </div>
            <div className={styles.summaryCard} style={{ borderColor: cumulativePnL >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
              <div className={styles.summaryLabel}>累計獲利</div>
              <div className={styles.summaryValue} style={{ color: cumulativePnL >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                {cumulativePnL >= 0 ? '+' : ''}{cumulativePnL.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
              </div>
              <div className={styles.summarySub}>未實現+已實現+股利</div>
            </div>
            <div className={styles.summaryCard}>
              <div className={styles.summaryLabel}>持股數</div>
              <div className={styles.summaryValue}>{Object.keys(byCode).length}</div>
              <div className={styles.summarySub}>個股種</div>
            </div>
          </div>

          {/* 持倉水位分析：平均成本 / 現價 / 報酬率水位 (逐股) */}
          {aggByCode.length > 0 && (
            <div style={{
              padding: '18px', borderRadius: '12px', marginBottom: '20px',
              background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
            }}>
              <div className={styles.cardTitle} style={{ marginBottom: '4px' }}>📊 持倉水位分析</div>
              <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: '16px' }}>
                平均持有成本 vs 現價 · 報酬率水位（紅=獲利、綠=虧損，中線為損益兩平）
              </div>

              {/* 整體成本/市值水位 */}
              <div style={{ marginBottom: '18px', paddingBottom: '16px', borderBottom: '1px solid var(--border-primary)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 10, rowGap: 2, fontSize: 'calc(13px * var(--fz))', marginBottom: '8px', minWidth: 0 }}>
                  <span style={{ color: 'var(--text-muted)', minWidth: 0 }}>
                    整體 · 成本水位 <strong style={{ color: 'var(--text-secondary)' }}>{Math.round(totalCost).toLocaleString()}</strong>
                    <span style={{ margin: '0 6px' }}>→</span>
                    市值 <strong style={{ color: 'var(--text-secondary)' }}>{Math.round(totalValue).toLocaleString()}</strong>
                  </span>
                  <strong style={{ color: totalPnL >= 0 ? 'var(--color-up)' : 'var(--color-down)', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {totalPnLPct >= 0 ? '+' : ''}{totalPnLPct.toFixed(2)}%
                  </strong>
                </div>
                <ProfitGauge pct={totalPnLPct} />
              </div>

              {/* 逐股水位 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {aggByCode.map(g => (
                  <div key={g.code} className={styles.gaugeRow}>
                    <div
                      style={{ cursor: 'pointer', minWidth: 0 }}
                      onClick={() => navigateTo('stock', g.code)}
                    >
                      <div style={{ fontWeight: 700, fontSize: 'calc(14px * var(--fz))', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 5 }}>{g.code}<RiskBadge code={g.code} size="xs" /></div>
                      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</div>
                    </div>
                    <div>
                      {/* 要斷就斷在「均價／現價／張數」的邊界，絕不在一個數值中間斷 →
                          整列可 wrap，每一段自己 nowrap。 */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', columnGap: 10, rowGap: 2, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', marginBottom: '6px', minWidth: 0 }}>
                        <span style={{ whiteSpace: 'nowrap' }}>均價 <strong style={{ color: 'var(--text-secondary)' }}>{g.avgCost.toFixed(2)}</strong></span>
                        <span style={{ whiteSpace: 'nowrap' }}>現價 <strong style={{ color: g.currentPrice >= g.avgCost ? 'var(--color-up)' : 'var(--color-down)' }}>{g.currentPrice.toFixed(2)}</strong></span>
                        <span style={{ whiteSpace: 'nowrap' }}>{g.lots} 張</span>
                      </div>
                      <ProfitGauge pct={g.pnlPct} />
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>
                      <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 700, color: g.pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                        {g.pnlPct >= 0 ? '+' : ''}{g.pnlPct.toFixed(2)}%
                      </div>
                      <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: g.pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                        {g.pnl >= 0 ? '+' : ''}{Math.round(g.pnl).toLocaleString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Member-exclusive: local-AI holdings analysis */}
          <PortfolioAI codes={byCode.map(g => ({ code: g.code, name: g.name }))} />

          {/* Chart + Holdings */}
          <div className={styles.mainGrid}>
            {/* Pie Chart */}
            {pieData.length > 0 && (
              <div className={styles.chartCard}>
                <div className={styles.cardTitle}>
                  持倉比例分布
                  <span style={{ marginLeft: 8, fontWeight: 400, fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                    分母＝持股市值（不含現金）
                  </span>
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={70}
                      outerRadius={110}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {pieData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i % COLORS.length]} />
                      ))}
                    </Pie>
                    {/* 圓心固定顯示總市值——原本 hover 單塊的無名提示框浮在圓心，
                        被誤讀為總金額（使用者實案：玉山金 7,170 被當成總計） */}
                    <text x="50%" y="43%" textAnchor="middle" fill="var(--text-muted)" fontSize={11}>持倉總市值</text>
                    <text x="50%" y="52%" textAnchor="middle" fill="var(--text-primary)" fontSize={16} fontWeight={800}>
                      {pieData.reduce((t, d) => t + d.value, 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元
                    </text>
                    {assetCash != null && (
                      <text x="50%" y="62%" textAnchor="middle" fill="var(--text-muted)" fontSize={10}>
                        另有現金 {assetCash.toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元
                      </text>
                    )}
                    <Tooltip
                      formatter={(v: any, name: any) => {
                        const total = pieData.reduce((t, d) => t + d.value, 0);
                        const pct = total > 0 ? (v / total * 100).toFixed(1) : '0';
                        // 現金已知時一併給「佔總資產」——這才是再平衡面板用的口徑，
                        // 兩個數字並列，使用者就不會以為其中一個是錯的。
                        const totalAll = total + (assetCash ?? 0);
                        const pctAll = assetCash != null && totalAll > 0 ? (v / totalAll * 100).toFixed(1) : null;
                        const txt = pctAll != null
                          ? `${(v as number).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元（佔持股 ${pct}%・佔總資產 ${pctAll}%）`
                          : `${(v as number).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元（佔持股 ${pct}%）`;
                        return [txt, name];
                      }}
                      contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: 'calc(12.5px * var(--fz))' }}
                labelStyle={{ color: '#ffffff', fontWeight: 800, marginBottom: 2 }}
                    />
                    <Legend
                      formatter={(value) => <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-secondary)' }}>{value}</span>}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Holdings List */}
            <div className={styles.holdingsCard}>
              <div className={styles.cardTitle}>持倉明細</div>
              <div className={styles.holdingsList}>
                {byCode.map((group, gi) => (
                  <div key={group.code} className={styles.holdingGroup}>
                    <div
                      className={styles.groupHeader}
                      onClick={() => { navigateTo('stock', group.code); }}
                    >
                      <span className={styles.groupCode}>{group.code}</span>
                      <span className={styles.groupName}>{group.name}</span>
                      {/* 持股頁標當沖資格：想當沖手上部位時，這裡是最後一道提醒 */}
                      {(() => { const st = statusOf(dt, group.code); return st == null ? null : <DayTradeMark status={st} size="xs" />; })()}
                      <VerdictBadge v={verdicts[group.code]} compact />
                      <div className={styles.groupBar} style={{ background: COLORS[gi % COLORS.length] }} />
                    </div>
                    {verdicts[group.code] && ['清倉', '優先減碼', '減碼', '可加碼'].includes(verdicts[group.code].a) && (
                      <div style={{ margin: '4px 0 6px' }}><VerdictStrip v={verdicts[group.code]} /></div>
                    )}
                    {group.items.map(item => (
                      <div key={item.id} className={styles.holdingRow}>
                        <div className={styles.holdingMeta}>
                          <span className={styles.holdingDate}>{item.buyDate}</span>
                          <span className={styles.holdingQty}>{fmtQty(item.quantity, item.unit)}</span>
                          <span className={styles.holdingBuy}>買進 {item.buyPrice.toFixed(2)}</span>
                          <span className={styles.holdingCurrent}>現價 {item.currentPrice.toFixed(2)}</span>
                        </div>
                        <div
                          className={styles.holdingPnl}
                          style={{ color: item.netPnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}
                          title={`扣除費稅後實際利潤（現價賣出）。毛利 ${item.pnl >= 0 ? '+' : ''}${Math.round(item.pnl).toLocaleString()}、買賣手續費+證交稅 −${Math.round(item.feeTax).toLocaleString()}`}
                        >
                          {item.netPnl >= 0 ? '+' : ''}{item.netPnl.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                          <span className={styles.holdingPnlPct}>
                            ({item.netPnlPct >= 0 ? '+' : ''}{item.netPnlPct.toFixed(2)}%)
                          </span>
                          <span style={{ display: 'block', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)', fontWeight: 400 }}>
                            毛 {item.pnl >= 0 ? '+' : ''}{Math.round(item.pnl).toLocaleString()}｜費稅 −{Math.round(item.feeTax).toLocaleString()}
                          </span>
                        </div>
                        <div className={styles.rowActions}>
                          <button
                            className={styles.editBtn}
                            onClick={() => startEdit(item)}
                            title="修改此筆記錄"
                          >
                            ✏️
                          </button>
                          <button
                            id={`remove-holding-${item.id}`}
                            className={styles.removeBtn}
                            onClick={() => {
                              if (confirm(`確定要刪除 ${item.buyDate} 買進的 ${fmtQty(item.quantity, item.unit)} ${item.stockName || item.name} 嗎？`)) {
                                removeHolding(item.id);
                              }
                            }}
                            title="刪除此筆記錄"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Edit Holding Modal */}
      {editingHolding && (
        <div className={styles.modalOverlay} onClick={() => setEditingHolding(null)}>
          <div className={styles.modal} onClick={e => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>修改持倉 — {editingHolding.code} {editingHolding.stockName || editingHolding.name}</h3>
              <button className={styles.modalClose} onClick={() => setEditingHolding(null)}>×</button>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.formGroup}>
                <label>買進單價 (每股)</label>
                <input
                  type="number"
                  step="0.01"
                  value={editForm.buyPrice}
                  onChange={e => setEditForm(f => ({ ...f, buyPrice: e.target.value }))}
                  className="input"
                />
                <span className={styles.inputHelper}>請以「每股單價」輸入，如台積電輸入 600、大立光輸入 2500，而非整張數百萬元。</span>
              </div>
              <div className={styles.formGroup}>
                <label>買進張數（可含零股：0.35 張＝350 股）</label>
                <input
                  type="number"
                  min="0.001"
                  step="0.001"
                  value={editForm.quantity}
                  onChange={e => setEditForm(f => ({ ...f, quantity: e.target.value }))}
                  className="input"
                />
              </div>
              <div className={styles.formGroup}>
                <label>買進日期</label>
                <input
                  type="date"
                  value={editForm.buyDate}
                  onChange={e => setEditForm(f => ({ ...f, buyDate: e.target.value }))}
                  className="input"
                />
              </div>
              <div className={styles.formGroup}>
                <label>備注</label>
                <input
                  type="text"
                  placeholder="可選填"
                  value={editForm.note}
                  onChange={e => setEditForm(f => ({ ...f, note: e.target.value }))}
                  className="input"
                />
              </div>
              {editForm.buyPrice && editForm.quantity && (
                <div className={styles.costPreview}>
                  <div style={{ fontSize: 'calc(12.5px * var(--fz))', marginBottom: '4px', opacity: 0.8 }}>
                    計算公式：單價 ({parseFloat(editForm.buyPrice).toLocaleString()} 元) × {fmtQty(parseFloat(editForm.quantity) || 0)}（{Math.round((parseFloat(editForm.quantity) || 0) * 1000).toLocaleString()} 股）
                  </div>
                  <div>
                    預估成本 (含 0.1425% 手續費)：
                    <strong>
                      {(parseFloat(editForm.buyPrice) * (parseFloat(editForm.quantity) || 0) * 1000 * 1.001425).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元
                    </strong>
                  </div>
                </div>
              )}
            </div>
            <div className={styles.modalFooter}>
              <button className="btn btn-ghost" onClick={() => setEditingHolding(null)}>取消</button>
              <button
                className="btn btn-buy"
                onClick={() => {
                  const buyPrice = parseFloat(editForm.buyPrice);
                  const quantity = parseFloat(editForm.quantity || '0');
                  if (isNaN(buyPrice) || buyPrice <= 0 || isNaN(quantity) || quantity <= 0) {
                    alert('請輸入正確的單價與張數！');
                    return;
                  }
                  if (!editForm.buyDate) {
                    alert('請選擇買進日期！');
                    return;
                  }
                  updateHolding(editingHolding.id, {
                    buyPrice,
                    quantity,
                    buyDate: editForm.buyDate,
                    note: editForm.note,
                  });
                  setEditingHolding(null);
                }}
              >
                儲存修改
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
