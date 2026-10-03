"""a32_walkforward 步驟 3：逐月前推比較 OLD／NEW／ALL／ALLW（＋OLDSM 樣本量對照、REC 新近對照、NEW 學習曲線）。

輸入：.surge-cache/a32_walkforward_sc_<tag>.npz（a32_walkforward_fit.py，3 個 seed）。
評估口徑（全部「同日內」排名）：
  · 每日前 1／3／10 名的精確度（s+1 收漲停）與可買精確度（s+1 收漲停且開盤 < 漲停價）——全部列排名
  · 只在新起漲列（s 日未漲停）內排名的前 1／3／10 名精確度與可買精確度
  · 同日 AUC（只比較同一天的正負例對，依對數加權＝把各日正負例對數合計後的一致率）——全部列與新起漲列
  · 指標＝3 個 seed 各自計算後取平均（另列 seed 間最小～最大）
  · 合併 2026-04～09：日區塊 bootstrap（5 個交易日一塊、2000 次）給差值 95% 區間；每次重抽同時對 3 個 seed 取平均
輸出：out/a32_walkforward_{month,boot,lc,imp,overlap}.csv、out/a32_walkforward_report.txt、out/a32_walkforward_summary.json
"""
import os
import glob
import json
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')
OUT = os.path.join(HERE, 'out')
KS = (1, 3, 10)
SEEDS = (1, 2, 3)
MONTHS = ('2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09')
EXTRA_MONTHS = ('2026-02', '2026-03')
BLOCK = 5
N_BOOT = 2000
TREES = 600
LC_WINDOW = ('2026-08-01', '2026-12-31')

META = np.load(os.path.join(SP, 'a32_walkforward_meta.npz'))
DATES = META['dates']; S = META['m_s']; SD = DATES[S]
Y = META['m_y'].astype(np.int8); BUY = META['m_buy_lu'].astype(np.int8); LU = META['m_lu_s'].astype(np.int8)
LOCK = META['m_locked1'].astype(np.int8)
NAMES = META['names']
REPORT: list = []


def say(*a) -> None:
    line = ' '.join(str(x) for x in a)
    print(line, flush=True); REPORT.append(line)


def wilson(p: float, n: float, z: float = 1.96) -> tuple:
    if n <= 0 or not np.isfinite(p): return (np.nan, np.nan)
    c = (p + z * z / (2 * n)); r = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); d = 1 + z * z / n
    return ((c - r) / d, (c + r) / d)


def month_of(sd: np.ndarray) -> np.ndarray:
    """日期 → 測試月份；2026-10-01（資料最後一日）併入 2026-09（任務定義 09＝2026-09-01～2026-10-01）。"""
    mo = np.array([d[:7] for d in sd]) if len(sd) else np.array([], str)
    return np.where(np.asarray(sd) >= '2026-10-01', '2026-09', mo)


# ── 分數載入 ──
def tag(kind: str, target: str, M: str, seed: int, k: int = 0) -> str:
    return f'{kind}{k if kind == "REC" else ""}_{target}_{M.replace("-", "")}_s{seed}'


_CACHE: dict = {}


def load_score(t: str, trees: int = TREES) -> tuple:
    key = (t, trees)
    if key not in _CACHE:
        z = np.load(os.path.join(SP, f'a32_walkforward_sc_{t}.npz'))
        _CACHE[key] = (z['rows'], z[f'score_{trees}'], json.loads(str(z['info'])), z['imp'])
    return _CACHE[key]


def full_score(kind: str, target: str, seed: int, trees: int = TREES, months=MONTHS, k: int = 0, fixed_M: str = None) -> np.ndarray:
    """組出全長分數向量（NaN＝未打分）。kind=OLD 用單一模型；fixed_M 指定時用單一模型 M 打全部可用列；否則逐月前推。"""
    sc = np.full(len(S), np.nan, np.float32)
    if kind == 'OLD' or fixed_M is not None:
        rows, v, _, _ = load_score(tag(kind, target, fixed_M or '-', seed, k), trees)
        sc[rows] = v; return sc
    for M in months:
        rows, v, _, _ = load_score(tag(kind, target, M, seed, k), trees)
        inm = month_of(SD[rows]) == M
        sc[rows[inm]] = v[inm]
    return sc


