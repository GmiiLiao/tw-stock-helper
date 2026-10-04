"""T1 分軌研究 Phase 1：評估引擎（SEL＋HC 與 HOLDOUT 走同一條程式路徑；登錄 metrics／bootstrap／outputs 各節）。

frame   評估視窗內 M／Mp／R／S／W（與 NE，只供事件分母與 outside）全部列：軌道檔的描述欄＋代理組成項（float64、短歷史 NaN）
        ＋u 雜湊＋名稱／市場／當日 M 列 o_log_mcap 三分位。
scores  M0（G0.5 重擬的各折、三種子平均後轉 float32，同凍結的 official 分數）與新模型（三種子平均）＋u×1e-9。
lists   每份登錄清單在池內每日排名（rank ≤ K 為選股）；RAND＝同池同日期望值（不抽樣）。
metrics precision@K、召回（分母＝視窗內全部 T1 事件）、同日 lift（逐年）、對 RAND 的 Δ、可買精確度、逐日等權 c5／c10、
        DK_s 拆層、Qmax、市場與市值三分位；20 日循環區塊 bootstrap（B＝2000、seed＝11，每個日集合各自重抽、配對比較共用同一組）。
報酬一律未扣成本；逐筆平均只作描述並標「逐筆」。非投資建議。
"""
import hashlib
import json
import os

import numpy as np
import pandas as pd

import a36_tracks_build as BLD
import a36_tracks_fit as FIT
import a36_tracks_lib as L
import a36_tracks_proxy as PX
import cv_official as CVO

BLOCK, NBOOT, BOOT_SEED = 20, 2000, 11
EVAL_TRACKS = ('M', 'Mp', 'R', 'S', 'W')
WIN_ID = {'HO': 1, 'SEL': 2, 'HC': 3}
META = ('m_s', 'm_j', 'm_track', 'm_window', 'm_fold', *[f'k_{k}' for k in L.FAIL_FLAGS], 'k_close', 'k_vol20', 'k_cnt130', 'k_hist_len',
        'k_age_off', 'k_age_cap', 'k_listing_src', 'k_qmax', 'k_R_core', 'k_dk_s', 'k_at_known5', 'k_at_known20', 'm_locked_open', 'm_vol_t',
        'm_buyable', 'm_disp_t_exec', 'm_y', 'm_fBF', 'm_c1', 'm_c5', 'm_c10', 'p_in_pinned_dataset')
KEY_FEATS = ('atr14', 'n_lu_250', 'r20', 'c_ma120', 'vr20', 'days_since_lu', 'dt_ratio20', 'lend_to_v', 'rev_yoy', 'o_turn', 'o_log_mcap', 'o_lu_follow')
# (清單代號, 記錄檔所屬軌, 池, K, 類型, 來源)
LISTS = (
    ('M0@10', 'M', ('M',), 10, 'model', 'M0'),
    ('M0@20', 'M', ('M',), 20, 'model', 'M0'),
    ('M_atr14@5', 'M', ('M',), 5, 'proxy', 'atr14'),
    ('M_combo@5', 'M', ('M',), 5, 'proxy', 'combo'),
    ('M0s@10', 'Mp', ('M',), 10, 'model', 'M0s'),
    ('Mp1@10', 'Mp', ('M', 'Mp'), 10, 'model', 'Mp1'),
    ('Mp1_Monly@10', 'Mp', ('M',), 10, 'model', 'Mp1'),
    ('SFB_atr14@5', 'Mp', ('Mp',), 5, 'proxy', 'atr14'),
    ('R0_combo@5', 'R', ('R',), 5, 'proxy', 'combo'),
    ('R1@5', 'R', ('R',), 5, 'model', 'R1'),
    ('R2@5', 'R', ('R',), 5, 'model', 'R2'),
    ('S0_atr14@5', 'S', ('S',), 5, 'proxy', 'atr14'),
    ('S1@5', 'S', ('S',), 5, 'model', 'S1'),
    ('S2@5', 'S', ('S',), 5, 'model', 'S2'),
    ('W_atr14@3', 'W', ('W',), 3, 'proxy', 'atr14'),
)
LSPEC = {x[0]: dict(track=x[1], pool=x[2], K=x[3], kind=x[4], src=x[5]) for x in LISTS}
TRACK_EVENT_LISTS = {'M': ('M0@10', 'M0s@10', 'Mp1@10'), 'Mp': ('Mp1@10', 'SFB_atr14@5'), 'R': ('R0_combo@5', 'R1@5', 'R2@5'),
                     'S': ('S0_atr14@5', 'S1@5', 'S2@5'), 'W': ('W_atr14@3',)}
