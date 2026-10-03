"""方案 A 總結：TEST 精確度 vs 涵蓋度前緣（每日前 1／3／10 名、TEST 全期前 30／100／300 名）＋尾盤五檔探索。

分數：
  A_COUNT_ALL ：符合的 70% 共同條件個數（使用者原方案的字面版本）
  A_LLR_ALL   ：共同條件加權符合數（樸素貝氏 LLR）
  A_LLR_COMB  ：FRESH／CONT 分開建共同條件、DESIGN 上 Platt 校準後合併
  G_ALL／G_CONT／G_BUY：a31_shared_gbdt.py 的 GBDT（同樣全部參數，可學交互作用）
尾盤五檔（x_bd_*，只有 2026-07-20～10-01、全在 TEST 內）：前半段選門檻、後半段報告（探索性，樣本小）。
"""
import json
import numpy as np, pandas as pd
import a31_shared_common as C
import a31_shared_formula as F


def frontier(name, score, D, rows=None):
    sp = D['split']; s = D['s']; y = D['y']; buy = D['buy_lu']
    valid = np.isfinite(score) if rows is None else (np.isfinite(score) & rows)
    out = []
    for n in (1, 3, 10):
        sel = C.topn_per_day(score, s, n, valid=valid)
        v = C.evaluate(sel, D, 1); t = C.evaluate(sel, D, 2)
        out.append(dict(score=name, cut=f'top{n}/day', VALID_prec=v['prec'], TEST_prec=t['prec'], TEST_picks=t['picks'],
                        TEST_days=t['days_with_pick'], TEST_ppd=t['picks_per_day'], TEST_lb=t['wilson_lb'], TEST_buy=t['buy_prec']))
    mt = np.nonzero((sp == 2) & valid)[0]
    order = mt[np.argsort(-score[mt], kind='stable')]
    for K in (30, 100, 300, 1000):
        idx = order[:K]; k = int(y[idx].sum())
        out.append(dict(score=name, cut=f'TEST top{K} total', VALID_prec=np.nan, TEST_prec=k / K, TEST_picks=K,
                        TEST_days=int(len(np.unique(s[idx]))), TEST_ppd=K / len(np.unique(s[sp == 2])),
                        TEST_lb=C.wilson_lb(k, K), TEST_buy=buy[idx].mean()))
    return out


def bookdepth(D, gall):
    nm = {n: i for i, n in enumerate(D['names'])}; X = D['X']
    has = X[:, nm['x_bd_has']] == 1
    days = np.unique(D['s'][has]); h = days[len(days) // 2]
    H1 = has & (D['s'] < h); H2 = has & (D['s'] >= h)
    q = X[:, nm['x_bd_q_v']]; cont = D['lu_s'] == 1
    print(f'\n尾盤五檔：{len(days)} 日（前半 {int((days < h).sum())} 日選門檻、後半 {int((days >= h).sum())} 日報告）')
    best = None
    for t in (0.5, 1, 2, 3, 5, 8, 12):
        sel = cont & (q >= t)
        n1 = int((sel & H1).sum()); k1 = int(D['y'][sel & H1].sum())
        n2 = int((sel & H2).sum()); k2 = int(D['y'][sel & H2].sum()); b2 = int(D['buy_lu'][sel & H2].sum())
        print(f'  CONT & 漲停委買/成交量 ≥{t:>4}：前半 {k1}/{n1}={k1 / max(n1, 1) * 100:.1f}%  後半 {k2}/{n2}={k2 / max(n2, 1) * 100:.1f}%（可買 {b2}）')
        if n1 >= 15 and (best is None or C.wilson_lb(k1, n1) > best[0]): best = (C.wilson_lb(k1, n1), t)
    # GBDT 每日前 3 名 × 委買佇列
    top3 = C.topn_per_day(gall, D['s'], 3)
    for t in (0, 1, 3):
        sel = top3 & has & (q >= t) if t else top3 & has
        for lab, m in (('前半', H1), ('後半', H2)):
            n = int((sel & m).sum()); k = int(D['y'][sel & m].sum())
            print(f'  G_ALL 每日前3{"" if not t else f" & 委買/量≥{t}"}（{lab}）：{k}/{n}={k / max(n, 1) * 100:.1f}%')
    return best


def main():
    D = C.load()
    conds_all = json.load(open(f'{C.B.SP}/a31_shared_conds.json'))
    conds = sorted([c for c in conds_all['ALL'] if c.get('lift') and np.isfinite(c['lift']) and c['lift'] > 1.05], key=lambda c: -c['lift'])
    cnt = F.cond_matrix(D, conds).sum(1).astype(np.float64)
    L = np.load(f'{C.B.SP}/a31_shared_llr.npz'); G = np.load(f'{C.B.SP}/a31_shared_scores.npz')
    res = []
    res += frontier('A_COUNT_ALL', cnt, D)
    res += frontier('A_LLR_ALL', L['ALL'].astype(np.float64), D)
    res += frontier('A_LLR_COMB', L['COMB'].astype(np.float64), D)
    res += frontier('A_KNN', np.load(f'{C.B.SP}/a31_shared_knn.npy').astype(np.float64), D)
    res += frontier('G_ALL', G['G_ALL'].astype(np.float64), D)
    res += frontier('G_CONT', G['G_CONT'].astype(np.float64), D, rows=D['lu_s'] == 1)
    res += frontier('G_BUY', G['G_BUY'].astype(np.float64), D)
    # 集成：G_ALL、A_KNN、A_LLR_COMB 的同日百分位平均（等權、不調）
    ens = np.zeros(len(D['y']))
    for sc in (G['G_ALL'], np.load(f'{C.B.SP}/a31_shared_knn.npy'), L['COMB']):
        ens += pd.Series(np.asarray(sc, np.float64)).groupby(D['s']).rank(pct=True).values
    res += frontier('ENS(G_ALL+KNN+LLR)', ens, D)
    R = pd.DataFrame(res)
    R.to_csv('out/a31_shared_frontier.csv', index=False, float_format='%.5g')
    show = R.copy()
    for c in ('VALID_prec', 'TEST_prec', 'TEST_lb', 'TEST_buy'): show[c] = (show[c] * 100).round(1)
    show['TEST_ppd'] = show['TEST_ppd'].round(2)
    pd.set_option('display.width', 250); pd.set_option('display.max_rows', 200)
    print(show.to_string(index=False))
    # 樂觀上限：G_ALL 在自己的訓練期（DESIGN，樣本內）最高分 K 筆的精確度——連背答案的樣本內都到不了 9 成，外樣本更不可能
    g = G['G_ALL'].astype(np.float64); md = np.nonzero(D['split'] == 0)[0]; o = md[np.argsort(-g[md])]
    print('\nG_ALL DESIGN 樣本內（樂觀上限）：' + '、'.join(f'前{K}筆 {D["y"][o[:K]].mean() * 100:.1f}%' for K in (30, 100, 300, 1000)))
    bookdepth(D, g)


if __name__ == '__main__':
    main()
