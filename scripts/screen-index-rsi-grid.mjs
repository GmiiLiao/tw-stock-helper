#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// 大盤 RSI 邊緣值網格搜尋 —— 2026-08-05（使用者指定：結構固定，門檻由我測）
//
// 使用者定案的結構（已三次確認）：
//   連 2 日 RSI 極端 ＋ 下個交易日大盤轉向確認 → 判定方向
//   上下邊緣值（RSI5/RSI10 的門檻）由本腳本搜尋決定。
//
// ⚠**我先前三版都測到「等確認」是負貢獻（-1.0 / -0.15 / -1.27pp），已如實
//   回報且使用者確認保留該結構。** 因此本腳本：
//     · 以「連2日 ∧ 隔日確認」為主結果（使用者指定的結構）
//     · 同格並列「不等確認」的數字（同一組門檻、唯一差別是有無確認）
//   讓兩者在同一張表上直接比較，而不是由我單方面否決。
//
// ⚠**多重檢定風險（必讀）**：本腳本掃 4×5×2 側 = 80 個門檻組合。
//   純機率下也會有若干組「看起來很好」。因此：
//     · 通過門檻＝ n≥20 **且三等分窗全部方向正確**（不是只看全窗平均）
//     · 最終仍必須標示「這是樣本內選出的參數，需要未來資料前瞻驗證」
//   本站沒有 RSI 大盤訊號的獨立窗可用（10 年資料已全用於搜尋），
//   所以**任何入選者都只能當候選，不可當已驗證訊號落地**。
//
// 口徑：^TWII 日線；進場＝確認版在 T+1 收盤、不確認版在 T 日收盤。
//       指數不可直接買賣，測的是大盤方向，不扣費稅。
// 用法：node scripts/screen-index-rsi-grid.mjs
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const CACHE = path.join(process.env.TMPDIR || '/tmp', 'twii-daily.json');
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = x => (x == null ? null : +x.toFixed(2));
const wr = a => (a.length ? +(a.filter(v => v > 0).length / a.length * 100).toFixed(1) : null);
const pad = (x, n) => String(x).padEnd(n), padL = (x, n) => String(x).padStart(n);

