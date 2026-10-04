"""起漲特徵實驗·資料集建置（2026-10-02）

問題：2025～2026 年很多個股出現「連 2 日漲停」或「5 日連漲 ≥30%」的強攻。起漲前一天（s = t-1）的收盤後，
      價量／均線／MACD／KD／籌碼／營收／產業／大盤環境各長什麼樣？

定義（全部在 build_events()）
  漲停 LU[t]   ：收盤 ≥ 依「除權息參考價」算出的 10% 漲停價（檔位取整）。除權息日用官方參考價，不用前收。
  事件 A       ：LU[t] ∧ LU[t+1]（連 2 日漲停收盤）
  事件 B       ：t..t+4 連 5 日收盤上漲 ∧ C[t+4]/C[t-1] ≥ 1.30（還原價）
  事件(SURGE)  ：A 或 B 的「起漲日 t」＝同一檔相鄰標記日合併成一段後的第一天；起漲前一天 s = t-1 的特徵即「起漲前特徵」。

母體（可進入資料集的 (s, 代號)；每一條都是為了讓「起漲前」與「對照」可比）
  普通股 4 碼（排 00xx ETF）、s 日收盤≥10 元、近 20 日均量 ≥300 張、近 130 日有 ≥125 日資料且近 20 日無缺值、
  s 當天沒有收盤漲停、s 前 10 日內不在另一段強攻（含冷卻）、前 125 日～後 5 日沒有價格結構斷點（減資／分割等）、
  s+5 ≤ 最後一日（標籤要看得到）。

所有特徵只用 ≤ s 的資料（pit_check.py 會截斷後重算驗證）。
"""
import json, os, sys
import numpy as np, pandas as pd

SP = os.environ.get('SURGE_CACHE', os.path.join(os.path.dirname(os.path.abspath(__file__)), '.surge-cache'))
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

MIN_PRICE, MIN_VOL20 = 10.0, 300.0
COOLDOWN = 10
HIST_NEED, HIST_WIN = 125, 130
BREAK_LO, BREAK_HI = 0.895, 1.105
B_RET, B_DAYS = 1.30, 5


# ───────────────────────── 檔位／漲停 ─────────────────────────
def tick_of(p):
    return np.where(p < 10, 0.01, np.where(p < 50, 0.05, np.where(p < 100, 0.1, np.where(p < 500, 0.5, np.where(p < 1000, 1.0, 5.0)))))

def limit_up_price(ref):
    raw = ref * 1.1
    tk = tick_of(raw)
    return np.floor(raw / tk + 1e-6) * tk

def round_tick(p):
    tk = tick_of(p)
    return np.round(p / tk) * tk


# ───────────────────────── 載入與還原 ─────────────────────────
def load_panel():
    z = np.load(f'{SP}/panel.npz')
    dates = list(z['dates']); codes = list(z['codes'])
    P = {k: z[k].astype(np.float64) for k in ('C', 'V', 'O', 'H', 'L', 'IF', 'IT', 'ML', 'MS', 'LEND', 'DT')}
    return dates, codes, P

def load_factor_events(dates, codes):
    """exright-history（除權息）＋ priceEvents（減資／面額變更）；同 (日期, 代號) 只套一次，以官方除權息係數優先。"""
    ex = json.load(open(os.path.join(REPO, 'scripts/data/exright-history.json')))['items']
    # exright-history.json 之後的官方除權息差額（fetch_exright_delta.mjs；目前只有上市——上櫃端點 2026-10-03 連不上）
    if os.path.exists(f'{SP}/exright_delta.json'): ex = ex + json.load(open(f'{SP}/exright_delta.json'))['items']
    pe = (json.load(open(f'{SP}/priceEvents.json')) or {}).get('items') or []
    seen, out = {}, []
    for e in ex:
        d, c, f = (e[0], e[1], e[2]) if isinstance(e, list) else (e['date'], e['code'], e['factor'])
        if (f or 0) > 0: seen[(c, d)] = ('exright', f)
    for e in pe:
        if (e.get('factor') or 0) > 0 and (e['code'], e['date']) not in seen: seen[(e['code'], e['date'])] = ('priceEvents', e['factor'])
    return [(c, d, s, f) for (c, d), (s, f) in seen.items()]

