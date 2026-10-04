"""T1 分軌研究 Phase 1 CV（事前登錄 T1-TRACKS-PREREG-2026-10-04 v2；登錄封存不改，偏差寫 tracks/DEVIATIONS_t1_tracks.md）。

讀 tracks/registration_t1_tracks.json（雜湊不符拒跑）與各軌資料集（SURGE_CACHE/tracks/a36_tracks_*.npz），每軌跑登錄的代理與候選模型
（run_cv 協定：依季分折 expanding、purge 11、負例 10%、HistGBDT depth2×250，種子 0／1／2 平均；擬合在 a36_tracks_fit.py），依序：
  select      SELECTION（2025 四折）＋HALF-CONFIRM（2026 三折）：全部候選清單（含對照 M0*）、選模（W_R、W_S、Mp1 閘）、
              等名額對照、命中／漏網／選股記錄 → out/tracks_t1/tracks_t1_{軌}_{hits,misses,picks}.csv、tracks_t1_summary.json（要 commit）。
  ho-start    HOLDOUT 前置：SEL+HC 乾跑（同一條程式路徑重算，與已 commit 的摘要數值與記錄 sha256 逐位比對；另重擬每個模型一折一種子比對檢查點）
              → tracks_t1_HO_DRYRUN.json；通過才寫並 commit 哨兵 tracks_t1_HO_STARTED.json（之後才准讀 HO 標籤或報酬）。
  （之後跑 a36_tracks_fit.py run --windows HO：HO 各折只用折前資料訓練、purge 11）
  ho-eval     HOLDOUT（2023-08～2024-12，六折）只算一次：第一道檢查＝HO 分區標籤 assertion；代理與選定模型（新模型清單只在 HO-model 判定）；
              Holm（m＝3）與判定樹機械計算 → tracks_t1_HO_*；寫鎖檔 tracks_t1_HO_LOCK.json 並 commit。鎖檔存在時拒跑，
              唯一例外 ho-eval --verify-identical（只驗證逐位重現，不寫任何產出）。
用法：SURGE_CACHE=… SURGE_OFFICIAL_LIMIT=… SURGE_REVENUE=revenue_official.json SURGE_PIT_STRICT=1 python3 a36_tracks_cv.py select|ho-start|ho-eval
報酬一律未扣成本（成本另列參考，不當門檻）·事後欄位以 m_ 標示·非投資建議。
"""
import json
import os
import subprocess
import sys
import time
import traceback

import numpy as np
import pandas as pd

import a36_tracks_build as BLD
import a36_tracks_decide as DC
import a36_tracks_eval as EV
import a36_tracks_fit as FIT
import a36_tracks_lib as L

OUT = BLD.OUT_DIR
REL_OUT = 'scripts/surge-lab/out/tracks_t1'
CODE_FILES = ('a36_tracks_cv.py', 'a36_tracks_eval.py', 'a36_tracks_decide.py', 'a36_tracks_ho.py', 'a36_tracks_fit.py', 'a36_tracks_proxy.py',
              'a36_tracks_gate.py', 'a36_tracks_lib.py', 'a36_tracks_build.py', 'a36_tracks_stages.py')
SELHC_LISTS = [x[0] for x in EV.LISTS]
SELHC_MODELS = ('M0', 'M0s', 'Mp1', 'R1', 'R2', 'S1', 'S2')
HO_BASE_LISTS = ['M0@10', 'M0@20', 'M_atr14@5', 'M_combo@5', 'SFB_atr14@5', 'R0_combo@5', 'S0_atr14@5', 'W_atr14@3']
MODEL_OF = {'R1@5': 'R1', 'R2@5': 'R2', 'S1@5': 'S1', 'S2@5': 'S2'}
SEL_PAIRS = (('Mp1@10', 'M0@10'), ('M0s@10', 'M0@10'), ('Mp1_Monly@10', 'M0s@10'), ('Mp1_Monly@10', 'M0@10'),
             ('R1@5', 'R0_combo@5'), ('R2@5', 'R0_combo@5'), ('S1@5', 'S0_atr14@5'), ('S2@5', 'S0_atr14@5'))
