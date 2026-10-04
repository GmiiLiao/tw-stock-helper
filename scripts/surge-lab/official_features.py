"""官方資料特徵（2026-10-04 使用者：訓練資料一律用上市／上櫃官網來源，重新訓練起漲特徵模型）。

來源：official_backfill.mjs 存在 .surge-cache/official/{資料集}/{日}.json.gz 的官網原始回應（資料日已回聲驗證）。
  twse_daily  MI_INDEX（ALLBUT0999）  成交股數／成交筆數／成交金額
  tpex_daily  dailyQuotes             成交股數／成交筆數／成交金額(元)／發行股數
  twse_qfiis  MI_QFIIS                發行股數／全體外資及陸資持股比率／尚可投資比率
  twse_t86    T86                     自營商買賣超股數（自行買賣、避險）
  tpex_insti  insti/dailyTrade        7 組×(買,賣,超)＋合計；組序以「合計＝外資合計＋投信＋自營合計」等三條恆等式驗證：
                                      0 外陸資(不含外資自營) 1 外資自營 2 外資合計 3 投信 4 自營(自行買賣) 5 自營(避險) 6 自營合計
  tpex_daytrade intraday/stat tables[1] 逐檔當日沖銷交易成交股數（daemon 只用 tables[0] 的市場總計）
  twse_limit  TWT84U 股價升降幅度     當日官方漲停價／跌停價（上市）；上櫃取前一交易日 dailyQuotes 的「次日 漲停價／跌停價」
              ⇒ 官方逐檔漲停／跌停判定（收盤＝漲停價）、觸及漲停未鎖（最高＝漲停價、收盤＜漲停價）、一字鎖、跌停歷史；並與推算規則逐格對照
  mops_t163sb04 公開資訊觀測站綜合損益表彙總（季；Q2～Q4 為年初累計 ⇒ 換算單季）：營收、毛利、營業利益、淨利、EPS
另用既有官方日線（panel：收盤、量；build.build_events 的漲停）衍生「股性」與「套牢量」，月營收（revenueArchive，官方）衍生創新高／連續年增；
台股 wiki（second-brain/wiki/_graph/stocks.json）的官方產業別（MOPS t05st03）衍生同產業共振，取代覆蓋 67% 的 peerComps 產業；
集團（wiki 由官方董監／法人持股推導的單一最大法人股東樹）是 2026-10 的靜態快照，回測有前視 ⇒ 只做實驗組、不併入 all。

PIT：全部只用 ≤ s 的資料；月營收的來源檔與可用日與 build.revenue_matrices 共用（B.load_revenue／B.revenue_avail_index：
     SURGE_REVENUE 換來源檔、SURGE_PIT_STRICT=1 改「次月 10 日期限遇休市順延後的下一交易日」）；
輸出：把新特徵（f_o_*）與 m_tdr（91xx 台灣存託憑證，評估時排除）附加到既有資料集的同一批列 → dataset_{t1,t2,lu1}_off.npz。
用法：SURGE_CACHE=<快取目錄> python3 official_features.py [--only t1,t2,lu1]
"""
import gzip, json, os, re, sys, glob
import numpy as np, pandas as pd
import build as B

OFF = os.path.join(B.SP, 'official')
TPEX_INSTI_GROUPS = 7


def num(x):
    s = str(x).replace(',', '').strip()
    if s in ('', '--', '-', 'X', 'N/A'): return np.nan
    try: return float(s)
    except ValueError: return np.nan


def table_of(raw, must, code=None):
    """第一張同時含 must 欄與代號欄的逐檔表（上市 MI_INDEX 另有「大盤統計」表也有成交筆數欄）。"""
    tabs = raw.get('tables') or [{'fields': raw.get('fields'), 'data': raw.get('data')}]
    for t in tabs:
        f = t.get('fields') or []
        if must in f and (code is None or code in f) and t.get('data'): return f, t['data']
    return None, None


