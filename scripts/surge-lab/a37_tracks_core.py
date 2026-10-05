"""T1 分軌前向影子：決策日 s 的軌道歸屬、代理排名與 core 凍結內容（登錄 T1-TRACKS-FWD-2026-10-05 §3～§6）。

計算全部走釘選模組（a36_tracks_lib.compute_all、a36_tracks_proxy、a36_tracks_fwd_rules）；本檔只負責「把面板截到 ≤ s、餵前向的輸入、取第 s 列」：
  · 面板、官方漲停價、處置與注意公告一律截到 ≤ s（同 G0.6 截斷測試的 pit 變體：除權息／減資只用生效日 ≤ s，B.adjust 自然略過之後的事件）。
  · 官方漲停價以參數傳入 compute_all(limits=…)（不經 SURGE_OFFICIAL_LIMIT）。
  · 上市日 v3（listing_info_v3、LISTING_SRC_V3）只在本次計算範圍內替換（同 a36_tracks_fwd_verify.v3_patches）。
  · 前向日曆：usable 全 True（v2 衝擊窗與「面板最後 5 日」排除只適用歷史視窗）；視窗記為 FWD（不混進 HC 摘要）。
  · compute_all 的列範圍在截斷面板上＝s 日有收盤的列；D_fwd 另含「近 250 日有收盤、s 日停牌」的列，只作 NE_SUSP 描述（DEV-002 第 4 點）。
  · 處置／注意：v2 coverage_rule 之外另加前向更嚴的未知規則（FDEV-002）：[s−20, s−1] 內任一個 2026-10-02 之後的交易日沒有鏡像定版列
    ⇒ 該市場 DK_s、dp_*、at_known* 記 NaN（「處置狀態未知（來源缺漏）」），R 的 Qmax 隨之未知。只會把值變成未知，不會改變任何池或名單。
影子模式·未扣成本·事後欄位以 m_ 標示·非投資建議。
"""
import contextlib
import gzip
import hashlib
import json
import os
import re

import numpy as np

import a36_tracks_fit as FIT
import a36_tracks_fwd_rules as FR
import a36_tracks_lib as L
import a36_tracks_proxy as PX
import attention as AT
import build as B
import disposal as DP
import official_features as OF
import surge_inputs as SI

import a37_tracks_fwd_io as IO
import a37_tracks_sync as SY

PROXY_LISTS = ('S0_atr14@5', 'SFB_atr14@5', 'R0_combo@5', 'W_atr14@3')
TRACK_LIST = {'S': 'S0_atr14@5', 'Mp': 'SFB_atr14@5', 'R': 'R0_combo@5', 'W': 'W_atr14@3', 'M': 'M0@10'}
EVAL_TRACKS = ('M', 'Mp', 'R', 'S', 'W')
FAIL_BITS = {k: 1 << i for i, k in enumerate(L.FAIL_FLAGS + ('NE_TDR', 'NE_SUSP', 'NE_LU_S'))}
FAIL_TEXT = {'fP10': '收盤<10', 'fP5': '收盤<5', 'fV300': 'vol20<300 張', 'fV100': 'vol20<100 張', 'fVnan': 'vol20 缺值', 'fH125': '近130日有收盤<125日',
             'fA60': '上市未滿60日', 'fN20': '近20日有缺值', 'fBP': '近125日價格結構斷點', 'fCD': '冷卻期（前10日內連板）',
             'NE_TDR': 'TDR（不參與）', 'NE_SUSP': 's 日無收盤', 'NE_LU_S': 's 日已收漲停'}
FWD_WINDOW = 'FWD'
MIN_CLOSES = {'TWSE': 800, 'TPEx': 500}           # s 日兩市收盤檔數下限（C1b；同 a35 名單的上櫃到齊防呆，上市另加）
LIMIT_COVERAGE_MIN = 0.95                         # C2b：s 日有收盤的列中，官方漲停價有值的比例下限（兩市各自；2025-08～2026-10 實測最低 0.9965）
DISP_T_LOOKBACK = 20                              # t 日起處置（m_disp_t_exec）要看的公告日窗：[s−20, s]（實測處置期最長 12 個交易日、起日＝公告次一交易日）
MARKETS = ('TWSE', 'TPEx')
DOMAIN_FEATURES = ('atr14', 'n_lu_250', 'r20', 'c_ma120')
LISTING_DIRS = {'TWSE': ('openapi.twse.com.tw', 'twse_oa_opendata_t187ap03_L', '公司代號', '上市日期', '公司簡稱'),
                'TPEx': ('www.tpex.org.tw', 'tpex_oa_mopsfin_t187ap03_O', 'SecuritiesCompanyCode', 'DateOfListing', 'CompanyAbbreviation')}