DISCLOSURES = ['報酬一律未扣成本；成本參考表見 cost_reference，只作參考、不當門檻',
               'HALF-CONFIRM（2026）宣告已污染：只做方向閘，不作統計主張（CI 只作描述）',
               'TPEx 存活者偏誤未檢查（來源未提供）',
               '處置公告疑似缺漏月份（筆數 < 該市場逐月中位數 25%）：TWSE 2023-01、2023-08，TPEx 2023-01（揭露、不改值）',
               '全額交割、變更交易方法、停止信用交易：研究快取無 PIT 來源，狀態一律 unknown（來源未提供）',
               '容量以 s 日 vol20 估計，未模擬開盤競價量與滑價；S 清單一律標「容量受限」',
               'SELECTION 與 HALF-CONFIRM 各折的訓練資料包含 HOLDOUT 那段日曆，但只當訓練資料、從不當測試',
               '非投資建議']


def log(msg):
    BLD.log(msg)


def git(*a, check=True) -> str:
    return subprocess.run(['git', '-C', L.LAB, *a], capture_output=True, text=True, check=check).stdout.strip()


def code_sha() -> dict:
    return {f: L.file_sha256(os.path.join(L.LAB, f)) for f in CODE_FILES}


def dumps(obj) -> bytes:
    return json.dumps(obj, ensure_ascii=False, indent=1, default=BLD._np_default).encode('utf-8')


# ───────────────────────── 日集合 ─────────────────────────
def day_sets(res, group) -> dict:
    d = np.array(res['dates'])
    win, fold = res['cal']['window'], res['cal']['fold']
    if group == 'SELHC':
        return {'SEL': np.nonzero(win == 2)[0], 'HC': np.nonzero(win == 3)[0]}
    ho = win == 1
    model = ho & (fold >= 3)
    return {'HO': np.nonzero(ho)[0], 'HO-model': np.nonzero(model)[0],
            'HO-2023': np.nonzero(ho & (d <= '2023-12-31'))[0], 'HO-2024': np.nonzero(ho & (d >= '2024-01-01'))[0],
            'HO-model-a': np.nonzero(model & (d <= '2024-08-15'))[0], 'HO-model-b': np.nonzero(model & (d >= '2024-08-16'))[0],
            'HO-ex2024Q4': np.nonzero(ho & (fold <= 4))[0], 'HO-model-ex2024Q4': np.nonzero(model & (fold <= 4))[0]}


YEARS = {'SEL': {'2025': 'SEL'}, 'HC': {'2026': 'HC'}, 'HO': {'HO-2023': 'HO-2023', 'HO-2024': 'HO-2024'}, 'HO-model': {'HO-2024（模型窗）': 'HO-model'}}
MODEL_SETS = ('HO-model', 'HO-model-a', 'HO-model-b', 'HO-model-ex2024Q4', 'HO', 'HO-2023')


# ───────────────────────── 共用評估（SEL＋HC 與 HO 同一條路徑）─────────────────────────
def composite_vectors(df, lids, days, vec) -> tuple:
    pk = pd.concat([EV.picks_of(df, lid) for lid in lids])
    v = {k: sum(vec[lid][k] for lid in lids) for k in ('n_pool', 'ev_pool', 'picks', 'hits', 'E', 'bpicks', 'bhits')}
    b = pk[pk.buyable]
    for h in ('c5', 'c10'):
        v[h] = EV.daily_mean(b, f'm_{h}', days)
        v[f'{h}_dk0'] = EV.daily_mean(b[b.dk == 0], f'm_{h}', days)
        v[f'{h}_dk1'] = EV.daily_mean(b[b.dk == 1], f'm_{h}', days)
    v['pool_c5'] = np.full(len(days), np.nan)
    return v, pk


def dd1_vector(df, days) -> tuple:
    """DD1：M∪Mp∪R∪S 的可買列，逐日 DK_s=1 列 c5 平均 − DK_s=0 列 c5 平均（只用當日至少一列 DK_s=1 的日子）；DK_s 未知者排除並計數。"""
    x = df[df.track_name.isin(('M', 'Mp', 'R', 'S')) & df.buyable & np.isfinite(df.m_c5.values)]
    a = EV.daily_mean(x[x.dk == 1], 'm_c5', days)
    b = EV.daily_mean(x[x.dk == 0], 'm_c5', days)
    return a - b, int(x.dk.isna().sum()), int((x.dk == 1).sum())


