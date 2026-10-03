"""超參數只在「2024Q4 折」上選（訓練 ≤2024-09、測試 2024-10~12），之後 2025Q1 起的測試折完全不參與調參。"""
import numpy as np, time, warnings
import evallib as E
from models import HistGBDT
warnings.filterwarnings('ignore')
t0 = time.time()
D = E.load(); R = E.rank_features(D); print('載入/排名', round(time.time() - t0), 's', R.shape)
dates = D['dates']; s = D['s']; y = D['y']
di = {d: i for i, d in enumerate(dates)}
def idx_of(date): return int(np.searchsorted(np.array(dates), date))
ts, te = idx_of('2024-10-01'), idx_of('2025-01-01')
PURGE = 11
tr = np.nonzero(s <= ts - PURGE)[0]; test = np.nonzero((s >= ts) & (s < te))[0]
rng = np.random.default_rng(0)
neg = tr[y[tr] == 0]; pos = tr[y[tr] == 1]
tr_s = np.concatenate([pos, rng.choice(neg, int(len(neg) * 0.10), replace=False)])
print(f'train rows {len(tr_s)} (pos {len(pos)}), test rows {len(test)} (pos {int(y[test].sum())})')
Xtr, ytr, Xte, yte, ste = R[tr_s], y[tr_s], R[test], y[test], s[test]
res = []
for depth in (2, 3, 4):
    for mch in (3.0,):
        m = HistGBDT(n_trees=400, depth=depth, lr=0.05, min_child_h=mch, l2=20.0, colsample=0.5, subsample=0.8, seed=0).fit(Xtr, ytr)
        for nt in (50, 100, 200, 300, 400):
            sc = m.decision_function(Xte, n_trees=nt)
            tab, base = E.topk_table(sc, ste, yte, Ks=(10, 20))
            res.append((depth, nt, E.within_day_auc(sc, ste, yte), E.pooled_auc(sc, yte), tab.lift[0], tab.lift[1]))
            print(f'depth={depth} trees={nt:3d}  wdAUC={res[-1][2]:.4f} AUC={res[-1][3]:.4f}  lift@10={res[-1][4]:.1f}x lift@20={res[-1][5]:.1f}x  ({round(time.time()-t0)}s)', flush=True)
