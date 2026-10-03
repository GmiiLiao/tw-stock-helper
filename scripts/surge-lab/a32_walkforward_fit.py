"""a32_walkforward 步驟 2：訓練一個 HistGBDT（同一組超參數），對 2026 測試列打分。

用法：python3 a32_walkforward_fit.py <kind> <target: y|buy> <M: YYYY-MM|-> <seed> [k]
  kind
    OLD   ：s ≤ 2025-12-31（固定，只訓練一次；M 填 -）→ 打全部 2026 列
    NEW   ：只用 2026-01-01 ≤ s 且 s < start(M) 前 2 個交易日（purge：標籤用 s+1、y2 用 s+2）
    ALL   ：全部 s < start(M) 前 2 個交易日
    ALLW  ：同 ALL，但 2026 列樣本權重 ×3（HistGBDT.fit 支援 w，直接乘在權重上，不複製列）
    REC   ：只用最近 k 個月：start(M−k 月) ≤ s < start(M) 前 2 個交易日（「新近」對照）
    OLDSM ：OLD 期間隨機抽列，使正例數＝NEW(M) 的正例數（「樣本量」對照）
  target：y＝m_y（s+1 收漲停）；buy＝m_buy_lu（s+1 收漲停且開盤 < 漲停價）
共同設定：depth 4、600 棵、lr 0.05、l2 20、colsample 0.5、subsample 0.8、min_child_h 3；
負例抽 15%、權重 1/0.15 補償（正例全取、權重 1）。
輸出 .surge-cache/a32_walkforward_sc_<tag>.npz：rows（dataset 列索引，遞增）、score、200/400 棵分數、重要度。
"""
import os
import sys
import time
import json
import numpy as np
from a32_walkforward_gbdt import FastGBDT   # 與 models.HistGBDT 數學相同、輸出逐位相同，只是較快

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.path.join(HERE, '.surge-cache')
NEG_FRAC = 0.15
W2026 = 3.0
PURGE = 2
PARAMS = dict(n_trees=600, depth=4, lr=0.05, l2=20.0, colsample=0.5, subsample=0.8, min_child_h=3.0)
CHUNK = 150000


def month_start_idx(dates: np.ndarray, ym: str) -> int:
    return int(np.searchsorted(dates, f'{ym}-01'))


def shift_month(ym: str, k: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    t = y * 12 + (m - 1) - k
    return f'{t // 12:04d}-{t % 12 + 1:02d}'


def train_mask(kind: str, M: str, k: int, s: np.ndarray, sd: np.ndarray, dates: np.ndarray) -> np.ndarray:
    if kind in ('OLD', 'OLDSM'):
        return sd <= '2025-12-31'
    t0 = month_start_idx(dates, M)
    before = s < t0 - PURGE
    if kind == 'NEW': return before & (sd >= '2026-01-01')
    if kind in ('ALL', 'ALLW'): return before
    if kind == 'REC': return before & (sd >= f'{shift_month(M, k)}-01')
    raise ValueError(kind)


def main() -> None:
    kind, target, M, seed = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
    k = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    tag = f'{kind}{k if kind == "REC" else ""}_{target}_{M.replace("-", "")}_s{seed}'
    out_path = os.path.join(SP, f'a32_walkforward_sc_{tag}.npz')
    lock = os.path.join(SP, 'a32_walkforward_locks', tag)
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    if os.path.exists(out_path): print(f'{tag} 已存在，略過'); return
    try:
        os.close(os.open(lock, os.O_CREAT | os.O_EXCL))          # 兩個佇列共用時避免重複訓練
    except FileExistsError:
        print(f'{tag} 已有其他程序在跑，略過'); return
    t_start = time.time()
    Mt = np.load(os.path.join(SP, 'a32_walkforward_meta.npz'))
    X = np.load(os.path.join(SP, 'a32_walkforward_X.npy'), mmap_mode='r')
    dates = Mt['dates']; s = Mt['m_s']; sd = dates[s]
    y = (Mt['m_y'] if target == 'y' else Mt['m_buy_lu']).astype(np.int8)
    rng = np.random.default_rng(10_000 + seed * 97 + sum(map(ord, tag)))
    tm = train_mask(kind, M, k, s, sd, dates)
    if kind == 'OLDSM':
        ref = train_mask('NEW', M, 0, s, sd, dates)
        n_pos_target = int(y[ref].sum())
        pos = np.nonzero(tm & (y == 1))[0]
        frac = n_pos_target / len(pos)
        tm = tm & (rng.random(len(y)) < frac)
    rows = np.nonzero(tm)[0]
    keep = (y[rows] == 1) | (rng.random(len(rows)) < NEG_FRAC)
    tr = rows[keep]
    w = np.where(y[tr] == 1, 1.0, 1.0 / NEG_FRAC)
    if kind == 'ALLW':
        w = w * np.where(sd[tr] >= '2026-01-01', W2026, 1.0)
    info = dict(tag=tag, kind=kind, target=target, M=M, seed=seed, k=k,
                train_first=str(dates[s[rows].min()]), train_last=str(dates[s[rows].max()]), train_days=int(len(np.unique(s[rows]))),
                train_rows_full=int(len(rows)), train_pos=int(y[rows].sum()), fit_rows=int(len(tr)),
                train_base=float(y[rows].mean()), pos_2026_share=float((sd[rows][y[rows] == 1] >= '2026-01-01').mean()))
    print(json.dumps(info, ensure_ascii=False), flush=True)
    Xtr = np.asarray(X[tr])
    m = FastGBDT(seed=seed, **PARAMS).fit(Xtr, y[tr], w=w)
    del Xtr
    info['fit_sec'] = round(time.time() - t_start)
    lo = month_start_idx(dates, M) if kind != 'OLD' else month_start_idx(dates, '2026-01')
    sc_rows = np.nonzero(s >= lo)[0]
    out = {f'score_{n}': np.empty(len(sc_rows), np.float32) for n in (200, 400, 600)}
    for a in range(0, len(sc_rows), CHUNK):
        Xs = np.asarray(X[sc_rows[a:a + CHUNK]])
        for n in (200, 400, 600):
            out[f'score_{n}'][a:a + CHUNK] = m.decision_function(Xs, n_trees=n)
    names = Mt['names']
    imp = m.gain_imp / max(m.gain_imp.sum(), 1e-12)
    info['top_imp'] = [(str(names[i]), round(float(imp[i]) * 100, 2)) for i in np.argsort(-imp)[:20]]
    info['total_sec'] = round(time.time() - t_start)
    np.savez(out_path, rows=sc_rows, imp=imp.astype(np.float32),
             info=json.dumps(info, ensure_ascii=False), **out)
    print(json.dumps(info, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