def load_matrices(dates, codes):
    T, N = len(dates), len(codes)
    di = {d: i for i, d in enumerate(dates)}; ci = {c: i for i, c in enumerate(codes)}
    keys = ['VOLSH', 'TRADES', 'VALUE', 'SHOUT', 'FHOLD', 'FROOM', 'DSELF', 'DHEDGE', 'DTSH', 'LIMUP', 'LIMDN', 'NXUP', 'NXDN']
    M = {k: np.full((T, N), np.nan, dtype=np.float64) for k in keys}
    cov = {}

    def each(ds):
        files = sorted(glob.glob(os.path.join(OFF, ds, '*.json.gz')))
        cov[ds] = len(files)
        for f in files:
            day = os.path.basename(f)[:10]
            t = di.get(day)
            if t is None: continue
            yield t, json.load(gzip.open(f))['raw']

    def put(t, fields, data, codecol, cols):
        ix = {k: fields.index(v) for k, v in cols.items()}; icode = fields.index(codecol)
        for row in data:
            j = ci.get(str(row[icode]).strip())
            if j is None: continue
            for k, i in ix.items(): M[k][t, j] = num(row[i])

    for t, raw in each('twse_daily'):
        f, d = table_of(raw, '成交筆數', '證券代號')
        if f: put(t, f, d, '證券代號', {'VOLSH': '成交股數', 'TRADES': '成交筆數', 'VALUE': '成交金額'})
    for t, raw in each('tpex_daily'):
        f, d = table_of(raw, '成交筆數', '代號')
        if f:
            cols = {'VOLSH': '成交股數', 'TRADES': '成交筆數', 'VALUE': '成交金額(元)', 'SHOUT': '發行股數'}
            if '次日 漲停價' in f: cols.update({'NXUP': '次日 漲停價', 'NXDN': '次日 跌停價'})
            put(t, f, d, '代號', cols)
    for t, raw in each('twse_qfiis'):
        f, d = table_of(raw, '發行股數')
        if f: put(t, f, d, '證券代號', {'SHOUT': '發行股數', 'FHOLD': '全體外資及陸資持股比率', 'FROOM': '外資及陸資尚可投資比率'})
    for t, raw in each('twse_t86'):
        f, d = table_of(raw, '自營商買賣超股數(避險)')
        if f: put(t, f, d, '證券代號', {'DSELF': '自營商買賣超股數(自行買賣)', 'DHEDGE': '自營商買賣超股數(避險)'})
    bad_insti = 0
    for t, raw in each('tpex_insti'):
        f, d = table_of(raw, '三大法人買賣超股數合計')
        if not f: continue
        for row in d:
            j = ci.get(str(row[0]).strip())
            if j is None: continue
            v = [num(x) for x in row[2:]]
            if len(v) != TPEX_INSTI_GROUPS * 3 + 1: bad_insti += 1; continue
            g = [v[i * 3 + 2] for i in range(TPEX_INSTI_GROUPS)]
            if abs(g[2] + g[3] + g[6] - v[-1]) > 1: bad_insti += 1; continue      # 組序驗證失敗就不收
            M['DSELF'][t, j] = g[4]; M['DHEDGE'][t, j] = g[5]
    for t, raw in each('tpex_daytrade'):
        f, d = table_of(raw, '當日沖銷交易成交股數')
        if f: put(t, f, d, '證券代號', {'DTSH': '當日沖銷交易成交股數'})
    for t, raw in each('twse_limit'):
        f, d = table_of(raw, '漲停價', '證券代號')
        if f: put(t, f, d, '證券代號', {'LIMUP': '漲停價', 'LIMDN': '跌停價'})
    # 上櫃：t 日的漲跌停價＝前一交易日 dailyQuotes 公布的「次日」價（只在上市沒有值的格子補）
    nxu = np.full_like(M['NXUP'], np.nan); nxd = np.full_like(M['NXDN'], np.nan); nxu[1:] = M['NXUP'][:-1]; nxd[1:] = M['NXDN'][:-1]
    M['LIMUP'] = np.where(np.isfinite(M['LIMUP']), M['LIMUP'], nxu); M['LIMDN'] = np.where(np.isfinite(M['LIMDN']), M['LIMDN'], nxd)
    cov['tpex_insti_bad_rows'] = bad_insti
    return M, cov


