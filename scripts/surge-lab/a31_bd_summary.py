"""A31-D 總表：把方法 D（尾盤五檔）各選股器的設計／報告期數字、LOWO、可買精準度、前沿整理成 out/a31_bd_summary.json。
需要 a31_bd_hist.py 的全部分數。門檻一律取自 a31_bd_q1／q2 的「設計期選定」規則（這裡重算，不在報告期調參）。"""
import json, numpy as np, pandas as pd
from a31_bd_common import load_bd_window, choose_threshold, lowo_threshold
from a31_bd_lib import load_all, split_of, sel_stats, topk_mask, wilson_lb
from models import Logistic


def stats_block(df, sel, nd_design, nd_report):
    d = df.part.values == 'design'; r = ~d
    sd = sel_stats(sel & d, df.m_y.values, df.m_buy_lu.values, df.date.values, nd_design)
    sr = sel_stats(sel & r, df.m_y.values, df.m_buy_lu.values, df.date.values, nd_report)
    return dict(design_precision=sd['prec'], design_picks=sd['picks'], test_precision=sr['prec'], test_picks=sr['picks'],
                test_hits=sr['hits'], wilson_lb=sr['wilson_lb'], buyable_test_precision=sr['buy_prec'],
                test_days_with_pick=sr['days_with_pick'], picks_per_day=sr['picks_per_day'])