def fnum(x):
    """numpy／python 數值 → JSON 可序列化（NaN／inf → None；不捏造 0）。"""
    if x is None:
        return None
    v = float(x)
    return v if np.isfinite(v) else None


def inum(x):
    v = fnum(x)
    return None if v is None else int(v)


# ───────────────────────── 輸入 ─────────────────────────
def load_inputs(p: dict) -> dict:
    """前向快取（同步後）的全部輸入。登錄雜湊（v2 與前向）不符就丟 SystemExit；釘選結果另存（C7 由呼叫端判）。"""
    reg_fwd = FR.load_forward_registration()
    reg_v2 = L.load_registration()
    pins = FR.check_pins(reg_fwd)
    dates, codes, P = B.load_panel()
    dates, codes = [str(d) for d in dates], [str(c) for c in codes]
    if not dates or dates[0] != L.PANEL_START:
        raise IO.Refuse(f'面板起點 {dates[0] if dates else None} ≠ {L.PANEL_START}（登錄 track_assignment.panel_start）')
    base_ev = B.load_factor_events(dates, codes)
    extra = SI.load_extra_exright_items(B.SP)
    events = SI.merge_extra_exright(base_ev, extra)
    U, Dn, ndays = SY.align_limits(OF, p['cache'], dates, codes)
    names = IO.read_json(os.path.join(B.SP, 'names.json')) or {}
    return dict(p=p, reg_fwd=reg_fwd, reg_v2=reg_v2, pins=pins, dates=list(dates), codes=list(codes), P=P, events=events,
                n_extra_exright=len(extra), U=U, limits_days=ndays, intervals=DP.load_intervals(), att_rows=AT.load_rows(),
                mkt=L.market_of_codes(codes), names=names, coverage=SY.load_coverage(p['cache']),
                fw=FIT.check_feature_windows(), panel_sha256=IO.file_sha256(os.path.join(B.SP, 'panel.npz')))


# ───────────────────────── 上市快照（as-of s）─────────────────────────
def _parse_listing(path: str, mkt: str) -> tuple:
    host, ds, ccol, dcol, ncol = LISTING_DIRS[mkt]
    snaps, names = {}, {}
    for r in json.load(gzip.open(path))['payload']:
        c, d8 = str(r[ccol]).strip(), str(r[dcol]).strip()
        if not re.fullmatch(r'\d{8}', d8):
            raise IO.Refuse(f'{path} {c} 上市日期格式 {d8!r}')
        snaps[c] = (mkt, f'{d8[:4]}-{d8[4:6]}-{d8[6:]}')
        n = str(r.get(ncol, '')).strip()
        if n:
            names[c] = n
    return snaps, names


def listing_asof(official_root: str, day: str) -> dict:
    """v2 釘住的 2026-10-02 快照（L.load_listing_snapshots）疊上鏡像中檔名日期 ≤ day 的最新快照（同代號以較新者為準）。"""
    pinned = L.load_listing_snapshots()
    newer, names, files = {}, {}, {}
    for mkt in ('TWSE', 'TPEx'):
        host, ds = LISTING_DIRS[mkt][:2]
        f = FR.latest_snapshot_file(os.path.join(official_root, host, ds), day)
        if f is None:
            files[mkt] = None
            continue
        sn, nm = _parse_listing(f, mkt)
        files[mkt] = dict(file=os.path.relpath(f, official_root), sha256=IO.file_sha256(f))
        for c, v in sn.items():
            if c in newer and newer[c][0] != mkt:          # 同代號出現在兩市最新快照（轉市場過渡）：以檔名日期較新的為準，同日取上市
                other = files['TWSE'] if mkt == 'TPEx' else files[mkt]
                if other and os.path.basename(other['file']) >= os.path.basename(f):
                    continue
            newer[c] = v
        names.update(nm)
    if not pinned:
        raise IO.Refuse('v2 釘住的上市快照讀不到（C5）')
    snaps = FR.merge_snapshots(pinned, newer)
    sha = hashlib.sha256(json.dumps(sorted(snaps.items()), ensure_ascii=False).encode()).hexdigest()
    return dict(snaps=snaps, names=names, files=files, sha256=sha)


