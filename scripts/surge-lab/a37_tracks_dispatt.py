"""T1 分軌前向影子：處置／注意鏡像（逐日區間查詢）與 v2 釘住檔（逐月區間查詢）的重疊比對（接線前證明 disp_att_overlap；FDEV-007）。

官方端點的 startDate／endDate 是「查詢區間」，不是「公布日」（2026-10-05 以鏡像 2026-08-21～10-02 共 29 個交易日、四個資料集實證）：
  · 處置（TWSE punish、TPEx bulletin/disposal）回傳「處置期間」與查詢區間重疊的處置（TPEx 標題直寫「處置期間為 …」）；
    ⇒ 鏡像鍵 D（起訖同日）的處置列＝釘住檔中「處置起迄時間」含 D 的列（D 當天公布、次日起處置的那筆不在 D，要到起日才出現）。
  · 注意（TWSE notice、TPEx bulletin/attention）回傳「日期／公告日期」落在查詢區間的公告 ⇒ 鏡像鍵 D＝釘住檔中日期＝D 的列。
  · 「編號」是查詢結果內的序號；處置的「累計」與上市注意的「累計次數」是查詢區間內的計數（同一筆處置單日查 1～2、整月查 3～7）
    ⇒ 這幾欄排除；其餘欄位逐字比對（上櫃注意的「累計」實測與查詢區間無關，照比）。研究口徑（disposal.load_intervals 的區間與 KNOWN、
    attention.pit_features 的 at_cnt5／at_cnt20）都不讀這幾欄。
比對兩層，都要過（四個資料集各自 ≥ MIN_DAYS 個鏡像日，否則 pending）：
  A 列層：每個鏡像日 D ≤ BASE_TO，鏡像列（排除上列欄）＝釘住檔依上列語意對到 D 的列；欄位清單逐字相同。
  B 推導層：把 v2 釘住檔截到「第一個鏡像日的前一天」當 base（處置以公布日、注意以日期截），以前向合併規則 a37_tracks_sync.merge_disp_att
    逐決策日 s 只收「當時已有」的鏡像日（凍結 ≤ s、t 日起處置 ≤ t＋1），用前向的截斷與前向未知規則（a37_tracks_core.strict_unknown／
    disp_t_unknown）推 DK_s、at_known5／20、t 日起處置，與釘住檔推出的值逐檔比較：前向有值的格子必須相同；前向記未知的格子另計（不是不同）。
決定記錄（封印、只寫一次；舊檔永不刪改）：每個比對程式版本（本檔 sha256）第一次落定 pass／fail 寫 prewire/tracks_fwd_dispatt_overlap_<sha256>_<狀態>.json。
  本檔 sha256 要登錄在前向偏差紀錄的「OVERLAP-CHECK: a37_tracks_dispatt.py <sha256>」列；其他版本（含第一版：無 sha 的
  tracks_fwd_dispatt_overlap_{pass,fail}.json 與接線前證明 tracks_fwd_prewire_*.json 內的 fail）封印的 fail，要有
  「OVERLAP-SUPERSEDE: <out/tracks_fwd 內相對路徑> <封印> <FDEV-編號>」列才算被取代——閘門 decision_state 讀這些列。
未扣成本·非投資建議。
"""
import glob
import json
import os
import re
import shutil
import tempfile

import numpy as np

import a37_tracks_fwd_io as IO

CHECK_FILE = os.path.abspath(__file__)
CHECK_NAME = 'a37_tracks_dispatt.py'
MIN_DAYS = 5
DATE_COL = {('disposal', 'TWSE'): '公布日期', ('disposal', 'TPEx'): '公布日期', ('attention', 'TWSE'): '日期', ('attention', 'TPEx'): '公告日期'}
PERIOD_COL = {('disposal', 'TWSE'): '處置起迄時間', ('disposal', 'TPEx'): '處置起訖時間'}
QUERY_DEPENDENT = {('disposal', 'TWSE'): ('編號', '累計'), ('disposal', 'TPEx'): ('編號', '累計'),
                   ('attention', 'TWSE'): ('編號', '累計次數'), ('attention', 'TPEx'): ('編號',)}
