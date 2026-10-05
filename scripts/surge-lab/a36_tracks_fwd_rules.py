"""T1 分軌前向影子：接線前修正（G1 第 4 項）與前向登錄 T1-TRACKS-FWD-2026-10-05 的純規則（不讀檔、不寫檔、不發網路）。

v2 登錄（T1-TRACKS-PREREG-2026-10-04，sha256 065a92c6…）凍結不改；鎖定的 a36_tracks_{lib,eval,cv,…}.py（HO 摘要內嵌雜湊）也不改。
本檔只「包一層」：前向建置與鎖後驗證都 import 這裡，同一套規則兩邊共用。偏差紀錄 tracks/DEVIATIONS_t1_tracks.md DEV-009 起。

  (i)   選股記錄：舊欄 tradable_status 只代表處置狀態 ⇒ 前向改名 disposal_status（舊檔以 alias_legacy_tradable_status 換名換值）；
        另加清單層級判定 list_verdict（FWD_LISTS）。
  (ii)  「出場日無收盤」與「t 日起處置」同一套旗標（FLAG_TEXT），逐列 flags 與逐日揭露（daily_disclosure）。
  (iii) M0 前向推論的同日百分位母體＝當日 M 軌全部列（rank_pct_by_day 只對母體列排名）。
  (iv)  轉市場股第一筆收盤在面板起點 ⇒ 面板前上市（−∞，transfer_prepanel）；「從未發生」不再填 999：
        censor_since 以窗長 W＋1 表示「W 日內未發生」（右截斷，state＝censored），歷史不足 W 日且未觀察到者 NaN（state＝unknown）。
另含前向 RAND（期望值為主；逐日種子抽樣只作稽核／介面基準）與 G60／G250／G500 的機械判定。
報酬一律未扣成本（成本另列參考，不當門檻）·事後欄位以 m_ 標示·非投資建議。
"""
import hashlib
import json
import os
import re

import numpy as np
import pandas as pd

import a36_tracks_lib as L

FWD_REG_ID = 'T1-TRACKS-FWD-2026-10-05'
FWD_REG_JSON = os.path.join(L.LAB, 'tracks', 'registration_t1_tracks_forward.json')
FWD_REG_MD = os.path.join(L.LAB, 'tracks', 'REGISTRATION_t1_tracks_forward.md')
FWD_DEV_LOG = os.path.join(L.LAB, 'tracks', 'DEVIATIONS_t1_tracks_forward.md')
NOTE = L.NOTE

# ───────────────────────── (iv-a) 上市日：轉市場股的面板起點規則 ─────────────────────────
LISTING_SRC_V2 = L.LISTING_SRC
LISTING_SRC_V3 = LISTING_SRC_V2 + ('transfer_prepanel',)        # 只往後加，舊代碼 0～6 的意義不變
TRANSFER_PREPANEL = LISTING_SRC_V3.index('transfer_prepanel')
_LISTING_INFO_V2 = L.listing_info                                 # import 當下綁定：驗證時會把 L.listing_info 換成 v3，避免遞迴


def listing_info_v3(dates, codes, C, snaps: dict) -> dict:
    """v2 四條規則（L.listing_info）＋修正：快照上市日 ≥ 面板起點、但面板第一筆收盤就在面板第一天（轉市場、面板前已在交易）
    ⇒ first_trade＝−∞、listing_src＝transfer_prepanel（DEV-008 第 6 點的下一輪規則）。其餘列與 v2 逐位相同。"""
    r = _LISTING_INFO_V2(dates, codes, C, snaps)
    ft, src = r['first_trade'].copy(), r['listing_src'].copy()
    m = (src == LISTING_SRC_V2.index('transfer_min')) & (r['first_close'] == 0)
    ft[m] = -np.inf
    src[m] = TRANSFER_PREPANEL
    return dict(r, first_trade=ft, listing_src=src)


def latest_snapshot_file(directory: str, asof: str):
    """官方鏡像目錄中檔名日期 ≤ asof 的最新一份（YYYY-MM-DD.json.gz）；沒有就 None（呼叫端記缺料，不捏造）。"""
    if not os.path.isdir(directory):
        return None
    days = sorted(f[:10] for f in os.listdir(directory) if re.fullmatch(r'\d{4}-\d{2}-\d{2}\.json\.gz', f) and f[:10] <= asof)
    return os.path.join(directory, f'{days[-1]}.json.gz') if days else None


