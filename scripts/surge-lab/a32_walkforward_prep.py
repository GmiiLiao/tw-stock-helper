"""a32_walkforward 步驟 1：從 dataset_lu1.npz 組出逐月前推（walk-forward）比較用的特徵矩陣。

特徵（共 124 欄）：
  · 109 個 f_*（非大盤類）→ 同日百分位（pandas groupby(s).rank(pct=True)；NaN 保留為 NaN，GBDT 另成缺值箱）
  · 8 個 f_mkt_*（同日不變的大盤欄）→ 原值
  · x_lu_s、x_oneword_s、x_close_at_high、x_lu_streak、log(x_price)、log(x_vol20)、m_otc
  · 不含尾盤五檔 x_bd_*（2026-07-20 起才有）
輸出：{SURGE_CACHE}/a32_walkforward_X.npy（float32，約 1.5M×124，memmap）與 a32_walkforward_meta.npz，
      ＋側檔 a32_walkforward_build.json（2026-10-04 起；起漲影子每日流程據此判斷「訓練矩陣與上線特徵是否同一版」）：
      buildId＝X 檔案雜湊＋meta 內容雜湊（matrix_build_id；同資料重建得同一個 id）；inputs／revenueSha256＝build_lu1.py 建 dataset 時的輸入雜湊清單
      （surge_inputs.input_manifest：營收、除權息／減資、產業、市場別、逐日補抓除權息）——取自 dataset 側檔，且 dataset 檔的雜湊要對得上、
      建置時沒有研究用環境變數才採信；否則記 null，不猜。
快取目錄＝環境變數 SURGE_CACHE，否則本檔所在目錄的 .surge-cache（2026-10-04 前寫死後者）。
寫入是原子的：先寫暫存檔再 os.replace——正在 memmap 讀舊矩陣的程序不會讀到半套。
"""
import os
import json
import time
import hashlib
import datetime
import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SP = os.environ.get('SURGE_CACHE', os.path.join(HERE, '.surge-cache'))
DS = os.path.join(SP, 'dataset_lu1.npz')
DS_SIDECAR = os.path.join(SP, 'dataset_lu1.build.json')
X_OUT = os.path.join(SP, 'a32_walkforward_X.npy')
META_OUT = os.path.join(SP, 'a32_walkforward_meta.npz')
SIDECAR_OUT = os.path.join(SP, 'a32_walkforward_build.json')
RAW_PREFIX = 'f_mkt_'
X_FLAGS = ('x_lu_s', 'x_oneword_s', 'x_close_at_high', 'x_lu_streak')
META = ('m_s', 'm_j', 'm_y', 'm_y2', 'm_lu_s', 'm_locked1', 'm_buy_lu', 'm_otc', 'm_oc1', 'm_cc1')
TZ = datetime.timezone(datetime.timedelta(hours=8))


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 24), b''): h.update(b)
    return h.hexdigest()


def npz_content_sha256(path: str) -> str:
    """npz 的內容雜湊（逐陣列：名稱、dtype、shape、位元組）——np.savez 的 zip 帶寫入時刻，檔案位元組每次都不同，不能直接雜湊檔案。"""
    h = hashlib.sha256()
    with np.load(path, allow_pickle=False) as z:
        for k in sorted(z.files):
            a = np.ascontiguousarray(z[k])
            h.update(k.encode()); h.update(str(a.dtype).encode()); h.update(str(a.shape).encode()); h.update(a.tobytes())
    return h.hexdigest()


def matrix_build_id(x_path: str, meta_path: str) -> str:
    """訓練矩陣的內容識別碼＝sha256(X.npy 檔案雜湊＋meta.npz 內容雜湊)；同資料重建得到同一個 id（a35_shadow_lib.matrix_id 用同一支）。"""
    return hashlib.sha256((file_sha256(x_path) + npz_content_sha256(meta_path)).encode()).hexdigest()


def dataset_sidecar_trusted(ds_sidecar: dict, ds_sha: str) -> bool:
    """dataset 側檔描述的正是這份 dataset 檔（雜湊相符），且建置時沒有研究用環境變數（官方漲停價／營收版本／PIT 嚴格／後綴）。"""
    return bool(ds_sidecar) and ds_sidecar.get('datasetSha256') == ds_sha and not ds_sidecar.get('env')


def dataset_revenue_sha(ds_sidecar: dict, ds_sha: str) -> str:
    """dataset 側檔記的營收檔雜湊——側檔可信（dataset_sidecar_trusted）才採信，否則 None。"""
    return (ds_sidecar.get('revenueSha256') or None) if dataset_sidecar_trusted(ds_sidecar, ds_sha) else None


