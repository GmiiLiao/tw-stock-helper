"""T1 分軌前向影子：0 網路資料同步（官方鏡像 → 前向專用快取 SURGE_CACHE＝.surge-cache-F），只增不改。

只讀：共用快取（SURGE_TRACKS_SHARED，a35 協調器每輪更新的 panel 等）、釘住快取（SURGE_TRACKS_SEED＝.surge-cache-T，只在第一次播種時讀）、
      官方鏡像（OFFICIAL_ROOT＝second-brain/official，manifest 原子寫入、讀取不需加鎖）。
只寫：前向快取（不存在就建立；共用、釘住、研究快取一律不寫——a37_tracks_fwd_io.guard_env）。
  1 播種（一次）：釘住快取 official/ 的 7 個日資料集＋mops_t163sb04 以 cp -c 複製；v2 釘住的處置／注意四檔另存 base/。
  2 每輪複製共用檔（cp -c，記 sha256）：panel.npz、priceEvents.json、exright_delta.json、a35_shadow_exright_*.json、市場別、名稱。
  3 鏡像增量：只收 status＝ok、echo＝鍵、final≠false、鍵 ≤ upto、前向快取還沒有的日子；manifest 有 sha256 時要與檔頭 meta.sha256 相同。
    寫成研究格式 {day, source, raw}（gzip mtime 0、原子寫入）；已存在的日子絕不覆寫。
  4 處置／注意：v2 釘住檔（base/）＋鏡像「帶日期」的區間端點（twse_punish、twse_notice、tpex_bulletin_disposal、tpex_bulletin_attention；
    與研究檔同一組官方端點、起訖同日）逐日列，欄位清單必須與 base 逐字相同（不同就停用該來源並記警示）；完全相同的列去重。
    逐日涵蓋（有定版列＝有答案，含合法空表）另存 disp_att_coverage.json，供前向更嚴的 DK_s／at_known 未知規則（前向偏差 FDEV-002）。
  5 官方漲跌停矩陣：逐日解析（與 official_features.load_matrices 同一組 table_of／num 與欄位）存 limits_parsed/，再依「當前面板」的
    dates／codes 對齊（代號集合是排序後的聯集、新上市會讓欄位位移，所以快取一律以代號字串為鍵），套上櫃「前一面板列」位移與上市優先規則。
    full_limits() 以 official_features.load_matrices 全量重建，測試與 selfcheck 要求兩者逐位相同。
未扣成本·非投資建議。
"""
import contextlib
import glob
import gzip
import json
import os
import re

import numpy as np

import a37_tracks_fwd_io as IO

OFFICIAL_DATASETS = ('twse_limit', 'tpex_daily', 'twse_daily', 'twse_t86', 'twse_qfiis', 'tpex_insti', 'tpex_daytrade')
SEED_EXTRA_DIRS = ('mops_t163sb04',)
MIRROR_MAP = {
    'twse_limit': ('www.twse.com.tw', 'twse_twt84u'), 'tpex_daily': ('www.tpex.org.tw', 'tpex_dailyquotes'),
    'twse_daily': ('www.twse.com.tw', 'twse_mi_index'), 'twse_t86': ('www.twse.com.tw', 'twse_t86'),
    'twse_qfiis': ('www.twse.com.tw', 'twse_mi_qfiis'), 'tpex_insti': ('www.tpex.org.tw', 'tpex_insti_dailytrade'),
    'tpex_daytrade': ('www.tpex.org.tw', 'tpex_intraday_stat'),
}
SHARED_FILES = ('panel.npz', 'priceEvents.json', 'exright_delta.json', 'code_market.json', 'a34_code_market_ext.json', 'names.json')
EXRIGHT_GLOB = 'a35_shadow_exright_*.json'
DISP_ATT = {   # (類別, 市場) → (鏡像主機, 資料集, 研究檔名, 代號欄位置——TPEx 研究抓取只收該欄有值的列)
    ('disposal', 'TWSE'): ('www.twse.com.tw', 'twse_punish', 'disposal_twse.json', None),
    ('disposal', 'TPEx'): ('www.tpex.org.tw', 'tpex_bulletin_disposal', 'disposal_tpex.json', 2),
    ('attention', 'TWSE'): ('www.twse.com.tw', 'twse_notice', 'attention_twse.json', None),
    ('attention', 'TPEx'): ('www.tpex.org.tw', 'tpex_bulletin_attention', 'attention_tpex.json', 1),
}
BASE_TO = '2026-10-02'          # v2 釘住處置／注意檔的涵蓋終點（fetchedAt 2026-10-02 23:10／23:43 台北，含當日公告）
MARKER = '.a37_forward_cache.json'
LIMIT_COLS = {'twse_limit': ('LIMUP', 'LIMDN'), 'tpex_daily': ('NXUP', 'NXDN')}
DAY_FILE_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})\.json\.gz$')


