"""a32_profile 步驟 2：2026 與 2023-2025 的「隔日漲停」組成差異。

正例＝s+1 收漲停的 (s, 股)。每一項都報 A（2023-01-11～2025-12-31）與 B（2026-01-01～10-01），
95% 區間＝5 日區塊 bootstrap（A、B 各自重抽）。
  1 延續（s 已漲停）佔比、s 日一字鎖佔比、s+1 開盤即鎖（買不到）佔比
  2 上櫃（TPEx）佔比與各市場漲停率
  3 價位帶：正例分布與各帶漲停率（全部／新起漲）
  4 當沖比（f_dt_ratio）有值比例
  5 產業（peerComps 快照）：正例佔比、漲停率、B/A 倍數
  6 大盤環境（s 日 f_mkt_*）：以 A 的日分布切五分位，各時代日數分布與漲停率；
    「若 2026 套用 A 的分環境漲停率，預期漲停數」vs 實際 → 2026 的熱有多少是環境（多頭日變多）可解釋
  7 熱日（同一個 s+1 有 ≥30 檔漲停，以資料集母體計）：日數比例、漲停落在熱日的比例
輸出：out/a32_profile_composition.log、out/a32_profile_composition.json
"""
import json
import numpy as np
import a32_profile_common as P

HOT = 30
PRICE_BANDS = (0, 10, 20, 50, 100, 300, 1e9)


class Agg:
    def __init__(self, D):
        self.D = D
        self.rd, self.day_dates = P.day_index(D)
        self.nD = len(self.day_dates)
        self.eB = self.day_dates >= P.ERA_B_START; self.eA = ~self.eB
        self.W = {'A': P.block_weights(self.day_dates, self.eA, seed=21), 'B': P.block_weights(self.day_dates, self.eB, seed=22)}
        self.M = {'A': self.eA, 'B': self.eB}

    def d(self, mask):
        return np.bincount(self.rd, weights=mask.astype(np.float64), minlength=self.nD)

    def ratio(self, num, den):
        """num、den：列布林。回傳 {A:(pt,lo,hi), B:(...), dB_A:(pt,lo,hi)}（差＝B−A）。"""
        nd, dd = self.d(num), self.d(den)
        out = {}; bss = {}
        for e in ('A', 'B'):
            pt, lo, hi, bs = P.ratio_ci(nd, dd, self.W[e], self.M[e]); out[e] = (pt, lo, hi); bss[e] = bs
            out[f'n_{e}'] = (int(nd[self.M[e]].sum()), int(dd[self.M[e]].sum()))
        df = bss['B'] - bss['A']
        out['diff'] = (out['B'][0] - out['A'][0], *np.nanpercentile(df, [2.5, 97.5]))
        return out


def fmt(r, nd=1):
    a, b, d = r['A'], r['B'], r['diff']
    return (f"A {a[0] * 100:.{nd}f}% [{a[1] * 100:.{nd}f},{a[2] * 100:.{nd}f}] (n={r['n_A'][0]:,}/{r['n_A'][1]:,})  "
            f"B {b[0] * 100:.{nd}f}% [{b[1] * 100:.{nd}f},{b[2] * 100:.{nd}f}] (n={r['n_B'][0]:,}/{r['n_B'][1]:,})  "
            f"B−A {d[0] * 100:+.{nd}f}pp [{d[1] * 100:+.{nd}f},{d[2] * 100:+.{nd}f}]")