def lu_traits(LU, win=250, prior_w=2.0):
    """股性：過去 win 日內「漲停後隔日再漲停」的比例（向全市場同窗比例收縮）與連板起點次數。只用 t'+1 ≤ s 的完成事件。"""
    T, N = LU.shape
    L = LU.astype(float)
    cont = np.zeros_like(L); cont[:-1] = L[:-1] * L[1:]             # cont[t']：t' 漲停且 t'+1 也漲停
    start2 = np.zeros_like(L); start2[1:-1] = L[1:-1] * L[2:] * (1 - L[:-2])
    # 在 s 日只能看到 t' ≤ s−1 的事件（需要 t'+1 ≤ s）
    def past_sum(X):
        c = pd.DataFrame(X).rolling(win, min_periods=1).sum().values
        out = np.full_like(c, np.nan); out[1:] = c[:-1]; return out
    n_lu, n_cont, n_st = past_sum(L), past_sum(cont), past_sum(start2)
    with np.errstate(all='ignore'):
        p0 = np.nansum(n_cont, 1) / np.maximum(np.nansum(n_lu, 1), 1)          # 全市場同窗比例（PIT）
        rate = (n_cont + prior_w * p0[:, None]) / (n_lu + prior_w)
    return rate, n_st


def overhead(Ca, V, win):
    """套牢量：過去 win 日成交量中，收盤價高於 s 日收盤的比例（以還原收盤代表當日成交價位）。"""
    T, N = Ca.shape
    num_ = np.zeros((T, N)); den = np.zeros((T, N))
    for k in range(1, win + 1):
        Cp = np.full((T, N), np.nan); Cp[k:] = Ca[:-k]
        Vp = np.full((T, N), np.nan); Vp[k:] = V[:-k]
        ok = np.isfinite(Cp) & np.isfinite(Vp)
        den += np.where(ok, Vp, 0); num_ += np.where(ok & (Cp > Ca), Vp, 0)
    with np.errstate(all='ignore'):
        out = num_ / den
    out[den <= 0] = np.nan
    return out


def revenue_traits(dates, codes):
    """月營收創 12 月新高、連續年增月數。來源檔與可用日與 build.revenue_matrices 共用同一個函式
    （B.load_revenue／B.revenue_avail_index：SURGE_REVENUE、SURGE_PIT_STRICT 兩處同時生效）。"""
    rev = B.load_revenue()
    T, N = len(dates), len(codes); ci = {c: i for i, c in enumerate(codes)}; d_arr = np.array(dates)
    hi12 = np.full((T, N), np.nan); ystreak = np.full((T, N), np.nan)
    months = sorted(rev.keys()); hist = {}; streak = {}
    for mi, m in enumerate(months):
        t0 = B.revenue_avail_index(d_arr, m)
        t1 = min(B.revenue_avail_index(d_arr, months[mi + 1]), T) if mi + 1 < len(months) else T
        for r in rev[m]['rows']:
            c = r['c']; h = hist.setdefault(c, [])
            v = r.get('rev'); y = r.get('yoy')
            streak[c] = (streak.get(c, 0) + 1) if (y is not None and y > 0) else 0
            j = ci.get(c)
            if j is not None and t0 < T:
                if v is not None and len(h) >= 11: hi12[t0:t1, j] = float(v >= max(h[-11:]))
                if y is not None: ystreak[t0:t1, j] = streak[c]
            if v is not None: h.append(v)
    return hi12, ystreak


FIN_DUE = {1: '06-01', 2: '09-01', 3: '12-01'}            # 各業最晚法定期限翌日（金融業 Q1/Q2/Q3 期限較晚，一律取最晚）；Q4＝次年 04-01