TRACK_PICK_LISTS = {'M': ('M0@10', 'M_atr14@5', 'M_combo@5'), 'Mp': ('Mp1@10', 'M0s@10', 'Mp1_Monly@10', 'SFB_atr14@5'),
                    'R': ('R0_combo@5', 'R1@5', 'R2@5'), 'S': ('S0_atr14@5', 'S1@5', 'S2@5'), 'W': ('W_atr14@3',)}
TRADABLE_STATUS = ('可交易（DK_s＝0）', '處置中・交易規則另案登錄（DK_s＝1）', '處置狀態未知（來源缺漏）')
FIXED_LABELS = '未扣成本（成本參考：2.8 折來回約 0.38%、全額約 0.585%）；交易方法狀態未知（全額交割、變更交易方法、停止信用交易的來源未提供）；容量以 s 日 vol20 估計，未模擬開盤競價量與滑價'


# ───────────────────────── bootstrap ─────────────────────────
def boot_index(n: int) -> np.ndarray:
    """quant.boot_index：nb＝ceil(n/20) 個起點均勻抽自 [0, n)，各接 20 日（循環）後截成 n。"""
    rng = np.random.default_rng(BOOT_SEED)
    nb = int(np.ceil(n / BLOCK))
    st = rng.integers(0, n, (NBOOT, nb))
    return ((st[:, :, None] + np.arange(BLOCK)[None, None, :]).reshape(NBOOT, -1)[:, :n]) % n


def ratio_b(num, den, IDX):
    return num[IDX].sum(1) / np.maximum(den[IDX].sum(1), 1e-12)


def mean_b(x, IDX):
    v = np.isfinite(x)
    return np.where(v, x, 0.0)[IDX].sum(1) / np.maximum(v[IDX].sum(1), 1)


def ci(b, scale=100.0, nd=4):
    return [round(float(np.percentile(b, 2.5)) * scale, nd), round(float(np.percentile(b, 97.5)) * scale, nd)]


def p_one_sided(b, delta0=0.0) -> float:
    return float((1 + int((b <= delta0 + 1e-15).sum())) / (len(b) + 1))


def r(x, nd=4):
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


# ───────────────────────── frame ─────────────────────────
def build_frame(I: dict, res: dict, wins: tuple) -> pd.DataFrame:
    fw = FIT.check_feature_windows()
    comps = PX.components(res['A'], res['fl']['lu'])
    ids = [WIN_ID[w] for w in wins]
    parts = []
    for t in EVAL_TRACKS + ('NE',):
        z = np.load(os.path.join(FIT.TRACK_DIR, f'a36_tracks_{t}.npz'))
        keep = np.isin(z['m_window'], ids)
        cols = {k: z[k][keep] for k in META}
        if t != 'NE':
            for f in KEY_FEATS:
                cols[f'f_{f}'] = z[f'f_{f}'][keep].astype(np.float64)
            for lab, f in CVO.SOURCE_FLAGS.items():
                cols[f'has_{f}'] = np.isfinite(z[f'f_{f}'][keep]).astype(np.int8)
        parts.append(pd.DataFrame(cols))
    df = pd.concat(parts, ignore_index=True)
    df = df.rename(columns={c: c[2:] for c in df.columns if c[:2] in ('m_', 'k_') and c not in
                            ('m_locked_open', 'm_vol_t', 'm_buyable', 'm_disp_t_exec', 'm_fBF', 'm_c1', 'm_c5', 'm_c10')})
    df = df.sort_values(['s', 'j']).reset_index(drop=True)
    s, j = df.s.values, df.j.values
    hl = df.hist_len.values.astype(np.float64)
    for c in PX.COMPONENTS:
        df[f'px_{c}'] = np.where(hl < fw[c]['window'], np.nan, comps[c][s, j])
    df['u'] = PX.u_hash(I['dates'], I['codes'], s, j)
    df['track_name'] = np.array(L.TRACKS)[df.track.values]
    df['code'] = np.array(I['codes'])[j]
    df['date_s'] = np.array(I['dates'])[s]
    df['date_t'] = np.array(I['dates'])[np.minimum(s + 1, len(I['dates']) - 1)]
    nm = json.load(open(os.path.join(FIT.B.SP, 'names.json')))
    df['name'] = df.code.map(lambda c: nm.get(c, ''))
    df['market'] = np.array(I['mkt'])[j]
    df['year'] = df.date_s.str[:4]
    df['buyable'] = df.m_buyable.values == 1
    df['dk'] = df.dk_s.values
    df['listing'] = np.array(L.LISTING_SRC)[df.listing_src.values]
    df['mcap_tier'] = mcap_tiers(df)
    df['ne'] = df.track_name.str.startswith('NE_')
    return df


