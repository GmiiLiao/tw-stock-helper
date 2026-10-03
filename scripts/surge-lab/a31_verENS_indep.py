"""a31 verENS step 2: independent re-implementation of the ENS_cont members (no author code or caches imported).

Members (same recipe as described by the author, written from scratch, different random seeds):
  NB          : continuation-group naive Bayes over 10 same-day-percentile bins, LR tables from DESIGN only (+1 smoothing)
  kNN_U_k400  : continuation-group kNN in same-day-percentile space, equal weights, DESIGN rows as the reference library
  kNN_A_k100  : same, weights max(|AUC-0.5|-0.02, 0) with AUC computed on DESIGN continuation rows
  GBDT_CONT_y : HistGBDT on DESIGN continuation rows (raw + percentile features); n_trees picked on VALID
  GBDT_ALL_y  : HistGBDT on all DESIGN rows (negatives subsampled 25%, weight 4); n_trees picked on VALID
ENS = mean of each member's ECDF position within the VALID continuation-row score distribution.

Usage: python3 a31_verENS_indep.py ranks | gbdt_all <seed> | cont <seed> | ens
Caches: .surge-cache/a31_verENS_*.npy/npz ; results: out/a31_verENS_indep.json
"""
import json
import os
import sys
import time

import numpy as np
import pandas as pd

from models import HistGBDT

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')
OUT = os.path.join(HERE, 'out')
RANKS = f'{SP}/a31_verENS_ranks.npy'
BOOK = {'x_bd_has', 'x_bd_bidlim', 'x_bd_bid', 'x_bd_ask', 'x_bd_imb', 'x_bd_q_v'}
TREE_GRID = (100, 200, 300, 400, 500, 600)


def load_core():
    z = np.load(f'{SP}/dataset_lu1.npz')
    dates = np.array(z['dates']).astype(str)
    names = sorted(k for k in z.files if (k.startswith('f_') or k.startswith('x_')) and k not in BOOK)
    m = {k: z[k] for k in ('m_s', 'm_j', 'm_y', 'm_lu_s', 'm_buy_lu', 'm_locked1')}
    sd = dates[m['m_s']]
    split = np.where(sd <= '2025-06-30', 0, np.where(sd <= '2025-12-31', 1, 2)).astype(np.int8)
    return z, names, m, split


def load_X(z, names):
    X = np.empty((len(z['m_s']), len(names)), np.float32)
    for i, k in enumerate(names):
        X[:, i] = z[k]
    return X


def market_constant(X, s):
    """columns whose within-day spread is ~0 on most days (market-wide features)."""
    flags = np.zeros(X.shape[1], bool)
    for k in range(X.shape[1]):
        g = pd.Series(X[:, k]).groupby(s)
        rng = (g.max() - g.min()).fillna(0).values
        flags[k] = np.median(rng) < 1e-6
    return flags


def build_ranks():
    z, names, m, split = load_core()
    X = load_X(z, names); s = m['m_s']
    const = market_constant(X, s)
    R = np.empty(X.shape, np.float32)
    des = split == 0
    for k in range(X.shape[1]):
        col = X[:, k].astype(np.float64)
        if const[k]:
            ref = np.sort(col[des & np.isfinite(col)])
            r = np.searchsorted(ref, col, side='right') / max(len(ref), 1)
            r = np.where(np.isfinite(col), r, np.nan)
        else:
            r = pd.Series(col).groupby(s).rank(pct=True, method='average').values
        R[:, k] = np.where(np.isfinite(r), r, 0.5)
    np.save(RANKS, R)
    np.save(f'{SP}/a31_verENS_const.npy', const)
    print('ranks done; market-constant cols:', [names[i] for i in np.nonzero(const)[0]])


def feats(X, R, const, idx):
    return np.hstack([X[idx], R[idx][:, ~const]]).astype(np.float32)


def auc(score, y):
    o = np.argsort(score, kind='mergesort'); r = np.empty(len(score)); r[o] = np.arange(1, len(score) + 1)
    xs = score[o]; b = np.r_[0, np.nonzero(np.diff(xs))[0] + 1, len(xs)]
    for a, e in zip(b[:-1], b[1:]):
        if e - a > 1:
            r[o[a:e]] = (a + 1 + e) / 2
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def daily_top3(score, y, s):
    df = pd.DataFrame(dict(s=s, sc=score, y=y)).sort_values(['s', 'sc'], ascending=[True, False])
    return float(df.groupby('s').head(3).y.mean())


