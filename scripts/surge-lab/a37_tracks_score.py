"""T1 分軌前向影子：到期評分、每日對帳（每個 T1 事件 → 軌道／沒通過的條件／名次／是否入選）、parity、摘要（登錄 §7～§10）。

  · 標籤 y（s＋2）：t、t＋1 兩日在面板、收盤＋法人到齊且無第三方補洞（C1）、官方漲停價檔齊（C2）、除權息涵蓋（C3）才評分；
    t＋1 之後再過 10 個交易日仍不齊 ⇒ label_unavailable（不進指標、不補值）。
  · c5（s＋5）／c10（s＋10）：到期當時的還原面板算一次（close(t+k−1)/open(t)−1），出場日無收盤記 NaN＋旗標（不補 0）。
  · 每個 (s, 期數) 只寫一次（a37_tracks_fwd_io.write_once）；之後上游修正不改寫。
  · parity（G60 P3）：y 到期時以當下的輸入把面板截到 ≤ s 重算 core，與凍結檔比軌道／池列數／成員與名次；
    輸入摘要不同 ⇒「資料修正」（附哪些輸入變了）、摘要相同卻不同 ⇒ parity 失敗。
  · 摘要：已評分日的 precision、Δprecision 對 RAND_E、lift 與 20 日循環區塊 bootstrap（a36_tracks_eval，B＝2000、seed＝11）；
    G60 流程檢查 P1～P7 的機械部分（P8 介面另由發佈端的測試保證）。
報酬只在本機研究記錄（未扣成本），不進後台文件。影子模式·非投資建議。
"""
import glob
import json
import os
import subprocess

import numpy as np
import pandas as pd

import a36_tracks_eval as EV
import a36_tracks_fwd_rules as FR
import a36_tracks_lib as L
import build as B
import build_v2 as V2

import a37_tracks_core as C
import a37_tracks_fwd_io as IO

LABEL_GRACE = 10                     # t＋1 之後再等 10 個交易日（登錄 maturity_and_scoring.label_unavailable）
HORIZONS = {'c5': 5, 'c10': 10}
NODE = '/opt/homebrew/bin/node'
G60_N, G250_N, G500_N = 60, 250, 500
FWD_LIST_IDS = ('S0_atr14@5', 'SFB_atr14@5', 'R0_combo@5', 'W_atr14@3')
# 前向自己的旗標：DTNA＝t 日起處置狀態未知（釘選的 FR.FLAG_TEXT 沒有這一碼；FR.pick_flag_codes 遇到 None 只會「不標 DISP_T」，等於當成未處置）
FLAG_TEXT_FWD = {**FR.FLAG_TEXT, 'DTNA': 't 日起處置狀態未知（鏡像處置公告缺漏；不當成未處置，FDEV-005）'}
G60_RULING_RE = r'^\s*G60-RULING:\s*(CONTINUE|HALT)\b'


def flags_fwd(dk, te, has_open, locked, cat5, cat10) -> str:
    """FR.pick_flag_codes（固定順序）＋前向的 DTNA：te 為 None（未知）時插在 DISP_T 的位置（DK 旗標之後）。"""
    codes = FR.pick_flag_codes([dk], [te if te is not None else 0], [has_open], [locked], [cat5], [cat10])[0]
    if te is not None:
        return codes
    parts = [c for c in codes.split(';') if c]
    at = 1 if parts and parts[0] in ('DK1', 'DKNA') else 0
    return ';'.join(parts[:at] + ['DTNA'] + parts[at:])


def flags_text_fwd(codes: str) -> str:
    return '；'.join(FLAG_TEXT_FWD[c] for c in codes.split(';') if c)


# ───────────────────────── 檔名 ─────────────────────────
def core_path(out, d):
    return os.path.join(out, f'tracks_fwd_{d}.json')


def gap_path(out, d):
    return os.path.join(out, f'tracks_fwd_gap_{d}.json')


def wait_path(out, d):
    return os.path.join(out, 'wait', f'tracks_fwd_wait_{d}.json')


def score_path(out, d, stage):
    return os.path.join(out, f'tracks_fwd_score_{d}_{stage}.json')