DERIVED_FIELDS = ('dk_s', 'at_known5', 'at_known20', 'disp_t_exec')
DECIDED_FMT = 'tracks_fwd_dispatt_overlap_{sha}_{status}.json'
DECIDED_RE = re.compile(r'^tracks_fwd_dispatt_overlap_([0-9a-f]{64})_(pass|fail)\.json$')
LEGACY_DECIDED_RE = re.compile(r'^tracks_fwd_dispatt_overlap_(pass|fail)\.json$')        # 第一版（公布日分組的錯誤比對；無 sha）
PROOF_RE = re.compile(r'^tracks_fwd_prewire_\d{8}T\d{6}\.json$')
CHECK_LINE = re.compile(r'^\s*OVERLAP-CHECK:\s*a37_tracks_dispatt\.py\s+([0-9a-f]{64})\s*$')
SUPERSEDE_LINE = re.compile(r'^\s*OVERLAP-SUPERSEDE:\s*(\S+)\s+([0-9a-f]{64})\s+(FDEV-\d{3})\s*$')
SEMANTICS = ('鏡像鍵 D：處置＝處置起迄含 D 的列、注意＝日期＝D 的列；排除查詢區間相依欄（編號；處置「累計」、上市注意「累計次數」）；'
             '推導層以前向合併＋截斷＋未知規則重建 DK_s／at_known5／at_known20／t 日起處置與釘住檔逐檔比較（FDEV-007）')


def check_sha256() -> str:
    return IO.file_sha256(CHECK_FILE)


# ───────────────────────── A 列層 ─────────────────────────
def _key(row, fields, drop) -> str:
    return json.dumps([v for f, v in zip(fields, row) if f not in drop], ensure_ascii=False)


def pinned_index(kind_mkt, fields, rows):
    """釘住檔（逐月查詢）→ 函式 day ↦ 逐日查詢鍵＝day 時應出現的列（語意見檔頭；口徑用研究模組的 parse_period／iso）。"""
    import attention as AT
    import disposal as DP
    if kind_mkt[0] == 'disposal':
        ip = fields.index(PERIOD_COL[kind_mkt])
        spans = [(DP.parse_period(str(r[ip])), r) for r in rows]
        return lambda day: [r for (a, b), r in spans if a and a <= day <= b]
    idc = fields.index(DATE_COL[kind_mkt])
    by = {}
    for r in rows:
        by.setdefault(AT.iso(r[idc]), []).append(r)
    return lambda day: by.get(day, [])


def row_level(p: dict, upto: str) -> dict:
    """每個資料集：鏡像鍵 ≤ upto 的定版列（ok／定版空表）逐日與釘住檔依正確語意對到同一天的列比對。"""
    import a37_tracks_sync as SY
    res = {}
    for (kind, mkt), (host, mds, fname, code_col) in SY.DISP_ATT.items():
        base = json.load(open(os.path.join(p['cache'], 'base', fname), encoding='utf-8'))
        fields, drop = list(base['fields']), QUERY_DEPENDENT[(kind, mkt)]
        days, mism, n_rows = [], [], 0
        on_day = pinned_index((kind, mkt), fields, base['data'])
        for key, row in sorted(SY.mirror_manifest(p['official_root'], host, mds).items()):
            if key > upto or not SY.accept_row(key, row, upto, statuses=('ok', 'empty')):
                continue
            if row['status'] == 'ok':
                payload, _ = SY.mirror_payload(p['official_root'], host, mds, key, row)
                f2, data = SY._fields_rows(payload, mkt)
            else:
                f2, data = fields, []
            days.append(key)
            fields_equal = f2 is not None and list(f2) == fields
            got = {_key(r, fields, drop) for r in (data or []) if code_col is None or r[code_col]} if fields_equal else set()
            want = {_key(r, fields, drop) for r in on_day(key)}
            n_rows += len(got)
            if not fields_equal or got != want:
                mism.append(dict(day=key, fields_equal=fields_equal, only_mirror=len(got - want), only_pinned=len(want - got),
                                 sample_only_mirror=sorted(got - want)[:2], sample_only_pinned=sorted(want - got)[:2]))
        res[f'{kind}_{mkt}'] = dict(mirror=f'{host}/{mds}', days_compared=len(days), n_mismatched=len(mism), mismatched=mism[:30],
                                    rows_compared=n_rows, first=days[0] if days else None, last=days[-1] if days else None,
                                    excluded_query_dependent=list(drop))
    return res


