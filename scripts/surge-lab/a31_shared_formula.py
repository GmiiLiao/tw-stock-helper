"""方案 A 第 2 步：「相似處帶入公式」——把 DESIGN 找到的共同條件（各含 ≥70% 正例的區間）組成選股公式。

公式（全部只在 DESIGN 決定，VALID 用來選門檻，TEST 只報告）：
  F1  AND-topk  ：依 lift 排序取前 k 個共同條件、全部都要符合（k=1..10）
  F2  AND-greedy：逐步加入「使 DESIGN 精確度最高」的共同條件（k=1..10；每步要求 DESIGN 至少 300 筆）
  F3  COUNT     ：符合的共同條件個數（取 lift 前 M 個；M=10/25/全部 lift>1.05）；門檻 ≥m
  F4  LLR       ：加權符合數＝Σ 符合 ? log(正例率/負例率) : log((1-正例率)/(1-負例率))（樸素貝氏）
區隔：ALL（全體一套公式）、FRESH（s 日未漲停）、CONT（s 日已漲停）。
"""
import json, sys
import numpy as np, pandas as pd
import a31_shared_common as C

SEGS = ('ALL', 'FRESH', 'CONT')


def cond_matrix(D, conds):
    cols = {n: i for i, n in enumerate(D['names'])}
    M = np.empty((len(D['y']), len(conds)), bool)
    for k, c in enumerate(conds):
        x = D['X'][:, cols[c['feature']]]
        lo = -np.inf if c['lo'] <= -1e29 else c['lo']; hi = np.inf if c['hi'] >= 1e29 else c['hi']
        inb = (x >= lo) & (x <= hi)
        M[:, k] = inb | (np.isnan(x) if c['nan_in'] else False)
    return M


def seg_mask(D, seg):
    return {'ALL': np.ones(len(D['y']), bool), 'FRESH': D['lu_s'] == 0, 'CONT': D['lu_s'] == 1}[seg]


def row(name, sel, D):
    r = {'selector': name}
    for i, (sp, _, _) in enumerate(C.SPLITS):
        e = C.evaluate(sel, D, i)
        r[f'{sp}_prec'] = e['prec']; r[f'{sp}_picks'] = e['picks']
        if sp == 'TEST':
            r.update(TEST_days=e['days_with_pick'], TEST_ppd=e['picks_per_day'], TEST_lb=e['wilson_lb'], TEST_buy=e['buy_prec'])
    return r


def run_seg(D, seg, conds_all):
    conds = [c for c in conds_all[seg] if c.get('lift') and np.isfinite(c['lift']) and c['lift'] > 1.05]
    conds.sort(key=lambda c: -c['lift'])
    sm = seg_mask(D, seg)
    M = cond_matrix(D, conds) & sm[:, None]
    y = D['y'].astype(bool); dz = (D['split'] == 0)
    out = []
    # F1 AND-topk
    acc = sm.copy()
    for k in range(min(10, len(conds))):
        acc = acc & M[:, k]
        out.append(row(f'{seg} AND-top{k + 1} (+{conds[k]["feature"]})', acc, D))
    # F2 AND-greedy
    acc = sm.copy(); used = []
    for k in range(10):
        best = None
        for j in range(len(conds)):
            if j in used: continue
            a2 = acc & M[:, j]; n = int((a2 & dz).sum())
            if n < 300: continue
            p = (a2 & dz & y).sum() / n
            if best is None or p > best[0]: best = (p, j)
        if best is None: break
        used.append(best[1]); acc = acc & M[:, best[1]]
        out.append(row(f'{seg} AND-greedy{k + 1} (+{conds[best[1]]["feature"]})', acc, D))
    # F3 COUNT／F4 LLR
    for Mn in (10, 25, len(conds)):
        cnt = M[:, :Mn].sum(1)
        for m in range(max(1, Mn - 8), Mn + 1):
            out.append(row(f'{seg} COUNT{Mn}>={m}', sm & (cnt >= m), D))
    ps = np.array([c['pos_share'] for c in conds]); ns = np.array([c['neg_share'] for c in conds])
    w_in = np.log(ps / ns); w_out = np.log(np.clip(1 - ps, 1e-6, 1) / np.clip(1 - ns, 1e-6, 1))
    llr = np.where(M, w_in, w_out).sum(1).astype(np.float64)
    llr[~sm] = -np.inf
    qs = np.quantile(llr[sm & dz], [0.9, 0.97, 0.99, 0.997, 0.999, 0.9997])
    for q, t in zip((0.9, 0.97, 0.99, 0.997, 0.999, 0.9997), qs):
        out.append(row(f'{seg} LLR>=DESIGN q{q}', llr >= t, D))
    for n in (1, 3, 10):
        out.append(row(f'{seg} LLR top{n}/day', C.topn_per_day(llr, D['s'], n, valid=sm), D))
        cnt = M.sum(1).astype(np.float64)
        out.append(row(f'{seg} COUNTall top{n}/day', C.topn_per_day(cnt, D['s'], n, valid=sm), D))
    return out, conds, M, llr


