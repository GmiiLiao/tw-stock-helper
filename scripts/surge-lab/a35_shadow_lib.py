"""a35_shadow 共用函式庫：影子（shadow）漲停預測的特徵、訓練、打分、凍結檔格式。

⚠ 影子模式：不取代、不修改站上既有預測（scripts/ai-daemon.mjs computeLimitUpForecast），不寫 Firestore。
   本檔只讀 `.surge-cache/`、只寫 `out/` 與 `.surge-cache/a35_*`。

協定（與 a32_walkforward 的 OLD/ALL 完全同一套，只把「月初」換成「打分日」）
  · 目標：m_y＝隔日（s+1）收漲停（含「s 當天已漲停」的延續列；母體不排除已漲停）。
  · 特徵（124 欄）：109 個 f_* 同日百分位＋8 個 f_mkt_* 原值＋x_lu_s／x_oneword_s／x_close_at_high／x_lu_streak／log 價／log 量／m_otc。
    欄位名單與順序取自 a32_walkforward_meta.npz 的 names（a32_walkforward_prep.py 產生）。
  · 訓練列：s' ≤ 打分日索引 − 3（交易日；標籤用 s'+1 ⇒ 最晚標籤日 ＝ 打分日 − 2，嚴格不含任何打分日當天或之後的資料）。
  · 超參數：depth 4、600 棵、lr .05、l2 20、colsample .5、subsample .8、min_child_h 3；負例抽 15%（權重 1/.15）、正例全取；
    3 個 seed（1,2,3），各自對「打分日全列」z 化後取平均。
  · 實盤列（live）：打分日所有「有收盤、已有 ≥125 日歷史」的個股（＝資料集母體扣掉需要 s+1 資訊的兩條：s+1 有收盤、s+1 非結構斷點）；
    同日百分位以這群為母體計算（與資料集一致）。可挑選名單（pool）再加站上實盤濾網：收盤 ≥10、20 日均量 ≥300 張、近 20 日無缺值、
    近 125 日無價格結構斷點（＝ a30_live_list.py 的 elig_base & ~brk_past；**不**排除「s 當天已漲停」、**不**套 T1 冷卻）。
"""
import os
import sys
import json
import time
import pickle
import hashlib
import datetime
import subprocess
import plistlib
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path: sys.path.insert(0, HERE)
import build as B                                              # noqa: E402
from a32_walkforward_gbdt import FastGBDT                      # noqa: E402

SP = B.SP
OUT = os.path.join(HERE, 'out')
MODEL_DIR = os.path.join(SP, 'a35_models')
X_PATH = os.path.join(SP, 'a32_walkforward_X.npy')
META_PATH = os.path.join(SP, 'a32_walkforward_meta.npz')
TZ = datetime.timezone(datetime.timedelta(hours=8))

SCHEMA = 'a35.shadow.v1'
PARAMS = dict(n_trees=600, depth=4, lr=0.05, l2=20.0, colsample=0.5, subsample=0.8, min_child_h=3.0)
NEG_FRAC = 0.15
PURGE_DAYS = 3                 # 訓練列 s' ≤ 打分日 − 3 個交易日
SEEDS = (1, 2, 3)
TOPK = 100                     # 每個子榜存前 100 名（後台每次 +20 檔瀏覽；2026-10-04 使用者要求，舊名單只存 30）
EVAL_TOP = 30                  # 成績口徑仍是前 10／前 30（鍵名 *Top30 沿用舊名，內容最多 TOPK 列）
SHOCK = ('2025-04-07', '2025-04-10')


def now_iso() -> str:
    return datetime.datetime.now(TZ).isoformat(timespec='seconds')


def log(*a) -> None:
    print(datetime.datetime.now(TZ).strftime('%H:%M:%S'), *a, flush=True)


# ───────────────────────── 面板與特徵（live 建構） ─────────────────────────
class Ctx:
    """整張面板的衍生矩陣（同 build_lu1.main 的前半段）。屬性＝numpy 陣列 (T×N)。"""
    pass


def load_default_panel():
    return B.load_panel()


