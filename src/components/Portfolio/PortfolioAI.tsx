'use client';

import { useEffect, useState } from 'react';
import { useDataUid } from '@/lib/view-as';
import { useIsPremium } from '@/lib/view-as';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── Member-exclusive (premium+) AI holdings analysis, powered by the
//    resident local-AI daemon. Shows daemon status + per-holding advice. ──

// 等級清單已集中到 lib/view-as（PREMIUM_LEVELS）——此處不再各自定義，避免模擬只改到一半

interface HoldingAnalysis {
  code: string; name: string;
  action: string; pnlPct: number;
  targetPrice: { low: number | null; mid: number | null; high: number | null };
  stopLoss: number | null;
  sellTrigger: string; newsSummary: string; rationale: string;
  isRisk: boolean; riskType: 'attention' | 'disposition' | null;
  swingAdvice: string | null;
  strategy?: HoldingStrategy | null;
}
// daemon computeHoldingStrategy 的實算輸出（零 LLM，欄位見 ai-daemon.mjs 同名函式）
interface HoldingStrategy {
  chg: number; pos: number | null; brk20: boolean; charLabel: string | null;
  filterPass: boolean; passes: string[]; fails: string[];
  hold: Array<{ d: number; med: number; win: number; n: number }>;
  heldDays: number | null; holdN: number;
  analog: { n: number; stats: Array<{ d: number; med: number; win: number }>; grow: number; draw: number;
    examples: Array<{ code: string; date: string; ret5: number | null }> } | null;
}
interface AnalysisDoc { generatedAt: number; model: string; analyses: Record<string, HoldingAnalysis>; }
interface DaemonStatus { running: boolean; lastHeartbeat: number | null; ageSeconds?: number; host?: string; model?: string }

const ACTION_COLOR: Record<string, string> = {
  續抱: 'var(--color-up)', 加碼: '#c92a2a', 減碼: '#e67700', 出脫: 'var(--color-down)', 換股: '#1971c2', 觀望: '#868e96',
};

