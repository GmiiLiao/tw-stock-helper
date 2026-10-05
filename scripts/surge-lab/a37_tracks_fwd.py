"""T1 分軌前向影子（登錄 T1-TRACKS-FWD-2026-10-05）每日生產與評分：協調器 a35_shadow_daily.mjs 在 a35 名單＋發佈之後呼叫。

用法（環境：SURGE_CACHE＝前向快取 .surge-cache-F、SURGE_TRACKS_SHARED＝共用快取、OFFICIAL_ROOT＝鏡像、SURGE_TRACKS_OUT＝輸出目錄）：
  python3 a37_tracks_fwd.py daily --plan <計畫 JSON> [--rehearsal --now YYYY-MM-DDTHH:MM]
      同步 → 缺口記錄（計畫的 missed）→ core 凍結（計畫的 produce；條件 C1～C7＋接線前證明）→ 到期評分（y／c5／c10）
      → parity（y 到期時）→ 摘要；狀態寫 tracks_fwd_status.json。單一步驟失敗只記錄，不中止其他步驟。
  python3 a37_tracks_fwd.py prewire [--days 2026-09-17,…]    接線前證明（登錄 §17 第 2 步）：上市快照、漲跌停矩陣增量＝全量、
      處置／注意鏡像與 v2 釘住檔的重疊比對、≥5 個歷史交易日的研究路徑 parity → tracks_fwd_prewire.json（記 sha256）。
  python3 a37_tracks_fwd.py summary                          只重算摘要與 CSV（不凍結、不評分）。
總開關 tracks/forward_config.json（enabled＋startDay）：false 時 daily 只同步與記狀態，不凍結（磁碟即部署）。
--rehearsal：輸出目錄不可是正式 out/tracks_fwd；允許 --now 覆寫時鐘、不看總開關；所有文件標 rehearsal:true（不得發佈）。
結束碼：0 正常（含等待）；2 環境／設定拒跑；1 其他錯誤（已記入狀態檔）。
影子模式·未扣成本·事後欄位以 m_ 標示·非投資建議。
"""
import argparse
import glob
import gzip
import json
import os
import sys
import time
import traceback

import a37_tracks_fwd_io as IO

PROD_OUT = os.path.join(IO.LAB, 'out', 'tracks_fwd')
T2_TRACKS = os.path.join(IO.MAIN_REPO, 'scripts', 'surge-lab', '.surge-cache-T2', 'tracks')
FWDPREP_PICKS = os.path.join(IO.LAB, 'out', 'tracks_t1', 'fwdprep', 'tracks_t1_FWDPREP_SELHC_fwdlists_picks.csv.gz')
PREWIRE_DAYS = ('2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-03-16', '2025-06-16')
PREWIRE_PATH = 'tracks_fwd_prewire.json'
FDEV_REF = 'DEVIATIONS_t1_tracks_forward.md FDEV-001～FDEV-004'


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('stage', choices=('daily', 'prewire', 'summary'))
    ap.add_argument('--plan')
    ap.add_argument('--rehearsal', action='store_true')
    ap.add_argument('--now')
    ap.add_argument('--days')
    a = ap.parse_args(argv)
    if a.now and not a.rehearsal:
        ap.error('--now 只能搭配 --rehearsal（正式執行一律用現在時刻）')
    return a


# ───────────────────────── 條件與凍結 ─────────────────────────
def prewire_gate(out: str) -> dict:
    """第一份 core 凍結前必須有接線前證明：上市快照、漲跌停增量＝全量、研究路徑 parity ≥5 日都通過；處置／注意重疊比對允許「待鏡像回補」（FDEV）。"""
    pw = IO.read_json(os.path.join(out, PREWIRE_PATH))
    if not pw or not IO.verify_seal(pw):
        return dict(ok=False, why='沒有接線前證明（python3 a37_tracks_fwd.py prewire）或封印不符')
    need = {k: pw.get('checks', {}).get(k, {}).get('status') for k in ('listing', 'limits_incremental', 'research_path')}
    bad = [k for k, v in need.items() if v != 'pass']
    da = pw.get('checks', {}).get('disp_att_overlap', {}).get('status')
    if da not in ('pass', 'pending'):
        bad.append(f'disp_att_overlap={da}')
    return dict(ok=not bad, why='、'.join(bad) if bad else None, seal=pw.get('seal'), statuses=dict(need, disp_att_overlap=da))