def load_extra_exright() -> tuple:
    """a35_shadow_fetch.mjs 補抓的官方除權息（上市＋上櫃，.surge-cache/a35_shadow_exright_{日}.json）。回傳 (items[(日期,代號,factor)], cover[(日期,error,counts,twseOnly)])。
    研究快取的 exright_delta.json 只有上市（上櫃 2026-10-03 連不上），上櫃 09-30～10-02 的除權息要靠這裡補，否則該日除權息股的漲停判定會錯。"""
    import glob
    items, cover = [], []
    for p in sorted(glob.glob(f'{SP}/a35_shadow_exright_*.json')):
        j = json.load(open(p)); cover.append((j.get('date'), j.get('error'), j.get('counts'), bool(j.get('twseOnly'))))
        items += [tuple(i) for i in j.get('items', [])]
    return items, cover


def build_ctx(dates=None, codes=None, P=None, with_features=True, extra_factor_items='auto') -> Ctx:
    if P is None: dates, codes, P = load_default_panel()
    T, N = P['C'].shape
    events = B.load_factor_events(dates, codes)
    if isinstance(extra_factor_items, str): extra_factor_items = load_extra_exright()[0]
    if extra_factor_items:                      # 掃描日的額外除權息（a35_shadow_fetch.mjs 產出）；同檔同日已存在者不重複
        have = {(c, d) for (c, d, _s, _f) in events}
        events = events + [(c, d, 'a35_extra', f) for (d, c, f) in extra_factor_items if f > 0 and (c, d) not in have]
    A, F_day, _ = B.adjust(dates, codes, P, events)
    EV = B.build_events(P, A, F_day)
    x = Ctx()
    x.dates, x.codes, x.P, x.A, x.F_day, x.EV, x.T, x.N = dates, codes, P, A, F_day, EV, T, N
    x.LU, x.brk = EV['LU'], EV['brk']
    C, O, H, L, Vv = P['C'], P['O'], P['H'], P['L'], P['V']
    x.vol20 = pd.DataFrame(Vv).rolling(20, min_periods=15).mean().values
    x.cnt130 = pd.DataFrame(A['C']).notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
    x.nan20 = pd.DataFrame(A['C']).isna().astype(float).rolling(20, min_periods=1).sum().values
    x.brk_past = pd.DataFrame(EV['brk'].astype(float)).rolling(B.HIST_NEED, min_periods=1).max().values > 0
    x.elig_base = np.isfinite(C) & (C >= B.MIN_PRICE) & (x.vol20 >= B.MIN_VOL20) & (x.cnt130 >= B.HIST_NEED) & (x.nan20 == 0)
    Cff = pd.DataFrame(C).ffill().values
    prev = np.vstack([np.full((1, N), np.nan), Cff[:-1]])
    x.prev = prev
    x.lim = B.limit_up_price(B.round_tick(prev * F_day))
    x.oneword = x.LU & np.isfinite(O) & (O >= x.lim - 1e-9) & (L >= x.lim - 1e-9)
    x.open_lim = np.isfinite(O) & (O >= x.lim - 1e-9)
    x.close_at_high = np.isfinite(H) & (C >= H - 1e-9)
    run = np.zeros((T, N), np.int16)
    for t in range(T): run[t] = np.where(x.LU[t], (run[t - 1] + 1) if t else 1, 0)
    x.run = run
    mk = json.load(open(f'{SP}/code_market.json'))
    x.mk = np.array([mk.get(c, '?') for c in codes])
    x.otc = np.array([1 if mk.get(c) == 'otc' else 0 for c in codes], np.int8)
    nm = f'{SP}/names.json'
    x.names = json.load(open(nm)) if os.path.exists(nm) else {}
    x.F = None
    if with_features:
        F = B.compute_features(dates, codes, P, A, EV, x.elig_base)
        dsl = F['days_since_lu'].copy(); dsl[~np.isfinite(dsl)] = 999.0; F['days_since_lu'] = dsl.astype(np.float32)   # 同 build_lu1
        x.F = F
    return x


def live_universe(x: Ctx, t: int) -> np.ndarray:
    """打分日 t 的排名母體（＝資料集母體扣掉需 s+1 資訊的兩條件）：有收盤、已有 ≥125 日歷史。"""
    return np.nonzero(np.isfinite(x.P['C'][t]) & (x.cnt130[t] >= B.HIST_NEED))[0]


def pool_mask(x: Ctx, t: int, js: np.ndarray) -> np.ndarray:
    """站上實盤濾網（可挑選名單）：elig_base & ~brk_past；不排除已漲停、不套 T1 冷卻。"""
    return x.elig_base[t, js] & ~x.brk_past[t, js]