def adjust(dates, codes, P, events):
    """回傳還原價矩陣（事件日之前 × factor）與每日事件係數 F_day[t, j]（用於漲停價參考價）。"""
    T, N = P['C'].shape
    ci = {c: i for i, c in enumerate(codes)}
    d_arr = np.array(dates)
    cum = np.ones((T, N))
    F_day = np.ones((T, N))
    n_used = 0
    for code, d, src, f in events:
        j = ci.get(code)
        if j is None: continue
        idx = np.searchsorted(d_arr, d)          # d 當天或其後第一個交易日
        if idx >= T: continue
        if idx == 0: continue                    # 事件日在資料起點之前
        cum[:idx, j] *= f
        F_day[idx, j] *= f
        n_used += 1
    A = {k: P[k] * cum for k in ('C', 'O', 'H', 'L')}
    return A, F_day, n_used


# ───────────────────────── 事件／標籤 ─────────────────────────
NO_LIMIT_PLACEHOLDER = 9995.0   # 官方「無漲跌幅限制」佔位（新上市首五日等：漲停 9995／跌停 0.01）——不是價格


def official_limit_up(T, N):
    """官方當日漲停價（T×N，上市 TWT84U、上櫃前一交易日 dailyQuotes「次日漲停價」）；環境變數 SURGE_OFFICIAL_LIMIT 指到
    official_limits.py 產生的 npz 才啟用（2026-10-04：官方判定與檔位推算 99.991% 一致，不一致處以官方為準）。"""
    path = os.environ.get('SURGE_OFFICIAL_LIMIT')
    if not path: return None
    U = np.load(path)['LIMUP']
    if U.shape != (T, N): raise ValueError(f'官方漲停價矩陣形狀 {U.shape} ≠ panel {(T, N)}')
    return U


def official_limit_masks(U):
    """官方漲停價矩陣 → (has, nolim)。has＝官方有給值（含佔位）；nolim＝9995 佔位＝當日無漲跌幅限制。
    nolim 格一律判「不可能漲停」，不可退回檔位推算（2026-10-04 實測：退回推算會多出 51 格假漲停）；
    真實高價股（U≥9000，如 5274／6515／2059）照官方價判定——舊版 U<9000 上限把 12 格真漲停判成否。"""
    has = np.isfinite(U) & (U > 0)
    nolim = has & (np.abs(U - NO_LIMIT_PLACEHOLDER) < 1e-6)
    return has, nolim


def build_events(P, A, F_day):
    C, Ca = P['C'], A['C']
    T, N = C.shape
    Cff = pd.DataFrame(C).ffill().values
    Cprev_raw = np.vstack([np.full((1, N), np.nan), Cff[:-1]])          # 最近有價的前收（含停牌後復牌）
    ref = round_tick(Cprev_raw * F_day)
    LU = (C >= limit_up_price(ref) - 1e-9) & np.isfinite(ref) & (ref > 0) & np.isfinite(C)
    U = official_limit_up(T, N)
    if U is not None:                                                    # 官方有漲停價的格子以官方為準；9995 佔位（無漲跌幅）判否
        has, nolim = official_limit_masks(U)
        LU = np.where(has, np.isfinite(C) & (C >= U - 1e-6) & ~nolim, LU)
    Caff = pd.DataFrame(Ca).ffill().values
    Caprev = np.vstack([np.full((1, N), np.nan), Caff[:-1]])
    with np.errstate(invalid='ignore', divide='ignore'):
        ratio = Ca / Caprev
    brk = (ratio > BREAK_HI) | (ratio < BREAK_LO)                          # 還原後仍超出 ±10.5%＝結構斷點
    brk &= np.isfinite(ratio)
    up = (Ca > Caprev) & np.isfinite(ratio)

    def shift_lead(X, k, fill=False):      # X[t+k]
        out = np.full_like(X, fill)
        if k > 0: out[:-k] = X[k:]
        else: out = X.copy()
        return out
    def shift_lag(X, k, fill=False):       # X[t-k]
        if k == 0: return X.copy()
        out = np.full_like(X, fill)
        out[k:] = X[:-k]
        return out

    # A：連 2 日漲停（標記整段連續漲停的每一天）
    A_start = LU & shift_lead(LU, 1)
    LUrun2 = LU & (shift_lead(LU, 1) | shift_lag(LU, 1))
    # B：5 日連漲≥30%
    upall = up.copy()
    for k in range(1, B_DAYS): upall &= shift_lead(up, k)
    with np.errstate(invalid='ignore', divide='ignore'):
        r5 = np.full_like(Ca, np.nan); r5[:-(B_DAYS - 1)] = Ca[B_DAYS - 1:] / Caprev[:-(B_DAYS - 1)] if B_DAYS > 1 else Ca / Caprev
    # 注意：r5[t] = C[t+4] / C[t-1]
    B_start = upall & (r5 >= B_RET) & np.isfinite(r5)
    Bmark = np.zeros_like(B_start)
    for k in range(B_DAYS): Bmark |= shift_lag(B_start, k)
    mark = LUrun2 | Bmark
    # 起漲日 t：mark[t] ∧ ¬mark[t-1]
    start = mark & ~shift_lag(mark, 1)
    # 近 COOLDOWN 日內有標記（含 s 當天）
    recent = np.zeros_like(mark)
    for k in range(0, COOLDOWN + 1): recent |= shift_lag(mark, k)
    return dict(LU=LU, brk=brk, up=up, A_start=A_start, B_start=B_start, mark=mark, start=start, recent=recent, Caprev=Caprev)


