"""Verification step 2b: independent re-train of the 'GBDT_ALL_y' member (all rows, target m_y) on DESIGN only.
Uses the repo's HistGBDT (models.py) with the author's hyper-parameters but a DIFFERENT negative-subsample seed
and tree seed (robustness), my own rank features (a31_vfyENS_ranks.npy). n_trees chosen by VALID AUC (all rows).
Output: .surge-cache/a31_vfyENS_gbdtall.npz  (score for every row; DESIGN rows in-sample)
"""
import json, sys, time
import numpy as np
from models import HistGBDT

SP = '/Users/gmii/Documents/股票助手app/tw-stock-app/scripts/surge-lab/.surge-cache'
SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 11
t0 = time.time()
meta = json.load(open(f'{SP}/a31_vfyENS_names.json')); names = meta['names']; const = set(meta['const'])
z = np.load(f'{SP}/dataset_lu1.npz')
s = z['m_s']; ds = z['dates'][s]; y = z['m_y'].astype(np.int8)
split = np.where(ds <= '2025-06-30', 0, np.where(ds <= '2025-12-31', 1, 2))
X = np.empty((len(s), len(names)), np.float32)
for i, k in enumerate(names): X[:, i] = z[k]
R = np.load(f'{SP}/a31_vfyENS_ranks.npy', mmap_mode='r')
keep = np.array([i for i, k in enumerate(names) if k not in const])


def feats(idx):
    return np.hstack([X[idx], np.asarray(R[idx])[:, keep]]).astype(np.float32)


rng = np.random.default_rng(SEED)
tr = np.nonzero(split == 0)[0]
kp = (y[tr] == 1) | (rng.random(len(tr)) < 0.25)
tr = tr[kp]; w = np.where(y[tr] == 1, 1.0, 4.0)
print(f'train rows {len(tr):,} pos {int(y[tr].sum()):,}', flush=True)
m = HistGBDT(n_trees=500, depth=5, lr=0.05, min_child_h=5.0, l2=10.0, colsample=0.5, subsample=0.8, seed=SEED).fit(feats(tr), y[tr], w=w)
print(f'fit done {time.time() - t0:.0f}s', flush=True)


def auc(sc, yy):
    o = np.argsort(sc); r = np.empty(len(sc)); r[o] = np.arange(1, len(sc) + 1)
    n1 = yy.sum(); n0 = len(yy) - n1
    return (r[yy == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


va = np.nonzero(split == 1)[0]
Fv = feats(va)
best, bauc = None, -1
for nt in (200, 300, 400, 500):
    a = auc(m.decision_function(Fv, n_trees=nt), y[va].astype(float))
    print(f'  n_trees {nt}: VALID AUC {a:.4f}', flush=True)
    if a > bauc: best, bauc = nt, a
del Fv
print('chosen n_trees', best, flush=True)
lu = z['m_lu_s'].astype(bool)
q = np.nonzero(lu)[0]                               # only the continuation rows are needed for ENS_cont
score = np.full(len(s), np.nan, np.float32)
for a in range(0, len(q), 100000):
    ii = q[a:a + 100000]; score[ii] = m.decision_function(feats(ii), n_trees=best)
np.savez_compressed(f'{SP}/a31_vfyENS_gbdtall_s{SEED}.npz', score=score, n_trees=best)
print(f'done {time.time() - t0:.0f}s')
