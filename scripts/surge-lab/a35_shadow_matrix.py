"""a35_shadow_matrix.py — 訓練矩陣（a32_walkforward_X.npy＋meta.npz）要不要重建（唯讀；a35_shadow_daily.mjs 用）。

用法：python3 a35_shadow_matrix.py --day 2026-10-05        → stdout 一行 JSON：{ rebuild, reasons, matrixMaxS, … }
重建條件（任一成立，見 a35_shadow_lib.rebuild_reasons）：
  · 矩陣最晚的 s < 打分日索引 − 3（訓練列不夠新）
  · 面板日期序列不是矩陣日期的延伸（alignment）
  · 沒有建置側檔／側檔記的不是目前這份矩陣／dataset 建置時帶研究用環境變數／側檔沒有輸入清單／任一輸入與上線不同
    （surge_inputs.input_manifest：營收、exright-history、exright_delta、priceEvents、產業、市場別、逐日補抓除權息；訓練與上線特徵不一致）
重建＝SURGE_SHADOW_EXTRA_EXRIGHT=1 python3 build_lu1.py && python3 a32_walkforward_prep.py（同一個 SURGE_CACHE；開關＝併入逐日補抓除權息，與上線一致）。
"""
import os
import sys
import json
import argparse
import numpy as np
import a35_shadow_lib as L


def status(day: str) -> dict:
    panel_dates = [str(d) for d in np.load(f'{L.SP}/panel.npz')['dates']]
    if day not in panel_dates: return dict(day=day, error=f'面板沒有 {day}（面板最後一天 {panel_dates[-1]}）', rebuild=None)
    t = panel_dates.index(day)
    base = dict(day=day, panelLast=panel_dates[-1], dayIdx=t, needCutoffIdx=t - L.PURGE_DAYS, needCutoff=panel_dates[t - L.PURGE_DAYS])
    if not (os.path.exists(L.X_PATH) and os.path.exists(L.META_PATH)):
        return dict(base, rebuild=True, reasons=['missing-matrix'])
    M = np.load(L.META_PATH)
    meta_dates = [str(d) for d in M['dates']]
    max_s = int(M['m_s'].max())
    fd = L.feature_data()
    reasons = L.rebuild_reasons(meta_dates, max_s, panel_dates, day, fd['consistency'])
    return dict(base, matrixMaxS=meta_dates[max_s], matrixMaxSIdx=max_s, rebuild=bool(reasons), reasons=reasons, **fd)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--day', required=True, help='打分日 YYYY-MM-DD')
    st = status(ap.parse_args().day)
    print(json.dumps(st, ensure_ascii=False), flush=True)
    return 2 if st.get('error') else 0


if __name__ == '__main__':
    sys.exit(main())
