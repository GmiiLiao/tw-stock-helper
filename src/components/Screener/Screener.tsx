'use client';

import { useState, useMemo, useEffect } from 'react';
import { useAppStore } from '@/lib/store';
import type { StockInfo } from '@/lib/twse-api';
import { formatVolume, formatChangePercentSign } from '@/lib/twse-api';
import { useLiveQuotes } from '@/lib/useLiveQuotes';
import styles from './Screener.module.css';
import { useShallow } from 'zustand/react/shallow';

interface ScreenerFilter {
  changePercentMin: number | '';
  changePercentMax: number | '';
  priceMin: number | '';
  priceMax: number | '';
  volumeMin: number | '';
  macdPositive: boolean;
  rsiMin: number | '';
  rsiMax: number | '';
  industry: string;
  aiRating: string;
}

const DEFAULT_FILTER: ScreenerFilter = {
  changePercentMin: '',
  changePercentMax: '',
  priceMin: '',
  priceMax: '',
  volumeMin: '',
  macdPositive: false,
  rsiMin: '',
  rsiMax: '',
  industry: 'all',
  aiRating: 'all',
};

// Client-side industry categorizer
export function getStockIndustry(code: string, name: string): { code: string; name: string; emoji: string } {
  const specificMap: Record<string, { code: string; name: string; emoji: string }> = {
    '2330': { code: '24', name: '半導體', emoji: '🔲' }, // 台積電
    '2454': { code: '24', name: '半導體', emoji: '🔲' }, // 聯發科
    '2303': { code: '24', name: '半導體', emoji: '🔲' }, // 聯電
    '3711': { code: '24', name: '半導體', emoji: '🔲' }, // 日月光投控
    '2308': { code: '28', name: '電子零組件', emoji: '🔌' }, // 台達電
    '2317': { code: '31', name: '其他電子', emoji: '🔧' }, // 鴻海
    '2382': { code: '25', name: '電腦週邊', emoji: '💻' }, // 廣達
    '3231': { code: '25', name: '電腦週邊', emoji: '💻' }, // 緯創
    '2357': { code: '25', name: '電腦週邊', emoji: '💻' }, // 華碩
    '2324': { code: '25', name: '電腦週邊', emoji: '💻' }, // 仁寶
    '2356': { code: '25', name: '電腦週邊', emoji: '💻' }, // 英業達
    '2409': { code: '26', name: '光電業', emoji: '🖥️' }, // 友達
    '3481': { code: '26', name: '光電業', emoji: '🖥️' }, // 群創
    '3008': { code: '26', name: '光電業', emoji: '🖥️' }, // 大立光
    '2412': { code: '27', name: '通信網路', emoji: '📡' }, // 中華電
    '3045': { code: '27', name: '通信網路', emoji: '📡' }, // 台灣大
    '4904': { code: '27', name: '通信網路', emoji: '📡' }, // 遠傳
    '2603': { code: '15', name: '航運業', emoji: '🚢' }, // 長榮
    '2609': { code: '15', name: '航運業', emoji: '🚢' }, // 陽明
    '2615': { code: '15', name: '航運業', emoji: '🚢' }, // 萬海
    '2618': { code: '15', name: '航運業', emoji: '🚢' }, // 長榮航
    '2610': { code: '15', name: '航運業', emoji: '🚢' }, // 華航
    '2881': { code: '17', name: '金融保險', emoji: '🏦' }, // 富邦金
    '2882': { code: '17', name: '金融保險', emoji: '🏦' }, // 國泰金
    '2886': { code: '17', name: '金融保險', emoji: '🏦' }, // 兆豐金
    '2891': { code: '17', name: '金融保險', emoji: '🏦' }, // 中信金
    '2884': { code: '17', name: '金融保險', emoji: '🏦' }, // 玉山金
    '2892': { code: '17', name: '金融保險', emoji: '🏦' }, // 第一金
    '2880': { code: '17', name: '金融保險', emoji: '🏦' }, // 華南金
    '2883': { code: '17', name: '金融保險', emoji: '🏦' }, // 開發金
    '2885': { code: '17', name: '金融保險', emoji: '🏦' }, // 元大金
    '2887': { code: '17', name: '金融保險', emoji: '🏦' }, // 台新金
    '2890': { code: '17', name: '金融保險', emoji: '🏦' }, // 永豐金
    '5871': { code: '17', name: '金融保險', emoji: '🏦' }, // 中租-KY
    '5880': { code: '17', name: '金融保險', emoji: '🏦' }, // 合庫金
    '1101': { code: '01', name: '水泥工業', emoji: '🏗️' }, // 台泥
    '1102': { code: '01', name: '水泥工業', emoji: '🏗️' }, // 亞泥
    '1301': { code: '03', name: '塑膠工業', emoji: '🔬' }, // 台塑
    '1303': { code: '03', name: '塑膠工業', emoji: '🔬' }, // 南亞
    '1326': { code: '03', name: '塑膠工業', emoji: '🔬' }, // 台化
    '6505': { code: '23', name: '油電燃氣', emoji: '🔋' }, // 台塑化
    '2002': { code: '10', name: '鋼鐵工業', emoji: '🔩' }, // 中鋼
  };

  if (specificMap[code]) return specificMap[code];

  // ETFs
  if (code.startsWith('00') || name.includes('元大台灣') || (name.includes('國泰') && (name.includes('高股息') || name.includes('50') || name.includes('債') || name.includes('ETF')))) {
    return { code: 'etf', name: 'ETF / 指數型基金', emoji: '📈' };
  }

  // Code prefixes
  if (code.startsWith('28') || code.startsWith('58')) {
    return { code: '17', name: '金融保險', emoji: '🏦' };
  }
  if (code.startsWith('26') || code.startsWith('56')) {
    return { code: '15', name: '航運業', emoji: '🚢' };
  }
  if (code.startsWith('25') || code.startsWith('55')) {
    return { code: '14', name: '建材營造', emoji: '🏢' };
  }
  if (code.startsWith('20')) {
    return { code: '10', name: '鋼鐵工業', emoji: '🔩' };
  }
  if (code.startsWith('11')) {
    return { code: '01', name: '水泥工業', emoji: '🏗️' };
  }
  if (code.startsWith('12')) {
    return { code: '02', name: '食品工業', emoji: '🍜' };
  }
  if (code.startsWith('13')) {
    return { code: '03', name: '塑膠工業', emoji: '🔬' };
  }
  if (code.startsWith('14')) {
    return { code: '04', name: '紡織纖維', emoji: '🧵' };
  }
  if (code.startsWith('15')) {
    return { code: '05', name: '電機機械', emoji: '⚙️' };
  }
  if (code.startsWith('16')) {
    return { code: '06', name: '電器電纜', emoji: '⚡' };
  }
  if (code.startsWith('18')) {
    return { code: '08', name: '玻璃陶瓷', emoji: '🏺' };
  }
  if (code.startsWith('19')) {
    return { code: '09', name: '造紙工業', emoji: '📄' };
  }
  if (code.startsWith('21')) {
    return { code: '11', name: '橡膠工業', emoji: '🔄' };
  }
  if (code.startsWith('22')) {
    return { code: '12', name: '汽車工業', emoji: '🚗' };
  }
  if (code.startsWith('27') || code.startsWith('57')) {
    return { code: '16', name: '觀光事業', emoji: '✈️' };
  }
  if (code.startsWith('29')) {
    return { code: '18', name: '貿易百貨', emoji: '🛒' };
  }
  if (code.startsWith('17') || code.startsWith('41') || code.startsWith('47')) {
    if (name.includes('生技') || name.includes('藥') || name.includes('醫') || name.includes('科') || code.startsWith('41')) {
      return { code: '22', name: '生技醫療', emoji: '💊' };
    }
    return { code: '21', name: '化學工業', emoji: '⚗️' };
  }

  // Tech / Electronics
  if (
    code.startsWith('23') || code.startsWith('24') || code.startsWith('30') || 
    code.startsWith('32') || code.startsWith('34') || code.startsWith('35') || 
    code.startsWith('36') || code.startsWith('37') || code.startsWith('49') || 
    code.startsWith('53') || code.startsWith('54') || code.startsWith('61') || 
    code.startsWith('62') || code.startsWith('64') || code.startsWith('65') || 
    code.startsWith('80') || code.startsWith('81') || code.startsWith('82')
  ) {
    if (name.includes('晶圓') || name.includes('半導體') || name.includes('IC') || name.includes('晶') || (name.includes('科') && (code.startsWith('24') || code.startsWith('30') || code.startsWith('64')))) {
      return { code: '24', name: '半導體', emoji: '🔲' };
    }
    if (name.includes('網') || name.includes('通') || name.includes('訊') || name.includes('信')) {
      return { code: '27', name: '通信網路', emoji: '📡' };
    }
    if (name.includes('光') || (name.includes('電') && code.startsWith('34'))) {
      return { code: '26', name: '光電業', emoji: '🖥️' };
    }
    if (name.includes('軟體') || name.includes('資訊') || name.includes('資安')) {
      return { code: '30', name: '資訊服務', emoji: '☁️' };
    }
    if (name.includes('零組件') || name.includes('電阻') || name.includes('電容') || name.includes('線圈') || name.includes('電路板') || name.includes('板') || name.includes('導線架')) {
      return { code: '28', name: '電子零組件', emoji: '🔌' };
    }
    if (name.includes('電腦') || name.includes('週邊') || name.includes('伺服器') || name.includes('機殼') || name.includes('散熱') || name.includes('大聯大') || name.includes('聯強')) {
      return { code: '25', name: '電腦週邊', emoji: '💻' };
    }
    return { code: '13', name: '電子工業', emoji: '💡' };
  }

  return { code: '20', name: '其他類股', emoji: '📊' };
}

