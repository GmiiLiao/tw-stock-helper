'use client';

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db as fsdb } from '@/lib/firebase';
import { useAppStore } from '@/lib/store';

// ── 🌅 盤前總覽（2026-08-05 三卡合一）────────────────────────────
// 合併前是三張獨立卡片，由上而下排：日韓早盤風向 → 盤前晨報 → 國際盤連動。
// 使用者指出它們該是同一張卡——**因為它們回答的是同一個問題**：
//   「台股 09:00 開盤前，我已經知道了什麼？」
// 三者只是同一問題的三個時間切片：
//   隔夜（美股收盤·台北 04:00）→ 今晨（日韓 08:00 開盤）→ 開盤前（晨報彙整）
// 拆成三張卡等於要使用者自己在腦中重新拼回一個時間軸。
//
// 版面：桌機三欄並排（時間順序由左至右＝隔夜→今晨→彙整），窄螢幕自動堆疊。
//   長文（晨報全文）預設收合——它是三者中唯一的散文，不收合會把另外兩欄的
//   數字擠到螢幕外，而數字才是開盤前真正要看的東西。
//
// ⚠日韓早盤的預測力是**初步**（n=54 交易日，遠低於本站 480日主窗＋OOT 標準）。
//   所有數字與警語由 daemon 帶下來，UI 不自行加工也不自行下結論。非投資建議。

