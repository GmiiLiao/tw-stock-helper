"""a36_tracks_fwd_rules 的合成資料測試（python3 a36_tracks_fwd_rules_test.py 或 pytest -q a36_tracks_fwd_rules_test.py）。
涵蓋 G1 第 4 項的四個修正：(i) 處置狀態換名與清單判定、(ii) 出場日分類（與鎖後補遺逐列等價）與逐列旗標／逐日揭露、
(iii) 同日百分位只在母體列排名（與 cv_official.ranks 同式）、(iv) v3 上市日規則與「距上次」右截斷；另含 RAND、前向判定與登錄釘選。
"""
import os
import tempfile

import numpy as np
import pandas as pd

import a36_tracks_fwd_rules as FR
import a36_tracks_lib as L
import a36_tracks_t1_audit as AU


# ── (iv-a) 上市日 ──
def test_listing_v3_only_changes_transfer_at_panel_start():
    dates = ['2022-07-18', '2022-07-19', '2022-07-20', '2022-07-21', '2022-07-22']
    codes = ['1111', '2222', '3333', '4444', '5555']
    C = np.full((5, 5), np.nan)
    C[:, 0] = 10                      # 面板前上市
    C[2:, 1] = 10                     # 面板內上市
    C[1:, 2] = 10                     # 轉市場，首收在面板中途 ⇒ 維持 transfer_min
    C[:, 3] = 10                      # 轉市場，首收在面板第一天 ⇒ v3：transfer_prepanel（−∞）
    C[3:, 4] = 10                     # 不在快照，首收在中途
    snaps = {'1111': ('TWSE', '1990-01-01'), '2222': ('TPEx', '2022-07-20'), '3333': ('TWSE', '2022-07-21'), '4444': ('TWSE', '2022-07-22')}
    v2 = L.listing_info(dates, codes, C, snaps)
    v3 = FR.listing_info_v3(dates, codes, C, snaps)
    assert [L.LISTING_SRC[k] for k in v2['listing_src']][3] == 'transfer_min' and v2['first_trade'][3] == 0
    assert [FR.LISTING_SRC_V3[k] for k in v3['listing_src']] == ['official_prepanel', 'official', 'transfer_min', 'transfer_prepanel', 'fallback_first_close']
    assert v3['first_trade'][3] == -np.inf and v3['first_trade'][2] == 1
    same = [0, 1, 2, 4]
    assert np.array_equal(v2['first_trade'][same], v3['first_trade'][same]) and np.array_equal(v2['listing_src'][same], v3['listing_src'][same])
    a2, a3 = L.ages(5, v2['first_trade']), L.ages(5, v3['first_trade'])
    assert np.array_equal(a2['hist_len'], a3['hist_len'])                 # hist_len 不受影響（ft＝0 與 −∞ 都是 s＋1）
    assert a2['age_cap'][4, 3] == 5 and a3['age_cap'][4, 3] == 250        # age_cap 只在面板起點附近不同
    assert FR.LISTING_SRC_V3[:len(L.LISTING_SRC)] == L.LISTING_SRC        # 舊代碼意義不變


def test_latest_snapshot_file_and_merge():
    with tempfile.TemporaryDirectory() as d:
        for n in ('2026-10-01.json.gz', '2026-10-02.json.gz', '2026-10-06.json.gz', '_manifest.json'):
            open(os.path.join(d, n), 'w').close()
        assert os.path.basename(FR.latest_snapshot_file(d, '2026-10-05')) == '2026-10-02.json.gz'
        assert FR.latest_snapshot_file(d, '2026-09-30') is None
    assert FR.latest_snapshot_file('/nonexistent-dir-xyz', '2026-10-05') is None
    m = FR.merge_snapshots({'1': ('TWSE', '2020-01-01'), '2': ('TWSE', '2021-01-01')}, {'2': ('TPEx', '2026-01-22')})
    assert m == {'1': ('TWSE', '2020-01-01'), '2': ('TPEx', '2026-01-22')}


