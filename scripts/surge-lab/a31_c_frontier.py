"""a31 C 補充：把跑法 a（新起漲）與 b（延續）的規則集成分數合併成全市場單一排名，畫 TEST 精準度—涵蓋前沿。

分數＝每列命中規則中「VALID 縮減精準度」最高者（規則只在 DESIGN 上挑、VALID 估精準度、TEST 完全沒參與）；
沒命中任何規則的列給 −1（排最後）。同分以隨機鍵打散。另列跑法 c（目標＝開盤買得到的漲停）的同一前沿。
需先跑 a31_c_rules_search.py a b c。輸出 out/a31_c_frontier.csv。
"""
import numpy as np, pandas as pd
import a31_c_rules_search as R

Z = np.load(R.DS)
N_ALL = len(Z['m_s'])


def load_ens(run, key='ens_v'):
    e = np.load(f'{R.SP}/a31_c_{run}_ens.npz')
    return e['idx'], e[key]


def curve(score, s, y, buy, label, rng):
    sc = score + rng.random(len(score)) * 1e-7
    order = np.lexsort((-sc, s)); ss = s[order]
    start = np.r_[0, np.nonzero(np.diff(ss))[0] + 1]
    rank = np.empty(len(sc), np.int64); rank[order] = np.arange(len(ss)) - np.repeat(start, np.diff(np.r_[start, len(ss)]))
    rows = []
    for K in (1, 3, 10):
        m = rank < K
        rows.append(dict(set=label, cut=f'每日前 {K}', n=int(m.sum()), days=len(np.unique(s[m])), prec=y[m].mean(),
                         wlb=float(R.wilson_lb(y[m].sum(), m.sum())), buy=buy[m].mean()))
    g = np.argsort(-sc)
    for N in (30, 100, 300, 1000):
        m = np.zeros(len(sc), bool); m[g[:N]] = True
        rows.append(dict(set=label, cut=f'全期前 {N}', n=N, days=len(np.unique(s[m])), prec=y[m].mean(),
                         wlb=float(R.wilson_lb(y[m].sum(), N)), buy=buy[m].mean()))
    return rows


def main():
    ds = Z['dates'][Z['m_s']]; test = ds > R.VALID_END
    y = Z['m_y'].astype(int); buy = Z['m_buy_lu'].astype(int); s = Z['m_s']
    rng = np.random.default_rng(0)
    out = []
    for key in ('ens_v', 'ens'):
        sc = np.full(N_ALL, -1.0)
        for run in ('a', 'b'):
            idx, e = load_ens(run, key); sc[idx] = e
        out += curve(sc[test], s[test], y[test], buy[test], f'a+b 目標 m_y（{key}）', rng)
        idx, e = load_ens('c', key); sc = np.full(N_ALL, -1.0); sc[idx] = e
        out += curve(sc[test], s[test], buy[test], buy[test], f'c 目標 m_buy_lu（{key}）', rng)
    df = pd.DataFrame(out)
    df.to_csv(f'{R.OUT}/a31_c_frontier.csv', index=False)
    pd.set_option('display.width', 200)
    print(f'TEST 基準率：m_y {y[test].mean():.4f}、m_buy_lu {buy[test].mean():.4f}；TEST 日數 {len(np.unique(s[test]))}')
    print(df.round(3).to_string(index=False))


if __name__ == '__main__':
    main()
