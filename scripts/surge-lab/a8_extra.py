"""再加 14 個「相對自己歷史」的時點特徵，看外樣本能否再進步（兩組種子取平均）。"""
import numpy as np, pandas as pd, warnings, time
import build as B, evallib as E
from models import HistGBDT
from run_cv import run, GB
warnings.filterwarnings('ignore')
t0 = time.time()
D = E.load(); R = E.rank_features(D); s, j, y = D['s'], D['j'], D['y']
dates, codes, P = B.load_panel(); T, N = P['C'].shape
ev = B.load_factor_events(dates, codes); A, Fd, _ = B.adjust(dates, codes, P, ev)
C, H, L, O = [pd.DataFrame(A[k]) for k in 'CHLO']; V = pd.DataFrame(P['V']); Craw = pd.DataFrame(P['C']); DT = pd.DataFrame(P['DT'])
pc = C.shift(1); ret = C / pc - 1
tr = pd.DataFrame(np.fmax(np.fmax((H - L).values, (H - pc).abs().values), (L - pc).abs().values))
atr = tr.rolling(14, min_periods=12).mean() / C
day_range = (H - L) / pc; range20 = (H.rolling(20).max() - L.rolling(20).min()) / C
tv = Craw * V; tv20 = tv.rolling(20, min_periods=16).mean()
dtr20 = DT.rolling(20, min_periods=15).sum() / V.rolling(20, min_periods=15).sum().replace(0, np.nan)
r20 = C / C.shift(20) - 1
F = {}
F['atr_rel'] = atr / atr.rolling(120, min_periods=90).median()
F['dayrange_rel'] = day_range / day_range.rolling(60, min_periods=45).mean()
F['range20_rel'] = range20 / range20.rolling(120, min_periods=90).mean()
F['tv_rel'] = tv20 / tv20.rolling(120, min_periods=90).mean()
F['v_rel120'] = V / V.rolling(120, min_periods=90).median()
F['v5_rel120'] = V.rolling(5, min_periods=4).mean() / V.rolling(120, min_periods=90).mean()
F['dt_rel'] = dtr20 / dtr20.rolling(120, min_periods=90).mean()
F['r20_z'] = (r20 - r20.rolling(250, min_periods=150).mean()) / r20.rolling(250, min_periods=150).std()
vavg = V.shift(1).rolling(60, min_periods=45).mean()
F['hot_vol5'] = (V > 1.5 * vavg).astype(float).rolling(5, min_periods=5).sum()
F['gap3_cnt10'] = (((O - pc) / pc) >= 0.03).astype(float).rolling(10, min_periods=8).sum()
F['bigup_cnt20'] = (ret >= 0.05).astype(float).rolling(20, min_periods=16).sum()
F['bigdn_cnt20'] = (ret <= -0.05).astype(float).rolling(20, min_periods=16).sum()
F['range_exp'] = day_range / atr
F['mom_vol_adj'] = r20 / ret.rolling(60, min_periods=50).std()
names_x = list(F)
Xx = np.stack([F[k].values[s, j] for k in names_x], 1).astype(np.float32)
Rx = np.empty_like(Xx)
for k in range(Xx.shape[1]):
    Rx[:, k] = pd.Series(Xx[:, k].astype(np.float64)).groupby(s).rank(pct=True, method='average').values.astype(np.float32)
print('extra features', len(names_x), round(time.time() - t0), 's', flush=True)
# 單變量（同日百分位）
for k, nm in enumerate(names_x):
    rp = Rx[y == 1, k]; print(f'  {nm:14s} within-day AUC {np.nanmean(rp):.3f}')
Raug = np.hstack([R, Rx])
res = {}
for tag, XX in (('base', R), ('aug', Raug)):
    ws, l10, l20, auc = [], [], [], []
    for sd in (0, 1):
        oof = run(D, XX, lambda: HistGBDT(**{**GB, 'seed': sd}), tag, seed=sd * 100)
        m = np.isfinite(oof); t, _ = E.topk_table(oof[m], s[m], y[m], Ks=(10, 20))
        ws.append(E.within_day_auc(oof[m], s[m], y[m])); auc.append(E.pooled_auc(oof[m], y[m])); l10.append(t.lift[0]); l20.append(t.lift[1])
    res[tag] = (np.mean(ws), np.mean(auc), np.mean(l10), np.mean(l20), np.std(ws))
    print(tag, 'wdAUC %.4f (種子sd %.4f) AUC %.4f lift@10 %.2f lift@20 %.2f' % (res[tag][0], res[tag][4], res[tag][1], res[tag][2], res[tag][3]), round(time.time() - t0), 's', flush=True)
np.savez_compressed(f'{E.B.SP}/extra_feats.npz', X=Xx, R=Rx, names=np.array(names_x))
