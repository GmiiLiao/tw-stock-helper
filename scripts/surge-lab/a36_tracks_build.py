"""T1 分軌研究 Phase 0 建置（事前登錄 T1-TRACKS-PREREG-2026-10-04 v2；登錄已封存，本檔只照做，偏差寫 tracks/DEVIATIONS_t1_tracks.md）。

分段執行（每段 < 9 分鐘，中間結果寫進 SURGE_CACHE/tracks/）：
  build    驗登錄與輸入雜湊 → 全面板重算（同 build_v2 濾網、官方上市日、處置／注意 KNOWN、R 專用特徵、Qmax、162 個 official 特徵＋登錄額外特徵）
           → 每一列 (s, 代號) 恰屬一軌（assert）＋全部沒通過的條件（多標籤）→ 各軌資料集 SURGE_CACHE/tracks/a36_tracks_{M,Mp,R,S,W,NE}.npz
           → G0.0／G0.3／G0.4／G0.7／G0.8／G0.10／G0.11 與 feature_windows_t1.json；並存截斷測試的 12 日全面板參考列。
  events   SEL+HC 全部 T1 事件逐件歸軌（現行與 aadab48f 兩版漲停判定）＋與 out/official_cv_t1L_official_{hits,misses,outside}.csv 對帳（G0.1 標籤、G0.2）。
           HOLDOUT 一律不讀標籤、不算逐軌事件數。
  trunc    G0.6 截斷測試（--part i --of n）：面板、官方漲跌停價、除權息因子、處置與注意公告截到 ≤ s 後重算，與全面板第 s 列逐格比對。
  report   彙整 → out/tracks_t1/tracks_t1_G0.json（含所有產出的 sha256）。
用法：SURGE_CACHE=… SURGE_OFFICIAL_LIMIT=… SURGE_REVENUE=revenue_official.json SURGE_PIT_STRICT=1 python3 a36_tracks_build.py build|events|trunc|report
未扣成本·事後欄位以 m_ 標示·非投資建議。
"""
import gzip
import json
import os
import sys
import time
import warnings

import numpy as np
import pandas as pd

import a36_tracks_lib as L
import attention as AT
import build as B
import build_v2 as V2
import disposal as DP
import fingerprint as FP
import official_features as OF

warnings.filterwarnings('ignore', category=RuntimeWarning)
CACHE_DIR = os.path.join(B.SP, 'tracks')
OUT_DIR = os.path.join(L.LAB, 'out', 'tracks_t1')
DATASET = os.path.join(B.SP, 'dataset_t1L_off.npz')
REF_DATASET = os.path.join(B.SP, 'a36_ref_dataset_t1L_off_quant.npz')
OLD_CSV = {k: os.path.join(L.MAIN_REPO, 'scripts/surge-lab/out', f'official_cv_t1L_official_{k}.csv') for k in ('hits', 'misses', 'outside')}
PINNED_FP = 'fac51da2a75183426e76a02f82c7039dfbbe9577287f4b9b4b81cc28bd067d2a'
TRUNC_SEED, TRUNC_DAYS = 20261004, 12
FOUT_REASON = ('股價<10', '20日均量<300張', '上市未滿125日', '其他（冷卻期／價格結構斷點／近20日缺值／衝擊日）')


def log(msg):
    print(f'[{time.strftime("%H:%M:%S")}] {msg}', flush=True)


def jdump(obj, path):
    tmp = f'{path}.tmp{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, default=_np_default)
    os.replace(tmp, path)


def _np_default(o):
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return None if not np.isfinite(o) else float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    raise TypeError(type(o))


def load_inputs():
    reg = L.load_registration()
    vin = L.verify_inputs(reg)
    if not vin['ok']:
        raise SystemExit('輸入雜湊不符，拒跑：\n' + '\n'.join(vin['mismatches']))
    dates, codes, P = B.load_panel()
    return dict(reg=reg, verify=vin, dates=dates, codes=codes, P=P, events=B.load_factor_events(dates, codes),
                snaps=L.load_listing_snapshots(), intervals=DP.load_intervals(), att_rows=AT.load_rows(), mkt=L.market_of_codes(codes))


def compute(I, **kw):
    return L.compute_all(I['reg'], I['dates'], I['codes'], I['P'], I['events'], I['snaps'], I['intervals'], I['att_rows'], I['mkt'], **kw)


