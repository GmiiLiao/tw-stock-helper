"""a31-B 步驟 6：延續群（s 日已漲停）相似度＋模型集成——看「多個公式同時認為相似」能否把精確度推高。

集成分數＝各分數在 VALID 延續群經驗分布下的百分位之平均（只用 VALID 的無標籤分布做尺度，TEST 不參與任何決定）。
成員：GBDT_CONT_y、GBDT_ALL_y、kNN_U_k400、kNN_A_k100、NB；另做「全部成員都 ≥ q 分位」的一致決（AND）版本，q 在 VALID 選。
"""
import numpy as np, pandas as pd
import a31_simB_common as C
from a31_simB_report import load_scores

MEMBERS = ('GBDT_CONT_y', 'GBDT_ALL_y', 'kNN_U_k400', 'kNN_A_k100', 'NB')


def ecdf_valid(sc, vmask):
    ref = np.sort(sc[vmask & np.isfinite(sc)])
    return np.searchsorted(ref, sc, side='right') / len(ref)


def main():
    D = C.load(); S = load_scores(D)
    lu = D['lu_s'].astype(bool); v = (D['split'] == 1) & lu
    P = np.stack([np.where(lu, ecdf_valid(S[m], v), np.nan) for m in MEMBERS], 1)
    ens = np.nanmean(P, 1); ens = np.where(lu, ens, -np.inf)
    rows = []
    for r in C.frontier(ens, D, split=2, tops=(30, 100, 300, 1000)): rows.append(dict(rule='ENS frontier', **r))
    for r in C.frontier(ens, D, split=1, tops=(30, 100, 300, 1000)): rows.append(dict(rule='ENS frontier VALID', **r))
    for t in (0.5, 0.6, 0.7, 0.8, 0.9):
        th = C.threshold_from_valid(ens, D, t)
        if th is None: rows.append(dict(rule=f'ENS VALID≥{t:.0%}', sel='VALID 達不到')); continue
        m = ens >= th
        for r in C.split_report(m, D, f'ENS VALID≥{t:.0%} θ={th:.3f}'): rows.append(dict(rule='ENS thr', **r))
    # 一致決：所有成員都在 VALID 前 (1-q)
    for q in (0.8, 0.9, 0.95, 0.98):
        m = lu & np.all(P >= q, 1)
        for r in C.split_report(m, D, f'ALL members ≥ VALID p{int(q * 100)}'): rows.append(dict(rule='AND', **r))
    for r in rows:
        if 'n' in r: print(f"{r['rule']:<18} " + C.fmt(r))
        else: print(r)
    pd.DataFrame(rows).to_csv(f'{C.OUT}/a31_simB_ensemble.csv', index=False, float_format='%.4f')


if __name__ == '__main__':
    main()
