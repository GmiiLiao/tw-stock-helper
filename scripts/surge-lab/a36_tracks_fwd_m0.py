"""M0 前向推論（G1 第 4 項 (iii)；前向登錄 T1-TRACKS-FWD-2026-10-05 的 M0 參照清單與等名額對照）。

M0＝凍結的 official 模型（cv_official 'official' 欄位、run_cv 協定、種子 0／1／2）。訓練段逐字照 a36_tracks_fit.run_m0（訓練列、
負例抽樣 default_rng(seed＋ts)、HistGBDT 超參數都相同；以「同一折、同一種子的資料集測試列分數與已存檢查點逐位相同」驗證）。
唯一的修正在推論端：同日百分位的母體＝當日 M 軌全部列（含只卡 brk_future、s 收盤時無法得知的列；不含 TDR），
不再沿用釘住資料集的母體（DEV-008 第 8 點）。模型的特徵編碼維持訓練時的樣子（days_since_lu 仍是 999 編碼，見 DEV-009）。
需要 SURGE_CACHE 指向含釘住資料集的快取（.surge-cache-T 或其 APFS 複本）。未扣成本·非投資建議。
"""
import hashlib
import os
import pickle

import numpy as np

import a36_tracks_fit as FIT
import a36_tracks_fwd_rules as FR
import run_cv
from models import HistGBDT

FWD_TS = 1022            # 前向凍結模型的 ts＝釘住面板最後一日（2026-10-02）的索引；訓練列 s ≤ ts−11（run_cv purge）
SEEDS = FIT.SEEDS


def m0_model(ts: int, seed: int):
    """FIT.run_m0 的訓練段（同一組列與抽樣），回傳 (模型, M0 欄位索引, 訓練資訊)。"""
    D, R, cols = FIT.m0_data()
    s, y = D['s'], D['y']
    tr = np.nonzero((s <= ts - run_cv.PURGE) & ~D['extra'])[0]
    rng = np.random.default_rng(seed + ts)
    neg, pos = tr[y[tr] == 0], tr[y[tr] == 1]
    tr_s = np.concatenate([pos, rng.choice(neg, int(len(neg) * run_cv.NEG_FRAC), replace=False)])
    m = HistGBDT(**{**run_cv.GB, 'seed': seed}).fit(np.asarray(R[tr_s])[:, cols], y[tr_s])
    return m, cols, dict(ts=int(ts), seed=int(seed), n_train=int(len(tr_s)), n_pos=int(len(pos)), last_train_s=int(ts - run_cv.PURGE))


def m0_feature_spec() -> tuple:
    """(M0 欄名清單, 是否轉同日百分位的遮罩)：cv_official.ranks 對 t1L 任務只保留 mkt_* 原值。"""
    D, _, cols = FIT.m0_data()
    names = [D['names'][k] for k in cols]
    return names, np.array([not (n.startswith('mkt_') or n in D['raw_names']) for n in names])


def population_ranks(day, F_rows: dict, names, rank_mask) -> np.ndarray:
    """母體列（當日 M 軌全部列）的 M0 輸入：同日百分位只在這些列之間排名。F_rows[name]＝與 day 對齊的原值（float32，訓練時的編碼）。"""
    X = np.stack([np.asarray(F_rows[n], np.float32) for n in names], 1)
    return FR.rank_pct_by_day(day, X, rank_mask)


def score(models: list, Xr: np.ndarray) -> np.ndarray:
    """三種子平均，同 a36_tracks_eval.model_scores 的 M0 算式：((z0＋z1)＋z2)/3 後轉 float32。"""
    z = [m.decision_function(Xr) for m in models]
    return (((z[0] + z[1]) + z[2]) / 3).astype(np.float32).astype(np.float64)


def fit_frozen_forward(ts: int = FWD_TS) -> list:
    return [m0_model(ts, sd)[0] for sd in SEEDS]


def save_models(models: list, path: str) -> str:
    """pickle 存檔並回傳 sha256（前向第一份凍結名單記錄這個雜湊，之後不得更換；改模型要另立修訂）。"""
    tmp = f'{path}.tmp{os.getpid()}'
    with open(tmp, 'wb') as f:
        pickle.dump(dict(models=models, ts=FWD_TS, seeds=list(SEEDS), protocol='run_cv（cv_official official）'), f, protocol=5)
    os.replace(tmp, path)
    h = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    return h
