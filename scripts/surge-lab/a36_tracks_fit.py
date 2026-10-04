"""T1 分軌研究 Phase 1：模型擬合（事前登錄 T1-TRACKS-PREREG-2026-10-04 v2；偏差寫 tracks/DEVIATIONS_t1_tracks.md）。

訓練協定逐字沿用 run_cv（依季分折 expanding、purge 11、正例全留、負例抽 10%（rng＝default_rng(seed+ts)）、
HistGBDT(run_cv.GB) 種子 0／1／2，分數＝三種子平均）。每個 (模型, 折, 種子) 是一個獨立工作，結果寫成檢查點
SURGE_CACHE/tracks/cv/a36_fit_{模型}_{折}_s{種子}.npz（已存在就跳過＝從檢查點續跑），可多個行程平行跑。

模型：
  M0   凍結的 official 模型：cv_official 'official' 欄位、cv_official.ranks 轉換、dataset_t1L_off 全部列（含 TDR）訓練。
       G0.5 以 SEL+HC 七折重擬並逐位比對 a36_ref_official_cv_scores_t1L.npz；HOLDOUT 折只在哨兵 commit 後跑。
       只卡 brk_future 的 M 列：同一組各折模型推論，百分位以同日資料集列錨定（登錄 training_protocol.brk_future_rows_scoring）。
  M0s  M0*（對照，不參賽）：新管線（official − rk_* + age_cap、短歷史 NaN、M 錨定百分位）只用 M 列訓練。
  Mp1  同上，用 M ∪ Mp 列訓練；對 M ∪ Mp 列評分（M′ 清單）。
  R1   只用 R 列；特徵＋R 專用特徵。R2：M ∪ R，特徵同 R1 再加 is_R。
  S1   只用 S 列；特徵＋原值 log10(vol20)、o_log_mcap、log10(收盤)。S2：M ∪ S，再加 is_S。
新模型訓練列排除 NE 列（軌道檔本來就不含）與 s 索引 < 125 的列。
用法：python3 a36_tracks_fit.py ranks｜prep｜run --models M0,Mp1 --windows SEL,HC [--part i --of n]｜status
未扣成本·事後欄位以 m_ 標示·非投資建議。
"""
import json
import os
import sys
import time

import numpy as np
import pandas as pd

import a36_tracks_lib as L
import build as B
import cv_official as CVO
import fingerprint as FP
import run_cv
from models import HistGBDT

TRACK_DIR = os.path.join(B.SP, 'tracks')
CV_DIR = os.path.join(TRACK_DIR, 'cv')
OUT_DIR = os.path.join(L.LAB, 'out', 'tracks_t1')
SEEDS = (0, 1, 2)
MIN_TRAIN_S = 125
PINNED_FP = 'fac51da2a75183426e76a02f82c7039dfbbe9577287f4b9b4b81cc28bd067d2a'
FW_SHA256 = '3dcf0e0a86815c3e19e5500809b92f00a31ebc81cf07000c374ebc592240d459'
WINDOW_KEYS = {'SEL': 'SELECTION', 'HC': 'HALF_CONFIRM', 'HO': 'HOLDOUT'}
MODEL_TRACKS = ('M', 'Mp', 'R', 'S')
# R 專用特徵中「0／1 旗標與計數」不轉百分位（登錄 anchored_percentile.raw_features）；整數天數類同屬計數（DEV-003）
R_RAW = ('r_seg_len', 'r_days_since_seg_end', 'r_n_seg_250', 'dk_s', 'dp_cnt20', 'dp_cnt60', 'dp_since', 'dp_n250', 'at_known5', 'at_known20')
S1_RAW = ('log10_vol20', 'raw_o_log_mcap', 'log10_close')
MODELS = {
    'M0s': dict(train=('M',), score=('M',), extra=(), flag=None),
    'Mp1': dict(train=('M', 'Mp'), score=('M', 'Mp'), extra=(), flag=None),
    'R1': dict(train=('R',), score=('R',), extra='R', flag=None),
    'R2': dict(train=('M', 'R'), score=('R',), extra='R', flag='is_R'),
    'S1': dict(train=('S',), score=('S',), extra='S1', flag=None),
    'S2': dict(train=('M', 'S'), score=('S',), extra=(), flag='is_S'),
}


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def atomic_savez(path, **arrs):
    tmp = f'{path}.tmp{os.getpid()}.npz'
    np.savez_compressed(tmp, **arrs)
    os.replace(tmp, path)


