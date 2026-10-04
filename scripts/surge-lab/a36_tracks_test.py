"""a36_tracks_lib 的合成資料測試（python3 a36_tracks_test.py 或 pytest -q a36_tracks_test.py）。
涵蓋：上市日四條規則、R 專用特徵（段尾只認已結束、窗外截斷、找不到時的 0／251／NaN）、分區互斥窮盡與優先序、Qmax、窗長表解析
（含 DEV-001 補列與未知特徵 assert）、錨定百分位、短歷史 NaN 規則、R 特徵截斷不變。
"""
import numpy as np

import a36_tracks_lib as L


def test_listing_rules():
    dates = ['2022-07-18', '2022-07-19', '2022-07-20', '2022-07-21', '2022-07-22']
    codes = ['1111', '2222', '3333', '4444', '5555', '6666']
    C = np.full((5, 6), np.nan)
    C[:, 0] = 10                      # 快照：面板前上市
    C[2:, 1] = 10                     # 快照：面板內上市，首收＝上市日
    C[1:, 2] = 10                     # 快照：上市日 07-21，首收較早（轉市場）
    C[:3, 3] = 10                     # 不在快照，首收在面板起點
    C[3:, 4] = 10                     # 不在快照，首收在面板中途
    snaps = {'1111': ('TWSE', '1990-01-01'), '2222': ('TPEx', '2022-07-20'), '3333': ('TWSE', '2022-07-21')}
    r = L.listing_info(dates, codes, C, snaps)
    src = [L.LISTING_SRC[k] for k in r['listing_src']]
    assert src == ['official_prepanel', 'official', 'transfer_min', 'fallback_prepanel', 'fallback_first_close', 'no_close']
    assert r['first_trade'][0] == -np.inf and r['first_trade'][1] == 2 and r['first_trade'][2] == 1
    assert r['first_trade'][3] == -np.inf and r['first_trade'][4] == 3 and r['first_trade'][5] == np.inf
    assert r['last_close'].tolist() == [4, 4, 4, 2, 4, -1]
    ag = L.ages(5, r['first_trade'])
    assert ag['age_off'][4, 0] == np.inf and ag['age_cap'][4, 0] == 250 and ag['hist_len'][4, 0] == 5
    assert ag['age_off'][4, 1] == 3 and ag['age_cap'][4, 1] == 3 and ag['hist_len'][4, 1] == 3


def _rfeat(lu_days, T=30, hist=300):
    LU = np.zeros((T, 1), bool)
    LU[lu_days, 0] = True
    Ca = np.cumprod(np.where(LU, 1.1, 1.0), axis=0) * 10
    Caprev = np.vstack([[np.nan], Ca[:-1]])
    return L.r_features(LU, Ca, Caprev, Ca.copy(), np.full((T, 1), float(hist)))


def test_r_features_completed_segment_only():
    r = _rfeat([10, 11, 12])                    # 段 10..12，段尾 12；s=13 起才算已結束（LU[13]＝否在 s=13 才知道）
    assert np.isnan(r['r_seg_gain'][12, 0]) and r['r_seg_len'][12, 0] == 0 and r['r_days_since_seg_end'][12, 0] == 251
    assert r['r_seg_len'][13, 0] == 3 and r['r_days_since_seg_end'][13, 0] == 1
    assert abs(r['r_seg_gain'][13, 0] - (1.1 ** 3 - 1)) < 1e-12
    assert r['r_n_seg_250'][11, 0] == 1           # 起點 10 在 s=11 收盤時已確認 ≥2（LU[11] 已知）⇒ 窗 [s−250, s−1] 計入
    assert r['r_n_seg_250'][10, 0] == 0           # s=10 時 LU[11] 未知


def test_r_features_single_lu_and_short_history():
    r = _rfeat([5])                               # 單日漲停不是 ≥2 連板段
    assert r['r_seg_len'][20, 0] == 0 and r['r_n_seg_250'][20, 0] == 0
    r2 = _rfeat([5], hist=100)                    # 找不到且 hist_len < 250 ⇒ NaN
    assert np.isnan(r2['r_seg_len'][20, 0]) and np.isnan(r2['r_days_since_seg_end'][20, 0])


