"""a32_regime 步驟 3：評估（讀 a32_regime_fit 的分數）。

選股＝每日依分數取前 k 名（k＝1、3、10）；「只限新起漲」＝在 m_lu_s==0 的列內另外排名取前 k。
每個數字旁附：Wilson 95%、日區塊 bootstrap 95%（2000 次）、可買精確度（m_buy_lu：s+1 漲停且開盤 < 漲停價）。
熱度分組有兩種：ex-post（s+1 當日漲停檔數，結果定義，只能描述）與 ex-ante（s 日漲停檔數／站上 MA20 比例，決策時已知）。
輸出：out/a32_regime_eval.log、out/a32_regime_eval.csv
"""
import os
import sys
import numpy as np
import pandas as pd
import a32_regime_common as C

ROWS = []


def load_score(tag):
    f = os.path.join(C.SP, f'a32_regime_score_{tag}.npz')
    if not os.path.exists(f): print(f'（缺 {tag}）'); return None
    return np.load(f)['score']


class Ctx:
    def __init__(self):
        self.D = C.load(with_x=False)
        g = C.day_table(self.D)
        T = len(self.D['dates'])
        self.g = g
        self.post = np.full(T, np.nan); self.post[g.s] = g.lu_next
        self.pre = np.full(T, np.nan); self.pre[g.s] = g.lu_s
        self.breadth = np.full(T, np.nan); self.breadth[g.s] = g.f_mkt_breadth_ma20
        self.wk = np.full(T, '', object); self.wk[g.s] = g.wk
        self.ym = np.full(T, '', object); self.ym[g.s] = g.ym
        self.fresh = self.D['lu_s'] == 0


def rec(r, **kw):
    r = {**r, **kw}; ROWS.append(r); print('  ' + C.fmt(r)); return r


def block(X, sc, rows, title, ks=(1, 3, 10), fresh=True, boot=True):
    D = X.D; s = D['s']
    print(f'-- {title}（交易日 {len(np.unique(s[rows]))}）')
    out = {}
    for k in ks:
        m = C.topk_mask(sc, s, k, rows)
        out[k] = rec(C.summarize(m, D, f'top{k}/日 全部', boot), section=title, k=k, pool='all')
    if fresh:
        for k in ks:
            m = C.topk_mask(sc, s, k, rows & X.fresh)
            out[f'f{k}'] = rec(C.summarize(m, D, f'top{k}/日 只限新起漲', boot), section=title, k=k, pool='fresh')
    return out


def by_groups(X, sc, rows, groups, title, ks=(1, 10)):
    """groups：list of (名稱, 依 s 索引的布林陣列)。在 rows 全期排名後（每日排名與分組無關）再依日分組。"""
    D = X.D; s = D['s']
    print(f'-- {title}')
    masks = {k: C.topk_mask(sc, s, k, rows) for k in ks}
    fmask = C.topk_mask(sc, s, 1, rows & X.fresh)
    for nm, dm in groups:
        sel_day = dm[s]
        nd = len(np.unique(s[rows & sel_day]))
        base = D['y'][rows & sel_day].mean() if nd else np.nan
        print(f' [{nm}] 日 {nd}、母體基準率 {base * 100:.2f}%')
        for k in ks:
            rec(C.summarize(masks[k] & sel_day, D, f'{nm} top{k}/日'), section=title, group=nm, k=k, pool='all', base=base)
        rec(C.summarize(fmask & sel_day, D, f'{nm} top1/日 新起漲'), section=title, group=nm, k=1, pool='fresh', base=base)


