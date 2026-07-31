#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 隔週沖/短波段模式種子檢定（5日持有·今收買→t+5收賣·扣0.4425%）
// 注意：5日前視視窗重疊→樣本非獨立、顯著性需打折；兩半窗同向仍為硬條件。
// 測：隔日語意被否決但屬波段尺度的因子（深回檔/深跌反彈/法人連買/布局）＋現有正因子。
// ─────────────────────────────────────────────────────────────────────────
import { loadDays, buildSamples } from './lib/bt-core.mjs';
const days = await loadDays({ days: 700 });
const samples = buildSamples(days).filter(s => s.tradable && s.net5 != null);
const avg = a => a.length ? +(a.reduce((t, v) => t + v, 0) / a.length).toFixed(3) : null;
const base = {};
for (const half of [0, 1]) base[half] = avg(samples.filter(s => s.half === half).map(s => s.net5));
console.log(`樣本 ${samples.length.toLocaleString()}·5日淨基準 前半${base[0]}%/後半${base[1]}%`);
const row = (label, cond) => {
  const out = [0, 1].map(half => {
    const g = samples.filter(s => s.half === half).filter(cond);
    if (g.length < 500) return null;
    return { d: +(avg(g.map(s => s.net5)) - base[half]).toFixed(3), win: +(g.filter(s => s.net5 > 0).length / g.length * 100).toFixed(1), n: g.length };
  });
  const ok = out[0] && out[1] && Math.sign(out[0].d) === Math.sign(out[1].d) && Math.min(Math.abs(out[0].d), Math.abs(out[1].d)) >= 0.1;
  console.log(`  ${label.padEnd(22)} Δ5日[${out[0]?.d ?? '不足'}/${out[1]?.d ?? '不足'}] 淨勝[${out[0]?.win ?? '-'}%/${out[1]?.win ?? '-'}%] n=${((out[0]?.n ?? 0) + (out[1]?.n ?? 0)).toLocaleString()} ${ok ? '✅' : '❌'}`);
};
console.log('── 均值回歸族（隔日語意曾見但不穩/regime相依）──');
row('5日跌<-5%（深跌）', s => s.ret5 != null && s.ret5 < -5);
row('深回檔 posture<0.8', s => s.posture60 != null && s.posture60 < 0.8);
row('深跌∧深回檔', s => s.ret5 != null && s.ret5 < -5 && s.posture60 != null && s.posture60 < 0.8);
console.log('── 法人族（波段原生尺度）──');
row('外資連買≥3', s => s.fStreak >= 3);
row('外資連買≥5', s => s.fStreak >= 5);
row('法人5日吸貨≥30%均量', s => s.inst5Ratio != null && s.inst5Ratio >= 0.3);
row('連買≥3∧未大漲(ret5<5)', s => s.fStreak >= 3 && s.ret5 != null && s.ret5 < 5);
row('吸貨≥30%∧未大漲', s => s.inst5Ratio != null && s.inst5Ratio >= 0.3 && s.ret5 != null && s.ret5 < 5);
console.log('── 動能族（隔日已驗證·5日是否延伸）──');
row('破高×強尾', s => s.brk20 && s.pos >= 0.7);
row('定版濾網(×3~7)', s => s.brk20 && s.pos >= 0.7 && s.chg >= 3 && s.chg <= 7);
row('過熱 ret5≥20', s => s.ret5 != null && s.ret5 >= 20);
console.log('※ fwd視窗重疊·顯著性打折；門檻|Δ|≥0.1pp 兩窗同向。非投資建議。');
process.exit(0);
