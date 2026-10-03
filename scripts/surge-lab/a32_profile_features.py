"""a32_profile 步驟 1：每個特徵在 A（2023-2025）與 B（2026）兩個時代的「隔日漲停前一日」輪廓。

每個特徵 × 分組（all／fresh／cont）× 時代：
  · 中位數：正例（s+1 漲停）與負例；有值比例
  · 同日 AUC：在同一個 s 日內比較正例與負例的名次（等同「同日百分位」基準，消除整天冷熱的影響），
    跨日合計＝ΣU_d／Σ(n1_d·n0_d)；缺值列不計
  · 提升倍數：lift_hi＝P(同日分組內前 20%｜正例)／P(前 20%｜負例)；lift_lo 同理用後 20%
  · 大盤類（f_mkt_*，同一天全市場同值）沒有同日名次 → 改報「日層級」AUC（哪些日子較常出漲停），另行標示
  · 不確定度：5 日區塊 bootstrap（A、B 各自重抽），ΔAUC＝B−A 的 95% 區間
另報逐年 AUC（2023／2024／2025／2025H2／2026）供判斷差異是 2026 才出現還是逐年趨勢。
輸出：out/a32_profile_features.csv、out/a32_profile_features.log（變化最大 20、最穩定 20）
"""
import time
import numpy as np
import pandas as pd
import a32_profile_common as P

GROUPS = ('all', 'fresh', 'cont')
PERIODS = (('2023', '2023-01-01', '2023-12-31'), ('2024', '2024-01-01', '2024-12-31'), ('2025', '2025-01-01', '2025-12-31'),
           ('2025H2', '2025-07-01', '2025-12-31'), ('2026', '2026-01-01', '2026-12-31'))


def per_day_stock_feature(x, d, y, nD):
    """同日名次 → 逐日 U、配對數、前後 20% 計數。"""
    f = np.isfinite(x)
    xs, ds, ys = x[f], d[f], y[f].astype(np.float64)
    out = {}
    if len(xs) == 0:
        z = np.zeros(nD); return dict(U=z, Pp=z, n1=z, n0=z, p_hi=z, n_hi=z, p_lo=z, n_lo=z)
    r = pd.Series(xs).groupby(ds).rank(method='average').values
    n = np.bincount(ds, minlength=nD).astype(np.float64)
    n1 = np.bincount(ds, weights=ys, minlength=nD); n0 = n - n1
    R1 = np.bincount(ds, weights=r * ys, minlength=nD)
    out['U'] = R1 - n1 * (n1 + 1) / 2; out['Pp'] = n1 * n0
    q = (r - 0.5) / n[ds]
    hi = (q >= 0.8).astype(np.float64); lo = (q < 0.2).astype(np.float64)
    out['n1'], out['n0'] = n1, n0
    out['p_hi'] = np.bincount(ds, weights=hi * ys, minlength=nD); out['n_hi'] = np.bincount(ds, weights=hi * (1 - ys), minlength=nD)
    out['p_lo'] = np.bincount(ds, weights=lo * ys, minlength=nD); out['n_lo'] = np.bincount(ds, weights=lo * (1 - ys), minlength=nD)
    return out


def day_level_auc(v, n1, n0, W):
    """日層級 AUC（v＝每日值；W＝權重矩陣 B×nD，可為單列）。同值算一半。"""
    ok = np.isfinite(v)
    o = np.nonzero(ok)[0][np.argsort(v[ok], kind='stable')]
    vs = v[o]; starts = np.r_[0, np.nonzero(np.diff(vs))[0] + 1]
    M1 = W[:, o] * n1[o]; M0 = W[:, o] * n0[o]
    G1 = np.add.reduceat(M1, starts, axis=1); G0 = np.add.reduceat(M0, starts, axis=1)
    below = np.cumsum(G0, 1) - G0
    num = (G1 * (below + 0.5 * G0)).sum(1); den = G1.sum(1) * G0.sum(1)
    with np.errstate(invalid='ignore', divide='ignore'): return num / den