def _fin_pick(hdr, row):
    def first(cands, contains=False):
        for c in cands:
            for i, h in enumerate(hdr):
                if (c in h) if contains else (h == c): return num(row[i])
        return np.nan
    rev = first(['營業收入', '淨收益', '收益', '收入'])
    gp = first(['營業毛利（毛損）淨額', '營業毛利（毛損）'])
    op = first(['營業利益（損失）', '營業利益'])
    ni = first(['淨利（淨損）歸屬於母公司業主', '淨利（損）歸屬於母公司業主'])
    if not np.isfinite(ni): ni = first(['本期淨利（淨損）', '本期稅後淨利（淨損）'])
    eps = first(['基本每股盈餘（元）'])
    return dict(rev=rev, gp=gp, op=op, ni=ni, eps=eps)


def load_fin():
    """{(code, 西元年, 季): 累計值 dict}——t163sb04 原始 HTML 解析（bs4）。"""
    from bs4 import BeautifulSoup
    out = {}
    for f in sorted(glob.glob(os.path.join(OFF, 'mops_t163sb04', '*.html.gz'))):
        typek, roc, ss = os.path.basename(f)[:-8].split('_'); y, q = int(roc) + 1911, int(ss)
        soup = BeautifulSoup(gzip.open(f).read().decode('utf-8', 'replace'), 'html.parser')
        for tb in soup.find_all('table'):
            hdr = None
            for tr in tb.find_all('tr'):
                ths = [th.get_text(strip=True) for th in tr.find_all('th')]
                if ths and any('公司' in h and '代號' in h for h in ths): hdr = ths; continue
                tds = [td.get_text(strip=True) for td in tr.find_all('td')]
                if hdr and tds and len(tds) == len(hdr) and re.fullmatch(r'\d{4}', tds[0]): out[(tds[0], y, q)] = _fin_pick(hdr, tds)
    return out


def fin_singles(cum):
    """年初累計 → 單季（Q1 原值；Qn＝累計n−累計n−1，任一缺就缺）。"""
    single = {}
    for (c, y, q), v in cum.items():
        if q == 1: single[(c, y, q)] = dict(v); continue
        p = cum.get((c, y, q - 1))
        single[(c, y, q)] = {k: (v[k] - p[k]) if p is not None and np.isfinite(v[k]) and np.isfinite(p[k]) else np.nan for k in v} if p else {k: np.nan for k in v}
    return single


def fin_features(dates, codes, Craw):
    """每個 s 日用「已過法定期限」的最新一季：EPS 年增（÷股價）、TTM 本益比倒數、毛利率／營益率年變、季營收年增、轉虧為盈。"""
    cum = load_fin(); sg = fin_singles(cum)
    T, N = len(dates), len(codes); ci = {c: i for i, c in enumerate(codes)}; d_arr = np.array(dates)
    keys = ['eps_yoy_p', 'ep_ttm', 'gm', 'gm_yoy', 'om_yoy', 'rev_q_yoy', 'turnaround']
    F = {k: np.full((T, N), np.nan) for k in keys}
    qs = sorted({(y, q) for (_, y, q) in sg})
    def avail(y, q): return f'{y + 1}-04-01' if q == 4 else f'{y}-{FIN_DUE[q]}'
    def prevq(y, q, k):
        for _ in range(k): y, q = (y, q - 1) if q > 1 else (y - 1, 4)
        return y, q
    for i, (y, q) in enumerate(qs):
        t0 = int(np.searchsorted(d_arr, avail(y, q)))
        t1 = int(np.searchsorted(d_arr, avail(*qs[i + 1]))) if i + 1 < len(qs) else T
        if t0 >= T or t1 <= t0: continue
        for c, j in ci.items():
            cur = sg.get((c, y, q))
            if cur is None: continue
            ly = sg.get((c, *prevq(y, q, 4))); pq = sg.get((c, *prevq(y, q, 1)))
            ttm = [sg.get((c, *prevq(y, q, k))) for k in range(4)]
            sl = slice(t0, t1); px = Craw[sl, j]
            with np.errstate(all='ignore'):
                if ly and np.isfinite(cur['eps']) and np.isfinite(ly['eps']): F['eps_yoy_p'][sl, j] = (cur['eps'] - ly['eps']) / px
                if all(x and np.isfinite(x['eps']) for x in ttm): F['ep_ttm'][sl, j] = sum(x['eps'] for x in ttm) / px
                gm = cur['gp'] / cur['rev'] if cur['rev'] and cur['rev'] > 0 else np.nan; F['gm'][sl, j] = gm
                if ly and ly['rev'] and ly['rev'] > 0:
                    F['gm_yoy'][sl, j] = gm - ly['gp'] / ly['rev']
                    F['om_yoy'][sl, j] = cur['op'] / cur['rev'] - ly['op'] / ly['rev'] if cur['rev'] and cur['rev'] > 0 else np.nan
                    F['rev_q_yoy'][sl, j] = cur['rev'] / ly['rev'] - 1
                if pq and np.isfinite(cur['ni']) and np.isfinite(pq['ni']): F['turnaround'][sl, j] = float(cur['ni'] > 0 and pq['ni'] <= 0)
    return {f'o_fin_{k}': v for k, v in F.items()}, len(cum)


