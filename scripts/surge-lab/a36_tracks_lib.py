"""T1 分軌研究（事前登錄 T1-TRACKS-PREREG-2026-10-04 v2）Phase 0 的共用計算——全面板建置與截斷測試走同一條程式路徑。

只 import 既有函式（build／build_v2／official_features／disposal／attention），不改它們的語意：
  · 漲停、還原、冷卻、vol20／cnt130／nan20／brk_past＝build_v2.main 的同一組公式；brk_future 只當描述欄 m_fBF（前視）。
  · 特徵＝cv_official 'official' 設定的 162 個欄位（build.compute_features＋official_features.compute）＋登錄的額外特徵。
  · 處置 KNOWN＝disposal.build_matrices()['KNOWN']；注意股 at_known5／20＝attention.pit_features 的 at_cnt5／at_cnt20（公告日 ≤ s−1）。
  · 官方上市日：second-brain/official 的兩份 2026-10-02 快照（主 checkout，唯讀）。
所有輸出只用 ≤ s 的資料（brk_future 與 last_close_idx 例外，見登錄 definitions.row_domain）。未扣成本·非投資建議。
"""
import contextlib
import gzip
import hashlib
import json
import os
import re
import subprocess
import sys
import types

import numpy as np
import pandas as pd

import attention as AT
import build as B
import build_v2 as V2
import disposal as DP
import official_features as OF

LAB = os.path.dirname(os.path.abspath(__file__))
REG_JSON = os.path.join(LAB, 'tracks', 'registration_t1_tracks.json')
REG_SHA256 = '065a92c6b063ccfb0bcb5a8facc99734e4f7d769f7af66198953cd7f5592c3e3'
MAIN_REPO = '/Users/gmii/Documents/股票助手app/tw-stock-app'      # 主 checkout：只讀 second-brain/official 與 out/
OLD_LIMIT_COMMIT = 'aadab48fd968c835ff1646d32918912995a7c2ea'      # 240313f 的父 commit（U<9000 上限）

TRACKS = ('NE_TDR', 'NE_SUSP', 'NE_LU_S', 'M', 'Mp', 'R', 'S', 'W')
TID = {t: i for i, t in enumerate(TRACKS)}
NE_IDS = (TID['NE_TDR'], TID['NE_SUSP'], TID['NE_LU_S'])
FAIL_FLAGS = ('fP10', 'fP5', 'fV300', 'fV100', 'fVnan', 'fH125', 'fA60', 'fN20', 'fBP', 'fCD')
LISTING_SRC = ('official_prepanel', 'official', 'transfer_min', 'official_late_first_close', 'fallback_prepanel', 'fallback_first_close', 'no_close')
WINDOW_NAMES = ('NONE', 'HO', 'SEL', 'HC')
PANEL_START = '2022-07-18'
AGE_CAP = 250
R_WIN = 250
QMAX_Q = {'M': 0.02, 'Mp': 0.02, 'R': 0.02, 'S': 0.01}
QMAX_R_DISPOSAL_Q = 0.01
LISTING_SNAPSHOTS = {
    'TWSE': ('second-brain/official/openapi.twse.com.tw/twse_oa_opendata_t187ap03_L/2026-10-02.json.gz', '公司代號', '上市日期'),
    'TPEx': ('second-brain/official/www.tpex.org.tw/tpex_oa_mopsfin_t187ap03_O/2026-10-02.json.gz', 'SecuritiesCompanyCode', 'DateOfListing'),
}
SUSPEND_LISTING = 'second-brain/official/openapi.twse.com.tw/twse_oa_company_suspendListingCsvAndHtml/2026-10-02.json.gz'
R_FEATURES = ('r_seg_len', 'r_days_since_seg_end', 'r_seg_gain', 'r_dd_high20', 'r_n_seg_250')
DISP_FEATURES = ('dk_s', 'dp_cnt20', 'dp_cnt60', 'dp_since', 'dp_n250')
ATT_FEATURES = ('at_known5', 'at_known20')
S1_RAW = ('log10_vol20', 'log10_close')
EXTRA_FEATURES = ('age_cap',) + R_FEATURES + DISP_FEATURES + ATT_FEATURES + S1_RAW
# 偏差 DEV-001（tracks/DEVIATIONS_t1_tracks.md）：窗長表漏列的特徵，依登錄慣例「w 取公式的最長回看」補上；其餘未列者照登錄 assert 失敗
DEV001_WINDOWS = {'rs20': 21, 'log10_vol20': 20, 'log10_close': 1, 'is_R': 0, 'is_S': 0}
NOTE = '未扣成本·事後欄位以 m_ 標示·非投資建議'