def evaluate(I, res, reg, group, lists, models, selection=None) -> dict:
    wins = ('SEL', 'HC') if group == 'SELHC' else ('HO',)
    t0 = time.time()
    df = EV.build_frame(I, res, wins)
    ncodes = len(I['codes'])
    scores = {m: EV.model_scores(df, reg, m, wins, ncodes) for m in models}
    for lid in lists:
        sp = EV.LSPEC[lid]
        if sp['kind'] == 'model':
            pool = df.track_name.isin(sp['pool']).values
            assert np.isfinite(scores[sp['src']][pool]).all(), f'{lid}：池內有列沒有模型分數'
    EV.rank_lists(df, scores, lists)
    log(f'[{group}] 框架 {len(df):,} 列、清單排名完成（{time.time() - t0:.0f}s）')
    sets = day_sets(res, group)
    days_all = np.sort(np.concatenate([sets[w] for w in (('SEL', 'HC') if group == 'SELHC' else ('HO',))]))
    pos = {k: np.searchsorted(days_all, v) for k, v in sets.items()}
    IDX = {k: EV.boot_index(len(v)) for k, v in sets.items()}
    n_ev = {k: int(df[df.s.isin(v)].y.sum()) for k, v in sets.items()}
    vec = {lid: EV.day_vectors(df, EV.picks_of(df, lid), EV.LSPEC[lid]['pool'], days_all, EV.LSPEC[lid]['K']) for lid in lists}
    if group == 'SELHC':
        main_sets = ('SEL', 'HC')
    else:
        main_sets = tuple(sets)
    metrics = {}
    for lid in lists:
        pk = EV.picks_of(df, lid)
        metrics[lid] = {}
        for w in main_sets:
            pkw = pk[pk.s.isin(sets[w])]
            yv = {y: EV.sub_vec(vec[lid], pos[ys]) for y, ys in YEARS.get(w, {}).items()}
            metrics[lid][w] = EV.list_metrics(lid, EV.sub_vec(vec[lid], pos[w]), pkw, IDX[w], n_ev[w], yv)
    pairs = {}
    want_pairs = list(SEL_PAIRS) if group == 'SELHC' else ho_pairs(lists, selection)
    for a, b in want_pairs:
        if a in vec and b in vec:
            pairs[f'{a} − {b}'] = {w: EV.paired(EV.sub_vec(vec[a], pos[w]), EV.sub_vec(vec[b], pos[w]), IDX[w]) for w in main_sets}
    # 等名額對照：M0 前 10＋R 清單前 5＋S 清單前 5（20 檔）對 M0 前 20（描述）
    wr, ws = (selection or {}).get('W_R', 'R0_combo@5'), (selection or {}).get('W_S', 'S0_atr14@5')
    eq = {}
    for tag, (r_l, s_l) in {'final_lists': (wr, ws), 'proxy_lists': ('R0_combo@5', 'S0_atr14@5')}.items():
        if r_l in vec and s_l in vec:
            cv, cpk = composite_vectors(df, ['M0@10', r_l, s_l], days_all, vec)
            eq[tag] = dict(lists=['M0@10', r_l, s_l], vs='M0@20', by_window={})
            for w in main_sets:
                m = EV.list_metrics('M0@20', EV.sub_vec(cv, pos[w]), cpk[cpk.s.isin(sets[w])], IDX[w], n_ev[w], {})
                pr = EV.public(EV.paired(EV.sub_vec(cv, pos[w]), EV.sub_vec(vec['M0@20'], pos[w]), IDX[w]))
                eq[tag]['by_window'][w] = dict(composite=dict(m, K=20), M0_top20=metrics['M0@20'][w], composite_minus_M0top20=pr)
    dd1v, n_unknown, n_dk1 = dd1_vector(df, days_all)
    dd1 = {w: dict(EV.ret_block(dd1v[pos[w]], IDX[w]), n_rows_dk_unknown_excluded=n_unknown, n_rows_dk1=n_dk1) for w in main_sets}
    c2 = {}
    if 'Mp1@10' in vec:
        pk = EV.picks_of(df, 'Mp1@10')
        mp = EV.by_day(pk[pk.track_name == 'Mp'].groupby('s').size(), days_all)
        c2 = {w: DC.c2_check(vec['Mp1@10']['picks'][pos[w]], mp[pos[w]]) for w in main_sets}
    rec = records(df, group, lists)
    return dict(df=df, sets=sets, n_events=n_ev, metrics=metrics, pairs=pairs, vec=vec, pos=pos, IDX=IDX, equal_slot=eq, dd1=dd1, c2=c2,
                records=rec, runtime_s=round(time.time() - t0, 1))