# ── 每日統計 ──
def per_day(score: np.ndarray, rows: np.ndarray, day: np.ndarray, nd: int, seed: int = 0) -> dict:
    """rows＝評估列（全長索引）、day＝其日序（0..nd-1）。回傳每日陣列。"""
    rng = np.random.default_rng(seed)
    sc = score[rows].astype(np.float64)
    if np.isnan(sc).any(): raise ValueError('評估列有未打分的列')
    y, b, lu, lk = Y[rows], BUY[rows], LU[rows], LOCK[rows]
    out = {}
    for name, sub in (('all', np.ones(len(rows), bool)), ('fresh', lu == 0)):
        ii = np.nonzero(sub)[0]
        d = day[ii]; s_ = sc[ii]
        order = np.lexsort((rng.random(len(ii)), -s_, d))
        ds = d[order]
        cnt = np.bincount(d, minlength=nd)
        start = np.r_[0, np.cumsum(cnt)[:-1]]
        rk = np.empty(len(ii), np.int64); rk[order] = np.arange(len(ii)) - start[ds]
        for k in KS:
            m = rk < k
            out[f'{name}_n{k}'] = np.bincount(d[m], minlength=nd).astype(float)
            out[f'{name}_hit{k}'] = np.bincount(d[m], weights=y[ii][m], minlength=nd)
            out[f'{name}_buy{k}'] = np.bincount(d[m], weights=b[ii][m], minlength=nd)
            out[f'{name}_cont{k}'] = np.bincount(d[m], weights=lu[ii][m], minlength=nd)
            out[f'{name}_lock{k}'] = np.bincount(d[m], weights=lk[ii][m], minlength=nd)
        r_asc = cnt[d] - rk                                  # 1＝當日最低分
        for lab_name, lab in (('y', y[ii]), ('b', b[ii])):
            n1 = np.bincount(d, weights=lab, minlength=nd); n0 = cnt - n1
            rs = np.bincount(d, weights=r_asc * lab, minlength=nd)
            out[f'{name}_auc{lab_name}_c'] = rs - n1 * (n1 + 1) / 2
            out[f'{name}_auc{lab_name}_p'] = n1 * n0
    return out


def agg(st: dict, w: np.ndarray = None) -> dict:
    """依日權重 w（None＝全 1）合計成指標。"""
    f = (lambda a: a.sum()) if w is None else (lambda a: w @ a)
    r = {}
    for name in ('all', 'fresh'):
        for k in KS:
            n = f(st[f'{name}_n{k}'])
            r[f'{name}_n{k}'] = n
            for q in ('hit', 'buy', 'cont', 'lock'):
                r[f'{name}_{q}{k}'] = f(st[f'{name}_{q}{k}']) / n
        for lab in ('y', 'b'):
            r[f'{name}_auc{lab}'] = f(st[f'{name}_auc{lab}_c']) / f(st[f'{name}_auc{lab}_p'])
    return r


def agg_boot(st: dict, W: np.ndarray, keys: tuple) -> dict:
    """W：(reps, nd) 日權重矩陣；只算指定鍵。"""
    r = {}
    for key in keys:
        name, rest = key.split('_', 1)
        if rest.startswith('auc'):
            r[key] = (W @ st[f'{key}_c']) / (W @ st[f'{key}_p'])
        else:
            q, k = rest.rstrip('0123456789'), rest[len(rest.rstrip('0123456789')):]
            r[key] = (W @ st[f'{name}_{q}{k}']) / (W @ st[f'{name}_n{k}'])
    return r


def eval_rows(lo: str, hi: str) -> tuple:
    rows = np.nonzero((SD >= lo) & (SD <= hi))[0]
    ud, day = np.unique(S[rows], return_inverse=True)
    return rows, day, len(ud), DATES[ud]


