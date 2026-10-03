"""a31 C：窮舉高精準規則搜尋（subgroup discovery / beam search）——「隔日漲停」能不能用 ≤4 個門檻條件挑到 9 成準？

資料：.surge-cache/dataset_lu1.npz（build_lu1.py）。精準度＝s 日收盤後選出的股票中，s+1 收漲停的比例。
協定：DESIGN＝s ≤ 2025-06-30；VALID＝2025-07-01～12-31；TEST＝2026-01-01～2026-10-01。
  · 門檻＝DESIGN 列的分位數切點（含 0.5/1/2/…/99.5%；離散特徵用實際取值），條件＝「x ≥ 切點」「x < 切點」「x 缺值」。
  · beam search：每層對 beam 中每條規則加 1 個條件（同特徵＝取交集），以 DESIGN 指標排序；支持數 ≥50、DESIGN 日數 ≥10。
  · 三個搜尋準則：prec（純精準度、min 50）、prec200（純精準度、min 200）、wlb（Wilson 95% 下界）。
  · 所有 beam 出現過的規則進候選池 → 算 VALID／TEST（切點固定為 DESIGN 的）。
  · 選法：①DESIGN 第一名；②DESIGN+VALID（VALID ≥20 筆，以 min(D,V) 精準度排序）；③TEST 事後最佳（明示為有選擇偏誤的上限）。
三個跑法：a＝新起漲（m_lu_s=0，目標 m_y）；b＝延續（m_lu_s=1，目標 m_y）；c＝目標 m_buy_lu（全部列）；
另 bd＝尾盤五檔子研究（只有 2026-07-20 起 46 日，全在 TEST 內 → 前 23 日當設計、後 23 日當測試，延續段）。
用法：python3 a31_c_rules_search.py [a|b|c|bd ...]   輸出 out/a31_c_*.csv、.surge-cache/a31_c_*.npz、out/a31_c_rules_search.log（自行 tee）。
"""
import os, sys, json, time
import numpy as np, pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.environ.get('SURGE_CACHE', os.path.join(HERE, '.surge-cache'))
OUT = os.path.join(HERE, 'out')
DS = os.path.join(SP, 'dataset_lu1.npz')

PCTS = np.array([0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 85, 90, 92.5, 95, 97, 98, 99, 99.5]) / 100
NB = 34            # 箱 0..32＝非缺值（最多 32 個切點）、33＝缺值
NANB = NB - 1
MAX_DISCRETE = 32
DESIGN_END, VALID_END = '2025-06-30', '2025-12-31'
BEAM_W, PER_PARENT, DEPTH = 200, 100, 4
ROOT_KEEP = 4000                   # 第一層（根）保留的候選數
MIN_DAYS = 10
# (名稱, 最少支持數, 排序指標, 分散要求)：分散＝DESIGN 日數 ≥ SPREAD_DAYS 且單日占比 ≤ SPREAD_SHARE（排除「單一崩盤反彈日」型規則）
CRITERIA = (('prec', 50, 'prec', False), ('prec200', 200, 'prec', False), ('wlb', 50, 'wlb', False),
            ('prec_sp', 50, 'prec', True), ('wlb_sp', 50, 'wlb', True))
CRITERIA_BD = (('prec', 30, 'prec', False), ('wlb', 30, 'wlb', False), ('wlb_sp', 30, 'wlb', True))
SPREAD_DAYS, SPREAD_SHARE = 20, 0.10
SPREAD_DAYS_BD, SPREAD_SHARE_BD = 8, 0.20
Z = 1.96
EXTRA_X = ('x_lu_s', 'x_oneword_s', 'x_close_at_high', 'x_lu_streak', 'x_price', 'x_vol20')
BD_X = ('x_bd_has', 'x_bd_bidlim', 'x_bd_bid', 'x_bd_ask', 'x_bd_imb', 'x_bd_q_v')


def wilson_lb(pos, n, z=Z):
    n = np.maximum(np.asarray(n, float), 1e-9); p = np.asarray(pos, float) / n
    return (p + z * z / (2 * n) - z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n)


