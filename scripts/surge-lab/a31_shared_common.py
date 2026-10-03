"""a31_shared（方案 A：全部漲停前一日「全參數」統計比對）共用：載入 dataset_lu1、切分、選股評估。

協定（2026-10-03 統一）：DESIGN＝s 日 ≤ 2025-06-30；VALID＝2025-07-01～2025-12-31；TEST＝2026-01-01～2026-10-01。
規則與門檻只在 DESIGN（＋VALID）決定；TEST 只報告、不回頭調。
精確度（precision）＝選出的 (s, 股) 中，s+1 收漲停的比例；可買精確度＝其中 s+1 漲停且開盤買得到（m_buy_lu=1）的比例。
"""
import os
import numpy as np
import build as B

DS = f'{B.SP}/dataset_lu1.npz'
CACHE = f'{B.SP}/a31_shared_cache.npz'
SPLITS = (('DESIGN', None, '2025-06-30'), ('VALID', '2025-07-01', '2025-12-31'), ('TEST', '2026-01-01', '2026-10-01'))
META = ('m_s', 'm_j', 'm_y', 'm_y2', 'm_lu_s', 'm_locked1', 'm_buy_lu', 'm_otc', 'm_liquid', 'm_oc1', 'm_cc1')
BD_FEATS = ('x_bd_has', 'x_bd_bidlim', 'x_bd_bid', 'x_bd_ask', 'x_bd_imb', 'x_bd_q_v')   # 只有 2026-07-20 起 47 日 → 不進 DESIGN 統計


def load():
    """回傳 dict：X（float32，列×特徵）、names、meta 欄、dates、split（0/1/2）。第一次讀 npz 後快取。"""
    if os.path.exists(CACHE) and os.path.getmtime(CACHE) >= os.path.getmtime(DS):
        d = np.load(CACHE, allow_pickle=False)
        D = {k: d[k] for k in d.files}
        D['names'] = list(D['names']); D['dates'] = list(D['dates'])
        return D
    d = np.load(DS)
    names = [k for k in d.files if (k.startswith('f_') or k.startswith('x_'))]
    X = np.empty((len(d['m_s']), len(names)), np.float32)
    for i, k in enumerate(names): X[:, i] = d[k]
    D = {k[2:]: d[k] for k in META}
    D.update(X=X, names=np.array(names), dates=d['dates'], codes=d['codes'])
    dates = np.array(d['dates']); sd = dates[D['s']]
    split = np.full(len(sd), -1, np.int8)
    for i, (_, lo, hi) in enumerate(SPLITS):
        m = (sd <= hi) if lo is None else ((sd >= lo) & (sd <= hi))
        split[m] = i
    D['split'] = split
    np.savez(CACHE, **D)
    D['names'] = names; D['dates'] = list(dates)
    return D


def wilson_lb(k, n, z=1.96):
    if n == 0: return float('nan')
    p = k / n; den = 1 + z * z / n
    return float((p + z * z / (2 * n) - z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / den)


def evaluate(sel, D, split_idx):
    """sel：布林（全列）。回傳該切分的精確度、筆數、有選股日數、每日平均筆數（以該切分總交易日為分母）、Wilson 下界、可買精確度。"""
    m = sel & (D['split'] == split_idx)
    n = int(m.sum()); k = int(D['y'][m].sum()); kb = int(D['buy_lu'][m].sum())
    s_all = np.unique(D['s'][D['split'] == split_idx]); days = np.unique(D['s'][m])
    return dict(prec=(k / n if n else float('nan')), picks=n, hits=k, days_with_pick=int(len(days)),
                picks_per_day=n / max(len(s_all), 1), wilson_lb=wilson_lb(k, n),
                buy_prec=(kb / n if n else float('nan')), n_days=int(len(s_all)))


def topn_per_day(score, s, n, valid=None, seed=0):
    """每日分數前 n 名（score 為 NaN／valid=False 的列不選）。同分以隨機鍵打散。"""
    rng = np.random.default_rng(seed)
    sc = np.where(np.isfinite(score), score, -np.inf).astype(np.float64)
    if valid is not None: sc = np.where(valid, sc, -np.inf)
    sc = sc + rng.random(len(sc)) * 1e-9
    order = np.lexsort((-sc, s))
    ss = s[order]
    start = np.r_[0, np.nonzero(np.diff(ss))[0] + 1]
    rank_sorted = np.arange(len(ss)) - np.repeat(start, np.diff(np.r_[start, len(ss)]))
    rank = np.empty(len(sc), np.int64); rank[order] = rank_sorted
    return (rank < n) & np.isfinite(sc) & (sc > -np.inf)


def fmt(r):
    return (f"prec {r['prec'] * 100:5.1f}% ({r['hits']}/{r['picks']}) days {r['days_with_pick']}/{r['n_days']} "
            f"ppd {r['picks_per_day']:.2f} LB {r['wilson_lb'] * 100:5.1f}% buy {r['buy_prec'] * 100:5.1f}%")
