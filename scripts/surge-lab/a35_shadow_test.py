"""a35_shadow 的單元／端對端測試（pytest 或直接 python3 執行皆可）。

  python3 a35_shadow_test.py
  python3 -m pytest -q a35_shadow_test.py

涵蓋：封印（sha256）與竄改偵測、Wilson、週區塊、daemon 漲停規則、live 特徵無前視（截斷面板重算同值）、
      以極小模型（20 棵）跑完整「產生 → 封印 → 對答案」流程，並與站上記分板／lu_recompute.json 的命中數交叉核對。
"""
import os
import json
import tempfile
import numpy as np
import a35_shadow_lib as L
import a35_shadow_score as S
import a35_shadow_history as H

_CTX = {}


def ctx():
    if 'x' not in _CTX: _CTX['x'] = L.build_ctx()
    return _CTX['x']


def test_seal_roundtrip_and_tamper():
    o = L.seal({'a': 1, 'b': [1, 2, {'c': 'x'}], 'z': None})
    assert L.verify_seal(o)
    o2 = json.loads(json.dumps(o)); o2['b'][2]['c'] = 'y'
    assert not L.verify_seal(o2)
    o3 = json.loads(json.dumps(o)); o3['sha256'] = '0' * 64
    assert not L.verify_seal(o3)
    # key order must not matter (canonical)
    assert L.canon({'a': 1, 'b': 2}) == L.canon({'b': 2, 'a': 1})


def test_wilson():
    lo, hi = S.wilson(0, 10); assert lo == 0.0 and 0.2 < hi < 0.35
    lo, hi = S.wilson(50, 100); assert 0.40 < lo < 0.41 and 0.59 < hi < 0.60
    assert S.wilson(1, 0) == (None, None)


def test_weekly_blocks():
    days = ['2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21', '2026-07-24', '2026-07-27']
    b = H.blocks(days, 'weekly')
    assert b['2026-07-17'] == '2026-07-16' and b['2026-07-21'] == '2026-07-20' and b['2026-07-24'] == '2026-07-20' and b['2026-07-27'] == '2026-07-27'
    assert H.blocks(days, 'daily') == {d: d for d in days}


def test_daemon_rule_matches_build_on_normal_cases():
    pc = np.array([100.0, 49.9, 9.95, 523.0, 25.0])
    lim_d = np.floor(pc * 1.1 / L.B.tick_of(pc) + 1e-9) * L.B.tick_of(pc)
    c = np.round(lim_d, 2)
    assert S.daemon_lu(c, pc).all()
    assert not S.daemon_lu(c - L.B.tick_of(c), pc).any()


def test_cutoff_never_reaches_scoring_day():
    for t in (500, 1022):
        ci = L.cutoff_index(None, t)
        assert ci == t - L.PURGE_DAYS and ci + 1 <= t - 2      # 訓練標籤日最晚 = 打分日 − 2


def test_live_features_use_no_future_data():
    """把面板在 s 截斷後重算 s 日的 live 特徵矩陣，必須與完整面板算出的逐格相同（PIT）。"""
    x = ctx(); t = x.dates.index('2026-09-15')
    names = L.feature_names()
    js, X = L.live_X(x, t, names)
    dates, codes, P = x.dates[:t + 1], x.codes, {k: v[:t + 1] for k, v in x.P.items()}
    x2 = L.build_ctx(dates, codes, P)
    js2, X2 = L.live_X(x2, t, names)
    assert np.array_equal(js, js2)
    same = (X == X2) | (np.isnan(X) & np.isnan(X2))
    # 除權息係數檔是全期的，截斷面板不影響 s 當日以前；允許極少數浮點尾數差
    assert same.mean() > 0.9999, f'截斷前後特徵不一致比例 {1 - same.mean():.2e}'
    assert np.nanmax(np.abs(X - X2)) < 1e-5


