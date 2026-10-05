"""G1 第 4 項（接線前修正）的鎖後驗證：把修正套進 v2 的鎖定評估路徑重跑，判定不得改變（DEV-009 起）。

只在 APFS 複本 SURGE_CACHE＝.surge-cache-T2 上寫（.surge-cache-T 被 v2 登錄釘住，只讀；共用 .surge-cache 完全不碰）。
v2 鎖定程式（a36_tracks_{lib,eval,cv,ho,decide,fit,proxy,build,stages}.py）一行不改，修正以 a36_tracks_fwd_rules／_m0 包一層：
  rebuild   v3 上市日規則（轉市場第一筆收盤在面板起點 ⇒ −∞）＋「距上次」右截斷（days_since_lu、dp_since 不再 999）重算全面板，
            寫 T2/tracks/a36_tracks_*.npz；與 T 的軌道檔逐欄比對，只有修正要改的欄位可以不同（其餘逐位相同）。
  m0pop     M0 各折各種子：訓練段照 run_m0（資料集測試列分數須與 T 的檢查點逐位相同）→ 以「當日 M 軌全部列」為同日百分位母體重評 M 軌列，
            寫 T2/tracks/cv/a36_fit_M0_*.npz（--windows SEL,HC,HO [--part i --of n]）。
  （新模型：python3 a36_tracks_fit.py prep → run --models … --windows …，皆以 SURGE_CACHE＝T2 執行；舊檢查點先用 clear 移除）
  clear     --models M0s,Mp1,… --windows SEL,HC[,HO]：刪 T2 的這些檢查點（只刪 T2；路徑核對）。
  eval      SEL+HC 全部清單與選模 → HOLDOUT 判定（同 a36_tracks_cv.evaluate／a36_tracks_ho.decide），逐項對照鎖檔；
            前向清單以修正後的格式輸出選股記錄（disposal_status、list_verdict、統一旗標）與逐日揭露
            → out/tracks_t1/fwdprep/（鎖後描述，不參與任何判定、不得用於重新選模）。
  m0fwd     前向凍結 M0（ts＝2026-10-02）擬合兩次確認逐位可重現，記指紋（前向登錄釘住；模型 pickle 只寫 T2）。
每次讀 HO 標籤（HO 擬合、HO 評估）都在 tracks_t1_HO_ATTEMPTS.jsonl 加一列 post-lock:fwdprep:*（只增不改）。
用法：SURGE_CACHE=<T2> SURGE_OFFICIAL_LIMIT=<T2>/official_limits.npz SURGE_REVENUE=revenue_official.json SURGE_PIT_STRICT=1 \\
      python3 a36_tracks_fwd_verify.py rebuild | m0pop --windows SEL,HC,HO [--part i --of n] | clear --models … --windows … | eval | m0fwd
報酬一律未扣成本（成本另列參考，不當門檻）·事後欄位以 m_ 標示·非投資建議。
"""
import contextlib
import gzip
import io
import json
import os
import subprocess
import sys
import time

import numpy as np
import pandas as pd

import a36_tracks_build as BLD
import a36_tracks_cv as CV
import a36_tracks_eval as EV
import a36_tracks_fit as FIT
import a36_tracks_fwd_m0 as FM
import a36_tracks_fwd_rules as FR
import a36_tracks_lib as L
import a36_tracks_t1_audit as AU
import attention as AT
import build as B
import disposal as DP

T_CACHE = os.path.join(L.MAIN_REPO, 'scripts/surge-lab/.surge-cache-T')
T2_CACHE = os.path.join(L.MAIN_REPO, 'scripts/surge-lab/.surge-cache-T2')
MARKER = '.a36_fwdprep_clone.json'
OUT = os.path.join(BLD.OUT_DIR, 'fwdprep')
TRACK_FILES = ('M', 'Mp', 'R', 'S', 'W', 'NE')
SELF = 'a36_tracks_fwd_verify.py'
FWD_CODE = ('a36_tracks_fwd_rules.py', 'a36_tracks_fwd_m0.py', SELF)
POST_LOCK = '鎖後敏感度（G1 第 4 項修正套進 v2 鎖定路徑）：不參與任何判定、不得用於重新選模；判定以 v2 鎖檔為準'
EXPECTED_CHANGED_COLS = {'k_age_off', 'k_age_cap', 'f_age_cap', 'k_first_trade_idx', 'k_listing_src', 'f_days_since_lu', 'f_dp_since', 'k_fA60',
                         'listing_src_names'}


def log(msg):
    BLD.log(msg)


def now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%S%z')


