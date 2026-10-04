"""訓練矩陣（build_lu1.py → a32_walkforward_prep.py）與起漲影子上線特徵（a35_shadow_lib.build_ctx）共用的輸入清單（2026-10-04 審查）。

為什麼要有這份清單
  · 「訓練矩陣與上線特徵是不是同一版資料」原本只比 revenue.json。但同時餵矩陣與上線特徵、且每次 fetch_cache 都可能更新的
    還有除權息／減資係數（exright-history、exright_delta、priceEvents、a35_shadow_exright_*）、產業分類、市場別——任何一個變了，
    兩次重建之間上線改用新輸入、矩陣還是舊的，簽章卻查不出來。
  · 這裡只放「會改變矩陣內容」的輸入；panel.npz 每天都會長一天，由 a35_shadow_lib.rebuild_reasons 的 rows／alignment 處理。

逐日補抓的除權息（a35_shadow_exright_*.json）
  · 上線特徵一律併入（build_ctx）。訓練資料集只有在環境變數 SURGE_SHADOW_EXTRA_EXRIGHT=1 時併入（起漲影子協調器重建矩陣時設）：
    研究腳本（build_v2／official_features／retrain_official.sh 的 build_lu1）預設不吃，研究線「修正前 vs 修正後」的數字才可重現
    （2026-10-04 審查：原本寫進 build.load_factor_events，所有研究 build 都會悄悄併入）。
  · 清單記 enabled 與每個檔的雜湊；沒設開關建出的矩陣與上線（enabled=True）不同 ⇒ 判為輸入不一致、自動重建。

本檔只用標準函式庫、不讀環境變數以外的狀態；研究腳本可 import（不受 a35_shadow_lib 的研究環境變數防呆影響）。
"""
import glob
import hashlib
import json
import os

EXTRA_EXRIGHT_ENV = 'SURGE_SHADOW_EXTRA_EXRIGHT'
EXTRA_EXRIGHT_GLOB = 'a35_shadow_exright_*.json'
SCHEMA = 'surge.inputs.v1'


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 24), b''): h.update(b)
    return h.hexdigest()


def sha_or_none(path: str) -> str:
    return file_sha256(path) if os.path.isfile(path) else None


def price_events_sha(path: str) -> str:
    """priceEvents.json 的內容雜湊：只取 build.load_factor_events 用到的 (代號, 日期, factor)，排序後雜湊。
    檔頭的 window／fetchedAt／updatedAt 每次抓取都會變，不能直接雜湊檔案（否則每輪都判成輸入改變）。沒有檔＝None。"""
    if not os.path.isfile(path): return None
    with open(path, encoding='utf-8') as f: doc = json.load(f) or {}
    rows = sorted((str(e.get('code')), str(e.get('date')), e.get('factor')) for e in (doc.get('items') or []))
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def extra_exright_enabled(env=None) -> bool:
    return (os.environ if env is None else env).get(EXTRA_EXRIGHT_ENV) == '1'


def extra_exright_paths(sp: str) -> list:
    return sorted(glob.glob(os.path.join(sp, EXTRA_EXRIGHT_GLOB)))


def merge_extra_exright(events: list, items) -> list:
    """把逐日補抓的除權息 items[(日期, 代號, factor)] 併到 build.load_factor_events 的事件表 [(代號, 日期, 來源, factor)]：
    factor > 0 才收；同檔同日已存在（含 items 內重複）者不重複；附加在最後。訓練（build_lu1）與上線（build_ctx）共用這一支，逐位一致。"""
    out = list(events)
    have = {(c, d) for (c, d, _s, _f) in out}
    for d, c, f in items or []:
        if (f or 0) > 0 and (c, d) not in have:
            out.append((c, d, 'a35_extra', f)); have.add((c, d))
    return out


def load_extra_exright_items(sp: str) -> list:
    items = []
    for p in extra_exright_paths(sp):
        with open(p, encoding='utf-8') as f: items += [tuple(i) for i in (json.load(f).get('items') or [])]
    return items


def input_manifest(sp: str, repo: str, revenue_path: str, extra_exright: bool) -> dict:
    """矩陣內容所依賴的輸入雜湊（panel.npz 除外）。檔案不存在記 None（照實，不補預設值）。"""
    return dict(
        schema=SCHEMA,
        revenue=sha_or_none(revenue_path),
        exrightHistory=sha_or_none(os.path.join(repo, 'scripts/data/exright-history.json')),
        exrightDelta=sha_or_none(os.path.join(sp, 'exright_delta.json')),
        priceEvents=price_events_sha(os.path.join(sp, 'priceEvents.json')),
        peerCompsIndustries=sha_or_none(os.path.join(sp, 'peerComps_industries.json')),
        codeMarket=sha_or_none(os.path.join(sp, 'code_market.json')),
        a35ExtraExright=dict(enabled=bool(extra_exright),
                             files={os.path.basename(p): file_sha256(p) for p in extra_exright_paths(sp)} if extra_exright else {}),
    )


def manifest_diff(built: dict, now: dict) -> list:
    """兩份清單不同的鍵（排序）；a35ExtraExright 細分成 enabled 與各檔名。"""
    out = []
    for k in sorted(set(built or {}) | set(now or {})):
        a, b = (built or {}).get(k), (now or {}).get(k)
        if k == 'a35ExtraExright' and isinstance(a, dict) and isinstance(b, dict):
            if a.get('enabled') != b.get('enabled'): out.append('a35ExtraExright.enabled')
            fa, fb = a.get('files') or {}, b.get('files') or {}
            out += [f'a35ExtraExright:{n}' for n in sorted(set(fa) | set(fb)) if fa.get(n) != fb.get(n)]
        elif a != b:
            out.append(k)
    return out