def wiki_map(field):
    """台股 wiki stocks.json：代號 → 欄位值（industry＝MOPS t05st03 官方產業別；group＝推導集團名）。"""
    p = os.path.join(os.path.dirname(B.SP.rstrip('/')), '..', '..', 'second-brain', 'wiki', '_graph', 'stocks.json')
    p = os.environ.get('WIKI_STOCKS', os.path.normpath(p))
    st = json.load(open(p))['stocks']
    return {c: v.get(field) for c, v in st.items() if v.get(field)}


def cohort_features(codes, label, LU, el, r5, prefix, min_size=2):
    """同一分組（產業或集團）排除自己：當日漲停數、近 5 日漲停數、漲停占比、同組 5 日平均漲幅與相對強弱。"""
    names = sorted({v for v in label.values()}); ni = {n: k for k, n in enumerate(names)}
    Mi = np.zeros((len(codes), len(names)))
    for j, c in enumerate(codes):
        if c in label: Mi[j, ni[label[c]]] = 1
    has = Mi.sum(1) > 0
    LUe = np.where(el, LU, 0).astype(float); size = np.where(el, 1.0, 0.0) @ Mi
    own_cnt = (LUe @ Mi) @ Mi.T; own_size = size @ Mi.T
    F = {}
    with np.errstate(all='ignore'):
        cnt = np.where(has[None, :] & (own_size >= min_size), own_cnt - LUe, np.nan)
        F[f'{prefix}_lu_cnt'] = cnt; F[f'{prefix}_lu_share'] = cnt / np.maximum(own_size - 1, 1)
        F[f'{prefix}_lu_cnt5'] = pd.DataFrame(cnt).rolling(5, min_periods=1).sum().values
        r5e = np.where(el, r5, np.nan); r5z = np.nan_to_num(r5e)
        s_ = (r5z @ Mi) @ Mi.T; n_ = (np.isfinite(r5e).astype(float) @ Mi) @ Mi.T
        mean_ex = (s_ - r5z) / np.maximum(n_ - np.isfinite(r5e), 1)
        F[f'{prefix}_r5'] = np.where(has[None, :] & (own_size >= min_size), mean_ex, np.nan); F[f'{prefix}_r5_rel'] = r5 - F[f'{prefix}_r5']
    return F


