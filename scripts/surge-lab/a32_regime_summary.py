"""a32_regime 步驟 4：重點表（含兩個種子）與成對比較（日區塊 bootstrap）。

前一步發現：同設定只換種子，每日第 1 名有一半的日子選到不同股票、top1 精確度可差 5～7 個百分點；
所以這裡的模型比較一律用「兩種子平均」的每日命中率做成對差，並同時列出各種子的數字。
輸出：out/a32_regime_summary.log、out/a32_regime_summary.csv
"""
import os
import sys
import numpy as np
import pandas as pd
import a32_regime_common as C

ROWS = []
SEEDS = ('', '_s1')


def scores(tag):
    out = []
    for sfx in SEEDS:
        f = os.path.join(C.SP, f'a32_regime_score_{tag}{sfx}.npz')
        if os.path.exists(f): out.append((sfx or '_s0', np.load(f)['score']))
    return out


def per_day(D, sc, rows, k, fresh):
    """回傳以 s 為索引的 DataFrame：每日 top-k 的命中數、可買命中數、選股數。"""
    r = rows & (D['lu_s'] == 0) if fresh else rows
    m = C.topk_mask(sc, D['s'], k, r)
    df = pd.DataFrame(dict(s=D['s'][m], y=D['y'][m].astype(float), b=D['buy_lu'][m].astype(float), n=1.0))
    return df.groupby('s').sum()


def line(D, tag, rows, label, k, fresh):
    sc = scores(tag)
    if not sc: return None
    per = []; txt = []
    for sfx, s_ in sc:
        pdf = per_day(D, s_, rows, k, fresh); per.append(pdf)
        n = pdf.n.sum(); p = pdf.y.sum() / n; pb = pdf.b.sum() / n
        lo, hi = C.wilson(int(pdf.y.sum()), int(n))
        txt.append(f'{sfx[1:]} {p * 100:4.1f}% [W {lo * 100:4.1f}–{hi * 100:4.1f}] 可買 {pb * 100:4.1f}%')
        ROWS.append(dict(model=tag, seed=sfx[1:], period=label, k=k, pool='fresh' if fresh else 'all', n=int(n), days=len(pdf),
                         prec=p, w_lo=lo, w_hi=hi, buy_prec=pb))
    avg = pd.concat(per).groupby(level=0).mean()
    pm = avg.y.sum() / avg.n.sum(); pbm = avg.b.sum() / avg.n.sum()
    print(f'  {tag:<7} {label:<22} top{k:<2} {"新起漲" if fresh else "全部  "} 日 {len(avg):>3} | ' + ' | '.join(txt) +
          f' | 種子平均 {pm * 100:4.1f}%（可買 {pbm * 100:4.1f}%）')
    return avg


def paired(a, b, la, lb, n_boot=4000, seed=0):
    """a、b：per-day 平均（相同日子）。差＝(a 命中率 − b 命中率)，以日為區塊重抽。"""
    j = a.index.intersection(b.index)
    ya, na, yb, nb = a.y[j].values, a.n[j].values, b.y[j].values, b.n[j].values
    d = ya.sum() / na.sum() - yb.sum() / nb.sum()
    rng = np.random.default_rng(seed); bs = []
    for _ in range(n_boot):
        ii = rng.integers(0, len(j), len(j))
        bs.append(ya[ii].sum() / na[ii].sum() - yb[ii].sum() / nb[ii].sum())
    lo, hi = np.percentile(bs, [2.5, 97.5])
    print(f'    成對差 {la} − {lb} = {d * 100:+.1f} 個百分點（日 bootstrap 95% {lo * 100:+.1f}～{hi * 100:+.1f}，{len(j)} 日）')
    ROWS.append(dict(model=f'{la}-{lb}', period='paired', prec=d, w_lo=lo, w_hi=hi, days=len(j)))


def unpaired(a, b, la, lb, n_boot=4000, seed=0):
    """不同日子的兩組：各自以日為區塊重抽，差的 95% 區間。"""
    rng = np.random.default_rng(seed)
    pa = a.y.sum() / a.n.sum(); pb = b.y.sum() / b.n.sum(); bs = []
    for _ in range(n_boot):
        ia = rng.integers(0, len(a), len(a)); ib = rng.integers(0, len(b), len(b))
        bs.append(a.y.values[ia].sum() / a.n.values[ia].sum() - b.y.values[ib].sum() / b.n.values[ib].sum())
    lo, hi = np.percentile(bs, [2.5, 97.5])
    print(f'    差 {la} − {lb} = {(pa - pb) * 100:+.1f} 個百分點（各自日 bootstrap 95% {lo * 100:+.1f}～{hi * 100:+.1f}；{len(a)} vs {len(b)} 日）')
    ROWS.append(dict(model=f'{la}-{lb}', period='unpaired', prec=pa - pb, w_lo=lo, w_hi=hi, days=len(a) + len(b)))