# ───────────────────────── build ─────────────────────────
def expost(res, P, si, ji):
    T = P['C'].shape[0]
    meta = V2.forward_meta(si, ji, res['A'], P, res['F_day'], T)
    nxt = np.minimum(si + 1, T - 1)
    ok = si + 1 < T
    open_t = np.where(ok, P['O'][nxt, ji], np.nan)
    m = {'m_locked_open': meta['locked_open'], 'm_open_t': open_t.astype(np.float32),
         'm_vol_t': np.where(ok, P['V'][nxt, ji], np.nan).astype(np.float32),
         'm_buyable': (np.isfinite(open_t) & (meta['locked_open'] == 0)).astype(np.int8),
         'm_disp_t_exec': res['da']['disp_t_exec'][si, ji].astype(np.int8), 'm_y': res['fl']['y'][si, ji].astype(np.int8),
         'm_fBF': res['fl']['brk_future'][si, ji].astype(np.int8)}
    for k in (1, 5, 10):
        m[f'm_c{k}'] = meta[f'o_c{k}']
    return m


def row_columns(res, si, ji):
    part, fl, ag = res['part'], res['fl'], res['ages']
    c = {'m_s': si.astype(np.int32), 'm_j': ji.astype(np.int32), 'm_track': part['track'][si, ji],
         'm_window': res['cal']['window'][si], 'm_fold': res['cal']['fold'][si]}
    for k, v in part['fails'].items():
        c[f'k_{k}'] = v[si, ji].astype(np.int8)
    for k, v in part['ne'].items():
        c[f'k_{k}'] = np.broadcast_to(v, res['domain'].shape)[si, ji].astype(np.int8)
    c.update({'k_close': res['P_C'][si, ji].astype(np.float32), 'k_vol20': fl['vol20'][si, ji].astype(np.float32),
              'k_cnt130': fl['cnt130'][si, ji].astype(np.int16), 'k_nan20': fl['nan20'][si, ji].astype(np.int16),
              'k_hist_len': ag['hist_len'][si, ji].astype(np.int32), 'k_age_off': ag['age_off'][si, ji].astype(np.float32),
              'k_age_cap': ag['age_cap'][si, ji].astype(np.float32), 'k_first_trade_idx': res['lst']['first_trade'][ji].astype(np.float32),
              'k_listing_src': res['lst']['listing_src'][ji], 'k_qmax': res['qmax'][si, ji].astype(np.float32),
              'k_R_core': part['r_core'][si, ji].astype(np.int8), 'k_dk_s': res['extra']['dk_s'][si, ji].astype(np.float32),
              'k_at_known5': res['extra']['at_known5'][si, ji].astype(np.float32), 'k_at_known20': res['extra']['at_known20'][si, ji].astype(np.float32)})
    return c


