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
import re
import sys
import gzip
import json
import time
import pickle
import hashlib
import datetime
import subprocess
import plistlib

# 研究用環境變數（官方漲停價／營收版本／PIT 嚴格／資料集後綴）——影子 v1 的訓練矩陣與上線特徵都不吃這些。
# 同一個 shell 先 export 跑研究、再跑影子時，影子會悄悄改用別的漲停價／營收，或在 build.py 的形狀檢查處當掉（2026-10-04 審查）。
RESEARCH_ENV_VARS = ('SURGE_OFFICIAL_LIMIT', 'SURGE_REVENUE', 'SURGE_PIT_STRICT', 'SURGE_DATASET_SUFFIX')


def research_env_leak(env) -> list:
    """回傳環境中有設的研究用變數名（有設＝存在，空字串也算）。"""
    return [k for k in RESEARCH_ENV_VARS if k in env]


if research_env_leak(os.environ):
    sys.exit(f'a35_shadow：環境變數 {", ".join(research_env_leak(os.environ))} 已設定（研究用）——影子名單拒跑。'
             f'請在乾淨的 shell 執行（unset {" ".join(research_env_leak(os.environ))}）')

import numpy as np                                             # noqa: E402
import pandas as pd                                            # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path: sys.path.insert(0, HERE)
import build as B                                              # noqa: E402
from a32_walkforward_gbdt import FastGBDT                      # noqa: E402

SP = B.SP
OUT = os.path.join(HERE, 'out')
MODEL_DIR = os.path.join(SP, 'a35_models')
X_PATH = os.path.join(SP, 'a32_walkforward_X.npy')
META_PATH = os.path.join(SP, 'a32_walkforward_meta.npz')
MATRIX_SIDECAR = os.path.join(SP, 'a32_walkforward_build.json')     # a32_walkforward_prep.py 寫：矩陣內容雜湊＋建置時的 revenue.json 雜湊
REVENUE_PATH = os.path.join(SP, 'revenue.json')
META_JS = os.path.join(HERE, 'a35_shadow_meta.mjs')
DAEMON_PLIST = os.path.expanduser('~/Library/LaunchAgents/com.gmii.twstock.ai-daemon.plist')
MIRROR_HOLIDAY_DIR = os.path.join(B.REPO, 'second-brain/official/openapi.twse.com.tw/twse_oa_holidaySchedule_holidaySchedule')
TZ = datetime.timezone(datetime.timedelta(hours=8))
FREEZE_HHMM = (9, 0)            # 事前凍結：凍結時刻必須早於目標日 09:00（台北）——與 surge-shadow-report.forwardFreezeOk 同一條
TRADING_MARK_RE = re.compile(r'開始交易|最後交易')   # 官方休市表裡的「交易日標記」不是休市（sync-trading-calendar.mjs 同規則）

# a35_shadow_list.py 的結束碼（a35_shadow_daily.mjs 依此分類）
EXIT_MISSED, EXIT_NOT_READY, EXIT_INCONSISTENT, EXIT_CALENDAR = 4, 5, 6, 7

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


def _model_path(cutoff_date: str, seed: int, sig: str, data_sig: str) -> str:
    """模型快取鍵＝超參數＋截止日＋seed＋訓練列簽章（列與標籤）＋特徵資料簽章（矩陣內容＋revenue.json）。
    只用訓練列簽章時，矩陣或營收被重建後同截止日會誤用舊模型（2026-10-04 審查）；modelHash 仍只由 trainSig＋模型內容決定。"""
    ph = hashlib.sha256(json.dumps([PARAMS, NEG_FRAC, PURGE_DAYS], sort_keys=True).encode()).hexdigest()[:8]
    return os.path.join(MODEL_DIR, f'shadow_{cutoff_date}_s{seed}_{ph}_{sig[:12]}_d{data_sig[:12]}.pkl')


