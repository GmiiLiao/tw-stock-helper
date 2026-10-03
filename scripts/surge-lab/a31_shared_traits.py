"""方案 A 第 1 步：全部「漲停前一日」(m_y=1) vs 其他 (m_y=0)，逐一比對每個參數（只用 DESIGN）。

對每個參數、每個區隔（ALL／FRESH＝s 日未漲停／CONT＝s 日已漲停）計算：
  · 正例／負例中位數
  · 「共同條件」＝含 ≥70% 正例的區間（在正例分位數上滑動 70% 視窗，挑負例佔比最低者；端點在最邊時開放成 ±inf；
    缺值可選擇算入或排除，取負例佔比較低的版本）
  · 正例符合率、負例符合率、lift＝兩者比、當濾網的精確度（DESIGN）
輸出：out/a31_shared_traits_{seg}.csv、.surge-cache/a31_shared_conds.json（給 a31_shared_formula.py 用）
"""
import json
import numpy as np, pandas as pd
import a31_shared_common as C

COVER = 0.70
GRID = 121          # 視窗起點在正例分位 0～30% 間取 121 個點（每 0.25%）


def shared_band(xp, xn, cover=COVER):
    """xp／xn：正例／負例的特徵值（含 NaN）。回傳最佳共同條件 dict（或 None）。"""
    npos, nneg = len(xp), len(xn)
    fp = np.sort(xp[np.isfinite(xp)]); fn = np.sort(xn[np.isfinite(xn)])
    nan_p, nan_n = npos - len(fp), nneg - len(fn)
    best = None
    if len(fp) < 20: return None
    for nan_in in (False, True):
        need = int(np.ceil(cover * npos)) - (nan_p if nan_in else 0)
        if need <= 0:
            cand = [(np.inf, -np.inf)]                     # 只靠缺值即滿足（不會發生在本資料，保留防呆）
        elif need > len(fp):
            continue
        else:
            starts = np.unique(np.linspace(0, len(fp) - need, GRID).round().astype(int))
            cand = []
            for i in starts:
                lo = -np.inf if i == 0 else fp[i]
                hi = np.inf if i + need - 1 >= len(fp) - 1 else fp[i + need - 1]
                cand.append((lo, hi))
        for lo, hi in cand:
            kp = np.searchsorted(fp, hi, 'right') - np.searchsorted(fp, lo, 'left') + (nan_p if nan_in else 0)
            kn = np.searchsorted(fn, hi, 'right') - np.searchsorted(fn, lo, 'left') + (nan_n if nan_in else 0)
            ps, ns = kp / npos, kn / nneg
            if ps < cover - 1e-9: continue
            key = ns / ps                                   # 最小化 負例率／正例率（＝最大化 lift）
            if best is None or key < best['key'] - 1e-12:
                best = dict(key=key, lo=float(lo), hi=float(hi), nan_in=nan_in, pos_share=ps, neg_share=ns,
                            lift=(ps / ns if ns > 0 else np.inf), prec=kp / (kp + kn) if kp + kn else np.nan)
    return best


def segment_table(D, seg_mask, names, cols):
    m = seg_mask & (D['split'] == 0)
    y = D['y'][m].astype(bool)
    rows = []
    for k, nm in zip(cols, names):
        x = D['X'][m, k]
        xp, xn = x[y], x[~y]
        b = shared_band(xp, xn)
        r = dict(feature=nm, med_pos=float(np.nanmedian(xp)) if np.isfinite(xp).any() else np.nan,
                 med_neg=float(np.nanmedian(xn)) if np.isfinite(xn).any() else np.nan,
                 nan_pos=float(np.isnan(xp).mean()), nan_neg=float(np.isnan(xn).mean()))
        if b: r.update({k2: v for k2, v in b.items() if k2 != 'key'})
        rows.append(r)
    T = pd.DataFrame(rows)
    T['base_rate'] = y.mean()
    return T.sort_values('lift', ascending=False)


def main():
    D = C.load()
    keep = [i for i, n in enumerate(D['names']) if n not in C.BD_FEATS]
    names = [D['names'][i] for i in keep]
    segs = dict(ALL=np.ones(len(D['y']), bool), FRESH=D['lu_s'] == 0, CONT=D['lu_s'] == 1)
    out = {}
    for seg, sm in segs.items():
        T = segment_table(D, sm, names, keep)
        T.to_csv(f'out/a31_shared_traits_{seg}.csv', index=False, float_format='%.6g')
        out[seg] = T.replace({np.inf: 1e30, -np.inf: -1e30}).to_dict('records')
        print(f'\n=== {seg}：DESIGN 正例 {int((sm & (D["split"] == 0) & (D["y"] == 1)).sum()):,}，基準率 {T["base_rate"].iloc[0] * 100:.2f}% ===')
        print(f'{"feature":22s} {"med+":>9s} {"med-":>9s} {"band":>26s} {"nan":>3s} {"pos%":>6s} {"neg%":>6s} {"lift":>5s} {"prec%":>6s}')
        for r in T.head(30).itertuples():
            band = f'[{r.lo:.4g}, {r.hi:.4g}]'
            print(f'{r.feature:22s} {r.med_pos:9.4g} {r.med_neg:9.4g} {band:>26s} {"y" if r.nan_in else "n":>3s} '
                  f'{r.pos_share * 100:6.1f} {r.neg_share * 100:6.1f} {r.lift:5.2f} {r.prec * 100:6.2f}')
    json.dump(out, open(f'{C.B.SP}/a31_shared_conds.json', 'w'))


if __name__ == '__main__':
    main()
