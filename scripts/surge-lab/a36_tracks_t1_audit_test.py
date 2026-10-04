"""a36_tracks_t1_audit 純函式的合成資料測試（python3 a36_tracks_t1_audit_test.py 或 pytest -q a36_tracks_t1_audit_test.py）。
涵蓋：gzip 分片逐位還原、出場日無收盤的分類與兩種描述性出場價（不補 0）、名稱補齊的「來源未提供」、NaN 安全的內容比對。
"""
import numpy as np

import a36_tracks_t1_audit as AU


def test_gz_parts_roundtrip_single_and_sharded():
    rng = np.random.default_rng(3)
    data = b''.join(f'{i},{rng.integers(0, 10**9)},{rng.random():.12f}\n'.encode() for i in range(20000))
    one = AU.gz_parts(data)
    assert len(one) == 1 and AU.gunzip_parts(one) == data
    many = AU.gz_parts(data, limit=40_000)
    assert len(many) > 1 and all(len(p) <= 40_000 for p in many)
    assert AU.gunzip_parts(many) == data
    assert AU.gz_parts(data) == one                           # mtime＝0：可重現


def test_valid_index_helpers():
    fin = np.array([[True, False], [False, False], [True, True]])
    assert AU.last_valid_index(fin).tolist() == [[0, -1], [0, -1], [2, 2]]
    assert AU.next_valid_index(fin).tolist() == [[0, 2], [2, 2], [2, 2]]


def test_exit_alternatives_categories_and_prices():
    T, nan = 12, np.nan
    C = np.full((T, 4), 10.0)
    O = np.full((T, 4), 10.0)
    C[6:9, 0] = O[6:9, 0] = nan        # 列0：s＝1，出場日 e＝6 停牌，第 9 日恢復
    C[9, 0], O[9, 0] = 12.0, 11.0
    C[5, 0] = 9.0                       # 停牌前最後收盤
    C[6:, 1] = O[6:, 1] = nan          # 列1：e＝6 起不再有收盤（下市）
    C[5, 1] = 8.0
    C[6, 2] = O[6, 2] = nan            # 列2：冷門股（nan20>0），e＝6 無成交
    s = np.array([1, 1, 1, 8, 1])
    j = np.array([0, 1, 2, 3, 3])
    base = np.array([nan, nan, nan, nan, 0.0])
    buy = np.array([True, True, True, True, True])
    n20 = np.array([0, 0, 3, 0, 0])
    x = AU.exit_alternatives(C, O, s, j, base, buy, n20, 5)
    assert x['cat'].tolist() == ['halt_then_resume', 'no_close_after', 'illiquid_no_trade', 'panel_end', 'ok']
    np.testing.assert_allclose(x['alt_last'][:3], [9.0 / 10 - 1, 8.0 / 10 - 1, 10.0 / 10 - 1])
    np.testing.assert_allclose(x['alt_next'][0], 11.0 / 10 - 1)
    assert np.isnan(x['alt_next'][1]) and np.isnan(x['alt_last'][3]) and np.isnan(x['alt_next'][3])   # 不補 0
    assert x['alt_last'][4] == 0.0 and x['alt_next'][4] == 0.0
    assert x['gap'][0] == 3 and np.isnan(x['gap'][1]) and x['gap'][2] == 1


def test_exit_alternatives_not_buyable_is_na():
    C = np.full((8, 1), 10.0)
    x = AU.exit_alternatives(C, C.copy(), np.array([0]), np.array([0]), np.array([np.nan]), np.array([False]), np.array([0]), 5)
    assert x['cat'].tolist() == ['na'] and np.isnan(x['alt_last'][0])


def test_fill_names_fallback_and_unknown():
    nm, src = AU.fill_names(['1101', '5301', '9999'], ['台泥', '', ''], {'5301': ('寶得利', 'TWSE 終止上市名單 2026-10-02')})
    assert nm.tolist() == ['台泥', '寶得利', '來源未提供']
    assert src.tolist() == ['names.json', 'TWSE 終止上市名單 2026-10-02', '來源未提供']


def test_canon_is_nan_safe():
    assert AU.canon({'a': float('nan'), 'b': [1, 2]}) == AU.canon({'b': [1, 2], 'a': float('nan')})
    assert AU.canon({'a': 1.0}) != AU.canon({'a': 1.0001})


if __name__ == '__main__':
    for k, f in list(globals().items()):
        if k.startswith('test_'):
            f()
            print('ok', k)