def train_ensembles(cutoffs: list, seeds=SEEDS, workers: int = 3, reuse: bool = True, store: Store = None, data_sig: str = None) -> dict:
    """一次訓練（或載入快取）多個截止日的 seed 模型，所有 (截止日, seed) 工作共用同一個程序池。
    data_sig：特徵資料簽章（feature_data()['sig']）；沒給就當場算。
    回傳 {cutoff_idx: dict(models, infos, digests, hash, cutoffDate, cutoffIdx, trainSig, rowsFull, pos)}。"""
    from concurrent.futures import ProcessPoolExecutor
    store = store or Store()
    data_sig = data_sig or feature_data()['sig']
    os.makedirs(MODEL_DIR, exist_ok=True)
    res, jobs, meta = {}, [], {}
    for ci in sorted(set(cutoffs)):
        check_store(store, ci)
        cd = str(store.dates[ci]); rows = store.rows_upto(ci); sig = train_sig(rows, store.y)
        meta[ci] = (cd, rows, sig)
        for sd in seeds:
            p = _model_path(cd, sd, sig, data_sig)
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
            path = _model_path(cd, sd, sig, data_sig); tmp = path + f'.tmp{os.getpid()}'
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


def train_ensemble(cutoff_idx: int, seeds=SEEDS, workers: int = 3, reuse: bool = True, store: Store = None, data_sig: str = None) -> dict:
    return train_ensembles([cutoff_idx], seeds, workers, reuse, store, data_sig)[cutoff_idx]


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


def cred_path() -> str:
    """Firestore 憑證路徑：環境變數 GOOGLE_APPLICATION_CREDENTIALS 優先，否則讀 daemon 的 launchd plist（只取路徑，不讀內容、不印出）。"""
    cred = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    if cred and os.path.exists(cred): return cred
    try:
        pl = plistlib.load(open(DAEMON_PLIST, 'rb'))
        cred = (pl.get('EnvironmentVariables') or {}).get('GOOGLE_APPLICATION_CREDENTIALS')
    except Exception as e:
        log(f'  讀 plist 失敗：{e}')
        return None
    return cred if cred and os.path.exists(cred) else None


def site_from_firestore(days: list) -> dict:
    """唯讀 Firestore：limitUpForecast/pred-{day}（a35_shadow_site.mjs；憑證取自環境變數或 launchd plist，不印出）。失敗回 {}（呼叫端退回記分板快照）。"""
    cred = cred_path()
    if not cred:
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


# ───────────────────────── 休市日曆／凍結時鐘閘（每日自動化，2026-10-04） ─────────────────────────
class CalendarError(RuntimeError):
    """休市日曆讀不到或不涵蓋所需年份——不可退回「下一個週一～五」（10-09、10-26 是補假）。"""


def roc_to_iso(roc) -> str:
    s = str(roc or '')
    return f'{int(s[:3]) + 1911}-{s[3:5]}-{s[5:7]}' if re.fullmatch(r'\d{7}', s) else None


def make_calendar(fs_doc: dict = None, mirror_rows: list = None) -> dict:
    """合併兩個來源成 {holidays:set(iso), covered:set(年), sources:[…]}；兩者皆無回 None。
    ① Firestore system/tradingCalendar（sync-trading-calendar.mjs：官方表＋臨時休市；涵蓋 coverYear）
    ② 本機官方鏡像 twse_oa_holidaySchedule（openapi 休市表原文；/開始交易|最後交易/ 是交易日標記，其餘是休市）。
    取聯集：多認一天休市只會讓目標日往後找，不會把休市日當成目標日。"""
    holidays, covered, sources = set(), set(), []
    if fs_doc and isinstance(fs_doc.get('holidays'), list) and fs_doc['holidays']:
        holidays |= {str(d) for d in fs_doc['holidays']}
        cy = fs_doc.get('coverYear') or (str(fs_doc['official'][0])[:4] if fs_doc.get('official') else None)
        if cy: covered.add(int(cy))
        sources.append('firestore:system/tradingCalendar')
    if mirror_rows:
        n = 0
        for row in mirror_rows:
            iso = roc_to_iso((row or {}).get('Date'))
            if not iso: continue
            n += 1; covered.add(int(iso[:4]))
            if not TRADING_MARK_RE.search(str(row.get('Name') or '')): holidays.add(iso)
        if n: sources.append('mirror:twse_oa_holidaySchedule')
    return dict(holidays=holidays, covered=covered, sources=sources) if sources else None


def next_trading_day(day: str, cal: dict) -> str:
    """day 之後第一個交易日（平日且不在休市表）。平日落在日曆未涵蓋的年份 ⇒ CalendarError（不猜）。"""
    if not cal: raise CalendarError('沒有休市日曆（Firestore 與本機鏡像都讀不到）')
    d = datetime.date.fromisoformat(day)
    for _ in range(31):
        d += datetime.timedelta(days=1)
        if d.weekday() >= 5: continue
        if d.year not in cal['covered']: raise CalendarError(f'休市日曆未涵蓋 {d.year} 年（來源 {cal["sources"]}；涵蓋 {sorted(cal["covered"])}）——無法判定 {day} 的下一交易日')
        if d.isoformat() not in cal['holidays']: return d.isoformat()
    raise CalendarError(f'{day} 之後 31 天內找不到交易日（日曆異常）')


