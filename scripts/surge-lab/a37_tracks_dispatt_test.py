"""處置／注意重疊比對（a37_tracks_dispatt，FDEV-007）的合成資料測試：python3 a37_tracks_dispatt_test.py（或 pytest -q）。
涵蓋：逐日查詢＝「處置期間含 D」／「注意日期＝D」的語意、查詢區間相依欄（編號、累計）排除、其他欄位照比；推導層抓得到
「前向未知規則漏看 s 當天 ⇒ DK_s 捏造 0」；決定記錄以比對程式 sha256 為鍵、只寫一次；舊版封印 fail 要有 OVERLAP-SUPERSEDE 才算取代；
本檔的比對程式 sha256 已登錄在前向偏差紀錄。
"""
import contextlib
import datetime
import gzip
import json
import os
import tempfile

import numpy as np

import a37_tracks_core as C
import a37_tracks_dispatt as DA
import a37_tracks_fwd as FWD
import a37_tracks_fwd_io as IO
import a37_tracks_sync as SY

TW_D = ['編號', '公布日期', '證券代號', '證券名稱', '累計', '處置條件', '處置起迄時間', '處置措施', '處置內容', '備註']
TP_D = ['編號', '公布日期', '證券代號', '證券名稱', '累計', '處置起訖時間', '處置原因', '處置措施', '處置內容', '收盤價', '本益比', ' ']
TW_A = ['編號', '證券代號', '證券名稱', '累計次數', '注意交易資訊', '日期', '收盤價', '本益比']
TP_A = ['編號', '證券代號', '證券名稱', '累計', '注意交易資訊', '公告日期', '收盤價', '本益比', 'link']
DISPOSALS = [   # (市場, 代號, 公布日, 起, 迄, 條件／原因)
    ('TWSE', '2454', '2026-08-12', '2026-08-13', '2026-08-19', '連續三次'),
    ('TWSE', '2330', '2026-09-04', '2026-09-07', '2026-09-11', '連續三次'),
    ('TWSE', '1101', '2026-09-14', '2026-09-15', '2026-09-21', '連續五次及當日沖銷標準'),
    ('TPEx', '8299', '2026-08-27', '2026-08-28', '2026-09-03', '連續3個營業日'),
    ('TPEx', '6488', '2026-09-08', '2026-09-09', '2026-09-15', '連續3個營業日及沖銷標準'),
]
CODES = ['1101', '2330', '2454', '6488', '8299']
MKT = np.array(['TWSE', 'TWSE', 'TWSE', 'TPEx', 'TPEx'])
MIRROR_DAYS = ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16',
               '2026-09-17', '2026-09-18']
OVERLAP_TO = '2026-09-18'


def _weekdays(a, b):
    d, out = datetime.date.fromisoformat(a), []
    while d.isoformat() <= b:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += datetime.timedelta(days=1)
    return out


DATES = _weekdays('2026-08-03', '2026-09-30')


def _roc(d, sep='/'):
    y, m, dd = d.split('-')
    return f'{int(y) - 1911}{sep}{m}{sep}{dd}'


def _attn():
    """每個交易日兩市各一筆面板外的填充列（避免研究的「零筆日」遮罩讓比對變空）＋幾筆面板內的注意股。"""
    rows = []
    for d in DATES:
        rows.append(('TWSE', '9998', d, '當日週轉率達 9%﹝第十款﹞。'))
        rows.append(('TPEx', '9997', d, '當日週轉率達 9%(第十款)'))
    rows += [('TWSE', '2330', '2026-09-03', '最近六個營業日累積收盤價漲幅達 32%﹝第一款﹞。'),
             ('TWSE', '1101', '2026-09-10', '最近六個營業日累積收盤價漲幅達 30%﹝第一款﹞。'),
             ('TWSE', '1101', '2026-09-11', '最近六個營業日累積收盤價漲幅達 35%﹝第一款﹞。'),
             ('TWSE', '1101', '2026-09-14', '最近六個營業日累積收盤價漲幅達 40%﹝第一款﹞。'),
             ('TPEx', '6488', '2026-09-04', '最近六個營業日累積收盤價漲幅達 33%(第一款)'),
             ('TPEx', '6488', '2026-09-08', '最近六個營業日累積收盤價漲幅達 36%(第一款)'),
             ('TPEx', '8299', '2026-09-16', '最近六個營業日累積收盤價跌幅達 30%(第一款)')]
    return rows