def conditions(I, ctx, day, target) -> dict:
    import a37_tracks_score as SC
    p, cal = I['p'], ctx['cal']
    dates = I['dates']
    out = {}
    s = dates.index(day) if day in dates else None
    b = ctx['basis'].get(day)
    c1 = s is not None and SC.basis_ok(b)
    out['C1'] = dict(ok=bool(c1), basis=b and {k: b.get(k) for k in ('ready', 'missing', 'basis', 'nonOfficialOtcClose', 'gapFixSource')},
                     in_panel=s is not None)
    prev = dates[s - 1] if s else None
    c2 = s is not None and SC.official_ok(p['cache'], 'twse_limit', day) and prev is not None and SC.official_ok(p['cache'], 'tpex_daily', prev)
    out['C2'] = dict(ok=bool(c2), twse_twt84u=day, tpex_dailyquotes=prev)
    to = (IO.read_json(os.path.join(IO.LAB, '..', '..', 'scripts', 'data', 'exright-history.json')) or {}).get('to') or day
    ex = {d: SC.exright_ok(p['cache'], d) for d in cal.between(to, day)}
    out['C3'] = dict(ok=all(v[0] for v in ex.values()), days={d: v[1] for d, v in ex.items()}, history_to=to)
    out['C4'] = dict(ok=True, note='處置／注意依 coverage_rule＋FDEV-002 建好；缺漏只會記 NaN，不擋凍結')
    out['C5'] = dict(ok=ctx['listing'] is not None)
    out['C7'] = dict(ok=bool(I['pins']['ok']), mismatches=I['pins']['mismatches'])
    out['target'] = dict(ok=cal.next_trading(day) == target, computed=cal.next_trading(day), given=target)
    out['prewire'] = ctx['prewire']
    return out


def write_gap(p, ctx, day, target, reason, extra=None) -> str:
    import a37_tracks_score as SC
    out = p['out']
    if os.path.exists(SC.core_path(out, day)) or os.path.exists(SC.gap_path(out, day)):
        return 'exists'
    wait = IO.read_json(SC.wait_path(out, day)) or {}
    dl = IO.deadline_of(target)
    blocks = [b for b in ctx['plan'].get('preflightBlocks', []) if f'{day}T13:30' < b < dl.strftime('%Y-%m-%dT%H:%M')]
    doc = dict(schema=IO.SCHEMA_GAP, kind='t1-tracks-gap', which='core', date_s=day, t=target, deadline=IO.iso_tw(dl), reason=reason,
               unmet_conditions=wait.get('unmet'), last_wait_time=wait.get('time'), blocked_slots=blocks,
               recorded=IO.iso_tw(ctx['now']), rehearsal=ctx['rehearsal'], registration_id='T1-TRACKS-FWD-2026-10-05',
               rule='期限前沒有凍結 ⇒ 缺口，永不補產（登錄 freeze.timing）', note=IO.NOTE, **(extra or {}))
    return IO.write_once(SC.gap_path(out, day), IO.sealed(doc))


def freeze_core(I, ctx, day, target) -> dict:
    import a37_tracks_core as C
    import a37_tracks_score as SC
    p, out = I['p'], I['p']['out']
    if os.path.exists(SC.core_path(out, day)):
        return dict(day=day, result='exists')
    if os.path.exists(SC.gap_path(out, day)):
        return dict(day=day, result='gap-exists')
    dl = IO.deadline_of(target)
    if ctx['now'] >= dl:
        return dict(day=day, result='gap', write=write_gap(p, ctx, day, target, '已過目標日 09:00（凍結前時鐘閘）'))
    ctx['listing'] = None
    try:
        ctx['listing'] = C.listing_asof(p['official_root'], day)
    except (IO.Refuse, OSError, ValueError) as e:
        ctx['listing_error'] = str(e)
    cond = conditions(I, ctx, day, target)
    unmet = {k: v for k, v in cond.items() if not v.get('ok')}
    if unmet:
        IO.write_json_atomic(SC.wait_path(out, day), dict(day=day, target=target, time=IO.iso_tw(ctx['now']), unmet=unmet))
        return dict(day=day, result='wait', unmet=sorted(unmet))
    s = I['dates'].index(day)
    prev = I['dates'][s - 1]
    extra = dict(
        deadline=IO.iso_tw(dl), rehearsal=ctx['rehearsal'], frozen_time=None,
        m0ref=dict(status='not-wired', gap=True, reason='M0@10／M0@20 參照（m0ref）尚未接線：第二期重現凍結模型指紋（80ec0f8e…）後才凍結；core 照常（登錄 missing_data：m0ref 不齊只記 m0ref 缺口，FDEV-004）'),
        targetDayBasis=dict(sources=ctx['cal'].sources, computed=cond['target']['computed']),
        conditions={k: dict(ok=v['ok']) for k, v in cond.items()}, prewire=dict(seal=ctx['prewire'].get('seal'), statuses=ctx['prewire'].get('statuses'),
                                                                             deviations=FDEV_REF),
        dataBasis=dict(close=cond['C1']['basis'], exright=cond['C3'],
                       official_limit_files={f'twse_twt84u/{day}': IO.file_sha256(os.path.join(p['cache'], 'official', 'twse_limit', f'{day}.json.gz')),
                                             f'tpex_dailyquotes/{prev}': IO.file_sha256(os.path.join(p['cache'], 'official', 'tpex_daily', f'{prev}.json.gz'))},
                       sync_manifest_sha256=ctx.get('sync_sha256')))
    try:
        doc = C.build_core(I, s, target, ctx['listing'], extra)
    except AssertionError as e:                          # C6：分區 assertion 失敗 ⇒ 不產生名單
        IO.write_json_atomic(SC.wait_path(out, day), dict(day=day, target=target, time=IO.iso_tw(ctx['now']), unmet={'C6': dict(ok=False, error=str(e)[:500])}))
        return dict(day=day, result='wait', unmet=['C6'])
    now2 = IO.now_tw(ctx['now_override'])
    if now2 >= dl:
        return dict(day=day, result='gap', write=write_gap(p, ctx, day, target, '計算完成時已過目標日 09:00（凍結後時鐘閘）'))
    doc['frozen_time'] = IO.iso_tw(now2)
    w = IO.write_once(SC.core_path(out, day), IO.sealed(doc))
    return dict(day=day, result=w, seal=IO.seal_of(doc))


