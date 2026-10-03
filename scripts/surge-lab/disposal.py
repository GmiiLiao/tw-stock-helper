"""官方處置名單（TWSE punish＋TPEx disposal）→ 與面板對齊的逐日狀態矩陣。

資料：fetch_disposal.mjs 抓到的 disposal_twse.json／disposal_tpex.json（公布日期、處置起迄、累計、處置條件／原因）。
口徑
  · 處置期間含起迄兩端的交易日（「自 X 日起至 Y 日止」）。
  · 2026-08-10 起處置新制：一般 5 個營業日、涉當沖／沖銷 7 個營業日；官方公告端點不回頭改舊公告迄日（專案 risk-stocks-source.ts 記載 8046 實案），
    故迄日取「公告迄日」與「新制推算迄日」較早者；已符合新天數者自實施日起解除（有效迄日不早於實施日前一個交易日）。營業日以面板的交易日曆推算。
  · 前視安全：一筆處置在 t 日「已知」需公布日（公布日期）< t，所以 known_start = max(起日, 公布日的下一個交易日)。
    公布日當晚才公告、次一營業日開始處置者，在 s 日收盤時不可知（AI 波段的 17:00 後決策才知道）——另以 PUB 矩陣標示。
"""
import json, os, re
import numpy as np

SP = os.environ.get('SURGE_CACHE', os.path.join(os.path.dirname(os.path.abspath(__file__)), '.surge-cache'))
NEW_REGIME = '2026-08-10'
_DATE = re.compile(r'(\d{2,3})/(\d{1,2})/(\d{1,2})')


def roc_iso(s):
    m = _DATE.search(s or '')
    if not m: return None
    return f'{int(m.group(1)) + 1911:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}'


def parse_period(p):
    ds = _DATE.findall(p or '')
    if len(ds) < 2: return None, None
    f = lambda t: f'{int(t[0]) + 1911:04d}-{int(t[1]):02d}-{int(t[2]):02d}'
    return f(ds[0]), f(ds[1])


def load_intervals():
    """回傳 list of dict(code, pub, start, end, cum, kind, measure, daytrade_related, src)。"""
    out = []
    tw = json.load(open(f'{SP}/disposal_twse.json'))
    F = tw['fields']; ix = {k: i for i, k in enumerate(F)}
    for r in tw['data']:
        st, en = parse_period(r[ix['處置起迄時間']])
        if not st: continue
        cond = str(r[ix['處置條件']]); meas = str(r[ix['處置措施']])
        out.append(dict(code=str(r[ix['證券代號']]).strip(), pub=roc_iso(r[ix['公布日期']]), start=st, end=en, cum=r[ix['累計']], measure=meas,
                        dt_rel=('沖' in cond), src='TWSE'))
    tp = json.load(open(f'{SP}/disposal_tpex.json'))
    F = tp['fields']; ix = {k: i for i, k in enumerate(F)}
    for r in tp['data']:
        st, en = parse_period(r[ix['處置起訖時間']])
        if not st: continue
        out.append(dict(code=str(r[ix['證券代號']]).strip(), pub=roc_iso(r[ix['公布日期']]), start=st, end=en, cum=r[ix['累計']], measure=str(r[ix['處置措施']]),
                        dt_rel=('沖' in str(r[ix['處置原因']])), src='TPEx'))
    # 去重
    seen, res = set(), []
    for d in out:
        k = (d['code'], d['start'], d['end'])
        if k in seen: continue
        seen.add(k); res.append(d)
    return res


def nth_trading_day(dates, start_idx, n):
    return min(start_idx + n - 1, len(dates) - 1)


def build_matrices(dates, codes, intervals=None):
    """dates: 面板交易日（str 陣列）。回傳 dict：
       DISP（t 日在處置期，含已公告當日起生效者）、DISP_known（前視安全版：公布日已過）、PUB（t 日公布、次一營業日起處置）、START（處置起日）、
       以及每筆有效區間 list（code, t_start, t_end, src, dt_rel, cum）供區間長度統計。"""
    intervals = intervals or load_intervals()
    d_arr = np.array(dates); T = len(d_arr); N = len(codes)
    ci = {c: i for i, c in enumerate(codes)}
    DISP = np.zeros((T, N), bool); KNOWN = np.zeros((T, N), bool); PUB = np.zeros((T, N), bool); START = np.zeros((T, N), bool)
    eff = []
    floor_t = int(np.searchsorted(d_arr, NEW_REGIME)) - 1        # 新制實施日前一個交易日
    for d in intervals:
        j = ci.get(d['code'])
        if j is None: continue
        ts = int(np.searchsorted(d_arr, d['start']))              # 起日當天或其後第一個交易日
        te = int(np.searchsorted(d_arr, d['end'], side='right')) - 1
        if d['end'] >= NEW_REGIME and ts < T:                     # 新制校正
            n = 7 if d['dt_rel'] else 5
            te_new = nth_trading_day(d_arr, ts, n)
            te = min(te, max(te_new, floor_t))
        if te < ts or ts >= T: continue
        te = min(te, T - 1)
        DISP[ts:te + 1, j] = True; START[ts, j] = True
        tp = int(np.searchsorted(d_arr, d['pub'])) if d['pub'] else ts - 1       # 公布日（交易日）
        if d['pub'] and tp < T and d_arr[min(tp, T - 1)] == d['pub']: PUB[tp, j] = True
        ks = max(ts, tp + 1)
        if ks <= te: KNOWN[ks:te + 1, j] = True
        eff.append(dict(code=d['code'], ts=ts, te=te, len=te - ts + 1, src=d['src'], dt_rel=d['dt_rel'], cum=d['cum'], start=d['start'], end=d['end']))
    return dict(DISP=DISP, KNOWN=KNOWN, PUB=PUB, START=START, intervals=eff)


def features(M, T):
    """前視安全的處置歷史特徵（以 KNOWN 為準）。回傳 dict name -> T×N float32。"""
    K = M['KNOWN']; N = K.shape[1]
    cs = np.cumsum(K, axis=0, dtype=np.int32)
    def roll(a, w):
        out = a.copy(); out[w:] = a[w:] - a[:-w]; return out
    cnt20 = roll(cs, 20)
    cnt60 = roll(cs, 60)
    # 距上次處置（含當日在處置＝0）：向前填補
    idx = np.where(K, np.arange(T)[:, None], -1)
    last = np.maximum.accumulate(idx, axis=0)
    since = np.where(last >= 0, np.arange(T)[:, None] - last, 999).astype(np.float32)
    # 近 250 日處置次數（以「已知」起點計）
    start_known = K & ~np.vstack([np.zeros((1, N), bool), K[:-1]])
    cs2 = np.cumsum(start_known, axis=0, dtype=np.int32)
    n250 = roll(cs2, 250)
    return {'dp_in': K.astype(np.float32), 'dp_cnt20': cnt20.astype(np.float32), 'dp_cnt60': cnt60.astype(np.float32),
            'dp_since': since, 'dp_n250': n250.astype(np.float32)}
