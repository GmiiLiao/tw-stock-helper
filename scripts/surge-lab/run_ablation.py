"""特徵群消融：只用某群／拿掉某群，GBDT(rank) 同一套滾動外樣本驗證。"""
import numpy as np, time, warnings, json
import evallib as E, groups as G
from models import HistGBDT
from run_cv import run, GB
warnings.filterwarnings('ignore')
t0 = time.time()
D = E.load(); R = E.rank_features(D); names = D['names']; ix = {n: i for i, n in enumerate(names)}
s, y = D['s'], D['y']
def score(oof):
    m = np.isfinite(oof)
    t, base = E.topk_table(oof[m], s[m], y[m], Ks=(10, 20))
    return dict(wdAUC=E.within_day_auc(oof[m], s[m], y[m]), AUC=E.pooled_auc(oof[m], y[m]), lift10=t.lift[0], lift20=t.lift[1], recall20=t.recall[1])
res = {}
for mode in ('only', 'drop'):
    for g, feats in G.GROUPS.items():
        cols = [ix[f] for f in feats] if mode == 'only' else [i for i, n in enumerate(names) if n not in feats]
        oof = run(D, R, lambda: HistGBDT(**GB), f'{mode}:{g}', cols=cols)
        res[f'{mode}:{g}'] = score(oof)
        print(mode, g, {k: round(v, 3) for k, v in res[f'{mode}:{g}'].items()}, round(time.time() - t0), 's', flush=True)
json.dump(res, open(f'{E.B.SP}/ablation.json', 'w'), ensure_ascii=False, indent=1)
