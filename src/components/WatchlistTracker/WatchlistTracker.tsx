'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppStore } from '@/lib/store';
import type { WatchlistGroup, WatchlistItem, AppNotification } from '@/lib/store';
import styles from './WatchlistTracker.module.css';
import StockTrendChart from './StockTrendChart';
import { startLiveLoop, revealTick, shouldPollNow } from '@/lib/market-clock';
import StockAIEval from './StockAIEval';
import { getTargetPrice } from '@/lib/scoring';
import { MarketPatternBanner } from '@/components/MarketPattern/MarketPatternBanner';
import PageHelp from '@/components/Help/PageHelp';
import { useDayTradeStatus } from '@/lib/useDayTradeCodes';
import { DayTradeMark } from '@/components/shared/DayTradeBadge';
import AddCandidateButton from '@/components/Candidates/AddCandidateButton';
import { MaChipFor, SeqBarsFor } from '@/components/shared/SeqIndicators';
import { useRiskCodes, isDispositionPending, taipeiToday } from '@/lib/useRiskCodes';

// ─── Shared status badges (漲跌停 / 注意 / 處置) ───────────────────────────────
// 注意/處置名單改用全站共用 hook（2026-09-18：此處原有一份複本，處置「尚未生效」的判斷只修共用版就會漏這裡）。
/** Format a date string (YYYY-MM-DD or similar) to M/D for compact display. */
function shortDate(d?: string): string {
  if (!d) return '';
  const m = d.match(/(\d{1,2})[-/](\d{1,2})$/) || d.match(/(\d{2})(\d{2})$/);
  return m ? `${parseInt(m[1], 10)}/${parseInt(m[2], 10)}` : d;
}

/** Inline status tags shown next to a stock name in every tracking tab.
 *  showLimit=false for panels that already render their own 漲跌停 badge. */
function StatusBadges({ code, changePercent, showLimit = true }: { code: string; changePercent?: number | null; showLimit?: boolean }) {
  const risk = useRiskCodes();
  const { attention, disposition, dispEnd, dispStart, attEnd } = risk;
  const dtSt = useDayTradeStatus(code);   // 當沖資格（null = 名單未載入，不渲染）
  const pct = changePercent ?? 0;
  const limitUp = showLimit && pct >= 9.9;
  const limitDown = showLimit && pct <= -9.9;
  const nearUp = showLimit && pct >= 7 && pct < 9.9;
  const pending = disposition.has(code) && isDispositionPending(risk, code);   // 已公告、明日起才處置（3441 實案）
  const isDisp = disposition.has(code) && !pending;
  const isAtt = attention.has(code) && !isDisp;
  if (!limitUp && !limitDown && !nearUp && !isDisp && !isAtt && !pending && dtSt == null) return null;
  const dispUntil = shortDate(dispEnd.get(code));
  const attUntil = shortDate(attEnd.get(code));
  const tag = (text: string, color: string, bg: string, border?: string) => (
    <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color, background: bg, border: border ? `1px solid ${border}` : undefined, padding: '1px 6px', borderRadius: '4px', whiteSpace: 'nowrap' }}>{text}</span>
  );
  return (
    <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
      {limitUp && tag('漲停', 'var(--color-up)', 'rgba(240,62,62,0.15)')}
      {limitDown && tag('跌停', 'var(--color-down)', 'rgba(47,158,68,0.15)')}
      {nearUp && tag('近漲停', '#e67700', 'rgba(230,119,0,0.15)')}
      {isDisp && tag(dispUntil ? `🔴 處置至 ${dispUntil}` : '🔴 處置', '#ef4444', 'rgba(239,68,68,0.18)', 'rgba(239,68,68,0.35)')}
      {isAtt && tag(attUntil ? `🟡 注意至 ${attUntil}` : '🟡 注意', '#eab308', 'rgba(234,179,8,0.18)', 'rgba(234,179,8,0.35)')}
      {pending && tag(`🔴 ${shortDate(dispStart.get(code))}起處置`, '#ef4444', 'rgba(239,68,68,0.18)', 'rgba(239,68,68,0.35)')}
      {dtSt != null && <DayTradeMark status={dtSt} size="xs" />}
    </span>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface LiveQuote {
  code: string;
  name: string;
  price: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  changePercent: number;
  volume: number;
  tradeTime: string;
  source: 'mis_realtime' | 'stock_day_all' | 'snapshot' | 'unknown';
  prevPrice?: number; // previous fetched price for flash detection
  revealAt?: number | null;   // MIS 揭示時戳（R7）；null＝來源未提供
}

interface AiRecommendation {
  code: string;
  name: string;
  score: number;          // 0-100
  signal: string;         // 'STRONG_BUY' | 'BUY' | 'WATCH' | 'NEUTRAL'
  reason: string;
  strategy: string;       // 'momentum' | 'growth' | 'defensive'
  buyPoint?: number;
  sellPoint?: number;
  changePercent?: number;
  // Risk fields
  isAttention?: boolean;
  isDisposition?: boolean;
  riskLevel?: 'high' | 'medium' | 'low';
  riskWarnings?: Array<{
    type: 'attention' | 'disposition';
    label: string;
    reason: string;
    severity: 'critical' | 'warning';
    source: string;
    measures?: string;
    period?: string;
  }>;
}

// 急漲偵測 - 從即時報價計算
export interface RapidRiseStock {
  code: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;  // 漲跌%
  volume: number;         // 成交量
  volumeRatio: number;    // 對平均值倍數（估算）
  strength: '漲停' | '強勢' | '中強' | '温和';
  score: number;          // 綜合得分 0-100
  isLimitUp: boolean;
  closePositionPct: number;  // 收盤在日內高低之間的位置 0-100%
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconPlus() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6" /><path d="M14 11v6" /><path d="M9 6V4h6v2" />
    </svg>
  );
}

function IconBell() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  );
}

function IconRefresh({ spinning }: { spinning?: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      style={{ animation: spinning ? 'spin 1s linear infinite' : undefined }}
    >
      <polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
    </svg>
  );
}

function notifTypeIcon(type: AppNotification['type']) {
  switch (type) {
    case 'limit_up':     return '🔥';
    case 'limit_down':   return '🧊';
    case 'price_alert':  return '📌';
    case 'volume_alert': return '📊';
    case 'ai_signal':    return '🤖';
    case 'signal_alert': return '⚡';
    case 'premarket_reminder': return '⏰';
    default:             return '🔔';
  }
}

function formatTime(ts: number) {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000)   return '剛才';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分前`;
  // Show HH:MM in Taiwan time
  const d = new Date(ts);
  const tw = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${String(tw.getHours()).padStart(2, '0')}:${String(tw.getMinutes()).padStart(2, '0')}`;
}

// ─── Color Swatches for group creation ────────────────────────────────────────

const GROUP_COLORS = [
  '#f03e3e', '#f76707', '#f59f00', '#2f9e44',
  '#1971c2', '#7048e8', '#c2255c', '#0ca678',
];

// ─── Add Group Modal ──────────────────────────────────────────────────────────