def check_feature_windows() -> dict:
    """G0.12：評估時 feature_windows_t1.json 的 sha256 必須等於已 commit 的封存值，否則拒跑。"""
    path = os.path.join(OUT_DIR, 'feature_windows_t1.json')
    sha = L.file_sha256(path)
    if sha != FW_SHA256:
        raise SystemExit(f'feature_windows_t1.json sha256 {sha} ≠ 封存 {FW_SHA256}：拒跑')
    return json.load(open(path, encoding='utf-8'))['windows']


def folds(reg, dates, wins) -> list:
    """[(折名, ts, te)]；ts／te＝折起訖在面板的 searchsorted 索引（同 run_cv.folds）。"""
    d = np.array(dates)
    out = []
    for w in wins:
        for k, (a, b) in enumerate(reg['windows'][WINDOW_KEYS[w]]['folds']):
            out.append((f'{w}{k + 1}', int(np.searchsorted(d, a)), int(np.searchsorted(d, b))))
    return out


def ckpt_path(model, fold, seed):
    return os.path.join(CV_DIR, f'a36_fit_{model}_{fold}_s{seed}.npz')


# ───────────────────────── M0（凍結 official）─────────────────────────
def m0_ranks(D) -> np.ndarray:
    """逐字同 cv_official.ranks（非 mkt_、非原值欄位轉同日百分位）；快取改寫到 a36_ 檔（不得新增非 a36 檔到 SURGE_CACHE）。"""
    cache = os.path.join(TRACK_DIR, 'a36_m0_ranks_t1L_off.npy')
    meta = cache + '.json'
    if os.path.exists(cache) and os.path.exists(meta) and json.load(open(meta))['dataset_sha'] == D['dataset_sha']:
        R = np.load(cache, mmap_mode='r')
        if R.shape == D['X'].shape:
            return R
    R = np.empty_like(D['X'])
    s = D['s']
    for k, nm in enumerate(D['names']):
        if nm.startswith('mkt_') or nm in D['raw_names']:
            R[:, k] = D['X'][:, k]
        else:
            R[:, k] = pd.Series(D['X'][:, k].astype(np.float64)).groupby(s).rank(pct=True, method='average').values.astype(np.float32)
    tmp = f'{cache}.tmp{os.getpid()}.npy'
    np.save(tmp, R)
    os.replace(tmp, cache)
    json.dump(dict(dataset_sha=D['dataset_sha'], shape=list(R.shape)), open(meta, 'w'))
    return np.load(cache, mmap_mode='r')


def m0_cols(names) -> list:
    """逐字同 cv_official.main 的 all_cols（'official' 設定）。"""
    ix = {n: i for i, n in enumerate(names)}
    off = [g for gl in CVO.GROUPS.values() for g in gl]
    new_names = {n for gl in CVO.GROUPS.values() for n in gl} | {n for gl in CVO.EXPERIMENTAL.values() for n in gl}
    base_cols = [i for i, n in enumerate(names) if not n.startswith('o_') and n not in new_names]
    nonoff = {ix[n] for n in CVO.NON_OFFICIAL_BASE if n in ix}
    return [i for i in base_cols if i not in nonoff] + [ix[n] for n in off if n in ix]


_M0 = {}


def m0_data():
    if not _M0:
        D = CVO.load('t1L')
        if D['dataset_sha'] != PINNED_FP:
            raise SystemExit(f'資料集內容指紋 {D["dataset_sha"]} ≠ 釘住 {PINNED_FP}：拒跑')
        _M0.update(D=D, R=m0_ranks(D), cols=m0_cols(D['names']))
    return _M0['D'], _M0['R'], _M0['cols']


_BF = {}


def bf_only_rows():
    """M 軌中不在釘住資料集的列（只卡 brk_future）：(s, j) 與錨定百分位後的 official 特徵（以同日資料集列錨定）。"""
    if _BF:
        return _BF['s'], _BF['j'], _BF['X']
    D, R, cols = m0_data()
    z = np.load(os.path.join(TRACK_DIR, 'a36_tracks_M.npz'))
    keep = z['p_in_pinned_dataset'] == 0
    s, j = z['m_s'][keep], z['m_j'][keep]
    X = np.full((len(s), len(D['names'])), np.nan, np.float32)      # 只填 M0 用到的 official 欄位；其餘欄位 M0 不讀
    for k in cols:
        nm = D['names'][k]
        v = z[f'f_{nm}'][keep].astype(np.float64)
        if nm.startswith('mkt_'):
            X[:, k] = v
            continue
        X[:, k] = anchored_pct_by_day(D['s'], D['X'][:, k].astype(np.float64), s, v)
    _BF.update(s=s, j=j, X=X)
    return s, j, X