# ── 載入 ──
def load(run):
    z = np.load(DS)
    dates = z['dates']; s_all = z['m_s']; ds = dates[s_all]
    lu = z['m_lu_s']
    if run == 'a': keep = lu == 0
    elif run in ('b', 'bd'): keep = lu == 1
    else: keep = np.ones(len(lu), bool)
    if run == 'bd': keep &= np.isfinite(z['x_bd_has'])
    idx = np.nonzero(keep)[0]
    tgt = 'm_buy_lu' if run == 'c' else 'm_y'
    M = dict(idx=idx, s=s_all[idx], ds=ds[idx], y=z[tgt][idx].astype(np.int8), y_lu=z['m_y'][idx].astype(np.int8),
             buy=z['m_buy_lu'][idx].astype(np.int8), locked=z['m_locked1'][idx].astype(np.int8),
             oc1=z['m_oc1'][idx], codes=z['codes'][z['m_j'][idx]], dates=dates)
    names = [k for k in z.files if k.startswith('f_')] + list(EXTRA_X) + (list(BD_X) if run == 'bd' else [])
    cols = [z[k][idx].astype(np.float32) for k in names]
    cols += [z['m_otc'][idx].astype(np.float32), z['m_liquid'][idx].astype(np.float32)]
    names += ['m_otc', 'm_liquid']
    if run == 'bd':
        bdd = np.unique(M['ds']); half = bdd[len(bdd) // 2]
        sp = np.where(M['ds'] < half, 0, 2)
    else:
        sp = np.where(M['ds'] <= DESIGN_END, 0, np.where(M['ds'] <= VALID_END, 1, 2))
    return M, names, cols, sp.astype(np.int8)


def make_bins(names, cols, design):
    """DESIGN 列分位數切點 → uint8 箱號（Fortran 排列，逐欄連續）。常數特徵剔除。"""
    keep_n, cuts, Xb = [], [], []
    for nm, x in zip(names, cols):
        v = x[design & np.isfinite(x)]
        if len(v) < 50: continue
        u = np.unique(v)
        if len(u) < 2: continue
        c = u[1:] if len(u) <= MAX_DISCRETE + 1 else np.unique(np.quantile(v, PCTS).astype(np.float32))
        c = c[:MAX_DISCRETE]
        b = np.searchsorted(c, x, side='right').astype(np.uint8)       # 箱號＝≤x 的切點數
        b[~np.isfinite(x)] = NANB
        keep_n.append(nm); cuts.append(c); Xb.append(b)
    Xb = np.asfortranarray(np.stack(Xb, 1))
    return keep_n, cuts, Xb


# ── 規則：{j: (lo, hi)} 箱號閉區間 ──
def rule_mask(rule, Xb, rows=None):
    m = None
    for j, (a, b) in rule.items():
        col = Xb[:, j] if rows is None else Xb[rows, j]
        mj = (col >= a) & (col <= b)
        m = mj if m is None else (m & mj)
    return m


def rule_text(rule, names, cuts):
    out = []
    for j, (a, b) in sorted(rule.items()):
        nm, c = names[j], cuts[j]; nc = len(c)
        if a == NANB: out.append(f'{nm} 缺值'); continue
        lo = f'{nm} ≥ {c[a - 1]:.4g}' if a >= 1 else None
        hi = f'{nm} < {c[b]:.4g}' if b < nc else None
        if lo and hi: out.append(f'{c[a - 1]:.4g} ≤ {nm} < {c[b]:.4g}')
        elif lo: out.append(lo)
        elif hi: out.append(hi)
        else: out.append(f'{nm} 非缺值')
    return ' AND '.join(out)


def key_of(rule):
    return tuple(sorted((j, a, b) for j, (a, b) in rule.items()))


def refine_counts(Xb, rows, yf, ncut):
    """父群 rows（只含 DESIGN 列）→ 每個特徵、每個箱的 n 與 正例數。"""
    p = Xb.shape[1]
    cnt = np.zeros((p, NB)); pos = np.zeros((p, NB))
    yr = yf[rows]
    for j in range(p):
        col = Xb[rows, j]
        cnt[j] = np.bincount(col, minlength=NB)
        pos[j] = np.bincount(col, weights=yr, minlength=NB)
    return cnt, pos


def candidate_refinements(rule, cnt, pos, ncut, n_parent, crit, minsup, keep):
    """所有「加一個條件」的子規則（≥切點、<切點、缺值），回傳 (score, n, pos, j, lo, hi) 前 PER_PARENT 名。"""
    p = cnt.shape[0]
    C = np.cumsum(cnt[:, :NANB], 1); P = np.cumsum(pos[:, :NANB], 1)
    out = []
    for j in range(p):
        nc = ncut[j]
        a0, b0 = rule.get(j, (0, nc))
        if a0 == NANB: continue                                   # 已限定缺值，不再細分
        tot_n, tot_p = C[j, nc], P[j, nc]
        ks = np.arange(nc)
        # x < cut_k ⇔ 箱 ≤ k ；x ≥ cut_k ⇔ 箱 ≥ k+1
        n_lt, p_lt = C[j, ks], P[j, ks]
        n_ge, p_ge = tot_n - n_lt, tot_p - p_lt
        for ns, ps, kind in ((n_lt, p_lt, 'lt'), (n_ge, p_ge, 'ge')):
            ok = (ns >= minsup) & (ns < n_parent)
            for k in np.nonzero(ok)[0]:
                lo, hi = (a0, min(b0, k)) if kind == 'lt' else (max(a0, k + 1), b0)
                if lo > hi: continue
                out.append((ns[k], ps[k], j, lo, hi))
        if j not in rule and cnt[j, NANB] >= minsup and cnt[j, NANB] < n_parent:
            out.append((cnt[j, NANB], pos[j, NANB], j, NANB, NANB))
    if not out: return []
    A = np.array([o[:2] for o in out], float)
    sc = wilson_lb(A[:, 1], A[:, 0]) if crit == 'wlb' else A[:, 1] / A[:, 0] + 1e-9 * A[:, 0]
    order = np.argsort(-sc)[:keep]
    return [(sc[i],) + out[i] for i in order]


def beam_search(Xb, yf, s, design_rows, ncut, crit, minsup, log, min_days=MIN_DAYS, max_share=1.0, label=''):
    pool = {}
    beam = [({}, design_rows)]
    for depth in range(1, DEPTH + 1):
        t0 = time.time(); cands = {}
        for rule, rows in beam:
            cnt, pos = refine_counts(Xb, rows, yf, ncut)
            got = 0; lim = ROOT_KEEP if not rule else PER_PARENT
            for sc, n, ps, j, lo, hi in candidate_refinements(rule, cnt, pos, ncut, len(rows), crit, minsup, lim * 4):
                r2 = dict(rule); r2[j] = (lo, hi); k = key_of(r2)
                if k in cands: continue
                cands[k] = (sc, n, ps, r2, rule, rows)
                got += 1
                if got >= lim: break
        ranked = sorted(cands.values(), key=lambda t: -t[0])
        new_beam, seen_fs, seen_rows = [], set(), set()
        for sc, n, ps, r2, parent, prow in ranked:
            fs = tuple(sorted(r2))                                 # 同一組特徵只留最佳切點 → 多樣性
            if fs in seen_fs: continue
            rows2 = prow[rule_mask({j: r2[j] for j in r2 if r2.get(j) != parent.get(j)}, Xb, prow)]
            sig = (len(rows2), int(rows2.sum()), int((rows2.astype(np.int64) % 1000003).sum()))
            if sig in seen_rows: continue                          # 邏輯等價（同一批列，如 close_pos 缺值≡一字鎖）只留一條
            _, dc = np.unique(s[rows2], return_counts=True); nd = len(dc)
            if nd < min_days or dc.max() > max_share * len(rows2): continue
            seen_fs.add(fs); seen_rows.add(sig)
            pool[key_of(r2)] = dict(rule=r2, crit=crit, depth=depth, d_n=int(n), d_pos=int(ps), d_days=nd, d_score=float(sc))
            new_beam.append((r2, rows2))
            if len(new_beam) >= BEAM_W: break
        beam = new_beam
        best = max((v['d_pos'] / v['d_n'] for v in pool.values() if v['depth'] == depth), default=float('nan'))
        log(f'  [{label or crit}] 深度 {depth}：候選 {len(cands):,}、beam {len(beam)}、本層 DESIGN 最高精準 {best:.3f}（{time.time() - t0:.0f}s）')
    return pool


def evaluate_pool(pool, Xb, M, sp, prior, prior_v):
    """每條規則在 DESIGN/VALID/TEST 的 n、正例、日數、可買比例；同時累積兩種『規則集成分數』（每列取命中規則的最大值）：
    ens＝D+V 合併縮減精準度；ens_v＝只用 VALID 縮減精準度（規則是在 DESIGN 上挑的，VALID 精準度才是無偏估計）。"""
    n = len(sp); ens = np.full(n, -1.0); ens_v = np.full(n, -1.0); recs = []
    y, buy, s = M['y'], M['buy'], M['s']; y_lu = M['y_lu']
    for k, v in pool.items():
        m = rule_mask(v['rule'], Xb)
        r = dict(v)
        for t, nm in ((0, 'd'), (1, 'v'), (2, 't')):
            mm = m & (sp == t)
            r[f'{nm}_n'] = int(mm.sum()); r[f'{nm}_pos'] = int(y[mm].sum())
            r[f'{nm}_days'] = int(len(np.unique(s[mm]))) if mm.any() else 0
            r[f'{nm}_buy'] = int(buy[mm].sum()); r[f'{nm}_lu'] = int(y_lu[mm].sum())
            r[f'{nm}_maxshare'] = float(np.bincount(s[mm]).max() / mm.sum()) if mm.any() else np.nan
        nn, pp = r['d_n'] + r['v_n'], r['d_pos'] + r['v_pos']
        sh = (pp + 20 * prior) / (nn + 20)                         # 縮減到基準率（20 筆虛擬樣本）
        r['dv_shrunk'] = sh
        upd = m & (sh > ens)
        ens[upd] = sh
        shv = (r['v_pos'] + 20 * prior_v) / (r['v_n'] + 20)
        r['v_shrunk'] = shv
        upd = m & (shv > ens_v)
        ens_v[upd] = shv
        recs.append(r)
    return pd.DataFrame(recs), ens, ens_v


def add_stats(df, tot_test_days, tot_test_pos):
    for nm in ('d', 'v', 't'):
        df[f'{nm}_prec'] = df[f'{nm}_pos'] / df[f'{nm}_n'].replace(0, np.nan)
    df['t_wlb'] = wilson_lb(df['t_pos'], df['t_n'])
    df['t_buyprec'] = df['t_buy'] / df['t_n'].replace(0, np.nan)
    df['t_luprec'] = df['t_lu'] / df['t_n'].replace(0, np.nan)
    df['t_picks_per_day'] = df['t_n'] / tot_test_days
    df['t_recall'] = df['t_pos'] / tot_test_pos
    return df


def frontier(score, s, y, buy, rng):
    """TEST：每日前 K 名精準度、全期前 N 名精準度（同分隨機打散）。"""
    sc = score + rng.random(len(score)) * 1e-7
    out = {}
    order = np.lexsort((-sc, s)); ss = s[order]
    start = np.r_[0, np.nonzero(np.diff(ss))[0] + 1]
    rank = np.arange(len(ss)) - np.repeat(start, np.diff(np.r_[start, len(ss)]))
    for K in (1, 3, 10):
        sel = order[rank < K]
        out[f'top{K}/day'] = (len(sel), y[sel].mean(), buy[sel].mean())
    g = np.argsort(-sc)
    for N in (30, 100, 300, 1000):
        sel = g[:N]
        out[f'top{N} total'] = (N, y[sel].mean(), buy[sel].mean())
    return out


def run_one(run, log):
    t0 = time.time()
    M, names0, cols, sp = load(run)
    design = sp == 0
    names, cuts, Xb = make_bins(names0, cols, design); del cols
    ncut = np.array([len(c) for c in cuts])
    y = M['y']; yf = y.astype(np.float64); s = M['s']
    test_days = len(np.unique(s[sp == 2]))
    base = {t: y[sp == t].mean() for t in (0, 1, 2) if (sp == t).any()}
    log(f'\n══ 跑法 {run}（目標 {"m_buy_lu" if run == "c" else "m_y"}）列 {len(y):,}、特徵 {len(names)}；'
        f'基準率 D {base.get(0, np.nan):.4f} V {base.get(1, np.nan):.4f} T {base.get(2, np.nan):.4f}；TEST 日數 {test_days}（{time.time() - t0:.0f}s 載入）')
    drows = np.nonzero(design)[0]
    pool = {}
    crits = CRITERIA if run != 'bd' else CRITERIA_BD
    sd, ss_ = (SPREAD_DAYS, SPREAD_SHARE) if run != 'bd' else (SPREAD_DAYS_BD, SPREAD_SHARE_BD)
    for crit, minsup, kind, spread in crits:
        p = beam_search(Xb, yf, s, drows, ncut, kind, minsup, log, min_days=sd if spread else MIN_DAYS,
                        max_share=ss_ if spread else 1.0, label=crit)
        for k, v in p.items():
            v['crit'] = crit
            if k not in pool: pool[k] = v
    log(f'  候選池 {len(pool):,} 條規則')
    prior = y[sp <= 1].mean(); prior_v = y[sp == 1].mean() if (sp == 1).any() else prior
    df, ens, ens_v = evaluate_pool(pool, Xb, M, sp, prior, prior_v)
    df = add_stats(df, test_days, int(y[sp == 2].sum()))
    sigc = ['d_n', 'd_pos', 'v_n', 'v_pos', 't_n', 't_pos', 'd_days', 't_days']
    df = df.sort_values(['depth', 'd_score'], ascending=[True, False]).drop_duplicates(sigc)   # 跨準則邏輯等價規則只留一條
    df['text'] = [rule_text(r, names, cuts) for r in df['rule']]
    tag = f'a31_c_{run}'
    df.drop(columns=['rule']).sort_values('d_score', ascending=False).to_csv(f'{OUT}/{tag}_pool.csv', index=False)
    np.savez_compressed(f'{SP}/{tag}_ens.npz', idx=M['idx'], ens=ens.astype(np.float32), ens_v=ens_v.astype(np.float32),
                        sp=sp, s=s, y=y, buy=M['buy'], y_lu=M['y_lu'])

    cols_show = ['crit', 'depth', 'd_n', 'd_prec', 'd_days', 'v_n', 'v_prec', 't_n', 't_prec', 't_days', 't_maxshare', 't_wlb', 't_buyprec', 'text']
    fmt = lambda d: d[cols_show].round(3).to_string(index=False, max_colwidth=160)
    sel = []
    for crit, *_ in crits:
        dd = df[df.crit == crit].sort_values('d_score', ascending=False)
        log(f'\n  ① DESIGN 前 8 名（準則 {crit}）'); log(fmt(dd.head(8)))
        sel.append(dd.head(1).assign(selector=f'{run}:D-top1[{crit}]'))
    has_v = (sp == 1).any()
    if has_v:
        dv = df[(df.v_n >= 20)].copy()
        dv['dv_min'] = np.minimum(dv.d_prec, dv.v_prec)
        dv = dv.sort_values('dv_min', ascending=False)
        log(f'\n  ② DESIGN+VALID 確認（VALID ≥20 筆，依 min(D,V) 精準度）前 12 名'); log(fmt(dv.head(12)))
        sel.append(dv.head(1).assign(selector=f'{run}:DV-top1'))
        dvs = dv[dv.crit.str.endswith('_sp')]
        if len(dvs):
            log(f'\n  ②′ 同上但只限「分散」規則（DESIGN ≥{sd} 日、單日 ≤{ss_:.0%}）前 8 名'); log(fmt(dvs.head(8)))
            sel.append(dvs.head(1).assign(selector=f'{run}:DV-top1[spread]'))
        for K in (5, 10, 20):                                       # 前 K 條規則的聯集（任一條命中即選）
            um = np.zeros(len(sp), bool)
            for r in dv.head(K)['rule']: um |= rule_mask(r, Xb)
            row = {'selector': f'{run}:DV-top{K}-union', 'crit': 'union', 'depth': np.nan, 'text': f'DV 前 {K} 條規則任一命中'}
            for t, nm in ((0, 'd'), (1, 'v'), (2, 't')):
                mm = um & (sp == t); row[f'{nm}_n'] = int(mm.sum()); row[f'{nm}_pos'] = int(y[mm].sum())
                row[f'{nm}_prec'] = y[mm].mean() if mm.any() else np.nan; row[f'{nm}_days'] = len(np.unique(s[mm]))
            mt_ = um & (sp == 2)
            row.update(t_buyprec=M['buy'][mt_].mean() if mt_.any() else np.nan, t_luprec=M['y_lu'][mt_].mean() if mt_.any() else np.nan,
                       t_picks_per_day=mt_.sum() / test_days, t_wlb=float(wilson_lb(row['t_pos'], row['t_n'])),
                       t_recall=row['t_pos'] / max(int(y[sp == 2].sum()), 1),
                       t_maxshare=float(np.bincount(s[mt_]).max() / mt_.sum()) if mt_.any() else np.nan)
            log(f'  ② DV 前 {K} 條聯集：DESIGN {row["d_prec"]:.3f}（{row["d_n"]}）VALID {row["v_prec"]:.3f}（{row["v_n"]}）'
                f'TEST {row["t_prec"]:.3f}（{row["t_n"]} 筆、{row["t_days"]} 日）可買 {row["t_buyprec"]:.3f}')
            sel.append(pd.DataFrame([row]))
    tt = df[df.t_n >= 30].sort_values('t_prec', ascending=False)
    log(f'\n  ③ TEST 事後最佳（≥30 筆；**用 TEST 挑選＝有選擇偏誤的上限**，{len(tt):,} 條中）'); log(fmt(tt.head(8)))
    sel.append(tt.head(1).assign(selector=f'{run}:TEST-oracle(≥30)'))

    # 過度擬合：依 DESIGN 精準度分組，看 VALID/TEST 的 n 加權精準度
    df = df.drop(columns=['rule'])
    df['d_bucket'] = pd.cut(df.d_prec, [0, .2, .3, .4, .5, .6, .7, .8, .9, 1.01])
    g = df[df.t_n > 0].groupby('d_bucket', observed=True).apply(
        lambda q: pd.Series(dict(rules=len(q), d=(q.d_pos.sum() / q.d_n.sum()), v=(q.v_pos.sum() / max(q.v_n.sum(), 1)),
                                 t=(q.t_pos.sum() / q.t_n.sum()), t_rules_ge30=(q.t_n >= 30).sum(),
                                 t_best_ge30=q[q.t_n >= 30].t_prec.max() if (q.t_n >= 30).any() else np.nan)))
    log('\n  過度擬合：依 DESIGN 精準度分組（n 加權；同一列可能被多條規則重複計）'); log(g.round(3).to_string())

    # 規則集成分數的前沿（D+V 縮減精準度，TEST 不參與）
    mt = sp == 2
    fr = None
    for nm_e, E_ in (('D+V 縮減', ens), ('VALID 縮減', ens_v)):
        if nm_e.startswith('VALID') and not (sp == 1).any(): continue
        f_ = frontier(E_[mt], s[mt], y[mt], M['buy'][mt], np.random.default_rng(0)); fr = fr or f_
        log(f'\n  規則集成（每列取所命中規則中 {nm_e}精準度最高者）TEST 前沿：')
        for k, (n, pr, bp) in f_.items(): log(f'    {k:>14}：n {n:>5}  精準 {pr:.3f}  可買漲停 {bp:.3f}')
        for th in (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
            m2 = mt & (E_ >= th)
            if m2.sum(): log(f'    分數 ≥ {th:.1f}：TEST n {int(m2.sum()):>5}、日數 {len(np.unique(s[m2])):>3}、精準 {y[m2].mean():.3f}、可買 {M["buy"][m2].mean():.3f}')
    S = pd.concat(sel)
    S['run'] = run
    return S, fr, df


def main():
    runs = sys.argv[1:] or ['a', 'b', 'c', 'bd']
    os.makedirs(OUT, exist_ok=True)
    logf = open(f'{OUT}/a31_c_rules_search_{"_".join(runs)}.log', 'w')

    def log(msg):
        print(msg, flush=True); logf.write(msg + '\n'); logf.flush()
    log(f'a31 C 規則搜尋 {time.strftime("%Y-%m-%d %H:%M")}；beam {BEAM_W}、每父 {PER_PARENT}、深度 {DEPTH}、最少日數 {MIN_DAYS}')
    allsel = []
    for r in runs:
        S, fr, _ = run_one(r, log)
        allsel.append(S)
    S = pd.concat(allsel)
    keep = ['run', 'selector', 'crit', 'depth', 'd_n', 'd_prec', 'v_n', 'v_prec', 't_n', 't_pos', 't_prec', 't_days', 't_picks_per_day',
            't_maxshare', 't_wlb', 't_buyprec', 't_luprec', 't_recall', 'text']
    S[keep].to_csv(f'{OUT}/a31_c_selected_{"_".join(runs)}.csv', index=False)
    log('\n══ 選出的規則總表'); log(S[keep].round(3).to_string(index=False, max_colwidth=200))


if __name__ == '__main__':
    main()