def merge_snapshots(older: dict, newer: dict) -> dict:
    """{代號: (市場, 上市日)}：同代號以較新快照為準；只在舊快照出現的代號（之後下市）保留。"""
    return {**older, **newer}


# ───────────────────────── (iv-b) 「距上次」特徵：不再用 999 ─────────────────────────
SINCE_W = 250                                                     # 登錄窗長表「距上次」類＝250（days_since_lu、dp_since）
SINCE_STATES = ('observed', 'censored', 'unknown')
SINCE_STATE_TEXT = {'observed': '已觀察到（≤ W 日）', 'censored': f'近 {SINCE_W} 日內未發生（右截斷值 {SINCE_W + 1}）',
                    'unknown': '狀態未知（可用歷史 < W 日且未觀察到，或來源缺漏）'}


def censor_since(raw, hist_len, never, W: int = SINCE_W) -> tuple:
    """raw＝距上次事件的交易日數（含當日＝0）；never＝「面板內從未發生」的布林（舊碼 999 或 NaN 由呼叫端轉成這個遮罩）；
    raw 為 NaN 且不屬 never ＝來源缺漏。回傳 (值, 狀態碼 0／1／2)：
      observed  raw ≤ W                         → raw
      censored  (raw > W 或 never) 且 hist_len ≥ W → W＋1（與 r_days_since_seg_end 的 251 一致）
      unknown   其餘（never 但 hist_len < W；來源缺漏） → NaN
    """
    raw = np.asarray(raw, dtype=np.float64)
    never = np.asarray(never, dtype=bool)
    hl = np.asarray(hist_len, dtype=np.float64)
    fin = np.isfinite(raw) & ~never
    obs = fin & (raw <= W)
    cens = ~obs & (never | (fin & (raw > W))) & (hl >= W)
    val = np.where(obs, raw, np.where(cens, float(W + 1), np.nan))
    state = np.where(obs, 0, np.where(cens, 1, 2)).astype(np.int8)
    return val, state


def since_from_legacy(x999, hist_len, W: int = SINCE_W) -> tuple:
    """舊管線（build_v2 的 days_since_lu、disposal.features 的 dp_since）以 999 表示從未發生、NaN 表示來源缺漏 ⇒ censor_since。
    999 也可能是真實天數（面板 1,023 日）——兩者都 > W，在 hist_len ≥ W 時同為 censored，hist_len < W 時不可能是真實值，故無歧義。"""
    x = np.asarray(x999, dtype=np.float64)
    return censor_since(np.where(x == 999.0, np.nan, x), hist_len, x == 999.0, W)


# ───────────────────────── (i) 處置狀態與清單層級判定 ─────────────────────────
DISPOSAL_STATUS = ('非處置（DK_s＝0）', '處置中（DK_s＝1）·交易規則另案登錄', '處置狀態未知（來源缺漏）')
LEGACY_TRADABLE_STATUS = {'可交易（DK_s＝0）': DISPOSAL_STATUS[0],
                          '處置中・交易規則另案登錄（DK_s＝1）': DISPOSAL_STATUS[1],
                          '處置狀態未知（來源缺漏）': DISPOSAL_STATUS[2]}
LEGACY_NOTE = '舊欄 tradable_status 只代表處置狀態（DEV-008 第 3 點）；清單層級判定見 list_verdict'


def disposal_status(dk) -> np.ndarray:
    dk = np.asarray(dk, dtype=np.float64)
    return np.where(dk == 0, DISPOSAL_STATUS[0], np.where(dk == 1, DISPOSAL_STATUS[1], DISPOSAL_STATUS[2])).astype(object)