def run_m0(fold, ts, te, seed):
    """run_cv.run 的單折單種子（逐字同一套索引、抽樣與模型）；另推論只卡 brk_future 的 M 列。"""
    D, R, cols = m0_data()
    s, y = D['s'], D['y']
    tr = np.nonzero((s <= ts - run_cv.PURGE) & ~D['extra'])[0]
    test = np.nonzero((s >= ts) & (s < te))[0]
    rng = np.random.default_rng(seed + ts)
    neg, pos = tr[y[tr] == 0], tr[y[tr] == 1]
    tr_s = np.concatenate([pos, rng.choice(neg, int(len(neg) * run_cv.NEG_FRAC), replace=False)])
    m = HistGBDT(**{**run_cv.GB, 'seed': seed}).fit(np.asarray(R[tr_s])[:, cols], y[tr_s])
    sc = m.decision_function(np.asarray(R[test])[:, cols])
    bs, bj, bX = bf_only_rows()
    bm = (bs >= ts) & (bs < te)
    bsc = m.decision_function(bX[bm][:, cols]) if bm.any() else np.zeros(0)
    return dict(row=test, s=s[test], j=D['j'][test], score=sc, bf_s=bs[bm], bf_j=bj[bm], bf_score=bsc,
                n_train=len(tr_s), n_pos=len(pos))


# ───────────────────────── 新模型：特徵矩陣（短歷史 NaN＋M 錨定百分位）─────────────────────────
def anchored_pct_by_day(m_day, m_val, q_day, q_val) -> np.ndarray:
    """登錄 §6：pct(x)＝(#{M_s<x}＋0.5·#{M_s=x})÷#{M_s 有值}；M_s＝同日錨定列。全向量化（日×唯一值的複合鍵）。"""
    out = np.full(len(q_val), np.nan, np.float32)
    fm, fq = np.isfinite(m_val), np.isfinite(q_val)
    if not fm.any() or not fq.any():
        return out
    uniq, inv = np.unique(np.concatenate([m_val[fm], q_val[fq]]), return_inverse=True)
    U = np.int64(len(uniq) + 1)
    nm = int(fm.sum())
    km = np.sort(m_day[fm].astype(np.int64) * U + inv[:nm])
    qd = q_day[fq].astype(np.int64)
    kq = qd * U + inv[nm:]
    lt, le = np.searchsorted(km, kq, 'left'), np.searchsorted(km, kq, 'right')
    d0, d1 = np.searchsorted(km, qd * U, 'left'), np.searchsorted(km, (qd + 1) * U, 'left')
    n = d1 - d0
    with np.errstate(invalid='ignore', divide='ignore'):
        out[fq] = np.where(n > 0, ((lt - d0) + 0.5 * (le - lt)) / np.maximum(n, 1), np.nan)
    return out


def new_feature_names(feat_official) -> dict:
    base = [n for n in feat_official if not n.startswith('rk_')] + ['age_cap']
    return dict(base=base, R=list(L.R_FEATURES) + list(L.DISP_FEATURES) + list(L.ATT_FEATURES), S1=list(S1_RAW))


def is_raw(name) -> bool:
    return name.startswith('mkt_') or name == 'age_cap' or name in R_RAW or name in S1_RAW


