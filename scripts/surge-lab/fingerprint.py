"""研究產物的輸入指紋（2026-10-04）：讓「分數／報告」能追溯到確切的輸入版本，口徑混用時拒跑。

file_sha256        檔案位元組的 sha256（json／csv 等小檔）。
npz_content_sha256 npz 的「內容」sha256：依鍵名排序，逐一雜湊 鍵名＋dtype＋shape＋位元組。
                   不受 zip 內的時間戳影響——內容相同的重建得到相同指紋，任何一欄改變（含只改特徵、列不變）都會不同。
                   可傳路徑或已開啟的 np.load 物件（同一個檔案代號＝與實際讀到的內容一致，不怕讀取中被原子替換）。
"""
import hashlib
import os

import numpy as np

CHUNK = 1 << 20


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(CHUNK), b''):
            h.update(b)
    return h.hexdigest()


def npz_content_sha256(src) -> str:
    z = np.load(src) if isinstance(src, (str, os.PathLike)) else src
    h = hashlib.sha256()
    for k in sorted(z.files):
        a = np.ascontiguousarray(z[k])
        h.update(f'{k}|{a.dtype.str}|{a.shape}|'.encode())
        h.update(a.tobytes() if a.dtype != object else repr(a.tolist()).encode())
    return h.hexdigest()


def sha_of(path: str) -> str:
    """npz 取內容指紋、其他檔取位元組指紋。"""
    return npz_content_sha256(path) if path.endswith('.npz') else file_sha256(path)


def _rel(path: str, sp: str) -> str:
    """快取內的檔記相對 SP 的名字（換快取路徑仍可比對）；快取外的記絕對路徑。"""
    ap, root = os.path.abspath(path), os.path.abspath(sp)
    return os.path.relpath(ap, root) if ap.startswith(root + os.sep) else ap


def _resolve(name: str, sp: str) -> str:
    return name if os.path.isabs(name) else os.path.join(sp, name)


def scores_inputs(task: str, dataset_sha: str) -> dict:
    """cv_official 逐列分數所依據的輸入（開跑時記錄）：資料集內容指紋＋月營收檔＋官方漲停價檔（SURGE_OFFICIAL_LIMIT）。"""
    import build as B
    rev = B.revenue_path()
    lim = os.environ.get('SURGE_OFFICIAL_LIMIT') or None
    return dict(dataset=dict(file=f'dataset_{task}_off.npz', sha256=dataset_sha),
                revenue=dict(file=_rel(rev, B.SP), sha256=sha_of(rev)),
                limits=dict(file=_rel(lim, B.SP), sha256=sha_of(lim)) if lim else None)


def verify_inputs(rec: dict, dataset_obj, sp: str) -> list:
    """把分數檔記錄的輸入與現在磁碟上的檔逐項比對；回傳不符清單（空＝全符）。
    dataset_obj：已開啟的 dataset_{task}_off.npz（與分析實際讀的內容同一份）。"""
    bad = []
    cur = npz_content_sha256(dataset_obj)
    if cur != rec['dataset']['sha256']:
        bad.append(f"資料集 {rec['dataset']['file']} 內容 {cur[:12]} ≠ 分數檔記錄 {rec['dataset']['sha256'][:12]}（重建過——要重跑 cv_official）")
    for k in ('revenue', 'limits'):
        r = rec.get(k)
        if not r: continue
        p = _resolve(r['file'], sp)
        if not os.path.isfile(p):
            bad.append(f'{k} 檔 {p} 不在（分數檔依據它）'); continue
        now = sha_of(p)
        if now != r['sha256']:
            bad.append(f"{k} 檔 {r['file']} 現為 {now[:12]} ≠ 分數檔記錄 {r['sha256'][:12]}（輸入已變——重建資料集並重跑 cv_official）")
    return bad
