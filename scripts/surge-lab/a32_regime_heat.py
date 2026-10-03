"""a32_regime 步驟 1：市場熱度描述（不需模型）。

回答：
  (1) 年／季／月／週的隔日漲停基準率與每日漲停檔數，2026 vs 2023–2025；2026 有沒有冷的時段
  (3) 檢驗「未來幾年只會更熱」：2023→2026 趨勢、變異、持續性（月與月、日與日的自相關）
輸出：out/a32_regime_heat.log、out/a32_regime_daily.csv、out/a32_regime_monthly.csv、out/a32_regime_weekly.csv
"""
import os
import sys
import numpy as np
import pandas as pd
import a32_regime_common as C


def pct(x): return f'{x * 100:.2f}%'


def block_boot_slope(t, v, block=3, n_boot=4000, seed=0):
    """月序列 OLS 斜率（每年），以連續 block 個月為區塊重抽求 95% 區間（保留短期自相關）。"""
    rng = np.random.default_rng(seed)
    nb = int(np.ceil(len(v) / block)); starts = np.arange(0, len(v) - block + 1)
    sl = []
    for _ in range(n_boot):
        ii = np.concatenate([np.arange(st, st + block) for st in rng.choice(starts, nb)])[:len(v)]
        sl.append(np.polyfit(t[ii], v[ii], 1)[0])
    return np.percentile(sl, [2.5, 97.5])


