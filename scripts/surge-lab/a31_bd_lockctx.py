"""A31-D 補充（全歷史、無需五檔）：「鎖死型」漲停訊號（一字鎖、連板數）在共同切分 DESIGN/VALID/TEST 上的隔日漲停
精準度與可買精準度——五檔排隊量本質上是鎖死強度的量測，這裡看鎖死強度的天花板。輸出 out/a31_bd_lockctx.txt。"""
import numpy as np, pandas as pd
from a31_bd_lib import load_all, split_of, wilson_lb

pd.set_option('display.width', 220)


def main():
    df, _, _ = load_all(feat=False)
    df['split'] = split_of(df.date.values)
    L = df[df.m_lu_s == 1].copy()
    out = open('out/a31_bd_lockctx.txt', 'w')
    def P(*a):
        print(*a); print(*a, file=out)
    rules = {
        'LU_s (all)': np.ones(len(L), bool),
        'LU & !oneword': L.x_oneword_s.values == 0,
        'LU & oneword': L.x_oneword_s.values == 1,
        'LU & streak>=2': L.x_lu_streak.values >= 2,
        'LU & streak>=3': L.x_lu_streak.values >= 3,
        'LU & streak>=5': L.x_lu_streak.values >= 5,
        'LU & oneword & streak>=2': (L.x_oneword_s.values == 1) & (L.x_lu_streak.values >= 2),
        'LU & oneword & streak>=3': (L.x_oneword_s.values == 1) & (L.x_lu_streak.values >= 3),
        'LU & oneword & streak>=5': (L.x_oneword_s.values == 1) & (L.x_lu_streak.values >= 5),
        'LU & oneword & streak>=3 & otc': (L.x_oneword_s.values == 1) & (L.x_lu_streak.values >= 3) & (L.m_otc.values == 1),
    }
    rows = []
    for nm, m in rules.items():
        r = dict(rule=nm)
        for sp in ('design', 'valid', 'test'):
            mm = m & (L.split.values == sp); n = int(mm.sum()); k = int(L.m_y.values[mm].sum())
            r[f'{sp}_n'] = n; r[f'{sp}_prec'] = k / n if n else np.nan
            if sp == 'test':
                r['test_lb'] = wilson_lb(k, n); r['test_buy'] = L.m_buy_lu.values[mm].mean() if n else np.nan
                r['test_locked'] = L.m_locked1.values[mm].mean() if n else np.nan
                r['test_days'] = L.date.values[mm].size and pd.Series(L.date.values[mm]).nunique()
        rows.append(r)
    P(pd.DataFrame(rows).round(3).to_string(index=False))
    out.close()


if __name__ == '__main__':
    main()