def feature_names() -> list:
    return [str(n) for n in np.load(META_PATH)['names']]


def live_X(x: Ctx, t: int, names: list, js: np.ndarray = None) -> tuple:
    """打分日 t 的 live 特徵矩陣（float32、欄序＝names）。回傳 (js, X)。dtype 路徑逐步對齊 a32_walkforward_prep.py。"""
    if js is None: js = live_universe(x, t)
    X = np.empty((len(js), len(names)), np.float32)
    price32 = x.P['C'][t, js].astype(np.float32)
    vol32 = x.vol20[t, js].astype(np.float32)
    for k, nm in enumerate(names):
        if nm.startswith('pct_f_'):
            v = x.F[nm[6:]][t, js].astype(np.float64)
            v[~np.isfinite(v)] = np.nan
            X[:, k] = pd.Series(v).rank(pct=True, method='average').values.astype(np.float32)
        elif nm.startswith('f_mkt_'):
            X[:, k] = x.F[nm[2:]][t, js]
        elif nm == 'x_lu_s': X[:, k] = x.LU[t, js].astype(np.float32)
        elif nm == 'x_oneword_s': X[:, k] = x.oneword[t, js].astype(np.float32)
        elif nm == 'x_close_at_high': X[:, k] = x.close_at_high[t, js].astype(np.float32)
        elif nm == 'x_lu_streak': X[:, k] = x.run[t, js].astype(np.float32)
        elif nm == 'log_x_price':
            with np.errstate(divide='ignore', invalid='ignore'): X[:, k] = np.log(np.maximum(price32, 1e-6))
        elif nm == 'log_x_vol20':
            with np.errstate(divide='ignore', invalid='ignore'): X[:, k] = np.log1p(np.maximum(vol32, 0))
        elif nm == 'm_otc': X[:, k] = x.otc[js]
        else: raise KeyError(f'未知特徵欄 {nm}')
    return js, X


# ───────────────────────── 訓練（與 a32_walkforward_fit.py 同一套） ─────────────────────────
class Store:
    """a32_walkforward 的訓練矩陣（memmap）＋標籤／日期。"""

    def __init__(self):
        self.X = np.load(X_PATH, mmap_mode='r')
        M = np.load(META_PATH)
        self.names = [str(n) for n in M['names']]
        self.dates = M['dates']; self.s = M['m_s']; self.y = M['m_y'].astype(np.int8)
        self.lu = M['m_lu_s'].astype(np.int8)
        assert self.X.shape[0] == len(self.s) and self.X.shape[1] == len(self.names)

    def rows_upto(self, cutoff_idx: int) -> np.ndarray:
        return np.nonzero(self.s <= cutoff_idx)[0]


def cutoff_index(dates, t: int, lag: int = PURGE_DAYS) -> int:
    return t - lag


def check_alignment(store: Store, x: Ctx) -> None:
    """訓練矩陣的日期索引必須與目前面板的日期索引一致（面板只能「往後增加日期」；中間補日或重排會讓 s 索引錯位）。"""
    n = len(store.dates)
    if list(map(str, store.dates)) != list(x.dates[:n]):
        raise RuntimeError('訓練矩陣（a32_walkforward_*）與目前面板的日期序列不一致：面板被重建且日期有增減於中間。請重跑 build_lu1.py 與 a32_walkforward_prep.py。')


def check_store(store: Store, cutoff_idx: int) -> None:
    last = int(store.s.max())
    if last < cutoff_idx:
        raise RuntimeError(f'訓練矩陣只到 s={store.dates[last]}，不足訓練截止日索引 {cutoff_idx}（{store.dates[cutoff_idx] if cutoff_idx < len(store.dates) else "?"}）。'
                           f'請先刷新：python3 panel.py && python3 build_lu1.py && python3 a32_walkforward_prep.py（見 a35_shadow_RUNBOOK.md）')


def train_rows(store: Store, cutoff_idx: int, seed: int, tag: str) -> tuple:
    rows = store.rows_upto(cutoff_idx)
    rng = np.random.default_rng(10_000 + seed * 97 + sum(map(ord, tag)))      # 與 a32_walkforward_fit.py 同公式
    keep = (store.y[rows] == 1) | (rng.random(len(rows)) < NEG_FRAC)
    tr = rows[keep]
    w = np.where(store.y[tr] == 1, 1.0, 1.0 / NEG_FRAC)
    return rows, tr, w