def platt(x, y, iters=50):
    """1 維邏輯迴歸（Newton）：回傳 (a, b)。"""
    x = x.astype(np.float64); y = y.astype(np.float64); a, b = np.log(y.mean() / (1 - y.mean())), 0.0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(a + b * x))); w = np.maximum(p * (1 - p), 1e-9)
        g = np.array([(p - y).sum(), ((p - y) * x).sum()])
        H = np.array([[w.sum(), (w * x).sum()], [(w * x).sum(), (w * x * x).sum()]]) + 1e-9 * np.eye(2)
        step = np.linalg.solve(H, g); a, b = a - step[0], b - step[1]
        if np.abs(step).max() < 1e-10: break
    return a, b


def main():
    D = C.load()
    conds_all = json.load(open(f'{C.B.SP}/a31_shared_conds.json'))
    res = []; llrs = {}
    for seg in SEGS:
        out, conds, M, llr = run_seg(D, seg, conds_all)
        res += out; llrs[seg] = llr
    # 合併：FRESH 公式＋CONT 公式。樸素貝氏把相關條件重複計分（LLR 嚴重過度自信），
    # 所以先在 DESIGN 上各自做 Platt 校準（logit p = a + b·LLR），再用校準後機率跨區隔排序。
    y = D['y']; dz = D['split'] == 0
    comb = np.full(len(y), -np.inf)
    for seg in ('FRESH', 'CONT'):
        sm = seg_mask(D, seg); a, b = platt(llrs[seg][sm & dz], y[sm & dz])
        comb[sm] = a + b * llrs[seg][sm]
        print(f'{seg} Platt：a={a:.3f} b={b:.3f}（b<1 ＝ 原 LLR 過度自信）')
    for n in (1, 3, 10):
        res.append(row(f'FRESH+CONT LLR(calibrated) top{n}/day', C.topn_per_day(comb, D['s'], n), D))
    np.savez(f'{C.B.SP}/a31_shared_llr.npz', ALL=llrs['ALL'].astype(np.float32), FRESH=llrs['FRESH'].astype(np.float32),
             CONT=llrs['CONT'].astype(np.float32), COMB=comb.astype(np.float32))
    R = pd.DataFrame(res)
    R.to_csv('out/a31_shared_formula.csv', index=False, float_format='%.5g')
    pd.set_option('display.width', 250); pd.set_option('display.max_rows', 500); pd.set_option('display.max_colwidth', 60)
    show = R.copy()
    for c in [c for c in R.columns if c.endswith('_prec') or c in ('TEST_lb', 'TEST_buy')]: show[c] = (R[c] * 100).round(2)
    show['TEST_ppd'] = R['TEST_ppd'].round(2)
    print(show.to_string(index=False))


if __name__ == '__main__':
    main()