def concentration(X, sc, rows, title):
    """前 1 名命中有多少來自最熱 10% 的日；拿掉最熱 10% 後精確度；冷日精確度。"""
    D = X.D; s = D['s']; y = D['y']
    m1 = C.topk_mask(sc, s, 1, rows); m10 = C.topk_mask(sc, s, 10, rows)
    days = np.unique(s[rows])
    print(f'-- {title}：命中集中度（交易日 {len(days)}）')
    rng = np.random.default_rng(0)
    for heat_nm, heat in (('ex-post s+1 漲停數', X.post), ('ex-ante s 日漲停數', X.pre)):
        hd = heat[days]; cut = np.quantile(hd, 0.9); hot = hd >= cut
        for k, m in ((1, m1), (10, m10)):
            hits = np.bincount(np.searchsorted(days, s[m]), y[m].astype(float), len(days))
            picks = np.bincount(np.searchsorted(days, s[m]), minlength=len(days)).astype(float)
            share = hits[hot].sum() / hits.sum()
            lu_share = X.post[days][hot].sum() / X.post[days].sum()
            bs = []
            for _ in range(2000):
                ii = rng.integers(0, len(days), len(days)); h = hits[ii]
                bs.append(h[hot[ii]].sum() / max(h.sum(), 1))
            lo, hi = np.percentile(bs, [2.5, 97.5])
            p_hot = hits[hot].sum() / picks[hot].sum(); p_rest = hits[~hot].sum() / picks[~hot].sum()
            print(f'  [{heat_nm}] 最熱 10% 日（≥{cut:.0f} 檔，{int(hot.sum())} 日）：top{k}/日 命中 {int(hits[hot].sum())}/{int(hits.sum())} '
                  f'＝ {share * 100:.1f}%（日boot {lo * 100:.1f}–{hi * 100:.1f}）；這些日占全部漲停 {lu_share * 100:.1f}%；'
                  f'精確度 最熱10% {p_hot * 100:.1f}% vs 其餘 {p_rest * 100:.1f}%')
            ROWS.append(dict(section=title, label=f'concentration {heat_nm} top{k}', share_hot=share, share_lo=lo, share_hi=hi,
                             prec_hot=p_hot, prec_rest=p_rest, lu_share=lu_share, cut=cut))
    for heat_nm, heat in (('ex-post s+1', X.post), ('ex-ante s 日', X.pre)):
        cool = heat < C.COOL_LU
        rec(C.summarize(m1 & cool[s], D, f'{heat_nm} 漲停<{C.COOL_LU} 檔日 top1'), section=title, group=f'cool_{heat_nm}', k=1, pool='all')
        rec(C.summarize(m10 & cool[s], D, f'{heat_nm} 漲停<{C.COOL_LU} 檔日 top10'), section=title, group=f'cool_{heat_nm}', k=10, pool='all')


def heat_buckets(X):
    b = [(0, 15), (15, 30), (30, 50), (50, 80), (80, 10 ** 6)]
    return [(f's+1 漲停 {lo}–{hi if hi < 10 ** 6 else "∞"}', lambda h, lo=lo, hi=hi: (h >= lo) & (h < hi)) for lo, hi in b]


def calib(X, sc, rows, title):
    """模型自認機率（校正負例抽樣：logit + ln 0.15）vs 實際命中：每日第 1 名。"""
    D = X.D; m1 = C.topk_mask(sc, D['s'], 1, rows)
    p = 1 / (1 + np.exp(-(sc[m1].astype(float) + np.log(C.NEG_FRAC))))
    print(f'  [{title}] 每日第 1 名：模型自認平均機率 {p.mean() * 100:.1f}%、實際 {D["y"][m1].mean() * 100:.1f}%（n={int(m1.sum())}）；'
          f'全部列模型平均機率 {np.nanmean(1 / (1 + np.exp(-(sc[rows].astype(float) + np.log(C.NEG_FRAC))))) * 100:.2f}% vs 基準率 {D["y"][rows].mean() * 100:.2f}%')


