// ── 即時轉空型態判定（唯一實作：即時轉空分頁 FadeWatch 與多空同屏 DualBoard 共用）──────────
// 規則與數字來自 scripts/fade-intraday-lab.mjs 的 5 分 K 逐根回放（2026-07-03～09-23）：
//   成立當根收盤賣出（現股當沖先賣）、官方收盤回補，淨＝扣當沖成本 0.435%（未含折讓）。訓練＝前 60% 交易日、樣本外＝後 40%。
//   全部型態合併做空：訓練淨均 −0.08%、樣本外 −0.35% ⇒ 不分辨就放空是賠錢的；只留兩段都為正的，兩段都為負的列成「不建議放空」。
import { statusOf } from '@/lib/useDayTradeCodes';

export interface FadeSnap {
  code: string; name: string; price: number; change: number; changePercent: number;
  volume: number; volX: number | null; market: string; open: number; high: number; low: number;
  vwap?: number | null;   // daemon 取樣累積 VWAP（Σ價×Δ量÷Σ量；取樣覆蓋不足當日量 80% 時為 null）
}
export type Tier = 'A' | 'B' | 'C' | 'X';
export interface FadeMetrics { hiUp: number; give: number; chg: number; openUp: number; openFall: number; volX: number; pace: number; aboveVwap: boolean | null; hm: number }
export interface FadePattern { key: string; label: string; tier: Tier; oos: string; train: string; test: (m: FadeMetrics) => boolean }
export type FadeRow = { s: FadeSnap; m: FadeMetrics; main: FadePattern; also: FadePattern[]; demote?: string };
export type FadeAvoidRow = { s: FadeSnap; m: FadeMetrics; why: string };

export const FADE_PATTERNS: FadePattern[] = [
  { key: 'luVwap', label: '漲停打開·仍在VWAP上', tier: 'A', oos: '樣本外淨 +1.89%／勝率 57%（n=68）', train: '訓練 +2.06%（n=196）', test: m => m.hiUp >= 9.4 && m.give >= 3 && m.aboveVwap === true },
  { key: 'luOpen', label: '漲停打開回落', tier: 'A', oos: '樣本外淨 +0.84%／勝率 51%（n=315）', train: '訓練 +0.53%（n=796）', test: m => m.hiUp >= 9.4 && m.give >= 3 },
  { key: 'earlyDeep', label: '早盤深回吐（10 點前回吐≥6）', tier: 'A', oos: '樣本外淨 +0.79%／勝率 51%（n=61）', train: '訓練 +1.25%（n=158）', test: m => m.hm < 600 && m.give >= 6 },
  { key: 'spikeVol', label: '沖高回落＋爆量', tier: 'B', oos: '樣本外淨 +0.29%／勝率 54%（n=894）', train: '訓練 +0.41%（n=1,561）', test: m => m.hiUp >= 5 && m.give >= 4 && m.pace >= 2 },
  { key: 'spike', label: '沖高回落（量未放大）', tier: 'C', oos: '樣本外淨 +0.04%（約損益兩平）', train: '訓練 +0.16%', test: m => m.hiUp >= 5 && m.give >= 4 },
];
const AVOID: { key: string; label: string; why: string; test: (m: FadeMetrics) => boolean }[] = [
  { key: 'flipped', label: '已翻黑', why: '追空已翻黑：訓練 −0.56%／樣本外 −1.32%', test: m => m.hiUp >= 3 && m.chg < 0 },
  { key: 'openFall', label: '開高走低', why: '訓練 −0.54%／樣本外 −0.68%', test: m => m.openUp >= 2 && m.openFall >= 2 },
  { key: 'lowPace', label: '量能不足', why: '量能節奏<2x：訓練 −0.58%／樣本外 −1.20%', test: m => m.hiUp >= 5 && m.give >= 4 && m.pace < 2 && m.hiUp < 9.4 },
];
export const TIER_STYLE: Record<Tier, { c: string; bg: string; t: string }> = {
  A: { c: '#2f9e44', bg: 'rgba(47,158,68,0.20)', t: '強' },
  B: { c: '#4ade80', bg: 'rgba(74,222,128,0.12)', t: '中' },
  C: { c: 'var(--text-muted)', bg: 'rgba(148,163,184,0.12)', t: '弱' },
  X: { c: '#f59e0b', bg: 'rgba(245,158,11,0.12)', t: '避' },
};
export const TIER_RANK: Record<Tier, number> = { A: 0, B: 1, C: 2, X: 3 };

/** 台北時間的「盤中分鐘數」與已過交易時段比例（量能節奏＝今日量比÷已過時段比例；時間規則只在盤中套用） */
export function sessionClock(marketOpen: boolean): { hm: number; frac: number } {
  if (!marketOpen) return { hm: 999, frac: 1 };
  const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const hm = t.getHours() * 60 + t.getMinutes();
  return { hm, frac: Math.min(1, Math.max(0.05, (hm - 540) / 270)) };
}

type DtMap = Parameters<typeof statusOf>[0];
/** 全市場快照 → 做空候選（依型態強度）與不建議放空清單。不做篩選／截斷，由呼叫端決定。 */
export function classifyFade(snaps: FadeSnap[], marketOpen: boolean, dt: DtMap): { rows: FadeRow[]; avoid: FadeAvoidRow[] } {
  const { hm, frac } = sessionClock(marketOpen);
  const rows: FadeRow[] = []; const avoid: FadeAvoidRow[] = [];
  for (const s of snaps) {
    if (!/^\d{4}$/.test(s.code) || s.code.startsWith('00')) continue;
    const prev = s.price - s.change;
    if (!(prev > 10) || !(s.high > 0) || !(s.price > 0)) continue;
    if ((s.volume || 0) / 1000 < 500) continue;   // 與回測同一流動性門檻
    const vwap = s.vwap && s.vwap > 0 ? s.vwap : null;
    const volX = s.volX ?? 0;
    const m: FadeMetrics = {
      hiUp: (s.high / prev - 1) * 100, give: (s.high - s.price) / prev * 100, chg: s.changePercent,
      openUp: s.open > 0 ? (s.open / prev - 1) * 100 : 0, openFall: s.open > 0 ? (s.open - s.price) / s.open * 100 : 0,
      volX, pace: volX / frac, aboveVwap: vwap ? s.price > vwap : null, hm,
    };
    if (m.hiUp < 3) continue;
    const dts = statusOf(dt, s.code);
    if (dts != null && dts !== 1) { if (m.hiUp >= 5) avoid.push({ s, m, why: dts === 2 ? '僅先買後賣：不可先賣當沖（無法放空）' : '不可現股當沖（處置股等）：無法放空' }); continue; }
    const bad = AVOID.find(a => a.test(m));
    const hits = FADE_PATTERNS.filter(p => p.test(m));
    // 已翻黑／開高走低／量能不足：兩段都為負 ⇒ 除非同時是「漲停打開」這種兩段都為正的強型態，否則歸入不建議放空
    if (bad && !(hits[0] && hits[0].tier === 'A' && hits[0].key.startsWith('lu'))) { avoid.push({ s, m, why: `${bad.label}：${bad.why}` }); continue; }
    if (!hits.length) continue;
    const main = hits[0];
    const demote = marketOpen && hm >= 720 ? '12:00 後進場：訓練 −0.52%／樣本外 −0.30%，勝率僅 30～35%' : undefined;
    rows.push({ s, m, main: demote ? { ...main, tier: 'X' } : main, also: hits.slice(1), demote });
  }
  return { rows, avoid };
}