def parity_path(out, d):
    return os.path.join(out, f'tracks_fwd_parity_{d}.json')


def frozen_days(out) -> list:
    return sorted(os.path.basename(f)[11:21] for f in glob.glob(os.path.join(out, 'tracks_fwd_2???-??-??.json')))


# ───────────────────────── 資料到齊（收盤＋法人、除權息）─────────────────────────
def basis_for(days, shared: str, injected: dict = None) -> dict:
    """{日: basisOf}（a35_shadow_meta.basisOf 同一支判斷，讀共用快取 chipArchive.json.gz）。injected＝計畫檔或測試直接給。"""
    days = sorted(set(d for d in days if d))
    if injected is not None:
        return {d: injected.get(d) for d in days}
    if not days:
        return {}
    r = subprocess.run([NODE, os.path.join(IO.LAB, 'a37_tracks_basis.mjs'), *days], capture_output=True, text=True,
                       env=dict(os.environ, SURGE_CACHE=shared), timeout=180)
    if r.returncode != 0:
        raise IO.Refuse(f'讀不到收盤歸檔到齊狀態（a37_tracks_basis.mjs）：{r.stderr.strip()[-300:]}')
    return json.loads(r.stdout)


def basis_ok(b) -> bool:
    return bool(b and b.get('found') and b.get('ready') and not b.get('nonOfficialOtcClose'))


def exright_ok(cache: str, day: str) -> tuple:
    """生效日 day 的除權息是否已載入：exright-history 涵蓋，或 a35 補抓檔兩市都成功。"""
    to = (IO.read_json(os.path.join(B.REPO, 'scripts/data/exright-history.json')) or {}).get('to')
    if to and day <= to:
        return True, 'exright-history'
    j = IO.read_json(os.path.join(cache, f'a35_shadow_exright_{day}.json'))
    if not j:
        return False, '沒有除權息補抓檔'
    if j.get('error') or j.get('twseOnly'):
        return False, f'除權息補抓不完整（{j.get("error") or "只有上市"}）'
    return True, 'a35_shadow_exright'


def official_ok(cache: str, ds: str, day: str) -> bool:
    return os.path.exists(os.path.join(cache, 'official', ds, f'{day}.json.gz'))


# ───────────────────────── 標籤與報酬 ─────────────────────────
def maturity(I, cal, frozen, stage, basis, today) -> dict:
    """回傳 {state: ready|wait|unavailable, why, days}。"""
    D = frozen['date_s']
    t = cal.next_trading(D)
    k = 1 if stage == 'y' else HORIZONS[stage] - 1
    due = cal.nth_after(t, k)                            # y：t＋1；c5：t＋4（＝s＋5）；c10：t＋9
    need = [t] + cal.between(t, due)
    dates, cache = I['dates'], I['p']['cache']
    why = []
    rows_ok = False
    if D not in dates:
        why.append(f'面板沒有決策日 {D}')
    else:
        s = dates.index(D)
        rows_ok = True
        for i, d in enumerate(need, 1):
            if s + i >= len(dates) or dates[s + i] != d:
                why.append(f'面板第 s＋{i} 列不是 {d}（{dates[s + i] if s + i < len(dates) else "尚無"}）')
                rows_ok = False
                break
    if stage == 'y' and rows_ok and 'U' in I:                       # C2b 同口徑：t、t＋1 兩市官方漲停價覆蓋率（格式漂移解析出 0 列時不無聲退回檔位推算）
        mk = C.market_array(I, None)
        for i, d in ((1, t), (2, due)):
            chk = C.limit_coverage_check(I, s + i, mk)
            if not chk['ok']:
                why.append(f'{d} 官方漲停價覆蓋率不足 {chk["min"]}：{chk["low"]}')
    for d in need:
        if not basis_ok(basis.get(d)):
            why.append(f'{d} 收盤＋法人未到齊或含第三方補洞')
        ok, w = exright_ok(cache, d)
        if not ok:
            why.append(f'{d} {w}')
    if stage == 'y':
        prev = {t: D, due: t}
        for d in (t, due):
            if not official_ok(cache, 'twse_limit', d):
                why.append(f'上市官方漲停價 TWT84U({d}) 未到')
            if not official_ok(cache, 'tpex_daily', prev[d]):
                why.append(f'上櫃官方漲停價 dailyQuotes({prev[d]}) 未到')
    if not why:
        return dict(state='ready', t=t, due=due, days=need)
    if today > cal.nth_after(due, LABEL_GRACE):
        return dict(state='unavailable', t=t, due=due, days=need, why=why)
    return dict(state='wait', t=t, due=due, days=need, why=why)