function AddGroupModal({ onClose, onAdd }: {
  onClose: () => void;
  onAdd: (name: string, color: string) => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(GROUP_COLORS[0]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onAdd(name.trim(), color);
    onClose();
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>新增自選分組</span>
          <button className={styles.modalClose} onClick={onClose}><IconX /></button>
        </div>
        <form onSubmit={handleSubmit} className={styles.modalForm}>
          <label className={styles.formLabel}>
            群組名稱
            <input
              className={styles.formInput}
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="例：科技股、ETF..."
              autoFocus
              maxLength={20}
            />
          </label>
          <div className={styles.formLabel}>
            顏色
            <div className={styles.colorSwatches}>
              {GROUP_COLORS.map(c => (
                <button
                  key={c}
                  type="button"
                  className={`${styles.colorSwatch} ${color === c ? styles.colorSwatchActive : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`選擇顏色 ${c}`}
                />
              ))}
            </div>
          </div>
          <div className={styles.modalActions}>
            <button type="button" className={styles.btnSecondary} onClick={onClose}>取消</button>
            <button type="submit" className={styles.btnPrimary} disabled={!name.trim()}>新增群組</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ManageGroupsModal({ onClose }: { onClose: () => void }) {
  const watchlistGroups = useAppStore(s => s.watchlistGroups);
  const removeWatchlistGroup = useAppStore(s => s.removeWatchlistGroup);
  const updateWatchlistGroup = useAppStore(s => s.updateWatchlistGroup);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState('');

  const handleStartEdit = (group: any) => {
    setEditingGroupId(group.id);
    setEditName(group.name);
    setEditColor(group.color);
  };

  const handleSaveEdit = (groupId: string) => {
    if (!editName.trim()) return;
    updateWatchlistGroup(groupId, editName.trim(), editColor);
    setEditingGroupId(null);
  };

  const handleDelete = (groupId: string, name: string) => {
    if (confirm(`確定要刪除「${name}」分組嗎？此操作無法撤銷。`)) {
      removeWatchlistGroup(groupId);
    }
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} style={{ width: '420px', maxWidth: '95%' }} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>⚙️ 自選比較組管理</span>
          <button className={styles.modalClose} onClick={onClose} aria-label="關閉"><IconX /></button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '350px', overflowY: 'auto', paddingRight: '4px' }}>
          {watchlistGroups.map(group => {
            const isEditing = editingGroupId === group.id;
            return (
              <div key={group.id} style={{
                display: 'flex', flexDirection: 'column', gap: '8px',
                padding: '10px 12px', border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: '10px', background: 'rgba(255, 255, 255, 0.015)'
              }}>
                {isEditing ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <input
                      className={styles.formInput}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      placeholder="請輸入群組名稱"
                      maxLength={20}
                      autoFocus
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 'calc(13px * var(--fz))', color: '#8b9bb8' }}>群組顏色：</span>
                      <div className={styles.colorSwatches} style={{ gap: '6px' }}>
                        {GROUP_COLORS.map(c => (
                          <button
                            key={c}
                            type="button"
                            className={`${styles.colorSwatch} ${editColor === c ? styles.colorSwatchActive : ''}`}
                            style={{ background: c, width: '20px', height: '20px' }}
                            onClick={() => setEditColor(c)}
                            aria-label={`主題色 ${c}`}
                          />
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '2px' }}>
                      <button className={styles.btnSecondary} style={{ padding: '4px 10px', fontSize: 'calc(13px * var(--fz))', borderRadius: '6px' }} onClick={() => setEditingGroupId(null)}>取消</button>
                      <button className={styles.btnPrimary} style={{ padding: '4px 10px', fontSize: 'calc(13px * var(--fz))', borderRadius: '6px' }} onClick={() => handleSaveEdit(group.id)} disabled={!editName.trim()}>儲存</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: group.color, flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, fontSize: 'calc(13px * var(--fz))', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.name}</span>
                      <span style={{ fontSize: 'calc(13px * var(--fz))', color: '#8b9bb8', background: 'rgba(255, 255, 255, 0.04)', padding: '1px 5px', borderRadius: '4px', flexShrink: 0 }}>{group.stocks.length} 檔</span>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      <button
                        className={styles.btnSecondary}
                        style={{ padding: '3px 8px', fontSize: 'calc(13px * var(--fz))', borderRadius: '6px', minHeight: '24px', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                        onClick={() => handleStartEdit(group)}
                      >
                        ✏️ 編輯
                      </button>
                      {group.id !== 'default' && (
                        <button
                          className={styles.btnSecondary}
                          style={{ padding: '3px 8px', fontSize: 'calc(13px * var(--fz))', borderRadius: '6px', minHeight: '24px', color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.2)', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                          onClick={() => handleDelete(group.id, group.name)}
                        >
                          🗑️ 刪除
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Add Stock Search ─────────────────────────────────────────────────────────

function AddStockBar({ groupId, onAdd }: { groupId: string; onAdd: (groupId: string, stock: WatchlistItem) => void }) {
  const [query, setQuery] = useState('');
  const addInputRef = useRef<HTMLInputElement>(null);
  const allStocks = useAppStore(s => s.allStocks);

  const q = query.trim().toLowerCase();
  const filtered = q.length >= 1
    ? allStocks.filter(s => {
        if (!s) return false;
        const code = s.code ? String(s.code).toLowerCase() : '';
        const name = s.name ? String(s.name).toLowerCase() : '';
        return code.includes(q) || name.includes(q);
      }).slice(0, 8)
    : [];

  const handleAdd = (stock: { code: string; name: string }) => {
    onAdd(groupId, { code: stock.code, name: stock.name, addedAt: Date.now() });
    setQuery('');
    if (addInputRef.current) addInputRef.current.value = '';   // 非受控：自行清空 DOM
  };

  return (
    <div className={styles.addStockBar}>
      <div className={styles.searchWrapper}>
        <svg className={styles.searchIcon} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        {/* ⚠ 這個搜尋框**必須是非受控（uncontrolled）**——不要改回 value={...}。
                     成因（Header.tsx:41 已記錄過同一件事，這次是漏推廣）：
                     父元件每次重渲染，React 就把 controlled value 回寫進 DOM；
                     手機 IME 下這個回寫會把**游標打回開頭**，於是後續字元插在最前面：
                     輸入 3008 變成 8003（Header 那次是 2527 變 7252）。
                     本元件的父層有即時報價輪詢（useLiveQuotes / setInterval），
                     重渲染比 Header 當年的時鐘更頻繁，所以更容易中。
                     ⇒ 顯示用 defaultValue + ref 手動寫入；state 只餵搜尋邏輯。 */}
        <input
          className={styles.searchInput}
          ref={addInputRef}
          defaultValue=""
          onChange={e => setQuery(e.target.value)}
          placeholder="輸入股票代號或名稱..."
        />
        {query && (
          <button className={styles.searchClear} onClick={() => { setQuery(''); if (addInputRef.current) addInputRef.current.value = ''; }}><IconX /></button>
        )}
      </div>
      {filtered.length > 0 && (
        <div className={styles.searchDropdown}>
          {filtered.map(s => (
            <button key={s.code} className={styles.searchResult} onClick={() => handleAdd(s)}>
              <span className={styles.searchResultCode}>{s.code}</span>
              <span className={styles.searchResultName}>{s.name}</span>
              <IconPlus />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Stock Row ────────────────────────────────────────────────────────────────

// AI 訊號 → 顯示樣式（rating.signal 為英文枚舉）
const SIG_STYLE: Record<string, { t: string; c: string; b: string }> = {
  STRONG_BUY: { t: '強力買進', c: '#dc2626', b: 'rgba(220,38,38,0.14)' },
  BUY: { t: '買進', c: '#f97316', b: 'rgba(249,115,22,0.14)' },
  WATCH: { t: '觀察', c: '#f59e0b', b: 'rgba(245,158,11,0.14)' },
  NEUTRAL: { t: '中性', c: '#94a3b8', b: 'rgba(148,163,184,0.12)' },
  SELL: { t: '賣出', c: '#22c55e', b: 'rgba(34,197,94,0.14)' },
};

function StockRow({
  stock,
  quote,
  rating,
  isAiPick,
  hasAlert,
  onRemove,
  isExpanded,
  onToggleExpand,
  showDragHandle,
  onMouseDownDrag,
  onMouseUpDrag,
}: {
  stock: WatchlistItem;
  quote?: LiveQuote;
  rating?: { score: number; signal: string };
  isAiPick?: boolean;
  hasAlert?: boolean;
  onRemove: () => void;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  showDragHandle?: boolean;
  onMouseDownDrag?: () => void;
  onMouseUpDrag?: () => void;
}) {
  const isUp   = (quote?.change ?? 0) > 0;
  const isDown = (quote?.change ?? 0) < 0;
  const isLimitUp   = (quote?.changePercent ?? 0) >= 9.9;
  const isLimitDown = (quote?.changePercent ?? 0) <= -9.9;
  
  const allStocks = useAppStore(s => s.allStocks);
  const navigateTo = useAppStore(s => s.navigateTo);   // 點代號/名稱 → 個股分析頁（2026-08-18）
  const stockInfo = allStocks.find(s => s.code === stock.code);
  const targetPrice = stockInfo ? getTargetPrice({
    ...stockInfo,
    price: quote?.price || stockInfo.price,
    changePercent: quote?.changePercent || stockInfo.changePercent
  }) : null;
  // Flash when price updated by 5s poll
  const priceChanged = quote?.prevPrice !== undefined && quote.prevPrice !== quote.price && (quote?.price ?? 0) > 0;
  const flashClass   = priceChanged
    ? (quote!.price > quote!.prevPrice! ? styles.priceFlashUp : styles.priceFlashDown)
    : '';

  const vol = (quote?.volume ?? 0);
  const volStr = vol >= 1_000_000 ? `${(vol/1_000_000).toFixed(1)}M`
               : vol >= 1_000     ? `${(vol/1_000).toFixed(0)}K`
               : vol > 0          ? vol.toFixed(0) : '--';

  return (
    <div
      data-anchor={stock.code}
      className={`${styles.stockRow} ${showDragHandle ? styles.hasDragHandle : ''} ${isLimitUp ? styles.limitUp : ''} ${isLimitDown ? styles.limitDown : ''}`}
      onClick={onToggleExpand}
      style={{ cursor: 'pointer', borderColor: isExpanded ? 'rgba(99, 102, 241, 0.4)' : undefined, background: isExpanded ? 'rgba(99, 102, 241, 0.03)' : undefined }}
    >
      {showDragHandle && (
        <div
          className={styles.dragHandle}
          onMouseDown={onMouseDownDrag}
          onMouseUp={onMouseUpDrag}
          onMouseLeave={onMouseUpDrag}
          onClick={(e) => e.stopPropagation()}
          title="拖拽排序"
        >
          ⋮⋮
        </div>
      )}
      {/* Stock info */}
      <div className={styles.stockInfo}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {/* 點代號/名稱進個股分析頁（stopPropagation：別觸發整列的展開切換） */}
          <span className={styles.stockCode}
            onClick={(e) => { e.stopPropagation(); navigateTo('stock', stock.code); }}
            style={{ cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'rgba(125,211,252,0.35)', textUnderlineOffset: 3 }}
            title={`開啟 ${stock.code} 個股分析頁`}>
            {stock.code}
          </span>
          {isAiPick  && <span style={{ fontSize: 'calc(12.5px * var(--fz))' }}>🤖</span>}
          {hasAlert  && <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#f59e0b' }}>🔔</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span className={styles.stockName}
            onClick={(e) => { e.stopPropagation(); navigateTo('stock', stock.code); }}
            style={{ cursor: 'pointer' }}
            title={`開啟 ${stock.code} 個股分析頁`}>
            {stock.name || quote?.name || ''}
          </span>
          <StatusBadges code={stock.code} changePercent={quote?.changePercent} />
          {/* 09-17 使用者：列上加候選、三線位置提示（自選各子分頁共用這個 StockRow） */}
          <span onClick={e => e.stopPropagation()}><AddCandidateButton code={stock.code} variant="icon" /></span>
          <MaChipFor code={stock.code} />
        </div>
      </div>

      {/* Price / Change / Pct
          ⚠ 用 class 而不是 nth-child 定位（2026-08-11）：拖曳把手是條件渲染的 DOM 子節點，
            有它沒它會讓所有 nth-child 位移一格——舊的 `.stockRow > div:nth-child(3)`
            在有把手時隱藏到的其實是**價格區**，不是成交量。 */}
      <div className={styles.rowQuote} style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontVariantNumeric: 'tabular-nums' }}>
        {quote ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
              <span
                className={flashClass}
                style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : '#e2e8f0', padding: '1px 4px' }}
              >
                {quote.price > 0 ? quote.price.toFixed(2) : '--'}
              </span>
              <span style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 600, color: isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : '#94a3b8' }}>
                {quote.change > 0 ? '+' : ''}{quote.change.toFixed(2)}
              </span>
              <span className={`${styles.stockPct} ${isUp ? styles.bgUp : isDown ? styles.bgDown : styles.bgFlat}`}>
                {isUp ? '▲' : isDown ? '▼' : '─'}{Math.abs(quote.changePercent).toFixed(2)}%
              </span>
            </div>
            {/* OHLC mini row & Target Price */}
            <div style={{ display: 'flex', gap: '10px', fontSize: 'calc(12.5px * var(--fz))', color: '#94a3b8', alignItems: 'center', flexWrap: 'wrap' }}>
              {(quote.open > 0 || quote.high > 0) && (
                <>
                  <span>開 <b style={{ color: '#94a3b8' }}>{quote.open > 0 ? quote.open.toFixed(2) : '—'}</b></span>
                  <span>高 <b style={{ color: '#ef4444' }}>{quote.high > 0 ? quote.high.toFixed(2) : '—'}</b></span>
                  <span>低 <b style={{ color: '#3b82f6' }}>{quote.low > 0 ? quote.low.toFixed(2) : '—'}</b></span>
                </>
              )}
              {targetPrice !== null && targetPrice !== undefined && (
                <>
                  {(quote.open > 0 || quote.high > 0) && <span style={{ color: 'rgba(255,255,255,0.1)' }}>|</span>}
                  <span style={{ color: 'var(--accent-orange, #f59e0b)' }}>目標 <b style={{ color: 'var(--accent-orange, #f59e0b)' }}>{targetPrice.toFixed(2)}</b></span>
                </>
              )}
              {rating && (
                <>
                  <span style={{ color: 'rgba(255,255,255,0.1)' }}>|</span>
                  <span>評分 <b style={{ color: rating.score >= 75 ? 'var(--color-up)' : rating.score >= 55 ? '#f59e0b' : 'var(--color-down)' }}>{rating.score}</b></span>
                  {SIG_STYLE[rating.signal] && (
                    <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '1px 7px', borderRadius: 6, background: SIG_STYLE[rating.signal].b, color: SIG_STYLE[rating.signal].c }}>
                      {SIG_STYLE[rating.signal].t}
                    </span>
                  )}
                </>
              )}
            </div>
            {/* 近 10 日漲跌×成交量縮圖（09-17）：資料日為最近收盤，未回或無此檔不佔位 */}
            <SeqBarsFor code={stock.code} width={72} />
          </>
        ) : (
          <span className={styles.noData}>載入中...</span>
        )}
      </div>

      {/* Volume */}
      <div className={styles.rowVolume} style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        <div style={{ fontSize: 'calc(14px * var(--fz))', fontWeight: 600, color: '#94a3b8' }}>{volStr}</div>
        {quote?.source === 'mis_realtime' && (
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#22c55e', fontWeight: 700, marginTop: '2px' }}
            title={quote.revealAt ? '交易所揭示時刻（MIS tlong）' : '來源未提供揭示時刻，顯示的是抓取時刻'}>
            ● 即時{quote.tradeTime ? ` ${new Date(quote.tradeTime).toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ''}
          </div>
        )}
      </div>

      <button className={styles.removeBtn} onClick={(e) => { e.stopPropagation(); onRemove(); }} title="移除"><IconTrash /></button>
    </div>
  );
}

// ─── Group Panel ──────────────────────────────────────────────────────────────

function GroupPanel({
  group,
  isActive,
  quotes,
  ratingsMap,
  aiPickCodes,
  alertCodes,
  onRemoveStock,
  onAddStock,
  onDeleteGroup,
  expandedCode,
  onToggleExpand,
}: {
  group: WatchlistGroup;
  isActive: boolean;
  quotes: Record<string, LiveQuote>;
  ratingsMap: Record<string, { score: number; signal: string }>;
  aiPickCodes: Set<string>;
  alertCodes: Set<string>;
  onRemoveStock: (groupId: string, code: string) => void;
  onAddStock: (groupId: string, stock: WatchlistItem) => void;
  onDeleteGroup: (id: string) => void;
  expandedCode: string | null;
  onToggleExpand: (code: string) => void;
}) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [activeDragCode, setActiveDragCode] = useState<string | null>(null);
  const reorderGroupStocks = useAppStore(s => s.reorderGroupStocks);

  if (!isActive) return null;

  const handleDragStart = (e: React.DragEvent, index: number) => {
    e.dataTransfer.effectAllowed = 'move';
    setDraggedIndex(index);
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    if (draggedIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
    setActiveDragCode(null);
  };

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== targetIndex) {
      reorderGroupStocks(group.id, draggedIndex, targetIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
    setActiveDragCode(null);
  };

  return (
    <div className={styles.groupPanel}>
      {/* ⚠ 目前分組標示（2026-08-11 使用者回報「自定義分組無法分辨是哪一組」）：
          分頁列是橫向捲動的，群組一多就會被捲出畫面，只靠分頁的高亮無法回答
          「我現在看的是哪一組」。這一行永遠釘在清單最上方，是唯一可靠的答案。 */}
      <div className={styles.activeGroupBar}>
        <span className={styles.activeGroupDot} style={{ background: group.color || '#6366f1' }} />
        <span className={styles.activeGroupName}>{group.name}</span>
        <span className={styles.activeGroupCount}>{group.stocks.length} 檔</span>
      </div>
      {/* Column headers */}
      <div className={`${styles.tableHeader} ${styles.hasHeaderOffset}`}>
        <span>代號 / 名稱</span>
        <span>現價 / 漲跌% / 開高低</span>
        <span style={{ textAlign: 'right' }}>成交量</span>
        <span></span>
      </div>

      {/* Stock rows */}
      {group.stocks.length === 0 ? (
        <div className={styles.emptyGroup}>
          <span>此分組尚無股票，請在下方搜尋並新增。</span>
        </div>
      ) : (
        group.stocks.map((stock, idx) => {
          const isDragOver = dragOverIndex === idx && draggedIndex !== idx;
          const isDragging = draggedIndex === idx;
          const dragOverClass = isDragOver
            ? (idx > (draggedIndex ?? 0) ? styles.dragOverBottom : styles.dragOverTop)
            : '';

          return (
            <div
              key={stock.code}
              className={`${styles.stockRowContainer} ${dragOverClass} ${isDragging ? styles.isDragging : ''}`}
              draggable={activeDragCode === stock.code}
              onDragStart={(e) => handleDragStart(e, idx)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDragEnd={handleDragEnd}
              onDrop={(e) => handleDrop(e, idx)}
            >
              <StockRow
                stock={stock}
                quote={quotes[stock.code]}
                rating={ratingsMap[stock.code]}
                isAiPick={aiPickCodes.has(stock.code)}
                hasAlert={alertCodes.has(stock.code)}
                onRemove={() => onRemoveStock(group.id, stock.code)}
                isExpanded={expandedCode === stock.code}
                onToggleExpand={() => onToggleExpand(stock.code)}
                showDragHandle={true}
                onMouseDownDrag={() => setActiveDragCode(stock.code)}
                onMouseUpDrag={() => setActiveDragCode(null)}
              />
              {expandedCode === stock.code && (
                <div className={styles.chartWrapper}>
                  <StockTrendChart
                    code={stock.code}
                    name={stock.name || quotes[stock.code]?.name || ''}
                    closePrice={quotes[stock.code]?.price}
                    changePercent={quotes[stock.code]?.changePercent}
                  />
                  <StockAIEval code={stock.code} name={stock.name || quotes[stock.code]?.name || ''} />
                </div>
              )}
            </div>
          );
        })
      )}

      {/* Add stock search */}
      <AddStockBar groupId={group.id} onAdd={onAddStock} />

      {/* Delete group (only for non-default groups) */}
      {group.id !== 'default' && (
        <button
          className={styles.deleteGroupBtn}
          onClick={() => onDeleteGroup(group.id)}
        >
          <IconTrash /> 刪除此群組
        </button>
      )}
    </div>
  );
}

// ─── Notifications Panel ──────────────────────────────────────────────────────

function NotificationsPanel() {
  const notifications = useAppStore(s => s.notifications);
  const clearAllNotifications = useAppStore(s => s.clearAllNotifications);
  const markNotificationRead = useAppStore(s => s.markNotificationRead);

  const recent = notifications.slice(0, 10);

  return (
    <div className={styles.notifPanel}>
      <div className={styles.notifHeader}>
        <span className={styles.notifTitle}>
          <IconBell /> 即時注意事項
          {notifications.filter(n => !n.read).length > 0 && (
            <span className={styles.unreadBadge}>
              {notifications.filter(n => !n.read).length}
            </span>
          )}
        </span>
        {notifications.length > 0 && (
          <button className={styles.clearBtn} onClick={clearAllNotifications}>
            清除全部
          </button>
        )}
      </div>

      <div className={styles.notifList}>
        {recent.length === 0 ? (
          <div className={styles.notifEmpty}>
            <span>暫無通知</span>
          </div>
        ) : (
          recent.map(n => (
            <div
              key={n.id}
              className={`${styles.notifItem} ${!n.read ? styles.notifUnread : ''} ${styles[`sev-${n.severity}`]}`}
              onClick={() => markNotificationRead(n.id)}
            >
              <span className={styles.notifEmoji}>{notifTypeIcon(n.type)}</span>
              <div className={styles.notifContent}>
                <div className={styles.notifMsg}>{n.message}</div>
                <div className={styles.notifDetail}>{n.detail}</div>
                <div className={styles.notifMeta}>
                  {n.stockCode && <span className={styles.notifCode}>{n.stockCode}</span>}
                  <span className={styles.notifTime}>{formatTime(n.timestamp)}</span>
                </div>
              </div>
              {!n.read && <span className={styles.unreadDot} />}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── AI Group Panel ───────────────────────────────────────────────────────────

function AiGroupPanel({
  aiStocks,
  quotes,
  loading,
  onViewStock,
  expandedCode,
  onToggleExpand,
}: {
  aiStocks: AiRecommendation[];
  quotes: Record<string, LiveQuote>;
  loading: boolean;
  onViewStock: (code: string, name: string) => void;
  expandedCode: string | null;
  onToggleExpand: (code: string) => void;
}) {
  const allStocks = useAppStore(s => s.allStocks);
  const strategyLabel: Record<string, string> = {
    momentum: '動能',
    growth: '成長',
    defensive: '防禦',
  };
  const strategyColor: Record<string, string> = {
    momentum: '#f03e3e',
    growth: '#2f9e44',
    defensive: '#1971c2',
  };
  const signalColor = (signal: string) => {
    if (signal.includes('強力買')) return 'var(--color-up)';
    if (signal.includes('買進'))   return '#f97316';
    if (signal.includes('賣出'))   return 'var(--color-down)';
    return '#94a3b8';
  };
  const signalBg = (signal: string) => {
    if (signal.includes('強力買')) return 'rgba(220,38,38,0.12)';
    if (signal.includes('買進'))   return 'rgba(249,115,22,0.12)';
    if (signal.includes('賣出'))   return 'rgba(34,197,94,0.12)';
    return 'rgba(148,163,184,0.1)';
  };

  if (loading && aiStocks.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'calc(14px * var(--fz))' }}>
        <div style={{ fontSize: 'calc(28px * var(--fz))', marginBottom: '12px', animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>🤖</div>
        <div>AI 正在分析市場…</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
      {/* Column header */}
      <div className={styles.aiHeader} style={{
        padding: '8px 16px',
        fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border-primary)',
        letterSpacing: '0.04em',
      }}>
        <span>代號 / 名稱 / 策略</span>
        <span>現價 / 漲跌%</span>
        <span>AI 評分 / 訊號</span>
        <span style={{ textAlign: 'right' }}>操作</span>
      </div>

      {aiStocks.map((ai, idx) => {
        const q = quotes[ai.code];
        const isUp = (q?.changePercent ?? ai.changePercent ?? 0) > 0;
        const isDown = (q?.changePercent ?? ai.changePercent ?? 0) < 0;
        const pct = q?.changePercent ?? ai.changePercent ?? 0;
        const price = q?.price ?? 0;
        const change = q?.change ?? 0;

        const stockInfo = allStocks.find(st => st.code === ai.code);
        const targetPrice = stockInfo ? getTargetPrice({
          ...stockInfo,
          price: q?.price || stockInfo.price,
          changePercent: q?.changePercent || stockInfo.changePercent
        }) : null;
        
        // Flash when price changes between polls
        const priceChanged = q?.prevPrice !== undefined && q.prevPrice !== price && price > 0;
        const flashClass = priceChanged
          ? (price > (q?.prevPrice ?? price) ? styles.priceFlashUp : styles.priceFlashDown)
          : '';
        
        const isExpanded = expandedCode === ai.code;

        return (
          <div key={ai.code} className={styles.stockRowContainer}>
            <div
              onClick={() => onToggleExpand(ai.code)}
              className={styles.aiRow}
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--border-primary)',
                alignItems: 'center',
                background: isExpanded ? 'rgba(99, 102, 241, 0.03)' : (idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)'),
                borderColor: isExpanded ? 'rgba(99, 102, 241, 0.4)' : undefined,
                transition: 'all 0.15s',
                cursor: 'pointer',
              }}
            >
              {/* Stock info */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontWeight: 700, fontSize: 'calc(14.5px * var(--fz))', color: 'var(--text-primary)' }}>{ai.code}</span>
                  <span style={{
                    fontSize: 'calc(12.5px * var(--fz))', padding: '2px 6px', borderRadius: '4px',
                    background: strategyColor[ai.strategy] + '22',
                    color: strategyColor[ai.strategy],
                    fontWeight: 600,
                  }}>{strategyLabel[ai.strategy] ?? ai.strategy}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 'calc(14px * var(--fz))', color: '#f5a623', fontWeight: 700 }}>{ai.name}</span>
                  <StatusBadges code={ai.code} changePercent={pct} />
                  <span onClick={e => e.stopPropagation()}><AddCandidateButton code={ai.code} variant="icon" /></span>
                  <MaChipFor code={ai.code} />
                </div>
                {ai.reason && (
                  <span style={{
                    fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)',
                    overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                    maxWidth: '220px',
                  }} title={ai.reason}>💡 {ai.reason}</span>
                )}
              </div>

              {/* Price / change */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px' }}>
                  <span
                    className={flashClass}
                    style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : 'var(--text-primary)', padding: '2px 4px' }}
                  >
                    {price > 0 ? price.toFixed(2) : '--'}
                  </span>
                  {q?.source === 'mis_realtime' && q.tradeTime && (
                    <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#22c55e', fontWeight: 700 }}>● 即時</span>
                  )}
                </div>
                {price > 0 && (
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <span style={{ fontSize: 'calc(13px * var(--fz))', color: isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : 'var(--text-muted)' }}>
                      {change > 0 ? '+' : ''}{change.toFixed(2)}
                    </span>
                    <span style={{
                      fontSize: 'calc(13px * var(--fz))', padding: '2px 8px', borderRadius: '4px', fontWeight: 600,
                      background: isUp ? 'rgba(220,38,38,0.12)' : isDown ? 'rgba(34,197,94,0.12)' : 'rgba(100,116,139,0.12)',
                      color: isUp ? 'var(--color-up)' : isDown ? 'var(--color-down)' : 'var(--text-muted)',
                    }}>
                      {isUp ? '▲' : isDown ? '▼' : '─'}{Math.abs(pct).toFixed(2)}%
                    </span>
                  </div>
                )}
                {/* Open / High / Low mini row & Target Price */}
                <div style={{ display: 'flex', gap: '8px', fontSize: 'calc(12.5px * var(--fz))', color: '#94a3b8', alignItems: 'center', flexWrap: 'wrap' }}>
                  {q && (q.high > 0 || q.low > 0) && (
                    <>
                      <span>開 <span style={{ color: 'var(--text-secondary)' }}>{q.open > 0 ? q.open.toFixed(2) : '—'}</span></span>
                      <span>高 <span style={{ color: 'var(--color-up)' }}>{q.high > 0 ? q.high.toFixed(2) : '—'}</span></span>
                      <span>低 <span style={{ color: 'var(--color-down)' }}>{q.low > 0 ? q.low.toFixed(2) : '—'}</span></span>
                    </>
                  )}
                  {targetPrice !== null && targetPrice !== undefined && (
                    <>
                      {q && (q.high > 0 || q.low > 0) && <span style={{ color: 'rgba(255,255,255,0.1)' }}>|</span>}
                      <span style={{ color: 'var(--accent-orange, #f59e0b)' }}>目標 <span style={{ color: 'var(--accent-orange, #f59e0b)' }}>{targetPrice.toFixed(2)}</span></span>
                    </>
                  )}
                </div>
                <SeqBarsFor code={ai.code} width={72} />
                {ai.buyPoint && (
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#94a3b8' }}>買點 {ai.buyPoint.toFixed(2)} · 賣點 {ai.sellPoint?.toFixed(2) ?? '--'}</span>
                )}
              </div>

              {/* AI score + signal */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {/* Score bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ flex: 1, height: '6px', borderRadius: '999px', background: 'var(--bg-tertiary)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${ai.score}%`, borderRadius: '999px',
                      background: ai.score >= 75 ? 'var(--color-up)' : ai.score >= 55 ? '#f59e0b' : 'var(--color-down)',
                    }} />
                  </div>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: 'var(--text-primary)', minWidth: '28px' }}>{ai.score}</span>
                </div>
                {/* Signal badge */}
                <span style={{
                  fontSize: 'calc(13px * var(--fz))', padding: '3px 10px', borderRadius: '6px', fontWeight: 600,
                  background: signalBg(ai.signal), color: signalColor(ai.signal),
                  width: 'fit-content',
                }}>{ai.signal}</span>
              </div>

              {/* Action */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={(e) => { e.stopPropagation(); onViewStock(ai.code, ai.name); }}
                  style={{
                    fontSize: 'calc(13px * var(--fz))', padding: '6px 12px', borderRadius: '6px',
                    background: 'rgba(99,102,241,0.12)', color: '#818cf8',
                    border: '1px solid rgba(99,102,241,0.3)', cursor: 'pointer',
                    fontWeight: 600, transition: 'all 0.15s',
                  }}
                  title={`查看 ${ai.code} 個股分析`}
                >
                  查看
                </button>
              </div>
            </div>
            {isExpanded && (
              <div className={styles.chartWrapper} style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.005)', borderBottom: '1px solid var(--border-primary)' }}>
                <StockTrendChart
                  code={ai.code}
                  name={ai.name}
                  closePrice={price}
                />
              </div>
            )}
          </div>
        );
      })}

      {aiStocks.length === 0 && !loading && (
        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'calc(13px * var(--fz))' }}>
          暫無 AI 推薦股票
        </div>
      )}
    </div>
  );
}
// ─── Risk Monitor Panel ───────────────────────────────────────────────────────