def pick_trees(model, F_va, y_va, s_va):
    best, bv = None, -1
    for nt in TREE_GRID:
        if nt > model.n_trees:
            break
        sc = model.decision_function(F_va, n_trees=nt)
        v = auc(sc, y_va) + daily_top3(sc, y_va, s_va)
        print(f'   trees {nt}: crit {v:.4f}', flush=True)
        if v > bv:
            best, bv = nt, v
    return best


def gbdt_all(seed):
    t0 = time.time()
    z, names, m, split = load_core(); X = load_X(z, names); R = np.load(RANKS, mmap_mode='r'); const = np.load(f'{SP}/a31_verENS_const.npy')
    y = m['m_y'].astype(np.int8); rng = np.random.default_rng(1000 + seed)
    tr = np.nonzero(split == 0)[0]
    tr = tr[(y[tr] == 1) | (rng.random(len(tr)) < 0.25)]
    w = np.where(y[tr] == 1, 1.0, 4.0)
    print(f'[ALL s{seed}] train rows {len(tr):,} pos {int(y[tr].sum()):,}', flush=True)
    mdl = HistGBDT(n_trees=max(TREE_GRID), depth=5, lr=0.05, min_child_h=5.0, l2=10.0, colsample=0.5, subsample=0.8, seed=seed).fit(feats(X, R, const, tr), y[tr], w=w)
    print(f'[ALL s{seed}] fit {time.time() - t0:.0f}s', flush=True)
    va = np.nonzero(split == 1)[0]
    nt = pick_trees(mdl, feats(X, R, const, va), y[va].astype(float), m['m_s'][va])
    q = np.nonzero((m['m_lu_s'] == 1) & (split >= 1))[0]
    sc = np.full(len(y), np.nan, np.float32); sc[q] = mdl.decision_function(feats(X, R, const, q), n_trees=nt)
    np.save(f'{SP}/a31_verENS_gbdt_all_s{seed}.npy', sc)
    print(f'[ALL s{seed}] picked {nt} trees; done {time.time() - t0:.0f}s', flush=True)


def knn_frac(Zr, yr, Zq, k):
    rn = (Zr ** 2).sum(1); out = np.empty(len(Zq), np.float32)
    for a in range(0, len(Zq), 2048):
        q = Zq[a:a + 2048]
        d = rn[None, :] - 2 * q @ Zr.T
        nn = np.argpartition(d, k - 1, axis=1)[:, :k]
        out[a:a + len(q)] = yr[nn].mean(1)
    return out


def cont_members(seed):
    t0 = time.time()
    z, names, m, split = load_core(); X = load_X(z, names); R = np.load(RANKS); const = np.load(f'{SP}/a31_verENS_const.npy')
    y = m['m_y'].astype(np.int8); lu = m['m_lu_s'] == 1
    ref = np.nonzero(lu & (split == 0))[0]; qry = np.nonzero(lu & (split >= 1))[0]
    va = np.nonzero(lu & (split == 1))[0]
    out = {}
    # NB
    B = np.minimum((R * 10).astype(np.int16), 9)
    nb = np.zeros(len(y))
    yr = y[ref].astype(bool)
    prior = np.log(yr.mean() / (1 - yr.mean()))
    for k in range(R.shape[1]):
        cp = np.bincount(B[ref[yr], k], minlength=10) + 1.0; cn = np.bincount(B[ref[~yr], k], minlength=10) + 1.0
        L = np.log((cp / cp.sum()) / (cn / cn.sum()))
        nb[qry] += L[B[qry, k]]
    out['NB'] = np.where(lu & (split >= 1), nb + prior, np.nan)
    # kNN weights
    aucs = np.array([auc(R[ref, k].astype(np.float64), y[ref].astype(float)) for k in range(R.shape[1])])
    wA = np.maximum(np.abs(aucs - 0.5) - 0.02, 0)
    for nm, w, k in (('kNN_U_k400', np.ones(R.shape[1]), 400), ('kNN_A_k100', wA, 100)):
        sw = np.sqrt(w).astype(np.float32)
        sc = np.full(len(y), np.nan, np.float32)
        sc[qry] = knn_frac(R[ref] * sw, y[ref].astype(np.float32), R[qry] * sw, k)
        out[nm] = sc
    # GBDT CONT
    mdl = HistGBDT(n_trees=max(TREE_GRID), depth=3, lr=0.03, min_child_h=2.0, l2=10.0, colsample=0.5, subsample=0.8, seed=seed).fit(feats(X, R, const, ref), y[ref])
    nt = pick_trees(mdl, feats(X, R, const, va), y[va].astype(float), m['m_s'][va])
    sc = np.full(len(y), np.nan, np.float32); sc[qry] = mdl.decision_function(feats(X, R, const, qry), n_trees=nt)
    out['GBDT_CONT_y'] = sc
    np.savez(f'{SP}/a31_verENS_cont_s{seed}.npz', **out, ntrees=nt, aucs=aucs)
    print(f'[cont s{seed}] NB/kNN/GBDT_CONT({nt} trees) done {time.time() - t0:.0f}s', flush=True)


