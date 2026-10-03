"""滾動時間序外樣本驗證（expanding window，每季一折）。
訓練＝測試季開始前 11 個交易日以前的所有母體列（purge：標籤用到 s+5，再留緩衝）；負例抽 10%、正例全留。
測試＝該季所有母體列（不抽樣）。輸出 OOF 分數，供之後所有分析共用。"""
import numpy as np, time, warnings, sys, json
import evallib as E
from models import HistGBDT, Logistic
warnings.filterwarnings('ignore')

QUARTERS = [('2025-01-01', '2025-04-01'), ('2025-04-01', '2025-07-01'), ('2025-07-01', '2025-10-01'), ('2025-10-01', '2026-01-01'),
            ('2026-01-01', '2026-04-01'), ('2026-04-01', '2026-07-01'), ('2026-07-01', '2026-12-31')]
PURGE, NEG_FRAC = 11, 0.10
GB = dict(n_trees=250, depth=2, lr=0.05, min_child_h=3.0, l2=20.0, colsample=0.5, subsample=0.8)


def folds(D):
    dates = np.array(D['dates'])
    for a, b in QUARTERS:
        ts, te = int(np.searchsorted(dates, a)), int(np.searchsorted(dates, b))
        yield a, ts, te


def run(D, X, make_model, label, seed=0, cols=None):
    s, y = D['s'], D['y']
    oof = np.full(len(s), np.nan)
    Xu = X if cols is None else X[:, cols]
    for a, ts, te in folds(D):
        ex = D.get('extra')
        tr = np.nonzero((s <= ts - PURGE) & (~ex if ex is not None else True))[0]; test = np.nonzero((s >= ts) & (s < te))[0]
        if len(test) == 0: continue
        rng = np.random.default_rng(seed + ts)
        neg = tr[y[tr] == 0]; pos = tr[y[tr] == 1]
        tr_s = np.concatenate([pos, rng.choice(neg, int(len(neg) * NEG_FRAC), replace=False)])
        m = make_model().fit(Xu[tr_s], y[tr_s])
        oof[test] = m.decision_function(Xu[test])
    return oof


if __name__ == '__main__':
    t0 = time.time()
    D = E.load(); R = E.rank_features(D)
    names = D['names']; ix = {n: i for i, n in enumerate(names)}
    out = {}
    out['gbdt_rank'] = run(D, R, lambda: HistGBDT(**GB), 'gbdt_rank'); print('gbdt_rank', round(time.time() - t0), flush=True)
    out['gbdt_raw'] = run(D, D['X'], lambda: HistGBDT(**GB), 'gbdt_raw'); print('gbdt_raw', round(time.time() - t0), flush=True)
    out['logit_rank'] = run(D, R, lambda: Logistic(l2=200.0), 'logit_rank'); print('logit_rank', round(time.time() - t0), flush=True)
    # 無需訓練的基準
    out['base_atr'] = R[:, ix['atr14']].astype(np.float64)
    out['base_nlu250'] = R[:, ix['n_lu_250']].astype(np.float64)
    out['base_composite'] = np.nanmean(np.stack([R[:, ix['atr14']], R[:, ix['n_lu_250']], R[:, ix['c_ma120']], 1 - R[:, ix['lend_to_v']]], 1), 1).astype(np.float64)
    out['base_random'] = np.random.default_rng(5).random(len(D['s']))
    np.savez_compressed(f'{E.B.SP}/oof{E.TAG}.npz', **out)
    print('saved', round(time.time() - t0), 's')