def ho_pairs(lists, selection) -> list:
    out = [('Mp1@10', 'M0@10'), ('Mp1_Monly@10', 'M0s@10'), ('Mp1_Monly@10', 'M0@10'), ('M0s@10', 'M0@10')]
    for t in ('R', 'S'):
        w = selection[f'W_{t}']
        if w != DC.PROXY[t]:
            out.append((w, DC.PROXY[t]))
        out.append((w, 'M0@10'))
        if w != DC.PROXY[t]:
            out.append((DC.PROXY[t], 'M0@10'))
    return out


def records(df, group, lists) -> dict:
    wn = np.array(L.WINDOW_NAMES)
    win_name = lambda x: wn[x.window.values]
    pre = 'tracks_t1_' if group == 'SELHC' else 'tracks_t1_HO_'
    files = {}
    for t in EV.EVAL_TRACKS:
        ev = EV.event_records(df, t, [x for x in EV.TRACK_EVENT_LISTS[t] if x in lists], win_name)
        pk = EV.pick_records(df, t, [x for x in EV.TRACK_PICK_LISTS[t] if x in lists], win_name)
        files[f'{pre}{t}_hits.csv'] = EV.csv_bytes(ev[ev.result == '命中'] if len(ev) else ev)
        files[f'{pre}{t}_misses.csv'] = EV.csv_bytes(ev[ev.result == '漏網'] if len(ev) else ev)
        files[f'{pre}{t}_picks.csv'] = EV.csv_bytes(pk)
    if group != 'SELHC':
        ne = df[df.ne & (df.y == 1) & df.track_name.isin(('NE_SUSP', 'NE_TDR'))]
        out = pd.DataFrame({'window': win_name(ne), 'fold': ne.fold.values + 1, 'date_s': ne.date_s.values, 'event_day_t': ne.date_t.values,
                            'code': ne.code.values, 'name': ne.name.values, 'market': ne.market.values, 'track': ne.track_name.values,
                            'failing_filters': EV.failing(ne) if len(ne) else [], 'hist_len': ne.hist_len.values, 'listing_src': ne.listing.values,
                            'm_c5': EV.fmt_pct(ne.m_c5.values), 'note': L.NOTE})
        files['tracks_t1_HO_outside.csv'] = EV.csv_bytes(out)
    return files


def partition_counts(E) -> dict:
    df = E['df']
    out = {}
    for w, days in E['sets'].items():
        g = df[df.s.isin(days)]
        out[w] = dict(rows={t: int((g.track_name == t).sum()) for t in L.TRACKS}, events={t: int(g[g.track_name == t].y.sum()) for t in L.TRACKS},
                      all_events=int(g.y.sum()), days=int(len(days)))
    return out


def label_asserts(E, res, group) -> dict:
    """登錄 §2.1 標籤 assertion：NE_LU_S 事件＝0；各軌事件加總＝視窗內全部 T1 事件（以全面板 y 重算核對）。"""
    df, y = E['df'], res['fl']['y']
    out = {}
    for w, days in E['sets'].items():
        g = df[df.s.isin(days)]
        tot_panel = int(y[days].sum())
        out[w] = dict(NE_LU_S_events=int(g[g.track_name == 'NE_LU_S'].y.sum()), sum_tracks=int(g.y.sum()), all_T1_events_panel=tot_panel)
        out[w]['pass_'] = out[w]['NE_LU_S_events'] == 0 and out[w]['sum_tracks'] == tot_panel
    return out


def compact_pairs(pairs) -> dict:
    return {k: {w: EV.public(v) for w, v in d.items()} for k, d in pairs.items()}


