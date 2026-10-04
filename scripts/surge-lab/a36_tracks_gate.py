"""T1 分軌研究：進入 SELECTION 前的兩道閘門（登錄 decision_tree.G0 的 G0.5 與 G0.9）。

G0.5  以相同協定與種子重擬 M0（a36_tracks_fit.py run --models M0 --windows SEL,HC 的檢查點），official 分數與
      SURGE_CACHE/a36_ref_official_cv_scores_t1L.npz 逐位相同（np.array_equal、含 NaN 位置）；cv_official 破同分口徑下
      SEL+HC 前 10 命中＝122／選股 4,150；另報雜湊破同分的結果；並報只卡 brk_future 的列的補分。
G0.9  a36 代理程式（a36_tracks_proxy）切到重現模式（不套短歷史 NaN、combo 照 quant 的 0.0、default_rng(7) 破同分、tiers 池），
      在 SEL+HC 上逐數重現 review_years.json 所有 R|、B| 鍵（atr14／combo、K＝3／5／10、2025／2026，及兩個 Qmax1pct 鍵），
      aadab48f 與基底兩版漲停判定各跑一次，至少一版逐數相同並記下是哪一版；兩版都不符＝G0-STOP。
輸出：SURGE_CACHE/tracks/a36_report_gate.json 與 out/tracks_t1/tracks_t1_G0_gate.json。未扣成本·非投資建議。
"""
import json
import os
import time

import numpy as np
import pandas as pd

import a36_tracks_build as BLD
import a36_tracks_fit as FIT
import a36_tracks_lib as L
import a36_tracks_proxy as PX
import build as B
import cv_official as CVO

REVIEW_YEARS = os.path.join(L.MAIN_REPO, 'scripts/surge-lab/out/smallcap_20261004/review_years.json')
N_TEST_DAYS = 415


def fwd(X, k):
    out = np.full(X.shape, np.nan)
    out[:-k] = X[k:]
    return out


# ───────────────────────── G0.5 ─────────────────────────
def g05(reg) -> dict:
    D, R, cols = FIT.m0_data()
    dates = D['dates']
    n = len(D['s'])
    z = [np.full(n, np.nan) for _ in FIT.SEEDS]
    bf = {}
    for f, ts, te in FIT.folds(reg, dates, ['SEL', 'HC']):
        for sd in FIT.SEEDS:
            c = np.load(FIT.ckpt_path('M0', f, sd))
            z[sd][c['row']] = c['score']
            for a, b, v in zip(c['bf_s'], c['bf_j'], c['bf_score']):
                bf.setdefault((int(a), int(b)), [None] * len(FIT.SEEDS))[sd] = float(v)
    sc = (((z[0] + z[1]) + z[2]) / 3).astype(np.float32)
    ref = np.load(os.path.join(B.SP, 'a36_ref_official_cv_scores_t1L.npz'))['official']
    equal = bool(np.array_equal(sc, ref, equal_nan=True))
    test = np.isfinite(sc) & ~D['extra'] & ~D['tdr']
    st = CVO.day_stats(sc[test], D['s'][test], D['y'][test], 10)
    ti = np.nonzero(test)[0]
    u = PX.u_hash(dates, D['codes'], D['s'][ti], D['j'][ti])
    rk = PX.rank_in_day(D['s'][ti], sc[ti].astype(np.float64) + u * 1e-9, u, 'registered')
    top = rk <= 10
    bf_rows = [dict(date=dates[a], code=D['codes'][b], score=((v[0] + v[1]) + v[2]) / 3) for (a, b), v in sorted(bf.items())]
    out = dict(bit_equal_official=equal, nan_positions_equal=bool(np.array_equal(np.isnan(sc), np.isnan(ref))),
               cv_official_tiebreak=dict(hits=int(st.hit.sum()), picks=int(st.n.sum()), test_rows=int(test.sum()), events=int(D['y'][test].sum())),
               hash_tiebreak=dict(hits=int(D['y'][ti][top].sum()), picks=int(top.sum())),
               brk_future_only_rows_scored_selhc=bf_rows)
    out['pass'] = equal and out['cv_official_tiebreak']['hits'] == 122 and out['cv_official_tiebreak']['picks'] == 4150
    return out


