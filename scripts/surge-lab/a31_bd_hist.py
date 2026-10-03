"""A31-D 步驟 1：只用 f_*（全歷史可得）訓練基準 GBDT，作為「五檔是否有增量」的對照（唯讀）。

模型（超參數在 DESIGN→VALID 選；最終以 DESIGN+VALID＝s≤2025-12-31 重訓，2026 全為樣本外）：
  M_lu      ：s 日已漲停（m_lu_s=1）列，目標 m_y（隔日續漲停）
  M_lu_buy  ：同上，目標 m_buy_lu（隔日漲停且開盤買得到）
  M_nonlu   ：s 日未漲停列，目標 m_y（負例抽 10%、權重 10）
  M_all     ：全部列，目標 m_y（同上抽樣）—— 跨族群排序用
  M_all_buy ：全部列，目標 m_buy_lu
輸出 .surge-cache/a31_bd_scores.npz（與 dataset_lu1 列序對齊）、out/a31_bd_hist.txt。
"""
import numpy as np, pandas as pd, sys, time
from a31_bd_lib import load_all, split_of, sel_stats, topk_mask, day_auc, pooled_auc, SP
from models import HistGBDT

NEG_KEEP = 0.10
GRID = [dict(n_trees=300, depth=3, lr=0.05), dict(n_trees=300, depth=5, lr=0.05)]
GRID_BIG = [dict(n_trees=300, depth=4, lr=0.05)]          # 大族群只跑一組（純 numpy GBDT 較慢）
BASE_HP = dict(min_child_h=5.0, l2=5.0, colsample=0.5, subsample=0.8, seed=0)


def feat_matrix(df, X, names):
    ext = np.stack([df.x_oneword_s.values, df.x_close_at_high.values, df.x_lu_streak.values,
                    np.log(np.maximum(df.x_price.values, 1e-3)), np.log1p(np.maximum(df.x_vol20.values, 0)),
                    df.m_otc.values.astype(np.float32), df.m_lu_s.values.astype(np.float32)], 1).astype(np.float32)
    return np.hstack([X, ext]), names + ['x_oneword_s', 'x_close_at_high', 'x_lu_streak', 'log_price', 'log_vol20', 'otc', 'lu_s']


def subsample(idx, y, rng, keep=NEG_KEEP):
    pos = idx[y[idx] == 1]; neg = idx[y[idx] == 0]
    neg = neg[rng.random(len(neg)) < keep]
    ii = np.sort(np.r_[pos, neg]); w = np.where(y[ii] == 1, 1.0, 1.0 / keep)
    return ii, w


def fit(Xf, y, idx, hp, sub, seed=0):
    rng = np.random.default_rng(seed)
    if sub: ii, w = subsample(idx, y, rng)
    else: ii, w = idx, None
    return HistGBDT(**hp, **BASE_HP).fit(Xf[ii], y[ii], w=w)


def main():
    out = open('out/a31_bd_hist.txt', 'w')
    def P(*a):
        print(*a); print(*a, file=out); out.flush()
    df, X, names = load_all()
    Xf, fn = feat_matrix(df, X, names); del X
    sp = split_of(df.date.values); date = df.date.values
    lu = df.m_lu_s.values == 1
    specs = {'M_lu': (lu, 'm_y', False), 'M_lu_buy': (lu, 'm_buy_lu', False),
             'M_nonlu': (~lu, 'm_y', True), 'M_all': (np.ones(len(df), bool), 'm_y', True),
             'M_all_buy': (np.ones(len(df), bool), 'm_buy_lu', True)}
    scores = {}
    for name, (grp, tgt, sub) in specs.items():
        y = df[tgt].values.astype(np.int8)
        tr = np.nonzero(grp & (sp == 'design'))[0]; va = grp & (sp == 'valid')
        best, best_m = None, -1
        for hp in (GRID_BIG if sub else GRID):
            t = time.time(); m = fit(Xf, y, tr, hp, sub)
            s = m.decision_function(Xf[va])
            met = day_auc(s, y[va], date[va]) if name != 'M_lu' and name != 'M_lu_buy' else pooled_auc(s, y[va])
            P(f'{name} {hp} VALID metric={met:.4f} ({time.time() - t:.0f}s)')
            if met > best_m: best, best_m = hp, met
        tr2 = np.nonzero(grp & (sp != 'test'))[0]
        m = fit(Xf, y, tr2, best, sub)
        sc = np.full(len(df), np.nan, np.float32); sc[grp] = m.decision_function(Xf[grp])
        scores[name] = sc
        np.savez_compressed(f'{SP}/a31_bd_scores.npz', **scores)      # 逐模型存檔，後續腳本可先用
        imp = pd.Series(m.gain_imp, index=fn).sort_values(ascending=False)
        P(f'{name} chosen {best}; top features: ' + ', '.join(f'{k}' for k in imp.index[:12]))
    # TEST（2026）上的前 K 名精準度
    te = sp == 'test'; nd = len(np.unique(date[te]))
    P(f'\nTEST 2026-01-01..10-01: {nd} days, rows {te.sum():,}, base m_y {df.m_y[te].mean():.4f}, LU_s cont {df.m_y[te & lu].mean():.4f}')
    for name, (grp, tgt, sub) in specs.items():
        for k in (1, 3, 10):
            sel = topk_mask(scores[name], date, k, cand=te & grp)
            st = sel_stats(sel, df.m_y.values, df.m_buy_lu.values, date, nd)
            P(f'  {name:9s} top{k:<2d}/day  picks={st["picks"]:5d} prec={st["prec"]:.3f} LB={st["wilson_lb"]:.3f} buy={st["buy_prec"]:.3f}')
    out.close()


if __name__ == '__main__':
    main()
