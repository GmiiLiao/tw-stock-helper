"""a32_profile 步驟 4b：比較 A（2023-2025）與 B（2026）GBDT 的 split-gain 重要度（僅描述用），並附樣本外對照。

重要度：各模型 gain 佔比；前 20 名與重疊數；全部 123 特徵的 Spearman 相關；特徵家族佔比。
雜訊基準：A_m1 vs A_m2（同時代、與 B 同日數的兩組互斥抽樣）、B_full vs B_s1（同資料換種子）。
樣本外對照（描述用，不調參）：
  · 2026-07-01～10-01：A_full（只看 ≤2025）vs B_h1（只看 2026-01～06）→ 每日前 1／3／10 名精確度、可買精確度、只限新起漲
  · 2026 全年：A_full（樣本外）；B_full（樣本內，只當上限參考）
  · 反向：B_full 打 2023-2025（樣本外，描述用）
輸出：out/a32_profile_gbdt_eval.log、out/a32_profile_importance.csv
"""
import os
import numpy as np
import pandas as pd
import a32_profile_common as P

MODELS = ('A_full', 'B_full', 'B_s1', 'A_m1', 'A_m2', 'A_fresh', 'B_fresh', 'B_h1')
FAMILY = [('漲停史/型態', ('f_n_lu', 'f_days_since_lu', 'x_lu_', 'x_oneword', 'x_close_at_high')),
          ('報酬/位置', ('f_r1', 'f_r3', 'f_r5', 'f_r10', 'f_r20', 'f_r60', 'f_r120', 'f_pos', 'f_dist_hi', 'f_brk', 'f_up_')),
          ('指標', ('f_macd', 'f_kd', 'f_rsi')),          # 須在「均線」前（f_macd 也以 f_ma 開頭）
          ('均線', ('f_c_ma', 'f_ma', 'f_n_above_ma', 'f_bull_align')),
          ('波動', ('f_atr14', 'f_bbw', 'f_bb_pctb', 'f_vol10', 'f_vol60', 'f_vol_ratio', 'f_range', 'f_day_range')),
          ('K 棒', ('f_body', 'f_upper_shadow', 'f_lower_shadow', 'f_close_pos', 'f_gap')),
          ('量能', ('f_vr', 'f_v5_20', 'f_v_', 'f_log_tv20', 'f_obv', 'f_updown_vol', 'f_pv_up', 'x_vol20')),
          ('籌碼', ('f_fgn', 'f_trust', 'f_inst', 'f_ml_', 'f_ms_', 'f_lend', 'f_dt_')),
          ('營收', ('f_rev',)),
          ('大盤', ('f_mkt_',)),
          ('橫斷面/產業', ('f_rk_', 'f_rs20', 'f_ind_')),
          ('價格', ('x_price',))]


def family(n):
    for fam, pre in FAMILY:
        if any(n.startswith(p) for p in pre): return fam
    return '其他'


def spearman(a, b):
    ra = pd.Series(a).rank().values; rb = pd.Series(b).rank().values
    return float(np.corrcoef(ra, rb)[0, 1])


