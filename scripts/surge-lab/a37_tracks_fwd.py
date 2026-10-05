"""T1 分軌前向影子（登錄 T1-TRACKS-FWD-2026-10-05）每日生產與評分：協調器 a35_shadow_daily.mjs 在 a35 名單＋發佈之後呼叫。

用法（環境：SURGE_CACHE＝前向快取 .surge-cache-F、SURGE_TRACKS_SHARED＝共用快取、OFFICIAL_ROOT＝鏡像、SURGE_TRACKS_OUT＝輸出目錄）：
  python3 a37_tracks_fwd.py daily --plan <計畫 JSON> [--rehearsal --now YYYY-MM-DDTHH:MM]
      同步 → 缺口記錄（計畫的 missed）→ core 凍結（計畫的 produce；條件 C1～C7＋接線前證明）→ 到期評分（y／c5／c10）
      → parity（y 到期時）→ 摘要；狀態寫 tracks_fwd_status.json。單一步驟失敗只記錄，不中止其他步驟。
  python3 a37_tracks_fwd.py prewire [--days 2026-09-17,…]    接線前證明（登錄 §17 第 2 步）：上市快照、漲跌停矩陣增量＝全量、
      處置／注意鏡像與 v2 釘住檔的重疊比對（a37_tracks_dispatt：列層＋推導層，FDEV-007）、≥5 個歷史交易日的研究路徑 parity
      → tracks_fwd_prewire.json（記 sha256）；重疊比對第一次落定 pass／fail 另寫以比對程式 sha256 為鍵的封印決定檔。
  python3 a37_tracks_fwd.py summary                          只重算摘要與 CSV（不凍結、不評分）。
總開關 tracks/forward_config.json（enabled＋startDay）：false 時 daily 只同步與記狀態，不凍結（磁碟即部署）。
--rehearsal：輸出目錄不可是正式 out/tracks_fwd；允許 --now 覆寫時鐘、--config 換設定檔（例如演練用的 allowDispAttPending）、不看總開關；
    所有文件標 rehearsal:true（不得發佈）。
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

import a37_tracks_dispatt as DA
import a37_tracks_fwd_io as IO

PROD_OUT = os.path.join(IO.LAB, 'out', 'tracks_fwd')
T2_TRACKS = os.path.join(IO.MAIN_REPO, 'scripts', 'surge-lab', '.surge-cache-T2', 'tracks')
FWDPREP_PICKS = os.path.join(IO.LAB, 'out', 'tracks_t1', 'fwdprep', 'tracks_t1_FWDPREP_SELHC_fwdlists_picks.csv.gz')
PREWIRE_DAYS = ('2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-03-16', '2025-06-16')
PREWIRE_PATH = 'tracks_fwd_prewire.json'
OVERLAP_PATH = 'tracks_fwd_dispatt_overlap.json'                 # 每輪重算的處置／注意重疊比對（可覆寫的狀態檔）
# 第一次落定 pass／fail 的封印決定檔（只寫一次）：以比對程式 a37_tracks_dispatt.py 的 sha256 為鍵（DA.DECIDED_FMT）；第一版
# tracks_fwd_dispatt_overlap_{pass,fail}.json（公布日分組的錯誤比對）與其證明內的 fail 由 FDEV-007 取代，舊檔保留（DA.decision_state）。
OVERLAP_MIN_DAYS = DA.MIN_DAYS                                   # 四個資料集各自至少比到 5 個重疊日才算「有證明」，否則 pending
PREWIRE_CODE = ('a37_tracks_fwd_io.py', 'a37_tracks_sync.py', 'a37_tracks_core.py', 'a37_tracks_dispatt.py')   # 證明綁定的程式（改了就要重跑 prewire）
APPROVAL_RE = r'FDEV-001.*使用者核可.*\d{4}-\d{2}-\d{2}'          # forward_config.allowDispAttPending 的格式（只有使用者核可才可放行 pending）
FDEV_REF = 'DEVIATIONS_t1_tracks_forward.md FDEV-001～FDEV-007'


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('stage', choices=('daily', 'prewire', 'summary'))
    ap.add_argument('--plan')
    ap.add_argument('--rehearsal', action='store_true')
    ap.add_argument('--now')
    ap.add_argument('--days')
    ap.add_argument('--config')
    a = ap.parse_args(argv)
    if a.now and not a.rehearsal:
        ap.error('--now 只能搭配 --rehearsal（正式執行一律用現在時刻）')
    if a.config and not a.rehearsal:
        ap.error('--config 只能搭配 --rehearsal（正式執行一律讀 tracks/forward_config.json）')
    return a


# ───────────────────────── 條件與凍結 ─────────────────────────
def code_digest() -> dict:
    return {f: IO.file_sha256(os.path.join(IO.LAB, f)) for f in PREWIRE_CODE}


def approval_ok(value) -> bool:
    import re
    return isinstance(value, str) and re.search(APPROVAL_RE, value) is not None


def prewire_gate(out: str, p: dict = None, cfg: dict = None, overlap: dict = None, rehearsal: bool = False, devlog: str = None) -> dict:
    """第一份 core 凍結前（以及之後每一輪）都要有接線前證明（登錄 data_sources.adapter_parity_before_first_freeze、execution_order 第 2 步）：
      · 上市快照、漲跌停增量＝全量、研究路徑 parity ≥5 日都 pass；
      · 處置／注意鏡像與 v2 釘住檔的重疊比對：只接受 pass（每輪以 overlap＝當下重算結果為準，鏡像回補後自動落定）；
        pending 只有在 forward_config.allowDispAttPending 帶使用者核可（格式 APPROVAL_RE）時放行，fail 一律擋；
      · 證明必須綁定正式環境：前向快取與鏡像根目錄（realpath）＝本次 p、PREWIRE_CODE 的 sha256＝現在的程式（改了就要重跑 prewire）。
        演練（rehearsal）只把路徑不符記成 rehearsal_binding，不擋。
      · 封印決定（FDEV-007）：比對程式（a37_tracks_dispatt.py）的 sha256 要登錄（OVERLAP-CHECK 列）；本版已封印 fail ⇒ 擋；
        其他版本封印的 fail（含第一版接線前證明內的 fail）要有 OVERLAP-SUPERSEDE 列（相對路徑＋封印）才算被取代，否則擋。"""
    pw = IO.read_json(os.path.join(out, PREWIRE_PATH))
    if not pw or not IO.verify_seal(pw):
        return dict(ok=False, why='沒有接線前證明（python3 a37_tracks_fwd.py prewire）或封印不符')
    checks = pw.get('checks', {})
    need = {k: checks.get(k, {}).get('status') for k in ('listing', 'limits_incremental', 'research_path')}
    bad = [f'{k}={v}' for k, v in need.items() if v != 'pass']
    binding = {}
    if p is not None:
        for k in ('cache', 'official_root'):
            if os.path.realpath(pw.get(k) or '') != os.path.realpath(p[k]):
                binding[k] = dict(proof=pw.get(k), now=p[k])
    code_now = code_digest()
    if pw.get('code_sha256') != code_now:
        bad.append('程式與證明時不同（PREWIRE_CODE 的 sha256；請在正式環境重跑 python3 a37_tracks_fwd.py prewire）')
    if binding and not rehearsal:
        bad.append('證明不是在正式環境做的（' + '、'.join(f'{k}：{v["proof"]}' for k, v in binding.items()) + '）')
    da_proof = checks.get('disp_att_overlap', {}).get('status')
    da = (overlap or {}).get('status') or da_proof
    approval = (cfg or {}).get('allowDispAttPending')
    pending_ok = da == 'pending' and approval_ok(approval)
    if da == 'pending' and not pending_ok:
        bad.append('disp_att_overlap=pending（處置／注意鏡像與 v2 釘住檔的重疊比對尚未證明；登錄要求第一份凍結前證明，'
                   '例外需 forward_config.allowDispAttPending 的使用者核可，FDEV-001／FDEV-005）')
    elif da not in ('pass', 'pending'):
        bad.append(f'disp_att_overlap={da}（比對不同：先寫前向偏差並由使用者裁定，不得凍結）')
    dec = DA.decision_state(out, devlog)
    if not dec['ok']:
        bad.append(dec['why'])
    return dict(ok=not bad, why='、'.join(bad) if bad else None, seal=pw.get('seal'), statuses=dict(need, disp_att_overlap=da, disp_att_overlap_proof=da_proof),
                disp_att_pending_approval=approval if pending_ok else None, rehearsal_binding=binding if rehearsal else None, code_sha256=code_now,
                overlap_decision={k: dec[k] for k in ('ok', 'why', 'check_sha256', 'registered')} | dict(
                    current=[d['rel'] for d in dec['current']], superseded=[dict(rel=d['rel'], seal=d['seal'], by=d['by']) for d in dec['superseded']]))


def conditions(I, ctx, day, target) -> dict:
    import a37_tracks_core as C
    import a37_tracks_score as SC
    p, cal = I['p'], ctx['cal']
    dates = I['dates']
    out = {}
    s = dates.index(day) if day in dates else None
    b = ctx['basis'].get(day)
    c1 = s is not None and SC.basis_ok(b)
    out['C1'] = dict(ok=bool(c1), basis=b and {k: b.get(k) for k in ('ready', 'missing', 'basis', 'nonOfficialOtcClose', 'gapFixSource')},
                     in_panel=s is not None)
    mk = C.market_array(I, (ctx.get('listing') or {}).get('snaps'))
    out['C1b'] = C.closes_check(I, s, mk) if s is not None else dict(ok=False, why='面板沒有這一天')   # 凍結所用的面板本身兩市到齊
    prev = dates[s - 1] if s else None
    c2 = s is not None and SC.official_ok(p['cache'], 'twse_limit', day) and prev is not None and SC.official_ok(p['cache'], 'tpex_daily', prev)
    out['C2'] = dict(ok=bool(c2), twse_twt84u=day, tpex_dailyquotes=prev)
    out['C2b'] = C.limit_coverage_check(I, s, mk) if s is not None else dict(ok=False, why='面板沒有這一天')
    to = (IO.read_json(os.path.join(IO.LAB, '..', '..', 'scripts', 'data', 'exright-history.json')) or {}).get('to') or day
    ex = {d: SC.exright_ok(p['cache'], d) for d in cal.between(to, day)}
    out['C3'] = dict(ok=all(v[0] for v in ex.values()), days={d: v[1] for d, v in ex.items()}, history_to=to)
    out['C4'] = dict(ok=True, note='處置／注意依 coverage_rule＋FDEV-002 建好；缺漏只會記 NaN，不擋凍結（登錄 C4）', mirror_live=ctx.get('disp_att_live'))
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
                                                                             disp_att_pending_approval=ctx['prewire'].get('disp_att_pending_approval'),
                                                                             deviations=FDEV_REF),
        disp_att_mirror_live=ctx.get('disp_att_live'),
        dataBasis=dict(close=cond['C1']['basis'], closes_at_s_check=cond['C1b'], exright=cond['C3'],
                       official_limit_files={f'twse_twt84u/{day}': IO.file_sha256(os.path.join(p['cache'], 'official', 'twse_limit', f'{day}.json.gz')),
                                             f'tpex_dailyquotes/{prev}': IO.file_sha256(os.path.join(p['cache'], 'official', 'tpex_daily', f'{prev}.json.gz'))},
                       sync_manifest_sha256=ctx.get('sync_sha256')))
    try:
        doc = C.build_core(I, s, target, ctx['listing'], extra)
    except AssertionError as e:                          # C6：分區 assertion 失敗 ⇒ 當日 core 記缺口（登錄 daily_assertion），不產生名單、不重試
        err = str(e)[:500]
        IO.write_json_atomic(SC.wait_path(out, day), dict(day=day, target=target, time=IO.iso_tw(ctx['now']), unmet={'C6': dict(ok=False, error=err)}))
        return dict(day=day, result='gap', unmet=['C6'],
                    write=write_gap(p, ctx, day, target, '分區 assertion 失敗（C6；登錄 track_assignment.daily_assertion）', dict(assertion_error=err)))
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
def _disc_days(cal, start, now) -> list:
    """P1 的分母：[start, 今天] 中「期限（下一交易日 09:00）已過」的交易日——每一天都必須有 core 或缺口記錄。"""
    if cal is None or not start or now is None:
        return None
    out, d = [], start
    today = now.strftime('%Y-%m-%d')
    while d <= today:
        if cal.is_trading(d):
            try:
                if now >= IO.deadline_of(cal.next_trading(d)):
                    out.append(d)
            except IO.Refuse:
                pass
        d = IO._add_days(d, 1)
    return out


def process_checks(days, gap_docs, cal, start, now, out) -> dict:
    """G60 流程檢查 P1～P8 的機械部分（登錄 G60.process_checks）。每項 ok＝True／False／None（無法判定＝不能當通過）。"""
    import a37_tracks_score as SC
    core_days = {d for d, *_ in days}
    expected = _disc_days(cal, start, now)
    if expected is None:
        p1 = dict(ok=None, why='沒有日曆或起算日（summary 單獨執行時）：P1 無法判定')
    else:
        silent = [d for d in expected if d not in core_days and d not in gap_docs]
        n_gap = sum(1 for d in expected if d in gap_docs)
        ratio = n_gap / len(expected) if expected else 0.0
        p1 = dict(ok=not silent and ratio <= 0.2, n_trading_days=len(expected), silent_days=silent, n_silent=len(silent),
                  gap_ratio=round(ratio, 4), rule='每個期限已過的前向交易日都有 core 或缺口（沒有無聲缺日）；缺口 ≤ 20%')
    seals_ok = all(IO.verify_seal(fz) for _, fz, _, _ in days) and all(IO.verify_seal(x) for _, _, sc, _ in days for x in sc.values() if x) \
        and all(IO.verify_seal(g) for g in gap_docs.values())
    raw = IO.read_json(os.path.join(out, '.published_raw_verify.json'))
    p2 = dict(ok=bool(seals_ok and (raw is None or raw.get('ok') is True)), local_seals=seals_ok,
              firestore_copy=raw or '尚未發佈逐位副本（a37_tracks_publish.mjs 寫 surgeShadow/tracks-raw-* 後讀回比對）')
    par = [x for *_, x in days if x]
    fails = [x['date_s'] for x in par if x['verdict'] == 'fail']
    p3 = dict(ok=not fails, n=len(par), fail=fails, data_correction=[x['date_s'] for x in par if x['verdict'] == 'data_correction'])
    p4 = dict(ok=all(all(fz['partition_checks'].values()) for _, fz, _, _ in days)
              and not any('C6' in (g.get('unmet_conditions') or {}) for g in gap_docs.values()),
              c6_gaps=sorted(d for d, g in gap_docs.items() if 'C6' in (g.get('unmet_conditions') or {})))
    bad5 = []
    for d, fz, sc, _ in days:
        y = sc.get('y') or {}
        for lid, yl in (y.get('lists') or {}).items():
            for po, pk in zip(yl.get('picks_outcome') or [], fz['lists'][lid]['picks']):
                codes = (po.get('flags') or '').split(';')
                if pk['DK_s'] is None and 'DKNA' not in codes:
                    bad5.append(f'{d} {lid} {pk["code"]} DK_s 未知卻無 DKNA')
                if po.get('m_disp_t_exec') is None and po.get('m_buyable') is not None and 'DTNA' not in codes:
                    bad5.append(f'{d} {lid} {pk["code"]} t 日起處置未知卻無 DTNA')
    p5 = dict(ok=not bad5, problems=bad5[:20], rule='未知值一律 null＋旗標（DKNA／DTNA）；報酬未到期或出場日無收盤一律 null（不以 0 填補）')
    late = [d for d, _, sc, _ in days if sc.get('y') and sc['y'].get('status') == 'ok' and str(sc['y'].get('computed', ''))[:10] < str(sc['y'].get('due', ''))]
    p6 = dict(ok=not late, early_labels=late, rule='T1 標籤恰寫一次（write_once）且在 t＋1 資料到齊之後')
    c7 = sorted(d for d, g in gap_docs.items() if 'C7' in (g.get('unmet_conditions') or {}))
    p7 = dict(ok=all(fz['implementation_pins']['ok'] for _, fz, _, _ in days) and not c7, c7_gaps=c7)
    p8 = dict(ok=True, rule='發佈端 assertNoReturns 與 surge-tracks-report.test.mjs 保證：後台文件無報酬欄、各區獨立（結構保證）')
    return dict(P1=p1, P2=p2, P3=p3, P4=p4, P5=p5, P6=p6, P7=p7, P8=p8)


def summary(out: str, rehearsal: bool, cal=None, start=None, now=None) -> dict:
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
    gap_docs = {}
    for f in sorted(glob.glob(os.path.join(out, 'tracks_fwd_gap_*.json'))):
        g = IO.read_json(f)
        if g and bool(g.get('rehearsal')) == rehearsal:
            gap_docs[g['date_s']] = g
    gaps = sorted(gap_docs)
    scored = [(d, fz, sc) for d, fz, sc, _ in days if sc['y'] and sc['y'].get('status') == 'ok']
    series = {lid: [(sc['y']['lists'][lid]['hits'], sc['y']['lists'][lid]['picks'], sc['y']['lists'][lid]['E_rand']) for _, _, sc in scored]
              for lid in SC.FWD_LIST_IDS}
    stats = {lid: SC.boot_stats(*zip(*v)) | dict(window_days=len(v)) if v else SC.boot_stats([], [], []) | dict(window_days=0)
             for lid, v in series.items()}                  # 累計（全部已評分日，只作顯示）
    windows = {name: {lid: SC.boot_stats(*zip(*v[:n])) | dict(window_days=n) for lid, v in series.items()}
               for name, n in (('g60', SC.G60_N), ('g250', SC.G250_N), ('g500', SC.G500_N)) if len(scored) >= n}   # 判定窗：各自固定前 N 個評分日
    rows, ev = [], []
    since_note = '前向 core 以 compute_all(with_features=False) 計算，不算這個特徵（四份代理清單不使用）；依登錄 pick_columns_new 記 NaN＋state＝unknown'
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
                                 list_verdict=fl['list_verdict'],
                                 m_disp_t_exec=po['m_disp_t_exec'] if po['m_disp_t_exec'] is not None else np.nan, m_has_open_t=po['m_has_open_t'],
                                 m_locked_open=po['m_locked_open'], m_buyable=po['m_buyable'], m_c1=po['m_c1'], m_c5=c5.get('m_c5'),
                                 m_c10=c10.get('m_c10'), exit_c5_cat=c5.get('exit_c5_cat', 'PENDING' if po['m_buyable'] else 'NA'),
                                 exit_c10_cat=c10.get('exit_c10_cat', 'PENDING' if po['m_buyable'] else 'NA'),
                                 flags=po.get('flags', ''), flags_text=po.get('flags_text', ''), Qmax_lots=pk['qmax_lots'], vol20_s=pk['vol20'],
                                 atr14=pk.get('atr14'), n_lu_250=pk.get('n_lu_250'), r20=pk.get('r20'), c_ma120=pk.get('c_ma120'),
                                 days_since_lu=np.nan, days_since_lu_state='unknown', dp_since=np.nan, dp_since_state='unknown', since_note=since_note,
                                 note=IO.NOTE))
        e5 = {e['code']: e for e in ((sc.get('c5') or {}).get('events_outcome') or [])}
        e10 = {e['code']: e for e in ((sc.get('c10') or {}).get('events_outcome') or [])}
        for e in sc['y']['events']:
            row = {k: (';'.join(v) if isinstance(v, list) else v) for k, v in e.items()}
            row.update(date_s=d, result=('命中' if e.get('picked') else '漏網') if e.get('list_id') and e.get('rank') is not None else '池外／不排名',
                       detail=e.get('note'), m_c5=(e5.get(e['code']) or {}).get('m_c5'), exit_c5_cat=(e5.get(e['code']) or {}).get('exit_c5_cat', 'PENDING'),
                       m_c10=(e10.get(e['code']) or {}).get('m_c10'), exit_c10_cat=(e10.get(e['code']) or {}).get('exit_c10_cat', 'PENDING'), note=IO.NOTE)
            ev.append(row)
    files = {}
    if rows:
        pk = pd.DataFrame(rows)
        for lid, g in pk.groupby('list_id'):
            files[f'{lid}_picks'] = _csv(out, f'tracks_fwd_{lid.split("_")[0]}_picks.csv', g)
        te = pd.to_numeric(pk.m_disp_t_exec, errors='coerce')
        need = ['date_s', 'list_id', 'DK_s', 'm_disp_t_exec', 'm_buyable', 'm_has_open_t', 'm_locked_open', 'exit_c5_cat', 'exit_c10_cat']
        disc = FR.daily_disclosure(pk[need].assign(DK_s=pk.DK_s.astype(float), m_disp_t_exec=te))   # 只給登錄欄（它把所有 n_* 欄加總）；t 日起處置未知不填 0
        unk = pk.assign(n_disp_t_unknown=te.isna().astype(int)).groupby(['date_s', 'list_id'], sort=True)['n_disp_t_unknown'].sum().reset_index()
        disc = disc.merge(unk, on=['date_s', 'list_id'], how='left')
        files['daily_disclosure'] = _csv(out, 'tracks_fwd_daily_disclosure.csv', disc)
    if ev:
        e = pd.DataFrame(ev)
        for lid in SC.FWD_LIST_IDS:
            g = e[e.list_id == lid]
            files[f'{lid}_hits'] = _csv(out, f'tracks_fwd_{lid.split("_")[0]}_hits.csv', g[g.result == '命中'])
            files[f'{lid}_misses'] = _csv(out, f'tracks_fwd_{lid.split("_")[0]}_misses.csv', g[g.result == '漏網'])
        files['outside'] = _csv(out, 'tracks_fwd_outside.csv', e[e.result == '池外／不排名'])
    n = len(scored)
    first = days[0][0] if days else None
    seen = [x for x in (first, *gaps) if x]
    proc = process_checks(days, gap_docs, cal, start or (min(seen) if seen else None), now, out)   # 沒有起算日（演練）＝第一筆記錄
    doc = dict(schema='t1-tracks-forward-summary/v2', generated=IO.iso_tw(IO.now_tw()), rehearsal=rehearsal, s0=first, n_core=len(days),
               n_m0ref_gaps=sum(1 for _, fz, _, _ in days if (fz.get('m0ref') or {}).get('gap')),
               n_gaps=len(gaps), gaps=gaps, n_scored=n, g60_reached=n >= SC.G60_N, g250_reached=n >= SC.G250_N, g500_reached=n >= SC.G500_N,
               stats=stats, windows=windows, gate=SC.gate_report(windows, n, proc, SC.g60_ruling()), process=proc, files=files, note=IO.NOTE)
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
    checks['disp_att_overlap'] = disp_att_overlap(p, I)
    checks['research_path'] = research_path_parity(I, days)
    checks['m0_fingerprint'] = dict(status='pending', why='m0ref（M0@10／M0@20 參照）未接線：第二期以 fit-verify 重現指紋 80ec0f8e… 後才可凍結')
    doc = dict(schema=IO.SCHEMA_PREWIRE, kind='t1-tracks-prewire', registration_id='T1-TRACKS-FWD-2026-10-05', computed=IO.iso_tw(IO.now_tw()),
               cache=p['cache'], shared=p['shared'], official_root=p['official_root'], sync=dict(official={k: v['last'] for k, v in man['official'].items()}),
               code_sha256=code_digest(), checks=checks, runtime_s=round(time.time() - t0, 1), deviations=FDEV_REF, note=IO.NOTE,
               binding='凍結閘門要求 cache／official_root（realpath）＝正式前向快取與鏡像、code_sha256＝當下程式；不符就要在正式環境重跑本證明（FDEV-005）')
    doc = IO.sealed(doc)
    stamp = IO.now_tw().strftime('%Y%m%dT%H%M%S')
    IO.write_once(os.path.join(p['out'], 'prewire', f'tracks_fwd_prewire_{stamp}.json'), doc)
    IO.write_json_atomic(os.path.join(p['out'], PREWIRE_PATH), doc)
    return dict(doc, _decided_record=DA.record_decision(p['out'], checks['disp_att_overlap']))   # 決定檔另寫；_decided_record 只回報給呼叫端（不在封印內）


def disp_att_overlap(p, I=None) -> dict:
    """處置／注意鏡像與 v2 釘住檔的重疊比對（a37_tracks_dispatt：列層以正確語意對日——處置＝處置期間含 D、注意＝日期＝D，排除查詢區間相依欄；
    推導層以前向合併＋截斷＋未知規則重建 DK_s／at_known5／20／t 日起處置與釘住檔逐檔比較）。I＝load_inputs 的結果（推導層要面板）。
    第一版以「公布日」分組、整列（含編號／累計）比對，29 天全部不同是比對錯誤、不是資料不同（FDEV-007）。"""
    panel = dict(dates=I['dates'], codes=I['codes'], mkt=I['mkt']) if I is not None else None
    return DA.overlap_check(p, panel)


def overlap_now(p, out, I=None) -> dict:
    """每輪重算重疊比對；狀態檔可覆寫，本版比對（sha256）第一次落定 pass／fail 另寫封印決定檔（只寫一次；舊版決定檔與證明一律保留）。"""
    ov = disp_att_overlap(p, I)
    IO.write_json_atomic(os.path.join(out, OVERLAP_PATH), ov)
    return dict(ov, decided_record=DA.record_decision(out, ov))


def disp_att_live(p, cal, today) -> dict:
    """四個帶日期資料集的鏡像最後一天（≥ BASE_TO 的定版列）；落後「今天之前最近一個交易日」就是 lagging（登錄 C4 不擋凍結，只告警）。"""
    import a37_tracks_sync as SY
    cov = SY.load_coverage(p['cache'])
    want, d = None, today
    for _ in range(31):                                   # 今天之前最近一個交易日（當天的公告晚上才有，不要求）
        d = IO._add_days(d, -1)
        if cal.is_trading(d):
            want = d
            break
    out = {}
    for kind in ('disposal', 'attention'):
        for m in ('TWSE', 'TPEx'):
            days = cov.get(kind, {}).get(m, [])
            last = days[-1] if days else None
            out[f'{kind}_{m}'] = dict(last=last, lagging=bool(want and (last is None or last < want)))
    return dict(datasets=out, expect_at_least=want, any_lagging=any(v['lagging'] for v in out.values()),
                note='鏡像帶日期處置／注意資料集（FDEV-001）≥ 前一交易日才算即時；落後時 DK_s／at_known／m_disp_t_exec 依 FDEV-002／FDEV-005／FDEV-007 記未知'
                     '（處置鏡像鍵是「處置期間含 D」：DK_s 要 s 當天、t 日起處置要 t 當天的鏡像列）')


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
    cfg = IO.load_config(a.config) if a.config else IO.load_config()
    st['config'] = cfg
    plan = IO.read_json(a.plan) if a.plan else None
    if not plan:
        raise IO.Refuse(f'讀不到計畫檔 {a.plan}')
    st['plan'] = {k: plan.get(k) for k in ('produce', 'missed', 'waiting', 'startDay')}
    if not cfg['enabled'] and not a.rehearsal:
        st['skipped'] = f'forward_config.enabled＝false（{cfg.get("error") or "總開關未開"}）：不同步、不凍結'
        return 0
    cal = IO.Calendar.from_plan(plan)
    ctx = dict(plan=plan, cal=cal, now=IO.now_tw(a.now), now_override=a.now, rehearsal=bool(a.rehearsal))
    today = ctx['now'].strftime('%Y-%m-%d')
    man = SY.sync(p, today)
    ctx['sync_sha256'] = IO.file_sha256(os.path.join(p['cache'], 'a37_sync_manifest.json'))
    st['sync'] = {k: dict(last=v['last'], added=v['added'][-5:]) for k, v in man['official'].items() if k in ('twse_limit', 'tpex_daily')}
    st['sync']['disp_att'] = {k: dict(days=v['days'], last=v['last'], problems=len(v['problems'])) for k, v in man['disp_att'].items()}
    I = C.load_inputs(p)                                  # 重疊比對的推導層要面板（FDEV-007）
    try:
        ov = overlap_now(p, p['out'], I)                  # 每輪重算重疊比對：本版比對第一次落定 pass／fail 寫封印決定檔（fail 擋凍結）
    except Exception as e:                                # 比對程式本身出錯：記 error（閘門照擋），評分與摘要照跑
        st['errors'].append(dict(step='disp_att_overlap', error=f'{type(e).__name__}: {e}'[:600], trace=traceback.format_exc()[-1500:]))
        ov = dict(status='error', why=f'重疊比對程式出錯：{type(e).__name__}: {e}'[:300])
    ctx['prewire'] = prewire_gate(p['out'], p, cfg, ov, rehearsal=bool(a.rehearsal))
    ctx['disp_att_live'] = disp_att_live(p, cal, today)
    st['prewire_gate'] = {k: ctx['prewire'].get(k) for k in ('ok', 'why', 'statuses', 'disp_att_pending_approval', 'rehearsal_binding', 'overlap_decision')}
    st['disp_att_overlap'] = {k: ov.get(k) for k in ('status', 'why', 'days_total', 'check', 'decided_record')}
    st['disp_att_live'] = ctx['disp_att_live']
    st['pins_ok'] = I['pins']['ok']
    st['pins_mismatches'] = I['pins']['mismatches']
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
        sm = summary(p['out'], ctx['rehearsal'], cal=cal, start=(cfg.get('startDay') if not a.rehearsal else plan.get('startDay')), now=ctx['now'])
        st['summary'] = dict(n_core=sm['n_core'], n_gaps=sm['n_gaps'], n_scored=sm['n_scored'], s0=sm['s0'],
                             P1_silent=(sm['process'].get('P1') or {}).get('silent_days'), g60=(sm['gate'].get('g60') or {}).get('outcome'))
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
                st['disp_att_overlap_decided'] = doc.get('_decided_record')
                st['prewire_gate'] = {k: v for k, v in prewire_gate(p['out'], p).items() if k in ('ok', 'why', 'overlap_decision')}
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
