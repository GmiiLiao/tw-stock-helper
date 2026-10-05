"""T1 分軌前向影子接線（a37_tracks_*）的合成資料測試：python3 a37_tracks_fwd_test.py（或 pytest -q a37_tracks_fwd_test.py）。
涵蓋：封印／只寫一次／期限／休市日曆／總開關／環境防呆；鏡像增量只收定版列且不覆寫；處置／注意合併（欄位漂移整源不收、去重、涵蓋日）；
官方漲跌停矩陣「增量對齊」與 official_features.load_matrices 全量重建逐位相同（含新上市讓欄位位移、上櫃前一面板列位移、上市優先、同代號後列覆蓋）；
前向更嚴的處置／注意未知規則（FDEV-007：處置看 s 當天、t 日起處置看 t 當天）；parity 比對；到期判定；bootstrap 與 G 判定；缺口只寫一次、凍結前時鐘閘。
"""
import gzip
import json
import os
import tempfile

import numpy as np

import a37_tracks_fwd_io as IO
import a37_tracks_sync as SY
import a37_tracks_core as C
import a37_tracks_score as SC
import a37_tracks_fwd as FWD
import official_features as OF


def _tmp():
    return tempfile.mkdtemp(prefix='a37test')


def _gz(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, 'wt', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


# ───────────────────────── IO ─────────────────────────
def test_seal_write_once_and_conflict():
    d = _tmp()
    doc = IO.sealed(dict(a=1, b='中', c=[1.5, None]))
    assert IO.verify_seal(doc)
    assert not IO.verify_seal(dict(doc, a=2))
    p = os.path.join(d, 'x.json')
    assert IO.write_once(p, doc) == 'written'
    assert IO.write_once(p, doc) == 'same'
    assert IO.write_once(p, IO.sealed(dict(a=2))) == 'conflict'
    assert json.load(open(p))['a'] == 1                                  # 原檔不動
    try:
        IO.canon_bytes(dict(x=float('nan')))
        raise AssertionError('NaN 必須拒絕（不得以 NaN 字面寫進凍結檔）')
    except ValueError:
        pass


def test_deadline_and_calendar():
    assert IO.iso_tw(IO.deadline_of('2026-10-06')) == '2026-10-06T09:00:00+08:00'
    cal = IO.Calendar(['2026-10-09', '2026-10-26'], [2026])
    assert cal.next_trading('2026-10-02') == '2026-10-05'
    assert cal.next_trading('2026-10-08') == '2026-10-12'
    assert cal.nth_after('2026-10-05', 4) == '2026-10-12'
    assert cal.between('2026-10-07', '2026-10-13') == ['2026-10-08', '2026-10-12', '2026-10-13']
    try:
        cal.next_trading('2026-12-31')
        raise AssertionError('未涵蓋年份必須丟錯')
    except IO.Refuse as e:
        assert '2027' in str(e)
    try:
        IO.Calendar.from_plan({})
        raise AssertionError('計畫沒有日曆必須拒跑')
    except IO.Refuse:
        pass


def test_config_strict_and_env_guard():
    d = _tmp()
    p = os.path.join(d, 'c.json')
    for obj, want in ((dict(enabled=True, startDay='2026-10-06'), True), (dict(enabled='true', startDay='2026-10-06'), False),
                      (dict(enabled=True, startDay=None), False), (dict(enabled=False, startDay='2026-10-06'), False)):
        json.dump(obj, open(p, 'w'))
        assert IO.load_config(p)['enabled'] is want, obj
    assert IO.load_config(os.path.join(d, 'missing.json'))['enabled'] is False
    good = dict(cache='/x/.surge-cache-F', shared='/x/.surge-cache', seed='/x/.surge-cache-T', official_root='/o', out='/out')
    IO.guard_env(good, env={'SURGE_CACHE': '/x/.surge-cache-F'})
    for bad_env, bad_p in (({'SURGE_CACHE': '/x/.surge-cache-F', 'SURGE_OFFICIAL_LIMIT': 'a'}, good),
                           ({'SURGE_CACHE': '/x/.surge-cache'}, dict(good, cache='/x/.surge-cache')),
                           ({'SURGE_CACHE': '/x/.surge-cache-T'}, dict(good, cache='/x/.surge-cache-T')),
                           ({}, good)):
        try:
            IO.guard_env(bad_p, env=bad_env)
            raise AssertionError(f'應拒跑：{bad_env} {bad_p["cache"]}')
        except IO.Refuse:
            pass


def test_lock_shared_with_orchestrator():
    d = os.path.join(_tmp(), 'lock')
    with IO.orchestrator_lock(d) as how:
        assert how == 'mine' and json.load(open(os.path.join(d, 'owner.json')))['pid'] == os.getpid()
    assert not os.path.exists(d)                                          # 自己的鎖用完即釋放
    os.mkdir(d)
    json.dump(dict(pid=1, startedAt='x'), open(os.path.join(d, 'owner.json'), 'w'))   # 活著的別人（pid 1）
    try:
        with IO.orchestrator_lock(d):
            raise AssertionError('有人持鎖時必須拒跑')
    except IO.Refuse:
        pass
    json.dump(dict(pid=os.getppid()), open(os.path.join(d, 'owner.json'), 'w'))       # 協調器（父行程）持鎖 ⇒ 子行程沿用
    with IO.orchestrator_lock(d) as how:
        assert how == 'parent'
    assert os.path.exists(d)                                              # 父行程的鎖不由子行程釋放
    json.dump(dict(pid=99999999), open(os.path.join(d, 'owner.json'), 'w'))           # 殘留鎖（持有者已死）⇒ 回收
    with IO.orchestrator_lock(d) as how:
        assert how == 'mine'


# ───────────────────────── 同步 ─────────────────────────
def test_mirror_increments_only_final_ok_rows_and_never_overwrite():
    root, cache = _tmp(), _tmp()
    host, ds = SY.MIRROR_MAP['twse_limit']
    rows = {'2026-10-05': dict(status='ok', echo='2026-10-05', final=True, file='2026-10-05.json.gz', sha256='h1'),
            '2026-10-06': dict(status='ok', echo='2026-10-05', final=True, file='2026-10-06.json.gz'),          # 回聲不符
            '2026-10-07': dict(status='ok', echo='2026-10-07', final=False, file='2026-10-07.json.gz'),         # 未定版
            '2026-10-08': dict(status='empty', echo='2026-10-08', final=True, file='2026-10-08.json.gz'),
            '2026-10-12': dict(status='ok', echo='2026-10-12', final=True, file='2026-10-12.json.gz', sha256='zz'),  # sha 不符
            '2026-10-13': dict(status='ok', echo='2026-10-13', final=True, file='2026-10-13.json.gz')}             # 超過 upto
    for k, r in rows.items():
        _gz(os.path.join(root, host, ds, r['file']), dict(meta=dict(url=f'u{k}', sha256='h1' if k != '2026-10-12' else 'other'), payload=dict(day=k)))
    json.dump(dict(rows=rows), open(os.path.join(root, host, ds, '_manifest.json'), 'w'))
    keep = os.path.join(cache, 'official', 'twse_limit', '2026-10-02.json.gz')
    _gz(keep, dict(day='2026-10-02', raw='舊'))
    out = SY.mirror_increments(dict(cache=cache, official_root=root), '2026-10-12')
    assert out['twse_limit']['added'] == ['2026-10-05'], out['twse_limit']
    got = json.load(gzip.open(os.path.join(cache, 'official', 'twse_limit', '2026-10-05.json.gz')))
    assert got['raw'] == dict(day='2026-10-05') and got['day'] == '2026-10-05' and got['source'] == 'u2026-10-05'
    assert json.load(gzip.open(keep))['raw'] == '舊'
    again = SY.mirror_increments(dict(cache=cache, official_root=root), '2026-10-12')
    assert again['twse_limit']['added'] == []                            # 已有的日子不覆寫


def _disp_base(F, fname, fields, data):
    os.makedirs(os.path.join(F, 'base'), exist_ok=True)
    json.dump(dict(fields=fields, data=data), open(os.path.join(F, 'base', fname), 'w'), ensure_ascii=False)


def test_merge_disp_att_fields_drift_dedupe_and_coverage():
    root, F = _tmp(), _tmp()
    tw_fields = ['編號', '公布日期', '證券代號', '證券名稱', '累計', '處置條件', '處置起迄時間', '處置措施', '處置內容', '備註']
    tp_fields = ['編號', '公布日期', '證券代號', '證券名稱', '累計', '處置起訖時間', '處置原因', '處置措施', '處置內容', '收盤價', '本益比', ' ']
    at_tw = ['編號', '證券代號', '證券名稱', '累計次數', '注意交易資訊', '日期', '收盤價', '本益比']
    at_tp = ['編號', '證券代號', '證券名稱', '累計', '注意交易資訊', '公告日期', '收盤價', '本益比', 'link']
    r1 = [1, '115/10/02', '2030', '彰源', 1, '連續三次', '115/10/05～115/10/12', '第一次處置', 'x', '']
    _disp_base(F, 'disposal_twse.json', tw_fields, [r1])
    _disp_base(F, 'disposal_tpex.json', tp_fields, [])
    _disp_base(F, 'attention_twse.json', at_tw, [])
    _disp_base(F, 'attention_tpex.json', at_tp, [])

    def put(kind_mkt, key, status, payload):
        host, ds = SY.DISP_ATT[kind_mkt][:2]
        d = os.path.join(root, host, ds)
        man = IO.read_json(os.path.join(d, '_manifest.json')) or dict(rows={})
        man['rows'][key] = dict(status=status, echo=key, final=True, file=f'{key}.json.gz')
        _gz(os.path.join(d, f'{key}.json.gz'), dict(meta={}, payload=payload))
        os.makedirs(d, exist_ok=True)
        json.dump(man, open(os.path.join(d, '_manifest.json'), 'w'))

    r2 = [1, '115/10/05', '8084', '巨虹', 1, '連續三次', '115/10/06～115/10/13', '第一次處置', 'y', '']
    put(('disposal', 'TWSE'), '2026-10-05', 'ok', dict(fields=tw_fields, data=[r1, r2]))          # r1 重複（去重）
    put(('disposal', 'TWSE'), '2026-10-06', 'empty', {})                                           # 定版空表＝有答案
    put(('disposal', 'TPEx'), '2026-10-05', 'ok', dict(tables=[dict(fields=tp_fields + ['多一欄'], data=[])]))   # 欄位漂移
    t1 = [1, '6538', '倉和', 5, '…(第一款)', '115/10/05', '50', '10', 'l']
    put(('attention', 'TPEx'), '2026-10-05', 'ok', dict(tables=[dict(fields=at_tp, data=[t1, [2, '', '', 0, '', '', '', '', '']])]))
    rep = SY.merge_disp_att(dict(cache=F, official_root=root), '2026-10-06')
    tw = json.load(open(os.path.join(F, 'disposal_twse.json')))
    assert tw['data'] == [r1, r2]
    assert rep['disposal_TWSE']['rows_added'] == 1
    assert rep['disposal_TPEx']['problems'] and rep['disposal_TPEx']['days'] == 0      # 漂移：整個來源不收
    atp = json.load(open(os.path.join(F, 'attention_tpex.json')))
    assert atp['data'] == [t1]                                                          # 代號空白列不收（同研究抓取）
    cov = SY.load_coverage(F)
    assert cov['disposal']['TWSE'] == ['2026-10-05', '2026-10-06'] and cov['disposal']['TPEx'] == []
    assert cov['attention']['TPEx'] == ['2026-10-05']


def _limit_files(F, days, twse, tpex):
    tw_fields = ['證券代號', '證券名稱', '漲停價', '開盤競價基準', '跌停價', '開盤競價基準']
    tp_fields = ['代號', '名稱', '收盤', '成交股數', '成交筆數', '成交金額(元)', '發行股數', '次日 漲停價', '次日 跌停價']
    for d in days:
        if d in twse:
            _gz(os.path.join(F, 'official', 'twse_limit', f'{d}.json.gz'), dict(day=d, raw=dict(fields=tw_fields, data=twse[d])))
        if d in tpex:
            _gz(os.path.join(F, 'official', 'tpex_daily', f'{d}.json.gz'), dict(day=d, raw=dict(tables=[dict(fields=tp_fields, data=tpex[d])])))


def test_incremental_limits_equal_full_rebuild_bitwise():
    F = _tmp()
    days = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']
    twse = {'2026-10-01': [['1101', 'a', '50.5', '', '41.3', ''], ['2330', 'b', '1,100', '', '900', '']],
            '2026-10-02': [['1101', 'a', '51', '', '42', ''], ['1101', 'a', '--', '', '--', '']],          # 同代號後列覆蓋（含缺值）
            '2026-10-06': [['1101', 'a', '9995', '', '0.01', ''], ['9999', 'z', '10', '', '9', '']]}       # 9999 不在面板
    tp = lambda c, n, nxu, nxd: [c, n, '1', '1,000', '10', '1,000', '5,000', nxu, nxd]
    tpex = {'2026-10-01': [tp('6538', 'c', '49.5', '40.5'), tp('1101', 'a', '1', '1')],                    # 上櫃值不覆蓋上市
            '2026-10-05': [tp('6538', 'c', '50.6', '41.4'), tp('711111', 'w', '2', '1')]}
    _limit_files(F, days, twse, tpex)
    codes = ['1101', '2330', '6538', '7777']                              # 7777＝面板內新上市（欄位位移情境見下）
    Ui, Di, nd = SY.align_limits(OF, F, days, codes)
    Uf, Df = SY.full_limits(OF, F, days, codes)
    assert SY.arrays_equal(Ui, Uf) and SY.arrays_equal(Di, Df)
    assert Ui[0, 0] == 50.5 and Ui[0, 1] == 1100 and Ui[3, 0] == 9995
    assert Ui[1, 0] == 1.0                                                # 上市當日缺值（後列 '--' 覆蓋）⇒ 依 load_matrices 由上櫃前一列補（同一口徑）
    assert Ui[1, 2] == 49.5 and Ui[3, 2] == 50.6 and np.isnan(Ui[2, 2])   # 上櫃：前一「面板列」公布的次日漲停價
    assert np.isnan(Ui[:, 3]).all() and nd == {'twse_limit': 3, 'tpex_daily': 2}
    codes2 = ['1101', '1234', '2330', '6538', '7777']                     # 新代號插在中間：以代號字串對齊，不吃欄位索引
    Ui2, _, _ = SY.align_limits(OF, F, days, codes2)
    Uf2, _ = SY.full_limits(OF, F, days, codes2)
    assert SY.arrays_equal(Ui2, Uf2) and SY.arrays_equal(Ui2[:, [0, 2, 3, 4]], Ui)
    _limit_files(F, ['2026-10-05'], {'2026-10-05': [['1101', 'a', '55', '', '45', '']]}, {})       # 新的一天：增量解析
    Ui3, _, _ = SY.align_limits(OF, F, days, codes)
    Uf3, _ = SY.full_limits(OF, F, days, codes)
    assert SY.arrays_equal(Ui3, Uf3) and Ui3[2, 0] == 55


# ───────────────────────── 前向規則 ─────────────────────────
def test_strict_unknown_marks_market_when_mirror_day_missing():
    I = dict(dates=['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'],
             mkt=np.array(['TWSE', 'TPEx', 'unknown']),
             coverage=dict(base_to='2026-10-02', disposal=dict(TWSE=['2026-10-05', '2026-10-06', '2026-10-07'], TPEx=['2026-10-05', '2026-10-07']),
                           attention=dict(TWSE=['2026-10-05', '2026-10-06'], TPEx=['2026-10-05', '2026-10-06'])))
    dm, am, why = C.strict_unknown(I, 5)                                 # s＝10-07：處置看 [s−20, s]、注意看 [s−20, s−1]（10-02 之後）
    assert dm.tolist() == [False, True, True]                             # TPEx 處置 10-06 缺 ⇒ TPEx 與市場不明的列未知；TWSE 齊 ⇒ 已知
    assert why['TPEx']['disposal_missing_days'] == ['2026-10-06'] and why['TWSE']['disposal_missing_days'] == []
    assert am.tolist() == [False, False, False] and why['TWSE']['attention_missing_days'] == []   # 注意不看 s 當天（at_cnt 只用 ≤ s−1）
    dm2, _, _ = C.strict_unknown(I, 3)                                    # s＝10-05：兩市都有 10-05 ⇒ 全部已知
    assert dm2.tolist() == [False, False, False]
    I2 = dict(I, coverage=dict(I['coverage'], disposal=dict(TWSE=['2026-10-05', '2026-10-06'], TPEx=['2026-10-05', '2026-10-06'])))
    dm3, _, why3 = C.strict_unknown(I2, 5)                                # FDEV-007：缺 s 當天（10-07）⇒ 未知（鏡像處置鍵＝處置期間含 D；
    assert dm3.tolist() == [True, True, True]                             #  s 起處置、s−1 公布的那筆只在 s 以後的鏡像日）
    assert why3['TWSE']['disposal_missing_days'] == ['2026-10-07']


def test_compare_core_detects_track_rank_and_pool_diffs():
    base = dict(domain=dict(codes=['1', '2', '3'], track=[3, 6, 7]),
                lists={'S0_atr14@5': dict(n_pool=2, ranked_codes=['2', '9'], ranked_scores=[0.5, 0.4])})
    same = C.compare_core(base, json.loads(json.dumps(base)))
    assert same['equal'] and same['score_max_rel_diff'] == 0
    other = json.loads(json.dumps(base))
    other['domain']['track'] = [3, 7, 7]
    other['lists']['S0_atr14@5'].update(n_pool=3, ranked_codes=['9', '2'], ranked_scores=[0.5, 0.4 + 1e-12])
    d = C.compare_core(base, other)
    kinds = sorted(x['kind'] for x in d['diffs'])
    assert not d['equal'] and kinds == ['n_pool', 'rank_order', 'track'] and d['score_max_rel_diff'] > 0


def test_maturity_wait_ready_unavailable():
    F = _tmp()
    cal = IO.Calendar(['2026-10-09'], [2026])
    dates = ['2026-10-02', '2026-10-05', '2026-10-06']
    I = dict(dates=dates, p=dict(cache=F))
    fz = dict(date_s='2026-10-02')
    ok = dict(found=True, ready=True, nonOfficialOtcClose=False)
    basis = {'2026-10-05': ok, '2026-10-06': ok}
    m = SC.maturity(I, cal, fz, 'y', basis, '2026-10-06')
    assert m['state'] == 'wait' and any('TWT84U(2026-10-05)' in w for w in m['why'])
    for d in ('2026-10-05', '2026-10-06'):
        _gz(os.path.join(F, 'official', 'twse_limit', f'{d}.json.gz'), {})
    for d in ('2026-10-02', '2026-10-05'):
        _gz(os.path.join(F, 'official', 'tpex_daily', f'{d}.json.gz'), {})
    for d in ('2026-10-05', '2026-10-06'):
        json.dump(dict(date=d, items=[]), open(os.path.join(F, f'a35_shadow_exright_{d}.json'), 'w'))
    m = SC.maturity(I, cal, fz, 'y', basis, '2026-10-06')
    assert m == dict(state='ready', t='2026-10-05', due='2026-10-06', days=['2026-10-05', '2026-10-06'])
    m = SC.maturity(I, cal, fz, 'y', dict(basis, **{'2026-10-06': dict(ok, nonOfficialOtcClose=True)}), '2026-10-06')
    assert m['state'] == 'wait' and any('第三方' in w for w in m['why'])
    json.dump(dict(date='2026-10-06', items=[], twseOnly=True), open(os.path.join(F, 'a35_shadow_exright_2026-10-06.json'), 'w'))
    m = SC.maturity(I, cal, fz, 'y', basis, '2026-10-06')
    assert m['state'] == 'wait' and any('只有上市' in w for w in m['why'])
    I2 = dict(I, dates=['2026-10-02', '2026-10-06'])                    # 面板跳過 10-05（t 沒有收盤資料）
    assert SC.maturity(I2, cal, fz, 'y', basis, '2026-10-21')['state'] == 'wait'          # t＋1＝10-06 之後第 10 個交易日＝10-21：還在等
    m = SC.maturity(I2, cal, fz, 'y', basis, '2026-10-22')
    assert m['state'] == 'unavailable' and any('不是 2026-10-05' in w for w in m['why'])
    m = SC.maturity(I, cal, fz, 'c5', basis, '2026-10-06')
    assert m['due'] == '2026-10-12' and m['state'] == 'wait'


def test_boot_stats_and_gate_report_windows_halt_g500():
    st = SC.boot_stats([1, 0, 0, 2], [5, 5, 5, 5], [0.1, 0.1, 0.2, 0.1])
    assert st['hits'] == 3 and st['picks'] == 20 and abs(st['delta_pp'] - (3 - 0.5) / 20 * 100) < 1e-9
    assert st['delta_ci_pp'][0] <= st['delta_pp'] <= st['delta_ci_pp'][1]
    assert SC.boot_stats([], [], [])['delta_pp'] is None
    ok_proc = {f'P{i}': dict(ok=True) for i in range(1, 9)}
    w = lambda d, lo, hi: dict(delta_pp=d, delta_ci_pp=[lo, hi])
    good = {lid: w(0.5, 0.1, 0.9) for lid in SC.FWD_LIST_IDS}
    g = SC.gate_report({'g60': dict(good, **{'S0_atr14@5': w(-0.1, -0.5, -0.01)})}, 60, ok_proc)
    assert g['g60']['outcome'] == 'HALT-FOR-REVIEW' and g['g60']['crash']['S0_atr14@5'] is True and g['g250'] is None
    g = SC.gate_report({'g60': good}, 60, dict(ok_proc, P1=dict(ok=None)))                 # 無法判定的流程檢查不能當通過
    assert g['g60']['outcome'] == 'HALT-FOR-REVIEW' and g['g60']['failed_checks'] == ['P1']
    w250 = {'S0_atr14@5': w(0.5, 0.1, 0.9), 'SFB_atr14@5': w(0.3, -0.1, 0.7), 'R0_combo@5': w(0.3, -0.1, 0.5), 'W_atr14@3': w(1, 0.5, 2)}
    halted = SC.gate_report({'g60': dict(good, **{'S0_atr14@5': w(-0.1, -0.5, -0.01)}), 'g250': w250}, 250, ok_proc)
    assert halted['g250']['paused'] is True and all(v is None for v in halted['g250']['verdict'].values())
    ruled = SC.gate_report({'g60': dict(good, **{'S0_atr14@5': w(-0.1, -0.5, -0.01)}), 'g250': w250}, 250, ok_proc, ruling='CONTINUE')
    assert ruled['g250']['paused'] is False and ruled['g250']['verdict']['S0_atr14@5'] == 'CONFIRM'
    g = SC.gate_report({'g60': good, 'g250': w250}, 250, ok_proc)
    assert g['g250']['verdict'] == {'S0_atr14@5': 'CONFIRM', 'SFB_atr14@5': 'EXTEND', 'R0_combo@5': 'EXTEND', 'W_atr14@3': 'DESCRIPTIVE'} and g['g500'] is None
    w500 = dict(w250, **{'SFB_atr14@5': w(0.4, 0.05, 0.8), 'R0_combo@5': w(0.2, -0.2, 0.6)})
    g = SC.gate_report({'g60': good, 'g250': w250, 'g500': w500}, 500, ok_proc)
    assert g['g500']['verdict'] == {'SFB_atr14@5': 'CONFIRM', 'R0_combo@5': 'STAY-WATCH'}          # 只對 EXTEND；R0 的 DROP＝維持灰底


def test_g60_ruling_reads_last_line():
    d = _tmp()
    lp = os.path.join(d, 'dev.md')
    open(lp, 'w', encoding='utf-8').write('## FDEV-009\nG60-RULING: HALT 2027-01-20\n說明 G60-RULING: CONTINUE（行中不算）\nG60-RULING: CONTINUE 2027-01-25 使用者核可\n')
    assert SC.g60_ruling(lp) == 'CONTINUE'
    assert SC.g60_ruling(os.path.join(d, 'none.md')) is None


def test_flags_dtna_and_disp_t_unknown():
    assert SC.flags_fwd(0.0, 1, True, 0, 'PENDING', 'NA') == 'DISP_T;C5_PENDING'
    assert SC.flags_fwd(np.nan, None, True, 0, 'NA', 'NA') == 'DKNA;DTNA'
    assert SC.flags_fwd(0.0, None, False, 0, 'NA', 'NA') == 'DTNA;NO_OPEN_T'
    assert 't 日起處置狀態未知' in SC.flags_text_fwd('DKNA;DTNA')
    I = dict(dates=['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'], mkt=np.array(['TWSE', 'TPEx', 'unknown']),
             coverage=dict(base_to='2026-10-02', disposal=dict(TWSE=['2026-10-05', '2026-10-06', '2026-10-07'], TPEx=['2026-10-05', '2026-10-07'])))
    m, why = C.disp_t_unknown(I, 4)                                       # s＝10-06：看 [s−20, s] 中 10-02 之後的 10-05、10-06，再加 t＝10-07
    assert m.tolist() == [False, True, True] and why == dict(TWSE=[], TPEx=['2026-10-06'])
    m2, _ = C.disp_t_unknown(I, 1)                                        # 歷史日（s、t ≤ BASE_TO）：釘住檔涵蓋，全部已知
    assert m2.tolist() == [False, False, False]
    m3, why3 = C.disp_t_unknown(I, 2)                                     # s＝10-02（≤ BASE_TO）但 t＝10-05：鏡像兩市都有 ⇒ 已知
    assert m3.tolist() == [False, False, False] and why3 == dict(TWSE=[], TPEx=[])
    I2 = dict(I, coverage=dict(I['coverage'], disposal=dict(TWSE=['2026-10-05', '2026-10-06'], TPEx=['2026-10-05', '2026-10-06'])))
    m4, why4 = C.disp_t_unknown(I2, 4)                                    # FDEV-007：缺 t 當天（10-07）⇒ 未知（s 晚上公布、t 起處置的那筆只在 t 以後）
    assert m4.tolist() == [True, True, True] and why4 == dict(TWSE=['2026-10-07'], TPEx=['2026-10-07'])
    m5, why5 = C.disp_t_unknown(I, 5)                                     # 面板沒有 t 列：無法確認 ⇒ 未知
    assert m5.all() and why5['TWSE'] == ['面板沒有 t 列']


def _fake_freeze_inputs(out, cache, closes_tpex=True, limits_twse=True):
    dates = ['2026-10-01', '2026-10-02', '2026-10-05']
    codes = [f'1{i:03d}' for i in range(900)] + [f'6{i:03d}' for i in range(600)]
    mkt = np.array(['TWSE'] * 900 + ['TPEx'] * 600)
    Cc = np.full((3, len(codes)), 10.0)
    if not closes_tpex:
        Cc[2, 900:] = np.nan                                              # 上櫃整批消失（本專案的故障族）
    U = np.full((3, len(codes)), 11.0)
    if not limits_twse:
        U[2, :900] = np.nan                                               # 鏡像回應格式漂移、解析出 0 列
    for ds, d in (('twse_limit', '2026-10-05'), ('tpex_daily', '2026-10-02')):
        _gz(os.path.join(cache, 'official', ds, f'{d}.json.gz'), {})
    cal = IO.Calendar([], [2026])
    to = (IO.read_json(os.path.join(IO.LAB, '..', 'data', 'exright-history.json')) or {}).get('to') or '2026-10-02'
    for d in cal.between(to, '2026-10-05'):                               # C3：exright-history 之後每個交易日都有兩市補抓檔
        json.dump(dict(date=d, items=[]), open(os.path.join(cache, f'a35_shadow_exright_{d}.json'), 'w'))
    I = dict(p=dict(out=out, cache=cache, official_root=cache), dates=dates, codes=codes, mkt=mkt, P=dict(C=Cc), U=U,
             pins=dict(ok=True, mismatches=[]))
    ok = dict(found=True, ready=True, nonOfficialOtcClose=False)
    ctx = dict(plan=dict(preflightBlocks=[]), cal=cal, now=IO.now_tw('2026-10-05T23:50'), now_override=None, rehearsal=True,
               basis={'2026-10-05': ok}, prewire=dict(ok=True))
    return I, ctx


def test_c1b_c2b_block_freeze_when_market_missing():
    orig = C.listing_asof
    C.listing_asof = lambda root, day: dict(snaps={}, names={}, files={}, sha256='x')
    exr = os.path.join(IO.LAB, '..', 'data', 'exright-history.json')
    try:
        for kw, key in ((dict(closes_tpex=False), 'C1b'), (dict(limits_twse=False), 'C2b')):
            out, cache = _tmp(), _tmp()
            I, ctx = _fake_freeze_inputs(out, cache, **kw)
            cond = FWD.conditions(I, dict(ctx, listing=dict(snaps={})), '2026-10-05', '2026-10-06')
            assert cond[key]['ok'] is False, (key, cond[key])
            r = FWD.freeze_core(I, ctx, '2026-10-05', '2026-10-06')
            assert r['result'] == 'wait' and key in r['unmet'], r
            assert not os.path.exists(SC.core_path(out, '2026-10-05'))       # 面板缺半個市場：絕不凍結（凍結檔寫一次、不覆寫）
        out, cache = _tmp(), _tmp()
        I, ctx = _fake_freeze_inputs(out, cache)
        cond = FWD.conditions(I, dict(ctx, listing=dict(snaps={})), '2026-10-05', '2026-10-06')
        assert cond['C1b']['ok'] and cond['C2b']['ok'] and cond['C1b']['counts']['TPEx'] == 600, (cond['C1b'], cond['C2b'])
        assert cond['C2b']['coverage']['TWSE']['n_tick_fallback'] == 0
    finally:
        C.listing_asof = orig
    assert os.path.exists(exr)


def test_c6_assertion_failure_writes_gap_immediately():
    orig_l, orig_b = C.listing_asof, C.build_core
    C.listing_asof = lambda root, day: dict(snaps={}, names={}, files={}, sha256='x')

    def boom(*a, **k):
        raise AssertionError('分區 assertion：測試')
    C.build_core = boom
    try:
        out, cache = _tmp(), _tmp()
        I, ctx = _fake_freeze_inputs(out, cache)
        r = FWD.freeze_core(I, ctx, '2026-10-05', '2026-10-06')
        assert r['result'] == 'gap' and r['unmet'] == ['C6'] and r['write'] == 'written', r
        g = json.load(open(SC.gap_path(out, '2026-10-05')))
        assert 'C6' in g['reason'] and list(g['unmet_conditions']) == ['C6'] and IO.verify_seal(g)
    finally:
        C.listing_asof, C.build_core = orig_l, orig_b


def test_disp_att_overlap_delegates_to_corrected_check():
    """第一版（公布日分組、整列比對）已由 a37_tracks_dispatt 取代（FDEV-007）；細部語意測試在 a37_tracks_dispatt_test.py。"""
    root, F = _tmp(), _tmp()
    for (kind, mkt), (host, ds, fname, code_col) in SY.DISP_ATT.items():
        _disp_base(F, fname, ['編號', '公布日期', '證券代號', '處置起迄時間', '處置起訖時間', '日期', '公告日期'], [])
    r = FWD.disp_att_overlap(dict(cache=F, official_root=root))             # 鏡像從未產出：0 天、沒有面板 ⇒ pending
    assert r['status'] == 'pending' and r['check']['file'] == 'a37_tracks_dispatt.py' and r['days_total'] == 0
    assert 'a37_tracks_dispatt.py' in FWD.PREWIRE_CODE                       # 比對程式改了就要重跑接線前證明


def test_process_checks_p1_flags_silent_days():
    out = _tmp()
    cal = IO.Calendar(['2026-10-09'], [2026])
    now = IO.now_tw('2026-10-12T10:00')
    proc = FWD.process_checks([], {'2026-10-06': dict(seal='x', unmet_conditions={})}, cal, '2026-10-05', now, out)
    p1 = proc['P1']
    assert p1['n_trading_days'] == 4 and p1['silent_days'] == ['2026-10-05', '2026-10-07', '2026-10-08'] and p1['ok'] is False   # 10-12 期限 10-13 09:00 未到
    assert proc['P2']['ok'] is False                                     # 缺口檔封印不符
    assert FWD.process_checks([], {}, None, None, None, out)['P1']['ok'] is None


# ───────────────────────── 缺口與時鐘閘 ─────────────────────────
def test_gap_written_once_with_blocks_and_clock_gate_before_compute():
    out = _tmp()
    p = dict(out=out)
    ctx = dict(plan=dict(preflightBlocks=['2026-10-05T12:00', '2026-10-05T22:40', '2026-10-06T07:05', '2026-10-06T10:00']),
               now=IO.now_tw('2026-10-06T09:30'), rehearsal=False, now_override=None)
    os.makedirs(os.path.join(out, 'wait'), exist_ok=True)
    json.dump(dict(time='2026-10-06T07:05:00+08:00', unmet=dict(C2=dict(ok=False))), open(SC.wait_path(out, '2026-10-05'), 'w'))
    assert FWD.write_gap(p, ctx, '2026-10-05', '2026-10-06', '測試') == 'written'
    g = json.load(open(SC.gap_path(out, '2026-10-05')))
    assert IO.verify_seal(g) and g['blocked_slots'] == ['2026-10-05T22:40', '2026-10-06T07:05'] and list(g['unmet_conditions']) == ['C2']
    assert FWD.write_gap(p, ctx, '2026-10-05', '2026-10-06', '另一個理由') == 'exists'
    r = FWD.freeze_core(dict(p=p), dict(ctx, now=IO.now_tw('2026-10-07T09:00')), '2026-10-06', '2026-10-07')
    assert r['result'] == 'gap' and os.path.exists(SC.gap_path(out, '2026-10-06'))
    assert FWD.freeze_core(dict(p=p), ctx, '2026-10-06', '2026-10-07')['result'] == 'gap-exists'


def test_prewire_gate_pass_only_binding_and_approval():
    out = _tmp()
    p = dict(cache='/x/.surge-cache-F', official_root='/o')
    assert FWD.prewire_gate(out, p)['ok'] is False
    checks = dict(listing=dict(status='pass'), limits_incremental=dict(status='pass'), research_path=dict(status='pass'), disp_att_overlap=dict(status='pending'))
    base = dict(checks=checks, cache='/x/.surge-cache-F', official_root='/o', code_sha256=FWD.code_digest())
    put = lambda doc: IO.write_json_atomic(os.path.join(out, FWD.PREWIRE_PATH), IO.sealed(doc))
    put(base)
    g = FWD.prewire_gate(out, p)
    assert g['ok'] is False and 'pending' in g['why']                                   # 預設只接受 pass
    assert FWD.prewire_gate(out, p, dict(allowDispAttPending='yes'))['ok'] is False      # 格式不對＝不算核可
    appr = 'FDEV-001 使用者核可 2026-10-07（處置／注意重疊比對待鏡像回補）'
    g = FWD.prewire_gate(out, p, dict(allowDispAttPending=appr))
    assert g['ok'] is True and g['disp_att_pending_approval'] == appr
    assert FWD.prewire_gate(out, p, dict(allowDispAttPending=appr), overlap=dict(status='fail'))['ok'] is False   # 每輪重算落定 fail ⇒ 擋
    assert FWD.prewire_gate(out, p, overlap=dict(status='pass'))['ok'] is True         # 鏡像回補後重算 pass ⇒ 不需核可
    other = dict(cache='/w/worktree/.surge-cache-F', official_root='/o')
    assert FWD.prewire_gate(out, other, overlap=dict(status='pass'))['ok'] is False    # 證明不是在正式環境做的
    g = FWD.prewire_gate(out, other, overlap=dict(status='pass'), rehearsal=True)
    assert g['ok'] is True and g['rehearsal_binding']['cache']['proof'] == '/x/.surge-cache-F'
    put(dict(base, code_sha256=dict(base['code_sha256'], **{'a37_tracks_core.py': '0' * 64})))
    assert '程式與證明時不同' in FWD.prewire_gate(out, p, overlap=dict(status='pass'))['why']
    put(dict(base, checks=dict(checks, research_path=dict(status='fail'))))
    assert FWD.prewire_gate(out, p, overlap=dict(status='pass'))['ok'] is False
    IO.write_json_atomic(os.path.join(out, FWD.PREWIRE_PATH), dict(base, seal='0' * 64))      # 封印不符
    assert FWD.prewire_gate(out, p, overlap=dict(status='pass'))['ok'] is False


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for t in tests:
        t()
    print(f'{len(tests)} 項測試全部通過')