def _jmap(I, codes):
    ci = {c: j for j, c in enumerate(I['codes'])}
    return np.array([ci.get(c, -1) for c in codes], np.int64)


def outcome_y(I, frozen, mat, snaps) -> dict:
    """y、可買、開盤鎖死、t 日起處置、c1（t＋1 為止的面板，官方漲停價為準）。"""
    s, t1 = I['dates'].index(frozen['date_s']), I['dates'].index(mat['due'])
    res = C.compute_upto(I, t1, snaps)
    T = t1 + 1
    allj = np.arange(len(I['codes']))
    si = np.full(len(allj), s, np.int64)
    P = res['_t']['P']
    with L._patched(B, 'official_limit_up', lambda T_, N_: res['_t']['U']):
        meta = V2.forward_meta(si, allj, res['A'], P, res['F_day'], T)
    open_t = P['O'][s + 1]
    unk, why = C.disp_t_unknown(I, s)                     # 鏡像處置缺 t 當天或 [s−20, s] 的市場：t 日起處置記 NaN（不捏造 0，FDEV-005／FDEV-007）
    disp_t = np.where(unk, np.nan, res['da']['disp_t_exec'][s].astype(np.float64))
    mk = C.market_array(I, snaps)
    return dict(y=res['fl']['y'][s].astype(bool), buyable=(np.isfinite(open_t) & (meta['locked_open'] == 0)), has_open=np.isfinite(open_t),
                locked=meta['locked_open'].astype(int), c1=meta['o_c1'], disp_t=disp_t, disp_t_unknown_why=why,
                limit_coverage={'t': C.limit_coverage(I, s + 1, mk), 't1': C.limit_coverage(I, t1, mk)})


def outcome_ret(I, frozen, mat, k) -> dict:
    """c_k＝close(s＋k)/open(t)−1（到期當時的還原面板；只用生效日 ≤ s＋k 的除權息）＋出場日分類（記錄時點＝到期日）。"""
    s, e = I['dates'].index(frozen['date_s']), I['dates'].index(mat['due'])
    P = {kk: v[:e + 1] for kk, v in I['P'].items()}
    A, _, _ = B.adjust(I['dates'][:e + 1], I['codes'], P, I['events'])
    with np.errstate(invalid='ignore', divide='ignore'):
        r = A['C'][e] / A['O'][s + 1] - 1
    return dict(ret=r, fin=np.isfinite(P['C']), asof=e)


def _f(x):
    return C.fnum(x)


def _te(Y, j):
    """t 日起處置：1／0；鏡像處置公告缺漏 ⇒ None（DTNA）。"""
    if j < 0:
        return None
    v = float(Y['disp_t'][j])
    return int(v) if np.isfinite(v) else None