def main():
    D = P.load(); G = Agg(D); X, names = D['X'], D['names']
    col = lambda n: X[:, names.index(n)]
    y = D['y'] == 1; lu = D['lu_s'] == 1; fr = ~lu; otc = D['otc'] == 1
    ow = col('x_oneword_s') == 1; locked = D['locked1'] == 1; buy = D['buy_lu'] == 1
    allr = np.ones(len(y), bool)
    L = []; J = {}

    def add(key, r, nd=1):
        J[key] = r; L.append(f'  {key:<46} ' + fmt(r, nd))

    L.append('== 1 組成：延續／一字鎖／隔日開盤即鎖 ==')
    add('正例中延續（s 已漲停）佔比', G.ratio(y & lu, y))
    add('延續正例中 s 日一字鎖佔比', G.ratio(y & lu & ow, y & lu))
    add('全部 s 日漲停中一字鎖佔比', G.ratio(lu & ow, lu))
    add('正例中隔日開盤即鎖（買不到）佔比', G.ratio(y & locked, y))
    add('新起漲正例中隔日開盤即鎖佔比', G.ratio(y & fr & locked, y & fr))
    add('延續正例中隔日開盤即鎖佔比', G.ratio(y & lu & locked, y & lu))
    add('全部列 s 日已漲停佔比（漲停供給）', G.ratio(lu, allr), 2)

    L.append('\n== 2 市場別 ==')
    add('正例中上櫃佔比', G.ratio(y & otc, y)); add('全部列中上櫃佔比', G.ratio(otc, allr))
    add('上市 隔日漲停率（全部）', G.ratio(y & ~otc, ~otc), 2); add('上櫃 隔日漲停率（全部）', G.ratio(y & otc, otc), 2)
    add('上市 新起漲率', G.ratio(y & ~otc & fr, ~otc & fr), 2); add('上櫃 新起漲率', G.ratio(y & otc & fr, otc & fr), 2)
    add('上市 延續率', G.ratio(y & ~otc & lu, ~otc & lu)); add('上櫃 延續率', G.ratio(y & otc & lu, otc & lu))

    L.append('\n== 3 價位帶（s 日收盤） ==')
    price = col('x_price')
    for lo, hi in zip(PRICE_BANDS[:-1], PRICE_BANDS[1:]):
        b = (price >= lo) & (price < hi); tag = f'{lo:g}-{hi:g}' if hi < 1e9 else f'≥{lo:g}'
        add(f'價 {tag}：正例佔比', G.ratio(y & b, y)); add(f'價 {tag}：全部列佔比', G.ratio(b, allr))
        add(f'價 {tag}：新起漲率', G.ratio(y & b & fr, b & fr), 2); add(f'價 {tag}：延續率', G.ratio(y & b & lu, b & lu))

    L.append('\n== 4 當沖比有值比例 ==')
    dt = np.isfinite(col('f_dt_ratio'))
    add('正例 f_dt_ratio 有值', G.ratio(y & dt, y)); add('負例 f_dt_ratio 有值', G.ratio(~y & dt, ~y))
    add('有當沖比者 新起漲率', G.ratio(y & dt & fr, dt & fr), 2); add('無當沖比者 新起漲率', G.ratio(y & ~dt & fr, ~dt & fr), 2)

    L.append('\n== 5 產業（peerComps 目前快照；歸屬非逐日） ==')
    ind = P.industry_of_codes(D['codes'])[D['j']]
    rows = []
    for nm in np.unique(ind):
        b = ind == nm
        if (y & b).sum() < 40: continue
        rs = G.ratio(y & b, y); rr = G.ratio(y & b, b); rf = G.ratio(y & b & fr, b & fr)
        rows.append((nm, rs, rr, rf, G.ratio(b, allr)))
    rows.sort(key=lambda t: -(t[1]['B'][0] - t[1]['A'][0]))
    L.append(f"  {'產業':<10} 正例佔比 A→B（B−A 區間）｜列佔比 A→B｜漲停率 A→B（倍數）｜新起漲率 A→B（倍數）")
    for nm, rs, rr, rf, ru in rows:
        L.append(f"  {nm:<10} {rs['A'][0] * 100:5.1f}%→{rs['B'][0] * 100:5.1f}% [{rs['diff'][1] * 100:+.1f},{rs['diff'][2] * 100:+.1f}]"
                 f" ｜{ru['A'][0] * 100:4.1f}%→{ru['B'][0] * 100:4.1f}%"
                 f" ｜{rr['A'][0] * 100:.2f}%→{rr['B'][0] * 100:.2f}% (×{rr['B'][0] / max(rr['A'][0], 1e-9):.2f})"
                 f" ｜{rf['A'][0] * 100:.2f}%→{rf['B'][0] * 100:.2f}% (×{rf['B'][0] / max(rf['A'][0], 1e-9):.2f}; n正={rf['n_A'][0]}/{rf['n_B'][0]})")
        J[f'ind_{nm}'] = dict(share=rs, rate=rr, fresh_rate=rf, rows_share=ru)
    tot_tv = sum(abs(r[1]['B'][0] - r[1]['A'][0]) for r in rows) / 2
    L.append(f'  正例產業分布的總變異距離（TV）≈ {tot_tv * 100:.1f}%（只計正例 ≥40 的產業）')

    L.append('\n== 6 大盤環境（s 日；以 A 的日分布切五分位） ==')
    regime_block(D, G, col, y, fr, lu, L, J)

    L.append(f'\n== 7 熱日（同一 s+1 日資料集內漲停 ≥{HOT} 檔） ==')
    cnt = np.bincount(G.rd, weights=y.astype(float), minlength=G.nD)
    hot_day = cnt >= HOT; hot_row = hot_day[G.rd]
    for e in ('A', 'B'):
        m = G.M[e]
        L.append(f'  {e}: 交易日 {int(m.sum())}、熱日 {int(hot_day[m].sum())}（{hot_day[m].mean() * 100:.1f}%）；每日漲停 平均 {cnt[m].mean():.1f}、'
                 f'中位數 {np.median(cnt[m]):.0f}、P90 {np.percentile(cnt[m], 90):.0f}、最大 {cnt[m].max():.0f}')
    add('正例落在熱日比例', G.ratio(y & hot_row, y)); add('新起漲正例落在熱日比例', G.ratio(y & fr & hot_row, y & fr))
    add('延續正例落在熱日比例', G.ratio(y & lu & hot_row, y & lu))
    add('非熱日 新起漲率', G.ratio(y & fr & ~hot_row, fr & ~hot_row), 2); add('非熱日 延續率', G.ratio(y & lu & ~hot_row, lu & ~hot_row))
    add('熱日 新起漲率', G.ratio(y & fr & hot_row, fr & hot_row), 2); add('熱日 延續率', G.ratio(y & lu & hot_row, lu & hot_row))
    txt = '\n'.join(L); print(txt)
    open(f'{P.OUT}/a32_profile_composition.log', 'w').write(txt + '\n')
    json.dump(J, open(f'{P.OUT}/a32_profile_composition.json', 'w'), ensure_ascii=False, default=lambda o: o.tolist() if hasattr(o, 'tolist') else str(o), indent=1)