def train_sig(rows: np.ndarray, y: np.ndarray) -> str:
    h = hashlib.sha256(); h.update(rows.astype(np.int64).tobytes()); h.update(y[rows].tobytes())
    return h.hexdigest()


def model_digest(m: FastGBDT) -> str:
    h = hashlib.sha256()
    h.update(np.float64(m.base).tobytes()); h.update(np.int64([m.nb]).tobytes())
    for e in m.edges: h.update(np.asarray(e, np.float64).tobytes())
    for levels, leaf in m.trees:
        for bf, bb in levels:
            h.update(np.asarray(bf, np.int64).tobytes()); h.update(np.asarray(bb, np.int64).tobytes())
        h.update(np.asarray(leaf, np.float64).tobytes())
    return h.hexdigest()


def fit_job(args: tuple) -> dict:
    """子程序入口：訓練一個 seed。args＝(cutoff_idx, seed, tag)。回傳 dict(model, info)。"""
    cutoff_idx, seed, tag = args
    t0 = time.time()
    store = Store()
    rows, tr, w = train_rows(store, cutoff_idx, seed, tag)
    Xtr = np.asarray(store.X[tr])
    m = FastGBDT(seed=seed, **PARAMS).fit(Xtr, store.y[tr], w=w)
    imp = m.gain_imp / max(m.gain_imp.sum(), 1e-12)
    info = dict(seed=seed, tag=tag, cutoffIdx=int(cutoff_idx), trainFirst=str(store.dates[store.s[rows].min()]), trainLast=str(store.dates[store.s[rows].max()]),
                trainDays=int(len(np.unique(store.s[rows]))), trainRowsFull=int(len(rows)), trainPos=int(store.y[rows].sum()), fitRows=int(len(tr)),
                trainSig=train_sig(rows, store.y), fitSec=round(time.time() - t0),
                topImp=[(store.names[i], round(float(imp[i]) * 100, 2)) for i in np.argsort(-imp)[:10]])
    return dict(model=m, info=info)


def _model_path(cutoff_date: str, seed: int, sig: str) -> str:
    ph = hashlib.sha256(json.dumps([PARAMS, NEG_FRAC, PURGE_DAYS], sort_keys=True).encode()).hexdigest()[:8]
    return os.path.join(MODEL_DIR, f'shadow_{cutoff_date}_s{seed}_{ph}_{sig[:12]}.pkl')


def train_ensembles(cutoffs: list, seeds=SEEDS, workers: int = 3, reuse: bool = True, store: Store = None) -> dict:
    """一次訓練（或載入快取）多個截止日的 seed 模型，所有 (截止日, seed) 工作共用同一個程序池。
    回傳 {cutoff_idx: dict(models, infos, digests, hash, cutoffDate, cutoffIdx, trainSig, rowsFull, pos)}。"""
    from concurrent.futures import ProcessPoolExecutor
    store = store or Store()
    os.makedirs(MODEL_DIR, exist_ok=True)
    res, jobs, meta = {}, [], {}
    for ci in sorted(set(cutoffs)):
        check_store(store, ci)
        cd = str(store.dates[ci]); rows = store.rows_upto(ci); sig = train_sig(rows, store.y)
        meta[ci] = (cd, rows, sig)
        for sd in seeds:
            p = _model_path(cd, sd, sig)
            if reuse and os.path.exists(p):
                with open(p, 'rb') as f: res[(ci, sd)] = pickle.load(f)
            else:
                jobs.append((ci, sd, f'SHADOW_y_{cd}_s{sd}'))
    log(f'  模型：快取 {len(res)}、需訓練 {len(jobs)}（截止日 {len(meta)} 個、seeds {list(seeds)}、workers={workers}）')
    if jobs:
        def _save(job, o):
            ci, sd, _tag = job
            cd, _rows, sig = meta[ci]
            o['digest'] = model_digest(o['model']); res[(ci, sd)] = o
            path = _model_path(cd, sd, sig); tmp = path + f'.tmp{os.getpid()}'
            with open(tmp, 'wb') as f: pickle.dump(o, f)
            os.replace(tmp, path)                     # 每完成一個就落地：中途中斷不丟已完成的模型
            log(f'  截止 {cd} seed={sd} 完成 {o["info"]["fitSec"]}s digest={o["digest"][:12]}')
        if len(jobs) == 1 or workers <= 1:
            for j in jobs: _save(j, fit_job(j))
        else:
            from concurrent.futures import as_completed
            with ProcessPoolExecutor(max_workers=min(workers, len(jobs))) as ex:
                futs = {ex.submit(fit_job, j): j for j in jobs}
                for f in as_completed(futs): _save(futs[f], f.result())
    out = {}
    for ci, (cd, rows, sig) in meta.items():
        digests = [res[(ci, sd)]['digest'] if 'digest' in res[(ci, sd)] else model_digest(res[(ci, sd)]['model']) for sd in seeds]
        spec = dict(params=PARAMS, negFrac=NEG_FRAC, purgeDays=PURGE_DAYS, seeds=list(seeds), cutoffDate=cd, trainSig=sig, perSeed=digests)
        mh = hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()
        out[ci] = dict(models=[res[(ci, sd)]['model'] for sd in seeds], infos=[res[(ci, sd)]['info'] for sd in seeds], digests=digests, hash=mh,
                       cutoffDate=cd, cutoffIdx=ci, trainSig=sig, rowsFull=int(len(rows)), pos=int(store.y[rows].sum()))
    return out


