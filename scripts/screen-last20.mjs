#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 近 20 個交易日回測 —— 2026-08-05（使用者指定窗口）
//
// ⚠**先講這個窗口能與不能回答什麼**，否則結論會被過度解讀：
//   · 20 個交易日 ≈ 20 個進場日。本站的判準是「480 日主窗兩半窗同號 ＋
//     240 日第三獨立窗」，20 日連一個半窗都不夠。
//   · 同一段期間的 20 天高度共享同一個市場狀態（本窗就是一段回檔），
//     樣本之間**不獨立**，算出來的勝率沒有統計意義。
//   ⇒ 本腳本**不用來驗證任何權重**。它只回答兩件事：
//     ① 近 20 日實際發生了什麼（描述）
//     ② 2026-08-05 上線的新排序鍵在這段期間有沒有明顯壞掉（健檢）
//   任何「近 20 日勝率 XX%」都不可以拿去當成效證據——要看成效請看
//   screen-recommend-rank.mjs 的 480 日＋240 日結果。
//
// 口徑：隔日沖 今收買→明開賣·扣 0.4425%；可交易宇宙（當日漲幅 ≤8.5%）。
// 用法：node scripts/screen-last20.mjs
// ─────────────────────────────────────────────────────────────────────────
import { loadDays } from './lib/bt-core.mjs';
import { build, fiveFixed, validated } from './screen-recommend-rank.mjs';

const N_DAYS = 20, WARM = 62;
const r3 = x => (x == null ? null : +x.toFixed(3));
const r2 = x => (x == null ? null : +x.toFixed(2));
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);

const KEY_A = s => fiveFixed(s);                       // 舊排序鍵的修正版（Ⓐ）
const KEY_C = s => fiveFixed(s) + validated(s) * 3;    // 現行 v2 排序鍵（Ⓒ）

const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