def main():
    t0 = time.time()
    D = P.load(); X, names = D['X'], D['names']
    rd, day_dates = P.day_index(D); nD = len(day_dates)
    eB = day_dates >= P.ERA_B_START; eA = ~eB
    WA = P.block_weights(day_dates, eA, seed=11); WB = P.block_weights(day_dates, eB, seed=12)
    pmask = {nm: (day_dates >= lo) & (day_dates <= hi) for nm, lo, hi in PERIODS}
    y = D['y']; era = D['era']
    gmask = dict(all=np.ones(len(y), bool), fresh=D['fresh'], cont=~D['fresh'])
    rows = []
    for g in GROUPS:
        gm = gmask[g]
        gi = np.nonzero(gm)[0]
        dg, yg = rd[gi], y[gi]
        # 日層級計數（大盤類用）
        n1d = np.bincount(dg, weights=yg.astype(float), minlength=nD); n0d = np.bincount(dg, minlength=nD) - n1d
        for k, nm in enumerate(names):
            x = X[gi, k]
            rec = dict(group=g, feature=nm, kind='day-level' if P.is_day_constant(nm) else 'same-day')
            for e, em in ((0, 'A'), (1, 'B')):
                me = era[gi] == e
                for lab, lm in (('pos', yg == 1), ('neg', yg == 0)):
                    xx = x[me & lm]; fin = np.isfinite(xx)
                    rec[f'med_{lab}_{em}'] = float(np.median(xx[fin])) if fin.any() else np.nan
                    rec[f'fin_{lab}_{em}'] = float(fin.mean()) if len(xx) else np.nan
            if P.is_day_constant(nm):
                v = np.full(nD, np.nan); v[dg] = x                     # 同日同值
                for em, base, W in (('A', eA, WA), ('B', eB, WB)):
                    w0 = base.astype(np.float32)[None, :]
                    rec[f'auc_{em}'] = float(day_level_auc(v, n1d, n0d, w0)[0])
                    bs = day_level_auc(v, n1d, n0d, W); rec[f'_bs_{em}'] = bs
                    rec[f'auc_{em}_lo'], rec[f'auc_{em}_hi'] = np.nanpercentile(bs, [2.5, 97.5])
                    q80, q20 = np.nanquantile(v[base], [0.8, 0.2])
                    hi = (v >= q80) & base; lo = (v <= q20) & base
                    rec[f'lift_hi_{em}'] = (n1d[hi].sum() / n1d[base].sum()) / max(n0d[hi].sum() / n0d[base].sum(), 1e-12)
                    rec[f'lift_lo_{em}'] = (n1d[lo].sum() / n1d[base].sum()) / max(n0d[lo].sum() / n0d[base].sum(), 1e-12)
                for pn, pm in pmask.items():
                    rec[f'auc_{pn}'] = float(day_level_auc(v, n1d, n0d, pm.astype(np.float32)[None, :])[0])
            else:
                S = per_day_stock_feature(x, dg, yg, nD)
                for em, base, W in (('A', eA, WA), ('B', eB, WB)):
                    rec[f'auc_{em}'] = S['U'][base].sum() / max(S['Pp'][base].sum(), 1e-12)
                    with np.errstate(invalid='ignore', divide='ignore'):
                        bs = (W @ S['U']) / (W @ S['Pp'])
                    rec[f'_bs_{em}'] = bs
                    rec[f'auc_{em}_lo'], rec[f'auc_{em}_hi'] = np.nanpercentile(bs, [2.5, 97.5])
                    for t in ('hi', 'lo'):
                        pp = S[f'p_{t}'][base].sum() / max(S['n1'][base].sum(), 1e-12)
                        nn = S[f'n_{t}'][base].sum() / max(S['n0'][base].sum(), 1e-12)
                        rec[f'lift_{t}_{em}'] = pp / nn if nn > 0 else np.nan
                for pn, pm in pmask.items():
                    rec[f'auc_{pn}'] = S['U'][pm].sum() / max(S['Pp'][pm].sum(), 1e-12)
            d_bs = rec.pop('_bs_B') - rec.pop('_bs_A')
            rec['dAUC'] = rec['auc_B'] - rec['auc_A']
            rec['dAUC_lo'], rec['dAUC_hi'] = np.nanpercentile(d_bs, [2.5, 97.5])
            rows.append(rec)
        print(f'[{g}] done {time.time() - t0:.0f}s', flush=True)
    df = pd.DataFrame(rows)
    a, b = df['auc_A'] - 0.5, df['auc_B'] - 0.5
    df['flip'] = (a * b < 0) & (a.abs() >= 0.02) & (b.abs() >= 0.02)
    df['sig'] = (df['dAUC_lo'] > 0) | (df['dAUC_hi'] < 0)
    df.to_csv(f'{P.OUT}/a32_profile_features.csv', index=False, float_format='%.5g')
    report(df)


