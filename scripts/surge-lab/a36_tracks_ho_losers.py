"""T1 分軌研究：落選挑戰者 R2、S1、S2 在 HOLDOUT 的鎖後描述記錄（DEV-009；使用者 G1 第 5 項，2026-10-05）。

鎖後描述，不參與判定：登錄 T1-TRACKS-PREREG-2026-10-04 v2 凍結、HOLDOUT 鎖檔與全部鎖定產出一律不動，判定不變；
本檔輸出只能當描述，不得用於重新選模。本檔不在 a36_tracks_cv.CODE_FILES 內（新增它不改 HO 摘要內嵌的程式雜湊）。

  fit   SURGE_CACHE＝.surge-cache-T3（釘住快取 .surge-cache-T 的 APFS 複本 `cp -c -R`；寫入只在 T3，釘住的 T 不寫）：
        以 a36_tracks_fit.stage_run 同一條路徑（＝HO 擬合 R1 時的路徑）擬合 R2、S1、S2 的 HO 六折×種子 0／1／2——
        expanding window、purge 11、正例全留＋負例 10%（rng＝default_rng(seed＋ts)）、run_cv.GB、新模型訓練列 s ≥ 125、
        特徵＝登錄的各挑戰者特徵 → T3/tracks/cv/a36_fit_{R2,S1,S2}_HO{1..6}_s{0,1,2}.npz（已存在就跳過＝從檢查點續跑）。
        可平行：--part i --of n。
  eval  SURGE_CACHE＝.surge-cache-T（登錄 env；BLD.load_inputs 逐項驗輸入雜湊；唯讀）：只有這三個模型的檢查點改讀 T3，
        其餘一律讀 T。先核對 (1) T 與 T3 的擬合輸入 sha256 相同、(2) 每模型重擬 SEL1／HO4 種子 0 與檢查點逐位相同、
        (3) 同一個 a36_tracks_cv.evaluate 重算的 16 份 HO 鎖定記錄 sha256＝鎖檔、全部鎖定清單指標／配對／判定細節＝HO 摘要、
        判定樹重算＝鎖檔判定；之後才輸出落選三清單的命中／漏網／選股與摘要到 out/tracks_t1/addendum/ho_losers/。
        前後比對釘住快取 T 的檔案清單（大小＋mtime）完全不變。
挑戰者只在 HO-model（2024Q2～Q4，第 4～6 折）有意義；HO 全期、HO-2023、排除 2024Q4 標「面板起點限制，不作判定」（登錄 §8.1）。
用法：SURGE_CACHE=<…/.surge-cache-T3> python3 a36_tracks_ho_losers.py fit [--part i --of n]
      SURGE_CACHE=<…/.surge-cache-T> SURGE_OFFICIAL_LIMIT=<…/.surge-cache-T/official_limits.npz> SURGE_REVENUE=revenue_official.json \\
      SURGE_PIT_STRICT=1 python3 a36_tracks_ho_losers.py eval
報酬一律未扣成本（成本另列參考，不當門檻）·事後欄位以 m_ 標示·非投資建議。
"""
import contextlib
import json
import os
import sys
import time

import numpy as np
import pandas as pd

import a36_tracks_build as BLD
import a36_tracks_cv as CV
import a36_tracks_eval as EV
import a36_tracks_fit as FIT
import a36_tracks_ho as HO
import a36_tracks_lib as L
import a36_tracks_t1_audit as AU
import run_cv