# ───────────────────────── 1 播種 ─────────────────────────
def seed(p: dict) -> dict:
    """第一次建立前向快取：釘住快取只讀、cp -c 複製（已存在的目錄不動）。"""
    F, S = p['cache'], p['seed']
    os.makedirs(F, exist_ok=True)
    done = []
    for ds in OFFICIAL_DATASETS + SEED_EXTRA_DIRS:
        src, dst = os.path.join(S, 'official', ds), os.path.join(F, 'official', ds)
        if not os.path.isdir(dst):
            if not os.path.isdir(src):
                raise IO.Refuse(f'釘住快取缺 official/{ds}（{src}）：無法播種')
            IO.clone_tree(src, dst)
            done.append(f'official/{ds}')
    for k in DISP_ATT.values():
        src, dst = os.path.join(S, k[2]), os.path.join(F, 'base', k[2])
        if not os.path.exists(dst):
            IO.clone_file(src, dst)
            done.append(f'base/{k[2]}')
    mk = os.path.join(F, MARKER)
    if not os.path.exists(mk):
        IO.write_json_atomic(mk, dict(schema='a37.forwardCache.v1', created=IO.iso_tw(IO.now_tw()), seed=S,
                                      base_sha256={k[2]: IO.file_sha256(os.path.join(F, 'base', k[2])) for k in DISP_ATT.values()},
                                      note='T1 分軌前向專用快取（只增不改；共用／釘住快取不寫）'))
    return dict(seeded=done)


# ───────────────────────── 2 共用檔 ─────────────────────────
def copy_shared(p: dict) -> dict:
    out = {}
    for name in SHARED_FILES:
        src = os.path.join(p['shared'], name)
        if os.path.exists(src):
            IO.clone_file(src, os.path.join(p['cache'], name))
            out[name] = IO.file_sha256(os.path.join(p['cache'], name))
        else:
            out[name] = None                                  # 照實記缺（例如 exright_delta 不存在）
    for src in sorted(glob.glob(os.path.join(p['shared'], EXRIGHT_GLOB))):
        dst = os.path.join(p['cache'], os.path.basename(src))
        IO.clone_file(src, dst)
        out[os.path.basename(src)] = IO.file_sha256(dst)
    if out.get('panel.npz') is None:
        raise IO.Refuse(f'共用快取沒有 panel.npz（{p["shared"]}）')
    return out


# ───────────────────────── 3 鏡像增量（官方日資料集）─────────────────────────
def mirror_manifest(root: str, host: str, ds: str) -> dict:
    m = IO.read_json(os.path.join(root, host, ds, '_manifest.json'))
    return (m or {}).get('rows') or {}


def mirror_payload(root: str, host: str, ds: str, key: str, row: dict):
    """回傳 (payload, meta)；manifest 有 sha256 時要與檔頭相同，否則 None（不收）。"""
    f = row.get('file')
    if not f:
        return None, None
    path = os.path.join(root, host, ds, f)
    try:
        o = json.load(gzip.open(path))
    except (OSError, ValueError, EOFError):
        return None, None
    meta = o.get('meta') or {}
    if row.get('sha256') and meta.get('sha256') and row['sha256'] != meta['sha256']:
        return None, None
    return o.get('payload'), meta


def accept_row(key: str, row: dict, upto: str, statuses=('ok',)) -> bool:
    return (row.get('status') in statuses and row.get('echo') == key and row.get('final') is not False and key <= upto)


def day_files(directory: str) -> list:
    return sorted(m.group(1) for f in (os.listdir(directory) if os.path.isdir(directory) else []) for m in [DAY_FILE_RE.match(f)] if m)


def mirror_increments(p: dict, upto: str) -> dict:
    out = {}
    for ds, (host, mds) in MIRROR_MAP.items():
        d = os.path.join(p['cache'], 'official', ds)
        have = set(day_files(d))
        added, skipped = [], []
        for key, row in sorted(mirror_manifest(p['official_root'], host, mds).items()):
            if key in have or not accept_row(key, row, upto):
                continue
            payload, meta = mirror_payload(p['official_root'], host, mds, key, row)
            if payload is None:
                skipped.append(dict(day=key, why='鏡像檔讀不到或 sha256 不符'))
                continue
            IO.gz_json_dump(os.path.join(d, f'{key}.json.gz'), dict(day=key, source=meta.get('url'), raw=payload,
                                                                    mirror=dict(host=host, dataset=mds, sha256=row.get('sha256'))))
            added.append(key)
        days = day_files(d)
        out[ds] = dict(added=added, skipped=skipped, last=days[-1] if days else None, n=len(days))
    return out