def _query(lo, hi):
    """官方端點在查詢區間 [lo, hi] 的回應（各資料集的 data 列）：處置＝處置期間與區間重疊；注意＝日期在區間內。
    編號＝結果內序號；處置「累計」與上市注意「累計次數」＝結果內該代號的列數（查詢區間相依）；上櫃注意「累計」固定。"""
    out = {}
    for mk in ('TWSE', 'TPEx'):
        ds = [x for x in DISPOSALS if x[0] == mk and x[3] <= hi and x[4] >= lo]
        cnt = {c: sum(1 for y in ds if y[1] == c) for _, c, *_ in ds}
        if mk == 'TWSE':
            out[('disposal', mk)] = [[i + 1, _roc(p), c, f'名{c}', cnt[c], cond, f'{_roc(a)}～{_roc(b)}', '第一次處置', '內容', '']
                                     for i, (_, c, p, a, b, cond) in enumerate(ds)]
        else:
            out[('disposal', mk)] = [[i + 1, _roc(p), c, f'名{c}', cnt[c], f'{_roc(a)}~{_roc(b)}', cond, '第一次處置', '內容', '10', '20', '']
                                     for i, (_, c, p, a, b, cond) in enumerate(ds)]
        at = [x for x in _attn() if x[0] == mk and lo <= x[2] <= hi]
        ca = {c: sum(1 for y in at if y[1] == c) for _, c, *_ in at}
        if mk == 'TWSE':
            out[('attention', mk)] = [[i + 1, c, f'名{c}', str(ca[c]), txt, _roc(d, '.'), '10.0', '---'] for i, (_, c, d, txt) in enumerate(at)]
        else:
            out[('attention', mk)] = [[i + 1, c, f'名{c}', 7, txt, _roc(d), '10', 'N/A', f'l{c}'] for i, (_, c, d, txt) in enumerate(at)]
    return out


FIELDS = {('disposal', 'TWSE'): TW_D, ('disposal', 'TPEx'): TP_D, ('attention', 'TWSE'): TW_A, ('attention', 'TPEx'): TP_A}