SELF = 'a36_tracks_ho_losers.py'
LOSER_MODELS = ('R2', 'S1', 'S2')
LOSER_LISTS = ('R2@5', 'S1@5', 'S2@5')
TRACK_LISTS = {'R': ('R2@5',), 'S': ('S1@5', 'S2@5')}
PAIR_REFS = {'R2@5': ('R0_combo@5', 'R1@5', 'M0@10'), 'S1@5': ('S0_atr14@5', 'M0@10'), 'S2@5': ('S0_atr14@5', 'M0@10')}
CACHE_T = os.path.join(L.MAIN_REPO, 'scripts', 'surge-lab', '.surge-cache-T')
CACHE_T3 = os.path.join(L.MAIN_REPO, 'scripts', 'surge-lab', '.surge-cache-T3')
OUT_DIR = os.path.join(AU.ADD_DIR, 'ho_losers')
PRE = 'tracks_t1_HO_losers_'
LABEL = '鎖後描述，不參與判定'
LABEL_LONG = (f'{LABEL}（DEV-009；使用者 G1 第 5 項 2026-10-05）：落選挑戰者在 HOLDOUT 的描述記錄，'
              '鎖定判定不變，不得用於重新選模')
PANEL_WINDOWS = ('HO', 'HO-2023', 'HO-ex2024Q4')       # 含 HO 第 1～3 折：面板起點限制，不作判定（同 a36_tracks_ho.run）
HO_MODEL_FIRST_FOLD = 4                                 # 記錄檔 fold 欄是 1 起算；HO-model＝第 4～6 折
FIT_INPUTS = ('tracks/a36_tracks_M.npz', 'tracks/cv/a36_mx_meta.json') + tuple(
    f'tracks/cv/a36_mx_{t}{x}' for t in ('M', 'R', 'S') for x in ('.npy', '_meta.npz'))


def log(msg):
    BLD.log(msg)


def now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%S%z')


def code_sha() -> dict:
    return dict(AU.code_sha(), **{SELF: L.file_sha256(os.path.join(L.LAB, SELF))})


# ───────────────────────── 純函式（有單元測試）─────────────────────────
def same_dir(a: str, b: str) -> bool:
    return os.path.realpath(a) == os.path.realpath(b)


@contextlib.contextmanager
def loser_ckpts_from(cv_dir: str, models=LOSER_MODELS):
    """只把 models 的擬合檢查點路徑改到 cv_dir（a36_tracks_eval.model_scores 經 FIT.ckpt_path 取路徑）；其餘模型照舊。離開時還原。"""
    orig = FIT.ckpt_path

    def routed(model, fold, seed):
        p = orig(model, fold, seed)
        return os.path.join(cv_dir, os.path.basename(p)) if model in models else p
    FIT.ckpt_path = routed
    try:
        yield routed
    finally:
        FIT.ckpt_path = orig


def tree_manifest(root: str) -> dict:
    """root 之下每個檔案的（大小, mtime_ns）；用來證明釘住快取前後完全沒有被寫。"""
    out = {}
    for d, _, fs in os.walk(root):
        for f in fs:
            p = os.path.join(d, f)
            st = os.lstat(p)
            out[os.path.relpath(p, root)] = (st.st_size, st.st_mtime_ns)
    return out


def manifest_diff(a: dict, b: dict) -> dict:
    return dict(added=sorted(set(b) - set(a)), removed=sorted(set(a) - set(b)), changed=sorted(k for k in set(a) & set(b) if a[k] != b[k]))


def label_rows(frame: pd.DataFrame) -> pd.DataFrame:
    """每列加 HO-model 歸屬與鎖後標籤（fold 欄 1 起算）。"""
    if frame.empty:
        return frame
    ho_model = frame['fold'].values >= HO_MODEL_FIRST_FOLD
    return frame.assign(ho_model_window=np.where(ho_model, 'HO-model（2024Q2～Q4，挑戰者評估窗）', f'HO 第 1～3 折：{HO.PANEL_START_NOTE}'),
                        addendum_note=f'{LABEL_LONG}·{L.NOTE}')