def main():
    D = C.load(with_x=False)
    g = C.day_table(D)
    os.makedirs(C.OUT, exist_ok=True)
    g.to_csv(os.path.join(C.OUT, 'a32_regime_daily.csv'), index=False)
    print(f'交易日 {len(g)}（{g.date.iloc[0]}～{g.date.iloc[-1]}），列 {len(D["s"]):,}')
    print(f'檢查：s 日漲停檔數（m_lu_s 加總）與 f_mkt_lu_cnt 中位數相關 {np.corrcoef(g.lu_s, g.f_mkt_lu_cnt)[0, 1]:.3f}')

    print('\n=== 年度 ===（基準率＝s+1 漲停列 ÷ 母體列；每日漲停＝s+1 當日母體內漲停檔數）')
    rows = []
    for yr, h in g.groupby('year'):
        lu = h.lu_next.values
        rows.append(dict(year=yr, days=len(h), univ=h.n.mean(), base=h.lu_next.sum() / h.n.sum(), lu_mean=lu.mean(), lu_med=np.median(lu),
                         lu_p10=np.percentile(lu, 10), lu_p90=np.percentile(lu, 90), lu_cv=lu.std() / lu.mean(),
                         cool=(lu < C.COOL_LU).mean(), fresh_share=h.fresh_next.sum() / h.lu_next.sum(), buy_share=h.buy_next.sum() / h.lu_next.sum()))
    yt = pd.DataFrame(rows)
    for r in yt.itertuples():
        print(f'{r.year}: 日 {r.days:>3}  母體 {r.univ:6.0f}/日  基準率 {pct(r.base)}  每日漲停 平均 {r.lu_mean:5.1f}／中位 {r.lu_med:4.0f}'
              f'（P10 {r.lu_p10:4.0f}、P90 {r.lu_p90:4.0f}、CV {r.lu_cv:.2f}）  <{C.COOL_LU} 檔的日 {r.cool * 100:4.1f}%  '
              f'新起漲占 {r.fresh_share * 100:4.1f}%  開盤買得到占 {r.buy_share * 100:4.1f}%')
    b26 = yt.loc[yt.year == 2026, 'base'].item(); b_prev = g[g.year < 2026].lu_next.sum() / g[g.year < 2026].n.sum()
    print(f'2026 基準率 ÷ 2023–2025 合併基準率 = {b26 / b_prev:.2f} 倍；÷ 2025 = {b26 / yt.loc[yt.year == 2025, "base"].item():.2f} 倍')

    print('\n=== 季度 ===')
    qt = g.groupby('q').apply(lambda h: pd.Series(dict(days=len(h), base=h.lu_next.sum() / h.n.sum(), lu_mean=h.lu_next.mean(),
                                                       cool=(h.lu_next < C.COOL_LU).mean())), include_groups=False).reset_index()
    for r in qt.itertuples():
        print(f'{r.q}: 日 {int(r.days):>2}  基準率 {pct(r.base)}  每日漲停平均 {r.lu_mean:5.1f}  冷日 {r.cool * 100:4.1f}%  ' + '#' * int(round(r.base * 1000)))
    qb = qt.base.values
    up = (np.diff(qb) > 0).sum()
    print(f'季對季：上升 {up}／{len(qb) - 1} 次；相鄰兩季基準率相關（lag-1）{np.corrcoef(qb[:-1], qb[1:])[0, 1]:.2f}')

    print('\n=== 月度 ===')
    mt = g.groupby('ym').apply(lambda h: pd.Series(dict(days=len(h), base=h.lu_next.sum() / h.n.sum(), lu_mean=h.lu_next.mean(),
                                                        lu_min=h.lu_next.min(), cool=(h.lu_next < C.COOL_LU).mean(),
                                                        breadth=h.f_mkt_breadth_ma20.mean(), mkt_r20=h.f_mkt_r20.iloc[-1])),
                               include_groups=False).reset_index()
    mt['year'] = mt.ym.str[:4].astype(int)
    prev = mt[mt.year < 2026].base.values
    mt['pctile_vs_2325'] = [(prev < b).mean() for b in mt.base]
    mt.to_csv(os.path.join(C.OUT, 'a32_regime_monthly.csv'), index=False)
    for r in mt.itertuples():
        flag = ' ← 2026' if r.year == 2026 else ''
        print(f'{r.ym}: 日 {int(r.days):>2}  基準率 {pct(r.base)}  每日漲停 {r.lu_mean:5.1f}（最少 {int(r.lu_min):>3}）  冷日 {r.cool * 100:4.0f}%  '
              f'站上MA20比例 {r.breadth * 100:4.1f}%  在 2023–25 月分布的百分位 {r.pctile_vs_2325 * 100:4.0f}{flag}')
    m26 = mt[mt.year == 2026]
    print(f'2026 各月基準率 {pct(m26.base.min())}～{pct(m26.base.max())}；2023–2025 各月 {pct(prev.min())}～{pct(prev.max())}（中位 {pct(np.median(prev))}，P90 {pct(np.percentile(prev, 90))}）')
    print(f'2026 低於 2023–2025 月中位數的月份：{list(m26[m26.base < np.median(prev)].ym)}；低於 2025 年基準率的月份：'
          f'{list(m26[m26.base < yt.loc[yt.year == 2025, "base"].item()].ym)}')
    mb = mt.base.values
    print(f'月對月 lag-1 相關 {np.corrcoef(mb[:-1], mb[1:])[0, 1]:.2f}；月基準率 CV：2023–25 {prev.std() / prev.mean():.2f}、2026 {m26.base.std() / m26.base.mean():.2f}')
    tt = np.arange(len(mb)) / 12.0
    sl = np.polyfit(tt, mb, 1)[0]; lo, hi = block_boot_slope(tt, mb)
    print(f'月基準率線性趨勢（2023-01～2026-09）：每年 {sl * 100:+.2f} 個百分點（3 個月區塊 bootstrap 95% {lo * 100:+.2f}～{hi * 100:+.2f}）')
    pre = mt.year < 2026
    sl2 = np.polyfit(tt[pre], mb[pre], 1)[0]; lo2, hi2 = block_boot_slope(tt[pre], mb[pre])
    print(f'只看 2023–2025：每年 {sl2 * 100:+.2f} 個百分點（95% {lo2 * 100:+.2f}～{hi2 * 100:+.2f}）')
    i26 = np.nonzero((mt.year == 2026).values)[0]
    sl3 = np.polyfit(tt[i26], mb[i26], 1)[0]
    print(f'2026 年內（1～9 月）趨勢：每年 {sl3 * 100:+.2f} 個百分點（9 點，不做區間）')

    print('\n=== 週度（2026）===')
    wt = g.groupby('wk').apply(lambda h: pd.Series(dict(start=h.date.iloc[0], days=len(h), base=h.lu_next.sum() / h.n.sum(),
                                                        lu_mean=h.lu_next.mean(), lu_s_mean=h.lu_s.mean())), include_groups=False).reset_index()
    wt['year'] = wt.start.str[:4].astype(int)
    wt.to_csv(os.path.join(C.OUT, 'a32_regime_weekly.csv'), index=False)
    w26 = wt[wt.year == 2026]; wprev = wt[wt.year < 2026]
    med_prev = np.median(wprev.base); b25 = yt.loc[yt.year == 2025, 'base'].item()
    print(f'2026 週數 {len(w26)}；週基準率 {pct(w26.base.min())}～{pct(w26.base.max())}（中位 {pct(w26.base.median())}）；2023–2025 週中位 {pct(med_prev)}')
    print(f'2026 週基準率 < 2023–25 週中位數：{int((w26.base < med_prev).sum())} 週；< 2025 年基準率（{pct(b25)}）：{int((w26.base < b25).sum())} 週')
    print('2026 最冷 8 週：' + '、'.join(f'{r.start}({pct(r.base)}, {r.lu_mean:.0f}檔/日)' for r in w26.nsmallest(8, 'base').itertuples()))
    print('2026 最熱 5 週：' + '、'.join(f'{r.start}({pct(r.base)}, {r.lu_mean:.0f}檔/日)' for r in w26.nlargest(5, 'base').itertuples()))
    wb = wt.base.values
    print(f'週對週 lag-1 相關 {np.corrcoef(wb[:-1], wb[1:])[0, 1]:.2f}')

    print('\n=== 日度熱度可預測性（ex-ante 能不能看出明天熱不熱）===')
    for yr in (None, 2026):
        h = g if yr is None else g[g.year == yr]
        c1 = np.corrcoef(h.lu_s, h.lu_next)[0, 1]
        cb = np.corrcoef(h.lu_s / h.n, h.base)[0, 1]
        print(f'{"全期" if yr is None else yr}: corr(s 日漲停檔數, s+1 日漲停檔數)={c1:.2f}；比率相關={cb:.2f}')
    h = g[g.year == 2026]
    for lo_, hi_ in ((0, 15), (15, 30), (30, 50), (50, 80), (80, 999)):
        mm = (h.lu_s >= lo_) & (h.lu_s < hi_)
        if mm.sum():
            print(f'  2026 s 日漲停 {lo_:>2}～{hi_:<3} 檔的日（{int(mm.sum()):>3} 日）：s+1 漲停平均 {h.lu_next[mm].mean():5.1f} 檔、'
                  f's+1 < {C.COOL_LU} 檔的比例 {(h.lu_next[mm] < C.COOL_LU).mean() * 100:4.0f}%')

    print('\n=== 2026 冷日 ===')
    for yr in (2023, 2024, 2025, 2026):
        h = g[g.year == yr]
        print(f'{yr}: s+1 漲停 < {C.COOL_LU} 檔 {int((h.lu_next < C.COOL_LU).sum())} 日／{len(h)}；< 10 檔 {int((h.lu_next < 10).sum())} 日；'
              f's 日漲停 < {C.COOL_LU} 檔（ex-ante）{int((h.lu_s < C.COOL_LU).sum())} 日')
    h = g[(g.year == 2026) & (g.lu_next < C.COOL_LU)]
    print('2026 冷日（s 日→s+1 漲停數）：' + '、'.join(f'{r.date}({int(r.lu_next)})' for r in h.itertuples()))


if __name__ == '__main__':
    log = open(os.path.join(C.OUT, 'a32_regime_heat.log'), 'w')

    class Tee:
        def write(self, x): sys.__stdout__.write(x); log.write(x)
        def flush(self): sys.__stdout__.flush(); log.flush()
    sys.stdout = Tee()
    main()