def dataset_checks(I, res, feat_off):
    """G0.0、G0.3、G0.4：釘住資料集對帳（只比列鍵與特徵；HO 的標籤不彙總）。"""
    d = np.load(DATASET)
    out = {'G0.0': {}, 'G0.3': {}, 'G0.4': {}}
    fp = FP.npz_content_sha256(d)
    ms, mj = d['m_s'], d['m_j']
    keys = set(zip(np.array(I['dates'])[ms].tolist(), np.array(I['codes'])[mj].tolist()))
    only_ref = I['reg']['reference_provenance']['rows_only_in_reference']
    out['G0.0'] = dict(content_fingerprint=fp, expected=PINNED_FP, rows=int(len(ms)),
                       ref_only_rows_absent=all(tuple(x.split('|')) not in keys for x in only_ref))
    out['G0.0']['pass'] = fp == PINNED_FP and len(ms) == 812555 and out['G0.0']['ref_only_rows_absent']
    fl, part, cal = res['fl'], res['part'], res['cal']
    base_ok = fl['elig_base'] & ~fl['brk_past'] & ~fl['brk_future'] & cal['usable'][:, None]
    e1 = base_ok & ~fl['lu'] & ~fl['cool1']
    si, ji = np.nonzero(e1)
    rows_equal = np.array_equal(si, ms) and np.array_equal(ji, mj)
    tdr = d['m_tdr'].astype(bool)
    trk = part['track'][ms, mj]
    M = part['track'] == L.TID['M']
    in_ds = np.zeros_like(M)
    in_ds[ms, mj] = True
    bf_only = M & ~in_ds
    win = cal['window']
    selhc = (win == 2) | (win == 3)
    test_rows = int((selhc[ms] & ~tdr & ~d['m_extra'].astype(bool)).sum())
    mr, mc = np.nonzero(M & selhc[:, None])
    out['G0.3'] = dict(
        e1_rows_equal_dataset=rows_equal, y_equal_dataset=bool(np.array_equal(fl['y'][ms, mj].astype(np.int8), d['m_y'])),
        locked_open_equal=None, dataset_nonTDR_all_in_M=bool((trk[~tdr] == L.TID['M']).all()),
        dataset_TDR_all_in_NE_TDR=bool((trk[tdr] == L.TID['NE_TDR']).all()),
        M_minus_dataset_all_brk_future=bool(fl['brk_future'][bf_only].all()),
        brk_future_only_rows_all_s=int(bf_only.sum()), brk_future_only_rows_selhc=int((bf_only & selhc[:, None]).sum()),
        dataset_selhc_test_rows_nonTDR=test_rows, M_rows_selhc=int(len(mr)),
        M_rows_selhc_eq_test_plus_bf=int(len(mr)) == test_rows + int((bf_only & selhc[:, None]).sum()),
        ref_only_rows=[ref_only_row(I, res, x) for x in only_ref])
    out['G0.3']['pass'] = all(out['G0.3'][k] for k in ('e1_rows_equal_dataset', 'y_equal_dataset', 'dataset_nonTDR_all_in_M',
                                                       'dataset_TDR_all_in_NE_TDR', 'M_minus_dataset_all_brk_future', 'M_rows_selhc_eq_test_plus_bf')) \
        and test_rows == I['reg']['reference_provenance']['pinned_dataset']['sel_hc_test_rows_non_tdr']
    feats = {}
    F = res['F']
    for k in sorted(x for x in d.files if x.startswith('f_')):
        a, b = F[k[2:]][ms, mj], d[k]
        close = np.isclose(a, b, rtol=1e-4, atol=1e-6, equal_nan=True)
        same = (a == b) | (np.isnan(a) & np.isnan(b))
        feats[k[2:]] = dict(allclose_fail=int((~close).sum()), not_bit_equal=int((~same).sum()), in_official=k[2:] in feat_off)
    out['G0.4'] = dict(n_features=len(feats), fail_features={k: v for k, v in feats.items() if v['allclose_fail']},
                       non_bit_equal_features={k: v['not_bit_equal'] for k, v in feats.items() if v['not_bit_equal']},
                       official_features_checked=sum(v['in_official'] for v in feats.values()))
    out['G0.4']['pass'] = not out['G0.4']['fail_features'] and out['G0.4']['official_features_checked'] == len(feat_off)
    mm = expost(res, I['P'], ms, mj)
    out['G0.3']['locked_open_equal'] = bool(np.array_equal(mm['m_locked_open'], d['m_locked_open']))
    out['G0.3']['o_c5_equal'] = bool(np.allclose(mm['m_c5'], d['m_o_c5'], rtol=1e-5, equal_nan=True))
    out['G0.3']['vol20_equal'] = bool(np.allclose(fl['vol20'][ms, mj].astype(np.float32), d['m_vol20'], rtol=1e-6, equal_nan=True))
    return out, in_ds


def ref_only_row(I, res, key):
    dt, code = key.split('|')
    s, j = I['dates'].index(dt), I['codes'].index(code)
    part = res['part']
    tr = int(part['track'][s, j])
    return dict(date=dt, code=code, track=L.TRACKS[tr] if tr >= 0 else None,
                failing=[k for k, v in part['fails'].items() if v[s, j]] + [k for k, v in part['ne'].items() if np.broadcast_to(v, res['domain'].shape)[s, j]],
                lu_s=bool(res['fl']['lu'][s, j]), cool1=bool(res['fl']['cool1'][s, j]))