def calendar_from_firestore() -> dict:
    """唯讀 Firestore system/tradingCalendar（a35_shadow_meta.mjs calendar）。失敗回 None。"""
    cred = cred_path()
    if not cred: return None
    try:
        r = subprocess.run(['node', META_JS, 'calendar'], capture_output=True, text=True, timeout=120,
                           env=dict(os.environ, GOOGLE_APPLICATION_CREDENTIALS=cred), cwd=HERE)
        if r.returncode != 0:
            log(f'  休市日曆（Firestore）讀取失敗：{r.stderr.strip()[-300:]}'); return None
        return json.loads(r.stdout)
    except Exception as e:
        log(f'  休市日曆（Firestore）讀取例外：{e}'); return None


def mirror_holiday_rows(mirror_dir: str = MIRROR_HOLIDAY_DIR) -> list:
    """本機官方鏡像的休市表原文（manifest.lastFile）。沒有鏡像回 None。"""
    try:
        mf = json.load(open(os.path.join(mirror_dir, '_manifest.json')))
        with gzip.open(os.path.join(mirror_dir, mf['lastFile']), 'rt', encoding='utf-8') as f:
            return json.load(f).get('payload') or None
    except Exception:
        return None


def load_calendar(use_firestore: bool = True, mirror_dir: str = MIRROR_HOLIDAY_DIR) -> dict:
    return make_calendar(calendar_from_firestore() if use_firestore else None, mirror_holiday_rows(mirror_dir))


def freeze_deadline(target_day: str) -> datetime.datetime:
    y, m, d = map(int, target_day.split('-'))
    return datetime.datetime(y, m, d, *FREEZE_HHMM, tzinfo=TZ)


def frozen_before_open(generated_at: str, target_day: str) -> bool:
    """凍結時刻（ISO，含時區）是否早於目標日 09:00 台北——不早於就不算事前凍結（publish 的 forwardFreezeOk 同一條）。"""
    try: t = datetime.datetime.fromisoformat(generated_at)
    except (TypeError, ValueError): return False
    if t.tzinfo is None: return False
    return t < freeze_deadline(target_day)


# ───────────────────────── 凍結檔的資料依據（每日自動化，2026-10-04） ─────────────────────────
def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 24), b''): h.update(b)
    return h.hexdigest()


def matrix_id() -> str:
    """訓練矩陣（X.npy＋meta.npz）的內容識別碼（與 a32_walkforward_prep 側檔的 buildId 同一支公式）。
    每次都重算、不信任側檔：舊版 prep（不寫側檔）改寫矩陣後，側檔的 buildId 就對不上 ⇒ stale-sidecar。"""
    from a32_walkforward_prep import matrix_build_id
    return matrix_build_id(X_PATH, META_PATH)


def read_json(path: str) -> dict:
    try:
        with open(path, encoding='utf-8') as f: return json.load(f)
    except (OSError, ValueError):
        return None


def matrix_consistency(sidecar: dict, mid: str, revenue_now: str) -> str:
    """訓練矩陣與「現在上線特徵要讀的 revenue.json」是否同一版：
    ok｜no-sidecar（舊版建置、沒有側檔）｜stale-sidecar（側檔記的不是目前這份矩陣）｜unknown-revenue（建置時沒記營收）｜revenue-changed。"""
    if not sidecar: return 'no-sidecar'
    if sidecar.get('buildId') != mid: return 'stale-sidecar'
    if not sidecar.get('revenueSha256'): return 'unknown-revenue'
    return 'ok' if sidecar['revenueSha256'] == revenue_now else 'revenue-changed'


def feature_data() -> dict:
    """特徵資料簽章：模型快取鍵與凍結檔都記。sig＝sha256(矩陣內容雜湊＋目前 revenue.json 雜湊)。"""
    mid, rev = matrix_id(), file_sha256(REVENUE_PATH)
    sc = read_json(MATRIX_SIDECAR)
    sig = hashlib.sha256(json.dumps({'matrix': mid, 'revenue': rev}, sort_keys=True).encode()).hexdigest()
    return dict(sig=sig, matrixId=mid, revenueSha256=rev, matrixRevenueSha256=(sc or {}).get('revenueSha256'),
                matrixBuilt=(sc or {}).get('generatedAt'), consistency=matrix_consistency(sc, mid, rev))


