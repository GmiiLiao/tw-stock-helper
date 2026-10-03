"""a31 verENS step 1 (adversarial verification): reproduce "ENS_cont TEST top-30 total" from the author's cached
member scores, but with independently written split / ECDF / ranking / label code, then stress-test it.

Checks: split boundaries from raw dates; member-score coverage; exact top-N precision around N=30; ties at the cut;
buyable / locked-at-open / filled precision; concentration (unique codes, streak continuation, one-word locks);
the threshold implied by the TEST top-30 and what that threshold did on VALID; VALID-chosen thresholds applied
to TEST; how extreme 90% is among all author top-30 frontier points (multiple comparisons).
Outputs: out/a31_verENS_repro.json, .surge-cache/a31_verENS_repro.log (stdout).
"""
import json
import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')
OUT = os.path.join(HERE, 'out')
DESIGN_END, VALID_START, VALID_END, TEST_START, TEST_END = '2025-06-30', '2025-07-01', '2025-12-31', '2026-01-01', '2026-10-01'


def wilson(k, n, z=1.96):
    if n == 0:
        return float('nan')
    p = k / n
    den = 1 + z * z / n
    return (p + z * z / (2 * n) - z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / den


def load():
    z = np.load(f'{SP}/dataset_lu1.npz')
    dates = np.array(z['dates']).astype(str)
    codes = np.array(z['codes']).astype(str)
    d = {k: z[k] for k in ('m_s', 'm_j', 'm_y', 'm_y2', 'm_lu_s', 'm_locked1', 'm_buy_lu', 'm_otc', 'm_oc1', 'm_cc1',
                          'x_lu_s', 'x_oneword_s', 'x_lu_streak', 'x_price', 'x_close_at_high')}
    sd = dates[d['m_s']]
    split = np.full(len(sd), -1, np.int8)
    split[sd <= DESIGN_END] = 0
    split[(sd >= VALID_START) & (sd <= VALID_END)] = 1
    split[(sd >= TEST_START) & (sd <= TEST_END)] = 2
    assert (split >= 0).all(), 'rows outside protocol windows'
    return dates, codes, d, split, sd


def author_members(n):
    p = np.load(f'{SP}/a31_simB_scores_profile.npz')
    ku = np.load(f'{SP}/a31_simB_knn_U.npz'); ka = np.load(f'{SP}/a31_simB_knn_A.npz')
    gc = np.load(f'{SP}/a31_simB_gbdt_CONT_y.npz'); ga = np.load(f'{SP}/a31_simB_gbdt_ALL_y.npz')
    iu = list(ku['ks']).index(400); ia = list(ka['ks']).index(100)
    M = dict(GBDT_CONT_y=gc['score_des'], GBDT_ALL_y=ga['score_des'], kNN_U_k400=ku['knn'][:, iu],
             kNN_A_k100=ka['knn'][:, ia], NB=p['nb'])
    for k, v in M.items():
        assert len(v) == n, k
    return M, int(gc['n_trees']), int(ga['n_trees'])


def valid_ecdf(score, ref_mask):
    ref = np.sort(score[ref_mask & np.isfinite(score)])
    out = np.searchsorted(ref, score, side='right') / len(ref)
    return np.where(np.isfinite(score), out, np.nan)


def ens_from(M, lu, split):
    v = lu & (split == 1)
    P = np.column_stack([valid_ecdf(M[k], v) for k in M])
    P[~lu] = np.nan
    with np.errstate(all='ignore'):
        e = np.nanmean(P, 1)
    return e, P


def topn_curve(score, mask, d, Ns):
    ii = np.nonzero(mask & np.isfinite(score))[0]
    o = ii[np.argsort(-score[ii], kind='stable')]
    rows = []
    for N in Ns:
        sel = o[:N]
        k = int(d['m_y'][sel].sum())
        rows.append(dict(N=N, hits=k, prec=k / N, wlb=wilson(k, N), buy=float(d['m_buy_lu'][sel].mean()),
                         locked=float(d['m_locked1'][sel].mean())))
    return o, rows


def main():
    dates, codes, d, split, sd = load()
    n = len(split); lu = d['m_lu_s'].astype(bool)
    rep = {}
    rep['split_rows'] = {nm: int((split == i).sum()) for i, nm in enumerate(('design', 'valid', 'test'))}
    rep['split_ranges'] = {nm: [str(np.sort(np.unique(sd[split == i]))[0]), str(np.sort(np.unique(sd[split == i]))[-1])] for i, nm in enumerate(('design', 'valid', 'test'))}
    rep['test_days_total'] = int(len(np.unique(d['m_s'][split == 2])))
    # label sanity: buy_lu implies y; buy_lu = y & ~locked1; lu_s == x_lu_s
    rep['label_sanity'] = dict(buy_implies_y=bool(((d['m_buy_lu'] == 1) <= (d['m_y'] == 1)).all()),
                               buy_eq_y_and_not_locked=float(np.mean(d['m_buy_lu'] == ((d['m_y'] == 1) & (d['m_locked1'] == 0)))),
                               lu_s_eq_x_lu_s=float(np.mean(d['m_lu_s'] == d['x_lu_s'])),
                               cc1_when_y_min=float(np.nanmin(d['m_cc1'][d['m_y'] == 1])),
                               cc1_when_y_median=float(np.nanmedian(d['m_cc1'][d['m_y'] == 1])))
    M, nt_c, nt_a = author_members(n)
    rep['author_ntrees'] = dict(CONT_y=nt_c, ALL_y=nt_a)
    rep['member_coverage_cont'] = {k: {nm: float(np.isfinite(v[lu & (split == i)]).mean()) for i, nm in enumerate(('design', 'valid', 'test'))} for k, v in M.items()}
    ens, P = ens_from(M, lu, split)
    test_c = lu & (split == 2); valid_c = lu & (split == 1)
    rep['cont_rows'] = dict(valid=int(valid_c.sum()), test=int(test_c.sum()), test_base_rate=float(d['m_y'][test_c].mean()),
                            valid_base_rate=float(d['m_y'][valid_c].mean()), test_buy_base=float(d['m_buy_lu'][test_c].mean()))
    Ns = (10, 15, 20, 25, 28, 29, 30, 31, 32, 35, 40, 45, 50, 60, 75, 100, 150, 300)
    o, curve = topn_curve(ens, test_c, d, Ns)
    rep['test_curve'] = curve
    _, vcurve = topn_curve(ens, valid_c, d, (10, 20, 30, 40, 50, 100))
    rep['valid_curve'] = vcurve
    # exact top-30 picks
    top = o[:30]
    th30 = float(ens[o[29]]); th31 = float(ens[o[30]])
    rep['theta_test30'] = th30; rep['theta_test31'] = th31
    rep['ties_at_cut'] = int((np.abs(ens[test_c] - th30) < 1e-12).sum())
    pk = pd.DataFrame(dict(date=sd[top], code=codes[d['m_j'][top]], ens=ens[top], y=d['m_y'][top], y2=d['m_y2'][top],
                           buy_lu=d['m_buy_lu'][top], locked1=d['m_locked1'][top], oneword_s=d['x_oneword_s'][top],
                           streak=d['x_lu_streak'][top], otc=d['m_otc'][top], price=d['x_price'][top], oc1=d['m_oc1'][top]))
    pk.to_csv(f'{OUT}/a31_verENS_top30_picks.csv', index=False, float_format='%.5f')
    print(pk.to_string(index=False))
    nl = pk.locked1 == 0
    rep['top30'] = dict(n=30, hits=int(pk.y.sum()), prec=float(pk.y.mean()), wilson=wilson(int(pk.y.sum()), 30),
                        buyable_prec=float(pk.buy_lu.mean()), locked_open_share=float(pk.locked1.mean()),
                        filled_n=int(nl.sum()), filled_prec=float(pk.y[nl].mean()) if nl.any() else None,
                        days=int(pk.date.nunique()), unique_codes=int(pk.code.nunique()),
                        oneword_share=float(pk.oneword_s.mean()), streak_ge2_share=float((pk.streak >= 2).mean()),
                        streak_median=float(pk.streak.median()), y2_share=float(pk.y2.mean()),
                        months=pk.date.str[:7].value_counts().sort_index().to_dict(),
                        mean_oc1_buyable=float(pk.oc1[nl].mean()) if nl.any() else None)
    # The threshold implied by TEST top-30, applied to VALID (where it should have been chosen)
    vsel = valid_c & (ens >= th30)
    rep['theta30_on_valid'] = dict(n=int(vsel.sum()), prec=float(d['m_y'][vsel].mean()) if vsel.any() else None)
    dsel = lu & (split == 0) & (ens >= th30)
    rep['theta30_on_design_in_sample'] = dict(n=int(dsel.sum()), prec=float(d['m_y'][dsel].mean()) if dsel.any() else None)
    # VALID-chosen thresholds (top-N of VALID) transferred to TEST
    vo = np.nonzero(valid_c)[0]; vo = vo[np.argsort(-ens[vo], kind='stable')]
    trans = []
    for N in (10, 20, 30, 50, 100):
        th = float(ens[vo[N - 1]]); t = test_c & (ens >= th); k = int(d['m_y'][t].sum()); m = int(t.sum())
        trans.append(dict(valid_topN=N, valid_prec=float(d['m_y'][vo[:N]].mean()), theta=th, test_n=m, test_prec=k / m if m else None,
                          test_wilson=wilson(k, m), test_buy=float(d['m_buy_lu'][t].mean()) if m else None, test_days=int(len(np.unique(d['m_s'][t])))))
    rep['valid_threshold_transfer'] = trans
    # Daily top-1 (a causal analogue)
    sc = np.where(test_c, ens, -np.inf)
    df = pd.DataFrame(dict(s=d['m_s'], sc=sc, y=d['m_y'], b=d['m_buy_lu']))[test_c]
    t1 = df.sort_values('sc', ascending=False).groupby('s').head(1)
    rep['test_top1_per_day'] = dict(n=len(t1), prec=float(t1.y.mean()), buy=float(t1.b.mean()))
    # multiple comparisons: author's own TEST top-30 frontier points
    F = pd.read_csv(f'{OUT}/a31_simB_frontier.csv'); f30 = F[F.sel == 'top30 total']
    rep['author_top30_points'] = dict(count=int(len(f30)), max=float(f30.prec.max()), n_ge_0_9=int((f30.prec >= 0.9).sum()),
                                      median=float(f30.prec.median()))
    # how likely is >=27/30 under the selector's own neighborhood rate (top-31..top-100 of TEST, i.e. ~p)
    p_nb = float(d['m_y'][o[30:100]].mean())
    from math import comb
    tail = sum(comb(30, k) * p_nb ** k * (1 - p_nb) ** (30 - k) for k in range(27, 31))
    rep['binomial_tail_ge27_given_rank31_100_rate'] = dict(rate=p_nb, p=tail)
    json.dump(rep, open(f'{OUT}/a31_verENS_repro.json', 'w'), ensure_ascii=False, indent=1, default=float)
    print(json.dumps(rep, ensure_ascii=False, indent=1, default=float))


if __name__ == '__main__':
    main()
