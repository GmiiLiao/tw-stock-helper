"""a32_profile 步驟 4：分別用 A（2023-2025）與 B（2026）資料訓練同設定 GBDT，比較 split-gain 重要度（僅描述用）。

用法：python3 a32_profile_gbdt.py <模型名>
  A_full ：A 全部列           B_full ：B 全部列（2026-01-01～10-01）       B_s1：同 B_full、換亂數種子（種子雜訊基準）
  A_m1／A_m2：A 中隨機抽 180 個交易日（兩組互斥），與 B 同日數 → 「同時代、同大小」重要度重疊的雜訊基準
  A_fresh／B_fresh：只用新起漲列（s 日未漲停）
  B_h1  ：只用 2026-01-01～06-30 訓練（供 2026-07-01～10-01 的樣本外對照；評估在 a32_profile_gbdt_eval.py）
設定（同 a31_shared_gbdt 典型 depth-4 模型）：depth 4、600 棵、lr 0.05、min_child_h 3、l2 20、colsample 0.5、subsample 0.8；
正例全取、負例抽 15%（不加權；只影響截距，不影響排序與重要度相對大小）。特徵＝123 個原值（不含 x_bd_*）。
輸出：.surge-cache/a32_profile_gbdt_<名>.npz（gain_imp、names、必要時的打分）
"""
import sys
import time
import numpy as np
import a32_profile_common as P
from models import HistGBDT

NEG_FRAC = 0.15
PARAMS = dict(n_trees=600, depth=4, lr=0.05, min_child_h=3.0, l2=20.0, colsample=0.5, subsample=0.8)
H1_END = '2026-06-30'


def score_chunked(m, X, idx, chunk=200000):
    out = np.empty(len(idx), np.float32)
    for a in range(0, len(idx), chunk):
        out[a:a + chunk] = m.decision_function(X[idx[a:a + chunk]])
    return out


def main():
    name = sys.argv[1]
    t0 = time.time()
    D = P.load(); X, y, sd, era = D['X'], D['y'].astype(np.int8), D['sd'], D['era']
    seed = 1 if name == 'B_s1' else 0
    rng = np.random.default_rng(100 + seed)
    rows = np.ones(len(y), bool)
    if name in ('A_full', 'A_fresh', 'A_m1', 'A_m2'): rows &= era == 0
    if name in ('B_full', 'B_s1', 'B_fresh'): rows &= era == 1
    if name == 'B_h1': rows &= (era == 1) & (sd <= H1_END)
    if name.endswith('_fresh'): rows &= D['fresh']
    if name in ('A_m1', 'A_m2'):
        daysA = np.unique(D['s'][era == 0]); nB = len(np.unique(D['s'][era == 1]))
        perm = np.random.default_rng(2026).permutation(daysA)
        pick = perm[:nB] if name == 'A_m1' else perm[nB:2 * nB]
        rows &= np.isin(D['s'], pick)
    idx = np.nonzero(rows)[0]
    pos = idx[y[idx] == 1]; neg = idx[y[idx] == 0]
    tr = np.sort(np.concatenate([pos, rng.choice(neg, int(len(neg) * NEG_FRAC), replace=False)]))
    print(f'[{name}] 母體列 {len(idx):,}（日 {len(np.unique(D["s"][idx]))}、正例 {len(pos):,}）訓練列 {len(tr):,}', flush=True)
    m = HistGBDT(seed=seed, **PARAMS).fit(X[tr], y[tr])
    print(f'[{name}] 訓練完成 {time.time() - t0:.0f}s', flush=True)
    out = dict(gain_imp=m.gain_imp, names=np.array(D['names']), n_rows=len(idx), n_pos=len(pos), n_days=len(np.unique(D['s'][idx])))
    if name in ('A_full', 'B_h1', 'A_fresh'):       # 2026 樣本外打分
        te = np.nonzero(era == 1)[0]
        out['score_B'] = score_chunked(m, X, te); out['idx_B'] = te
    if name in ('B_full', 'B_fresh'):               # 反向：2026 模型打 A（樣本外，僅描述）
        te = np.nonzero(era == 0)[0]
        out['score_A'] = score_chunked(m, X, te); out['idx_A'] = te
        te2 = np.nonzero(era == 1)[0]
        out['score_B_insample'] = score_chunked(m, X, te2); out['idx_B'] = te2
    np.savez_compressed(f'{P.SP}/a32_profile_gbdt_{name}.npz', **out)
    imp = m.gain_imp / m.gain_imp.sum()
    top = np.argsort(-imp)[:20]
    print(f'[{name}] 重要度前 20：' + '、'.join(f'{D["names"][i]}({imp[i] * 100:.1f}%)' for i in top))
    print(f'[{name}] 完成 {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
