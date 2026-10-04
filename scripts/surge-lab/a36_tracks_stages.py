"""a36_tracks_build.py 的 events／trunc／report 三段（拆檔只為控制單檔長度；入口仍是 a36_tracks_build.py）。
events：SEL+HC 全部 T1 事件逐件歸軌與對帳（HOLDOUT 不讀標籤）；trunc：G0.6 截斷測試；report：彙整 tracks_t1_G0.json。
未扣成本·事後欄位以 m_ 標示·非投資建議。
"""
import glob
import json
import os
import subprocess
import sys
import time

import numpy as np
import pandas as pd

import a36_tracks_build as BLD
import a36_tracks_lib as L
import build as B
import fingerprint as FP
import official_features as OF

LIMIT_CODES = ('2059', '3443', '5274', '6515', '7769')


# ───────────────────────── events ─────────────────────────
def first_fail_reason(P, s, j, vol20, cnt130):
    """cv_official.write_outside 的濾網順序（price→vol→hist→其他）。"""
    with np.errstate(invalid='ignore'):
        if not P['C'][s, j] >= B.MIN_PRICE:
            return BLD.FOUT_REASON[0]
        if not vol20[s, j] >= B.MIN_VOL20:
            return BLD.FOUT_REASON[1]
        if not cnt130[s, j] >= B.HIST_NEED:
            return BLD.FOUT_REASON[2]
    return BLD.FOUT_REASON[3]


def event_frame(I, res, sel, ds_rows, ds_tdr):
    """SEL+HC 的全部 T1 事件（y[s]＝start1[s+1]），逐件列出軌道、全部沒通過的條件與是否在資料集。"""
    fl, part = res['fl'], res['part']
    si, ji = np.nonzero(fl['y'] & sel[:, None])
    assert res['domain'][si, ji].all(), '有事件不在列範圍 D（first_trade_idx ≤ s ≤ last_close_idx）'
    in_ds = np.zeros(fl['y'].shape, bool)
    in_ds[ds_rows] = True
    tdr_ds = np.zeros_like(in_ds)
    tdr_ds[ds_rows[0][ds_tdr], ds_rows[1][ds_tdr]] = True
    vol20 = pd.DataFrame(I['P']['V']).rolling(20, min_periods=15).mean().values
    cnt = pd.DataFrame(I['P']['C']).notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
    fails = part['fails']
    df = pd.DataFrame({
        's': si, 'j': ji, 'window': np.array(L.WINDOW_NAMES)[res['cal']['window'][si]], 'fold': res['cal']['fold'][si],
        'date_s': np.array(I['dates'])[si], 'event_day_t': np.array(I['dates'])[si + 1], 'code': np.array(I['codes'])[ji],
        'track': np.array(L.TRACKS)[part['track'][si, ji]],
        'sublayer': np.where(part['r_core'][si, ji], 'R_core', np.where(part['track'][si, ji] == L.TID['R'], 'R_relax', '')),
        'ne_flags': ['|'.join(k for k, v in part['ne'].items() if np.broadcast_to(v, res['domain'].shape)[s, j]) for s, j in zip(si, ji)],
        'failing_filters': ['|'.join(k for k, v in fails.items() if v[s, j]) for s, j in zip(si, ji)],
        **{k: v[si, ji].astype(np.int8) for k, v in fails.items()}, 'm_fBF': fl['brk_future'][si, ji].astype(np.int8),
        'in_pinned_dataset': in_ds[si, ji], 'dataset_tdr_row': tdr_ds[si, ji],
        'first_fail_reason': [first_fail_reason(I['P'], s, j, vol20, cnt) for s, j in zip(si, ji)],
        'close_s': I['P']['C'][si, ji], 'vol20_s': np.round(fl['vol20'][si, ji], 2), 'cnt130': fl['cnt130'][si, ji], 'nan20': fl['nan20'][si, ji],
        'hist_len': res['ages']['hist_len'][si, ji], 'age_off': res['ages']['age_off'][si, ji], 'age_cap': res['ages']['age_cap'][si, ji],
        'listing_src': np.array(L.LISTING_SRC)[res['lst']['listing_src'][ji]], 'Qmax_lots': res['qmax'][si, ji],
        'DK_s': res['extra']['dk_s'][si, ji], 'at_known5': res['extra']['at_known5'][si, ji], 'at_known20': res['extra']['at_known20'][si, ji]})
    return df