def mcap_tiers(df) -> np.ndarray:
    """市值三分位：以當日 M 列 o_log_mcap 的 1/3、2/3 分位數定界（描述用）；o_log_mcap 缺值記 unknown。"""
    m = df[df.track_name == 'M'].groupby('s').f_o_log_mcap.quantile([1 / 3, 2 / 3]).unstack()
    q1 = df.s.map(m[1 / 3]).values
    q2 = df.s.map(m[2 / 3]).values
    x = df.f_o_log_mcap.values
    with np.errstate(invalid='ignore'):
        return np.where(~np.isfinite(x) | ~np.isfinite(q1), 'unknown', np.where(x < q1, 'small', np.where(x < q2, 'mid', 'large')))


def row_keys(df, ncodes):
    return df.s.values.astype(np.int64) * ncodes + df.j.values


def model_scores(df, reg, model, wins, ncodes) -> np.ndarray:
    """三種子平均（M0：((z0+z1)+z2)/3 後轉 float32，等於凍結 official 分數）；未評分列 NaN。"""
    keys = row_keys(df, ncodes)
    z = [np.full(len(df), np.nan) for _ in FIT.SEEDS]
    for f, ts, te in FIT.folds(reg, list(np.load(os.path.join(FIT.TRACK_DIR, 'a36_tracks_M.npz'))['dates']), wins):
        for sd in FIT.SEEDS:
            p = FIT.ckpt_path(model, f, sd)
            if not os.path.exists(p):
                raise SystemExit(f'缺擬合檢查點 {os.path.basename(p)}：先跑 a36_tracks_fit.py run')
            c = np.load(p)
            for ss, jj, sc in ((c['s'], c['j'], c['score']),) + (((c['bf_s'], c['bf_j'], c['bf_score']),) if model == 'M0' else ()):
                k = ss.astype(np.int64) * ncodes + jj
                ix = np.searchsorted(keys, k)
                ok = (ix < len(keys)) & (keys[np.minimum(ix, len(keys) - 1)] == k)
                z[sd][ix[ok]] = sc[ok]
    out = ((z[0] + z[1]) + z[2]) / 3
    return out.astype(np.float32).astype(np.float64) if model == 'M0' else out


# ───────────────────────── 排名 ─────────────────────────
def rank_lists(df, scores: dict, lists) -> None:
    """每份清單的池內每日名次 rk_{清單}、分數 sc_{清單}、combo 項數 nc_{清單}（池外 NaN）。"""
    for lid in lists:
        sp = LSPEC[lid]
        pool = df.track_name.isin(sp['pool']).values
        sub = df[pool]
        s = sub.s.values
        nc = np.full(len(sub), np.nan)
        if sp['kind'] == 'model':
            v = scores[sp['src']][pool] + sub.u.values * 1e-9
        else:
            v, n_ok = PX.proxy_scores(s, {c: sub[f'px_{c}'].values for c in PX.COMPONENTS}, sp['src'], 'registered')
            if n_ok is not None:
                nc = n_ok.astype(np.float64)
        rk = PX.rank_in_day(s, v, sub.u.values, 'registered')
        for col, val in ((f'rk_{lid}', rk.astype(np.float64)), (f'sc_{lid}', v), (f'nc_{lid}', nc)):
            arr = np.full(len(df), np.nan)
            arr[pool] = val
            df[col] = arr
    allp = df.track_name.isin(EVAL_TRACKS).values
    sub = df[allp]
    v, n_ok = PX.proxy_scores(sub.s.values, {c: sub[f'px_{c}'].values for c in PX.COMPONENTS}, 'combo', 'registered')
    g = np.full(len(df), np.nan)
    g[allp] = PX.rank_in_day(sub.s.values, v, sub.u.values, 'registered')
    df['global_rank_combo'] = g