def stage_prep():
    """四個模型軌（M、Mp、R、S）s ≥ 125 的列 → 短歷史 NaN → M 錨定百分位 → SURGE_CACHE/tracks/cv/a36_mx_{軌}.npy（float32）。"""
    t0 = time.time()
    L.load_registration()
    fw = check_feature_windows()
    os.makedirs(CV_DIR, exist_ok=True)
    z = {t: np.load(os.path.join(TRACK_DIR, f'a36_tracks_{t}.npz')) for t in MODEL_TRACKS}
    names = new_feature_names(list(z['M']['feat_official']))
    cols = names['base'] + names['R'] + names['S1']
    src = {n: ('o_log_mcap' if n == 'raw_o_log_mcap' else n) for n in cols}
    win = {n: fw[src[n]]['window'] for n in cols}
    keep = {t: z[t]['m_s'] >= MIN_TRAIN_S for t in MODEL_TRACKS}
    hl = {t: z[t]['k_hist_len'][keep[t]].astype(np.float64) for t in MODEL_TRACKS}
    day = {t: z[t]['m_s'][keep[t]] for t in MODEL_TRACKS}
    mats = {t: np.lib.format.open_memmap(os.path.join(CV_DIR, f'a36_mx_{t}.npy.tmp.npy'), mode='w+', dtype=np.float32,
                                         shape=(int(keep[t].sum()), len(cols))) for t in MODEL_TRACKS}
    for c, n in enumerate(cols):
        raw = {t: np.where(hl[t] < win[n], np.nan, z[t][f'f_{src[n]}'][keep[t]].astype(np.float64)) for t in MODEL_TRACKS}
        for t in MODEL_TRACKS:
            mats[t][:, c] = raw[t].astype(np.float32) if is_raw(n) else anchored_pct_by_day(day['M'], raw['M'], day[t], raw[t])
        if c % 20 == 0:
            log(f'  特徵 {c + 1}/{len(cols)} {n}（{time.time() - t0:.0f}s）')
    for t in MODEL_TRACKS:
        mats[t].flush()
        del mats[t]
        os.replace(os.path.join(CV_DIR, f'a36_mx_{t}.npy.tmp.npy'), os.path.join(CV_DIR, f'a36_mx_{t}.npy'))
        atomic_savez(os.path.join(CV_DIR, f'a36_mx_{t}_meta.npz'), s=day[t], j=z[t]['m_j'][keep[t]], y=z[t]['m_y'][keep[t]],
                     cols=np.array(cols), raw=np.array([is_raw(n) for n in cols]), windows=np.array([win[n] for n in cols]))
    json.dump(dict(cols=cols, windows=win, raw=[n for n in cols if is_raw(n)], feature_windows_sha256=FW_SHA256,
                   rows={t: int(keep[t].sum()) for t in MODEL_TRACKS}, runtime_s=round(time.time() - t0, 1)),
              open(os.path.join(CV_DIR, 'a36_mx_meta.json'), 'w'), ensure_ascii=False, indent=1)
    log(f'prep 完成（{time.time() - t0:.0f}s）')


_MX = {}


def mx(track):
    if track not in _MX:
        meta = np.load(os.path.join(CV_DIR, f'a36_mx_{track}_meta.npz'))
        _MX[track] = dict(X=np.load(os.path.join(CV_DIR, f'a36_mx_{track}.npy'), mmap_mode='r'), s=meta['s'], j=meta['j'], y=meta['y'],
                          cols=list(meta['cols']))
    return _MX[track]


def feature_groups() -> dict:
    return new_feature_names(list(np.load(os.path.join(TRACK_DIR, 'a36_tracks_M.npz'))['feat_official']))


def model_feature_names(model) -> list:
    spec, g = MODELS[model], feature_groups()
    return g['base'] + (g['R'] if spec['extra'] == 'R' else g['S1'] if spec['extra'] == 'S1' else []) + ([spec['flag']] if spec['flag'] else [])


def model_cols(spec, cols) -> list:
    g = feature_groups()
    want = g['base'] + (g['R'] if spec['extra'] == 'R' else g['S1'] if spec['extra'] == 'S1' else [])
    ix = {c: i for i, c in enumerate(cols)}
    return [ix[n] for n in want]


def rows_of(tracks, sel_fn):
    """多軌合併後依 (s, j) 排序的列索引（只取 s、j、y；特徵等抽樣後再讀，結果與「先合併全部特徵再抽樣」相同）。"""
    parts = []
    for k, t in enumerate(tracks):
        d = mx(t)
        r = np.nonzero(sel_fn(d['s']))[0]
        parts.append((np.full(len(r), k, np.int8), r, d['s'][r], d['j'][r], d['y'][r]))
    tid, r, s, j, y = (np.concatenate([p[c] for p in parts]) for c in range(5))
    o = np.lexsort((j, s))
    return tid[o], r[o], s[o], j[o], y[o].astype(np.int8)


def gather(tracks, tid, r, colix, flag) -> np.ndarray:
    """抽中的列的特徵（float32）；flag＝is_R／is_S 時附加 0／1 原值欄。"""
    X = np.empty((len(r), len(colix) + (1 if flag else 0)), np.float32)
    for k, t in enumerate(tracks):
        m = tid == k
        if m.any():
            X[m, :len(colix)] = np.asarray(mx(t)['X'][r[m]])[:, colix]
            if flag:
                X[m, -1] = float(t == flag[3:])
    return X