# ── (iv-b) 距上次 ──
def test_censor_since_states():
    raw = np.array([0, 10, 250, 251, 400, np.nan, np.nan, np.nan, 999])
    never = np.array([0, 0, 0, 0, 0, 1, 1, 0, 0], bool)
    hl = np.array([300, 300, 300, 300, 500, 300, 100, 300, 1000])
    v, st = FR.censor_since(raw, hl, never)
    assert np.array_equal(v[:3], [0, 10, 250]) and st[:3].tolist() == [0, 0, 0]
    assert v[3] == 251 and v[4] == 251 and st[3] == 1 and st[4] == 1     # 觀察到但 > W ⇒ 右截斷
    assert v[5] == 251 and st[5] == 1                                    # 從未發生、歷史夠長 ⇒ W＋1
    assert np.isnan(v[6]) and st[6] == 2                                 # 從未發生、歷史 < W ⇒ 未知
    assert np.isnan(v[7]) and st[7] == 2                                 # 來源缺漏 ⇒ 未知（不捏造）
    assert v[8] == 251 and st[8] == 1                                    # 真實 999 天（> W）⇒ 右截斷
    assert not np.any(v == 999)


def test_since_from_legacy_maps_999():
    v, st = FR.since_from_legacy(np.array([999.0, 999.0, 5.0, np.nan]), np.array([250, 249, 10, 400]))
    assert v[0] == 251 and np.isnan(v[1]) and v[2] == 5 and np.isnan(v[3])
    assert st.tolist() == [1, 2, 0, 2]


# ── (i) 處置狀態與清單判定 ──
def test_disposal_status_and_legacy_alias():
    assert FR.disposal_status([0, 1, np.nan]).tolist() == list(FR.DISPOSAL_STATUS)
    old = pd.DataFrame({'tradable_status': ['可交易（DK_s＝0）', '處置中・交易規則另案登錄（DK_s＝1）', '處置狀態未知（來源缺漏）'], 'x': [1, 2, 3]})
    new = FR.alias_legacy_tradable_status(old)
    assert 'tradable_status' not in new.columns and new.disposal_status.tolist() == list(FR.DISPOSAL_STATUS)
    try:
        FR.alias_legacy_tradable_status(pd.DataFrame({'tradable_status': ['可交易']}))
        raise AssertionError('未登錄的值應該失敗')
    except ValueError:
        pass


def test_forward_lists_labels():
    assert set(FR.FWD_LISTS) == {'S0_atr14@5', 'SFB_atr14@5', 'R0_combo@5', 'W_atr14@3', 'M0@10', 'M0@20'}
    assert FR.FWD_LISTS['S0_atr14@5']['label'] == '觀察／研究榜·代理 lift 的時間外複製·容量受限·不可交易·待前向確認'
    assert FR.FWD_LISTS['SFB_atr14@5']['label'].startswith('探索性·') and FR.FWD_LISTS['SFB_atr14@5']['exploratory']
    assert FR.FWD_LISTS['R0_combo@5']['grey'] and FR.FWD_LISTS['W_atr14@3']['grey'] and not FR.FWD_LISTS['S0_atr14@5']['grey']
    assert len({v['section'] for v in FR.FWD_LISTS.values()}) == len(FR.FWD_LISTS)       # 各自一區，不混排
    assert 'Mp1@10' not in FR.FWD_LISTS                                                    # Mp 不進影子
    assert all(lid in FR.LIST_VERDICT_FWD for lid in FR.FWD_LISTS)


# ── (ii) 出場日分類與旗標 ──
def _exit_case():
    T, nan = 12, np.nan
    C = np.full((T, 4), 10.0)
    O = np.full((T, 4), 10.0)
    C[6:9, 0] = O[6:9, 0] = nan        # 列0：e＝6 停牌，第 9 日恢復
    C[9, 0], O[9, 0] = 12.0, 11.0
    C[6:, 1] = O[6:, 1] = nan          # 列1：e＝6 起不再有收盤
    C[6, 2] = O[6, 2] = nan            # 列2：冷門股（nan20>0）
    s = np.array([1, 1, 1, 8, 1])
    j = np.array([0, 1, 2, 3, 3])
    return C, O, s, j