def test_fetched_close_merge_equals_panel():
    """面板少最後一天、改由 a35_shadow_fetch.mjs 抓的 chipArchive 收盤補一列 ⇒ 漲停／開盤鎖死判定與完整面板逐檔相同。"""
    day = '2026-10-02'
    pf = f'{L.SP}/a35_shadow_close_{day}.json'
    if not os.path.exists(pf): return                                  # 沒抓過就略過（a35_shadow_score.py --fetch 會產生）
    full_dates, codes, P = L.load_default_panel()
    assert full_dates[-1] == day
    orig = L.load_default_panel
    L.load_default_panel = lambda: (full_dates[:-1], codes, {k: v[:-1] for k, v in P.items()})
    try: dates2, codes2, P2, src = S.panel_with_day(day, allow_fetch=False)
    finally: L.load_default_panel = orig
    assert dates2 == list(full_dates) and src.endswith(f'a35_shadow_close_{day}.json')
    a = L.build_ctx(with_features=False); b = L.build_ctx(dates2, codes2, P2, with_features=False)
    t = a.T - 1
    for k in ('C', 'O', 'H', 'L', 'V'):
        assert np.array_equal(a.P[k][t], b.P[k][t], equal_nan=True), k
    assert np.array_equal(a.LU[t], b.LU[t]) and np.array_equal(a.open_lim[t], b.open_lim[t]) and np.array_equal(a.oneword[t], b.oneword[t])


def test_end_to_end_tiny_models_and_crosscheck():
    x = ctx(); st = L.Store()
    old_params, old_dir = dict(L.PARAMS), L.MODEL_DIR
    L.PARAMS.update(n_trees=20); L.MODEL_DIR = tempfile.mkdtemp(prefix='a35test_')
    try:
        day = '2026-09-30'; t = x.dates.index(day)
        ens = L.train_ensemble(L.cutoff_index(x.dates, t), workers=1, reuse=False, store=st)
        fz = L.build_frozen(x, t, ens, st.names, kind='test', fs={}, target_day=x.dates[t + 1])
    finally:
        L.PARAMS.update(old_params); L.MODEL_DIR = old_dir
    assert L.verify_seal(fz) and fz['scoringDay'] == day and fz['targetDay'] == '2026-10-01'
    for name in ('overallTop30', 'twseTop30', 'tpexTop30', 'freshTop30', 'continuationTop30', 'researchUniverseTop30'):
        lst = fz['lists'][name]; assert len(lst) == 30, name
        assert [e['rank'] for e in lst] == list(range(1, 31))
        assert all(lst[i]['score'] >= lst[i + 1]['score'] for i in range(29))
    assert all(e['market'] == 'tse' for e in fz['lists']['twseTop30']) and all(e['market'] == 'otc' for e in fz['lists']['tpexTop30'])
    assert all(not e['limitUpAtS'] for e in fz['lists']['freshTop30']) and all(e['limitUpAtS'] for e in fz['lists']['continuationTop30'])
    assert fz['site']['source'] and len(fz['site']['codes']) == 30          # 以 lu_scoreboard.json 快照為來源
    # 對答案
    r = S.score_one(fz, x, t, t + 1, False, [])
    all_lu = int((x.LU[t + 1] & np.isfinite(x.P['C'][t + 1])).sum())
    assert r['truth']['nLimitUp'] == all_lu
    for name in ('overallTop30', 'twseTop30', 'tpexTop30', 'freshTop30', 'continuationTop30'):
        for k in ('10', '30'):
            s_ = r['lists'][name][k]; assert s_['n'] == int(k) and s_['hit'] <= s_['n'] and s_['buy'] <= s_['hit']
            assert s_['nFresh'] + s_['nCont'] == s_['n'] and s_['nTse'] + s_['nOtc'] <= s_['n']
    # 與站上記分板／獨立重算（lu_recompute.json，兩市）核對：同一天站上 A 榜前 10／30 的命中數
    rec = {e['D']: e for e in json.load(open(f'{L.SP}/lu_recompute.json'))}
    if day in rec:
        assert r['lists']['site_top10']['10']['hit'] == rec[day]['h10'], (r['lists']['site_top10'], rec[day])
        assert r['lists']['site_top30']['30']['hit'] == rec[day]['h30'], (r['lists']['site_top30'], rec[day])
        # act＝站上母體（elig：收盤≥5、20 日均量≥100 張）內的漲停數；本檔計全部 4 碼個股 ⇒ 只可能 ≥
        assert rec[day]['act'] <= r['truth']['nLimitUp'] <= rec[day]['act'] + 10, (r['truth']['nLimitUp'], rec[day]['act'])


if __name__ == '__main__':
    import sys
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try: fn(); print('PASS', name)
            except Exception as e:
                fails += 1; print('FAIL', name, repr(e))
    sys.exit(1 if fails else 0)