def train_ensemble(cutoff_idx: int, seeds=SEEDS, workers: int = 3, reuse: bool = True, store: Store = None) -> dict:
    return train_ensembles([cutoff_idx], seeds, workers, reuse, store)[cutoff_idx]


def score_live(models: list, X: np.ndarray) -> tuple:
    """各 seed 的原始分數對打分日全列 z 化後取平均。回傳 (avg_z, per_seed_z)。"""
    zs = []
    for m in models:
        s = m.decision_function(X, n_trees=PARAMS['n_trees'])
        sd = s.std()
        zs.append((s - s.mean()) / (sd if sd > 0 else 1.0))
    zs = np.vstack(zs)
    return zs.mean(0), zs


# ───────────────────────── 名單／上下文／站上預測 ─────────────────────────
def r6(v) -> float:
    return None if v is None or not np.isfinite(v) else round(float(v), 6)


def entry(x: Ctx, t: int, j: int, rank: int, score: float) -> dict:
    c = x.codes[j]
    pc = x.prev[t, j]; cl = x.P['C'][t, j]
    return dict(rank=int(rank), code=c, name=x.names.get(c, ''), market=str(x.mk[j]), score=r6(score), close=r6(cl),
                chgPct=r6((cl / pc - 1) * 100) if np.isfinite(pc) and pc > 0 else None, vol20Lots=r6(x.vol20[t, j]),
                limitUpAtS=bool(x.LU[t, j]), oneWordLockAtS=bool(x.oneword[t, j]), luStreakAtS=int(x.run[t, j]),
                closeAtHigh=bool(x.close_at_high[t, j]))


def top_list(x: Ctx, t: int, js: np.ndarray, score: np.ndarray, mask: np.ndarray, k: int = TOPK) -> list:
    idx = np.nonzero(mask)[0]
    if len(idx) == 0: return []
    codes = np.array([x.codes[js[i]] for i in idx])
    order = np.lexsort((codes, -np.round(score[idx], 9)))          # 同分以代號升冪（決定性）
    return [entry(x, t, js[idx[i]], r + 1, score[idx[i]]) for r, i in enumerate(order[:k])]


def limit_down_price(ref):
    raw = ref * 0.9
    tk = B.tick_of(raw)
    return np.ceil(raw / tk - 1e-6) * tk