# ───────────────────────── 特徵 ─────────────────────────
def df(X): return pd.DataFrame(X)

def rsi(close, n):
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1.0 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1.0 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn.replace(0, np.nan))

def streak(cond):
    """cond: bool DataFrame；回傳到當日為止連續為 True 的天數（DataFrame）。"""
    X = np.asarray(cond, dtype=bool)
    out = np.zeros(X.shape, dtype=np.float32)
    run = np.zeros(X.shape[1], dtype=np.float32)
    for t in range(X.shape[0]):
        run = np.where(X[t], run + 1, 0)
        out[t] = run
    return pd.DataFrame(out, index=cond.index, columns=cond.columns)

# ───────────────────────── 公告資料的可用日（PIT）─────────────────────────
REVENUE_DEFAULT = 'revenue.json'


def avail_index(d_arr, deadline):
    """法定期限 deadline（YYYY-MM-DD）→ 第一個可用的面板索引：期限遇休市先順延到下一交易日（行政程序法 §48），
    再取「其後」第一個交易日（期限當天申報者盤後才公告）。回傳 ≥ len(d_arr) 代表面板內不可用。
    以交易日近似行政機關上班日：兩者不一致時（結算交割日、補班日）只會更晚、不會偷看。"""
    return int(np.searchsorted(d_arr, deadline)) + 1


def _next_month(month):
    y, mo = int(month[:4]), int(month[5:7])
    return (y + 1, 1) if mo == 12 else (y, mo + 1)


def revenue_avail_index(d_arr, month):
    """月營收 month（YYYY-MM）在面板中第一個可用的索引——build.revenue_matrices 與 official_features.revenue_traits 共用。
    SURGE_PIT_STRICT=1：法定期限次月 10 日（遇休市順延）之後的第一個交易日；
    未設（預設，影子與舊資料集逐位重現）：次月 11 日起第一個交易日——期限落在休市日時早一個交易日（2022-08～2026-06 有 19 個月）。"""
    ny, nm = _next_month(month)
    if os.environ.get('SURGE_PIT_STRICT') == '1':
        return avail_index(d_arr, f'{ny:04d}-{nm:02d}-10')
    return int(np.searchsorted(d_arr, f'{ny:04d}-{nm:02d}-11'))


def revenue_path():
    """月營收來源檔：預設 {SP}/revenue.json（Firestore revenueArchive 匯出，只有本國公司）；
    SURGE_REVENUE=revenue_official.json 改用 revenue_official.py 由 MOPS 鏡像合併的版本（含 -KY、2022-06 起）。"""
    name = os.environ.get('SURGE_REVENUE') or REVENUE_DEFAULT
    path = name if os.path.isabs(name) else os.path.join(SP, name)
    if not os.path.isfile(path): raise FileNotFoundError(f'月營收檔不存在：{path}（SURGE_REVENUE={name!r}）')
    return path


def load_revenue():
    with open(revenue_path()) as f:
        return json.load(f)


_TPE_MS = 8 * 3600 * 1000


def revenue_row_floor(d_arr, r):
    """列層級的最早可用索引：列帶 absentAt（revenue_official.py：當期快照當下沒有這列＝晚申報證據，epoch ms）時，
    取「快照台北日期之後的第一個交易日」；沒有則 0（不限制）。revenue.json 沒有這個欄位 ⇒ 預設管線逐位不變。"""
    a = r.get('absentAt')
    if a is None: return 0
    day = np.datetime_as_string(np.datetime64(int(a) + _TPE_MS, 'ms'), unit='D')
    return int(np.searchsorted(d_arr, day, side='right'))