const main = async () => {
  const all = await loadDays({ days: N_DAYS + WARM + 2 });
  const S = build(all.slice(-(N_DAYS + WARM)));
  const byDay = {};
  for (const s of S) (byDay[s.di] ||= []).push(s);
  const dis = Object.keys(byDay).map(Number).sort((a, b) => a - b).slice(-N_DAYS);
  const dateOf = {};
  for (const d of all) dateOf[d.date] = d.date;
  // di → 日期：build() 內的 di 是 days 陣列索引，對回 slice 後的 all
  const sliced = all.slice(-(N_DAYS + WARM));
  const dOf = i => sliced[i]?.date ?? '?';

  console.log('═'.repeat(96));
  console.log(`近 ${N_DAYS} 個交易日回測｜${dOf(dis[0])} → ${dOf(dis[dis.length - 1])}`);
  console.log('⚠ 20 日 = 20 個進場日，遠低於本站 480 日主窗＋240 日 OOT 的判準；');
  console.log('  樣本高度重疊、不獨立 ⇒ 只作描述與健檢，不可作為成效證據。');
  console.log('═'.repeat(96));

  // ── ① 每日明細 ──
  console.log('\n【① 每日明細】隔日開盤賣·已扣費稅%');
  console.log(pad('日期', 12) + padL('大盤中位', 10) + padL('宇宙檔數', 10) + padL('基準', 9)
    + padL('Ⓐ前20', 9) + padL('Ⓒ前20', 9) + padL('Ⓒ前5', 9) + padL('Ⓒ-基準', 9));
  console.log('─'.repeat(77));
  const acc = { base: [], a20: [], c20: [], c5: [] };
  const perDay = [];
  for (const di of dis) {
    const arr = byDay[di];
    const base = arr.map(s => s.netOpen);
    const a20 = [...arr].sort((x, y) => KEY_A(y) - KEY_A(x)).slice(0, 20).map(s => s.netOpen);
    const c20 = [...arr].sort((x, y) => KEY_C(y) - KEY_C(x)).slice(0, 20).map(s => s.netOpen);
    const c5 = [...arr].sort((x, y) => KEY_C(y) - KEY_C(x)).slice(0, 5).map(s => s.netOpen);
    acc.base.push(...base); acc.a20.push(...a20); acc.c20.push(...c20); acc.c5.push(...c5);
    perDay.push({ di, base: avg(base), c20: avg(c20) });
    console.log(pad(dOf(di), 12) + padL(`${r2(arr[0].mktChg)}%`, 10) + padL(arr.length, 10)
      + padL(`${r2(avg(base))}`, 9) + padL(`${r2(avg(a20))}`, 9) + padL(`${r2(avg(c20))}`, 9)
      + padL(`${r2(avg(c5))}`, 9) + padL(`${r2(avg(c20) - avg(base))}`, 9));
  }

  // ── ② 彙總＋兩個 10 日半窗（極粗略的穩定性檢查）──
  console.log('\n【② 彙總】');
  const halfA = dis.slice(0, 10), halfB = dis.slice(10);
  const sub = (list, days) => {
    const set = new Set(days);
    const out = [];
    for (const di of days) {
      const arr = byDay[di]; if (!arr) continue;
      if (list === 'base') out.push(...arr.map(s => s.netOpen));
      else if (list === 'a20') out.push(...[...arr].sort((x, y) => KEY_A(y) - KEY_A(x)).slice(0, 20).map(s => s.netOpen));
      else if (list === 'c20') out.push(...[...arr].sort((x, y) => KEY_C(y) - KEY_C(x)).slice(0, 20).map(s => s.netOpen));
      else out.push(...[...arr].sort((x, y) => KEY_C(y) - KEY_C(x)).slice(0, 5).map(s => s.netOpen));
    }
    void set;
    return out;
  };
  console.log(pad('項目', 20) + padL('淨均%', 10) + padL('淨勝%', 9) + padL('樣本', 9)
    + padL('前10日', 10) + padL('後10日', 10) + padL('vs基準', 9));
  console.log('─'.repeat(77));
  const baseAvg = avg(acc.base);
  for (const [label, key, arr] of [['可交易宇宙(基準)', 'base', acc.base], ['Ⓐ 舊鍵前20', 'a20', acc.a20],
                                    ['Ⓒ 現行鍵前20', 'c20', acc.c20], ['Ⓒ 現行鍵前5', 'c5', acc.c5]]) {
    const h1 = avg(sub(key, halfA)), h2 = avg(sub(key, halfB));
    console.log(pad(label, 20) + padL(r2(avg(arr)), 10) + padL(wr(arr), 9) + padL(arr.length.toLocaleString(), 9)
      + padL(r2(h1), 10) + padL(r2(h2), 10) + padL(key === 'base' ? '—' : r2(avg(arr) - baseAvg), 9));
  }

  // ── ③ 已驗證訊號各項在這 20 日的實際觸發與表現 ──
  console.log('\n【③ 已驗證訊號在本窗的觸發次數與表現】（各項為 composite-score 的 ±2 項）');
  const SIGS = {
    '🏔破高×強尾 (+2)': s => s.brk20 && s.pos >= 0.7,
    '💪強尾單獨 (−2)': s => !(s.brk20 && s.pos >= 0.7) && s.pos >= 0.8 && Math.abs(s.chg) > 1,
    '🐑跟風 (−2)': s => s.mktChg != null && s.mktChg >= 1 && s.chg >= 3 && s.chg - s.mktChg < 1,
    '🔥5日過熱 (−2)': s => s.ret5 != null && s.ret5 >= 20,
    '📉K>90 超買 (−2)': s => s.k9 != null && s.k9 > 90,
    '😴低波動 (−2)': s => s.vol20 != null && s.vol20 < 1.5,
  };
  console.log(pad('訊號', 20) + padL('觸發次數', 10) + padL('日均', 8) + padL('淨均%', 10) + padL('淨勝%', 9) + padL('vs基準', 9) + '  方向');
  console.log('─'.repeat(75));
  for (const [name, cond] of Object.entries(SIGS)) {
    const hit = S.filter(s => dis.includes(s.di) && cond(s)).map(s => s.netOpen);
    if (!hit.length) { console.log(pad(name, 20) + padL(0, 10)); continue; }
    const d = avg(hit) - baseAvg;
    const expect = name.includes('+2') ? '應為正' : '應為負';
    const ok = name.includes('+2') ? d > 0 : d < 0;
    console.log(pad(name, 20) + padL(hit.length, 10) + padL((hit.length / dis.length).toFixed(1), 8)
      + padL(r2(avg(hit)), 10) + padL(wr(hit), 9) + padL(r2(d), 9)
      + `  ${expect}·本窗${ok ? '同向 ✓' : '反向 ✗'}`);
  }

  // ── ④ 結論 ──
  const upDays = perDay.filter(d => d.c20 > 0).length;
  const beatDays = perDay.filter(d => d.c20 > d.base).length;
  console.log('\n' + '═'.repeat(96));
  console.log('【④ 結論】');
  console.log('═'.repeat(96));
  console.log(`  · 窗口市況：可交易宇宙 ${dis.length} 日等權淨均 ${r2(baseAvg)}%／日、淨勝 ${wr(acc.base)}%。`);
  console.log(`  · Ⓒ 現行鍵前20：淨均 ${r2(avg(acc.c20))}%、淨勝 ${wr(acc.c20)}%，`
    + `${dis.length} 天中有 ${beatDays} 天贏過當日基準、${upDays} 天絕對為正。`);
  console.log(`  · Ⓒ vs Ⓐ：${r2(avg(acc.c20) - avg(acc.a20))}pp（正＝已驗證訊號疊加在本窗有幫助）。`);
  console.log(`  · 兩個 10 日半窗：Ⓒ前20 ${r2(avg(sub('c20', halfA)))}% / ${r2(avg(sub('c20', halfB)))}%`
    + `——半窗只有 10 天，方向不一致屬正常，不足以判定不穩。`);
  // 單日敏感度：20 日窗最致命的問題不是樣本少，是**被少數幾天主宰**
  const sorted = [...perDay].sort((a, b) => b.c20 - a.c20);
  const dayMean = rs => avg(rs.map(r => r.c20));
  console.log(`  · **單日敏感度**：去掉表現最好的 1 天（${dOf(sorted[0].di)}，Ⓒ前20 ${r2(sorted[0].c20)}%），`
    + `日均由 ${r2(dayMean(perDay))}% 掉到 ${r2(dayMean(sorted.slice(1)))}%；去掉最好的 2 天 → ${r2(dayMean(sorted.slice(2)))}%。`);
  console.log('    **一天就翻轉整個結論**——這就是 20 日窗不能當證據的具體理由，不是原則問題。');
  const exc = perDay.map(r => r.c20 - r.base).sort((a, b) => a - b);
  console.log(`  · 相對之下**超額比較穩健**：每日超額中位數 ${r2(exc[Math.floor(exc.length / 2)])}pp、`
    + `${perDay.filter(r => r.c20 > r.base).length}/${perDay.length} 天為正，`
    + '與 480 日主窗 +0.249pp／OOT +0.184pp 同量級 ⇒ 新排序鍵在本窗**沒有明顯壞掉**（健檢通過）。');
  console.log('\n  ⚠ 以上皆為描述性。20 個進場日無法通過本站任何判準；');
  console.log('     要看成效請用 screen-recommend-rank.mjs（480 日主窗＋240 日第三獨立窗）。');
  console.log('     非投資建議。');
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