def alias_legacy_tradable_status(frame: pd.DataFrame) -> pd.DataFrame:
    """讀 v2 鎖定選股記錄時一律經過這裡：tradable_status → disposal_status（值換成處置語意），不留誤導的欄名。"""
    if 'tradable_status' not in frame.columns:
        return frame.copy()
    bad = sorted(set(frame['tradable_status'].dropna()) - set(LEGACY_TRADABLE_STATUS))
    if bad:
        raise ValueError(f'tradable_status 出現未登錄的值 {bad}')
    out = frame.rename(columns={'tradable_status': 'disposal_status'})
    out['disposal_status'] = out['disposal_status'].map(LEGACY_TRADABLE_STATUS)
    return out


LABEL_S0 = '觀察／研究榜·代理 lift 的時間外複製·容量受限·不可交易·待前向確認'
LABEL_SFB = '探索性·' + LABEL_S0
LABEL_GREY = '不可交易，僅觀察（灰底；介面不顯示報酬，研究記錄照算）'
LABEL_M0 = '主榜 M0 參照（M-UNCHANGED）·本研究未作可交易判定'
LABEL_EQ = '等名額對照（描述用，不參與任何判定）'
FIXED_LABELS = ('未扣成本（成本參考：2.8 折來回約 0.38%、全額約 0.585%；只作參考，不當門檻）',
                '交易方法狀態未知（全額交割、變更交易方法、停止信用交易的來源未提供）',
                '容量以 s 日 vol20 估計，未模擬開盤競價量與滑價', '非投資建議')
# 前向清單（登錄 lists 一節；section 不混排，grey＝灰底觀察區，介面不顯示報酬）
FWD_LISTS = {
    'S0_atr14@5': dict(track='S', pool=('S',), K=5, kind='proxy', src='atr14', section='S0', grey=False, exploratory=False,
                       verdict='S-KEEP-AS-SHADOW', label=LABEL_S0, g250='KEEP'),
    'SFB_atr14@5': dict(track='Mp', pool=('Mp',), K=5, kind='proxy', src='atr14', section='S_FB', grey=False, exploratory=True,
                        verdict='SFB-KEEP-AS-SHADOW', label=LABEL_SFB, g250='KEEP'),
    'R0_combo@5': dict(track='R', pool=('R',), K=5, kind='proxy', src='combo', section='R_GREY', grey=True, exploratory=False,
                       verdict='R-WATCH-ONLY', label=LABEL_GREY, g250='WATCH_UPGRADABLE'),
    'W_atr14@3': dict(track='W', pool=('W',), K=3, kind='proxy', src='atr14', section='W_GREY', grey=True, exploratory=False,
                      verdict='W-WATCH-ONLY', label=LABEL_GREY, g250='DESCRIPTIVE'),
    'M0@10': dict(track='M', pool=('M',), K=10, kind='model', src='M0', section='M0_REF', grey=False, exploratory=False,
                  verdict='M-UNCHANGED', label=LABEL_M0, g250='DESCRIPTIVE'),
    'M0@20': dict(track='M', pool=('M',), K=20, kind='model', src='M0', section='EQ_CONTROL', grey=False, exploratory=False,
                  verdict='M-UNCHANGED（等名額對照的對照組）', label=LABEL_EQ, g250='DESCRIPTIVE'),
}
EQUAL_SLOT = dict(composite=('M0@10', 'R0_combo@5', 'S0_atr14@5'), versus='M0@20', label=LABEL_EQ)
LIST_VERDICT_FWD = {k: f'{v["verdict"]}：{v["label"]}' for k, v in FWD_LISTS.items()}


# ───────────────────────── (ii) 同一套旗標：出場日無收盤、t 日起處置 ─────────────────────────
HORIZON_STEPS = {'c5': 5, 'c10': 10}                              # 出場日 e＝s＋k（t＝s＋1 起第 k 個交易日收盤；c5＝close(t+4)）
EXIT_CATS = ('NA', 'OK', 'PENDING', 'NOCLOSE_HALT', 'NOCLOSE_ILLIQ', 'NOCLOSE_UNRESOLVED')
FLAG_TEXT = {
    'DK1': '處置中（DK_s＝1）·交易規則另案登錄',
    'DKNA': '處置狀態未知（來源缺漏）',
    'DISP_T': 't 日起處置（s 日盤後公告、t 日開盤前已知；可交易口徑照算，另列敏感度）',
    'NO_OPEN_T': 't 日無開盤（不可買）',
    'LOCKED_OPEN_T': 't 日開盤鎖漲停（不可買）',
}
for _h in HORIZON_STEPS:
    FLAG_TEXT.update({
        f'{_h.upper()}_PENDING': f'{_h} 尚未到期（出場日未到或資料未齊；研究記錄的面板末端同此）',
        f'{_h.upper()}_NOCLOSE_HALT': f'{_h} 出場日無收盤、之後恢復收盤（推定停牌；報酬未計，不補 0）',
        f'{_h.upper()}_NOCLOSE_ILLIQ': f'{_h} 出場日無成交（推定冷門股：s 日 nan20＞0、之後恢復；報酬未計，不補 0）',
        f'{_h.upper()}_NOCLOSE_UNRESOLVED': f'{_h} 出場日起至記錄時點不再有收盤（下市或長期停牌；報酬未計，不補 0）',
    })