# ───────────────────────── 評分、parity ─────────────────────────
def score_all(I, ctx) -> list:
    import a37_tracks_core as C
    import a37_tracks_score as SC
    out, cal = I['p']['out'], ctx['cal']
    today = ctx['now'].strftime('%Y-%m-%d')
    done = []
    for day in SC.frozen_days(out):
        if os.path.exists(SC.score_path(out, day, 'c10')):          # 三期都評完：不必再讀凍結檔
            continue
        fz = IO.read_json(SC.core_path(out, day))
        if not fz or not IO.verify_seal(fz) or bool(fz.get('rehearsal')) != ctx['rehearsal']:
            done.append(dict(day=day, stage='*', result='skip', why='封印不符或演練／正式不一致'))
            continue
        ydoc = IO.read_json(SC.score_path(out, day, 'y'))
        for stage in ('y', 'c5', 'c10'):
            path = SC.score_path(out, day, stage)
            if os.path.exists(path):
                continue
            if stage != 'y' and (not ydoc or ydoc.get('status') != 'ok'):
                break
            try:
                mat = SC.maturity(I, cal, fz, stage, ctx['basis'], today)
            except IO.Refuse as e:
                done.append(dict(day=day, stage=stage, result='wait', why=[str(e)]))
                break
            if mat['state'] == 'wait':
                done.append(dict(day=day, stage=stage, result='wait', why=mat['why'][:5]))
                break
            base = dict(schema=IO.SCHEMA_SCORE, kind='t1-tracks-score', stage=stage, date_s=day, t=mat['t'], due=mat['due'], frozen_seal=fz['seal'],
                        computed=IO.iso_tw(ctx['now']), rehearsal=ctx['rehearsal'], note=IO.NOTE)
            if mat['state'] == 'unavailable':
                doc = dict(base, status='label_unavailable' if stage == 'y' else 'unavailable', why=mat['why'][:20])
            elif stage == 'y':
                Y = SC.outcome_y(I, fz, mat, C.listing_asof(I['p']['official_root'], day)['snaps'])
                doc = dict(base, status='ok', **SC.score_y_doc(I, fz, mat, Y))
                ydoc = doc
            else:
                R = SC.outcome_ret(I, fz, mat, SC.HORIZONS[stage])
                doc = dict(base, status='ok', **SC.score_ret_doc(I, fz, ydoc, R, SC.HORIZONS[stage], stage))
            done.append(dict(day=day, stage=stage, result=IO.write_once(path, IO.sealed(doc)), status=doc['status']))
            if doc['status'] != 'ok':
                break
    return done