# ───────────────────────── T2 防呆與輸入 ─────────────────────────
def t2_guard():
    """只准在 T2 複本上跑：SURGE_CACHE 的實際路徑＝T2、≠ T，且 T2 有本流程建立的標記檔。"""
    sp = os.path.realpath(os.environ.get('SURGE_CACHE', ''))
    if sp != os.path.realpath(T2_CACHE) or sp == os.path.realpath(T_CACHE) or os.path.realpath(B.SP) != sp:
        raise SystemExit(f'SURGE_CACHE 必須是 {T2_CACHE}（目前 {sp}）：拒跑')
    if not os.path.exists(os.path.join(sp, MARKER)):
        raise SystemExit(f'{sp} 沒有 {MARKER}（不是本流程建立的 APFS 複本）：拒跑')


def load_inputs_t2() -> dict:
    """同 a36_tracks_build.load_inputs，唯一差別：SURGE_CACHE／SURGE_OFFICIAL_LIMIT 指向 T2（其餘環境、全部輸入檔與程式的 sha256 照登錄核對）。"""
    t2_guard()
    reg = L.load_registration()
    bad, n = [], 0
    for k, v in reg['inputs']['env'].items():
        want = {'SURGE_CACHE': T2_CACHE, 'SURGE_OFFICIAL_LIMIT': os.path.join(T2_CACHE, 'official_limits.npz')}.get(k, v)
        cur = os.path.realpath(sys.executable) if k == 'python' else os.environ.get(k)
        want = os.path.realpath(want) if k in ('python',) else want
        n += 1
        if cur != want:
            bad.append(f'環境 {k}={cur!r} ≠ {want!r}')
    for group in ('files_sha256', 'code_sha256'):
        for key, want in reg['inputs'][group].items():
            p = L.resolve_input(key)
            n += 1
            cur = L.file_sha256(p) if os.path.isfile(p) else None
            if cur != want:
                bad.append(f'{key}：{cur} ≠ 登錄 {want}')
    if bad:
        raise SystemExit('T2 輸入與登錄不符，拒跑：\n' + '\n'.join(bad))
    dates, codes, P = B.load_panel()
    return dict(reg=reg, verify=dict(ok=True, n_checked=n, note='SURGE_CACHE／SURGE_OFFICIAL_LIMIT 指向 T2（APFS 複本），檔案雜湊與登錄相同'),
                dates=dates, codes=codes, P=P, events=B.load_factor_events(dates, codes), snaps=L.load_listing_snapshots(),
                intervals=DP.load_intervals(), att_rows=AT.load_rows(), mkt=L.market_of_codes(codes))


@contextlib.contextmanager
def v3_patches():
    """v2 程式不改，只在這個範圍內把上市日規則換成 v3（含 listing_src 代碼表）。"""
    with L._patched(L, 'listing_info', FR.listing_info_v3), L._patched(L, 'LISTING_SRC', FR.LISTING_SRC_V3):
        yield


def code_sha() -> dict:
    return dict(CV.code_sha(), **{f: L.file_sha256(os.path.join(L.LAB, f)) for f in FWD_CODE})


def git(*a) -> str:
    return subprocess.run(['git', '-C', L.LAB, *a], capture_output=True, text=True, check=True).stdout.strip()


# ───────────────────────── rebuild ─────────────────────────
def apply_since_fix(res) -> dict:
    hl = res['ages']['hist_len']
    out = {}
    for name, src in (('days_since_lu', res['F']), ('dp_since', res['extra'])):
        v, st = FR.since_from_legacy(src[name], hl)
        dom = res['domain']
        out[name] = dict(cells_domain=int(dom.sum()), legacy_999_domain=int(((np.asarray(src[name]) == 999) & dom).sum()),
                         state_counts_domain={FR.SINCE_STATES[k]: int(((st == k) & dom).sum()) for k in range(3)},
                         observed_gt_W_domain=int((np.isfinite(np.asarray(src[name], np.float64)) & (np.asarray(src[name]) != 999)
                                                   & (np.asarray(src[name]) > FR.SINCE_W) & dom).sum()))
        src[name] = v.astype(np.asarray(src[name]).dtype)
    return out


