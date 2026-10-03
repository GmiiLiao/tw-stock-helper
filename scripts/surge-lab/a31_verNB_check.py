"""a31 verification (independent re-implementation): NB_cont >= theta (VALID>=70%).

Claimed selector (a31_simB): among stocks already limit-up on s (m_lu_s=1), naive-Bayes similarity
score = group prior log-odds + sum over 123 features of log LR of the feature's 10-quantile bin, where
quantile = same-day percentile rank (NaN -> 0.5; day-constant market features -> DESIGN ECDF), LR tables
fit on DESIGN continuation rows with +1 smoothing. Threshold = lowest score whose VALID cumulative
precision >= 70% with >= 30 picks. Claimed theta = 11.02; TEST 65.6% on 61 picks; buyable 11.5%.

This script does NOT import any a31_simB_* module. It rebuilds percentile ranks with numpy (own tie
handling), own day-constant detection, own LR tables / threshold search, then runs robustness checks.
Output: printed report + scripts/surge-lab/out/a31_verNB_check.json
"""
import json
import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DS = os.path.join(HERE, '.surge-cache', 'dataset_lu1.npz')
OUT = os.path.join(HERE, 'out', 'a31_verNB_check.json')
VALID_START, TEST_START, TEST_END = '2025-07-01', '2026-01-01', '2026-10-01'
N_BINS = 10
TARGET = 0.70
MIN_N = 30
BOOK_PREFIX = 'x_bd_'