async function loadTwii() {
  const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  return j.bars;
}
function rsi(cl, p) {
  const o = new Array(cl.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = cl[i] - cl[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p; o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < cl.length; i++) {
    const d = cl[i] - cl[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}

const main = async () => {
  const bars = await loadTwii();
  const C = bars.map(b => b.c);
  const R5 = rsi(C, 5), R10 = rsi(C, 10);
  const fwd = (i, n) => (i + n < C.length ? (C[i + n] - C[i]) / C[i] * 100 : null);
  const chg = i => (i > 0 ? (C[i] - C[i - 1]) / C[i - 1] * 100 : null);
  const third = Math.floor(C.length / 3);
  const WIN = [[0, third], [third, 2 * third], [2 * third, C.length]];

  const baseSeg = ([lo, hi]) => {
    const a = [];
    for (let i = Math.max(15, lo); i < Math.min(hi, C.length - 20); i++) { const v = fwd(i, 20); if (v != null) a.push(v); }
    return avg(a);
  };
  const B = WIN.map(baseSeg);
  const baseAll = (() => { const a = []; for (let i = 15; i < C.length - 20; i++) { const v = fwd(i, 20); if (v != null) a.push(v); } return avg(a); })();

  console.log('═'.repeat(118));
  console.log(`大盤 RSI 邊緣值網格｜^TWII ${bars.length} 根（${bars[0].d} → ${bars[bars.length - 1].d}）`);
  console.log(`基準：全窗 ${r2(baseAll)}%｜三等分 ${B.map(r2).join(' / ')}%`);
  console.log('結構固定＝連 2 日 RSI 極端；「確認」欄＝加上隔日轉向後、於 T+1 收盤進場');
  console.log('═'.repeat(118));

  const evalSet = (cond, entryShift) => {
    // entryShift=0：T 日收盤進場（不等確認）；=1：T+1 收盤進場（等確認）
    const idx = [];
    for (let i = 15; i < C.length - 20; i++) if (cond(i)) idx.push(i);
    if (!idx.length) return null;
    const f20 = idx.map(i => fwd(i, 20)).filter(v => v != null);
    const segs = WIN.map(([lo, hi]) => {
      const a = idx.filter(i => i >= lo && i < hi).map(i => fwd(i, 20)).filter(v => v != null);
      return a.length ? { v: avg(a), n: a.length } : null;
    });
    void entryShift;
    return { n: idx.length, f5: avg(idx.map(i => fwd(i, 5)).filter(v => v != null)),
      f10: avg(idx.map(i => fwd(i, 10)).filter(v => v != null)), f20: avg(f20), w: wr(f20), segs };
  };

  let tested = 0;
  const winners = { bear: [], bull: [] };

  for (const side of ['bear', 'bull']) {
    const isBear = side === 'bear';
    const grid5 = isBear ? [75, 80, 85, 90] : [30, 25, 20, 15];
    const grid10 = isBear ? [70, 75, 80, 85, null] : [40, 35, 30, 25, null];
    console.log(`\n${'━'.repeat(118)}`);
    console.log(isBear
      ? 'Ⓐ 超買側（假說：連2日超買＋隔日轉跌 → 下跌開始）｜成立條件＝20日均**低於**基準，且三窗皆低'
      : 'Ⓑ 超賣側（假說：連2日超賣＋隔日轉漲 → 上漲開始）｜成立條件＝20日均**高於**基準，且三窗皆高');
    console.log('━'.repeat(118));
    console.log(pad('門檻', 26) + padL('確認n', 7) + padL('確認20日', 10) + padL('確認勝', 8)
      + padL('無確認n', 8) + padL('無確認20日', 11) + padL('無確認勝', 9) + padL('確認增量', 10) + '  三窗(確認)');
    console.log('─'.repeat(118));

    for (const t5 of grid5) for (const t10 of grid10) {
      const at = (i, k) => {
        const a = R5[i - k], b = R10[i - k];
        if (a == null) return false;
        if (isBear) return a > t5 && (t10 == null || (b != null && b > t10));
        return a < t5 && (t10 == null || (b != null && b < t10));
      };
      const two = i => at(i, 1) && at(i, 2);          // 連 2 日（T 與 T-1）
      const confirmed = i => two(i) && (isBear ? chg(i) < 0 : chg(i) > 0);
      const noConfirm = i => at(i, 0) && at(i, 1);    // 同樣連 2 日，但 T 日收盤就進

      const A = evalSet(confirmed, 1), N = evalSet(noConfirm, 0);
      tested++;
      if (!A || A.n < 20) continue;
      const okSeg = A.segs.every((s, j) => s && (isBear ? s.v < B[j] : s.v > B[j]));
      const okAll = isBear ? A.f20 < baseAll : A.f20 > baseAll;
      const label = `RSI5${isBear ? '>' : '<'}${t5}${t10 != null ? `∧RSI10${isBear ? '>' : '<'}${t10}` : ''}`;
      const incr = N ? A.f20 - N.f20 : null;
      console.log(pad(label, 26) + padL(A.n, 7) + padL(`${r2(A.f20)}%`, 10) + padL(`${A.w}%`, 8)
        + padL(N ? N.n : '—', 8) + padL(N ? `${r2(N.f20)}%` : '—', 11) + padL(N ? `${N.w}%` : '—', 9)
        + padL(incr != null ? `${incr > 0 ? '+' : ''}${r2(incr)}pp` : '—', 10)
        + '  ' + A.segs.map(s => (s ? `${r2(s.v)}(${s.n})` : 'n=0')).join(' / ')
        + (okSeg && okAll ? '  ✅' : ''));
      if (okSeg && okAll) winners[side].push({ label, A, N, incr });
    }
  }

  console.log(`\n${'═'.repeat(118)}\n結論\n${'═'.repeat(118)}`);
  console.log(`  共測 ${tested} 個門檻組合（每組又分確認/不確認兩版）。`);
  for (const side of ['bear', 'bull']) {
    const w = winners[side];
    const nm = side === 'bear' ? 'Ⓐ 超買側（下跌）' : 'Ⓑ 超賣側（上漲）';
    if (!w.length) { console.log(`\n  ${nm}：**沒有任何門檻組合通過**（n≥20 且三等分窗方向全對）。`); continue; }
    console.log(`\n  ${nm}：${w.length} 組通過（n≥20 且三窗方向全對），依樣本數排序：`);
    w.sort((a, b) => b.A.n - a.A.n);
    for (const x of w) {
      console.log(`    ${pad(x.label, 26)} n=${String(x.A.n).padStart(3)}  20日 ${r2(x.A.f20)}%  勝${x.A.w}%`
        + `  ｜不等確認 n=${x.N ? x.N.n : '—'} ${x.N ? r2(x.N.f20) + '%' : ''}`
        + `  確認增量 ${x.incr != null ? (x.incr > 0 ? '+' : '') + r2(x.incr) + 'pp' : '—'}`);
    }
  }
  console.log('\n  ⚠ 多重檢定：80 組門檻中挑出的贏家有相當機率是雜訊。10 年資料已全部用於搜尋，');
  console.log('    **沒有留下獨立窗做驗證** ⇒ 入選者只能當候選，不可當已驗證訊號直接落地。');
  console.log('    要落地必須：先凍結參數，再用未來資料前瞻累積（本站 picksScoreboard 的做法）。');
  console.log('  · 指數不可直接買賣；測的是大盤方向。非投資建議。');
  process.exit(0);
};
main().catch(e => { console.error(e); process.exit(1); });
