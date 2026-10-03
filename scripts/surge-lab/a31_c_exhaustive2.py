"""a31 C 補充：窮舉「所有 2 條件組合」（不是 beam），驗證 beam search 沒漏掉高精準規則。

對跑法 b（延續，m_lu_s=1）做完整窮舉；跑法 a（新起漲）只窮舉第一條件為尾端（DESIGN 涵蓋 ≤3%）者，否則太慢。
每個組合在 DESIGN 上算 n／正例；n ≥ 50 中取 DESIGN 精準度前 300 名 → 算 VALID／TEST。
切點與 a31_c_rules_search.py 相同（DESIGN 分位數）。輸出 out/a31_c_exhaustive2_<run>.csv 與 log。
用法：python3 a31_c_exhaustive2.py b   （或 a）
"""
import sys, time
import numpy as np, pandas as pd
import a31_c_rules_search as R

TOPN = 300
MINSUP = 50


def first_conditions(Xb, ncut, rows, frac_max):
    """所有單一條件（≥切點／<切點／缺值），回傳 (j, lo, hi)；只留 DESIGN 涵蓋 ≥MINSUP 且 ≤frac_max 者。"""
    out = []; n = len(rows)
    for j in range(Xb.shape[1]):
        col = Xb[rows, j]; cnt = np.bincount(col, minlength=R.NB); C = np.cumsum(cnt[:R.NANB]); nc = ncut[j]
        for k in range(nc):
            for lo, hi, m in ((0, k, C[k]), (k + 1, nc, C[nc] - C[k])):
                if MINSUP <= m <= frac_max * n: out.append((j, lo, hi))
        if MINSUP <= cnt[R.NANB] <= frac_max * n: out.append((j, R.NANB, R.NANB))
    return out


def main():
    run = sys.argv[1] if len(sys.argv) > 1 else 'b'
    frac_max = 1.0 if run == 'b' else 0.03
    t0 = time.time()
    M, names0, cols, sp = R.load(run)
    names, cuts, Xb = R.make_bins(names0, cols, sp == 0); del cols
    ncut = np.array([len(c) for c in cuts]); y = M['y']; yf = y.astype(float); s = M['s']
    drows = np.nonzero(sp == 0)[0]
    F1 = first_conditions(Xb, ncut, drows, frac_max)
    print(f'跑法 {run}：第一條件 {len(F1):,} 個（{time.time() - t0:.0f}s）', flush=True)
    best = []                                                    # (prec, n, pos, rule)
    thr = 0.0
    for i, (j, lo, hi) in enumerate(F1):
        col = Xb[drows, j]; sub = drows[(col >= lo) & (col <= hi)]
        cnt, pos = R.refine_counts(Xb, sub, yf, ncut)
        rule = {j: (lo, hi)}
        for sc, n, ps, j2, lo2, hi2 in R.candidate_refinements(rule, cnt, pos, ncut, len(sub), 'prec', MINSUP, 400):
            if sc < thr: break
            r2 = dict(rule); r2[j2] = (lo2, hi2)
            best.append((sc, n, ps, r2))
        if len(best) > 20 * TOPN:
            best.sort(key=lambda t: -t[0]); best = best[:5 * TOPN]; thr = best[-1][0]
        if i % 1000 == 0: print(f'  {i:,}/{len(F1):,}  目前門檻 {thr:.3f}（{time.time() - t0:.0f}s）', flush=True)
    best.sort(key=lambda t: -t[0])
    seen, recs = set(), []
    for sc, n, ps, r in best:
        k = R.key_of(r)
        if k in seen: continue
        seen.add(k)
        m = R.rule_mask(r, Xb)
        rec = dict(d_n=int(n), d_pos=int(ps), d_prec=ps / n, text=R.rule_text(r, names, cuts))
        for t, nm in ((0, 'd'), (1, 'v'), (2, 't')):
            mm = m & (sp == t)
            rec[f'{nm}_n'] = int(mm.sum()); rec[f'{nm}_prec'] = y[mm].mean() if mm.any() else np.nan
            rec[f'{nm}_days'] = len(np.unique(s[mm]))
        rec['t_buyprec'] = M['buy'][m & (sp == 2)].mean() if (m & (sp == 2)).any() else np.nan
        recs.append(rec)
        if len(recs) >= TOPN: break
    df = pd.DataFrame(recs)
    df.to_csv(f'{R.OUT}/a31_c_exhaustive2_{run}.csv', index=False)
    pd.set_option('display.width', 250)
    cols = ['d_n', 'd_prec', 'd_days', 'v_n', 'v_prec', 't_n', 't_prec', 't_days', 't_buyprec', 'text']
    print('\nDESIGN 精準度前 25 名（窮舉 2 條件、n≥50）'); print(df[cols].head(25).round(3).to_string(index=False, max_colwidth=120))
    print('\n前 300 名彙總：DESIGN 平均 %.3f、VALID n 加權 %.3f、TEST n 加權 %.3f' % (
        df.d_prec.mean(), (df.v_prec * df.v_n).sum() / df.v_n.sum(), (df.t_prec * df.t_n).sum() / df.t_n.sum()))
    ok = df[df.t_n >= 30]
    print('TEST ≥30 筆者中 TEST 最高（事後挑選上限）：%.3f（n=%d）' % (ok.t_prec.max(), ok.loc[ok.t_prec.idxmax(), 't_n']) if len(ok) else '無')
    dv = df[df.v_n >= 20].assign(m=lambda q: np.minimum(q.d_prec, q.v_prec)).sort_values('m', ascending=False)
    print('\nDESIGN+VALID 確認（VALID≥20，min(D,V)）前 10 名'); print(dv[cols].head(10).round(3).to_string(index=False, max_colwidth=120))


if __name__ == '__main__':
    main()