def score_y_doc(I, frozen, mat, Y) -> dict:
    jm = {}
    lists, ev_rows = {}, []
    dom = frozen['domain']
    dmap = dict(zip(dom['codes'], dom['track']))
    fmask = dict(zip(dom['codes'], dom['failmask']))
    dix = {c: i for i, c in enumerate(dom['codes'])}
    feats = dom.get('features') or {}
    for lid, fl in frozen['lists'].items():
        codes = fl['ranked_codes']
        jj = _jmap(I, codes)
        jm[lid] = jj
        ok = jj >= 0
        y = np.where(ok, Y['y'][np.maximum(jj, 0)], False)
        buy = np.where(ok, Y['buyable'][np.maximum(jj, 0)], False)
        K, n = fl['K'], fl['n_pool']
        picks_n, E = FR.rand_expected([n], [int(y.sum())], K)
        rd = set(fl['rand']['draw'])
        prs = []
        for pk in fl['picks']:
            i = pk['rank'] - 1
            j = int(jj[i])
            te = _te(Y, j)
            ho, lo = (bool(Y['has_open'][j]), int(Y['locked'][j])) if j >= 0 else (False, 0)
            codes_f = flags_fwd(pk['DK_s'] if pk['DK_s'] is not None else np.nan, te, ho, lo, 'PENDING' if buy[i] else 'NA', 'PENDING' if buy[i] else 'NA')
            prs.append(dict(rank=pk['rank'], code=pk['code'], y=int(y[i]), m_buyable=int(buy[i]), m_has_open_t=int(ho), m_locked_open=lo,
                            m_c1=_f(Y['c1'][j]) if j >= 0 and buy[i] else None, m_disp_t_exec=te, flags=codes_f, flags_text=flags_text_fwd(codes_f)))
        lists[lid] = dict(K=K, n_pool=n, events=int(y.sum()), picks=int(picks_n[0]), hits=int(sum(p['y'] for p in prs)), E_rand=float(E[0]),
                          rand_draw_hits=int(sum(int(y[i]) for i, c in enumerate(codes) if c in rd)), buyable_picks=int(sum(p['m_buyable'] for p in prs)),
                          buyable_hits=int(sum(p['m_buyable'] and p['y'] for p in prs)),
                          dk0_picks=int(sum(1 for p in fl['picks'] if p['DK_s'] == 0)),
                          n_disp_t_unknown=int(sum(1 for p in prs if p['m_disp_t_exec'] is None)), picks_outcome=prs,
                          pool_y=[int(v) for v in y], pool_buyable=[int(v) for v in buy])
    # 對帳：當日每個 T1 事件（y＝1）——名次、命中或漏網、分數（凍結的池內分數）、池列數、關鍵特徵（凍結）、DK_s、旗標、事後 m_ 欄
    for j in np.nonzero(Y['y'])[0]:
        code = I['codes'][j]
        tr = dmap.get(code)
        tn = L.TRACKS[tr] if tr is not None and tr >= 0 else None
        lid = C.TRACK_LIST.get(tn) if tn else None
        mk = str(I['mkt'][j])
        k = dix.get(code)
        dk = dom['DK_s'][k] if k is not None and 'DK_s' in dom else None
        te = _te(Y, int(j))
        ho, lo = bool(Y['has_open'][j]), int(Y['locked'][j])
        codes_f = flags_fwd(dk if dk is not None else np.nan, te, ho, lo, 'NA', 'NA')
        row = dict(code=code, name=C.name_of(I, code, {})[0], market=mk if mk in ('TWSE', 'TPEx') else '來源未提供', track=tn or 'outside',
                   failing=[kk for kk, b in C.FAIL_BITS.items() if fmask.get(code, 0) & b], list_id=None, rank=None, K=None, n_pool=None, score=None,
                   picked=False, DK_s=dk, at_known5=(dom['at_known5'][k] if k is not None and 'at_known5' in dom else None),
                   **{f: (feats[f][k] if k is not None and f in feats else None) for f in C.DOMAIN_FEATURES},
                   flags=codes_f, flags_text=flags_text_fwd(codes_f), m_buyable=int(Y['buyable'][j]), m_has_open_t=int(ho), m_locked_open=lo,
                   m_disp_t_exec=te, m_c1=_f(Y['c1'][j]) if Y['buyable'][j] else None)
        if tn is None:
            row['outside_reason'] = 's 日不在列範圍（s 日無收盤、或面板內上市日之後）'
        elif lid in frozen['lists']:
            fl = frozen['lists'][lid]
            rk = fl['ranked_codes'].index(code) + 1 if code in fl['ranked_codes'] else None
            row.update(list_id=lid, rank=rk, K=fl['K'], n_pool=fl['n_pool'], picked=bool(rk is not None and rk <= fl['K']),
                       score=fl['ranked_scores'][rk - 1] if rk is not None else None)
        elif lid == 'M0@10':
            row.update(list_id='M0@10', note='M0 參照（m0ref）尚未接線：第二期重現凍結模型指紋後才排名')
        else:
            row['note'] = '不參與排名的軌（NE）'
        ev_rows.append(row)
    by_track = {}
    for r in ev_rows:
        by_track[r['track']] = by_track.get(r['track'], 0) + 1
    return dict(lists=lists, events=ev_rows, n_events=len(ev_rows), events_by_track=by_track,
                official_limit_coverage=Y.get('limit_coverage'), disp_t_unknown_days=Y.get('disp_t_unknown_why'))