# ───────────────────────── B 推導層 ─────────────────────────
def _load_research(sp: str):
    import attention as AT
    import disposal as DP
    import a37_tracks_sync as SY
    with SY._patched(DP, 'SP', sp), SY._patched(AT, 'SP', sp):
        return DP.load_intervals(), AT.load_rows()


def _prev_day(iso: str) -> str:
    return IO._add_days(iso, -1)


def _write_cut_base(src_base: str, dst: str, cut: str) -> None:
    """v2 釘住檔截到 cut：處置以公布日、注意以日期（等於 cut 當晚以逐月查詢抓到的內容）。"""
    import attention as AT
    import disposal as DP
    import a37_tracks_sync as SY
    os.makedirs(os.path.join(dst, 'base'), exist_ok=True)
    for (kind, mkt), (_, _, fname, _) in SY.DISP_ATT.items():
        b = json.load(open(os.path.join(src_base, fname), encoding='utf-8'))
        ix = b['fields'].index(DATE_COL[(kind, mkt)])
        day = (lambda v: DP.roc_iso(str(v))) if kind == 'disposal' else AT.iso
        keep = [r for r in b['data'] if (day(r[ix]) or '9999') <= cut]
        with open(os.path.join(dst, 'base', fname), 'w', encoding='utf-8') as f:
            json.dump(dict(b, data=keep), f, ensure_ascii=False)


def _forward_asof(p: dict, work: str, cut: str, upto: str):
    """前向合併規則（base＝釘住檔截到 cut、鏡像 (cut, upto]）→ (處置區間, 注意列, 涵蓋)。"""
    import a37_tracks_sync as SY
    for f in glob.glob(os.path.join(work, '*.json')):
        os.unlink(f)
    with SY._patched(SY, 'BASE_TO', cut):
        SY.merge_disp_att(dict(cache=work, official_root=p['official_root']), upto)
    iv, ar = _load_research(work)
    return iv, ar, SY.load_coverage(work)


def _cmp(fwd: np.ndarray, pin: np.ndarray) -> tuple:
    """前向有值的格子必須等於釘住值（釘住 NaN 也算不同）；前向 NaN 而釘住有值＝前向未知（另計）。回傳 (不同格數, 前向未知格數, 不同的欄位索引)。"""
    fwd, pin = np.asarray(fwd, np.float64), np.asarray(pin, np.float64)
    known = np.isfinite(fwd)
    bad = known & ~(np.isfinite(pin) & (fwd == pin))
    return int(bad.sum()), int((~known & np.isfinite(pin)).sum()), np.nonzero(bad)[0]