# v2 鎖後補遺（a36_tracks_t1_audit.EXIT_LABEL）的分類 → 本旗標（研究記錄與前向同一套）
AUDIT_CAT_MAP = {'na': 'NA', 'ok': 'OK', 'panel_end': 'PENDING', 'halt_then_resume': 'NOCLOSE_HALT',
                 'illiquid_no_trade': 'NOCLOSE_ILLIQ', 'no_close_after': 'NOCLOSE_UNRESOLVED'}


def next_close_index(fin: np.ndarray) -> np.ndarray:
    """fin[T, N] → 每格 ≥ i 的第一個有收盤的索引（沒有則 T）。"""
    T = fin.shape[0]
    idx = np.where(fin, np.arange(T)[:, None], T)
    return np.minimum.accumulate(idx[::-1], axis=0)[::-1]


def exit_category(fin_close: np.ndarray, s, j, k: int, asof: int, buyable, nan20_s) -> np.ndarray:
    """可買選股在出場日 e＝s＋k 的狀態（只用 ≤ asof 的資料；研究記錄 asof＝面板最後一日）：
    PENDING（e > asof）→ OK（e 有收盤）→ NOCLOSE_UNRESOLVED（(e, asof] 都沒有收盤）→ NOCLOSE_ILLIQ（s 日 nan20＞0）→ NOCLOSE_HALT。
    不可買的選股記 NA。與 a36_tracks_t1_audit.exit_alternatives 的分類逐列等價（asof＝T−1，單元測試）。"""
    s, j = np.asarray(s, np.int64), np.asarray(j, np.int64)
    T = fin_close.shape[0]
    lim = min(int(asof), T - 1)
    e = s + k
    ec = np.clip(e, 0, T - 1)
    nci = next_close_index(fin_close[:lim + 1])
    pend = e > lim
    have = ~pend & fin_close[ec, j]
    after_idx = np.where(pend, lim + 1, nci[np.clip(e, 0, lim), j])
    unresolved = ~pend & ~have & (after_idx > lim)
    illiq = ~pend & ~have & ~unresolved & (np.nan_to_num(np.asarray(nan20_s, np.float64), nan=0.0) > 0)
    cat = np.where(pend, 'PENDING', np.where(have, 'OK', np.where(unresolved, 'NOCLOSE_UNRESOLVED', np.where(illiq, 'NOCLOSE_ILLIQ', 'NOCLOSE_HALT'))))
    return np.where(np.asarray(buyable, bool), cat, 'NA').astype(object)


def pick_flag_codes(dk, disp_t_exec, has_open_t, locked_open_t, cat_c5, cat_c10) -> list:
    """逐列旗標代碼（固定順序）；空字串＝沒有任何旗標。"""
    dk = np.asarray(dk, np.float64)
    out = []
    for d, te, ho, lo, c5, c10 in zip(dk, disp_t_exec, has_open_t, locked_open_t, cat_c5, cat_c10):
        f = []
        if d == 1:
            f.append('DK1')
        elif not d == 0:
            f.append('DKNA')
        if te == 1:
            f.append('DISP_T')
        if not ho:
            f.append('NO_OPEN_T')
        elif lo == 1:
            f.append('LOCKED_OPEN_T')
        for h, c in (('C5', c5), ('C10', c10)):
            if c not in ('NA', 'OK'):
                f.append(f'{h}_{c}')
        out.append(';'.join(f))
    return out