def picks_of(df, lid, K=None):
    K = LSPEC[lid]['K'] if K is None else K
    return df[df[f'rk_{lid}'] <= K]


# ───────────────────────── 逐日向量 ─────────────────────────
def by_day(series_by_s, days, fill=0.0):
    return series_by_s.reindex(days).fillna(fill).values.astype(np.float64) if fill is not None else series_by_s.reindex(days).values.astype(np.float64)


def daily_mean(g, col, days):
    x = g[np.isfinite(g[col].values)]
    return by_day(x.groupby('s')[col].mean(), days, fill=None)


def day_vectors(df, pk, pool_tracks, days, K) -> dict:
    """單一清單在 days 上的逐日量（pk＝選股列；池＝pool_tracks 的列）。RAND：picks_s＝min(K, n_s)、E[hits_s]＝事件數×picks_s÷n_s。"""
    pool = df[df.track_name.isin(pool_tracks)]
    n_pool = by_day(pool.groupby('s').size(), days)
    ev_pool = by_day(pool.groupby('s').y.sum(), days)
    picks = by_day(pk.groupby('s').size(), days)
    hits = by_day(pk.groupby('s').y.sum(), days)
    assert np.array_equal(picks, np.minimum(n_pool, K)), '選股數 ≠ min(K, 池列數)'
    with np.errstate(invalid='ignore', divide='ignore'):
        E = np.where(n_pool > 0, ev_pool * picks / np.maximum(n_pool, 1), 0.0)
    b = pk[pk.buyable]
    b0, b1 = b[b.dk == 0], b[b.dk == 1]
    pb = pool[pool.buyable]
    v = dict(n_pool=n_pool, ev_pool=ev_pool, picks=picks, hits=hits, E=E, bpicks=by_day(b.groupby('s').size(), days),
             bhits=by_day(b.groupby('s').y.sum(), days), pool_c5=daily_mean(pb, 'm_c5', days))
    for h in ('c5', 'c10'):
        v[h] = daily_mean(b, f'm_{h}', days)
        v[f'{h}_dk0'] = daily_mean(b0, f'm_{h}', days)
        v[f'{h}_dk1'] = daily_mean(b1, f'm_{h}', days)
    return v


def sub_vec(v, ix):
    return {k: a[ix] for k, a in v.items()}


# ───────────────────────── 指標 ─────────────────────────
def ret_block(x, IDX) -> dict:
    ok = np.isfinite(x)
    if not ok.any():
        return dict(daily_mean_pct=None, ci_pct=None, n_days=0)
    b = mean_b(x, IDX)
    return dict(daily_mean_pct=r(np.nanmean(x) * 100), ci_pct=ci(b), median_daily_pct=r(np.nanmedian(x) * 100),
                win_days_pct=r(float((x[ok] > 0).mean()) * 100, 2), n_days=int(ok.sum()))


def per_pick(x) -> dict:
    x = x[np.isfinite(x)]
    if not len(x):
        return dict(n=0)
    return dict(n=int(len(x)), mean_pct=r(x.mean() * 100), median_pct=r(np.median(x) * 100), win_pct=r((x > 0).mean() * 100, 2))


def split_table(pk, col) -> dict:
    out = {}
    for k, g in pk.groupby(col):
        b = g[g.buyable & np.isfinite(g.m_c5.values)]
        d5 = b.groupby('s').m_c5.mean()
        out[str(k)] = dict(picks=int(len(g)), hits=int(g.y.sum()), precision_pct=r(g.y.mean() * 100),
                           c5_daily_mean_pct=r(d5.mean() * 100) if len(d5) else None, c5_days=int(len(d5)))
    return out