# ───────────────────────── 截斷與計算 ─────────────────────────
@contextlib.contextmanager
def v3_patches():
    with L._patched(L, 'listing_info', FR.listing_info_v3), L._patched(L, 'LISTING_SRC', FR.LISTING_SRC_V3):
        yield


def fwd_calendar(T: int) -> dict:
    return dict(usable=np.ones(T, bool), window=np.zeros(T, np.int8), fold=np.full(T, -1, np.int8))


def truncated(I: dict, s: int) -> dict:
    dt = I['dates'][s]
    return dict(dates=I['dates'][:s + 1], P={k: v[:s + 1] for k, v in I['P'].items()}, U=I['U'][:s + 1],
                intervals=[x for x in I['intervals'] if x['pub'] and x['pub'] <= dt],
                att_rows=[r for r in I['att_rows'] if r[1] and r[1] <= dt])


def compute_upto(I: dict, s: int, snaps: dict) -> dict:
    """面板截到 ≤ s 後的 compute_all（with_features=False）。分區 assertion 失敗會丟 AssertionError（C6）。"""
    t = truncated(I, s)
    with v3_patches():
        res = L.compute_all(I['reg_v2'], t['dates'], I['codes'], t['P'], I['events'], snaps, t['intervals'], t['att_rows'], I['mkt'],
                            limits=t['U'], cal=fwd_calendar(s + 1), with_features=False)
    res['_t'] = t
    return res


def strict_unknown(I: dict, s: int) -> tuple:
    """FDEV-002：每個市場在 [s−20, s−1] 內、BASE_TO 之後的交易日，鏡像沒有定版列 ⇒ 該市場（含市場別不明）DK／at 未知。回傳 (disp_mask, att_mask, 說明)。"""
    dates, mkt, cov = I['dates'], I['mkt'], I['coverage']
    lo = max(0, s - 20)
    days = [d for d in dates[lo:s] if d > cov.get('base_to', SY.BASE_TO)]
    dm, am, why = np.zeros(len(mkt), bool), np.zeros(len(mkt), bool), {}
    for src in ('TWSE', 'TPEx'):
        cols = (mkt == src) | (mkt == 'unknown')
        miss_d = [d for d in days if d not in set(cov.get('disposal', {}).get(src, []))]
        miss_a = [d for d in days if d not in set(cov.get('attention', {}).get(src, []))]
        if miss_d:
            dm |= cols
        if miss_a:
            am |= cols
        why[src] = dict(disposal_missing_days=miss_d, attention_missing_days=miss_a)
    return dm, am, why


def ranked_pool(dates, codes, s: int, j: np.ndarray, px: dict, src: str) -> tuple:
    """池內排名（登錄 registered 模式）：回傳 (依名次排序的 j, 分數, combo 有值項數或 None, u)。"""
    s_arr = np.full(len(j), s, np.int64)
    v, n_ok = PX.proxy_scores(s_arr, {c: px[c][j] for c in PX.COMPONENTS}, src, 'registered')
    u = PX.u_hash(dates, codes, s_arr, j) if len(j) else np.zeros(0)
    rk = PX.rank_in_day(s_arr, v, u, 'registered') if len(j) else np.zeros(0, np.int64)
    o = np.argsort(rk, kind='stable')
    return j[o], v[o], (n_ok[o] if n_ok is not None else None), rk[o]


