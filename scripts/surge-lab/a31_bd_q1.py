"""A31-D 問題 1：s 日已漲停（m_lu_s=1）且有尾盤五檔者，漲停價委買排隊量（x_bd_bidlim、x_bd_q_v）與一字鎖
（x_oneword_s）能否預測 s+1 續漲停？門檻在前 60% 的五檔日選、後 40% 報告；另做逐週留一（LOWO）。
需要先跑 a31_bd_hist.py（M_lu／M_lu_buy 分數）；沒有分數時略過組合部分。輸出 out/a31_bd_q1.txt、out/a31_bd_q1_rules.csv。
"""
import numpy as np, pandas as pd
from a31_bd_common import (load_bd_window, choose_threshold, report_row, lowo_threshold, oof_logistic, boot_auc_diff,
                           MIN_DESIGN_PICKS)
from a31_bd_lib import pooled_auc, day_auc, sel_stats, topk_mask, wilson_lb

pd.set_option('display.width', 220); pd.set_option('display.max_columns', 30)


def main():
    out = open('out/a31_bd_q1.txt', 'w')
    def P(*a):
        print(*a); print(*a, file=out); out.flush()
    w, bdays, nd = load_bd_window()
    ndr = len(bdays) - nd
    P(f'五檔日 {len(bdays)}（{bdays[0]}～{bdays[-1]}）；設計 {nd} 日（～{bdays[nd - 1]}）、報告 {ndr} 日（{bdays[nd]}～）')
    has_sc = 'M_lu' in w.columns and np.isfinite(w['M_lu']).any()
    L = w[(w.m_lu_s == 1)].copy()
    P(f'視窗內 s 日漲停 {len(L)} 列，其中有五檔 {int((L.x_bd_has == 1).sum())}；有五檔續漲停率 {L[L.x_bd_has == 1].m_y.mean():.3f}、'
      f'無五檔 {L[L.x_bd_has != 1].m_y.mean():.3f}')
    L = L[L.x_bd_has == 1].reset_index(drop=True)
    d = L.part.values == 'design'
    for part in ('design', 'report'):
        m = L.part.values == part
        P(f'  {part}: n={m.sum()} 續漲停 {L.m_y[m].mean():.3f}  可買漲停 {L.m_buy_lu[m].mean():.3f}  開盤鎖死 {L.m_locked1[m].mean():.3f}  一字鎖占比 {L.x_oneword_s[m].mean():.3f}')

    # ── 1. 單變數 AUC ──
    feats = ['x_bd_q_v', 'x_bd_bidlim', 'qv20', 'qval', 'x_oneword_s', 'x_lu_streak'] + (['M_lu', 'M_lu_buy'] if has_sc else [])
    rows = []
    for f in feats:
        for tgt in ('m_y', 'm_buy_lu'):
            r = dict(feature=f, target=tgt)
            for part in ('design', 'report', 'all'):
                m = np.ones(len(L), bool) if part == 'all' else (L.part.values == part)
                r[f'auc_{part}'] = pooled_auc(L[f].values[m].astype(float), L[tgt].values[m])
            rows.append(r)
    P('\n[1] 單變數 AUC（s 日漲停且有五檔；0.5=無資訊）'); P(pd.DataFrame(rows).round(3).to_string(index=False))
    # 非一字鎖內
    nw = L.x_oneword_s.values == 0
    P('  非一字鎖內 AUC(m_y)：' + ', '.join(f'{f}={pooled_auc(L[f].values[nw].astype(float), L.m_y.values[nw]):.3f}' for f in ['x_bd_q_v', 'x_bd_bidlim', 'qv20']))
    ow = ~nw
    P('  一字鎖內 AUC(m_y)：' + ', '.join(f'{f}={pooled_auc(L[f].values[ow].astype(float), L.m_y.values[ow]):.3f}' for f in ['x_bd_q_v', 'x_bd_bidlim', 'qv20']) + f'（n={ow.sum()}）')

    # ── 2. 分位數表（全視窗，描述用） ──
    P('\n[2] x_bd_q_v 五分位（全視窗；描述用）')
    L['qq'] = pd.qcut(L.x_bd_q_v.rank(method='first'), 5, labels=False)
    P(L.groupby(['x_oneword_s', 'qq']).agg(n=('m_y', 'size'), lo=('x_bd_q_v', 'min'), hi=('x_bd_q_v', 'max'), prec=('m_y', 'mean'),
                                            buy=('m_buy_lu', 'mean'), locked=('m_locked1', 'mean'), oc1=('m_oc1', 'mean')).round(3).to_string())

    # ── 3. 規則：設計期選門檻 → 報告期 ──
    cand_all = np.ones(len(L), bool)
    fam = [('LU&q_v>=θ', 'x_bd_q_v', cand_all), ('LU&bidlim>=θ', 'x_bd_bidlim', cand_all), ('LU&qv20>=θ', 'qv20', cand_all),
           ('LU&qval>=θ', 'qval', cand_all), ('LU&oneword&q_v>=θ', 'x_bd_q_v', L.x_oneword_s.values == 1),
           ('LU&streak>=2&q_v>=θ', 'x_bd_q_v', L.x_lu_streak.values >= 2), ('LU&streak>=3&q_v>=θ', 'x_bd_q_v', L.x_lu_streak.values >= 3),
           ('LU&!oneword&q_v>=θ', 'x_bd_q_v', L.x_oneword_s.values == 0)]
    if has_sc:
        fam += [('LU&M_lu>=θ', 'M_lu', cand_all), ('LU&oneword&M_lu>=θ', 'M_lu', L.x_oneword_s.values == 1)]
    res = []
    for tgt in ('m_y', 'm_buy_lu'):
        for name, f, cand in fam:
            mp = MIN_DESIGN_PICKS if 'oneword' not in name and 'streak>=3' not in name else 10
            th, pin, nin = choose_threshold(L[f].values.astype(float), L[tgt].values, cand & d, min_picks=mp)
            if not np.isfinite(th): continue
            sel = cand & (L[f].values >= th)
            r = report_row(name.replace('θ', f'{th:.4g}'), f'{name}; θ={th:.4g} chosen on design to max {tgt} precision (min {mp} design picks)',
                           L, sel, nd, ndr, target='m_y')
            r['opt_for'] = tgt; res.append(r)
        # 固定規則
    for name, sel in [('LU (all, has book)', cand_all), ('LU&oneword', L.x_oneword_s.values == 1),
                      ('LU&oneword&streak>=2', (L.x_oneword_s.values == 1) & (L.x_lu_streak.values >= 2)),
                      ('LU&streak>=3', L.x_lu_streak.values >= 3)]:
        r = report_row(name, name + ' (no threshold)', L, sel, nd, ndr); r['opt_for'] = '-'; res.append(r)
    for k in (1, 3):
        for f in ['x_bd_q_v', 'qv20'] + (['M_lu', 'M_lu_buy'] if has_sc else []):
            sel = topk_mask(L[f].values.astype(float), L.date.values, k)
            r = report_row(f'top{k}/day by {f}', f'each day top-{k} LU_s stocks by {f}', L, sel, nd, ndr); r['opt_for'] = '-'; res.append(r)
    R = pd.DataFrame(res)
    P('\n[3] 規則（門檻在設計期選；報告期＝未調參）'); P(R.drop(columns=['definition']).round(3).to_string(index=False))
    R.to_csv('out/a31_bd_q1_rules.csv', index=False)

    # ── 4. LOWO 穩定度 ──
    P('\n[4] 逐週留一（在其他週選門檻、套到留出週）')
    for name, f, cand in fam[:5] + ([fam[8]] if has_sc else []):
        for tgt in ('m_y', 'm_buy_lu'):
            mp = MIN_DESIGN_PICKS if 'oneword' not in name else 10
            t, p, pb, n, lb = lowo_threshold(L, f, cand, target=tgt, min_picks=mp)
            if tgt == 'm_buy_lu':                     # 合併的「隔日漲停」精準度也列出
                yy = L.m_y.values
            wk = t[t.picks > 0]
            P(f'  {name:22s} opt={tgt:8s} picks={n:4d} pooled_prec({tgt})={p:.3f} LB={lb:.3f} buy={pb:.3f} | 週精準度 min={wk.prec.min():.2f} '
              f'med={wk.prec.median():.2f} max={wk.prec.max():.2f}（{len(wk)} 週有選股）')
    # 固定門檻逐週
    th_qv = np.nanquantile(L.x_bd_q_v.values[d], 0.9)
    P(f'  固定規則 LU&q_v>={th_qv:.3f}（設計期 90 分位）逐週：')
    g = L.assign(sel=L.x_bd_q_v >= th_qv)
    t = g[g.sel].groupby('week').agg(picks=('m_y', 'size'), prec=('m_y', 'mean'), buy=('m_buy_lu', 'mean'))
    t['base_LU'] = g.groupby('week').m_y.mean()
    P(t.round(3).to_string())

    # ── 5. 與 f_* 歷史模型的增量 ──
    if has_sc:
        P('\n[5] 增量：逐週留一邏輯迴歸 out-of-fold（M_lu logit 單獨 vs ＋五檔）')
        cand = np.ones(len(L), bool)
        for tgt, base in (('m_y', 'M_lu'), ('m_buy_lu', 'M_lu_buy')):
            s0 = oof_logistic(L, cand, [base], target=tgt)
            s1 = oof_logistic(L, cand, [base, 'log_qv', 'log_bidlim', 'x_oneword_s'], target=tgt)
            s2 = oof_logistic(L, cand, ['log_qv', 'log_bidlim', 'x_oneword_s'], target=tgt)
            y = L[tgt].values
            dlt, ci = boot_auc_diff(s1, s0, y, L.date.values)
            P(f'  {tgt}: AUC 歷史={pooled_auc(s0, y):.3f}  只五檔={pooled_auc(s2, y):.3f}  歷史＋五檔={pooled_auc(s1, y):.3f}  '
              f'差={dlt:+.3f} 95%CI[{ci[0]:+.3f},{ci[1]:+.3f}]（依日 bootstrap）')
            for k in (1, 3):
                for nm, s in (('歷史', s0), ('歷史＋五檔', s1), ('只五檔', s2)):
                    sel = topk_mask(s, L.date.values, k)
                    st = sel_stats(sel, L.m_y.values, L.m_buy_lu.values, L.date.values, len(bdays))
                    P(f'     top{k}/day {nm:6s} picks={st["picks"]:3d} prec(m_y)={st["prec"]:.3f} LB={st["wilson_lb"]:.3f} buy={st["buy_prec"]:.3f}')
        # 分層：M_lu 高低 × q_v 高低
        P('  分層（設計期中位數切）：')
        mlu = L.M_lu.values >= np.nanmedian(L.M_lu.values[d]); qv = L.x_bd_q_v.values >= np.nanmedian(L.x_bd_q_v.values[d])
        P(L.assign(M_lu_hi=mlu, qv_hi=qv).groupby(['M_lu_hi', 'qv_hi']).agg(n=('m_y', 'size'), prec=('m_y', 'mean'), buy=('m_buy_lu', 'mean'),
                                                                           locked=('m_locked1', 'mean')).round(3).to_string())
    out.close()


if __name__ == '__main__':
    main()