def revenue_spans(rev, d_arr):
    """月營收逐月逐列的可用區間——build.revenue_matrices 與 official_features.revenue_traits 共用。
    回傳 [(月, 月可用索引 t0m, {代號: (t0, t1)})]：
      t0＝max(月可用日 revenue_avail_index, 列層級 revenue_row_floor)；
      t1＝同代號下個月那列的 t0（下個月沒有該代號＝下個月的月可用日），皆截到 T。
    晚申報列在 [月可用日, t0) 之間沿用上個月的值（上個月那列的 t1 延到它的 t0）。無 absentAt 時與舊版（整月同一區間）逐位相同。"""
    T = len(d_arr); months = sorted(rev.keys())
    t0m = [revenue_avail_index(d_arr, m) for m in months]
    row_t0 = [{r['c']: max(t0m[i], revenue_row_floor(d_arr, r)) for r in rev[m]['rows']} for i, m in enumerate(months)]
    out = []
    for i, m in enumerate(months):
        nxt_m = min(t0m[i + 1], T) if i + 1 < len(months) else T
        nxt = row_t0[i + 1] if i + 1 < len(months) else {}
        out.append((m, t0m[i], {c: (min(t0, T), min(nxt.get(c, nxt_m), T) if i + 1 < len(months) else T) for c, t0 in row_t0[i].items()}))
    return out


def revenue_matrices(dates, codes):
    rev = load_revenue()
    T, N = len(dates), len(codes)
    ci = {c: i for i, c in enumerate(codes)}
    yoy = np.full((T, N), np.nan); mom = np.full((T, N), np.nan); yoyp = np.full((T, N), np.nan); age = np.full((T, N), np.nan)
    d_arr = np.array(dates)
    prev_yoy = {}
    for m, t0m, spans in revenue_spans(rev, d_arr):
        # 月營收法定公布期限＝次月 10 日；可用日見 revenue_avail_index（預設次月 11 日起、SURGE_PIT_STRICT=1 期限順延後再隔一交易日），
        # 列層級晚申報證據見 revenue_row_floor；每列到「同代號下個月營收可用」為止（revenue_spans）
        if t0m >= T: continue
        rows = rev[m]['rows']
        for r in rows:
            j = ci.get(r['c'])
            if j is None: continue
            t0, t1 = spans[r['c']]
            yoy[t0:t1, j] = r.get('yoy') if r.get('yoy') is not None else np.nan
            mom[t0:t1, j] = r.get('mom') if r.get('mom') is not None else np.nan
            if r['c'] in prev_yoy: yoyp[t0:t1, j] = prev_yoy[r['c']]
            age[t0:t1, j] = np.arange(t0, min(t1, T)) - t0
        prev_yoy = {r['c']: r.get('yoy') for r in rows if r.get('yoy') is not None}
    return yoy, mom, yoyp

def industry_matrix(codes):
    ind = json.load(open(f'{SP}/peerComps_industries.json'))
    names = sorted(ind.keys())
    M = np.zeros((len(codes), len(names)))
    ci = {c: i for i, c in enumerate(codes)}
    for k, nm in enumerate(names):
        for r in ind[nm]:
            j = ci.get(r['code'])
            if j is not None: M[j, k] = 1
    return M, names

