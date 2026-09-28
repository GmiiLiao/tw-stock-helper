'use client';

import { useState, useEffect, useCallback } from 'react';
import { getSession, isForeground, msToNextReveal, startLiveLoop, revealTick } from '@/lib/market-clock';
import IndexIntradayModal from '@/components/shared/IndexIntradayModal';
import { useAppStore } from '@/lib/store';
import styles from './AiNewsTicker.module.css';

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

interface AgentMessage {
  id:        string;
  type:      'brief' | 'alert' | 'opportunity' | 'risk' | 'trend';
  label:     string;
  emoji:     string;
  text:      string;
  summary:   string;
  severity:  'info' | 'warning' | 'danger' | 'success';
  stocks:    string[];
  timestamp: number;
  agentId:   string;
}

interface MarketIndexData {
  weighted: number;
  weightedChange: number;
  weightedChangePercent: number;
  high?: number;
  low?: number;
  prevClose?: number;
  source?: string;
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function formatTime(ts: number) {
  const d = new Date(ts);
  const tw = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${String(tw.getHours()).padStart(2,'0')}:${String(tw.getMinutes()).padStart(2,'0')}`;
}

function relativeTime(ts: number) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '剛才';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分前`;
  return formatTime(ts);
}

const SEVERITY_COLOR: Record<string, string> = {
  info:    'var(--color-text-muted)',
  warning: '#f59e0b',
  danger:  'var(--color-down)',
  success: 'var(--color-up)',
};

// ──────────────────────────────────────────────────────────────
// Detail Modal
// ──────────────────────────────────────────────────────────────

function DetailModal({ msg, onClose }: { msg: AgentMessage; onClose: () => void }) {
  // 股號 chip 要帶名稱、點擊開個股分析（使用者 2026-09-02 指定）。
  // 名稱查 allStocks（Header 已載的全市場清單）；查不到只顯示代號，不捏造。
  const allStocks = useAppStore(s => s.allStocks);
  const navigateTo = useAppStore(s => s.navigateTo);
  const nameOf = (code: string) => allStocks.find(x => x.code === code)?.name || '';
  const openStock = (code: string) => { onClose(); navigateTo('stock', code); };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <span className={styles.modalEmoji}>{msg.emoji}</span>
          <span className={styles.modalTitle}>{msg.label}</span>
          <span className={styles.modalTime}>{relativeTime(msg.timestamp)}</span>
          <button className={styles.modalClose} onClick={onClose}>✕</button>
        </div>

        {msg.stocks.length > 0 && (
          <div className={styles.modalStocks}>
            {msg.stocks.map(s => (
              <button
                key={s}
                className={styles.stockChip}
                onClick={() => openStock(s)}
                title={`開啟 ${s} 個股分析`}
                style={{ cursor: 'pointer' }}
              >
                {s}{nameOf(s) ? ` ${nameOf(s)}` : ''} ↗
              </button>
            ))}
          </div>
        )}

        <div className={styles.modalBody}>
          <div className={styles.modalText}>
            {msg.text.split('\n').map((line, i) => (
              <p key={i} className={line.startsWith('【') || line.startsWith('■') ? styles.modalSection : styles.modalPara}>
                {line}
              </p>
            ))}
          </div>
        </div>

        <div className={styles.modalFooter}>
          <span className={styles.modalModel}>🤖 AI 監控子代理 · {msg.agentId}</span>
          <span className={styles.modalDisclaimer}>僅供參考，非投資建議</span>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Ticker Strip — 跑馬燈
// ──────────────────────────────────────────────────────────────

function TickerStrip({ messages, onSelect }: {
  messages: AgentMessage[];
  onSelect: (msg: AgentMessage) => void;
}) {
  if (messages.length === 0) return (
    <div className={styles.tickerEmpty}>
      <span className={styles.tickerLoadingDot} />
      AI 監控中，分析訊息準備中…
    </div>
  );

  // Duplicate for seamless scroll
  const doubled = [...messages, ...messages];

  return (
    <div className={styles.tickerWrapper}>
      <div className={styles.tickerLabel}>AI</div>
      <div className={styles.tickerTrack}>
        <div className={styles.tickerContent}>
          {doubled.map((msg, idx) => (
            <button
              key={`${msg.id}-${idx}`}
              className={styles.tickerChip}
              onClick={() => onSelect(msg)}
              style={{ borderColor: SEVERITY_COLOR[msg.severity] ?? 'transparent' }}
            >
              <span className={styles.tickerChipEmoji}>{msg.emoji}</span>
              <span className={styles.tickerChipText}>
                {msg.summary || msg.text.slice(0, 50)}
                {(msg.summary || msg.text).length > 50 ? '…' : ''}
              </span>
              <span className={styles.tickerChipTime}>{relativeTime(msg.timestamp)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// Market Index Mini Widget (for Navbar)
// ──────────────────────────────────────────────────────────────

export function NavbarIndexWidget() {
  const [data, setData] = useState<MarketIndexData | null>(null);
  const [showChart, setShowChart] = useState(false);   // 點卡片彈出大盤即時走勢（2026-08-14）

  useEffect(() => {
    const load = async () => {
      // 分頁在背景就跳過。cache-buster 已移除 —— 它會讓每次 URL 都不同、CDN 100% miss，
      // 而 Header 也在打同一支 API，兩者共用 CDN 快取才有意義。
      if (!isForeground()) return;
      try {
        const res = await fetch(`/api/twse/market-index?t=${revealTick()}`);
        if (res.ok) setData(await res.json());
      } catch { /* ignore */ }
    };
    // 盤中 5 秒（與 Header 同節奏；daemon 已把指數搭進 5 秒快線，60 秒輪詢會白白落後
    // ——2026-08-17 使用者回報「左上更新太久」）。
    // ⚠ 2026-09-02「報價完全沒有變化」同族修復：背景排的 300 秒計時器在回前景時
    //   不會自己縮短，這張側欄大指數卡就凍住最久 5 分鐘。改接 startLiveLoop
    //   （鎖相＋visibilitychange 立即恢復），節奏函式自帶——含美股/夜盤時段，
    //   不能吃預設 liveQuoteInterval（它盤外 10 分鐘，會拖慢美股更新）。
    const getInterval = () => {
      if (!isForeground()) return 300_000;
      const s = getSession();
      if (s === 'regular') return msToNextReveal(3000);   // 鎖相：揭示邊界+3s
      if (s === 'pre-open') return 15_000;
      return 60_000;
    };
    load();
    const stop = startLiveLoop(load, getInterval);
    return () => stop();
  }, []);

  if (!data || data.weighted === 0) return (
    <div className={styles.indexWidgetLoading}>
      <span>📊 加權指數</span>
      <span className={styles.indexDash}>--</span>
    </div>
  );

  const isUp = data.weightedChange >= 0;
  const color = isUp ? 'var(--color-up)' : 'var(--color-down)';
  const sign  = isUp ? '+' : '';

  return (
    <>
    <div className={styles.indexWidget} onClick={() => setShowChart(true)}
      style={{ cursor: 'pointer' }} title="點擊查看大盤即時走勢圖（含成交量）">
      <div className={styles.indexWidgetTitle}>📊 台股加權指數</div>
      <div className={styles.indexWidgetValue} style={{ color }}>
        {data.weighted.toLocaleString('zh-TW', { minimumFractionDigits: 2 })}
      </div>
      <div className={styles.indexWidgetChange} style={{ color }}>
        {sign}{data.weightedChange.toFixed(2)}
        <span className={styles.indexWidgetPct}>
          ({sign}{data.weightedChangePercent.toFixed(2)}%)
        </span>
      </div>
      {data.high && data.low && (
        <div className={styles.indexWidgetHl}>
          <span>H {data.high.toFixed(0)}</span>
          <div className={styles.indexHlBar}>
            <div style={{
              width: `${data.weighted > 0 ? ((data.weighted - data.low) / (data.high - data.low)) * 100 : 50}%`,
              height: '100%', background: color, borderRadius: '999px',
              transition: 'width 0.5s',
            }} />
          </div>
          <span>L {data.low.toFixed(0)}</span>
        </div>
      )}
      {data.source === 'mis_realtime' && (
        <div className={styles.indexWidgetSource}>● 即時數據</div>
      )}
    </div>
    <IndexIntradayModal open={showChart} onClose={() => setShowChart(false)} />
    </>
  );
}

// ──────────────────────────────────────────────────────────────
// Main AiNewsTicker Component
// ──────────────────────────────────────────────────────────────

export default function AiNewsTicker() {
  const [isOpen, setIsOpen]       = useState(false);
  const [messages, setMessages]   = useState<AgentMessage[]>([]);
  const [selectedMsg, setSelected] = useState<AgentMessage | null>(null);
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [agentActive, setAgentActive] = useState(false);
  const [heartbeat, setHeartbeat] = useState(0);

  // ── Poll /api/ai-analysis every 15s ──────────────────────
  const fetchMessages = useCallback(async () => {
    // 訊息由 daemon 產生，休市時仍可能更新，所以只擋背景分頁不擋休市。
    if (!isForeground()) return;
    try {
      const res = await fetch('/api/ai-analysis', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.messages)) {
        setMessages(data.messages);
        if (data.messages.length > 0) setLastFetch(Date.now());
      }
      // 上線判定以 daemon 心跳為準（訊息 10 分鐘一則是設計節奏，不代表離線）
      if (typeof data.lastHeartbeat === 'number') setHeartbeat(data.lastHeartbeat);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchMessages();
    // 盤中 15 秒；休市時 daemon 產出頻率低很多，60 秒足夠。
    // 間隔每拍重算（G3-05：原本掛載時算死，盤中開的分頁整夜仍 15 秒打）；閘門在 fetchMessages 內（isForeground）
    const stop = startLiveLoop(() => { void fetchMessages(); }, () => (getSession() === 'closed' ? 60_000 : 15_000));
    return () => stop();
  }, [fetchMessages]);

  // ── Check agent status (ping agentId in messages) ──────
  useEffect(() => {
    const hbFresh = heartbeat > 0 && Date.now() - heartbeat < 3 * 60_000;
    const msgFresh = messages.length > 0 && Date.now() - messages[0].timestamp < 5 * 60_000;
    setAgentActive(hbFresh || msgFresh);   // 心跳為主；訊息稀疏是設計節奏不是離線
  }, [messages, heartbeat]);

  const hasMessages = messages.length > 0;
  const latestMsg   = messages[0];

  return (
    <>
      {/* ── Navbar Section ────────────────────────────────────── */}
      <div className={styles.navSection}>
        {/* Toggle Button */}
        <button
          className={`${styles.toggleBtn} ${isOpen ? styles.toggleBtnActive : ''}`}
          onClick={() => setIsOpen(v => !v)}
          title={isOpen ? '關閉 AI 監控面板' : '開啟 AI 監控面板'}
          id="ai-agent-toggle"
        >
          <span className={styles.toggleIcon}>🤖</span>
          <span className={styles.toggleLabel}>AI 股市分析</span>
          <span className={`${styles.toggleBadge} ${agentActive ? styles.toggleBadgePulse : ''}`}>
            {hasMessages ? messages.length : agentActive ? '●' : '▼'}
          </span>
        </button>

        {/* Ticker Strip (always visible when open) */}
        {isOpen && (
          <div className={styles.tickerSection}>
            <TickerStrip messages={messages} onSelect={setSelected} />
          </div>
        )}

        {/* Expanded Panel */}
        {isOpen && (
          <div className={styles.expandedPanel}>
            {/* Panel Header */}
            <div className={styles.panelHeader}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className={styles.panelTitle}>AI 監控子代理</span>
                <span style={{
                  fontSize: 'calc(12.5px * var(--fz))', fontWeight: 700, padding: '2px 6px', borderRadius: '999px',
                  background: agentActive ? 'rgba(34,197,94,0.15)' : 'rgba(100,116,139,0.15)',
                  color: agentActive ? '#22c55e' : '#8b9bb8',
                }}>
                  {agentActive ? '● 運行中' : '○ 待命'}
                </span>
              </div>
              <div className={styles.panelActions}>
                {lastFetch && (
                  <span className={styles.panelTime}>{relativeTime(lastFetch)}</span>
                )}
                <button
                  className={styles.refreshBtn}
                  onClick={fetchMessages}
                  title="重新整理"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M23 4v6h-6M1 20v-6h6"/>
                    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* Message List */}
            <div className={styles.msgList}>
              {messages.length === 0 ? (
                <div className={styles.msgEmpty}>
                  <span style={{ fontSize: 'calc(24px * var(--fz))' }}>🤖</span>
                  <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#8b9bb8', marginTop: '8px' }}>
                    子代理啟動中，正在監控市場…
                  </div>
                  <div style={{ fontSize: 'calc(13px * var(--fz))', color: '#475569', marginTop: '4px' }}>
                    每 5 分鐘推送最新分析，最多保留 5 條
                  </div>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <button
                    key={msg.id}
                    className={`${styles.msgCard} ${i === 0 ? styles.msgCardLatest : ''}`}
                    onClick={() => setSelected(msg)}
                    style={{ borderLeftColor: SEVERITY_COLOR[msg.severity] ?? '#334155' }}
                  >
                    <div className={styles.msgCardHeader}>
                      <span className={styles.msgEmoji}>{msg.emoji}</span>
                      <span className={styles.msgLabel}>{msg.label}</span>
                      {i === 0 && <span className={styles.msgBadgeNew}>最新</span>}
                      <span className={styles.msgTime}>{relativeTime(msg.timestamp)}</span>
                    </div>
                    <div className={styles.msgSummary}>{msg.summary || msg.text.slice(0, 80)}</div>
                    {msg.stocks.length > 0 && (
                      <div className={styles.msgStockTags}>
                        {msg.stocks.slice(0, 4).map(s => (
                          <span key={s} className={styles.msgStockTag}>{s}</span>
                        ))}
                      </div>
                    )}
                    <span className={styles.msgReadMore}>查看詳情 →</span>
                  </button>
                ))
              )}
            </div>

            {/* Footer */}
            <div className={styles.panelFooter}>
              🤖 AI 子代理 · 08:55 啟動 · 盤中持續分析＋追蹤股即時警示 · 14:30 關閉
            </div>
          </div>
        )}
      </div>

      {/* ── Detail Modal ──────────────────────────────────────── */}
      {selectedMsg && (
        <DetailModal
          msg={selectedMsg}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