def wilson_lb(k, n, z=1.96):
    if n == 0:
        return float('nan')
    p = k / n
    return (p + z * z / (2 * n) - z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def day_pct_rank(x, s, day_start, day_len):
    """Same-day percentile rank (average ties) over non-NaN values (+-inf ranked at the ends); NaN where x is NaN."""
    out = np.full(len(x), np.nan)
    fin = ~np.isnan(x)
    idx = np.nonzero(fin)[0]
    if len(idx) == 0:
        return out
    xs, ss = x[idx], s[idx]
    o = np.lexsort((xs, ss))
    xs_o, ss_o = xs[o], ss[o]
    n = len(o)
    new_day = np.r_[True, ss_o[1:] != ss_o[:-1]]
    day_first = np.maximum.accumulate(np.where(new_day, np.arange(n), 0))
    pos_in_day = np.arange(n) - day_first + 1                      # 1-based
    cnt_day = np.bincount(ss_o, minlength=s.max() + 1)[ss_o]
    new_run = new_day | np.r_[True, xs_o[1:] != xs_o[:-1]]
    run_id = np.cumsum(new_run) - 1
    run_first = np.nonzero(new_run)[0]
    run_last = np.r_[run_first[1:], n] - 1
    avg = (pos_in_day[run_first] + pos_in_day[run_last]) / 2.0
    r = avg[run_id] / cnt_day
    tmp = np.empty(n); tmp[o] = r
    out[idx] = tmp
    return out


def is_day_constant(x, s, des):
    """True if, on >=95% of DESIGN days, all finite values within the day are identical."""
    m = des & np.isfinite(x)
    ss, xx = s[m], x[m]
    mx = np.full(s.max() + 1, -np.inf); mn = np.full(s.max() + 1, np.inf)
    np.maximum.at(mx, ss, xx); np.minimum.at(mn, ss, xx)
    days = np.unique(ss)
    return float(np.mean((mx[days] - mn[days]) < 1e-9)) >= 0.95


def to_bins(r):
    r = np.where(np.isfinite(r), r, 0.5)
    return np.minimum((r * N_BINS).astype(np.int16), N_BINS - 1).astype(np.int8)


def sel_stats(m, z):
    n = int(m.sum()); k = int(z['y'][m].sum())
    if n == 0:
        return dict(n=0)
    locked = z['locked1'][m]; nl = m & (z['locked1'] == 0)
    oc_nl = z['oc1'][nl]
    return dict(n=n, k=k, prec=k / n, wlb=wilson_lb(k, n), buy=float(z['buy_lu'][m].mean()),
                days=int(len(np.unique(z['s'][m]))), locked_open=float(locked.mean()),
                filled_n=int(nl.sum()), filled_prec=float(z['y'][nl].mean()) if nl.any() else float('nan'),
                filled_oc1_mean=float(np.nanmean(oc_nl)) if nl.any() else float('nan'))


def thr_from_valid(score, valid_mask, y, target, min_n):
    v = np.nonzero(valid_mask & np.isfinite(score))[0]
    o = v[np.argsort(-score[v], kind='mergesort')]
    cy = np.cumsum(y[o]); n = np.arange(1, len(o) + 1); p = cy / n
    ok = np.nonzero((p >= target) & (n >= min_n))[0]
    if len(ok) == 0:
        return None
    return float(score[o][ok.max()])


MKT_CONST = ['f_mkt_r1', 'f_mkt_r5', 'f_mkt_r20', 'f_mkt_breadth_ma20', 'f_mkt_lu_cnt', 'f_mkt_lu_cnt5',
             'f_mkt_vol_ratio', 'f_mkt_near_hi']
# a31_simB_common.day_constant() inspects only the first 200k rows (2023-01..07); revenue features are all-NaN there
# and f_ml_chg20 is near-constant there, so the author's code ALSO maps these 4 stock-level features through a pooled
# DESIGN ECDF instead of a same-day rank. "as_built" reproduces that; "corrected" ranks them within day.
AUTHOR_EXTRA_ECDF = ['f_ml_chg20', 'f_rev_yoy', 'f_rev_mom', 'f_rev_yoy_acc']


def compute_bins(zf, names, s, des, lu, ecdf_feats, f32, nan_ecdf_top=False):
    """nan_ecdf_top: reproduce a31_simB_common.ranks(), where searchsorted(NaN) = len(ref) gives NaN rows of
    ECDF-mapped features a percentile of 1.0 (top decile) instead of the intended 0.5."""
    Bc = np.empty((int(lu.sum()), len(names)), np.int8)
    for i, nm in enumerate(names):
        x = zf[nm].astype(np.float64)
        if nm in ecdf_feats:
            ref = np.sort(x[des & np.isfinite(x)])
            r = np.searchsorted(ref, x, side='right') / max(len(ref), 1)
            if not nan_ecdf_top:
                r = np.where(np.isnan(x), np.nan, r)
        else:
            r = day_pct_rank(x, s, None, None)
        r = np.where(np.isfinite(r[lu]), r[lu], 0.5)
        if f32:
            Bc[:, i] = np.minimum((r.astype(np.float32) * np.float32(N_BINS)).astype(np.int16), N_BINS - 1)
        else:
            Bc[:, i] = to_bins(r)
    return Bc


def nb_score(Bc, yc, dc, n_rows, lu):
    pos, neg = dc & (yc == 1), dc & (yc == 0)
    L = np.zeros((Bc.shape[1], N_BINS))
    for i in range(Bc.shape[1]):
        cp = np.bincount(Bc[pos, i], minlength=N_BINS) + 1.0
        cn = np.bincount(Bc[neg, i], minlength=N_BINS) + 1.0
        L[i] = np.log(cp / cp.sum()) - np.log(cn / cn.sum())
    prior = np.log(yc[dc].mean() / (1 - yc[dc].mean()))
    score = np.full(n_rows, -np.inf)
    score[lu] = prior + L[np.arange(Bc.shape[1])[None, :], Bc].sum(1)
    return score


def main():
    zf = np.load(DS)
    dates = np.array(zf['dates'])
    z = {k: zf[f'm_{k}'] for k in ('s', 'y', 'lu_s', 'buy_lu', 'locked1', 'oc1', 'cc1')}
    s = z['s'].astype(np.int64)
    ds = dates[s]
    split = np.where(ds < VALID_START, 0, np.where(ds < TEST_START, 1, 2))
    assert dates[s.max()] <= TEST_END
    des, val, tst = split == 0, split == 1, split == 2
    lu = z['lu_s'] == 1
    y = z['y'].astype(np.int64)
    names = [k for k in zf.files if (k.startswith('f_') or k.startswith('x_')) and not k.startswith(BOOK_PREFIX)]
    print(f'features used: {len(names)}; rows {len(s):,}; cont rows {int(lu.sum()):,}')
    detected = [nm for nm in names if is_day_constant(zf[nm].astype(np.float64), s, des)]
    print('truly day-constant (my detector, >=95% DESIGN days single-valued):', detected)
    assert sorted(detected) == sorted(MKT_CONST)
    yc = y[lu]; dc, vc, tc = des[lu], val[lu], tst[lu]
    print(f'cont base rates: DES {yc[dc].mean():.3f} VAL {yc[vc].mean():.3f} TEST {yc[tc].mean():.3f}')
    variants = {}
    for vname, ecdf, f32, ntop in (('as_built', MKT_CONST + AUTHOR_EXTRA_ECDF, True, True),
                                   ('corrected', MKT_CONST, False, False),
                                   ('as_built_nan_mid', MKT_CONST + AUTHOR_EXTRA_ECDF, False, False)):
        Bc = compute_bins(zf, names, s, des, lu, ecdf, f32, ntop)
        variants[vname] = nb_score(Bc, yc, dc, len(s), lu)
    res = {}
    for vname in ('corrected', 'as_built_nan_mid'):
        sc = variants[vname]
        print(f'\n== variant {vname}: VALID cumulative precision of top-N (cont rows)')
        v = np.nonzero(val & lu)[0]; o = v[np.argsort(-sc[v], kind='mergesort')]
        cp = np.cumsum(y[o]) / np.arange(1, len(o) + 1)
        print('   ', {n: round(float(cp[n - 1]), 3) for n in (10, 20, 30, 40, 50, 100)}, ' max p (n>=30):',
              round(float(cp[29:].max()), 3))
        t2 = thr_from_valid(sc, val & lu, y, TARGET, MIN_N)
        res[f'{vname}_theta70'] = t2
        print('    theta for VALID>=70% n>=30:', t2)
        for tgt in (0.6, 0.65):
            t3 = thr_from_valid(sc, val & lu, y, tgt, MIN_N)
            if t3 is None:
                continue
            m3 = lu & (sc >= t3)
            print(f'    VALID>={tgt:.0%}: theta {t3:.3f} VAL {sel_stats(m3 & val, z)}')
            print(f'                        TEST {sel_stats(m3 & tst, z)}')
        ti = np.nonzero(tst & lu)[0]; ot = ti[np.argsort(-sc[ti], kind='mergesort')]
        print('    TEST top-N precision:', {n: round(float(y[ot[:n]].mean()), 3) for n in (30, 61, 100, 300)})
    score = variants['as_built']
    print('\n== variant as_built (reproduces author transform incl. float32 binning)')

    th = thr_from_valid(score, val & lu, y, TARGET, MIN_N)
    sel = lu & (score >= th)
    res['theta'] = th
    print(f'\ntheta (VALID>={TARGET:.0%}, n>={MIN_N}) = {th:.4f}')
    for nm_, m_ in (('DESIGN', des), ('VALID', val), ('TEST', tst)):
        st = sel_stats(sel & m_, z); res[nm_] = st
        print(f'  {nm_:<6} {st}')
    ntd = len(np.unique(s[tst]))
    res['TEST_trading_days'] = ntd; res['TEST_picks_per_day'] = res['TEST']['n'] / ntd
    print(f'  TEST trading days {ntd}; picks/day {res["TEST_picks_per_day"]:.3f}')

    # --- robustness: threshold sensitivity (all chosen on VALID only)
    print('\n-- threshold sensitivity (VALID target / min_n -> TEST)')
    sens = []
    for tgt in (0.6, 0.65, 0.7, 0.75, 0.8):
        for mn in (20, 30, 50, 100):
            t2 = thr_from_valid(score, val & lu, y, tgt, mn)
            if t2 is None:
                sens.append(dict(target=tgt, min_n=mn, theta=None)); continue
            m2 = lu & (score >= t2)
            a, b = sel_stats(m2 & val, z), sel_stats(m2 & tst, z)
            sens.append(dict(target=tgt, min_n=mn, theta=t2, val_n=a['n'], val_prec=a['prec'], test_n=b.get('n', 0),
                             test_prec=b.get('prec'), test_buy=b.get('buy')))
            print(f'  tgt {tgt:.2f} min_n {mn:>3}: theta {t2:7.3f}  VAL {a["n"]:>4} {a["prec"]:.3f}  TEST {b.get("n",0):>4} '
                  f'{b.get("prec", float("nan")):.3f} buy {b.get("buy", float("nan")):.3f}')
    res['sensitivity'] = sens
    print('\n-- theta perturbation around claimed value (TEST)')
    pert = []
    for d in (-1.0, -0.5, -0.25, 0, 0.25, 0.5, 1.0, 2.0):
        m2 = lu & (score >= th + d) & tst; st = sel_stats(m2, z)
        pert.append(dict(delta=d, **st))
        print(f'  theta{d:+.2f}: n {st.get("n",0):>4} prec {st.get("prec", float("nan")):.3f} buy {st.get("buy", float("nan")):.3f}')
    res['perturb'] = pert

    # --- frontier on TEST within continuation group
    print('\n-- TEST frontier (cont group, NB score)')
    fr = []
    ti = np.nonzero(tst & lu)[0]; o = ti[np.argsort(-score[ti], kind='mergesort')]
    for N in (30, 61, 100, 300, 1000):
        st = sel_stats(np.isin(np.arange(len(s)), o[:N]), z); fr.append(dict(sel=f'top{N} total', **st))
        print(f'  top{N:<5} prec {st["prec"]:.3f} wlb {st["wlb"]:.3f} buy {st["buy"]:.3f} locked {st["locked_open"]:.3f}')
    for k in (1, 3, 10):
        # per-day top-k inside TEST cont rows
        oo = ti[np.lexsort((-score[ti], s[ti]))]
        ss = s[oo]; first = np.r_[True, ss[1:] != ss[:-1]]
        start = np.maximum.accumulate(np.where(first, np.arange(len(oo)), 0))
        m2 = np.zeros(len(s), bool); m2[oo[(np.arange(len(oo)) - start) < k]] = True
        st = sel_stats(m2, z); fr.append(dict(sel=f'top{k}/day', **st))
        print(f'  top{k}/day   n {st["n"]} prec {st["prec"]:.3f} wlb {st["wlb"]:.3f} buy {st["buy"]:.3f} locked {st["locked_open"]:.3f}')
    res['frontier'] = fr

    # --- simple no-model baselines in continuation group
    print('\n-- baselines (no model)')
    ow = zf['x_oneword_s'] == 1; streak = zf['x_lu_streak']
    base = {}
    for lab, m in (('cont all', lu), ('cont oneword', lu & ow), ('cont oneword & streak>=2', lu & ow & (streak >= 2)),
                   ('cont oneword & streak>=3', lu & ow & (streak >= 3))):
        row = {}
        for nm_, m_ in (('DES', des), ('VAL', val), ('TEST', tst)):
            st = sel_stats(m & m_, z); row[nm_] = st
        base[lab] = row
        print(f'  {lab:<28} DES {row["DES"]["prec"]:.3f} VAL {row["VAL"]["prec"]:.3f} TEST {row["TEST"]["prec"]:.3f} '
              f'(n {row["TEST"]["n"]}) buy {row["TEST"]["buy"]:.3f} locked {row["TEST"]["locked_open"]:.3f}')
    res['baselines'] = base
    tsel = sel & tst
    print('\n-- composition of the 61 TEST picks')
    print(f'  oneword on s: {ow[tsel].mean():.3f}; streak>=2: {(streak[tsel] >= 2).mean():.3f}; streak dist:',
          dict(zip(*np.unique(streak[tsel].astype(int), return_counts=True))))
    mon = np.array([d[:7] for d in ds[tsel]])
    um, cnt = np.unique(mon, return_counts=True)
    hits = [int(y[tsel][mon == u].sum()) for u in um]
    print('  by month (picks/hits):', {u: f'{c}/{h}' for u, c, h in zip(um, cnt, hits)})
    dd, dc_ = np.unique(s[tsel], return_counts=True)
    print(f'  max picks on one day: {dc_.max()}; days with >=3 picks: {int((dc_ >= 3).sum())}')
    # day-cluster bootstrap CI for TEST precision
    rng = np.random.default_rng(0)
    days_u = np.unique(s[tsel]); ky = {d: (int(y[tsel & (s == d)].sum()), int((tsel & (s == d)).sum())) for d in days_u}
    arr = np.array([ky[d] for d in days_u])
    bs = []
    for _ in range(5000):
        b = arr[rng.integers(0, len(arr), len(arr))]; bs.append(b[:, 0].sum() / b[:, 1].sum())
    res['day_bootstrap_95'] = [float(np.quantile(bs, 0.025)), float(np.quantile(bs, 0.975))]
    print(f'  day-cluster bootstrap 95% CI of TEST precision: {res["day_bootstrap_95"]}')
    res['tradable_mean_oc1_unlocked'] = float(np.nanmean(z['oc1'][tsel & (z['locked1'] == 0)]))
    res['mean_cc1_all_picks'] = float(np.nanmean(z['cc1'][tsel]))
    print(f'  TEST picks not locked at open: mean s+1 open->close {res["tradable_mean_oc1_unlocked"]:.4f}; '
          f'mean close->close (incl. untradable) {res["mean_cc1_all_picks"]:.4f}')
    json.dump(res, open(OUT, 'w'), ensure_ascii=False, indent=1, default=float)
    print('\nwrote', OUT)


if __name__ == '__main__':
    main()