def flags_text(codes: str) -> str:
    return '；'.join(FLAG_TEXT[c] for c in codes.split(';') if c)


def daily_disclosure(picks: pd.DataFrame) -> pd.DataFrame:
    """逐日（date_s × list_id）揭露：選股數、處置三態、t 日起處置、t 日不可買原因、c5／c10 出場狀態件數。
    picks 需有 date_s、list_id、DK_s、m_disp_t_exec、m_buyable、m_has_open_t、m_locked_open、exit_c5_cat、exit_c10_cat。"""
    p = picks
    g = p.assign(
        n_picks=1, n_dk0=(p.DK_s == 0).astype(int), n_dk1=(p.DK_s == 1).astype(int), n_dk_unknown=(~np.isfinite(p.DK_s.astype(float))).astype(int),
        n_disp_t=(p.m_disp_t_exec == 1).astype(int), n_buyable=(p.m_buyable == 1).astype(int),
        n_no_open_t=(~p.m_has_open_t.astype(bool)).astype(int), n_locked_open_t=(p.m_has_open_t.astype(bool) & (p.m_locked_open == 1)).astype(int),
        **{f'n_{h}_{c.lower()}': (p[f'exit_{h}_cat'] == c).astype(int) for h in HORIZON_STEPS for c in EXIT_CATS[1:]})
    cols = [c for c in g.columns if c.startswith('n_')]
    return g.groupby(['date_s', 'list_id'], sort=True)[cols].sum().reset_index()


# ───────────────────────── (iii) M0 同日百分位：母體＝當日 M 軌全部列 ─────────────────────────
def rank_pct_by_day(day, X, rank_mask) -> np.ndarray:
    """cv_official.ranks 的同一算式（groupby(日).rank(pct=True, method='average')，NaN 不參與、仍為 NaN，轉 float32），
    但只對傳入的母體列排名。前向 M0：傳入當日 M 軌全部列（含只卡 brk_future、s 日無法得知的列），不含 TDR（NE_TDR 軌）。
    rank_mask[k]＝False 的欄（mkt_*、原值欄）照原值。"""
    X = np.asarray(X)
    out = np.empty(X.shape, np.float32)
    day = np.asarray(day)
    for k in range(X.shape[1]):
        if rank_mask[k]:
            out[:, k] = pd.Series(X[:, k].astype(np.float64)).groupby(day).rank(pct=True, method='average').values.astype(np.float32)
        else:
            out[:, k] = X[:, k]
    return out


# ───────────────────────── RAND（同日隨機基準）─────────────────────────
def rand_expected(n_pool, n_events, K: int) -> tuple:
    """主口徑（同 v2 metrics.RAND_reference，不抽樣）：picks＝min(K, n)、E[hits]＝事件數×picks÷n（n＝0 時 0）。"""
    n = np.asarray(n_pool, np.float64)
    ev = np.asarray(n_events, np.float64)
    picks = np.minimum(n, K)
    with np.errstate(invalid='ignore', divide='ignore'):
        E = np.where(n > 0, ev * picks / np.maximum(n, 1), 0.0)
    return picks, E


def rand_seed(date_s: str, list_id: str) -> int:
    return int(hashlib.sha256(f'{date_s}|{list_id}|t1fwd-rand'.encode()).hexdigest()[:16], 16)


def rand_draw(date_s: str, list_id: str, pool_codes, K: int) -> list:
    """稽核／介面用的實際隨機名單：池代號升冪排序後，default_rng(rand_seed) 不放回抽 min(K, n) 檔；與名單一起凍結封印，可逐位重現。
    判定一律用 rand_expected（期望值），抽樣名單只作次要描述。"""
    pool = sorted(str(c) for c in pool_codes)
    n = min(int(K), len(pool))
    if n == 0:
        return []
    ix = np.random.default_rng(rand_seed(date_s, list_id)).choice(len(pool), size=n, replace=False)
    return sorted(pool[i] for i in ix)


# ───────────────────────── 前向判定（機械計算）─────────────────────────
def _num(x):
    return None if x is None or not np.isfinite(float(x)) else float(x)