def official_limit_flags(P, M):
    """官方漲跌停判定（原始未還原價對官方漲跌停價）：LU 收盤＝漲停價、LD 收盤＝跌停價、TOUCH 盤中觸及漲停但未收在漲停、ONE 一字鎖漲停。"""
    C, H, O, L = P['C'], P['H'], P['O'], P['L']; U, Dn = M['LIMUP'], M['LIMDN']
    ok = np.isfinite(C) & np.isfinite(U) & (U > 0)
    _, nolim = B.official_limit_masks(U)                    # 9995／0.01 佔位＝無漲跌幅：不算漲停／跌停／觸及（ok 不動，滾動計數照舊）
    eps = 1e-6
    with np.errstate(all='ignore'):
        LU = ok & (C >= U - eps) & ~nolim; LD = np.isfinite(C) & np.isfinite(Dn) & (Dn > 0) & (C <= Dn + eps) & ~nolim
        TOUCH = ok & np.isfinite(H) & (H >= U - eps) & ~LU & ~nolim
        ONE = LU & np.isfinite(O) & np.isfinite(L) & (O >= U - eps) & (L >= U - eps)
    return dict(ok=ok, LU=LU, LD=LD, TOUCH=TOUCH, ONE=ONE)


def limit_features(P, M, LU_rule):
    """官方漲跌停衍生特徵（只用 ≤ s）＋與推算規則（build.build_events）的逐格對照。"""
    g = official_limit_flags(P, M); ok = g['ok']
    roll = lambda X, k: pd.DataFrame(np.where(ok, X, np.nan).astype(float)).rolling(k, min_periods=1).sum().values
    F = {'o_ld_cnt20': roll(g['LD'], 20), 'o_ld_cnt60': roll(g['LD'], 60), 'o_touch_lu_s': np.where(ok, g['TOUCH'], np.nan).astype(float),
         'o_touch_lu20': roll(g['TOUCH'], 20), 'o_oneword_cnt20': roll(g['ONE'], 20), 'o_lu_off_cnt20': roll(g['LU'], 20)}
    last_ld = np.full(P['C'].shape, np.nan); run = np.full(P['C'].shape[1], np.nan)
    for t in range(P['C'].shape[0]):
        run = np.where(g['LD'][t], 0.0, run + 1); last_ld[t] = run
    F['o_ld_days_since'] = np.where(np.isfinite(last_ld), last_ld, 999.0)
    # 市場層（全市場同值）：官方漲停／跌停家數與比值
    n_lu = g['LU'].sum(1).astype(float); n_ld = g['LD'].sum(1).astype(float); N = P['C'].shape[1]
    F['mkt_lu_off'] = np.repeat(n_lu[:, None], N, 1); F['mkt_ld_off'] = np.repeat(n_ld[:, None], N, 1)
    F['mkt_lu_ld_ratio'] = np.repeat(((n_lu + 1) / (n_ld + 1))[:, None], N, 1)
    both = ok & np.isfinite(P['C']); both[0, :] = False      # 面板第一天沒有前一日收盤，推算規則必判否——不列入對照
    agree = (g['LU'] == LU_rule)[both]
    chk = dict(cells=int(both.sum()), agree=f'{agree.mean() * 100:.3f}%', official_lu=int(g['LU'][both].sum()), rule_lu=int(LU_rule[both].sum()),
               official_only=int((g['LU'] & ~LU_rule & both).sum()), rule_only=int((~g['LU'] & LU_rule & both).sum()))
    dt, dj = np.nonzero((g['LU'] != LU_rule) & both)
    chk['_cells'] = [(int(t), int(j), float(P['C'][t, j]), float(M['LIMUP'][t, j]), bool(g['LU'][t, j])) for t, j in zip(dt, dj)]
    return F, chk


