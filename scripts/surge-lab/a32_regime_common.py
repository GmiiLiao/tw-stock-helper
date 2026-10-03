"""a32_regime 共用：載入 dataset_lu1、日層級熱度、GBDT 設定、評估工具（每日前 K、Wilson、日區塊 bootstrap）。

2026-10-03 使用者：「現在是 2026 年且未來幾年只會更熱 … 獨立使用 2026 年至今的漲停前一天資料來訓練，再做 2 者比對」。
本組（regime）只回答：2026 內部的熱度穩定性、命中集中度、以及「若下一段像 2025 一樣冷，2026 模型會怎樣」。

GBDT 設定沿用 a31_shared_gbdt 的 G_ALL 選定值（depth 4、600 棵、lr 0.05、min_child_h 3、l2 20、colsample 0.5、
subsample 0.8、負例抽 15%）；特徵＝全部 f_*（排序）＋ 6 個 x_*，不含尾盤五檔 x_bd_*（2026-07-20 起才有）。
熱度定義（兩種，務必分開解讀）：
  · ex-ante（決策時已知）：s 日母體內收漲停檔數＝sum(m_lu_s)；與 f_mkt_lu_cnt 同義（後者只算流動性母體）
  · ex-post（結果定義）  ：s+1 日母體內收漲停檔數＝sum(m_y)；用來分組只算「描述」，不可當成可操作的濾網
"""
import os
import numpy as np
import pandas as pd
from models import HistGBDT

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')
OUT = os.path.join(HERE, 'out')
DS = os.path.join(SP, 'dataset_lu1.npz')
X_EXTRA = ('x_lu_s', 'x_oneword_s', 'x_close_at_high', 'x_lu_streak', 'x_price', 'x_vol20')
META = ('m_s', 'm_j', 'm_y', 'm_lu_s', 'm_locked1', 'm_buy_lu', 'm_otc', 'm_liquid', 'm_oc1')
GBDT_PARAMS = dict(n_trees=600, depth=4, lr=0.05, min_child_h=3.0, l2=20.0, colsample=0.5, subsample=0.8)
NEG_FRAC = 0.15
COOL_LU = 15                     # 「冷日」：當日漲停 < 15 檔


def load(with_x=True):
    z = np.load(DS)
    dates = np.array(z['dates']).astype(str)
    D = {k[2:]: z[k] for k in META}
    D['dates'] = dates; D['sd'] = dates[D['s']]
    if with_x:
        names = sorted(k for k in z.files if k.startswith('f_')) + list(X_EXTRA)
        X = np.empty((len(D['s']), len(names)), np.float32)
        for i, k in enumerate(names): X[:, i] = z[k]
        D['X'] = X; D['names'] = names
    else:
        for k in ('f_mkt_lu_cnt', 'f_mkt_breadth_ma20', 'f_mkt_r1', 'f_mkt_r5', 'f_mkt_r20'):
            D[k] = z[k]
    return D


def day_table(D):
    """每個 s 日一列：母體數、s 日漲停數（ex-ante）、s+1 漲停數（ex-post）、基準率、可買漲停數、大盤欄位。"""
    s = D['s']
    df = pd.DataFrame(dict(s=s, y=D['y'].astype(int), lu=D['lu_s'].astype(int), buy=D['buy_lu'].astype(int),
                           fresh_y=((D['y'] == 1) & (D['lu_s'] == 0)).astype(int)))
    for k in ('f_mkt_lu_cnt', 'f_mkt_breadth_ma20', 'f_mkt_r1', 'f_mkt_r5', 'f_mkt_r20'):
        if k in D: df[k] = D[k]
    agg = dict(n=('y', 'size'), lu_next=('y', 'sum'), lu_s=('lu', 'sum'), buy_next=('buy', 'sum'), fresh_next=('fresh_y', 'sum'))
    for k in ('f_mkt_lu_cnt', 'f_mkt_breadth_ma20', 'f_mkt_r1', 'f_mkt_r5', 'f_mkt_r20'):
        if k in df: agg[k] = (k, 'median')
    g = df.groupby('s').agg(**agg).reset_index()
    g['date'] = D['dates'][g['s'].values]
    g['base'] = g['lu_next'] / g['n']
    dt = pd.to_datetime(g['date'])
    g['year'] = dt.dt.year; g['ym'] = dt.dt.strftime('%Y-%m'); g['q'] = dt.dt.year.astype(str) + 'Q' + dt.dt.quarter.astype(str)
    iso = dt.dt.isocalendar(); g['wk'] = iso['year'].astype(str) + '-W' + iso['week'].astype(int).map('{:02d}'.format)
    return g