# ───────────────────────── G0.9 ─────────────────────────
def quant_frame(I, res, bmod) -> pd.DataFrame:
    """quant.build_frame＋tradability.add_exec_fields 中 review_years 用到的欄位（SEL+HC 415 日、s 有收盤、s 未漲停、非 TDR；(s, j) 列優先順序）。"""
    P = I['P']
    T, N = P['C'].shape
    win = res['cal']['window']
    days = np.nonzero((win == 2) | (win == 3))[0]
    assert len(days) == N_TEST_DAYS, len(days)
    LU = res['fl']['lu']
    cand = np.zeros((T, N), bool)
    cand[days] = True
    cand &= np.isfinite(P['C']) & ~LU & ~res['tdr'][None, :]
    si, ji = np.nonzero(cand)
    comps = PX.components(res['A'], LU)
    nxt = np.minimum(np.arange(T) + 1, T - 1)
    with np.errstate(invalid='ignore'):
        lim_rule = bmod.limit_up_price(bmod.round_tick(P['C'] * res['F_day'][nxt]))
        u1 = bmod.official_limit_up(T, N)[nxt]
        lim = np.where(np.isfinite(u1) & (u1 > 0) & (u1 < 9000), u1, lim_rule)      # quant.locked_open 原式
        opn = P['O'][nxt]
        lock = np.isfinite(opn) & (opn >= lim - 1e-9)
        c5 = fwd(res['A']['C'], 5) / fwd(res['A']['O'], 1) - 1
    fl = res['fl']
    df = pd.DataFrame({'s': si, 'j': ji, 'y': fl['y'][si, ji].astype(np.int8), 'vol20': fl['vol20'][si, ji], 'cnt130': fl['cnt130'][si, ji],
                       'fM': fl['nan20'][si, ji] > 0, 'fBp': fl['brk_past'][si, ji], 'fC': fl['cool1'][si, ji],
                       'c5': c5[si, ji], 'buyable': np.isfinite(opn[si, ji]) & ~lock[si, ji],
                       'disp_s': res['da']['feats']['dk_s'][si, ji] == 1, 'year': np.array([I['dates'][t][:4] for t in si])})
    for k, v in comps.items():
        df[k] = v[si, ji]
    with np.errstate(invalid='ignore'):
        clean = ~df.fM & ~df.fBp & (df.cnt130 >= 60)
        v = df.vol20
        tier = np.full(len(df), 'W', dtype=object)
        tier[(clean & df.fC & (v >= 300)).values] = 'R'
        tier[(clean & ~df.fC & (v >= 300)).values] = 'A'
        tier[(clean & ~df.fC & (v >= 100) & (v < 300)).values] = 'B'
    df['ptier'] = tier
    return df


def review_entries(df) -> dict:
    """review_years.py 的 R／B 鍵（同捨入）；排名用 a36_tracks_proxy 的重現模式。"""
    noise = np.random.default_rng(7).random(len(df))
    out = {}
    for t in ('R', 'B'):
        pool = (df.ptier.values == t)
        g0 = df[pool]
        s = g0.s.values
        for p in ('atr14', 'combo'):
            v, _ = PX.proxy_scores(s, {k: g0[k].values for k in PX.COMPONENTS}, p, 'repro')
            rk = PX.rank_in_day(s, v, noise[pool], 'repro')
            for K in (3, 5, 10):
                picks = g0[rk <= K]
                for y, g in picks.groupby('year'):
                    b = g[g.buyable]
                    d5 = b.groupby('s').c5.mean()
                    out[f'{t}|{p}@{K}|{y}'] = dict(
                        picks=int(len(g)), hits=int(g.y.sum()), prec=round(float(g.y.mean() * 100), 3),
                        base=round(float(df[(df.ptier == t) & (df.year == y)].y.mean() * 100), 3), c5_daily=round(float(d5.mean() * 100), 2),
                        c5_disp_s_daily=round(float(b[b.disp_s].groupby('s').c5.mean().mean() * 100), 2) if b.disp_s.any() else None,
                        c5_nodisp_s_daily=round(float(b[~b.disp_s].groupby('s').c5.mean().mean() * 100), 2),
                        disp_s_share=round(float(g.disp_s.mean() * 100), 1))
                if t == 'B' and K == 5:
                    q = np.floor(0.01 * picks.vol20.values)
                    out[f'B|{p}@5|Qmax1pct'] = dict(median=float(np.nanmedian(q)), share_eq0=round(float((q < 1).mean() * 100), 1),
                                                    share_le1=round(float((q <= 1).mean() * 100), 1), med_vol20=float(np.nanmedian(picks.vol20.values)))
    return out


