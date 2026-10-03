"""Verification step 2a: independent same-day percentile ranks (own implementation, does not import a31_simB_*).
Market-wide (per-day constant) columns -> empirical CDF of DESIGN rows (cross-sectional rank would be meaningless).
Output: .surge-cache/a31_vfyENS_ranks.npy (float32, NaN->0.5), a31_vfyENS_names.json
"""
import json, time
import numpy as np, pandas as pd

SP = '/Users/gmii/Documents/股票助手app/tw-stock-app/scripts/surge-lab/.surge-cache'
BOOK = {'x_bd_has', 'x_bd_bidlim', 'x_bd_bid', 'x_bd_ask', 'x_bd_imb', 'x_bd_q_v'}
t0 = time.time()
z = np.load(f'{SP}/dataset_lu1.npz')
names = [k for k in z.files if (k.startswith('f_') or k.startswith('x_')) and k not in BOOK]
s = z['m_s']; ds = z['dates'][s]; des = ds <= '2025-06-30'
order = np.argsort(s, kind='stable'); ss = s[order]
bounds = np.r_[0, np.nonzero(np.diff(ss))[0] + 1, len(ss)]
R = np.empty((len(s), len(names)), np.float32)
const = []
for k, nm in enumerate(names):
    col = z[nm].astype(np.float64)
    # per-day spread over ALL days (not a sample): constant within day if median within-day (max-min) == 0
    cs = col[order]
    fin = np.isfinite(cs)
    mx = np.maximum.reduceat(np.where(fin, cs, -np.inf), bounds[:-1]); mn = np.minimum.reduceat(np.where(fin, cs, np.inf), bounds[:-1])
    spread = np.where(np.isfinite(mx) & np.isfinite(mn), mx - mn, 0.0)
    is_const = np.median(spread) < 1e-6
    if is_const:
        const.append(nm)
        ref = np.sort(col[des & np.isfinite(col)])
        r = np.searchsorted(ref, col, side='right') / len(ref)
        r[~np.isfinite(col)] = np.nan
    else:
        r = pd.Series(col).groupby(s).rank(pct=True, method='average').values
    R[:, k] = np.where(np.isfinite(r), r, 0.5)
print('day-constant columns:', const)
np.save(f'{SP}/a31_vfyENS_ranks.npy', R)
json.dump(dict(names=names, const=const), open(f'{SP}/a31_vfyENS_names.json', 'w'))
# compare with the author's cache (if present) -- informational only
try:
    A = np.load(f'{SP}/a31_simB_ranks.npy', mmap_mode='r')
    idx = np.random.default_rng(0).choice(len(s), 200000, replace=False); idx.sort()
    d = np.abs(np.asarray(A[idx]) - R[idx])
    print('max |diff| vs author ranks per column (top 5):', sorted(zip(d.max(0).round(4), names), reverse=True)[:5])
except Exception as e:
    print('author rank compare skipped:', e)
print(f'done {time.time() - t0:.0f}s')