def wilson(k, n, z=1.96):
    if n == 0: return (float('nan'), float('nan'))
    p = k / n; den = 1 + z * z / n; c = (p + z * z / (2 * n)) / den
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (c - h, c + h)


def rank_in_day(score, s, seed=0):
    """同日名次（0＝最高分）；NaN／-inf 排最後；同分隨機打散。"""
    rng = np.random.default_rng(seed)
    sc = np.where(np.isfinite(score), score, -np.inf) + rng.random(len(score)) * 1e-9
    order = np.lexsort((-sc, s)); ss = s[order]
    start = np.r_[0, np.nonzero(np.diff(ss))[0] + 1]
    day_start = np.repeat(start, np.diff(np.r_[start, len(ss)]))
    out = np.empty(len(score), np.int64); out[order] = np.arange(len(ss)) - day_start
    return out


def topk_mask(score, s, k, rows):
    """rows（布林）內每日前 k 名；score 為 NaN 的列不選。"""
    sc = np.where(rows & np.isfinite(score), score, -np.inf)
    r = rank_in_day(sc, s)
    return rows & np.isfinite(score) & (r < k)


def day_block_boot(sel, D, n_boot=2000, seed=0, day_subset=None):
    """以「日」為區塊重抽，回傳精確度與可買精確度的 95% 區間。sel＝布林遮罩。"""
    s = D['s'][sel]; y = D['y'][sel].astype(float); b = D['buy_lu'][sel].astype(float)
    if len(s) == 0: return (np.nan, np.nan), (np.nan, np.nan)
    u, inv = np.unique(s, return_inverse=True)
    ky = np.bincount(inv, y, len(u)); kb = np.bincount(inv, b, len(u)); nn = np.bincount(inv, minlength=len(u)).astype(float)
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(u), (n_boot, len(u)))
    N = nn[idx].sum(1); py = ky[idx].sum(1) / N; pb = kb[idx].sum(1) / N
    return tuple(np.percentile(py, [2.5, 97.5])), tuple(np.percentile(pb, [2.5, 97.5]))


def summarize(sel, D, label='', boot=True):
    n = int(sel.sum()); k = int(D['y'][sel].sum()); kb = int(D['buy_lu'][sel].sum())
    days = len(np.unique(D['s'][sel]))
    lo, hi = wilson(k, n)
    r = dict(label=label, n=n, days=days, hits=k, prec=k / n if n else np.nan, w_lo=lo, w_hi=hi,
             buy_hits=kb, buy_prec=kb / n if n else np.nan, cont_share=float(D['lu_s'][sel].mean()) if n else np.nan)
    if boot and n:
        (a, b_), (c, d) = day_block_boot(sel, D)
        r.update(bt_lo=a, bt_hi=b_, bbt_lo=c, bbt_hi=d)
    return r


def fmt(r):
    if not r['n']: return f"{r['label']:<44} n=0"
    s = (f"{r['label']:<44} n={r['n']:>5} 日={r['days']:>3} 命中={r['hits']:>4} 精確 {r['prec'] * 100:5.1f}% "
         f"[W {r['w_lo'] * 100:4.1f}–{r['w_hi'] * 100:4.1f}]")
    if 'bt_lo' in r: s += f" [日boot {r['bt_lo'] * 100:4.1f}–{r['bt_hi'] * 100:4.1f}]"
    s += f" | 可買 {r['buy_prec'] * 100:5.1f}%"
    if 'bbt_lo' in r: s += f" [{r['bbt_lo'] * 100:4.1f}–{r['bbt_hi'] * 100:4.1f}]"
    s += f" | 延續占 {r['cont_share'] * 100:4.1f}%"
    return s


def neg_sample(idx, y, rng, frac=NEG_FRAC):
    pos = idx[y[idx] == 1]; neg = idx[y[idx] == 0]
    return np.sort(np.concatenate([pos, rng.choice(neg, int(len(neg) * frac), replace=False)]))


def fit_gbdt(D, train_rows, seed=0, **over):
    """train_rows：布林遮罩。回傳 (模型, 訓練列數, 正例數)。"""
    rng = np.random.default_rng(1000 + seed)
    y = D['y'].astype(np.int8)
    tr = neg_sample(np.nonzero(train_rows)[0], y, rng)
    m = HistGBDT(**{**GBDT_PARAMS, **over, 'seed': seed}).fit(D['X'][tr], y[tr])
    return m, len(tr), int(y[tr].sum())


def score_rows(m, D, rows, chunk=250000):
    idx = np.nonzero(rows)[0]
    out = np.full(len(D['s']), np.nan, np.float32)
    for a in range(0, len(idx), chunk):
        ii = idx[a:a + chunk]; out[ii] = m.decision_function(D['X'][ii])
    return out
