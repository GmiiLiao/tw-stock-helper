"""Phase 1 CV 模組的合成資料測試（python3 a36_tracks_cv_test.py 或 pytest -q a36_tracks_cv_test.py）。
涵蓋：日別錨定百分位（向量化版＝逐日參考實作）、池內排名的 NaN 墊底與兩種破同分方向、combo 最少 3 項與重現模式的 0.0、
bootstrap 索引（同 quant.boot_index）、單尾 p、Holm（m＝3）、Mp 閘、挑戰者選擇、C2 滾動窗、T1～T4、判定樹分支、RAND 期望值。
"""
import numpy as np
import pandas as pd

import a36_tracks_decide as DC
import a36_tracks_eval as EV
import a36_tracks_fit as FIT
import a36_tracks_lib as L
import a36_tracks_proxy as PX


def test_anchored_pct_by_day_matches_reference():
    rng = np.random.default_rng(1)
    md = rng.integers(0, 5, 400)
    mv = np.round(rng.normal(size=400), 1)
    mv[rng.random(400) < 0.1] = np.nan
    qd = rng.integers(0, 6, 300)
    qv = np.round(rng.normal(size=300), 1)
    qv[rng.random(300) < 0.1] = np.nan
    got = FIT.anchored_pct_by_day(md, mv, qd, qv)
    for d in range(6):
        exp = L.anchored_pct(qv[qd == d], mv[md == d])
        np.testing.assert_allclose(got[qd == d], exp.astype(np.float32), rtol=0, atol=0, equal_nan=True)


def test_rank_in_day_nan_last_and_tiebreak_direction():
    s = np.array([0, 0, 0, 0, 1, 1])
    v = np.array([1.0, np.nan, 1.0, 0.5, 2.0, 3.0])
    tie = np.array([0.2, 0.9, 0.8, 0.1, 0.5, 0.4])
    reg = PX.rank_in_day(s, v, tie, 'registered')
    assert reg.tolist() == [2, 4, 1, 3, 2, 1]        # 同值 u 大者先；NaN 最後
    rep = PX.rank_in_day(s, v, tie, 'repro')
    assert rep.tolist() == [1, 4, 2, 3, 2, 1]        # 重現模式：亂數小者先（tradability.rank_pool）


def test_combo_min_components_and_repro_zero():
    s = np.zeros(4, int)
    comps = {'atr14': np.array([1.0, 2.0, np.nan, np.nan]), 'n_lu_250': np.array([1.0, 2.0, np.nan, 3.0]),
             'r20': np.array([1.0, np.nan, np.nan, 3.0]), 'c_ma120': np.array([1.0, 2.0, np.nan, np.nan])}
    v, n = PX.combo(s, comps, 'registered')
    assert n.tolist() == [4, 3, 0, 2] and np.isfinite(v[:2]).all() and np.isnan(v[2]) and np.isnan(v[3])
    v2, _ = PX.combo(s, comps, 'repro')
    assert v2[2] == 0.0 and np.isfinite(v2[3])


def test_boot_index_same_as_quant():
    n = 239
    rng = np.random.default_rng(11)
    nb = int(np.ceil(n / 20))
    st = rng.integers(0, n, (2000, nb))
    exp = ((st[:, :, None] + np.arange(20)[None, None, :]).reshape(2000, -1)[:, :n]) % n
    assert np.array_equal(EV.boot_index(n), exp)


def test_p_one_sided_and_holm():
    b = np.array([-0.1, 0.0, 0.1, 0.2])
    assert abs(EV.p_one_sided(b, 0.0) - 3 / 5) < 1e-12 and abs(EV.p_one_sided(b, -0.05) - 2 / 5) < 1e-12
    h = DC.holm({'H_Mp': 1.0, 'H_R': 0.004, 'H_S': 0.02})
    assert abs(h['H_R']['p_adj'] - 0.012) < 1e-12 and h['H_R']['reject']
    assert abs(h['H_S']['p_adj'] - 0.04) < 1e-12 and not h['H_S']['reject'] and not h['H_Mp']['reject']


