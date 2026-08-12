'use client';

import type { HoldingStrategyResult } from '../../../scripts/lib/holding-strategy';

// ── 持股策略三段面板（藍=隔日沖、青=波段持有、紫=相似歷史）──────────────
// PortfolioAI（持股卡）與 DecisionDesk（決策工作台展開區）共用——
// 單一渲染實作，配色/揭露文字兩處永遠一致。資料來源：
//   持股卡＝daemon 寫進 portfolioAnalysis.analyses[code].strategy；
//   工作台＝/api/ai/stock-strategy（同一份共用計算模組）。
// 兩條誠實揭露（描述統計非預測／相似檢定未通過）是本元件的一部分，不可由呼叫端關掉。

const BLUE = '#3d8ef8', TEAL = '#2dd4bf', VIOLET = '#a78bfa';

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

export default function StrategyPanels({ st, pnlPct, mode = 'holding' }: { st: HoldingStrategyResult; pnlPct?: number; mode?: 'holding' | 'candidate' }) {
  // 日計慣例（2026-08-12 使用者定案）：**進場／操作當天＝第 1 日**。
  // st.heldDays 是「經過的交易日數」（進場日=0）——顯示一律 +1；
  // 候選（無買進日）由呼叫端把 heldDays 錨定為 0＝「以操作時間為第 1 日」。
  // 對照列取 max(1, elapsed)：進場當天對到 d=1（＝明日收盤那格），語意是
  // 「接下來持有滿 1 個交易日，歷史上中位是多少」。
  const elapsed = st.heldDays;
  const dayNo = elapsed != null ? elapsed + 1 : null;
  const matched = elapsed != null ? st.hold.find(h => h.d >= Math.max(1, elapsed)) ?? st.hold[st.hold.length - 1] : null;
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
        {dayNo != null && matched && (
          <div>
            你目前{mode === 'candidate' ? '操作' : '持有'}<b style={{ color: TEAL }}>第 {dayNo} 個交易日</b>
            <span style={{ color: 'var(--text-muted)', fontSize: 'calc(0.68rem * var(--fz))' }}>（{mode === 'candidate' ? '以操作時間為第 1 日' : '買進日＝第 1 日'}）</span>
            {pnlPct != null && <>、帳面 <b style={{ color: pnlPct >= 0 ? 'var(--color-up)' : 'var(--color-down)' }}>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</b></>}
            ；持有滿 <b>{matched.d}</b> 個交易日的歷史中位 {matched.med >= 0 ? '+' : ''}{matched.med}%（勝率 {matched.win}%）。
          </div>
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
}