def write_record(out_dir: str, name: str, frame: pd.DataFrame) -> dict:
    """≤ 500,000 bytes 存原檔 CSV；較大的 gzip（mtime＝0、可重現），壓縮後 > 1,000,000 bytes 才分片（DEV-005 同一規則）。"""
    raw = EV.csv_bytes(frame)
    if len(raw) <= AU.RAW_COMMIT_MAX:
        open(os.path.join(out_dir, name), 'wb').write(raw)
        files = [dict(path=name, bytes=len(raw), sha256=EV.sha(raw))]
        storage = 'csv 原檔'
    else:
        parts = AU.gz_parts(raw)
        assert AU.gunzip_parts(parts) == raw
        files = []
        for i, p in enumerate(parts):
            fn = f'{name}.gz' if len(parts) == 1 else f'{name}.gz.part{i + 1:02d}'
            open(os.path.join(out_dir, fn), 'wb').write(p)
            files.append(dict(path=fn, bytes=len(p), sha256=EV.sha(p)))
        storage = 'gzip -9、mtime＝0（還原：' + ('gunzip -c ' + files[0]['path'] if len(files) == 1 else 'cat 各分片 | gunzip') + '）'
    return dict(raw_sha256=EV.sha(raw), raw_bytes=len(raw), rows=AU.rows_of(raw), storage=storage, files=files)


# ───────────────────────── 守門 ─────────────────────────
def require_cache(expected: str) -> None:
    if not same_dir(FIT.B.SP, expected):
        raise SystemExit(f'SURGE_CACHE＝{FIT.B.SP} ≠ 本階段指定的 {expected}：拒跑（fit 只准寫 T3；eval 只准用登錄的 T）')


def lock_guard() -> tuple:
    lock = json.load(open(os.path.join(CV.OUT, 'tracks_t1_HO_LOCK.json'), encoding='utf-8'))
    if lock['decisions'] != AU.EXPECTED_DECISIONS:
        raise SystemExit(f'鎖檔判定與預期不同：{lock["decisions"]}')
    sel = json.load(open(os.path.join(CV.OUT, 'tracks_t1_HO_STARTED.json'), encoding='utf-8'))['selection']
    if sel['W_R'] in LOSER_LISTS or sel['W_S'] in LOSER_LISTS:
        raise SystemExit(f'選定清單 {sel} 含本檔的落選清單：不適用')
    return lock, sel