def dataset_inputs(ds_sidecar: dict, ds_sha: str) -> dict:
    """dataset 側檔記的輸入雜湊清單——側檔可信才採信，否則 None（舊版 v1 側檔沒有清單也是 None）。"""
    return (ds_sidecar.get('inputs') or None) if dataset_sidecar_trusted(ds_sidecar, ds_sha) else None


def main() -> None:
    t0 = time.time()
    ds_sha = file_sha256(DS)
    z = np.load(DS)
    s = z['m_s']
    fnames = [k for k in z.files if k.startswith('f_')]
    names = ([f'pct_{k}' for k in fnames if not k.startswith(RAW_PREFIX)] + [k for k in fnames if k.startswith(RAW_PREFIX)]
             + list(X_FLAGS) + ['log_x_price', 'log_x_vol20', 'm_otc'])
    n = len(s)
    x_tmp, meta_tmp = f'{X_OUT}.tmp{os.getpid()}', f'{META_OUT}.tmp{os.getpid()}'
    X = np.lib.format.open_memmap(x_tmp, mode='w+', dtype=np.float32, shape=(n, len(names)))
    col = 0
    for k in fnames:
        if k.startswith(RAW_PREFIX): continue
        v = z[k].astype(np.float64)
        v[~np.isfinite(v)] = np.nan
        X[:, col] = pd.Series(v).groupby(s).rank(pct=True, method='average').values.astype(np.float32); col += 1
    for k in fnames:
        if not k.startswith(RAW_PREFIX): continue
        X[:, col] = z[k]; col += 1
    for k in X_FLAGS:
        X[:, col] = z[k]; col += 1
    with np.errstate(divide='ignore', invalid='ignore'):
        X[:, col] = np.log(np.maximum(z['x_price'], 1e-6)); col += 1
        X[:, col] = np.log1p(np.maximum(z['x_vol20'], 0)); col += 1
    X[:, col] = z['m_otc']; col += 1
    assert col == len(names), (col, len(names))
    X.flush()
    # 大盤欄同日不變的檢查（若非同日不變，原值也仍是合理特徵，只做提示）
    for k in fnames:
        if k.startswith(RAW_PREFIX):
            sd = pd.Series(z[k][:300000]).groupby(s[:300000]).std().fillna(0).median()
            print(f'{k} 同日標準差中位數 {sd:.2e}')
    dates = z['dates'].astype(str)
    with open(meta_tmp, 'wb') as f:
        np.savez(f, names=np.array(names), dates=dates, codes=z['codes'].astype(str), **{k: z[k] for k in META})
    nan_share = np.isnan(np.asarray(X[::50])).mean(0)
    del X
    x_sha, meta_sha = file_sha256(x_tmp), npz_content_sha256(meta_tmp)
    os.replace(meta_tmp, META_OUT)
    os.replace(x_tmp, X_OUT)
    ds_side = None
    try:
        with open(DS_SIDECAR, encoding='utf-8') as f: ds_side = json.load(f)
    except (OSError, ValueError):
        pass
    max_s = int(s.max())
    side = dict(schema='a32.walkforward.build.v2', generatedAt=datetime.datetime.now(TZ).isoformat(timespec='seconds'),
                buildId=hashlib.sha256((x_sha + meta_sha).encode()).hexdigest(), xSha256=x_sha, metaContentSha256=meta_sha,
                rows=int(n), features=len(names), maxS=str(dates[max_s]), maxSIdx=max_s, lastDate=str(dates[-1]),
                datasetSha256=ds_sha, revenueSha256=dataset_revenue_sha(ds_side, ds_sha), inputs=dataset_inputs(ds_side, ds_sha), dataset=ds_side)
    tmp = f'{SIDECAR_OUT}.tmp{os.getpid()}'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(side, f, ensure_ascii=False, indent=1, sort_keys=True)
    os.replace(tmp, SIDECAR_OUT)
    print(f'特徵 {len(names)}；NaN 比例最高 5 欄：' + '、'.join(f'{names[i]} {nan_share[i] * 100:.1f}%' for i in np.argsort(-nan_share)[:5]))
    print(f'側檔 {SIDECAR_OUT}：buildId {side["buildId"][:12]}、最晚 s {side["maxS"]}、revenue.json {(side["revenueSha256"] or "未知")[:12]}')
    print(f'完成 {time.time() - t0:.0f}s')


if __name__ == '__main__':
    main()