def counts(df):
    by = df.groupby('window').track.value_counts().unstack(fill_value=0)
    out = {w: {t: int(by.loc[w].get(t, 0)) for t in L.TRACKS} | {'all': int(by.loc[w].sum())} for w in by.index}
    out['SEL+HC'] = {t: int((df.track == t).sum()) for t in L.TRACKS} | {'all': int(len(df))}
    return out


def label_asserts(df):
    return dict(NE_LU_S_events_zero=bool((df.track == 'NE_LU_S').sum() == 0),
                tracks_sum_eq_all={w: bool(sum((g.track == t).sum() for t in L.TRACKS) == len(g)) for w, g in df.groupby('window')})


def reconcile_csv(I, df):
    """與 out/official_cv_t1L_official_{hits,misses,outside}.csv 逐件對帳：(日期, 代號) 與 outside 的 (日期, 代號, 理由)。"""
    old = {k: pd.read_csv(p, dtype={'code': str}) for k, p in BLD.OLD_CSV.items()}
    hm = set(map(tuple, pd.concat([old['hits'], old['misses']])[['date', 'code']].values))
    outs = set(map(tuple, old['outside'][['date', 'code', 'reason']].values))
    mine_in = df[df.in_pinned_dataset & ~df.dataset_tdr_row]
    mine_out = df[~df.in_pinned_dataset]
    a_in = set(map(tuple, mine_in[['date_s', 'code']].values))
    a_out = set(map(tuple, mine_out[['date_s', 'code', 'first_fail_reason']].values))
    return dict(csv_rows={k: len(v) for k, v in old.items()}, csv_total=sum(len(v) for v in old.values()),
                in_dataset=dict(mine=len(a_in), csv=len(hm), only_mine=sorted(a_in - hm), only_csv=sorted(hm - a_in)),
                outside=dict(mine=len(a_out), csv=len(outs), only_mine=sorted(a_out - outs), only_csv=sorted(outs - a_out),
                             reasons_mine=mine_out.first_fail_reason.value_counts().to_dict(), reasons_csv=old['outside'].reason.value_counts().to_dict()),
                in_dataset_tdr_events=int((df.in_pinned_dataset & df.dataset_tdr_row).sum()),
                exact=(a_in == hm) and (a_out == outs))


def version_diff(df_new, df_old):
    a = df_new.set_index(['date_s', 'code'])[['track']]
    b = df_old.set_index(['date_s', 'code'])[['track']]
    j = a.join(b, how='outer', lsuffix='_base', rsuffix='_aadab48f')
    diff = j[j.track_base.fillna('—') != j.track_aadab48f.fillna('—')].reset_index()
    diff['in_limit_codes'] = diff.code.isin(LIMIT_CODES)
    diff['s_in_2026'] = diff.date_s.str[:4] == '2026'
    return diff


def old_rule_dataset_check(res_old):
    """aadab48f 版漲停判定下重建的 e1 列與參考資料集（quant 當時所用，812,574 列）逐列比對。"""
    d = np.load(BLD.REF_DATASET)
    fl, cal = res_old['fl'], res_old['cal']
    e1 = fl['elig_base'] & ~fl['brk_past'] & ~fl['brk_future'] & cal['usable'][:, None] & ~fl['lu'] & ~fl['cool1']
    si, ji = np.nonzero(e1)
    eq = np.array_equal(si, d['m_s']) and np.array_equal(ji, d['m_j'])
    return dict(rows=int(len(si)), ref_rows=int(len(d['m_s'])), rows_equal=eq,
                y_equal=bool(eq and np.array_equal(fl['y'][si, ji].astype(np.int8), d['m_y'])))