def compute(dates, codes, P, A, EV):
    M, cov = load_matrices(dates, codes)
    Craw = P['C']; V = P['V']; Ca = A['C']
    df = pd.DataFrame
    r20 = lambda X: df(X).rolling(20, min_periods=15).mean().values
    r5 = lambda X: df(X).rolling(5, min_periods=4).mean().values
    F = {}
    with np.errstate(all='ignore'):
        lot = M['VOLSH'] / M['TRADES'] / 1000.0; lot[~np.isfinite(lot)] = np.nan
        F['o_avglot'] = lot; F['o_avglot_r'] = lot / r20(lot); F['o_avglot_5_20'] = r5(lot) / r20(lot)
        F['o_trades_vr20'] = M['TRADES'] / r20(M['TRADES'])
        vwap = M['VALUE'] / M['VOLSH']; dev = Craw / vwap - 1; dev[~np.isfinite(dev)] = np.nan
        F['o_vwap_dev'] = dev; F['o_vwap_dev5'] = r5(dev)
        shout = df(M['SHOUT']).ffill(limit=5).values                      # 發行股數偶有缺日：最多沿用 5 日
        F['o_log_mcap'] = np.log10(Craw * shout)
        turn = M['VOLSH'] / shout; F['o_turn'] = turn; F['o_turn20'] = r20(turn); F['o_turn_r'] = turn / r20(turn)
        F['o_fhold'] = M['FHOLD']; F['o_fhold_chg5'] = M['FHOLD'] - df(M['FHOLD']).shift(5).values
        F['o_fhold_chg20'] = M['FHOLD'] - df(M['FHOLD']).shift(20).values; F['o_froom'] = M['FROOM']
        av20 = df(V).rolling(20, min_periods=16).mean().replace(0, np.nan).values
        for k in (1, 5, 20):
            F[f'o_dself_{k}'] = df(M['DSELF'] / 1000).rolling(k, min_periods=max(1, int(k * .8))).sum().values / av20
            F[f'o_dhedge_{k}'] = df(M['DHEDGE'] / 1000).rolling(k, min_periods=max(1, int(k * .8))).sum().values / av20
        dt_all = np.where(np.isfinite(P['DT']), P['DT'], M['DTSH'] / 1000.0)  # 上市沿用既有 dayTradeJson（張），上櫃補官方逐檔表
        F['o_dt_ratio_all'] = dt_all / np.where(V > 0, V, np.nan)
        F['o_dt_ratio20_all'] = df(dt_all).rolling(20, min_periods=15).sum().values / df(V).rolling(20, min_periods=15).sum().replace(0, np.nan).values
    rate, nst = lu_traits(EV['LU'])
    F['o_lu_follow'] = rate; F['o_lu2_starts250'] = nst
    F['o_overhead60'] = overhead(Ca, V, 60); F['o_overhead240'] = overhead(Ca, V, 240)
    hi12, ystreak = revenue_traits(dates, codes)
    F['o_rev_hi12'] = hi12; F['o_rev_yoy_streak'] = ystreak
    lim, chk = limit_features(P, M, EV['LU']); F.update(lim); cov['limit_check'] = chk
    fin, n_fin = fin_features(dates, codes, Craw); F.update(fin); cov['fin_rows'] = n_fin
    cov['revenue_source'] = os.path.basename(B.revenue_path()); cov['pit_strict'] = os.environ.get('SURGE_PIT_STRICT') == '1'
    el = np.isfinite(Craw) & (Craw >= B.MIN_PRICE)
    r5 = (df(Ca) / df(Ca).shift(5) - 1).values
    ind = wiki_map('industry'); grp = wiki_map('group')
    F.update(cohort_features(codes, ind, EV['LU'], el, r5, 'o_ind'))
    F.update(cohort_features(codes, grp, EV['LU'], el, r5, 'o_grp'))
    cov['wiki_industry_codes'] = sum(c in ind for c in codes); cov['wiki_group_codes'] = sum(c in grp for c in codes)
    # 驗證：官方成交股數÷1000 應等於 panel 的量（張）
    with np.errstate(all='ignore'):
        both = np.isfinite(M['VOLSH']) & np.isfinite(V) & (V > 0)
        agree = np.abs(M['VOLSH'][both] / 1000.0 - V[both]) <= np.maximum(1, 0.001 * V[both])
    cov['volume_agree'] = f'{agree.mean() * 100:.2f}%（{int(both.sum()):,} 格）'
    cov['coverage'] = {k: f'{np.isfinite(v).mean() * 100:.1f}%' for k, v in F.items()}
    return {k: np.asarray(v, dtype=np.float32) for k, v in F.items()}, cov