def derived_level(p: dict, dates: list, codes: list, mkt, first_day: str, upto: str) -> dict:
    """推導層：重疊期間 [first_day, upto] 的每個面板交易日 s，前向重建的 DK_s／at_known5／20（凍結口徑）與 t 日起處置（評分口徑）vs 釘住檔。"""
    import a36_tracks_lib as L
    import a37_tracks_core as C
    dates, codes = list(dates), list(codes)
    cut = _prev_day(first_day)
    days = [d for d in dates if first_day <= d <= upto]
    piv, par = _load_research(os.path.join(p['cache'], 'base'))
    work = tempfile.mkdtemp(prefix='a37dispatt')
    out = {k: dict(days=0, fully_known_days=0, mismatched_cells=0, unknown_cells=0) for k in DERIVED_FIELDS}
    diffs = []
    try:
        _write_cut_base(os.path.join(p['cache'], 'base'), work, cut)

        def pair(iv, ar, e):
            dt = dates[e]
            return L.disposal_attention(dates[:e + 1], codes, [x for x in iv if x['pub'] and x['pub'] <= dt],
                                        [r for r in ar if r[1] and r[1] <= dt], mkt)
        for d in days:
            s = dates.index(d)
            fiv, far, cov = _forward_asof(p, work, cut, d)                    # 凍結時（s 晚上）只有 ≤ s 的鏡像日
            fI = dict(dates=dates, mkt=mkt, coverage=cov)
            pa, fa = pair(piv, par, s), pair(fiv, far, s)
            dm, am, _ = C.strict_unknown(fI, s)
            fv = dict(dk_s=np.where(dm, np.nan, fa['feats']['dk_s'][s]), at_known5=np.where(am, np.nan, fa['feats']['at_known5'][s]),
                      at_known20=np.where(am, np.nan, fa['feats']['at_known20'][s]))
            for k, v in fv.items():
                nb, nu, js = _cmp(v, pa['feats'][k][s])
                out[k]['days'] += 1
                out[k]['fully_known_days'] += nu == 0
                out[k]['mismatched_cells'] += nb
                out[k]['unknown_cells'] += nu
                if nb:
                    diffs.append(dict(day=d, field=k, codes=[codes[j] for j in js[:10]]))
            if s + 2 < len(dates) and dates[s + 1] <= upto:                   # t 日起處置：評分時（t＋1 晚上）有 ≤ t＋1 的鏡像日
                e = s + 2
                fiv, far, cov = _forward_asof(p, work, cut, min(dates[e], upto))
                pt, ft = pair(piv, par, e)['disp_t_exec'][s].astype(np.float64), pair(fiv, far, e)['disp_t_exec'][s].astype(np.float64)
                um, _ = C.disp_t_unknown(dict(dates=dates, mkt=mkt, coverage=cov), s)
                nb, nu, js = _cmp(np.where(um, np.nan, ft), pt)
                out['disp_t_exec']['days'] += 1
                out['disp_t_exec']['fully_known_days'] += nu == 0
                out['disp_t_exec']['mismatched_cells'] += nb
                out['disp_t_exec']['unknown_cells'] += nu
                if nb:
                    diffs.append(dict(day=d, field='disp_t_exec', codes=[codes[j] for j in js[:10]]))
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return dict(fields=out, diffs=diffs[:30], n_diffs=len(diffs), cut=cut, days=days, first=days[0] if days else None, last=days[-1] if days else None,
                rule='前向有值的格子必須等於釘住值；前向未知（鏡像缺日依前向規則記 NaN、釘住有值）另計 unknown_cells；'
                     f'每個欄位至少 {MIN_DAYS} 個決策日全部格子已知才算有證明')


# ───────────────────────── 合併判定 ─────────────────────────
def overlap_check(p: dict, panel: dict = None) -> dict:
    """panel＝dict(dates, codes, mkt)（面板）；沒有面板就只做列層、狀態最多 pending（推導層是 pass 的必要條件）。"""
    import a37_tracks_sync as SY
    upto = SY.BASE_TO
    rows = row_level(p, upto)
    bad = sum(v['n_mismatched'] for v in rows.values())
    thin = sorted(k for k, v in rows.items() if v['days_compared'] < MIN_DAYS)
    derived, why = None, []
    if thin:
        why.append(f'重疊期間（≤ {upto}）可比的鏡像日不足 {MIN_DAYS} 天：' + '、'.join(f'{k} {rows[k]["days_compared"]} 天' for k in thin))
    if bad:
        why.append('列層不同：' + '、'.join(f'{k} {v["n_mismatched"]} 天' for k, v in rows.items() if v['n_mismatched']))
    if not thin and panel is not None:
        first = max(v['first'] for v in rows.values())                     # 四個資料集都有鏡像的第一天
        derived = derived_level(p, panel['dates'], panel['codes'], panel['mkt'], first, upto)
        if derived['n_diffs']:
            why.append(f'推導層不同 {derived["n_diffs"]} 筆（DK_s／at_known／t 日起處置）')
        short = [k for k, v in derived['fields'].items() if v['fully_known_days'] < MIN_DAYS]
        if short:
            thin.append('derived')
            why.append(f'推導層全部格子已知的決策日不足 {MIN_DAYS} 天：' + '、'.join(short))
    elif panel is None:
        thin.append('derived')
        why.append('沒有面板：推導層未比對')
    status = 'fail' if bad or (derived and derived['n_diffs']) else ('pending' if thin else 'pass')
    return dict(status=status, datasets=rows, derived=derived, min_days=MIN_DAYS, days_total=sum(v['days_compared'] for v in rows.values()),
                why='；'.join(why) or None, semantics=SEMANTICS, check=dict(file=CHECK_NAME, sha256=check_sha256()), computed=IO.iso_tw(IO.now_tw()))


