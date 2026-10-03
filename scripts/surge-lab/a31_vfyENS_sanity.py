"""Verification step 4: label identities + look-ahead screen (single-feature AUC per split in the continuation group)."""
import json
import numpy as np
SP = '/Users/gmii/Documents/股票助手app/tw-stock-app/scripts/surge-lab/.surge-cache'
z = np.load(f'{SP}/dataset_lu1.npz')
s = z['m_s']; ds = z['dates'][s]
split = np.where(ds <= '2025-06-30', 0, np.where(ds <= '2025-12-31', 1, 2))
y = z['m_y'].astype(int); lu = z['m_lu_s'].astype(int); buy = z['m_buy_lu'].astype(int); lk = z['m_locked1'].astype(int)
cc1 = z['m_cc1']; r1 = z['f_r1']; oc1 = z['m_oc1']
print('buy_lu == y & ~locked1 :', np.array_equal(buy, y & (1 - lk)))
print('lu_s == x_lu_s         :', np.array_equal(lu, z['x_lu_s'].astype(int)))
print('cc1 | y=1  quantiles 0/1/50/99/100%:', np.nanquantile(cc1[y == 1], [0, .01, .5, .99, 1]).round(4))
print('share y=0 with cc1>=0.095:', np.mean(cc1[y == 0] >= 0.095).round(5), ' n=', int(np.sum(cc1[y == 0] >= 0.095)))
print('f_r1 | lu_s=1 quantiles 0/1/50/100%:', np.nanquantile(r1[lu == 1], [0, .01, .5, 1]).round(4))
print('locked1=1 & y=1 -> oc1 quantiles (should be ~0):', np.nanquantile(oc1[(lk == 1) & (y == 1)], [0, .5, 1]).round(4))
print('first/last s date per split:', {sp: (min(ds[split == sp]), max(ds[split == sp])) for sp in (0, 1, 2)})
# look-ahead screen: single-feature AUC of m_y within continuation rows, per split; leaks would be extreme in all splits
names = [k for k in z.files if k.startswith(('f_', 'x_')) and not k.startswith('x_bd_')]
def auc(x, yy):
    ok = np.isfinite(x); x = x[ok]; yy = yy[ok]
    o = np.argsort(x, kind='mergesort'); xs = x[o]; r = np.empty(len(x)); r[o] = np.arange(1, len(x) + 1)
    b = np.r_[0, np.nonzero(np.diff(xs))[0] + 1, len(xs)]
    for a, e in zip(b[:-1], b[1:]):
        if e - a > 1: r[o[a:e]] = (a + 1 + e) / 2
    n1 = yy.sum(); n0 = len(yy) - n1
    return (r[yy == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)
rows = []
for nm in names:
    x = z[nm].astype(float)
    a = [auc(x[(lu == 1) & (split == sp)], y[(lu == 1) & (split == sp)]) for sp in (0, 1, 2)]
    aa = [auc(x[split == sp][::5], y[split == sp][::5]) for sp in (0, 2)]
    rows.append((max(abs(v - .5) for v in a), nm, a, aa))
rows.sort(reverse=True)
print('\nTop-12 |AUC-0.5| single features for m_y (cont group, DES/VAL/TEST) | all rows (DES/TEST, 1/5 sample):')
for _, nm, a, aa in rows[:12]:
    print(f'  {nm:<20} cont {a[0]:.3f} {a[1]:.3f} {a[2]:.3f} | all {aa[0]:.3f} {aa[1]:.3f}')
# m_cc1 / m_oc1 must not be (near-)copies of any feature
for nm in names:
    x = z[nm].astype(float); ok = np.isfinite(x) & np.isfinite(cc1)
    c = np.corrcoef(x[ok][::7], cc1[ok][::7])[0, 1]
    if abs(c) > 0.3: print('  |corr(feature, cc1)|>0.3 :', nm, round(c, 3))
print('done')