def test_exit_category_matches_audit():
    C, O, s, j = _exit_case()
    buy = np.array([True, True, True, True, False])
    n20 = np.array([0, 0, 3, 0, 0])
    base = np.where(np.isfinite(C[np.minimum(s + 5, 11), j]) & (s + 5 <= 11), C[np.minimum(s + 5, 11), j] / O[s + 1, j] - 1, np.nan)
    got = FR.exit_category(np.isfinite(C), s, j, 5, 11, buy, n20)
    au = AU.exit_alternatives(C, O, s, j, base, buy, n20, 5)['cat']
    assert got.tolist() == ['NOCLOSE_HALT', 'NOCLOSE_UNRESOLVED', 'NOCLOSE_ILLIQ', 'PENDING', 'NA']
    assert [FR.AUDIT_CAT_MAP[a] for a in au] == got.tolist()


def test_exit_category_asof_is_point_in_time():
    C, O, s, j = _exit_case()
    buy = np.ones(5, bool)
    n20 = np.zeros(5)
    at7 = FR.exit_category(np.isfinite(C), s, j, 5, 7, buy, n20)     # 記錄時點 7：列0 尚未恢復 ⇒ 不能用未來的恢復資訊
    assert at7[0] == 'NOCLOSE_UNRESOLVED' and at7[3] == 'PENDING'
    at5 = FR.exit_category(np.isfinite(C), s, j, 5, 5, buy, n20)     # 出場日 6 > 記錄時點 5 ⇒ 尚未到期
    assert set(at5.tolist()) == {'PENDING'}


def test_pick_flags_and_daily_disclosure():
    codes = FR.pick_flag_codes([0, 1, np.nan, 0], [0, 1, 0, 0], [True, True, False, True], [0, 0, 0, 1],
                               ['OK', 'NOCLOSE_HALT', 'NA', 'NA'], ['PENDING', 'OK', 'NA', 'NA'])
    assert codes == ['C10_PENDING', 'DK1;DISP_T;C5_NOCLOSE_HALT', 'DKNA;NO_OPEN_T', 'LOCKED_OPEN_T']
    assert all(FR.flags_text(c) or c == '' for c in codes) and '推定停牌' in FR.flags_text(codes[1])
    p = pd.DataFrame({'date_s': ['2026-10-05'] * 3 + ['2026-10-06'], 'list_id': ['S0_atr14@5'] * 4, 'DK_s': [0, 1, np.nan, 0],
                      'm_disp_t_exec': [0, 1, 0, 0], 'm_buyable': [1, 1, 0, 0], 'm_has_open_t': [1, 1, 0, 1], 'm_locked_open': [0, 0, 0, 1],
                      'exit_c5_cat': ['OK', 'NOCLOSE_HALT', 'NA', 'NA'], 'exit_c10_cat': ['PENDING', 'OK', 'NA', 'NA']})
    d = FR.daily_disclosure(p)
    r0 = d[d.date_s == '2026-10-05'].iloc[0]
    assert (r0.n_picks, r0.n_dk0, r0.n_dk1, r0.n_dk_unknown, r0.n_disp_t, r0.n_buyable, r0.n_no_open_t) == (3, 1, 1, 1, 1, 2, 1)
    assert (r0.n_c5_ok, r0.n_c5_noclose_halt, r0.n_c10_pending, r0.n_c10_ok) == (1, 1, 1, 1)
    assert d[d.date_s == '2026-10-06'].iloc[0].n_locked_open_t == 1