def block_weights(nd: int, reps: int, block: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    nb = int(np.ceil(nd / block))
    blk = np.arange(nd) // block
    draws = rng.integers(0, nb, size=(reps, nb))
    cnt = np.zeros((reps, nb))
    for j in range(nb): cnt[np.arange(reps), draws[:, j]] += 1
    return cnt[:, blk]


def fmt_pct(x: float) -> str:
    return f'{x * 100:5.1f}%' if np.isfinite(x) else '  —  '


# ── 主流程 ──
def model_stats(kind: str, target: str, rows: np.ndarray, day: np.ndarray, nd: int, trees: int = TREES, **kw) -> list:
    return [per_day(full_score(kind, target, sd, trees, **kw), rows, day, nd, seed=sd) for sd in SEEDS]


def mean_over_seeds(stl: list, w=None) -> tuple:
    rs = [agg(s, w) for s in stl]
    keys = rs[0].keys()
    mean = {k: float(np.mean([r[k] for r in rs])) for k in keys}
    lo = {k: float(np.min([r[k] for r in rs])) for k in keys}
    hi = {k: float(np.max([r[k] for r in rs])) for k in keys}
    return mean, lo, hi


def month_masks(dates_of_days: np.ndarray, months) -> dict:
    mo = month_of(np.asarray(dates_of_days))
    return {M: (mo == M).astype(float) for M in months}


MAIN_KEYS = ('all_aucy', 'fresh_aucy', 'all_hit1', 'all_buy1', 'all_hit3', 'all_buy3', 'all_hit10', 'all_buy10',
             'fresh_hit1', 'fresh_buy1', 'fresh_hit3', 'fresh_buy3', 'fresh_hit10', 'fresh_buy10', 'all_cont10', 'all_lock1')
BUY_KEYS = ('all_aucb', 'fresh_aucb', 'all_buy1', 'all_hit1', 'all_buy3', 'all_hit3', 'all_buy10', 'all_hit10',
            'fresh_buy1', 'fresh_buy3', 'fresh_buy10', 'all_lock1')


def section_walkforward() -> dict:
    rows, day, nd, ddates = eval_rows('2026-04-01', '2026-10-01')
    say(f'\n══ 逐月前推：測試列 {len(rows):,}、{nd} 個交易日（{ddates[0]}～{ddates[-1]}）、隔日漲停 {int(Y[rows].sum()):,}（基準 {Y[rows].mean() * 100:.2f}%）、'
        f'其中新起漲 {int((Y[rows] & (LU[rows] == 0)).sum()):,}、可買漲停 {int(BUY[rows].sum()):,}')
    mm = month_masks(ddates, MONTHS)
    for M in MONTHS:
        r = rows[month_of(SD[rows]) == M]
        say(f'  {M}：{int(mm[M].sum())} 日、列 {len(r):,}、基準 {Y[r].mean() * 100:.2f}%、新起漲基準 {Y[r][LU[r] == 0].mean() * 100:.2f}%、可買漲停率 {BUY[r].mean() * 100:.2f}%')
    specs = [('OLD', 'y'), ('NEW', 'y'), ('ALL', 'y'), ('ALLW', 'y'), ('OLDSM', 'y'), ('OLD', 'buy'), ('NEW', 'buy')]
    ST = {sp: model_stats(sp[0], sp[1], rows, day, nd) for sp in specs}
    ST[('NEW', 'y', 200)] = model_stats('NEW', 'y', rows, day, nd, trees=200)
    ST[('OLD', 'y', 200)] = model_stats('OLD', 'y', rows, day, nd, trees=200)
    recs = []
    for sp, stl in ST.items():
        for M in list(MONTHS) + ['POOLED']:
            w = None if M == 'POOLED' else mm[M]
            mean, lo, hi = mean_over_seeds(stl, w)
            rec = dict(model=sp[0], target=sp[1], trees=sp[2] if len(sp) > 2 else TREES, month=M)
            for k in mean: rec[k] = mean[k]
            for k in ('all_hit1', 'all_hit10', 'all_aucy', 'all_buy1', 'fresh_hit1', 'fresh_hit10'):
                rec[f'{k}_seedmin'] = lo[k]; rec[f'{k}_seedmax'] = hi[k]
            for k in KS:
                for nm in ('all', 'fresh'):
                    for q in ('hit', 'buy'):
                        a, b = wilson(mean[f'{nm}_{q}{k}'], mean[f'{nm}_n{k}'])
                        rec[f'{nm}_{q}{k}_wlo'] = a; rec[f'{nm}_{q}{k}_whi'] = b
            recs.append(rec)
    df = pd.DataFrame(recs)
    df.to_csv(os.path.join(OUT, 'a32_walkforward_month.csv'), index=False)
    # 表格輸出
    for target, keys, title in (('y', MAIN_KEYS, '目標＝s+1 收漲停（m_y）'), ('buy', BUY_KEYS, '目標＝s+1 漲停且開盤買得到（m_buy_lu）')):
        say(f'\n── {title}；3 seed 平均；hit＝精確度、buy＝可買精確度、fresh＝只在新起漲列內排名')
        say('model  month    ' + ' '.join(f'{k:>11}' for k in keys))
        for _, r in df[(df.target == target) & (df.trees == TREES)].iterrows():
            say(f'{r.model:<6} {r.month:<8} ' + ' '.join(f'{fmt_pct(r[k]):>11}' for k in keys))
    say('\n── 合併 2026-04～09 的 Wilson 95%（以 3 seed 平均精確度與選取數近似）')
    for _, r in df[(df.month == 'POOLED') & (df.trees == TREES)].iterrows():
        say(f'{r.model:<6}{r.target:<4} top1 {fmt_pct(r.all_hit1)} [{fmt_pct(r.all_hit1_wlo)},{fmt_pct(r.all_hit1_whi)}] n={r.all_n1:.0f}  '
            f'top10 {fmt_pct(r.all_hit10)} [{fmt_pct(r.all_hit10_wlo)},{fmt_pct(r.all_hit10_whi)}] n={r.all_n10:.0f}  '
            f'fresh top1 {fmt_pct(r.fresh_hit1)} [{fmt_pct(r.fresh_hit1_wlo)},{fmt_pct(r.fresh_hit1_whi)}]  '
            f'seed 範圍 top1 {fmt_pct(r.all_hit1_seedmin)}～{fmt_pct(r.all_hit1_seedmax)}、top10 {fmt_pct(r.all_hit10_seedmin)}～{fmt_pct(r.all_hit10_seedmax)}')
    say('\n── 樹數敏感度（合併）：')
    for _, r in df[(df.month == 'POOLED') & (df.target == 'y') & df.model.isin(['OLD', 'NEW'])].iterrows():
        say(f'{r.model:<5} trees={r.trees:<4} AUC {fmt_pct(r.all_aucy)} top1 {fmt_pct(r.all_hit1)} top3 {fmt_pct(r.all_hit3)} top10 {fmt_pct(r.all_hit10)} fresh top10 {fmt_pct(r.fresh_hit10)}')
    # bootstrap
    W = block_weights(nd, N_BOOT, BLOCK, 20261003)
    bkeys = ('all_hit1', 'all_hit3', 'all_hit10', 'all_buy1', 'all_buy10', 'all_aucy', 'fresh_aucy', 'fresh_hit1', 'fresh_hit10', 'fresh_buy10')
    bkeys_buy = ('all_buy1', 'all_buy3', 'all_buy10', 'all_aucb', 'fresh_buy10')

    def boot_mean(stl, keys):
        rs = [agg_boot(s, W, keys) for s in stl]
        return {k: np.mean([r[k] for r in rs], axis=0) for k in keys}

    def point(stl, keys):
        rs = [agg(s) for s in stl]
        return {k: float(np.mean([r[k] for r in rs])) for k in keys}

    B = {sp: boot_mean(ST[sp], bkeys) for sp in [('OLD', 'y'), ('NEW', 'y'), ('ALL', 'y'), ('ALLW', 'y'), ('OLDSM', 'y')]}
    Bb = {sp: boot_mean(ST[sp], bkeys_buy) for sp in [('OLD', 'buy'), ('NEW', 'buy')]}
    brecs = []
    say(f'\n── 日區塊 bootstrap（{BLOCK} 日一塊、{N_BOOT} 次、每次對 3 seed 平均）：差值點估計 [95% 區間]  P(差>0)')
    pairs = [(('NEW', 'y'), ('OLD', 'y')), (('ALL', 'y'), ('OLD', 'y')), (('ALLW', 'y'), ('OLD', 'y')),
             (('NEW', 'y'), ('ALL', 'y')), (('ALLW', 'y'), ('ALL', 'y')), (('NEW', 'y'), ('OLDSM', 'y'))]
    for a, b in pairs:
        pa, pb = point(ST[a], bkeys), point(ST[b], bkeys)
        for k in bkeys:
            d = B[a][k] - B[b][k]; est = pa[k] - pb[k]
            brecs.append(dict(a=f'{a[0]}_{a[1]}', b=f'{b[0]}_{b[1]}', metric=k, a_val=pa[k], b_val=pb[k], diff=est,
                              lo=float(np.percentile(d, 2.5)), hi=float(np.percentile(d, 97.5)), p_gt0=float((d > 0).mean())))
        for kk in ('1', '10'):   # 「漲停但開盤已鎖死（買不到）」＝精確度 − 可買精確度（同分母）
            hb = lambda X: X[f'all_hit{kk}'] - X[f'all_buy{kk}']
            d = hb(B[a]) - hb(B[b]); va, vb = hb(pa), hb(pb)
            brecs.append(dict(a=f'{a[0]}_{a[1]}', b=f'{b[0]}_{b[1]}', metric=f'all_unbuyhit{kk}', a_val=va, b_val=vb, diff=va - vb,
                              lo=float(np.percentile(d, 2.5)), hi=float(np.percentile(d, 97.5)), p_gt0=float((d > 0).mean())))
    a, b = ('NEW', 'buy'), ('OLD', 'buy')
    pa, pb = point(ST[a], bkeys_buy), point(ST[b], bkeys_buy)
    for k in bkeys_buy:
        d = Bb[a][k] - Bb[b][k]; est = pa[k] - pb[k]
        brecs.append(dict(a='NEW_buy', b='OLD_buy', metric=k, a_val=pa[k], b_val=pb[k], diff=est,
                          lo=float(np.percentile(d, 2.5)), hi=float(np.percentile(d, 97.5)), p_gt0=float((d > 0).mean())))
    bdf = pd.DataFrame(brecs); bdf.to_csv(os.path.join(OUT, 'a32_walkforward_boot.csv'), index=False)
    for _, r in bdf.iterrows():
        say(f'{r.a:>9} − {r.b:<9} {r.metric:<12} {fmt_pct(r.a_val)} vs {fmt_pct(r.b_val)}  差 {r["diff"] * 100:+5.1f}pp [{r.lo * 100:+5.1f}, {r.hi * 100:+5.1f}]  P>0={r.p_gt0:.2f}')
    return dict(month=df, boot=bdf, ST=ST, rows=rows, day=day, nd=nd)


def section_learning_curve() -> pd.DataFrame:
    rows, day, nd, ddates = eval_rows(*LC_WINDOW)
    say(f'\n══ NEW 的 2026 訓練量學習曲線：固定測試窗 {ddates[0]}～{ddates[-1]}（{nd} 日、列 {len(rows):,}、漲停 {int(Y[rows].sum()):,}）')
    variants = []
    for M, lab in (('2026-02', '1月'), ('2026-03', '1～2月'), ('2026-04', '1～3月'), ('2026-05', '1～4月'), ('2026-06', '1～5月'),
                   ('2026-07', '1～6月'), ('2026-08', '1～7月')):
        variants.append((f'NEW 累積 {lab}', 'NEW', M, 0))
    for k in range(1, 7):
        variants.append((f'REC 只用最近 {k} 個月', 'REC', '2026-08', k))
    variants.append(('OLDSM ≤2025 抽樣（正例數＝NEW 1～7月）', 'OLDSM', '2026-08', 0))
    variants.append(('ALL ≤2026-07', 'ALL', '2026-08', 0))
    variants.append(('ALLW ≤2026-07（2026×3）', 'ALLW', '2026-08', 0))
    variants.append(('OLD ≤2025', 'OLD', '-', 0))
    W = block_weights(nd, N_BOOT, BLOCK, 7)
    bkeys = ('all_hit1', 'all_hit10', 'all_aucy', 'fresh_hit10')
    ref = None
    recs = []
    for lab, kind, M, k in variants:
        stl = [per_day(full_score(kind, 'y', sd, k=k, fixed_M=M), rows, day, nd, seed=sd) for sd in SEEDS]
        mean, lo, hi = mean_over_seeds(stl)
        info = load_score(tag(kind, 'y', M, 1, k))[2]
        bm = {kk: np.mean([agg_boot(s, W, bkeys)[kk] for s in stl], axis=0) for kk in bkeys}
        if kind == 'OLD': ref = bm
        recs.append(dict(variant=lab, kind=kind, M=M, k=k, train_first=info['train_first'], train_last=info['train_last'],
                         train_days=info['train_days'], train_pos=info['train_pos'], **mean, _boot=bm,
                         hit1_seedmin=lo['all_hit1'], hit1_seedmax=hi['all_hit1'], hit10_seedmin=lo['all_hit10'], hit10_seedmax=hi['all_hit10']))
    out = []
    for r in recs:
        bm = r.pop('_boot')
        for kk in bkeys:
            d = bm[kk] - ref[kk]
            r[f'{kk}_vsOLD_lo'] = float(np.percentile(d, 2.5)); r[f'{kk}_vsOLD_hi'] = float(np.percentile(d, 97.5))
        out.append(r)
    df = pd.DataFrame(out); df.to_csv(os.path.join(OUT, 'a32_walkforward_lc.csv'), index=False)
    say('variant                                   訓練期                 日數  正例   AUC   fAUC  top1  top1可買 top3  top10 top10可買 fresh1 fresh10  | top1−OLD 95%     top10−OLD 95%')
    for _, r in df.iterrows():
        say(f'{r.variant:<40} {r.train_first}～{r.train_last} {r.train_days:>4} {r.train_pos:>6} {fmt_pct(r.all_aucy)} {fmt_pct(r.fresh_aucy)} {fmt_pct(r.all_hit1)} {fmt_pct(r.all_buy1)} '
            f'{fmt_pct(r.all_hit3)} {fmt_pct(r.all_hit10)} {fmt_pct(r.all_buy10)} {fmt_pct(r.fresh_hit1)} {fmt_pct(r.fresh_hit10)}  | '
            f'[{r.all_hit1_vsOLD_lo * 100:+5.1f},{r.all_hit1_vsOLD_hi * 100:+5.1f}] [{r.all_hit10_vsOLD_lo * 100:+5.1f},{r.all_hit10_vsOLD_hi * 100:+5.1f}]')
    return df


def section_extra_months() -> None:
    rows, day, nd, ddates = eval_rows('2026-02-01', '2026-03-31')
    say(f'\n══ 附：2026-02、03（不在合併內；NEW 只學了 1 個月／2 個月）')
    mm = month_masks(ddates, EXTRA_MONTHS)
    for kind in ('OLD', 'NEW'):
        stl = [per_day(full_score(kind, 'y', sd, months=EXTRA_MONTHS), rows, day, nd, seed=sd) for sd in SEEDS]
        for M in EXTRA_MONTHS:
            mean, _, _ = mean_over_seeds(stl, mm[M])
            say(f'{kind:<4} {M} AUC {fmt_pct(mean["all_aucy"])} top1 {fmt_pct(mean["all_hit1"])}（可買 {fmt_pct(mean["all_buy1"])}） top10 {fmt_pct(mean["all_hit10"])}（可買 {fmt_pct(mean["all_buy10"])}） fresh top10 {fmt_pct(mean["fresh_hit10"])}')


def section_importance() -> pd.DataFrame:
    def avg_imp(kind, M, target='y'):
        return np.mean([load_score(tag(kind, target, M, sd))[3] for sd in SEEDS], axis=0)
    I = {'OLD': avg_imp('OLD', '-'), 'NEW_Jan-Aug': avg_imp('NEW', '2026-09'), 'NEW_Jan-Mar': avg_imp('NEW', '2026-04'),
         'ALL_≤Aug': avg_imp('ALL', '2026-09'), 'OLD_buy': avg_imp('OLD', '-', 'buy'), 'NEW_buy_Jan-Aug': avg_imp('NEW', '2026-09', 'buy')}
    df = pd.DataFrame({k: v * 100 for k, v in I.items()}, index=NAMES)
    for k in I: df[f'rank_{k}'] = df[k].rank(ascending=False).astype(int)
    df = df.sort_values('OLD', ascending=False)
    df.to_csv(os.path.join(OUT, 'a32_walkforward_imp.csv'))
    say('\n══ 重要度（gain %，3 seed 平均）：OLD 前 15 與 NEW(1～8 月) 前 15')
    say('  OLD：' + '、'.join(f'{n}({v:.1f})' for n, v in df['OLD'].nlargest(15).items()))
    say('  NEW：' + '、'.join(f'{n}({v:.1f})' for n, v in df['NEW_Jan-Aug'].nlargest(15).items()))
    d = (df['NEW_Jan-Aug'] - df['OLD']).sort_values()
    say('  NEW 比 OLD 更倚重：' + '、'.join(f'{n}(+{v:.1f})' for n, v in d[::-1].head(10).items()))
    say('  NEW 比 OLD 更不倚重：' + '、'.join(f'{n}({v:.1f})' for n, v in d.head(10).items()))
    say('  可買目標 NEW_buy：' + '、'.join(f'{n}({v:.1f})' for n, v in df['NEW_buy_Jan-Aug'].nlargest(12).items()))
    say('  可買目標 OLD_buy：' + '、'.join(f'{n}({v:.1f})' for n, v in df['OLD_buy'].nlargest(12).items()))
    return df


def section_overlap(W: dict) -> None:
    rows, day, nd = W['rows'], W['day'], W['nd']
    recs = []
    for sd in SEEDS:
        a = full_score('NEW', 'y', sd)[rows]; b = full_score('OLD', 'y', sd)[rows]
        for d in range(nd):
            m = day == d
            ra = pd.Series(a[m]).rank(ascending=False).values; rb = pd.Series(b[m]).rank(ascending=False).values
            rho = np.corrcoef(ra, rb)[0, 1]
            t1a, t1b = np.argmin(ra), np.argmin(rb)
            ta, tb = set(np.argsort(ra)[:10]), set(np.argsort(rb)[:10])
            recs.append(dict(seed=sd, day=d, spearman=rho, top1_same=float(t1a == t1b), top10_overlap=len(ta & tb) / 10))
    df = pd.DataFrame(recs); df.to_csv(os.path.join(OUT, 'a32_walkforward_overlap.csv'), index=False)
    say(f'\n══ NEW 與 OLD 選股重疊（同 seed 配對、逐日）：同日分數 Spearman 平均 {df.spearman.mean():.3f}；'
        f'第 1 名相同比例 {df.top1_same.mean() * 100:.1f}%；前 10 名重疊平均 {df.top10_overlap.mean() * 100:.1f}%')


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    n_files = len(glob.glob(os.path.join(SP, 'a32_walkforward_sc_*.npz')))
    say(f'分數檔 {n_files} 個')
    W = section_walkforward()
    section_extra_months()
    lc = section_learning_curve()
    section_importance()
    section_overlap(W)
    pooled = W['month'][(W['month'].month == 'POOLED') & (W['month'].trees == TREES)]
    summary = dict(pooled=pooled.to_dict(orient='records'), boot=W['boot'].to_dict(orient='records'),
                   learning_curve=lc.to_dict(orient='records'))
    json.dump(summary, open(os.path.join(OUT, 'a32_walkforward_summary.json'), 'w'), ensure_ascii=False, indent=1, default=float)
    open(os.path.join(OUT, 'a32_walkforward_report.txt'), 'w').write('\n'.join(REPORT) + '\n')


if __name__ == '__main__':
    main()
