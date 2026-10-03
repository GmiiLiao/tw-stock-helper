"""A31-D 尾盤五檔視窗共用：視窗資料、設計／報告日切分、門檻選擇、逐週留一（LOWO）。"""
import numpy as np, pandas as pd, os
from a31_bd_lib import load_all, sel_stats, wilson_lb, pooled_auc, day_auc, SP, BD0

DESIGN_FRAC = 0.6
MIN_DESIGN_PICKS = 20


F_EXTRA = ('f_r1', 'f_atr14', 'f_close_pos', 'f_vr5', 'f_day_range', 'f_upper_shadow')


def load_bd_window():
    df, _, _ = load_all(feat=False)
    z = np.load(f'{SP}/dataset_lu1.npz')
    for k in F_EXTRA: df[k] = z[k]
    sc_path = f'{SP}/a31_bd_scores.npz'
    if os.path.exists(sc_path):
        sc = np.load(sc_path)
        for k in sc.files: df[k] = sc[k]
    w = df[df.date >= BD0].copy()
    bdays = np.sort(w.loc[w.x_bd_has == 1, 'date'].unique())
    nd = int(round(len(bdays) * DESIGN_FRAC))
    w = w[w.date.isin(bdays)].copy()
    w['part'] = np.where(w.date.isin(bdays[:nd]), 'design', 'report')
    dt = pd.to_datetime(w.date)
    w['week'] = dt.dt.strftime('%G-W%V')
    # 衍生
    w['qv20'] = w.x_bd_bidlim / w.x_vol20
    w['qval'] = w.x_bd_bidlim * w.x_price / 1e5          # 億元（張×1000×價÷1e8）
    w['log_qv'] = np.log10(w.x_bd_q_v + 1e-3)
    w['log_bidlim'] = np.log10(w.x_bd_bidlim + 1)
    w['bid_v20'] = w.x_bd_bid / w.x_vol20
    w['ask_v20'] = w.x_bd_ask / w.x_vol20
    w['log_bid_v20'] = np.log10(w.bid_v20 + 1e-3)
    w['log_ask_v20'] = np.log10(w.ask_v20 + 1e-3)
    return w, bdays, nd


def choose_threshold(f, y, cand, qs=(0.0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95), min_picks=MIN_DESIGN_PICKS):
    """在候選中依特徵分位數格點選門檻：最大化精準度且選股數 ≥ min_picks。回傳 (θ, prec, picks)。"""
    fv = f[cand]; yv = y[cand]
    best = (np.nan, -1.0, 0)
    for q in qs:
        th = np.nanquantile(fv, q) if len(fv) else np.nan
        m = fv >= th; n = int(m.sum())
        if n < min_picks: continue
        p = yv[m].mean()
        if p > best[1] + 1e-12: best = (float(th), float(p), n)
    return best


def report_row(name, definition, w, sel, nd_design, nd_report, target='m_y'):
    d = w.part.values == 'design'; r = ~d
    sd = sel_stats(sel & d, w[target].values, w.m_buy_lu.values, w.date.values, nd_design)
    sr = sel_stats(sel & r, w[target].values, w.m_buy_lu.values, w.date.values, nd_report)
    return dict(name=name, definition=definition, design_picks=sd['picks'], design_prec=sd['prec'], design_buy=sd['buy_prec'],
                report_picks=sr['picks'], report_hits=sr['hits'], report_prec=sr['prec'], report_lb=sr['wilson_lb'],
                report_buy=sr['buy_prec'], report_days=sr['days_with_pick'], report_ppd=sr['picks_per_day'])


def lowo_threshold(w, fcol, cand, target='m_y', **kw):
    """逐週留一：在其他週選門檻、套到留出週。回傳 (逐週表, 合併精準度, 合併可買精準度, 選股數)。"""
    rows = []; allsel = np.zeros(len(w), bool)
    f = w[fcol].values.astype(float); y = w[target].values
    for wk in sorted(w.week.unique()):
        ho = w.week.values == wk
        th, p_in, n_in = choose_threshold(f, y, cand & ~ho, **kw)
        if not np.isfinite(th): continue
        sel = cand & ho & (f >= th); allsel |= sel
        n = int(sel.sum()); k = int(y[sel].sum()); kb = int(w.m_buy_lu.values[sel].sum())
        rows.append(dict(week=wk, th=th, picks=n, hits=k, prec=(k / n if n else np.nan), buy=(kb / n if n else np.nan)))
    t = pd.DataFrame(rows); n = int(allsel.sum()); k = int(y[allsel].sum())
    return t, (k / n if n else np.nan), (w.m_buy_lu.values[allsel].mean() if n else np.nan), n, wilson_lb(k, n)


def oof_logistic(w, cand, xcols, target='m_y', l2=10.0):
    """逐週留一的邏輯迴歸 out-of-fold 分數（只在 cand 列）。"""
    from models import Logistic
    oof = np.full(len(w), np.nan)
    Xa = w[xcols].values.astype(float); y = w[target].values.astype(float)
    for wk in sorted(w.week.unique()):
        ho = w.week.values == wk
        tr = cand & ~ho; te = cand & ho
        if te.sum() == 0 or y[tr].sum() < 3: continue
        m = Logistic(l2=l2).fit(Xa[tr], y[tr])
        oof[te] = m.decision_function(Xa[te])
    return oof


def boot_auc_diff(s1, s2, y, date, n=1000, seed=7):
    """依日區塊 bootstrap 的 AUC 差（s1−s2）95% 區間。"""
    rng = np.random.default_rng(seed)
    ok = np.isfinite(s1) & np.isfinite(s2)
    s1, s2, y, date = s1[ok], s2[ok], y[ok], date[ok]
    days = np.unique(date); idx_by = {d: np.nonzero(date == d)[0] for d in days}
    diffs = []
    for _ in range(n):
        ii = np.concatenate([idx_by[d] for d in rng.choice(days, len(days))])
        a1, a2 = pooled_auc(s1[ii], y[ii]), pooled_auc(s2[ii], y[ii])
        if np.isfinite(a1) and np.isfinite(a2): diffs.append(a1 - a2)
    return float(pooled_auc(s1, y) - pooled_auc(s2, y)), np.percentile(diffs, [2.5, 97.5])
