"""a31-B 步驟 5：為什麼到不了 9 成——天花板診斷（只讀前面步驟產出的分數）。

A. 信心越高、越買不到：TEST 依分數最高的 0.01%～3% 分層 → 隔日漲停率、開盤即鎖死率、P(買得到 | 漲停)。
B. 「最相似的歷史樣本」標籤一致度：TEST 每列的 25 個最近 DESIGN 鄰居中有幾成隔日漲停（kNN_A_k25）；
   若「長得幾乎一樣的歷史個案」本身就只有 2～5 成漲停，任何相似度公式的精確度上限就在那裡。
C. VALID 上任一分數、任一門檻（≥30 筆）可達的最高精確度（不看 TEST）。
D. 延續群內最強單一型態（一字鎖＋連板）在三段期間的續漲停率（無模型的天花板參考）。
"""
import os
import numpy as np, pandas as pd
import a31_simB_common as C
from a31_simB_report import load_scores


def tiers(name, sc, D):
    te = np.nonzero((D['split'] == 2) & np.isfinite(sc))[0]
    o = te[np.argsort(-sc[te])]
    rows = []
    for q in (0.0001, 0.0003, 0.001, 0.003, 0.01, 0.03):
        n = max(int(len(o) * q), 1); sel = o[:n]
        y = D['y'][sel]; lk = D['locked1'][sel]; b = D['buy_lu'][sel]
        rows.append(dict(score=name, top=f'{q * 100:.2f}%', n=n, prec=y.mean(), wlb=C.wilson_lb(int(y.sum()), n),
                         locked_open=lk.mean(), buyable=b.mean(), p_buy_given_lu=(b.sum() / y.sum()) if y.sum() else np.nan,
                         cont_share=D['lu_s'][sel].mean()))
    return rows


def valid_max(name, sc, D, min_n=30):
    v = np.nonzero((D['split'] == 1) & np.isfinite(sc))[0]
    if len(v) == 0: return None
    o = v[np.argsort(-sc[v])]; y = D['y'][o].astype(float)
    cy = np.cumsum(y); n = np.arange(1, len(o) + 1); p = cy / n
    p[n < min_n] = -1
    i = int(np.argmax(p))
    return dict(score=name, valid_max_prec=float(p[i]), at_n=int(n[i]), valid_prec_at_100=float(p[99]) if len(p) >= 100 else np.nan)


def main():
    D = C.load(); S = load_scores(D)
    pd.set_option('display.width', 250)
    keys = [k for k in S if k.startswith(('GBDT_', 'kNN_A_k100', 'kNN_U_k100', 'kNN_T15_k100', 'NB', 'COUNT'))]
    A = pd.DataFrame([r for k in keys for r in tiers(k, S[k], D)])
    A.to_csv(f'{C.OUT}/a31_simB_ceiling_tiers.csv', index=False, float_format='%.4f')
    print('=== A. TEST 分數最高層：精確度 vs 開盤鎖死 vs 可買（cont_share＝延續群占比）')
    print((A.set_index(['score', 'top'])[['n', 'prec', 'wlb', 'locked_open', 'buyable', 'p_buy_given_lu', 'cont_share']]).round(3).to_string())
    lu = D['lu_s'].astype(bool)
    if 'kNN_A_k25' in S:
        k25 = S['kNN_A_k25']; te = (D['split'] == 2) & np.isfinite(k25)
        print('\n=== B. 最近 25 個 DESIGN 相似個案的隔日漲停比例（kNN_A_k25；DESIGN 新起漲負例已回權）')
        for g, gm in (('fresh', ~lu), ('cont', lu)):
            m = te & gm; ypos = m & (D['y'] == 1)
            qs = np.quantile(k25[ypos], [0.5, 0.9, 0.99])
            print(f'  {g}: TEST 正例的鄰居漲停比例 中位 {qs[0]:.3f}、P90 {qs[1]:.3f}、P99 {qs[2]:.3f}；'
                  f'鄰居漲停比例 ≥0.5 的 TEST 列 {int((m & (k25 >= 0.5)).sum())} 筆（其中隔日漲停 {D["y"][m & (k25 >= 0.5)].mean() * 100 if (m & (k25 >= 0.5)).any() else float("nan"):.1f}%）、'
                  f'≥0.8 的 {int((m & (k25 >= 0.8)).sum())} 筆')
    print('\n=== C. VALID 任一門檻（≥30 筆）可達最高精確度')
    Vm = pd.DataFrame([r for k in S if (r := valid_max(k, S[k], D)) is not None]).sort_values('valid_max_prec', ascending=False)
    print(Vm.head(25).to_string(index=False))
    Vm.to_csv(f'{C.OUT}/a31_simB_valid_max.csv', index=False, float_format='%.4f')
    print('\n=== D. 延續群單一型態天花板：s 日一字鎖漲停且連板 ≥2（無模型）')
    n = D['names']; X = D['X']
    ow = X[:, n.index('x_oneword_s')] == 1; st = X[:, n.index('x_lu_streak')]
    for lab, m in (('一字鎖', lu & ow), ('一字鎖＋連板≥2', lu & ow & (st >= 2)), ('一字鎖＋連板≥3', lu & ow & (st >= 3))):
        for r in C.split_report(m, D, lab): print('  ' + C.fmt(r))


if __name__ == '__main__':
    main()