# ───────────────────────── 4 處置／注意 ─────────────────────────
def _fields_rows(payload, market: str):
    """區間端點的原始回應 → (fields, rows)；TWSE 是 {fields, data}，TPEx 是 {tables:[{fields, data}]}。認不得就 (None, None)。"""
    if not isinstance(payload, dict):
        return None, None
    if market == 'TWSE':
        return payload.get('fields'), payload.get('data') or []
    tabs = payload.get('tables') or []
    t0 = tabs[0] if tabs and isinstance(tabs[0], dict) else None
    return (t0.get('fields'), t0.get('data') or []) if t0 else (None, None)


def merge_disp_att(p: dict, upto: str) -> dict:
    """base（v2 釘住）＋鏡像逐日列 → 研究格式四檔（disposal.load_intervals／attention.load_rows 直接讀）＋逐日涵蓋。"""
    F = p['cache']
    report, coverage = {}, {'disposal': {}, 'attention': {}, 'base_to': BASE_TO}
    for (kind, mkt), (host, mds, fname, code_col) in DISP_ATT.items():
        base = json.load(open(os.path.join(F, 'base', fname), encoding='utf-8'))
        fields, rows = base['fields'], list(base['data'])
        seen = {json.dumps(r, ensure_ascii=False) for r in rows}
        days_ok, added, problems = [], 0, []
        for key, row in sorted(mirror_manifest(p['official_root'], host, mds).items()):
            if key <= BASE_TO or not accept_row(key, row, upto, statuses=('ok', 'empty')):
                continue
            if row['status'] == 'empty':
                days_ok.append(key)                            # 定版的合法空表＝該日確定沒有公告
                continue
            payload, _ = mirror_payload(p['official_root'], host, mds, key, row)
            f2, data = _fields_rows(payload, mkt)
            if f2 is None:
                problems.append(dict(day=key, why='回應格式認不得'))
                continue
            if list(f2) != list(fields):
                problems.append(dict(day=key, why=f'欄位與 v2 釘住檔不同：{f2}'))
                continue
            for r in data:
                if code_col is not None and not r[code_col]:
                    continue
                k = json.dumps(r, ensure_ascii=False)
                if k not in seen:
                    seen.add(k)
                    rows.append(r)
                    added += 1
            days_ok.append(key)
        if problems:                                           # 欄位漂移：這個來源整個不採用（不讓半套資料看起來像有答案）
            rows, days_ok = list(base['data']), []
        IO.write_json_atomic(os.path.join(F, fname), dict(fields=fields, data=rows, base=os.path.join('base', fname),
                                                          mirror=f'{host}/{mds}', mirror_days=days_ok))
        coverage[kind][mkt] = days_ok
        report[f'{kind}_{mkt}'] = dict(mirror=f'{host}/{mds}', days=len(days_ok), last=days_ok[-1] if days_ok else None,
                                      rows_added=added if not problems else 0, problems=problems[:20])
    IO.write_json_atomic(os.path.join(F, 'disp_att_coverage.json'), coverage)
    return report


def load_coverage(cache: str) -> dict:
    return IO.read_json(os.path.join(cache, 'disp_att_coverage.json')) or {'disposal': {}, 'attention': {}, 'base_to': BASE_TO}


# ───────────────────────── 5 官方漲跌停矩陣（逐日解析＋對齊）─────────────────────────
def _parse_day(OF, path: str, ds: str):
    """official_features.load_matrices 的同一組解析（table_of／num／欄位）；同代號後列覆蓋前列（put 的行為）。"""
    raw = json.load(gzip.open(path))['raw']
    if ds == 'twse_limit':
        f, d = OF.table_of(raw, '漲停價', '證券代號')
        if not f:
            return np.zeros(0, 'U1'), {}
        ic, cols = f.index('證券代號'), {'LIMUP': f.index('漲停價'), 'LIMDN': f.index('跌停價')}
    else:
        f, d = OF.table_of(raw, '成交筆數', '代號')
        if not f or '次日 漲停價' not in f:
            return np.zeros(0, 'U1'), {}
        ic, cols = f.index('代號'), {'NXUP': f.index('次日 漲停價'), 'NXDN': f.index('次日 跌停價')}
    last = {}
    for row in d:
        last[str(row[ic]).strip()] = row                     # 後列覆蓋前列
    codes = np.array(list(last.keys()), dtype=str) if last else np.zeros(0, 'U1')
    vals = {k: np.array([OF.num(r[i]) for r in last.values()], dtype=np.float64) for k, i in cols.items()}
    return codes, vals