# ───────────────────────── 登錄與輸入雜湊 ─────────────────────────
def canonical_sha256(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def load_registration() -> dict:
    obj = json.load(open(REG_JSON, encoding='utf-8'))
    h = canonical_sha256(obj)
    if h != REG_SHA256:
        raise SystemExit(f'登錄 JSON 雜湊 {h} ≠ 封存值 {REG_SHA256}：拒跑')
    return obj


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def resolve_input(key: str) -> str:
    if key.startswith('SURGE_CACHE/'):
        return os.path.join(B.SP, key[len('SURGE_CACHE/'):])
    if key.startswith('repo:'):
        return os.path.join(B.REPO, key[len('repo:'):])
    if key.startswith('main-readonly:'):
        return os.path.join(MAIN_REPO, key[len('main-readonly:'):])
    if key.startswith('second-brain/'):
        return os.path.join(MAIN_REPO, key)
    raise ValueError(f'無法解析的輸入鍵 {key}')


def verify_inputs(reg: dict) -> dict:
    """環境變數、輸入檔與程式碼的 sha256 逐項比對登錄值；任一不符就回報（呼叫端拒跑）。"""
    bad, checked = [], {}
    for k, v in reg['inputs']['env'].items():
        cur = os.path.realpath(sys.executable) if k == 'python' else os.environ.get(k)
        want = os.path.realpath(v) if k == 'python' else v
        checked[f'env:{k}'] = cur == want
        if cur != want:
            bad.append(f'環境 {k}={cur!r} ≠ 登錄 {want!r}')
    for group in ('files_sha256', 'code_sha256'):
        for key, want in reg['inputs'][group].items():
            p = resolve_input(key)
            cur = file_sha256(p) if os.path.isfile(p) else None
            checked[key] = cur == want
            if cur != want:
                bad.append(f'{key}：{cur} ≠ 登錄 {want}')
    return dict(ok=not bad, mismatches=bad, n_checked=len(checked))


# ───────────────────────── 日曆與視窗 ─────────────────────────
def calendar(reg: dict, dates) -> dict:
    """usable＝可產生列的 s 日（排除 build_v2.SHOCK_S 與面板最後 5 日）；window 0 無／1 HO／2 SEL／3 HC；fold＝視窗內折序。"""
    d = np.array(dates)
    T = len(d)
    usable = np.ones(T, bool)
    usable[T - 5:] = False
    usable &= ~((d >= V2.SHOCK_S[0]) & (d <= V2.SHOCK_S[1]))
    window = np.zeros(T, np.int8)
    fold = np.full(T, -1, np.int8)
    for wi, key in ((1, 'HOLDOUT'), (2, 'SELECTION'), (3, 'HALF_CONFIRM')):
        for k, (a, b) in enumerate(reg['windows'][key]['folds']):
            m = (d >= a) & (d < b) & usable
            window[m] = wi
            fold[m] = k
    return dict(usable=usable, window=window, fold=fold)


# ───────────────────────── 官方上市日 ─────────────────────────
def load_listing_snapshots() -> dict:
    out = {}
    for mkt, (rel, ccol, dcol) in LISTING_SNAPSHOTS.items():
        for r in json.load(gzip.open(os.path.join(MAIN_REPO, rel)))['payload']:
            c, d8 = str(r[ccol]).strip(), str(r[dcol]).strip()
            assert re.fullmatch(r'\d{8}', d8), f'{mkt} {c} 上市日期格式 {d8!r}'
            assert c not in out, f'{c} 同時出現在兩份上市快照'
            out[c] = (mkt, f'{d8[:4]}-{d8[4:6]}-{d8[6:]}')
    return out


def listing_info(dates, codes, C, snaps: dict) -> dict:
    """first_trade_idx（float；面板前上市＝−inf；從未有收盤＝+inf）與 listing_src（登錄 definitions.listing 的四條規則）。"""
    d_arr = np.array(dates)
    T, N = C.shape
    fin = np.isfinite(C)
    has = fin.any(0)
    first_close = np.where(has, fin.argmax(0), T)
    last_close = np.where(has, T - 1 - fin[::-1].argmax(0), -1)
    ft = np.empty(N)
    src = np.empty(N, np.int8)
    for j, c in enumerate(codes):
        fc = int(first_close[j])
        if c in snaps:
            lst = snaps[c][1]
            if lst < PANEL_START:
                ft[j], src[j] = -np.inf, LISTING_SRC.index('official_prepanel')
                continue
            li = int(np.searchsorted(d_arr, lst))
            ft[j] = min(li, fc)
            lab = 'official' if li == fc else ('transfer_min' if fc < li else 'official_late_first_close')
            src[j] = LISTING_SRC.index(lab)
        elif not has[j]:
            ft[j], src[j] = np.inf, LISTING_SRC.index('no_close')
        elif fc == 0:
            ft[j], src[j] = -np.inf, LISTING_SRC.index('fallback_prepanel')
        else:
            ft[j], src[j] = fc, LISTING_SRC.index('fallback_first_close')
    return dict(first_trade=ft, listing_src=src, first_close=first_close, last_close=last_close,
                snap_market=np.array([snaps[c][0] if c in snaps else '' for c in codes]))


def ages(T: int, first_trade: np.ndarray) -> dict:
    s = np.arange(T, dtype=np.float64)[:, None]
    ft = first_trade[None, :]
    age_off = s - ft + 1.0                                         # 面板前上市（−inf）＝+inf
    age_cap = np.minimum(age_off, float(AGE_CAP))
    hist_len = s - np.maximum(ft, 0.0) + 1.0
    return dict(age_off=age_off, age_cap=age_cap, hist_len=hist_len)


# ───────────────────────── 旗標與分區 ─────────────────────────
def core_flags(P: dict, A: dict, EV: dict) -> dict:
    """build_v2.main 的同一組濾網（brk_future 只當描述）＋ T1 區段／標籤。"""
    S = V2.segments(EV, A['C'])
    Ca, V = A['C'], P['V']
    vol20 = pd.DataFrame(V).rolling(20, min_periods=15).mean().values
    cnt130 = pd.DataFrame(Ca).notna().astype(float).rolling(B.HIST_WIN, min_periods=1).sum().values
    nan20 = pd.DataFrame(Ca).isna().astype(float).rolling(20, min_periods=1).sum().values
    brk_past = pd.DataFrame(EV['brk'].astype(float)).rolling(B.HIST_NEED, min_periods=1).max().values > 0
    brk_future = np.zeros_like(brk_past)
    for k in range(1, 6):
        brk_future[:-k] |= EV['brk'][k:]
    with np.errstate(invalid='ignore'):
        elig_base = np.isfinite(P['C']) & (P['C'] >= B.MIN_PRICE) & (vol20 >= B.MIN_VOL20) & (cnt130 >= B.HIST_NEED) & (nan20 == 0)
    return dict(vol20=vol20, cnt130=cnt130, nan20=nan20, brk_past=brk_past, brk_future=brk_future, cool1=S['cool1'],
                lu=S['LU'], start1=S['start1'], y=V2.lead(S['start1'], 1), elig_base=elig_base)


def partition(close, fl: dict, age_off, tdr_col, domain) -> dict:
    """登錄 §2：互斥窮盡的軌道（int8，−1＝不在列範圍）、全部沒通過的條件（多標籤）、結構 assertion。"""
    vol20, cnt130, nan20, bp, cd, lu = fl['vol20'], fl['cnt130'], fl['nan20'], fl['brk_past'], fl['cool1'], fl['lu']
    with np.errstate(invalid='ignore'):
        p10, p5 = close >= 10, close >= 5
        v300, v100 = vol20 >= 300, vol20 >= 100
        h125, a60, n20 = cnt130 >= B.HIST_NEED, age_off >= 60, nan20 == 0
    tdr = np.broadcast_to(tdr_col[None, :], close.shape)
    fin = np.isfinite(close)
    base = ~tdr & fin & ~lu
    cond = {'M': p10 & v300 & h125 & n20 & ~bp & ~cd,
            'Mprime': p5 & v300 & a60 & n20 & ~bp & ~cd,
            'R': p5 & v300 & a60 & n20 & ~bp & cd,
            'S': p5 & v100 & ~v300 & a60 & n20 & ~bp & ~cd}
    ind = {'M': cond['M'] & base, 'Mp': cond['Mprime'] & ~cond['M'] & base, 'R': cond['R'] & base, 'S': cond['S'] & base}
    ne = {'NE_TDR': tdr, 'NE_SUSP': ~fin, 'NE_LU_S': lu}
    track = np.full(close.shape, -1, np.int8)
    assigned = np.zeros(close.shape, bool)
    for name in TRACKS:
        m = (ne[name] if name.startswith('NE_') else (ind[name] if name != 'W' else np.ones_like(assigned))) & domain & ~assigned
        track[m] = TID[name]
        assigned |= m
    # ── 結構 assertion（不讀標籤）──
    tot = sum(v.astype(np.int8) for v in ind.values())
    is_ne = ne['NE_TDR'] | ne['NE_SUSP'] | ne['NE_LU_S']
    chk = {
        'sum_I_le_1': bool((tot[domain] <= 1).all()),
        'NE_sum_I_eq_0': bool((tot[domain & is_ne] == 0).all()),
        'label_eq_unique_I': all(bool((track[domain & ~is_ne & ind[k]] == TID[k]).all()) for k in ind)
                            and bool((track[domain & ~is_ne & (tot == 0)] == TID['W']).all()),
        'NE_precedence': bool((track[domain & ne['NE_TDR']] == TID['NE_TDR']).all())
                         and bool((track[domain & ~ne['NE_TDR'] & ne['NE_SUSP']] == TID['NE_SUSP']).all())
                         and bool((track[domain & ~ne['NE_TDR'] & ~ne['NE_SUSP'] & ne['NE_LU_S']] == TID['NE_LU_S']).all()),
        'every_domain_row_one_track': bool((track[domain] >= 0).all()) and bool((track[~domain] == -1).all()),
        'M_subset_Mprime': bool((~cond['M'] | cond['Mprime'])[domain].all()),
        'M_Mp_vs_R_by_cool1': bool(~((cond['M'] | cond['Mprime']) & cond['R'])[domain].any()),
        'M_Mp_vs_S_by_vol20': bool(~((cond['M'] | cond['Mprime']) & cond['S'])[domain].any()),
        'R_vs_S_by_cool1': bool(~(cond['R'] & cond['S'])[domain].any()),
    }
    assert all(chk.values()), f'分區結構 assertion 失敗：{chk}'
    fails = {'fP10': ~p10, 'fP5': ~p5, 'fV300': ~v300, 'fV100': ~v100, 'fVnan': ~np.isfinite(vol20), 'fH125': ~h125,
             'fA60': ~a60, 'fN20': ~n20, 'fBP': bp, 'fCD': cd}
    with np.errstate(invalid='ignore'):
        r_core = (track == TID['R']) & p10 & h125
    return dict(track=track, fails=fails, ne=ne, checks=chk, r_core=r_core)


# ───────────────────────── R 專用特徵 ─────────────────────────
def r_features(LU, Ca, Caprev, Ha, hist_len) -> dict:
    """只用 ≤ s：最近一段已結束（e ≤ s−1 且 LU[e+1]＝否已知）的 ≥2 連板段，段尾 e ∈ [s−250, s−1]。"""
    T, N = LU.shape
    L = LU.astype(bool)
    rl = np.zeros((T, N), np.int32)
    run = np.zeros(N, np.int32)
    for t in range(T):
        run = np.where(L[t], run + 1, 0)
        rl[t] = run
    nxt = np.zeros_like(L)
    nxt[:-1] = L[1:]
    known_next = np.zeros_like(L)
    known_next[:-1] = True                                       # 面板最後一列的 LU[t+1] 未知 ⇒ 不算已結束
    seg_end = L & ~nxt & known_next & (rl >= 2)
    tt = np.arange(T)[:, None]
    start = np.clip(tt - rl + 1, 0, T - 1)
    with np.errstate(invalid='ignore', divide='ignore'):
        gain_end = np.where(seg_end, Ca / np.take_along_axis(Caprev, start, 0) - 1, np.nan)
    last_upto = np.maximum.accumulate(np.where(seg_end, tt, -1), axis=0)
    e = np.vstack([np.full((1, N), -1), last_upto[:-1]])         # 最近一個 ≤ s−1 的段尾
    found = (e >= 0) & (e >= tt - R_WIN)
    ec = np.clip(e, 0, T - 1)
    longh = hist_len >= R_WIN
    seg_len = np.where(found, np.take_along_axis(rl, ec, 0).astype(np.float64), np.where(longh, 0.0, np.nan))
    days = np.where(found, (tt - e).astype(np.float64), np.where(longh, float(R_WIN + 1), np.nan))
    gain = np.where(found, np.take_along_axis(gain_end, ec, 0), np.nan)
    prev = np.zeros_like(L)
    prev[1:] = L[:-1]
    st2 = L & ~prev & nxt & known_next
    st2[0] = False                                               # 同 official_features.lu_traits：面板第一天無法確認前一日
    cs = np.cumsum(st2.astype(np.int32), axis=0)
    roll = cs.copy()
    roll[R_WIN:] = cs[R_WIN:] - cs[:-R_WIN]                       # roll[t]＝Σ st2[t−249..t]
    n_seg = np.full((T, N), np.nan)
    n_seg[1:] = roll[:-1]                                        # Σ st2[s−250..s−1]
    hh = pd.DataFrame(Ha).rolling(20, min_periods=18).max().values
    with np.errstate(invalid='ignore', divide='ignore'):
        dd = Ca / hh - 1
    return dict(r_seg_len=seg_len, r_days_since_seg_end=days, r_seg_gain=gain, r_dd_high20=dd, r_n_seg_250=n_seg)


# ───────────────────────── 處置／注意（含涵蓋檢查）─────────────────────────
def market_of_codes(codes) -> np.ndarray:
    mk = json.load(open(f'{B.SP}/code_market.json'))
    p = f'{B.SP}/a34_code_market_ext.json'
    ext = json.load(open(p)).get('inferred', {}) if os.path.exists(p) else {}
    m = {'tse': 'TWSE', 'otc': 'TPEx'}
    return np.array([m.get(mk.get(c) or ext.get(c), 'unknown') for c in codes])


def coverage(dates, intervals, att_rows, mkt) -> dict:
    """登錄 §5.1：注意股逐交易日零筆 ⇒ [s−20, s−1] 涵蓋該日者 at_known* NaN；處置以月為單位零筆 ⇒ 該月首日～月末後 20 交易日 DK／dp_* NaN。
    處置月檢查只看「完整月」：含面板最後一日的月份資料尚未齊（截斷到 s 時就是 s 所在月），不判零筆（DEV-002）。"""
    d_arr = np.array(dates)
    T = len(d_arr)
    dset = set(dates)
    months = np.array([d[:7] for d in dates])
    out = {'disposal': {}, 'attention': {}}
    disp_mask = np.zeros((T, len(mkt)), bool)
    att_mask = np.zeros((T, len(mkt)), bool)
    for src in ('TWSE', 'TPEx'):
        cols = (mkt == src) | (mkt == 'unknown')
        pubs = [x['pub'] for x in intervals if x['src'] == src and x['pub']]
        bym = pd.Series([p[:7] for p in pubs]).value_counts()
        mlist = sorted(set(months))
        cnt = {m: int(bym.get(m, 0)) for m in mlist}
        complete = mlist[:-1]
        med = float(np.median([cnt[m] for m in mlist]))
        zero = [m for m in complete if cnt[m] == 0]
        for m in zero:
            idx = np.nonzero(months == m)[0]
            disp_mask[idx[0]:min(idx[-1] + 20, T - 1) + 1, cols] = True
        day_cnt = pd.Series(pubs).value_counts()
        nontd = sorted(p for p in pubs if p not in dset)
        out['disposal'][src] = dict(
            monthly=cnt, median=med, zero_months=zero, incomplete_month_not_checked=mlist[-1],
            suspect_months_lt25pct_median={m: v for m, v in cnt.items() if v < 0.25 * med},
            zero_trading_days=int(sum(1 for d in dates if day_cnt.get(d, 0) == 0)),
            pub_on_non_trading_day=[dict(pub=p, mapped_next_trading_day=(dates[int(np.searchsorted(d_arr, p))] if np.searchsorted(d_arr, p) < T else None),
                                         last_trading_day=(dates[int(np.searchsorted(d_arr, p)) - 1] if np.searchsorted(d_arr, p) > 0 else None),
                                         before_panel=p < dates[0]) for p in nontd])
        adays = [d for c, d, cum, txt, s_ in att_rows if s_ == src and d]
        acnt = pd.Series(adays).value_counts()
        zero_days = [d for d in dates if acnt.get(d, 0) == 0]
        for zd in zero_days:
            x = int(np.searchsorted(d_arr, zd))
            att_mask[x + 1:min(x + 20, T - 1) + 1, cols] = True
        nontd_a = [d for d in adays if d not in dset]
        out['attention'][src] = dict(
            zero_trading_days=zero_days, rows=len(adays),
            monthly={m: int(v) for m, v in pd.Series([d[:7] for d in adays]).value_counts().sort_index().items()},
            rows_on_non_trading_day=len(nontd_a), rows_before_panel=int(sum(d < dates[0] for d in nontd_a)),
            rows_non_trading_in_panel=sorted(set(d for d in nontd_a if d >= dates[0])))
    out['disposal_mask_cells'] = int(disp_mask.sum())
    out['attention_mask_cells'] = int(att_mask.sum())
    return dict(report=out, disp_mask=disp_mask, att_mask=att_mask)


def disposal_attention(dates, codes, intervals, att_rows, mkt) -> dict:
    DM = DP.build_matrices(list(dates), list(codes), intervals)
    T = len(dates)
    dpf = DP.features(DM, T)
    with _patched(AT, 'load_rows', lambda: att_rows):
        AM = AT.build_matrices(list(dates), list(codes))
    atf = AT.pit_features(AM, T)
    cov = coverage(dates, intervals, att_rows, mkt)
    dm, am = cov['disp_mask'], cov['att_mask']
    out = {'dk_s': np.where(dm, np.nan, DM['KNOWN'].astype(np.float64))}
    for k in ('dp_cnt20', 'dp_cnt60', 'dp_since', 'dp_n250'):
        out[k] = np.where(dm, np.nan, dpf[k].astype(np.float64))
    out['at_known5'] = np.where(am, np.nan, atf['at_cnt5'].astype(np.float64))
    out['at_known20'] = np.where(am, np.nan, atf['at_cnt20'].astype(np.float64))
    disp_next = np.zeros_like(DM['DISP'])
    disp_next[:-1] = DM['DISP'][1:]
    return dict(feats=out, disp_t_exec=disp_next, coverage=cov['report'], att_miss=AM['miss'])


# ───────────────────────── Qmax 與短歷史 NaN ─────────────────────────
def qmax(track, vol20, dk) -> np.ndarray:
    """floor(q×vol20(s))（張）；R 在處置中 q 減半；R 的 DK_s 未知＝Qmax 未知（NaN，不捏造）；NE／W 不適用（NaN）。"""
    q = np.full(track.shape, np.nan)
    for k in ('M', 'Mp', 'S'):
        q[track == TID[k]] = QMAX_Q[k]
    isr = track == TID['R']
    q[isr & (dk == 1)] = QMAX_R_DISPOSAL_Q
    q[isr & (dk == 0)] = QMAX_Q['R']
    with np.errstate(invalid='ignore'):
        return np.floor(q * vol20 + 1e-9)


def resolve_window(name: str, table: dict):
    if name in DEV001_WINDOWS and name not in table:
        return DEV001_WINDOWS[name], 'DEV-001'
    if name in table:
        return int(table[name]), 'exact'
    for pat, v in table.items():
        if '{k}' in pat:
            m = re.fullmatch(re.escape(pat).replace(re.escape('{k}'), r'(\d+)'), name)
            if m:
                k = int(m.group(1))
                return int(eval(str(v), {'__builtins__': {}}, {'k': k, 'max': max})), pat
        elif pat.endswith('*') and name.startswith(pat[:-1]):
            return int(v), pat
    return None, None


def feature_windows(names, reg: dict) -> dict:
    table = reg['definitions']['short_history_nan_rule']['window_table']
    out, unknown = {}, []
    for n in names:
        w, how = resolve_window(n, table)
        if w is None:
            unknown.append(n)
        else:
            out[n] = dict(window=w, rule=how)
    assert not unknown, f'特徵不在登錄窗長表（亦非 DEV-001 補列）：{unknown}——依登錄拒跑'
    return out


def apply_short_history(x, hist_len, w: int):
    return np.where(hist_len < w, np.nan, x)


def anchored_pct(x, m_vals) -> np.ndarray:
    """登錄 §6：pct(x)＝(#{M<x}＋0.5×#{M=x})÷#{M 有值}；x 為 NaN 或當日 M 無值者 NaN。"""
    v = np.sort(m_vals[np.isfinite(m_vals)])
    out = np.full(len(x), np.nan)
    if len(v) == 0:
        return out
    ok = np.isfinite(x)
    lt = np.searchsorted(v, x[ok], 'left')
    le = np.searchsorted(v, x[ok], 'right')
    out[ok] = (lt + 0.5 * (le - lt)) / len(v)
    return out


# ───────────────────────── 特徵 ─────────────────────────
def official_names(dataset_files) -> list:
    """cv_official 'official' 設定的欄位與順序（逐字同 cv_official.main 的 all_cols）。"""
    names = sorted(k[2:] for k in dataset_files if k.startswith('f_'))
    new_names = {n for gl in OF.GROUPS.values() for n in gl} | {n for gl in OF.EXPERIMENTAL.values() for n in gl}
    base = [n for n in names if not n.startswith('o_') and n not in new_names]
    return [n for n in base if n not in OF.NON_OFFICIAL_BASE] + [n for gl in OF.GROUPS.values() for n in gl if n in names]


@contextlib.contextmanager
def _patched(mod, attr, value):
    old = getattr(mod, attr)
    setattr(mod, attr, value)
    try:
        yield
    finally:
        setattr(mod, attr, old)


def features_all(dates, codes, P, A, EV, elig_base, of_loaders=None) -> dict:
    """build.compute_features（days_since_lu 缺值填 999，同 build_v2）＋official_features.compute。of_loaders＝截斷模式的
    (load_matrices, load_fin) 替身（同一份官方原始檔、只截斷列）。"""
    F = B.compute_features(dates, codes, P, A, EV, elig_base)
    dsl = F['days_since_lu'].copy()
    dsl[~np.isfinite(dsl)] = 999.0
    F['days_since_lu'] = dsl.astype(np.float32)
    if of_loaders is None:
        Fo, cov = OF.compute(dates, codes, P, A, EV)
    else:
        with _patched(OF, 'load_matrices', of_loaders[0]), _patched(OF, 'load_fin', of_loaders[1]):
            Fo, cov = OF.compute(dates, codes, P, A, EV)
    F.update(Fo)
    return F


# ───────────────────────── 主計算（全面板與截斷共用）─────────────────────────
def compute_all(reg, dates, codes, P, factor_events, snaps, intervals, att_rows, mkt, limits=None, of_loaders=None, cal=None,
                adj=None, with_features=True) -> dict:
    """回傳 T×N 結果。limits＝官方漲停價矩陣替身（截斷模式）；None＝依 SURGE_OFFICIAL_LIMIT。cal＝全面板日曆截到 T（截斷模式；
    「面板最後 5 日」是標籤可得性、屬全面板的性質，截斷後不可重算）。adj＝(A, F_day) 替身：截斷測試的「固定還原因子」變體
    （全面板還原價截到 ≤ s；未來除權息只讓 ≤ s 的價格整欄同乘一常數），None＝以 factor_events 重新還原。"""
    T, N = P['C'].shape
    ctx = _patched(B, 'official_limit_up', (lambda T_, N_: limits)) if limits is not None else contextlib.nullcontext()
    with ctx:
        A, F_day, n_used = B.adjust(dates, codes, P, factor_events) if adj is None else (adj[0], adj[1], None)
        EV = B.build_events(P, A, F_day)
        fl = core_flags(P, A, EV)
        cal = calendar(reg, dates) if cal is None else cal
        lst = listing_info(dates, codes, P['C'], snaps)
        ag = ages(T, lst['first_trade'])
        tdr = np.array([len(c) == 4 and c.startswith('91') for c in codes])
        s_idx = np.arange(T)[:, None]
        domain = cal['usable'][:, None] & (lst['first_trade'][None, :] <= s_idx) & (s_idx <= lst['last_close'][None, :])
        part = partition(P['C'], fl, ag['age_off'], tdr, domain)
        da = disposal_attention(dates, codes, intervals, att_rows, mkt)
        rf = r_features(fl['lu'], A['C'], EV['Caprev'], A['H'], ag['hist_len'])
        qm = qmax(part['track'], fl['vol20'], da['feats']['dk_s'])
        extra = {'age_cap': ag['age_cap'], **rf, **da['feats']}
        with np.errstate(invalid='ignore', divide='ignore'):
            extra['log10_vol20'] = np.where(fl['vol20'] > 0, np.log10(np.where(fl['vol20'] > 0, fl['vol20'], 1.0)), np.nan)
            extra['log10_close'] = np.where(P['C'] > 0, np.log10(np.where(P['C'] > 0, P['C'], 1.0)), np.nan)
        F = features_all(dates, codes, P, A, EV, fl['elig_base'], of_loaders) if with_features else None
    return dict(A=A, F_day=F_day, EV=EV, fl=fl, cal=cal, lst=lst, ages=ag, tdr=tdr, domain=domain, part=part, da=da,
                extra=extra, qmax=qm, F=F, n_factor_used=n_used)


def row_snapshot(res: dict, s: int, feat_names) -> dict:
    """第 s 列（全部代號）供截斷比對：歸屬、旗標、上市、Qmax、R／處置／注意、全部特徵。brk_future 與 m_ 欄不列入。"""
    fl, part, ag = res['fl'], res['part'], res['ages']
    snap = {'domain': res['domain'][s], 'track': part['track'][s], 'r_core': part['r_core'][s], 'qmax': res['qmax'][s],
            'first_trade': res['lst']['first_trade'], 'listing_src': res['lst']['listing_src'],
            'age_off': ag['age_off'][s], 'age_cap': ag['age_cap'][s], 'hist_len': ag['hist_len'][s],
            'vol20': fl['vol20'][s], 'cnt130': fl['cnt130'][s], 'nan20': fl['nan20'][s], 'brk_past': fl['brk_past'][s],
            'cool1': fl['cool1'][s], 'lu_s': fl['lu'][s]}
    for k, v in part['fails'].items():
        snap[f'fail_{k}'] = v[s]
    for k, v in part['ne'].items():
        snap[f'ne_{k}'] = np.broadcast_to(v, res['domain'].shape)[s]
    for k, v in res['extra'].items():
        snap[f'x_{k}'] = v[s]
    if res['F'] is not None:
        for n in feat_names:
            snap[f'f_{n}'] = res['F'][n][s]
    return {k: np.array(v) for k, v in snap.items()}


# ───────────────────────── aadab48f 版漲停判定（參考對帳）─────────────────────────
def load_old_build():
    """以 git show 取 aadab48f 的 build.py（只用它的 build_events 漲停判定；其餘沿用現行程式）。"""
    src = subprocess.run(['git', '-C', LAB, 'show', f'{OLD_LIMIT_COMMIT}:scripts/surge-lab/build.py'], capture_output=True, text=True, check=True).stdout
    mod = types.ModuleType('build_aadab48f')
    mod.__file__ = os.path.join(LAB, 'build.py')
    exec(compile(src, f'{OLD_LIMIT_COMMIT[:8]}:build.py', 'exec'), mod.__dict__)
    return mod, hashlib.sha256(src.encode()).hexdigest()