def compute_features(dates, codes, P, A, EV, elig_base):
    """回傳 dict name -> (T×N float32)。全部只用 ≤ s 的資料。"""
    T, N = P['C'].shape
    C, H, L, O = df(A['C']), df(A['H']), df(A['L']), df(A['O'])
    V = df(P['V'])
    Craw = df(P['C'])
    class F32(dict):
        def __setitem__(self, k, v): super().__setitem__(k, np.asarray(v, dtype=np.float32))
    F = F32()
    ret = C.pct_change(fill_method=None)
    for k in (1, 3, 5, 10, 20, 60, 120):
        F[f'r{k}'] = (C / C.shift(k) - 1).values
    # 位置／距離
    for k in (20, 60, 120):
        hh = H.rolling(k, min_periods=int(k * .9)).max(); ll = L.rolling(k, min_periods=int(k * .9)).min()
        F[f'pos{k}'] = ((C - ll) / (hh - ll).replace(0, np.nan)).values
        F[f'dist_hi{k}'] = (C / hh - 1).values
    hh240 = H.rolling(240, min_periods=150).max(); F['dist_hi240'] = (C / hh240 - 1).values
    for k in (20, 60):
        F[f'brk{k}'] = (C > C.shift(1).rolling(k, min_periods=int(k * .9)).max()).astype(float).where(C.notna()).values
    F['range20'] = ((H.rolling(20).max() - L.rolling(20).min()) / C).values
    F['range60'] = ((H.rolling(60, min_periods=50).max() - L.rolling(60, min_periods=50).min()) / C).values
    # 均線
    ma = {k: C.rolling(k, min_periods=int(k * .9)).mean() for k in (5, 10, 20, 60, 120)}
    for k in ma: F[f'c_ma{k}'] = (C / ma[k] - 1).values
    F['ma20_slope5'] = (ma[20] / ma[20].shift(5) - 1).values
    F['ma60_slope10'] = (ma[60] / ma[60].shift(10) - 1).values
    F['ma5_ma20'] = (ma[5] / ma[20] - 1).values
    F['ma20_ma60'] = (ma[20] / ma[60] - 1).values
    F['ma60_ma120'] = (ma[60] / ma[120] - 1).values
    stack = np.stack([ma[5].values, ma[10].values, ma[20].values], 0)
    F['ma_tight'] = ((np.nanmax(stack, 0) - np.nanmin(stack, 0)) / C.values)
    stack4 = np.stack([ma[5].values, ma[10].values, ma[20].values, ma[60].values], 0)
    F['ma_tight4'] = ((np.nanmax(stack4, 0) - np.nanmin(stack4, 0)) / C.values)
    above = sum((C > ma[k] * (1 + 1e-9)).astype(float) for k in (5, 10, 20, 60, 120))
    F['n_above_ma'] = above.where(C.notna()).values
    F['bull_align'] = ((ma[5] > ma[10] * (1 + 1e-9)) & (ma[10] > ma[20] * (1 + 1e-9)) & (ma[20] > ma[60] * (1 + 1e-9))).astype(float).where(C.notna()).values
    # 波動／布林
    pc = C.shift(1)
    tr = pd.DataFrame(np.fmax(np.fmax((H - L).values, (H - pc).abs().values), (L - pc).abs().values), index=C.index, columns=C.columns)
    F['atr14'] = (tr.rolling(14, min_periods=12).mean() / C).values
    sd20 = C.rolling(20, min_periods=18).std()
    bbw = 4 * sd20 / ma[20]
    F['bbw'] = bbw.values
    F['bb_pctb'] = ((C - (ma[20] - 2 * sd20)) / (4 * sd20).replace(0, np.nan)).values
    F['bbw_rank120'] = bbw.rolling(120, min_periods=90).apply(lambda a: (a[:-1] < a[-1] * (1 - 1e-9)).mean(), raw=True).values
    F['vol10'] = ret.rolling(10, min_periods=9).std().values
    F['vol60'] = ret.rolling(60, min_periods=50).std().values
    F['vol_ratio_10_60'] = (ret.rolling(10, min_periods=9).std() / ret.rolling(60, min_periods=50).std()).values
    # K 線形態（s 當天）
    rng = (H - L).replace(0, np.nan)
    F['body'] = ((C - O) / pc).values
    F['upper_shadow'] = ((H - np.maximum(O, C)) / pc).values
    F['lower_shadow'] = ((np.minimum(O, C) - L) / pc).values
    F['close_pos'] = ((C - L) / rng).values
    F['day_range'] = ((H - L) / pc).values
    F['gap'] = ((O - pc) / pc).values
    up = (C > pc).astype(float).where(C.notna() & pc.notna())
    F['up_days5'] = up.rolling(5, min_periods=5).sum().values
    F['up_streak'] = streak(up.fillna(0) > 0).values
    # 漲停歷史
    LUd = df(EV['LU'].astype(float))
    for k in (20, 60, 250):
        F[f'n_lu_{k}'] = LUd.rolling(k, min_periods=1).sum().values
    last = pd.DataFrame(np.where(EV['LU'], np.arange(T)[:, None], np.nan)).ffill()
    F['days_since_lu'] = (np.arange(T)[:, None] - last.values)
    # 量
    v = V
    for k in (5, 20): F[f'vr{k}'] = (v / v.shift(1).rolling(k, min_periods=int(k * .8)).mean()).values
    F['v5_20'] = (v.rolling(5, min_periods=4).mean() / v.rolling(20, min_periods=16).mean()).values
    F['v_dryup5'] = (v.rolling(5, min_periods=4).min() / v.rolling(20, min_periods=16).mean()).values
    F['v_rank120'] = v.rolling(120, min_periods=90).apply(lambda a: (a[:-1] < a[-1]).mean(), raw=True).values
    tv = (df(P['C']) * v)  # 成交值（千元＝價×張）
    F['log_tv20'] = np.log10(tv.rolling(20, min_periods=16).mean().replace(0, np.nan)).values
    sgn = np.sign(C.diff()).fillna(0)
    obv = (sgn * v).cumsum()
    F['obv_slope20'] = ((obv - obv.shift(20)) / v.rolling(20, min_periods=16).sum().replace(0, np.nan)).values
    upv = (v * (C > pc)).rolling(20, min_periods=16).sum(); dnv = (v * (C < pc)).rolling(20, min_periods=16).sum()
    F['updown_vol20'] = (upv / dnv.replace(0, np.nan)).values
    F['pv_up_surge'] = ((C > pc) & (v / v.shift(1).rolling(5, min_periods=4).mean() > 1.5)).astype(float).where(C.notna()).values
    # 指標
    e12, e26 = C.ewm(span=12, adjust=False).mean(), C.ewm(span=26, adjust=False).mean()
    dif = e12 - e26; dea = dif.ewm(span=9, adjust=False).mean(); hist = dif - dea
    F['macd_dif'] = (dif / C).values; F['macd_hist'] = (hist / C).values
    F['macd_hist_d1'] = ((hist - hist.shift(1)) / C).values
    F['macd_hist_d3'] = ((hist - hist.shift(3)) / C).values
    F['macd_dif_pos'] = (dif > 0).astype(float).where(C.notna()).values
    F['macd_hist_pos'] = (hist > 0).astype(float).where(C.notna()).values
    gc = ((dif > dea + 1e-12) & (dif.shift(1) <= dea.shift(1) + 1e-12)).astype(float)
    F['macd_gold3'] = gc.rolling(3, min_periods=1).max().where(C.notna()).values
    F['macd_gold10'] = gc.rolling(10, min_periods=1).max().where(C.notna()).values
    ll9, hh9 = L.rolling(9, min_periods=9).min(), H.rolling(9, min_periods=9).max()
    rsv = (C - ll9) / (hh9 - ll9).replace(0, np.nan) * 100
    K = rsv.ewm(alpha=1 / 3, adjust=False).mean(); D = K.ewm(alpha=1 / 3, adjust=False).mean()
    F['kd_k'] = K.values; F['kd_d'] = D.values; F['kd_kd'] = (K - D).values
    F['kd_gold3'] = (((K > D + 1e-9) & (K.shift(1) <= D.shift(1) + 1e-9)).astype(float).rolling(3, min_periods=1).max()).where(C.notna()).values
    for n in (5, 10, 14): F[f'rsi{n}'] = rsi(C, n).values
    # 籌碼（張數正規化：÷近 20 日均量）
    av20 = V.rolling(20, min_periods=16).mean().replace(0, np.nan)
    IFd, ITd = df(P['IF']), df(P['IT'])
    for k in (1, 5, 20):
        F[f'fgn_{k}'] = (IFd.rolling(k, min_periods=max(1, int(k * .8))).sum() / av20).values
        F[f'trust_{k}'] = (ITd.rolling(k, min_periods=max(1, int(k * .8))).sum() / av20).values
    F['trust_streak'] = streak(ITd > 0).where(ITd.notna()).values
    F['fgn_streak'] = streak(IFd > 0).where(IFd.notna()).values
    F['inst_pct_v1'] = ((IFd + ITd) / V.replace(0, np.nan)).values
    ML, MS, LEND, DT = df(P['ML']), df(P['MS']), df(P['LEND']), df(P['DT'])
    F['ml_chg5'] = (ML / ML.shift(5) - 1).values; F['ml_chg20'] = (ML / ML.shift(20) - 1).values
    F['ml_to_v'] = (ML / av20).values
    F['ms_chg5'] = (MS / MS.shift(5).replace(0, np.nan) - 1).values
    F['ms_to_ml'] = (MS / ML.replace(0, np.nan)).values
    F['ms_to_v'] = (MS / av20).values
    F['lend_to_v'] = (LEND / av20).values
    F['lend_chg5'] = ((LEND - LEND.shift(5)) / av20).values
    F['lend_chg20'] = ((LEND - LEND.shift(20)) / av20).values
    F['dt_ratio'] = (DT / V.replace(0, np.nan)).values
    F['dt_ratio20'] = (DT.rolling(20, min_periods=15).sum() / V.rolling(20, min_periods=15).sum().replace(0, np.nan)).values
    # 營收（PIT：可用日見 revenue_avail_index；來源檔見 revenue_path）
    yoy, mom, yoyp = revenue_matrices(dates, codes)
    F['rev_yoy'] = yoy; F['rev_mom'] = mom; F['rev_yoy_acc'] = yoy - yoyp
    # 市場環境（s 當天，全市場同值）與橫斷面
    el = elig_base & np.isfinite(F['r20'])
    def med(X):
        Xm = np.where(el, X, np.nan)
        with np.errstate(all='ignore'): return np.nanmedian(Xm, axis=1)
    mk = {}
    for k in (1, 5, 20): mk[f'mkt_r{k}'] = med(F[f'r{k}'])
    with np.errstate(all='ignore'):
        mk['mkt_breadth_ma20'] = np.nanmean(np.where(el, F['c_ma20'] > 1e-9, np.nan), axis=1)
        mk['mkt_lu_cnt'] = np.where(el, EV['LU'], 0).sum(1).astype(float)
        mk['mkt_lu_cnt5'] = pd.Series(mk['mkt_lu_cnt']).rolling(5, min_periods=1).mean().values
        mk['mkt_vol_ratio'] = med(F['vr20'])
        mk['mkt_near_hi'] = np.nanmean(np.where(el, F['dist_hi60'] > -0.05, np.nan), axis=1)
    for k, a in mk.items(): F[k] = np.repeat(a[:, None], N, 1)
    for nm in ('r5', 'r20', 'r60', 'vr20', 'log_tv20'):
        X = np.where(el, F[nm], np.nan)
        F[f'rk_{nm}'] = pd.DataFrame(X).rank(axis=1, pct=True).values
    F['rs20'] = F['r20'] - F['mkt_r20']
    # 產業共振（排除自己）：同產業當日漲停檔數／近 5 日平均漲幅
    Mi, names = industry_matrix(codes)
    has_ind = Mi.sum(1) > 0
    LUe = np.where(el, EV['LU'], 0).astype(float)
    cnt = LUe @ Mi                                   # T×I 產業漲停數
    size = np.where(el, 1.0, 0.0) @ Mi               # T×I 產業可交易檔數
    own_cnt = (cnt @ Mi.T)                           # T×N 自己產業的漲停數
    own_size = (size @ Mi.T)
    F['ind_lu_cnt'] = np.where(has_ind[None, :], own_cnt - LUe, np.nan)
    with np.errstate(all='ignore'):
        F['ind_lu_share'] = F['ind_lu_cnt'] / np.maximum(own_size - 1, 1)
    F['ind_lu_cnt5'] = pd.DataFrame(F['ind_lu_cnt']).rolling(5, min_periods=1).sum().values
    r5e = np.where(el, F['r5'], np.nan); r5z = np.nan_to_num(r5e)
    ind_sum = r5z @ Mi; ind_n = np.isfinite(r5e).astype(float) @ Mi
    with np.errstate(all='ignore'):
        own_mean = (ind_sum / np.maximum(ind_n, 1)) @ Mi.T
        own_n = ind_n @ Mi.T
        F['ind_r5'] = np.where(has_ind[None, :], (own_mean * own_n - r5z) / np.maximum(own_n - 1, 1) , np.nan)
    F['ind_r5_rel'] = F['r5'] - F['ind_r5']
    return dict(F)


