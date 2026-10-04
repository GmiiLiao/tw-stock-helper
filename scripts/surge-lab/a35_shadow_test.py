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
        lst = fz['lists'][name]; assert 30 <= len(lst) <= L.TOPK, (name, len(lst))
        assert [e['rank'] for e in lst] == list(range(1, len(lst) + 1))
        assert all(lst[i]['score'] >= lst[i + 1]['score'] for i in range(len(lst) - 1))
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


# ───────────── 每日自動化（2026-10-04）：目標日、時鐘閘、矩陣重建判斷、資料依據（純函式；不連網、不讀 Firestore） ─────────────
# 休市表案例與 scripts/lib/surge-shadow-daily.test.mjs 同一組（兩種語言實作同一條規則）
MIRROR_ROWS = [
    {'Name': '中華民國開國紀念日', 'Date': '1150101'}, {'Name': '國曆新年開始交易日', 'Date': '1150102'},
    {'Name': '農曆春節前最後交易日', 'Date': '1150211'}, {'Name': '市場無交易，僅辦理結算交割作業', 'Date': '1150212'},
    {'Name': '國慶日', 'Date': '1151009'}, {'Name': '國慶日', 'Date': '1151010'},
    {'Name': '臺灣光復暨金門古寧頭大捷紀念日', 'Date': '1151025'}, {'Name': '臺灣光復暨金門古寧頭大捷紀念日', 'Date': '1151026'},
    {'Name': '行憲紀念日', 'Date': '1151225'},
]
FS_DOC = {'holidays': ['2026-01-01', '2026-02-12', '2026-10-09', '2026-10-26', '2026-12-25'], 'coverYear': 2026, 'official': ['2026-01-01']}


def test_next_trading_day_skips_makeup_holidays():
    cal = L.make_calendar(None, MIRROR_ROWS)
    assert '2026-02-12' in cal['holidays'] and '2026-01-02' not in cal['holidays'] and '2026-02-11' not in cal['holidays']
    for c in (cal, L.make_calendar(FS_DOC, None), L.make_calendar(FS_DOC, MIRROR_ROWS)):
        assert L.next_trading_day('2026-10-02', c) == '2026-10-05'
        assert L.next_trading_day('2026-10-08', c) == '2026-10-12'      # 10-09 補假
        assert L.next_trading_day('2026-10-23', c) == '2026-10-27'      # 10-26 補假
        assert L.next_trading_day('2026-12-24', c) == '2026-12-28'
    assert L.next_trading_day('2025-12-31', cal) == '2026-01-02'
    for day, c in (('2026-12-31', cal), ('2026-10-02', None)):
        try: L.next_trading_day(day, c); raise AssertionError('應該丟 CalendarError')
        except L.CalendarError: pass
    assert L.make_calendar(None, None) is None and L.make_calendar({'holidays': []}, []) is None


def test_freeze_gate_is_target_day_0900_taipei():
    assert L.frozen_before_open('2026-10-04T21:00:00+08:00', '2026-10-05')
    assert L.frozen_before_open('2026-10-05T08:59:59+08:00', '2026-10-05')
    assert not L.frozen_before_open('2026-10-05T09:00:00+08:00', '2026-10-05')
    assert not L.frozen_before_open('2026-10-05T01:00:00+00:00', '2026-10-05')     # = 09:00 台北
    assert not L.frozen_before_open('2026-10-05T08:00:00', '2026-10-05')           # 沒時區＝不可判定 ⇒ 不算
    assert not L.frozen_before_open(None, '2026-10-05')