def attempt(stage: str) -> None:
    """HO 讀取一律記進 ATTEMPTS（只增不改，DEV-005 第 5 點）。"""
    rec = dict(time=now(), head=CV.git('rev-parse', 'HEAD'), code_sha256=code_sha(), stage=stage, error=None)
    with open(os.path.join(CV.OUT, 'tracks_t1_HO_ATTEMPTS.jsonl'), 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


# ───────────────────────── fit ─────────────────────────
def stage_fit():
    require_cache(CACHE_T3)
    lock_guard()
    part = sys.argv[sys.argv.index('--part') + 1] if '--part' in sys.argv else '0'
    of = sys.argv[sys.argv.index('--of') + 1] if '--of' in sys.argv else '1'
    attempt(f'post-lock:ho-losers:fit:start part {part}/{of}（{LABEL}；寫入只在 .surge-cache-T3）')
    sys.argv = [sys.argv[0], 'run', '--models', ','.join(LOSER_MODELS), '--windows', 'HO', '--part', part, '--of', of]
    FIT.stage_run()
    attempt(f'post-lock:ho-losers:fit:done part {part}/{of}')


# ───────────────────────── eval：前置核對 ─────────────────────────
def ho_jobs(reg) -> list:
    dates = list(np.load(os.path.join(FIT.TRACK_DIR, 'a36_tracks_M.npz'))['dates'])
    return FIT.jobs(reg, dates, list(LOSER_MODELS), ['HO'])


def checkpoint_inventory(reg) -> dict:
    t3_cv = os.path.join(CACHE_T3, 'tracks', 'cv')
    out, missing, in_pinned = {}, [], []
    for (m, f, ts, te, sd) in ho_jobs(reg):
        name = os.path.basename(FIT.ckpt_path(m, f, sd))
        p = os.path.join(t3_cv, name)
        if os.path.exists(os.path.join(CACHE_T, 'tracks', 'cv', name)):
            in_pinned.append(name)
        if not os.path.exists(p):
            missing.append(name)
            continue
        c = np.load(p)
        out[name] = dict(sha256=L.file_sha256(p), model=m, fold=f, seed=sd, ts=ts, te=te, n_train=int(c['n_train']), n_pos=int(c['n_pos']),
                         n_feat=int(c['n_feat']), n_scored=int(len(c['s'])))
    if missing or in_pinned:
        raise SystemExit(f'檢查點缺 {missing}；釘住快取 T 出現本檔的檢查點 {in_pinned}（T 不得被寫）')
    return out


def fit_inputs_equal() -> dict:
    out = {k: dict(T=L.file_sha256(os.path.join(CACHE_T, k)), T3=L.file_sha256(os.path.join(CACHE_T3, k))) for k in FIT_INPUTS}
    for v in out.values():
        v['equal'] = v['T'] == v['T3']
    if not all(v['equal'] for v in out.values()):
        raise SystemExit(f'T3 的擬合輸入與釘住快取 T 不同：{out}')
    return out


def spot_refit(reg) -> dict:
    """每個落選模型：SEL1 種子 0 重擬（讀 T）＝T 的 SELECTION 檢查點；HO4 種子 0 重擬（讀 T）＝T3 的 HO 檢查點（逐位）。"""
    dates = list(np.load(os.path.join(FIT.TRACK_DIR, 'a36_tracks_M.npz'))['dates'])
    sel1 = FIT.folds(reg, dates, ['SEL'])[0]
    ho4 = FIT.folds(reg, dates, ['HO'])[HO_MODEL_FIRST_FOLD - 1]
    out = {}
    for m in LOSER_MODELS:
        for (f, ts, te), root in ((sel1, CACHE_T), (ho4, CACHE_T3)):
            p = os.path.join(root, 'tracks', 'cv', os.path.basename(FIT.ckpt_path(m, f, 0)))
            r = FIT.run_new(m, ts, te, 0)
            c = np.load(p)
            ok = bool(np.array_equal(np.asarray(r['score']), c['score']) and np.array_equal(r['s'], c['s']) and np.array_equal(r['j'], c['j']))
            out[f'{m}|{f}|s0'] = dict(checkpoint=os.path.relpath(p, os.path.dirname(root)), bit_equal=ok)
    if not all(v['bit_equal'] for v in out.values()):
        raise SystemExit(f'重擬與檢查點不同：{out}')
    return out


def locked_lists_view(E, lists) -> dict:
    """依 a36_tracks_ho.run 的同一規則替新模型清單的 HO／HO-2023／排除 2024Q4 加標籤。"""
    return {lid: {w: (dict(m, _label=HO.PANEL_START_NOTE) if lid in HO.NEW_MODEL_LISTS and w in PANEL_WINDOWS else m)
                  for w, m in E['metrics'][lid].items()} for lid in lists}


def locked_consistency(E, lists, lock, summ, sel) -> dict:
    """加入落選清單後，鎖定的部分必須逐位不變：16 份記錄 sha256、全部清單指標、配對、等名額、DD1、C2、分區、判定細節與判定。"""
    rec = CV.records(E['df'], 'HO', lists)
    rec_cmp = {k: dict(lock=lock['outputs_sha256'].get(k), now=EV.sha(v)) for k, v in rec.items()}
    for v in rec_cmp.values():
        v['equal'] = v['lock'] == v['now']
    view = locked_lists_view(E, lists)
    dec = HO.decide(E, sel)
    c = AU.canon
    checks = dict(
        records_all_equal=all(v['equal'] for v in rec_cmp.values()) and len(rec_cmp) == len(lock['outputs_sha256']) - 1,
        lists_equal={lid: c(view[lid]) == c(summ['lists'][lid]) for lid in lists},
        lists_set_equal=sorted(lists) == sorted(summ['lists']),
        pairs_equal=c(CV.compact_pairs(E['pairs'])) == c(summ['pairs']),
        equal_slot_equal=c(E['equal_slot']) == c(summ['equal_slot_control_descriptive']),
        DD1_equal=c(E['dd1']) == c(summ['DD1']), C2_equal=c(E['c2']) == c(summ['C2']),
        partition_equal=c(CV.partition_counts(E)) == c(summ['partition']),
        decision_detail_equal=c(dec) == c(summ['decision_detail']),
        decisions_now={k: dec[k] for k in lock['decisions']}, decisions_lock=lock['decisions'])
    checks['decisions_equal'] = checks['decisions_now'] == checks['decisions_lock']
    ok = (checks['records_all_equal'] and all(checks['lists_equal'].values()) and checks['lists_set_equal'] and checks['decisions_equal']
          and all(checks[k] for k in ('pairs_equal', 'equal_slot_equal', 'DD1_equal', 'C2_equal', 'partition_equal', 'decision_detail_equal')))
    if not ok:
        raise SystemExit(f'加入落選清單後鎖定部分與鎖檔／HO 摘要不同：{json.dumps(checks, ensure_ascii=False, default=str)[:3000]}')
    return dict(checks, records=rec_cmp, all_equal=True)


# ───────────────────────── eval：落選清單的描述 ─────────────────────────
def loser_pairs(E) -> dict:
    out = {}
    for lid, refs in PAIR_REFS.items():
        for ref in refs:
            out[f'{lid} − {ref}'] = {w: (dict(EV.public(EV.paired(EV.sub_vec(E['vec'][lid], E['pos'][w]), EV.sub_vec(E['vec'][ref], E['pos'][w]), E['IDX'][w])),
                                          **({'_label': HO.PANEL_START_NOTE} if w in PANEL_WINDOWS else {})))
                                     for w in E['sets']}
    return out


def selection_reference() -> dict:
    s = json.load(open(os.path.join(CV.OUT, 'tracks_t1_summary.json'), encoding='utf-8'))
    pairs = {f'{lid} − {refs[0]}': {w: s['pairs'][f'{lid} − {refs[0]}'][w] for w in ('SEL', 'HC')} for lid, refs in PAIR_REFS.items()}
    return dict(selection={t: s['selection'][t] for t in ('R', 'S')}, pairs_vs_proxy=pairs,
                lists={lid: {w: {k: s['lists'][lid][w][k] for k in ('picks', 'hits', 'precision_pct', 'delta_vs_rand_pp', 'delta_vs_rand_ci_pp', 'lift')}
                             for w in ('SEL', 'HC')} for lid in LOSER_LISTS},
                source='out/tracks_t1/tracks_t1_summary.json（已 commit 的 SEL＋HC 結果；落選原因＝SEL 配對 CI 下界 ≤ 0）')


def loser_records(E, ax) -> dict:
    df = E['df']
    wn = np.array(L.WINDOW_NAMES)
    win_name = lambda x: wn[x.window.values]
    fallback = AU.name_fallback()
    frames = {}
    for t, lids in TRACK_LISTS.items():
        ev = label_rows(AU.with_names(EV.event_records(df, t, list(lids), win_name), fallback))
        frames[f'{PRE}{t}_hits.csv'] = ev[ev.result == '命中']
        frames[f'{PRE}{t}_misses.csv'] = ev[ev.result == '漏網']
        pk = [pd.concat([EV.pick_records(df, t, [lid], win_name), AU.annotate_rows(EV.picks_of(df, lid), ax, lid)], axis=1) for lid in lids]
        frames[f'{PRE}{t}_picks.csv'] = label_rows(pd.concat(pk, ignore_index=True))
    return frames


def record_counts(frames) -> dict:
    out = {}
    for name, fr in frames.items():
        if fr.empty:
            out[name] = dict(rows=0)
            continue
        hm = fr.ho_model_window.str.startswith('HO-model')
        out[name] = {lid: dict(rows=int((fr.list_id == lid).sum()), rows_ho_model=int(((fr.list_id == lid) & hm).sum())) for lid in sorted(set(fr.list_id))}
    return out


def headline(metrics, pairs) -> dict:
    """報告用的精簡表（HO-model 為挑戰者評估窗；HO 全期只作描述）。"""
    out = {}
    for lid in LOSER_LISTS:
        mm, pr = metrics[lid]['HO-model'], pairs[f'{lid} − {PAIR_REFS[lid][0]}']['HO-model']
        out[lid] = dict(HO_model=dict(hits=mm['hits'], picks=mm['picks'], precision_pct=mm['precision_pct'], lift=mm['lift'],
                                      delta_vs_rand_pp=mm['delta_vs_rand_pp'], delta_vs_rand_ci_pp=mm['delta_vs_rand_ci_pp'],
                                      c5_dk0=mm['c5_dk0'], c10_dk0=mm['c10_dk0'], vs_proxy=dict(ref=PAIR_REFS[lid][0], dprec_pp=pr['dprec_pp'],
                                                                                                 dprec_ci_pp=pr['dprec_ci_pp'], p_dprec_gt0=pr['p_dprec_gt0'])),
                        HO_all_347_panel_start_limited=dict(hits=metrics[lid]['HO']['hits'], picks=metrics[lid]['HO']['picks'],
                                                            precision_pct=metrics[lid]['HO']['precision_pct'], lift=metrics[lid]['HO']['lift']))
    return out


def protocol(reg, inv) -> dict:
    jobs = ho_jobs(reg)
    folds = sorted({(f, ts, te) for (_, f, ts, te, _) in jobs})
    return dict(code_path='a36_tracks_fit.stage_run → run_new（與 HO 擬合選定挑戰者 R1 同一條路徑、同一份程式）',
                folds=[dict(fold=f, ts=ts, te=te) for f, ts, te in folds], seeds=list(FIT.SEEDS), purge=run_cv.PURGE, neg_frac=run_cv.NEG_FRAC,
                gbdt=run_cv.GB, min_train_s=FIT.MIN_TRAIN_S, models={m: dict(FIT.MODELS[m], n_features=len(FIT.model_feature_names(m)),
                                                                                    features=FIT.model_feature_names(m)) for m in LOSER_MODELS},
                n_checkpoints=len(inv), ho_model_rule='登錄 §8.1：只在 HO-model（第 4～6 折，2024Q2～Q4，186 日）有意義；第 1～3 折面板起點限制')


def write_outputs(frames) -> dict:
    os.makedirs(OUT_DIR, exist_ok=True)
    return {k: write_record(OUT_DIR, k, v) for k, v in frames.items()}


def stage_eval():
    t0 = now()
    require_cache(CACHE_T)
    lock, sel = lock_guard()
    attempt(f'post-lock:ho-losers:eval:start（{LABEL}；不寫 HO 鎖定產出）')
    man0 = tree_manifest(CACHE_T)
    reg = L.load_registration()
    inv = checkpoint_inventory(reg)
    inputs = fit_inputs_equal()
    spot = spot_refit(reg)
    log(f'前置核對通過：檢查點 {len(inv)} 份、擬合輸入 T＝T3、重擬逐位相同（{len(spot)} 項）')
    I, res = CV.load_all()
    summ = json.load(open(os.path.join(CV.OUT, 'tracks_t1_HO_summary.json'), encoding='utf-8'))
    models, lists = CV.ho_models_and_lists(sel)
    with loser_ckpts_from(os.path.join(CACHE_T3, 'tracks', 'cv')):
        E = CV.evaluate(I, res, I['reg'], 'HO', lists + list(LOSER_LISTS), models + list(LOSER_MODELS), selection=sel)
    cons = locked_consistency(E, lists, lock, summ, sel)
    log('鎖定部分逐位不變（16 份記錄、全部清單指標、配對、判定）')
    ax = AU.annotations(E['df'], I, res)
    dfx = E['df'][['s', 'buyable', 'dk', 'm_disp_t_exec', 'track_name', 'm_c5', 'm_c10']].join(ax)
    disc, sens, texec = AU.exit_tables(E, dfx, list(LOSER_LISTS))
    metrics = {lid: v for lid, v in locked_lists_view(E, LOSER_LISTS).items()}
    pairs = loser_pairs(E)
    frames = loser_records(E, ax)
    files = write_outputs(frames)
    man1 = tree_manifest(CACHE_T)
    pinned = dict(root=CACHE_T, n_files=len(man1), unchanged=man0 == man1, diff=manifest_diff(man0, man1))
    if not pinned['unchanged']:
        raise SystemExit(f'釘住快取 T 在執行期間有變動：{pinned["diff"]}')
    out = dict(label=LABEL, label_detail=LABEL_LONG, generated_by=f'scripts/surge-lab/{SELF} eval', time_start=t0, time_end=now(),
               head=CV.git('rev-parse', 'HEAD'), registration_sha256=L.REG_SHA256, code_sha256=code_sha(),
               user_decision='G1 第 5 項（2026-10-05）：補算落選挑戰者 R2、S1、S2 在 HOLDOUT 的鎖後描述記錄（DEV-006 的後續，DEV-009）',
               headline_HO_model=headline(metrics, pairs), selection_reference=selection_reference(), protocol=protocol(reg, inv),
               caches=dict(pinned_T=pinned, clone_T3=dict(root=CACHE_T3, method='cp -c -R .surge-cache-T .surge-cache-T3（APFS 複本）',
                                                         fit_inputs_sha256_equal_T=inputs, writes='只有本檔 fit 的 54 份檢查點')),
               checkpoints=inv, spot_refit=spot, locked_consistency=cons, selection_used=sel,
               lists=metrics, pairs=pairs, record_counts=record_counts(frames), exit_return_missing=disc, exit_price_sensitivity=sens,
               t_exec_sensitivity=texec, files=files, list_verdicts={lid: AU.LIST_VERDICT[lid] for lid in LOSER_LISTS},
               window_roles={'HO-model': '挑戰者評估窗（第 4～6 折，186 日）', 'HO-model-a／b': '挑戰者 T4 兩段（只作描述）',
                             'HO-model-ex2024Q4': '排除 2024Q4（曾調超參數）的敏感度，只作描述',
                             'HO／HO-2023／HO-ex2024Q4': f'含第 1～3 折：{HO.PANEL_START_NOTE}', 'HO-2024': '含 2024Q1（第 3 折），只作描述'},
               disclosures=[LABEL_LONG, '這是 HOLDOUT 的額外讀取（三個模型在 HO 六折重擬），不是修正重跑：沒有修正任何實作錯誤、沒有重產任何鎖定產出',
                            '落選原因不變：SELECTION 上對代理的配對 Δprecision@5 CI 下界 ≤ 0（selection_reference）',
                            '欄位 tradable_status 只代表處置狀態（DEV-008 第 3 點）；清單判定見 list_verdict'] + CV.DISCLOSURES,
               cost_reference=I['reg']['cost_reference'], note=L.NOTE)
    open(os.path.join(OUT_DIR, f'{PRE}summary.json'), 'wb').write(CV.dumps(out))
    attempt('post-lock:ho-losers:eval:done（鎖後描述）')
    log(f'落選挑戰者 HO 描述完成：{len(files)} 份記錄＋摘要；釘住快取不變；判定不變')


if __name__ == '__main__':
    st = sys.argv[1] if len(sys.argv) > 1 else ''
    {'fit': stage_fit, 'eval': stage_eval}.get(st, lambda: sys.exit(__doc__))()