def list_metrics(lid, v, pk, IDX, n_all_events, year_vectors) -> dict:
    P, H, E = v['picks'].sum(), v['hits'].sum(), v['E'].sum()
    bp, br = ratio_b(v['hits'], v['picks'], IDX), ratio_b(v['E'], v['picks'], IDX)
    out = dict(K=LSPEC[lid]['K'], days=len(v['picks']), picks=int(P), hits=int(H), precision_pct=r(H / max(P, 1) * 100), precision_ci_pct=ci(bp),
               recall_all_events_pct=r(H / max(n_all_events, 1) * 100), n_all_events=int(n_all_events),
               rand_expected_hits=r(E, 3), rand_precision_pct=r(E / max(P, 1) * 100),
               lift=r(H / E if E > 0 else np.nan, 3), lift_ci=ci(ratio_b(v['hits'], v['E'], IDX), 1, 3),
               delta_vs_rand_pp=r((H - E) / max(P, 1) * 100), delta_vs_rand_ci_pp=ci(bp - br), p_vs_rand=r(p_one_sided(bp - br), 5),
               buyable_picks=int(v['bpicks'].sum()), buyable_hits=int(v['bhits'].sum()),
               buyable_precision_pct=r(v['bhits'].sum() / max(v['bpicks'].sum(), 1) * 100),
               lift_by_year={y: dict(hits=int(yv['hits'].sum()), rand_expected=r(yv['E'].sum(), 3),
                                     lift=r(yv['hits'].sum() / yv['E'].sum() if yv['E'].sum() > 0 else np.nan, 3),
                                     delta_vs_rand_pp=r((yv['hits'].sum() - yv['E'].sum()) / max(yv['picks'].sum(), 1) * 100)) for y, yv in year_vectors.items()})
    b = pk[pk.buyable]
    for h in ('c5', 'c10'):
        out[f'{h}_all_buyable'] = ret_block(v[h], IDX) | {'per_pick_逐筆_描述': per_pick(b[f'm_{h}'].values)}
        out[f'{h}_dk0'] = ret_block(v[f'{h}_dk0'], IDX)
        out[f'{h}_dk1'] = ret_block(v[f'{h}_dk1'], IDX)
    exc = v['c5'] - v['pool_c5']
    out['c5_excess_vs_pool'] = ret_block(exc, IDX)
    q = pk.qmax.values
    out['liquidity'] = dict(qmax_median=r(np.nanmedian(q), 1) if np.isfinite(q).any() else None,
                            share_qmax_ge2_pct=r(float((q >= 2).mean()) * 100, 2) if np.isfinite(q).any() else None,
                            share_qmax_eq0_pct=r(float((q == 0).mean()) * 100, 2) if np.isfinite(q).any() else None,
                            share_qmax_unknown_pct=r(float((~np.isfinite(q)).mean()) * 100, 2), median_vol20=r(np.nanmedian(pk.vol20.values), 1))
    out['disposal'] = dict(share_dk1_pct=r(float((pk.dk == 1).mean()) * 100, 2), share_dk_unknown_pct=r(float(pk.dk.isna().mean()) * 100, 2),
                           n_dk_unknown=int(pk.dk.isna().sum()), share_disp_t_exec_pct=r(float((pk.m_disp_t_exec == 1).mean()) * 100, 2),
                           precision_dk1_pct=r(pk[pk.dk == 1].y.mean() * 100) if (pk.dk == 1).any() else None,
                           precision_dk0_pct=r(pk[pk.dk == 0].y.mean() * 100) if (pk.dk == 0).any() else None)
    out['by_market'] = split_table(pk, 'market')
    out['by_mcap_tier'] = split_table(pk, 'mcap_tier')
    out['by_track_of_pick'] = split_table(pk, 'track_name')
    nc = pk[f'nc_{lid}'].values
    if np.isfinite(nc).any():
        out['combo_only3_components_share_pct'] = r(float((nc == 3).mean()) * 100, 2)
    out['short_history_hist_len_lt125'] = dict(share_pct=r(float((pk.hist_len < 125).mean()) * 100, 2),
                                               precision_pct=r(pk[pk.hist_len < 125].y.mean() * 100) if (pk.hist_len < 125).any() else None)
    return out


