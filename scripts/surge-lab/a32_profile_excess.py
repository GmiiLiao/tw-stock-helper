"""a32_profile 步驟 2b：2026 多出來的漲停從哪裡來？＋「同樣熱度下，2026 是否不同」。

  (a) 事前熱度分層：以 s 日「全市場漲停檔數」f_mkt_lu_cnt（s 收盤即知）細分層（A 很少出現 60 檔以上的日子，
      五分位不夠細），各層新起漲率／延續率 A vs B；並以這些層把 2026 標準化（套 A 的分層率）→ 解釋了多少升幅
  (b) 超額分解：2026 超額漲停＝Σ_segment rows_B × (rate_B − rate_A)，依產業、價位帶、市場別分攤
      （段內 rate 的差＝該段在 2026 變得多會漲停；乘上 2026 列數＝該段貢獻的超額檔數）
  (c) 價位帶 × 產業交叉：高價（≥300）電子／半導體 vs 其他
95% 區間：5 日區塊 bootstrap。
輸出：out/a32_profile_excess.log
"""
import numpy as np
import a32_profile_common as P

LU_BINS = (0, 10, 20, 30, 45, 60, 90, 1e9)
PRICE_BANDS = (0, 10, 20, 50, 100, 300, 1e9)
TECH = ('半導體業', '電子零組件業', '光電業', '電腦及週邊設備業', '其他電子業', '通信網路業', '電子通路業', '資訊服務業', '數位雲端', '電子工業')