def regime_block(D, G, col, y, fr, lu, L, J):
    for nm in ('f_mkt_r20', 'f_mkt_breadth_ma20', 'f_mkt_lu_cnt5', 'f_mkt_r5', 'f_mkt_near_hi'):
        v = np.full(G.nD, np.nan); v[G.rd] = col(nm)
        cuts = np.nanquantile(v[G.eA], [0.2, 0.4, 0.6, 0.8])
        q = np.searchsorted(cuts, v, side='right'); q[~np.isfinite(v)] = -1
        qr = q[G.rd]
        L.append(f'  -- {nm}（A 五分位切點 {", ".join(f"{c:.4g}" for c in cuts)}）--')
        for e in ('A', 'B'):
            m = G.M[e]
            L.append(f'     {e} 日數分布 Q1..Q5：' + ' '.join(f'{(q[m] == k).mean() * 100:4.1f}%' for k in range(5)))
        for lab, grp in (('新起漲率', fr), ('延續率', lu)):
            parts = []
            for k in range(5):
                r = G.ratio(y & grp & (qr == k), grp & (qr == k))
                parts.append(f"Q{k + 1} {r['A'][0] * 100:.2f}→{r['B'][0] * 100:.2f}")
            L.append(f'     {lab} A→B：' + '  '.join(parts))
        # 環境標準化：2026 若套用 A 的分五分位漲停率，預期幾檔？
        for lab, grp in (('新起漲', fr), ('延續', lu)):
            pos_dk = np.stack([G.d(y & grp & (qr == k)) for k in range(5)])        # 5×nD
            den_dk = np.stack([G.d(grp & (qr == k)) for k in range(5)])
            mA, mB = G.M['A'], G.M['B']
            rateA = pos_dk[:, mA].sum(1) / np.maximum(den_dk[:, mA].sum(1), 1)
            exp_B = (den_dk[:, mB].sum(1) * rateA).sum(); act_B = pos_dk[:, mB].sum()
            rA_bs = (G.W['A'] @ pos_dk.T) / np.maximum(G.W['A'] @ den_dk.T, 1e-9)          # B×5
            exp_bs = ((G.W['B'] @ den_dk.T) * rA_bs).sum(1); act_bs = (G.W['B'] @ pos_dk.T).sum(1)
            ratio_bs = act_bs / exp_bs
            base_A = pos_dk[:, mA].sum() / den_dk[:, mA].sum(); base_B = act_B / den_dk[:, mB].sum()
            exp_rate = exp_B / den_dk[:, mB].sum()
            lo, hi = np.nanpercentile(ratio_bs, [2.5, 97.5])
            L.append(f'     {lab}：A 率 {base_A * 100:.2f}% → 2026 實際 {base_B * 100:.2f}%；套 A 分環境率的 2026 預期 {exp_rate * 100:.2f}%'
                     f'（環境可解釋 {(exp_rate - base_A) / max(base_B - base_A, 1e-9) * 100:.0f}% 的升幅）；實際/預期 {act_B / exp_B:.2f} [{lo:.2f},{hi:.2f}]')
            J[f'regime_{nm}_{lab}'] = dict(base_A=base_A, base_B=base_B, expected_B=exp_rate, ratio=act_B / exp_B, ratio_ci=[lo, hi])


if __name__ == '__main__':
    main()
