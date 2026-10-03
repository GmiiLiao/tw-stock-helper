"""資料載入（含同日百分位快取）與評估工具。"""
import numpy as np, pandas as pd, os
import build as B

DATASET = os.environ.get('SURGE_DATASET', 'dataset.npz')          # v2：dataset_t1.npz／dataset_t2.npz
_STEM = os.path.splitext(DATASET)[0]
CACHE_RANK = f'{B.SP}/ranks.npy' if DATASET == 'dataset.npz' else f'{B.SP}/ranks_{_STEM}.npy'
LABEL = os.environ.get('SURGE_LABEL', '')                          # 例：yh3（dataset_at.npz 的 h=3 標籤）
TAG = ('' if DATASET == 'dataset.npz' else '_' + _STEM.replace('dataset_', '')) + (('_' + LABEL) if LABEL else '')   # 輸出檔名後綴（univariate_t1.csv…）


def load(primary_only=False):
    d = np.load(f'{B.SP}/{DATASET}')
    dates = list(d['dates']); codes = list(d['codes'])
    names = sorted(k[2:] for k in d.files if k.startswith('f_'))
    X = np.stack([d[f'f_{k}'] for k in names], 1).astype(np.float32)
    D = dict(dates=dates, codes=codes, names=names, X=X, s=d['m_s'], j=d['m_j'], y=(d[f'm_{LABEL}'] if LABEL else d['m_y']).astype(np.int8),
             yA=d['m_yA'].astype(bool), yB=d['m_yB'].astype(bool),
             extra=(d['m_extra'].astype(bool) if 'm_extra' in d.files else np.zeros(len(d['m_s']), bool)))
    for k in ['f_c1', 'f_c2', 'f_c5', 'f_c10', 'f_c20', 'f_open1', 'o_c1', 'o_c2', 'o_c5', 'o_c10', 'o_c20', 'f_maxup10', 'f_mindn5_vs_open', 'locked_open', 'close_raw', 'vol20']:
        D[k] = d[f'm_{k}']
    if primary_only and D['extra'].any():                    # 只留主要母體（排除 T2「進行中區段」額外列）
        n = len(D['s']); keep = ~D['extra']
        for k, v in list(D.items()):
            if isinstance(v, np.ndarray) and v.shape[0] == n: D[k] = v[keep]
    return D


def rank_features(D, force=False):
    """每個非大盤特徵的「同日百分位」（0～1）。大盤特徵保留原值。快取檔名含列數（primary_only 與完整資料各一份，互不覆蓋）。"""
    names = D['names']
    cache = CACHE_RANK if DATASET == 'dataset.npz' else CACHE_RANK.replace('.npy', f'_{len(D["s"])}.npy')
    ds = f'{B.SP}/{DATASET}'
    fresh = os.path.exists(cache) and os.path.getmtime(cache) >= os.path.getmtime(ds)   # dataset 重建後舊快取即失效（只比 shape 會靜默沿用舊排名）
    if fresh and not force:
        R = np.load(cache)
        if R.shape == D['X'].shape: return R
    s = D['s']; X = D['X']
    R = np.empty_like(X)
    for k, nm in enumerate(names):
        if nm.startswith('mkt_'):
            R[:, k] = X[:, k]
        else:
            R[:, k] = pd.Series(X[:, k].astype(np.float64)).groupby(s).rank(pct=True, method='average').values.astype(np.float32)
    np.save(cache, R)
    return R


def rank_in_day_desc(score, s, seed=0):
    """每列在同一天內的名次（0＝最高分）。同分以隨機鍵打散（避免依代號順序偏袒）。"""
    rng = np.random.default_rng(seed)
    jitter = rng.random(len(score)) * 1e-9
    order = np.lexsort((-(score + jitter), s))             # 先依日、再依分數降冪
    pos_in_sorted = np.empty(len(score), dtype=np.int64); pos_in_sorted[order] = np.arange(len(score))
    first = np.zeros(len(score), dtype=np.int64)
    ss = s[order]
    start_idx = np.r_[0, np.nonzero(np.diff(ss))[0] + 1]
    day_start = np.repeat(start_idx, np.diff(np.r_[start_idx, len(ss)]))
    rank_sorted = np.arange(len(ss)) - day_start
    out = np.empty(len(score), dtype=np.int64); out[order] = rank_sorted
    return out


def within_day_auc(score, s, y):
    """正例在同一天所有候選中的平均百分位（以分數計；1＝最高）。"""
    r = pd.Series(score).groupby(s).rank(pct=True, method='average').values
    return float(r[y == 1].mean())


def pooled_auc(score, y):
    r = pd.Series(score).rank(method='average').values
    n1 = (y == 1).sum(); n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def topk_table(score, s, y, Ks=(5, 10, 20, 50), mask=None):
    """每天取前 K 名：命中（隔日起漲）的精準度、相對基準率的倍數、涵蓋全部事件的比例。"""
    if mask is not None: score, s, y = score[mask], s[mask], y[mask]
    rk = rank_in_day_desc(score, s)
    base = y.mean(); tot_pos = y.sum(); ndays = len(np.unique(s))
    rows = []
    for K in Ks:
        sel = rk < K
        hit = int(y[sel].sum()); n = int(sel.sum())
        rows.append(dict(K=K, picks=n, hits=hit, precision=hit / n, lift=(hit / n) / base, recall=hit / tot_pos, per_day=hit / ndays))
    return pd.DataFrame(rows), base


def pick_returns(score, s, D_ret, K, mask=None, hold='o_c5', skip_locked=True):
    """每天前 K 名、隔日開盤買、持有 hold；一字鎖漲停開盤＝買不到（略過）。回傳每筆報酬 Series（含日期）。"""
    idx = np.arange(len(score)) if mask is None else np.nonzero(mask)[0]
    rk = rank_in_day_desc(score[idx], D_ret['s'][idx])
    sel = idx[rk < K]
    r = D_ret[hold][sel].astype(np.float64)
    ok = np.isfinite(r)
    if skip_locked: ok &= D_ret['locked_open'][sel] == 0
    return pd.DataFrame({'s': D_ret['s'][sel][ok], 'ret': r[ok], 'locked': D_ret['locked_open'][sel][ok], 'n_all': len(sel), 'fill': ok.mean()})


def universe_returns(s_arr, D_ret, mask, hold='o_c5', skip_locked=True):
    idx = np.nonzero(mask)[0]
    r = D_ret[hold][idx].astype(np.float64); ok = np.isfinite(r)
    if skip_locked: ok &= D_ret['locked_open'][idx] == 0
    return pd.DataFrame({'s': D_ret['s'][idx][ok], 'ret': r[ok]})


def boot_ci(per_day_series, n=400, seed=1):
    """依日期 bootstrap 平均報酬的 95% 區間；per_day_series: DataFrame(s, ret)。"""
    g = per_day_series.groupby('s').ret.agg(['sum', 'count'])
    S, N = g['sum'].values, g['count'].values
    rng = np.random.default_rng(seed)
    m = [S[i].sum() / N[i].sum() for i in (rng.integers(0, len(S), len(S)) for _ in range(n))]
    return np.percentile(m, [2.5, 97.5])