def test_research_env_guard():
    assert L.research_env_leak({'PATH': '/bin', 'SURGE_CACHE': '/x'}) == []
    assert L.research_env_leak({'SURGE_REVENUE': '', 'SURGE_DATASET_SUFFIX': 'L'}) == ['SURGE_REVENUE', 'SURGE_DATASET_SUFFIX']
    import subprocess, sys as _sys
    r = subprocess.run([_sys.executable, '-c', 'import a35_shadow_lib'], cwd=L.HERE, capture_output=True, text=True,
                       env=dict(os.environ, SURGE_OFFICIAL_LIMIT='/tmp/x.npz'), timeout=60)
    assert r.returncode == 1 and 'SURGE_OFFICIAL_LIMIT' in r.stderr, (r.returncode, r.stderr[-300:])


def test_matrix_consistency_and_rebuild_reasons():
    inp = {'revenue': 'r1', 'priceEvents': 'p1', 'a35ExtraExright': {'enabled': True, 'files': {'a35_shadow_exright_2026-10-02.json': 'e1'}}}
    sc = {'buildId': 'm1', 'revenueSha256': 'r1', 'inputs': inp, 'dataset': {'env': {}}}
    assert L.matrix_consistency(sc, 'm1', inp) == 'ok'
    assert L.matrix_consistency(sc, 'm1', dict(inp, revenue='r2')) == 'inputs-changed'
    assert L.matrix_consistency(sc, 'm1', dict(inp, priceEvents='p2')) == 'inputs-changed', '減資／面額變更事件變了也要判出來'
    assert L.matrix_consistency(sc, 'm1', dict(inp, a35ExtraExright={'enabled': True, 'files': {}})) == 'inputs-changed'
    assert L.matrix_consistency(dict(sc, inputs=dict(inp, a35ExtraExright={'enabled': False, 'files': {}})), 'm1', inp) == 'inputs-changed', \
        '沒開 SURGE_SHADOW_EXTRA_EXRIGHT 建的矩陣 ≠ 上線'
    assert L.matrix_consistency(sc, 'm2', inp) == 'stale-sidecar'
    assert L.matrix_consistency(dict(sc, dataset={'env': {'SURGE_REVENUE': 'revenue_official.json'}}), 'm1', inp) == 'research-env'
    assert L.matrix_consistency({'buildId': 'm1', 'revenueSha256': 'r1'}, 'm1', inp) == 'unknown-inputs', 'v1 側檔沒有輸入清單'
    assert L.matrix_consistency(None, 'm1', inp) == 'no-sidecar'
    panel = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']
    meta = panel[:4]                                   # 矩陣建於 10-02，最晚 s＝10-01（idx 2）
    assert L.rebuild_reasons(meta, 2, panel, '2026-10-05', 'ok') == []          # 需要 s ≤ idx 1
    assert L.rebuild_reasons(meta, 2, panel, '2026-10-06', 'ok') == []          # 需要 s ≤ idx 2
    assert L.rebuild_reasons(meta, 2, panel, '2026-10-07', 'ok') == ['rows']    # 需要 s ≤ idx 3
    assert L.rebuild_reasons(meta, 2, panel, '2026-10-05', 'inputs-changed') == ['inputs-changed']
    assert L.rebuild_reasons(['2026-09-28'] + meta[1:], 2, panel, '2026-10-05', 'no-sidecar') == ['alignment', 'no-sidecar']
    try: L.rebuild_reasons(meta, 2, panel, '2026-10-08', 'ok'); raise AssertionError('面板沒有該日應丟錯')
    except ValueError: pass