def day_rows(I: dict, s: int, snaps: dict) -> dict:
    """第 s 列的歸屬、旗標、代理、處置與 Qmax（全部只用 ≤ s）。"""
    res = compute_upto(I, s, snaps)
    part, fl, ag, ex = res['part'], res['fl'], res['ages'], res['extra']
    track = part['track'][s].astype(np.int64)
    fails = {k: np.asarray(v[s], bool) for k, v in part['fails'].items()}
    ne = {k: np.broadcast_to(v, res['domain'].shape)[s].astype(bool) for k, v in part['ne'].items()}
    failmask = np.zeros(len(track), np.int64)
    for k, b in FAIL_BITS.items():
        failmask |= np.where((fails[k] if k in fails else ne[k]), b, 0)
    hist_len = ag['hist_len'][s]
    comps = PX.components(res['A'], fl['lu'])
    px = {c: np.where(hist_len < I['fw'][c]['window'], np.nan, comps[c][s]) for c in PX.COMPONENTS}
    dk = ex['dk_s'][s].astype(np.float64).copy()
    at5, at20 = ex['at_known5'][s].astype(np.float64).copy(), ex['at_known20'][s].astype(np.float64).copy()
    dm, am, why = strict_unknown(I, s)
    dk[dm], at5[am], at20[am] = np.nan, np.nan, np.nan
    qmax = L.qmax(track[None, :], fl['vol20'][s][None, :], dk[None, :])[0]
    fin = np.isfinite(I['P']['C'][:s + 1])
    ft = res['lst']['first_trade']
    recent = fin[max(0, s - 249):s + 1].any(0)
    dfwd = (ft <= s) & recent                            # D_fwd(s)：上市日 ≤ s 且近 250 日有收盤（不看未來）
    return dict(res=res, track=track, fails=fails, ne=ne, failmask=failmask, px=px, dk=dk, at5=at5, at20=at20, qmax=qmax,
                vol20=fl['vol20'][s], nan20=fl['nan20'][s], close=I['P']['C'][s], hist_len=hist_len, age_off=ag['age_off'][s],
                listing_src=res['lst']['listing_src'], first_trade=ft, domain=res['domain'][s], dfwd=dfwd, strict_unknown=why,
                checks=part['checks'], lu_s=fl['lu'][s], n_factor_used=res['n_factor_used'])


# ───────────────────────── 名稱與市場 ─────────────────────────
def name_of(I: dict, code: str, lst_names: dict) -> tuple:
    n = I['names'].get(code)
    if isinstance(n, str) and n:
        return n, 'names.json'
    if code in lst_names:
        return lst_names[code], '官方上市（櫃）快照簡稱（現名）'
    return '來源未提供', '來源未提供'


def market_of(I: dict, j: int, code: str, snaps: dict) -> str:
    if code in snaps:
        return snaps[code][0]
    m = I['mkt'][j]
    return m if m in ('TWSE', 'TPEx') else '來源未提供'


def market_array(I: dict, snaps) -> np.ndarray:
    """每個面板代號的市場別（上市快照優先，其次 code_market；都沒有＝「來源未提供」）。snaps＝None 時只用 code_market。"""
    snaps = snaps or {}
    return np.array([market_of(I, j, c, snaps) for j, c in enumerate(I['codes'])])


# ───────────────────────── 完整性（C1b、C2b）─────────────────────────
def closes_by_market(I: dict, s: int, mk: np.ndarray) -> dict:
    """第 s 列（截斷後面板就是這一列）各市場有收盤的檔數。"""
    fin = np.isfinite(I['P']['C'][s])
    return {m: int((fin & (mk == m)).sum()) for m in (*MARKETS, '來源未提供')}


def closes_check(I: dict, s: int, mk: np.ndarray) -> dict:
    """C1b：s 日兩市收盤檔數各自 ≥ MIN_CLOSES（面板缺半個市場就不凍結——凍結檔寫一次、不覆寫）。"""
    n = closes_by_market(I, s, mk)
    short = {m: n[m] for m in MARKETS if n[m] < MIN_CLOSES[m]}
    return dict(ok=not short, counts=n, min=MIN_CLOSES, short=short)


def limit_coverage(I: dict, s: int, mk: np.ndarray) -> dict:
    """第 s 列官方漲停價的覆蓋（s 日有收盤的列）：n_official＝有官方值、n_tick_fallback＝缺官方值、由 v2 檔位推算（登錄 missing_data：逐日揭露件數）。"""
    fin = np.isfinite(I['P']['C'][s])
    has = np.isfinite(I['U'][s])
    out = {}
    for m in (*MARKETS, '來源未提供'):
        sel = fin & (mk == m)
        n, k = int(sel.sum()), int((sel & has).sum())
        out[m] = dict(n_close=n, n_official=k, n_tick_fallback=n - k, coverage=(k / n) if n else None)
    return out