def test_r_features_window_cutoff():
    T = 300
    r = _rfeat([10, 11], T=T)                     # 段尾 11；s−250 > 11 ⇒ 窗外
    assert r['r_seg_len'][261, 0] == 2 and r['r_seg_len'][262, 0] == 0 and r['r_days_since_seg_end'][262, 0] == 251


def test_r_features_truncation_invariant():
    rng = np.random.default_rng(3)
    LU = rng.random((120, 4)) < 0.15
    Ca = np.cumprod(1 + rng.normal(0, 0.02, (120, 4)), 0)
    Caprev = np.vstack([np.full((1, 4), np.nan), Ca[:-1]])
    hl = np.full((120, 4), 300.0)
    full = L.r_features(LU, Ca, Caprev, Ca, hl)
    for s in (30, 77, 119):
        tr = L.r_features(LU[:s + 1], Ca[:s + 1], Caprev[:s + 1], Ca[:s + 1], hl[:s + 1])
        for k in full:
            np.testing.assert_array_equal(full[k][s], tr[k][s])


def test_partition_precedence_and_exclusivity():
    close = np.array([[12.0, 12.0, np.nan, 6.0, 6.0, 6.0, 3.0, 12.0]])
    fl = dict(vol20=np.array([[500, 500, 500, 500, 500, 150, 500, 500.0]]), cnt130=np.array([[130, 130, 130, 130, 130, 130, 130, 130.0]]),
              nan20=np.zeros((1, 8)), brk_past=np.zeros((1, 8), bool), cool1=np.array([[0, 0, 0, 0, 1, 0, 0, 0]], bool),
              lu=np.array([[0, 1, 0, 0, 0, 0, 0, 0]], bool))
    age = np.full((1, 8), 300.0)
    tdr = np.array([False, False, False, False, False, False, False, True])
    p = L.partition(close, fl, age, tdr, np.ones((1, 8), bool))
    got = [L.TRACKS[k] for k in p['track'][0]]
    assert got == ['M', 'NE_LU_S', 'NE_SUSP', 'Mp', 'R', 'S', 'W', 'NE_TDR']
    assert all(p['checks'].values())
    assert p['fails']['fP10'][0, 3] and not p['fails']['fP5'][0, 3] and p['fails']['fCD'][0, 4] and p['fails']['fV300'][0, 5]


def test_qmax():
    tr = np.array([L.TID['M'], L.TID['R'], L.TID['R'], L.TID['R'], L.TID['S'], L.TID['W']])
    q = L.qmax(tr, np.array([350.0, 350, 350, 350, 250, 900]), np.array([0, 0, 1, np.nan, 0, 0.0]))
    assert q[0] == 7 and q[1] == 7 and q[2] == 3 and np.isnan(q[3]) and q[4] == 2 and np.isnan(q[5])


def test_windows_and_unknown_assert():
    reg = L.load_registration()
    w = L.feature_windows(['r20', 'c_ma120', 'macd_hist', 'fgn_5', 'o_dself_20', 'mkt_r5', 'o_fin_gm', 'rs20', 'is_R'], reg)
    assert [w[k]['window'] for k in w] == [21, 120, 60, 20, 20, 0, 0, 21, 0]
    assert w['rs20']['rule'] == 'DEV-001'
    try:
        L.feature_windows(['rk_r20'], reg)
        raise AssertionError('未知特徵應該 assert 失敗')
    except AssertionError as e:
        assert '不在登錄窗長表' in str(e)


def test_anchored_pct_and_short_history():
    m = np.array([1.0, 2.0, 2.0, 3.0, np.nan])
    p = L.anchored_pct(np.array([0.0, 2.0, 5.0, np.nan]), m)
    assert p[0] == 0.0 and p[1] == 0.5 and p[2] == 1.0 and np.isnan(p[3])
    x = L.apply_short_history(np.array([1.0, 2.0]), np.array([19.0, 20.0]), 20)
    assert np.isnan(x[0]) and x[1] == 2.0


if __name__ == '__main__':
    n = 0
    for k, f in list(globals().items()):
        if k.startswith('test_') and callable(f):
            f()
            n += 1
            print('ok', k)
    print(f'{n} 項通過')