def parity_all(I, ctx) -> list:
    import a37_tracks_core as C
    import a37_tracks_score as SC
    out = I['p']['out']
    res = []
    for day in SC.frozen_days(out):
        if os.path.exists(SC.parity_path(out, day)) or not os.path.exists(SC.score_path(out, day, 'y')):
            continue
        fz = IO.read_json(SC.core_path(out, day))
        if not fz or bool(fz.get('rehearsal')) != ctx['rehearsal'] or day not in I['dates']:
            continue
        s = I['dates'].index(day)
        lst = C.listing_asof(I['p']['official_root'], day)
        try:
            now_doc = C.build_core(I, s, fz['t'], lst, {})
            cmp = C.compare_core(fz, now_doc)
        except AssertionError as e:
            cmp = dict(equal=False, diffs=[dict(kind='assertion', error=str(e)[:300])], n_diffs=1, score_max_rel_diff=None)
        dig_then = fz['dataBasis']['inputs_digest']
        dig_now = C.input_digests(I, s, lst['sha256'], fz['dataBasis']['panel_codes'])
        changed = sorted(k for k in dig_then if dig_then.get(k) != dig_now.get(k))
        verdict = 'pass' if cmp['equal'] else ('data_correction' if changed else 'fail')
        doc = dict(schema=IO.SCHEMA_PARITY, kind='t1-tracks-parity', date_s=day, frozen_seal=fz['seal'], computed=IO.iso_tw(ctx['now']),
                   verdict=verdict, inputs_changed=changed, rehearsal=ctx['rehearsal'], **cmp,
                   rule='研究路徑（compute_all＋listing_info_v3＋a36_tracks_proxy）在截到 ≤ s 的面板重算；摘要不同＝資料修正（附證據），相同卻不同＝parity 失敗')
        res.append(dict(day=day, verdict=verdict, result=IO.write_once(SC.parity_path(out, day), IO.sealed(doc))))
    return res


# ───────────────────────── 摘要與 CSV ─────────────────────────
def summary(out: str, rehearsal: bool) -> dict:
    import numpy as np
    import pandas as pd
    import a36_tracks_fwd_rules as FR
    import a37_tracks_score as SC
    days = []
    for day in SC.frozen_days(out):
        fz = IO.read_json(SC.core_path(out, day))
        if not fz or bool(fz.get('rehearsal')) != rehearsal:
            continue
        sc = {st: IO.read_json(SC.score_path(out, day, st)) for st in ('y', 'c5', 'c10')}
        days.append((day, fz, sc, IO.read_json(SC.parity_path(out, day))))
    gaps = sorted(os.path.basename(f)[15:25] for f in glob.glob(os.path.join(out, 'tracks_fwd_gap_*.json')))
    scored = [(d, fz, sc) for d, fz, sc, _ in days if sc['y'] and sc['y'].get('status') == 'ok']
    stats = {}
    n_win = SC.G250_N if len(scored) >= SC.G250_N else SC.G60_N if len(scored) >= SC.G60_N else len(scored)   # 判定窗＝前 60／250 個評分日
    for lid in ('S0_atr14@5', 'SFB_atr14@5', 'R0_combo@5', 'W_atr14@3'):
        v = [(sc['y']['lists'][lid]['hits'], sc['y']['lists'][lid]['picks'], sc['y']['lists'][lid]['E_rand']) for _, _, sc in scored][:n_win]
        stats[lid] = SC.boot_stats([x[0] for x in v], [x[1] for x in v], [x[2] for x in v]) | dict(window_days=len(v))
    rows, ev = [], []
    for d, fz, sc in scored:
        for lid, fl in fz['lists'].items():
            y = sc['y']['lists'][lid]
            r5 = {p['rank']: p for p in ((sc.get('c5') or {}).get('lists', {}).get(lid, {}).get('picks_outcome', []))}
            r10 = {p['rank']: p for p in ((sc.get('c10') or {}).get('lists', {}).get(lid, {}).get('picks_outcome', []))}
            for pk, po in zip(fl['picks'], y['picks_outcome']):
                c5, c10 = r5.get(pk['rank'], {}), r10.get(pk['rank'], {})
                rows.append(dict(date_s=d, t=sc['y']['t'], list_id=lid, section=fl['section'], grey_watch_only=fl['grey_watch_only'], rank=pk['rank'],
                                 code=pk['code'], name=pk['name'], name_src=pk['name_src'], market=pk['market'], track=pk['track'], score=pk['score'],
                                 n_pool=fl['n_pool'], y=po['y'], DK_s=pk['DK_s'] if pk['DK_s'] is not None else np.nan, disposal_status=pk['disposal_status'],
                                 list_verdict=fl['list_verdict'], m_disp_t_exec=po['m_disp_t_exec'], m_has_open_t=po['m_has_open_t'],
                                 m_locked_open=po['m_locked_open'], m_buyable=po['m_buyable'], m_c1=po['m_c1'], m_c5=c5.get('m_c5'),
                                 m_c10=c10.get('m_c10'), exit_c5_cat=c5.get('exit_c5_cat', 'PENDING' if po['m_buyable'] else 'NA'),
                                 exit_c10_cat=c10.get('exit_c10_cat', 'PENDING' if po['m_buyable'] else 'NA'), Qmax_lots=pk['qmax_lots'],
                                 vol20_s=pk['vol20'], note=IO.NOTE))
        for e in sc['y']['events']:
            row = {k: (';'.join(v) if isinstance(v, list) else v) for k, v in e.items()}
            row.update(date_s=d, result=('命中' if e.get('picked') else '漏網') if e.get('list_id') and e.get('rank') is not None else '池外／不排名',
                       detail=e.get('note'), note=IO.NOTE)
            ev.append(row)
    files = {}
    if rows:
        pk = pd.DataFrame(rows)
        for lid, g in pk.groupby('list_id'):
            files[f'{lid}_picks'] = _csv(out, f'tracks_fwd_{lid.split("_")[0]}_picks.csv', g)
        disc = FR.daily_disclosure(pk.assign(DK_s=pk.DK_s.astype(float), m_disp_t_exec=pk.m_disp_t_exec.fillna(0)))
        files['daily_disclosure'] = _csv(out, 'tracks_fwd_daily_disclosure.csv', disc)
    if ev:
        e = pd.DataFrame(ev)
        for lid in ('S0_atr14@5', 'SFB_atr14@5', 'R0_combo@5', 'W_atr14@3'):
            g = e[e.list_id == lid]
            files[f'{lid}_hits'] = _csv(out, f'tracks_fwd_{lid.split("_")[0]}_hits.csv', g[g.result == '命中'])
            files[f'{lid}_misses'] = _csv(out, f'tracks_fwd_{lid.split("_")[0]}_misses.csv', g[g.result == '漏網'])
        files['outside'] = _csv(out, 'tracks_fwd_outside.csv', e[e.result == '池外／不排名'])
    n = len(scored)
    seals_ok = all(IO.verify_seal(fz) for _, fz, _, _ in days) and all(IO.verify_seal(x) for _, _, sc, _ in days for x in sc.values() if x)
    par = [p for *_, p in days if p]
    first = days[0][0] if days else None
    proc = dict(
        P2_seals=seals_ok, P3_parity=dict(n=len(par), fail=[p['date_s'] for p in par if p['verdict'] == 'fail'],
                                          data_correction=[p['date_s'] for p in par if p['verdict'] == 'data_correction']),
        P4_assertions=all(all(fz['partition_checks'].values()) for _, fz, _, _ in days),
        P7_pins=all(fz['implementation_pins']['ok'] for _, fz, _, _ in days),
        P5_no_zero_fill='DK_s 未知一律 null；報酬未到期／出場日無收盤一律 null（結構保證）', P8_ui='發佈端測試保證灰底清單無報酬欄位（surge-tracks-report.test.mjs）')
    doc = dict(schema='t1-tracks-forward-summary/v1', generated=IO.iso_tw(IO.now_tw()), rehearsal=rehearsal, s0=first, n_core=len(days),
               n_m0ref_gaps=sum(1 for _, fz, _, _ in days if (fz.get('m0ref') or {}).get('gap')),
               n_gaps=len(gaps), gaps=gaps, n_scored=n, g60_reached=n >= SC.G60_N, g250_reached=n >= SC.G250_N, stats=stats,
               gate=SC.gate_verdicts(stats, n), process=proc, files=files, note=IO.NOTE)
    IO.write_json_atomic(os.path.join(out, 'tracks_fwd_summary.json'), doc)
    return doc