def run_new(model, ts, te, seed):
    spec = MODELS[model]
    colix = model_cols(spec, mx('M')['cols'])
    tid, r, _, _, ytr = rows_of(spec['train'], lambda s: (s >= MIN_TRAIN_S) & (s <= ts - run_cv.PURGE))
    rng = np.random.default_rng(seed + ts)
    idx = np.arange(len(ytr))
    neg, pos = idx[ytr == 0], idx[ytr == 1]
    tr_s = np.concatenate([pos, rng.choice(neg, int(len(neg) * run_cv.NEG_FRAC), replace=False)])
    Xtr = gather(spec['train'], tid[tr_s], r[tr_s], colix, spec['flag'])
    m = HistGBDT(**{**run_cv.GB, 'seed': seed}).fit(Xtr, ytr[tr_s])
    tid2, r2, s, j, _ = rows_of(spec['score'], lambda s: (s >= ts) & (s < te))
    Xte = gather(spec['score'], tid2, r2, colix, spec['flag'])
    return dict(s=s, j=j, track=np.array(spec['score'])[tid2] if len(s) else np.zeros(0, '<U2'),
                score=m.decision_function(Xte) if len(s) else np.zeros(0), n_train=len(tr_s), n_pos=len(pos), n_feat=Xtr.shape[1])


# ───────────────────────── 工作排程 ─────────────────────────
def jobs(reg, dates, models, wins):
    return [(m, f, ts, te, sd) for m in models for (f, ts, te) in folds(reg, dates, wins) for sd in SEEDS]


def stage_run():
    argv = sys.argv
    models = argv[argv.index('--models') + 1].split(',')
    wins = argv[argv.index('--windows') + 1].split(',')
    part, of = (int(argv[argv.index('--part') + 1]), int(argv[argv.index('--of') + 1])) if '--part' in argv else (0, 1)
    if 'HO' in wins and not os.path.exists(os.path.join(OUT_DIR, 'tracks_t1_HO_STARTED.json')):
        raise SystemExit('HOLDOUT 擬合要讀 HO 期間標籤：哨兵 tracks_t1_HO_STARTED.json 尚未寫入，拒跑（登錄 §8.2）')
    reg = L.load_registration()
    check_feature_windows()
    dates = list(np.load(os.path.join(TRACK_DIR, 'a36_tracks_M.npz'))['dates'])
    os.makedirs(CV_DIR, exist_ok=True)
    todo = [x for k, x in enumerate(jobs(reg, dates, models, wins)) if k % of == part]
    t0 = time.time()
    for (m, f, ts, te, sd) in todo:
        p = ckpt_path(m, f, sd)
        if os.path.exists(p):
            continue
        t1 = time.time()
        r = run_m0(f, ts, te, sd) if m == 'M0' else run_new(m, ts, te, sd)
        atomic_savez(p, **{k: np.asarray(v) for k, v in r.items()}, model=np.array(m), fold=np.array(f), seed=np.array(sd),
                     ts=np.array(ts), te=np.array(te))
        log(f'{m} {f} s{sd}：訓練 {r["n_train"]:,}（正例 {r["n_pos"]}）、測試 {len(r["s"]):,}（{time.time() - t1:.0f}s，累計 {time.time() - t0:.0f}s）')


def stage_status():
    reg = L.load_registration()
    dates = list(np.load(os.path.join(TRACK_DIR, 'a36_tracks_M.npz'))['dates'])
    allm = ['M0'] + list(MODELS)
    for w in ('SEL', 'HC', 'HO'):
        for m in allm:
            js = jobs(reg, dates, [m], [w])
            done = sum(os.path.exists(ckpt_path(x[0], x[1], x[4])) for x in js)
            print(f'{w:>3} {m:<4} {done}/{len(js)}')


def stage_ranks():
    t0 = time.time()
    D, R, cols = m0_data()
    log(f'M0 百分位矩陣 {R.shape}、欄位 {len(cols)}（{time.time() - t0:.0f}s）')


if __name__ == '__main__':
    stage = sys.argv[1] if len(sys.argv) > 1 else ''
    {'ranks': stage_ranks, 'prep': stage_prep, 'run': stage_run, 'status': stage_status}.get(stage, lambda: sys.exit(__doc__))()