def line(r):
    return (f"  {r.feature:<22} {r.kind[:3]} AUC A {r.auc_A:.3f} [{r.auc_A_lo:.3f},{r.auc_A_hi:.3f}] → B {r.auc_B:.3f} [{r.auc_B_lo:.3f},{r.auc_B_hi:.3f}]"
            f"  Δ {r.dAUC:+.3f} [{r.dAUC_lo:+.3f},{r.dAUC_hi:+.3f}]{' *' if r.sig else '  '}{' FLIP' if r.flip else ''}"
            f" | 逐年 23 {r.auc_2023:.3f} 24 {r.auc_2024:.3f} 25 {r.auc_2025:.3f} 25H2 {r.auc_2025H2:.3f} 26 {r.auc_2026:.3f}"
            f" | lift_hi {r.lift_hi_A:.2f}→{r.lift_hi_B:.2f} lift_lo {r.lift_lo_A:.2f}→{r.lift_lo_B:.2f}"
            f" | 中位數 正 {r.med_pos_A:.4g}→{r.med_pos_B:.4g} 負 {r.med_neg_A:.4g}→{r.med_neg_B:.4g}")


def report(df):
    out = []
    for g in GROUPS:
        d = df[df.group == g].copy()
        d['absd'] = d['dAUC'].abs()
        out.append(f'\n==== 分組 {g}：特徵 {len(d)} 個；ΔAUC 顯著（區間不含 0）{int(d.sig.sum())} 個；方向翻轉 {int(d.flip.sum())} 個 ====')
        out.append('-- 變化最大 20（|ΔAUC|）--')
        for r in d.sort_values('absd', ascending=False).head(20).itertuples(): out.append(line(r))
        st = d[((d.auc_A - 0.5).abs() >= 0.05) & ((d.auc_B - 0.5).abs() >= 0.05) & ((d.auc_A - 0.5) * (d.auc_B - 0.5) > 0)]
        out.append(f'-- 最穩定 20（兩時代 |AUC−0.5|≥0.05 且同向者 {len(st)} 個中 |ΔAUC| 最小）--')
        for r in st.sort_values('absd').head(20).itertuples(): out.append(line(r))
        out.append('-- 兩時代各自最強 10（|AUC−0.5|）--')
        for em in ('A', 'B'):
            top = d.reindex((d[f'auc_{em}'] - 0.5).abs().sort_values(ascending=False).index).head(10)
            out.append(f'  {em}: ' + '、'.join(f'{r.feature}({getattr(r, "auc_" + em):.3f})' for r in top.itertuples()))
    txt = '\n'.join(out)
    print(txt)
    open(f'{P.OUT}/a32_profile_features.log', 'w').write(txt + '\n')


if __name__ == '__main__':
    main()