def listing_report(I, res):
    lst = res['lst']
    src = np.array(L.LISTING_SRC)[lst['listing_src']]
    sm = lst['snap_market']
    cnt = {m or 'not_in_snapshot': {k: int(((sm == m) & (src == k)).sum()) for k in L.LISTING_SRC if ((sm == m) & (src == k)).any()} for m in ('TWSE', 'TPEx', '')}
    exp = {'TWSE': {'official_prepanel': 954, 'official': 127, 'transfer_min': 8},
           'TPEx': {'official_prepanel': 767, 'official': 124, 'transfer_min': 1},
           'not_in_snapshot': {'fallback_prepanel': 37, 'fallback_first_close': 2}}
    transfers = [dict(code=c, market=sm[j], first_close=I['dates'][lst['first_close'][j]], listing=I['snaps'][c][1])
                 for j, c in enumerate(I['codes']) if src[j] == 'transfer_min']
    return dict(counts=cnt, expected=exp, transfers=transfers, pass_=cnt == exp)


def survivorship(I, res):
    rows = json.load(gzip.open(os.path.join(L.MAIN_REPO, L.SUSPEND_LISTING)))['payload']
    out, codes = [], I['codes']
    for r in rows:
        y, m, d = str(r['DelistingDate']).split('/')
        iso = f'{int(y) + 1911:04d}-{int(m):02d}-{int(d):02d}'
        if not (L.PANEL_START <= iso <= I['dates'][-1]):
            continue
        c = str(r['Code']).strip()
        j = codes.index(c) if c in codes else None
        lc = I['dates'][res['lst']['last_close'][j]] if j is not None and res['lst']['last_close'][j] >= 0 else None
        out.append(dict(code=c, delisting=iso, in_panel=j is not None, last_close=lc,
                        tpex_snapshot=I['snaps'].get(c, ('',))[0] == 'TPEx', ok=(j is not None and lc is not None and (lc <= iso or I['snaps'].get(c, ('',))[0] == 'TPEx'))))
    missing = [x['code'] for x in out if not x['in_panel']]
    ok = len(out) == 17 and missing == ['2841'] and all(x['ok'] for x in out if x['in_panel']) and sum(x['in_panel'] for x in out) == 16
    return dict(rows=out, n=len(out), not_in_panel=missing, pass_=ok, tpex='TPEx 存活者偏誤未檢查（來源未提供）')


def write_tracks(I, res, feat_names, in_ds):
    os.makedirs(CACHE_DIR, exist_ok=True)
    tr = res['part']['track']
    files, counts = {}, {}
    for name in ('M', 'Mp', 'R', 'S', 'W', 'NE'):
        mask = np.isin(tr, L.NE_IDS) if name == 'NE' else tr == L.TID[name]
        si, ji = np.nonzero(mask)
        cols = row_columns(res, si, ji)
        cols.update(expost(res, I['P'], si, ji))
        cols['p_in_pinned_dataset'] = in_ds[si, ji].astype(np.int8)
        if name != 'NE':
            for n in feat_names['official']:
                cols[f'f_{n}'] = res['F'][n][si, ji].astype(np.float32)
            for n in feat_names['extra']:
                cols[f'f_{n}'] = res['extra'][n][si, ji].astype(np.float32)
        path = os.path.join(CACHE_DIR, f'a36_tracks_{name}.npz')
        tmp = f'{path}.tmp{os.getpid()}.npz'
        np.savez_compressed(tmp, dates=np.array(I['dates']), codes=np.array(I['codes']), tracks=np.array(L.TRACKS),
                            listing_src_names=np.array(L.LISTING_SRC), window_names=np.array(L.WINDOW_NAMES),
                            feat_official=np.array(feat_names['official']), feat_extra=np.array(feat_names['extra']), **cols)
        os.replace(tmp, path)
        files[name] = path
        win = res['cal']['window'][si]
        counts[name] = {w: int((win == k).sum()) for k, w in enumerate(L.WINDOW_NAMES)} | {'all': int(len(si))}
        log(f'  {name}: {len(si):,} 列 → {os.path.basename(path)}')
    return files, counts


def trunc_days(reg, res):
    rng = np.random.default_rng(TRUNC_SEED)
    pool = np.nonzero(res['cal']['window'] > 0)[0]
    return np.sort(rng.choice(pool, size=TRUNC_DAYS, replace=False))