def wilson(k, n, zz=1.96):
    p = k / n
    return (p + zz * zz / (2 * n) - zz * np.sqrt(p * (1 - p) / n + zz * zz / (4 * n * n))) / (1 + zz * zz / n)


def ecdf_valid(sc, vmask):
    ref = np.sort(sc[vmask & np.isfinite(sc)])
    return np.where(np.isfinite(sc), np.searchsorted(ref, sc, side='right') / len(ref), np.nan)


def ens_eval(members, m, split, label):
    lu = m['m_lu_s'] == 1; v = lu & (split == 1); t = lu & (split == 2)
    P = np.column_stack([ecdf_valid(members[k], v) for k in sorted(members)])
    with np.errstate(all='ignore'):
        e = np.nanmean(P, 1)
    res = dict(label=label)
    for nm, msk in (('valid', v), ('test', t)):
        ii = np.nonzero(msk)[0]; o = ii[np.argsort(-e[ii], kind='stable')]
        for N in (10, 20, 30, 40, 50, 100, 300):
            sel = o[:N]; k = int(m['m_y'][sel].sum())
            res[f'{nm}_top{N}'] = dict(prec=k / N, wlb=wilson(k, N), buy=float(m['m_buy_lu'][sel].mean()), locked=float(m['m_locked1'][sel].mean()),
                                       days=int(len(np.unique(m['m_s'][sel]))))
    # VALID-top-30 threshold transferred to TEST
    vi = np.nonzero(v)[0]; th = np.sort(e[vi])[::-1][29]
    ts = t & (e >= th); k = int(m['m_y'][ts].sum()); n = int(ts.sum())
    res['valid30_threshold_on_test'] = dict(theta=float(th), n=n, prec=k / n if n else None, wlb=wilson(k, n) if n else None,
                                            buy=float(m['m_buy_lu'][ts].mean()) if n else None)
    return res, e


def ens():
    z, names, m, split = load_core()
    rows = []
    seeds_c = sorted(int(f.split('_s')[1].split('.')[0]) for f in os.listdir(SP) if f.startswith('a31_verENS_cont_s') and f.endswith('.npz'))
    seeds_a = sorted(int(f.split('_s')[1].split('.')[0]) for f in os.listdir(SP) if f.startswith('a31_verENS_gbdt_all_s') and f.endswith('.npy'))
    print('cont seeds', seeds_c, 'all seeds', seeds_a)
    for sc_ in seeds_c:
        c = np.load(f'{SP}/a31_verENS_cont_s{sc_}.npz')
        base = {k: c[k] for k in ('NB', 'kNN_U_k400', 'kNN_A_k100', 'GBDT_CONT_y')}
        r4, _ = ens_eval(base, m, split, f'4 members (no GBDT_ALL), cont seed {sc_}')
        rows.append(r4)
        for sa in seeds_a:
            full = dict(base, GBDT_ALL_y=np.load(f'{SP}/a31_verENS_gbdt_all_s{sa}.npy'))
            r5, _ = ens_eval(full, m, split, f'5 members, cont seed {sc_}, all seed {sa}')
            rows.append(r5)
    for r in rows:
        tt = r['test_top30']; vv = r['valid_top30']; tr = r['valid30_threshold_on_test']
        print(f"{r['label']:<44} VALID top30 {vv['prec']:.3f} | TEST top10 {r['test_top10']['prec']:.2f} top20 {r['test_top20']['prec']:.3f} "
              f"top30 {tt['prec']:.3f} (buy {tt['buy']:.3f}, locked {tt['locked']:.2f}) top40 {r['test_top40']['prec']:.3f} top50 {r['test_top50']['prec']:.3f} "
              f"top100 {r['test_top100']['prec']:.3f} | VALID-θ30→TEST n={tr['n']} prec={tr['prec']:.3f}")
    json.dump(rows, open(f'{OUT}/a31_verENS_indep.json', 'w'), indent=1, default=float)


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'ranks':
        build_ranks()
    elif mode == 'gbdt_all':
        gbdt_all(int(sys.argv[2]))
    elif mode == 'cont':
        cont_members(int(sys.argv[2]))
    elif mode == 'ens':
        ens()