def _csv(out, name, frame):
    path = os.path.join(out, name)
    frame.to_csv(path, index=False)
    return dict(file=name, rows=int(len(frame)), sha256=IO.file_sha256(path))


# ───────────────────────── 接線前證明 ─────────────────────────
def prewire(p, days) -> dict:
    import numpy as np
    import pandas as pd
    import a36_tracks_lib as L
    import a37_tracks_core as C
    import a37_tracks_sync as SY
    import official_features as OF
    t0 = time.time()
    man = SY.sync(p, IO.now_tw().strftime('%Y-%m-%d'))
    I = C.load_inputs(p)
    checks = {}
    pinned = L.load_listing_snapshots()
    la = C.listing_asof(p['official_root'], SY.BASE_TO)
    checks['listing'] = dict(status='pass' if la['snaps'] == pinned else 'fail', n=len(pinned), files=la['files'])
    Ui, Di, _ = SY.align_limits(OF, p['cache'], I['dates'], I['codes'])
    Uf, Df = SY.full_limits(OF, p['cache'], I['dates'], I['codes'])
    checks['limits_incremental'] = dict(status='pass' if SY.arrays_equal(Ui, Uf) and SY.arrays_equal(Di, Df) else 'fail',
                                        shape=list(Ui.shape), finite_cells=int(np.isfinite(Uf).sum()))
    checks['disp_att_overlap'] = disp_att_overlap(p)
    checks['research_path'] = research_path_parity(I, days)
    checks['m0_fingerprint'] = dict(status='pending', why='m0ref（M0@10／M0@20 參照）未接線：第二期以 fit-verify 重現指紋 80ec0f8e… 後才可凍結')
    doc = dict(schema=IO.SCHEMA_PREWIRE, kind='t1-tracks-prewire', registration_id='T1-TRACKS-FWD-2026-10-05', computed=IO.iso_tw(IO.now_tw()),
               cache=p['cache'], shared=p['shared'], official_root=p['official_root'], sync=dict(official={k: v['last'] for k, v in man['official'].items()}),
               checks=checks, runtime_s=round(time.time() - t0, 1), deviations=FDEV_REF, note=IO.NOTE)
    doc = IO.sealed(doc)
    stamp = IO.now_tw().strftime('%Y%m%dT%H%M%S')
    IO.write_once(os.path.join(p['out'], 'prewire', f'tracks_fwd_prewire_{stamp}.json'), doc)
    IO.write_json_atomic(os.path.join(p['out'], PREWIRE_PATH), doc)
    return doc


