"""a31 方案 B（相似度比對＋學習模型）共用：載入 dataset_lu1、切分、同日百分位、評估（每日前 K、門檻、前緣、Wilson）。

切分（強制協定）：DESIGN＝s ≤ 2025-06-30；VALID＝2025-07-01～2025-12-31；TEST＝2026-01-01～2026-10-01。
所有規則／門檻只在 DESIGN(+VALID) 決定；TEST 只報告、不調參。
"""
import os
import numpy as np
import pandas as pd

SP = os.environ.get('SURGE_CACHE', os.path.join(os.path.dirname(os.path.abspath(__file__)), '.surge-cache'))
DS = f'{SP}/dataset_lu1.npz'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')
RANK_CACHE = f'{SP}/a31_simB_ranks.npy'
VALID_START, TEST_START = '2025-07-01', '2026-01-01'
META = ('s', 'j', 'y', 'y2', 'lu_s', 'locked1', 'buy_lu', 'otc', 'liquid', 'oc1', 'cc1')
# 尾盤五檔只有 2026-07-20 起 47 日（全在 TEST 內），DESIGN 全為 NaN → 不進模型／相似度
BOOK = ('x_bd_has', 'x_bd_bidlim', 'x_bd_bid', 'x_bd_ask', 'x_bd_imb', 'x_bd_q_v')


def load(with_book=False):
    z = np.load(DS)
    dates = np.array(z['dates']); codes = np.array(z['codes'])
    names = [k for k in z.files if (k.startswith('f_') or k.startswith('x_')) and k not in BOOK]
    X = np.empty((len(z['m_s']), len(names)), np.float32)
    for i, k in enumerate(names): X[:, i] = z[k]
    D = dict(dates=dates, codes=codes, names=names, X=X)
    for k in META: D[k] = z[f'm_{k}']
    if with_book:
        for k in BOOK: D[k] = z[k]
    ds = dates[D['s']]
    D['split'] = np.where(ds < VALID_START, 0, np.where(ds < TEST_START, 1, 2)).astype(np.int8)
    return D


def day_constant(X, s, tol=1e-6):
    """同日內（幾乎）不變的欄位（大盤類）：同日百分位無意義，改用 DESIGN 全期經驗 CDF。"""
    df = pd.DataFrame(X[:200000]); g = df.groupby(s[:200000]).std().fillna(0).values
    return np.nanmedian(g, 0) < tol


def ranks(D, force=False):
    """同日百分位（0～1，NaN→0.5）；大盤類欄位用 DESIGN 期經驗 CDF。快取。"""
    if os.path.exists(RANK_CACHE) and not force and os.path.getmtime(RANK_CACHE) >= os.path.getmtime(DS):
        R = np.load(RANK_CACHE, mmap_mode=None)
        if R.shape == D['X'].shape: return R
    X, s = D['X'], D['s']
    const = day_constant(X, s)
    R = np.empty_like(X)
    des = D['split'] == 0
    for k in range(X.shape[1]):
        col = X[:, k].astype(np.float64)
        if const[k]:
            ref = np.sort(col[des & np.isfinite(col)])
            r = np.searchsorted(ref, col, side='right') / max(len(ref), 1)
        else:
            r = pd.Series(col).groupby(s).rank(pct=True, method='average').values
        R[:, k] = np.where(np.isfinite(r), r, 0.5).astype(np.float32)
    np.save(RANK_CACHE, R)
    return R


def wilson_lb(k, n, z=1.96):
    if n == 0: return float('nan')
    p = k / n
    return (p + z * z / (2 * n) - z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


def rank_in_day(score, s, seed=0):
    """同日名次（0＝最高分），同分隨機打散。"""
    rng = np.random.default_rng(seed)
    sc = score + rng.random(len(score)) * 1e-9
    order = np.lexsort((-sc, s)); ss = s[order]
    start = np.r_[0, np.nonzero(np.diff(ss))[0] + 1]
    day_start = np.repeat(start, np.diff(np.r_[start, len(ss)]))
    out = np.empty(len(score), np.int64); out[order] = np.arange(len(ss)) - day_start
    return out


def stats(mask, D, idx=None):
    """一組選取（布林遮罩，限定在 idx 列）之統計。"""
    m = mask if idx is None else mask & idx
    n = int(m.sum()); s = D['s'][m]
    k = int(D['y'][m].sum()); kb = int(D['buy_lu'][m].sum())
    days = len(np.unique(s)); ndays_split = len(np.unique(D['s'][idx])) if idx is not None else len(np.unique(D['s']))
    return dict(n=n, prec=k / n if n else np.nan, wlb=wilson_lb(k, n) if n else np.nan, buy=kb / n if n else np.nan,
                days=days, ppd=n / ndays_split, cont=float(D['lu_s'][m].mean()) if n else np.nan)


def topk_day(score, D, idx, k, rid=None):
    """每日前 k 名（在 idx 列內排名）。回傳遮罩。"""
    sc = np.where(idx, score, -np.inf)
    r = rank_in_day(sc, D['s']) if rid is None else rid
    return idx & (r < k)


def threshold_from_valid(score, D, target_prec, min_n=30):
    """在 VALID 上找使 VALID 精確度 ≥ target 的最低門檻（至少 min_n 筆）；找不到回 None。"""
    v = D['split'] == 1
    sv = score[v]; yv = D['y'][v]
    o = np.argsort(-sv); cy = np.cumsum(yv[o]); n = np.arange(1, len(o) + 1); p = cy / n
    ok = np.nonzero((p >= target_prec) & (n >= min_n))[0]
    if len(ok) == 0: return None
    return float(sv[o][ok.max()])


def frontier(score, D, split=2, tops=(30, 100, 300, 1000, 3000), per_day=(1, 3, 10)):
    """TEST 精確度前緣：全期依分數排前 N 筆、每日前 k 名。"""
    idx = D['split'] == split
    rows = []
    sc = score[idx]; y = D['y'][idx]; b = D['buy_lu'][idx]; s = D['s'][idx]; lu = D['lu_s'][idx]
    o = np.argsort(-sc)
    ndays = len(np.unique(s))
    for N in tops:
        sel = o[:N]; k = int(y[sel].sum())
        rows.append(dict(sel=f'top{N} total', n=N, prec=k / N, wlb=wilson_lb(k, N), buy=b[sel].mean(),
                         days=len(np.unique(s[sel])), ppd=N / ndays, cont=lu[sel].mean()))
    rid = rank_in_day(np.where(idx, score, -np.inf), D['s'])
    for k in per_day:
        m = idx & (rid < k); st = stats(m, D, idx)
        rows.append(dict(sel=f'top{k}/day', **st))
    return rows


def fmt(r):
    return (f"{r.get('sel', ''):<24} n={r['n']:>6}  prec={r['prec'] * 100:6.2f}%  WilsonLB={r['wlb'] * 100:6.2f}%  "
            f"buyable={r['buy'] * 100:6.2f}%  days={r['days']:>4}  picks/day={r['ppd']:.2f}  cont-share={r['cont'] * 100:5.1f}%")


def split_report(mask, D, label):
    out = []
    for sp, nm in ((0, 'DESIGN'), (1, 'VALID'), (2, 'TEST')):
        idx = D['split'] == sp; st = stats(mask, D, idx); st['sel'] = f'{label} {nm}'; out.append(st)
    return out