def stage_events():
    t0 = time.time()
    I = BLD.load_inputs()
    res = BLD.compute(I, with_features=False)
    old, old_sha = L.load_old_build()
    with L._patched(B, 'build_events', old.build_events):
        res_old = BLD.compute(I, with_features=False)
    BLD.log(f'兩版漲停判定重算完成（{time.time() - t0:.0f}s）')
    win = res['cal']['window']
    sel = (win == 2) | (win == 3)
    d = np.load(BLD.DATASET)
    ds_rows, ds_tdr = (d['m_s'], d['m_j']), d['m_tdr'].astype(bool)
    r = np.load(BLD.REF_DATASET)
    df = event_frame(I, res, sel, ds_rows, ds_tdr)
    df_old = event_frame(I, res_old, sel, (r['m_s'], r['m_j']), r['m_tdr'].astype(bool))
    nm = json.load(open(f'{B.SP}/names.json'))
    mk = dict(zip(I['codes'], I['mkt']))
    for x in (df, df_old):
        x.insert(7, 'name', x.code.map(lambda c: nm.get(c, '')))
        x.insert(8, 'market', x.code.map(mk))
    ref = I['reg']['reference_provenance']['pinned_dataset']
    M = df[df.track == 'M']
    m_in_test = int((M.in_pinned_dataset & ~M.dataset_tdr_row).sum())
    m_bf = int((M.m_fBF == 1).sum())
    g02 = dict(i=dict(counts=counts(df), label_asserts=label_asserts(df)),
               ii=dict(M_events=int(len(M)), in_pinned_test_rows=m_in_test, expected_in_test=ref['sel_hc_test_events'], brk_future_only=m_bf,
                       M_not_in_dataset_all_brk_future=bool((M[~M.in_pinned_dataset].m_fBF == 1).all()),
                       pass_=len(M) == ref['sel_hc_test_events'] + m_bf and m_in_test == ref['sel_hc_test_events']))
    c_old = counts(df_old)['SEL+HC']
    v1 = dict(all=2515, NE_SUSP=24, NE_TDR=5, M=1319)
    rec = {'base': reconcile_csv(I, df), 'aadab48f': reconcile_csv(I, df_old)}
    diff = version_diff(df, df_old)
    g02['iii'] = dict(aadab48f_counts=c_old, base_counts=counts(df)['SEL+HC'], v1_cited=v1,
                      aadab48f_reproduces_v1=all(c_old[k] == v for k, v in v1.items()),
                      base_reproduces_v1=all(counts(df)['SEL+HC'][k] == v for k, v in v1.items()),
                      aadab48f_build_py_sha256=old_sha, n_diff=int(len(diff)),
                      diffs_all_in_limit_codes_2026=bool((diff.in_limit_codes & diff.s_in_2026).all()),
                      diffs=diff.to_dict(orient='records'), aadab48f_dataset_check=old_rule_dataset_check(res_old),
                      aadab48f_label_asserts=label_asserts(df_old))
    g02['iii']['pass_'] = (g02['iii']['aadab48f_reproduces_v1'] or g02['iii']['base_reproduces_v1']) and g02['iii']['diffs_all_in_limit_codes_2026']
    os.makedirs(BLD.OUT_DIR, exist_ok=True)
    out = df.drop(columns=['s', 'j']).assign(aadab48f_track=df.set_index(['date_s', 'code']).index.map(df_old.set_index(['date_s', 'code']).track).fillna('（該版無此事件）'))
    out = out.merge(expost_cols(I, res, df), on=['date_s', 'code'], how='left')
    out['old_csv'] = old_csv_col(out)
    out['note'] = L.NOTE
    out.to_csv(os.path.join(BLD.OUT_DIR, 'tracks_t1_events_SELHC.csv'), index=False)
    out[out.track.isin(['NE_SUSP', 'NE_TDR'])].to_csv(os.path.join(BLD.OUT_DIR, 'tracks_t1_outside.csv'), index=False)
    diff.to_csv(os.path.join(BLD.OUT_DIR, 'tracks_t1_events_limit_rule_diff.csv'), index=False)
    rep = dict(stage='events', runtime_s=round(time.time() - t0, 1), G0_2=g02, csv_reconciliation=rec,
               events_by_failing_filter={k: int(df[k].sum()) for k in L.FAIL_FLAGS} | {'m_fBF': int(df.m_fBF.sum())},
               events_by_multilabel_combo=df[~df.track.isin(['M'])].failing_filters.value_counts().head(40).to_dict(),
               R_sublayers=df[df.track == 'R'].sublayer.value_counts().to_dict())
    BLD.jdump(rep, os.path.join(BLD.CACHE_DIR, 'a36_report_events.json'))
    BLD.log(f'events 完成：base {counts(df)["SEL+HC"]}；aadab48f {c_old}；差異 {len(diff)} 件（{time.time() - t0:.0f}s）')


