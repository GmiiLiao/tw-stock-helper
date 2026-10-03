"""方案 A 延伸：放寬「70% 共同條件」——在 DESIGN 上用 beam search 找「精確度最高」的 AND 規則（明確公式的上限）。

條件庫：每個參數（不含尾盤五檔）在該區隔 DESIGN 分位數 {2,5,10,…,90,95,98}% 上的「≤t」與「≥t」。
評分：DESIGN 精確度的 Wilson 95% 下界（支持數 ≥ MINSUP）。beam 寬 B、深度 ≤4。
選規則：每層取 DESIGN 下界前 25 名 → 依 DESIGN+VALID 合併的 Wilson 下界挑（VALID 至少 15 筆）→ TEST 只報告。
"""
import sys
import numpy as np, pandas as pd
import a31_shared_common as C

QS = (0.02, 0.05) + tuple(np.round(np.arange(0.1, 0.91, 0.05), 2)) + (0.95, 0.98)
B_WIDTH = 40
DEPTH = 4


def wilson_vec(k, n, z=1.96):
    n = np.maximum(n, 1); p = k / n; den = 1 + z * z / n
    return (p + z * z / (2 * n) - z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / den


def build_conds(D, rows, names, cols):
    dz = rows & (D['split'] == 0)
    conds, bits = [], []
    for nm, k in zip(names, cols):
        x = D['X'][:, k]; xd = x[dz]; xd = xd[np.isfinite(xd)]
        if len(xd) < 50: continue
        ts = np.unique(np.quantile(xd, QS))
        for t in ts:
            for op in ('<=', '>='):
                m = (x <= t) if op == '<=' else (x >= t)
                m &= rows
                frac = m[dz].mean()
                if frac < 0.005 or frac > 0.995: continue
                conds.append((nm, op, float(t))); bits.append(np.packbits(m))
    return conds, np.stack(bits)


def popc(a):
    return np.bitwise_count(a).sum(axis=-1, dtype=np.int64)


def beam(D, rows, seg, names, cols, minsup):
    conds, Bm = build_conds(D, rows, names, cols)
    yb = np.packbits(D['y'].astype(bool)); spb = [np.packbits(D['split'] == i) for i in range(3)]
    print(f'{seg}: 條件 {len(conds)} 個', flush=True)
    feat_of = np.array([c[0] for c in conds])

    def score(Rb):
        n = popc(Rb & spb[0]); k = popc(Rb & spb[0] & yb)
        lb = np.where(n >= minsup, wilson_vec(k, n), -1.0)
        return lb, n, k

    lb, n, k = score(Bm)
    order = np.argsort(-lb)[:B_WIDTH]
    beam_rules = [((int(i),), Bm[i]) for i in order if lb[i] > 0]
    found = [(r, lb[order[j]]) for j, r in enumerate(beam_rules)]
    allrules = {r[0]: r[1] for r in beam_rules}
    level = {1: [(r[0], float(lb[order[j]])) for j, r in enumerate(beam_rules)]}
    for d in range(2, DEPTH + 1):
        cand = {}
        for rule, rb in beam_rules:
            used = set(feat_of[list(rule)])
            R2 = Bm & rb[None, :]
            l2, n2, k2 = score(R2)
            for i in np.argsort(-l2)[:B_WIDTH * 2]:
                if l2[i] <= 0 or feat_of[i] in used: continue
                key = tuple(sorted(rule + (int(i),)))
                if key not in cand or cand[key][0] < l2[i]: cand[key] = (float(l2[i]), R2[i])
        top = sorted(cand.items(), key=lambda t: -t[1][0])[:B_WIDTH]
        beam_rules = [(kk, v[1]) for kk, v in top]
        level[d] = [(kk, v[0]) for kk, v in top]
        for kk, v in top: allrules[kk] = v[1]
        print(f'  depth {d}: 最佳 DESIGN 下界 {top[0][1][0] * 100:.1f}%', flush=True)
    rows_out = []
    for d, lst in level.items():
        for rule, dlb in lst[:25]:
            sel = np.unpackbits(allrules[rule])[:len(D['y'])].astype(bool)
            ev = [C.evaluate(sel, D, i) for i in range(3)]
            nd, kd = ev[0]['picks'], ev[0]['hits']; nv, kv = ev[1]['picks'], ev[1]['hits']
            rows_out.append(dict(seg=seg, depth=d, rule=' & '.join(f'{conds[i][0]}{conds[i][1]}{conds[i][2]:.4g}' for i in rule),
                                 D_prec=ev[0]['prec'], D_n=nd, D_lb=dlb, V_prec=ev[1]['prec'], V_n=nv,
                                 DV_lb=C.wilson_lb(kd + kv, nd + nv) if nv >= 15 else np.nan,
                                 T_prec=ev[2]['prec'], T_n=ev[2]['picks'], T_days=ev[2]['days_with_pick'],
                                 T_ppd=ev[2]['picks_per_day'], T_lb=ev[2]['wilson_lb'], T_buy=ev[2]['buy_prec']))
    return pd.DataFrame(rows_out)


def main():
    D = C.load()
    keep = [i for i, n in enumerate(D['names']) if n not in C.BD_FEATS]
    names = [D['names'][i] for i in keep]
    segs = [('CONT', D['lu_s'] == 1, 100), ('FRESH', D['lu_s'] == 0, 300)]
    out = []
    for seg, rows, ms in segs:
        out.append(beam(D, rows, seg, names, keep, ms))
    R = pd.concat(out)
    R.to_csv('out/a31_shared_rules.csv', index=False, float_format='%.5g')
    pd.set_option('display.width', 300); pd.set_option('display.max_colwidth', 120); pd.set_option('display.max_rows', 300)
    for seg in ('CONT', 'FRESH'):
        S = R[R.seg == seg].sort_values('DV_lb', ascending=False)
        print(f'\n=== {seg}：依 DESIGN+VALID 下界排序前 12（TEST 只報告） ===')
        show = S.head(12).copy()
        for c in ('D_prec', 'D_lb', 'V_prec', 'DV_lb', 'T_prec', 'T_lb', 'T_buy'): show[c] = (show[c] * 100).round(1)
        show['T_ppd'] = show['T_ppd'].round(2)
        print(show.drop(columns=['seg']).to_string(index=False))


if __name__ == '__main__':
    main()