def _gz(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, 'wt', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def _world(mirror_days=MIRROR_DAYS, tweak=None):
    """釘住檔＝逐月查詢（2026-08、2026-09）串接；鏡像＝逐日查詢。tweak(kind_mkt, day, rows) 可改某天的鏡像列。"""
    root, F = tempfile.mkdtemp(prefix='dartroot'), tempfile.mkdtemp(prefix='dartcache')
    months = [('2026-08-01', '2026-08-31'), ('2026-09-01', '2026-09-30')]
    base = {k: [] for k in FIELDS}
    for lo, hi in months:
        for k, rows in _query(lo, hi).items():
            base[k] += rows
    for k, (host, ds, fname, code_col) in SY.DISP_ATT.items():
        os.makedirs(os.path.join(F, 'base'), exist_ok=True)
        json.dump(dict(fields=FIELDS[k], data=base[k]), open(os.path.join(F, 'base', fname), 'w', encoding='utf-8'), ensure_ascii=False)
        d = os.path.join(root, host, ds)
        man = dict(rows={})
        for day in mirror_days:
            rows = _query(day, day)[k]
            if tweak:
                rows = tweak(k, day, rows)
            man['rows'][day] = dict(status='ok' if rows else 'empty', echo=day, final=True, file=f'{day}.json.gz')
            payload = dict(fields=FIELDS[k], data=rows) if k[1] == 'TWSE' else dict(tables=[dict(fields=FIELDS[k], data=rows)])
            _gz(os.path.join(d, f'{day}.json.gz'), dict(meta={}, payload=payload))
        os.makedirs(d, exist_ok=True)
        json.dump(man, open(os.path.join(d, '_manifest.json'), 'w'))
    return dict(cache=F, official_root=root)


PANEL = dict(dates=DATES, codes=CODES, mkt=MKT)


@contextlib.contextmanager
def _base_to(v):
    with SY._patched(SY, 'BASE_TO', v):
        yield


# ───────────────────────── 語意 ─────────────────────────
def test_query_semantics_disposal_by_period_attention_by_date():
    on = DA.pinned_index(('disposal', 'TWSE'), TW_D, _query('2026-09-01', '2026-09-30')[('disposal', 'TWSE')])
    assert sorted(r[2] for r in on('2026-09-14')) == []                  # 1101 9/14 公布、9/15 起處置：9/14 的逐日查詢沒有它
    assert sorted(r[2] for r in on('2026-09-15')) == ['1101']
    assert sorted(r[2] for r in on('2026-09-08')) == ['2330']            # 2330 9/4 公布：在處置期間每一天都出現
    ona = DA.pinned_index(('attention', 'TWSE'), TW_A, _query('2026-09-01', '2026-09-30')[('attention', 'TWSE')])
    assert sorted(r[1] for r in ona('2026-09-11')) == ['1101', '9998']


def test_overlap_passes_when_only_query_dependent_columns_differ():
    p = _world()
    with _base_to(OVERLAP_TO):
        r = DA.overlap_check(p, PANEL)
    assert r['status'] == 'pass', r['why']
    assert all(v['days_compared'] == 10 and v['n_mismatched'] == 0 for v in r['datasets'].values())
    f = r['derived']['fields']
    assert f['dk_s']['days'] == 10 and f['dk_s']['mismatched_cells'] == 0 and f['dk_s']['fully_known_days'] == 10
    assert f['disp_t_exec']['days'] == 9 and f['at_known20']['mismatched_cells'] == 0
    assert r['check']['sha256'] == DA.check_sha256()


def test_overlap_fails_on_real_content_difference_and_tpex_attention_cum():
    def content(k, day, rows):
        if k == ('disposal', 'TWSE') and day == '2026-09-16':
            return [r[:7] + ['第二次處置'] + r[8:] for r in rows]          # 處置措施不同＝真的不同
        return rows
    with _base_to(OVERLAP_TO):
        r = DA.overlap_check(_world(tweak=content), PANEL)
    assert r['status'] == 'fail' and r['datasets']['disposal_TWSE']['n_mismatched'] == 1

    def cum(k, day, rows):
        if k == ('attention', 'TPEx') and day == '2026-09-08':
            return [r[:3] + [8] + r[4:] for r in rows]                     # 上櫃注意的「累計」與查詢區間無關 ⇒ 照比
        return rows
    with _base_to(OVERLAP_TO):
        r = DA.overlap_check(_world(tweak=cum), PANEL)
    assert r['status'] == 'fail' and r['datasets']['attention_TPEx']['n_mismatched'] == 1


def test_overlap_pending_when_few_days_or_no_panel():
    with _base_to(OVERLAP_TO):
        r = DA.overlap_check(_world(mirror_days=MIRROR_DAYS[:4]), PANEL)
        assert r['status'] == 'pending' and '不足 5 天' in r['why'] and r['derived'] is None
        r = DA.overlap_check(_world(), None)
        assert r['status'] == 'pending' and '沒有面板' in r['why']


def test_derived_layer_catches_unknown_rule_that_skips_day_s():
    """鏡像缺 9/15 那天：前向未知規則若只看 [s−20, s−1]（FDEV-002 原文），s＝9/15 的 1101（9/14 公布、9/15 起處置）DK_s 會被算成 0。"""
    days = [d for d in MIRROR_DAYS if d != '2026-09-15']
    p = _world(mirror_days=days)
    with _base_to(OVERLAP_TO):
        r = DA.overlap_check(p, PANEL)                                    # 現行規則：缺日記未知，不是不同
    assert r['status'] == 'pass' and r['derived']['n_diffs'] == 0, r['why']
    assert r['derived']['fields']['dk_s']['unknown_cells'] > 0

    def old_rule(I, s):
        dates, mkt, cov = I['dates'], I['mkt'], I['coverage']
        dd = [d for d in dates[max(0, s - 20):s] if d > cov['base_to']]
        dm = np.zeros(len(mkt), bool)
        for src in ('TWSE', 'TPEx'):
            if any(d not in set(cov['disposal'].get(src, [])) for d in dd):
                dm |= (mkt == src) | (mkt == 'unknown')
        return dm, np.zeros(len(mkt), bool), {}
    with _base_to(OVERLAP_TO), SY._patched(C, 'strict_unknown', old_rule):
        r = DA.overlap_check(p, PANEL)
    assert r['status'] == 'fail'
    assert any(x['day'] == '2026-09-15' and x['field'] == 'dk_s' and '1101' in x['codes'] for x in r['derived']['diffs'])


# ───────────────────────── 決定記錄與取代 ─────────────────────────
def _devlog(lines):
    p = os.path.join(tempfile.mkdtemp(prefix='dartlog'), 'dev.md')
    open(p, 'w', encoding='utf-8').write('# 測試\n' + ''.join(f'{x}\n' for x in lines) + '說明 OVERLAP-CHECK: a37_tracks_dispatt.py ' + 'f' * 64 + '（行中不算）\n')
    return p


def _put(out, rel, doc):
    path = os.path.join(out, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'wb').write(IO.canon_bytes(doc))
    return doc


def test_record_decision_keyed_by_check_sha_first_decision_stands():
    out = tempfile.mkdtemp(prefix='dartout')
    sha = 'a' * 64
    assert DA.record_decision(out, dict(status='pending', check=dict(sha256=sha))) == 'not-decided'
    assert DA.record_decision(out, dict(status='fail', check=dict(sha256=sha), x=1)) == 'written'
    assert DA.record_decision(out, dict(status='pass', check=dict(sha256=sha))).startswith('exists:tracks_fwd_dispatt_overlap_' + sha + '_fail')
    assert DA.record_decision(out, dict(status='pass', check=dict(sha256='b' * 64))) == 'written'       # 新版比對另一個鍵；舊檔不動
    names = sorted(os.listdir(os.path.join(out, 'prewire')))
    assert names == [f'tracks_fwd_dispatt_overlap_{sha}_fail.json', f'tracks_fwd_dispatt_overlap_{"b" * 64}_pass.json']
    doc = json.load(open(os.path.join(out, 'prewire', names[0])))
    assert IO.verify_seal(doc) and doc['status'] == 'fail' and doc['kind'] == 't1-tracks-dispatt-overlap'


def test_decision_state_registration_sealed_fail_and_supersede():
    out, cur = tempfile.mkdtemp(prefix='dartout'), 'c' * 64
    assert '未登錄' in DA.decision_state(out, _devlog([]), sha=cur)['why']
    reg = f'OVERLAP-CHECK: a37_tracks_dispatt.py {cur}'
    assert DA.decision_state(out, _devlog([reg]), sha=cur)['ok'] is True
    legacy = _put(out, 'prewire/tracks_fwd_prewire_20261005T224747.json',
                  IO.sealed(dict(kind='t1-tracks-prewire', checks=dict(disp_att_overlap=dict(status='fail')))))   # 第一版：無 check sha
    st = DA.decision_state(out, _devlog([reg]), sha=cur)
    assert st['ok'] is False and '未被取代' in st['why']
    wrong = f'OVERLAP-SUPERSEDE: prewire/tracks_fwd_prewire_20261005T224747.json {"0" * 64} FDEV-007'
    assert DA.decision_state(out, _devlog([reg, wrong]), sha=cur)['ok'] is False                       # 封印不對＝沒有取代
    sup = f'OVERLAP-SUPERSEDE: prewire/tracks_fwd_prewire_20261005T224747.json {legacy["seal"]} FDEV-007'
    st = DA.decision_state(out, _devlog([reg, sup]), sha=cur)
    assert st['ok'] is True and st['superseded'][0]['by'] == 'FDEV-007'
    assert os.path.exists(os.path.join(out, 'prewire', 'tracks_fwd_prewire_20261005T224747.json'))      # 舊檔保留
    _put(out, f'prewire/tracks_fwd_dispatt_overlap_{cur}_fail.json', IO.sealed(dict(status='fail', check=dict(sha256=cur))))
    st = DA.decision_state(out, _devlog([reg, sup]), sha=cur)
    assert st['ok'] is False and '本版比對已封印 fail' in st['why']                                       # 本版落定 fail：要換版＋偏差
    out2 = tempfile.mkdtemp(prefix='dartout')
    _put(out2, f'prewire/tracks_fwd_dispatt_overlap_{cur}_pass.json', dict(IO.sealed(dict(status='pass', check=dict(sha256=cur))), status='fail'))
    assert '封印或內容不符' in DA.decision_state(out2, _devlog([reg]), sha=cur)['why']
    _put(out2, 'prewire/tracks_fwd_dispatt_overlap_fail.json', IO.sealed(dict(status='fail')))         # 第一版決定檔也要取代
    assert '未被取代' in DA.decision_state(out2, _devlog([reg]), sha=cur)['why']


def test_prewire_gate_blocks_unsuperseded_legacy_fail():
    out = tempfile.mkdtemp(prefix='dartout')
    p = dict(cache='/x/.surge-cache-F', official_root='/o')
    checks = dict(listing=dict(status='pass'), limits_incremental=dict(status='pass'), research_path=dict(status='pass'),
                  disp_att_overlap=dict(status='pass', check=dict(sha256=DA.check_sha256())))
    IO.write_json_atomic(os.path.join(out, FWD.PREWIRE_PATH), IO.sealed(dict(checks=checks, cache=p['cache'], official_root='/o', code_sha256=FWD.code_digest())))
    reg = f'OVERLAP-CHECK: a37_tracks_dispatt.py {DA.check_sha256()}'
    assert FWD.prewire_gate(out, p, overlap=dict(status='pass'), devlog=_devlog([reg]))['ok'] is True
    legacy = _put(out, 'prewire/tracks_fwd_prewire_20261005T224747.json',
                  IO.sealed(dict(kind='t1-tracks-prewire', checks=dict(disp_att_overlap=dict(status='fail')))))
    g = FWD.prewire_gate(out, p, overlap=dict(status='pass'), devlog=_devlog([reg]))
    assert g['ok'] is False and '未被取代' in g['why']
    sup = f'OVERLAP-SUPERSEDE: prewire/tracks_fwd_prewire_20261005T224747.json {legacy["seal"]} FDEV-007'
    g = FWD.prewire_gate(out, p, overlap=dict(status='pass'), devlog=_devlog([reg, sup]))
    assert g['ok'] is True and g['overlap_decision']['superseded'][0]['rel'] == 'prewire/tracks_fwd_prewire_20261005T224747.json'
    assert FWD.prewire_gate(out, p, overlap=dict(status='pass'), devlog=_devlog([sup]))['ok'] is False   # 本版比對沒登錄


def test_current_check_is_registered_in_forward_deviation_log():
    reg = DA.registry()
    assert DA.check_sha256() in reg['checks'], f'{DA.CHECK_NAME} 改過但前向偏差紀錄沒有新的 OVERLAP-CHECK 列（sha256 {DA.check_sha256()}）'
    assert all(fdev.startswith('FDEV-') for fdev in reg['superseded'].values())


if __name__ == '__main__':
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for t in tests:
        t()
    print(f'{len(tests)} 項測試全部通過')