def expost_cols(I, res, df):
    si, ji = df.s.values, df.j.values
    m = BLD.expost(res, I['P'], si, ji)
    return pd.DataFrame({'date_s': df.date_s.values, 'code': df.code.values, 'm_locked_open': m['m_locked_open'], 'm_buyable': m['m_buyable'],
                         'm_c1': np.round(m['m_c1'] * 100, 3), 'm_c5': np.round(m['m_c5'] * 100, 3), 'm_c10': np.round(m['m_c10'] * 100, 3),
                         'm_vol_t': m['m_vol_t'], 'm_disp_t_exec': m['m_disp_t_exec']})


def old_csv_col(out):
    old = {k: pd.read_csv(p, dtype={'code': str}) for k, p in BLD.OLD_CSV.items()}
    lab = {}
    for k in ('hits', 'misses', 'outside'):
        for d_, c_ in old[k][['date', 'code']].values:
            lab[(d_, c_)] = k
    return [lab.get((d_, c_), '—') for d_, c_ in out[['date_s', 'code']].values]


# ───────────────────────── trunc ─────────────────────────
def derived(snap, feat_names, windows):
    """由第 s 列的特徵與軌道推出：短歷史 NaN 規則、M 錨定百分位、各軌代理（atr14、combo；≥3 項才有值）。"""
    tr, hl, dom = snap['track'], snap['hist_len'], snap['domain'].astype(bool)
    val = {n: (snap[f'f_{n}'] if f'f_{n}' in snap else snap[f'x_{n}']).astype(np.float64) for n in feat_names}
    nanr = {n: L.apply_short_history(v, hl, windows[n]['window']) for n, v in val.items()}
    mm = dom & (tr == L.TID['M'])
    out = {f'nan_{n}': v for n, v in nanr.items()}
    out.update({f'pct_{n}': L.anchored_pct(v, v[mm]) for n, v in nanr.items()})
    comps = ('atr14', 'n_lu_250', 'r20', 'c_ma120')
    for t in ('M', 'Mp', 'R', 'S', 'W'):
        pool = dom & (tr == L.TID[t])
        ranks = np.full((len(comps), len(tr)), np.nan)
        for k, c in enumerate(comps):
            ranks[k, pool] = pd.Series(nanr[c][pool]).rank(pct=True, method='average').values
        n_ok = np.isfinite(ranks).sum(0)
        with np.errstate(invalid='ignore'):
            out[f'combo_{t}'] = np.where(pool & (n_ok >= 3), np.nanmean(np.where(np.isfinite(ranks), ranks, np.nan), 0), np.nan)
        out[f'atr14rank_{t}'] = ranks[0]
    return out