GROUPS = {
    'micro': ['o_avglot', 'o_avglot_r', 'o_avglot_5_20', 'o_trades_vr20', 'o_vwap_dev', 'o_vwap_dev5'],
    'size': ['o_log_mcap', 'o_turn', 'o_turn20', 'o_turn_r'],
    'fhold': ['o_fhold', 'o_fhold_chg5', 'o_fhold_chg20', 'o_froom'],
    'dealer': [f'o_{a}_{k}' for a in ('dself', 'dhedge') for k in (1, 5, 20)],
    'dt_all': ['o_dt_ratio_all', 'o_dt_ratio20_all'],
    'trait': ['o_lu_follow', 'o_lu2_starts250'],
    'overhead': ['o_overhead60', 'o_overhead240'],
    'rev': ['o_rev_hi12', 'o_rev_yoy_streak'],
    'fin': ['o_fin_eps_yoy_p', 'o_fin_ep_ttm', 'o_fin_gm', 'o_fin_gm_yoy', 'o_fin_om_yoy', 'o_fin_rev_q_yoy', 'o_fin_turnaround'],
    'ind_off': ['o_ind_lu_cnt', 'o_ind_lu_share', 'o_ind_lu_cnt5', 'o_ind_r5', 'o_ind_r5_rel'],
    'limit': ['o_ld_cnt20', 'o_ld_cnt60', 'o_ld_days_since', 'o_touch_lu_s', 'o_touch_lu20', 'o_oneword_cnt20', 'o_lu_off_cnt20', 'mkt_lu_off', 'mkt_ld_off', 'mkt_lu_ld_ratio'],
}
# 實驗組（不併入 all）：集團是 2026-10 的靜態快照，回測有前視
EXPERIMENTAL = {'grp': ['o_grp_lu_cnt', 'o_grp_lu_share', 'o_grp_lu_cnt5', 'o_grp_r5', 'o_grp_r5_rel']}
# 官方化：原有特徵中來源非官方者（peerComps 產業共振），official 模型以 ind_off 取代
NON_OFFICIAL_BASE = ['ind_lu_cnt', 'ind_lu_cnt5', 'ind_lu_share', 'ind_r5', 'ind_r5_rel']


def main():
    only = sys.argv[sys.argv.index('--only') + 1].split(',') if '--only' in sys.argv else ['t1', 't2', 'lu1']
    dates, codes, P = B.load_panel()
    A, F_day, _ = B.adjust(dates, codes, P, B.load_factor_events(dates, codes))
    EV = B.build_events(P, A, F_day)
    F, cov = compute(dates, codes, P, A, EV)
    cells = cov['limit_check'].pop('_cells', [])
    pd.DataFrame([dict(date=dates[t], code=codes[j], close=c, official_limit_up=u, official_lu=o, rule_lu=not o) for t, j, c, u, o in cells],
                 columns=['date', 'code', 'close', 'official_limit_up', 'official_lu', 'rule_lu']).to_csv(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'official_limit_disagree.csv'), index=False)
    print('官方檔數', {k: v for k, v in cov.items() if k not in ('coverage',)})
    print('特徵覆蓋（全格）', cov['coverage'])
    tdr = np.array([c.startswith('91') and len(c) == 4 for c in codes])
    for task in only:
        src = f'{B.SP}/dataset_{task}.npz'
        d = dict(np.load(src))
        s, j = d['m_s'], d['m_j']
        assert list(d['codes']) == list(codes) and list(d['dates']) == list(dates), f'{src} 的代號／日期順序與 panel 不同——m_s／m_j 會對錯格'
        for k, v in F.items(): d[f'f_{k}'] = v[s, j]
        d['m_tdr'] = tdr[j].astype(np.int8)
        out = f'{B.SP}/dataset_{task}_off.npz'
        np.savez_compressed(out, **d)
        print(f'[{task}] {len(s):,} 列；新特徵 {len(F)}；TDR 列 {int(d["m_tdr"].sum())} → {out}')
        for k in F: print(f'   {k:<20} 有值 {np.isfinite(d[f"f_{k}"]).mean() * 100:5.1f}%')


if __name__ == '__main__':
    main()