def market_context(x: Ctx, t: int) -> dict:
    """當日兩市（面板內 4 碼普通股）的漲跌停家數、漲跌家數、成交值、報酬中位數；＋上櫃指數日報酬（若有）。"""
    C = x.P['C'][t]; V = x.P['V'][t]; Ca, Cap = x.A['C'][t], x.EV['Caprev'][t]
    fin = np.isfinite(C)
    with np.errstate(invalid='ignore', divide='ignore'): ret = Ca / Cap - 1
    ldp = limit_down_price(B.round_tick(x.prev[t] * x.F_day[t]))
    ld = fin & np.isfinite(ldp) & (C <= ldp + 1e-9) & (x.prev[t] > 0)
    out = {}
    for name, m in (('tse', x.mk == 'tse'), ('otc', x.mk == 'otc'), ('all', np.ones(len(x.mk), bool))):
        a = fin & m; r = ret[a & np.isfinite(ret)]
        out[name] = dict(n=int(a.sum()), nLimitUp=int((x.LU[t] & a).sum()), nLimitDown=int((ld & a).sum()),
                         nUp=int((r > 1e-9).sum()), nDown=int((r < -1e-9).sum()),
                         medianRetPct=r6(np.median(r) * 100) if len(r) else None,
                         turnoverMNTD=r6(np.nansum(np.where(a, C * V, 0.0)) / 1000.0))
    ih = f'{SP}/index_history.json'
    if os.path.exists(ih):
        try:
            idx = json.load(open(ih)).get('otc') or {}
            d = x.dates[t].replace('-', ''); dp = x.dates[t - 1].replace('-', '') if t > 0 else None
            if d in idx and dp in idx: out['otc']['indexRetPct'] = r6((idx[d][3] / idx[dp][3] - 1) * 100)
        except Exception: pass
    return out


def site_from_scoreboard(day: str) -> dict:
    p = f'{SP}/lu_scoreboard.json'
    if not os.path.exists(p): return None
    s = json.load(open(p)); d = (s.get('preds') or {}).get(day)
    if not d: return None
    return dict(source='lu_scoreboard.json', sourceMtime=datetime.datetime.fromtimestamp(os.path.getmtime(p), TZ).isoformat(timespec='seconds'), doc=d)


def site_from_firestore(days: list) -> dict:
    """唯讀 Firestore：limitUpForecast/pred-{day}（a35_shadow_site.mjs；憑證取自 launchd plist，不印出）。失敗回 {}（呼叫端退回記分板快照）。"""
    cred = None
    try:
        pl = plistlib.load(open(os.path.expanduser('~/Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist'), 'rb'))
        cred = (pl.get('EnvironmentVariables') or {}).get('GOOGLE_APPLICATION_CREDENTIALS')
    except Exception as e:
        log(f'  讀 plist 失敗：{e}')
    if not cred or not os.path.exists(cred):
        return {}
    env = dict(os.environ, GOOGLE_APPLICATION_CREDENTIALS=cred)
    try:
        r = subprocess.run(['node', os.path.join(HERE, 'a35_shadow_site.mjs'), *days], capture_output=True, text=True, timeout=180, env=env, cwd=HERE)
        if r.returncode != 0:
            log(f'  Firestore 讀取失敗（退回快照）：{r.stderr.strip()[-300:]}')
            return {}
        return json.loads(r.stdout)
    except Exception as e:
        log(f'  Firestore 讀取例外（退回快照）：{e}')
        return {}


def ms_iso(v) -> str:
    try: return datetime.datetime.fromtimestamp(int(v) / 1000, TZ).isoformat(timespec='seconds')
    except Exception: return None


def site_block(day: str, fs: dict = None) -> dict:
    """站上已發佈的 pred-{day}（top-30 A 榜、前 120 名次、B 榜）。優先 Firestore，退回 lu_scoreboard.json。"""
    src, doc = None, None
    if fs and fs.get(day):
        src, doc = 'firestore:limitUpForecast/pred-' + day, fs[day]
    else:
        sb = site_from_scoreboard(day)
        if sb: src, doc = sb['source'] + f'（快照 {sb["sourceMtime"]}）', sb['doc']
    if not doc: return dict(source=None, codes=[], note='找不到站上 pred-' + day)
    ranks = doc.get('ranks') or {}
    codes = [str(c) for c in (doc.get('codes') or [])]
    b = [dict(code=str(e.get('code')), est=e.get('est')) for e in (doc.get('bCodes') or [])]
    return dict(source=src, dataDate=doc.get('dataDate'), writtenAt=ms_iso(doc.get('at')), codes=codes, ranksTop120={str(k): int(v) for k, v in ranks.items()},
                bList=b, canonicalAt=ms_iso(doc.get('canonicalAt')) if doc.get('canonicalAt') else None)


# ───────────────────────── 凍結檔 ─────────────────────────
def canon(obj) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def seal(obj: dict) -> dict:
    o = json.loads(canon({k: v for k, v in obj.items() if k != 'sha256'}))       # 深拷貝成純 JSON（不與可變的模組全域如 PARAMS 共用參照）
    o['sha256'] = hashlib.sha256(canon(o).encode('utf-8')).hexdigest()
    return o