def test_matrix_id_matches_prep_build_id():
    """lib 的矩陣內容雜湊＝prep 側檔 buildId 的同一公式；dataset 側檔只有雜湊相符才採信營收版本。"""
    import a32_walkforward_prep as PREP
    d = tempfile.mkdtemp(prefix='a35mx_')
    xp, mp = os.path.join(d, 'X.npy'), os.path.join(d, 'meta.npz')
    np.save(xp, np.arange(6, dtype=np.float32).reshape(2, 3)); np.savez(mp, a=np.arange(3))
    old = L.X_PATH, L.META_PATH
    L.X_PATH, L.META_PATH = xp, mp
    try: mid = L.matrix_id()
    finally: L.X_PATH, L.META_PATH = old
    assert mid == PREP.matrix_build_id(xp, mp) == __import__('hashlib').sha256((PREP.file_sha256(xp) + PREP.npz_content_sha256(mp)).encode()).hexdigest()
    mp2 = os.path.join(d, 'meta2.npz'); np.savez_compressed(mp2, a=np.arange(3))                     # 同內容、不同檔案位元組
    assert PREP.npz_content_sha256(mp2) == PREP.npz_content_sha256(mp) and PREP.file_sha256(mp2) != PREP.file_sha256(mp)
    assert PREP.dataset_revenue_sha({'datasetSha256': 'ds', 'revenueSha256': 'rv'}, 'ds') == 'rv'
    assert PREP.dataset_revenue_sha({'datasetSha256': 'old', 'revenueSha256': 'rv'}, 'ds') is None
    assert PREP.dataset_revenue_sha(None, 'ds') is None
    assert PREP.dataset_revenue_sha({'datasetSha256': 'ds', 'revenueSha256': 'rv', 'env': {'SURGE_PIT_STRICT': '1'}}, 'ds') is None, '研究環境建的 dataset 不採信'
    assert PREP.dataset_inputs({'datasetSha256': 'ds', 'inputs': {'revenue': 'rv'}, 'env': {}}, 'ds') == {'revenue': 'rv'}
    assert PREP.dataset_inputs({'datasetSha256': 'ds', 'inputs': {'revenue': 'rv'}, 'env': {'SURGE_REVENUE': 'x'}}, 'ds') is None
    assert PREP.dataset_inputs({'datasetSha256': 'ds', 'revenueSha256': 'rv'}, 'ds') is None


def test_input_manifest_and_extra_exright_merge():
    """輸入清單：priceEvents 只雜湊 (代號, 日期, factor)、檔頭變動不算；逐日補抓除權息只有開關打開才列入；訓練／上線共用同一支合併。"""
    import surge_inputs as SI
    d = tempfile.mkdtemp(prefix='a35in_'); repo = tempfile.mkdtemp(prefix='a35repo_')
    os.makedirs(os.path.join(repo, 'scripts/data'))
    json.dump({'items': []}, open(os.path.join(repo, 'scripts/data/exright-history.json'), 'w'))
    json.dump({'r': 1}, open(os.path.join(d, 'revenue.json'), 'w'))
    pe = {'window': {'from': '2026-05-20', 'to': '2026-10-02'}, 'fetchedAt': 1, 'items': [{'code': '4806', 'date': '2026-10-02', 'factor': 1.43, 'name': 'x'}]}
    json.dump(pe, open(os.path.join(d, 'priceEvents.json'), 'w'))
    json.dump({'date': '2026-10-02', 'items': [['2026-10-02', '2330', 1.01], ['2026-10-02', '2330', 1.01], ['2026-10-02', '1101', 0]]},
              open(os.path.join(d, 'a35_shadow_exright_2026-10-02.json'), 'w'))
    m_on = SI.input_manifest(d, repo, os.path.join(d, 'revenue.json'), True)
    m_off = SI.input_manifest(d, repo, os.path.join(d, 'revenue.json'), False)
    assert m_on['a35ExtraExright']['files'] and not m_off['a35ExtraExright']['files'] and m_on['exrightDelta'] is None
    assert SI.manifest_diff(m_off, m_on)[0] == 'a35ExtraExright.enabled'
    json.dump(dict(pe, window={'from': '2026-05-21', 'to': '2026-10-05'}, fetchedAt=2), open(os.path.join(d, 'priceEvents.json'), 'w'))
    assert SI.input_manifest(d, repo, os.path.join(d, 'revenue.json'), True) == m_on, '只有檔頭（window／fetchedAt）變不算輸入改變'
    json.dump(dict(pe, items=pe['items'] + [{'code': '2330', 'date': '2026-06-01', 'factor': 2.0}]), open(os.path.join(d, 'priceEvents.json'), 'w'))
    assert SI.manifest_diff(m_on, SI.input_manifest(d, repo, os.path.join(d, 'revenue.json'), True)) == ['priceEvents']
    ev = [('1101', '2026-09-01', 'exright', 1.1)]
    merged = SI.merge_extra_exright(ev, SI.load_extra_exright_items(d))
    assert merged == ev + [('2330', '2026-10-02', 'a35_extra', 1.01)], merged          # 重複列只收一次、factor 0 不收、原表不變
    assert ev == [('1101', '2026-09-01', 'exright', 1.1)]
    assert SI.extra_exright_enabled({'SURGE_SHADOW_EXTRA_EXRIGHT': '1'}) and not SI.extra_exright_enabled({})