# ── (iii) 同日百分位母體 ──
def test_rank_pct_by_day_population_only():
    rng = np.random.default_rng(1)
    day = np.repeat([0, 1], 6)
    X = rng.normal(size=(12, 2)).astype(np.float32)
    X[3, 0] = np.nan
    X[[1, 2], 1] = X[0, 1]                                 # 同值
    got = FR.rank_pct_by_day(day, X, [True, False])
    ref = pd.Series(X[:, 0].astype(np.float64)).groupby(day).rank(pct=True, method='average').values.astype(np.float32)
    assert np.array_equal(got[:, 0], ref, equal_nan=True) and np.array_equal(got[:, 1], X[:, 1])
    sub = FR.rank_pct_by_day(day[:5], X[:5], [True, True])          # 母體少一列 ⇒ 名次重算（不是沿用大母體的值）
    assert not np.array_equal(sub[:, 0], got[:5, 0], equal_nan=True)
    assert np.isnan(got[3, 0])


# ── RAND 與判定 ──
def test_rand_expected_and_draw():
    picks, E = FR.rand_expected([0, 3, 10], [0, 1, 2], 5)
    assert picks.tolist() == [0, 3, 5] and E.tolist() == [0.0, 1.0, 1.0]
    pool = [f'{1000 + i}' for i in range(30)]
    a = FR.rand_draw('2026-10-05', 'S0_atr14@5', pool, 5)
    assert a == FR.rand_draw('2026-10-05', 'S0_atr14@5', list(reversed(pool)), 5)        # 與池的順序無關
    assert len(a) == 5 and len(set(a)) == 5 and a != FR.rand_draw('2026-10-06', 'S0_atr14@5', pool, 5)
    assert FR.rand_draw('2026-10-05', 'W_atr14@3', ['1', '2'], 3) == ['1', '2'] and FR.rand_draw('2026-10-05', 'x', [], 3) == []


def test_forward_decisions_exclusive_exhaustive():
    cases = [(0.5, 0.1), (0.5, -0.1), (0.5, 0.0), (0.0, 0.1), (-0.2, -0.5), (None, None), (float('nan'), 0.2)]
    keep = [FR.g250_keep(p, lo) for p, lo in cases]
    assert keep == ['CONFIRM', 'EXTEND', 'EXTEND', 'DROP', 'DROP', 'DROP', 'DROP']
    assert [FR.g500_final(p, lo) for p, lo in cases] == ['CONFIRM', 'DROP', 'DROP', 'DROP', 'DROP', 'DROP', 'DROP']
    assert [FR.g250_watch(p, lo) for p, lo in cases] == ['UPGRADE', 'EXTEND', 'EXTEND', 'STAY-WATCH', 'STAY-WATCH', 'STAY-WATCH', 'STAY-WATCH']
    assert FR.g60_crash(-0.01) and not FR.g60_crash(0.0) and not FR.g60_crash(None)


def test_registration_hash_and_pins():
    with tempfile.TemporaryDirectory() as d:
        reg = {'a': 1, 'implementation_pins': {'files_sha256': {'x.py': '0' * 64}}}
        jp, mp, lp = (os.path.join(d, n) for n in ('r.json', 'r.md', 'dev.md'))
        import json
        json.dump(reg, open(jp, 'w'))
        h = L.canonical_sha256(reg)
        open(mp, 'w', encoding='utf-8').write(f'| **JSON 封存雜湊（sha256）** | **`{h}`** |\n')
        assert FR.load_forward_registration(jp, mp) == reg
        open(mp, 'w', encoding='utf-8').write(f'| **JSON 封存雜湊（sha256）** | **`{"f" * 64}`** |\n')
        try:
            FR.load_forward_registration(jp, mp)
            raise AssertionError('雜湊不符應拒跑')
        except SystemExit:
            pass
        open(os.path.join(d, 'x.py'), 'w').write('print(1)\n')
        assert not FR.check_pins(reg, d, lp)['ok']
        cur = L.file_sha256(os.path.join(d, 'x.py'))
        open(lp, 'w', encoding='utf-8').write(f'## FWD-DEV-001 測試\nPIN-UPDATE: x.py {cur}\n')
        assert FR.check_pins(reg, d, lp)['ok']


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for t in tests:
        t()
    print(f'{len(tests)} 項測試全部通過')
