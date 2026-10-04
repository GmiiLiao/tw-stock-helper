"""T1 分軌研究：代理（atr14、n_lu_250、r20、c_ma120、combo）與池內排名——登錄 proxies 一節的唯一實作。

兩種模式走同一組函式：
  registered（登錄定義）：組成項套短歷史 NaN；combo 至少 3 項有值否則 NaN；同分以 u(s, code)＝sha256('{date}|{code}|t1tracks')/2^256 破
             （值大者優先、u 大者優先；NaN 排最後，只在當日有值者不足 K 檔時才會入選）。
  repro（G0.9 重現模式）：不套短歷史 NaN；combo 照 tradability.rank_pool 的 fillna(0.0)、不設最少項數；
             同分以 np.random.default_rng(7).random(len(df))（quant 的列順序）破；池用 tiers 的定義。
組成項公式逐字同 quant.proxies（＝build.compute_features 的同名特徵；float64，只用 ≤ s）。未扣成本·非投資建議。
"""
import hashlib

import numpy as np
import pandas as pd

COMPONENTS = ('atr14', 'n_lu_250', 'r20', 'c_ma120')
COMBO_MIN = 3


def components(A: dict, LU: np.ndarray) -> dict:
    """quant.proxies 的四個代理（T×N float64）。"""
    C, H, Lo = (pd.DataFrame(A[k]) for k in ('C', 'H', 'L'))
    pc = C.shift(1)
    tr = pd.DataFrame(np.fmax(np.fmax((H - Lo).values, (H - pc).abs().values), (Lo - pc).abs().values))
    return {'atr14': (tr.rolling(14, min_periods=12).mean() / C).values,
            'n_lu_250': pd.DataFrame(LU.astype(float)).rolling(250, min_periods=1).sum().values,
            'r20': (C / C.shift(20) - 1).values,
            'c_ma120': (C / C.rolling(120, min_periods=108).mean() - 1).values}


def u_hash(dates, codes, s, j) -> np.ndarray:
    """登錄 tie_noise：u(s, code)＝int(sha256('{date}|{code}|t1tracks'), 16) / 2**256（與列順序無關）。"""
    d, c = np.asarray(dates), np.asarray(codes)
    return np.array([int(hashlib.sha256(f'{d[a]}|{c[b]}|t1tracks'.encode()).hexdigest(), 16) / 2 ** 256 for a, b in zip(s, j)])


def pool_pct(s: np.ndarray, x: np.ndarray) -> np.ndarray:
    """池內同日百分位：groupby(s).rank(pct=True, method='average')，NaN 不參與（quant／tradability 同式）。"""
    return pd.Series(x).groupby(s).rank(pct=True, method='average').values


def combo(s: np.ndarray, comps: dict, mode: str):
    """池內 combo 與有值項數。registered：≥3 項才有值；repro：全 NaN 記 0.0（tradability.rank_pool）。"""
    pcts = pd.concat([pd.Series(pool_pct(s, comps[k])) for k in COMPONENTS], axis=1)
    n_ok = pcts.notna().sum(axis=1).values
    mean = pcts.mean(axis=1, skipna=True).values                 # 同 tradability.rank_pool 的算術（兩模式共用）
    if mode == 'repro':
        return np.where(n_ok > 0, mean, 0.0), n_ok               # ＝ .fillna(0.0)
    return np.where(n_ok >= COMBO_MIN, mean, np.nan), n_ok


def rank_in_day(s: np.ndarray, v: np.ndarray, tie: np.ndarray, mode: str) -> np.ndarray:
    """池內每日名次（1＝最高）。值 NaN 視為 −∞ 排最後。registered：同值時 tie（u）大者優先；repro：同值時 tie（亂數）小者優先
    （tradability.rank_pool：sort_values(['s', −v, r])）。"""
    neg = np.where(np.isfinite(v), -v, np.inf)
    t = -tie if mode == 'registered' else tie
    o = np.lexsort((t, neg, s))
    ss = s[o]
    start = np.r_[0, np.nonzero(np.diff(ss))[0] + 1]
    first = np.repeat(start, np.diff(np.r_[start, len(ss)]))
    rk = np.empty(len(s), np.int64)
    rk[o] = np.arange(len(ss)) - first + 1
    return rk


def apply_nan_rule(comps: dict, hist_len: np.ndarray, windows: dict) -> dict:
    """登錄 §4：hist_len < w(f) ⇒ NaN（代理組成項同樣適用）。"""
    return {k: np.where(hist_len < windows[k], np.nan, v) for k, v in comps.items()}


def proxy_scores(s, comps_rows: dict, proxy: str, mode: str):
    """池內（s 已限定在池列）代理分數：('atr14' 或其他單項) 原值；'combo' 池內重算。回傳 (分數, combo 有值項數或 None)。"""
    if proxy == 'combo':
        return combo(s, comps_rows, mode)
    return comps_rows[proxy].astype(np.float64), None
