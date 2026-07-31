'use client';

import { useState, useMemo, useEffect } from 'react';
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
import { tradeCost, netRealizedPnL, taxRateLabel, isEtf , fmtQty } from '@/lib/tw-fee';
import { useBrokerSettings } from '@/lib/useBrokerSettings';
import { settleDate, isSettled, tradingDaysUntilSettle } from '@/lib/tw-settlement';
import { useChipVerdicts, VerdictBadge, VerdictStrip } from '@/components/shared/ChipVerdict';
import WeeklyReport from './WeeklyReport';
import DefenseBanner from './DefenseBanner';
import DividendTaxCalc from './DividendTaxCalc';
import RiskBadge from '@/components/shared/RiskBadge';
import styles from './Portfolio.module.css';
import PageHelp from '@/components/Help/PageHelp';

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
  const { addTradeRecord, allStocks, holdings } = useAppStore();
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
  const [showSearch, setShowSearch] = useState(false);

  const matchedStocks = useMemo(() => {
    if (!searchQuery || searchQuery.length < 1) return [];
    return allStocks
      .filter(s => /^\d{4,5}$/.test(s.code) && (s.code.includes(searchQuery) || s.name.includes(searchQuery)))
      .slice(0, 8);
  }, [searchQuery, allStocks]);

  // Calculate avg cost for sell — only use holdings (not trade records, which would double-count)
  const avgCostBasis = useMemo(() => {
    if (!form.code || form.type !== 'sell') return 0;
    const stockHoldings = holdings.filter(h => h.code === form.code);
    let totalShares = 0, totalCost = 0;
    stockHoldings.forEach(h => { totalShares += h.quantity * 1000; totalCost += h.buyPrice * h.quantity * 1000; });
    return totalShares > 0 ? totalCost / totalShares : 0;
  }, [form.code, form.type, holdings]);

  const price = parseFloat(form.price) || 0;
  const qtyRaw = parseFloat(form.quantity) || 0;
  const qty = form.unit === 'share' ? qtyRaw / 1000 : qtyRaw;   // 內部一律以「張」(可小數，0.35=350股)
  const taxOpts = { dayTrade: form.dayTrade, code: form.code };
  const cost = form.type === 'dividend'
    ? { gross: price * qty * 1000, fee: 0, tax: 0, net: price * qty * 1000 }
    : tradeCost(form.type, price, qty, broker, taxOpts);
  const fee = cost.fee, tax = cost.tax, grossAmount = cost.gross, totalAmount = cost.net;
  // 已實現淨損益（含買賣雙邊成本，非只扣賣出）
  const realized = form.type === 'sell' && avgCostBasis > 0
    ? netRealizedPnL(price, avgCostBasis, qty, broker, taxOpts)
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
                    flex: 1, padding: '10px', borderRadius: '8px', fontSize: '14px', fontWeight: 600,
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
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.dayTrade} onChange={e => setForm(f => ({ ...f, dayTrade: e.target.checked }))} />
              現股當沖（證交稅減半 0.15%）
            </label>
          )}

          {/* Stock search */}
          <div className={styles.formGroup}>
            <label>股票代號</label>
            <div style={{ position: 'relative' }}>
              <input
                className="input"
                placeholder="輸入代號或名稱搜尋"
                value={form.code ? `${form.code} ${form.name}` : searchQuery}
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
                      }}
                      style={{
                        padding: '10px 14px', cursor: 'pointer', fontSize: '13px',
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
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
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
                      style={{ padding: '2px 10px', fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer',
                        background: form.unit === u ? 'var(--accent-primary, #3d8ef8)' : 'var(--bg-tertiary)',
                        color: form.unit === u ? '#fff' : 'var(--text-secondary)' }}>
                      {u === 'lot' ? '張' : '股(零股)'}
                    </button>
                  ))}
                </span>
              </label>
              <input
                className="input" type="number" min="1" step={form.unit === 'share' ? 1 : 'any'}
                placeholder={form.unit === 'share' ? '1~999 股' : '張數（可小數，0.35=350股）'}
                value={form.quantity}
                onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
              />
              {form.unit === 'share' && qtyRaw > 0 && (
                <span className={styles.inputHelper}>＝ {fmtQty(qtyRaw / 1000)}（零股費率同 0.1425%，低消以 1 元計）</span>
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
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', fontSize: '12px' }}>
                <div>成交金額：<strong>{grossAmount.toLocaleString()} 元</strong></div>
                <div>手續費(0.1425%{broker.discount < 1 ? `×${broker.discount}折讓` : ''})：<strong>{fee.toLocaleString()} 元</strong>{fee === broker.minFee && grossAmount > 0 ? <span style={{ color: 'var(--text-muted)' }}> 最低</span> : null}</div>
                {form.type === 'sell' && <div>交易稅({taxRateLabel({ dayTrade: form.dayTrade, code: form.code })})：<strong>{tax.toLocaleString()} 元</strong></div>}
                {form.type !== 'dividend' && <div>交割日(T+2)：<strong>{settleDate(form.date)}</strong></div>}
                <div style={{ gridColumn: '1/-1', borderTop: '1px solid var(--border-primary)', paddingTop: '8px' }}>
                  {form.type === 'buy' ? '💰 實際支出' : form.type === 'sell' ? '💰 實際收入' : '💰 股利收入'}：
                  <strong style={{ fontSize: '15px', color: form.type === 'sell' ? 'var(--color-up)' : 'var(--text-primary)' }}>
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
                    <div style={{ fontSize: '11px', marginTop: 4, opacity: 0.85, fontWeight: 400 }}>
                      成本均價 {avgCostBasis.toFixed(2)}｜買進手續費 −{realized.buyFee.toLocaleString()}｜賣出手續費 −{realized.sellFee.toLocaleString()}｜證交稅 −{realized.tax.toLocaleString()}
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

// ─── Trade History Panel ─────────────────────────────────────────────────

function TradeHistoryPanel() {
  const { tradeRecords, removeTradeRecord, navigateTo } = useAppStore();
  const [filter, setFilter] = useState<'all' | 'buy' | 'sell' | 'dividend'>('all');
  const [showAddModal, setShowAddModal] = useState(false);

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
        <div style={{ display: 'flex', gap: '6px' }}>
          {(['all', 'buy', 'sell', 'dividend'] as const).map(f => {
            const labels = { all: '全部', buy: '🟢 買入', sell: '🔴 賣出', dividend: '💰 股利' };
            return (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '6px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
                  background: filter === f ? 'var(--accent-purple, #7c3aed)' : 'var(--bg-tertiary)',
                  color: filter === f ? '#fff' : 'var(--text-secondary)',
                  border: 'none', cursor: 'pointer', transition: 'all 0.15s',
                }}
              >{labels[f]} {f === 'all' ? `(${tradeRecords.length})` : `(${tradeRecords.filter(t => t.type === f).length})`}</button>
            );
          })}
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          style={{
            padding: '8px 18px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: '#fff', border: 'none', cursor: 'pointer',
            boxShadow: '0 2px 12px rgba(99,102,241,0.3)',
          }}
        >+ 新增交易</button>
      </div>

      {/* Trade List */}
      {filtered.length === 0 ? (
        <div style={{ padding: '60px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>📝</div>
          <div style={{ fontSize: '15px', marginBottom: '6px' }}>尚未記錄任何交易</div>
          <div style={{ fontSize: '12px', opacity: 0.7 }}>點擊「新增交易」開始記錄你的買賣紀錄</div>
        </div>
      ) : (
        grouped.map(([month, records]) => (
          <div key={month}>
            <div style={{
              fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)',
              padding: '8px 0', borderBottom: '1px solid var(--border-primary)',
              letterSpacing: '0.05em',
            }}>
              📅 {month.replace('-', ' 年 ')} 月 · {records.length} 筆
            </div>
            {records.map(t => {
              const cfg = typeConfig[t.type];
              return (
                <div key={t.id} style={{
                  display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto',
                  padding: '14px 12px', alignItems: 'center',
                  borderBottom: '1px solid var(--border-primary)',
                  transition: 'background 0.12s',
                }}>
                  {/* Stock + Type */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <span
                        onClick={() => navigateTo('stock', t.code)}
                        style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)', cursor: 'pointer' }}
                      >{t.code}</span>
                      <span style={{
                        fontSize: '12px', padding: '2px 8px', borderRadius: '4px',
                        background: cfg.bg, color: cfg.color, fontWeight: 600,
                      }}>{cfg.label}</span>
                    </div>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{t.name}</span>
                    <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>{t.date}</span>
                  </div>

                  {/* Price + Qty */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {t.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{fmtQty(t.quantity)}</span>
                  </div>

                  {/* Amount + PnL */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    {/* 現金流以「支出/收入」中性呈現——紅綠語意保留給損益（獲利紅/虧損綠），
                        避免買入成本的負號被誤讀為虧損 */}
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {t.type === 'buy' ? '支出 ' : t.type === 'sell' ? '收入 ' : '入帳 '}{Math.abs(t.totalAmount).toLocaleString()} 元
                    </span>
                    {t.fee > 0 && (
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        手續費 {t.fee.toLocaleString()}{t.tax > 0 ? ` + 稅 ${t.tax.toLocaleString()}` : ''}{t.dayTrade ? ' · 當沖' : ''}
                      </span>
                    )}
                    {t.realizedPnL !== undefined && (
                      <span style={{
                        fontSize: '13px', fontWeight: 600,
                        color: t.realizedPnL >= 0 ? '#f03e3e' : '#2f9e44',
                      }}>
                        實際獲利 {t.realizedPnL >= 0 ? '+' : ''}{t.realizedPnL.toLocaleString()}
                      </span>
                    )}
                    {/* 交割狀態（T+2） */}
                    {t.type !== 'dividend' && (() => {
                      const settled = isSettled(t.date);
                      const dleft = tradingDaysUntilSettle(t.date);
                      return (
                        <span style={{ fontSize: '11px', fontWeight: 600, color: settled ? 'var(--text-muted)' : '#f59e0b' }}>
                          {settled ? `✓ 已交割 ${settleDate(t.date)}` : `⏳ ${settleDate(t.date)} 交割${dleft === 0 ? '(今日)' : `(還 ${dleft} 交易日)`}`}
                        </span>
                      );
                    })()}
                  </div>

                  {/* Actions */}
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => {
                        if (confirm(`確定要刪除 ${t.date} ${typeConfig[t.type].label} ${t.code} 的紀錄嗎？`))
                          removeTradeRecord(t.id);
                      }}
                      style={{
                        padding: '4px 8px', borderRadius: '6px', fontSize: '12px',
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
    </div>
  );
}

// ─── Analytics Panel ─────────────────────────────────────────────────────

function AnalyticsPanel() {
  const { tradeRecords, holdings, allStocks } = useAppStore();
  const [misPrices, setMisPrices] = useState<Record<string, number>>({});

  // Fetch MIS real-time prices for held stocks
  useEffect(() => {
    const codes = [...new Set(holdings.map(h => h.code))];
    if (codes.length === 0) return;
    fetch(`/api/twse/mis-quote?codes=${codes.join(',')}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (data.quotes && Array.isArray(data.quotes)) {
          const map: Record<string, number> = {};
          data.quotes.forEach((q: any) => { map[q.code] = q.price; });
          setMisPrices(map);
        }
      })
      .catch(err => console.error('[AnalyticsPanel] MIS fetch error:', err));
  }, [holdings]);

  const stats = useMemo(() => {
    const sells = tradeRecords.filter(t => t.type === 'sell' && t.realizedPnL !== undefined);
    const buys = tradeRecords.filter(t => t.type === 'buy');
    const dividends = tradeRecords.filter(t => t.type === 'dividend');

    const totalRealized = sells.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
    const totalDividend = dividends.reduce((s, t) => s + t.totalAmount, 0);
    const wins = sells.filter(t => (t.realizedPnL ?? 0) > 0);
    const losses = sells.filter(t => (t.realizedPnL ?? 0) < 0);
    const winRate = sells.length > 0 ? (wins.length / sells.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.realizedPnL ?? 0), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.realizedPnL ?? 0), 0) / losses.length : 0;
    const totalFees = tradeRecords.reduce((s, t) => s + t.fee + t.tax, 0);
    const totalTrades = tradeRecords.length;
    const totalBuyAmount = buys.reduce((s, t) => s + t.totalAmount, 0);
    const totalSellAmount = sells.reduce((s, t) => s + t.totalAmount, 0);

    return {
      totalRealized, totalDividend, winRate, avgWin, avgLoss,
      totalFees, totalTrades, totalBuyAmount, totalSellAmount,
      winCount: wins.length, lossCount: losses.length, sellCount: sells.length,
    };
  }, [tradeRecords]);

  // Monthly PnL chart data
  const monthlyData = useMemo(() => {
    const months: Record<string, { month: string; pnl: number; dividend: number }> = {};
    tradeRecords.forEach(t => {
      const m = t.date.slice(0, 7);
      if (!months[m]) months[m] = { month: m, pnl: 0, dividend: 0 };
      if (t.type === 'sell' && t.realizedPnL !== undefined) months[m].pnl += t.realizedPnL;
      if (t.type === 'dividend') months[m].dividend += t.totalAmount;
    });
    return Object.values(months).sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  }, [tradeRecords]);

  // Per-stock PnL ranking
  const stockRanking = useMemo(() => {
    const byCode: Record<string, { code: string; name: string; pnl: number; trades: number }> = {};
    tradeRecords.filter(t => t.type === 'sell' && t.realizedPnL !== undefined).forEach(t => {
      if (!byCode[t.code]) byCode[t.code] = { code: t.code, name: t.name, pnl: 0, trades: 0 };
      byCode[t.code].pnl += t.realizedPnL ?? 0;
      byCode[t.code].trades += 1;
    });
    return Object.values(byCode).sort((a, b) => b.pnl - a.pnl);
  }, [tradeRecords]);

  // Unrealized PnL from holdings — use MIS real-time prices
  const unrealizedPnL = useMemo(() => {
    return holdings.reduce((sum, h) => {
      const currentPrice = misPrices[h.code] ?? allStocks.find(s => s.code === h.code)?.price ?? h.buyPrice;
      return sum + (currentPrice - h.buyPrice) * h.quantity * 1000;
    }, 0);
  }, [holdings, misPrices, allStocks]);

  if (tradeRecords.length === 0) {
    return (
      <div style={{ padding: '60px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: '48px', marginBottom: '12px' }}>📈</div>
        <div style={{ fontSize: '15px', marginBottom: '6px' }}>尚無交易紀錄可供分析</div>
        <div style={{ fontSize: '12px', opacity: 0.7 }}>新增交易紀錄後即可查看損益分析</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* AI 交易覆盤 (常駐 daemon LLM) */}
      <PortfolioTradeReview />

      {/* Summary Stats */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px',
      }}>
        {[
          { label: '已實現損益', value: stats.totalRealized, isMoney: true, color: stats.totalRealized >= 0 ? '#f03e3e' : '#2f9e44' },
          { label: '未實現損益', value: unrealizedPnL, isMoney: true, color: unrealizedPnL >= 0 ? '#f03e3e' : '#2f9e44' },
          { label: '累計股利', value: stats.totalDividend, isMoney: true, color: '#f59e0b' },
          { label: '總手續費+稅', value: stats.totalFees, isMoney: true, color: '#94a3b8' },
          { label: '勝率', value: stats.winRate, isPct: true, color: stats.winRate >= 50 ? '#f03e3e' : '#2f9e44',
            sub: `${stats.winCount} 勝 / ${stats.lossCount} 負 / ${stats.sellCount} 筆` },
          { label: '總交易筆數', value: stats.totalTrades, color: 'var(--text-primary)' },
        ].map((card, i) => (
          <div key={i} style={{
            padding: '16px', borderRadius: '12px',
            background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
          }}>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.04em' }}>{card.label}</div>
            <div style={{ fontSize: '20px', fontWeight: 700, color: card.color, fontFamily: "'JetBrains Mono', monospace" }}>
              {card.isMoney
                ? `${(card.value as number) >= 0 ? '+' : ''}${(card.value as number).toLocaleString('zh-TW', { maximumFractionDigits: 0 })}`
                : card.isPct
                ? `${(card.value as number).toFixed(1)}%`
                : card.value.toLocaleString()}
            </div>
            {card.sub && <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' }}>{card.sub}</div>}
            {card.isMoney && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>元</div>}
          </div>
        ))}
      </div>

      {/* Profit Gauge */}
      {stats.sellCount > 0 && (
        <div style={{
          padding: '16px', borderRadius: '12px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>📊 平均獲利 vs 平均虧損</div>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', color: '#f03e3e', marginBottom: '4px' }}>平均獲利</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#f03e3e', fontFamily: "'JetBrains Mono', monospace" }}>
                +{stats.avgWin.toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元
              </div>
            </div>
            <div style={{ width: '1px', height: '40px', background: 'var(--border-primary)' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', color: '#2f9e44', marginBottom: '4px' }}>平均虧損</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#2f9e44', fontFamily: "'JetBrains Mono', monospace" }}>
                {stats.avgLoss.toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元
              </div>
            </div>
            <div style={{ width: '1px', height: '40px', background: 'var(--border-primary)' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '4px' }}>盈虧比</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: "'JetBrains Mono', monospace" }}>
                {stats.avgLoss !== 0 ? Math.abs(stats.avgWin / stats.avgLoss).toFixed(2) : '∞'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Monthly PnL Chart */}
      {monthlyData.length > 0 && (
        <div style={{
          padding: '16px', borderRadius: '12px',
          background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
        }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>📊 月度損益走勢</div>
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
                tickFormatter={(v: number) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toString()}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)',
                  borderRadius: '8px', fontSize: '12px',
                }}
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
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>🏆 個股損益排行</div>
          {stockRanking.map((s, i) => (
            <div key={s.code} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '10px 8px', borderBottom: i < stockRanking.length - 1 ? '1px solid var(--border-primary)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{
                  width: '24px', height: '24px', borderRadius: '50%', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 700,
                  background: i < 3 ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'var(--bg-tertiary)',
                  color: i < 3 ? '#fff' : 'var(--text-muted)',
                }}>{i + 1}</span>
                <div>
                  <span style={{ fontWeight: 600, fontSize: '13px' }}>{s.code}</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)', marginLeft: '6px' }}>{s.name}</span>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontSize: '14px', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace",
                  color: s.pnl >= 0 ? '#f03e3e' : '#2f9e44',
                }}>
                  {s.pnl >= 0 ? '+' : ''}{s.pnl.toLocaleString('zh-TW', { maximumFractionDigits: 0 })}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{s.trades} 筆交易</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Portfolio Component ────────────────────────────────────────────

export default function Portfolio() {
  const { holdings, allStocks, tradeRecords, removeHolding, updateHolding, navigateTo } = useAppStore();
  const [broker] = useBrokerSettings();
  const [activeTab, setActiveTab] = useState<'overview' | 'trades' | 'analytics'>('overview');

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

  // 累計獲利 = 未實現(持倉) + 已實現(賣出) + 累計股利
  const realizedPnL = useMemo(
    () => tradeRecords.filter(t => t.type === 'sell').reduce((s, t) => s + (t.realizedPnL ?? 0), 0),
    [tradeRecords],
  );
  const totalDividend = useMemo(
    () => tradeRecords.filter(t => t.type === 'dividend').reduce((s, t) => s + t.totalAmount, 0),
    [tradeRecords],
  );
  // 累計獲利用「扣費稅後」未實現＋已實現(已為淨額)＋股利，全口徑一致
  const cumulativePnL = totalNetPnL + realizedPnL + totalDividend;

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
              marginLeft: 10, fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 12,
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
              flex: 1, padding: '10px 16px', borderRadius: '10px', fontSize: '13px', fontWeight: 600,
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
        <TradeHistoryPanel />
      ) : activeTab === 'analytics' ? (
        <AnalyticsPanel />
      ) : holdings.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>💼</div>
          <div className={styles.emptyText}>尚未記錄任何持倉</div>
          <div className={styles.emptySub}>搜尋股票後點擊「記錄持倉」按鈕加入</div>
        </div>
      ) : (
        <>
          {/* 崩盤防禦清單（大跌日自動生成，48h 內顯示） */}
          <DefenseBanner />

          {/* 警報推播設定（Web Push） */}
          <PushSetup />

          {/* 個人化每日摘要 (常駐 daemon LLM) */}
          <PortfolioSummary />

          {/* 投組相關性/分散度 (常駐 daemon) */}
          <PortfolioRisk />

          {/* 汰弱留強輪動建議（持股評分 vs 全市場） */}
          <RotationAdvice />

          {/* 投資論點追蹤 (P2：AI 依數據預填草稿，每日檢核) */}
          <ThesisCards />

          {/* 資金總覽（現金流水帳：入金/出金/股利，買賣自動帶入） */}
          <CashLedger />

          {/* 配置漂移再平衡 (P2：個股≤25%/產業≤40%/現金≥10%) */}
          <RebalancePanel />

          {/* 影子帳戶：從交易紀錄學實際規則、抓破戒（Vibe-Trading 概念） */}
          <ShadowAccount />

          {/* 週末復盤週報（每週六） */}
          <WeeklyReport />

          {/* 月度投資報告 (P3：daemon 每月純模板) */}
          <MonthlyReport />

          {/* 股利稅負試算 (P3：已婚合併申報，純前端法定公式) */}
          <DividendTaxCalc />

          {/* 自動停損/停利提醒 (常駐 daemon 觸價寫入) */}
          <PortfolioAlerts />

          {/* 自訂條件警報 */}
          <PortfolioAlertRules />

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
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
                平均持有成本 vs 現價 · 報酬率水位（紅=獲利、綠=虧損，中線為損益兩平）
              </div>

              {/* 整體成本/市值水位 */}
              <div style={{ marginBottom: '18px', paddingBottom: '16px', borderBottom: '1px solid var(--border-primary)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', marginBottom: '8px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>
                    整體 · 成本水位 <strong style={{ color: 'var(--text-secondary)' }}>{Math.round(totalCost).toLocaleString()}</strong>
                    <span style={{ margin: '0 6px' }}>→</span>
                    市值 <strong style={{ color: 'var(--text-secondary)' }}>{Math.round(totalValue).toLocaleString()}</strong>
                  </span>
                  <strong style={{ color: totalPnL >= 0 ? 'var(--color-up)' : 'var(--color-down)', fontFamily: "'JetBrains Mono', monospace" }}>
                    {totalPnLPct >= 0 ? '+' : ''}{totalPnLPct.toFixed(2)}%
                  </strong>
                </div>
                <ProfitGauge pct={totalPnLPct} />
              </div>

              {/* 逐股水位 */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {aggByCode.map(g => (
                  <div key={g.code} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 92px', gap: '14px', alignItems: 'center' }}>
                    <div
                      style={{ cursor: 'pointer', minWidth: 0 }}
                      onClick={() => navigateTo('stock', g.code)}
                    >
                      <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 5 }}>{g.code}<RiskBadge code={g.code} size="xs" /></div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</div>
                    </div>
                    <div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>
                        <span>均價 <strong style={{ color: 'var(--text-secondary)' }}>{g.avgCost.toFixed(2)}</strong></span>
                        <span>現價 <strong style={{ color: g.currentPrice >= g.avgCost ? 'var(--color-up)' : 'var(--color-down)' }}>{g.currentPrice.toFixed(2)}</strong></span>
                        <span>{g.lots} 張</span>
                      </div>
                      <ProfitGauge pct={g.pnlPct} />
                    </div>
                    <div style={{ textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: g.pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                        {g.pnlPct >= 0 ? '+' : ''}{g.pnlPct.toFixed(2)}%
                      </div>
                      <div style={{ fontSize: '12px', color: g.pnl >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
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
                <div className={styles.cardTitle}>持倉比例分布</div>
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
                    <text x="50%" y="47%" textAnchor="middle" fill="var(--text-muted)" fontSize={11}>持倉總市值</text>
                    <text x="50%" y="55%" textAnchor="middle" fill="var(--text-primary)" fontSize={16} fontWeight={800}>
                      {pieData.reduce((t, d) => t + d.value, 0).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元
                    </text>
                    <Tooltip
                      formatter={(v: any, name: any) => {
                        const total = pieData.reduce((t, d) => t + d.value, 0);
                        const pct = total > 0 ? (v / total * 100).toFixed(1) : '0';
                        return [`${(v as number).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 元（${pct}%）`, name];
                      }}
                      contentStyle={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-primary)', borderRadius: '8px', fontSize: '12px' }}
                    />
                    <Legend
                      formatter={(value) => <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{value}</span>}
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
                          <span className={styles.holdingQty}>{fmtQty(item.quantity)}</span>
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
                          <span style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 400 }}>
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
                              if (confirm(`確定要刪除 ${item.buyDate} 買進的 ${fmtQty(item.quantity)} ${item.stockName || item.name} 嗎？`)) {
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
                  <div style={{ fontSize: '0.75rem', marginBottom: '4px', opacity: 0.8 }}>
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