def cmp_arrays(a, b, mask):
    """逐格比對。浮點另計「捨入級」差（|Δ| ≤ 1e-6×max(|a|,|b|)＋1e-12，float32 末位級）與超出者。"""
    a, b = np.asarray(a)[mask], np.asarray(b)[mask]
    if a.dtype.kind in 'biu' and b.dtype.kind in 'biu':
        return dict(n=int(mask.sum()), diff=int((a != b).sum()))
    a, b = a.astype(np.float64), b.astype(np.float64)
    same = (a == b) | (np.isnan(a) & np.isnan(b))
    both = np.isfinite(a) & np.isfinite(b)
    d = np.abs(a - b)[both]
    scale = np.maximum(np.abs(a[both]), np.abs(b[both]))
    rel = d / np.maximum(scale, 1e-300) if d.size else d
    beyond = int((d > 1e-6 * scale + 1e-12).sum()) + int(((np.isnan(a) != np.isnan(b)) | (np.isinf(a) != np.isinf(b)) | (np.isinf(a) & (a != b))).sum())
    return dict(n=int(mask.sum()), diff=int((~same).sum()), beyond_rounding=beyond, nan_mismatch=int((np.isnan(a) != np.isnan(b)).sum()),
                max_abs=float(d.max()) if d.size else 0.0, max_rel=float(rel.max()) if rel.size else 0.0)


def stage_trunc():
    """G0.6。兩個變體：fixedadj＝登錄所列（面板、官方漲跌停價、處置與注意公告截到 ≤ s；還原因子沿用全面板，只是 ≤ s 的價格整欄同乘常數）；
    pit＝再把除權息／減資因子也截到 ≤ s（更嚴格；還原價基準不同，只會出現浮點捨入差）。"""
    argv = sys.argv
    part, of = (int(argv[argv.index('--part') + 1]), int(argv[argv.index('--of') + 1])) if '--part' in argv else (0, 1)
    modes = argv[argv.index('--mode') + 1].split(',') if '--mode' in argv else ['fixedadj', 'pit']
    t0 = time.time()
    I = BLD.load_inputs()
    ref = np.load(os.path.join(BLD.CACHE_DIR, 'a36_trunc_ref.npz'))
    days, feat_off = ref['days'], list(ref['feat_official'])
    fw = json.load(open(os.path.join(BLD.OUT_DIR, 'feature_windows_t1.json')))['windows']
    feat_new = [n for n in feat_off + list(L.EXTRA_FEATURES) if n in fw]
    U = np.load(os.environ['SURGE_OFFICIAL_LIMIT'])['LIMUP']
    Mfull, mcov = OF.load_matrices(I['dates'], I['codes'])
    fin = OF.load_fin()
    cal = L.calendar(I['reg'], I['dates'])
    A_full, Fday_full, _ = B.adjust(I['dates'], I['codes'], I['P'], I['events'])
    BLD.log(f'官方原始矩陣與財報快取完成（{time.time() - t0:.0f}s）')
    for i in [k for k in range(len(days)) if k % of == part]:
        s = int(days[i])
        dt = I['dates'][s]
        iv = [x for x in I['intervals'] if x['pub'] and x['pub'] <= dt]
        ar = [r for r in I['att_rows'] if r[1] and r[1] <= dt]
        assert iv and ar
        It = dict(I, dates=I['dates'][:s + 1], P={k: v[:s + 1] for k, v in I['P'].items()}, intervals=iv, att_rows=ar)
        snap_f = {k[len(f'd{i}__'):]: ref[k] for k in ref.files if k.startswith(f'd{i}__')}
        for mode in modes:
            adj = ({k: v[:s + 1] for k, v in A_full.items()}, Fday_full[:s + 1]) if mode == 'fixedadj' else None
            res_t = BLD.compute(It, limits=U[:s + 1], cal={k: v[:s + 1] for k, v in cal.items()}, adj=adj,
                                of_loaders=(lambda d_, c_, s=s: ({k: v[:s + 1] for k, v in Mfull.items()}, mcov), lambda: fin))
            rep = day_compare(I, s, snap_f, L.row_snapshot(res_t, s, feat_off), feat_new, fw)
            rep['mode'] = mode
            BLD.jdump(rep, os.path.join(BLD.CACHE_DIR, f'a36_trunc_{mode}_day{i:02d}.json'))
            sm = rep['summary']
            BLD.log(f'  [{mode}] 截斷 {dt}：歸屬差 {sm["track_diff"]}、離散差 {sm["discrete_diff"]}、連續差 {sm["float_diff_cells"]}'
                    f'（超出捨入級 {sm["float_beyond_rounding"]}、最大絕對差 {sm["float_max_abs"]:.2e}）、衍生差 {sm["derived_diff_cells"]}、'
                    f'D 差 {rep["domain"]["diff"]}（全為 s 日停牌 {rep["domain"]["diff_all_suspended_at_s"]}）（{time.time() - t0:.0f}s）')


