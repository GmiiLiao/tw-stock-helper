"""Adversarial verification of 'ENS_cont >= theta (VALID>=60%)' (a31 simB) -- step 1: re-derive the selector
from the author's cached member scores with independent code (own split, ECDF, threshold, Wilson, stats).
Does NOT import a31_simB_*.  Read-only on the dataset/caches.
"""
import numpy as np

SP = '/Users/gmii/Documents/股票助手app/tw-stock-app/scripts/surge-lab/.surge-cache'
z = np.load(f'{SP}/dataset_lu1.npz')
dates = z['dates']; s = z['m_s']; y = z['m_y'].astype(int); lu = z['m_lu_s'].astype(bool)
buy = z['m_buy_lu'].astype(int); locked = z['m_locked1'].astype(int)
ds = dates[s]
split = np.where(ds <= '2025-06-30', 0, np.where(ds <= '2025-12-31', 1, 2))
assert sorted(set(ds))[-1] <= '2026-10-01', sorted(set(ds))[-1]


def wilson(k, n, zz=1.96):
    p = k / n
    return (p + zz * zz / (2 * n) - zz * np.sqrt(p * (1 - p) / n + zz * zz / (4 * n * n))) / (1 + zz * zz / n)


prof = np.load(f'{SP}/a31_simB_scores_profile.npz')
gA = np.load(f'{SP}/a31_simB_gbdt_ALL_y.npz'); gC = np.load(f'{SP}/a31_simB_gbdt_CONT_y.npz')
kU = np.load(f'{SP}/a31_simB_knn_U.npz'); kA = np.load(f'{SP}/a31_simB_knn_A.npz')
ksU = list(kU['ks']); ksA = list(kA['ks'])
M = {'GBDT_CONT_y': gC['score_des'], 'GBDT_ALL_y': gA['score_des'],
     'kNN_U_k400': kU['knn'][:, ksU.index(400)], 'kNN_A_k100': kA['knn'][:, ksA.index(100)], 'NB': prof['nb']}
v = (split == 1) & lu
P = []
for nm, sc in M.items():
    ref = np.sort(sc[v & np.isfinite(sc)])
    pc = np.searchsorted(ref, sc, side='right') / len(ref)
    pc = np.where(lu & np.isfinite(sc), pc, np.nan)
    P.append(pc)
    print(f'{nm:<12} finite: DES {np.isfinite(sc[(split == 0) & lu]).mean():.3f} VAL {np.isfinite(sc[(split == 1) & lu]).mean():.3f} '
          f'TEST {np.isfinite(sc[(split == 2) & lu]).mean():.3f}  VALID-cont ref n={len(ref)}')
P = np.stack(P, 1)
with np.errstate(all='ignore'):
    ens = np.where(lu, np.nanmean(P, 1), -np.inf)
nmem = np.isfinite(P).sum(1)
print('members available per split (cont rows):', {sp: np.bincount(nmem[(split == sp) & lu], minlength=6).tolist() for sp in (0, 1, 2)})

# threshold: VALID, largest-coverage cut with cumulative precision >= 0.60 and n >= 30
vi = np.nonzero(split == 1)[0]
o = vi[np.argsort(-ens[vi], kind='mergesort')]
cum = np.cumsum(y[o]); n = np.arange(1, len(o) + 1); prec = cum / n
for tgt in (0.5, 0.6, 0.7):
    ok = np.nonzero((prec >= tgt) & (n >= 30) & np.isfinite(ens[o]))[0]
    print(f'target {tgt}: reachable={len(ok) > 0}', '' if not len(ok) else f'theta={ens[o][ok.max()]:.5f} n={n[ok.max()]} prec={prec[ok.max()]:.3f}')
ok = np.nonzero((prec >= 0.6) & (n >= 30))[0]
theta = ens[o][ok.max()]
print(f'theta = {theta:.6f}')
sel = ens >= theta
for sp, nm in ((0, 'DESIGN'), (1, 'VALID'), (2, 'TEST')):
    m = sel & (split == sp)
    nn = int(m.sum()); k = int(y[m].sum()); kb = int(buy[m].sum())
    nd = len(np.unique(s[split == sp])); dwp = len(np.unique(s[m]))
    print(f'{nm:<7} n={nn:>4} prec={k / nn:.4f} wilsonLB={wilson(k, nn):.4f} buyable={kb / nn:.4f} days_with_pick={dwp} '
          f'trading_days={nd} picks/day={nn / nd:.3f} locked_open={locked[m].mean():.3f}')
np.savez_compressed(f'{SP}/a31_vfyENS_cache_sel.npz', ens=ens.astype(np.float32), theta=theta, sel=sel)