def paired(vA, vB, IDX) -> dict:
    """A−B：Δprecision（同一組重抽日）、Δc5／Δc10 逐日（只取兩邊都有值的日子）、單尾 p（δ0＝0）。"""
    bA, bB = ratio_b(vA['hits'], vA['picks'], IDX), ratio_b(vB['hits'], vB['picks'], IDX)
    d = bA - bB
    pt = vA['hits'].sum() / max(vA['picks'].sum(), 1) - vB['hits'].sum() / max(vB['picks'].sum(), 1)
    out = dict(dprec_pp=r(pt * 100), dprec_ci_pp=ci(d), p_dprec_gt0=r(p_one_sided(d), 5), _boot_dprec=d)
    for h in ('c5', 'c10', 'c5_dk0', 'c10_dk0'):
        x = vA[h] - vB[h]
        b = mean_b(x, IDX)
        out[f'd{h}_pp'] = r(np.nanmean(x) * 100) if np.isfinite(x).any() else None
        out[f'd{h}_ci_pp'] = ci(b) if np.isfinite(x).any() else None
        out[f'd{h}_paired_days'] = int(np.isfinite(x).sum())
        out[f'_boot_d{h}'] = b
    return out


def public(d: dict) -> dict:
    return {k: v for k, v in d.items() if not k.startswith('_')}


# ───────────────────────── 記錄 ─────────────────────────
def key_pct(df, rows) -> list:
    """關鍵特徵（原值）以當日 M 列錨定的百分位（描述用）。"""
    m = df[df.track_name == 'M']
    out = {}
    for f in KEY_FEATS:
        out[f] = FIT.anchored_pct_by_day(m.s.values, m[f'f_{f}'].values, rows.s.values, rows[f'f_{f}'].values)
    return ['|'.join(f'{f}={x:.3f}' if np.isfinite(x) else f'{f}=NaN' for f, x in zip(KEY_FEATS, vals)) for vals in zip(*[out[f] for f in KEY_FEATS])]


def src_flags(rows) -> list:
    labs = list(CVO.SOURCE_FLAGS.items())
    return ['|'.join(f'{lab}={int(v)}' for (lab, _), v in zip(labs, vals)) for vals in zip(*[rows[f'has_{f}'].values for _, f in labs])]


def tradable_status(dk):
    return np.where(dk == 0, TRADABLE_STATUS[0], np.where(dk == 1, TRADABLE_STATUS[1], TRADABLE_STATUS[2]))


def failing(rows):
    return ['|'.join(k for k in L.FAIL_FLAGS if row[k]) + ('|fBF(前視·描述)' if row['m_fBF'] else '') for _, row in rows[list(L.FAIL_FLAGS) + ['m_fBF']].iterrows()]


def fmt_pct(x):
    return np.round(x * 100, 3)