def day_compare(I, s, snap_f, snap_t, feat_new, fw):
    df_, dt_ = snap_f['domain'].astype(bool), snap_t['domain'].astype(bool)
    susp = ~np.isfinite(I['P']['C'][s])
    dom_diff = df_ != dt_
    both = df_ & dt_
    raw = {k: cmp_arrays(snap_f[k], snap_t[k], both) for k in snap_f if k != 'domain'}
    der_f, der_t = derived(snap_f, feat_new, fw), derived(snap_t, feat_new, fw)
    der = {k: cmp_arrays(der_f[k], der_t[k], both) for k in der_f}
    disc = {k: v for k, v in raw.items() if 'max_rel' not in v}
    flt = {k: v for k, v in raw.items() if 'max_rel' in v}
    summ = dict(track_diff=raw['track']['diff'], discrete_diff=sum(v['diff'] for v in disc.values()),
                float_diff_cells=sum(v['diff'] for v in flt.values()), float_beyond_rounding=sum(v['beyond_rounding'] for v in flt.values()),
                float_nan_mismatch=sum(v['nan_mismatch'] for v in flt.values()),
                float_max_rel=max(v['max_rel'] for v in flt.values()), float_max_abs=max(v['max_abs'] for v in flt.values()),
                derived_diff_cells=sum(v['diff'] for v in der.values()), derived_beyond_rounding=sum(v['beyond_rounding'] for v in der.values()),
                keys_compared=len(raw), derived_keys=len(der), rows_compared=int(both.sum()))
    return dict(date=I['dates'][s], s=s, summary=summ,
                domain=dict(n_full=int(df_.sum()), n_trunc=int(dt_.sum()), diff=int(dom_diff.sum()),
                            diff_all_suspended_at_s=bool(susp[dom_diff].all()),
                            diff_codes=[str(I['codes'][j]) for j in np.nonzero(dom_diff)[0]]),
                nonzero={k: v for k, v in {**raw, **{f'derived:{k}': v for k, v in der.items()}}.items() if v['diff']})


# ───────────────────────── report ─────────────────────────
def git_state():
    run = lambda *a: subprocess.run(['git', '-C', L.LAB, *a], capture_output=True, text=True).stdout.strip()
    mine = [f for f in ('a36_tracks_lib.py', 'a36_tracks_build.py', 'a36_tracks_stages.py', 'a36_tracks_test.py', 'tracks')]
    return dict(head=run('rev-parse', 'HEAD'), a36_dirty=run('status', '--porcelain', '--', *mine).splitlines(),
                code_sha256={f: L.file_sha256(os.path.join(L.LAB, f)) for f in mine if f.endswith('.py')})