def verify_seal(obj: dict) -> bool:
    o = {k: v for k, v in obj.items() if k != 'sha256'}
    return hashlib.sha256(canon(o).encode('utf-8')).hexdigest() == obj.get('sha256')


def build_frozen(x: Ctx, t: int, ens: dict, store_names: list, kind: str, fs: dict = None, target_day: str = None,
                 anchor_day: str = None, command: str = None) -> dict:
    """為打分日 t 產生凍結檔內容（尚未寫檔）。"""
    s_day = x.dates[t]
    js, X = live_X(x, t, store_names)
    z, zs = score_live(ens['models'], X)
    pool = pool_mask(x, t, js)
    lu = x.LU[t, js]
    mk = x.mk[js]
    lists = dict(
        overallTop30=top_list(x, t, js, z, pool),
        twseTop30=top_list(x, t, js, z, pool & (mk == 'tse')),
        tpexTop30=top_list(x, t, js, z, pool & (mk == 'otc')),
        freshTop30=top_list(x, t, js, z, pool & ~lu),
        continuationTop30=top_list(x, t, js, z, pool & lu),
        researchUniverseTop30=top_list(x, t, js, z, np.ones(len(js), bool)),
    )
    site = site_block(s_day, fs)
    top30_codes = {e['code'] for e in lists['overallTop30'][:EVAL_TOP]}
    site30 = set(site.get('codes') or [])
    gen = now_iso()
    if target_day is None:
        d = datetime.date.fromisoformat(s_day) + datetime.timedelta(days=1)
        while d.weekday() >= 5: d += datetime.timedelta(days=1)
        target_day, target_assumed = d.isoformat(), True
    else:
        target_assumed = False
    cutoff = ens['cutoffDate']
    obj = dict(
        schema=SCHEMA, kind=kind, shadowMode=True,
        note='影子預測：不取代／不修改站上預測、不寫 Firestore。名單於打分日盤後凍結，待下一交易日收盤後以 a35_shadow_score.py 對答案。非投資建議。',
        scoringDay=s_day, targetDay=target_day, targetDayAssumed=target_assumed,
        generatedAt=gen, command=command,
        training=dict(rule=f's\' <= scoringDay index - {PURGE_DAYS} trading days; labels use s\'+1', cutoffDate=cutoff, cutoffIndex=int(ens['cutoffIdx']),
                      lastLabelDate=str(x.dates[ens['cutoffIdx'] + 1]) if ens['cutoffIdx'] + 1 < x.T else None,
                      firstDate=ens['infos'][0]['trainFirst'], rowsFull=ens['rowsFull'], positives=ens['pos'], fitRows=ens['infos'][0]['fitRows'],
                      anchorDay=anchor_day or s_day, retrain='daily (exact protocol)' if (anchor_day or s_day) == s_day else f'weekly block anchored at {anchor_day}',
                      seeds=list(SEEDS), params=PARAMS, negFrac=NEG_FRAC, scoreCombine='mean of per-seed z-scores over the scoring-day universe',
                      topImportance=ens['infos'][0]['topImp']),
        modelHash=ens['hash'], perSeedDigest=ens['digests'], trainSig=ens['trainSig'],
        features=dict(n=len(store_names), namesSha256=hashlib.sha256('|'.join(store_names).encode()).hexdigest()),
        universe=dict(rankUniverse=int(len(js)), pool=int(pool.sum()), poolByMarket={m: int((pool & (mk == m)).sum()) for m in ('tse', 'otc', '?')},
                      poolDefinition='close>=10, vol20>=300 lots, nan20==0, hist>=125d, no structural break in 125d; already-limit-up rows kept',
                      alreadyLimitUpInPool=int((pool & lu).sum()), tpexRowsPresent=int((mk == 'otc').sum())),
        lists=lists,
        site=dict(**site, overlapWithOverallTop30=len(top30_codes & site30), overlapCodes=sorted(top30_codes & site30)),
        marketContext=market_context(x, t),
    )
    return seal(obj)


def write_json(path: str, obj: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + f'.tmp{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(obj, f, ensure_ascii=False, sort_keys=True, indent=1)
    os.replace(tmp, path)