def diff_tracks(dir_a: str, dir_b: str) -> dict:
    """兩組軌道檔逐列鍵、逐欄比對（NaN 相等）。"""
    rep = {}
    for name in TRACK_FILES:
        za, zb = np.load(os.path.join(dir_a, f'a36_tracks_{name}.npz')), np.load(os.path.join(dir_b, f'a36_tracks_{name}.npz'))
        nc = len(za['codes'])
        ka, kb = za['m_s'].astype(np.int64) * nc + za['m_j'], zb['m_s'].astype(np.int64) * nc + zb['m_j']
        common, ia, ib = np.intersect1d(ka, kb, assume_unique=True, return_indices=True)
        only_a, only_b = np.setdiff1d(ka, kb), np.setdiff1d(kb, ka)
        cols = {}
        for c in sorted(set(za.files) & set(zb.files)):
            a, b = za[c], zb[c]
            if a.ndim == 0 or a.shape[0] != len(ka):
                if not np.array_equal(a, b):
                    cols[c] = dict(kind='meta', equal=False)
                continue
            x, y = a[ia], b[ib]
            if x.dtype.kind == 'f' or y.dtype.kind == 'f':
                x64, y64 = x.astype(np.float64), y.astype(np.float64)
                same = (x64 == y64) | (np.isnan(x64) & np.isnan(y64))
            else:
                same = x == y
            nd = int((~same).sum())
            if nd:
                s_ = za['m_s'][ia][~same]
                cols[c] = dict(n_diff=nd, s_min=int(s_.min()), s_max=int(s_.max()), in_windows=int((za['m_window'][ia][~same] > 0).sum()),
                               s_ge_125=int((s_ >= FIT.MIN_TRAIN_S).sum()))
        rep[name] = dict(rows_a=int(len(ka)), rows_b=int(len(kb)), only_in_a=int(len(only_a)), only_in_b=int(len(only_b)),
                         only_s_max=int(max([(only_a // nc).max() if len(only_a) else -1, (only_b // nc).max() if len(only_b) else -1])),
                         changed_columns=cols, extra_columns_a=sorted(set(za.files) - set(zb.files)), extra_columns_b=sorted(set(zb.files) - set(za.files)))
    return rep


def stage_rebuild():
    t0 = time.time()
    I = load_inputs_t2()
    with v3_patches():
        res = BLD.compute(I)
    res['P_C'] = I['P']['C']
    lst = res['lst']
    moved = [dict(code=I['codes'][j], listing_v2='transfer_min', listing_v3='transfer_prepanel')
             for j in np.nonzero(lst['listing_src'] == FR.TRANSFER_PREPANEL)[0]]
    since = apply_since_fix(res)
    d = np.load(BLD.DATASET)
    in_ds = np.zeros(res['P_C'].shape, bool)
    in_ds[d['m_s'], d['m_j']] = True
    feat_off = L.official_names(d.files)
    log(f'v3 重算完成（{time.time() - t0:.0f}s）：transfer_prepanel {len(moved)} 檔')
    with v3_patches():
        files, counts = BLD.write_tracks(I, res, {'official': feat_off, 'extra': list(L.EXTRA_FEATURES)}, in_ds)
    rep = diff_tracks(os.path.join(T_CACHE, 'tracks'), os.path.join(T2_CACHE, 'tracks'))
    changed = sorted({c for v in rep.values() for c in v['changed_columns']})
    unexpected = sorted(set(changed) - EXPECTED_CHANGED_COLS - {'m_track'})
    moved_rows_ok = all(v['only_s_max'] < 59 for v in rep.values())
    out = dict(stage='rebuild', time=now(), runtime_s=round(time.time() - t0, 1), listing_v3_moved=moved, since_fix=since,
               partition_structural=res['part']['checks'], rows_by_track_window=counts, diff_vs_T=rep, changed_columns=changed,
               unexpected_changed_columns=unexpected, rows_moved_between_tracks_all_s_lt_59=moved_rows_ok,
               pass_=not unexpected and moved_rows_ok, note=POST_LOCK)
    os.makedirs(OUT, exist_ok=True)
    BLD.jdump(out, os.path.join(T2_CACHE, 'tracks', 'a36_fwdprep_rebuild.json'))
    log(f'rebuild：變動欄位 {changed}；非預期 {unexpected}；換軌列都在 s<59＝{moved_rows_ok}（{time.time() - t0:.0f}s）')
    if not out['pass_']:
        raise SystemExit('rebuild 出現非預期的差異：停止')


# ───────────────────────── m0pop ─────────────────────────
_ZT = {}


def t_m_rows(names) -> dict:
    """T（只讀）的 M 軌檔：全部 M 列的 official 原值（訓練時的編碼）。"""
    if not _ZT:
        z = np.load(os.path.join(T_CACHE, 'tracks', 'a36_tracks_M.npz'))
        _ZT.update(s=z['m_s'], j=z['m_j'], **{f'f_{n}': z[f'f_{n}'] for n in names})
    return _ZT


def argv_opt(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def stage_m0pop():
    t2_guard()
    wins = argv_opt('--windows', 'SEL,HC,HO').split(',')
    part, of = int(argv_opt('--part', 0)), int(argv_opt('--of', 1))
    if 'HO' in wins:
        CV.attempt('post-lock:fwdprep:m0pop:start（鎖後敏感度：M0 以 M 軌全部列為同日百分位母體重評 HO；不寫鎖定產出）')
    reg = L.load_registration()
    FIT.check_feature_windows()
    dates = list(np.load(os.path.join(FIT.TRACK_DIR, 'a36_tracks_M.npz'))['dates'])
    jobs = [(f, ts, te, sd) for (f, ts, te) in FIT.folds(reg, dates, wins) for sd in FM.SEEDS]
    jobs = [x for k, x in enumerate(jobs) if k % of == part]
    names, mask = FM.m0_feature_spec()
    zt = t_m_rows(names)
    D, R, cols = FIT.m0_data()
    t0 = time.time()
    for f, ts, te, sd in jobs:
        p = FIT.ckpt_path('M0', f, sd)
        if os.path.exists(p) and 'population' in np.load(p).files:
            continue
        m, cols_m, info = FM.m0_model(ts, sd)
        assert cols_m == cols
        test = np.nonzero((D['s'] >= ts) & (D['s'] < te))[0]
        Rt = np.asarray(R[test])[:, cols]
        same_rank = bool(np.array_equal(FR.rank_pct_by_day(D['s'][test], D['X'][test][:, cols], mask), Rt, equal_nan=True))
        old = np.load(os.path.join(T_CACHE, 'tracks', 'cv', f'a36_fit_M0_{f}_s{sd}.npz'))
        train_identical = bool(np.array_equal(m.decision_function(Rt), old['score']))
        if not (same_rank and train_identical):
            raise SystemExit(f'M0 {f} s{sd}：同日百分位函式重現 {same_rank}、訓練逐位相同 {train_identical}：停止')
        keep = (zt['s'] >= ts) & (zt['s'] < te)
        ss, jj = zt['s'][keep], zt['j'][keep]
        Xr = FM.population_ranks(ss, {n: zt[f'f_{n}'][keep] for n in names}, names, mask)
        sc = m.decision_function(Xr)
        e0 = np.zeros(0)
        FIT.atomic_savez(p, s=ss, j=jj, score=sc, bf_s=e0.astype(np.int32), bf_j=e0.astype(np.int32), bf_score=e0, population=np.array('M 軌全部列'),
                         n_pop=np.array(len(ss)), n_dataset_test=np.array(len(test)), n_dataset_test_tdr=np.array(int(D['tdr'][test].sum())),
                         train_identical=np.array(train_identical), rank_fn_reproduces_m0_ranks=np.array(same_rank),
                         model=np.array('M0'), fold=np.array(f), seed=np.array(sd), ts=np.array(ts), te=np.array(te))
        log(f'M0 {f} s{sd}：母體 {len(ss):,} 列（資料集測試列 {len(test):,}、其中 TDR {int(D["tdr"][test].sum())}）；訓練逐位相同（{time.time() - t0:.0f}s）')
    if 'HO' in wins:
        CV.attempt('post-lock:fwdprep:m0pop:done（鎖後敏感度）')


# ───────────────────────── clear ─────────────────────────
def stage_clear():
    t2_guard()
    models = argv_opt('--models').split(',')
    wins = argv_opt('--windows').split(',')
    reg = L.load_registration()
    dates = list(np.load(os.path.join(FIT.TRACK_DIR, 'a36_tracks_M.npz'))['dates'])
    n = 0
    for m in models:
        for f, ts, te in FIT.folds(reg, dates, wins):
            for sd in FIT.SEEDS:
                p = os.path.realpath(FIT.ckpt_path(m, f, sd))
                assert p.startswith(os.path.realpath(T2_CACHE) + os.sep), p
                if os.path.exists(p):
                    os.unlink(p)
                    n += 1
    log(f'clear：刪除 T2 檢查點 {n} 份（{models} × {wins}）')


# ───────────────────────── eval ─────────────────────────
def canon(x) -> str:
    return AU.canon(x)


METRIC_KEYS = ('picks', 'hits', 'precision_pct', 'rand_expected_hits', 'delta_vs_rand_pp', 'delta_vs_rand_ci_pp', 'p_vs_rand', 'lift')


def metric_diffs(new: dict, ref: dict) -> dict:
    out = {}
    for lid, d in new.items():
        for w, m in d.items():
            r = ref.get(lid, {}).get(w)
            if r is None:
                out[f'{lid}|{w}'] = 'ref 無此項'
                continue
            dd = {k: dict(locked=r.get(k), fixed=m.get(k)) for k in METRIC_KEYS if canon(m.get(k)) != canon(r.get(k))}
            for h in ('c5_all_buyable', 'c5_dk0', 'c10_dk0'):
                if canon(m[h]) != canon(r[h]):
                    dd[h] = dict(locked=r[h].get('daily_mean_pct'), fixed=m[h].get('daily_mean_pct'), locked_ci=r[h].get('ci_pct'), fixed_ci=m[h].get('ci_pct'))
            whole_equal = canon({k: v for k, v in m.items() if k != '_label'}) == canon({k: v for k, v in r.items() if k != '_label'})
            if dd or not whole_equal:
                out[f'{lid}|{w}'] = dict(changed=dd, whole_block_equal=whole_equal)
    return out


def fixed_records(E, I, res, lids) -> tuple:
    """修正後格式的前向清單選股記錄（i、ii）與逐日揭露；同時核對新旁類（FR.exit_category）與鎖後補遺（AU.exit_alternatives）逐列等價。"""
    df = E['df']
    T = res['A']['C'].shape[0]
    fin = np.isfinite(res['A']['C'])
    O = I['P']['O']
    n20 = AU.nan20_of(df, len(I['codes']))
    wn = np.array(L.WINDOW_NAMES)
    fb = AU.name_fallback()
    parts, eq = [], {}
    Ca, Oa = np.asarray(res['A']['C'], np.float64), np.asarray(res['A']['O'], np.float64)
    for lid in lids:
        if f'rk_{lid}' not in df:
            continue
        pk = EV.picks_of(df, lid)
        ix = df.index.get_indexer(pk.index)
        s, j = pk.s.values.astype(np.int64), pk.j.values.astype(np.int64)
        buy = pk.buyable.values.astype(bool)
        has_open = np.where(s + 1 < T, np.isfinite(O[np.minimum(s + 1, T - 1), j]), False)
        cats = {}
        for h, k in FR.HORIZON_STEPS.items():
            cats[h] = FR.exit_category(fin, s, j, k, T - 1, buy, n20[ix])
            au = AU.exit_alternatives(Ca, Oa, s, j, pk[f'm_{h}'].values.astype(np.float64), buy, n20[ix], k)['cat']
            eq[f'{lid}|{h}'] = bool(all(FR.AUDIT_CAT_MAP[a] == b for a, b in zip(au, cats[h])))
        codes = FR.pick_flag_codes(pk.dk.values, pk.m_disp_t_exec.values, has_open, pk.m_locked_open.values, cats['c5'], cats['c10'])
        nm, nsrc = AU.fill_names(pk.code.values, pk.name.values, fb)
        spec = FR.FWD_LISTS[lid]
        parts.append(pd.DataFrame({
            'window': wn[pk.window.values], 'date_s': pk.date_s.values, 'trade_day_t': pk.date_t.values, 'code': pk.code.values, 'name': nm,
            'name_src': nsrc, 'market': pk.market.values, 'track': pk.track_name.values, 'list_id': lid, 'section': spec['section'],
            'grey_watch_only': spec['grey'], 'rank': pk[f'rk_{lid}'].values.astype(int), 'score': np.round(pk[f'sc_{lid}'].values, 6), 'y': pk.y.values,
            'DK_s': pk.dk.values, 'disposal_status': FR.disposal_status(pk.dk.values), 'list_verdict': FR.LIST_VERDICT_FWD[lid],
            'm_disp_t_exec': pk.m_disp_t_exec.values, 'm_has_open_t': has_open.astype(np.int8), 'm_locked_open': pk.m_locked_open.values,
            'm_buyable': pk.m_buyable.values, 'exit_c5_cat': cats['c5'], 'exit_c10_cat': cats['c10'], 'flags': codes,
            'flags_text': [FR.flags_text(c) for c in codes], 'm_c5': EV.fmt_pct(pk.m_c5.values), 'm_c10': EV.fmt_pct(pk.m_c10.values),
            'Qmax_lots': pk.qmax.values, 'vol20_s': np.round(pk.vol20.values, 2), 'labels': '；'.join(FR.FIXED_LABELS) + ('；容量受限' if 'S0' in lid or 'SFB' in lid else ''),
            'note': POST_LOCK + '·' + L.NOTE}))
    rec = pd.concat(parts, ignore_index=True)
    return rec, FR.daily_disclosure(rec), eq


def write_gz(name: str, frame: pd.DataFrame) -> dict:
    raw = EV.csv_bytes(frame)
    gz = gzip.compress(raw, 9, mtime=0)
    assert len(gz) < 1_000_000, f'{name} 壓縮後 {len(gz)} bytes ≥ 1 MB（要分片）'
    open(os.path.join(OUT, f'{name}.gz'), 'wb').write(gz)
    return dict(path=f'fwdprep/{name}.gz', rows=int(len(frame)), raw_sha256=EV.sha(raw), gz_sha256=EV.sha(gz), gz_bytes=len(gz))


def write_records(group: str, records: dict) -> dict:
    """修正後重跑的命中／漏網／選股記錄（v2 格式，專案規則：每次評估都要留 HIT 與 MISS）：gzip（mtime＝0）、壓縮後 > 1 MB 才分片。"""
    d = os.path.join(OUT, 'records', group)
    os.makedirs(d, exist_ok=True)
    out = {}
    for name, raw in records.items():
        parts = AU.gz_parts(raw)
        assert AU.gunzip_parts(parts) == raw
        paths = []
        for i, b in enumerate(parts):
            fn = f'{name}.gz' if len(parts) == 1 else f'{name}.gz.part{i + 1:02d}'
            open(os.path.join(d, fn), 'wb').write(b)
            paths.append(dict(path=f'fwdprep/records/{group}/{fn}', bytes=len(b), sha256=EV.sha(b)))
        out[f'records/{group}/{name}'] = dict(raw_sha256=EV.sha(raw), rows=max(raw.count(b'\n') - 1, 0), gz=paths)
    return out


PROXY_LISTS = {'M_atr14@5': 'M', 'M_combo@5': 'M', 'SFB_atr14@5': 'Mp', 'R0_combo@5': 'R', 'S0_atr14@5': 'S', 'W_atr14@3': 'W'}


def locked_bytes(name: str) -> bytes:
    """已鎖／已 commit 的記錄檔：原檔在 out/tracks_t1/，較大的只有 gz/（DEV-005）。"""
    p = os.path.join(CV.OUT, name)
    if os.path.exists(p):
        return open(p, 'rb').read()
    return gzip.decompress(open(os.path.join(CV.OUT, 'gz', f'{name}.gz'), 'rb').read())


def proxy_membership(records: dict, pre: str) -> dict:
    """代理清單（修正不影響）的選股成員、名次與命中逐列相同：修正後重跑的 v2 格式選股記錄 vs 鎖定記錄。"""
    out = {}
    for lid, t in PROXY_LISTS.items():
        name = f'{pre}{t}_picks.csv'
        if name not in records:
            continue
        cols = ['date_s', 'code', 'list_id', 'rank', 'y', 'm_buyable', 'm_c5', 'm_c10', 'DK_s', 'Qmax_lots']
        a = pd.read_csv(io.BytesIO(records[name]), dtype={'code': str})
        b = pd.read_csv(io.BytesIO(locked_bytes(name)), dtype={'code': str})
        a, b = (x[x.list_id == lid][cols].reset_index(drop=True) for x in (a, b))
        out[lid] = dict(rows_fixed=int(len(a)), rows_locked=int(len(b)), identical=bool(len(a) == len(b) and a.equals(b)))
    return out


def selhc_part(I, res, locked_sel) -> tuple:
    t0 = time.time()
    summ, E = CV.build_selhc(I, res)
    sel = summ['selection']
    log(f'SEL+HC（修正後）完成：W_R={sel["W_R"]}、W_S={sel["W_S"]}、Mp1 帶進 HO={sel["Mp1_carry_to_holdout"]}（{time.time() - t0:.0f}s）')
    selhc = dict(selection_locked={k: locked_sel['selection'][k] for k in ('W_R', 'W_S', 'Mp1_carry_to_holdout')},
                 selection_fixed={k: sel[k] for k in ('W_R', 'W_S', 'Mp1_carry_to_holdout')},
                 selection_detail_fixed={k: sel[k] for k in ('Mp', 'R', 'S')}, selection_detail_locked={k: locked_sel['selection'][k] for k in ('Mp', 'R', 'S')},
                 metric_diffs=metric_diffs(E['metrics'], locked_sel['lists']),
                 records_sha_equal={k: locked_sel['record_files'][k]['sha256'] == EV.sha(v) for k, v in E['records'].items()},
                 equal_slot_fixed={tag: {w: x['composite_minus_M0top20'] for w, x in v['by_window'].items()} for tag, v in E['equal_slot'].items()},
                 proxy_picks_identical=proxy_membership(E['records'], 'tracks_t1_'))
    selhc['selection_equal'] = selhc['selection_locked'] == selhc['selection_fixed']
    os.makedirs(OUT, exist_ok=True)
    rec_s, dis_s, eq_s = fixed_records(E, I, res, list(FR.FWD_LISTS))
    files = {'tracks_t1_FWDPREP_SELHC_fwdlists_picks.csv': write_gz('tracks_t1_FWDPREP_SELHC_fwdlists_picks.csv', rec_s),
             'tracks_t1_FWDPREP_SELHC_daily_disclosure.csv': write_gz('tracks_t1_FWDPREP_SELHC_daily_disclosure.csv', dis_s)}
    files.update(write_records('SELHC', E['records']))
    return {k: sel[k] for k in ('W_R', 'W_S', 'Mp1_carry_to_holdout')} | {k: sel[k] for k in ('Mp', 'R', 'S')}, selhc, files, eq_s


def stage_eval():
    t0 = time.time()
    I = load_inputs_t2()
    with v3_patches():
        res = BLD.compute(I, with_features=False)
        res['dates'] = I['dates']
        locked_sel = json.load(open(os.path.join(CV.OUT, 'tracks_t1_summary.json'), encoding='utf-8'))
        ck = os.path.join(T2_CACHE, 'tracks', 'a36_fwdprep_eval_selhc.json')
        if '--resume' in sys.argv and os.path.exists(ck):           # HO 段崩潰後續跑：SEL+HC 段的結果與檔案已寫好
            c = json.load(open(ck, encoding='utf-8'))
            sel, selhc, files, eq_s = c['sel'], c['selhc'], c['files'], c['eq_s']
            log('沿用已完成的 SEL+HC 段（--resume）')
        else:
            sel, selhc, files, eq_s = selhc_part(I, res, locked_sel)
            BLD.jdump(dict(sel=sel, selhc=selhc, files=files, eq_s=eq_s), ck)
        lock = json.load(open(os.path.join(CV.OUT, 'tracks_t1_HO_LOCK.json'), encoding='utf-8'))
        ho_summ = json.load(open(os.path.join(CV.OUT, 'tracks_t1_HO_summary.json'), encoding='utf-8'))
        models, lists = CV.ho_models_and_lists(sel)
        missing = [FIT.ckpt_path(m, f, sd) for m in models for (f, ts, te) in FIT.folds(I['reg'], I['dates'], ['HO']) for sd in FIT.SEEDS
                   if not os.path.exists(FIT.ckpt_path(m, f, sd))]
        if missing:
            raise SystemExit(f'HO 檢查點缺 {len(missing)} 份（選模變了？{sel["W_R"]}／{sel["W_S"]}）：{missing[:3]}…')
        CV.attempt('post-lock:fwdprep:ho-eval:start（鎖後敏感度：G1 第 4 項修正套進 HO 路徑；不寫鎖定產出、不改判定）')
        import a36_tracks_ho as HO
        first = HO.ho_label_assertion(res)
        Eh = CV.evaluate(I, res, I['reg'], 'HO', lists, models, selection=sel)
        dec = HO.decide(Eh, sel)
        decisions = {k: dec[k] for k in ('Mp', 'R', 'S', 'S_FB', 'DD', 'M', 'W')}
        holm_exact = (AU.holm_exact(Eh, dict(decision_detail=dec))
                      if {'R1@5 − R0_combo@5', 'Mp1@10 − M0@10'} <= set(Eh['pairs']) else None)
        if holm_exact:                                   # AU 的鍵名 holm_lock 在這裡指「修正後重跑、捨入 p」，換名以免誤讀成鎖檔
            holm_exact['holm_rounded_p_fixed_run'] = holm_exact.pop('holm_lock')
        ho = dict(first_assertion=first, first_assertion_equal_locked=canon(first) == canon(ho_summ['first_assertion']),
                  decisions_locked=lock['decisions'], decisions_fixed=decisions, decisions_equal=decisions == lock['decisions'],
                  holm_fixed=dec['holm'], holm_locked=ho_summ['decision_detail']['holm'], holm_exact_p_fixed=holm_exact,
                  decision_detail_fixed={k: v for k, v in dec.items() if k.endswith('_detail') or k in ('tests', 'DD1')},
                  metric_diffs=metric_diffs(Eh['metrics'], ho_summ['lists']),
                  records_sha_equal={k: lock['outputs_sha256'].get(k) == EV.sha(v) for k, v in Eh['records'].items()},
                  equal_slot_fixed={tag: {w: x['composite_minus_M0top20'] for w, x in v['by_window'].items() if w in ('HO', 'HO-model')} for tag, v in Eh['equal_slot'].items()},
                  proxy_picks_identical=proxy_membership(Eh['records'], 'tracks_t1_HO_'))
        rec_h, dis_h, eq_h = fixed_records(Eh, I, res, list(FR.FWD_LISTS))
        files.update({'tracks_t1_FWDPREP_HO_fwdlists_picks.csv': write_gz('tracks_t1_FWDPREP_HO_fwdlists_picks.csv', rec_h),
                      'tracks_t1_FWDPREP_HO_daily_disclosure.csv': write_gz('tracks_t1_FWDPREP_HO_daily_disclosure.csv', dis_h)})
        files.update(write_records('HO', Eh['records']))
        CV.attempt('post-lock:fwdprep:ho-eval:done（鎖後敏感度）')
    rb = json.load(open(os.path.join(T2_CACHE, 'tracks', 'a36_fwdprep_rebuild.json'), encoding='utf-8'))
    m0 = m0_checks(I['reg'], I['dates'])
    proxy_lists = ('M_atr14@5', 'M_combo@5', 'SFB_atr14@5', 'R0_combo@5', 'S0_atr14@5', 'W_atr14@3')
    proxy_equal = {g: not any(k.split('|')[0] in proxy_lists for k in d['metric_diffs']) and all(x['identical'] for x in d['proxy_picks_identical'].values())
                   for g, d in (('SELHC', selhc), ('HO', ho))}
    out = dict(generated_by=f'scripts/surge-lab/{SELF} eval', time=now(), head=git('rev-parse', 'HEAD'), registration_sha256=L.REG_SHA256,
               code_sha256=code_sha(), cache=T2_CACHE, post_lock_note=POST_LOCK,
               fixes={'i': '選股記錄 tradable_status→disposal_status＋list_verdict（記錄格式，不影響指標）',
                      'ii': '出場日無收盤與 t 日起處置同一套旗標＋逐日揭露（記錄格式，不影響指標）',
                      'iii': 'M0 同日百分位母體＝當日 M 軌全部列（影響 M0 清單與用到 M0 的配對）',
                      'iv': 'v3 上市日規則＋距上次右截斷（影響新模型 Mp1、M0*、R1、R2、S1、S2 的特徵）'},
               rebuild=dict(pass_=rb['pass_'], changed_columns=rb['changed_columns'], listing_v3_moved=rb['listing_v3_moved'], since_fix=rb['since_fix'],
                            rows_moved_between_tracks_all_s_lt_59=rb['rows_moved_between_tracks_all_s_lt_59'],
                            changed_columns_detail={k: v['changed_columns'] for k, v in rb['diff_vs_T'].items()}),
               m0_population=m0, SELHC=selhc, HO=ho, proxy_lists_metrics_identical=proxy_equal,
               exit_category_equivalent_to_audit=dict(SELHC=all(eq_s.values()), HO=all(eq_h.values()), detail={**{f'SELHC|{k}': v for k, v in eq_s.items()}, **{f'HO|{k}': v for k, v in eq_h.items()}}),
               verdicts_unchanged=ho['decisions_equal'] and selhc['selection_equal'], files=files, runtime_s=round(time.time() - t0, 1), note=L.NOTE)
    open(os.path.join(OUT, 'tracks_t1_FWDPREP_VERIFY.json'), 'wb').write(CV.dumps(out))
    log(f'eval：選模相同 {selhc["selection_equal"]}；HO 判定相同 {ho["decisions_equal"]}（{decisions}）；代理清單指標相同 {proxy_equal}（{out["runtime_s"]}s）')


def m0_checks(reg, dates) -> dict:
    out = {}
    for w in ('SEL', 'HC', 'HO'):
        for f, ts, te in FIT.folds(reg, dates, [w]):
            for sd in FIT.SEEDS:
                c = np.load(FIT.ckpt_path('M0', f, sd))
                out[f'{f}_s{sd}'] = dict(population=str(c['population']), n_pop=int(c['n_pop']), n_dataset_test=int(c['n_dataset_test']),
                                         n_dataset_test_tdr=int(c['n_dataset_test_tdr']), train_identical=bool(c['train_identical']),
                                         rank_fn_reproduces_m0_ranks=bool(c['rank_fn_reproduces_m0_ranks']))
    return dict(per_fold_seed=out, all_train_identical=all(v['train_identical'] for v in out.values()),
                all_rank_fn_reproduces=all(v['rank_fn_reproduces_m0_ranks'] for v in out.values()))


def stage_m0fwd():
    """前向凍結 M0（ts＝FM.FWD_TS）：擬合三種子兩次，確認逐位可重現，記錄指紋（全部釘住資料集列的 decision_function 的 sha256）。
    模型 pickle 只寫 T2（不進版控）；接線時以同一函式重擬，指紋必須相同才可凍結第一份 M0 參照名單。"""
    t2_guard()
    D, R, cols = FIT.m0_data()
    Xall = np.asarray(R)[:, cols]
    fps = []
    for rep in range(2):
        models = FM.fit_frozen_forward()
        z = np.concatenate([m.decision_function(Xall) for m in models])
        fps.append(EV.sha(z.astype('<f8').tobytes()))
    info = FM.m0_model(FM.FWD_TS, 0)[2]
    pk = os.path.join(T2_CACHE, 'tracks', 'a36_fwd_m0_models.pkl')
    out = dict(stage='m0fwd', time=now(), ts=FM.FWD_TS, ts_date=D['dates'][FM.FWD_TS], last_train_s=info['last_train_s'],
               last_train_date=D['dates'][info['last_train_s']], n_train_seed0=info['n_train'], n_pos=info['n_pos'],
               fingerprint_sha256=fps[0], reproducible=fps[0] == fps[1], n_rows_fingerprint=int(len(Xall)),
               fingerprint_rule='sha256(concat_seeds(decision_function(釘住資料集全部列的 M0 百分位輸入)).astype(<f8))',
               pickle_sha256_T2=FM.save_models(models, pk), dataset_fingerprint=D['dataset_sha'])
    BLD.jdump(out, os.path.join(T2_CACHE, 'tracks', 'a36_fwdprep_m0fwd.json'))
    log(f'm0fwd：指紋 {fps[0][:16]}…、兩次逐位相同 {out["reproducible"]}；訓練到 {out["last_train_date"]}')


def stage_attempt():
    """HO 擬合（a36_tracks_fit.py run --windows HO）前後手動記一列 ATTEMPTS（--msg 文字）。"""
    t2_guard()
    CV.attempt(f'post-lock:fwdprep:{argv_opt("--msg")}')


if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    {'rebuild': stage_rebuild, 'm0pop': stage_m0pop, 'clear': stage_clear, 'eval': stage_eval, 'm0fwd': stage_m0fwd,
     'attempt': stage_attempt}.get(st, lambda: sys.exit(__doc__))()