def main():
    D = P.load(); X, names = D['X'], D['names']
    col = lambda n: X[:, names.index(n)]
    rd, dd = P.day_index(D); nD = len(dd)
    eB = dd >= P.ERA_B_START; eA = ~eB
    WA = P.block_weights(dd, eA, seed=41); WB = P.block_weights(dd, eB, seed=42)
    dsum = lambda m: np.bincount(rd, weights=m.astype(np.float64), minlength=nD)
    y = D['y'] == 1; lu = D['lu_s'] == 1; fr = ~lu; buy = D['buy_lu'] == 1
    L = []

    # (a) 事前熱度細分層
    L.append('== (a) s 日全市場漲停檔數（f_mkt_lu_cnt，事前可知）細分層 ==')
    v = col('f_mkt_lu_cnt')
    vb = np.searchsorted(np.array(LU_BINS[1:-1]), v, side='right')
    for lab, grp in (('新起漲', fr), ('延續', lu)):
        L.append(f'  -- {lab}：層｜A 日數 / 率 [95%]｜B 日數 / 率 [95%]｜可買率 A→B --')
        pos_k, den_k, buy_k = [], [], []
        for k in range(len(LU_BINS) - 1):
            m = vb == k
            pn, dn, bn = dsum(y & grp & m), dsum(grp & m), dsum(buy & grp & m)
            pos_k.append(pn); den_k.append(dn); buy_k.append(bn)
            dayk = np.zeros(nD, bool); dayk[rd[m]] = True
            parts = []
            for em, base, W in (('A', eA, WA), ('B', eB, WB)):
                if dn[base].sum() < 30: parts.append(f'{em} 日 {int(dayk[base].sum()):>3} / —'); continue
                pt, lo, hi, _ = P.ratio_ci(pn, dn, W, base)
                parts.append(f'{em} 日 {int(dayk[base].sum()):>3} / {pt * 100:5.2f}% [{lo * 100:5.2f},{hi * 100:5.2f}] (k={int(pn[base].sum())})')
            ba = bn[eA].sum() / max(dn[eA].sum(), 1); bb = bn[eB].sum() / max(dn[eB].sum(), 1)
            hi_ = LU_BINS[k + 1]
            L.append(f'    {LU_BINS[k]:>3g}-{hi_:<4g}' if hi_ < 1e9 else f'    ≥{LU_BINS[k]:<7g}')
            L[-1] += '｜' + '｜'.join(parts) + f'｜可買 {ba * 100:.2f}%→{bb * 100:.2f}%'
        pos_k, den_k = np.stack(pos_k), np.stack(den_k)
        rateA = pos_k[:, eA].sum(1) / np.maximum(den_k[:, eA].sum(1), 1)
        # A 沒有樣本的層（不太可能）以 A 最熱層的率代替
        exp_rate = (den_k[:, eB].sum(1) * rateA).sum() / den_k[:, eB].sum()
        bA = pos_k[:, eA].sum() / den_k[:, eA].sum(); bB = pos_k[:, eB].sum() / den_k[:, eB].sum()
        rA_bs = (WA @ pos_k.T) / np.maximum(WA @ den_k.T, 1e-9)
        exp_bs = ((WB @ den_k.T) * rA_bs).sum(1) / (WB @ den_k.T).sum(1); act_bs = (WB @ pos_k.T).sum(1) / (WB @ den_k.T).sum(1)
        expl_bs = (exp_bs - bA) / (act_bs - bA)
        lo, hi = np.nanpercentile(expl_bs, [2.5, 97.5])
        L.append(f'    標準化：A {bA * 100:.2f}% → 2026 實際 {bB * 100:.2f}%；套 A 分層率的 2026 預期 {exp_rate * 100:.2f}% → 熱度分層可解釋升幅 '
                 f'{(exp_rate - bA) / (bB - bA) * 100:.0f}% [{lo * 100:.0f},{hi * 100:.0f}]')

    # (b) 超額分解
    L.append('\n== (b) 2026 超額漲停分解：Σ rows_B ×（rate_B − rate_A） ==')
    ind = P.industry_of_codes(D['codes'])[D['j']]
    price = col('x_price')
    pb = np.searchsorted(np.array(PRICE_BANDS[1:-1]), price, side='right')
    pb_lab = [f'{PRICE_BANDS[k]:g}-{PRICE_BANDS[k + 1]:g}' if PRICE_BANDS[k + 1] < 1e9 else f'≥{PRICE_BANDS[k]:g}' for k in range(len(PRICE_BANDS) - 1)]
    otc = D['otc'] == 1
    segs = {'產業': [(nm, ind == nm) for nm in np.unique(ind)],
            '價位帶': [(pb_lab[k], pb == k) for k in range(len(pb_lab))],
            '市場': [('上市', ~otc), ('上櫃', otc)],
            '價位×電子': [('≥300 電子類', (price >= 300) & np.isin(ind, TECH)), ('≥300 非電子', (price >= 300) & ~np.isin(ind, TECH)),
                         ('100-300 電子類', (price >= 100) & (price < 300) & np.isin(ind, TECH)), ('<100 電子類', (price < 100) & np.isin(ind, TECH)),
                         ('<300 非電子', (price < 300) & ~np.isin(ind, TECH))]}
    era = D['era']
    for lab, grp in (('全部', np.ones(len(y), bool)), ('新起漲', fr), ('延續', lu)):
        rowsB = grp & (era == 1); rowsA = grp & (era == 0)
        tot_exc = y[rowsB].sum() - rowsB.sum() * y[rowsA].mean()
        L.append(f'  -- {lab}：2026 實際 {int(y[rowsB].sum()):,} 檔次；若維持 A 整體率應為 {rowsB.sum() * y[rowsA].mean():,.0f} → 超額 {tot_exc:,.0f} --')
        for sk, items in segs.items():
            rows = []
            for nm, m in items:
                nA, nB = (rowsA & m).sum(), (rowsB & m).sum()
                if nA < 500 or nB < 200: continue
                rA, rB = y[rowsA & m].mean(), y[rowsB & m].mean()
                exc = nB * (rB - rA)
                rows.append((exc, nm, rA, rB, nB, int(y[rowsB & m].sum())))
            rows.sort(reverse=True)
            sum_exc = sum(r[0] for r in rows)
            mix = tot_exc - sum_exc
            L.append(f'    [{sk}] 段內率變化合計 {sum_exc:,.0f}（{sum_exc / tot_exc * 100:.0f}%）；組成移動（2026 列數分布改變）{mix:,.0f}')
            for exc, nm, rA, rB, nB, kB in rows[:8]:
                L.append(f'      {nm:<12} 率 {rA * 100:5.2f}%→{rB * 100:5.2f}%  2026 列 {nB:>7,} 漲停 {kB:>5,}  超額 {exc:7,.0f}（{exc / tot_exc * 100:5.1f}%）')
    txt = '\n'.join(L); print(txt)
    open(f'{P.OUT}/a32_profile_excess.log', 'w').write(txt + '\n')


if __name__ == '__main__':
    main()