const UP = '#f03e3e', DOWN = '#2f9e44';
const col = (v: number | null | undefined) => (v == null ? 'var(--text-muted)' : v >= 0 ? UP : DOWN);
const sign = (v: number | null | undefined) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${v}%`);

interface Idx { sym: string; name: string; mkt: string; price: number; gap: number | null; drift: number | null; total: number }
interface Sector { sector: string; twPeers: string; leaders: string; chg: number }
interface Mkt { name: string; chg: number; dir: 'up' | 'down' | 'flat' | null; detail: string }
interface Asia {
  found?: boolean; date?: string; updatedAt?: number; twOpenIn?: number;
  indices?: Idx[]; sectors?: Sector[];
  score?: number | null; bias?: 'bull' | 'bear' | 'neutral' | null; biasNote?: string | null;
  soxNote?: string | null; horizon?: string; evidence?: string; caveats?: string[];
  // 日韓分別方向＋報價新鮮度（2026-08-06）：綜合分數會把一漲一跌抵消成「中性」，
  // 分歧本身是資訊；Yahoo 對日韓延遲約 20 分，必須揭露而不是假裝即時。
  jp?: Mkt | null; kr?: Mkt | null; split?: string | null;
  slot?: string | null; phase?: string; delayMin?: number | null; delayNote?: string | null;
}
interface GMarket { sym: string; name: string; price: number; changePct: number }
interface Forecast { bullish: { sector: string; reason: string }[]; bearish: { sector: string; reason: string }[]; model: string }
interface Note { date: string; content: string; forecast?: Forecast | null }
interface Hit { code: string; name: string; industry: string; side: string }

const BIAS: Record<string, { t: string; c: string }> = {
  bull: { t: '偏多', c: UP }, bear: { t: '偏空', c: DOWN }, neutral: { t: '中性', c: '#94a3b8' },
};

/** 欄標題：三欄用同一套樣式，讓「這是三個並列的東西」一眼看得出來 */
const ColHead = ({ icon, name, when }: { icon: string; name: string; when: string }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6, paddingBottom: 5, borderBottom: '1px solid rgba(148,163,184,0.16)', flexWrap: 'wrap' }}>
    <span style={{ fontWeight: 900, fontSize: 12.5 }}>{icon} {name}</span>
    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{when}</span>
  </div>
);

// ── 晨報正文去重（2026-08-05，三卡合一之後才發現）─────────────────
// daemon 的晨報 markdown 其實是「把本頁好幾張卡用文字再講一次」：
//   ## 今日風向推測 → 本卡全寬區已顯示（且是同一份 forecast 物件）
//   ## 隔夜國際盤   → 本卡第①欄已顯示
//   ## ADR 溢價     → 市場總覽「🌉 ADR 溢價」卡
//   ## 昨日大盤體質 → 市場總覽「❤️ 大盤健康度」卡
//   ## 今日事件     → 市場總覽「📅 事件日曆」卡
// 三張卡各自獨立、上下相隔幾個螢幕時，這種重複看不出來；**併成一張卡、
// 三欄並排之後，同一組數字就明擺著出現兩次**。合併是重複的顯影劑。
//
// 只砍「本分頁上真的有對應卡片」的段落。像「外資連買焦點」對應的
// 🏦法人連續買超 是收在📚進階指標裡（預設收合），砍掉就真的看不到了 → 保留。
//
// 比對用的是 daemon 目前的標題字串。若哪天 daemon 改了標題，這裡會**比對不到
// 而原樣顯示**——失敗方向是「重複出現」而不是「資訊消失」，這是刻意的。
const DUP_SECTIONS = ['風向推測', '隔夜國際盤', 'ADR 溢價', '昨日大盤體質', '今日事件'];

function cleanNote(md: string, hasForecast: boolean): string {
  const kill = hasForecast ? DUP_SECTIONS : DUP_SECTIONS.filter(k => k !== '風向推測');
  const out: string[] = [];
  let skipping = false;
  for (const raw of md.split('\n')) {
    const l = raw.trimEnd();
    if (/^#\s/.test(l)) continue;                       // 大標＝欄標題已經有日期了
    if (/^##\s/.test(l)) skipping = kill.some(k => l.includes(k));
    if (skipping) continue;
    out.push(l.replace(/^#+\s*/, '').replace(/^-\s/, '· '));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const colBox: React.CSSProperties = {
  padding: '10px 12px', borderRadius: 10,
  background: 'rgba(148,163,184,0.05)', border: '1px solid rgba(148,163,184,0.14)',
  minWidth: 0,   // grid 子項預設 min-width:auto，長字串會把欄位撐爆
};

export default function PremarketHub() {
  const [asia, setAsia] = useState<Asia | null>(null);
  const [gm, setGm] = useState<{ markets: GMarket[]; expectation: string } | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [hits, setHits] = useState<Hit[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);   // 散文預設收合（見檔頭）
  const [evOpen, setEvOpen] = useState(false);
  const user = useAppStore(s => s.user);

  useEffect(() => {
    let live = true;
    const get = <T,>(url: string, set: (d: T) => void) =>
      fetch(url).then(r => (r.ok ? r.json() : null)).then((d: T | null) => { if (live && d) set(d); }).catch(() => {});
    const load = () => {
      get<Asia>('/api/ai/asia-premarket', d => { if (d?.found !== false) setAsia(d); });
      get<{ markets: GMarket[]; expectation: string }>('/api/ai/global-markets', d => setGm(d));
      get<Note>('/api/ai/morning-note', d => { if (d?.content) setNote(d); });
    };
    load();
    // 盤前資料只在開盤前後變動，其餘 80% 的時間輪詢是純浪費——5 分一次已足夠。
    const id = setInterval(load, 300000);
    return () => { live = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!user?.uid || !fsdb || typeof (fsdb as { type?: unknown }).type === 'undefined') return;
    const unsub = onSnapshot(doc(fsdb, 'users', user.uid, 'data', 'forecastHits'),
      snap => setHits(snap.exists() ? (snap.data().hits || []) : []), () => {});
    return () => unsub();
  }, [user?.uid]);

  const hasAsia = !!asia?.indices?.length;
  const hasGm = !!gm?.markets?.length;
  if (!hasAsia && !hasGm && !note) return null;

  const b = asia?.bias ? BIAS[asia.bias] : null;
  const stale = asia?.updatedAt ? (Date.now() - asia.updatedAt) / 60000 : 999;
  const fc = note?.forecast;
  const bear = hits.filter(h => h.side === 'bear');
  const bull = hits.filter(h => h.side === 'bull');

  return (
    <div style={{ border: '1px solid rgba(56,189,248,0.3)', borderRadius: 12, padding: '12px 14px', margin: '0 0 4px', background: 'var(--bg-card)' }}>
      {/* 卡頭 */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontWeight: 900, fontSize: '1.05rem' }}>🌅 盤前總覽</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          隔夜美股 → 今晨日韓 → 開盤前彙整
          {asia?.twOpenIn != null && asia.twOpenIn > 0 ? `　·　距台股開盤 ${asia.twOpenIn} 分` : ''}
        </span>
        {b && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 13, fontWeight: 900 }}>
            {asia?.jp && <span style={{ color: col(asia.jp.chg) }}>🇯🇵日本 {sign(asia.jp.chg)}</span>}
            {asia?.kr && <span style={{ color: col(asia.kr.chg) }}>🇰🇷韓國 {sign(asia.kr.chg)}</span>}
            <span style={{ color: b.c }}>綜合 {sign(asia?.score)} → {b.t}</span>
          </span>
        )}
      </div>

      {/* ── 全寬區：今日風向推測 ＋ 我的持股命中 ───────────────────
          放在欄位之上是刻意的：這是唯一「跟你有關」的一句話，
          三欄的數字都是背景，它才是使用者開盤前真正要帶走的結論。 */}
      {fc && (fc.bullish.length > 0 || fc.bearish.length > 0) && (
        <div style={{ margin: '0 0 8px', padding: '10px 14px', borderRadius: 10, background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)' }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 5 }}>📰 今日風向推測（依國際盤＋新聞，AI 推測非事實）</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 8 }}>
            {fc.bullish.length > 0 && (
              <div style={{ fontSize: '0.98rem', fontWeight: 900, color: UP, lineHeight: 1.65 }}>
                🔴 看漲：{fc.bullish.map(x => x.sector).join('、')}
                <div style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--text-muted)', lineHeight: 1.65 }}>{fc.bullish.map(x => x.reason).join('；')}</div>
              </div>
            )}
            {fc.bearish.length > 0 && (
              <div style={{ fontSize: '0.98rem', fontWeight: 900, color: DOWN, lineHeight: 1.65 }}>
                🟢 看跌：{fc.bearish.map(x => x.sector).join('、')}
                <div style={{ fontSize: 11.5, fontWeight: 400, color: 'var(--text-muted)', lineHeight: 1.65 }}>{fc.bearish.map(x => x.reason).join('；')}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {hits.length > 0 && (
        <div style={{ margin: '0 0 10px', padding: '10px 14px', borderRadius: 10, background: bear.length ? 'rgba(47,158,68,0.12)' : 'rgba(240,62,62,0.10)', border: `2px solid ${bear.length ? DOWN : UP}` }}>
          {bear.length > 0 && (
            <div style={{ fontSize: '1.02rem', fontWeight: 900, color: DOWN, lineHeight: 1.7 }}>
              🚨 你的持股 {bear.map(h => `${h.code} ${h.name}（${h.industry}）`).join('、')} 屬今日看跌族群 — 開盤請留意
            </div>
          )}
          {bull.length > 0 && (
            <div style={{ fontSize: '0.98rem', fontWeight: 800, color: UP, lineHeight: 1.7 }}>
              ✨ 你的持股 {bull.map(h => `${h.code} ${h.name}（${h.industry}）`).join('、')} 屬今日看漲族群
            </div>
          )}
        </div>
      )}

      {/* ── 三欄：時間順序由左至右 ───────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 10, alignItems: 'start' }}>

        {/* ① 隔夜國際盤 */}
        <div style={colBox}>
          <ColHead icon="🌎" name="隔夜國際盤" when="美股收盤 · 台北 04:00" />
          {hasGm ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(88px, 1fr))', gap: 6 }}>
                {gm!.markets.map(m => (
                  <div key={m.sym} style={{ textAlign: 'center', padding: '6px 3px', background: 'var(--bg-tertiary)', borderRadius: 7 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</div>
                    <div style={{ fontSize: 12.5, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{m.price.toLocaleString()}</div>
                    <div style={{ fontSize: 11, fontWeight: 800, color: col(m.changePct) }}>{sign(m.changePct)}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11.5, marginTop: 7, fontWeight: 700, color: gm!.expectation.includes('多') ? UP : gm!.expectation.includes('空') ? DOWN : 'var(--text-muted)' }}>
                開盤預期：{gm!.expectation}
              </div>
            </>
          ) : <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>載入中…</div>}
        </div>

        {/* ② 今晨日韓早盤 */}
        <div style={colBox}>
          <ColHead icon="🌏" name="今晨日韓早盤" when="日韓 09:00 開盤 = 台北 08:00" />
          {hasAsia ? (
            <>
              {stale > 180 && (
                <div style={{ fontSize: 10.5, color: '#fbbf24', marginBottom: 5, lineHeight: 1.6 }}>
                  ⚠資料為 {asia!.date}（已逾 {Math.round(stale / 60)} 小時未更新）——非今日盤前即時值，僅供回看。
                </div>
              )}
              {(asia!.jp || asia!.kr) && (
                <div style={{ display: 'grid', gap: 3, marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid rgba(148,163,184,0.14)' }}>
                  {[asia!.jp, asia!.kr].filter(Boolean).map(m => (
                    <div key={m!.name} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 900 }}>{m!.name === '日本' ? '🇯🇵 日本' : '🇰🇷 韓國'}</span>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 900, color: col(m!.chg) }}>
                        {m!.dir === 'up' ? '▲' : m!.dir === 'down' ? '▼' : '—'} {sign(m!.chg)}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>{m!.detail}</span>
                    </div>
                  ))}
                  {asia!.split && <div style={{ fontSize: 10.5, color: '#fbbf24', lineHeight: 1.6 }}>{asia!.split}</div>}
                  {asia!.delayNote && (
                    <div style={{ fontSize: 10, color: (asia!.delayMin ?? 0) > 45 ? '#fbbf24' : 'var(--text-muted)', lineHeight: 1.6 }}>
                      {asia!.delayNote}{asia!.slot ? `　·　${asia!.slot} 那一輪` : ''}
                    </div>
                  )}
                </div>
              )}
              <div style={{ display: 'grid', gap: 3 }}>
                {asia!.indices!.map(x => (
                  <div key={x.sym} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700 }}>{x.name}</span>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 800, color: col(x.total) }}>{sign(x.total)}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 'auto' }}>跳空{sign(x.gap)}·開後{sign(x.drift)}</span>
                  </div>
                ))}
              </div>
              {asia!.biasNote && <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.6 }}>📐 {asia!.biasNote}</div>}
              {asia!.soxNote && <div style={{ fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.6 }}>🇺🇸 {asia!.soxNote}</div>}

              {!!asia!.sectors?.length && (
                <div style={{ marginTop: 7 }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 3 }}>產業風向（日韓龍頭 → 台股對應）</div>
                  {asia!.sectors!.map(s => (
                    <div key={s.sector} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 11, padding: '1px 0', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, minWidth: 56 }}>{s.sector}</span>
                      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 800, color: col(s.chg), minWidth: 48, textAlign: 'right' }}>{sign(s.chg)}</span>
                      <span style={{ fontSize: 10, color: '#7dd3fc', marginLeft: 'auto' }}>→ {s.twPeers}</span>
                    </div>
                  ))}
                </div>
              )}

              <button onClick={() => setEvOpen(o => !o)} style={{ background: 'none', border: 'none', color: '#7dd3fc', fontSize: 10.5, cursor: 'pointer', padding: '6px 0 0', textAlign: 'left' }}>
                {evOpen ? '▾ 收起實證與限制' : '▸ 實證數字與限制（務必先看）'}
              </button>
              {evOpen && (
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 3 }}>
                  {asia!.horizon && <div>⏱ {asia!.horizon}</div>}
                  {asia!.evidence && <div style={{ marginTop: 3 }}>📊 {asia!.evidence}</div>}
                  {asia!.caveats?.map((c, i) => <div key={i} style={{ marginTop: 3 }}>{c}</div>)}
                  <div style={{ marginTop: 4 }}>非投資建議。</div>
                </div>
              )}
            </>
          ) : <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>盤前 08:00 起每 15 分更新，尚無今日資料。</div>}
        </div>

        {/* ③ 盤前晨報（去重後只剩本頁沒有的段落，見 cleanNote） */}
        <div style={colBox}>
          <ColHead icon="📝" name="盤前晨報" when={note ? `${note.date} · 開盤前 70 分上報` : 'daemon 開盤前 70 分生成'} />
          {(() => {
            if (!note?.content) return <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>尚無今日晨報。</div>;
            const body = cleanNote(note.content, !!fc);
            if (!body) return (
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.7 }}>
                今日晨報的每一段都已呈現在左側兩欄與下方卡片（風向推測／國際盤／ADR 溢價／大盤健康度／事件日曆），沒有額外內容。
              </div>
            );
            // 只有長到會被截掉才給收合鈕——短內容配一顆按不出變化的按鈕最惱人
            const long = body.length > 190;
            const open = noteOpen || !long;
            return (
              <>
                <div style={{
                  fontSize: 11.5, lineHeight: 1.75, color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
                  maxHeight: open ? 'none' : 108, overflow: 'hidden',
                  // 收合時底部漸隱，明示「下面還有」而不是「就這樣」
                  maskImage: open ? undefined : 'linear-gradient(180deg,#000 60%,transparent)',
                  WebkitMaskImage: open ? undefined : 'linear-gradient(180deg,#000 60%,transparent)',
                }}>{body}</div>
                {long && (
                  <button onClick={() => setNoteOpen(o => !o)} style={{ background: 'none', border: 'none', color: '#7dd3fc', fontSize: 10.5, cursor: 'pointer', padding: '6px 0 0', textAlign: 'left' }}>
                    {noteOpen ? '▾ 收合晨報' : '▸ 展開晨報全文'}
                  </button>
                )}
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
