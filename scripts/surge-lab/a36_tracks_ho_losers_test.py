"""a36_tracks_ho_losers 純函式的合成資料測試（python3 a36_tracks_ho_losers_test.py 或 pytest -q a36_tracks_ho_losers_test.py）。
涵蓋：只改落選模型的檢查點路徑且離開時還原、釘住快取的檔案清單比對、HO-model 與鎖後標籤、記錄檔原檔／gzip 規則與逐位還原、
SURGE_CACHE 守門（fit 只准 T3、eval 只准 T）。
"""
import gzip
import os
import tempfile

import numpy as np
import pandas as pd

import a36_tracks_fit as FIT
import a36_tracks_ho_losers as HL


def test_loser_ckpts_routed_only_and_restored():
    orig = FIT.ckpt_path
    with HL.loser_ckpts_from('/tmp/clone/cv') as routed:
        assert FIT.ckpt_path is routed
        for m in HL.LOSER_MODELS:
            assert FIT.ckpt_path(m, 'HO4', 0) == f'/tmp/clone/cv/a36_fit_{m}_HO4_s0.npz'
        for m in ('M0', 'M0s', 'Mp1', 'R1'):
            assert FIT.ckpt_path(m, 'HO4', 0) == orig(m, 'HO4', 0)          # 鎖定模型仍讀釘住快取
    assert FIT.ckpt_path is orig


def test_loser_ckpts_restored_on_error():
    orig = FIT.ckpt_path
    try:
        with HL.loser_ckpts_from('/tmp/x'):
            raise RuntimeError('boom')
    except RuntimeError:
        pass
    assert FIT.ckpt_path is orig


def test_tree_manifest_detects_add_change_remove():
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, 'a'))
        for n in ('a/x.bin', 'y.bin'):
            open(os.path.join(d, n), 'wb').write(b'1')
        m0 = HL.tree_manifest(d)
        assert set(m0) == {'a/x.bin', 'y.bin'} and HL.manifest_diff(m0, HL.tree_manifest(d)) == dict(added=[], removed=[], changed=[])
        open(os.path.join(d, 'a/x.bin'), 'wb').write(b'22')
        open(os.path.join(d, 'z.bin'), 'wb').write(b'3')
        os.remove(os.path.join(d, 'y.bin'))
        assert HL.manifest_diff(m0, HL.tree_manifest(d)) == dict(added=['z.bin'], removed=['y.bin'], changed=['a/x.bin'])


def test_label_rows_marks_ho_model_folds_and_post_lock_label():
    fr = pd.DataFrame({'fold': [1, 3, 4, 6], 'list_id': ['S1@5'] * 4})
    out = HL.label_rows(fr)
    assert out.ho_model_window.str.startswith('HO-model').tolist() == [False, False, True, True]
    assert out.ho_model_window[0].endswith('面板起點限制，不作判定')
    assert all(x.startswith(HL.LABEL) and '非投資建議' in x for x in out.addendum_note)
    assert 'ho_model_window' not in fr                                   # 不改輸入
    assert HL.label_rows(pd.DataFrame()).empty


def test_write_record_raw_then_gzip_roundtrip():
    small = pd.DataFrame({'a': [1, 2], 'b': ['x', 'y']})
    rng = np.random.default_rng(5)
    big = pd.DataFrame({'a': np.arange(60_000), 'b': rng.random(60_000)})
    with tempfile.TemporaryDirectory() as d:
        r1 = HL.write_record(d, 's.csv', small)
        assert r1['files'][0]['path'] == 's.csv' and r1['rows'] == 2
        assert open(os.path.join(d, 's.csv'), 'rb').read() == small.to_csv(index=False).encode('utf-8')
        r2 = HL.write_record(d, 'b.csv', big)
        assert r2['raw_bytes'] > 500_000 and r2['files'][0]['path'] == 'b.csv.gz' and r2['rows'] == 60_000
        assert gzip.decompress(open(os.path.join(d, 'b.csv.gz'), 'rb').read()) == big.to_csv(index=False).encode('utf-8')
        assert HL.write_record(d, 'b.csv', big)['files'][0]['sha256'] == r2['files'][0]['sha256']   # mtime＝0：可重現


def test_require_cache_refuses_other_dirs():
    if HL.same_dir(FIT.B.SP, HL.CACHE_T3):
        HL.require_cache(HL.CACHE_T3)
    for bad in (HL.CACHE_T, '/nonexistent/.surge-cache'):
        if not HL.same_dir(FIT.B.SP, bad):
            try:
                HL.require_cache(bad)
                raise AssertionError('應拒跑')
            except SystemExit as e:
                assert '拒跑' in str(e)


if __name__ == '__main__':
    for k, f in list(globals().items()):
        if k.startswith('test_'):
            f()
            print('ok', k)