def score_ret_doc(I, frozen, y_doc, R, k, stage) -> dict:
    """到期當下（記錄時點＝到期日）的出場分類只會是 OK／NOCLOSE_UNRESOLVED（之後的重分類另檔、只增不改）。
    另對 y 檔的每個 T1 事件記同一期報酬（events_outcome；只在本機研究記錄，後台文件不帶）。"""
    out = {}
    s = I['dates'].index(frozen['date_s'])
    for lid, fl in frozen['lists'].items():
        jj = _jmap(I, fl['ranked_codes'])
        buy = np.array(y_doc['lists'][lid]['pool_buyable'], bool) & (jj >= 0)
        ret = np.where(jj >= 0, R['ret'][np.maximum(jj, 0)], np.nan)
        npk = len(fl['picks'])
        cats = FR.exit_category(R['fin'], np.full(npk, s), np.maximum(jj[:npk], 0), k, R['asof'], buy[:npk],
                                np.array([np.nan if p.get('nan20') is None else p['nan20'] for p in fl['picks']], np.float64))
        prs = []
        for i, pk in enumerate(fl['picks']):
            cat = str(cats[i])
            v = _f(ret[i]) if buy[i] and cat == 'OK' else None
            prs.append(dict(rank=pk['rank'], code=pk['code'], **{f'm_{stage}': v, f'exit_{stage}_cat': cat}))
        okp = [p[f'm_{stage}'] for p in prs if p[f'm_{stage}'] is not None]
        dk0 = [p[f'm_{stage}'] for p, pk in zip(prs, fl['picks']) if p[f'm_{stage}'] is not None and pk['DK_s'] == 0]
        pool_ok = [float(ret[i]) for i in range(len(jj)) if buy[i] and np.isfinite(ret[i])]
        out[lid] = dict(picks_outcome=prs, daily_mean_buyable=float(np.mean(okp)) if okp else None, daily_mean_dk0=float(np.mean(dk0)) if dk0 else None,
                        pool_mean_buyable=float(np.mean(pool_ok)) if pool_ok else None, n_buyable_with_ret=len(okp))
    ev = []
    evs = (y_doc or {}).get('events') or []
    if evs:
        ej = _jmap(I, [e['code'] for e in evs])
        ebuy = np.array([bool(e.get('m_buyable')) for e in evs]) & (ej >= 0)
        nan20 = np.full(len(evs), np.nan)                      # 事件列沒有凍結 nan20：停牌／冷門無成交無法區分時歸 NOCLOSE_HALT（只作描述）
        cats = FR.exit_category(R['fin'], np.full(len(evs), s), np.maximum(ej, 0), k, R['asof'], ebuy, nan20)
        for e, j, b, cat in zip(evs, ej, ebuy, cats):
            v = _f(R['ret'][j]) if j >= 0 and b and str(cat) == 'OK' else None
            ev.append(dict(code=e['code'], list_id=e.get('list_id'), rank=e.get('rank'), **{f'm_{stage}': v, f'exit_{stage}_cat': str(cat)}))
    return dict(lists=out, events_outcome=ev)


# ───────────────────────── 摘要（G60／G250 進度）─────────────────────────
def boot_stats(hits, picks, E) -> dict:
    hits, picks, E = (np.asarray(x, np.float64) for x in (hits, picks, E))
    n = len(hits)
    P, H, Es = picks.sum(), hits.sum(), E.sum()
    if n == 0 or P == 0:
        return dict(days=n, picks=int(P), hits=int(H), precision_pct=None, delta_pp=None, delta_ci_pp=None, lift=None, lift_ci=None)
    IDX = EV.boot_index(n)
    bp, br = EV.ratio_b(hits, picks, IDX), EV.ratio_b(E, picks, IDX)
    return dict(days=n, picks=int(P), hits=int(H), E_rand=round(float(Es), 4), precision_pct=round(H / P * 100, 4),
                rand_precision_pct=round(Es / P * 100, 4), delta_pp=round((H - Es) / P * 100, 4), delta_ci_pp=EV.ci(bp - br),
                lift=round(H / Es, 3) if Es > 0 else None, lift_ci=EV.ci(EV.ratio_b(hits, E, IDX), 1, 3) if Es > 0 else None)


