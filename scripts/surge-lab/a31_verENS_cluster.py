"""a31 verENS step 3: effective sample size of the ENS_cont TEST top-30 picks and simple-rule comparison.

1. Group the 30 picks into stock "episodes" (same code, picks within 5 trading days) and bootstrap precision by
   resampling episodes (cluster bootstrap), since consecutive days of one limit-up streak are not independent.
2. Compare with transparent rules on the continuation group that need no model (one-word lock + streak), with
   thresholds fixed a priori (not tuned on TEST), to show what the ensemble's extreme tail actually selects.
Input: out/a31_verENS_top30_picks.csv (from a31_verENS_repro.py) and the dataset. Output: out/a31_verENS_cluster.json
"""
import json
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache'); OUT = os.path.join(HERE, 'out')


def main():
    z = np.load(f'{SP}/dataset_lu1.npz')
    dates = np.array(z['dates']).astype(str); di = {d: i for i, d in enumerate(dates)}
    pk = pd.read_csv(f'{OUT}/a31_verENS_top30_picks.csv', dtype={'code': str})
    pk['t'] = pk.date.map(di); pk = pk.sort_values(['code', 't'])
    ep = (pk.groupby('code').t.diff().fillna(99) > 5).cumsum()
    pk['episode'] = ep.values
    g = pk.groupby('episode').agg(code=('code', 'first'), n=('y', 'size'), hits=('y', 'sum'), first=('date', 'min'))
    rng = np.random.default_rng(0)
    E = g[['n', 'hits']].values; boots = []
    for _ in range(20000):
        s = E[rng.integers(0, len(E), len(E))]
        boots.append(s[:, 1].sum() / s[:, 0].sum())
    boots = np.array(boots)
    rep = dict(episodes=int(len(g)), episode_table=g.reset_index().to_dict('records'),
               picks_per_episode=float(len(pk) / len(g)),
               episode_bootstrap_ci95=[float(np.quantile(boots, 0.025)), float(np.quantile(boots, 0.975))],
               episode_level_all_hit_share=float((g.hits == g.n).mean()),
               distinct_calendar_days=int(pk.date.nunique()))
    # transparent rules on TEST continuation rows (a-priori thresholds)
    sd = dates[z['m_s']]; test = sd >= '2026-01-01'; valid = (sd >= '2025-07-01') & (sd <= '2025-12-31'); des = sd <= '2025-06-30'
    lu = z['m_lu_s'] == 1; ow = z['x_oneword_s'] == 1; st = z['x_lu_streak']; y = z['m_y']; b = z['m_buy_lu']; lk = z['m_locked1']
    rules = {}
    for k in (1, 2, 3, 4, 5):
        m = lu & ow & (st >= k)
        rules[f'oneword & streak>={k}'] = {nm: dict(n=int((m & sp).sum()), prec=float(y[m & sp].mean()), buy=float(b[m & sp].mean()),
                                                     locked=float(lk[m & sp].mean())) for nm, sp in (('design', des), ('valid', valid), ('test', test))}
    rep['simple_rules'] = rules
    json.dump(rep, open(f'{OUT}/a31_verENS_cluster.json', 'w'), indent=1, default=float, ensure_ascii=False)
    print(g.to_string())
    print(json.dumps({k: v for k, v in rep.items() if k != 'episode_table'}, indent=1, default=float, ensure_ascii=False))


if __name__ == '__main__':
    main()