// AI ratings now come from the backend single source of truth (/api/rating),
// not a client re-implementation. See `useRatings` usage inside the component.
export type StockRatingLite = { score: number; grade: 'A+' | 'A' | 'B+' | 'B' | 'C'; signal: 'STRONG_BUY' | 'BUY' | 'WATCH' | 'NEUTRAL'; targetPrice: number };

const DEFAULT_RATING: StockRatingLite = { score: 0, grade: 'C', signal: 'NEUTRAL', targetPrice: 0 };

const STRATEGY_TEMPLATES = [
  {
    id: 'breakout',
    name: '🚀 強勢突破',
    desc: '漲幅 > 3%，爆量上攻',
    filter: { changePercentMin: 3, changePercentMax: 9.9, volumeMin: 1000, macdPositive: false } as Partial<ScreenerFilter>,
  },
  {
    id: 'momentum',
    name: '📈 強勢多頭',
    desc: '漲幅 1-5%，量能放大',
    filter: { changePercentMin: 1, changePercentMax: 5, volumeMin: 500, macdPositive: false } as Partial<ScreenerFilter>,
  },
  {
    id: 'oversold',
    name: '💎 超賣反彈',
    desc: 'RSI < 30，量縮後反彈',
    filter: { rsiMin: 0, rsiMax: 30, changePercentMin: 0, macdPositive: false } as Partial<ScreenerFilter>,
  },
  {
    id: 'stable',
    name: '🛡️ 防禦存股',
    desc: '低波動，成交穩定',
    filter: { changePercentMin: -1, changePercentMax: 1, volumeMin: 100 } as Partial<ScreenerFilter>,
  },
];