def disp_att_overlap(p) -> dict:
    """鏡像帶日期的處置／注意列（鍵 ≤ 2026-10-02）與 v2 釘住檔同一天的列逐筆比對；鏡像還沒回補到重疊期間就是 pending。"""
    import a37_tracks_sync as SY
    res, any_days, bad = {}, 0, 0
    for (kind, mkt), (host, mds, fname, code_col) in SY.DISP_ATT.items():
        base = json.load(open(os.path.join(p['cache'], 'base', fname), encoding='utf-8'))
        dcol = {('disposal', 'TWSE'): '公布日期', ('disposal', 'TPEx'): '公布日期', ('attention', 'TWSE'): '日期', ('attention', 'TPEx'): '公告日期'}[(kind, mkt)]
        ix = base['fields'].index(dcol)
        iso = lambda s: _roc_iso(s)
        byday = {}
        for r in base['data']:
            byday.setdefault(iso(r[ix]), set()).add(json.dumps(r, ensure_ascii=False))
        cmp_days, mism = [], []
        for key, row in sorted(SY.mirror_manifest(p['official_root'], host, mds).items()):
            if key > SY.BASE_TO or not SY.accept_row(key, row, SY.BASE_TO, statuses=('ok', 'empty')):
                continue
            payload, _ = SY.mirror_payload(p['official_root'], host, mds, key, row) if row['status'] == 'ok' else ({}, None)
            f2, data = SY._fields_rows(payload, mkt) if row['status'] == 'ok' else (base['fields'], [])
            got = {json.dumps(r, ensure_ascii=False) for r in (data or []) if code_col is None or r[code_col]}
            want = {x for x in byday.get(key, set())}
            cmp_days.append(key)
            if list(f2 or []) != list(base['fields']) or got != want:
                mism.append(dict(day=key, only_mirror=len(got - want), only_pinned=len(want - got), fields_equal=list(f2 or []) == list(base['fields'])))
        res[f'{kind}_{mkt}'] = dict(mirror=f'{host}/{mds}', days_compared=len(cmp_days), mismatched=mism[:30], n_mismatched=len(mism))
        any_days += len(cmp_days)
        bad += len(mism)
    status = 'pending' if any_days == 0 else ('pass' if bad == 0 else 'fail')
    return dict(status=status, datasets=res,
                why='鏡像帶日期的處置／注意資料集尚未回補到 2026-10-02 以前，沒有重疊可比（FDEV-001）' if status == 'pending' else None)


def _roc_iso(s):
    import re
    m = re.search(r'(\d{2,3})[./](\d{1,2})[./](\d{1,2})', str(s or ''))
    return f'{int(m.group(1)) + 1911:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}' if m else None