# ───────────────────────── select（SELECTION＋HALF-CONFIRM）─────────────────────────
def load_all():
    I = BLD.load_inputs()
    FIT.check_feature_windows()
    res = BLD.compute(I, with_features=False)
    res['dates'] = I['dates']
    return I, res


def g0_status() -> dict:
    g0 = json.load(open(os.path.join(OUT, 'tracks_t1_G0.json'), encoding='utf-8'))['G0']
    gate = json.load(open(os.path.join(OUT, 'tracks_t1_G0_gate.json'), encoding='utf-8'))
    g0 = dict(g0, **{'G0.5': gate['G0_5']['pass'], 'G0.9': gate['G0_9']['pass']})
    ok = lambda v: v is True or (isinstance(v, dict) and (v.get('pass_') is True or v.get('outputs') is True))
    return dict(items=g0, G0_9_reproduced_by=gate['G0_9']['reproduced_by'], G0_5_detail={k: v for k, v in gate['G0_5'].items() if k != 'brk_future_only_rows_scored_selhc'},
                all_pass=all(ok(v) for v in g0.values()), failing=[k for k, v in g0.items() if not ok(v)])


def build_selhc(I, res) -> tuple:
    reg = I['reg']
    E = evaluate(I, res, reg, 'SELHC', SELHC_LISTS, SELHC_MODELS)
    P = E['pairs']
    sel = dict(Mp=DC.mp_gate(P['Mp1@10 − M0@10']['SEL'], P['Mp1@10 − M0@10']['HC']),
               R=DC.challenger_select('R', {c: P[f'{c} − R0_combo@5']['SEL'] for c in DC.CHALLENGERS['R']},
                                      {c: P[f'{c} − R0_combo@5']['HC'] for c in DC.CHALLENGERS['R']}),
               S=DC.challenger_select('S', {c: P[f'{c} − S0_atr14@5']['SEL'] for c in DC.CHALLENGERS['S']},
                                      {c: P[f'{c} − S0_atr14@5']['HC'] for c in DC.CHALLENGERS['S']}))
    sel['W_R'], sel['W_S'] = sel['R']['winner'], sel['S']['winner']
    sel['Mp1_carry_to_holdout'] = sel['Mp']['carry_to_holdout']
    E2 = E if sel['W_R'] == 'R0_combo@5' and sel['W_S'] == 'S0_atr14@5' else None
    if E2 is None:      # 等名額對照的「最終清單」版本要用選定清單：同一路徑重算（只換 selection）
        E = evaluate(I, res, reg, 'SELHC', SELHC_LISTS, SELHC_MODELS, selection=sel)
    summary = dict(
        registration=dict(id='T1-TRACKS-PREREG-2026-10-04', version=2, sha256=L.REG_SHA256),
        feature_windows_sha256=FIT.FW_SHA256, generated_by='scripts/surge-lab/a36_tracks_cv.py select', code_sha256=code_sha(),
        G0=g0_status(), partition=partition_counts(E), label_assertions=label_asserts(E, res, 'SELHC'),
        selection=sel, lists=E['metrics'], pairs=compact_pairs(E['pairs']), equal_slot_control_descriptive=E['equal_slot'],
        DD1_descriptive=E['dd1'], C2_descriptive=E['c2'],
        record_files={k: dict(sha256=EV.sha(v), bytes=len(v), rows=max(v.count(b'\n') - 1, 0)) for k, v in E['records'].items()},
        disclosures=DISCLOSURES, deviations=deviations(), cost_reference=reg['cost_reference'], note=L.NOTE,
        definitions=dict(lists={k: dict(v, pool=list(v['pool'])) for k, v in EV.LSPEC.items()},
                         windows={w: dict(days=int(len(v)), first=res['dates'][v[0]], last=res['dates'][v[-1]]) for w, v in E['sets'].items()}))
    return summary, E


def deviations() -> list:
    path = os.path.join(L.LAB, 'tracks', 'DEVIATIONS_t1_tracks.md')
    return [ln.strip('# ').strip() for ln in open(path, encoding='utf-8') if ln.startswith('## DEV-')]