# ───────────────────────── 決定記錄與取代 ─────────────────────────
def registry(devlog: str = None) -> dict:
    """前向偏差紀錄的 OVERLAP-CHECK（登錄的比對程式版本）與 OVERLAP-SUPERSEDE（被取代的封印決定：相對路徑＋封印）列。"""
    import a36_tracks_fwd_rules as FR
    path = devlog or FR.FWD_DEV_LOG
    checks, sup = set(), {}
    if os.path.exists(path):
        for ln in open(path, encoding='utf-8'):
            m = CHECK_LINE.match(ln)
            if m:
                checks.add(m.group(1))
            m = SUPERSEDE_LINE.match(ln)
            if m:
                sup[(m.group(1), m.group(2))] = m.group(3)
    return dict(checks=checks, superseded=sup, path=path)


def decisions(out: str) -> list:
    """out/prewire 內帶處置／注意重疊判定的封印記錄：決定檔（keyed／第一版）與接線前證明。check_sha＝None 代表第一版（無 sha）。"""
    res = []
    for f in sorted(glob.glob(os.path.join(out, 'prewire', '*.json'))):
        name, doc = os.path.basename(f), IO.read_json(f)
        rel = f'prewire/{name}'
        m, ml = DECIDED_RE.match(name), LEGACY_DECIDED_RE.match(name)
        if m or ml:
            sha, st = (m.group(1), m.group(2)) if m else (None, ml.group(1))
            ok = bool(doc) and IO.verify_seal(doc) and doc.get('status') == st and (sha is None or (doc.get('check') or {}).get('sha256') == sha)
            res.append(dict(rel=rel, kind='decision', status=st, check_sha=sha, seal=(doc or {}).get('seal'), seal_ok=ok))
        elif PROOF_RE.match(name):
            ov = ((doc or {}).get('checks') or {}).get('disp_att_overlap') or {}
            st = ov.get('status')
            if st in ('pass', 'fail'):
                res.append(dict(rel=rel, kind='proof', status=st, check_sha=(ov.get('check') or {}).get('sha256'), seal=(doc or {}).get('seal'),
                                seal_ok=bool(doc) and IO.verify_seal(doc)))
    return res


def decision_state(out: str, devlog: str = None, sha: str = None) -> dict:
    """閘門用：本版比對（sha）要登錄；本版已封印 fail ⇒ 擋；其他版本封印的 fail 要有 OVERLAP-SUPERSEDE 列（路徑＋封印都對）才算被取代，否則擋。"""
    cur = sha or check_sha256()
    reg = registry(devlog)
    probs, superseded, current = [], [], []
    if cur not in reg['checks']:
        probs.append(f'處置／注意重疊比對程式 {CHECK_NAME}（sha256 {cur[:12]}…）未登錄於前向偏差紀錄（OVERLAP-CHECK 列）')
    for d in decisions(out):
        if not d['seal_ok']:
            probs.append(f'{d["rel"]} 封印或內容不符')
            continue
        if d['check_sha'] == cur:
            current.append(d)
            if d['status'] == 'fail':
                probs.append(f'本版比對已封印 fail（{d["rel"]}；要改判須另寫前向偏差並換新版比對）')
        elif d['status'] == 'fail':
            fdev = reg['superseded'].get((d['rel'], d['seal']))
            if fdev:
                superseded.append(dict(d, by=fdev))
            else:
                probs.append(f'舊版比對封印的 fail 未被取代（{d["rel"]}；需前向偏差 OVERLAP-SUPERSEDE 列：相對路徑＋封印）')
    return dict(ok=not probs, why='、'.join(probs) if probs else None, check_sha256=cur, registered=cur in reg['checks'],
                current=current, superseded=superseded)


def record_decision(out: str, ov: dict) -> str:
    """本版比對第一次落定 pass／fail ⇒ 寫一次封印決定檔（同版本已有任何決定就不再寫；舊檔一律保留）。"""
    st, sha = ov.get('status'), (ov.get('check') or {}).get('sha256')
    if st not in ('pass', 'fail') or not sha:
        return 'not-decided'
    have = sorted(glob.glob(os.path.join(out, 'prewire', f'tracks_fwd_dispatt_overlap_{sha}_*.json')))
    if have:
        return f'exists:{os.path.basename(have[0])}'
    doc = IO.sealed(dict(ov, kind='t1-tracks-dispatt-overlap', decided_rule='本版比對（check.sha256）第一次落定；舊版決定見 FDEV-007 取代規則'))
    return IO.write_once(os.path.join(out, 'prewire', DECIDED_FMT.format(sha=sha, status=st)), doc)