def research_path_parity(I, days) -> dict:
    """前向路徑（截斷面板＋前向快取）vs 研究路徑（T2：G1 第 4 項修正後的軌道檔與前向四份代理清單選股）逐日比對。"""
    import numpy as np
    import pandas as pd
    import a36_tracks_lib as L
    import a37_tracks_core as C
    if not os.path.isdir(T2_TRACKS) or not os.path.exists(FWDPREP_PICKS):
        return dict(status='fail', why=f'研究路徑參考檔不在（{T2_TRACKS}、{FWDPREP_PICKS}）')
    ref = {t: np.load(os.path.join(T2_TRACKS, f'a36_tracks_{t}.npz')) for t in ('M', 'Mp', 'R', 'S', 'W', 'NE')}
    rdates = list(ref['M']['dates'])
    rcodes = list(ref['M']['codes'])
    picks = pd.read_csv(FWDPREP_PICKS, dtype={'code': str})
    out, ok_days = {}, 0
    for day in days:
        if day not in I['dates'] or day not in rdates:
            out[day] = dict(ok=False, why='面板或研究參考沒有這一天')
            continue
        s, rs = I['dates'].index(day), rdates.index(day)
        lst = C.listing_asof(I['p']['official_root'], day)
        doc = C.build_core(I, s, '0000-00-00', lst, {})
        mine = dict(zip(doc['domain']['codes'], doc['domain']['track']))
        theirs = {}
        for t, z in ref.items():
            m = z['m_s'] == rs
            for j, tr in zip(z['m_j'][m], z['m_track'][m]):
                theirs[rcodes[int(j)]] = int(tr)
        susp = {c for c, tr in theirs.items() if tr == L.TID['NE_SUSP']}
        cmp_codes = (set(mine) | set(theirs)) - susp
        tdiff = sorted(c for c in cmp_codes if mine.get(c) != theirs.get(c))
        ldiff = {}
        for lid, fl in doc['lists'].items():
            g = picks[(picks.date_s == day) & (picks.list_id == lid)].sort_values('rank')
            want = list(zip(g['rank'].astype(int), g['code'].astype(str)))
            got = [(x['rank'], x['code']) for x in fl['picks']]
            sc = [abs((x['score'] or 0) - float(v)) / max(abs(float(v)), 1e-300) for x, v in zip(fl['picks'], g['score'])]
            pool_n = sum(1 for c, tr in theirs.items() if tr in [L.TID[k] for k in fl['pool']])
            if want != got or pool_n != fl['n_pool']:
                ldiff[lid] = dict(want=want, got=got, pool_research=pool_n, pool_forward=fl['n_pool'])
            else:
                ldiff[lid] = dict(equal=True, score_max_rel_diff=max(sc) if sc else 0.0)
        ok = not tdiff and all(v.get('equal') for v in ldiff.values())
        ok_days += ok
        out[day] = dict(ok=ok, track_diffs=tdiff[:30], n_track_diffs=len(tdiff), research_ne_susp=len(susp),
                        forward_ne_susp_fwd=doc['ne_susp_fwd']['n'], lists=ldiff, track_counts=doc['track_counts'])
    return dict(status='pass' if ok_days >= 5 and ok_days == len(days) else 'fail', days=out, n_days_equal=ok_days,
                reference=dict(tracks=T2_TRACKS, picks=os.path.relpath(FWDPREP_PICKS, IO.LAB), picks_sha256=IO.file_sha256(FWDPREP_PICKS)),
                rule='軌道歸屬（s 日有收盤的列）、各池列數、四份代理清單的成員與名次逐位相同；分數另報最大相對差（還原基準不同只有浮點捨入差）')


# ───────────────────────── daily ─────────────────────────
def run_daily(a, p, st) -> int:
    import a37_tracks_core as C
    import a37_tracks_score as SC
    import a37_tracks_sync as SY
    cfg = IO.load_config()
    st['config'] = cfg
    plan = IO.read_json(a.plan) if a.plan else None
    if not plan:
        raise IO.Refuse(f'讀不到計畫檔 {a.plan}')
    st['plan'] = {k: plan.get(k) for k in ('produce', 'missed', 'waiting', 'startDay')}
    if not cfg['enabled'] and not a.rehearsal:
        st['skipped'] = f'forward_config.enabled＝false（{cfg.get("error") or "總開關未開"}）：不同步、不凍結'
        return 0
    cal = IO.Calendar.from_plan(plan)
    ctx = dict(plan=plan, cal=cal, now=IO.now_tw(a.now), now_override=a.now, rehearsal=bool(a.rehearsal), prewire=prewire_gate(p['out']))
    today = ctx['now'].strftime('%Y-%m-%d')
    man = SY.sync(p, today)
    ctx['sync_sha256'] = IO.file_sha256(os.path.join(p['cache'], 'a37_sync_manifest.json'))
    st['sync'] = {k: dict(last=v['last'], added=v['added'][-5:]) for k, v in man['official'].items() if k in ('twse_limit', 'tpex_daily')}
    st['sync']['disp_att'] = {k: dict(days=v['days'], last=v['last'], problems=len(v['problems'])) for k, v in man['disp_att'].items()}
    I = C.load_inputs(p)
    st['pins_ok'] = I['pins']['ok']
    st['panel_last'] = I['dates'][-1]                     # 協調器據此判斷下一輪要不要刷新面板（tracksNeedData）
    produce = [x for x in plan.get('produce') or [] if a.rehearsal or x['date'] >= cfg['startDay']]
    frozen = SC.frozen_days(p['out'])
    need = set()
    for x in produce:
        need.add(x['date'])
    for d in frozen:
        try:
            t = cal.next_trading(d)
            need.update([t] + cal.between(t, cal.nth_after(t, 9)))
        except IO.Refuse:
            pass
    ctx['basis'] = SC.basis_for([d for d in need if d <= today], p['shared'], plan.get('basisInjected'))
    for m in plan.get('missed') or []:
        if a.rehearsal or m['date'] >= cfg['startDay']:
            st['gaps'].append(dict(day=m['date'], result=write_gap(p, ctx, m['date'], m['nextTD'], m.get('reason') or '期限前未凍結')))
    for x in produce:
        try:
            st['frozen'].append(freeze_core(I, ctx, x['date'], x['nextTD']))
        except Exception as e:                          # 單日失敗不中止
            st['errors'].append(dict(step=f'freeze {x["date"]}', error=f'{type(e).__name__}: {e}'[:600], trace=traceback.format_exc()[-1500:]))
    for name, fn in (('score', score_all), ('parity', parity_all)):
        try:
            st[name] = fn(I, ctx)
        except Exception as e:
            st['errors'].append(dict(step=name, error=f'{type(e).__name__}: {e}'[:600], trace=traceback.format_exc()[-1500:]))
    try:
        sm = summary(p['out'], ctx['rehearsal'])
        st['summary'] = dict(n_core=sm['n_core'], n_gaps=sm['n_gaps'], n_scored=sm['n_scored'], s0=sm['s0'])
    except Exception as e:
        st['errors'].append(dict(step='summary', error=f'{type(e).__name__}: {e}'[:600], trace=traceback.format_exc()[-1500:]))
    return 1 if st['errors'] else 0