interface RiskStockItem {
  code: string;
  name: string;
  type: 'attention' | 'disposition';
  reason: string;
  startDate?: string;
  endDate?: string;
  measures?: string;
  source: 'TWSE' | 'TPEx';
}

function RiskMonitorPanel({ onViewStock }: { onViewStock: (code: string, name: string) => void }) {
  const [attention, setAttention] = useState<RiskStockItem[]>([]);
  const [disposition, setDisposition] = useState<RiskStockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'disposition' | 'attention'>('all');
  const [listDates, setListDates] = useState<{ twse?: string | null; tpex?: string | null }>({});
  const watchlistGroups = useAppStore(s => s.watchlistGroups);

  // Get all user's watchlist codes for cross-reference
  const userCodes = new Set(watchlistGroups.flatMap(g => g.stocks.map(s => s.code)));

  useEffect(() => {
    setLoading(true);
    fetch('/api/twse/risk-stocks', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (data.attention) setAttention(data.attention);
        if (data.disposition) setDisposition(data.disposition);
        setListDates({ twse: data.twseAttentionDate, tpex: data.tpexAttentionDate });
      })
      .catch(err => console.error('[RiskMonitor] fetch error:', err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div style={{ padding: '60px 20px', textAlign: 'center' }}>
        <div style={{ fontSize: 'calc(40px * var(--fz))', marginBottom: '12px', animation: 'pulse 1.5s infinite' }}>⚠️</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 'calc(14px * var(--fz))' }}>載入注意/處置股票名單中...</div>
      </div>
    );
  }

  const allRisk = [
    ...disposition.map(d => ({ ...d, _priority: 0 })),
    ...attention.map(a => ({ ...a, _priority: 1 })),
  ];

  // User holdings first, then by priority (disposition > attention)
  const filtered = (filter === 'all' ? allRisk : allRisk.filter(r => r.type === filter))
    .sort((a, b) => {
      const aUser = userCodes.has(a.code) ? -1 : 0;
      const bUser = userCodes.has(b.code) ? -1 : 0;
      if (aUser !== bUser) return aUser - bUser;
      return a._priority - b._priority;
    });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', padding: '12px 0' }}>
      {/* Header */}
      <div style={{ padding: '0 16px' }}>
        <div style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          ⚠️ 風險監控中心
        </div>
        <div style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginTop: '4px' }}>
          證交所/櫃買中心公告之注意與處置股票 · 共 {disposition.length + attention.length} 檔
          {(listDates.twse || listDates.tpex) && <span title="注意股是公布日隔天生效的狀態；顯示的是最近一次已公布的名單，新名單通常在收盤後傍晚公布"> · 注意股名單日：上市 {listDates.twse?.slice(5) ?? '—'}／上櫃 {listDates.tpex?.slice(5) ?? '—'}</span>}
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', padding: '0 16px' }}>
        <div style={{
          padding: '14px', borderRadius: '12px',
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
        }}>
          <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#ef4444', fontWeight: 600 }}>🔴 處置股票</div>
          <div style={{ fontSize: 'calc(28px * var(--fz))', fontWeight: 800, color: '#ef4444', marginTop: '4px' }}>{disposition.length}</div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>交易限制 · 預收款券</div>
        </div>
        <div style={{
          padding: '14px', borderRadius: '12px',
          background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.2)',
        }}>
          <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#eab308', fontWeight: 600 }}>🟡 注意股票</div>
          <div style={{ fontSize: 'calc(28px * var(--fz))', fontWeight: 800, color: '#eab308', marginTop: '4px' }}>{attention.length}</div>
          <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>交易異常 · 觀察名單</div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: 'flex', gap: '6px', padding: '0 16px' }}>
        {([
          { id: 'all' as const, label: '全部', count: disposition.length + attention.length },
          { id: 'disposition' as const, label: '🔴 處置', count: disposition.length },
          { id: 'attention' as const, label: '🟡 注意', count: attention.length },
        ]).map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              padding: '6px 14px', borderRadius: '20px', fontSize: 'calc(13px * var(--fz))', fontWeight: 600,
              background: filter === f.id ? (f.id === 'disposition' ? '#ef4444' : f.id === 'attention' ? '#eab308' : 'var(--accent-purple, #7c3aed)') : 'var(--bg-tertiary)',
              color: filter === f.id ? '#fff' : 'var(--text-secondary)',
              border: 'none', cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {f.label} ({f.count})
          </button>
        ))}
      </div>

      {/* Risk Stock List */}
      {filtered.length === 0 ? (
        <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 'calc(40px * var(--fz))', marginBottom: '10px' }}>✅</div>
          <div style={{ fontSize: 'calc(14px * var(--fz))' }}>目前無{filter === 'disposition' ? '處置' : filter === 'attention' ? '注意' : '風險'}股票</div>
        </div>
      ) : (
        /* 熱力圖同款緊湊格狀（處置紅/注意黃，持股高亮；詳情看 tooltip、點格進個股） */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: '5px', padding: '0 16px' }}>
          {filtered.map((stock, idx) => {
            const isDisp = stock.type === 'disposition';
            const dispPending = isDisp && !!stock.startDate && stock.startDate > taipeiToday();   // 已公告、尚未生效
            const isUserHolding = userCodes.has(stock.code);
            const until = isDisp && stock.endDate ? stock.endDate.replace(/^\d{4}\//, '') : '';
            const tip = [`${stock.code} ${stock.name}（${stock.source}）`, stock.reason,
              isDisp && stock.measures ? `📋 ${stock.measures}` : '',
              isDisp && stock.startDate && stock.endDate ? `📅 ${stock.startDate} ~ ${stock.endDate}` : '',
              isUserHolding ? '⚠️ 您的持股' : ''].filter(Boolean).join('\n');
            return (
              <button
                key={`${stock.type}-${stock.code}-${idx}`}
                onClick={() => onViewStock(stock.code, stock.name)}
                title={tip}
                style={{
                  position: 'relative', padding: '7px 4px 6px', borderRadius: '8px', cursor: 'pointer',
                  background: isDisp ? 'rgba(239,68,68,0.55)' : 'rgba(234,179,8,0.45)',
                  border: isUserHolding ? '2px solid #fff' : '1px solid transparent',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px',
                  color: '#fff', minWidth: 0,
                }}
              >
                {isUserHolding && <span style={{ position: 'absolute', top: 1, right: 3, fontSize: 'calc(12.5px * var(--fz))' }}>⚠️</span>}
                <span style={{ fontWeight: 800, fontSize: 'calc(13px * var(--fz))', fontFamily: "'JetBrains Mono', monospace" }}>{stock.code}</span>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 600, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stock.name}</span>
                <span style={{ fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, color: isDisp ? '#ffd6d6' : '#fff3bf' }}>
                  {dispPending ? `${shortDate(stock.startDate)}起處置` : isDisp ? (until ? `處置至${until}` : '處置') : '注意'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Info Footer */}
      <div style={{
        padding: '12px 16px', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)',
        borderTop: '1px solid var(--border-primary)', lineHeight: '1.6',
      }}>
        <div><strong>📌 注意股票</strong>：交易量、價格波動等異常，證交所提醒投資人注意交易風險。</div>
        <div><strong>🚫 處置股票</strong>：已被限制交易（約每 2 分鐘分盤撮合、預收全額款券），買賣受限、流動性差。2026-08-10 新制：處置期由 10 個營業日縮短為 5 個（合併當沖過高者 7 個）。</div>
        <div style={{ marginTop: '4px', opacity: 0.7 }}>資料來源：證交所、櫃買中心 OpenAPI</div>
      </div>
    </div>
  );
}

// ─── Rapid Rise Computation ─────────────────────────────────────────────────────────────────

function computeRapidRisers(quotes: Record<string, LiveQuote>): RapidRiseStock[] {
  // Get all valid stocks with positive change, sorted by change%
  const allQuotes = Object.values(quotes).filter(q =>
    /^\d{4}$/.test(q.code) &&
    q.price > 0 &&
    q.changePercent > 0  // 只要有漲就列入排序
  );
  if (allQuotes.length === 0) return [];

  // 先排序再取 top 20 — 永遠保持 20 檔
  const sorted = allQuotes.sort((a, b) => b.changePercent - a.changePercent).slice(0, 20);

  // 平均成交量（用於估算量能倍數）
  const avgVolume = sorted.reduce((s, q) => s + q.volume, 0) / sorted.length;

  return sorted
    .map(q => {
      const isLimitUp = q.changePercent >= 9.9;
      const volRatio = avgVolume > 0 ? parseFloat((q.volume / avgVolume).toFixed(2)) : 1;

      // 价格位置評估（用漲跌%跟漲跌表示，漲跌越大表示收在高位）
      const closePositionPct = Math.min(100, Math.round((q.changePercent / 10) * 100));

      // 綜合得分：漲幅占 50% + 量能偵測 30% + 進喀度 20%
      const changeSc = Math.min(50, q.changePercent * 5);
      const volSc    = Math.min(30, volRatio * 10);
      const posSc    = Math.min(20, closePositionPct * 0.2);
      const score    = Math.round(changeSc + volSc + posSc);

      const strength: RapidRiseStock['strength'] =
        isLimitUp        ? '漲停'
        : q.changePercent >= 7 ? '強勢'
        : q.changePercent >= 5 ? '中強'
        : '温和';

      return {
        code: q.code,
        name: q.name,
        price: q.price,
        change: q.change,
        changePercent: q.changePercent,
        volume: q.volume,
        volumeRatio: volRatio,
        strength,
        score,
        isLimitUp,
        closePositionPct,
      } satisfies RapidRiseStock;
    })
    .sort((a, b) => b.score - a.score);
}

// ─── Rapid Rise Panel ─────────────────────────────────────────────────────────────────

function RapidRisePanel({
  stocks,
  loading,
  onViewStock,
  expandedCode,
  onToggleExpand,
}: {
  stocks: RapidRiseStock[];
  loading: boolean;
  onViewStock: (code: string, name: string) => void;
  expandedCode: string | null;
  onToggleExpand: (code: string) => void;
}) {
  const allStocks = useAppStore(s => s.allStocks);
  const [filter, setFilter] = useState<'all' | 'limit' | 'strong' | 'mid'>('all');

  const filtered = stocks.filter(s => {
    if (filter === 'limit')  return s.isLimitUp;
    if (filter === 'strong') return s.strength === '強勢' || s.strength === '漲停';
    if (filter === 'mid')    return s.strength === '中強';
    return true;
  });

  const strengthColor: Record<RapidRiseStock['strength'], string> = {
    '漲停': '#ef4444',
    '強勢': '#f97316',
    '中強': '#eab308',
    '温和': '#94a3b8',
  };
  const strengthBg: Record<RapidRiseStock['strength'], string> = {
    '漲停': 'rgba(239,68,68,0.15)',
    '強勢': 'rgba(249,115,22,0.12)',
    '中強': 'rgba(234,179,8,0.1)',
    '温和': 'rgba(148,163,184,0.08)',
  };

  if (loading && stocks.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: 'calc(32px * var(--fz))', marginBottom: '12px', animation: 'spin 1.2s linear infinite', display: 'inline-block' }}>🚀</div>
        <div style={{ fontSize: 'calc(14px * var(--fz))' }}>準備急漲偵測，請稍候…</div>
      </div>
    );
  }

  if (stocks.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: 'calc(32px * var(--fz))', marginBottom: '12px' }}>📊</div>
        <div style={{ fontSize: 'calc(14px * var(--fz))' }}>目前尚無上漲個股，請市場開盤後再查看</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>

      {/* Filter bar */}
      <div style={{
        display: 'flex', gap: '8px', padding: '10px 16px',
        borderBottom: '1px solid var(--border-primary)',
        alignItems: 'center', flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginRight: '4px' }}>筌選：</span>
        {([
          { id: 'all',    label: '全部', count: stocks.length },
          { id: 'limit',  label: '🔴 漲停板', count: stocks.filter(s => s.isLimitUp).length },
          { id: 'strong', label: '🟠 強勢', count: stocks.filter(s => s.strength === '強勢' || s.strength === '漲停').length },
          { id: 'mid',    label: '🟡 中強', count: stocks.filter(s => s.strength === '中強').length },
        ] as const).map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              fontSize: 'calc(12.5px * var(--fz))', padding: '4px 12px', borderRadius: '999px', cursor: 'pointer',
              background: filter === f.id ? 'var(--color-up)' : 'var(--bg-secondary)',
              color: filter === f.id ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${filter === f.id ? 'var(--color-up)' : 'var(--border-primary)'}`,
              fontWeight: filter === f.id ? 700 : 400, transition: 'all 0.15s',
            }}
          >{f.label} <span style={{ opacity: 0.7 }}>{f.count}</span></button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>
          顯示 {filtered.length} 支 · 漲幅排行 TOP 20
        </span>
      </div>

      {/* Column header */}
      <div className={styles.surgeHeader} style={{
        padding: '8px 16px', fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border-primary)', letterSpacing: '0.04em',
      }}>
        <span>代號 / 名稱</span>
        <span>現價 / 漲跌%</span>
        <span>成交量 / 量能倍數</span>
        <span>強度 / 得分</span>
        <span style={{ textAlign: 'right' }}>操作</span>
      </div>

      {filtered.map((s, idx) => {
        const isExpanded = expandedCode === s.code;
        const stockInfo = allStocks.find(st => st.code === s.code);
        const targetPrice = stockInfo ? getTargetPrice({
          ...stockInfo,
          price: s.price || stockInfo.price,
          changePercent: s.changePercent || stockInfo.changePercent
        }) : null;
        return (
          <div key={s.code} className={styles.stockRowContainer}>
            <div
              onClick={() => onToggleExpand(s.code)}
              className={styles.surgeRow}
              style={{
                padding: '11px 16px', alignItems: 'center',
                borderBottom: '1px solid var(--border-primary)',
                background: isExpanded ? 'rgba(99, 102, 241, 0.03)' : (s.isLimitUp
                  ? 'rgba(239,68,68,0.04)'
                  : idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.013)'),
                borderColor: isExpanded ? 'rgba(99, 102, 241, 0.4)' : undefined,
                transition: 'all 0.12s',
                cursor: 'pointer',
              }}
            >
              {/* Code / Name */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontWeight: 700, fontSize: 'calc(14px * var(--fz))', color: 'var(--text-primary)' }}>{s.code}</span>
                  {s.isLimitUp && (
                    <span style={{
                      fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: '4px',
                      background: 'rgba(239,68,68,0.18)', color: '#ef4444', fontWeight: 700,
                    }}>漲停板</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 'calc(14px * var(--fz))', color: '#f5a623', fontWeight: 700 }}>{s.name}</span>
                  <StatusBadges code={s.code} showLimit={false} />
                </div>
                {/* Mini position bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <div style={{ flex: 1, height: '3px', borderRadius: '999px', background: 'var(--bg-tertiary)', maxWidth: '60px' }}>
                    <div style={{
                      height: '100%', width: `${s.closePositionPct}%`,
                      borderRadius: '999px',
                      background: s.isLimitUp ? '#ef4444' : s.changePercent >= 5 ? '#f97316' : '#eab308',
                    }} />
                  </div>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>高位報收</span>
                </div>
              </div>

              {/* Price / change% & Target Price */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: 'var(--color-up)' }}>
                  {s.price.toFixed(2)}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--color-up)' }}>+{s.change.toFixed(2)}</span>
                  <span style={{
                    fontSize: 'calc(12.5px * var(--fz))', padding: '2px 7px', borderRadius: '4px', fontWeight: 700,
                    background: 'rgba(220,38,38,0.12)', color: 'var(--color-up)',
                  }}>▲{s.changePercent.toFixed(2)}%</span>
                </div>
                {targetPrice !== null && targetPrice !== undefined && (
                  <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--accent-orange, #f59e0b)' }}>
                    目標 {targetPrice.toFixed(2)}
                  </span>
                )}
              </div>

              {/* Volume / ratio */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {s.volume >= 1000000
                    ? `${(s.volume / 1000000).toFixed(1)}M`
                    : s.volume >= 1000
                    ? `${(s.volume / 1000).toFixed(0)}K`
                    : s.volume.toFixed(0)}
                </span>
                <span style={{
                  fontSize: 'calc(13px * var(--fz))',
                  color: s.volumeRatio >= 3 ? '#ef4444' : s.volumeRatio >= 2 ? '#f97316' : 'var(--text-muted)',
                }}>
                  {s.volumeRatio >= 1.5 ? '📢 ' : ''}×{s.volumeRatio.toFixed(1)} 平均量
                </span>
              </div>

              {/* Strength / score */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <span style={{
                  fontSize: 'calc(12.5px * var(--fz))', padding: '3px 8px', borderRadius: '6px', fontWeight: 600,
                  background: strengthBg[s.strength], color: strengthColor[s.strength],
                  width: 'fit-content',
                }}>{s.strength}</span>
                {/* Score bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <div style={{ flex: 1, height: '5px', borderRadius: '999px', background: 'var(--bg-tertiary)', overflow: 'hidden', maxWidth: '50px' }}>
                    <div style={{
                      height: '100%',
                      width: `${s.score}%`,
                      borderRadius: '999px',
                      background: s.score >= 70 ? '#ef4444' : s.score >= 55 ? '#f97316' : '#eab308',
                    }} />
                  </div>
                  <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>{s.score}</span>
                </div>
              </div>

              {/* Action */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={(e) => { e.stopPropagation(); onViewStock(s.code, s.name); }}
                  style={{
                    fontSize: 'calc(13px * var(--fz))', padding: '5px 10px', borderRadius: '6px',
                    background: 'rgba(220,38,38,0.1)', color: 'var(--color-up)',
                    border: '1px solid rgba(220,38,38,0.3)', cursor: 'pointer',
                    fontWeight: 600, transition: 'all 0.15s',
                  }}
                >查看</button>
              </div>
            </div>
            {isExpanded && (
              <div className={styles.chartWrapper} style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.005)', borderBottom: '1px solid var(--border-primary)' }}>
                <StockTrendChart
                  code={s.code}
                  name={s.name}
                  closePrice={s.price}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
// ─── Rapid Fall Types & Computation ───────────────────────────────────────────────────────────

export interface RapidFallStock {
  code: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;  // 負數
  volume: number;
  volumeRatio: number;
  severity: '跌停' | '急跌' | '中跌' | '小跌';
  score: number;          // 下漬壓力得分 0-100
  isLimitDown: boolean;
  alertLevel: 'critical' | 'warning' | 'info';
}

function computeRapidFallers(quotes: Record<string, LiveQuote>): RapidFallStock[] {
  // Get all valid stocks with negative change, sorted by change%
  const allQuotes = Object.values(quotes).filter(q =>
    /^\d{4}$/.test(q.code) &&
    q.price > 0 &&
    q.changePercent < 0   // 只要有跌就列入排序
  );
  if (allQuotes.length === 0) return [];

  // 先排序再取 top 20 — 永遠保持 20 檔
  const sorted = allQuotes.sort((a, b) => a.changePercent - b.changePercent).slice(0, 20);

  const avgVolume = sorted.reduce((s, q) => s + q.volume, 0) / sorted.length;

  return sorted
    .map(q => {
      const isLimitDown = q.changePercent <= -9.9;
      const volRatio = avgVolume > 0 ? parseFloat((q.volume / avgVolume).toFixed(2)) : 1;
      // 拋盤壓力得分：跌幅占 50% + 量能傳達賣壓力 30% + 跌幅絕對大小 20%
      const fallSc = Math.min(50, Math.abs(q.changePercent) * 5);
      const volSc  = Math.min(30, volRatio * 10);
      const absSc  = Math.min(20, Math.abs(q.changePercent) * 2);
      const score  = Math.round(fallSc + volSc + absSc);

      const severity: RapidFallStock['severity'] =
        isLimitDown               ? '跌停'
        : q.changePercent <= -7   ? '急跌'
        : q.changePercent <= -5   ? '中跌'
        : '小跌';

      const alertLevel: RapidFallStock['alertLevel'] =
        isLimitDown               ? 'critical'
        : q.changePercent <= -5   ? 'warning'
        : 'info';

      return {
        code: q.code,
        name: q.name,
        price: q.price,
        change: q.change,
        changePercent: q.changePercent,
        volume: q.volume,
        volumeRatio: volRatio,
        severity,
        score,
        isLimitDown,
        alertLevel,
      } satisfies RapidFallStock;
    })
    .sort((a, b) => a.changePercent - b.changePercent);
}

// ─── Rapid Fall Panel ────────────────────────────────────────────────────────────

function RapidFallPanel({
  stocks,
  loading,
  onViewStock,
  expandedCode,
  onToggleExpand,
}: {
  stocks: RapidFallStock[];
  loading: boolean;
  onViewStock: (code: string, name: string) => void;
  expandedCode: string | null;
  onToggleExpand: (code: string) => void;
}) {
  const allStocks = useAppStore(s => s.allStocks);
  const [filter, setFilter] = useState<'all' | 'limit' | 'sharp' | 'mid'>('all');

  const filtered = stocks.filter(s => {
    if (filter === 'limit') return s.isLimitDown;
    if (filter === 'sharp') return s.severity === '急跌' || s.severity === '跌停';
    if (filter === 'mid')   return s.severity === '中跌';
    return true;
  });

  // Taiwan market: 跌 = green
  const sevColor: Record<RapidFallStock['severity'], string> = {
    '跌停': '#22c55e',
    '急跌': '#16a34a',
    '中跌': '#4ade80',
    '小跌': '#86efac',
  };
  const sevBg: Record<RapidFallStock['severity'], string> = {
    '跌停': 'rgba(34,197,94,0.15)',
    '急跌': 'rgba(22,163,74,0.12)',
    '中跌': 'rgba(74,222,128,0.1)',
    '小跌': 'rgba(134,239,172,0.08)',
  };

  if (loading && stocks.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: 'calc(32px * var(--fz))', marginBottom: '12px', animation: 'spin 1.2s linear infinite', display: 'inline-block' }}>🔻</div>
        <div style={{ fontSize: 'calc(14px * var(--fz))' }}>準備急落偵測，請稍候…</div>
      </div>
    );
  }

  if (stocks.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: 'calc(32px * var(--fz))', marginBottom: '12px' }}>📈</div>
        <div style={{ fontSize: 'calc(14px * var(--fz))' }}>目前尚無下跌個股，市場還算穩定</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>

      {/* Filter bar */}
      <div style={{
        display: 'flex', gap: '8px', padding: '10px 16px',
        borderBottom: '1px solid var(--border-primary)',
        alignItems: 'center', flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)', marginRight: '4px' }}>筌選：</span>
        {([
          { id: 'all',   label: '全部',     count: stocks.length },
          { id: 'limit', label: '🟢 跌停板', count: stocks.filter(s => s.isLimitDown).length },
          { id: 'sharp', label: '🟢 急跌',  count: stocks.filter(s => s.severity === '急跌' || s.severity === '跌停').length },
          { id: 'mid',   label: '🟢 中跌',  count: stocks.filter(s => s.severity === '中跌').length },
        ] as const).map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            style={{
              fontSize: 'calc(12.5px * var(--fz))', padding: '4px 12px', borderRadius: '999px', cursor: 'pointer',
              background: filter === f.id ? '#16a34a' : 'var(--bg-secondary)',
              color: filter === f.id ? '#fff' : 'var(--text-muted)',
              border: `1px solid ${filter === f.id ? '#16a34a' : 'var(--border-primary)'}`,
              fontWeight: filter === f.id ? 700 : 400, transition: 'all 0.15s',
            }}
          >{f.label} <span style={{ opacity: 0.7 }}>{f.count}</span></button>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>
          顯示 {filtered.length} 支 · 跌幅排行 TOP 20
        </span>
      </div>

      {/* Column header */}
      <div className={styles.surgeHeader} style={{
        padding: '8px 16px', fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border-primary)', letterSpacing: '0.04em',
      }}>
        <span>代號 / 名稱</span>
        <span>現價 / 跌幅%</span>
        <span>成交量 / 賣壓量能</span>
        <span>嚴重度 / 壓力分</span>
        <span style={{ textAlign: 'right' }}>操作</span>
      </div>

      {filtered.map((s, idx) => {
        const isExpanded = expandedCode === s.code;
        const stockInfo = allStocks.find(st => st.code === s.code);
        const targetPrice = stockInfo ? getTargetPrice({
          ...stockInfo,
          price: s.price || stockInfo.price,
          changePercent: s.changePercent || stockInfo.changePercent
        }) : null;
        return (
          <div key={s.code} className={styles.stockRowContainer}>
            <div
              onClick={() => onToggleExpand(s.code)}
              className={styles.surgeRow}
              style={{
                padding: '11px 16px', alignItems: 'center',
                borderBottom: '1px solid var(--border-primary)',
                background: isExpanded ? 'rgba(99, 102, 241, 0.03)' : (s.isLimitDown
                  ? 'rgba(34,197,94,0.04)'
                  : idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.013)'),
                borderColor: isExpanded ? 'rgba(99, 102, 241, 0.4)' : undefined,
                transition: 'all 0.12s',
                cursor: 'pointer',
              }}
            >
              {/* Code / Name */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontWeight: 700, fontSize: 'calc(14px * var(--fz))', color: 'var(--text-primary)' }}>{s.code}</span>
                  {s.isLimitDown && (
                    <span style={{
                      fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: '4px',
                      background: 'rgba(34,197,94,0.18)', color: '#22c55e', fontWeight: 700,
                    }}>跌停板</span>
                  )}
                  {s.alertLevel === 'critical' && !s.isLimitDown && (
                    <span style={{
                      fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: '4px',
                      background: 'rgba(239,68,68,0.12)', color: '#ef4444', fontWeight: 600,
                    }}>注意</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 'calc(14px * var(--fz))', color: '#f5a623', fontWeight: 700 }}>{s.name}</span>
                  <StatusBadges code={s.code} showLimit={false} />
                </div>
                {/* Fall depth bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <div style={{ flex: 1, height: '3px', borderRadius: '999px', background: 'var(--bg-tertiary)', maxWidth: '60px' }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.min(100, Math.abs(s.changePercent) * 10)}%`,
                      borderRadius: '999px',
                      background: s.isLimitDown ? '#22c55e' : s.changePercent <= -5 ? '#16a34a' : '#4ade80',
                    }} />
                  </div>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>跌幅深度</span>
                </div>
              </div>

              {/* Price / change% & Target Price */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: 'var(--color-down)' }}>
                  {s.price.toFixed(2)}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--color-down)' }}>{s.change.toFixed(2)}</span>
                  <span style={{
                    fontSize: 'calc(12.5px * var(--fz))', padding: '2px 7px', borderRadius: '4px', fontWeight: 700,
                    background: 'rgba(34,197,94,0.12)', color: 'var(--color-down)',
                  }}>▼{Math.abs(s.changePercent).toFixed(2)}%</span>
                </div>
                {targetPrice !== null && targetPrice !== undefined && (
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--accent-orange, #f59e0b)' }}>
                    目標 {targetPrice.toFixed(2)}
                  </span>
                )}
              </div>

              {/* Volume / ratio */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontSize: 'calc(13px * var(--fz))', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {s.volume >= 1000000
                    ? `${(s.volume / 1000000).toFixed(1)}M`
                    : s.volume >= 1000
                    ? `${(s.volume / 1000).toFixed(0)}K`
                    : s.volume.toFixed(0)}
                </span>
                <span style={{
                  fontSize: 'calc(12.5px * var(--fz))',
                  color: s.volumeRatio >= 3 ? '#22c55e' : s.volumeRatio >= 2 ? '#4ade80' : 'var(--text-muted)',
                }}>
                  {s.volumeRatio >= 1.5 ? '📢 ' : ''}×{s.volumeRatio.toFixed(1)} 賣壓量
                </span>
              </div>

              {/* Severity / score */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <span style={{
                  fontSize: 'calc(12.5px * var(--fz))', padding: '3px 8px', borderRadius: '6px', fontWeight: 600,
                  background: sevBg[s.severity], color: sevColor[s.severity],
                  width: 'fit-content',
                }}>{s.severity}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <div style={{ flex: 1, height: '5px', borderRadius: '999px', background: 'var(--bg-tertiary)', overflow: 'hidden', maxWidth: '50px' }}>
                    <div style={{
                      height: '100%', width: `${s.score}%`, borderRadius: '999px',
                      background: s.score >= 70 ? '#22c55e' : s.score >= 50 ? '#4ade80' : '#86efac',
                    }} />
                  </div>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>{s.score}</span>
                </div>
              </div>

              {/* Action */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={(e) => { e.stopPropagation(); onViewStock(s.code, s.name); }}
                  style={{
                    fontSize: 'calc(12.5px * var(--fz))', padding: '5px 10px', borderRadius: '6px',
                    background: 'rgba(34,197,94,0.1)', color: 'var(--color-down)',
                    border: '1px solid rgba(34,197,94,0.3)', cursor: 'pointer',
                    fontWeight: 600, transition: 'all 0.15s',
                  }}
                >查看</button>
              </div>
            </div>
            {isExpanded && (
              <div className={styles.chartWrapper} style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.005)', borderBottom: '1px solid var(--border-primary)' }}>
                <StockTrendChart
                  code={s.code}
                  name={s.name}
                  closePrice={s.price}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Institutional Panel ──────────────────────────────────────────────────────

interface InstitutionalStockItem {
  code: string;
  name: string;
  foreignNetShares: number;
  trustNetShares: number;
  dealerNetShares: number;
  totalNetShares: number;
  foreignNetLots: number;
  trustNetLots: number;
  dealerNetLots: number;
  totalNetLots: number;
  price?: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  tradeTime?: string;
}

type InstitutionalMode = 'inst-buy' | 'inst-sell' | 'foreign-buy' | 'foreign-sell';

function InstitutionalPanel({
  stocks,
  mode,
  loading,
  dataDate,
  onViewStock,
  expandedCode,
  onToggleExpand,
}: {
  stocks: InstitutionalStockItem[];
  mode: InstitutionalMode;
  loading: boolean;
  dataDate: string;
  onViewStock: (code: string, name: string) => void;
  expandedCode: string | null;
  onToggleExpand: (code: string) => void;
}) {
  const allStocks = useAppStore(s => s.allStocks);
  const isBuy = mode === 'inst-buy' || mode === 'foreign-buy';
  const isForeign = mode === 'foreign-buy' || mode === 'foreign-sell';
  const accentColor = isBuy ? '#eab308' : '#a855f7';
  const accentBg = isBuy ? 'rgba(234,179,8,0.08)' : 'rgba(168,85,247,0.08)';

  const modeLabel = {
    'inst-buy': '🏦 三大法人買超',
    'inst-sell': '🏦 三大法人賣超',
    'foreign-buy': '🌐 外資買超',
    'foreign-sell': '🌐 外資賣超',
  }[mode];

  // Format date
  const formattedDate = dataDate
    ? `${dataDate.slice(0, 4)}/${dataDate.slice(4, 6)}/${dataDate.slice(6, 8)}`
    : '';

  function fmtLots(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 10000) return `${(n / 10000).toFixed(1)}萬`;
    if (abs >= 1000) return `${(n / 1000).toFixed(1)}千`;
    return n.toLocaleString();
  }

  if (loading && stocks.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: 'calc(32px * var(--fz))', marginBottom: '12px', animation: 'spin 1.2s linear infinite', display: 'inline-block' }}>{isForeign ? '🌐' : '🏦'}</div>
        <div style={{ fontSize: 'calc(14px * var(--fz))' }}>載入法人買賣超資料中…</div>
      </div>
    );
  }

  if (stocks.length === 0) {
    return (
      <div style={{ padding: '48px', textAlign: 'center', color: 'var(--text-muted)' }}>
        <div style={{ fontSize: 'calc(32px * var(--fz))', marginBottom: '12px' }}>📊</div>
        <div style={{ fontSize: 'calc(14px * var(--fz))' }}>暫無法人買賣超資料，盤後約 18:00 更新</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Header info bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 16px', borderBottom: '1px solid var(--border-primary)',
        fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)',
      }}>
        <span>{modeLabel} · TOP {stocks.length}</span>
        <span>📅 資料日期：{formattedDate} · 盤後統計</span>
      </div>

      {/* Column header */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 0.8fr minmax(70px, auto)',
        padding: '8px 16px', fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border-primary)', letterSpacing: '0.04em',
      }}>
        <span>代號 / 名稱</span>
        <span>現價 / 漲跌%</span>
        <span>{isForeign ? '外資淨買超' : '法人合計'}</span>
        <span>外資 / 投信 / 自營</span>
        <span style={{ textAlign: 'right' }}>操作</span>
      </div>

      {stocks.map((s, idx) => {
        const isExpanded = expandedCode === s.code;
        const stockInfo = allStocks.find(st => st.code === s.code);
        const targetPrice = stockInfo ? getTargetPrice({
          ...stockInfo,
          price: s.price || stockInfo.price,
          changePercent: s.changePercent || stockInfo.changePercent
        }) : null;
        // 現價 fallback：institutional-trading（T86）只有買賣超張數、沒有價格欄位，
        // 直接讀 s.price 整欄全是 "--"。補用 allStocks（stock-day-all 官方收盤）——
        // 本表是「盤後統計」，收盤價正是正確口徑。
        const price = s.price ?? stockInfo?.price ?? 0;
        const chg = s.change ?? stockInfo?.change ?? 0;
        const chgPct = s.changePercent ?? stockInfo?.changePercent ?? 0;
        const priceColor = chg > 0 ? 'var(--color-up)' : chg < 0 ? 'var(--color-down)' : 'var(--text-primary)';
        const netLots = isForeign ? s.foreignNetLots : s.totalNetLots;
        const netColor = netLots > 0 ? '#ef4444' : '#22c55e';

        return (
          <div key={s.code} className={styles.stockRowContainer}>
            <div
              onClick={() => onToggleExpand(s.code)}
              style={{
                display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 0.8fr minmax(70px, auto)',
                padding: '11px 16px', alignItems: 'center',
                borderBottom: '1px solid var(--border-primary)',
                background: isExpanded ? 'rgba(99,102,241,0.03)' : (idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.013)'),
                transition: 'all 0.12s', cursor: 'pointer',
              }}
            >
              {/* Code / Name */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontWeight: 700, fontSize: 'calc(14px * var(--fz))', color: 'var(--text-primary)' }}>{s.code}</span>
                  <span style={{
                    fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', borderRadius: '4px',
                    background: accentBg, color: accentColor, fontWeight: 600,
                  }}>{isBuy ? '買超' : '賣超'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 'calc(14px * var(--fz))', color: '#f5a623', fontWeight: 700 }}>{s.name}</span>
                  <StatusBadges code={s.code} />
                </div>
              </div>

              {/* Price / change */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {price > 0 ? (
                  <>
                    <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: priceColor }}>
                      {price.toLocaleString(undefined, { minimumFractionDigits: price < 100 ? 2 : 0, maximumFractionDigits: 2 })}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: priceColor }}>
                        {chg > 0 ? '+' : ''}{chg.toFixed(2)}
                      </span>
                      <span style={{
                        fontSize: 'calc(12.5px * var(--fz))', padding: '1px 5px', borderRadius: '4px', fontWeight: 600,
                        background: chg > 0 ? 'rgba(220,38,38,0.12)' : chg < 0 ? 'rgba(34,197,94,0.12)' : 'rgba(148,163,184,0.08)',
                        color: priceColor,
                      }}>{chg > 0 ? '▲' : chg < 0 ? '▼' : ''}{Math.abs(chgPct).toFixed(2)}%</span>
                    </div>
                    {targetPrice !== null && targetPrice !== undefined && (
                      <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--accent-orange, #f59e0b)' }}>
                        目標 {targetPrice.toFixed(2)}
                      </span>
                    )}
                  </>
                ) : (
                  <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--text-muted)' }}>--</span>
                )}
              </div>

              {/* Net buy/sell */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: netColor }}>
                  {netLots > 0 ? '+' : ''}{fmtLots(netLots)}張
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <div style={{
                    flex: 1, height: '4px', borderRadius: '999px',
                    background: 'var(--bg-tertiary)', overflow: 'hidden', maxWidth: '60px',
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.min(100, Math.abs(netLots) / (Math.abs(stocks[0]?.[isForeign ? 'foreignNetLots' : 'totalNetLots'] ?? 1)) * 100)}%`,
                      borderRadius: '999px', background: netColor,
                    }} />
                  </div>
                </div>
              </div>

              {/* Breakdown */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: 'calc(12.5px * var(--fz))' }}>
                <span style={{ color: s.foreignNetLots > 0 ? '#ef4444' : s.foreignNetLots < 0 ? '#22c55e' : 'var(--text-muted)' }}>
                  外 {s.foreignNetLots > 0 ? '+' : ''}{fmtLots(s.foreignNetLots)}
                </span>
                <span style={{ color: s.trustNetLots > 0 ? '#ef4444' : s.trustNetLots < 0 ? '#22c55e' : 'var(--text-muted)' }}>
                  投 {s.trustNetLots > 0 ? '+' : ''}{fmtLots(s.trustNetLots)}
                </span>
                <span style={{ color: s.dealerNetLots > 0 ? '#ef4444' : s.dealerNetLots < 0 ? '#22c55e' : 'var(--text-muted)' }}>
                  自 {s.dealerNetLots > 0 ? '+' : ''}{fmtLots(s.dealerNetLots)}
                </span>
              </div>

              {/* Action */}
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={(e) => { e.stopPropagation(); onViewStock(s.code, s.name); }}
                  style={{
                    fontSize: 'calc(12.5px * var(--fz))', padding: '5px 10px', borderRadius: '6px',
                    background: accentBg, color: accentColor,
                    border: `1px solid ${accentColor}33`, cursor: 'pointer',
                    fontWeight: 600, transition: 'all 0.15s',
                  }}
                >查看</button>
              </div>
            </div>
            {isExpanded && (
              <div className={styles.chartWrapper} style={{ padding: '8px 16px', background: 'rgba(255,255,255,0.005)', borderBottom: '1px solid var(--border-primary)' }}>
                <StockTrendChart code={s.code} name={s.name} closePrice={price} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}


export default function WatchlistTracker() {
  const watchlistGroups = useAppStore(s => s.watchlistGroups);
  const alerts = useAppStore(s => s.alerts);
  const addWatchlistGroup = useAppStore(s => s.addWatchlistGroup);
  const removeWatchlistGroup = useAppStore(s => s.removeWatchlistGroup);
  const updateWatchlistGroup = useAppStore(s => s.updateWatchlistGroup);
  const addToGroup = useAppStore(s => s.addToGroup);
  const removeFromGroup = useAppStore(s => s.removeFromGroup);
  const navigateTo = useAppStore(s => s.navigateTo);

  // 'ai' is the reserved ID for the AI tab；存 store 讓進個股再返回時回到原本群組分頁
  const activeGroupId = useAppStore(s => s.trackerGroupId);
  const setActiveGroupId = useAppStore(s => s.setTrackerGroupId);
  const [expandedCode, setExpandedCode] = useState<string | null>(null);
  // 分頁列橫向捲動容器（分頁少後僅保留 ref，行動裝置可原生捲動）
  const tabsScrollRef = useRef<HTMLDivElement>(null);

  const toggleExpand = useCallback((code: string) => {
    setExpandedCode(prev => prev === code ? null : code);
  }, []);

  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [snapQuotes, setSnapQuotes] = useState<Record<string, LiveQuote>>({}); // 全市場快照（急漲跌用）
  const quotesRef = useRef<Record<string, LiveQuote>>({}); // mirror for stable callback dep

  // 全市場快照：急漲跌榜需要全市場視角（daemon 每分掃 ~1900 檔）
  useEffect(() => {
    let live = true;
    // 首次一律載入（盤後要看當日最終值）；之後休市或分頁在背景就跳過（308KB 一支，原本 24/7 每分鐘打）
    const load = (force = false) => {
      if (!force && !shouldPollNow()) return;
      fetch('/api/twse/market-snapshot')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!live || !d?.quotes?.length) return;
        const map: Record<string, LiveQuote> = {};
        for (const x of d.quotes) {
          map[x.code] = {
            code: x.code, name: x.name, price: x.price,
            open: x.open ?? 0, high: x.high ?? 0, low: x.low ?? 0,
            prevClose: x.price - (x.change ?? 0), change: x.change ?? 0,
            changePercent: x.changePercent ?? 0, volume: x.volume ?? 0,
            tradeTime: '', source: 'snapshot',
          };
        }
        setSnapQuotes(map);
      }).catch(() => {});
    };
    load(true);
    const t = setInterval(() => load(), 60000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const [loading, setLoading] = useState(false);
  const [showAddGroup, setShowAddGroup] = useState(false);
  const [showManageGroups, setShowManageGroups] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [isRealtime, setIsRealtime] = useState(false);

  // 全市場 AI 評分/訊號表（code → score/signal）供各分頁(含我的自選)每列顯示。
  const [ratingsMap, setRatingsMap] = useState<Record<string, { score: number; signal: string }>>({});
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/rating')
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!alive || !d?.ratings) return;
        const m: Record<string, { score: number; signal: string }> = {};
        for (const c in d.ratings) m[c] = { score: d.ratings[c].score, signal: d.ratings[c].signal };
        setRatingsMap(m);
      })
      .catch(() => {});
    load();
    const id = setInterval(load, 120000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const [aiStocks, setAiStocks] = useState<AiRecommendation[]>([]);
  const aiStocksRef = useRef<AiRecommendation[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  // Institutional trading data
  const [instData, setInstData] = useState<{
    foreignBuy: InstitutionalStockItem[];
    foreignSell: InstitutionalStockItem[];
    instBuy: InstitutionalStockItem[];
    instSell: InstitutionalStockItem[];
    dataDate: string;
  }>({ foreignBuy: [], foreignSell: [], instBuy: [], instSell: [], dataDate: '' });
  const [instLoading, setInstLoading] = useState(false);
  // Keep refs in sync with state (stable values for useCallback)
  useEffect(() => { quotesRef.current = quotes; }, [quotes]);
  useEffect(() => { aiStocksRef.current = aiStocks; }, [aiStocks]);

  const aiPickCodes = new Set(aiStocks.map(s => s.code));
  const alertCodes = new Set(alerts.map(a => a.code));

  // Fetch live quotes — direct browser->MIS during market hours, server fallback otherwise
  const fetchQuotes = useCallback(async (stocks?: AiRecommendation[]) => {
    const isFirstLoad = Object.keys(quotesRef.current).length === 0;
    if (isFirstLoad) setLoading(true);
    try {
      const allGroups = useAppStore.getState().watchlistGroups;
      const groupCodes = allGroups.flatMap(g => g.stocks.map(s => s.code));
      const aiCodes = (stocks ?? aiStocksRef.current).map(s => s.code);
      const uniqueCodes = [...new Set([...aiCodes, ...groupCodes])].filter(c => /^\d{4}$/.test(c));

      // Market hours check (Taiwan time)
      const now = new Date();
      const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const day = tw.getDay();
      const t = tw.getHours() * 60 + tw.getMinutes();
      const marketOpen = day > 0 && day < 6 && t >= 9 * 60 && t < 13 * 60 + 31;

      // Strategy 1: MIS 即時報價 via server API (真正即時, 秒級更新)
      if (uniqueCodes.length > 0) {
        try {
          const batches: string[][] = [];
          for (let i = 0; i < uniqueCodes.length; i += 50) batches.push(uniqueCodes.slice(i, i + 50));

          const misResults = await Promise.all(
            batches.map(batch =>
              fetch(`/api/twse/mis-quote?codes=${batch.join(',')}&t=${revealTick()}`)
                .then(r => r.ok ? r.json() : null).catch(() => null)
            )
          );

          const map: Record<string, LiveQuote> = {};
          let gotRealtime = false;

          for (const res of misResults) {
            if (!res?.quotes) continue;
            if (res.isRealtime) gotRealtime = true;
            for (const q of res.quotes) {
              if (q.code && q.price > 0) {
                map[q.code] = {
                  code: q.code, name: q.name, price: q.price,
                  open: q.open ?? 0, high: q.high ?? 0, low: q.low ?? 0,
                  prevClose: q.prevClose ?? 0, change: q.change ?? 0,
                  changePercent: q.changePercent ?? 0, volume: q.volume ?? 0,
                  tradeTime: q.tradeTime ?? '', revealAt: q.revealAt ?? null, source: q.source ?? 'unknown',
                };
              }
            }
          }

          if (Object.keys(map).length > 0) {
            const prevQ = quotesRef.current;
            setQuotes(Object.fromEntries(
              Object.entries(map).map(([c, q]) => [c, { ...q, prevPrice: prevQ[c]?.price }])
            ));
            setIsRealtime(gotRealtime);
            setLastRefresh(new Date());
            return;
          }
        } catch (_misErr) { /* fall through */ }
      }

      // Strategy 2: Full STOCK_DAY_ALL (last resort, if mis-quote API completely fails)
      const res = await fetch('/api/twse/stock-day-all', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        const map: Record<string, LiveQuote> = {};
        for (const item of data) {
          const code  = item.Code || item.code;
          const name  = item.Name || item.name;
          const price = parseFloat(item.ClosingPrice || '0');
          const change = parseFloat(item.Change || '0');
          const prev  = price - change;
          const pct   = prev > 0 && change !== 0 ? (change / prev) * 100 : 0;
          if (code && !isNaN(price)) {
            map[code] = {
              code, name, price,
              open: parseFloat(item.OpeningPrice || '0'),
              high: parseFloat(item.HighestPrice || '0'),
              low: parseFloat(item.LowestPrice || '0'),
              prevClose: prev, change, changePercent: pct,
              volume: parseInt(item.TradeVolume?.replace(/,/g, '') || '0', 10),
              tradeTime: '', source: 'stock_day_all',
            };
          }
        }
        const prevQ2 = quotesRef.current;
        setQuotes(Object.fromEntries(
          Object.entries(map).map(([c, q]) => [c, { ...q, prevPrice: prevQ2[c]?.price }])
        ));
        setIsRealtime(false);
        setLastRefresh(new Date());
      }
    } catch (_err) {
      // ignore
    } finally {
      if (isFirstLoad) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // Fetch AI recommendations
  const fetchAiRecommendations = useCallback(async () => {
    setAiLoading(true);
    try {
      const res = await fetch('/api/twse/ai-recommend');
      if (!res.ok) return;
      const data = await res.json();
      if (data.recommendations && Array.isArray(data.recommendations)) {
        const parsed: AiRecommendation[] = data.recommendations.map((r: {
          code: string; name: string; score: number;
          signal?: string; reason?: string; strategy?: string;
          buyPoint?: number; sellPoint?: number; changePercent?: number;
          isAttention?: boolean; isDisposition?: boolean;
          riskLevel?: string; riskWarnings?: AiRecommendation['riskWarnings'];
        }) => ({
          code: r.code,
          name: r.name,
          score: r.score ?? 0,
          signal: r.signal ?? '觀察',
          reason: r.reason ?? '',
          strategy: r.strategy ?? 'momentum',
          buyPoint: r.buyPoint,
          sellPoint: r.sellPoint,
          changePercent: r.changePercent,
          isAttention: r.isAttention ?? false,
          isDisposition: r.isDisposition ?? false,
          riskLevel: r.riskLevel ?? 'low',
          riskWarnings: r.riskWarnings ?? [],
        }));
        setAiStocks(parsed);
      }
    } catch (_err) {
      // ignore
    } finally {
      setAiLoading(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    fetchQuotes();
    fetchAiRecommendations();
    // 報價鎖相（使用者 2026-09-02「盤中為 3 秒更新」）：原本 5 秒自由輪詢與
    // MIS 揭示邊界（5 秒一拍）相位隨機，平均多落後半拍。改鎖「揭示邊界+3s」
    // ——+1s 快線已抓、+3s 各層快取已回填，每拍都拿到最新揭示。
    const stopQ = startLiveLoop(fetchQuotes);   // 鎖相＋回前景立即恢復（標準件）
    // AI recommendations refresh every 5 min
    const aiInterval = setInterval(() => {
      fetchAiRecommendations();
    }, 5 * 60_000);
    return () => {
      live = false;
      stopQ();
      clearInterval(aiInterval);
    };
  }, [fetchQuotes, fetchAiRecommendations]);

  // Fetch institutional trading data
  const fetchInstitutionalData = useCallback(async () => {
    setInstLoading(true);
    try {
      const res = await fetch('/api/twse/institutional-trading', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setInstData({
          foreignBuy: data.foreignBuy ?? [],
          foreignSell: data.foreignSell ?? [],
          instBuy: data.instBuy ?? [],
          instSell: data.instSell ?? [],
          dataDate: data.dataDate ?? '',
        });
      }
    } catch (e) {
      console.warn('[WatchlistTracker] institutional fetch error:', e);
    } finally {
      setInstLoading(false);
    }
  }, []);

  // Fetch institutional data on mount and every 10 min
  useEffect(() => {
    fetchInstitutionalData();
    const interval = setInterval(fetchInstitutionalData, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchInstitutionalData]);

  // Fix: only sync to default if not on a reserved tab
  useEffect(() => {
    const isReserved = ['tail', 'ai', 'rapid', 'drop', 'risk', 'inst-buy', 'inst-sell', 'foreign-buy', 'foreign-sell'].includes(activeGroupId);
    if (!isReserved && !watchlistGroups.find(g => g.id === activeGroupId)) {
      setActiveGroupId('ai');
    }
  }, [watchlistGroups, activeGroupId]);

  useEffect(() => {
    setExpandedCode(null);
  }, [activeGroupId]);

  const handleAddGroup = (name: string, color: string) => {
    addWatchlistGroup(name, color);
  };

  const handleDeleteGroup = (id: string) => {
    if (id === 'default') return;
    removeWatchlistGroup(id);
  };

  const isAiTab = activeGroupId === 'ai';
  const isRapidTab = activeGroupId === 'rapid';
  const isDropTab = activeGroupId === 'drop';
  const isInstBuyTab = activeGroupId === 'inst-buy';
  const isInstSellTab = activeGroupId === 'inst-sell';
  const isForeignBuyTab = activeGroupId === 'foreign-buy';
  const isForeignSellTab = activeGroupId === 'foreign-sell';
  const isRiskTab = activeGroupId === 'risk';
  const isInstitutionalTab = isInstBuyTab || isInstSellTab || isForeignBuyTab || isForeignSellTab;
  const isTailTab = activeGroupId === 'tail';
  const activeGroup = (isTailTab || isAiTab || isRapidTab || isDropTab || isRiskTab || isInstitutionalTab)
    ? null
    : watchlistGroups.find(g => g.id === activeGroupId);

  // 五個頂層分頁（由 activeGroupId 推導，沿用已持久化的 trackerGroupId → 回上頁自動還原）
  const mainTab: 'tail' | 'rapid' | 'inst' | 'watch' | 'risk' =
    isTailTab ? 'tail'
      : (isRapidTab || isDropTab) ? 'rapid'
        : isInstitutionalTab ? 'inst'
          : isRiskTab ? 'risk'
            : 'watch';

  // 急漲跌用「全市場快照」(~1900檔)——追蹤池只有幾十檔，崩盤日跌停上百檔會漏光
  const rapidUniverse = Object.keys(snapQuotes).length > 500 ? snapQuotes : quotes;
  const rapidRisers  = computeRapidRisers(rapidUniverse);
  const rapidFallers = computeRapidFallers(rapidUniverse);

  const handleViewStock = (code: string, name: string) => {
    navigateTo('stock', code);
  };

  return (
    <div className={styles.tracker}>
      <PageHelp id="tracker" />
      {/* ── Header ── */}
      <div className={styles.trackerHeader}>
        <div className={styles.trackerTitleRow}>
          <h1 className={styles.trackerTitle} style={{ whiteSpace: 'nowrap' }}>📡 即時追蹤</h1>
          <div className={styles.trackerMeta}>
            {lastRefresh && (
              <span className={styles.refreshTime}>
                最後更新 {formatTime(lastRefresh.getTime())}
                {isRealtime && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: '3px',
                    marginLeft: '6px', fontSize: 'calc(12.5px * var(--fz))',
                    color: '#22c55e', fontWeight: 700,
                  }}>● 即時</span>
                )}
              </span>
            )}
            <button
              className={`${styles.refreshBtn} ${loading ? styles.refreshBtnLoading : ''}`}
              onClick={() => fetchQuotes()}
              disabled={loading}
              title="立即重新整理"
            >
              <IconRefresh spinning={loading} />
              重新整理
            </button>
          </div>
        </div>

        {/* ── 頂層 5 分頁：撿尾盤／急漲跌／法人籌碼／自選／風險 ── */}
        <div className={styles.tabBar}>
          <div className={styles.tabs} ref={tabsScrollRef}>
            {([
              { key: 'tail', label: '🪣 撿尾盤', color: '#10b981', on: () => setActiveGroupId('tail'), count: null },
              { key: 'rapid', label: '⚡ 急漲跌', color: '#ef4444', on: () => setActiveGroupId('rapid'), count: rapidRisers.length + rapidFallers.length },
              { key: 'inst', label: '🏦 法人籌碼', color: '#eab308', on: () => { if (mainTab !== 'inst') setActiveGroupId('inst-buy'); }, count: null },
              { key: 'watch', label: '⭐ 自選', color: '#818cf8', on: () => { if (mainTab !== 'watch') setActiveGroupId('ai'); }, count: aiStocks.length },
              { key: 'risk', label: '⚠️ 風險', color: '#ef4444', on: () => setActiveGroupId('risk'), count: null },
            ] as const).map(t => (
              <button
                key={t.key}
                className={`${styles.tab} ${mainTab === t.key ? styles.tabActive : ''}`}
                style={mainTab === t.key ? { borderColor: t.color, color: t.color } : {}}
                onClick={t.on}
              >
                <span className={styles.tabDot} style={{ background: t.color }} />
                {t.label}
                {t.count != null && <span className={styles.tabCount}>{t.count}</span>}
              </button>
            ))}
          </div>
        </div>

        {/* ── 次分頁：法人籌碼（4 類）／自選（AI候選＋群組＋新增） ── */}
        {mainTab === 'inst' && (
          <div className={styles.tabBar} style={{ marginTop: 8 }}>
            <div className={styles.tabs}>
              {([
                { id: 'inst-buy', label: '🏦 法人買超', color: '#eab308', n: instData.instBuy.length },
                { id: 'inst-sell', label: '🏦 法人賣超', color: '#a855f7', n: instData.instSell.length },
                { id: 'foreign-buy', label: '🌐 外資買超', color: '#06b6d4', n: instData.foreignBuy.length },
                { id: 'foreign-sell', label: '🌐 外資賣超', color: '#ec4899', n: instData.foreignSell.length },
              ] as const).map(s => (
                <button
                  key={s.id}
                  className={`${styles.tab} ${activeGroupId === s.id ? styles.tabActive : ''}`}
                  style={activeGroupId === s.id ? { borderColor: s.color, color: s.color } : {}}
                  onClick={() => setActiveGroupId(s.id)}
                >
                  <span className={styles.tabDot} style={{ background: s.color }} />
                  {s.label}
                  <span className={styles.tabCount}>{s.n}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {mainTab === 'watch' && (
          <div className={styles.tabBar} style={{ marginTop: 8 }}>
            <div className={styles.tabs}>
              <button
                className={`${styles.tab} ${isAiTab ? styles.tabActive : ''}`}
                style={isAiTab ? { borderColor: '#818cf8', color: '#818cf8' } : {}}
                onClick={() => setActiveGroupId('ai')}
              >
                <span className={styles.tabDot} style={{ background: 'linear-gradient(135deg,#6366f1,#a855f7)' }} />
                🤖 AI 候選股
                <span className={styles.tabCount}>{aiStocks.length}</span>
              </button>
              {watchlistGroups.map(group => (
                <button
                  key={group.id}
                  className={`${styles.tab} ${activeGroupId === group.id ? styles.tabActive : ''}`}
                  style={activeGroupId === group.id ? { borderColor: group.color, color: group.color } : {}}
                  onClick={() => setActiveGroupId(group.id)}
                >
                  <span className={styles.tabDot} style={{ background: group.color }} />
                  {group.name}
                  <span className={styles.tabCount}>{group.stocks.length}</span>
                </button>
              ))}
            </div>
            {/* 手機只留 icon（2026-08-11 使用者：「讓左邊的分組文字能多露出來，方便挑選」）。
                ⚠ 文字用 CSS 隱藏而不是刪掉——桌機仍要有字，
                  且**一定要保留 title/aria-label**，否則手機上就變成兩顆沒有名字的按鈕，
                  螢幕閱讀器與長按提示都拿不到任何資訊。 */}
            <button className={styles.addGroupBtn} onClick={() => setShowAddGroup(true)}
              title="新增群組" aria-label="新增群組">
              <IconPlus /><span className={styles.btnLabel}>新增群組</span>
            </button>
            <button
              className={styles.addGroupBtn}
              style={{ marginLeft: '6px', borderColor: 'rgba(255,255,255,0.08)', color: '#94a3b8' }}
              onClick={() => setShowManageGroups(true)}
              title="管理分組" aria-label="管理分組"
            >
              ⚙️<span className={styles.btnLabel}>管理分組</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Main Content（依頂層分頁切換） ── */}
      {mainTab === 'rapid' ? (
        // 急漲跌：左右 2 欄，全寬方便對照
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '14px' }}>
          <RapidRisePanel stocks={rapidRisers} loading={loading} onViewStock={handleViewStock} expandedCode={expandedCode} onToggleExpand={toggleExpand} />
          <RapidFallPanel stocks={rapidFallers} loading={loading} onViewStock={handleViewStock} expandedCode={expandedCode} onToggleExpand={toggleExpand} />
        </div>
      ) : (
        <div className={styles.trackerContent}>
          <div className={styles.stockListArea}>
            {mainTab === 'tail' ? (
              <MarketPatternBanner />
            ) : mainTab === 'risk' ? (
              <RiskMonitorPanel onViewStock={handleViewStock} />
            ) : isInstBuyTab ? (
              <InstitutionalPanel stocks={instData.instBuy} mode="inst-buy" loading={instLoading} dataDate={instData.dataDate} onViewStock={handleViewStock} expandedCode={expandedCode} onToggleExpand={toggleExpand} />
            ) : isInstSellTab ? (
              <InstitutionalPanel stocks={instData.instSell} mode="inst-sell" loading={instLoading} dataDate={instData.dataDate} onViewStock={handleViewStock} expandedCode={expandedCode} onToggleExpand={toggleExpand} />
            ) : isForeignBuyTab ? (
              <InstitutionalPanel stocks={instData.foreignBuy} mode="foreign-buy" loading={instLoading} dataDate={instData.dataDate} onViewStock={handleViewStock} expandedCode={expandedCode} onToggleExpand={toggleExpand} />
            ) : isForeignSellTab ? (
              <InstitutionalPanel stocks={instData.foreignSell} mode="foreign-sell" loading={instLoading} dataDate={instData.dataDate} onViewStock={handleViewStock} expandedCode={expandedCode} onToggleExpand={toggleExpand} />
            ) : isAiTab ? (
              <AiGroupPanel aiStocks={aiStocks} quotes={quotes} loading={aiLoading} onViewStock={handleViewStock} expandedCode={expandedCode} onToggleExpand={toggleExpand} />
            ) : activeGroup ? (
              <GroupPanel group={activeGroup} isActive={true} quotes={quotes} ratingsMap={ratingsMap} aiPickCodes={aiPickCodes} alertCodes={alertCodes} onRemoveStock={removeFromGroup} onAddStock={addToGroup} onDeleteGroup={handleDeleteGroup} expandedCode={expandedCode} onToggleExpand={toggleExpand} />
            ) : null}
          </div>

          {/* Right: notifications */}
          <NotificationsPanel />
        </div>
      )}

      {/* ── Add Group Modal ── */}
      {showAddGroup && (
        <AddGroupModal
          onClose={() => setShowAddGroup(false)}
          onAdd={handleAddGroup}
        />
      )}

      {/* ── Manage Groups Modal ── */}
      {showManageGroups && (
        <ManageGroupsModal
          onClose={() => setShowManageGroups(false)}
        />
      )}
    </div>
  );
}
