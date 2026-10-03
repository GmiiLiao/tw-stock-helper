"""A31-D 問題 2：s 日未漲停者，尾盤五檔委買／委賣失衡（x_bd_imb）與委買量能否預測 s+1 漲停、並在 f_* 歷史模型
（M_nonlu）之上有增量？另給視窗內全市場（含已漲停）前沿。需要 a31_bd_hist.py 的分數。
輸出 out/a31_bd_q2.txt。
"""
import numpy as np, pandas as pd
from a31_bd_common import load_bd_window, choose_threshold, report_row, oof_logistic, boot_auc_diff
from a31_bd_lib import pooled_auc, day_auc, sel_stats, topk_mask, wilson_lb

pd.set_option('display.width', 220); pd.set_option('display.max_columns', 30)
BOOK = ['x_bd_imb', 'log_bid_v20', 'log_ask_v20']


def main():
    out = open('out/a31_bd_q2.txt', 'w')
    def P(*a):
        print(*a); print(*a, file=out); out.flush()
    w, bdays, nd = load_bd_window(); ndr = len(bdays) - nd
    has_sc = 'M_nonlu' in w.columns
    N = w[(w.m_lu_s == 0) & (w.x_bd_has == 1) & np.isfinite(w.x_bd_imb)].reset_index(drop=True)
    d = N.part.values == 'design'
    P(f'未漲停且有五檔 {len(N):,} 列（設計 {d.sum():,}／報告 {(~d).sum():,}）；隔日漲停率 {N.m_y.mean():.4f}（設計 {N.m_y[d].mean():.4f}、報告 {N.m_y[~d].mean():.4f}）')
    P(f'  同視窗未漲停但無五檔 {int(((w.m_lu_s == 0) & (w.x_bd_has != 1)).sum()):,} 列，隔日漲停率 {w.m_y[(w.m_lu_s == 0) & (w.x_bd_has != 1)].mean():.4f}')

    # 1. 單變數
    feats = BOOK + ['x_bd_bid', 'x_bd_ask', 'f_r1', 'f_close_pos', 'f_atr14'] + (['M_nonlu'] if has_sc else [])
    rows = []
    for f in feats:
        for tgt in ('m_y', 'm_buy_lu'):
            r = dict(feature=f, target=tgt)
            for part in ('design', 'report'):
                m = N.part.values == part
                r[f'auc_{part}'] = pooled_auc(N[f].values[m].astype(float), N[tgt].values[m])
                r[f'dayauc_{part}'] = day_auc(N[f].values[m].astype(float), N[tgt].values[m], N.date.values[m])
            rows.append(r)
    P('\n[1] 單變數 AUC（pooled；dayauc＝正例在同日的平均百分位）'); P(pd.DataFrame(rows).round(3).to_string(index=False))

    # 2. imb 十分位
    N['imb_dec'] = pd.qcut(N.x_bd_imb.rank(method='first'), 10, labels=False)
    P('\n[2] x_bd_imb 十分位（全視窗）')
    P(N.groupby('imb_dec').agg(lo=('x_bd_imb', 'min'), hi=('x_bd_imb', 'max'), n=('m_y', 'size'), prec=('m_y', 'mean'),
                               buy=('m_buy_lu', 'mean'), r1=('f_r1', 'mean'), oc1=('m_oc1', 'mean')).round(4).to_string())
    # 強勢股內（s 日漲幅 ≥ 5% 未漲停）
    hot = N.f_r1.values >= 0.05
    P(f'\n  s 日漲 ≥5% 未漲停：n={hot.sum()} 隔日漲停 {N.m_y[hot].mean():.3f}；imb AUC={pooled_auc(N.x_bd_imb.values[hot], N.m_y.values[hot]):.3f}，'
      f'log_bid_v20 AUC={pooled_auc(N.log_bid_v20.values[hot], N.m_y.values[hot]):.3f}，log_ask_v20 AUC={pooled_auc(N.log_ask_v20.values[hot], N.m_y.values[hot]):.3f}')
    H = N[hot].copy(); H['q'] = pd.qcut(H.x_bd_imb.rank(method='first'), 5, labels=False)
    P(H.groupby('q').agg(lo=('x_bd_imb', 'min'), hi=('x_bd_imb', 'max'), n=('m_y', 'size'), prec=('m_y', 'mean'), buy=('m_buy_lu', 'mean')).round(3).to_string())

    if not has_sc:
        out.close(); return
    # 3. 增量：OOF 邏輯迴歸
    P('\n[3] 增量（逐週留一邏輯迴歸 OOF）：M_nonlu logit vs ＋五檔')
    cand = np.ones(len(N), bool)
    s0 = oof_logistic(N, cand, ['M_nonlu'])
    s1 = oof_logistic(N, cand, ['M_nonlu'] + BOOK)
    s2 = oof_logistic(N, cand, BOOK)
    y = N.m_y.values
    dlt, ci = boot_auc_diff(s1, s0, y, N.date.values, n=400)
    P(f'  AUC 歷史={pooled_auc(s0, y):.4f} 只五檔={pooled_auc(s2, y):.4f} 歷史＋五檔={pooled_auc(s1, y):.4f} 差={dlt:+.4f} 95%CI[{ci[0]:+.4f},{ci[1]:+.4f}]')
    P(f'  day-AUC 歷史={day_auc(s0, y, N.date.values):.4f} 歷史＋五檔={day_auc(s1, y, N.date.values):.4f}')
    for k in (1, 3, 10, 30):
        for nm, s in (('歷史', s0), ('歷史＋五檔', s1), ('只五檔', s2)):
            sel = topk_mask(s, N.date.values, k)
            st = sel_stats(sel, y, N.m_buy_lu.values, N.date.values, len(bdays))
            P(f'     top{k:<2d}/day {nm:6s} picks={st["picks"]:4d} prec={st["prec"]:.3f} LB={st["wilson_lb"]:.3f} buy={st["buy_prec"]:.3f}')
    # 4. 規則：M_nonlu 前 K 名中再以 imb 過濾（θ 設計期選）
    P('\n[4] M_nonlu 每日前 K 名內以 imb 過濾（設計期選 θ → 報告期）')
    res = []
    for K in (10, 30, 100):
        top = topk_mask(N.M_nonlu.values, N.date.values, K)
        r = report_row(f'top{K} M_nonlu', f'top{K}/day by M_nonlu among non-LU with book', N, top, nd, ndr); res.append(r)
        th, p, n = choose_threshold(N.x_bd_imb.values, y, top & d, min_picks=20)
        sel = top & (N.x_bd_imb.values >= th)
        res.append(report_row(f'top{K} M_nonlu & imb>={th:.3f}', '', N, sel, nd, ndr))
        lo = top & (N.x_bd_imb.values < np.nanmedian(N.x_bd_imb.values[top & d]))
        res.append(report_row(f'top{K} M_nonlu & imb<design median', '', N, lo, nd, ndr))
    P(pd.DataFrame(res).drop(columns=['definition']).round(3).to_string(index=False))

    # 5. 全市場前沿（視窗、含已漲停）：M_all 與 M_all＋五檔
    if 'M_all_buy' not in w.columns:
        out.close(); return
    P('\n[5] 視窗全市場（含 s 日已漲停）：每日前 K 名精準度（報告期 18 日）')
    A = w[np.isfinite(w.M_all)].reset_index(drop=True)
    A['bd_has1'] = (A.x_bd_has == 1).astype(float)
    for c in ['log_qv', 'log_bidlim', 'x_bd_imb', 'log_bid_v20', 'log_ask_v20']:
        A[c] = np.where(A.x_bd_has == 1, A[c], np.nan)
    sA = oof_logistic(A, np.ones(len(A), bool), ['M_all', 'bd_has1', 'log_qv', 'log_bidlim', 'x_bd_imb', 'log_bid_v20', 'log_ask_v20'])
    rp = A.part.values == 'report'
    for nm, s in (('M_all', A.M_all.values), ('M_all＋五檔(OOF)', sA), ('M_all_buy', A.M_all_buy.values)):
        for k in (1, 3, 10):
            sel = topk_mask(s, A.date.values, k) & rp
            st = sel_stats(sel, A.m_y.values, A.m_buy_lu.values, A.date.values, ndr)
            P(f'  {nm:16s} top{k:<2d}/day picks={st["picks"]:4d} prec={st["prec"]:.3f} LB={st["wilson_lb"]:.3f} buy={st["buy_prec"]:.3f}')
        o = np.argsort(-np.where(rp, np.nan_to_num(s, nan=-1e9), -1e9))
        for n in (30, 100, 300):
            ii = o[:n]
            P(f'  {nm:16s} 報告期總分最高 {n:3d} 檔：prec={A.m_y.values[ii].mean():.3f} buy={A.m_buy_lu.values[ii].mean():.3f}（描述前沿，非選股器）')
    out.close()


if __name__ == '__main__':
    main()
