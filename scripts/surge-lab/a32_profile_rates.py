"""a32_profile 步驟 3：延續率與新起漲基準率——逐時代、逐年、逐季、2026 逐月；2026 是否「一個月比一個月熱」。

  · 延續率 P(s+1 漲停｜s 已漲停)：依 s 日一字鎖與否、連板數（1／2／3／4+）
  · 新起漲率 P(s+1 漲停｜s 未漲停)、全部列漲停率、每日漲停檔數、熱日（≥30 檔）比例
  · 每項同時報「開盤買得到且漲停」（m_buy_lu）
  · 95% 區間：5 日區塊 bootstrap（月份只有約 4 塊 → 區間偏粗；另附 Wilson 作為下限參考，Wilson 不計日內群聚會偏窄）
  · 2026 趨勢：逐日率對交易日序做加權線性迴歸（權重＝當日列數）→ 每 20 個交易日的變化，區塊 bootstrap 區間；
    另比 2026H1（1～6 月）vs Q3（7～9 月＋10/1）
輸出：out/a32_profile_rates.log、out/a32_profile_rates.csv
"""
import numpy as np
import pandas as pd
import a32_profile_common as P

HOT = 30


def main():
    D = P.load(); X, names = D['X'], D['names']
    rd, dd = P.day_index(D); nD = len(dd)
    col = lambda n: X[:, names.index(n)]
    y = D['y'] == 1; buy = D['buy_lu'] == 1; lu = D['lu_s'] == 1; fr = ~lu
    ow = col('x_oneword_s') == 1; stk = col('x_lu_streak')
    dsum = lambda m: np.bincount(rd, weights=m.astype(np.float64), minlength=nD)
    cnt_y = dsum(y)

    periods = [('A 2023-2025', dd < P.ERA_B_START), ('B 2026', dd >= P.ERA_B_START)]
    periods += [(yr, np.char.startswith(dd, yr)) for yr in ('2023', '2024', '2025')]
    periods += [('2025H2', (dd >= '2025-07-01') & (dd < '2026-01-01')), ('2026H1', (dd >= '2026-01-01') & (dd <= '2026-06-30')),
                ('2026Q3+', dd >= '2026-07-01')]
    quarters = sorted({f'{d[:4]}Q{(int(d[5:7]) - 1) // 3 + 1}' for d in dd})
    qlab = np.array([f'{d[:4]}Q{(int(d[5:7]) - 1) // 3 + 1}' for d in dd])
    periods += [(q, qlab == q) for q in quarters]
    months26 = sorted(m for m in {d[:7] for d in dd if d >= P.ERA_B_START} if np.char.startswith(dd, m).sum() >= 5)   # 2026-10 只有 1 日 → 不列
    periods += [(m, np.char.startswith(dd, m)) for m in months26]

    metrics = [
        ('新起漲率', y & fr, fr), ('新起漲 可買率', buy & fr, fr),
        ('延續率', y & lu, lu), ('延續 可買率', buy & lu, lu),
        ('延續率｜一字鎖', y & lu & ow, lu & ow), ('延續率｜非一字', y & lu & ~ow, lu & ~ow),
        ('延續 可買率｜一字鎖', buy & lu & ow, lu & ow), ('延續 可買率｜非一字', buy & lu & ~ow, lu & ~ow),
        ('延續率｜連板1', y & (stk == 1), stk == 1), ('延續率｜連板2', y & (stk == 2), stk == 2),
        ('延續率｜連板3', y & (stk == 3), stk == 3), ('延續率｜連板4+', y & (stk >= 4), stk >= 4),
        ('全部漲停率', y, np.ones(len(y), bool)), ('s 日漲停佔比', lu, np.ones(len(y), bool)),
    ]
    md = {nm: (dsum(n), dsum(d)) for nm, n, d in metrics}
    rows = []
    for pi, (pl, pm) in enumerate(periods):
        W = P.block_weights(dd, pm, n_boot=500, seed=300 + pi)
        rec = dict(period=pl, days=int(pm.sum()))
        for nm, (nd, den) in md.items():
            pt, lo, hi, _ = P.ratio_ci(nd, den, W, pm)
            k, n = int(nd[pm].sum()), int(den[pm].sum())
            wl, wh = P.wilson(k, n)
            rec.update({nm: pt, f'{nm}_lo': lo, f'{nm}_hi': hi, f'{nm}_k': k, f'{nm}_n': n, f'{nm}_wl': wl, f'{nm}_wh': wh})
        c = cnt_y[pm]
        rec.update(lu_per_day=float(c.mean()), lu_per_day_med=float(np.median(c)), hot_share=float((c >= HOT).mean()))
        rows.append(rec)
    df = pd.DataFrame(rows)
    df.to_csv(f'{P.OUT}/a32_profile_rates.csv', index=False, float_format='%.5g')

    L = []
    show = ('新起漲率', '新起漲 可買率', '延續率', '延續 可買率', '延續率｜一字鎖', '延續率｜非一字', '延續 可買率｜一字鎖', '延續 可買率｜非一字',
            '延續率｜連板1', '延續率｜連板2', '延續率｜連板3', '延續率｜連板4+', '全部漲停率', 's 日漲停佔比')
    for nm in show:
        L.append(f'\n== {nm}（點估計 [區塊 bootstrap 95%]｛Wilson｝ k/n） ==')
        for r in df.to_dict('records'):
            if r['period'][:4] in ('2023', '2024', '2025') and 'Q' in r['period'] and nm not in ('新起漲率', '延續率', '全部漲停率'): continue
            L.append(f"  {r['period']:<12} {r[nm] * 100:6.2f}% [{r[nm + '_lo'] * 100:6.2f},{r[nm + '_hi'] * 100:6.2f}] "
                     f"｛{r[nm + '_wl'] * 100:.2f},{r[nm + '_wh'] * 100:.2f}｝ {r[nm + '_k']:,}/{r[nm + '_n']:,}")
    L.append('\n== 每日漲停檔數（資料集母體）與熱日比例 ==')
    for r in df.itertuples(index=False):
        L.append(f'  {r.period:<12} 日 {r.days:>3}  平均 {r.lu_per_day:5.1f}  中位 {r.lu_per_day_med:4.0f}  熱日 {r.hot_share * 100:5.1f}%')

    # 2026 逐日趨勢
    L.append('\n== 2026 逐日趨勢（加權線性迴歸，每 20 交易日變化；區塊 bootstrap） ==')
    mB = dd >= P.ERA_B_START; idx = np.nonzero(mB)[0]; tpos = np.arange(len(idx), dtype=np.float64)
    WB = P.block_weights(dd, mB, n_boot=1000, seed=999)[:, idx]
    for nm in ('新起漲率', '新起漲 可買率', '延續率', '延續 可買率', '全部漲停率'):
        nd, den = md[nm]; num, de = nd[idx], den[idx]

        def slope(w):
            ww = w * de; ok = de > 0
            r = np.where(ok, num / np.maximum(de, 1), 0)
            tm = (ww * tpos).sum() / ww.sum(); rm = (ww * r).sum() / ww.sum()
            return ((ww * (tpos - tm) * (r - rm)).sum() / (ww * (tpos - tm) ** 2).sum())
        pt = slope(np.ones(len(idx)))
        bs = np.array([slope(WB[b]) for b in range(WB.shape[0])])
        lo, hi = np.nanpercentile(bs, [2.5, 97.5])
        L.append(f'  {nm:<10} 每 20 日 {pt * 20 * 100:+.3f}pp [{lo * 20 * 100:+.3f},{hi * 20 * 100:+.3f}]（期初約 {df.loc[df.period == "2026-01", nm].values[0] * 100:.2f}%）')
    c = cnt_y[idx]
    pt = np.polyfit(tpos, c, 1)[0]
    bs = []
    for b in range(WB.shape[0]):
        w = WB[b]; tm = (w * tpos).sum() / w.sum(); cm = (w * c).sum() / w.sum()
        bs.append((w * (tpos - tm) * (c - cm)).sum() / (w * (tpos - tm) ** 2).sum())
    lo, hi = np.nanpercentile(bs, [2.5, 97.5])
    L.append(f'  每日漲停檔數 每 20 日 {pt * 20:+.2f} 檔 [{lo * 20:+.2f},{hi * 20:+.2f}]')
    txt = '\n'.join(L); print(txt)
    open(f'{P.OUT}/a32_profile_rates.log', 'w').write(txt + '\n')


if __name__ == '__main__':
    main()
