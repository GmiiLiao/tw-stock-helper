"""方案 A 最終選股器彙整：每一族的變體都只用 DESIGN／VALID 挑，TEST 只報告（含 Wilson 下界、可買精確度）。

需先跑：a31_shared_traits → a31_shared_formula → a31_shared_gbdt → a31_shared_knn → a31_shared_rules。
"""
import json
import numpy as np, pandas as pd
import a31_shared_common as C
import a31_shared_formula as F

MIN_VALID = 100


def conds_for(seg):
    cs = json.load(open(f'{C.B.SP}/a31_shared_conds.json'))[seg]
    return sorted([c for c in cs if c.get('lift') and np.isfinite(c['lift']) and c['lift'] > 1.05], key=lambda c: -c['lift'])


def ev_all(sel, D):
    return [C.evaluate(sel, D, i) for i in range(3)]


def pick_by_valid(cands, D):
    """cands：[(名稱, 布林選擇)]；挑 VALID 精確度最高且 VALID 筆數 ≥ MIN_VALID 者。"""
    best = None
    for name, sel in cands:
        v = C.evaluate(sel, D, 1)
        if v['picks'] >= MIN_VALID and (best is None or v['prec'] > best[0]): best = (v['prec'], name, sel)
    return best[1], best[2]


def main():
    D = C.load(); out = []

    def add(name, definition, sel):
        e = ev_all(sel, D)
        out.append(dict(name=name, definition=definition, design_precision=e[0]['prec'], valid_precision=e[1]['prec'],
                        test_precision=e[2]['prec'], test_picks=e[2]['picks'], test_days_with_pick=e[2]['days_with_pick'],
                        picks_per_day=e[2]['picks_per_day'], wilson_lb=e[2]['wilson_lb'], buyable_test_precision=e[2]['buy_prec'],
                        valid_picks=e[1]['picks']))

    # S1 字面版：符合共同條件個數（ALL）
    cA = conds_for('ALL'); MA = F.cond_matrix(D, cA); cnt = MA.sum(1)
    name, sel = pick_by_valid([(f'COUNT>={m}', cnt >= m) for m in range(60, len(cA) + 1)], D)
    add('A1_COUNT_shared_traits', f'ALL 區隔 {len(cA)} 個 70% 共同條件中符合 {name[5:]} 個以上（門檻依 VALID 選）', sel)
    # S2 字面版：s 日漲停 ＋ CONT 前 k 個共同條件全符合
    cC = conds_for('CONT'); MC = F.cond_matrix(D, cC) & (D['lu_s'] == 1)[:, None]
    cands = []; acc = D['lu_s'] == 1
    for k in range(10):
        acc = acc & MC[:, k]; cands.append((f'top{k + 1}', acc.copy()))
    name, sel = pick_by_valid(cands, D)
    k = int(name[3:])
    add('A2_AND_CONT_shared', 's 日已漲停 AND ' + ' AND '.join(f'{c["feature"]}∈[{c["lo"]:.4g},{c["hi"]:.4g}]'.replace('-1e+30', '-inf').replace('1e+30', 'inf')
                                                            for c in cC[:k]) + f'（k={k} 依 VALID 選）', sel)
    # S3 字面版加權：FRESH/CONT 共同條件 LLR（DESIGN Platt 校準）每日第 1 名
    L = np.load(f'{C.B.SP}/a31_shared_llr.npz')
    add('A3_LLR_calibrated_top1', 'FRESH／CONT 各自共同條件的加權符合分數（樸素貝氏 LLR，DESIGN 上 Platt 校準）每日第 1 名',
        C.topn_per_day(L['COMB'].astype(np.float64), D['s'], 1))
    # S4 字面版相似度：最近鄰
    knn = np.load(f'{C.B.SP}/a31_shared_knn.npy').astype(np.float64)
    for n in (1, 3):
        add(f'A4_KNN_similarity_top{n}', f'與 DESIGN 漲停前一日的最近鄰相似度（20 個共同條件參數分位＋s 日漲停／一字鎖；K=50）每日前 {n} 名',
            C.topn_per_day(knn, D['s'], n))
    # S5 放寬 70%：beam 規則（CONT，依 DESIGN+VALID 下界挑第一名）
    R = pd.read_csv('out/a31_shared_rules.csv'); r = R[R.seg == 'CONT'].sort_values('DV_lb', ascending=False).iloc[0]
    nm = {n: i for i, n in enumerate(D['names'])}; sel = D['lu_s'] == 1
    for part in r['rule'].split(' & '):
        op = '<=' if '<=' in part else '>='; f, t = part.split(op); x = D['X'][:, nm[f]]
        sel = sel & ((x <= float(t)) if op == '<=' else (x >= float(t)))
    add('A5_beam_rule_CONT', 's 日已漲停 AND ' + r['rule'] + '（DESIGN 上 beam 搜尋、DESIGN+VALID 下界挑；f_day_range<=0 即一字鎖）', sel)
    # S6～S8 對照：GBDT（同樣全部參數）
    G = np.load(f'{C.B.SP}/a31_shared_scores.npz')
    for n in (1, 3, 10):
        add(f'G_ALL_top{n}', f'GBDT（117+6 參數、標籤＝隔日漲停；VALID 選深度／樹數；TEST 用 DESIGN+VALID 重訓）每日前 {n} 名',
            C.topn_per_day(G['G_ALL'].astype(np.float64), D['s'], n))
    add('G_BUY_top1', 'GBDT 標籤＝隔日漲停且開盤買得到（m_buy_lu）每日第 1 名', C.topn_per_day(G['G_BUY'].astype(np.float64), D['s'], 1))
    T = pd.DataFrame(out)
    T.to_csv('out/a31_shared_summary.csv', index=False, float_format='%.5g')
    show = T.drop(columns=['definition']).copy()
    for c in ('design_precision', 'valid_precision', 'test_precision', 'wilson_lb', 'buyable_test_precision'): show[c] = (show[c] * 100).round(1)
    show['picks_per_day'] = show['picks_per_day'].round(2)
    pd.set_option('display.width', 250)
    print(show.to_string(index=False))
    for r in out: print(f"\n{r['name']}: {r['definition']}")


if __name__ == '__main__':
    main()