def limit_coverage_check(I: dict, s: int, mk: np.ndarray) -> dict:
    """C2b：兩市各自覆蓋率 ≥ LIMIT_COVERAGE_MIN（鏡像回應格式漂移、解析出 0 列時不會整天無聲退回檔位推算）。"""
    cov = limit_coverage(I, s, mk)
    low = {m: cov[m]['coverage'] for m in MARKETS if cov[m]['coverage'] is None or cov[m]['coverage'] < LIMIT_COVERAGE_MIN}
    return dict(ok=not low, coverage=cov, min=LIMIT_COVERAGE_MIN, low=low)


# ───────────────────────── t 日起處置的涵蓋（m_disp_t_exec）─────────────────────────
def disp_t_unknown(I: dict, s: int) -> tuple:
    """t 日起處置（DISP[t]）取決於公告日在 [s−20, s] 的處置公告（處置起日＝公告次一交易日、處置期最長 12 個交易日）。
    其中 BASE_TO 之後的交易日，若該市場的鏡像帶日期處置資料集沒有定版列 ⇒ 該市場（含市場別不明）的 m_disp_t_exec 記 None＋DTNA，
    不當成「未處置」（FDEV-005）。回傳 (mask over codes, 說明)。"""
    dates, mkt, cov = I['dates'], I['mkt'], I['coverage']
    lo = max(0, s - DISP_T_LOOKBACK)
    days = [d for d in dates[lo:s + 1] if d > cov.get('base_to', SY.BASE_TO)]
    mask, why = np.zeros(len(mkt), bool), {}
    for src in MARKETS:
        have = set(cov.get('disposal', {}).get(src, []))
        miss = [d for d in days if d not in have]
        if miss:
            mask |= (mkt == src) | (mkt == 'unknown')
        why[src] = miss
    return mask, why


# ───────────────────────── 輸入摘要（parity 歸因用）─────────────────────────
def input_digests(I: dict, s: int, snaps_sha: str, code_list=None) -> dict:
    """面板／官方漲停價（只取 code_list 的欄，依代號對齊——之後新上市讓欄位位移也比得了）、除權息、處置、注意、上市快照的雜湊。"""
    t = truncated(I, s)
    h = lambda b: hashlib.sha256(b).hexdigest()
    code_list = list(I['codes']) if code_list is None else list(code_list)
    ci = {c: j for j, c in enumerate(I['codes'])}
    if any(c not in ci for c in code_list):
        return dict(error='面板缺少凍結時的代號', missing=[c for c in code_list if c not in ci][:20])
    idx = np.array([ci[c] for c in code_list], np.int64)
    out = {k: h(np.ascontiguousarray(t['P'][k][:, idx]).tobytes()) for k in ('C', 'V', 'O', 'H', 'L')}
    out['limits'] = h(np.ascontiguousarray(t['U'][:, idx]).tobytes())
    codes_sha = h('\n'.join(code_list).encode())
    dt = I['dates'][s]
    out['factor_events'] = h(json.dumps(sorted([e for e in I['events'] if e[1] <= dt], key=lambda e: (e[1], e[0], e[2])), ensure_ascii=False).encode())
    out['disposal'] = h(json.dumps(sorted((x['code'], x['pub'], x['start'], x['end']) for x in t['intervals']), ensure_ascii=False).encode())
    out['attention'] = h(json.dumps(sorted((r[0], r[1], r[4]) for r in t['att_rows']), ensure_ascii=False).encode())
    out['listing'] = snaps_sha
    out['codes'] = codes_sha
    out['dates'] = h('\n'.join(t['dates']).encode())
    return out