def g250_keep(point, ci_lower) -> str:
    """S0、S_FB（判定為 KEEP 的軌）：依序 DROP（點估計 ≤ 0 或無法計算）→ CONFIRM（CI 下界 > 0）→ EXTEND。互斥且窮盡。"""
    p, lo = _num(point), _num(ci_lower)
    if p is None or p <= 0:
        return 'DROP'
    if lo is not None and lo > 0:
        return 'CONFIRM'
    return 'EXTEND'


def g500_final(point, ci_lower) -> str:
    """EXTEND 之後在 500 個前向評分日定案：點估計 > 0 且 CI 下界 > 0 ⇒ CONFIRM，否則 DROP。"""
    p, lo = _num(point), _num(ci_lower)
    return 'CONFIRM' if p is not None and p > 0 and lo is not None and lo > 0 else 'DROP'


def g250_watch(point, ci_lower) -> str:
    """R0（R-WATCH-ONLY）：只有 CI 下界 > 0 才 UPGRADE（升為 R-KEEP-AS-SHADOW＝觀察／研究榜，仍非可交易）；
    點估計 > 0 但下界 ≤ 0 ⇒ EXTEND（維持灰底到 500 日再以 g500_final 判，CONFIRM＝UPGRADE）；其餘 STAY-WATCH。"""
    p, lo = _num(point), _num(ci_lower)
    if p is not None and p > 0 and lo is not None and lo > 0:
        return 'UPGRADE'
    if p is not None and p > 0:
        return 'EXTEND'
    return 'STAY-WATCH'


def g60_crash(ci_upper) -> bool:
    """G60 崩壞：Δprecision@K(清單 − RAND) 的 95% CI 上界 < 0（顯著比同日隨機差）。"""
    u = _num(ci_upper)
    return u is not None and u < 0


# ───────────────────────── 登錄載入與實作釘選 ─────────────────────────
def recorded_sha256(md_path: str = FWD_REG_MD) -> str:
    """登錄 md 表頭「JSON 封存雜湊」那一列記載的 64 位 hex（登錄 JSON 不含自身雜湊）。"""
    for ln in open(md_path, encoding='utf-8'):
        if 'JSON 封存雜湊' in ln:
            m = re.search(r'`([0-9a-f]{64})`', ln)
            if m:
                return m.group(1)
    raise SystemExit(f'{md_path} 找不到 JSON 封存雜湊：拒跑')


def load_forward_registration(json_path: str = FWD_REG_JSON, md_path: str = FWD_REG_MD) -> dict:
    obj = json.load(open(json_path, encoding='utf-8'))
    h, want = L.canonical_sha256(obj), recorded_sha256(md_path)
    if h != want:
        raise SystemExit(f'前向登錄 JSON 雜湊 {h} ≠ 封存 {want}：拒跑')
    return obj


def pin_updates(log_path: str = FWD_DEV_LOG) -> dict:
    """前向偏差紀錄中的「PIN-UPDATE: <檔名> <sha256>」列（每次改實作都要先寫偏差再更新釘選）。"""
    out = {}
    if os.path.exists(log_path):
        for ln in open(log_path, encoding='utf-8'):
            m = re.match(r'\s*PIN-UPDATE:\s*(\S+)\s+([0-9a-f]{64})\s*$', ln)
            if m:
                out.setdefault(m.group(1), set()).add(m.group(2))
    return out


REPO_ROOT = os.path.dirname(os.path.dirname(L.LAB))                # 釘選鍵是 repo 相對路徑（scripts/surge-lab/…）


def check_pins(reg: dict, root: str = REPO_ROOT, log_path: str = FWD_DEV_LOG) -> dict:
    """登錄 implementation_pins 的每個檔（repo 相對路徑）：sha256 等於登錄值，或列在前向偏差紀錄的 PIN-UPDATE。不符的檔清單供呼叫端拒跑。"""
    ups, bad = pin_updates(log_path), []
    for rel, want in reg['implementation_pins']['files_sha256'].items():
        p = os.path.join(root, rel)
        cur = L.file_sha256(p) if os.path.isfile(p) else None
        if cur != want and cur not in ups.get(rel, set()):
            bad.append(dict(file=rel, now=cur, registered=want))
    return dict(ok=not bad, mismatches=bad)
