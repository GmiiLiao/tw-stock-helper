"""A31-D 共用：資料載入、時間切分、Wilson 下界、選股器評估（唯讀）。"""
import numpy as np, pandas as pd

SP = '.surge-cache'
DS = f'{SP}/dataset_lu1.npz'
DESIGN_END, VALID_END = '2025-06-30', '2025-12-31'
BD0 = '2026-07-20'
Z95 = 1.959964


def wilson_lb(k, n, z=Z95):
    if n == 0: return float('nan')
    p = k / n; den = 1 + z * z / n
    return float((p + z * z / (2 * n) - z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / den)


def load_all(feat=True, xcols=True):
    """回傳 meta DataFrame（m_*／x_*／date／code）與 f_* 矩陣（float32）、特徵名。"""
    z = np.load(DS, allow_pickle=True)
    dates = np.array(z['dates']); codes = np.array(z['codes'])
    cols = [k for k in z.files if k.startswith('m_') or (xcols and k.startswith('x_'))]
    df = pd.DataFrame({k: z[k] for k in cols})
    df['date'] = dates[df['m_s'].values]; df['code'] = codes[df['m_j'].values]
    names, X = [], None
    if feat:
        names = sorted(k for k in z.files if k.startswith('f_'))
        X = np.empty((len(df), len(names)), np.float32)
        for i, k in enumerate(names): X[:, i] = z[k]
    return df, X, names


def split_of(date_arr):
    d = np.asarray(date_arr)
    return np.where(d <= DESIGN_END, 'design', np.where(d <= VALID_END, 'valid', 'test'))


def sel_stats(sel, y, buy, date, ndays_total=None):
    """選股器統計：picks、hits、precision、Wilson LB、有選股日數、每日選股數、可買精準度。"""
    sel = np.asarray(sel, bool); n = int(sel.sum()); k = int(np.asarray(y)[sel].sum())
    kb = int(np.asarray(buy)[sel].sum())
    days = int(pd.Series(np.asarray(date)[sel]).nunique()) if n else 0
    nd = ndays_total if ndays_total else max(days, 1)
    return dict(picks=n, hits=k, prec=(k / n if n else np.nan), wilson_lb=wilson_lb(k, n),
                buy_prec=(kb / n if n else np.nan), days_with_pick=days, picks_per_day=n / nd)


def topk_mask(score, date, k, cand=None):
    """每天取分數最高的 k 名（cand 為候選遮罩；NaN 分數不選）。同分以列序穩定排序。"""
    score = np.asarray(score, float).copy()
    if cand is not None: score[~np.asarray(cand, bool)] = np.nan
    s = pd.Series(score)
    rk = s.groupby(np.asarray(date)).rank(ascending=False, method='first')
    return (rk <= k).values & np.isfinite(score)


def day_auc(score, y, date):
    """同日 AUC 的正例平均百分位（1=最高）；僅計入有正有負的日。"""
    df = pd.DataFrame({'s': score, 'y': y, 'd': date}).dropna()
    r = df.groupby('d')['s'].rank(pct=True, method='average')
    ok = df.groupby('d')['y'].transform(lambda v: 0 < v.sum() < len(v)).astype(bool)
    return float(r[(df.y == 1) & ok].mean())


def pooled_auc(score, y):
    m = np.isfinite(score); s = np.asarray(score)[m]; yy = np.asarray(y)[m]
    r = pd.Series(s).rank(method='average').values
    n1 = (yy == 1).sum(); n0 = len(yy) - n1
    if n1 == 0 or n0 == 0: return float('nan')
    return float((r[yy == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))