def test_mp_gate_and_challenger_select():
    ok = dict(dprec_pp=-0.29, dc5_pp=-0.10)
    bad = dict(dprec_pp=-0.31, dc5_pp=0.5)
    assert DC.mp_gate(ok, ok)['carry_to_holdout'] and not DC.mp_gate(ok, bad)['carry_to_holdout']
    sel = {'R1@5': dict(dprec_pp=1.0, dprec_ci_pp=[0.1, 2.0]), 'R2@5': dict(dprec_pp=1.5, dprec_ci_pp=[0.3, 2.5])}
    assert DC.challenger_select('R', sel, {'R1@5': dict(dprec_pp=0.1), 'R2@5': dict(dprec_pp=0.2)})['winner'] == 'R2@5'
    assert DC.challenger_select('R', sel, {'R1@5': dict(dprec_pp=0.1), 'R2@5': dict(dprec_pp=-0.2)})['winner'] == 'R0_combo@5'
    none = {'R1@5': dict(dprec_pp=1.0, dprec_ci_pp=[-0.1, 2.0]), 'R2@5': dict(dprec_pp=1.5, dprec_ci_pp=[0.0, 2.5])}
    assert DC.challenger_select('R', none, {'R1@5': dict(dprec_pp=1.0), 'R2@5': dict(dprec_pp=1.0)})['winner'] == 'R0_combo@5'


def test_c2_rolling():
    picks = np.full(40, 10.0)
    mp = np.zeros(40)
    mp[:20] = 3.0                                   # 前 20 日 30%、全期 15%
    r = DC.c2_check(picks, mp)
    assert r['pass_'] and r['total_share_pct'] == 15.0 and r['max_rolling20_share_pct'] == 30.0
    mp[:20] = 4.0
    assert not DC.c2_check(picks, mp)['pass_']


def test_tradable_tests_and_outcomes():
    lm = {'c5_dk0': dict(daily_mean_pct=0.5, ci_pct=[0.1, 0.9]), 'c10_dk0': dict(daily_mean_pct=0.2, ci_pct=[-0.1, 0.6])}
    pair = {'dc5_dk0_pp': -0.2, 'dc5_dk0_ci_pp': [-0.8, 0.3], 'dc10_dk0_pp': 0.0, 'dc10_dk0_ci_pp': [-1, 1]}
    tt = DC.tradable_tests(lm, pair, {'HO-2023': {'c5': 0.3, 'c10': 0.1}, 'HO-2024': {'c5': 0.4, 'c10': 0.2}})
    assert tt['T1']['horizon'] == 'c5' and tt['all_pass']
    assert DC.track_outcome('R', True, 0.5, tt) == 'R-TRADABLE-SHADOW'
    assert DC.track_outcome('R', False, -0.1, tt) == 'R-REJECT' and DC.track_outcome('R', False, 0.1, tt) == 'R-WATCH-ONLY'
    assert DC.track_outcome('S', True, 0.5, tt, dict(pass_=False)) == 'S-WATCH-ONLY'
    tt2 = DC.tradable_tests(lm, pair, {'HO-2023': {'c5': -0.1, 'c10': 0.1}, 'HO-2024': {'c5': 0.4, 'c10': 0.2}})
    assert not tt2['all_pass'] and DC.track_outcome('S', True, 0.5, tt2, dict(pass_=True)) == 'S-KEEP-AS-SHADOW'
    assert DC.dd_outcome([0.1, 0.5]) == 'DD-SUPPORTED' and DC.dd_outcome([-0.5, -0.1]) == 'DD-CONTRADICTED' and DC.dd_outcome([-0.1, 0.2]) == 'DD-INCONCLUSIVE'


def test_day_vectors_rand_expectation():
    df = pd.DataFrame({'s': [0, 0, 0, 0, 1, 1], 'track_name': ['R'] * 6, 'y': [1, 0, 0, 0, 0, 1], 'buyable': [True] * 6, 'dk': [0.0] * 6,
                       'm_c5': [0.1, -0.1, 0.0, 0.2, 0.05, 0.0], 'm_c10': [np.nan] * 6, 'rk_X': [1, 2, 3, 4, 2, 1]})
    pk = df[df.rk_X <= 2]
    v = EV.day_vectors(df, pk, ('R',), np.array([0, 1, 2]), 2)
    assert v['picks'].tolist() == [2, 2, 0] and v['hits'].tolist() == [1, 1, 0]
    assert np.allclose(v['E'], [1 * 2 / 4, 1 * 2 / 2, 0.0])
    assert np.isclose(v['c5'][0], 0.0) and np.isnan(v['c5'][2]) and np.isnan(v['c10']).all()


if __name__ == '__main__':
    n = 0
    for k, f in list(globals().items()):
        if k.startswith('test_') and callable(f):
            f()
            n += 1
            print('ok', k)
    print(f'{n} 項通過')