def stage_select():
    I, res = load_all()
    summary, E = build_selhc(I, res)
    os.makedirs(OUT, exist_ok=True)
    for k, v in E['records'].items():
        open(os.path.join(OUT, k), 'wb').write(v)
    open(os.path.join(OUT, 'tracks_t1_summary.json'), 'wb').write(dumps(summary))
    s = summary['selection']
    log(f'select 完成：W_R={s["W_R"]}、W_S={s["W_S"]}、Mp1 帶進 HO={s["Mp1_carry_to_holdout"]}（{E["runtime_s"]}s）')


# ───────────────────────── HOLDOUT ─────────────────────────
def committed_bytes(rel) -> bytes:
    return subprocess.run(['git', '-C', L.LAB, 'show', f'HEAD:{rel}'], capture_output=True, check=True).stdout


def attempt(stage, err=None):
    rec = dict(time=time.strftime('%Y-%m-%dT%H:%M:%S%z'), head=git('rev-parse', 'HEAD'), code_sha256=code_sha(), stage=stage, error=err)
    with open(os.path.join(OUT, 'tracks_t1_HO_ATTEMPTS.jsonl'), 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def stage_ho_start():
    if os.path.exists(os.path.join(OUT, 'tracks_t1_HO_LOCK.json')):
        raise SystemExit('鎖檔已存在：拒跑')
    if os.path.exists(os.path.join(OUT, 'tracks_t1_HO_STARTED.json')):
        raise SystemExit('哨兵已存在：HO 已開跑，不重做乾跑（崩潰後續跑請直接 ho-eval）')
    if git('status', '--porcelain', '--', *CODE_FILES, 'tracks', f'out/tracks_t1/tracks_t1_summary.json'):
        raise SystemExit('a36 程式、登錄或 SEL 摘要有未 commit 的修改：拒跑（登錄 §8.2 第 1 點）')
    I, res = load_all()
    t0 = time.time()
    summary, E = build_selhc(I, res)
    old = json.loads(committed_bytes(f'{REL_OUT}/tracks_t1_summary.json'))
    new = json.loads(dumps(summary))
    old_code, new_code = old.pop('code_sha256'), new.pop('code_sha256')
    refit = refit_spot_check(I['reg'])
    rec_cmp = {k: dict(committed=old['record_files'][k]['sha256'], dryrun=v['sha256'], equal=old['record_files'][k]['sha256'] == v['sha256'])
               for k, v in new['record_files'].items()}
    dry = dict(summary_numbers_identical=old == new, records_identical=all(x['equal'] for x in rec_cmp.values()), records=rec_cmp,
               code_sha256_committed_summary=old_code, code_sha256_now=new_code, refit_spot_check=refit,
               runtime_s=round(time.time() - t0, 1), head=git('rev-parse', 'HEAD'))
    dry['pass_'] = dry['summary_numbers_identical'] and dry['records_identical'] and all(x['bit_equal'] for x in refit.values())
    open(os.path.join(OUT, 'tracks_t1_HO_DRYRUN.json'), 'wb').write(dumps(dry))
    if not dry['pass_']:
        raise SystemExit('乾跑與已 commit 的 SEL+HC 結果不同：停止，不得進入 HO（tracks_t1_HO_DRYRUN.json）')
    started = dict(time=time.strftime('%Y-%m-%dT%H:%M:%S%z'), head=git('rev-parse', 'HEAD'), registration_sha256=L.REG_SHA256,
                   code_sha256=code_sha(), dryrun_sha256=L.file_sha256(os.path.join(OUT, 'tracks_t1_HO_DRYRUN.json')),
                   selection=dict(W_R=summary['selection']['W_R'], W_S=summary['selection']['W_S'], Mp1_carry_to_holdout=summary['selection']['Mp1_carry_to_holdout']),
                   note='此檔 commit 之前沒有讀取任何 HOLDOUT 標籤或報酬（登錄 §8.2 第 3 點）')
    open(os.path.join(OUT, 'tracks_t1_HO_STARTED.json'), 'wb').write(dumps(started))
    git('add', '--', f'out/tracks_t1/tracks_t1_HO_DRYRUN.json', f'out/tracks_t1/tracks_t1_HO_STARTED.json')
    git('commit', '-m', 'research: T1 分軌 HOLDOUT 乾跑逐位相同＋哨兵（讀 HO 標籤前封存）\n\n'
        f'乾跑：SEL+HC 摘要數值與 {len(rec_cmp)} 份記錄 sha256 全同；每模型一折一種子重擬逐位相同。\n'
        f'選模：W_R={started["selection"]["W_R"]}、W_S={started["selection"]["W_S"]}、Mp1 帶進 HO={started["selection"]["Mp1_carry_to_holdout"]}。\n'
        '未扣成本·非投資建議。\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')
    log(f'哨兵已 commit：{git("rev-parse", "HEAD")}')


def refit_spot_check(reg) -> dict:
    """每個 SEL+HC 用過的模型重擬 SEL1 折種子 0，與檢查點逐位比對（確認擬合路徑也一致）。"""
    dates = list(np.load(os.path.join(FIT.TRACK_DIR, 'a36_tracks_M.npz'))['dates'])
    f, ts, te = FIT.folds(reg, dates, ['SEL'])[0]
    out = {}
    for m in SELHC_MODELS:
        c = np.load(FIT.ckpt_path(m, f, 0))
        r = FIT.run_m0(f, ts, te, 0) if m == 'M0' else FIT.run_new(m, ts, te, 0)
        out[m] = dict(fold=f, seed=0, bit_equal=bool(np.array_equal(np.asarray(r['score']), c['score'])))
    return out


def ho_models_and_lists(sel) -> tuple:
    models, lists = ['M0'], list(HO_BASE_LISTS)
    if sel['Mp1_carry_to_holdout']:
        models += ['Mp1', 'M0s']
        lists += ['Mp1@10', 'Mp1_Monly@10', 'M0s@10']
    for t in ('W_R', 'W_S'):
        if sel[t] in MODEL_OF:
            models.append(MODEL_OF[sel[t]])
            lists.append(sel[t])
    return models, lists


def stage_ho_eval():
    verify = '--verify-identical' in sys.argv
    lock = os.path.join(OUT, 'tracks_t1_HO_LOCK.json')
    if os.path.exists(lock) and not verify:
        raise SystemExit('鎖檔存在：拒跑（只允許 --verify-identical）')
    started = os.path.join(OUT, 'tracks_t1_HO_STARTED.json')
    if not os.path.exists(started) or not git('log', '-1', '--format=%H', '--', f'out/tracks_t1/tracks_t1_HO_STARTED.json'):
        raise SystemExit('哨兵未 commit：拒跑')
    if not verify:
        attempt('ho-eval:start')
    try:
        import a36_tracks_ho as HO
        out = HO.run(load_all, evaluate, json.load(open(started, encoding='utf-8'))['selection'], ho_models_and_lists)
    except Exception as e:  # noqa: BLE001 — 崩潰要記錄到 ATTEMPTS 後再拋出
        if not verify:
            attempt('ho-eval:crash', f'{type(e).__name__}: {e}\n{traceback.format_exc()[-2000:]}')
        raise
    files = out['files']
    if verify:
        lk = json.load(open(lock, encoding='utf-8'))
        cmp = {k: dict(lock=lk['outputs_sha256'].get(k), now=EV.sha(v)) for k, v in files.items()}
        ok = all(x['lock'] == x['now'] for x in cmp.values())
        print(json.dumps(dict(verify_identical=ok, files=cmp), ensure_ascii=False, indent=1))
        return
    for k, v in files.items():
        open(os.path.join(OUT, k), 'wb').write(v)
    attempt('ho-eval:outputs-written')
    lk = dict(time=time.strftime('%Y-%m-%dT%H:%M:%S%z'), head=git('rev-parse', 'HEAD'), registration_sha256=L.REG_SHA256, code_sha256=code_sha(),
              outputs_sha256={k: EV.sha(v) for k, v in files.items()}, decisions=out['decisions'])
    open(lock, 'wb').write(dumps(lk))
    log(f'HO 完成：{out["decisions"]}')


if __name__ == '__main__':
    stage = sys.argv[1] if len(sys.argv) > 1 else ''
    {'select': stage_select, 'ho-start': stage_ho_start, 'ho-eval': stage_ho_eval}.get(stage, lambda: sys.exit(__doc__))()