const GROUP_COLORS = [
  '#f03e3e', '#f76707', '#f59f00', '#2f9e44',
  '#1971c2', '#7048e8', '#c2255c', '#0ca678',
];

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
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.6)',
      backdropFilter: 'blur(4px)', zIndex: 1000, display: 'flex',
      alignItems: 'center', justifyContent: 'center'
    }} onClick={onClose}>
      <div style={{
        background: '#141929', border: '1px solid rgba(255, 255, 255, 0.1)',
        borderRadius: '16px', padding: '24px', width: '420px', maxWidth: '95%',
        boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)'
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
          <span style={{ fontSize: 'calc(14.5px * var(--fz))', fontWeight: 700, color: '#f1f5f9' }}>⚙️ 自選比較組管理</span>
          <button
            onClick={onClose}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '28px', height: '28px', borderRadius: '8px', border: 'none',
              background: 'rgba(255, 255, 255, 0.06)', color: '#94a3b8', cursor: 'pointer'
            }}
            aria-label="關閉"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
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
                      className="input"
                      style={{ fontSize: 'calc(0.875rem * var(--fz))', padding: '6px 10px' }}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      placeholder="請輸入群組名稱"
                      maxLength={20}
                      autoFocus
                    />
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 'calc(13px * var(--fz))', color: '#8b9bb8' }}>群組顏色：</span>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {GROUP_COLORS.map(c => (
                          <button
                            key={c}
                            type="button"
                            style={{
                              background: c, width: '20px', height: '20px', borderRadius: '50%',
                              border: editColor === c ? '2px solid white' : '2px solid transparent',
                              cursor: 'pointer', transition: 'transform 0.15s',
                              transform: editColor === c ? 'scale(1.15)' : 'none'
                            }}
                            onClick={() => setEditColor(c)}
                            aria-label={`主題色 ${c}`}
                          />
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '2px' }}>
                      <button className="btn btn-secondary btn-sm" style={{ padding: '4px 10px', fontSize: 'calc(13px * var(--fz))', borderRadius: '6px', height: 'auto' }} onClick={() => setEditingGroupId(null)}>取消</button>
                      <button className="btn btn-primary btn-sm" style={{ padding: '4px 10px', fontSize: 'calc(13px * var(--fz))', borderRadius: '6px', height: 'auto' }} onClick={() => handleSaveEdit(group.id)} disabled={!editName.trim()}>儲存</button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                      <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: group.color, flexShrink: 0 }} />
                      <span style={{ fontWeight: 600, fontSize: 'calc(13px * var(--fz))', color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{group.name}</span>
                      <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: '#8b9bb8', background: 'rgba(255, 255, 255, 0.04)', padding: '1px 5px', borderRadius: '4px', flexShrink: 0 }}>{group.stocks.length} 檔</span>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        style={{ padding: '3px 8px', fontSize: 'calc(13px * var(--fz))', borderRadius: '6px', height: '24px', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
                        onClick={() => handleStartEdit(group)}
                      >
                        ✏️ 編輯
                      </button>
                      {group.id !== 'default' && (
                        <button
                          className="btn btn-secondary btn-sm"
                          style={{ padding: '3px 8px', fontSize: 'calc(13px * var(--fz))', borderRadius: '6px', height: '24px', color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.2)', display: 'inline-flex', alignItems: 'center', gap: '2px' }}
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

export default function Screener() {
  const {
    allStocks,
    navigateTo,
    addToWatchlist,
    removeFromWatchlist,
    isInWatchlist,
    watchlist,
    watchlistGroups,
    addWatchlistGroupWithStocks,
    removeWatchlistGroup,
    updateWatchlistGroup,
    addGroupAnalysisRecord,
    compareCodes,
    compareBudget,
    compareProfitTarget,
    compareProfitTargetType,
    compareTradeDuration,
    compareLotType,
    compareSelectedGroupId,
    setCompareCodes,
    setCompareBudget,
    setCompareProfitTarget,
    setCompareProfitTargetType,
    setCompareTradeDuration,
    setCompareLotType,
    setCompareSelectedGroupId
  } = useAppStore(useShallow((s) => ({
    allStocks: s.allStocks,
    navigateTo: s.navigateTo,
    addToWatchlist: s.addToWatchlist,
    removeFromWatchlist: s.removeFromWatchlist,
    isInWatchlist: s.isInWatchlist,
    watchlist: s.watchlist,
    watchlistGroups: s.watchlistGroups,
    addWatchlistGroupWithStocks: s.addWatchlistGroupWithStocks,
    removeWatchlistGroup: s.removeWatchlistGroup,
    updateWatchlistGroup: s.updateWatchlistGroup,
    addGroupAnalysisRecord: s.addGroupAnalysisRecord,
    compareCodes: s.compareCodes,
    compareBudget: s.compareBudget,
    compareProfitTarget: s.compareProfitTarget,
    compareProfitTargetType: s.compareProfitTargetType,
    compareTradeDuration: s.compareTradeDuration,
    compareLotType: s.compareLotType,
    compareSelectedGroupId: s.compareSelectedGroupId,
    setCompareCodes: s.setCompareCodes,
    setCompareBudget: s.setCompareBudget,
    setCompareProfitTarget: s.setCompareProfitTarget,
    setCompareProfitTargetType: s.setCompareProfitTargetType,
    setCompareTradeDuration: s.setCompareTradeDuration,
    setCompareLotType: s.setCompareLotType,
    setCompareSelectedGroupId: s.setCompareSelectedGroupId,
  })));
  const [screenerMode, setScreenerMode] = useState<'filter' | 'compare'>('filter');
  const [filter, setFilter] = useState<ScreenerFilter>(DEFAULT_FILTER);
  const [sortBy, setSortBy] = useState<keyof StockInfo | 'targetPrice'>('changePercent');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [activeTemplate, setActiveTemplate] = useState<string | null>(null);
  const [showManageGroups, setShowManageGroups] = useState(false);

  // AI ratings keyed by code — fetched once from the backend single source of
  // truth (/api/rating) so grades/signals match the AI recommendation page.
  const [ratings, setRatings] = useState<Record<string, StockRatingLite>>({});
  useEffect(() => {
    let cancelled = false;
    fetch('/api/rating')
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (!cancelled && data?.ratings) setRatings(data.ratings); })
      .catch(() => { /* ratings stay empty; UI falls back to DEFAULT_RATING */ });
    return () => { cancelled = true; };
  }, []);
  const ratingFor = (code: string): StockRatingLite => ratings[code] ?? DEFAULT_RATING;

  // Compare Mode Selection and AI reports state mapped to Zustand
  const selectedCompareCodes = compareCodes;
  const setSelectedCompareCodes = (valOrFn: string[] | ((prev: string[]) => string[])) => {
    if (typeof valOrFn === 'function') {
      setCompareCodes(valOrFn(compareCodes));
    } else {
      setCompareCodes(valOrFn);
    }
  };
  const [isAiAnalyzing, setIsAiAnalyzing] = useState(false);
  const [activeReport, setActiveReport] = useState<{ timestamp: number; report: string } | null>(null);

  const [compareSearchQuery, setCompareSearchQuery] = useState('');

  const compareSearchQ = compareSearchQuery.trim().toLowerCase();
  const compareFilteredSearch = compareSearchQ.length >= 1
    ? allStocks.filter(s => {
        if (!s) return false;
        if (selectedCompareCodes.includes(s.code)) return false;
        const code = s.code ? String(s.code).toLowerCase() : '';
        const name = s.name ? String(s.name).toLowerCase() : '';
        return code.includes(compareSearchQ) || name.includes(compareSearchQ);
      }).slice(0, 8)
    : [];

  const handleAddCompareCode = (code: string) => {
    if (selectedCompareCodes.includes(code)) return;
    if (selectedCompareCodes.length >= 5) {
      alert('最多只能選擇 5 檔股票進行比較喔！');
      return;
    }
    setSelectedCompareCodes(prev => [...prev, code]);
    setCompareSearchQuery('');
  };

  // Watchlist comparison parameters mapped to Zustand
  const selectedGroupId = compareSelectedGroupId;
  const setSelectedGroupId = setCompareSelectedGroupId;
  const budget = compareBudget;
  const setBudget = setCompareBudget;
  const profitTarget = compareProfitTarget;
  const setProfitTarget = setCompareProfitTarget;
  const profitTargetType = compareProfitTargetType;
  const setProfitTargetType = setCompareProfitTargetType;
  const tradeDuration = compareTradeDuration;
  const setTradeDuration = setCompareTradeDuration;
  const lotType = compareLotType;
  const setLotType = setCompareLotType;

  // Fallback if selected group is deleted
  useEffect(() => {
    const isReserved = selectedGroupId === 'all' || selectedGroupId === 'selected';
    if (!isReserved && !watchlistGroups.find(g => g.id === selectedGroupId)) {
      setSelectedGroupId('all');
    }
  }, [watchlistGroups, selectedGroupId, setSelectedGroupId]);

  const handleProfitTargetTypeChange = (type: 'percent' | 'amount') => {
    setProfitTargetType(type);
    if (type === 'percent') {
      setProfitTarget(10);
    } else {
      setProfitTarget(50000);
    }
  };

  // Markdown parser helper function
  const formatMarkdownToHtml = (markdown: string): string => {
    if (!markdown) return '';
    
    let html = markdown
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const lines = html.split('\n');
    let inList = false;
    let resultLines: string[] = [];

    for (let line of lines) {
      if (line.startsWith('### ')) {
        if (inList) { resultLines.push('</ul>'); inList = false; }
        resultLines.push(`<h4 style="margin: 18px 0 8px 0; color: var(--accent-blue); font-size: 1.1rem; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px;">${line.substring(4)}</h4>`);
        continue;
      }
      if (line.startsWith('## ')) {
        if (inList) { resultLines.push('</ul>'); inList = false; }
        resultLines.push(`<h3 style="margin: 22px 0 10px 0; color: var(--text-primary); font-size: 1.25rem; font-weight: 700;">${line.substring(3)}</h3>`);
        continue;
      }
      if (line.startsWith('# ')) {
        if (inList) { resultLines.push('</ul>'); inList = false; }
        resultLines.push(`<h2 style="margin: 26px 0 12px 0; color: var(--text-primary); font-size: 1.4rem; font-weight: 800;">${line.substring(2)}</h2>`);
        continue;
      }

      if (line.trim() === '---') {
        if (inList) { resultLines.push('</ul>'); inList = false; }
        resultLines.push('<hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.08); margin: 16px 0;" />');
        continue;
      }

      const bulletMatch = line.match(/^(\s*)([*\-])\s+(.*)$/);
      if (bulletMatch) {
        if (!inList) {
          resultLines.push('<ul style="margin: 8px 0; padding-left: 20px; list-style-type: disc;">');
          inList = true;
        }
        let content = bulletMatch[3];
        content = formatInlineMarkdown(content);
        resultLines.push(`<li style="margin: 6px 0; font-size: 0.9rem; line-height: 1.5; color: var(--text-secondary);">${content}</li>`);
        continue;
      } else {
        if (inList) {
          resultLines.push('</ul>');
          inList = false;
        }
      }

      if (line.trim() === '') {
        resultLines.push('<br />');
      } else {
        let content = formatInlineMarkdown(line);
        resultLines.push(`<p style="margin: 8px 0; font-size: 0.9rem; line-height: 1.6; color: var(--text-secondary);">${content}</p>`);
      }
    }

    if (inList) {
      resultLines.push('</ul>');
    }

    return resultLines.join('\n');
  };

  const formatInlineMarkdown = (text: string): string => {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong style="color: var(--text-primary); font-weight: 700;">$1</strong>')
      .replace(/\*(.*?)\*/g, '<em style="color: var(--text-secondary);">$1</em>')
      .replace(/`(.*?)`/g, '<code style="background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 0.85rem; color: var(--accent-blue);">$1</code>');
  };

  const toggleCompareStock = (stock: StockInfo) => {
    setSelectedCompareCodes(prev => {
      if (prev.includes(stock.code)) {
        return prev.filter(c => c !== stock.code);
      }
      if (prev.length >= 5) {
        alert('最多只能選擇 5 檔股票進行比較！');
        return prev;
      }
      return [...prev, stock.code];
    });
  };

  const handleSaveGroup = () => {
    if (selectedCompareCodes.length === 0) return;
    const groupName = prompt('請輸入新自選股分組名稱：', `自選比較組-${new Date().toLocaleDateString()}`);
    if (!groupName) return;
    
    const newGroupId = `group-${Date.now()}`;
    const stocksToSave = selectedCompareCodes.map(code => {
      const s = allStocks.find(st => st.code === code);
      return {
        code,
        name: s ? s.name : '未知股',
        addedAt: Date.now()
      };
    });
    
    addWatchlistGroupWithStocks(newGroupId, groupName, '#3b82f6', stocksToSave);
    setSelectedGroupId(newGroupId);
    setScreenerMode('compare');
    alert(`成功建立並切換至新分組：${groupName}！`);
  };

  const handleAiAnalysis = async () => {
    if (selectedGroupId === 'selected') {
      alert('請先將所選股票『儲存為自選股分組』，再進行 AI 分析以儲存歷史記錄！');
      return;
    }
    if (selectedGroupId === 'all') {
      alert('『全部自選股』不支援直接分析，請選擇或建立一個特定的自選分組以儲存 AI 報告。');
      return;
    }
    
    const group = watchlistGroups.find(g => g.id === selectedGroupId);
    if (!group || comparedStocks.length === 0) {
      alert('當前分組無股票數據，無法進行分析！');
      return;
    }

    if (group.analysisRecords && group.analysisRecords.length > 0) {
      const lastRecord = group.analysisRecords[0];
      const elapsedMs = Date.now() - lastRecord.timestamp;
      const minutesRemaining = 10 - elapsedMs / 60000;
      if (minutesRemaining > 0) {
        alert(`本分組 10 分鐘內已進行過 AI 分析。請於 ${Math.ceil(minutesRemaining)} 分鐘後再試，或查看下方的歷史報告記錄！`);
        return;
      }
    }

    setIsAiAnalyzing(true);
    setActiveReport(null);

    try {
      const response = await fetch('/api/ai/compare-agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupName: group.name,
          stocks: comparedStocks.map(s => ({
            code: s.code,
            name: s.name,
            price: s.price,
            changePercent: s.changePercent,
            volume: s.volume,
          })),
          budget,
          profitTarget,
          profitTargetType,
          tradeDuration,
          lotType,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || '分析服務發生錯誤');
      }

      const data = await response.json();
      addGroupAnalysisRecord(selectedGroupId, {
        timestamp: data.timestamp,
        report: data.report,
      });

      setActiveReport({
        timestamp: data.timestamp,
        report: data.report,
      });
    } catch (error: any) {
      console.error('AI analysis error:', error);
      alert(`AI 分析失敗: ${error.message || '未知錯誤，請稍後再試'}`);
    } finally {
      setIsAiAnalyzing(false);
    }
  };


  const filteredStocks = useMemo(() => {
    // 興櫃排除：沒有漲跌停、議價撮合、流動性極低，用上市櫃的量價門檻選它毫無意義
    // （2026-08-19 併入興櫃供搜尋時同步設限）
    let stocks = allStocks.filter(s => s.price > 0 && s.volume > 0 && s.market !== 'esb');

    if (filter.changePercentMin !== '') stocks = stocks.filter(s => s.changePercent >= (filter.changePercentMin as number));
    if (filter.changePercentMax !== '') stocks = stocks.filter(s => s.changePercent <= (filter.changePercentMax as number));
    if (filter.priceMin !== '') stocks = stocks.filter(s => s.price >= (filter.priceMin as number));
    if (filter.priceMax !== '') stocks = stocks.filter(s => s.price <= (filter.priceMax as number));
    if (filter.volumeMin !== '') stocks = stocks.filter(s => s.volume >= (filter.volumeMin as number) * 1000);

    // Filter by industry
    if (filter.industry && filter.industry !== 'all') {
      stocks = stocks.filter(s => {
        const ind = getStockIndustry(s.code, s.name);
        if (filter.industry === 'traditional') {
          return ['01', '02', '03', '04', '05', '06', '08', '09', '10', '11', '12', '14', '16', '18', '21'].includes(ind.code);
        }
        return ind.code === filter.industry;
      });
    }

    // Filter by AI Rating
    if (filter.aiRating && filter.aiRating !== 'all') {
      stocks = stocks.filter(s => {
        const rating = ratingFor(s.code);
        if (filter.aiRating === 'A+') return rating.grade === 'A+';
        if (filter.aiRating === 'A') return rating.grade === 'A';
        if (filter.aiRating === 'B+') return rating.grade === 'B+';
        if (filter.aiRating === 'B_C') return rating.grade === 'B' || rating.grade === 'C';
        return true;
      });
    }

    // Sort
    stocks.sort((a, b) => {
      const av = sortBy === 'targetPrice' ? (ratingFor(a.code).targetPrice || a.price) : (a[sortBy] as number);
      const bv = sortBy === 'targetPrice' ? (ratingFor(b.code).targetPrice || b.price) : (b[sortBy] as number);
      return sortDir === 'desc' ? bv - av : av - bv;
    });

    return stocks.slice(0, 100);
  }, [allStocks, filter, sortBy, sortDir, ratings]);

  // Live MIS quotes for the visible filtered rows — overlay real-time price.
  const liveQuotes = useLiveQuotes(filteredStocks.map(s => s.code), 60);
  const withLive = (s: StockInfo): StockInfo => {
    const q = liveQuotes[s.code];
    return q && q.price > 0 ? { ...s, price: q.price, change: q.change, changePercent: q.changePercent } : s;
  };

  const comparedStocks = useMemo(() => {
    let list: any[] = [];
    if (selectedGroupId === 'all') {
      list = watchlist;
    } else if (selectedGroupId === 'selected') {
      list = selectedCompareCodes.map(code => {
        const s = allStocks.find(st => st.code === code);
        return s ? { code: s.code, name: s.name } : { code, name: '未知股' };
      });
    } else {
      const group = watchlistGroups.find(g => g.id === selectedGroupId);
      list = group ? group.stocks : [];
    }

    // Map to real-time data from allStocks
    return list.map(w => {
      const stockData = allStocks.find(s => s.code === w.code);
      return stockData || {
        code: w.code,
        name: w.name,
        price: 0,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        change: 0,
        changePercent: 0,
        volume: 0,
      };
    }).filter(s => s.price > 0);
  }, [watchlist, watchlistGroups, selectedGroupId, selectedCompareCodes, allStocks]);

  const handleTemplate = (tpl: typeof STRATEGY_TEMPLATES[0]) => {
    if (activeTemplate === tpl.id) {
      setActiveTemplate(null);
      setFilter(DEFAULT_FILTER);
    } else {
      setActiveTemplate(tpl.id);
      setFilter({ ...DEFAULT_FILTER, ...tpl.filter });
    }
  };

  const handleSort = (col: keyof StockInfo | 'targetPrice') => {
    if (sortBy === col) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const SortIcon = ({ col }: { col: keyof StockInfo | 'targetPrice' }) => {
    if (sortBy !== col) return <span style={{ opacity: 0.3 }}>↕</span>;
    return <span>{sortDir === 'desc' ? '↓' : '↑'}</span>;
  };

  return (
    <div className={styles.screener}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>🔍 智慧選股引擎</h1>
          <p className={styles.subtitle}>使用多維度條件篩選最佳投資標的</p>
        </div>
        <div className={styles.resultCount}>
          {screenerMode === 'filter' ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
              <div>找到 <strong>{filteredStocks.length}</strong> 支符合條件的股票</div>
              <div style={{ fontSize: 'calc(12.5px * var(--fz))', color: selectedCompareCodes.length > 0 ? 'var(--accent-blue)' : 'var(--text-muted)' }}>
                已選擇比較：<strong>{selectedCompareCodes.length} / 5</strong> 檔
              </div>
            </div>
          ) : (
            <>共比較 <strong>{comparedStocks.length}</strong> 支自選股票</>
          )}
        </div>
      </div>

      {/* Mode Switcher Tabs */}
      <div className={styles.tabBar}>
        <button
          id="screener-mode-filter"
          className={`${styles.tabBtn} ${screenerMode === 'filter' ? styles.tabBtnActive : ''}`}
          onClick={() => setScreenerMode('filter')}
        >
          🔍 篩選模式
        </button>
        <button
          id="screener-mode-compare"
          className={`${styles.tabBtn} ${screenerMode === 'compare' ? styles.tabBtnActive : ''}`}
          onClick={() => setScreenerMode('compare')}
        >
          ⚖️ 自選股比較
        </button>
      </div>

      {/* Mode 1: Filter Screen */}
      {screenerMode === 'filter' ? (
        <>
          {/* Strategy Templates */}
          <div className={styles.templates}>
            <div className={styles.templatesTitle}>策略模板</div>
            <div className={styles.templateBtns}>
              {STRATEGY_TEMPLATES.map(tpl => (
                <button
                  key={tpl.id}
                  id={`template-${tpl.id}`}
                  className={`${styles.templateBtn} ${activeTemplate === tpl.id ? styles.templateActive : ''}`}
                  onClick={() => handleTemplate(tpl)}
                >
                  <span className={tpl.id === activeTemplate ? styles.templateActiveText : styles.templateName}>{tpl.name}</span>
                  <span className={styles.templateDesc}>{tpl.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Filter Panel */}
          <div className={styles.filterPanel}>
            <div className={styles.filterTitle}>篩選條件</div>
            <div className={styles.filterGrid}>
              <div className={styles.filterGroup}>
                <label className={styles.filterLabel}>漲跌幅 (%)</label>
                <div className={styles.rangeInput}>
                  <input
                    id="filter-change-min"
                    type="number"
                    placeholder="最低"
                    step="0.1"
                    value={filter.changePercentMin}
                    onChange={e => setFilter(f => ({ ...f, changePercentMin: e.target.value ? parseFloat(e.target.value) : '' }))}
                    className="input"
                  />
                  <span className={styles.rangeSep}>~</span>
                  <input
                    id="filter-change-max"
                    type="number"
                    placeholder="最高"
                    step="0.1"
                    value={filter.changePercentMax}
                    onChange={e => setFilter(f => ({ ...f, changePercentMax: e.target.value ? parseFloat(e.target.value) : '' }))}
                    className="input"
                  />
                </div>
              </div>

              <div className={styles.filterGroup}>
                <label className={styles.filterLabel}>股價 (元)</label>
                <div className={styles.rangeInput}>
                  <input
                    id="filter-price-min"
                    type="number"
                    placeholder="最低"
                    value={filter.priceMin}
                    onChange={e => setFilter(f => ({ ...f, priceMin: e.target.value ? parseFloat(e.target.value) : '' }))}
                    className="input"
                  />
                  <span className={styles.rangeSep}>~</span>
                  <input
                    id="filter-price-max"
                    type="number"
                    placeholder="最高"
                    value={filter.priceMax}
                    onChange={e => setFilter(f => ({ ...f, priceMax: e.target.value ? parseFloat(e.target.value) : '' }))}
                    className="input"
                  />
                </div>
              </div>

              <div className={styles.filterGroup}>
                <label className={styles.filterLabel}>成交量 (千股以上)</label>
                <input
                  id="filter-volume-min"
                  type="number"
                  placeholder="例如 1000 = 100萬股"
                  value={filter.volumeMin}
                  onChange={e => setFilter(f => ({ ...f, volumeMin: e.target.value ? parseFloat(e.target.value) : '' }))}
                  className="input"
                />
              </div>

              <div className={styles.filterGroup}>
                <label className={styles.filterLabel}>RSI 範圍</label>
                <div className={styles.rangeInput}>
                  <input
                    id="filter-rsi-min"
                    type="number"
                    placeholder="最低"
                    min="0" max="100"
                    value={filter.rsiMin}
                    onChange={e => setFilter(f => ({ ...f, rsiMin: e.target.value ? parseFloat(e.target.value) : '' }))}
                    className="input"
                  />
                  <span className={styles.rangeSep}>~</span>
                  <input
                    id="filter-rsi-max"
                    type="number"
                    placeholder="最高"
                    min="0" max="100"
                    value={filter.rsiMax}
                    onChange={e => setFilter(f => ({ ...f, rsiMax: e.target.value ? parseFloat(e.target.value) : '' }))}
                    className="input"
                  />
                </div>
              </div>

              <div className={styles.filterGroup}>
                <label className={styles.filterLabel} htmlFor="filter-industry">類股種類</label>
                <select
                  id="filter-industry"
                  value={filter.industry}
                  onChange={e => setFilter(f => ({ ...f, industry: e.target.value }))}
                  className="input"
                  style={{ background: 'var(--bg-elevated)', cursor: 'pointer', height: '38px' }}
                >
                  <option value="all">📁 全部類股</option>
                  <option value="24">🔲 半導體</option>
                  <option value="25">💻 電腦週邊</option>
                  <option value="28">🔌 電子零組件</option>
                  <option value="27">📡 通信網路</option>
                  <option value="26">🖥️ 光電業</option>
                  <option value="13">💡 電子工業</option>
                  <option value="17">🏦 金融保險</option>
                  <option value="15">🚢 航運業</option>
                  <option value="14">🏢 建材營造</option>
                  <option value="22">💊 生技醫療</option>
                  <option value="21">⚗️ 化學工業</option>
                  <option value="traditional">🏗️ 傳統產業</option>
                  <option value="etf">📈 ETF / 受益憑證</option>
                  <option value="20">📊 其他類股</option>
                </select>
              </div>

              <div className={styles.filterGroup}>
                <label className={styles.filterLabel} htmlFor="filter-ai-rating">AI 評分分類</label>
                <select
                  id="filter-ai-rating"
                  value={filter.aiRating}
                  onChange={e => setFilter(f => ({ ...f, aiRating: e.target.value }))}
                  className="input"
                  style={{ background: 'var(--bg-elevated)', cursor: 'pointer', height: '38px' }}
                >
                  <option value="all">🤖 全部評分</option>
                  <option value="A+">🔴 A+ 強力買進 (85分以上)</option>
                  <option value="A">🟠 A 買進 (75-84分)</option>
                  <option value="B+">🟡 B+ 偏多觀察 (65-74分)</option>
                  <option value="B_C">🟢 B/C 中性觀望 (64分以下)</option>
                </select>
              </div>
            </div>

            <div className={styles.filterActions}>
              <button
                id="clear-filters"
                className="btn btn-ghost btn-sm"
                onClick={() => { setFilter(DEFAULT_FILTER); setActiveTemplate(null); }}
              >
                清除條件
              </button>
            </div>
          </div>

          {/* Selected Stocks Drawer / List */}
          <div className={styles.selectedDrawer}>
            <div className={styles.selectedDrawerHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', flex: 1 }}>
                <h3 className={styles.selectedDrawerTitle}>
                  📋 已選股票清單 <span className={styles.selectedDrawerCount}>({selectedCompareCodes.length} / 5 檔)</span>
                </h3>
                
                {/* Direct Search & Add Bar */}
                <div className={styles.addStockBar}>
                  <div className={styles.searchWrapper}>
                    <svg className={styles.searchIcon} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      className={styles.searchInput}
                      value={compareSearchQuery}
                      onChange={e => setCompareSearchQuery(e.target.value)}
                      placeholder="快速搜尋並加入比較股票..."
                    />
                    {compareSearchQuery && (
                      <button
                        className={styles.searchClear}
                        onClick={() => setCompareSearchQuery('')}
                        style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {compareFilteredSearch.length > 0 && (
                    <div className={styles.searchDropdown}>
                      {compareFilteredSearch.map(s => (
                        <button
                          key={s.code}
                          className={styles.searchResult}
                          onClick={() => handleAddCompareCode(s.code)}
                        >
                          <span className={styles.searchResultCode}>{s.code}</span>
                          <span className={styles.searchResultName}>{s.name}</span>
                          <span style={{ fontSize: 'calc(13px * var(--fz))', color: 'var(--accent-blue)', marginLeft: 'auto' }}>＋ 加入</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              
              {selectedCompareCodes.length > 0 && (
                <button
                  onClick={() => setSelectedCompareCodes([])}
                  className="btn btn-ghost btn-xs"
                  style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))', padding: '2px 8px', flexShrink: 0 }}
                >
                  🧹 清除全部
                </button>
              )}
            </div>
            
            <div className={styles.selectedDrawerBody}>
              {selectedCompareCodes.length === 0 ? (
                <div className={styles.emptySelectedText}>
                  💡 尚未選擇股票。請在上方搜尋或在下方列表勾選「⚖️ 比較」加入股票，最多可選 5 檔。
                </div>
              ) : (
                <div className={styles.tagsContainer}>
                  {selectedCompareCodes.map(code => {
                    const s = allStocks.find(st => st.code === code);
                    const name = s ? s.name : '未知股';
                    const changePercent = s ? s.changePercent : 0;
                    const price = s ? s.price : 0;
                    const isUp = changePercent >= 0;
                    const changeColor = changePercent === 0 ? 'var(--color-flat)' : isUp ? 'var(--color-up)' : 'var(--color-down)';
                    return (
                      <div key={code} className={styles.stockTag}>
                        <span className={styles.tagCode}>{code}</span>
                        <span className={styles.tagName}>{name}</span>
                        <span className={styles.tagPrice} style={{ color: changeColor }}>
                          {price > 0 ? price.toFixed(2) : '--'}
                        </span>
                        <button
                          onClick={() => setSelectedCompareCodes(prev => prev.filter(c => c !== code))}
                          className={styles.tagRemoveBtn}
                          title="取消選擇"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              
              {selectedCompareCodes.length > 0 && (
                <div className={styles.drawerActions}>
                  <button
                    onClick={handleSaveGroup}
                    className="btn btn-primary btn-sm"
                    style={{
                      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                      border: 'none',
                      fontWeight: 'bold',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      height: '32px'
                    }}
                  >
                    💾 建立比價分組
                  </button>
                  <button
                    onClick={() => {
                      setSelectedGroupId('selected');
                      setScreenerMode('compare');
                    }}
                    className="btn btn-primary btn-sm"
                    style={{
                      background: 'var(--accent-blue)',
                      border: 'none',
                      fontWeight: 'bold',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      height: '32px'
                    }}
                  >
                    ⚖️ 開始比價 ➔
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Results Table & Mobile View Container */}
          <div className={styles.resultsCard}>
            {/* Desktop Table View */}
            <div className={styles.tableContainer}>
              <table className="data-table" id="screener-results-table">
                <thead>
                  <tr>
                    <th style={{ width: 50 }}>#</th>
                    <th style={{ textAlign: 'center', width: 70 }}>⚖️ 比較</th>
                    <th
                      id="sort-code"
                      onClick={() => handleSort('code')}
                      style={{ cursor: 'pointer' }}
                    >
                      代號 <SortIcon col="code" />
                    </th>
                    <th>名稱</th>
                    <th>類股</th>
                    <th
                      id="sort-price"
                      onClick={() => handleSort('price')}
                      style={{ cursor: 'pointer', textAlign: 'right' }}
                    >
                      現價 <SortIcon col="price" />
                    </th>
                    <th
                      id="sort-targetPrice"
                      onClick={() => handleSort('targetPrice')}
                      style={{ cursor: 'pointer', textAlign: 'right', color: 'var(--accent-orange, #f59e0b)' }}
                    >
                      目標價 <SortIcon col="targetPrice" />
                    </th>
                    <th
                      id="sort-changePercent"
                      onClick={() => handleSort('changePercent')}
                      style={{ cursor: 'pointer', textAlign: 'right' }}
                    >
                      漲跌幅 <SortIcon col="changePercent" />
                    </th>
                    <th
                      id="sort-change"
                      onClick={() => handleSort('change')}
                      style={{ cursor: 'pointer', textAlign: 'right' }}
                    >
                      漲跌點 <SortIcon col="change" />
                    </th>
                    <th
                      id="sort-volume"
                      onClick={() => handleSort('volume')}
                      style={{ cursor: 'pointer', textAlign: 'right' }}
                    >
                      成交量 <SortIcon col="volume" />
                    </th>
                    <th style={{ textAlign: 'center' }}>AI 評級</th>
                    <th style={{ textAlign: 'center' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredStocks.length === 0 ? (
                    <tr>
                      <td colSpan={12} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
                        {allStocks.length === 0 ? '資料載入中...' : '沒有符合條件的股票'}
                      </td>
                    </tr>
                  ) : (
                    filteredStocks.map((raw, i) => {
                      const stock = withLive(raw);
                      const isUp = stock.change >= 0;
                      const color = stock.change === 0 ? 'var(--color-flat)' : isUp ? 'var(--color-up)' : 'var(--color-down)';
                      const inWL = isInWatchlist(stock.code);
                      const industryInfo = getStockIndustry(stock.code, stock.name);
                      const aiRating = ratingFor(stock.code);

                      const getAiBadgeStyle = (grade: string) => {
                        if (grade === 'A+') return styles.aiStrongBuy;
                        if (grade === 'A') return styles.aiBuy;
                        if (grade === 'B+') return styles.aiNeutral;
                        return styles.aiSell; // B or C
                      };
                      const aiBadgeStyle = getAiBadgeStyle(aiRating.grade);

                      return (
                        <tr
                          key={stock.code}
                          id={`screener-row-${stock.code}`}
                          onClick={e => {
                            const target = e.target as HTMLElement;
                            const td = target.closest('td');
                            if (td) {
                              const cellIndex = (td as HTMLTableCellElement).cellIndex;
                              if (cellIndex === 1 || cellIndex === 11 || td.querySelector('button') || td.querySelector('input')) {
                                return;
                              }
                            }
                            navigateTo('stock', stock.code);
                          }}
                          style={{ cursor: 'pointer' }}
                        >
                          <td style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>{i + 1}</td>
                          <td style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={selectedCompareCodes.includes(stock.code)}
                              onChange={() => toggleCompareStock(stock)}
                              style={{ cursor: 'pointer', width: '16px', height: '16px', accentColor: 'var(--accent-blue)' }}
                            />
                          </td>
                          <td>
                            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: 'var(--accent-blue)' }}>
                              {stock.code}
                            </span>
                          </td>
                          <td>{stock.name}</td>
                          <td style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>
                            {industryInfo.emoji} {industryInfo.name}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                            {stock.price.toFixed(2)}
                          </td>
                          <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, color: 'var(--accent-orange, #f59e0b)' }}>
                            {(ratingFor(stock.code).targetPrice || stock.price).toFixed(2)}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span
                              className={`badge ${isUp ? 'badge-up' : stock.change < 0 ? 'badge-down' : 'badge-neutral'}`}
                              style={{ fontFamily: 'JetBrains Mono, monospace' }}
                            >
                              {formatChangePercentSign(stock.changePercent)}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right', color, fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                            {stock.change >= 0 ? '+' : ''}{stock.change.toFixed(2)}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>
                            {formatVolume(stock.volume)}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <span className={`${styles.aiBadge} ${aiBadgeStyle}`} style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '2px 8px' }}>
                              {aiRating.grade} {aiRating.grade === 'A+' ? '強力買進' : aiRating.grade === 'A' ? '買進' : aiRating.grade === 'B+' ? '觀察' : '中性'}
                            </span>
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            <button
                              id={`screener-watch-${stock.code}`}
                              className="btn btn-ghost btn-sm"
                              style={inWL ? { color: '#f59e0b' } : {}}
                              onClick={() => {
                                inWL ? removeFromWatchlist(stock.code) : addToWatchlist(stock);
                              }}
                            >
                              {inWL ? '★' : '☆'}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile Card-Based View */}
            <div className={styles.mobileCardList}>
              {filteredStocks.length === 0 ? (
                <div className={styles.emptyMobile}>
                  {allStocks.length === 0 ? '資料載入中...' : '沒有符合條件的股票'}
                </div>
              ) : (
                filteredStocks.map((raw, i) => {
                  const stock = withLive(raw);
                  const isUp = stock.change >= 0;
                  const color = stock.change === 0 ? 'var(--color-flat)' : isUp ? 'var(--color-up)' : 'var(--color-down)';
                  const inWL = isInWatchlist(stock.code);
                  const industryInfo = getStockIndustry(stock.code, stock.name);
                  const aiRating = ratingFor(stock.code);

                  const getAiBadgeStyle = (grade: string) => {
                    if (grade === 'A+') return styles.aiStrongBuy;
                    if (grade === 'A') return styles.aiBuy;
                    if (grade === 'B+') return styles.aiNeutral;
                    return styles.aiSell; // B or C
                  };
                  const aiBadgeStyle = getAiBadgeStyle(aiRating.grade);

                  return (
                    <div
                      key={stock.code}
                      className={styles.mobileCard}
                      onClick={() => navigateTo('stock', stock.code)}
                    >
                      <div className={styles.mobileCardHeader}>
                        <div className={styles.mobileCardTitle}>
                          <span className={styles.mobileCode}>{stock.code}</span>
                          <span className={styles.mobileName}>{stock.name}</span>
                          <span className={`${styles.aiBadge} ${aiBadgeStyle}`} style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '1px 6px', marginLeft: '6px' }}>
                            {aiRating.grade}
                          </span>
                        </div>
                        <span className={`badge ${isUp ? 'badge-up' : stock.change < 0 ? 'badge-down' : 'badge-neutral'}`}>
                          {formatChangePercentSign(stock.changePercent)}
                        </span>
                      </div>
                      <div className={styles.mobileCardBody}>
                        <div className={styles.mobileMetaRow}>
                          <span>類股: <strong style={{ color: 'var(--text-secondary)' }}>{industryInfo.emoji} {industryInfo.name}</strong></span>
                          <span>現價: <strong style={{ color: 'var(--text-primary)' }}>{stock.price.toFixed(2)}</strong> 元 | 目標: <strong style={{ color: 'var(--accent-orange, #f59e0b)' }}>{(ratingFor(stock.code).targetPrice || stock.price).toFixed(2)}</strong> 元</span>
                        </div>
                        <div className={styles.mobileMetaRow}>
                          <span>成交量: {formatVolume(stock.volume)}</span>
                          <span style={{ color }}>漲跌: {stock.change >= 0 ? '+' : ''}{stock.change.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className={styles.mobileCardActions} onClick={e => e.stopPropagation()}>
                        <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>排序 #{i + 1}</span>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            className={`btn ${selectedCompareCodes.includes(stock.code) ? 'btn-primary' : 'btn-ghost'} btn-xs`}
                            style={{ padding: '2px 8px' }}
                            onClick={() => toggleCompareStock(stock)}
                          >
                            {selectedCompareCodes.includes(stock.code) ? '✓ 比較' : '⚖ 比較'}
                          </button>
                          <button
                            className="btn btn-ghost btn-xs"
                            style={inWL ? { color: '#f59e0b', padding: '2px 8px' } : { padding: '2px 8px' }}
                            onClick={() => {
                              inWL ? removeFromWatchlist(stock.code) : addToWatchlist(stock);
                            }}
                          >
                            {inWL ? '★ 已入' : '☆ 加入'}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      ) : (
        /* Mode 2: Compare Screen */
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Top Panel: Group Selector & Settings */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px' }}>
            <div className={styles.compareSelectorRow} style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span className={styles.selectorLabel}>選擇比較分組：</span>
                <select
                  value={selectedGroupId}
                  onChange={e => setSelectedGroupId(e.target.value)}
                  className={styles.groupSelect}
                >
                  <option value="all">⭐️ 全部自選股 ({watchlist.length} 檔)</option>
                  <option value="selected">📋 篩選所選股票 ({selectedCompareCodes.length} / 5 檔)</option>
                  {watchlistGroups.map(g => (
                    <option key={g.id} value={g.id}>
                      📁 {g.name} ({g.stocks.length} 檔)
                    </option>
                  ))}
                </select>

                <button
                  onClick={() => setShowManageGroups(true)}
                  className="btn btn-secondary btn-sm"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', height: '34px', padding: '0 12px' }}
                >
                  ⚙️ 管理分組
                </button>

                {selectedGroupId === 'selected' && selectedCompareCodes.length > 0 && (
                  <button
                    onClick={handleSaveGroup}
                    className="btn btn-primary btn-sm"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', height: '34px', padding: '0 12px' }}
                  >
                    💾 儲存為自選股分組
                  </button>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button
                  onClick={handleAiAnalysis}
                  disabled={isAiAnalyzing}
                  className="btn btn-primary btn-sm"
                  style={{
                    background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
                    border: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontWeight: 'bold',
                    height: '34px',
                    padding: '0 16px',
                    opacity: isAiAnalyzing ? 0.7 : 1,
                    cursor: isAiAnalyzing ? 'not-allowed' : 'pointer'
                  }}
                >
                  {isAiAnalyzing ? '⏳ 分析中...' : '🧠 AI 深度分析'}
                </button>
              </div>
            </div>

            {/* Transaction Target Settings Calculator */}
            <div className={styles.compareParamsCard}>
              <div className={styles.compareParamsTitle}>⚙️ 投資預算與獲利目標試算設定</div>
              <div className={styles.compareParamsGrid}>
                <div className={styles.paramGroup}>
                  <label className={styles.paramLabel}>投資預算 (元)</label>
                  <input
                    type="number"
                    value={budget}
                    onChange={e => setBudget(Math.max(0, parseInt(e.target.value) || 0))}
                    placeholder="例如 500000"
                    className="input"
                    style={{ fontSize: 'calc(0.85rem * var(--fz))' }}
                  />
                </div>
                <div className={styles.paramGroup}>
                  <label className={styles.paramLabel} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>獲利目標</span>
                    <select
                      value={profitTargetType}
                      onChange={e => handleProfitTargetTypeChange(e.target.value as 'percent' | 'amount')}
                      className={styles.miniSelect}
                    >
                      <option value="percent">百分比 (%)</option>
                      <option value="amount">指定金額 (元)</option>
                    </select>
                  </label>
                  <input
                    type="number"
                    value={profitTarget}
                    onChange={e => setProfitTarget(parseFloat(e.target.value) || 0)}
                    placeholder={profitTargetType === 'percent' ? "例如 10" : "例如 50000"}
                    step={profitTargetType === 'percent' ? "0.5" : "1000"}
                    className="input"
                    style={{ fontSize: 'calc(0.85rem * var(--fz))' }}
                  />
                </div>
                <div className={styles.paramGroup}>
                  <label className={styles.paramLabel}>操作週期 (影響證交稅率)</label>
                  <div className={styles.toggleGroup}>
                    <button
                      className={`${styles.toggleItem} ${tradeDuration === 'swing' ? styles.toggleItemActive : ''}`}
                      onClick={() => setTradeDuration('swing')}
                    >
                      波段操作 (0.3%稅)
                    </button>
                    <button
                      className={`${styles.toggleItem} ${tradeDuration === 'day' ? styles.toggleItemActive : ''}`}
                      onClick={() => setTradeDuration('day')}
                    >
                      當沖交易 (0.15%稅)
                    </button>
                  </div>
                </div>
                <div className={styles.paramGroup}>
                  <label className={styles.paramLabel}>交易單位</label>
                  <div className={styles.toggleGroup}>
                    <button
                      className={`${styles.toggleItem} ${lotType === 'lot' ? styles.toggleItemActive : ''}`}
                      onClick={() => setLotType('lot')}
                    >
                      整張 (1,000股)
                    </button>
                    <button
                      className={`${styles.toggleItem} ${lotType === 'odd' ? styles.toggleItemActive : ''}`}
                      onClick={() => setLotType('odd')}
                    >
                      零股 (1股)
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {allStocks.length === 0 ? (
            <div className={styles.resultsCard} style={{ padding: '60px 40px', textAlign: 'center' }}>
              <div className={styles.spinner} style={{ margin: '0 auto 16px auto' }}></div>
              <h3 style={{ margin: '0 0 8px 0', fontSize: 'calc(1.1rem * var(--fz))', fontWeight: 700, color: 'var(--text-primary)' }}>個股資料載入中...</h3>
              <p style={{ fontSize: 'calc(0.875rem * var(--fz))', color: 'var(--text-muted)', maxWidth: '400px', margin: '0 auto', lineHeight: 1.5 }}>
                正在從 TWSE 載入個股即時報價與分析資料，請稍候。
              </p>
            </div>
          ) : comparedStocks.length === 0 ? (
            <div className={styles.resultsCard} style={{ padding: '60px 40px', textAlign: 'center' }}>
              <span style={{ fontSize: 'calc(3rem * var(--fz))', display: 'block', marginBottom: '16px' }}>📊</span>
              <h3 style={{ margin: '0 0 8px 0', fontSize: 'calc(1.1rem * var(--fz))', fontWeight: 700, color: 'var(--text-primary)' }}>自選股比較名單為空</h3>
              <p style={{ fontSize: 'calc(0.875rem * var(--fz))', color: 'var(--text-muted)', maxWidth: '400px', margin: '0 auto 20px auto', lineHeight: 1.5 }}>
                您選擇的分組中目前沒有任何股票。請切換至「篩選模式」或至「個股分析」點擊星號（★）將股票加入自選。
              </p>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setScreenerMode('filter')}
              >
                前往篩選股票
              </button>
            </div>
          ) : (
            <>
              {/* Summary Cards Grid */}
              <div className={styles.summaryGrid}>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryLabel}>總比較檔數</span>
                  <span className={styles.summaryVal}>{comparedStocks.length} 檔</span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryLabel}>單日漲跌分佈 (漲/跌/平)</span>
                  <span className={styles.summaryVal}>
                    <span style={{ color: 'var(--color-up)' }}>▲ {comparedStocks.filter(s => s.change > 0).length}</span> /{' '}
                    <span style={{ color: 'var(--color-down)' }}>▼ {comparedStocks.filter(s => s.change < 0).length}</span> /{' '}
                    <span style={{ color: 'var(--text-muted)' }}>- {comparedStocks.filter(s => s.change === 0).length}</span>
                  </span>
                </div>
                <div className={styles.summaryCard}>
                  <span className={styles.summaryLabel}>平均單日漲跌幅</span>
                  <span
                    className={styles.summaryVal}
                    style={{
                      color:
                        comparedStocks.reduce((a, b) => a + b.changePercent, 0) >= 0
                          ? 'var(--color-up)'
                          : 'var(--color-down)',
                    }}
                  >
                    {comparedStocks.reduce((a, b) => a + b.changePercent, 0) / comparedStocks.length >= 0 ? '+' : ''}
                    {(comparedStocks.reduce((a, b) => a + b.changePercent, 0) / comparedStocks.length).toFixed(2)}%
                  </span>
                </div>
              </div>

              {/* Comparison Results Card */}
              <div className={styles.resultsCard}>
                {/* Desktop View Table */}
                <div className={styles.tableContainer}>
                  <table className="data-table" id="screener-compare-table">
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}>#</th>
                        <th>代號</th>
                        <th>名稱</th>
                        <th style={{ textAlign: 'right' }}>現價</th>
                        <th style={{ textAlign: 'right' }}>漲跌幅</th>
                        <th style={{ textAlign: 'right' }}>可買數量</th>
                        <th style={{ textAlign: 'right' }}>預估花費</th>
                        <th style={{ textAlign: 'right' }}>目標價</th>
                        <th style={{ textAlign: 'right' }}>預估純利</th>
                        <th style={{ textAlign: 'center' }}>策略契合度</th>
                        <th style={{ textAlign: 'center' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparedStocks.map((stock, i) => {
                        const isUp = stock.change >= 0;
                        
                        // Calculations
                        const price = stock.price || 1;
                        let shares = 0;
                        if (lotType === 'lot') {
                          shares = Math.floor(budget / (price * 1000)) * 1000;
                        } else {
                          shares = Math.floor(budget / price);
                        }

                        const cost = shares * price;
                        const buyFee = shares > 0 ? Math.max(20, Math.floor(cost * 0.001425)) : 0;
                        
                        let sellPrice = 0;
                        if (shares > 0) {
                          if (profitTargetType === 'percent') {
                            sellPrice = parseFloat((price * (1 + profitTarget / 100)).toFixed(2));
                          } else {
                            const rate = 1 - 0.001425 - (tradeDuration === 'day' ? 0.0015 : 0.003);
                            sellPrice = parseFloat(((cost + buyFee + profitTarget) / (shares * rate)).toFixed(2));
                          }
                        } else {
                          sellPrice = price;
                        }

                        const sellValue = shares * sellPrice;
                        const sellFee = shares > 0 ? Math.max(20, Math.floor(sellValue * 0.001425)) : 0;
                        
                        const taxRate = tradeDuration === 'day' ? 0.0015 : 0.003;
                        const tax = Math.floor(sellValue * taxRate);
                        
                        const netProfit = shares > 0 ? (sellValue - cost - buyFee - sellFee - tax) : 0;

                        // Quantity representation
                        let quantityText = '';
                        if (lotType === 'lot') {
                          const lots = Math.floor(shares / 1000);
                          quantityText = lots > 0 ? `${lots} 張` : '預算不足';
                        } else {
                          quantityText = shares > 0 ? `${shares.toLocaleString()} 股` : '預算不足';
                        }

                        // Operation suitability fit badge
                        const getFitBadge = () => {
                          if (tradeDuration === 'day') {
                            const isHot = stock.volume > 2000000 && Math.abs(stock.changePercent) > 1.5;
                            return isHot 
                              ? { text: '🔥 高當沖契合', style: styles.aiStrongBuy } 
                              : { text: '⏳ 當沖波動低', style: styles.aiNeutral };
                          } else {
                            const isTrendUp = stock.changePercent > 0;
                            return isTrendUp 
                              ? { text: '📈 波段看多', style: styles.aiBuy } 
                              : { text: '📉 波段整理', style: styles.aiSell };
                          }
                        };
                        const fitBadge = getFitBadge();

                        return (
                          <tr
                            key={stock.code}
                            id={`compare-row-${stock.code}`}
                            onClick={() => navigateTo('stock', stock.code)}
                            style={{ cursor: 'pointer' }}
                          >
                            <td style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}>{i + 1}</td>
                            <td>
                              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: 'var(--accent-blue)' }}>
                                {stock.code}
                              </span>
                            </td>
                            <td>{stock.name}</td>
                            <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}>
                              {stock.price.toFixed(2)}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <span className={`badge ${isUp ? 'badge-up' : 'badge-down'}`} style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                                {formatChangePercentSign(stock.changePercent)}
                              </span>
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, color: shares > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                              {quantityText}
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace' }}>
                              {shares > 0 ? `${(cost + buyFee).toLocaleString()} 元` : '--'}
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', color: 'var(--accent-blue)', fontWeight: 600 }}>
                              {shares > 0 ? `${sellPrice.toFixed(2)} 元` : '--'}
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: netProfit >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>
                              {shares > 0 ? `${netProfit >= 0 ? '+' : ''}${Math.round(netProfit).toLocaleString()} 元` : '--'}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <span className={`${styles.aiBadge} ${fitBadge.style}`} style={{ fontSize: 'calc(12.5px * var(--fz))', padding: '2px 6px' }}>
                                {fitBadge.text}
                              </span>
                            </td>
                            <td style={{ textAlign: 'center' }} onClick={e => e.stopPropagation()}>
                              <button
                                className="btn btn-ghost btn-xs"
                                style={{ color: 'var(--text-muted)', fontSize: 'calc(12.5px * var(--fz))' }}
                                onClick={() => navigateTo('stock', stock.code)}
                              >
                                📊 分析
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Card-Based View */}
                <div className={styles.mobileCardList}>
                  {comparedStocks.map((stock, i) => {
                    const isUp = stock.change >= 0;
                    
                    // Calculations
                    const price = stock.price || 1;
                    let shares = 0;
                    if (lotType === 'lot') {
                      shares = Math.floor(budget / (price * 1000)) * 1000;
                    } else {
                      shares = Math.floor(budget / price);
                    }

                    const cost = shares * price;
                    const buyFee = shares > 0 ? Math.max(20, Math.floor(cost * 0.001425)) : 0;
                    
                    let sellPrice = 0;
                    if (shares > 0) {
                      if (profitTargetType === 'percent') {
                        sellPrice = parseFloat((price * (1 + profitTarget / 100)).toFixed(2));
                      } else {
                        const rate = 1 - 0.001425 - (tradeDuration === 'day' ? 0.0015 : 0.003);
                        sellPrice = parseFloat(((cost + buyFee + profitTarget) / (shares * rate)).toFixed(2));
                      }
                    } else {
                      sellPrice = price;
                    }

                    const sellValue = shares * sellPrice;
                    const sellFee = shares > 0 ? Math.max(20, Math.floor(sellValue * 0.001425)) : 0;
                    
                    const taxRate = tradeDuration === 'day' ? 0.0015 : 0.003;
                    const tax = Math.floor(sellValue * taxRate);
                    
                    const netProfit = shares > 0 ? (sellValue - cost - buyFee - sellFee - tax) : 0;

                    let quantityText = '';
                    if (lotType === 'lot') {
                      const lots = Math.floor(shares / 1000);
                      quantityText = lots > 0 ? `${lots} 張` : '預算不足';
                    } else {
                      quantityText = shares > 0 ? `${shares.toLocaleString()} 股` : '預算不足';
                    }

                    const getFitBadge = () => {
                      if (tradeDuration === 'day') {
                        const isHot = stock.volume > 2000000 && Math.abs(stock.changePercent) > 1.5;
                        return isHot 
                          ? { text: '🔥 高當沖契合', style: styles.aiStrongBuy } 
                          : { text: '⏳ 當沖波動低', style: styles.aiNeutral };
                      } else {
                        const isTrendUp = stock.changePercent > 0;
                        return isTrendUp 
                          ? { text: '📈 波段看多', style: styles.aiBuy } 
                          : { text: '📉 波段整理', style: styles.aiSell };
                      }
                    };
                    const fitBadge = getFitBadge();

                    return (
                      <div
                        key={stock.code}
                        className={styles.mobileCard}
                        onClick={() => navigateTo('stock', stock.code)}
                      >
                        <div className={styles.mobileCardHeader}>
                          <div className={styles.mobileCardTitle}>
                            <span className={styles.mobileCode}>{stock.code}</span>
                            <span className={styles.mobileName}>{stock.name}</span>
                          </div>
                          <span className={`badge ${isUp ? 'badge-up' : 'badge-down'}`}>
                            {formatChangePercentSign(stock.changePercent)}
                          </span>
                        </div>
                        
                        <div className={styles.mobileCardBody}>
                          <div className={styles.mobileMetaRow}>
                            <span>現價: <strong style={{ color: 'var(--text-primary)' }}>{stock.price.toFixed(2)}</strong> 元</span>
                            <span>成交量: {formatVolume(stock.volume)}</span>
                          </div>
                          
                          <div className={styles.calcGrid}>
                            <div className={styles.calcItem}>
                              <span className={styles.calcLabel}>可買數量:</span>
                              <span className={styles.calcVal} style={{ color: shares > 0 ? 'var(--text-primary)' : 'var(--text-muted)' }}>{quantityText}</span>
                            </div>
                            <div className={styles.calcItem}>
                              <span className={styles.calcLabel}>預估花費:</span>
                              <span className={styles.calcVal}>{shares > 0 ? `${(cost + buyFee).toLocaleString()} 元` : '--'}</span>
                            </div>
                            <div className={styles.calcItem}>
                              <span className={styles.calcLabel}>目標價格:</span>
                              <span className={styles.calcVal} style={{ color: 'var(--accent-blue)' }}>{shares > 0 ? `${sellPrice.toFixed(2)} 元` : '--'}</span>
                            </div>
                            <div className={styles.calcItem}>
                              <span className={styles.calcLabel}>預估純利:</span>
                              <span className={styles.calcVal} style={{ color: netProfit >= 0 ? 'var(--color-up)' : 'var(--color-down)', fontWeight: 700 }}>
                                {shares > 0 ? `${netProfit >= 0 ? '+' : ''}${Math.round(netProfit).toLocaleString()} 元` : '--'}
                              </span>
                            </div>
                          </div>
                        </div>

                        <div className={styles.mobileCardActions} onClick={e => e.stopPropagation()}>
                          <span className={`${styles.aiBadge} ${fitBadge.style}`} style={{ fontSize: 'calc(12.5px * var(--fz))' }}>
                            {fitBadge.text}
                          </span>
                          <button
                            className="btn btn-ghost btn-xs"
                            onClick={() => navigateTo('stock', stock.code)}
                          >
                            📊 詳細分析 →
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

            {/* AI Analysis Section */}
            {selectedGroupId !== 'all' && selectedGroupId !== 'selected' && (
              <div className={styles.aiAnalysisCard}>
                <div className={styles.aiAnalysisHeader}>
                  <h3 style={{ margin: 0, fontSize: 'calc(1.1rem * var(--fz))', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}>
                    🧠 AI 深度分析報告歷史記錄
                  </h3>
                  <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                    每 10 分鐘限分析一次
                  </span>
                </div>

                {/* Current loading state */}
                {isAiAnalyzing && (
                  <div className={styles.aiLoading}>
                    <div className={styles.spinner}></div>
                    <p style={{ margin: '10px 0 0 0', fontSize: 'calc(0.9rem * var(--fz))', color: 'var(--text-secondary)' }}>
                      本地 AI 投資專家正在評估您的配置、計算選購建議與潛在風險...
                    </p>
                  </div>
                )}

                {/* Display active/newest report if available */}
                {activeReport ? (
                  <div className={styles.reportDisplay}>
                    <div className={styles.reportTimeRow}>
                      <span>最新分析時間：{new Date(activeReport.timestamp).toLocaleString('zh-TW')}</span>
                      <button
                        onClick={() => setActiveReport(null)}
                        className="btn btn-ghost btn-xs"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        關閉報告
                      </button>
                    </div>
                    <div className={styles.reportContent} dangerouslySetInnerHTML={{ __html: formatMarkdownToHtml(activeReport.report) }} />
                  </div>
                ) : null}

                {/* List of historical reports */}
                {(() => {
                  const currentGroup = watchlistGroups.find(g => g.id === selectedGroupId);
                  const currentGroupRecords = currentGroup?.analysisRecords || [];
                  
                  return currentGroupRecords.length > 0 ? (
                    <div className={styles.recordsList}>
                      <div style={{ fontSize: 'calc(0.85rem * var(--fz))', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px' }}>
                        歷史報告列表 ({currentGroupRecords.length})：
                      </div>
                      <div className={styles.historyGrid}>
                        {currentGroupRecords.map((rec, index) => (
                          <div key={index} className={styles.historyItem}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', textAlign: 'left' }}>
                              <span style={{ fontSize: 'calc(0.85rem * var(--fz))', fontWeight: 600, color: 'var(--text-primary)' }}>
                                📝 分析記錄 #{currentGroupRecords.length - index}
                              </span>
                              <span style={{ fontSize: 'calc(12.5px * var(--fz))', color: 'var(--text-muted)' }}>
                                {new Date(rec.timestamp).toLocaleString('zh-TW')}
                              </span>
                            </div>
                            <button
                              className="btn btn-ghost btn-xs"
                              style={{ color: 'var(--accent-blue)', fontWeight: 600 }}
                              onClick={() => setActiveReport(rec)}
                            >
                              查看報告
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    !isAiAnalyzing && (
                      <div style={{ textAlign: 'center', padding: '30px 20px', color: 'var(--text-muted)', fontSize: 'calc(0.875rem * var(--fz))' }}>
                        💡 該分組目前尚無 AI 分析記錄。點擊頂部 **「🧠 AI 深度分析」** 按鈕可立刻產出最佳選購建議與風險報告！
                      </div>
                    )
                  );
                })()}
              </div>
            )}
          </>
        )}
      {showManageGroups && (
        <ManageGroupsModal onClose={() => setShowManageGroups(false)} />
      )}
      </div>
    )}
  </div>
);
}