def compare(mine: dict, ref: dict) -> dict:
    keys = sorted(k for k in ref if k[:2] in ('R|', 'B|'))
    diffs = []
    for k in keys:
        a = mine.get(k)
        for f, v in ref[k].items():
            if a is None or a.get(f) != v:
                diffs.append(dict(key=k, field=f, review_years=v, a36=None if a is None else a.get(f)))
    return dict(n_keys=len(keys), n_fields=sum(len(ref[k]) for k in keys), n_diff=len(diffs), diffs=diffs[:60], pass_=not diffs)


def g09(I) -> dict:
    ref = json.load(open(REVIEW_YEARS, encoding='utf-8'))
    out = {'review_years_sha256': L.file_sha256(REVIEW_YEARS)}
    old, old_sha = L.load_old_build()
    for ver in ('aadab48f', 'base'):
        t0 = time.time()
        if ver == 'aadab48f':
            with L._patched(B, 'build_events', old.build_events):
                res = BLD.compute(I, with_features=False)
            bmod = old
        else:
            res = BLD.compute(I, with_features=False)
            bmod = B
        df = quant_frame(I, res, bmod)
        mine = review_entries(df)
        out[ver] = compare(mine, ref) | dict(frame_rows=int(len(df)), tier_rows=df.ptier.value_counts().to_dict(), runtime_s=round(time.time() - t0, 1),
                                             entries=mine)
        BLD.log(f'G0.9 {ver}：{out[ver]["n_diff"]} 欄不同（{out[ver]["n_fields"]} 欄）')
    out['aadab48f_build_py_sha256'] = old_sha
    out['reproduced_by'] = [v for v in ('aadab48f', 'base') if out[v]['pass_']]
    out['pass'] = bool(out['reproduced_by'])
    return out


def stage_gate():
    t0 = time.time()
    I = BLD.load_inputs()
    FIT.check_feature_windows()
    r05 = g05(I['reg'])
    BLD.log(f'G0.5：逐位相同 {r05["bit_equal_official"]}、cv_official 破同分 {r05["cv_official_tiebreak"]}、雜湊破同分 {r05["hash_tiebreak"]}')
    r09 = g09(I)
    rep = dict(registration=L.REG_SHA256, G0_5=r05, G0_9={k: ({kk: vv for kk, vv in v.items() if kk != 'entries'} if isinstance(v, dict) else v)
                                                       for k, v in r09.items()},
               runtime_s=round(time.time() - t0, 1), note=L.NOTE)
    BLD.jdump(dict(rep, G0_9_entries={v: r09[v]['entries'] for v in ('aadab48f', 'base')}), os.path.join(BLD.CACHE_DIR, 'a36_report_gate.json'))
    BLD.jdump(rep, os.path.join(BLD.OUT_DIR, 'tracks_t1_G0_gate.json'))
    print(json.dumps(dict(G0_5=r05['pass'], G0_9=r09['pass'], reproduced_by=r09['reproduced_by']), ensure_ascii=False))


if __name__ == '__main__':
    stage_gate()