# ───────────────────────── core 凍結內容 ─────────────────────────
def pick_record(I, R, s, j, rank, score, nc, lid, grank, lst_names, snaps) -> dict:
    code = I['codes'][j]
    nm, nsrc = name_of(I, code, lst_names)
    dk = fnum(R['dk'][j])
    spec = FR.FWD_LISTS[lid]
    flags = 'DK1' if dk == 1 else ('DKNA' if dk is None else '')
    return dict(rank=int(rank), code=code, name=nm, name_src=nsrc, market=market_of(I, j, code, snaps), track=L.TRACKS[int(R['track'][j])],
                score=fnum(score), combo_n=inum(nc) if nc is not None else None, close=fnum(R['close'][j]), vol20=fnum(R['vol20'][j]),
                qmax_lots=fnum(R['qmax'][j]), qmax_rule=('floor(1%×vol20)' if spec['track'] == 'S' else '不適用' if spec['track'] == 'W'
                                                         else 'floor(2%×vol20)（R 處置中 1%；DK_s 未知＝未知）' if spec['track'] == 'R' else 'floor(2%×vol20)'),
                DK_s=dk, disposal_status=str(FR.disposal_status([R['dk'][j]])[0]), flags_known=flags,
                flags_known_text=FR.flags_text(flags) if flags else '', at_known5=fnum(R['at5'][j]), at_known20=fnum(R['at20'][j]),
                hist_len=fnum(R['hist_len'][j]), age_off=fnum(R['age_off'][j]), nan20=fnum(R['nan20'][j]),
                listing_src=FR.LISTING_SRC_V3[int(R['listing_src'][j])], global_rank_combo=inum(grank.get(j)),
                atr14=fnum(R['px']['atr14'][j]), n_lu_250=fnum(R['px']['n_lu_250'][j]), r20=fnum(R['px']['r20'][j]), c_ma120=fnum(R['px']['c_ma120'][j]))


def build_core(I: dict, s: int, t_day: str, lst: dict, extra: dict) -> dict:
    """決策日 s 的 core 凍結內容（不含封印）。extra：計畫／條件／時間等呼叫端欄位。"""
    dates, codes = I['dates'], I['codes']
    R = day_rows(I, s, lst['snaps'])
    tr = R['track']
    tid = L.TID
    lists, grank = {}, {}
    allp = np.nonzero(np.isin(tr, [tid[k] for k in EVAL_TRACKS]))[0]
    gj, _, _, grk = ranked_pool(dates, codes, s, allp, R['px'], 'combo')
    grank = {int(j): int(r) for j, r in zip(gj, grk)}
    for lid in PROXY_LISTS:
        spec = FR.FWD_LISTS[lid]
        pj = np.nonzero(np.isin(tr, [tid[k] for k in spec['pool']]))[0]
        oj, v, nc, rk = ranked_pool(dates, codes, s, pj, R['px'], spec['src'])
        K = spec['K']
        pool_codes = [codes[j] for j in oj]
        lists[lid] = dict(
            track=spec['track'], pool=list(spec['pool']), K=K, ranking=spec['src'], section=spec['section'], grey_watch_only=spec['grey'],
            exploratory=spec['exploratory'], label=spec['label'], list_verdict=FR.LIST_VERDICT_FWD[lid], n_pool=int(len(oj)),
            ranked_codes=pool_codes, ranked_scores=[fnum(x) for x in v], ranked_combo_n=([inum(x) for x in nc] if nc is not None else None),
            picks=[pick_record(I, R, s, int(j), rk[i], v[i], (nc[i] if nc is not None else None), lid, grank, lst['names'], lst['snaps'])
                   for i, j in enumerate(oj[:K])],
            rand=dict(seed=FR.rand_seed(dates[s], lid), draw=FR.rand_draw(dates[s], lid, pool_codes, K), picks=int(min(K, len(oj)))))
    dom = np.nonzero(R['domain'])[0]
    susp = np.nonzero(R['dfwd'] & ~R['domain'])[0]
    counts = {name: int((tr == tid[name]).sum()) for name in L.TRACKS}
    counts['NE_SUSP_fwd'] = int(len(susp))
    m_pool = sorted(codes[j] for j in np.nonzero(tr == tid['M'])[0])
    mk = market_array(I, lst['snaps'])
    return dict(
        schema=IO.SCHEMA_CORE, kind=IO.KIND_CORE, registration_id=FR.FWD_REG_ID, registration_sha256=FR.recorded_sha256(),
        parent_registration_sha256=L.REG_SHA256, implementation_pins=I['pins'], date_s=dates[s], s_index=int(s), t=t_day, window=FWD_WINDOW,
        panel=dict(first=dates[0], last_used=dates[s], panel_last=dates[-1], T_used=int(s + 1), N=len(codes), panel_sha256=I['panel_sha256']),
        closes_at_s=closes_by_market(I, s, mk), min_closes=MIN_CLOSES,
        official_limit_coverage=dict(rows=limit_coverage(I, s, mk), min=LIMIT_COVERAGE_MIN,
                                     note='s 日有收盤的列：n_official＝官方漲停價、n_tick_fallback＝缺官方值改用 v2 檔位推算（登錄 missing_data 逐日揭露）'),
        partition_checks={k: bool(v) for k, v in R['checks'].items()},
        track_counts=counts, lists=lists,
        domain=dict(codes=[codes[j] for j in dom], track=[int(tr[j]) for j in dom], failmask=[int(R['failmask'][j]) for j in dom],
                    tracks=list(L.TRACKS), fail_bits=FAIL_BITS, fail_text=FAIL_TEXT, lu_s=[bool(R['lu_s'][j]) for j in dom],
                    features={f: [fnum(R['px'][f][j]) for j in dom] for f in DOMAIN_FEATURES},
                    DK_s=[fnum(R['dk'][j]) for j in dom], at_known5=[fnum(R['at5'][j]) for j in dom],
                    features_note='s 日凍結的四個代理特徵（短歷史 NaN 規則後）、DK_s（含 FDEV-002 未知）、at_known5；命中／漏網記錄的「關鍵特徵」取這裡'),
        ne_susp_fwd=dict(n=int(len(susp)), codes=[codes[j] for j in susp], note='D_fwd：上市日 ≤ s、近 250 日有收盤、s 日停牌（只作描述，不入任何池）'),
        m_pool=dict(n=len(m_pool), codes=m_pool, note='M 軌全部列（M0 前向推論的同日百分位母體；m0ref 另檔）'),
        disposal_attention=dict(strict_unknown=R['strict_unknown'], base_to=I['coverage'].get('base_to'),
                                n_dk_unknown_pools={lid: sum(1 for c in lists[lid]['picks'] if c['DK_s'] is None) for lid in PROXY_LISTS}),
        dataBasis=dict(listing=dict(files=lst['files'], sha256=lst['sha256']), limits_days=I['limits_days'], n_factor_events=len(I['events']),
                       n_extra_exright=I['n_extra_exright'], panel_codes=list(codes), inputs_digest=input_digests(I, s, lst['sha256']),
                       **extra.get('dataBasis', {})),
        fixed_labels=list(FR.FIXED_LABELS), note=IO.NOTE, **{k: v for k, v in extra.items() if k != 'dataBasis'})