def main():
    dates, codes, P = load_panel()
    T, N = P['C'].shape
    events = load_factor_events(dates, codes)
    A, F_day, n_used = adjust(dates, codes, P, events)
    EV = build_events(P, A, F_day)
    print(f'T={T} N={N} 還原事件套用 {n_used}/{len(events)}；漲停格 {int(EV["LU"].sum())}；斷點 {int(EV["brk"].sum())}；起漲日 {int(EV["start"].sum())}（A {int((EV["A_start"]&EV["start"]).sum())}、B {int((EV["B_start"]&EV["start"]).sum())}）')

    Ca, V = A['C'], P['V']
    Cdf, Vdf = pd.DataFrame(Ca), pd.DataFrame(V)
    vol20 = Vdf.rolling(20, min_periods=15).mean().values
    cnt130 = Cdf.notna().astype(float).rolling(HIST_WIN, min_periods=1).sum().values
    nan20 = Cdf.isna().astype(float).rolling(20, min_periods=1).sum().values
    brk_any = pd.DataFrame(EV['brk'].astype(float))
    brk_past = brk_any.rolling(HIST_NEED, min_periods=1).max().values > 0
    brk_future = np.zeros_like(brk_past)
    for k in range(1, 6):
        brk_future[:-k] |= EV['brk'][k:]
    elig_base = np.isfinite(P['C']) & (P['C'] >= MIN_PRICE) & (vol20 >= MIN_VOL20) & (cnt130 >= HIST_NEED) & (nan20 == 0)
    elig = elig_base & ~EV['LU'] & ~brk_past & ~brk_future & ~EV['recent']
    elig[T - 5:] = False
    # 第二波：s 前 COOLDOWN 日內有強攻，但 s 本身不在強攻中、t=s+1 又起漲——另列不入主資料集
    start_next = np.zeros_like(EV['start']); start_next[:-1] = EV['start'][1:]
    second_wave = elig_base & ~EV['LU'] & ~brk_past & ~brk_future & EV['recent'] & ~EV['mark'] & start_next
    second_wave[T - 5:] = False

    F = compute_features(dates, codes, P, A, EV, elig_base)
    print('特徵', len(F))

    # ── 抽出母體 ──
    si, ji = np.nonzero(elig)
    pos = start_next[si, ji]
    A_next = np.zeros_like(EV['A_start']); A_next[:-1] = EV['A_start'][1:]
    B_next = np.zeros_like(EV['B_start']); B_next[:-1] = EV['B_start'][1:]
    meta = {
        's': si.astype(np.int32), 'j': ji.astype(np.int32),
        'y': pos.astype(np.int8), 'yA': (pos & A_next[si, ji]).astype(np.int8), 'yB': (pos & B_next[si, ji]).astype(np.int8),
    }
    # 前瞻報酬（以 s 收盤為基準；及 t 開盤進場）— 還原價
    Oa = A['O']
    def fwd(arr_num, arr_den, k):
        out = np.full(len(si), np.nan, dtype=np.float32)
        ok = si + k < T
        out[ok] = (arr_num[si[ok] + k, ji[ok]] / arr_den[si[ok], ji[ok]] - 1)
        return out
    for k in (1, 2, 5, 10, 20): meta[f'f_c{k}'] = fwd(Ca, Ca, k)
    out = np.full(len(si), np.nan, dtype=np.float32); ok = si + 1 < T
    out[ok] = Oa[si[ok] + 1, ji[ok]] / Ca[si[ok], ji[ok]] - 1
    meta['f_open1'] = out                                # t 開盤相對 s 收盤（跳空）
    for k in (1, 2, 5, 10, 20):                          # t 開盤買、第 k 日收盤賣
        out = np.full(len(si), np.nan, dtype=np.float32); ok = si + k < T
        out[ok] = Ca[si[ok] + k, ji[ok]] / Oa[si[ok] + 1, ji[ok]] - 1
        meta[f'o_c{k}'] = out
    # 最大漲幅（t..t+9 最高價 / s 收盤）、最深回檔（t..t+4 最低 / t 開盤）
    Hdf = pd.DataFrame(A['H']); Ldf = pd.DataFrame(A['L'])
    hmax10 = Hdf[::-1].rolling(10, min_periods=1).max()[::-1].shift(-1).values   # [s+1 .. s+10]
    lmin5 = Ldf[::-1].rolling(5, min_periods=1).min()[::-1].shift(-1).values
    meta['f_maxup10'] = (hmax10[si, ji] / Ca[si, ji] - 1).astype(np.float32)
    meta['f_mindn5_vs_open'] = (lmin5[si, ji] / Oa[np.minimum(si + 1, T - 1), ji] - 1).astype(np.float32)
    # 起漲日 t 是否開盤即鎖漲停（買不到）：開盤價 ≥ 漲停價
    Craw = P['C']
    ref_t = round_tick(Craw[si, ji] * F_day[np.minimum(si + 1, T - 1), ji])
    lim_t = limit_up_price(ref_t)
    opn = P['O'][np.minimum(si + 1, T - 1), ji]
    hi_t = P['H'][np.minimum(si + 1, T - 1), ji]
    meta['locked_open'] = (np.isfinite(opn) & (opn >= lim_t - 1e-9)).astype(np.int8)
    meta['close_raw'] = Craw[si, ji].astype(np.float32)
    meta['vol20'] = vol20[si, ji].astype(np.float32)

    feats = {k: v[si, ji] for k, v in F.items()}
    # 第二波事件另存
    s2, j2 = np.nonzero(second_wave)
    sw = {'s': s2.astype(np.int32), 'j': j2.astype(np.int32), **{k: v[s2, j2] for k, v in F.items()}}

    # 當日漲停與起漲日 mark 的完整事件目錄（含不在母體者，供目錄／月度統計）
    st_t, st_j = np.nonzero(EV['start'])
    catalog = {
        't': st_t.astype(np.int32), 'j': st_j.astype(np.int32),
        'A': (EV['A_start'][st_t, st_j]).astype(np.int8), 'B': (EV['B_start'][st_t, st_j]).astype(np.int8),
        'in_universe': np.array([bool(elig[t - 1, j]) if t >= 1 else False for t, j in zip(st_t, st_j)], dtype=np.int8),
    }
    np.savez_compressed(f'{SP}/dataset.npz', dates=np.array(dates), codes=np.array(codes),
                        **{f'm_{k}': v for k, v in meta.items()}, **{f'f_{k}': v for k, v in feats.items()},
                        **{f'sw_{k}': v for k, v in sw.items()}, **{f'cat_{k}': v for k, v in catalog.items()})
    print(f'母體 {len(si):,} 列；正例（起漲前一日）{int(meta["y"].sum()):,}（A {int(meta["yA"].sum())}、B {int(meta["yB"].sum())}）；基準率 {meta["y"].mean()*100:.3f}%；第二波 {len(s2)}')


if __name__ == '__main__':
    main()