def parsed_day(OF, cache: str, ds: str, day: str):
    """逐日解析快取：limits_parsed/{ds}/{day}.npz（以來源檔大小＋mtime_ns 判斷要不要重解析）。"""
    src = os.path.join(cache, 'official', ds, f'{day}.json.gz')
    st = os.stat(src)
    tag = np.array([st.st_size, st.st_mtime_ns], dtype=np.int64)
    pc = os.path.join(cache, 'limits_parsed', ds, f'{day}.npz')
    if os.path.exists(pc):
        z = np.load(pc)
        if np.array_equal(z['tag'], tag):
            return z['codes'], {k: z[k] for k in LIMIT_COLS[ds]}
    codes, vals = _parse_day(OF, src, ds)
    vals = {k: vals.get(k, np.zeros(0)) for k in LIMIT_COLS[ds]}
    os.makedirs(os.path.dirname(pc), exist_ok=True)
    tmp = f'{pc}.tmp{os.getpid()}.npz'
    np.savez_compressed(tmp, tag=tag, codes=codes, **vals)         # 上櫃日行情含權證約 1.2 萬列：壓縮後約十分之一
    os.replace(tmp, pc)
    return codes, vals


def align_limits(OF, cache: str, dates, codes) -> tuple:
    """當前面板 dates×codes 的官方 LIMUP／LIMDN（T×N float64），與 official_features.load_matrices 的 LIMUP／LIMDN 逐位相同。"""
    T, N = len(dates), len(codes)
    carr = np.asarray(codes)
    order = np.argsort(carr)
    sc = carr[order]
    M = {k: np.full((T, N), np.nan) for k in ('LIMUP', 'LIMDN', 'NXUP', 'NXDN')}
    n_days = {}
    for ds in ('twse_limit', 'tpex_daily'):
        have = set(day_files(os.path.join(cache, 'official', ds)))
        n_days[ds] = 0
        for t, day in enumerate(dates):
            if day not in have:
                continue
            pc, vals = parsed_day(OF, cache, ds, day)
            n_days[ds] += 1
            if not len(pc):
                continue
            pos = np.clip(np.searchsorted(sc, pc), 0, len(sc) - 1)
            ok = sc[pos] == pc
            j = order[pos[ok]]
            for k in LIMIT_COLS[ds]:
                M[k][t, j] = vals[k][ok]
    nxu, nxd = np.full((T, N), np.nan), np.full((T, N), np.nan)
    nxu[1:], nxd[1:] = M['NXUP'][:-1], M['NXDN'][:-1]
    U = np.where(np.isfinite(M['LIMUP']), M['LIMUP'], nxu)
    D = np.where(np.isfinite(M['LIMDN']), M['LIMDN'], nxd)
    return U, D, n_days


def full_limits(OF, cache: str, dates, codes) -> tuple:
    """official_features.load_matrices 的全量重建（只換讀取目錄；用來證明增量對齊逐位相同）。"""
    with _patched(OF, 'OFF', os.path.join(cache, 'official')):
        M, _ = OF.load_matrices(list(dates), list(codes))
    return M['LIMUP'], M['LIMDN']


@contextlib.contextmanager
def _patched(mod, attr, value):
    old = getattr(mod, attr)
    setattr(mod, attr, value)
    try:
        yield
    finally:
        setattr(mod, attr, old)


def arrays_equal(a, b) -> bool:
    a, b = np.asarray(a), np.asarray(b)
    return a.shape == b.shape and bool(np.array_equal(a, b, equal_nan=True))


# ───────────────────────── 一輪同步 ─────────────────────────
def sync(p: dict, upto: str) -> dict:
    s = seed(p)
    shared = copy_shared(p)
    inc = mirror_increments(p, upto)
    da = merge_disp_att(p, upto)
    man = dict(schema='a37.sync.v1', time=IO.iso_tw(IO.now_tw()), upto=upto, seed=s, shared_sha256=shared, official=inc, disp_att=da,
               official_root=p['official_root'])
    IO.write_json_atomic(os.path.join(p['cache'], 'a37_sync_manifest.json'), man)
    return man