def main():
    X = Ctx(); D = X.D; sd = D['sd']; s = D['s']; g = X.g; T = len(D['dates'])
    S = {t: load_score(t) for t in ('FIX25', 'ROLL26', 'D25H1', 'W9_25', 'D24', 'M26')}
    y26 = sd >= '2026-01-01'; feb = sd >= '2026-02-01'

    print('\n==================== (1) 2026：固定模型（≤2025）vs 逐月滾動 2026 模型 ====================')
    if S['FIX25'] is not None:
        block(X, S['FIX25'], y26, 'FIX25 @2026 全年（1/2～10/1）')
        block(X, S['FIX25'], feb, 'FIX25 @2026-02～10')
    if S['ROLL26'] is not None:
        block(X, S['ROLL26'], feb, 'ROLL26 @2026-02～10')
    if S['D25H1'] is not None:
        block(X, S['D25H1'], y26, 'D25H1（≤2025-06）@2026 全年', ks=(1, 10), fresh=False)

    print('\n-- 逐月 top1／top10（FIX25 vs ROLL26）')
    for ym in sorted(set(X.ym[np.unique(s[feb])])):
        rows = feb & (X.ym[s] == ym)
        line = f'  {ym} 基準率 {D["y"][rows].mean() * 100:4.2f}%'
        for t in ('FIX25', 'ROLL26'):
            if S[t] is None: continue
            for k in (1, 10):
                r = C.summarize(C.topk_mask(S[t], s, k, rows), D, '', boot=False)
                line += f' | {t} top{k} {r["prec"] * 100:5.1f}%（可買 {r["buy_prec"] * 100:4.1f}%, n={r["n"]}）'
                ROWS.append(dict(r, section='monthly', group=ym, model=t, k=k, pool='all'))
        print(line)

    # 熱／冷分組
    post_groups = [(nm, f(X.post)) for nm, f in heat_buckets(X)]
    pre_groups = [(nm.replace('s+1', 's 日'), f(X.pre)) for nm, f in heat_buckets(X)]
    d26 = np.unique(s[feb])
    br = X.breadth[d26]; t1, t2 = np.quantile(br, [1 / 3, 2 / 3])
    br_groups = [('站上MA20 低 1/3', X.breadth < t1), ('站上MA20 中 1/3', (X.breadth >= t1) & (X.breadth < t2)), ('站上MA20 高 1/3', X.breadth >= t2)]
    # 週：依當週基準率（ex-post）四分位；以及「上週」基準率（ex-ante）
    wk26 = g[(g.date >= '2026-02-01')].groupby('wk').apply(lambda h: h.lu_next.sum() / h.n.sum(), include_groups=False)
    q1, q3 = np.quantile(wk26.values, [0.25, 0.75])
    wk_base = np.full(T, np.nan); wk_base_prev = np.full(T, np.nan)
    wall = g.groupby('wk').apply(lambda h: h.lu_next.sum() / h.n.sum(), include_groups=False)
    wkeys = list(wall.index); prevmap = {wkeys[i]: wall.iloc[i - 1] for i in range(1, len(wkeys))}
    for r in g.itertuples():
        wk_base[r.s] = wall[r.wk]; wk_base_prev[r.s] = prevmap.get(r.wk, np.nan)
    wk_groups = [(f'當週基準率 最冷 1/4（<{q1 * 100:.2f}%）', wk_base < q1), ('當週 中間 1/2', (wk_base >= q1) & (wk_base <= q3)),
                 (f'當週基準率 最熱 1/4（>{q3 * 100:.2f}%）', wk_base > q3)]
    pq1, pq3 = np.nanquantile(wk_base_prev[d26], [0.25, 0.75])
    wkp_groups = [(f'上週基準率 最冷 1/4（<{pq1 * 100:.2f}%）', wk_base_prev < pq1), ('上週 中間 1/2', (wk_base_prev >= pq1) & (wk_base_prev <= pq3)),
                  (f'上週基準率 最熱 1/4（>{pq3 * 100:.2f}%）', wk_base_prev > pq3)]
    for t in ('FIX25', 'ROLL26'):
        if S[t] is None: continue
        print(f'\n==================== (1b) {t} @2026-02～10：冷 vs 熱 ====================')
        by_groups(X, S[t], feb, post_groups, f'{t} 依 ex-post 當日（s+1）漲停檔數')
        by_groups(X, S[t], feb, pre_groups, f'{t} 依 ex-ante s 日漲停檔數')
        by_groups(X, S[t], feb, br_groups, f'{t} 依 ex-ante 站上 MA20 比例（2026 三分位 {t1 * 100:.1f}%／{t2 * 100:.1f}%）')
        by_groups(X, S[t], feb, wk_groups, f'{t} 依 ex-post 當週基準率')
        by_groups(X, S[t], feb, wkp_groups, f'{t} 依 ex-ante 上週基準率')

    print('\n==================== (2) 2026 命中集中度 ====================')
    for t, rows in (('FIX25', y26), ('ROLL26', feb)):
        if S[t] is not None: concentration(X, S[t], rows, f'{t}')

    print('\n==================== (3) 「只會更熱」檢驗：2026 訓練模型拿去打從未見過的較冷時期 ====================')
    h2 = (sd >= '2025-07-01') & (sd <= '2025-12-31')
    for t in ('M26', 'D25H1', 'W9_25', 'D24'):
        if S[t] is not None:
            block(X, S[t], h2, f'{t} @2025H2（基準率 {D["y"][h2].mean() * 100:.2f}%）')
    # 2025 冷月：2025 年基準率低於 2025 中位數的月份（排除 2025-04 衝擊月不影響，因其為熱月）
    m25 = g[g.year == 2025].groupby('ym').apply(lambda h: h.lu_next.sum() / h.n.sum(), include_groups=False)
    cool_m = list(m25[m25 < m25.median()].index); hot_m = list(m25[m25 >= m25.median()].index)
    print(f'\n2025 冷月（< 2025 月中位 {m25.median() * 100:.2f}%）：{cool_m}；熱月：{hot_m}')
    cm = np.isin(X.ym[s], cool_m) & (sd < '2026-01-01'); hm = np.isin(X.ym[s], hot_m) & (sd < '2026-01-01')
    for t in ('M26', 'D24'):
        if S[t] is None: continue
        block(X, S[t], cm, f'{t} @2025 冷月（基準率 {D["y"][cm].mean() * 100:.2f}%）', ks=(1, 10))
        block(X, S[t], hm, f'{t} @2025 熱月（基準率 {D["y"][hm].mean() * 100:.2f}%）', ks=(1, 10))
    if S['M26'] is not None:
        print('\n-- M26（只用 2026 訓練）逐季打 2023–2025（全部樣本外）')
        for q in sorted(g[g.year < 2026].q.unique()):
            rows = (sd < '2026-01-01') & np.isin(s, g[g.q == q].s.values)
            r1 = C.summarize(C.topk_mask(S['M26'], s, 1, rows), D, '', boot=False)
            r10 = C.summarize(C.topk_mask(S['M26'], s, 10, rows), D, '', boot=False)
            rf = C.summarize(C.topk_mask(S['M26'], s, 1, rows & X.fresh), D, '', boot=False)
            print(f'  {q} 基準率 {D["y"][rows].mean() * 100:4.2f}% | top1 {r1["prec"] * 100:5.1f}% [W {r1["w_lo"] * 100:4.1f}–{r1["w_hi"] * 100:4.1f}] 可買 {r1["buy_prec"] * 100:4.1f}% '
                  f'| top10 {r10["prec"] * 100:5.1f}% 可買 {r10["buy_prec"] * 100:4.1f}% | 新起漲 top1 {rf["prec"] * 100:5.1f}% (n={rf["n"]})')
            for k, r in ((1, r1), (10, r10)): ROWS.append(dict(r, section='M26 quarterly', group=q, k=k, pool='all', base=D['y'][rows].mean()))
            ROWS.append(dict(rf, section='M26 quarterly', group=q, k=1, pool='fresh'))

    print('\n==================== (3b) 精確度 vs 當日熱度（全部樣本外打分合併）====================')
    pooled = []
    if S['FIX25'] is not None: pooled.append(('FIX25@2026', S['FIX25'], y26))
    if S['M26'] is not None: pooled.append(('M26@2023–25', S['M26'], sd < '2026-01-01'))
    if S['D25H1'] is not None: pooled.append(('D25H1@2025H2', S['D25H1'], h2))
    for nm, sc, rows in pooled:
        by_groups(X, sc, rows, post_groups, f'{nm} 依 ex-post s+1 漲停檔數', ks=(1, 10))
    # 熱度標準化：2026 各熱度桶的 top1 精確度 × 2025 熱度分布
    if S['FIX25'] is not None:
        print('\n-- 熱度標準化：FIX25 在 2026 各熱度桶的 top1 精確度，以 2025H2／2025 全年／2023 的「日熱度分布」加權')
        m1 = C.topk_mask(S['FIX25'], s, 1, y26)
        pb = []
        for nm, f in heat_buckets(X):
            dm = f(X.post)[s] & m1
            pb.append(D['y'][dm].mean() if dm.sum() else np.nan)
        pb = np.array(pb)
        for lab, sel in (('2026 本身', g.year == 2026), ('2025H2', (g.date >= '2025-07-01') & (g.date <= '2025-12-31')),
                         ('2025 全年', g.year == 2025), ('2023 全年', g.year == 2023)):
            hd = g[sel].lu_next.values
            w = np.array([f(hd).mean() for _, f in heat_buckets(X)])
            ok = np.isfinite(pb)
            print(f'  {lab}: 熱度桶日占比 ' + '／'.join(f'{x * 100:.0f}%' for x in w) + f' → 加權 top1 精確度 {np.nansum(pb[ok] * w[ok]) / w[ok].sum() * 100:.1f}%')
        print('  （2026 各桶 top1 精確度：' + '／'.join(f'{x * 100:.0f}%' for x in pb) + '；冷桶樣本極少，見上方 n）')

    print('\n==================== 模型自認機率 vs 實際（每日第 1 名）====================')
    for nm, t, rows in (('FIX25@2026', 'FIX25', y26), ('ROLL26@2026-02～', 'ROLL26', feb), ('M26@2025H2', 'M26', h2),
                        ('M26@2025冷月', 'M26', cm), ('D25H1@2025H2', 'D25H1', h2)):
        if S[t] is not None: calib(X, S[t], rows, nm)

    print('\n==================== 2025 逐季：M26（2026 訓練）vs D24（≤2024 訓練），兩者皆樣本外 ====================')
    if S['M26'] is not None and S['D24'] is not None:
        for q in ('2025Q1', '2025Q2', '2025Q3', '2025Q4'):
            rows = np.isin(s, g[g.q == q].s.values) & (sd < '2026-01-01')
            line = f'  {q} 基準率 {D["y"][rows].mean() * 100:4.2f}%'
            for t in ('M26', 'D24'):
                r1 = C.summarize(C.topk_mask(S[t], s, 1, rows), D, '', boot=False)
                r10 = C.summarize(C.topk_mask(S[t], s, 10, rows), D, '', boot=False)
                rf = C.summarize(C.topk_mask(S[t], s, 1, rows & X.fresh), D, '', boot=False)
                line += (f' | {t} top1 {r1["prec"] * 100:4.1f}%（可買 {r1["buy_prec"] * 100:4.1f}%）top10 {r10["prec"] * 100:4.1f}%'
                         f'（可買 {r10["buy_prec"] * 100:4.1f}%）新起漲top1 {rf["prec"] * 100:4.1f}%')
            print(line)
        # 成對差（日區塊 bootstrap）：同一批日子，M26 − D24 的 top1 命中差
        rows = sd >= '2025-01-01'
        rows &= sd < '2026-01-01'
        h = {}
        for t in ('M26', 'D24'):
            m = C.topk_mask(S[t], s, 1, rows); h[t] = pd.Series(D['y'][m].astype(float), index=s[m])
        dd = (h['M26'] - h['D24']).values; rng = np.random.default_rng(0)
        bs = [dd[rng.integers(0, len(dd), len(dd))].mean() for _ in range(4000)]
        print(f'  2025 全年 top1 成對差 M26 − D24 = {dd.mean() * 100:+.1f} 個百分點（日 bootstrap 95% {np.percentile(bs, 2.5) * 100:+.1f}～{np.percentile(bs, 97.5) * 100:+.1f}，{len(dd)} 日）')

    print('\n==================== 種子穩健度（同設定、不同負例抽樣與樹種子）====================')
    for t, rows, nm in (('M26', h2, '2025H2'), ('M26', cm, '2025 冷月'), ('FIX25', y26, '2026'), ('ROLL26', feb, '2026-02～10')):
        f1 = os.path.join(C.SP, f'a32_regime_score_{t}_s1.npz')
        if S[t] is None or not os.path.exists(f1): print(f'  （缺 {t}_s1）'); continue
        s1 = np.load(f1)['score']
        line = f'  {t}@{nm}:'
        for lab, sc in (('s0', S[t]), ('s1', s1), ('平均', (S[t] + s1) / 2)):
            r1 = C.summarize(C.topk_mask(sc, s, 1, rows), D, '', boot=False)
            r10 = C.summarize(C.topk_mask(sc, s, 10, rows), D, '', boot=False)
            rf = C.summarize(C.topk_mask(sc, s, 1, rows & X.fresh), D, '', boot=False)
            line += f' [{lab}] top1 {r1["prec"] * 100:4.1f}%／可買 {r1["buy_prec"] * 100:4.1f}% top10 {r10["prec"] * 100:4.1f}% 新起漲top1 {rf["prec"] * 100:4.1f}%'
        a = C.topk_mask(S[t], s, 1, rows); b = C.topk_mask(s1, s, 1, rows)
        line += f' | 兩種子第 1 名相同的日 {(a & b).sum() / a.sum() * 100:.0f}%'
        print(line)

    print('\n==================== 重現性：前次研究 a31_vgall DV4s0（≤2025 訓練）@2026 ====================')
    f = os.path.join(C.SP, 'a31_vgall_score_DV4s0.npz')
    if os.path.exists(f) and S['FIX25'] is not None:
        Z = np.load(f); prev = np.full(len(s), np.nan, np.float32); prev[Z['TEST_rows']] = Z['TEST']
        for lab, sc in (('a31 DV4s0', prev), ('a32 FIX25', S['FIX25'])):
            r1 = C.summarize(C.topk_mask(sc, s, 1, y26), D, '', boot=False); r10 = C.summarize(C.topk_mask(sc, s, 10, y26), D, '', boot=False)
            print(f'  {lab}: top1 {r1["prec"] * 100:.1f}%（可買 {r1["buy_prec"] * 100:.1f}%） top10 {r10["prec"] * 100:.1f}%（可買 {r10["buy_prec"] * 100:.1f}%）')

    pd.DataFrame(ROWS).to_csv(os.path.join(C.OUT, 'a32_regime_eval.csv'), index=False)


if __name__ == '__main__':
    log = open(os.path.join(C.OUT, 'a32_regime_eval.log'), 'w')

    class Tee:
        def write(self, x): sys.__stdout__.write(x); log.write(x)
        def flush(self): sys.__stdout__.flush(); log.flush()
    sys.stdout = Tee()
    main()