def main():
    w, bdays, nd = load_bd_window(); ndr = len(bdays) - nd
    L = w[(w.m_lu_s == 1) & (w.x_bd_has == 1)].reset_index(drop=True)
    N = w[(w.m_lu_s == 0) & (w.x_bd_has == 1) & np.isfinite(w.x_bd_imb)].reset_index(drop=True)
    dL = L.part.values == 'design'; dN = N.part.values == 'design'
    sels = []

    def add(name, definition, df, sel, lowo=None):
        r = dict(name=name, definition=definition, **stats_block(df, sel, nd, ndr))
        if lowo is not None: r['lowo'] = lowo
        sels.append(r)

    add('D0 LU_s baseline', 'all stocks limit-up on s with a closing book snapshot', L, np.ones(len(L), bool))
    # D1 q_v 門檻（設計期最大化精準度、≥20 檔）
    th, _, _ = choose_threshold(L.x_bd_q_v.values, L.m_y.values, dL)
    t, p, pb, n, lb = lowo_threshold(L, 'x_bd_q_v', np.ones(len(L), bool))
    add('D1 LU&q_v>=θ', f'LU_s & bid-queue-at-limit / day volume >= {th:.3f} (θ = design-period precision-max, ≥20 design picks)', L,
        L.x_bd_q_v.values >= th, lowo=dict(picks=n, precision=p, buyable=pb, wilson_lb=lb, weeks=int((t.picks > 0).sum()),
                                           week_prec_min=float(t.prec.min()), week_prec_max=float(t.prec.max())))
    # D2 bidlim 門檻
    th2, _, _ = choose_threshold(L.x_bd_bidlim.values, L.m_y.values, dL)
    t, p, pb, n, lb = lowo_threshold(L, 'x_bd_bidlim', np.ones(len(L), bool))
    add('D2 LU&bidlim>=θ', f'LU_s & bid lots queued at limit >= {th2:.0f}', L, L.x_bd_bidlim.values >= th2,
        lowo=dict(picks=n, precision=p, buyable=pb, wilson_lb=lb))
    # D3 一字鎖
    add('D3 LU&oneword', 'LU_s & one-price locked limit-up on s (no threshold)', L, L.x_oneword_s.values == 1)
    # D4 一字鎖＋q_v
    ow = L.x_oneword_s.values == 1
    th4, _, _ = choose_threshold(L.x_bd_q_v.values, L.m_y.values, ow & dL, min_picks=10)
    t, p, pb, n, lb = lowo_threshold(L, 'x_bd_q_v', ow, min_picks=10)
    add('D4 LU&oneword&q_v>=θ', f'LU_s & oneword & q_v >= {th4:.3f} (≥10 design picks)', L, ow & (L.x_bd_q_v.values >= th4),
        lowo=dict(picks=n, precision=p, buyable=pb, wilson_lb=lb))
    # D5 f_* 模型每日第 1 名（對照）
    add('D5 top1/day M_lu (f_* only)', 'among LU_s with book: top-1 per day by M_lu (GBDT on f_*, trained s<=2025-12-31)', L,
        topk_mask(L.M_lu.values, L.date.values, 1))
    # D6 M_lu＋五檔（設計期擬合邏輯迴歸 → 報告期）
    xc = ['M_lu', 'log_qv', 'log_bidlim', 'x_oneword_s']
    m = Logistic(l2=10.0).fit(L[xc].values[dL].astype(float), L.m_y.values[dL].astype(float))
    sc = m.decision_function(L[xc].values.astype(float))
    add('D6 top1/day M_lu+book', 'top-1 per day by logistic(M_lu, log q_v, log bidlim, oneword) fit on design days', L, topk_mask(sc, L.date.values, 1))
    add('D6b top3/day M_lu+book', 'same, top-3 per day', L, topk_mask(sc, L.date.values, 3))
    add('D5b top3/day M_lu (f_* only)', 'top-3 per day by M_lu', L, topk_mask(L.M_lu.values, L.date.values, 3))
    # D7 非漲停：M_nonlu 前 10 名 & imb
    top = topk_mask(N.M_nonlu.values, N.date.values, 10)
    th7, _, _ = choose_threshold(N.x_bd_imb.values, N.m_y.values, top & dN)
    add('D7 top10 M_nonlu & imb>=θ', f'non-LU: top-10/day by M_nonlu with top-5 bid/(bid+ask) >= {th7:.3f}', N, top & (N.x_bd_imb.values >= th7))
    add('D7b top10 M_nonlu', 'non-LU: top-10/day by M_nonlu (f_* only, control)', N, top)

    # 前沿（報告期，全市場含漲停股，M_all）
    A = w.reset_index(drop=True); rp = A.part.values == 'report'
    front = {}
    for nm in ('M_all', 'M_all_buy'):
        s = A[nm].values
        f = {}
        for k in (1, 3, 10):
            st = sel_stats(topk_mask(s, A.date.values, k) & rp, A.m_y.values, A.m_buy_lu.values, A.date.values, ndr)
            f[f'top{k}/day'] = dict(prec=st['prec'], buy=st['buy_prec'], picks=st['picks'], lb=st['wilson_lb'])
        o = np.argsort(-np.where(rp, np.nan_to_num(s, nan=-1e9), -1e9))
        for n in (30, 100, 300):
            f[f'top{n}_total'] = dict(prec=float(A.m_y.values[o[:n]].mean()), buy=float(A.m_buy_lu.values[o[:n]].mean()))
        front[nm] = f
    # 共同協定 TEST（2026-01-01～10-01，全市場）的 f_* 前沿
    df, _, _ = load_all(feat=False); sc_all = np.load('.surge-cache/a31_bd_scores.npz')
    te = split_of(df.date.values) == 'test'; ndt = len(np.unique(df.date.values[te]))
    tf = {}
    for nm in ('M_all', 'M_all_buy'):
        s = sc_all[nm]; f = {}
        for k in (1, 3, 10):
            st = sel_stats(topk_mask(s, df.date.values, k, cand=te), df.m_y.values, df.m_buy_lu.values, df.date.values, ndt)
            f[f'top{k}/day'] = dict(prec=st['prec'], buy=st['buy_prec'], picks=st['picks'], lb=st['wilson_lb'])
        o = np.argsort(-np.where(te, np.nan_to_num(s, nan=-1e9), -1e9))
        for n in (30, 100, 300):
            f[f'top{n}_total'] = dict(prec=float(df.m_y.values[o[:n]].mean()), buy=float(df.m_buy_lu.values[o[:n]].mean()))
        tf[nm] = f
    res = dict(book_days=len(bdays), design_days=nd, report_days=ndr, design_range=[bdays[0], bdays[nd - 1]], report_range=[bdays[nd], bdays[-1]],
               selectors=sels, report_frontier_window=front, test2026_frontier_fstar=tf)
    json.dump(res, open('out/a31_bd_summary.json', 'w'), ensure_ascii=False, indent=1, default=float)
    pd.set_option('display.width', 250)
    print(pd.DataFrame([{k: v for k, v in s.items() if k not in ('definition', 'lowo')} for s in sels]).round(3).to_string(index=False))
    for s in sels:
        if 'lowo' in s: print(s['name'], 'LOWO', {k: (round(v, 3) if isinstance(v, float) else v) for k, v in s['lowo'].items()})
    print(json.dumps(front, indent=0, default=float)[:3000]); print(json.dumps(tf, indent=0, default=float)[:3000])


if __name__ == '__main__':
    main()