def test_exright_coverage_statuses():
    dates = ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
    cover = [('2026-10-01', None, {}, False), ('2026-10-02', 'tpex down', {}, True)]
    r = L.exright_coverage_from(dates, '2026-10-05', '2026-09-29', '2026-09-30', cover)
    assert [(x['date'], x['status']) for x in r['days']] == [('2026-09-30', 'delta-twse-only'), ('2026-10-01', 'fetched'),
                                                            ('2026-10-02', 'fetched-twse-only'), ('2026-10-05', 'missing')]
    assert r['complete'] is False
    assert L.exright_coverage_from(dates, '2026-10-01', '2026-09-30', None, cover)['complete'] is True


def test_resolve_target_uses_calendar_and_rejects_mismatch():
    import a35_shadow_list as LS
    cal = L.make_calendar(None, MIRROR_ROWS)
    fake = L.Ctx(); fake.dates = ['2026-10-07', '2026-10-08']; fake.T = 2
    orig = L.load_calendar
    try:
        L.load_calendar = lambda use_firestore=True, mirror_dir=None: cal
        assert LS.resolve_target('2026-10-08', fake, 1, None, False)[0] == '2026-10-12'
        assert LS.resolve_target('2026-10-08', fake, 1, '2026-10-12', False)[0] == '2026-10-12'
        try: LS.resolve_target('2026-10-08', fake, 1, '2026-10-09', False); raise AssertionError('與日曆不符應拒絕')
        except L.CalendarError: pass
        assert LS.resolve_target('2026-10-07', fake, 0, None, False)[0] == '2026-10-08'        # 補產：以面板實際下一日為準
        L.load_calendar = lambda use_firestore=True, mirror_dir=None: None
        assert LS.resolve_target('2026-10-08', fake, 1, '2026-10-12', False)[0] == '2026-10-12'  # 無日曆：只接受明確指定
        try: LS.resolve_target('2026-10-08', fake, 1, None, False); raise AssertionError('無日曆又沒指定應拒絕')
        except L.CalendarError: pass
    finally:
        L.load_calendar = orig


def test_frozen_extra_fields_are_sealed_and_cannot_clobber():
    o = L.seal({'a': 1, 'dataBasis': {'ready': True, 'basis': '兩市官方'}, 'revenueSha256': 'ab' * 32})
    assert L.verify_seal(json.loads(json.dumps(o, ensure_ascii=False, sort_keys=True, indent=1)))
    o2 = json.loads(json.dumps(o)); o2['dataBasis']['basis'] = '上市官方＋上櫃含第三方補洞'
    assert not L.verify_seal(o2)
    try: L.build_frozen(None, 0, {}, [], kind='x', target_day=None); raise AssertionError('沒有目標日應拒絕')
    except ValueError: pass


if __name__ == '__main__':
    import sys
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith('test_') and callable(fn):
            try: fn(); print('PASS', name)
            except Exception as e:
                fails += 1; print('FAIL', name, repr(e))
    sys.exit(1 if fails else 0)