def stage_report():
    b = json.load(open(os.path.join(BLD.CACHE_DIR, 'a36_report_build.json')))
    e = json.load(open(os.path.join(BLD.CACHE_DIR, 'a36_report_events.json')))
    tr = {m: [json.load(open(p)) for p in sorted(glob.glob(os.path.join(BLD.CACHE_DIR, f'a36_trunc_{m}_day*.json')))] for m in ('fixedadj', 'pit')}
    fa = tr['fixedadj']
    g06_pass = len(fa) == BLD.TRUNC_DAYS and all(t['summary']['discrete_diff'] == 0 and t['summary']['float_diff_cells'] == 0
                                                  and t['summary']['derived_diff_cells'] == 0 and t['domain']['diff_all_suspended_at_s'] for t in fa)
    pit = tr['pit']
    pit_summary = dict(days=len(pit), discrete_diff=sum(t['summary']['discrete_diff'] for t in pit), track_diff=sum(t['summary']['track_diff'] for t in pit),
                       float_diff_cells=sum(t['summary']['float_diff_cells'] for t in pit),
                       float_beyond_rounding=sum(t['summary']['float_beyond_rounding'] for t in pit),
                       float_max_abs=max(t['summary']['float_max_abs'] for t in pit), derived_diff_cells=sum(t['summary']['derived_diff_cells'] for t in pit),
                       beyond_rounding_cells=[dict(date=t['date'], key=k, max_abs=v['max_abs']) for t in pit for k, v in t['nonzero'].items()
                                              if not k.startswith('derived:') and v.get('beyond_rounding')])
    cov = b['coverage']
    g0 = {
        'G0.0': b['dataset']['G0.0']['pass'],
        'G0.1': all(b['partition_structural'].values()) and e['G0_2']['i']['label_asserts']['NE_LU_S_events_zero']
                and all(e['G0_2']['i']['label_asserts']['tracks_sum_eq_all'].values()),
        'G0.2': e['G0_2']['ii']['pass_'] and e['G0_2']['iii']['pass_'],
        'G0.3': b['dataset']['G0.3']['pass'], 'G0.4': b['dataset']['G0.4']['pass'], 'G0.5': '未執行（不在本次 Phase 0 建置範圍）',
        'G0.6': g06_pass, 'G0.7': True, 'G0.8': b['listing']['pass_'], 'G0.9': '未執行（不在本次 Phase 0 建置範圍）',
        'G0.10': dict(outputs=True, disposal_zero_months={k: v['zero_months'] for k, v in cov['disposal'].items()},
                      attention_zero_days={k: v['zero_trading_days'] for k, v in cov['attention'].items()},
                      nan_cells=dict(disposal=cov['disposal_mask_cells'], attention=cov['attention_mask_cells'])),
        'G0.11': b['survivorship']['pass_'], 'G0.12': '待 feature_windows_t1.json 單獨 commit',
    }
    outs = sorted(glob.glob(os.path.join(BLD.CACHE_DIR, 'a36_*.npz')) + glob.glob(os.path.join(BLD.OUT_DIR, '*.csv'))
                  + [os.path.join(BLD.OUT_DIR, 'feature_windows_t1.json')])
    rep = dict(registration=dict(id='T1-TRACKS-PREREG-2026-10-04', version=2, sha256=L.REG_SHA256),
               generated_by='scripts/surge-lab/a36_tracks_build.py', G0=g0, build=b, events=e,
               truncation=dict(seed=BLD.TRUNC_SEED, days=[t['date'] for t in fa], registered_variant='fixedadj',
                               fixedadj=dict(pass_=g06_pass, domain_diff_suspended_rows=[t['domain']['diff'] for t in fa], per_day=fa),
                               pit=dict(summary=pit_summary, per_day=[{k: v for k, v in t.items() if k != 'nonzero'} | {'nonzero_keys': sorted(t['nonzero'])} for t in pit])),
               output_sha256={os.path.relpath(p, L.LAB if p.startswith(L.LAB) else B.SP): (FP.npz_content_sha256(p) if p.endswith('.npz') else L.file_sha256(p))
                              for p in outs},
               output_sha256_note='npz 記內容指紋（fingerprint.npz_content_sha256，不受 zip 時間戳影響）；其他檔記位元組 sha256',
               git=git_state(),
               disclosures=['TPEx 存活者偏誤未檢查（來源未提供）', '公告疑似缺漏月份見 build.coverage.disposal.*.suspect_months_lt25pct_median',
                            'HOLDOUT：本階段未讀標籤、未計算任何逐軌事件數或基準率（僅結構列數）', '偏差紀錄：tracks/DEVIATIONS_t1_tracks.md'],
               note=L.NOTE)
    BLD.jdump(rep, os.path.join(BLD.OUT_DIR, 'tracks_t1_G0.json'))
    print(json.dumps(g0, ensure_ascii=False, indent=1))