function StatusBadge({ s }: { s: DaemonStatus | null }) {
  const running = !!s?.running;
  const color = running ? '#22c55e' : '#ef4444';
  const label = running ? '常駐運作中' : (s?.lastHeartbeat ? '常駐已停止' : '常駐未啟動');
  const ago = s?.lastHeartbeat ? `${Math.round((s.ageSeconds ?? 0))}s 前回報` : '無心跳';
  return (
    <span title={`本地 AI 常駐服務 · ${ago}${s?.host ? ` · ${s.host}` : ''}${s?.model ? ` · ${s.model}` : ''}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'calc(0.78rem * var(--fz))', color, fontWeight: 600 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: running ? `0 0 8px ${color}` : 'none', animation: running ? 'pulse-dot 1.5s ease-in-out infinite' : 'none' }} />
      {label}
    </span>
  );
}

export default function PortfolioAI({ codes }: { codes: Array<{ code: string; name: string }> }) {
  const user = useAppStore(st => st.user);
  const dataUid = useDataUid();   // 模擬中＝被模擬者的 uid
  const isPremium = useIsPremium();   // 受身分模擬影響（見 lib/view-as）
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [data, setData] = useState<AnalysisDoc | null>(null);
  const [openStrat, setOpenStrat] = useState<Record<string, boolean>>({});   // 持股策略區收合（預設收合）

  // poll daemon status
  useEffect(() => {
    let live = true;
    const load = () => fetch('/api/ai/daemon-status').then(r => r.ok ? r.json() : null).then(d => { if (live && d) setStatus(d); }).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => { live = false; clearInterval(id); };
  }, []);

  // live subscribe to own portfolio analysis
  useEffect(() => {
    if (!isPremium || !dataUid || !db || typeof (db as { type?: unknown }).type === 'undefined') return;
    const ref = doc(db, 'users', dataUid, 'data', 'portfolioAnalysis');
    const unsub = onSnapshot(ref, snap => { setData(snap.exists() ? (snap.data() as AnalysisDoc) : null); }, () => {});
    return () => unsub();
  }, [isPremium, dataUid]);

  return (
    <div style={{ marginTop: 20, background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-lg)', padding: '16px 18px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 'calc(1rem * var(--fz))' }}>🤖 AI 持倉投資分析</span>
        <span style={{ fontSize: 'calc(0.66rem * var(--fz))', fontWeight: 800, padding: '2px 7px', borderRadius: 999, background: 'rgba(245,158,11,0.15)', color: '#fbbf24', border: '1px solid rgba(245,158,11,0.3)' }}>💎 高級會員</span>
        <span style={{ marginLeft: 'auto' }}><StatusBadge s={status} /></span>
      </div>

      {!isPremium ? (
        <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: 'calc(28px * var(--fz))', marginBottom: 8 }}>🔒</div>
          <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>此為高級會員專屬功能</div>
          <div style={{ fontSize: 'calc(0.82rem * var(--fz))' }}>本地 AI 將分析你的每檔持股：續抱／出脫／換股建議、AI 推估目標價、近一月新聞與注意/處置股波段策略。</div>
        </div>
      ) : !data ? (
        <div style={{ padding: '18px 4px', color: 'var(--text-muted)', fontSize: 'calc(0.85rem * var(--fz))' }}>
          {status?.running
            ? '常駐 AI 服務運作中，分析將於下個週期產生（約 30 分鐘一次）。'
            : '尚無分析資料。請在本機啟動常駐服務：bash scripts/install-ai-daemon.sh'}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 'calc(0.72rem * var(--fz))', color: 'var(--text-muted)', marginBottom: 10 }}>
            更新：{new Date(data.generatedAt).toLocaleString('zh-TW')} · 模型 {data.model}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {codes.map(({ code, name }) => {
              const a = data.analyses[code];
              if (!a) return null;
              const ac = ACTION_COLOR[a.action] || '#868e96';
              return (
                <div key={code} style={{ border: `1px solid ${a.isRisk ? 'rgba(245,158,11,0.4)' : 'var(--border-primary)'}`, borderRadius: 'var(--radius-md)', padding: '12px 14px', background: a.isRisk ? 'rgba(245,158,11,0.04)' : 'var(--bg-secondary)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: 'var(--accent-blue)' }}>{code}</span>
                    <span style={{ fontWeight: 600 }}>{name}</span>
                    <span style={{ fontSize: 'calc(0.72rem * var(--fz))', fontWeight: 800, padding: '2px 9px', borderRadius: 999, background: `${ac}1f`, color: ac, border: `1px solid ${ac}` }}>{a.action}</span>
                    {a.isRisk && <span style={{ fontSize: 'calc(0.68rem * var(--fz))', fontWeight: 700, padding: '2px 7px', borderRadius: 999, background: 'rgba(245,158,11,0.15)', color: '#fbbf24' }}>{a.riskType === 'disposition' ? '🔴 處置股' : '🟡 注意股'}</span>}
                    <span style={{ marginLeft: 'auto', fontFamily: 'JetBrains Mono, monospace', fontWeight: 700, color: a.pnlPct >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{a.pnlPct >= 0 ? '+' : ''}{a.pnlPct.toFixed(2)}%</span>
                  </div>

                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '8px 0', fontSize: 'calc(0.78rem * var(--fz))', fontFamily: 'JetBrains Mono, monospace' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>🎯 AI 推估目標：
                      <span style={{ color: 'var(--color-up)' }}> {a.targetPrice.low ?? '—'} / {a.targetPrice.mid ?? '—'} / {a.targetPrice.high ?? '—'}</span>
                    </span>
                    <span style={{ color: 'var(--text-secondary)' }}>🚫 停損 <span style={{ color: 'var(--color-down)' }}>{a.stopLoss ?? '—'}</span></span>
                  </div>

                  {a.sellTrigger && (
                    <div style={{ fontSize: 'calc(0.8rem * var(--fz))', color: 'var(--text-primary)', marginBottom: 6 }}>⏱️ <strong>脫手時機：</strong>{a.sellTrigger}</div>
                  )}
                  <div style={{ fontSize: 'calc(0.82rem * var(--fz))', lineHeight: 1.7, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{a.rationale}</div>

                  {a.swingAdvice && (
                    <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', fontSize: 'calc(0.8rem * var(--fz))', lineHeight: 1.6, color: '#fcd34d' }}>
                      📈 <strong>波段操作建議：</strong>{a.swingAdvice}
                    </div>
                  )}

                  {/* ── 📐 持股策略分析（零 LLM 實算·預設收合，2026-08-12 使用者需求）── */}
                  {a.strategy && (() => {
                    const st = a.strategy!;
                    const open = !!openStrat[code];
                    const matched = st.heldDays != null ? st.hold.find(h => h.d >= st.heldDays!) ?? st.hold[st.hold.length - 1] : null;
                    return (
                      <div style={{ marginTop: 8, border: '1px solid var(--border-primary)', borderRadius: 8, background: 'var(--bg-tertiary)' }}>
                        <button onClick={() => setOpenStrat(o => ({ ...o, [code]: !o[code] }))}
                          style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '7px 10px', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', textAlign: 'left', fontSize: 'calc(0.78rem * var(--fz))', fontWeight: 700, fontFamily: 'inherit' }}>
                          <span style={{ color: 'var(--text-muted)', fontSize: 'calc(0.65rem * var(--fz))' }}>{open ? '▾' : '▸'}</span>
                          📐 持股策略分析
                          <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'calc(0.7rem * var(--fz))' }}>隔日沖對照 · 持有日獲利 · 相似歷史波段</span>
                        </button>
                        {open && (() => {
                          // 三段各自配色：藍=隔日沖、青=波段持有、紫=相似歷史——
                          // 底色與重點同色系，掃讀時靠顏色就能定位段落；
                          // 警示（描述統計/檢定未通過）統一琥珀底，與全站風險語彙一致。
                          const panel = (c: string): React.CSSProperties => ({
                            marginTop: 8, padding: '8px 12px', borderRadius: 8,
                            background: `${c}0f`, border: `1px solid ${c}33`, borderLeft: `3px solid ${c}`,
                          });
                          const pTitle = (c: string): React.CSSProperties => ({ fontWeight: 800, color: c, marginBottom: 2 });
                          const chip = (border?: string): React.CSSProperties => ({
                            padding: '2px 8px', borderRadius: 6, background: 'rgba(0,0,0,0.25)',
                            fontFamily: 'JetBrains Mono, monospace', fontSize: 'calc(0.72rem * var(--fz))',
                            border: border ?? '1px solid transparent',
                          });
                          const caveat: React.CSSProperties = {
                            marginTop: 4, padding: '4px 8px', borderRadius: 6, background: 'rgba(245,158,11,0.10)',
                            border: '1px solid rgba(245,158,11,0.25)', color: '#fbbf24', fontSize: 'calc(0.68rem * var(--fz))',
                          };
                          const BLUE = '#3d8ef8', TEAL = '#2dd4bf', VIOLET = '#a78bfa';
                          return (
                          <div style={{ padding: '2px 10px 10px', fontSize: 'calc(0.76rem * var(--fz))', lineHeight: 1.8, color: 'var(--text-secondary)' }}>
                            {/* ① 隔日沖 */}
                            <div style={panel(BLUE)}>
                              <div style={pTitle(BLUE)}>🎯 若以隔日沖操作</div>
                              <div style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 6, marginBottom: 2,
                                background: st.filterPass ? 'rgba(240,62,62,0.12)' : 'rgba(148,163,184,0.12)',
                                border: st.filterPass ? '1px solid rgba(240,62,62,0.35)' : '1px solid var(--border-primary)' }}>
                                今日 <b style={{ color: st.chg >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{st.chg >= 0 ? '+' : ''}{st.chg}%</b>
                                {st.pos != null ? <>·收位 <b>{st.pos}</b></> : null}{st.charLabel ? `·${st.charLabel}` : ''}——
                                {st.filterPass
                                  ? <b style={{ color: 'var(--color-up)' }}>符合撿尾盤定版濾網</b>
                                  : <>不符定版濾網（缺 <b style={{ color: '#fbbf24' }}>{st.fails.join('、')}</b>）</>}
                              </div>
                              <div style={{ fontSize: 'calc(0.72rem * var(--fz))' }}>
                                鐵律：隔日沖持股一律<b style={{ color: BLUE }}>明早開盤賣出</b>（700 日實測唯一穩定淨正出場；開高續抱平均吐光溢價 -0.33%）。來回費稅約 <b>0.44%</b>。
                                {st.charLabel === '長期核心' ? <b style={{ color: '#fbbf24' }}>此股屬長期核心——短線訊號是雜訊，不建議隔日沖。</b> : null}
                              </div>
                            </div>
                            {/* ② 持有日獲利 */}
                            <div style={panel(TEAL)}>
                              <div style={pTitle(TEAL)}>🌊 波段持有日獲利<span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'calc(0.68rem * var(--fz))' }}>（該股近一年逐日進場統計·n={st.hold[0]?.n ?? '—'}）</span></div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '3px 0' }}>
                                {st.hold.map(h => (
                                  <span key={h.d} style={chip(matched && matched.d === h.d ? `1.5px solid ${TEAL}` : undefined)}>
                                    第{h.d}日 <b style={{ color: h.med >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{h.med >= 0 ? '+' : ''}{h.med}%</b> <span style={{ color: 'var(--text-muted)' }}>勝{h.win}%</span>
                                  </span>
                                ))}
                              </div>
                              {st.heldDays != null && matched && (
                                <div>你目前持有<b style={{ color: TEAL }}>第 {st.heldDays} 個交易日</b>、帳面 <b style={{ color: a.pnlPct >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{a.pnlPct >= 0 ? '+' : ''}{a.pnlPct.toFixed(2)}%</b>；該股歷史同持有期中位 {matched.med >= 0 ? '+' : ''}{matched.med}%（勝率 {matched.win}%）。</div>
                              )}
                              <div style={caveat}>⚠ 全歷史描述統計，會完整繼承這一年的趨勢——不是對你這筆進場的預測。</div>
                            </div>
                            {/* ③ 相似歷史波段 */}
                            {st.analog && (
                              <div style={panel(VIOLET)}>
                                <div style={pTitle(VIOLET)}>🔁 相似歷史波段<span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'calc(0.68rem * var(--fz))' }}>（全市場最像的 {st.analog.n} 段·近20日形狀）</span></div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '3px 0' }}>
                                  {st.analog.stats.map(x => (
                                    <span key={x.d} style={chip()}>
                                      後{x.d}日 <b style={{ color: x.med >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{x.med >= 0 ? '+' : ''}{x.med}%</b> <span style={{ color: 'var(--text-muted)' }}>勝{x.win}%</span>
                                    </span>
                                  ))}
                                  <span style={chip(`1px solid ${VIOLET}55`)}>
                                    最大成長 <b style={{ color: 'var(--color-up)' }}>+{st.analog.grow}%</b> ／ 回檔 <b style={{ color: 'var(--color-down)' }}>{st.analog.draw}%</b>
                                  </span>
                                </div>
                                <div style={{ fontSize: 'calc(0.7rem * var(--fz))', color: 'var(--text-muted)' }}>成長是賣不到的上界，必須配回檔一起看。例：{st.analog.examples.map(e => `${e.code} ${e.date} → 5日 ${e.ret5 != null ? (e.ret5 >= 0 ? '+' : '') + e.ret5 + '%' : '—'}`).join('；')}</div>
                                <div style={caveat}>⚠ 誠實揭露：「走勢相似→未來報酬」本站歷史檢定<b>未通過</b>（最大漲幅隨波動放大）——描述統計、非訊號，勿當排序依據。</div>
                              </div>
                            )}
                          </div>
                          );
                        })()}
                      </div>
                    );
                  })()}

                  {a.newsSummary && (
                    <div style={{ marginTop: 8, fontSize: 'calc(0.72rem * var(--fz))', color: 'var(--text-muted)' }}>📰 近一月新聞：{a.newsSummary}</div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 10, fontSize: 'calc(0.68rem * var(--fz))', color: 'var(--text-muted)' }}>⚠️ 建議綜合技術/估值/新聞＋三大法人籌碼（勝率雷達階段·主力倒貨）研判；目標價為 AI 推估，僅供參考、非投資建議。</div>
        </>
      )}
    </div>
  );
}