def main(argv=None) -> int:
    a = parse_args(sys.argv[1:] if argv is None else argv)
    p = IO.paths()
    st = dict(schema=IO.SCHEMA_STATUS, stage=a.stage, started=IO.iso_tw(IO.now_tw()), rehearsal=bool(a.rehearsal), paths=p,
              frozen=[], gaps=[], score=[], parity=[], errors=[], note=IO.NOTE)
    code = 0
    try:
        if a.rehearsal and os.path.realpath(p['out']) == os.path.realpath(PROD_OUT):
            raise IO.Refuse(f'演練輸出不可指到正式 {PROD_OUT}')
        if not a.rehearsal and os.path.realpath(p['out']) != os.path.realpath(PROD_OUT) and a.stage == 'daily':
            raise IO.Refuse(f'正式執行的輸出必須是 {PROD_OUT}（演練請加 --rehearsal）')
        IO.guard_env(p)
        os.makedirs(p['out'], exist_ok=True)
        with IO.orchestrator_lock() as how:
            st['lock'] = how
            if a.stage == 'daily':
                code = run_daily(a, p, st)
            elif a.stage == 'prewire':
                days = a.days.split(',') if a.days else list(PREWIRE_DAYS)
                doc = prewire(p, days)
                st['prewire'] = {k: v.get('status') for k, v in doc['checks'].items()}
                IO.log('接線前證明：' + json.dumps(st['prewire'], ensure_ascii=False))
            else:
                st['summary'] = summary(p['out'], bool(a.rehearsal))
    except IO.Refuse as e:
        st['errors'].append(dict(step='refuse', error=str(e)))
        code = 2
    except SystemExit as e:                               # 登錄雜湊不符等（釘選模組丟 SystemExit）
        st['errors'].append(dict(step='registration', error=str(e)))
        code = 2
    except Exception as e:
        st['errors'].append(dict(step=a.stage, error=f'{type(e).__name__}: {e}'[:600], trace=traceback.format_exc()[-2000:]))
        code = 1
    st['finished'] = IO.iso_tw(IO.now_tw())
    st['exit'] = code
    try:
        IO.write_json_atomic(os.path.join(p['out'], 'tracks_fwd_status.json'), st)
    except OSError as e:
        print(f'狀態檔寫不了：{e}', file=sys.stderr)
    for e in st['errors']:
        print(f'✖ {e["step"]}：{e["error"]}', file=sys.stderr)
    IO.log(f'完成（exit {code}）：凍結 {[(x["day"], x["result"]) for x in st["frozen"]]}｜缺口 {[(x["day"], x["result"]) for x in st["gaps"]]}｜'
           f'評分 {[(x["day"], x["stage"], x["result"]) for x in st["score"]][-6:]}｜parity {[(x["day"], x["verdict"]) for x in st["parity"]]}')
    return code


if __name__ == '__main__':
    sys.exit(main())
