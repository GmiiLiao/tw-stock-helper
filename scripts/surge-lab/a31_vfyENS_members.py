"""Verification step 2c: independent re-implementation of the four continuation-group members of ENS_cont
(only rows with m_lu_s=1 matter for the selector):
  NB        : 10-bin same-day-percentile likelihood-ratio table per feature (DESIGN cont rows, +1 smoothing), log-LR sum
  kNN_U_400 : Euclidean kNN in percentile space, all 123 features equal weight, refs = DESIGN cont rows, k=400
  kNN_A_100 : same, features weighted by w = max(|AUC_DESIGN - 0.5| - 0.02, 0) (AUC per feature on DESIGN cont), k=100
  GBDT_CONT : HistGBDT(depth 3, lr .03, ...) on DESIGN cont rows, raw + percentile features, n_trees by VALID AUC
Seeds for GBDT_CONT: 3 (author's) and 17, 29 (robustness).
Output: .surge-cache/a31_vfyENS_members.npz
"""
import json, time
import numpy as np
from models import HistGBDT

SP = '/Users/gmii/Documents/股票助手app/tw-stock-app/scripts/surge-lab/.surge-cache'
t0 = time.time()
meta = json.load(open(f'{SP}/a31_vfyENS_names.json')); names = meta['names']; const = set(meta['const'])
z = np.load(f'{SP}/dataset_lu1.npz')
s = z['m_s']; ds = z['dates'][s]; y = z['m_y'].astype(int); lu = z['m_lu_s'].astype(bool)
split = np.where(ds <= '2025-06-30', 0, np.where(ds <= '2025-12-31', 1, 2))
R = np.load(f'{SP}/a31_vfyENS_ranks.npy', mmap_mode='r')
ci = np.nonzero(lu)[0]                                    # continuation rows (all splits)
Rc = np.asarray(R[ci]).astype(np.float64)
Xc = np.stack([z[k][ci] for k in names], 1).astype(np.float32)
yc = y[ci]; spc = split[ci]
des = spc == 0; qry = spc >= 1
print(f'cont rows: DESIGN {des.sum():,} (pos {yc[des].sum():,}) VALID {(spc == 1).sum():,} TEST {(spc == 2).sum():,}', flush=True)


def auc_ties(x, yy):
    o = np.argsort(x, kind='mergesort'); xs = x[o]
    r = np.empty(len(x)); r[o] = np.arange(1, len(x) + 1, dtype=float)
    b = np.r_[0, np.nonzero(np.diff(xs))[0] + 1, len(xs)]
    for a, e in zip(b[:-1], b[1:]):
        if e - a > 1: r[o[a:e]] = (a + 1 + e) / 2
    n1 = yy.sum(); n0 = len(yy) - n1
    return (r[yy == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


# ---- NB ----
B = np.minimum((Rc * 10).astype(int), 9)
nb = np.zeros(len(ci))
for k in range(len(names)):
    cp = np.bincount(B[des & (yc == 1), k], minlength=10) + 1.0
    cn = np.bincount(B[des & (yc == 0), k], minlength=10) + 1.0
    lr = np.log((cp / cp.sum()) / (cn / cn.sum()))
    nb += lr[B[:, k]]
print(f'NB done {time.time() - t0:.0f}s', flush=True)

# ---- kNN ----
sep = np.array([abs(auc_ties(Rc[des, k], yc[des]) - 0.5) for k in range(len(names))])
wA = np.maximum(sep - 0.02, 0)
print('top-10 DESIGN-cont separation features:', [(names[i], round(sep[i], 3)) for i in np.argsort(-sep)[:10]], flush=True)


def knn(wt, k):
    Z = Rc * np.sqrt(wt)[None, :]
    Zr = Z[des]; yr = yc[des].astype(float); rn = (Zr ** 2).sum(1)
    out = np.full(len(ci), np.nan)
    qi = np.nonzero(qry)[0]
    for a in range(0, len(qi), 2000):
        q = Z[qi[a:a + 2000]]
        d = rn[None, :] - 2 * q @ Zr.T
        nn = np.argpartition(d, k - 1, axis=1)[:, :k]
        out[qi[a:a + 2000]] = yr[nn].mean(1)
    return out


kU = knn(np.ones(len(names)), 400)
kA = knn(wA, 100)
print(f'kNN done {time.time() - t0:.0f}s', flush=True)

# ---- GBDT_CONT ----
keep = np.array([i for i, k in enumerate(names) if k not in const])
Fc = np.hstack([Xc, Rc[:, keep].astype(np.float32)])
gb = {}
for seed in (3, 17, 29):
    m = HistGBDT(n_trees=600, depth=3, lr=0.03, min_child_h=2.0, l2=10.0, colsample=0.5, subsample=0.8, seed=seed).fit(Fc[des], yc[des])
    v = spc == 1
    best, ba = None, -1
    for nt in (100, 200, 300, 400, 500, 600):
        a = auc_ties(m.decision_function(Fc[v], n_trees=nt), yc[v])
        if a > ba: best, ba = nt, a
    gb[seed] = m.decision_function(Fc, n_trees=best)
    print(f'GBDT_CONT seed {seed}: n_trees {best} VALID AUC {ba:.4f}  {time.time() - t0:.0f}s', flush=True)


def full(v):
    o = np.full(len(s), np.nan, np.float32); o[ci] = v; return o


np.savez_compressed(f'{SP}/a31_vfyENS_members.npz', NB=full(nb), kNN_U_k400=full(kU), kNN_A_k100=full(kA),
                    GBDT_CONT_s3=full(gb[3]), GBDT_CONT_s17=full(gb[17]), GBDT_CONT_s29=full(gb[29]), sep=sep, names=np.array(names))
print(f'done {time.time() - t0:.0f}s')