def main():
    D = C.load(with_x=False); sd = D['sd']
    g = C.day_table(D)
    P = dict(feb=(sd >= '2026-02-01'), h1=(sd >= '2026-02-01') & (sd < '2026-07-01'), q3=(sd >= '2026-07-01') & (sd < '2026-10-01'),
             y26=(sd >= '2026-01-01'), h2=(sd >= '2025-07-01') & (sd <= '2025-12-31'))
    m25 = g[g.year == 2025].groupby('ym').apply(lambda h: h.lu_next.sum() / h.n.sum(), include_groups=False)
    cool_m = list(m25[m25 < m25.median()].index)
    ym = pd.Series(sd).str[:7].values
    P['c25'] = np.isin(ym, cool_m)
    for nm, r in P.items():
        print(f'{nm}: 日 {len(np.unique(D["s"][r]))}、基準率 {D["y"][r].mean() * 100:.2f}%、新起漲列基準率 {D["y"][r & (D["lu_s"] == 0)].mean() * 100:.2f}%')

    print('\n=== A. 2026-02～10：固定（≤2025）vs 逐月滾動（只用 2026）===')
    for k in (1, 10):
        for fresh in (False, True):
            a = line(D, 'FIX25', P['feb'], '2026-02～10', k, fresh); b = line(D, 'ROLL26', P['feb'], '2026-02～10', k, fresh)
            if a is not None and b is not None: paired(a, b, 'FIX25', 'ROLL26')

    print('\n=== B. 2026 上半（2～6 月，基準率高）vs 第三季（7～9 月，降溫）===')
    for tag in ('FIX25', 'ROLL26'):
        for k in (1, 10):
            for fresh in (False, True):
                a = line(D, tag, P['h1'], '2026-02～06', k, fresh); b = line(D, tag, P['q3'], '2026-07～09', k, fresh)
                if a is not None and b is not None: unpaired(a, b, f'{tag}@H1', f'{tag}@Q3')

    print('\n=== C. 2025H2（2026 模型從未見過、熱度像 2025）：2026 訓練 vs 歷史訓練 ===')
    av = {}
    for k in (1, 10):
        for fresh in (False, True):
            for tag in ('M26', 'D25H1', 'D24', 'W9_25'):
                av[(tag, k, fresh)] = line(D, tag, P['h2'], '2025H2', k, fresh)
            for other in ('D25H1', 'D24', 'W9_25'):
                if av[('M26', k, fresh)] is not None and av[(other, k, fresh)] is not None:
                    paired(av[('M26', k, fresh)], av[(other, k, fresh)], 'M26', other)

    print('\n=== D. 2025 冷月（' + ','.join(cool_m) + '）：2026 訓練 vs ≤2024 訓練 ===')
    for k in (1, 10):
        for fresh in (False, True):
            a = line(D, 'M26', P['c25'], '2025 冷月', k, fresh); b = line(D, 'D24', P['c25'], '2025 冷月', k, fresh)
            if a is not None and b is not None: paired(a, b, 'M26', 'D24')

    print('\n=== E. 同一個 2026 模型：2026 樣本內（參考，不可當成績）vs 2025H2 ===')
    print('  （M26 在 2026 是樣本內，無法當成績；改用 FIX25@2026 與 M26@2025H2 對照「熱市成績→冷市成績」的落差）')
    for k in (1, 10):
        for fresh in (False, True):
            line(D, 'FIX25', P['y26'], '2026 全年', k, fresh)
            line(D, 'M26', P['h2'], '2025H2', k, fresh)

    print('\n=== I. 同一個模型（D25H1：≤2025-06 訓練）在 2025H2（較冷）與 2026（熱）都是樣本外：熱度只抬高「買不到」的部分？===')
    for k in (1, 10):
        for fresh in (False, True):
            a = line(D, 'D25H1', P['h2'], '2025H2', k, fresh); b = line(D, 'D25H1', P['y26'], '2026', k, fresh)
    for k in (1, 10):
        a = line(D, 'D25H1', P['h2'], '2025H2', k, False); b = line(D, 'D25H1', P['y26'], '2026', k, False)
        for nm, col in (('精確', 'y'), ('可買', 'b')):
            rng = np.random.default_rng(0); bs = []
            for _ in range(4000):
                ia = rng.integers(0, len(a), len(a)); ib = rng.integers(0, len(b), len(b))
                bs.append(b[col].values[ib].sum() / b.n.values[ib].sum() - a[col].values[ia].sum() / a.n.values[ia].sum())
            d = b[col].sum() / b.n.sum() - a[col].sum() / a.n.sum()
            print(f'    top{k} {nm}：2026 − 2025H2 = {d * 100:+.1f} 個百分點（日 bootstrap 95% {np.percentile(bs, 2.5) * 100:+.1f}～{np.percentile(bs, 97.5) * 100:+.1f}）')

    print('\n=== G. 2026-02～10 冷熱分組（兩種子）：ex-post＝s+1 當日漲停檔數；ex-ante＝s 日漲停檔數 ===')
    T = len(D['dates']); post = np.full(T, np.nan); pre = np.full(T, np.nan)
    post[g.s] = g.lu_next; pre[g.s] = g.lu_s
    buckets = ((0, 15), (15, 30), (30, 50), (50, 80), (80, 10 ** 6))
    for heat_nm, heat in (('ex-post', post), ('ex-ante', pre)):
        for lo, hi in buckets:
            dm = ((heat >= lo) & (heat < hi))[D['s']] & P['feb']
            lab = f'{heat_nm} {lo}–{hi if hi < 10 ** 6 else "∞"} 檔'
            for tag in ('FIX25', 'ROLL26'):
                for k in (1, 10):
                    line(D, tag, dm, lab, k, False)
                line(D, tag, dm, lab, 1, True)

    print('\n=== H. 命中集中度（各種子）：最熱 10% 日（ex-post）貢獻的命中占比 ===')
    for tag, rows in (('FIX25', P['y26']), ('ROLL26', P['feb'])):
        days = np.unique(D['s'][rows]); hd = post[days]; hot = hd >= np.quantile(hd, 0.9)
        for sfx, s_ in scores(tag):
            for k in (1, 10):
                pdf = per_day(D, s_, rows, k, False).reindex(days).fillna(0)
                hh = pdf.y.values; nn = pdf.n.values
                print(f'  {tag}{sfx} top{k}: 最熱 10% 日（{int(hot.sum())} 日）命中占 {hh[hot].sum() / hh.sum() * 100:.1f}%；'
                      f'精確 最熱 {hh[hot].sum() / nn[hot].sum() * 100:.1f}% vs 其餘 {hh[~hot].sum() / nn[~hot].sum() * 100:.1f}%；'
                      f'冷日（<{C.COOL_LU}）{int((hd < C.COOL_LU).sum())} 日 精確 {hh[hd < C.COOL_LU].sum() / max(nn[hd < C.COOL_LU].sum(), 1) * 100:.1f}%')

    print('\n=== F. M26 逐季（2023–2025）top10 精確度 vs 該季基準率 ===')
    sc = scores('M26')
    if sc:
        qs = sorted(g[g.year < 2026].q.unique()); xb, yp, yp1 = [], [], []
        for q in qs:
            r = np.isin(D['s'], g[g.q == q].s.values) & (sd < '2026-01-01')
            xb.append(D['y'][r].mean())
            yp.append(np.mean([D['y'][C.topk_mask(s_, D['s'], 10, r)].mean() for _, s_ in sc]))
            yp1.append(np.mean([D['y'][C.topk_mask(s_, D['s'], 1, r)].mean() for _, s_ in sc]))
        xb, yp, yp1 = map(np.array, (xb, yp, yp1))
        b10 = np.polyfit(xb, yp, 1); b1 = np.polyfit(xb, yp1, 1)
        print(f'  12 季：corr(基準率, top10 精確)={np.corrcoef(xb, yp)[0, 1]:.2f}；top10 ≈ {b10[1] * 100:.1f}% + {b10[0]:.1f}×基準率；'
              f'corr(基準率, top1 精確)={np.corrcoef(xb, yp1)[0, 1]:.2f}')
        for b in (0.009, 0.0128, 0.0139, 0.0175):
            print(f'    基準率 {b * 100:.2f}% → 線性內插 top10 {np.polyval(b10, b) * 100:.1f}%、top1 {np.polyval(b1, b) * 100:.1f}%')
        print('    （2026 基準率 2.78% 超出 2023–25 範圍，不外插；實際樣本外 FIX25@2026 見 A／E 段）')

    pd.DataFrame(ROWS).to_csv(os.path.join(C.OUT, 'a32_regime_summary.csv'), index=False)


if __name__ == '__main__':
    log = open(os.path.join(C.OUT, 'a32_regime_summary.log'), 'w')

    class Tee:
        def write(self, x): sys.__stdout__.write(x); log.write(x)
        def flush(self): sys.__stdout__.flush(); log.flush()
    sys.stdout = Tee()
    main()