def rebuild_reasons(meta_dates: list, max_s_idx: int, panel_dates: list, day: str, consistency: str) -> list:
    """訓練矩陣要不要重建（build_lu1.py → a32_walkforward_prep.py）。回傳理由清單（空＝不必）。
    · alignment：面板日期序列不是矩陣日期的延伸（中間補日／重排會讓 s 索引錯位）
    · rows：矩陣最晚的 s < 打分日索引 − PURGE_DAYS（訓練列不夠新）
    · 其餘＝matrix_consistency 的非 ok 狀態（沒有側檔／側檔過期／營收版本不同）"""
    if day not in panel_dates: raise ValueError(f'面板沒有 {day}')
    out = []
    n = len(meta_dates)
    if [str(d) for d in meta_dates] != [str(d) for d in panel_dates[:n]]: out.append('alignment')
    if max_s_idx < panel_dates.index(day) - PURGE_DAYS: out.append('rows')
    if consistency != 'ok': out.append(consistency)
    return out


def data_basis(day: str) -> dict:
    """打分日 day 在本機快取 chipArchive.json.gz 的到齊狀態（a35_shadow_meta.mjs basis：與 daemon 定版閘門同一支 archiveDayStatus）。
    回傳 {date, found, ready, missing, basis, nonOfficialOtcClose, gapFixSource, otcPending, complete, nClose} 或 {error}。"""
    try:
        r = subprocess.run(['node', META_JS, 'basis', day], capture_output=True, text=True, timeout=180,
                           env=dict(os.environ, SURGE_CACHE=SP), cwd=HERE)
        if r.returncode != 0: return dict(date=day, error=(r.stderr.strip() or f'exit {r.returncode}')[-300:])
        return json.loads(r.stdout)
    except Exception as e:
        return dict(date=day, error=str(e)[-300:])


def exright_coverage_from(dates: list, upto: str, history_to: str, delta_to: str, cover: list) -> dict:
    """exright-history.json 之後、到 upto 為止每個面板日的除權息涵蓋狀態（純函式）。
    fetched＝上市＋上櫃都抓到；fetched-twse-only＝上櫃失敗；error＝兩市都失敗；delta-twse-only＝只有研究快取的上市差額；missing＝沒有。"""
    rec = {c[0]: c for c in cover or []}
    days = []
    for d in dates:
        if not (history_to < d <= upto): continue
        if d in rec:
            _d, err, _counts, twse_only = rec[d]
            st = 'fetched' if not err else ('fetched-twse-only' if twse_only else 'error')
        elif delta_to and d <= delta_to: st = 'delta-twse-only'
        else: st = 'missing'
        days.append(dict(date=d, status=st))
    return dict(historyTo=history_to, deltaTo=delta_to, days=days, complete=all(x['status'] == 'fetched' for x in days))


def exright_coverage(dates: list, upto: str) -> dict:
    hist = (read_json(os.path.join(B.REPO, 'scripts/data/exright-history.json')) or {}).get('to') or '0000-00-00'
    delta = (read_json(f'{SP}/exright_delta.json') or {}).get('to')
    return exright_coverage_from(dates, upto, hist, delta, load_extra_exright()[1])


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
                 anchor_day: str = None, command: str = None, extra: dict = None) -> dict:
    """為打分日 t 產生凍結檔內容（尚未寫檔）。target_day 必填（由休市日曆或面板實際下一日決定；不再猜「下一個平日」）。
    extra：附加的頂層中繼欄位（每日名單的 dataBasis／revenueSha256／exrightCoverage…；鍵不可與既有欄位重複），一併封印。"""
    if not target_day: raise ValueError('build_frozen 需要 target_day（休市日曆推得的下一交易日）')
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
    if extra:
        clash = sorted(set(extra) & set(obj))
        if clash: raise ValueError(f'extra 欄位與既有欄位重複：{clash}')
        obj.update(extra)
    return seal(obj)


def write_json(path: str, obj: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + f'.tmp{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(obj, f, ensure_ascii=False, sort_keys=True, indent=1)
    os.replace(tmp, path)