def g60_ruling(path: str = None):
    """前向偏差紀錄中使用者對 G60 HALT 的裁定列「G60-RULING: CONTINUE｜HALT …」（取最後一列；沒有＝None）。"""
    import re
    path = path or FR.FWD_DEV_LOG
    out = None
    if os.path.exists(path):
        for ln in open(path, encoding='utf-8'):
            m = re.match(G60_RULING_RE, ln)
            if m:
                out = m.group(1)
    return out


def _ci(st, i):
    ci = (st or {}).get('delta_ci_pp')
    return ci[i] if ci else None


def gate_report(windows: dict, n_scored: int, process: dict, ruling=None) -> dict:
    """G60／G250／G500 的機械判定（登錄 G60、G250、G500）。每個 G 各用自己固定的窗（前 60／250／500 個評分日）。
      · G60：P1～P8 全過且 S0、S_FB 都沒崩壞 ⇒ CONTINUE；否則 HALT-FOR-REVIEW（任一流程檢查無法判定也算沒過）。
      · G250：G60 為 HALT 且前向偏差紀錄沒有「G60-RULING: CONTINUE」⇒ 暫停（verdict＝null，理由寫明）；否則 S0／S_FB 用 g250_keep、R0 用 g250_watch、W 只描述。
      · G500：只對 G250 判 EXTEND 的清單；S0／S_FB 用 g500_final（CONFIRM／DROP），R0 的 CONFIRM＝UPGRADE、DROP＝STAY-WATCH（維持灰底）。"""
    out = dict(n_scored=n_scored, g60=None, g250=None, g500=None)
    w60 = windows.get('g60')
    if w60:
        crash = {lid: FR.g60_crash(_ci(w60.get(lid), 1)) for lid in ('S0_atr14@5', 'SFB_atr14@5')}
        failed = sorted(k for k, v in (process or {}).items() if not (isinstance(v, dict) and v.get('ok') is True))
        outcome = 'CONTINUE' if not failed and not any(crash.values()) else 'HALT-FOR-REVIEW'
        out['g60'] = dict(outcome=outcome, crash=crash, failed_checks=failed, window_days=G60_N, ruling=ruling,
                          note='HALT 時凍結照常、G250 暫停到使用者裁定（裁定寫進前向偏差紀錄 G60-RULING 列）')
    w250 = windows.get('g250')
    if w250:
        g60 = out['g60'] or {}
        if g60.get('outcome') != 'CONTINUE' and ruling != 'CONTINUE':
            out['g250'] = dict(paused=True, verdict={lid: None for lid in FWD_LIST_IDS}, reason='G250 暫停（G60 HALT-FOR-REVIEW，待使用者裁定）')
        else:
            v = {lid: FR.g250_keep(w250[lid].get('delta_pp'), _ci(w250[lid], 0)) for lid in ('S0_atr14@5', 'SFB_atr14@5')}
            v['R0_combo@5'] = FR.g250_watch(w250['R0_combo@5'].get('delta_pp'), _ci(w250['R0_combo@5'], 0))
            v['W_atr14@3'] = 'DESCRIPTIVE'
            out['g250'] = dict(paused=False, verdict=v, window_days=G250_N)
    w500 = windows.get('g500')
    if w500 and out['g250'] and not out['g250']['paused']:
        v = {}
        for lid, g in out['g250']['verdict'].items():
            if g != 'EXTEND':
                continue
            f = FR.g500_final(w500[lid].get('delta_pp'), _ci(w500[lid], 0))
            v[lid] = ('UPGRADE' if f == 'CONFIRM' else 'STAY-WATCH') if lid == 'R0_combo@5' else f
        out['g500'] = dict(verdict=v, window_days=G500_N, note='只對 G250 判 EXTEND 的清單；最終定案、不再延長')
    return out
