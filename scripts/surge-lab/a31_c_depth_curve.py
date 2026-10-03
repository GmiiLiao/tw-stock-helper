"""a31 C 補充：條件數加到 6 條時，DESIGN 精準度與 VALID／TEST 精準度怎麼走（過度擬合曲線）。

用法：python3 a31_c_depth_curve.py [b|a|c]   （預設 b＝延續段）
每個深度取 DESIGN 精準度前 20 名規則：DESIGN 平均、VALID／TEST（n 加權）、TEST ≥30 筆者的最高值。
"""
import sys
import numpy as np, pandas as pd
import a31_c_rules_search as R


def main():
    run = sys.argv[1] if len(sys.argv) > 1 else 'b'
    R.DEPTH = 6
    M, names0, cols, sp = R.load(run)
    names, cuts, Xb = R.make_bins(names0, cols, sp == 0); del cols
    ncut = np.array([len(c) for c in cuts]); y = M['y']; s = M['s']
    drows = np.nonzero(sp == 0)[0]
    rows = []
    for crit, minsup, kind, spread in (('prec', 30, 'prec', False), ('prec', 50, 'prec', False), ('wlb_sp', 50, 'wlb', True)):
        pool = R.beam_search(Xb, y.astype(float), s, drows, ncut, kind, minsup, print,
                             min_days=R.SPREAD_DAYS if spread else R.MIN_DAYS, max_share=R.SPREAD_SHARE if spread else 1.0,
                             label=f'{crit}/min{minsup}')
        for depth in range(1, R.DEPTH + 1):
            top = sorted((v for v in pool.values() if v['depth'] == depth), key=lambda v: -v['d_pos'] / v['d_n'])[:20]
            agg = dict(crit=crit, minsup=minsup, depth=depth, rules=len(top))
            dn = dp = vn = vp = tn = tp = 0; best_t = np.nan
            for v in top:
                m = R.rule_mask(v['rule'], Xb)
                dn += v['d_n']; dp += v['d_pos']
                mv, mt = m & (sp == 1), m & (sp == 2)
                vn += mv.sum(); vp += y[mv].sum(); tn += mt.sum(); tp += y[mt].sum()
                if mt.sum() >= 30: best_t = np.nanmax([best_t, y[mt].mean()])
            agg.update(d_prec=dp / max(dn, 1), v_prec=vp / max(vn, 1), t_prec=tp / max(tn, 1), avg_t_n=tn / max(len(top), 1),
                       best_t_ge30=best_t)
            rows.append(agg)
    df = pd.DataFrame(rows)
    df.to_csv(f'{R.OUT}/a31_c_depth_curve_{run}.csv', index=False)
    pd.set_option('display.width', 200)
    print(df.round(3).to_string(index=False))


if __name__ == '__main__':
    main()