def topk_eval(score, rows, D, ks=(1, 3, 10)):
    """rows：列索引（遞增）；score 對應 rows。回傳每日前 k 名的精確度／可買／延續佔比與 Wilson。"""
    s = D['s'][rows]; y = D['y'][rows]; b = D['buy_lu'][rows]; lu = D['lu_s'][rows]
    rng = np.random.default_rng(0)
    sc = score.astype(np.float64) + rng.random(len(score)) * 1e-9
    o = np.lexsort((-sc, s)); ss = s[o]
    start = np.r_[0, np.nonzero(np.diff(ss))[0] + 1]
    rk = np.empty(len(sc), np.int64); rk[o] = np.arange(len(ss)) - np.repeat(start, np.diff(np.r_[start, len(ss)]))
    out = []
    for k in ks:
        m = rk < k; n = int(m.sum()); h = int(y[m].sum()); hb = int(b[m].sum())
        out.append(f'top{k}/日 {h / n * 100:5.1f}% [{P.wilson(h, n)[0] * 100:4.1f},{P.wilson(h, n)[1] * 100:4.1f}] 可買 {hb / n * 100:4.1f}% 延續佔 {lu[m].mean() * 100:3.0f}% (n={n})')
    # 同日 AUC
    U = 0.0; PP = 0.0
    df = pd.DataFrame(dict(s=s, sc=sc, y=y))
    df['r'] = df.groupby('s')['sc'].rank()
    g = df.groupby('s').agg(n=('y', 'size'), n1=('y', 'sum'))
    r1 = df[df.y == 1].groupby('s')['r'].sum().reindex(g.index).fillna(0)
    U = (r1 - g.n1 * (g.n1 + 1) / 2).sum(); PP = (g.n1 * (g.n - g.n1)).sum()
    return out, U / PP


