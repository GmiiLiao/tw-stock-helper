"""匯出官方漲跌停價矩陣（對齊 panel 的 T×N）：上市 TWT84U 當日漲停／跌停價；上櫃用前一交易日 dailyQuotes 的「次日 漲停價／跌停價」。
輸出 .surge-cache/official_limits.npz（LIMUP、LIMDN、dates、codes），供 build.official_limit_up（環境變數 SURGE_OFFICIAL_LIMIT）以官方價判定漲停。
用法：SURGE_CACHE=<快取> python3 official_limits.py
"""
import numpy as np
import build as B
from official_features import load_matrices


def main():
    dates, codes, P = B.load_panel()
    M, cov = load_matrices(dates, codes)
    U, D = M['LIMUP'], M['LIMDN']
    out = f'{B.SP}/official_limits.npz'
    np.savez_compressed(out, LIMUP=U.astype(np.float64), LIMDN=D.astype(np.float64), dates=np.array(dates), codes=np.array(codes))
    has = np.isfinite(P['C'])
    print(f'官方漲停價覆蓋（有收盤的格子）{np.isfinite(U)[has].mean() * 100:.2f}%；上市檔 {cov.get("twse_limit")} 日、上櫃日行情 {cov.get("tpex_daily")} 日 → {out}')


if __name__ == '__main__':
    main()
