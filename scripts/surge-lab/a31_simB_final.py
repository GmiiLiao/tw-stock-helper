"""a31-B 步驟 7：彙整定案選擇器（協定欄位）＋ TEST 前緣 → out/a31_simB_final.json。

每個選擇器報：定義、DESIGN／VALID／TEST 精確度、TEST 筆數、有選股的 TEST 日數、每日筆數、TEST Wilson 95% 下界、
可買精確度（m_buy_lu）、以及「開盤沒鎖死、實際買得到的那幾筆」中隔日漲停的比例（filled_prec＝buy_lu ÷ 非開盤鎖死）。
注意：GBDT／NB／COUNT 的 DESIGN 精確度是樣本內（模型在 DESIGN 上訓練）；kNN 在 DESIGN 無分數（DESIGN 是參考庫）。
"""
import json
import numpy as np
import a31_simB_common as C
from a31_simB_report import load_scores
from a31_simB_ensemble import ecdf_valid, MEMBERS


def full(m, D, name, definition):
    r = dict(name=name, definition=definition)
    for sp, nm in ((0, 'design'), (1, 'valid'), (2, 'test')):
        st = C.stats(m, D, D['split'] == sp); r[f'{nm}_precision'] = st['prec']; r[f'{nm}_picks'] = st['n']
        if nm == 'test':
            mm = m & (D['split'] == 2); nl = mm & (D['locked1'] == 0)
            r.update(test_picks=st['n'], test_precision=st['prec'], wilson_lb=st['wlb'], buyable_test_precision=st['buy'],
                     test_days_with_pick=st['days'], picks_per_day=st['ppd'], test_cont_share=st['cont'],
                     test_locked_open=float(D['locked1'][mm].mean()) if mm.any() else np.nan,
                     test_filled_precision=float(D['y'][nl].mean()) if nl.any() else np.nan, test_filled_n=int(nl.sum()))
    return r


def main():
    D = C.load(); S = load_scores(D); lu = D['lu_s'].astype(bool)
    v = (D['split'] == 1) & lu
    P = np.stack([np.where(lu, ecdf_valid(S[m], v), np.nan) for m in MEMBERS], 1)
    with np.errstate(all='ignore'):
        S['ENS_cont'] = np.where(lu, np.nanmean(P, 1), -np.inf)
    out = []

    def topk(name, k, scope_mask, label):
        sc = np.where(scope_mask & np.isfinite(S[name]), S[name], -np.inf)
        rid = C.rank_in_day(sc, D['s']); m = (rid < k) & np.isfinite(sc)
        out.append(full(m, D, f'{name} top{k}/day ({label})', f'每日收盤後依 {name} 分數取前 {k} 名（{label}）'))

    def thr(name, target, scope_mask, label):
        sc = np.where(scope_mask & np.isfinite(S[name]), S[name], -np.inf)
        th = C.threshold_from_valid(sc, D, target)
        if th is None: return
        out.append(full(sc >= th, D, f'{name} ≥θ (VALID≥{target:.0%}, {label})', f'{name} ≥ {th:.4g}（VALID 精確度 ≥{target:.0%} 的最低門檻，{label}）'))

    allm = np.ones(len(lu), bool)
    for k in (1, 3, 10):
        topk('GBDT_ALL_y', k, allm, '全部')
        topk('GBDT_ALL_buy', k, allm, '全部')
    topk('GBDT_ALL_y', 1, ~lu, '只限新起漲')
    topk('GBDT_ALL_buy', 1, ~lu, '只限新起漲')
    topk('kNN_U_k400', 1, ~lu, '只限新起漲')
    topk('ENS_cont', 1, lu, '只限延續')
    topk('kNN_A_k25', 1, allm, '全部')
    topk('COUNT', 1, ~lu, '只限新起漲（相似處個數）')
    for t in (0.6, 0.7):
        thr('GBDT_ALL_y', t, allm, '全部')
    thr('NB', 0.7, lu, '只限延續')
    thr('ENS_cont', 0.6, lu, '只限延續')
    thr('kNN_U_k400', 0.6, lu, '只限延續')
    thr('COUNT', 0.7, lu, '只限延續')
    n = D['names']; X = D['X']
    ow = lu & (X[:, n.index('x_oneword_s')] == 1) & (X[:, n.index('x_lu_streak')] >= 2)
    out.append(full(ow, D, 'RULE 一字鎖＋連板≥2', 's 日一字鎖漲停（開低收都在漲停價）且連續漲停 ≥2 日（無模型基準）'))
    front = {}
    for nm, scope in (('GBDT_ALL_y', allm), ('ENS_cont', lu), ('GBDT_ALL_buy', allm), ('kNN_U_k400', ~lu), ('GBDT_ALL_y', ~lu)):
        key = nm + ('' if scope is allm else ('_cont' if scope is lu else '_fresh'))
        sc = np.where(scope & np.isfinite(S[nm]), S[nm], -np.inf)
        front[key] = C.frontier(sc, D, split=2, tops=(30, 100, 300, 1000, 3000))
    for r in out:
        print(f"{r['name']:<52} DES {r['design_precision'] * 100 if r['design_picks'] else float('nan'):5.1f}% VAL {r['valid_precision'] * 100:5.1f}% "
              f"TEST {r['test_precision'] * 100:5.1f}% n={r['test_picks']:>5} days={r['test_days_with_pick']:>3} ppd={r['picks_per_day']:.2f} "
              f"WLB {r['wilson_lb'] * 100:5.1f}% buy {r['buyable_test_precision'] * 100:5.1f}% lockedOpen {r['test_locked_open'] * 100:5.1f}% "
              f"filled {r['test_filled_precision'] * 100:5.1f}% (n={r['test_filled_n']})")
    for k, rows in front.items():
        print(f'\n--- TEST 前緣 {k}')
        for r in rows: print('  ' + C.fmt(r))
    json.dump(dict(selectors=out, frontier=front), open(f'{C.OUT}/a31_simB_final.json', 'w'), ensure_ascii=False, indent=1, default=float)


if __name__ == '__main__':
    main()