def event_records(df, track, lists, win_name) -> pd.DataFrame:
    ev = df[(df.track_name == track) & (df.y == 1)].copy()
    if ev.empty:
        return pd.DataFrame()
    ev['pct_key_features'] = key_pct(df, ev)
    ev['source_has_value_flags'] = src_flags(ev)
    ev['failing_filters'] = failing(ev)
    rows = []
    for lid in lists:
        if f'rk_{lid}' not in df:
            continue
        K = LSPEC[lid]['K']
        n_pool = df[df.track_name.isin(LSPEC[lid]['pool'])].groupby('s').size()
        x = pd.DataFrame({
            'window': win_name(ev), 'fold': ev.fold.values + 1, 'date_s': ev.date_s.values, 'event_day_t': ev.date_t.values, 'code': ev.code.values,
            'name': ev.name.values, 'market': ev.market.values, 'track': track,
            'sublayer': np.where(ev.R_core.values == 1, 'R_core', np.where(ev.track_name.values == 'R', 'R_relax', '')),
            'failing_filters': ev.failing_filters.values, 'list_id': lid, 'rank_in_list': ev[f'rk_{lid}'].values.astype(int),
            'n_pool_day': ev.s.map(n_pool).values, 'result': np.where(ev[f'rk_{lid}'].values <= K, '命中', '漏網'),
            'global_rank_combo': ev.global_rank_combo.values.astype(int), 'score': np.round(ev[f'sc_{lid}'].values, 6),
            'combo_n_components': ev[f'nc_{lid}'].values, 'pct_key_features': ev.pct_key_features.values,
            'source_has_value_flags': ev.source_has_value_flags.values, 'hist_len': ev.hist_len.values, 'age_off': ev.age_off.values,
            'age_cap': ev.age_cap.values, 'listing_src': ev.listing.values, 'vol20_s': np.round(ev.vol20.values, 2), 'Qmax_lots': ev.qmax.values,
            'DK_s': ev.dk.values, 'at_known5': ev.at_known5.values, 'm_locked_open': ev.m_locked_open.values, 'm_buyable': ev.m_buyable.values,
            'm_c1': fmt_pct(ev.m_c1.values), 'm_c5': fmt_pct(ev.m_c5.values), 'm_c10': fmt_pct(ev.m_c10.values), 'm_vol_t': ev.m_vol_t.values,
            'm_disp_t_exec': ev.m_disp_t_exec.values, 'note': L.NOTE})
        rows.append(x)
    return pd.concat(rows, ignore_index=True)


def qmax_rule(pk) -> np.ndarray:
    tn, dk = pk.track_name.values, pk.dk.values
    return np.where(tn == 'S', 'floor(1%×vol20)', np.where(tn == 'W', '不適用', np.where(
        (tn == 'R') & (dk == 1), 'floor(1%×vol20)（R 處置中減半）', np.where((tn == 'R') & ~np.isfinite(dk), 'NaN（R 的 DK_s 未知）', 'floor(2%×vol20)'))))


def pick_records(df, track, lists, win_name) -> pd.DataFrame:
    rows = []
    for lid in lists:
        if f'rk_{lid}' not in df:
            continue
        pk = picks_of(df, lid)
        n_pool = df[df.track_name.isin(LSPEC[lid]['pool'])].groupby('s').size()
        lab = FIXED_LABELS + ('；容量受限' if track == 'S' or lid.startswith('S') else '') + ('；不可交易，僅觀察' if track == 'W' else '')
        rows.append(pd.DataFrame({
            'window': win_name(pk), 'fold': pk.fold.values + 1, 'date_s': pk.date_s.values, 'trade_day_t': pk.date_t.values, 'code': pk.code.values,
            'name': pk.name.values, 'market': pk.market.values, 'track': pk.track_name.values, 'list_id': lid, 'rank': pk[f'rk_{lid}'].values.astype(int),
            'n_pool_day': pk.s.map(n_pool).values, 'score': np.round(pk[f'sc_{lid}'].values, 6), 'combo_n_components': pk[f'nc_{lid}'].values,
            'y': pk.y.values, 'm_locked_open': pk.m_locked_open.values, 'm_buyable': pk.m_buyable.values, 'm_c1': fmt_pct(pk.m_c1.values),
            'm_c5': fmt_pct(pk.m_c5.values), 'm_c10': fmt_pct(pk.m_c10.values), 'vol20_s': np.round(pk.vol20.values, 2), 'Qmax_lots': pk.qmax.values,
            'Qmax_rule': qmax_rule(pk), 'DK_s': pk.dk.values, 'at_known5': pk.at_known5.values, 'hist_len': pk.hist_len.values,
            'age_off': pk.age_off.values, 'age_cap': pk.age_cap.values, 'listing_src': pk.listing.values, 'mcap_tier': pk.mcap_tier.values,
            'm_vol_t': pk.m_vol_t.values, 'm_disp_t_exec': pk.m_disp_t_exec.values, 'tradable_status': tradable_status(pk.dk.values),
            'labels': lab, 'note': L.NOTE}))
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()


def csv_bytes(frame: pd.DataFrame) -> bytes:
    return frame.to_csv(index=False).encode('utf-8')


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()