def main():
    D = P.load(); names = D['names']
    M = {}
    for m in MODELS:
        f = f'{P.SP}/a32_profile_gbdt_{m}.npz'
        if os.path.exists(f): M[m] = dict(np.load(f, allow_pickle=False))
    L = []
    imp = {m: M[m]['gain_imp'] / M[m]['gain_imp'].sum() for m in M}
    df = pd.DataFrame({m: imp[m] for m in imp}, index=names)
    df['family'] = [family(n) for n in names]
    df.to_csv(f'{P.OUT}/a32_profile_importance.csv', float_format='%.5f')
    L.append('== 模型樣本 ==')
    for m in M:
        L.append(f'  {m:<8} 列 {int(M[m]["n_rows"]):>9,} 日 {int(M[m]["n_days"]):>4} 正例 {int(M[m]["n_pos"]):>6,}')
    L.append('\n== 重要度前 20（gain 佔比） ==')
    for m in ('A_full', 'B_full', 'A_fresh', 'B_fresh'):
        if m not in imp: continue
        top = np.argsort(-imp[m])[:20]
        L.append(f'  {m}: ' + '、'.join(f'{names[i]}({imp[m][i] * 100:.1f})' for i in top))
    L.append('\n== 前 20 重疊數／前 10 重疊數／全 123 特徵 Spearman ==')
    pairs = [('A_full', 'B_full', '跨時代（主比較）'), ('A_fresh', 'B_fresh', '跨時代（只新起漲）'),
             ('A_m1', 'A_m2', '雜訊基準：同 A、同大小、不同日子'), ('A_m1', 'B_full', '跨時代、同大小 1'), ('A_m2', 'B_full', '跨時代、同大小 2'),
             ('B_full', 'B_s1', '雜訊基準：同 B、換種子'), ('A_full', 'A_m1', '同 A：全量 vs 抽 180 日')]
    for a, b, lab in pairs:
        if a not in imp or b not in imp: continue
        ta, tb = set(np.argsort(-imp[a])[:20]), set(np.argsort(-imp[b])[:20])
        t10a, t10b = set(np.argsort(-imp[a])[:10]), set(np.argsort(-imp[b])[:10])
        L.append(f'  {a:<8} vs {b:<8} 前20重疊 {len(ta & tb):>2}  前10重疊 {len(t10a & t10b):>2}  Spearman {spearman(imp[a], imp[b]):.2f}  ← {lab}')
    if 'A_full' in imp and 'B_full' in imp:
        ta, tb = set(np.argsort(-imp['A_full'])[:20]), set(np.argsort(-imp['B_full'])[:20])
        L.append('  只在 A_full 前 20：' + '、'.join(names[i] for i in sorted(ta - tb, key=lambda i: -imp['A_full'][i])))
        L.append('  只在 B_full 前 20：' + '、'.join(names[i] for i in sorted(tb - ta, key=lambda i: -imp['B_full'][i])))
    if 'A_fresh' in imp and 'B_fresh' in imp:
        ta, tb = set(np.argsort(-imp['A_fresh'])[:20]), set(np.argsort(-imp['B_fresh'])[:20])
        L.append('  只在 A_fresh 前 20：' + '、'.join(names[i] for i in sorted(ta - tb, key=lambda i: -imp['A_fresh'][i])))
        L.append('  只在 B_fresh 前 20：' + '、'.join(names[i] for i in sorted(tb - ta, key=lambda i: -imp['B_fresh'][i])))
    L.append('\n== 特徵家族 gain 佔比（%） ==')
    fam = df.groupby('family')[[m for m in MODELS if m in imp]].sum() * 100
    L.append(fam.sort_values('A_full' if 'A_full' in fam else fam.columns[0], ascending=False).round(1).to_string())

    L.append('\n== 樣本外對照（描述用） ==')
    era, sd = D['era'], D['sd']
    if 'A_full' in M and 'B_h1' in M:
        q3 = np.nonzero((era == 1) & (sd >= '2026-07-01'))[0]
        for m in ('A_full', 'B_h1'):
            sc = pd.Series(M[m]['score_B'], index=M[m]['idx_B']).reindex(q3).values
            for lab, sub in (('全部', np.ones(len(q3), bool)), ('只新起漲', D['fresh'][q3])):
                r, auc = topk_eval(sc[sub], q3[sub], D)
                L.append(f'  2026-07～10 {m:<7}（{"只看≤2025" if m == "A_full" else "只看2026H1"}）{lab:<5} 同日AUC {auc:.3f}｜' + '｜'.join(r))
    if 'A_full' in M:
        idx = M['A_full']['idx_B']
        for lab, sub in (('全部', np.ones(len(idx), bool)), ('只新起漲', D['fresh'][idx])):
            r, auc = topk_eval(M['A_full']['score_B'][sub], idx[sub], D)
            L.append(f'  2026 全年 A_full（樣本外）{lab:<5} 同日AUC {auc:.3f}｜' + '｜'.join(r))
    if 'B_full' in M:
        idx = M['B_full']['idx_B']
        for lab, sub in (('全部', np.ones(len(idx), bool)), ('只新起漲', D['fresh'][idx])):
            r, auc = topk_eval(M['B_full']['score_B_insample'][sub], idx[sub], D)
            L.append(f'  2026 全年 B_full（樣本內！上限參考）{lab:<5} 同日AUC {auc:.3f}｜' + '｜'.join(r))
        idx = M['B_full']['idx_A']
        for lab, sub in (('全部', np.ones(len(idx), bool)), ('只新起漲', D['fresh'][idx])):
            r, auc = topk_eval(M['B_full']['score_A'][sub], idx[sub], D)
            L.append(f'  2023-2025 B_full（反向樣本外）{lab:<5} 同日AUC {auc:.3f}｜' + '｜'.join(r))
    if 'A_fresh' in M:
        idx = M['A_fresh']['idx_B']; sub = D['fresh'][idx]
        r, auc = topk_eval(M['A_fresh']['score_B'][sub], idx[sub], D)
        L.append(f'  2026 全年 A_fresh（樣本外，只新起漲）同日AUC {auc:.3f}｜' + '｜'.join(r))
    if 'B_fresh' in M:
        idx = M['B_fresh']['idx_A']; sub = D['fresh'][idx]
        r, auc = topk_eval(M['B_fresh']['score_A'][sub], idx[sub], D)
        L.append(f'  2023-2025 B_fresh（反向樣本外，只新起漲）同日AUC {auc:.3f}｜' + '｜'.join(r))
    txt = '\n'.join(L); print(txt)
    open(f'{P.OUT}/a32_profile_gbdt_eval.log', 'w').write(txt + '\n')


if __name__ == '__main__':
    main()