def stage_build():
    t0 = time.time()
    I = load_inputs()
    log(f'登錄雜湊 {L.REG_SHA256[:12]}… 相符；輸入 {I["verify"]["n_checked"]} 項雜湊相符')
    res = compute(I)
    res['P_C'] = I['P']['C']
    log(f'全面板重算完成（{time.time() - t0:.0f}s）')
    d = np.load(DATASET)
    feat_off = L.official_names(d.files)
    feat_names = {'official': feat_off, 'extra': list(L.EXTRA_FEATURES)}
    all_feats = feat_off + list(L.EXTRA_FEATURES)
    forbidden = [n for n in all_feats if n.startswith('m_') or n in ('hist_len', 'brk_future', 'fBF')]
    assert not forbidden, f'G0.7：禁用欄位進了特徵 {forbidden}'
    new_model = [n for n in all_feats if not n.startswith('rk_')] + ['is_R', 'is_S']
    windows = L.feature_windows(new_model, I['reg'])
    os.makedirs(OUT_DIR, exist_ok=True)
    fw = dict(registration=L.REG_SHA256, rule='hist_len < window ⇒ NaN（新模型與代理組成項；M0 不適用）', removed_from_new_models=[n for n in feat_off if n.startswith('rk_')],
              deviation_supplement=L.DEV001_WINDOWS, windows={n: windows[n] for n in new_model})
    jdump(fw, os.path.join(OUT_DIR, 'feature_windows_t1.json'))
    chk, in_ds = dataset_checks(I, res, feat_off)
    log(f'資料集對帳：G0.0 {chk["G0.0"]["pass"]}、G0.3 {chk["G0.3"]["pass"]}、G0.4 {chk["G0.4"]["pass"]}（{time.time() - t0:.0f}s）')
    files, counts = write_tracks(I, res, feat_names, in_ds)
    days = trunc_days(I['reg'], res)
    snaps = {f'd{i}__{k}': v for i, s in enumerate(days) for k, v in L.row_snapshot(res, int(s), feat_off).items()}
    np.savez_compressed(os.path.join(CACHE_DIR, 'a36_trunc_ref.npz'), days=days, feat_official=np.array(feat_off), **snaps)
    rf = res['extra']
    with np.errstate(invalid='ignore'):
        dom = res['domain']
        r_check = dict(r_n_seg_250_eq_o_lu2_starts250=int((dom & np.isfinite(rf['r_n_seg_250']) & (rf['r_n_seg_250'] != res['F']['o_lu2_starts250'])).sum()),
                       r_dd_high20_eq_dist_hi20=int((dom & ~np.isclose(rf['r_dd_high20'].astype(np.float32), res['F']['dist_hi20'], equal_nan=True)).sum()))
    rep = dict(stage='build', runtime_s=round(time.time() - t0, 1), verify_inputs=I['verify'], n_factor_events_used=res['n_factor_used'],
               panel=dict(T=len(I['dates']), N=len(I['codes']), first=I['dates'][0], last=I['dates'][-1]),
               windows_days={w: int((res['cal']['window'] == k).sum()) for k, w in enumerate(L.WINDOW_NAMES)},
               partition_structural=res['part']['checks'], rows_by_track_window=counts, tracks_files={k: os.path.basename(v) for k, v in files.items()},
               dataset=chk, listing=listing_report(I, res), survivorship=survivorship(I, res), coverage=res['da']['coverage'],
               attention_rows_dropped_non_panel_day=res['da']['att_miss'], r_feature_crosscheck=r_check,
               feature_counts=dict(official=len(feat_off), extra=len(L.EXTRA_FEATURES)), trunc_days=[I['dates'][int(s)] for s in days],
               wiki_stocks_sha256=L.file_sha256(os.path.join(L.MAIN_REPO, 'second-brain/wiki/_graph/stocks.json')),
               official_limits_content_sha256=FP.npz_content_sha256(os.environ['SURGE_OFFICIAL_LIMIT']))
    jdump(rep, os.path.join(CACHE_DIR, 'a36_report_build.json'))
    log(f'build 完成（{time.time() - t0:.0f}s）')


if __name__ == '__main__':
    import a36_tracks_stages as ST
    stage = sys.argv[1] if len(sys.argv) > 1 else ''
    {'build': stage_build, 'events': ST.stage_events, 'trunc': ST.stage_trunc, 'report': ST.stage_report}.get(stage, lambda: sys.exit(__doc__))()