def compare_core(frozen: dict, recomputed: dict) -> dict:
    """P3 parity：軌道歸屬、池列數、各清單成員與名次（逐位）；分數另報最大相對差（還原基準不同只會有浮點捨入差）。"""
    diffs = []
    fd, rd = frozen['domain'], recomputed['domain']
    fmap = dict(zip(fd['codes'], fd['track']))
    rmap = dict(zip(rd['codes'], rd['track']))
    for c in sorted(set(fmap) | set(rmap)):
        if fmap.get(c) != rmap.get(c):
            diffs.append(dict(kind='track', code=c, frozen=fmap.get(c), now=rmap.get(c)))
    max_rel = 0.0
    for lid, fl in frozen['lists'].items():
        rl = recomputed['lists'].get(lid)
        if rl is None:
            diffs.append(dict(kind='list_missing', list=lid))
            continue
        if fl['n_pool'] != rl['n_pool']:
            diffs.append(dict(kind='n_pool', list=lid, frozen=fl['n_pool'], now=rl['n_pool']))
        if fl['ranked_codes'] != rl['ranked_codes']:
            diffs.append(dict(kind='rank_order', list=lid, first_diff=next((i for i, (a, b) in enumerate(zip(fl['ranked_codes'], rl['ranked_codes'])) if a != b), None)))
        for a, b in zip(fl['ranked_scores'], rl['ranked_scores']):
            if (a is None) != (b is None):
                diffs.append(dict(kind='score_nan', list=lid))
                break
            if a is not None and a != b:
                max_rel = max(max_rel, abs(a - b) / max(abs(a), 1e-300))
    return dict(equal=not diffs, diffs=diffs[:200], n_diffs=len(diffs), score_max_rel_diff=max_rel)
